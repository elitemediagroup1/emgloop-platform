// DOMAIN INTELLIGENCE DIGESTS: persistence. Loop Intelligence PR A, approved 2026-09-24.
//
// Architecture: AUTHORITATIVE EVIDENCE -> DOMAIN INTELLIGENCE (this) -> domain UI / Briefing /
// connective intelligence -> Headlines -> Investigation -> Work. INTELLIGENCE IS NOT WORK: nothing
// here writes, reads or becomes a WorkItem. The contract (content shape, coverage, retention,
// freshness) is @emgloop/shared intelligence-digest.ts and intelligence-coverage.ts.
//
// A REBUILDABLE PROJECTION. One current row per (organization, user, domain, subjectKind,
// subjectRef), OVERWRITTEN when regenerated. ENGINEERING_PRINCIPLES Rule 1 (append-only) governs
// truth; a digest is a projection of evidence kept elsewhere (Rule 2), its provenance names that
// evidence (Rule 3), and overwriting it loses nothing that cannot be rebuilt from the evidence.
//
// PRINCIPAL-PRIVATE, AND THE UNSAFE CALL IS NOT EXPRESSIBLE. Every read and write takes a
// principal {organizationId, userId} the caller built from the signed session (never from a form,
// a query parameter, a path segment or a body). There is NO organization-wide read, NO "list for
// organization", NO role bypass: an OWNER, an ADMIN or a Super Admin reads their OWN digests and
// nobody else's, and another person's digest -- in this organization or any other -- is not found.
// A source-scan test pins that no method here reads without the user in scope, with exactly two
// named exceptions:
//   - `organizationCounts(organizationId)`, THE ONE ORGANIZATION-LEVEL READ: counts per (domain,
//     status, coverage), and nothing else. No content, no subject, no provenance, no user id -- it
//     can say "12 digests in CHATS are STALE", never whose or about what. It exists so an
//     operator surface can show whether intelligence is being produced at all.
//   - `purgeExpired`, a cross-tenant maintenance delete by time that returns a count and nothing
//     else (like SourceObservationRepository.purgeOlderThan).
//
// ORGANIZATION SCOPE (PR 2, the fabric, 2026-09-26) IS A SEPARATE DOOR. `upsert` and every principal
// read are PRINCIPAL-only, and filter on scope as well as the user, so they can never return an
// organization row. `upsertOrganization` and the `organization*` reads handle ORGANIZATION rows only --
// userId null, no provider, basis LOOP_RECORDS, never a private domain, never a principal-only entity
// reference, every provenance source an organization source -- and they can never return a principal
// row. There is still NO read that returns every digest in an organization: the organization reads are
// per domain and return ORGANIZATION rows only, and the caller enforces the domain's read authority
// (INTELLIGENCE_DOMAIN_REGISTRY readAuthority) from the signed session before calling. The database
// enforces the same rules (intelligence_digests_scope_check).
//
// MERGE-SAFE. Every read and write names its columns (DIGEST_BASE_SELECT), and "entityRefs" is named only
// once `digestEntityRefsPresent` says migration 20261006000000 has run: the web deploys before a human
// applies the migration, and a select naming a missing column fails. Before it, principal writes work as
// they did in PR A and organization writes are refused NOT_MIGRATED.
//
// CONSENT IS RE-CHECKED AT THE WRITE. A digest drawn from a provider that has a revocable
// content-consent authority (TELEGRAM today: source_content_authorizations) is written only if
// that consent is in force INSIDE the write's own transaction (`contentAuthorizedInTx`), so a
// producer already in flight when a revoke commits writes nothing afterwards. A revoke deletes
// that provider's digests in the revoke's own transaction (`withdrawForProvider`, called from
// SourceContentAuthorizationRepository.revoke and revokeContentAuthorizationsInTx). For a provider
// WITHOUT such an authority yet (GMAIL, CALENDAR ... read under the connection's own OAuth grant),
// the caller must state the basis explicitly (`consentBasis: 'SOURCE_CONNECTION_GRANT'`), and
// intelligence from Loop's own records (no provider) states `LOOP_RECORDS`. A missing or
// mismatched basis is refused: nothing is written on an assumed permission.
//
// RETENTION. `expiresAt` is stamped at write from the shared policy (30 days; dated 2026-09-24)
// and the connections worker's periodic purge deletes past it. Disconnect: the worker's
// derived-retention sweep deletes a principal's digests for a provider once the disconnect is past
// the 30-day grace (SourceConnectionRepository.expireDerivedWork). Offboarding: WorkErasureRepository
// deletes them with the rest of the person's work state.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  INTELLIGENCE_CONTRACT_VERSION,
  INTELLIGENCE_DIGEST_STATUSES,
  INTELLIGENCE_PRODUCER_KINDS,
  PRIVATE_INTELLIGENCE_DOMAINS,
  ENTITY_REFS_MAX_PER_DIGEST,
  entityRefListRefusals,
  intelligenceDomainAllowsScope,
  intelligenceSourceScopes,
  intelligenceSourceUseRefusals,
  INTELLIGENCE_DOMAIN_SUBJECT_REF,
  INTELLIGENCE_DOMAINS,
  INTELLIGENCE_GENERATED_COVERAGE,
  INTELLIGENCE_SUBJECT_KINDS,
  digestContentRefusals,
  intelligenceDigestExpiresAt,
  isIntelligenceCoverage,
  type DigestContent,
  type DigestContentRefusal,
  type IntelligenceCoverage,
  type IntelligenceDigestScope,
  type IntelligenceDigestStatus,
  type IntelligenceDomain,
  type IntelligenceProducerKind,
  type IntelligenceSourceUse,
  type IntelligenceSubjectKind,
} from '@emgloop/shared';

import { absentUntilMigrated } from '../../creator/until-migrated';
import { membershipAuthority } from '../membership.repository';
import { contentAuthorizedInTx } from '../source-content-consent';
import { workScope, type WorkPrincipal } from '../work-state/work-principal';
import { digestEntityRefsPresent } from './intelligence-fabric-presence';

/** One person, in one organization, from the signed session. The only way into this repository. */
export type IntelligencePrincipal = WorkPrincipal;

/**
 * Providers whose content Loop reads only under an explicit, revocable content authorization
 * (`source_content_authorizations`). A digest from one of these is written only while that
 * authorization is in force, re-checked inside the write.
 */
// GMAIL since Loop Intelligence Phase D: a MAIL digest drawn from mail CONTENT rests on the person's MAIL
// content authorization (and the governance gate that must be open for one to exist), re-checked here.
export const INTELLIGENCE_CONTENT_CONSENT_PROVIDERS: readonly string[] = Object.freeze(['TELEGRAM', 'GMAIL']);

/**
 * Why a digest may be written at all.
 *
 *   CONTENT_AUTHORIZATION    the person's revocable content consent (a provider listed above).
 *                            Re-checked in the write's transaction; the caller's word is not enough.
 *   SOURCE_CONNECTION_GRANT  the person connected the source and granted Loop read access (an OAuth
 *                            scope), and that provider has no separate content consent YET. The
 *                            caller asserts it; when a content-consent authority is built for the
 *                            provider, it moves to the list above and this basis is refused for it.
 *   LOOP_RECORDS             no external provider: Loop's own records (Work, CRM, CallGrid facts).
 */
export const INTELLIGENCE_CONSENT_BASES = ['CONTENT_AUTHORIZATION', 'SOURCE_CONNECTION_GRANT', 'LOOP_RECORDS'] as const;
export type IntelligenceConsentBasis = (typeof INTELLIGENCE_CONSENT_BASES)[number];

/** A digest's metadata only: what `metadataFor` returns. No content, subject or provenance. */
export interface IntelligenceDigestMetadata {
  readonly domain: IntelligenceDomain;
  readonly subjectKind: IntelligenceSubjectKind;
  readonly coverage: IntelligenceCoverage;
  readonly status: IntelligenceDigestStatus;
  readonly generatedAt: Date;
  readonly windowEnd: Date;
  readonly evidenceCount: number;
  readonly version: number;
  readonly expiresAt: Date;
}

/** One cell of `organizationCounts`: a count, and the three vocabularies it is grouped by. Nothing else. */
export interface IntelligenceDigestCount {
  readonly scope: IntelligenceDigestScope;
  readonly domain: IntelligenceDomain;
  readonly status: IntelligenceDigestStatus;
  readonly coverage: IntelligenceCoverage;
  readonly count: number;
}

/** The only columns `metadataFor` selects. A test pins the select to exactly these. */
export const INTELLIGENCE_DIGEST_METADATA_SELECT = Object.freeze({
  domain: true,
  subjectKind: true,
  coverage: true,
  status: true,
  generatedAt: true,
  windowEnd: true,
  evidenceCount: true,
  version: true,
  expiresAt: true,
} as const);

/** Where a digest came from. Keyed references and versions only -- never content. */
export interface DigestProvenance {
  /** Keyed source references (a conversation key, a thread key), never a raw provider id. */
  readonly sourceRefs: readonly string[];
  /** The keyed evidence events the digest's claims anchor to. */
  readonly anchorEventIds?: readonly string[];
  readonly aiInvocationId?: string | null;
  readonly taskId?: string | null;
  readonly taskVersion?: string | null;
  readonly schemaId?: string | null;
  readonly producerVersion: string;
  /**
   * Participation contract (PR 2): the governed sources read, each with its as-of and coverage. Required
   * for an ORGANIZATION digest, and every source named must be one whose evidence may feed that scope.
   */
  readonly sources?: readonly IntelligenceSourceUse[];
  /** RULE (deterministic over Loop records) or MODEL (a governed AI task). Only a RULE may state MEASURED. */
  readonly producerKind?: IntelligenceProducerKind;
  /** Stamped by the repository when absent: the participation contract version the digest was checked against. */
  readonly contractVersion?: string;
}

export interface IntelligenceDigestInput {
  /** Defaults to PRINCIPAL. `upsert` refuses ORGANIZATION: that is `upsertOrganization`. */
  readonly scope?: IntelligenceDigestScope;
  readonly domain: IntelligenceDomain;
  readonly subjectKind: IntelligenceSubjectKind;
  /** A keyed reference. For a DOMAIN rollup it is always 'domain' (it may be omitted). */
  readonly subjectRef?: string;
  readonly provider: string | null;
  readonly consentBasis: IntelligenceConsentBasis;
  readonly content: DigestContent;
  /** What the producer could see: SUFFICIENT, INSUFFICIENT or PARTIAL. The rest are read-time states. */
  readonly coverage: (typeof INTELLIGENCE_GENERATED_COVERAGE)[number];
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly evidenceCount: number;
  readonly lastEvidenceAt: Date | null;
  readonly provenance: DigestProvenance;
  readonly aiInvocationId: string | null;
  /**
   * Canonical entity references (@emgloop/shared entity-ref.ts), at most 32. Optional: a producer that
   * names none (Chats triage v4) writes an empty list. Written only once the column exists.
   */
  readonly entityRefs?: readonly string[];
  /**
   * The digest's meaning. An upsert with the fingerprint already stored writes nothing, so it must
   * cover everything that should refresh the row (content, coverage, and the window if it matters).
   */
  readonly fingerprint: string;
  readonly generatedAt: Date;
}

export interface IntelligenceDigestRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly scope: IntelligenceDigestScope;
  /** The principal's user id; null for an ORGANIZATION digest. */
  readonly userId: string | null;
  readonly domain: IntelligenceDomain;
  readonly subjectKind: IntelligenceSubjectKind;
  readonly subjectRef: string;
  readonly provider: string | null;
  readonly content: DigestContent;
  /** As recorded at generation; ERROR when the stored row cannot be understood. */
  readonly coverage: IntelligenceCoverage;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly evidenceCount: number;
  readonly lastEvidenceAt: Date | null;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly aiInvocationId: string | null;
  /** Empty before the PR 2 migration, and for every digest whose producer named none. */
  readonly entityRefs: readonly string[];
  readonly fingerprint: string;
  readonly version: number;
  readonly status: IntelligenceDigestStatus;
  readonly generatedAt: Date;
  readonly expiresAt: Date;
}

export const INTELLIGENCE_DIGEST_WRITE_REFUSALS = [
  // `upsert` was asked for an ORGANIZATION row (that is `upsertOrganization`), or the reverse.
  'ORGANIZATION_SCOPE_RESERVED',
  'WRONG_SCOPE',
  // The domain's registry entry does not admit this scope (Mail, Chats and Calendar are PRINCIPAL only).
  'SCOPE_NOT_ALLOWED_FOR_DOMAIN',
  // An ORGANIZATION digest must rest on Loop's own records and name only organization sources.
  'PRIVATE_EVIDENCE',
  'INVALID_ENTITY_REFS',
  // The PR 2 migration has not reached this database yet.
  'NOT_MIGRATED',
  'INVALID_INPUT',
  'INVALID_CONTENT',
  'CONSENT_BASIS_MISMATCH',
  'CONSENT_NOT_IN_FORCE',
  'NOT_AN_ACTIVE_MEMBER',
  'EXPIRED_AT_WRITE',
  'CONTENDED',
] as const;
export type IntelligenceDigestWriteRefusal = (typeof INTELLIGENCE_DIGEST_WRITE_REFUSALS)[number];

export type IntelligenceDigestWriteOutcome =
  | { readonly outcome: 'WRITTEN'; readonly digest: IntelligenceDigestRecord }
  | { readonly outcome: 'UNCHANGED'; readonly digest: IntelligenceDigestRecord }
  | { readonly outcome: 'REFUSED'; readonly refusal: IntelligenceDigestWriteRefusal; readonly contentRefusals?: readonly DigestContentRefusal[] };

const SUBJECT_REF = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,255}$/;

/**
 * THE COLUMNS EVERY READ NAMES. Never a whole row: the PR 2 column ("entityRefs") is added to a select
 * only after the migration is known to have run, so this code reads a database either side of it.
 */
export const DIGEST_BASE_SELECT = Object.freeze({
  id: true,
  organizationId: true,
  scope: true,
  userId: true,
  domain: true,
  subjectKind: true,
  subjectRef: true,
  provider: true,
  content: true,
  coverage: true,
  windowStart: true,
  windowEnd: true,
  evidenceCount: true,
  lastEvidenceAt: true,
  provenance: true,
  aiInvocationId: true,
  fingerprint: true,
  version: true,
  status: true,
  generatedAt: true,
  expiresAt: true,
} as const);

function digestSelect(withRefs: boolean) {
  return withRefs ? { ...DIGEST_BASE_SELECT, entityRefs: true as const } : DIGEST_BASE_SELECT;
}
const PROVIDER = /^[A-Z][A-Z0-9_]{0,63}$/;
const FINGERPRINT = /^[A-Za-z0-9._:-]{1,128}$/;
const READ_LIMIT_MAX = 200;
const PROVENANCE_MAX_REFS = 64;

type Db = PrismaClient | Prisma.TransactionClient;

function isDate(v: unknown): v is Date {
  return v instanceof Date && !Number.isNaN(v.getTime());
}

function nonBlankString(v: unknown, max: number): boolean {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max;
}

function stringList(v: unknown, maxItems: number, maxLen: number): boolean {
  return Array.isArray(v) && v.length <= maxItems && v.every((s) => nonBlankString(s, maxLen));
}

/** Whether the input is well-formed. Content is checked separately, so its refusals can be named. */
function inputIsValid(input: IntelligenceDigestInput, subjectRef: string): boolean {
  if (!(INTELLIGENCE_DOMAINS as readonly string[]).includes(input.domain)) return false;
  if (!(INTELLIGENCE_SUBJECT_KINDS as readonly string[]).includes(input.subjectKind)) return false;
  if (!SUBJECT_REF.test(subjectRef)) return false;
  if (input.subjectKind === 'DOMAIN' ? subjectRef !== INTELLIGENCE_DOMAIN_SUBJECT_REF : subjectRef === INTELLIGENCE_DOMAIN_SUBJECT_REF) return false;
  if (input.provider !== null && !(typeof input.provider === 'string' && PROVIDER.test(input.provider))) return false;
  if (!(INTELLIGENCE_GENERATED_COVERAGE as readonly string[]).includes(input.coverage)) return false;
  if (!isDate(input.windowStart) || !isDate(input.windowEnd) || input.windowEnd < input.windowStart) return false;
  if (!isDate(input.generatedAt)) return false;
  if (!Number.isInteger(input.evidenceCount) || input.evidenceCount < 0) return false;
  if (input.lastEvidenceAt !== null && !isDate(input.lastEvidenceAt)) return false;
  if (input.evidenceCount > 0 && input.lastEvidenceAt === null) return false;
  if (!(typeof input.fingerprint === 'string' && FINGERPRINT.test(input.fingerprint))) return false;
  if (input.aiInvocationId !== null && !nonBlankString(input.aiInvocationId, 200)) return false;
  const p = input.provenance as DigestProvenance | undefined;
  if (!p || typeof p !== 'object') return false;
  if (!stringList(p.sourceRefs, PROVENANCE_MAX_REFS, 256)) return false;
  if (p.anchorEventIds !== undefined && !stringList(p.anchorEventIds, PROVENANCE_MAX_REFS, 256)) return false;
  if (!nonBlankString(p.producerVersion, 64)) return false;
  for (const key of ['aiInvocationId', 'taskId', 'taskVersion', 'schemaId'] as const) {
    const v = p[key];
    if (v !== undefined && v !== null && !nonBlankString(v, 200)) return false;
  }
  if (p.producerKind !== undefined && !(INTELLIGENCE_PRODUCER_KINDS as readonly string[]).includes(p.producerKind)) return false;
  if (p.contractVersion !== undefined && !nonBlankString(p.contractVersion, 64)) return false;
  return true;
}

/** The provenance as stored: exactly the allowlisted keys, plus the consent basis. Nothing else survives. */
function storedProvenance(p: DigestProvenance, basis: IntelligenceConsentBasis): Record<string, unknown> {
  return {
    sourceRefs: [...p.sourceRefs],
    anchorEventIds: [...(p.anchorEventIds ?? [])],
    aiInvocationId: p.aiInvocationId ?? null,
    taskId: p.taskId ?? null,
    taskVersion: p.taskVersion ?? null,
    schemaId: p.schemaId ?? null,
    producerVersion: p.producerVersion,
    consentBasis: basis,
    // Participation contract (PR 2). Present only when the producer stated them, so a PR A row and a
    // PR A producer's new row keep exactly the provenance they always had.
    ...(p.sources ? { sources: p.sources.map((u) => ({ sourceId: u.sourceId, asOf: u.asOf, coverage: u.coverage })) } : {}),
    ...(p.producerKind ? { producerKind: p.producerKind, contractVersion: p.contractVersion ?? INTELLIGENCE_CONTRACT_VERSION } : {}),
  };
}

/** The content as stored: only the keys the producer set, in the contract's shape. */
function storedContent(content: DigestContent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) if (value !== undefined) out[key] = value;
  return out;
}

type DigestRow = Prisma.IntelligenceDigestGetPayload<{ select: typeof DIGEST_BASE_SELECT }> & { readonly entityRefs?: string[] };

function recordOf(row: DigestRow): IntelligenceDigestRecord {
  const content = row.content as unknown;
  const scope: IntelligenceDigestScope = row.scope === 'ORGANIZATION' ? 'ORGANIZATION' : 'PRINCIPAL';
  const producerKind = (row.provenance as { producerKind?: unknown } | null)?.producerKind;
  const readable =
    digestContentRefusals(content, { scope, producerKind: producerKind === 'RULE' || producerKind === 'MODEL' || producerKind === 'RULE_AND_MODEL' ? producerKind : null }).length === 0 &&
    isIntelligenceCoverage(row.coverage);
  return {
    id: row.id,
    organizationId: row.organizationId,
    scope,
    userId: row.userId ?? null,
    domain: row.domain as IntelligenceDomain,
    subjectKind: row.subjectKind as IntelligenceSubjectKind,
    subjectRef: row.subjectRef,
    provider: row.provider ?? null,
    // A row that cannot be understood is shown as what it is -- an ERROR -- never as a reading.
    content: readable ? (content as DigestContent) : {},
    coverage: readable ? (row.coverage as IntelligenceCoverage) : 'ERROR',
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    evidenceCount: row.evidenceCount,
    lastEvidenceAt: row.lastEvidenceAt ?? null,
    provenance: (row.provenance && typeof row.provenance === 'object' ? row.provenance : {}) as Record<string, unknown>,
    aiInvocationId: row.aiInvocationId ?? null,
    entityRefs: Array.isArray(row.entityRefs) ? [...row.entityRefs] : [],
    fingerprint: row.fingerprint,
    version: row.version,
    status: ((INTELLIGENCE_DIGEST_STATUSES as readonly string[]).includes(row.status) ? row.status : 'STALE') as IntelligenceDigestStatus,
    generatedAt: row.generatedAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Whether `intelligence_digests` exists in this database yet. Ask it OUTSIDE any transaction:
 * Netlify deploys `main` on every merge, while a migration reaches production only when a human
 * dispatches it, so there is a window in which this code knows a table the database does not have.
 * In that window there are no digests to delete, and an offboarding, a consent revoke or a
 * retention sweep must still complete -- but a failed statement aborts the whole Postgres
 * transaction, so the answer has to be known before it starts. A missing table or column
 * (P2021 / P2022) reads as absent; any other error (an unreachable database) is thrown, so nothing
 * is skipped on a guess. Scoped to one principal when one is given, so it reads their rows only.
 */
export async function intelligenceDigestsPresent(prisma: PrismaClient, principal?: IntelligencePrincipal): Promise<boolean> {
  const where = principal ? workScope(principal) : {};
  const probed = await absentUntilMigrated(prisma.intelligenceDigest.count({ where }).then(() => true));
  return probed === true;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown })?.code === 'P2002';
}

export class IntelligenceDigestRepository {
  constructor(private readonly db: Db) {}

  /** Run `fn` in a transaction: a new one on a client, or the caller's when this was built on one. */
  private inTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const db = this.db as PrismaClient;
    return typeof db.$transaction === 'function' ? db.$transaction(fn) : fn(this.db as Prisma.TransactionClient);
  }

  /**
   * Whether "entityRefs" exists here. Asked only on a client (outside a transaction); a repository built
   * on a transaction client does not know, and names the base columns only -- it never reads or writes
   * a column it has not proved.
   */
  private async refsPresent(): Promise<boolean> {
    const db = this.db as PrismaClient;
    if (typeof db.$transaction !== 'function') return false;
    return digestEntityRefsPresent(db);
  }

  /**
   * Write this person's current digest of one subject. Refused, writing nothing, when the scope is
   * ORGANIZATION, the input or content breaks the contract, the consent basis does not match the
   * provider, the provider's content consent is not in force at the moment of the write, the
   * person is not an active member, or the digest would already be expired.
   *
   * Same fingerprint as the stored row -> UNCHANGED, and nothing is written (the version does not
   * move). A different fingerprint -> the row is overwritten, version + 1, status CURRENT. A digest
   * previously marked STALE with the same fingerprint is re-affirmed CURRENT without a version
   * change: its meaning did not move, only its currency did.
   */
  async upsert(principal: IntelligencePrincipal, input: IntelligenceDigestInput): Promise<IntelligenceDigestWriteOutcome> {
    const scope = workScope(principal);
    if ((input.scope ?? 'PRINCIPAL') !== 'PRINCIPAL') return { outcome: 'REFUSED', refusal: 'ORGANIZATION_SCOPE_RESERVED' };
    if (!intelligenceDomainAllowsScope(input.domain, 'PRINCIPAL')) return { outcome: 'REFUSED', refusal: 'SCOPE_NOT_ALLOWED_FOR_DOMAIN' };
    const subjectRef = input.subjectKind === 'DOMAIN' ? (input.subjectRef ?? INTELLIGENCE_DOMAIN_SUBJECT_REF) : (input.subjectRef ?? '');
    if (!inputIsValid(input, subjectRef)) return { outcome: 'REFUSED', refusal: 'INVALID_INPUT' };
    if (input.provenance.sources !== undefined && intelligenceSourceUseRefusals(input.provenance.sources, 'PRINCIPAL', intelligenceSourceScopes).length > 0) {
      return { outcome: 'REFUSED', refusal: 'INVALID_INPUT' };
    }
    const entityRefs = input.entityRefs ?? [];
    if (entityRefListRefusals(entityRefs, ENTITY_REFS_MAX_PER_DIGEST, 'PRINCIPAL').length > 0) return { outcome: 'REFUSED', refusal: 'INVALID_ENTITY_REFS' };
    const contentRefusals = digestContentRefusals(input.content, { scope: 'PRINCIPAL', producerKind: input.provenance.producerKind ?? null });
    if (contentRefusals.length > 0) return { outcome: 'REFUSED', refusal: 'INVALID_CONTENT', contentRefusals };

    const needsContentConsent = input.provider !== null && INTELLIGENCE_CONTENT_CONSENT_PROVIDERS.includes(input.provider);
    const expectedBasis: IntelligenceConsentBasis =
      input.provider === null ? 'LOOP_RECORDS' : needsContentConsent ? 'CONTENT_AUTHORIZATION' : 'SOURCE_CONNECTION_GRANT';
    if (input.consentBasis !== expectedBasis) return { outcome: 'REFUSED', refusal: 'CONSENT_BASIS_MISMATCH' };

    const expiresAt = intelligenceDigestExpiresAt({
      subjectKind: input.subjectKind,
      lastEvidenceAt: input.lastEvidenceAt,
      windowEnd: input.windowEnd,
      generatedAt: input.generatedAt,
    });
    if (expiresAt.getTime() <= input.generatedAt.getTime()) return { outcome: 'REFUSED', refusal: 'EXPIRED_AT_WRITE' };

    // Probed OUTSIDE the transaction. Before the migration the column does not exist: nothing names it,
    // and a producer's references are simply not kept (they are optional for a principal digest).
    const withRefs = await this.refsPresent();
    const select = digestSelect(withRefs);
    const key = { ...scope, scope: 'PRINCIPAL', domain: input.domain, subjectKind: input.subjectKind, subjectRef };
    const data = {
      ...this.writeData(input, expiresAt),
      ...(withRefs ? { entityRefs: [...entityRefs] } : {}),
    };

    try {
      return await this.inTransaction(async (tx) => {
        const standing = await membershipAuthority(tx, scope.organizationId, scope.userId, input.generatedAt);
        if (!standing.granted) return { outcome: 'REFUSED' as const, refusal: 'NOT_AN_ACTIVE_MEMBER' as const };
        // THE WRITE RE-CHECKS CONSENT: a revoke that committed after the producer began wins.
        if (needsContentConsent && !(await contentAuthorizedInTx(tx, scope.organizationId, scope.userId, input.provider!))) {
          return { outcome: 'REFUSED' as const, refusal: 'CONSENT_NOT_IN_FORCE' as const };
        }
        return this.writeInTx(tx, key, data, input.fingerprint, select);
      });
    } catch (err) {
      // Two producers created the same subject at once; the other one's row stands.
      if (isUniqueViolation(err)) return { outcome: 'REFUSED', refusal: 'CONTENDED' };
      throw err;
    }
  }

  /**
   * Write the ORGANIZATION's current digest of one subject in one domain (PR 2). THE ONLY WAY AN
   * ORGANIZATION ROW IS WRITTEN, and it admits governed Loop records only:
   *   - the domain's registry entry must admit ORGANIZATION scope (never Mail, Chats or Calendar);
   *   - no provider, and consent basis LOOP_RECORDS;
   *   - the provenance must name its producer kind and at least one source, every one of them an
   *     organization source in the source registry (no Telegram, Gmail or Calendar evidence);
   *   - no entity reference of a principal-only kind (a conversation, a thread, a correspondent);
   *   - content validated as ORGANIZATION content (a MODEL producer can never state MEASURED).
   * `organizationId` comes from the signed session or a governed job, never a request. Refused
   * NOT_MIGRATED before 20261006000000 has run.
   */
  async upsertOrganization(organizationId: string, input: IntelligenceDigestInput): Promise<IntelligenceDigestWriteOutcome> {
    if (!organizationId) return { outcome: 'REFUSED', refusal: 'INVALID_INPUT' };
    if ((input.scope ?? 'ORGANIZATION') !== 'ORGANIZATION') return { outcome: 'REFUSED', refusal: 'WRONG_SCOPE' };
    if (PRIVATE_INTELLIGENCE_DOMAINS.includes(input.domain) || !intelligenceDomainAllowsScope(input.domain, 'ORGANIZATION')) {
      return { outcome: 'REFUSED', refusal: 'SCOPE_NOT_ALLOWED_FOR_DOMAIN' };
    }
    if (input.provider !== null || input.consentBasis !== 'LOOP_RECORDS') return { outcome: 'REFUSED', refusal: 'PRIVATE_EVIDENCE' };
    const sources = input.provenance?.sources;
    if (!sources || sources.length === 0 || !input.provenance.producerKind) return { outcome: 'REFUSED', refusal: 'INVALID_INPUT' };
    const sourceRefusals = intelligenceSourceUseRefusals(sources, 'ORGANIZATION', intelligenceSourceScopes);
    if (sourceRefusals.includes('PRIVATE_SOURCE')) return { outcome: 'REFUSED', refusal: 'PRIVATE_EVIDENCE' };
    if (sourceRefusals.length > 0) return { outcome: 'REFUSED', refusal: 'INVALID_INPUT' };
    const subjectRef = input.subjectKind === 'DOMAIN' ? (input.subjectRef ?? INTELLIGENCE_DOMAIN_SUBJECT_REF) : (input.subjectRef ?? '');
    if (!inputIsValid(input, subjectRef)) return { outcome: 'REFUSED', refusal: 'INVALID_INPUT' };
    const entityRefs = input.entityRefs ?? [];
    const refRefusals = entityRefListRefusals(entityRefs, ENTITY_REFS_MAX_PER_DIGEST, 'ORGANIZATION');
    if (refRefusals.includes('PRIVATE_ENTITY_REF')) return { outcome: 'REFUSED', refusal: 'PRIVATE_EVIDENCE' };
    if (refRefusals.length > 0) return { outcome: 'REFUSED', refusal: 'INVALID_ENTITY_REFS' };
    const contentRefusals = digestContentRefusals(input.content, { scope: 'ORGANIZATION', producerKind: input.provenance.producerKind });
    if (contentRefusals.length > 0) return { outcome: 'REFUSED', refusal: 'INVALID_CONTENT', contentRefusals };
    const expiresAt = intelligenceDigestExpiresAt({
      subjectKind: input.subjectKind,
      lastEvidenceAt: input.lastEvidenceAt,
      windowEnd: input.windowEnd,
      generatedAt: input.generatedAt,
    });
    if (expiresAt.getTime() <= input.generatedAt.getTime()) return { outcome: 'REFUSED', refusal: 'EXPIRED_AT_WRITE' };
    if (!(await this.refsPresent())) return { outcome: 'REFUSED', refusal: 'NOT_MIGRATED' };

    const select = digestSelect(true);
    const key = { organizationId, scope: 'ORGANIZATION', userId: null, domain: input.domain, subjectKind: input.subjectKind, subjectRef };
    const data = { ...this.writeData(input, expiresAt), entityRefs: [...entityRefs] };
    try {
      return await this.inTransaction((tx) => this.writeInTx(tx, key, data, input.fingerprint, select));
    } catch (err) {
      if (isUniqueViolation(err)) return { outcome: 'REFUSED', refusal: 'CONTENDED' };
      throw err;
    }
  }

  private writeData(input: IntelligenceDigestInput, expiresAt: Date) {
    return {
      provider: input.provider,
      content: storedContent(input.content) as Prisma.InputJsonValue,
      coverage: input.coverage,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      evidenceCount: input.evidenceCount,
      lastEvidenceAt: input.lastEvidenceAt,
      provenance: storedProvenance(input.provenance, input.consentBasis) as Prisma.InputJsonValue,
      aiInvocationId: input.aiInvocationId,
      fingerprint: input.fingerprint,
      status: 'CURRENT',
      generatedAt: input.generatedAt,
      expiresAt,
    };
  }

  /** The fingerprint-versioned write both scopes share. `key` fixes the scope; nothing here widens it. */
  private async writeInTx(
    tx: Prisma.TransactionClient,
    key: { organizationId: string; scope: string; userId: string | null; domain: string; subjectKind: string; subjectRef: string },
    data: ReturnType<IntelligenceDigestRepository['writeData']> & { entityRefs?: string[] },
    fingerprint: string,
    select: ReturnType<typeof digestSelect>,
  ): Promise<IntelligenceDigestWriteOutcome> {
    const existing = await tx.intelligenceDigest.findFirst({ where: key, select });
    if (!existing) {
      const created = await tx.intelligenceDigest.create({ data: { ...key, version: 1, ...data }, select });
      return { outcome: 'WRITTEN', digest: recordOf(created) };
    }
    if (existing.fingerprint === fingerprint) {
      if (existing.status === 'CURRENT') return { outcome: 'UNCHANGED', digest: recordOf(existing) };
      const reaffirmed = await tx.intelligenceDigest.update({ where: { id: existing.id }, data: { status: 'CURRENT' }, select });
      return { outcome: 'UNCHANGED', digest: recordOf(reaffirmed) };
    }
    const updated = await tx.intelligenceDigest.update({ where: { id: existing.id }, data: { ...data, version: existing.version + 1 }, select });
    return { outcome: 'WRITTEN', digest: recordOf(updated) };
  }

  /**
   * This person's digest of one subject in a domain, or their DOMAIN rollup when no subject is
   * named. Null when there is none, it expired, or it was withdrawn -- and for anyone else's, and for
   * any ORGANIZATION row.
   */
  async current(
    principal: IntelligencePrincipal,
    domain: IntelligenceDomain,
    subject: { readonly subjectKind?: IntelligenceSubjectKind; readonly subjectRef?: string; readonly now?: Date } = {},
  ): Promise<IntelligenceDigestRecord | null> {
    const scope = workScope(principal);
    const subjectKind = subject.subjectKind ?? 'DOMAIN';
    const subjectRef = subject.subjectRef ?? (subjectKind === 'DOMAIN' ? INTELLIGENCE_DOMAIN_SUBJECT_REF : '');
    if (!subjectRef) return null;
    const row = await this.db.intelligenceDigest.findFirst({
      where: { ...scope, scope: 'PRINCIPAL', domain, subjectKind, subjectRef, status: { not: 'WITHDRAWN' }, expiresAt: { gt: subject.now ?? new Date() } },
      select: digestSelect(await this.refsPresent()),
    });
    return row ? recordOf(row) : null;
  }

  /** Every live digest this person holds in one domain, newest evidence first, bounded. Never an ORGANIZATION row. */
  async forDomain(
    principal: IntelligencePrincipal,
    domain: IntelligenceDomain,
    options: { readonly now?: Date; readonly limit?: number } = {},
  ): Promise<IntelligenceDigestRecord[]> {
    const scope = workScope(principal);
    const rows = await this.db.intelligenceDigest.findMany({
      where: { ...scope, scope: 'PRINCIPAL', domain, status: { not: 'WITHDRAWN' }, expiresAt: { gt: options.now ?? new Date() } },
      orderBy: [{ lastEvidenceAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      take: Math.max(1, Math.min(options.limit ?? 50, READ_LIMIT_MAX)),
      select: digestSelect(await this.refsPresent()),
    });
    return rows.map(recordOf);
  }

  /**
   * The ORGANIZATION's digest of one subject in one domain (its DOMAIN rollup when no subject is named).
   * Returns ORGANIZATION rows only -- a principal row is structurally unreachable here (scope and
   * userId null are both in the filter). The CALLER enforces the domain's read authority from the
   * signed session (INTELLIGENCE_DOMAIN_REGISTRY readAuthority) before calling. Null before the migration.
   */
  async organizationCurrent(
    organizationId: string,
    domain: IntelligenceDomain,
    subject: { readonly subjectKind?: IntelligenceSubjectKind; readonly subjectRef?: string; readonly now?: Date } = {},
  ): Promise<IntelligenceDigestRecord | null> {
    if (!organizationId || PRIVATE_INTELLIGENCE_DOMAINS.includes(domain)) return null;
    if (!(await this.refsPresent())) return null;
    const subjectKind = subject.subjectKind ?? 'DOMAIN';
    const subjectRef = subject.subjectRef ?? (subjectKind === 'DOMAIN' ? INTELLIGENCE_DOMAIN_SUBJECT_REF : '');
    if (!subjectRef) return null;
    const row = await this.db.intelligenceDigest.findFirst({
      where: { organizationId, scope: 'ORGANIZATION', userId: null, domain, subjectKind, subjectRef, status: { not: 'WITHDRAWN' }, expiresAt: { gt: subject.now ?? new Date() } },
      select: digestSelect(true),
    });
    return row ? recordOf(row) : null;
  }

  /**
   * The ORGANIZATION's live digests in ONE domain, newest evidence first, bounded. Never a principal row,
   * never more than one domain per call, and never a private domain. The caller enforces read authority.
   */
  async organizationForDomain(
    organizationId: string,
    domain: IntelligenceDomain,
    options: { readonly now?: Date; readonly limit?: number } = {},
  ): Promise<IntelligenceDigestRecord[]> {
    if (!organizationId || PRIVATE_INTELLIGENCE_DOMAINS.includes(domain)) return [];
    if (!(await this.refsPresent())) return [];
    const rows = await this.db.intelligenceDigest.findMany({
      where: { organizationId, scope: 'ORGANIZATION', userId: null, domain, status: { not: 'WITHDRAWN' }, expiresAt: { gt: options.now ?? new Date() } },
      orderBy: [{ lastEvidenceAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      take: Math.max(1, Math.min(options.limit ?? 50, READ_LIMIT_MAX)),
      select: digestSelect(true),
    });
    return rows.map(recordOf);
  }

  /**
   * The stored fingerprint of one target, for the producer loop's "unchanged -> skip" check BEFORE any
   * model is called. Selects the fingerprint, status and version only. A principal target reads only
   * that person's row; an organization target only the organization's.
   */
  async storedFingerprint(
    owner: { readonly scope: 'PRINCIPAL'; readonly principal: IntelligencePrincipal } | { readonly scope: 'ORGANIZATION'; readonly organizationId: string },
    target: { readonly domain: IntelligenceDomain; readonly subjectKind: IntelligenceSubjectKind; readonly subjectRef: string },
  ): Promise<{ readonly fingerprint: string; readonly status: IntelligenceDigestStatus; readonly version: number } | null> {
    const where =
      owner.scope === 'PRINCIPAL'
        ? { ...workScope(owner.principal), scope: 'PRINCIPAL' }
        : { organizationId: owner.organizationId, scope: 'ORGANIZATION', userId: null };
    const row = await this.db.intelligenceDigest.findFirst({
      where: { ...where, domain: target.domain, subjectKind: target.subjectKind, subjectRef: target.subjectRef },
      select: { fingerprint: true, status: true, version: true },
    });
    if (!row) return null;
    return { fingerprint: row.fingerprint, status: ((INTELLIGENCE_DIGEST_STATUSES as readonly string[]).includes(row.status) ? row.status : 'STALE') as IntelligenceDigestStatus, version: row.version };
  }

  /**
   * The METADATA of every live digest this person holds, across domains: domain, subject kind,
   * coverage, status, when generated, window end, evidence count, version, expiry. The select names
   * only those columns, so no content, subject reference or provenance is even read. Bounded.
   */
  async metadataFor(principal: IntelligencePrincipal, opts: { readonly now: Date }): Promise<IntelligenceDigestMetadata[]> {
    const scope = workScope(principal);
    const rows = await this.db.intelligenceDigest.findMany({
      where: { ...scope, scope: 'PRINCIPAL', status: { not: 'WITHDRAWN' }, expiresAt: { gt: opts.now } },
      select: INTELLIGENCE_DIGEST_METADATA_SELECT,
      orderBy: [{ generatedAt: 'desc' }],
      take: READ_LIMIT_MAX,
    });
    return rows.map((r) => ({
      domain: r.domain as IntelligenceDomain,
      subjectKind: r.subjectKind as IntelligenceSubjectKind,
      coverage: isIntelligenceCoverage(r.coverage) ? r.coverage : 'ERROR',
      status: ((INTELLIGENCE_DIGEST_STATUSES as readonly string[]).includes(r.status) ? r.status : 'STALE') as IntelligenceDigestStatus,
      generatedAt: r.generatedAt,
      windowEnd: r.windowEnd,
      evidenceCount: r.evidenceCount,
      version: r.version,
      expiresAt: r.expiresAt,
    }));
  }

  /**
   * THE ONE ORGANIZATION-WIDE READ. How many live digests the organization holds, per (scope, domain,
   * status, coverage) -- a groupBy that selects nothing but those four and a count. It carries NO
   * content, NO subject, NO provenance and NO identity: the output has no user id, so it can say
   * that intelligence is (or is not) being produced, never whose or about what. It is still scoped
   * to one organization, which the caller takes from the signed session.
   */
  async organizationCounts(organizationId: string, opts: { readonly now: Date }): Promise<IntelligenceDigestCount[]> {
    if (!organizationId) return [];
    const groups = await this.db.intelligenceDigest.groupBy({
      by: ['scope', 'domain', 'status', 'coverage'],
      where: { organizationId, status: { not: 'WITHDRAWN' }, expiresAt: { gt: opts.now } },
      _count: { _all: true },
      orderBy: [{ scope: 'asc' }, { domain: 'asc' }, { status: 'asc' }, { coverage: 'asc' }],
    });
    return groups.map((g) => ({
      scope: (g.scope === 'ORGANIZATION' ? 'ORGANIZATION' : 'PRINCIPAL') as IntelligenceDigestScope,
      domain: g.domain as IntelligenceDomain,
      status: g.status as IntelligenceDigestStatus,
      coverage: isIntelligenceCoverage(g.coverage) ? g.coverage : 'ERROR',
      count: g._count._all,
    }));
  }

  /**
   * THE PRODUCER LOOP'S VERDICT ON ONE TARGET'S STORED READING (either scope). `markTargetStale`: a refresh
   * established that the prior reading no longer stands (NO_EVIDENCE) or could not be completed (HELD), so
   * a CURRENT row becomes STALE -- shown only "as of", never synthesized. `reaffirmTarget`: a refresh
   * gathered EXACTLY the evidence the stored reading was made from (same fingerprint), so a STALE row is
   * CURRENT again -- without a read or a model call. Each returns how many rows moved (0 or 1).
   */
  async markTargetStale(
    owner: { readonly scope: 'PRINCIPAL'; readonly principal: IntelligencePrincipal } | { readonly scope: 'ORGANIZATION'; readonly organizationId: string },
    target: { readonly domain: IntelligenceDomain; readonly subjectKind: IntelligenceSubjectKind; readonly subjectRef: string },
  ): Promise<{ readonly moved: number }> {
    const where = owner.scope === 'PRINCIPAL' ? { ...workScope(owner.principal), scope: 'PRINCIPAL' } : { organizationId: owner.organizationId, scope: 'ORGANIZATION', userId: null };
    const { count } = await this.db.intelligenceDigest.updateMany({ where: { ...where, domain: target.domain, subjectKind: target.subjectKind, subjectRef: target.subjectRef, status: 'CURRENT' }, data: { status: 'STALE' } });
    return { moved: count };
  }

  async reaffirmTarget(
    owner: { readonly scope: 'PRINCIPAL'; readonly principal: IntelligencePrincipal } | { readonly scope: 'ORGANIZATION'; readonly organizationId: string },
    target: { readonly domain: IntelligenceDomain; readonly subjectKind: IntelligenceSubjectKind; readonly subjectRef: string },
    fingerprint: string,
  ): Promise<{ readonly moved: number }> {
    const where = owner.scope === 'PRINCIPAL' ? { ...workScope(owner.principal), scope: 'PRINCIPAL' } : { organizationId: owner.organizationId, scope: 'ORGANIZATION', userId: null };
    const { count } = await this.db.intelligenceDigest.updateMany({ where: { ...where, domain: target.domain, subjectKind: target.subjectKind, subjectRef: target.subjectRef, status: 'STALE', fingerprint }, data: { status: 'CURRENT' } });
    return { moved: count };
  }

  /**
   * Mark this person's CURRENT digests stale -- all in a domain, one subject, or one provider's.
   * Returns how many moved. Nothing else about the rows changes.
   */
  async markStale(
    principal: IntelligencePrincipal,
    target: { readonly domain: IntelligenceDomain; readonly subjectKind?: IntelligenceSubjectKind; readonly subjectRef?: string; readonly provider?: string },
  ): Promise<number> {
    const scope = workScope(principal);
    const where: Record<string, unknown> = { ...scope, scope: 'PRINCIPAL', domain: target.domain, status: 'CURRENT' };
    if (target.subjectKind) where.subjectKind = target.subjectKind;
    if (target.subjectRef) where.subjectRef = target.subjectRef;
    if (target.provider) where.provider = target.provider;
    const { count } = await this.db.intelligenceDigest.updateMany({ where: where as never, data: { status: 'STALE' } });
    return count;
  }

  /**
   * CONSENT REVOKED: delete every digest this person holds from `provider`, immediately (approved
   * 2026-09-24: "removed immediately"). Call it inside the revoke's own transaction by building
   * this repository on that transaction client. Returns the count only.
   */
  async withdrawForProvider(principal: IntelligencePrincipal, provider: string): Promise<{ readonly deleted: number }> {
    const scope = workScope(principal);
    if (!provider) return { deleted: 0 };
    const { count } = await this.db.intelligenceDigest.deleteMany({ where: { ...scope, provider } });
    return { deleted: count };
  }

  /** Delete this person's digests -- all of them, or one provider's. Returns the count only. */
  async deleteForPrincipal(principal: IntelligencePrincipal, options: { readonly provider?: string } = {}): Promise<{ readonly deleted: number }> {
    const scope = workScope(principal);
    const where = options.provider ? { ...scope, provider: options.provider } : scope;
    const { count } = await this.db.intelligenceDigest.deleteMany({ where });
    return { deleted: count };
  }

  /**
   * RETENTION SWEEP, ACROSS ALL TENANTS. Delete every digest whose `expiresAt` is at or before
   * `now`. Cross-tenant by time on purpose -- a minimization sweep, not a tenant read -- and it
   * returns a count and nothing else: no row, no id, no organization.
   */
  async purgeExpired(now: Date): Promise<{ readonly purged: number }> {
    const { count } = await this.db.intelligenceDigest.deleteMany({ where: { expiresAt: { lte: now } } });
    return { purged: count };
  }
}

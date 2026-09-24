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
// ORGANIZATION SCOPE IS RESERVED. `upsert` refuses it before the database is asked, and a CHECK
// refuses it if anything else tried.
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
  INTELLIGENCE_DIGEST_STATUSES,
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
  type IntelligenceSubjectKind,
} from '@emgloop/shared';

import { absentUntilMigrated } from '../../creator/until-migrated';
import { membershipAuthority } from '../membership.repository';
import { contentAuthorizedInTx } from '../source-content-consent';
import { workScope, type WorkPrincipal } from '../work-state/work-principal';

/** One person, in one organization, from the signed session. The only way into this repository. */
export type IntelligencePrincipal = WorkPrincipal;

/**
 * Providers whose content Loop reads only under an explicit, revocable content authorization
 * (`source_content_authorizations`). A digest from one of these is written only while that
 * authorization is in force, re-checked inside the write.
 */
export const INTELLIGENCE_CONTENT_CONSENT_PROVIDERS: readonly string[] = Object.freeze(['TELEGRAM']);

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
}

export interface IntelligenceDigestInput {
  /** Defaults to PRINCIPAL. ORGANIZATION is refused. */
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
   * The digest's meaning. An upsert with the fingerprint already stored writes nothing, so it must
   * cover everything that should refresh the row (content, coverage, and the window if it matters).
   */
  readonly fingerprint: string;
  readonly generatedAt: Date;
}

export interface IntelligenceDigestRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
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
  readonly fingerprint: string;
  readonly version: number;
  readonly status: IntelligenceDigestStatus;
  readonly generatedAt: Date;
  readonly expiresAt: Date;
}

export const INTELLIGENCE_DIGEST_WRITE_REFUSALS = [
  'ORGANIZATION_SCOPE_RESERVED',
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
  };
}

/** The content as stored: only the keys the producer set, in the contract's shape. */
function storedContent(content: DigestContent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) if (value !== undefined) out[key] = value;
  return out;
}

function recordOf(row: any): IntelligenceDigestRecord {
  const content = row.content as unknown;
  const readable = digestContentRefusals(content).length === 0 && isIntelligenceCoverage(row.coverage);
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    domain: row.domain,
    subjectKind: row.subjectKind,
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
    fingerprint: row.fingerprint,
    version: row.version,
    status: (INTELLIGENCE_DIGEST_STATUSES as readonly string[]).includes(row.status) ? row.status : 'STALE',
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
    const subjectRef = input.subjectKind === 'DOMAIN' ? (input.subjectRef ?? INTELLIGENCE_DOMAIN_SUBJECT_REF) : (input.subjectRef ?? '');
    if (!inputIsValid(input, subjectRef)) return { outcome: 'REFUSED', refusal: 'INVALID_INPUT' };
    const contentRefusals = digestContentRefusals(input.content);
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

    const key = { ...scope, domain: input.domain, subjectKind: input.subjectKind, subjectRef };
    const data = {
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

    try {
      return await this.inTransaction(async (tx) => {
        const standing = await membershipAuthority(tx, scope.organizationId, scope.userId, input.generatedAt);
        if (!standing.granted) return { outcome: 'REFUSED' as const, refusal: 'NOT_AN_ACTIVE_MEMBER' as const };
        // THE WRITE RE-CHECKS CONSENT: a revoke that committed after the producer began wins.
        if (needsContentConsent && !(await contentAuthorizedInTx(tx, scope.organizationId, scope.userId, input.provider!))) {
          return { outcome: 'REFUSED' as const, refusal: 'CONSENT_NOT_IN_FORCE' as const };
        }
        const existing = await tx.intelligenceDigest.findFirst({ where: key });
        if (!existing) {
          const created = await tx.intelligenceDigest.create({ data: { ...key, scope: 'PRINCIPAL', version: 1, ...data } });
          return { outcome: 'WRITTEN' as const, digest: recordOf(created) };
        }
        if (existing.fingerprint === input.fingerprint) {
          if (existing.status === 'CURRENT') return { outcome: 'UNCHANGED' as const, digest: recordOf(existing) };
          const reaffirmed = await tx.intelligenceDigest.update({ where: { id: existing.id }, data: { status: 'CURRENT' } });
          return { outcome: 'UNCHANGED' as const, digest: recordOf(reaffirmed) };
        }
        const updated = await tx.intelligenceDigest.update({
          where: { id: existing.id },
          data: { ...data, version: existing.version + 1 },
        });
        return { outcome: 'WRITTEN' as const, digest: recordOf(updated) };
      });
    } catch (err) {
      // Two producers created the same subject at once; the other one's row stands.
      if (isUniqueViolation(err)) return { outcome: 'REFUSED', refusal: 'CONTENDED' };
      throw err;
    }
  }

  /**
   * This person's digest of one subject in a domain, or their DOMAIN rollup when no subject is
   * named. Null when there is none, it expired, or it was withdrawn -- and for anyone else's.
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
      where: { ...scope, domain, subjectKind, subjectRef, status: { not: 'WITHDRAWN' }, expiresAt: { gt: subject.now ?? new Date() } },
    });
    return row ? recordOf(row) : null;
  }

  /** Every live digest this person holds in one domain, newest evidence first, bounded. */
  async forDomain(
    principal: IntelligencePrincipal,
    domain: IntelligenceDomain,
    options: { readonly now?: Date; readonly limit?: number } = {},
  ): Promise<IntelligenceDigestRecord[]> {
    const scope = workScope(principal);
    const rows = await this.db.intelligenceDigest.findMany({
      where: { ...scope, domain, status: { not: 'WITHDRAWN' }, expiresAt: { gt: options.now ?? new Date() } },
      orderBy: [{ lastEvidenceAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      take: Math.max(1, Math.min(options.limit ?? 50, READ_LIMIT_MAX)),
    });
    return rows.map(recordOf);
  }

  /**
   * The METADATA of every live digest this person holds, across domains: domain, subject kind,
   * coverage, status, when generated, window end, evidence count, version, expiry. The select names
   * only those columns, so no content, subject reference or provenance is even read. Bounded.
   */
  async metadataFor(principal: IntelligencePrincipal, opts: { readonly now: Date }): Promise<IntelligenceDigestMetadata[]> {
    const scope = workScope(principal);
    const rows = await this.db.intelligenceDigest.findMany({
      where: { ...scope, status: { not: 'WITHDRAWN' }, expiresAt: { gt: opts.now } },
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
   * THE ONE ORGANIZATION-LEVEL READ. How many live digests the organization holds, per (domain,
   * status, coverage) -- a groupBy that selects nothing but those three and a count. It carries NO
   * content, NO subject, NO provenance and NO identity: the output has no user id, so it can say
   * that intelligence is (or is not) being produced, never whose or about what. It is still scoped
   * to one organization, which the caller takes from the signed session.
   */
  async organizationCounts(organizationId: string, opts: { readonly now: Date }): Promise<IntelligenceDigestCount[]> {
    if (!organizationId) return [];
    const groups = await this.db.intelligenceDigest.groupBy({
      by: ['domain', 'status', 'coverage'],
      where: { organizationId, status: { not: 'WITHDRAWN' }, expiresAt: { gt: opts.now } },
      _count: { _all: true },
      orderBy: [{ domain: 'asc' }, { status: 'asc' }, { coverage: 'asc' }],
    });
    return groups.map((g) => ({
      domain: g.domain as IntelligenceDomain,
      status: g.status as IntelligenceDigestStatus,
      coverage: isIntelligenceCoverage(g.coverage) ? g.coverage : 'ERROR',
      count: g._count._all,
    }));
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
    const where: Record<string, unknown> = { ...scope, domain: target.domain, status: 'CURRENT' };
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

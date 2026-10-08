// The historical-context backfill (CRM slice 6): titles, notes, source status, last-contacted time,
// creator and company context, from a reviewed import's OWN source, onto the subjects that import
// ALREADY created. Decision record: docs/architecture/crm-people-command-center.md §Backfill.
//
// WHAT IT NEVER DOES. It creates no Party, no Contact Point, no Opportunity, no Relationship, no
// Participant and no identity evidence, and it never re-runs the Party import. It writes context facts
// (`crm_subject_context_facts`, basis IMPORTED) and one audit row -- nothing else.
//
// WHY THE SAME SOURCE, PINNED. The import kept no title or note (by design: provenance holds hashes and
// ids). The only honest source for them is the very file that import read. So:
//   - the source's SHA-256 must equal the APPLY run's recorded `sourceSha256`;
//   - each row is matched to its import entry by line AND source row key AND the keyed row fingerprint
//     the import recorded -- a row that differs in any column is skipped (ROW_CHANGED), never guessed;
//   - only entries the APPLY actually applied (`appliedAt`) are used, and only their recorded subject ids.
//
// DRY RUN FIRST, THEN THE SAME PLAN. A dry run writes nothing and returns counts and a plan digest. An
// APPLY recomputes the plan and refuses unless the digest equals the one the operator reviewed
// (PLAN_CHANGED). Facts are keyed by content per subject, so a rerun records nothing new (idempotent)
// and a retry after a partial failure completes the rest (retry-safe).
//
// PRIVACY. Imported text is redacted of anything shaped like an address or a number before it is
// stored (`redactCrmContactValues`); results carry counts, codes and ids only -- never a value, a title,
// a note or a name -- so a command or a workflow can print them.

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  parseCrmImportCsv,
  redactCrmContactValues,
  type CrmContextFactKind,
  type CrmImportSourceRow,
  type CrmTimePrecision,
} from '@emgloop/shared';

import { AuditRepository } from '../repositories/audit.repository';
import { IamRepository } from '../repositories/iam.repository';
import { PartyReferenceRepository } from '../repositories/party-reference.repository';
import { rowFingerprint } from '../crm-import/crm-import.service';
import { crmOutreachPermits, type CrmOutreachActor } from './crm-outreach-access';
import { CrmOutreachRepository, type CrmContextFactInput } from './crm-outreach.repository';

export const CRM_CONTEXT_BACKFILL_VERSION = 'crm-context-backfill.v1' as const;

export type CrmContextBackfillSkip = 'NOT_APPLIED' | 'NO_SUBJECT' | 'ROW_MISSING' | 'ROW_CHANGED' | 'SUBJECT_UNAVAILABLE';

export interface CrmContextBackfillPlan {
  readonly version: typeof CRM_CONTEXT_BACKFILL_VERSION;
  readonly importRunId: string;
  readonly sourceSha256: string;
  readonly planDigest: string;
  /** Planned facts by kind. */
  readonly planned: Readonly<Record<CrmContextFactKind, number>>;
  /** Of those, already recorded (a rerun): written as UNCHANGED. */
  readonly alreadyRecorded: number;
  readonly subjects: { readonly people: number; readonly companies: number };
  readonly entries: { readonly considered: number; readonly used: number; readonly skipped: Readonly<Record<CrmContextBackfillSkip, number>> };
  /** How many address- or number-shaped runs were redacted from imported text. */
  readonly redactions: number;
  /** Rows whose time is unknown (no last-contacted value): their facts carry UNKNOWN time. */
  readonly unknownTime: number;
}

export type CrmContextBackfillResult =
  | { readonly outcome: 'DRY_RUN'; readonly plan: CrmContextBackfillPlan }
  | { readonly outcome: 'APPLIED'; readonly plan: CrmContextBackfillPlan; readonly recorded: number; readonly unchanged: number }
  | { readonly outcome: 'NOT_AUTHORIZED' | 'RUN_NOT_FOUND' | 'RUN_NOT_APPLY' | 'TARGET_REFUSED' | 'PRODUCTION_NOT_COMMISSIONED' }
  | { readonly outcome: 'SOURCE_MISMATCH'; readonly expected: string; readonly actual: string }
  | { readonly outcome: 'SOURCE_INVALID'; readonly problem: string }
  | { readonly outcome: 'PLAN_CHANGED'; readonly expected: string; readonly actual: string }
  /** No row's fingerprint matched: almost always a different identifier key than the import used. */
  | { readonly outcome: 'FINGERPRINT_KEY_MISMATCH'; readonly considered: number };

export type CrmContextBackfillTarget = 'LOCAL_TEST' | 'PRODUCTION';

export interface CrmContextBackfillDeps {
  outreach?: CrmOutreachRepository;
  references?: Pick<PartyReferenceRepository, 'resolveMany'>;
  audit?: Pick<AuditRepository, 'record'>;
  iam?: Pick<IamRepository, 'canEach'>;
  /** Whether this process may WRITE. Defaults to: a local database, not production. */
  targetGuard?: (target: CrmContextBackfillTarget) => boolean;
  clock?: () => Date;
}

interface PlannedFact extends CrmContextFactInput {
  readonly textHash: string | null;
}

const CHUNK = 200;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class CrmContextBackfillService {
  private readonly outreach: CrmOutreachRepository;
  private readonly references: Pick<PartyReferenceRepository, 'resolveMany'>;
  private readonly audit: Pick<AuditRepository, 'record'>;
  private readonly iam: Pick<IamRepository, 'canEach'>;
  private readonly targetGuard: (target: CrmContextBackfillTarget) => boolean;
  private readonly clock: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmContextBackfillDeps = {},
  ) {
    this.outreach = deps.outreach ?? new CrmOutreachRepository(prisma);
    this.references = deps.references ?? new PartyReferenceRepository(prisma);
    this.audit = deps.audit ?? new AuditRepository(prisma);
    this.iam = deps.iam ?? new IamRepository(prisma);
    this.targetGuard = deps.targetGuard ?? defaultTargetGuard;
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Plan only. Writes nothing. */
  dryRun(actor: CrmOutreachActor, importRunId: string, csvText: string): Promise<CrmContextBackfillResult> {
    return this.run(actor, importRunId, csvText, null, 'LOCAL_TEST');
  }

  /** Re-plan and write, only when the plan still equals the reviewed digest. */
  apply(actor: CrmOutreachActor, importRunId: string, csvText: string, expectedPlanDigest: string, target: CrmContextBackfillTarget = 'LOCAL_TEST'): Promise<CrmContextBackfillResult> {
    return this.run(actor, importRunId, csvText, expectedPlanDigest, target);
  }

  private async run(actor: CrmOutreachActor, importRunId: string, csvText: string, expectedPlanDigest: string | null, target: CrmContextBackfillTarget): Promise<CrmContextBackfillResult> {
    if (!(await crmOutreachPermits(this.prisma, this.iam, actor, 'BACKFILL_CONTEXT'))) return { outcome: 'NOT_AUTHORIZED' };
    const org = actor.organizationId;
    const run = await this.prisma.crmImportRun.findFirst({ where: { organizationId: org, id: importRunId }, select: { id: true, mode: true, sourceSha256: true } });
    if (!run) return { outcome: 'RUN_NOT_FOUND' };
    if (run.mode !== 'APPLY') return { outcome: 'RUN_NOT_APPLY' };
    const actual = sha256(csvText);
    if (actual !== run.sourceSha256) return { outcome: 'SOURCE_MISMATCH', expected: run.sourceSha256, actual };
    const parsed = parseCrmImportCsv(csvText);
    if (!parsed.ok) return { outcome: 'SOURCE_INVALID', problem: parsed.problem };

    const planned = await this.plan(org, run.id, actual, parsed.rows);
    if ('outcome' in planned) return planned;
    const { plan, facts } = planned;
    if (expectedPlanDigest === null) return { outcome: 'DRY_RUN', plan };

    if (expectedPlanDigest !== plan.planDigest) return { outcome: 'PLAN_CHANGED', expected: expectedPlanDigest, actual: plan.planDigest };
    if (target === 'PRODUCTION' && !productionCommissioned()) return { outcome: 'PRODUCTION_NOT_COMMISSIONED' };
    if (!this.targetGuard(target)) return { outcome: 'TARGET_REFUSED' };

    let recorded = 0;
    let unchanged = 0;
    const at = this.clock();
    for (let i = 0; i < facts.length; i += CHUNK) {
      const chunk = facts.slice(i, i + CHUNK);
      const r = await this.prisma.$transaction(
        async (tx) => {
          let rec = 0;
          let unc = 0;
          for (const { textHash: _textHash, ...f } of chunk) {
            const w = await this.outreach.recordFact(org, { ...f, recordedByUserId: actor.userId, recordedAt: at }, tx);
            if (w.outcome === 'RECORDED') rec += 1;
            else if (w.outcome === 'UNCHANGED') unc += 1;
          }
          return { rec, unc };
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
      recorded += r.rec;
      unchanged += r.unc;
    }
    if (recorded > 0) {
      await this.audit.record({
        organizationId: org,
        userId: actor.userId,
        action: 'crm_context.backfill_applied',
        entityType: 'crm_import_run',
        entityId: run.id,
        // Counts, ids and digests only.
        metadata: { version: CRM_CONTEXT_BACKFILL_VERSION, importRunId: run.id, sourceSha256: actual, planDigest: plan.planDigest, recorded, unchanged, planned: plan.planned, redactions: plan.redactions },
      });
    }
    return { outcome: 'APPLIED', plan, recorded, unchanged };
  }

  private async plan(org: string, importRunId: string, sourceSha256: string, rows: readonly CrmImportSourceRow[]): Promise<{ plan: CrmContextBackfillPlan; facts: PlannedFact[] } | { outcome: 'FINGERPRINT_KEY_MISMATCH'; considered: number }> {
    const entries = await this.prisma.crmImportEntry.findMany({
      where: { organizationId: org, importRunId },
      select: { line: true, sourceRowKey: true, rowFingerprint: true, creatorAliasId: true, companyPartyId: true, personPartyId: true, appliedAt: true },
      orderBy: { line: 'asc' },
    });
    const aliasIds = [...new Set(entries.map((e) => e.creatorAliasId).filter((x): x is string => !!x))];
    const aliases = aliasIds.length
      ? new Map((await this.prisma.crmImportCreatorAlias.findMany({ where: { organizationId: org, id: { in: aliasIds } }, select: { id: true, aliasText: true, creatorPartyId: true } })).map((a) => [a.id, a]))
      : new Map<string, { id: string; aliasText: string; creatorPartyId: string }>();
    const rowByLine = new Map(rows.map((r) => [r.line, r]));
    const subjectIds = [...new Set(entries.flatMap((e) => [e.personPartyId, e.companyPartyId]).filter((x): x is string => !!x))];
    const resolved = await this.references.resolveMany(org, subjectIds);
    const canonical = (id: string): { partyId: string; partyType: string } | null => {
      const r = resolved.get(id);
      if (!r) return null;
      if (r.state === 'ESTABLISHED' && !r.archived) return { partyId: r.partyId, partyType: r.partyType };
      if (r.state === 'SUPERSEDED' && r.canonicalEstablished && !r.canonicalArchived) return { partyId: r.canonicalPartyId, partyType: r.partyType };
      return null;
    };

    const skipped: Record<CrmContextBackfillSkip, number> = { NOT_APPLIED: 0, NO_SUBJECT: 0, ROW_MISSING: 0, ROW_CHANGED: 0, SUBJECT_UNAVAILABLE: 0 };
    const facts = new Map<string, PlannedFact>();
    const people = new Set<string>();
    const companies = new Set<string>();
    let used = 0;
    let redactions = 0;
    let unknownTime = 0;
    let fingerprintChecked = 0;

    for (const e of entries) {
      if (!e.appliedAt) { skipped.NOT_APPLIED += 1; continue; }
      const subjectRaw = e.personPartyId ?? e.companyPartyId;
      if (!subjectRaw) { skipped.NO_SUBJECT += 1; continue; }
      const row = rowByLine.get(e.line);
      if (!row || row.sourceRowKey !== e.sourceRowKey) { skipped.ROW_MISSING += 1; continue; }
      fingerprintChecked += 1;
      if (!e.rowFingerprint || rowFingerprint(org, row) !== e.rowFingerprint) { skipped.ROW_CHANGED += 1; continue; }
      const subject = canonical(subjectRaw);
      if (!subject) { skipped.SUBJECT_UNAVAILABLE += 1; continue; }
      used += 1;
      (subject.partyType === 'PERSON' ? people : companies).add(subject.partyId);

      const ref = { importRunId, importLine: e.line, sourceRef: `${CRM_CONTEXT_BACKFILL_VERSION}:${importRunId}:${e.line}` };
      const add = (kind: CrmContextFactKind, raw: string | null, extra: { relatedPartyId?: string | null; occurredAt?: Date | null; precision?: CrmTimePrecision } = {}) => {
        let text: string | null = null;
        let red = 0;
        // Only the last-contacted fact is a time without text; every other kind needs its text.
        if (raw === null && kind !== 'SOURCE_LAST_CONTACTED') return;
        if (raw !== null) {
          const trimmed = raw.trim();
          if (!trimmed) return;
          const r = redactCrmContactValues(trimmed.slice(0, 2000));
          text = r.value;
          red = r.redactions;
        }
        const precision = extra.precision ?? 'UNKNOWN';
        const occurredAt = precision === 'UNKNOWN' ? null : extra.occurredAt ?? null;
        const textHash = text === null ? null : sha256(text);
        // Keyed by CONTENT per subject: the same title on two lines is one fact, and a rerun is a no-op.
        const dedupeKey = `${CRM_CONTEXT_BACKFILL_VERSION}:${subject.partyId}:${kind}:${sha256(JSON.stringify([textHash, extra.relatedPartyId ?? null, occurredAt?.toISOString() ?? null]))}`;
        if (facts.has(dedupeKey)) return;
        redactions += red;
        facts.set(dedupeKey, {
          partyId: subject.partyId,
          partyType: subject.partyType,
          kind,
          text,
          redactions: red,
          relatedPartyId: extra.relatedPartyId ?? null,
          occurredAt,
          occurredAtPrecision: precision,
          basis: 'IMPORTED',
          dedupeKey,
          recordedByUserId: null,
          textHash,
          ...ref,
        });
      };

      if (subject.partyType === 'PERSON') add('TITLE', row.contactTitle);
      add('NOTE', row.sourceNotes);
      add('SOURCE_STATUS', row.sourceStatus);
      if (row.sourceLastContactedAt) {
        const at = new Date(row.sourceLastContactedAt);
        if (!Number.isNaN(at.getTime())) add('SOURCE_LAST_CONTACTED', null, { occurredAt: at, precision: DATE_ONLY.test(row.sourceLastContactedAt.trim()) ? 'DATE' : 'INSTANT' });
      } else unknownTime += 1;
      const alias = e.creatorAliasId ? aliases.get(e.creatorAliasId) : undefined;
      if (alias) add('CREATOR_CONTEXT', alias.aliasText, { relatedPartyId: alias.creatorPartyId });
      else if (row.creatorAlias) add('CREATOR_CONTEXT', row.creatorAlias);
      if (subject.partyType === 'PERSON' && e.companyPartyId) {
        const company = canonical(e.companyPartyId);
        if (company && company.partyType === 'COMPANY') add('COMPANY_CONTEXT', row.brandName ?? row.routeName, { relatedPartyId: company.partyId });
      }
    }

    if (fingerprintChecked > 0 && skipped.ROW_CHANGED === fingerprintChecked) return { outcome: 'FINGERPRINT_KEY_MISMATCH', considered: fingerprintChecked };

    const list = [...facts.values()].sort((a, b) => (a.dedupeKey < b.dedupeKey ? -1 : 1));
    const existing = await this.outreach.existingDedupeKeys(org, list.map((f) => f.dedupeKey));
    const counts = { TITLE: 0, NOTE: 0, SOURCE_STATUS: 0, SOURCE_LAST_CONTACTED: 0, CREATOR_CONTEXT: 0, COMPANY_CONTEXT: 0, ORIGIN: 0 } as Record<CrmContextFactKind, number>;
    for (const f of list) counts[f.kind] += 1;
    const planDigest = sha256(
      JSON.stringify({
        version: CRM_CONTEXT_BACKFILL_VERSION,
        importRunId,
        sourceSha256,
        facts: list.map((f) => [f.dedupeKey, f.partyId, f.kind, f.relatedPartyId, f.occurredAt?.toISOString() ?? null, f.occurredAtPrecision, f.textHash, f.importLine]),
      }),
    );
    return {
      plan: {
        version: CRM_CONTEXT_BACKFILL_VERSION,
        importRunId,
        sourceSha256,
        planDigest,
        planned: counts,
        alreadyRecorded: list.filter((f) => existing.has(f.dedupeKey)).length,
        subjects: { people: people.size, companies: companies.size },
        entries: { considered: entries.length, used, skipped },
        redactions,
        unknownTime,
      },
      facts: list,
    };
  }
}

/** Production writes only inside the reviewed workflow path on main, explicitly commissioned. */
function productionCommissioned(): boolean {
  return (
    process.env.LOOP_CRM_IMPORT_TARGET === 'production' &&
    process.env.GITHUB_ACTIONS === 'true' &&
    process.env.GITHUB_REF === 'refs/heads/main' &&
    process.env.CRM_CONTEXT_BACKFILL_PRODUCTION === 'commissioned-v1'
  );
}

function defaultTargetGuard(target: CrmContextBackfillTarget): boolean {
  if (target === 'PRODUCTION') return productionCommissioned();
  if (process.env.NODE_ENV === 'production') return false;
  try {
    const host = new URL(process.env.DATABASE_URL ?? '').hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

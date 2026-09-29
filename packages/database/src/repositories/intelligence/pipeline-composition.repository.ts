// What the Pipeline reading is actually counting -- a read-only diagnostic (2026-09-29). Production reported
// 24,587 "working" intake records, 24,575 of them "stalled". This measures that population by the Pipeline
// producer's OWN semantics, and separates what can be proven about each record from what cannot.
//
// PIPELINE SEMANTICS, REUSED EXACTLY. Working = the status reads as New, Contacted or Quoted (a missing or
// unrecognised status reads as New: `customerStatusWhere`). Stalled = working and `lastSeenAt` older than 14
// days (DomainFactsRepository.staleByStatus). The raw status is bucketed as ABSENT, one of the six known
// values, or OTHER.
//
// PROVENANCE, WITH ITS BASIS. VERIFIED only from marks the creating code wrote at creation and nothing
// rewrites afterwards (no code path updates `metadata` or `externalId`):
//   metadata.createdFrom = <provider>   the retired ingestion creator (identity Slice 1, #239, removed it)
//   externalId 'web-visitor:...'         that creator's anonymous-visitor records (written with createdFrom)
// HEURISTIC for conventions a record merely looks like (a demo externalId prefix, an 'anonymous-visitor'
// tag, which users can edit). UNKNOWN for everything else. Nothing is classified by appearance as VERIFIED.
//
// HUMAN WORK, ONLY WHERE A ROW NAMES THE ACTOR: a CRM note written by a HUMAN_AGENT, an audit entry on the
// record with a signed-in user, a Party link made by a user. Anything else is not claimed as human work.
//
// ACTIVITY in the last 14 days, per kind, only from rows tied to the Customer by a column or a fixed field
// (customerId, the audit entity, a workflow run's input.context.customerId).
//
// READ-ONLY, ONE ORGANIZATION, COUNTS AND CODES. Construct it with `readOnlyClient(prisma)`. Customer fields
// are matched IN the query (status, marks, empty identity fields), so only ids come back: no name, email,
// phone, status value, tag or metadata value is ever read. Ids stay in memory. Paged by id; the result says
// `complete` only when every read reached its end.

import { Prisma, type PrismaClient } from '@prisma/client';
import { entityRefRefusal } from '@emgloop/shared';

import { customerStatusWhere, PIPELINE_STATUSES, type PipelineStatus } from '../crm.repository';

const DAY = 24 * 60 * 60 * 1000;
export const PIPELINE_COMPOSITION_PAGE = 2_000;
/** Rows any one read may page through before it stops and says so. */
export const PIPELINE_COMPOSITION_MAX_ROWS = 500_000;
/** The Pipeline producer's stall threshold and working statuses (records.ts). */
const STALE_DAYS = 14;
const WORKING: readonly PipelineStatus[] = ['New', 'Contacted', 'Quoted'];
export const PIPELINE_ACTIVITY_WINDOW_DAYS = 14;
/** Months listed individually; older ones fold into EARLIER. */
const MAX_MONTHS = 24;

export const PIPELINE_STATUS_BUCKETS = ['ABSENT', ...PIPELINE_STATUSES.map((s) => s.toUpperCase()), 'OTHER'] as const;

export const PIPELINE_PROVENANCE = [
  { code: 'CALLGRID_INGESTION_CALLER_ONLY', basis: 'VERIFIED' },
  { code: 'CALLGRID_INGESTION_WITH_IDENTITY', basis: 'VERIFIED' },
  { code: 'WEB_VISITOR_INGESTION', basis: 'VERIFIED' },
  { code: 'WEB_LEAD_INGESTION', basis: 'VERIFIED' },
  { code: 'OTHER_INGESTION', basis: 'VERIFIED' },
  { code: 'SEED_OR_DEMO_PREFIX', basis: 'HEURISTIC' },
  { code: 'VISITOR_TAG_ONLY', basis: 'HEURISTIC' },
  { code: 'EXTERNAL_ID_UNMARKED', basis: 'UNKNOWN' },
  { code: 'UNKNOWN', basis: 'UNKNOWN' },
] as const;
export type PipelineProvenance = (typeof PIPELINE_PROVENANCE)[number]['code'];

export const HUMAN_WORK_SIGNALS = ['HUMAN_NOTE', 'USER_ACTION', 'USER_PARTY_LINK'] as const;
export const ACTIVITY_KINDS = ['ROW_UPDATED', 'INTERACTION', 'HUMAN_NOTE', 'CONVERSATION', 'BOOKING', 'ORDER', 'SERVICE_REQUEST', 'USER_ACTION', 'SYSTEM_AUDIT', 'WORKFLOW_RUN', 'PARTY_LINK'] as const;
const HUMAN_ACTIVITY: ReadonlySet<string> = new Set(['HUMAN_NOTE', 'USER_ACTION', 'PARTY_LINK']);
const DEMO_PREFIXES = ['sic-demo-', 'demo-', 'e2e-', 'test-', 'qa-', 'hotfix-verify'];

export interface PipelineCounts {
  readonly total: number;
  readonly working: number;
  readonly stalled: number;
}

export interface PipelineComposition {
  readonly records: number;
  readonly byStatus: readonly ({ readonly status: string } & PipelineCounts)[];
  readonly byProvenance: readonly ({ readonly provenance: PipelineProvenance; readonly basis: string; readonly humanWork: number } & PipelineCounts)[];
  /** Records with at least one deterministic human-work signal (all time), per signal and overall. */
  readonly humanWork: { readonly bySignal: Readonly<Record<string, number>>; readonly any: number; readonly stalledAny: number };
  /** lastSeenAt against createdAt, over all records and over the stalled ones. */
  readonly clock: { readonly all: ClockCounts; readonly stalled: ClockCounts };
  readonly cutoff: { readonly at: string; readonly createdBefore: PipelineCounts; readonly createdAfter: PipelineCounts; readonly afterWithIngestionMark: number };
  readonly months: readonly ({ readonly month: string } & PipelineCounts)[];
  readonly stalledActivity: { readonly windowDays: number; readonly byKind: Readonly<Record<string, number>>; readonly any: number; readonly human: number; readonly none: number };
  readonly nameable: { readonly stalled: number; readonly nameable: number };
  readonly complete: boolean;
  /** Which reads stopped at their bound (codes). Empty when complete. */
  readonly incomplete: readonly string[];
}

export interface ClockCounts {
  readonly lastSeenEqualsCreated: number;
  readonly lastSeenAfterCreated: number;
  readonly lastSeenBeforeCreated: number;
}

type IdRow = { id: string } & Record<string, unknown>;
interface Finder {
  findMany(args: { where: unknown; select: Record<string, boolean>; orderBy: { id: 'asc' }; take: number }): Promise<IdRow[]>;
}

const zero = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<string, number>;
const monthOf = (d: Date) => d.toISOString().slice(0, 7);

export class PipelineCompositionRepository {
  /** Pass `readOnlyClient(prisma)`. `maxRows` bounds each read (a test lowers it to prove the bound is reported). */
  constructor(private readonly db: PrismaClient, private readonly opts: { readonly maxRows?: number } = {}) {}

  /** Page through `delegate` by id, collecting `field` of each row. `complete` is false if the bound stopped it. */
  private async collect(delegate: Finder, where: Record<string, unknown>, field: string, onRow?: (row: IdRow) => void, extra: Record<string, boolean> = {}): Promise<{ values: Set<string>; complete: boolean }> {
    const values = new Set<string>();
    let after: string | undefined;
    let read = 0;
    for (;;) {
      const page = await delegate.findMany({
        where: after ? { AND: [where, { id: { gt: after } }] } : where,
        select: { id: true, ...(field === 'id' ? {} : { [field]: true }), ...extra },
        orderBy: { id: 'asc' },
        take: PIPELINE_COMPOSITION_PAGE,
      });
      for (const row of page) {
        const v = row[field];
        if (typeof v === 'string') values.add(v);
        onRow?.(row);
      }
      read += page.length;
      if (page.length < PIPELINE_COMPOSITION_PAGE) return { values, complete: true };
      if (read >= (this.opts.maxRows ?? PIPELINE_COMPOSITION_MAX_ROWS)) return { values, complete: false };
      after = page[page.length - 1]!.id;
    }
  }

  async read(organizationId: string, now: Date, slice1At: Date): Promise<PipelineComposition> {
    const org = { organizationId };
    const incomplete: string[] = [];
    const set = async (code: string, delegate: Finder, where: Record<string, unknown>, field = 'id', onRow?: (row: IdRow) => void, extra?: Record<string, boolean>) => {
      const r = await this.collect(delegate, where, field, onRow, extra);
      if (!r.complete) incomplete.push(code);
      return r.values;
    };
    const customers = this.db.customer as unknown as Finder;
    const inOrg = (w: Prisma.CustomerWhereInput): Record<string, unknown> => ({ AND: [org, w] });

    // Status: the raw value bucket, and Pipeline's own "working" (a missing or unknown value reads as New).
    const statusSets = new Map<string, Set<string>>();
    for (const s of PIPELINE_STATUSES) statusSets.set(s.toUpperCase(), await set(`STATUS_${s.toUpperCase()}`, customers, inOrg({ attributes: { path: ['pipelineStatus'], equals: s } })));
    // ABSENT: no pipelineStatus key at all (the JSON path is SQL NULL), exactly as customerStatusWhere reads it.
    statusSets.set('ABSENT', await set('STATUS_ABSENT', customers, inOrg({ attributes: { path: ['pipelineStatus'], equals: Prisma.DbNull } })));
    const working = await set('WORKING', customers, inOrg({ OR: WORKING.map((s) => customerStatusWhere(s)) }));

    // Provenance marks, matched in the query.
    const createdFromCallgrid = await set('MARK_CALLGRID', customers, inOrg({ metadata: { path: ['createdFrom'], equals: 'callgrid' } }));
    const createdFromWebsite = await set('MARK_WEBSITE', customers, inOrg({ metadata: { path: ['createdFrom'], equals: 'website' } }));
    // Any createdFrom string at all (a positive match: a negated null test drops rows with no such path).
    const createdFromAny = await set('MARK_ANY', customers, inOrg({ metadata: { path: ['createdFrom'], string_starts_with: '' } }));
    const webVisitorExternal = await set('MARK_WEB_VISITOR', customers, inOrg({ externalId: { startsWith: 'web-visitor:' } }));
    const demoPrefix = await set('HEURISTIC_DEMO', customers, inOrg({ OR: DEMO_PREFIXES.map((p) => ({ externalId: { startsWith: p } })) }));
    const visitorTag = await set('HEURISTIC_VISITOR_TAG', customers, inOrg({ tags: { has: 'anonymous-visitor' } }));
    const hasExternalId = await set('EXTERNAL_ID', customers, inOrg({ externalId: { not: null } }));
    const noIdentityFields = await set('NO_IDENTITY_FIELDS', customers, inOrg({ firstName: null, lastName: null, email: null }));

    // Deterministic human work (all time).
    const humanNote = await set('HUMAN_NOTE', this.db.interaction as unknown as Finder, { ...org, kind: 'NOTE', customerId: { not: null }, AND: [{ payload: { path: ['loopKind'], equals: 'crm_note' } }, { payload: { path: ['actorType'], equals: 'HUMAN_AGENT' } }] }, 'customerId');
    const userAction = await set('USER_ACTION', this.db.auditLog as unknown as Finder, { ...org, entityType: 'customer', userId: { not: null }, entityId: { not: null } }, 'entityId');
    const userPartyLink = await set('USER_PARTY_LINK', this.db.customerPartyLink as unknown as Finder, { ...org, linkedByUserId: { not: null } }, 'customerId');

    // Activity in the window, by kind (customer ids).
    const since = new Date(now.getTime() - PIPELINE_ACTIVITY_WINDOW_DAYS * DAY);
    const activity = new Map<string, Set<string>>();
    activity.set('INTERACTION', await set('ACT_INTERACTION', this.db.interaction as unknown as Finder, { ...org, customerId: { not: null }, occurredAt: { gte: since } }, 'customerId'));
    activity.set('HUMAN_NOTE', await set('ACT_HUMAN_NOTE', this.db.interaction as unknown as Finder, { ...org, kind: 'NOTE', customerId: { not: null }, occurredAt: { gte: since }, AND: [{ payload: { path: ['loopKind'], equals: 'crm_note' } }, { payload: { path: ['actorType'], equals: 'HUMAN_AGENT' } }] }, 'customerId'));
    activity.set('CONVERSATION', await set('ACT_CONVERSATION', this.db.conversation as unknown as Finder, { ...org, customerId: { not: null }, updatedAt: { gte: since } }, 'customerId'));
    activity.set('BOOKING', await set('ACT_BOOKING', this.db.booking as unknown as Finder, { ...org, customerId: { not: null }, updatedAt: { gte: since } }, 'customerId'));
    activity.set('ORDER', await set('ACT_ORDER', this.db.order as unknown as Finder, { ...org, customerId: { not: null }, updatedAt: { gte: since } }, 'customerId'));
    activity.set('SERVICE_REQUEST', await set('ACT_SERVICE_REQUEST', this.db.serviceRequest as unknown as Finder, { ...org, customerId: { not: null }, updatedAt: { gte: since } }, 'customerId'));
    activity.set('USER_ACTION', await set('ACT_USER_ACTION', this.db.auditLog as unknown as Finder, { ...org, entityType: 'customer', entityId: { not: null }, userId: { not: null }, createdAt: { gte: since } }, 'entityId'));
    activity.set('SYSTEM_AUDIT', await set('ACT_SYSTEM_AUDIT', this.db.auditLog as unknown as Finder, { ...org, entityType: 'customer', entityId: { not: null }, userId: null, createdAt: { gte: since } }, 'entityId'));
    activity.set('PARTY_LINK', await set('ACT_PARTY_LINK', this.db.customerPartyLink as unknown as Finder, { ...org, OR: [{ linkedAt: { gte: since } }, { reversedAt: { gte: since } }] }, 'customerId'));
    const runCustomers = new Set<string>();
    await set('ACT_WORKFLOW_RUN', this.db.workflowRun as unknown as Finder, { ...org, createdAt: { gte: since } }, 'input', (row) => {
      const input = row.input as { context?: { customerId?: unknown } } | null;
      const id = input && typeof input === 'object' ? input.context?.customerId : undefined;
      if (typeof id === 'string') runCustomers.add(id);
    });
    activity.set('WORKFLOW_RUN', runCustomers);

    // The records themselves: timestamps only.
    const byStatus = new Map<string, { total: number; working: number; stalled: number }>(PIPELINE_STATUS_BUCKETS.map((s) => [s, { total: 0, working: 0, stalled: 0 }]));
    const byProvenance = new Map<PipelineProvenance, { total: number; working: number; stalled: number; humanWork: number }>(PIPELINE_PROVENANCE.map((p) => [p.code, { total: 0, working: 0, stalled: 0, humanWork: 0 }]));
    const humanBySignal = zero(HUMAN_WORK_SIGNALS);
    let humanAny = 0;
    let stalledHuman = 0;
    const clockAll = { lastSeenEqualsCreated: 0, lastSeenAfterCreated: 0, lastSeenBeforeCreated: 0 };
    const clockStalled = { ...clockAll };
    const before = { total: 0, working: 0, stalled: 0 };
    const afterCut = { total: 0, working: 0, stalled: 0 };
    let afterWithIngestionMark = 0;
    const months = new Map<string, { total: number; working: number; stalled: number }>();
    const activityByKind = zero(ACTIVITY_KINDS);
    let stalledAny = 0;
    let stalledHumanActivity = 0;
    let stalledCount = 0;
    let nameable = 0;
    let records = 0;
    const staleBefore = new Date(now.getTime() - STALE_DAYS * DAY);

    const provenanceOf = (id: string): PipelineProvenance => {
      if (createdFromAny.has(id) && webVisitorExternal.has(id)) return 'WEB_VISITOR_INGESTION';
      if (createdFromCallgrid.has(id)) return noIdentityFields.has(id) ? 'CALLGRID_INGESTION_CALLER_ONLY' : 'CALLGRID_INGESTION_WITH_IDENTITY';
      if (createdFromWebsite.has(id)) return 'WEB_LEAD_INGESTION';
      if (createdFromAny.has(id)) return 'OTHER_INGESTION';
      if (demoPrefix.has(id)) return 'SEED_OR_DEMO_PREFIX';
      if (visitorTag.has(id)) return 'VISITOR_TAG_ONLY';
      if (hasExternalId.has(id)) return 'EXTERNAL_ID_UNMARKED';
      return 'UNKNOWN';
    };

    await set('RECORDS', customers, org, 'id', (row) => {
      const id = row.id;
      const createdAt = row.createdAt as Date;
      const lastSeenAt = row.lastSeenAt as Date;
      const updatedAt = row.updatedAt as Date;
      records += 1;
      const isWorking = working.has(id);
      const isStalled = isWorking && lastSeenAt < staleBefore;
      const bump = (c: { total: number; working: number; stalled: number }) => {
        c.total += 1;
        if (isWorking) c.working += 1;
        if (isStalled) c.stalled += 1;
      };
      let status = 'OTHER';
      for (const [bucket, ids] of statusSets) if (ids.has(id)) status = bucket;
      bump(byStatus.get(status)!);
      const prov = byProvenance.get(provenanceOf(id))!;
      bump(prov);
      const signals = HUMAN_WORK_SIGNALS.filter((s) => (s === 'HUMAN_NOTE' ? humanNote : s === 'USER_ACTION' ? userAction : userPartyLink).has(id));
      for (const s of signals) humanBySignal[s]! += 1;
      if (signals.length) {
        humanAny += 1;
        prov.humanWork += 1;
        if (isStalled) stalledHuman += 1;
      }
      const clock = (c: { lastSeenEqualsCreated: number; lastSeenAfterCreated: number; lastSeenBeforeCreated: number }) => {
        if (lastSeenAt.getTime() === createdAt.getTime()) c.lastSeenEqualsCreated += 1;
        else if (lastSeenAt > createdAt) c.lastSeenAfterCreated += 1;
        else c.lastSeenBeforeCreated += 1;
      };
      clock(clockAll);
      if (createdAt < slice1At) bump(before);
      else {
        bump(afterCut);
        if (createdFromAny.has(id)) afterWithIngestionMark += 1;
      }
      const m = monthOf(createdAt);
      months.set(m, months.get(m) ?? { total: 0, working: 0, stalled: 0 });
      bump(months.get(m)!);
      if (!isStalled) return;
      stalledCount += 1;
      clock(clockStalled);
      if (entityRefRefusal(`customer:${id}`, 'ORGANIZATION') === null) nameable += 1;
      const kinds: string[] = [];
      if (updatedAt >= since) kinds.push('ROW_UPDATED');
      for (const [kind, ids] of activity) if (ids.has(id)) kinds.push(kind);
      for (const k of kinds) activityByKind[k]! += 1;
      if (kinds.length) stalledAny += 1;
      if (kinds.some((k) => HUMAN_ACTIVITY.has(k))) stalledHumanActivity += 1;
    }, { createdAt: true, lastSeenAt: true, updatedAt: true });

    const monthList = [...months.entries()].sort(([a], [b]) => b.localeCompare(a));
    const listed = monthList.slice(0, MAX_MONTHS).map(([month, c]) => ({ month, ...c }));
    const older = monthList.slice(MAX_MONTHS).reduce((acc, [, c]) => ({ total: acc.total + c.total, working: acc.working + c.working, stalled: acc.stalled + c.stalled }), { total: 0, working: 0, stalled: 0 });
    return {
      records,
      byStatus: [...byStatus.entries()].map(([status, c]) => ({ status, ...c })),
      byProvenance: PIPELINE_PROVENANCE.map((p) => ({ provenance: p.code, basis: p.basis, ...byProvenance.get(p.code)! })),
      humanWork: { bySignal: humanBySignal, any: humanAny, stalledAny: stalledHuman },
      clock: { all: clockAll, stalled: clockStalled },
      cutoff: { at: slice1At.toISOString(), createdBefore: before, createdAfter: afterCut, afterWithIngestionMark },
      months: [...listed.sort((a, b) => a.month.localeCompare(b.month)), ...(older.total ? [{ month: 'EARLIER', ...older }] : [])],
      stalledActivity: { windowDays: PIPELINE_ACTIVITY_WINDOW_DAYS, byKind: activityByKind, any: stalledAny, human: stalledHumanActivity, none: stalledCount - stalledAny },
      nameable: { stalled: stalledCount, nameable },
      complete: incomplete.length === 0,
      incomplete,
    };
  }
}

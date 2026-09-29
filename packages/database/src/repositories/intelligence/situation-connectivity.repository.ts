// What an organization's records could let Situations name -- a read-only diagnostic (2026-09-29). The governed
// relationships themselves (what links they project, what they reject and why) come from the ONE projector the
// Situation pass uses (GovernedEntityLinkProjector), and cross-domain connectivity from the REAL clusterer
// (SituationService.connectivity). This file adds only what a projector does not know:
//   - CallGrid campaign and buyer members: a stable provider id, or only a label (a label-keyed reference is a
//     name, and moves when the member is renamed);
//   - nameable records: the stalled ELIGIBLE intake records Pipeline names as `customer:<id>` (intake
//     eligibility and the work clock), and newly established Parties as `party:<id>`.
//
// READ-ONLY, ONE ORGANIZATION, COUNTS ONLY. Construct it with `readOnlyClient(prisma)`. Every query is scoped by
// the organization; ids read to decide nameability never leave.

import type { PrismaClient } from '@prisma/client';
import { entityRefRefusal } from '@emgloop/shared';

import { INTAKE_WORKING, IntakeEligibilityRepository } from '../intake-eligibility.repository';

const DAY = 24 * 60 * 60 * 1000;
/** The window CallGrid members are counted over: the two 7-day windows the CallGrid and Campaigns readings compare. */
export const CONNECTIVITY_MEMBER_WINDOW_DAYS = 14;
/** Records read into memory per question. More than this and the answer says it is bounded. */
export const CONNECTIVITY_BOUND = 2_000;

const ESTABLISHED = { establishedAt: { not: null }, supersededAt: null, archivedAt: null } as const;
const nameable = (ref: string) => entityRefRefusal(ref, 'ORGANIZATION') === null;

export interface MemberIdentityCounts {
  readonly dimension: 'campaign' | 'buyer';
  readonly windowDays: number;
  /** Distinct members carrying a provider external id. */
  readonly stableExternalId: number;
  /** Distinct members with a label and no external id: their key falls back to the label. */
  readonly labelOnly: number;
  /** Of those, how many label keys pass the entity-ref grammar -- i.e. would be emitted as a reference today. */
  readonly labelOnlyNamedAsRef: number;
  /** Calls with neither: no member at all. */
  readonly unattributedCalls: number;
}

/** CallGrid member identity and nameable records, as counts. */
export interface GovernedConnectivity {
  readonly members: readonly MemberIdentityCounts[];
  readonly pipeline: { readonly working: number; readonly stalled: number; readonly nameable: number };
  readonly crm: { readonly established: number; readonly newlyEstablished7d: number; readonly nameable: number; readonly awaitingDecision: number };
  readonly bounded: boolean;
}

type MemberRow = { externalId: string | null; label: string | null; calls: number };

function memberCounts(dimension: 'campaign' | 'buyer', rows: readonly MemberRow[]): MemberIdentityCounts {
  const stable = new Set<string>();
  const labels = new Set<string>();
  let unattributedCalls = 0;
  for (const r of rows) {
    if (r.externalId) stable.add(r.externalId.toLowerCase());
    else if (r.label) labels.add(r.label.toLowerCase());
    else unattributedCalls += r.calls;
  }
  // The key the readings mint for a label-only member (callDimensionKey), and whether it passes as a reference.
  const labelOnlyNamedAsRef = [...labels].filter((key) => nameable(`provider_member:callgrid:${dimension}:${key}`)).length;
  return { dimension, windowDays: CONNECTIVITY_MEMBER_WINDOW_DAYS, stableExternalId: stable.size, labelOnly: labels.size, labelOnlyNamedAsRef, unattributedCalls };
}

export class SituationConnectivityRepository {
  /** Pass `readOnlyClient(prisma)`. */
  constructor(private readonly db: PrismaClient) {}

  async read(organizationId: string, now: Date): Promise<GovernedConnectivity> {
    const bound = CONNECTIVITY_BOUND;
    let bounded = false;
    const org = { organizationId };

    // 4. CallGrid members: stable provider ids vs label-only keys, over the readings' two windows.
    const since = new Date(now.getTime() - CONNECTIVITY_MEMBER_WINDOW_DAYS * DAY);
    const window = { ...org, sourceOccurredAt: { gte: since, lt: now } };
    const [campaignGroups, buyerGroups] = await Promise.all([
      this.db.marketplaceCall.groupBy({ by: ['campaignExternalId', 'campaignLabel'], where: window, _count: { _all: true } }),
      this.db.marketplaceCall.groupBy({ by: ['buyerExternalId', 'buyerLabel'], where: window, _count: { _all: true } }),
    ]);
    const members = [
      memberCounts('campaign', campaignGroups.map((g) => ({ externalId: g.campaignExternalId, label: g.campaignLabel, calls: g._count._all }))),
      memberCounts('buyer', buyerGroups.map((g) => ({ externalId: g.buyerExternalId, label: g.buyerLabel, calls: g._count._all }))),
    ];

    // 5. Pipeline: the STALLED ELIGIBLE intake records (the subjects of its STALLED signals) as `customer:<id>`
    //    -- intake eligibility and the work clock (IntakeEligibilityRepository), never every Customer row.
    const intake = await new IntakeEligibilityRepository(this.db).read(organizationId, now);
    if (!intake.complete) bounded = true;
    const workingCount = intake.records.filter((r) => (INTAKE_WORKING as readonly string[]).includes(r.status)).length;
    const stalledRecords = intake.records.filter((r) => r.stalled);
    const stalledCount = stalledRecords.length;
    const pipelineIds = stalledRecords.slice(0, bound).map((r) => r.id).filter((id) => nameable(`customer:${id}`));
    if (stalledRecords.length > bound) bounded = true;

    // 6. CRM: newly established Parties (the subjects of its "newly established" signal) as `party:<id>`.
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const [established, awaiting, newRows] = await Promise.all([
      this.db.cognitiveIdentity.count({ where: { ...org, ...ESTABLISHED } }),
      this.db.cognitiveIdentity.count({ where: { ...org, establishedAt: null, supersededAt: null, archivedAt: null } }),
      this.db.cognitiveIdentity.findMany({ where: { ...org, ...ESTABLISHED, establishedAt: { gte: weekAgo, lt: now } }, select: { id: true }, take: bound + 1 }),
    ]);
    if (newRows.length > bound) bounded = true;
    const crmRefs = newRows.slice(0, bound).map((r) => `party:${r.id}`).filter(nameable);

    return {
      members,
      pipeline: { working: workingCount, stalled: stalledCount, nameable: pipelineIds.length },
      crm: { established, newlyEstablished7d: Math.min(newRows.length, bound), nameable: crmRefs.length, awaitingDecision: awaiting },
      bounded,
    };
  }
}

// What an organization's intelligence could LEGITIMATELY connect today -- a read-only diagnostic for the
// Situation pass (2026-09-29). Nothing here creates identity, a link or a reading; it counts the governed
// relationships that already exist and asks what a deterministic entity-link projector could join from them.
//
// GOVERNED RELATIONSHIPS ONLY. A relationship counts only when a record already states it:
//   CustomerPartyLink   an intake record -> its Party (human-approved, reversible; ACTIVE only)
//   CreatorProfile      a creator -> its Party
//   WorkOrigin          a work instance -> the organization digest signal it was promoted from (human-confirmed),
//                       and through it the entities that signal names
// No name, label, email, phone or string similarity joins anything.
//
// NAMEABLE RECORDS. What a record domain could name as a stable canonical reference: a stalled ELIGIBLE intake
// record (intake eligibility and the work clock) as `customer:<id>`, a newly established Party as `party:<id>` -- only ids that pass the entity-ref grammar.
// CallGrid members are counted by whether they carry a stable provider id or only a label (a label-keyed
// reference is a name, and moves when the member is renamed).
//
// READ-ONLY, ONE ORGANIZATION, COUNTS AND CODES. Construct it with `readOnlyClient(prisma)`. Every query is
// scoped by the organization. The ids read to compute joins stay inside the service that composes the answer;
// what leaves it is counts and bounded codes.

import type { PrismaClient } from '@prisma/client';
import { entityRefRefusal } from '@emgloop/shared';

import { absentUntilMigrated } from '../../creator/until-migrated';
import { INTAKE_WORKING, IntakeEligibilityRepository } from '../intake-eligibility.repository';

const DAY = 24 * 60 * 60 * 1000;
/** The window CallGrid members are counted over: the two 7-day windows the CallGrid and Campaigns readings compare. */
export const CONNECTIVITY_MEMBER_WINDOW_DAYS = 14;
/** Records read into memory per question. More than this and the answer says it is bounded. */
export const CONNECTIVITY_BOUND = 2_000;

const ESTABLISHED = { establishedAt: { not: null }, supersededAt: null, archivedAt: null } as const;
const nameable = (ref: string) => entityRefRefusal(ref, 'ORGANIZATION') === null;

/** The governed source each organization domain's reading rests on (the producers' `sourceId`s). */
export const DOMAIN_SOURCE: Readonly<Record<string, string>> = Object.freeze({
  CALLGRID: 'CALLGRID',
  CAMPAIGNS: 'CALLGRID',
  PIPELINE: 'LOOP_INTAKE',
  CRM: 'LOOP_CRM',
  CREATORS: 'LOOP_CREATORS',
  WORK: 'LOOP_WORK',
  WEBSITE: 'WEBSITE_EVENTS',
});

export type WorkOriginOutcome = 'RESOLVES_TO_ENTITY' | 'DIGEST_GONE' | 'SIGNAL_GONE' | 'SIGNAL_NAMES_NO_ENTITY' | 'PRIVATE_SCOPE' | 'CASE_ORIGIN' | 'WORK_ITEM_ORIGIN' | 'OTHER';

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

/** One domain's references in a scenario: what it names (or would name), and the source it rests on. */
export interface ConnectivityDomainRefs {
  readonly domain: string;
  readonly source: string;
  readonly refs: readonly string[];
}

export interface PotentialComponentGroup {
  readonly domains: readonly string[];
  readonly sources: readonly string[];
  readonly count: number;
  /** At least two distinct governed sources. */
  readonly independent: boolean;
}

export interface PotentialSummary {
  /** Connected components spanning at least two domains (an UPPER bound: kind and time window not applied). */
  readonly crossDomain: number;
  /** Of those, spanning at least two distinct governed sources. */
  readonly independent: number;
  /** Cross-domain components the two-source requirement removes. */
  readonly eliminatedSameSource: number;
  readonly groups: readonly PotentialComponentGroup[];
}

/**
 * PURE. The connected components over the domains' references joined by explicit links, and which cross two
 * domains and two sources. A link joins two references; a reference no domain names may still join two that
 * are named (a Party behind an intake record and a creator). Nothing is fuzzy: equality of reference strings
 * and the supplied links only.
 */
export function potentialSituationComponents(domains: readonly ConnectivityDomainRefs[], links: readonly (readonly [string, string])[]): PotentialSummary {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    if (r !== x) parent.set(x, r);
    return r;
  };
  const join = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const [a, b] of links) join(a, b);
  const byRoot = new Map<string, { domains: Set<string>; sources: Set<string> }>();
  for (const d of domains) {
    for (const ref of d.refs) {
      const root = find(ref);
      const c = byRoot.get(root) ?? { domains: new Set<string>(), sources: new Set<string>() };
      c.domains.add(d.domain);
      c.sources.add(d.source);
      byRoot.set(root, c);
    }
  }
  const groups = new Map<string, PotentialComponentGroup>();
  let crossDomain = 0;
  let independent = 0;
  for (const c of byRoot.values()) {
    if (c.domains.size < 2) continue;
    crossDomain += 1;
    const isIndependent = c.sources.size >= 2;
    if (isIndependent) independent += 1;
    const ds = [...c.domains].sort();
    const ss = [...c.sources].sort();
    const key = `${ds.join('+')}|${ss.join('+')}`;
    const g = groups.get(key);
    groups.set(key, { domains: ds, sources: ss, count: (g?.count ?? 0) + 1, independent: isIndependent });
  }
  return {
    crossDomain,
    independent,
    eliminatedSameSource: crossDomain - independent,
    groups: [...groups.values()].sort((a, b) => b.count - a.count || a.domains.join().localeCompare(b.domains.join())),
  };
}

/** The governed facts, as counts; plus (internal only) the references and links the scenario needs. */
export interface GovernedConnectivity {
  /** Null: that record's migration has not reached this database. */
  readonly customerPartyLinks: { readonly active: number; readonly toEstablishedParty: number } | null;
  readonly creatorProfiles: { readonly total: number; readonly withEstablishedParty: number } | null;
  readonly workOrigins: readonly { readonly kind: string; readonly scope: string; readonly outcome: WorkOriginOutcome; readonly count: number }[] | null;
  readonly members: readonly MemberIdentityCounts[];
  readonly pipeline: { readonly working: number; readonly stalled: number; readonly nameable: number; readonly withActivePartyLink: number };
  readonly crm: { readonly established: number; readonly newlyEstablished7d: number; readonly nameable: number; readonly awaitingDecision: number };
  readonly bounded: boolean;
  /** INTERNAL: what Pipeline and CRM would name, and the links a projector would declare. Never printed. */
  readonly scenario: { readonly pipelineRefs: readonly string[]; readonly crmRefs: readonly string[]; readonly links: readonly (readonly [string, string])[] };
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

  private async establishedParties(organizationId: string, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db.cognitiveIdentity.findMany({ where: { organizationId, id: { in: [...new Set(ids)] }, ...ESTABLISHED }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }

  async read(organizationId: string, now: Date): Promise<GovernedConnectivity> {
    const bound = CONNECTIVITY_BOUND;
    let bounded = false;
    const links: (readonly [string, string])[] = [];
    const org = { organizationId };

    // 1. Intake record -> Party (ACTIVE links to established Parties only).
    const cpl = await absentUntilMigrated(this.db.customerPartyLink.findMany({ where: { ...org, reversedAt: null }, select: { customerId: true, partyId: true }, take: bound + 1 }));
    let customerPartyLinks: GovernedConnectivity['customerPartyLinks'] = null;
    const partyOfCustomer = new Map<string, string>();
    if (cpl) {
      if (cpl.length > bound) bounded = true;
      const rows = cpl.slice(0, bound);
      const established = await this.establishedParties(organizationId, rows.map((r) => r.partyId));
      for (const r of rows) if (established.has(r.partyId)) partyOfCustomer.set(r.customerId, r.partyId);
      customerPartyLinks = { active: await this.db.customerPartyLink.count({ where: { ...org, reversedAt: null } }), toEstablishedParty: partyOfCustomer.size };
    }

    // 2. Creator -> Party.
    const profiles = await absentUntilMigrated(this.db.creatorProfile.findMany({ where: org, select: { id: true, partyId: true }, take: bound + 1 }));
    let creatorProfiles: GovernedConnectivity['creatorProfiles'] = null;
    if (profiles) {
      if (profiles.length > bound) bounded = true;
      const rows = profiles.slice(0, bound);
      const established = await this.establishedParties(organizationId, rows.map((r) => r.partyId));
      const governed = rows.filter((r) => established.has(r.partyId));
      for (const r of governed) if (nameable(`creator:${r.id}`) && nameable(`party:${r.partyId}`)) links.push([`creator:${r.id}`, `party:${r.partyId}`]);
      creatorProfiles = { total: await this.db.creatorProfile.count({ where: org }), withEstablishedParty: governed.length };
    }

    // 3. Work instance -> the entities of the organization signal it was promoted from.
    const origins = await absentUntilMigrated(
      this.db.workOrigin.findMany({ where: org, select: { workInstanceId: true, originKind: true, originScope: true, originRef: true }, orderBy: { promotedAt: 'desc' }, take: bound + 1 }),
    );
    let workOrigins: GovernedConnectivity['workOrigins'] = null;
    if (origins) {
      if (origins.length > bound) bounded = true;
      const rows = origins.slice(0, bound);
      const digestIds = rows.filter((r) => r.originKind === 'DIGEST_SIGNAL' && r.originScope === 'ORGANIZATION').map((r) => r.originRef.split('#')[0]!).filter(Boolean);
      const digests = digestIds.length
        ? await this.db.intelligenceDigest.findMany({ where: { ...org, scope: 'ORGANIZATION', userId: null, id: { in: [...new Set(digestIds)] } }, select: { id: true, content: true } })
        : [];
      const signalsOf = new Map(digests.map((d) => [d.id, (d.content as { signals?: { key?: unknown; entities?: unknown }[] } | null)?.signals ?? []]));
      const tally = new Map<string, { kind: string; scope: string; outcome: WorkOriginOutcome; count: number }>();
      for (const r of rows) {
        let outcome: WorkOriginOutcome;
        if (r.originScope !== 'ORGANIZATION') outcome = 'PRIVATE_SCOPE';
        else if (r.originKind === 'CASE') outcome = 'CASE_ORIGIN';
        else if (r.originKind === 'WORK_ITEM') outcome = 'WORK_ITEM_ORIGIN';
        else if (r.originKind !== 'DIGEST_SIGNAL') outcome = 'OTHER';
        else {
          const at = r.originRef.indexOf('#');
          const signals = signalsOf.get(r.originRef.slice(0, at));
          const signal = signals?.find((s) => s.key === r.originRef.slice(at + 1));
          const entities = Array.isArray(signal?.entities) ? (signal!.entities as unknown[]).filter((e): e is string => typeof e === 'string' && nameable(e)) : [];
          outcome = !signals ? 'DIGEST_GONE' : !signal ? 'SIGNAL_GONE' : entities.length === 0 ? 'SIGNAL_NAMES_NO_ENTITY' : 'RESOLVES_TO_ENTITY';
          if (outcome === 'RESOLVES_TO_ENTITY' && nameable(`work_instance:${r.workInstanceId}`)) for (const e of entities) links.push([`work_instance:${r.workInstanceId}`, e]);
        }
        const key = `${r.originKind}|${r.originScope}|${outcome}`;
        const t = tally.get(key);
        tally.set(key, { kind: r.originKind, scope: r.originScope, outcome, count: (t?.count ?? 0) + 1 });
      }
      workOrigins = [...tally.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.outcome.localeCompare(b.outcome));
    }

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
    let withActivePartyLink = 0;
    for (const id of pipelineIds) {
      const party = partyOfCustomer.get(id);
      if (party && nameable(`party:${party}`)) {
        withActivePartyLink += 1;
        links.push([`customer:${id}`, `party:${party}`]);
      }
    }

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
      customerPartyLinks,
      creatorProfiles,
      workOrigins,
      members,
      pipeline: { working: workingCount, stalled: stalledCount, nameable: pipelineIds.length, withActivePartyLink },
      crm: { established, newlyEstablished7d: Math.min(newRows.length, bound), nameable: crmRefs.length, awaitingDecision: awaiting },
      bounded,
      scenario: { pipelineRefs: pipelineIds.map((id) => `customer:${id}`), crmRefs, links },
    };
  }
}

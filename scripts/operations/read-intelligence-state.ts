// Read intelligence state -- one organization's commissioned intelligence, from production rows.
//
// READ-ONLY. It prints what the CallGrid detector and the outbox actually recorded: the CallGrid
// Cases seen since a moment, each with its log of sightings (type, actor, time); duplicate Cases by
// rule and entity; how many rows each intelligence table gained since that moment; the outbox by
// domain and status; whether any relationship event qualifies for the creator review; delivery
// and subscription state; per member, calendar attendee-key coverage and identity suggestions by
// state; and the intelligence refresh queue, aggregated by domain, scope, state, attempts and the
// hold/retry outcome code (why a refresh is HELD); and the organization's situation pass, diagnosed
// read-only (digests, eligibility, signals, entity refs, links, clusters, decided, and the first gate that
// stopped it) -- it calls no model; and what the organization could legitimately connect (governed
// relationships, stable vs label-only CallGrid members, nameable records, and potential cross-domain
// components today and with the proposed link projector, with and without two distinct sources). It writes
// nothing and creates no link -- no retry, no purge, no stale
// transition: the reader is built on a client that can only read
// (`readOnlyClient`), and nothing here names a write.
//
// WHAT IT NEVER PRINTS: a title, a summary, a note or reason, an evidence payload, a buyer, vendor
// or campaign name or id, the entity half of a recurrence key, a user id or email, an address, an
// attendee key, a message or a token; from the refresh queue, never a user id, subject ref, source id or
// fingerprint. A person is the cycle's own `ref` digest. Every other value
// is a code-vocabulary token (a rule id, a state, a status); anything that is not one prints as
// UNRECOGNIZED rather than as itself.
//
// NO SCHEDULE, NO PUSH, NO PULL_REQUEST, NO WORKFLOW_CALL. Reading production is still touching
// production, and a human should be the one asking.

import type { IntelligenceState, SituationConnectivity, SituationDiagnosis } from '@emgloop/database';
import { employeeRef } from './cycle-employee-sources';

export interface IntelligenceStateReader {
  organizationBySlug(slug: string): Promise<{ id: string; slug: string } | null>;
  read(organizationId: string, since: Date): Promise<IntelligenceState>;
}

export interface IntelligenceStateDeps {
  reader: IntelligenceStateReader;
  /**
   * The ORGANIZATION situation pass, diagnosed read-only (SituationService.diagnose on a read-only client,
   * with no runtime: no model can be called). Absent: the section is not printed.
   */
  situations?: (organizationId: string) => Promise<SituationDiagnosis>;
  /**
   * What the organization could legitimately connect (SituationService.connectivity on the same read-only
   * client): governed relationships as counts, and potential cross-domain components today and with the
   * proposed entity-link projector, with and without the two-source requirement. Absent: not printed.
   */
  connectivity?: (organizationId: string) => Promise<SituationConnectivity>;
  now: () => Date;
  log: (line: string) => void;
}

export interface IntelligenceStateResult {
  readonly overall: 'READ' | 'FAILED_PRECONDITION';
}

/** When no moment is given: the last day. */
export const DEFAULT_LOOKBACK_HOURS = 24;
/** The furthest back a read may look. Enough for a commissioning week, not a history dump. */
export const MAX_LOOKBACK_DAYS = 30;

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
/** A code-vocabulary token: rule ids, states, statuses, keys like `daily:2026-09-19`, patterns like `relationship.*`. */
const TOKEN = /^[A-Za-z0-9_.:*\-]{1,80}$/;

type Field = string | number | boolean | null;

function line(fields: Record<string, Field>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '-' : String(v)}`)
    .join(' ');
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** A value printed only when it is a code token. Never free text. */
export function token(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return TOKEN.test(value) ? value : 'UNRECOGNIZED';
}

export function parseArgs(argv: readonly string[]): { organization: string; since: string } {
  let organization = '';
  let since = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--organization' || argv[i] === '--org') {
      organization = (argv[i + 1] ?? '').trim();
      i += 1;
    } else if (argv[i] === '--since') {
      since = (argv[i + 1] ?? '').trim();
      i += 1;
    }
  }
  return { organization, since };
}

export function readEnvironment(env: NodeJS.ProcessEnv): { ok: true } | { ok: false; missing: string[] } {
  return env.DATABASE_URL?.trim() ? { ok: true } : { ok: false, missing: ['DATABASE_URL'] };
}

/** The moment to read from: the one given, or a day ago. Never in the future, never beyond the bound. */
export function resolveSince(value: string, now: Date): { ok: true; since: Date } | { ok: false; reason: string } {
  if (value === '') return { ok: true, since: new Date(now.getTime() - DEFAULT_LOOKBACK_HOURS * 3_600_000) };
  if (!INSTANT.test(value)) return { ok: false, reason: '--since must be an ISO-8601 UTC instant, e.g. 2026-09-19T18:00:00Z' };
  const since = new Date(value);
  if (Number.isNaN(since.getTime())) return { ok: false, reason: '--since is not a real instant' };
  if (since.getTime() > now.getTime()) return { ok: false, reason: '--since is in the future' };
  if (now.getTime() - since.getTime() > MAX_LOOKBACK_DAYS * 86_400_000) return { ok: false, reason: `--since is more than ${MAX_LOOKBACK_DAYS} days ago` };
  return { ok: true, since };
}

export async function runIntelligenceState(
  request: { organizationSlug: string; since: string },
  deps: IntelligenceStateDeps,
): Promise<IntelligenceStateResult> {
  const refuse = (reason: string): IntelligenceStateResult => {
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return { overall: 'FAILED_PRECONDITION' };
  };
  if (!SLUG.test(request.organizationSlug)) return refuse('--organization must be lowercase letters, digits and hyphens');
  const now = deps.now();
  const window = resolveSince(request.since, now);
  if (!window.ok) return refuse(window.reason);
  const org = await deps.reader.organizationBySlug(request.organizationSlug);
  if (!org) return refuse('unknown organization');

  const state = await deps.reader.read(org.id, window.since);
  deps.log(line({ event: 'ORGANIZATION', organization: org.slug, since: iso(window.since), at: iso(now) }));

  // 1. CallGrid Cases created, seen or changed since the moment, with their sightings.
  let createdSince = 0;
  for (const c of state.cases.rows) {
    if (c.createdAt >= window.since) createdSince += 1;
    deps.log(line({
      event: 'CASE',
      id: token(c.id),
      rule: token(c.rule),
      entityType: token(c.entityType),
      state: token(c.state),
      severity: token(c.severity),
      outcome: token(c.outcome),
      createdAt: iso(c.createdAt),
      firstSeen: iso(c.firstDetectedAt),
      lastSeen: iso(c.lastDetectedAt),
      timesSeen: c.timesSeen,
      reopened: c.timesReopened,
      hypothesis: c.hasHypothesis,
      logEntries: c.logEntries,
      humanActs: c.humanActs,
      scope: c.organizationId === org.id ? 'OK' : 'MISMATCH',
    }));
    for (const s of c.sightings) {
      deps.log(line({
        event: 'SIGHTING',
        case: token(c.id),
        type: token(s.type),
        actor: token(s.actorType),
        source: token(s.source),
        occurredAt: iso(s.occurredAt),
        recordedAt: iso(s.recordedAt),
        detectionKey: token(s.detectionKey),
      }));
    }
  }
  deps.log(line({
    event: 'CASES',
    listed: state.cases.rows.length,
    createdSince,
    existedBefore: state.cases.rows.length - createdSince,
    truncated: state.cases.truncated,
    sightingsTruncated: state.cases.sightingsTruncated,
  }));
  for (const g of state.caseLogSince) deps.log(line({ event: 'CASE_LOG_SINCE', type: token(g.type), actor: token(g.actorType), count: g.count }));
  deps.log(line({ event: 'CASE_LOG_SINCE_SUMMARY', groups: state.caseLogSince.length, bounded: state.caseLogSinceBounded }));

  // 2. Duplicates by rule and entity. Case ids only: the entity is never printed.
  for (const g of state.duplicates.groups) {
    deps.log(line({ event: 'DUPLICATE', basis: g.basis, rule: token(g.rule), cases: g.caseIds.length, ids: g.caseIds.map((id) => token(id)).join(',') }));
  }
  deps.log(line({ event: 'DUPLICATES', groups: state.duplicates.groups.length, scanned: state.duplicates.scanned, bounded: state.duplicates.bounded }));

  // 3. Rows written since the moment.
  deps.log(line({ event: 'WRITES', since: iso(window.since), ...state.writesSince }));

  // 4. The outbox.
  for (const g of state.outbox.groups) deps.log(line({ event: 'OUTBOX', domain: token(g.domain), status: token(g.status), count: g.count }));
  deps.log(line({
    event: 'OUTBOX_SUMMARY',
    total: state.outbox.total,
    oldestWaitingCreatedAt: iso(state.outbox.oldestPending?.createdAt ?? null),
    oldestWaitingAvailableAt: iso(state.outbox.oldestPending?.availableAt ?? null),
    bounded: state.outbox.bounded,
  }));

  // 5. Creator eligibility.
  const byStatus = (prefix: string, counts: Readonly<Record<string, number>>) =>
    Object.fromEntries(Object.entries(counts).map(([status, n]) => [`${prefix}${token(status)}`, n]));
  deps.log(line({
    event: 'CREATOR',
    relationshipEvents: state.creator.relationshipEvents,
    ...byStatus('relationship_', state.creator.relationshipEventsByStatus),
    qualifying: state.creator.qualifying,
    ...byStatus('qualifying_', state.creator.qualifyingByStatus),
    creatorHubEvents: state.creator.creatorHubEvents,
    reviewCases: state.creator.reviewCases,
    reviewCasesSince: state.creator.reviewCasesSince,
    bounded: state.creator.bounded,
  }));
  for (const r of state.creator.crmRelationships) deps.log(line({ event: 'CRM_RELATIONSHIPS', kind: token(r.kind), state: token(r.state), count: r.count }));

  // 6. Deliveries and subscriptions.
  for (const d of state.deliveries) deps.log(line({ event: 'DELIVERIES', subscriber: token(d.subscriberKey), status: token(d.status), count: d.count }));
  deps.log(line({ event: 'DELIVERY_SUMMARY', groups: state.deliveries.length, bounded: state.deliveriesBounded }));
  for (const s of state.subscriptions) {
    deps.log(line({
      event: 'SUBSCRIPTION',
      key: token(s.subscriberKey),
      handler: token(s.handler),
      domain: token(s.domain),
      pattern: token(s.stateKeyPattern),
      status: token(s.status),
      required: s.required,
      createdAt: iso(s.createdAt),
    }));
  }

  // 7. Per member: attendee-key coverage and identity suggestions, as counts, by the cycle's ref.
  for (const e of state.employees) {
    deps.log(line({
      event: 'EMPLOYEE',
      ref: employeeRef({ organizationId: org.id, userId: e.userId }),
      membership: token(e.membershipStatus),
      role: token(e.role),
      events: e.events,
      attendanceKnown: e.eventsAttendanceKnown,
      eventsWithAttendeeKeys: e.eventsWithAttendeeKeys,
      attendeeKeys: e.attendeeKeys,
      latestKeyedEventObservedAt: iso(e.latestKeyedEventObservedAt),
      suggestionsProposed: e.suggestions.PROPOSED,
      suggestionsConfirmed: e.suggestions.CONFIRMED,
      suggestionsRejected: e.suggestions.REJECTED,
      suggestionsOther: e.suggestions.OTHER,
    }));
  }

  // 8. The intelligence refresh queue: identical requests aggregated; metadata and outcome codes only.
  if (state.refreshQueue === null) deps.log(line({ event: 'INTELLIGENCE_REFRESH_SUMMARY', present: false }));
  else {
    for (const g of state.refreshQueue.groups) {
      deps.log(line({
        event: 'INTELLIGENCE_REFRESH',
        domain: token(g.domain),
        scope: token(g.scope),
        state: token(g.state),
        attempts: g.attempts,
        reason: token(g.outcome),
        count: g.count,
        oldestCreatedAt: iso(g.oldestCreatedAt),
        latestUpdatedAt: iso(g.latestUpdatedAt),
      }));
    }
    const held = state.refreshQueue.groups.filter((g) => g.state === 'HELD').reduce((n, g) => n + g.count, 0);
    const total = state.refreshQueue.groups.reduce((n, g) => n + g.count, 0);
    deps.log(line({ event: 'INTELLIGENCE_REFRESH_SUMMARY', present: true, requests: total, held, bounded: state.refreshQueue.bounded }));
  }

  // 9. The organization's situation pass, diagnosed: why it would (or would not) call situation.synthesis.
  if (deps.situations) {
    const d = await deps.situations(org.id);
    const list = (xs: readonly string[]) => (xs.length ? xs.map((x) => token(x)).join(',') : null);
    for (const r of d.domains) {
      deps.log(line({ event: 'SITUATION_DOMAIN', domain: token(r.domain), digests: r.digests, eligible: r.eligible, signals: r.signals, clusterable: r.clusterable, entityRefs: r.entityRefs }));
    }
    for (const [reason, count] of Object.entries(d.ineligible)) deps.log(line({ event: 'SITUATION_INELIGIBLE', reason: token(reason), count }));
    for (const [kind, count] of Object.entries(d.excluded.kind)) deps.log(line({ event: 'SITUATION_EXCLUDED', basis: 'KIND', kind: token(kind), count }));
    if (d.excluded.noEntity > 0) deps.log(line({ event: 'SITUATION_EXCLUDED', basis: 'NO_ENTITY', kind: null, count: d.excluded.noEntity }));
    deps.log(line({
      event: 'SITUATION_PASS',
      scope: 'ORGANIZATION',
      selected: d.selected,
      digests: d.digests,
      eligibleDigests: d.eligibleDigests,
      eligibleDomains: list(d.eligibleDomains),
      signals: d.signals,
      clusterableSignals: d.clusterableSignals,
      clusterableDomains: list(d.clusterableDomains),
      entityRefs: d.entityRefs,
      explicitLinks: d.explicitLinks,
      sharedAcrossDomains: d.sharedAcrossDomains,
      clusters: d.clusters,
      unchanged: d.unchanged,
      wouldSynthesize: d.wouldSynthesize,
      reason: token(d.reason),
      modelCalls: 0,
    }));
  }

  // 10. What the organization could legitimately connect -- counts and codes; no link is created.
  if (deps.connectivity) {
    const c = await deps.connectivity(org.id);
    const joined = (xs: readonly string[]) => (xs.length ? xs.map((x) => token(x)).join('+') : null);
    const g = c.governed;
    deps.log(line({ event: 'SITUATION_RELATIONSHIP', relationship: 'CUSTOMER_PARTY_LINK', present: g.customerPartyLinks !== null, active: g.customerPartyLinks?.active ?? null, toEstablishedParty: g.customerPartyLinks?.toEstablishedParty ?? null }));
    deps.log(line({ event: 'SITUATION_RELATIONSHIP', relationship: 'CREATOR_PARTY', present: g.creatorProfiles !== null, profiles: g.creatorProfiles?.total ?? null, withEstablishedParty: g.creatorProfiles?.withEstablishedParty ?? null }));
    if (g.workOrigins === null) deps.log(line({ event: 'SITUATION_WORK_ORIGIN', present: false }));
    else if (g.workOrigins.length === 0) deps.log(line({ event: 'SITUATION_WORK_ORIGIN', present: true, count: 0 }));
    else for (const o of g.workOrigins) deps.log(line({ event: 'SITUATION_WORK_ORIGIN', present: true, kind: token(o.kind), scope: token(o.scope), outcome: token(o.outcome), count: o.count }));
    for (const m of g.members) {
      deps.log(line({ event: 'SITUATION_MEMBERS', provider: 'CALLGRID', dimension: token(m.dimension), windowDays: m.windowDays, stableExternalId: m.stableExternalId, labelOnly: m.labelOnly, labelOnlyNamedAsRef: m.labelOnlyNamedAsRef, unattributedCalls: m.unattributedCalls }));
    }
    deps.log(line({ event: 'SITUATION_NAMEABLE', domain: 'PIPELINE', kind: 'customer', working: g.pipeline.working, stalled: g.pipeline.stalled, nameable: g.pipeline.nameable, withActivePartyLink: g.pipeline.withActivePartyLink }));
    deps.log(line({ event: 'SITUATION_NAMEABLE', domain: 'CRM', kind: 'party', established: g.crm.established, newlyEstablished7d: g.crm.newlyEstablished7d, nameable: g.crm.nameable, awaitingDecision: g.crm.awaitingDecision }));
    for (const [scenario, p] of [['CURRENT', c.current], ['PROJECTOR', c.projector]] as const) {
      for (const grp of p.groups) {
        deps.log(line({ event: 'SITUATION_POTENTIAL_GROUP', scenario, domains: joined(grp.domains), sources: joined(grp.sources), count: grp.count, independent: grp.independent }));
      }
      deps.log(line({ event: 'SITUATION_POTENTIAL', scenario, crossDomain: p.crossDomain, independent: p.independent, eliminatedSameSource: p.eliminatedSameSource, bound: 'UPPER' }));
    }
    deps.log(line({ event: 'SITUATION_CONNECTIVITY_SUMMARY', bounded: g.bounded, linksCreated: 0, modelCalls: 0 }));
  }

  deps.log(line({
    event: 'SUMMARY',
    cases: state.cases.rows.length,
    duplicateGroups: state.duplicates.groups.length,
    subscriptions: state.subscriptions.length,
    employees: state.employees.length,
    employeesBounded: state.employeesBounded,
    OVERALL_RESULT: 'READ',
  }));
  return { overall: 'READ' };
}

// --- Wiring -------------------------------------------------------------------

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  const args = parseArgs(process.argv.slice(2));
  if (!args.organization) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--organization <slug> is required' }));
    return 2;
  }
  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(',') }));
    return 2;
  }

  const { prisma, readOnlyClient, IntelligenceStateRepository, SituationService } = await import('@emgloop/database');
  try {
    // The reader gets a client that can only read. Its own `$disconnect` stays with this wiring.
    const reader = new IntelligenceStateRepository(readOnlyClient(prisma));
    // The situation diagnosis: the same read-only client, NO runtime and no task enabled -- it cannot call a model.
    const situationService = new SituationService({ prisma: readOnlyClient(prisma), runtime: null, modelEnabled: () => false, principalFor: async () => null, now: () => new Date() });
    const situations = (organizationId: string) => situationService.diagnose({ scope: 'ORGANIZATION', organizationId });
    const connectivity = (organizationId: string) => situationService.connectivity(organizationId);
    const result = await runIntelligenceState({ organizationSlug: args.organization, since: args.since }, { reader, situations, connectivity, now: () => new Date(), log });
    return result.overall === 'READ' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]read-intelligence-state\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // A class, never a cause: a database error message can carry a connection string or a value.
      process.stdout.write(line({ event: 'RUN_FAILED', reason: 'UNEXPECTED' }) + '\n');
      process.exitCode = 1;
    },
  );
}

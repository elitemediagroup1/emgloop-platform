// Read intelligence state -- what the commissioned intelligence paths have actually done, in one
// organization, from production rows. A diagnostic reader for the Intelligence & Memory
// Foundation (docs/architecture/intelligence-foundation.md §9).
//
// READ-ONLY, ONE ORGANIZATION, IDS AND COUNTS. Construct it with `readOnlyClient(prisma)`: every
// model then offers only its read methods, so nothing here can write even by mistake. Every
// query is scoped by the organization. What leaves this file:
//   - Case ids, the rule half of a Case's recurrence key, states, severities, times and counters;
//   - the type and actor of each log entry, never its note, reason or evidence;
//   - counts of rows, by table, status, domain or kind;
//   - subscription definitions (which handler, which domain, which key pattern);
//   - per member, counts of calendar events and attendee keys and of identity suggestions, with
//     the member's user id so the runner can reduce it to the cycle's `ref`.
// It never selects a title, a summary, a note, a reason, an evidence payload, an entity name, an
// address, an attendee key or a message. The entity half of a recurrence key can hold a buyer's
// NAME (`callgrid-scoring.ts` falls back to it when there is no id), so it is used only inside
// this file, to group duplicates, and is never returned.
//
// BOUNDED. Tallies that need rows in memory stop at a bound and say so (`bounded: true`), so a
// partial number is never presented as a whole one.
import type { PrismaClient } from '@prisma/client';
import { CALLGRID_DECISION_PRODUCER } from '@emgloop/shared';
import { CREATOR_ONBOARDING_PRODUCER } from '../services/intelligence/creator-onboarding';
import { IDENTITY_MATCH_TYPE } from './cognitive/identity-suggestion.repository';

/** The producer the CallGrid pipeline records Cases as (apps/web `CALLGRID_SOURCE`). */
export const CALLGRID_CASE_PRODUCER = CALLGRID_DECISION_PRODUCER;
/** Cases listed in one read. More than this and the list says it was cut. */
export const INTELLIGENCE_STATE_CASE_LIMIT = 200;
/** Log entries listed across those Cases. */
export const INTELLIGENCE_STATE_SIGHTING_LIMIT = 2_000;
/** Rows a tally may hold in memory before it reports itself bounded. */
export const INTELLIGENCE_STATE_SCAN_BOUND = 50_000;

export interface IntelligenceStateSighting {
  readonly type: string;
  readonly actorType: string;
  readonly source: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly detectionKey: string | null;
}

export interface IntelligenceStateCase {
  readonly id: string;
  readonly organizationId: string;
  /** The rule half of the recurrence key. The entity half is never returned. */
  readonly rule: string;
  /** From the Case's evidence rows: buyer, vendor, campaign, ... Null when none says. */
  readonly entityType: string | null;
  readonly state: string;
  readonly severity: string;
  readonly outcome: string | null;
  readonly createdAt: Date;
  readonly firstDetectedAt: Date;
  readonly lastDetectedAt: Date;
  readonly timesSeen: number;
  readonly timesReopened: number;
  readonly hasHypothesis: boolean;
  readonly logEntries: number;
  readonly humanActs: number;
  /** Log entries recorded at or after `since`, oldest first. */
  readonly sightings: readonly IntelligenceStateSighting[];
}

export interface IntelligenceStateDuplicateGroup {
  /** Same rule and the same entity half of the key; or the same rule and the same provider entity id. */
  readonly basis: 'RULE_AND_KEY_ENTITY' | 'RULE_AND_ENTITY_REFERENCE';
  readonly rule: string;
  readonly caseIds: readonly string[];
}

export const INTELLIGENCE_STATE_WRITE_TABLES = [
  'casesCreated',
  'casesUpdated',
  'caseLog',
  'caseEvidence',
  'hypotheses',
  'outbox',
  'deliveries',
  'draftsCreated',
  'draftsSent',
  'crmRelationships',
  'crmParticipants',
] as const;
export type IntelligenceStateWriteTable = (typeof INTELLIGENCE_STATE_WRITE_TABLES)[number];

export interface IntelligenceStateEmployee {
  readonly userId: string;
  readonly membershipStatus: string;
  readonly role: string;
  readonly events: number;
  readonly eventsAttendanceKnown: number;
  readonly eventsWithAttendeeKeys: number;
  readonly attendeeKeys: number;
  readonly latestKeyedEventObservedAt: Date | null;
  readonly suggestions: Readonly<Record<'PROPOSED' | 'CONFIRMED' | 'REJECTED' | 'OTHER', number>>;
}

export interface IntelligenceState {
  readonly organizationId: string;
  readonly since: Date;
  readonly cases: { readonly rows: readonly IntelligenceStateCase[]; readonly truncated: boolean; readonly sightingsTruncated: boolean };
  /** CallGrid Case log entries recorded since `since`, by type and actor. */
  readonly caseLogSince: readonly { readonly type: string; readonly actorType: string; readonly count: number }[];
  readonly caseLogSinceBounded: boolean;
  readonly duplicates: { readonly groups: readonly IntelligenceStateDuplicateGroup[]; readonly scanned: number; readonly bounded: boolean };
  readonly writesSince: Readonly<Record<IntelligenceStateWriteTable, number>>;
  readonly outbox: {
    readonly groups: readonly { readonly domain: string; readonly status: string; readonly count: number }[];
    readonly total: number;
    readonly oldestPending: { readonly createdAt: Date; readonly availableAt: Date } | null;
    readonly bounded: boolean;
  };
  readonly creator: {
    readonly relationshipEvents: number;
    readonly relationshipEventsByStatus: Readonly<Record<string, number>>;
    /** A TALENT_REPRESENTATION Relationship becoming ACTIVE: what the creator review acts on. */
    readonly qualifying: number;
    readonly qualifyingByStatus: Readonly<Record<string, number>>;
    readonly creatorHubEvents: number;
    readonly reviewCases: number;
    readonly reviewCasesSince: number;
    readonly crmRelationships: readonly { readonly kind: string; readonly state: string; readonly count: number }[];
    readonly bounded: boolean;
  };
  readonly deliveries: readonly { readonly subscriberKey: string; readonly status: string; readonly count: number }[];
  readonly deliveriesBounded: boolean;
  readonly subscriptions: readonly {
    readonly subscriberKey: string;
    readonly handler: string;
    readonly domain: string | null;
    readonly stateKeyPattern: string | null;
    readonly status: string;
    readonly required: boolean;
    readonly createdAt: Date;
  }[];
  readonly employees: readonly IntelligenceStateEmployee[];
  readonly employeesBounded: boolean;
}

/** The rule half of `<ruleId>::<entity>`. */
function ruleOf(recurrenceKey: string): string {
  const at = recurrenceKey.indexOf('::');
  return at < 0 ? recurrenceKey : recurrenceKey.slice(0, at);
}

function entityOf(recurrenceKey: string): string {
  const at = recurrenceKey.indexOf('::');
  return at < 0 ? '' : recurrenceKey.slice(at + 2);
}

/** Counts by a composite key of plain values. */
function tally<T>(rows: readonly T[], parts: (row: T) => readonly string[]): { parts: string[]; count: number }[] {
  const out = new Map<string, { parts: string[]; count: number }>();
  for (const row of rows) {
    const p = [...parts(row)];
    const k = JSON.stringify(p);
    const hit = out.get(k);
    if (hit) hit.count += 1;
    else out.set(k, { parts: p, count: 1 });
  }
  return [...out.values()];
}

export class IntelligenceStateRepository {
  /** Pass `readOnlyClient(prisma)`. */
  constructor(private readonly db: PrismaClient) {}

  organizationBySlug(slug: string): Promise<{ id: string; slug: string } | null> {
    return this.db.organization.findFirst({ where: { slug }, select: { id: true, slug: true } });
  }

  async read(organizationId: string, since: Date): Promise<IntelligenceState> {
    const org = { organizationId };
    const bound = INTELLIGENCE_STATE_SCAN_BOUND;

    // 1. CallGrid Cases created, seen or changed since `since`. Titles and summaries are not selected.
    const caseRows = await this.db.operationalPriority.findMany({
      where: {
        ...org,
        sourceSystem: CALLGRID_CASE_PRODUCER,
        OR: [{ createdAt: { gte: since } }, { lastDetectedAt: { gte: since } }, { updatedAt: { gte: since } }],
      },
      select: {
        id: true,
        organizationId: true,
        recurrenceKey: true,
        state: true,
        severity: true,
        outcome: true,
        createdAt: true,
        firstDetectedAt: true,
        lastDetectedAt: true,
        detectionCount: true,
        reopenCount: true,
        hypothesisId: true,
      },
      orderBy: { createdAt: 'asc' },
      take: INTELLIGENCE_STATE_CASE_LIMIT + 1,
    });
    const listed = caseRows.slice(0, INTELLIGENCE_STATE_CASE_LIMIT);
    const ids = listed.map((c) => c.id);
    const evidence = ids.length
      ? await this.db.decisionEvidence.findMany({ where: { ...org, priorityId: { in: ids } }, select: { priorityId: true, entityType: true }, take: bound })
      : [];
    const log = ids.length
      ? await this.db.operationalObservation.findMany({ where: { ...org, priorityId: { in: ids } }, select: { priorityId: true, actorType: true }, take: bound })
      : [];
    const recent = ids.length
      ? await this.db.operationalObservation.findMany({
          where: { ...org, priorityId: { in: ids }, recordedAt: { gte: since } },
          select: { priorityId: true, observationType: true, actorType: true, source: true, occurredAt: true, recordedAt: true, detectionKey: true },
          orderBy: { recordedAt: 'asc' },
          take: INTELLIGENCE_STATE_SIGHTING_LIMIT + 1,
        })
      : [];
    const sightings = recent.slice(0, INTELLIGENCE_STATE_SIGHTING_LIMIT);
    const cases: IntelligenceStateCase[] = listed.map((c) => ({
      id: c.id,
      organizationId: c.organizationId,
      rule: ruleOf(c.recurrenceKey),
      entityType: evidence.find((e) => e.priorityId === c.id && e.entityType)?.entityType ?? null,
      state: c.state,
      severity: c.severity,
      outcome: c.outcome,
      createdAt: c.createdAt,
      firstDetectedAt: c.firstDetectedAt,
      lastDetectedAt: c.lastDetectedAt,
      timesSeen: c.detectionCount,
      timesReopened: c.reopenCount,
      hasHypothesis: c.hypothesisId !== null,
      logEntries: log.filter((o) => o.priorityId === c.id).length,
      humanActs: log.filter((o) => o.priorityId === c.id && o.actorType === 'HUMAN').length,
      sightings: sightings
        .filter((o) => o.priorityId === c.id)
        .map((o) => ({ type: o.observationType, actorType: o.actorType, source: o.source, occurredAt: o.occurredAt, recordedAt: o.recordedAt, detectionKey: o.detectionKey })),
    }));

    // Every CallGrid Case log entry recorded since `since`, whatever Case it belongs to.
    const callgridIds = (
      await this.db.operationalPriority.findMany({ where: { ...org, sourceSystem: CALLGRID_CASE_PRODUCER }, select: { id: true }, take: bound + 1 })
    ).map((c) => c.id);
    const logSince = callgridIds.length
      ? await this.db.operationalObservation.findMany({
          where: { ...org, recordedAt: { gte: since }, priorityId: { in: callgridIds.slice(0, bound) } },
          select: { observationType: true, actorType: true },
          take: bound + 1,
        })
      : [];
    const caseLogSince = tally(logSince.slice(0, bound), (o) => [o.observationType, o.actorType]).map(({ parts: [type, actorType], count }) => ({
      type: type!,
      actorType: actorType!,
      count,
    }));

    // 2. Duplicates: every CallGrid Case in the organization, grouped by rule + entity, two ways.
    const all = await this.db.operationalPriority.findMany({
      where: { ...org, sourceSystem: CALLGRID_CASE_PRODUCER },
      select: { id: true, recurrenceKey: true, sourceReference: true },
      take: bound + 1,
    });
    const scanned = all.slice(0, bound);
    const groups: IntelligenceStateDuplicateGroup[] = [];
    const group = (basis: IntelligenceStateDuplicateGroup['basis'], entity: (c: (typeof scanned)[number]) => string | null) => {
      const by = new Map<string, { rule: string; caseIds: string[] }>();
      for (const c of scanned) {
        const e = entity(c);
        if (e === null) continue;
        const rule = ruleOf(c.recurrenceKey);
        const k = JSON.stringify([rule, e]);
        const hit = by.get(k);
        if (hit) hit.caseIds.push(c.id);
        else by.set(k, { rule, caseIds: [c.id] });
      }
      for (const g of by.values()) if (g.caseIds.length > 1) groups.push({ basis, rule: g.rule, caseIds: g.caseIds });
    };
    group('RULE_AND_KEY_ENTITY', (c) => entityOf(c.recurrenceKey));
    group('RULE_AND_ENTITY_REFERENCE', (c) => c.sourceReference);

    // 3. Rows written since `since`, by table.
    const created = { ...org, createdAt: { gte: since } };
    const writesSince: Record<IntelligenceStateWriteTable, number> = {
      casesCreated: await this.db.operationalPriority.count({ where: created }),
      casesUpdated: await this.db.operationalPriority.count({ where: { ...org, updatedAt: { gte: since } } }),
      caseLog: await this.db.operationalObservation.count({ where: created }),
      caseEvidence: await this.db.decisionEvidence.count({ where: created }),
      hypotheses: await this.db.intelligenceHypothesis.count({ where: created }),
      outbox: await this.db.stateChangeOutbox.count({ where: created }),
      deliveries: await this.db.stateChangeDelivery.count({ where: created }),
      draftsCreated: await this.db.workDraft.count({ where: created }),
      draftsSent: await this.db.workDraft.count({ where: { ...org, sentAt: { gte: since } } }),
      crmRelationships: await this.db.crmRelationship.count({ where: created }),
      crmParticipants: await this.db.crmParticipant.count({ where: created }),
    };

    // 4. The outbox, by domain and status, and its oldest row still waiting.
    const outboxRows = await this.db.stateChangeOutbox.findMany({ where: org, select: { domain: true, status: true }, take: bound + 1 });
    const outboxGroups = tally(outboxRows.slice(0, bound), (r) => [r.domain, r.status]).map(({ parts: [domain, status], count }) => ({
      domain: domain!,
      status: status!,
      count,
    }));
    const oldest = await this.db.stateChangeOutbox.findFirst({
      where: { ...org, status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } },
      select: { createdAt: true, availableAt: true },
      orderBy: { createdAt: 'asc' },
    });

    // 5. Creator eligibility: relationship events waiting or delivered, and the ones the review acts on.
    const relationshipEvents = await this.db.stateChangeOutbox.findMany({
      where: { ...org, domain: 'RELATIONSHIP' },
      select: { status: true, payload: true },
      take: bound + 1,
    });
    const events = relationshipEvents.slice(0, bound);
    const qualifying = events.filter((e) => {
      const p = (e.payload ?? {}) as { kind?: unknown; fromState?: unknown; toState?: unknown };
      return p.kind === 'TALENT_REPRESENTATION' && p.toState === 'ACTIVE' && p.fromState !== 'ACTIVE';
    });
    const byStatus = (rows: readonly { status: string }[]) => Object.fromEntries(tally(rows, (r) => [r.status]).map(({ parts: [s], count }) => [s!, count]));
    const crm = await this.db.crmRelationship.findMany({ where: org, select: { kind: true, state: true }, take: bound + 1 });

    // 6. Deliveries by subscriber and status, and the subscription rows.
    const deliveryRows = await this.db.stateChangeDelivery.findMany({ where: org, select: { subscriberKey: true, status: true }, take: bound + 1 });
    const subscriptions = await this.db.stateChangeSubscription.findMany({
      where: org,
      select: { subscriberKey: true, endpointOrHandler: true, domain: true, stateKeyPattern: true, status: true, required: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    // 7. Per member: calendar attendee-key coverage and identity suggestions. The keys themselves
    // are read only to be counted, and never leave this function.
    const members = await this.db.organizationMembership.findMany({
      where: org,
      select: { userId: true, status: true, systemRole: true },
      orderBy: { createdAt: 'asc' },
    });
    const workEvents = await this.db.workEvent.findMany({
      where: org,
      select: { userId: true, attendanceKnown: true, attendeeHashes: true, observedAt: true },
      take: bound + 1,
    });
    const suggestionRows = await this.db.intelligenceHypothesis.findMany({
      where: { ...org, hypothesisType: IDENTITY_MATCH_TYPE },
      select: { privateToUserId: true, status: true },
      take: bound + 1,
    });
    const employees: IntelligenceStateEmployee[] = members.map((m) => {
      const own = workEvents.slice(0, bound).filter((e) => e.userId === m.userId);
      const keyed = own.filter((e) => (e.attendeeHashes ?? []).length > 0);
      const mine = suggestionRows.slice(0, bound).filter((s) => s.privateToUserId === m.userId);
      const count = (status: string) => mine.filter((s) => s.status === status).length;
      return {
        userId: m.userId,
        membershipStatus: m.status,
        role: m.systemRole,
        events: own.length,
        eventsAttendanceKnown: own.filter((e) => e.attendanceKnown).length,
        eventsWithAttendeeKeys: keyed.length,
        attendeeKeys: keyed.reduce((sum, e) => sum + (e.attendeeHashes ?? []).length, 0),
        latestKeyedEventObservedAt: keyed.reduce<Date | null>((latest, e) => (latest === null || e.observedAt > latest ? e.observedAt : latest), null),
        suggestions: {
          PROPOSED: count('PROPOSED'),
          CONFIRMED: count('ACCEPTED'),
          REJECTED: count('REJECTED'),
          OTHER: mine.filter((s) => !['PROPOSED', 'ACCEPTED', 'REJECTED'].includes(s.status)).length,
        },
      };
    });

    return {
      organizationId,
      since,
      cases: { rows: cases, truncated: caseRows.length > INTELLIGENCE_STATE_CASE_LIMIT, sightingsTruncated: recent.length > INTELLIGENCE_STATE_SIGHTING_LIMIT },
      caseLogSince,
      caseLogSinceBounded: callgridIds.length > bound || logSince.length > bound,
      duplicates: { groups, scanned: scanned.length, bounded: all.length > bound },
      writesSince,
      outbox: { groups: outboxGroups, total: Math.min(outboxRows.length, bound), oldestPending: oldest, bounded: outboxRows.length > bound },
      creator: {
        relationshipEvents: events.length,
        relationshipEventsByStatus: byStatus(events),
        qualifying: qualifying.length,
        qualifyingByStatus: byStatus(qualifying),
        creatorHubEvents: await this.db.stateChangeOutbox.count({ where: { ...org, domain: 'CREATOR' } }),
        reviewCases: await this.db.operationalPriority.count({ where: { ...org, sourceSystem: CREATOR_ONBOARDING_PRODUCER } }),
        reviewCasesSince: await this.db.operationalPriority.count({ where: { ...org, sourceSystem: CREATOR_ONBOARDING_PRODUCER, createdAt: { gte: since } } }),
        crmRelationships: tally(crm.slice(0, bound), (r) => [r.kind, r.state]).map(({ parts: [kind, state], count }) => ({ kind: kind!, state: state!, count })),
        bounded: relationshipEvents.length > bound || crm.length > bound,
      },
      deliveries: tally(deliveryRows.slice(0, bound), (r) => [r.subscriberKey, r.status]).map(({ parts: [subscriberKey, status], count }) => ({
        subscriberKey: subscriberKey!,
        status: status!,
        count,
      })),
      deliveriesBounded: deliveryRows.length > bound,
      subscriptions: subscriptions.map((s) => ({
        subscriberKey: s.subscriberKey,
        handler: s.endpointOrHandler,
        domain: s.domain,
        stateKeyPattern: s.stateKeyPattern,
        status: s.status,
        required: s.required,
        createdAt: s.createdAt,
      })),
      employees,
      employeesBounded: workEvents.length > bound || suggestionRows.length > bound,
    };
  }
}

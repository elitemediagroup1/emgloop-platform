// Building the one surfaced-intelligence shape (@emgloop/shared IntelligenceItem) from the two live
// authorities that hold it, and bringing memory to it.
//
// NO NEW TRUTH IS STORED HERE. Every field is read from a record an authority already owns: a
// person's work items and their log, their Gmail and Calendar facts, a Case and its append-only
// log, its evidence rows. The item is a projection -- rebuildable at any time -- so there is no
// second copy of anything to drift.
//
// MEMORY, READ. Outcomes people recorded were written and never read. Here they are: a Case brings
// its own earlier closures (this same situation before) and the closures of comparable Cases (the
// same rule about a different buyer, vendor or campaign), and `learnFromHistory` lets them change
// the next suggestion's posture with a stated basis.
//
// CONNECTING, SAFELY. A person's item may compose their own Gmail with their own Calendar: a
// conversation that needs them and a meeting organized by someone on that conversation. The join is
// an exact correspondent key -- the SAME address hash both sources store for the person's own graph
// (daily-loop-employee-intelligence.md §8.3, §11.4) -- never a name and never a claim about who
// anyone is. It happens at read time, inside that person's request, and is stored nowhere (§31.4:
// "Mixing happens at read time, in one principal's request. Never at storage.").
//
// SCOPE. `personalIntelligence` takes a principal and reads only that person's rows. `caseIntelligence`
// takes an organization and reads only Cases, which never hold private evidence.
import type { PrismaClient, OperationalPriority, OperationalObservation } from '@prisma/client';
import {
  learnFromHistory,
  type IntelligenceEvidenceRef,
  type IntelligenceHumanState,
  type IntelligenceItem,
  type IntelligenceSubjectRef,
  type PriorOutcome,
} from '@emgloop/shared';
import { WorkGraphRepository } from '../../repositories/work-state/work-graph.repository';
import { WorkItemRepository, type WorkItemRecord } from '../../repositories/work-state/work-item.repository';
import type { WorkPrincipal } from '../../repositories/work-state/work-principal';
import { MailAttentionService } from '../work-state/mail-attention.service';
import type { DecisionEngine } from '../decision/decision-engine';

const DAY_MS = 86_400_000;
/** How far ahead a meeting is close enough to matter to a conversation. */
export const MEETING_HORIZON_DAYS = 7;
/** Comparable Cases read per item. Enough to see a pattern, not a history dump. */
export const COMPARABLE_LIMIT = 10;

// --- Private: one person's own work -----------------------------------------------------------

const WORK_STATE: Readonly<Record<string, IntelligenceHumanState>> = { OPEN: 'NEW', SNOOZED: 'SNOOZED', RESOLVED: 'HANDLED', DISMISSED: 'DISMISSED' };

/**
 * The person's open work, as intelligence items, with their own Calendar composed in and their own
 * earlier closures remembered. Only theirs: every read takes their principal.
 */
export async function personalIntelligence(prisma: PrismaClient, principal: WorkPrincipal, now: Date): Promise<IntelligenceItem[]> {
  const items = new WorkItemRepository(prisma);
  const graph = new WorkGraphRepository(prisma);
  const open = await new MailAttentionService({ items, now: () => now }).open(principal);
  if (open.length === 0) return [];
  const upcoming = (await graph.events(principal, { from: now, to: new Date(now.getTime() + MEETING_HORIZON_DAYS * DAY_MS) })).filter(
    (e) => e.organizerHash !== null && !e.organizerIsSelf && e.status !== 'CANCELLED',
  );
  const people = new Map((await graph.correspondents(principal, { limit: 500 })).map((c) => [c.addressHash, c]));

  const out: IntelligenceItem[] = [];
  for (const item of open) {
    const evidence: IntelligenceEvidenceRef[] = [];
    const related: IntelligenceSubjectRef[] = [];
    const remembers: string[] = [];
    if (item.subjectKind === 'THREAD') {
      const thread = await graph.thread(principal, 'GOOGLE', item.subjectRef);
      evidence.push({ authority: 'GMAIL', kind: 'THREAD', ref: item.subjectRef, label: thread?.subject ?? item.title, observedAt: thread?.lastMessageAt ?? null });
      for (const hash of thread?.participantHashes ?? []) {
        const person = people.get(hash);
        if (person) related.push({ kind: 'CORRESPONDENT', ref: hash, label: person.displayName ?? person.displayAddress, verified: true });
        // Cross-source, inside one person's own graph: the same address key on both sides.
        for (const meeting of upcoming.filter((e) => e.organizerHash === hash)) {
          evidence.push({ authority: 'CALENDAR', kind: 'EVENT', ref: meeting.eventId, label: meeting.summary, observedAt: meeting.startsAt });
          remembers.push(`${person?.displayName ?? 'Someone on this conversation'} organized a meeting with you on ${(meeting.startsAt ?? meeting.startDate)?.toISOString().slice(0, 10) ?? 'an upcoming day'}.`);
        }
      }
    }
    const previously = await priorWorkOutcomes(items, principal, item);
    if (previously.length > 0) remembers.push(`You closed this before (${previously.length} time${previously.length === 1 ? '' : 's'}), and it came back with new messages.`);
    const learned = learnFromHistory(previously, { posture: item.class === 'NEEDS_YOU' ? 'ACT' : 'REVIEW', text: null });
    out.push({
      id: `work_item:${item.id}`,
      authority: 'WORK_ITEM',
      scope: 'PRIVATE',
      producer: item.producerId,
      whatChanged: item.title ?? 'A conversation needs attention',
      whyItMatters: null,
      evidence,
      related,
      remembers,
      previously,
      suggestedReview: learned,
      confidence: null,
      uncertainty: [],
      freshness: [],
      humanState: WORK_STATE[item.state] ?? 'NEW',
      firstSeenAt: item.firstDetectedAt,
      lastSeenAt: item.lastDetectedAt,
    });
  }
  return out;
}

async function priorWorkOutcomes(items: WorkItemRepository, principal: WorkPrincipal, item: WorkItemRecord): Promise<PriorOutcome[]> {
  const log = await items.observations(principal, item.id);
  return log
    .filter((o) => o.observationType === 'RESOLVED' || o.observationType === 'DISMISSED')
    .map((o) => ({
      at: o.occurredAt,
      outcome: o.observationType === 'RESOLVED' ? 'HANDLED' : 'DISMISSED',
      reason: o.reason ?? null,
      relation: 'SAME' as const,
      subjectLabel: item.title,
    }));
}

// --- Organization: Cases ------------------------------------------------------------------------

/** What a producer may put in a Case's opening picture under `intelligence` (JSON-safe). */
interface OpeningIntelligence {
  readonly refs?: readonly (Omit<IntelligenceEvidenceRef, 'observedAt'> & { readonly observedAt: string | null })[];
  readonly related?: readonly IntelligenceSubjectRef[];
  readonly remembers?: readonly string[];
}

type CaseReads = Pick<DecisionEngine, 'get' | 'list'>;

/** The rule part of a recurrence key (`<ruleId>::<entity>`). */
export function recurrenceRule(recurrenceKey: string): string {
  const at = recurrenceKey.indexOf('::');
  return at < 0 ? recurrenceKey : recurrenceKey.slice(0, at);
}

function caseHumanState(decision: OperationalPriority, log: readonly OperationalObservation[]): IntelligenceHumanState {
  switch (decision.state) {
    case 'ASSIGNED':
      return 'ASSIGNED';
    case 'WATCHING':
      return 'WATCHING';
    case 'RESOLVED':
      return decision.outcome === 'ACCEPTED_RISK' ? 'ACCEPTED' : decision.outcome === 'SUPPRESSED' ? 'SUPPRESSED' : 'HANDLED';
    case 'DISMISSED':
      return decision.outcome === 'SUPPRESSED' ? 'SUPPRESSED' : 'DISMISSED';
    default:
      return log.some((o) => o.observationType === 'REVIEWED' && o.occurredAt >= (decision.lastDetectedAt ?? decision.createdAt)) ? 'REVIEWED' : 'NEW';
  }
}

/**
 * One Case as an intelligence item, with what the organization remembers about it: its own earlier
 * outcomes, the outcomes of comparable Cases, and how those change the suggestion. Organization
 * scope only: a Case in another organization is not found.
 */
export async function caseIntelligence(
  engine: CaseReads,
  organizationId: string,
  caseId: string,
  options: { readonly freshness?: IntelligenceItem['freshness'] } = {},
): Promise<IntelligenceItem | null> {
  const view = await engine.get(organizationId, caseId);
  if (!view) return null;
  const decision = view.decision;
  const lastSeen = decision.lastDetectedAt ?? decision.createdAt;

  // This same situation before: closures recorded BEFORE its latest sighting.
  const own: PriorOutcome[] = view.observations
    .filter((o) => o.outcome !== null && o.occurredAt <= lastSeen)
    .map((o) => ({ at: o.occurredAt, outcome: o.outcome!, reason: o.reason ?? null, relation: 'SAME' as const, subjectLabel: decision.title }));
  // Comparable: the same rule about something else, closed with an outcome.
  const rule = recurrenceRule(decision.recurrenceKey);
  const siblings = (await engine.list(organizationId, { producer: decision.sourceSystem, take: 200 }))
    .filter((d) => d.id !== decision.id && recurrenceRule(d.recurrenceKey) === rule && d.outcome !== null)
    .slice(0, COMPARABLE_LIMIT);
  const comparable: PriorOutcome[] = siblings.map((d) => ({
    at: d.resolvedAt ?? d.updatedAt,
    outcome: d.outcome!,
    reason: null,
    relation: 'COMPARABLE' as const,
    subjectLabel: d.title,
  }));
  const previously = [...own, ...comparable];

  const remembers: string[] = [];
  const first = decision.firstDetectedAt ?? decision.createdAt;
  remembers.push(`First seen ${first.toISOString().slice(0, 10)}; seen ${decision.detectionCount} time${decision.detectionCount === 1 ? '' : 's'}.`);
  if (decision.reopenCount > 0) remembers.push(`Reopened ${decision.reopenCount} time${decision.reopenCount === 1 ? '' : 's'} after being closed.`);
  const held = view.observations.filter((o) => o.observationType === 'SITUATION_RESIGHTED' && o.reason?.startsWith('Seen again')).length;
  if (held > 0) remembers.push(`Seen again ${held} time${held === 1 ? '' : 's'} while a standing judgment held it closed.`);

  const authority = decision.sourceSystem === 'callgrid' ? 'CALLGRID' : 'LOOP';
  const evidence: IntelligenceEvidenceRef[] = view.evidence.slice(0, 12).map((e) => ({
    authority,
    kind: e.metricKey ? 'METRIC' : 'STATEMENT',
    ref: e.metricKey ?? e.id,
    label: e.statement ?? e.metricKey,
    observedAt: e.observedAt,
  }));
  const related: IntelligenceSubjectRef[] = [];
  // A producer may record, in its opening picture, references to records OTHER authorities own
  // (a CRM Relationship, a Party) and what it remembered. They are carried through as it wrote them.
  const opening = view.observations.find((o) => o.observationType === 'SITUATION_DETECTED');
  const picture = ((opening?.evidence ?? {}) as { intelligence?: OpeningIntelligence }).intelligence;
  for (const ref of picture?.refs ?? []) {
    evidence.push({ ...ref, observedAt: ref.observedAt ? new Date(ref.observedAt) : null });
  }
  related.push(...(picture?.related ?? []));
  remembers.push(...(picture?.remembers ?? []));
  for (const e of view.evidence) {
    if (!e.entityType || !e.entityId || related.some((r) => r.kind === e.entityType && r.ref === e.entityId)) continue;
    // The provider's own entity id: authoritative data, not a match.
    related.push({ kind: e.entityType.toUpperCase(), ref: e.entityId, label: e.entityName, verified: true });
  }

  return {
    id: `case:${decision.id}`,
    authority: 'CASE',
    scope: 'ORGANIZATION',
    producer: decision.sourceSystem,
    whatChanged: decision.title,
    whyItMatters: decision.summary,
    evidence,
    related,
    remembers,
    previously,
    suggestedReview: learnFromHistory(previously, { posture: decision.state === 'NEEDS_REVIEW' ? 'REVIEW' : 'NONE', text: null }),
    confidence: decision.confidence,
    uncertainty: [...new Set(view.evidence.flatMap((e) => [...e.unknowns, ...e.limitations]))].slice(0, 8),
    freshness: options.freshness ?? [],
    humanState: caseHumanState(decision, view.observations),
    firstSeenAt: first,
    lastSeenAt: lastSeen,
  };
}

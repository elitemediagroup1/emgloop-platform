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
// conversation that needs them and a meeting that someone on that conversation organized or is
// invited to (D2). The join is an exact correspondent key -- the SAME one-way address key both
// sources store for the person's own graph (daily-loop-employee-intelligence.md §8.3, §11.4) --
// never a name and never a claim about who anyone is. It happens at read time, inside that
// person's request, and is stored nowhere (§31.4: "Mixing happens at read time, in one principal's
// request. Never at storage."). A correspondent is named by the name they gave, or not at all:
// their address never appears in an item.
//
// WHO SOMEONE IS, ONLY AS FAR AS A PERSON SAID SO (D1). A PROPOSED identity suggestion appears as an
// UNVERIFIED Party with a question, and nothing is composed from it. Only a suggestion the person
// confirmed makes the correspondent that Party in their own intelligence -- and then, through the
// authorized CRM read, the relationships that Party takes part in. Calendar attendees are never
// matched to a Party; only the correspondent is.
//
// SCOPE. `personalIntelligence` takes a principal and reads only that person's rows. `caseIntelligence`
// takes an organization and reads only Cases, which never hold private evidence.
import type { PrismaClient, OperationalPriority, OperationalObservation } from '@prisma/client';
import {
  CALLGRID_DECISION_PRODUCER,
  crmCanonicalPartyId,
  learnFromHistory,
  zonedCalendarDay,
  type IntelligenceEvidenceRef,
  type IntelligenceHumanState,
  type IntelligenceItem,
  type IntelligenceSubjectRef,
  type PriorOutcome,
} from '@emgloop/shared';
import { IdentitySuggestionRepository, type IdentitySuggestion } from '../../repositories/cognitive/identity-suggestion.repository';
import { IamRepository } from '../../repositories/iam.repository';
import { PartyReadModelRepository } from '../../repositories/party-read-model.repository';
import { WorkGraphRepository } from '../../repositories/work-state/work-graph.repository';
import { WorkItemRepository, type WorkItemRecord } from '../../repositories/work-state/work-item.repository';
import { WorkPreferencesRepository } from '../../repositories/work-state/work-preferences.repository';
import type { WorkPrincipal } from '../../repositories/work-state/work-principal';
import { CrmRelationshipReadService } from '../crm-relationship-read.service';
import { MailAttentionService } from '../work-state/mail-attention.service';
import type { DecisionEngine } from '../decision/decision-engine';

const DAY_MS = 86_400_000;
/** How far ahead a meeting is close enough to matter to a conversation. */
export const MEETING_HORIZON_DAYS = 7;
/** Comparable Cases read per item. Enough to see a pattern, not a history dump. */
export const COMPARABLE_LIMIT = 10;

// --- Private: one person's own work -----------------------------------------------------------

const WORK_STATE: Readonly<Record<string, IntelligenceHumanState>> = { OPEN: 'NEW', SNOOZED: 'SNOOZED', RESOLVED: 'HANDLED', DISMISSED: 'DISMISSED' };

/** CRM relationships composed per confirmed match: the few a person needs, not a directory. */
const MATCH_RELATIONSHIP_LIMIT = 3;

type UpcomingEvent = Awaited<ReturnType<WorkGraphRepository['events']>>[number];

/** "today's meeting", "tomorrow's meeting" or "the meeting on 2026-09-24" -- days in the person's own zone. */
function meetingPhrase(meeting: UpcomingEvent, now: Date, timeZone: string): string {
  const day = zonedCalendarDay(meeting.startsAt!, timeZone);
  const today = zonedCalendarDay(now, timeZone);
  const apart = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  return apart === 0 ? "today's meeting" : apart === 1 ? "tomorrow's meeting" : `the meeting on ${day}`;
}

/** One sentence joining the conversation and the meeting. A name the person gave, or none. */
function meetingSentence(workClass: string, name: string | null, organized: boolean, phrase: string): string {
  const who = name ?? 'someone on this conversation';
  const presence = organized ? `${name ?? 'they'} organized ${phrase}` : `${name ?? 'they'} ${name ? 'is' : 'are'} in ${phrase}`;
  if (workClass === 'WAITING_ON_THEM') return `You're waiting on ${who}, and ${presence}.`;
  if (workClass === 'NEEDS_YOU') return `${name ?? 'Someone on this conversation'} is waiting on your reply, and ${presence}.`;
  return `${presence.charAt(0).toUpperCase()}${presence.slice(1)}.`;
}

interface IdentityMatch {
  readonly suggestion: IdentitySuggestion;
  readonly partyLabel: string | null;
}

/**
 * This person's own pending and confirmed identity suggestions, one per correspondent (a confirmed
 * one wins). Empty for someone who may not read identity state.
 */
async function identityMatches(prisma: PrismaClient, principal: WorkPrincipal): Promise<Map<string, IdentityMatch>> {
  const out = new Map<string, IdentityMatch>();
  const iam = new IamRepository(prisma);
  if (!(await iam.can({ ...principal, resource: 'identityResolution', action: 'view' }))) return out;
  const parties = new PartyReadModelRepository(prisma);
  const suggestions = await new IdentitySuggestionRepository(prisma).forOwner(principal, ['CONFIRMED', 'PROPOSED']);
  for (const suggestion of [...suggestions].sort((a, b) => (a.status === b.status ? 0 : a.status === 'CONFIRMED' ? -1 : 1))) {
    if (out.has(suggestion.subjectKey)) continue;
    const party = await parties.getRecord(principal.organizationId, suggestion.partyId);
    out.set(suggestion.subjectKey, { suggestion, partyLabel: party?.displayName ?? null });
  }
  return out;
}

/**
 * What a CONFIRMED match adds: the relationships that Party takes part in, read through the
 * authorized CRM read (a person who may not view Relationships gets none).
 */
async function confirmedRelationships(
  prisma: PrismaClient,
  principal: WorkPrincipal,
  partyId: string,
): Promise<{ evidence: IntelligenceEvidenceRef[]; related: IntelligenceSubjectRef[]; lines: string[] }> {
  const out = { evidence: [] as IntelligenceEvidenceRef[], related: [] as IntelligenceSubjectRef[], lines: [] as string[] };
  const crm = new CrmRelationshipReadService(prisma);
  const parties = new PartyReadModelRepository(prisma);
  const page = await crm.forParty(principal, partyId, { limit: MATCH_RELATIONSHIP_LIMIT });
  if (page.outcome !== 'OK') return out;
  for (const relationship of page.value.items.filter((r) => r.state === 'ACTIVE' || r.state === 'ENDED')) {
    const record = await crm.getRecord(principal, relationship.relationshipId);
    if (record.outcome !== 'OK') continue;
    const mine = record.value.participants.find((p) => p.state === 'ACTIVE' && crmCanonicalPartyId(p.party) === partyId);
    const counterparty = record.value.sides.find((side) => crmCanonicalPartyId(side.party) !== partyId);
    const counterpartyId = counterparty ? crmCanonicalPartyId(counterparty.party) : null;
    const counterpartyName = counterpartyId ? (await parties.getRecord(principal.organizationId, counterpartyId))?.displayName ?? null : null;
    out.evidence.push({ authority: 'CRM', kind: 'RELATIONSHIP', ref: relationship.relationshipId, label: `${relationship.kindLabel} · ${relationship.state}`, observedAt: new Date(relationship.createdAt) });
    if (counterpartyId) out.related.push({ kind: 'PARTY', ref: counterpartyId, label: counterpartyName, verified: true });
    const role = mine ? mine.role.toLowerCase().replace(/_/g, ' ') : 'a party';
    out.lines.push(`${role} on the ${relationship.kindLabel.toLowerCase()} relationship${counterpartyName ? ` with ${counterpartyName}` : ''} (${relationship.state.toLowerCase()})`);
  }
  return out;
}

/**
 * The person's open work, as intelligence items, with their own Calendar composed in, what they
 * confirmed about who their correspondents are, and their own earlier closures remembered. Only
 * theirs: every read takes their principal.
 */
export async function personalIntelligence(prisma: PrismaClient, principal: WorkPrincipal, now: Date): Promise<IntelligenceItem[]> {
  const items = new WorkItemRepository(prisma);
  const graph = new WorkGraphRepository(prisma);
  const open = await new MailAttentionService({ items, now: () => now }).open(principal);
  if (open.length === 0) return [];
  // Days are the person's own days (the Loop Time Authority): their stored zone, never the server's.
  const { timeZone } = await new WorkPreferencesRepository(prisma).get(principal);
  const upcoming = (await graph.events(principal, { from: now, to: new Date(now.getTime() + MEETING_HORIZON_DAYS * DAY_MS) })).filter(
    (e) => e.status !== 'CANCELLED' && e.startsAt !== null,
  );
  const people = new Map((await graph.correspondents(principal, { limit: 500 })).map((c) => [c.addressHash, c]));
  const matches = await identityMatches(prisma, principal);
  // One authorized CRM read per confirmed Party per request, however many items name it.
  const relationshipsOf = new Map<string, Promise<Awaited<ReturnType<typeof confirmedRelationships>>>>();

  const out: IntelligenceItem[] = [];
  for (const item of open) {
    const evidence: IntelligenceEvidenceRef[] = [];
    const related: IntelligenceSubjectRef[] = [];
    const remembers: string[] = [];
    const uncertainty: string[] = [];
    if (item.subjectKind === 'THREAD') {
      const thread = await graph.thread(principal, 'GOOGLE', item.subjectRef);
      evidence.push({ authority: 'GMAIL', kind: 'THREAD', ref: item.subjectRef, label: thread?.subject ?? item.title, observedAt: thread?.lastMessageAt ?? null });
      for (const hash of thread?.participantHashes ?? []) {
        const person = people.get(hash);
        const name = person?.displayName?.trim() || null;
        if (person) related.push({ kind: 'CORRESPONDENT', ref: hash, label: name, verified: true });
        // Cross-source, inside one person's own graph: the same address key on both sides, as the
        // meeting's organizer or as one of its invitees.
        for (const meeting of upcoming) {
          const organized = meeting.organizerHash === hash && !meeting.organizerIsSelf;
          if (!organized && !(meeting.attendeeHashes ?? []).includes(hash)) continue;
          if (!evidence.some((e) => e.authority === 'CALENDAR' && e.ref === meeting.eventId)) {
            evidence.push({ authority: 'CALENDAR', kind: 'EVENT', ref: meeting.eventId, label: meeting.summary, observedAt: meeting.startsAt });
          }
          remembers.push(meetingSentence(item.class, name, organized, meetingPhrase(meeting, now, timeZone)));
        }
        const match = matches.get(hash);
        if (!match) continue;
        const { suggestion, partyLabel } = match;
        if (suggestion.status === 'CONFIRMED') {
          related.push({ kind: 'PARTY', ref: suggestion.partyId, label: partyLabel, verified: true });
          evidence.push({ authority: 'IDENTITY', kind: 'CONFIRMED_MATCH', ref: suggestion.id, label: 'You confirmed this match', observedAt: suggestion.decidedAt });
          if (!relationshipsOf.has(suggestion.partyId)) relationshipsOf.set(suggestion.partyId, confirmedRelationships(prisma, principal, suggestion.partyId));
          const crm = await relationshipsOf.get(suggestion.partyId)!;
          evidence.push(...crm.evidence);
          for (const r of crm.related) if (!related.some((x) => x.kind === r.kind && x.ref === r.ref)) related.push(r);
          const who = name ?? 'This correspondent';
          remembers.push(
            crm.lines.length > 0
              ? `You confirmed ${who} is ${partyLabel ?? 'an established Party'}: ${crm.lines.join('; ')}.`
              : `You confirmed ${who} is ${partyLabel ?? 'an established Party'}.`,
          );
        } else {
          // A machine suggestion is never truth: unverified, cited, and a question for the person.
          related.push({ kind: 'PARTY', ref: suggestion.partyId, label: partyLabel, verified: false });
          evidence.push({ authority: 'IDENTITY', kind: 'SUGGESTION', ref: suggestion.id, label: 'Possible match, not confirmed', observedAt: suggestion.proposedAt });
          uncertainty.push(
            `${name ?? 'A correspondent'} may be ${partyLabel ?? 'an established Party'}: their address matches an identifier recorded on that Party. Not confirmed -- confirm or reject the match.`,
          );
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
      uncertainty,
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

  // The producer's own measurements are owned by the source it measured; CallGrid is the one such
  // source today. Compared against the registry value the pipeline records, never a typed copy.
  const authority = decision.sourceSystem === CALLGRID_DECISION_PRODUCER ? 'CALLGRID' : 'LOOP';
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

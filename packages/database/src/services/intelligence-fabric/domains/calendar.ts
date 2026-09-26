// Calendar intelligence (Loop Intelligence Phase E, 2026-09-26). A person's OWN day, from the calendar
// metadata Loop already stores under their Google connection (work_events) and their own mail metadata --
// never a new read of Google, never a body.
//
//   calendar.domain@1   the person's CALENDAR DOMAIN digest (the domain kit):
//     MEASURED   meetings in their day and how many include people outside the organization;
//     OBSERVED   meetings that overlap; a meeting with someone whose mail thread is waiting on the
//                person's reply (attendee keys meet thread participant keys -- a deterministic join, the
//                "prep" signal); a meeting with outside attendees that ended with no mail sent to any of
//                them since (the "follow-up" signal);
//     model      when calendar.domain.reading is activated: what the day MEANS, from the same facts.
//
// "The day" is the person's own zone (employee_work_preferences.timeZone); instants are stored UTC and a
// surface formats them (Loop Time Authority). Provider GOOGLE_CALENDAR, basis SOURCE_CONNECTION_GRANT:
// the calendar grant the person gave; the digest is theirs alone and expires in 30 days.

import { createHash } from 'node:crypto';
import { AI_TASK_CALENDAR_DOMAIN_READING, entityRef, type AiContextItem, type IntelligenceSignal } from '@emgloop/shared';

import type { DomainFactsRepository } from '../../../repositories/intelligence/domain-facts.repository';
import type { IntelligenceProducer } from '../producer';
import { domainProducer, type DomainKitPorts, type RuleReading } from '../domain-kit';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_EVENTS = 30;

interface CalendarEvent {
  readonly id: string;
  readonly summary: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly external: number;
  readonly attendees: readonly string[];
  readonly declined: boolean;
}

interface CalendarContext {
  readonly events: readonly CalendarEvent[];
  readonly conflicts: readonly [string, string][];
  readonly prep: readonly { readonly eventId: string; readonly threads: number }[];
  readonly noFollowUp: readonly string[];
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

/** Midnight in the person's zone, as a UTC instant (DST-correct via Intl). */
function startOfDay(now: Date, timeZone: string): Date {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now).map((p) => [p.type, p.value]));
  const elapsed = (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
  return new Date(now.getTime() - elapsed - now.getMilliseconds());
}

export function calendarDomainProducer(facts: DomainFactsRepository, kit: DomainKitPorts): IntelligenceProducer<CalendarContext> {
  return domainProducer<CalendarContext>(
    {
      id: 'calendar.domain@1',
      domain: 'CALENDAR',
      scope: 'PRINCIPAL',
      version: '1',
      provider: 'GOOGLE_CALENDAR',
      consentBasis: 'SOURCE_CONNECTION_GRANT',
      async discover() {
        const people = await facts.connectedGooglePrincipals();
        return people.map((p) => ({ scope: 'PRINCIPAL', organizationId: p.organizationId, userId: p.userId, domain: 'CALENDAR', subjectKind: 'DOMAIN', subjectRef: 'domain' }) as const);
      },
      async gather(target, now) {
        if (target.scope !== 'PRINCIPAL') return { status: 'NOT_PERMITTED', reason: 'PRINCIPAL_ONLY' };
        const { organizationId, userId } = target;
        const dayStart = startOfDay(now, (await facts.calendarTimeZone(organizationId, userId)) ?? 'UTC');
        const windowStart = new Date(dayStart.getTime() - DAY);
        const windowEnd = new Date(dayStart.getTime() + DAY);
        const rows = await facts.calendarEvents(organizationId, userId, windowStart, windowEnd, MAX_EVENTS);
        const events: CalendarEvent[] = rows
          .filter((r) => r.startsAt && r.endsAt && r.status !== 'cancelled')
          .map((r) => ({ id: r.id, summary: r.summary, startsAt: r.startsAt!, endsAt: r.endsAt!, external: r.externalAttendeeCount ?? 0, attendees: r.attendeeHashes, declined: r.selfResponse === 'declined' }));
        const today = events.filter((e) => e.startsAt >= dayStart && !e.declined);
        if (events.length === 0) return { status: 'NO_EVIDENCE' };
        // Overlaps among today's accepted meetings.
        const conflicts: [string, string][] = [];
        for (let i = 0; i < today.length; i += 1) for (let j = i + 1; j < today.length; j += 1) if (today[j]!.startsAt < today[i]!.endsAt) conflicts.push([today[i]!.id, today[j]!.id]);
        // Prep: a meeting ahead with someone whose thread is waiting on the person's reply.
        const threads = await facts.waitingThreadParticipants(organizationId, userId);
        const prep = today
          .filter((e) => e.startsAt > now && e.attendees.length > 0)
          .map((e) => ({ eventId: e.id, threads: threads.filter((t) => t.some((h) => e.attendees.includes(h))).length }))
          .filter((p) => p.threads > 0);
        // Follow-up: an outside meeting that ended in the last day with no mail to any attendee since.
        const ended = events.filter((e) => e.endsAt <= now && e.endsAt > new Date(now.getTime() - DAY) && e.external > 0 && e.attendees.length > 0 && !e.declined);
        const noFollowUp: string[] = [];
        for (const e of ended) {
          if (!(await facts.sentMailTo(organizationId, userId, e.endsAt, e.attendees))) noFollowUp.push(e.id);
        }
        const fingerprint = `calendar:${createHash('sha256').update(JSON.stringify([dayStart.toISOString(), events.map((e) => [e.id, e.startsAt.toISOString(), e.endsAt.toISOString(), e.external, e.declined]), conflicts, prep, noFollowUp])).digest('hex')}`;
        return { status: 'READY', fingerprint, context: { events, conflicts, prep, noFollowUp, windowStart: dayStart, windowEnd } };
      },
      rule(ctx, now): RuleReading {
        const today = ctx.events.filter((e) => e.startsAt >= ctx.windowStart && !e.declined);
        const external = today.filter((e) => e.external > 0).length;
        const ref = (id: string) => entityRef('work_event', id);
        const signals: IntelligenceSignal[] = [
          { key: 'meetings-today', kind: 'UPCOMING', knowledge: 'MEASURED', statement: `${today.length} ${today.length === 1 ? 'meeting' : 'meetings'} in your day.`, evidenceRefs: ['work_events:day'], metric: { name: 'meetings_today', value: today.length, unit: 'count' }, asOf: now.toISOString(), severity: 'LOW' },
        ];
        if (external > 0) signals.push({ key: 'external-meetings', kind: 'UPCOMING', knowledge: 'MEASURED', statement: `${external} with people outside the organization.`, evidenceRefs: ['work_events:day'], metric: { name: 'external_meetings', value: external, unit: 'count' }, asOf: now.toISOString(), severity: 'MEDIUM' });
        for (const [a, b] of ctx.conflicts.slice(0, 3)) {
          const first = ctx.events.find((e) => e.id === a)!;
          signals.push({ key: `conflict.${a.slice(-8)}.${b.slice(-8)}`, kind: 'RISK', knowledge: 'OBSERVED', statement: 'Two of your meetings overlap.', entities: [ref(a), ref(b)], evidenceRefs: [`work_event:${a}`, `work_event:${b}`], occurredAt: first.startsAt.toISOString(), severity: 'HIGH' });
        }
        for (const p of ctx.prep.slice(0, 3)) {
          const e = ctx.events.find((x) => x.id === p.eventId)!;
          signals.push({ key: `prep.${p.eventId.slice(-10)}`, kind: 'ATTENTION', knowledge: 'OBSERVED', statement: `A meeting ahead${e.summary ? ` (${e.summary.slice(0, 120)})` : ''} includes someone whose mail is waiting on your reply.`, entities: [ref(p.eventId)], evidenceRefs: [`work_event:${p.eventId}`], dueAt: e.startsAt.toISOString(), severity: 'HIGH' });
        }
        for (const id of ctx.noFollowUp.slice(0, 3)) {
          const e = ctx.events.find((x) => x.id === id)!;
          signals.push({ key: `follow-up.${id.slice(-10)}`, kind: 'UNRESOLVED', knowledge: 'OBSERVED', statement: `No mail has gone to the attendees of a meeting that ended${e.summary ? ` (${e.summary.slice(0, 120)})` : ''}.`, entities: [ref(id)], evidenceRefs: [`work_event:${id}`], occurredAt: e.endsAt.toISOString(), severity: 'MEDIUM' });
        }
        const parts = [
          `${today.length} ${today.length === 1 ? 'meeting' : 'meetings'} today${external > 0 ? `, ${external} with people outside the organization` : ''}`,
          ctx.conflicts.length > 0 ? `${ctx.conflicts.length === 1 ? 'two overlap' : `${ctx.conflicts.length} overlaps`}` : null,
          ctx.prep.length > 0 ? `${ctx.prep.length === 1 ? 'one needs' : `${ctx.prep.length} need`} preparation` : null,
        ].filter(Boolean);
        return {
          statement: `${parts.join('; ')}.`,
          status: ctx.conflicts.length + ctx.prep.length > 0 ? 'ATTENTION' : ctx.noFollowUp.length > 0 || external > 0 ? 'WATCH' : 'CALM',
          confidence: 'HIGH',
          signals: signals.slice(0, 12),
          limitations: [],
          entityRefs: ctx.events.map((e) => ref(e.id)).slice(0, 32),
          coverage: 'CONNECTED_SUFFICIENT',
          windowStart: ctx.windowStart,
          windowEnd: ctx.windowEnd,
          evidenceCount: ctx.events.length,
          lastEvidenceAt: ctx.events.length ? new Date(Math.max(...ctx.events.map((e) => e.startsAt.getTime()))) : null,
          sources: [{ sourceId: 'GOOGLE_CALENDAR', asOf: now.toISOString(), coverage: 'CONNECTED_SUFFICIENT' }],
          sourceRefs: ['work_events:day', ...ctx.events.map((e) => `work_event:${e.id}`)].slice(0, 64),
        };
      },
      model: {
        task: AI_TASK_CALENDAR_DOMAIN_READING,
        framing: {
          domainDescription: "one person's own calendar for today (their meetings, and Loop's facts about them)",
          audience: 'PRINCIPAL',
          lookFor: ['what the day means as a whole', 'the meetings that matter and why', 'what needs preparing, and what is unresolved around a meeting', 'conflicts and follow-ups owed'],
        },
        context(ctx) {
          const read = { resource: 'employeeIntelligence', action: 'view' } as const;
          const items: AiContextItem[] = ctx.events.slice(0, 20).map((e) => ({
            blockId: `work_event:${e.id}`,
            kind: 'STRUCTURED',
            trust: 'UNTRUSTED_INPUT',
            sourceRef: `work_event:${e.id}`,
            content: JSON.stringify({
              title: e.summary,
              starts: e.startsAt.toISOString(),
              minutes: Math.round((e.endsAt.getTime() - e.startsAt.getTime()) / 60_000),
              outsideAttendees: e.external,
              overlaps: ctx.conflicts.some((c) => c.includes(e.id)),
              mailWaitingOnYouWithAttendee: ctx.prep.some((p) => p.eventId === e.id),
              noFollowUpSent: ctx.noFollowUp.includes(e.id),
              declined: e.declined,
            }),
            sensitivity: 'COMMUNICATION_CONTENT',
            readUnder: read,
          }));
          return {
            items,
            evidence: {
              figures: new Map(ctx.events.map((e) => [`work_event:${e.id}`, new Set([Math.round((e.endsAt.getTime() - e.startsAt.getTime()) / 60_000), e.external])])),
              dates: new Set(ctx.events.map((e) => e.startsAt.toISOString().slice(0, 10))),
              entityRefs: new Set(ctx.events.map((e) => entityRef('work_event', e.id))),
            },
          };
        },
      },
    },
    kit,
  );
}

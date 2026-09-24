// "Your briefing" on Loop Home: the company-wide SYNTHESIS, in a few sentences of prose (Matt,
// 2026-09-24). Distinct from the three things around it: the KPI row owns the figures, Headlines own
// the connective records, and each tile owns its domain's interpretation. The briefing reads across
// them and says what they add up to for this person, today.
//
// ONE SENTENCE PER CONCERN, EACH CARRYING ITS SOURCES, AT MOST FOUR:
//   business        the moved figures against the window's OWN comparison label, or why nothing is
//                   compared, or that CallGrid could not be read (executive seat only);
//   intelligence    the open Headlines and how many are under investigation, or the governed
//                   attention statement when there are none (executive seat only);
//   communications  the viewer's OWN mail (the Mail domain's counts) and chats (the Chats domain's
//                   conversations that need them) -- always "you", never another person's;
//   day             the next meeting and when, or that none are left; and the viewer's work from the
//                   Work OS rows' own dates.
//
// PURE AND DETERMINISTIC. No loader, no clock beyond the TimeView handed in, no model: every word is a
// template over governed evidence already loaded. A source that was not read is left out or said
// honestly ("could not be read", "isn't connected"); a missing figure is never a zero.

import { counted, type AttentionAssessment, type HeadlineView, type TimeView } from '@emgloop/shared';
import type { ChatsIntelligence } from '../../../daily-loop/chats-intelligence';
import type { BriefingToday, WorkPosture } from './briefing';
import type { HeadlineStanding } from './front-door-data';
import type { HomeKpi, HomeKpiStrip } from './kpis';
import type { MailTileInput, TileRead } from './tiles';

export type NarrativeTopic = 'business' | 'intelligence' | 'communications' | 'day';

/** Where a sentence's facts came from; a link only where the viewer's rail leads. */
export interface NarrativeSource {
  readonly label: string;
  readonly href: string | null;
}

export interface NarrativeSentence {
  readonly topic: NarrativeTopic;
  readonly text: string;
  readonly sources: readonly NarrativeSource[];
}

export interface NarrativeInput {
  readonly time: TimeView;
  /** The executive KPI strip; null when CallGrid is not offered to this seat. */
  readonly business: TileRead<HomeKpiStrip> | null;
  /** The Headline authority's read for this seat; null when the seat cannot open Headlines. */
  readonly headlines: {
    /** Non-dismissed Headlines, or null when that read failed. */
    readonly rows: readonly HeadlineView[] | null;
    readonly attention: AttentionAssessment | null;
    readonly standings: ReadonlyMap<string, HeadlineStanding>;
  } | null;
  /** The composed day and mail states (briefing.ts). */
  readonly today: BriefingToday;
  /** The Mail domain's reading; null unless the mailbox was read. */
  readonly mail: MailTileInput | null;
  /** The Chats domain's reading; null when Chats is not offered. */
  readonly chats: TileRead<ChatsIntelligence> | null;
  /** The viewer's work posture; null when this seat has no work read. */
  readonly work: TileRead<WorkPosture> | null;
  /** Destinations, each null when the viewer's rail does not lead there. */
  readonly hrefs: {
    readonly callgrid: string | null;
    readonly headlines: string | null;
    readonly mail: string | null;
    readonly chats: string | null;
    readonly calendar: string | null;
    readonly work: string | null;
  };
}

/** The most sentences a briefing says. It is read in a glance, not scrolled. */
export const NARRATIVE_MAX = 4;

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const finish = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

function andJoin(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// --- Business --------------------------------------------------------------------------------------

/** The figures the business sentence names, in the row's order; the observed campaign count is not a comparison. */
const BUSINESS_KEYS: readonly HomeKpi['key'][] = ['revenue', 'netProfit', 'billableCalls', 'totalCalls'];

function figure(k: HomeKpi): string {
  return `${k.label.toLowerCase()} ${k.value}`;
}

function businessSentence(input: NarrativeInput): NarrativeSentence | null {
  const read = input.business;
  if (read === null) return null;
  const sources = [{ label: 'CallGrid', href: input.hrefs.callgrid }];
  if (!read.ok || read.value.state === 'UNAVAILABLE') return { topic: 'business', text: 'CallGrid could not be read just now, so Loop says nothing about the numbers.', sources };
  const strip = read.value;
  if (strip.state === 'NO_DATA') return { topic: 'business', text: finish(strip.freshness.detail), sources };
  const known = BUSINESS_KEYS.map((key) => strip.kpis.find((k) => k.key === key)).filter((k): k is HomeKpi => k !== undefined && k.state === 'VALUE');
  const period = strip.periodLabel;
  if (known.length === 0) return { topic: 'business', text: `CallGrid’s figures for ${lower(period)} are not known yet.`, sources };
  if (!strip.comparisonLabel) {
    // Nothing compared: the figures stand alone, with the window's own reason.
    const why = strip.coverageNote ?? known[0]!.noChangeReason ?? 'There is no valid comparison.';
    return { topic: 'business', text: `${cap(period)}: ${andJoin(known.slice(0, 3).map(figure))}. ${finish(why)}`, sources };
  }
  const against = lower(strip.comparisonLabel);
  const moved = known.filter((k) => k.change !== null && k.change.direction !== 'flat');
  if (moved.length === 0) return { topic: 'business', text: `${cap(period)}: ${andJoin(known.slice(0, 2).map(figure))}, level with ${against}.`, sources };
  const words = moved.slice(0, 3).map((k) => `${figure(k)} (${k.change!.direction === 'up' ? 'up' : 'down'} ${k.change!.text})`);
  return { topic: 'business', text: `${cap(period)}: ${andJoin(words)} against ${against}.`, sources };
}

// --- Intelligence ------------------------------------------------------------------------------------

function intelligenceSentence(input: NarrativeInput): NarrativeSentence | null {
  const h = input.headlines;
  if (h === null) return null;
  const sources = [{ label: 'Headlines', href: input.hrefs.headlines }];
  if (h.rows === null) return { topic: 'intelligence', text: 'Loop could not read Headlines just now.', sources };
  if (h.rows.length === 0) {
    // The governed statement: all clear says what was checked; a coverage gap says Loop cannot tell.
    return { topic: 'intelligence', text: h.attention ? finish(h.attention.statement) : 'No Headline is open.', sources };
  }
  const standings = h.rows.map((r) => h.standings.get(r.id)?.situation ?? null);
  const unknown = standings.some((s) => s === null);
  const investigating = standings.filter((s) => s === 'UNDER_INVESTIGATION').length;
  const open = `${counted(h.rows.length, 'Headline is', 'Headlines are')} open`;
  const cases = unknown
    ? 'Loop could not read which are under investigation'
    : investigating === 0
      ? 'none is under investigation yet'
      : investigating === h.rows.length
        ? `${h.rows.length === 1 ? 'it is' : 'all are'} under investigation`
        : `${investigating} under investigation`;
  return { topic: 'intelligence', text: `${open}; ${cases}.`, sources };
}

// --- Communications ------------------------------------------------------------------------------------

function mailClause(input: NarrativeInput): string | null {
  const state = input.today.mail;
  switch (state.state) {
    case 'NOT_CONFIGURED':
      return null;
    case 'NOT_CONNECTED':
      return 'your mail isn’t connected';
    case 'NOT_READ':
      return 'Loop has not read your mail yet';
    case 'UNAVAILABLE':
      return 'Loop could not open your mail just now';
    case 'READ': {
      const m = input.mail;
      if (!m) return 'Loop has not read your mail yet';
      const parts = [
        m.needsReply > 0 ? `${counted(m.needsReply, 'conversation in your mail needs', 'conversations in your mail need')} your reply` : null,
        m.waiting > 0 ? `you are waiting on ${counted(m.waiting, 'reply', 'replies')}` : null,
      ].filter((x): x is string => x !== null);
      if (parts.length === 0) return state.current ? 'nothing in your mail needs you' : 'nothing in your mail needed you when Loop last read it';
      return `${andJoin(parts)}${state.current ? '' : ' (as Loop last read it)'}`;
    }
  }
}

function chatsClause(input: NarrativeInput): string | null {
  const read = input.chats;
  if (read === null) return null;
  if (!read.ok) return 'Loop could not read your chats just now';
  const c = read.value;
  switch (c.state) {
    case 'NOT_PERMITTED':
    case 'NOT_AVAILABLE':
      return null;
    case 'NOT_CONNECTED':
      return 'Telegram isn’t connected';
    case 'UNAVAILABLE':
      return 'Loop cannot use your Telegram connection right now';
    default:
      return c.conversations.length > 0
        ? `${counted(c.conversations.length, 'Telegram conversation needs', 'Telegram conversations need')} you`
        : 'Loop flagged no Telegram conversation for you';
  }
}

function communicationsSentence(input: NarrativeInput): NarrativeSentence | null {
  const mail = mailClause(input);
  const chats = chatsClause(input);
  const clauses = [mail, chats].filter((x): x is string => x !== null);
  if (clauses.length === 0) return null;
  const sources: NarrativeSource[] = [];
  if (mail !== null) sources.push({ label: 'Mail', href: input.hrefs.mail });
  if (chats !== null) sources.push({ label: 'Chats', href: input.hrefs.chats });
  return { topic: 'communications', text: `${cap(clauses.join('; '))}.`, sources };
}

// --- The day and the work ---------------------------------------------------------------------------

function dayClause(input: NarrativeInput): string | null {
  const t = input.today;
  const cal = t.calendar;
  switch (cal.state) {
    case 'NOT_CONFIGURED':
      return null;
    case 'NOT_CONNECTED':
      return 'your calendar isn’t connected';
    case 'NOT_READ':
      return 'Loop has not read your calendar yet';
    case 'UNAVAILABLE':
      return 'Loop could not open your calendar just now';
    case 'READ': {
      const stale = cal.current ? '' : ' (as Loop last read it)';
      if (t.inProgress) {
        const next = t.next?.startsAt ? `, then “${t.next.summary ?? 'Untitled event'}” at ${input.time.time(t.next.startsAt)}` : '';
        return `“${t.inProgress.summary ?? 'Untitled event'}” is on now${next}${stale}`;
      }
      if (t.next?.startsAt) return `your next meeting is “${t.next.summary ?? 'Untitled event'}” at ${input.time.time(t.next.startsAt)}${stale}`;
      if (t.events.length > 0) return `no meetings are left today${stale}`;
      return `there are no meetings on your calendar today${stale}`;
    }
  }
}

function workClause(input: NarrativeInput): string | null {
  const read = input.work;
  if (read === null) return null;
  if (!read.ok) return 'Loop could not read your work just now';
  const p = read.value;
  if (p.assigned === 0) return 'no work is assigned to you';
  const floor = p.datesPartial ? 'at least ' : '';
  const dated = [p.overdue > 0 ? `${floor}${p.overdue} overdue` : null, p.dueToday > 0 ? `${floor}${p.dueToday} due today` : null].filter((x): x is string => x !== null);
  return `${counted(p.assigned, 'work item is', 'work items are')} assigned to you${dated.length > 0 ? `, ${andJoin(dated)}` : ''}`;
}

function daySentence(input: NarrativeInput): NarrativeSentence | null {
  const day = dayClause(input);
  const work = workClause(input);
  const clauses = [day, work].filter((x): x is string => x !== null);
  if (clauses.length === 0) return null;
  const sources: NarrativeSource[] = [];
  if (day !== null) sources.push({ label: 'Calendar', href: input.hrefs.calendar });
  if (work !== null) sources.push({ label: 'My Work', href: input.hrefs.work });
  return { topic: 'day', text: `${cap(clauses.join('; '))}.`, sources };
}

// --- The narrative --------------------------------------------------------------------------------

/** The briefing's prose: at most four sentences, each with its sources, in a fixed order. */
export function briefingNarrative(input: NarrativeInput): readonly NarrativeSentence[] {
  return [businessSentence(input), intelligenceSentence(input), communicationsSentence(input), daySentence(input)]
    .filter((s): s is NarrativeSentence => s !== null)
    .slice(0, NARRATIVE_MAX);
}

// How the People command center says things (CRM slice 6). Pure: no I/O, no clock.
//
// Every phrase keeps its basis visible: a state a person set says so, a state derived from the
// viewer's own Gmail says so, an imported fact says so, and what Loop cannot know is said plainly
// -- never a zero, a blank or a guess.

import {
  CRM_CONVERSATION_STATE_LABELS,
  type CrmConversationState,
  type CrmConversationStateBasis,
  type CrmMailVisibility,
  type CrmOutreachDerivation,
  type CrmReplyStatus,
  type CrmReviewReason,
  type CrmTimePrecision,
  type TimeView,
} from '@emgloop/shared';

import type { SubjectTone } from './subject-display';

/** A pill tone; `info` is the Loop pill for in-progress states (loop-os.css). */
export type OutreachTone = SubjectTone | 'info';

export function conversationStateTone(state: CrmConversationState): OutreachTone {
  switch (state) {
    case 'REPLIED_NEEDS_RESPONSE':
    case 'REVIEW_REQUIRED':
      return 'attention';
    case 'INTERESTED':
    case 'MEETING_SCHEDULED':
    case 'NEGOTIATING':
    case 'ACTIVE_CONVERSATION':
      return 'good';
    case 'AWAITING_REPLY':
      return 'info';
    case 'PASSED':
    case 'CLOSED':
    case 'ON_HOLD':
    case 'CIRCLE_BACK':
    case 'NO_OUTREACH':
    case 'UNKNOWN':
      return 'neutral';
  }
}

export function conversationState(state: CrmConversationState): { label: string; tone: OutreachTone } {
  return { label: CRM_CONVERSATION_STATE_LABELS[state], tone: conversationStateTone(state) };
}

const BASIS_TEXT: Readonly<Record<CrmConversationStateBasis, string>> = {
  HUMAN: 'set by a person',
  GMAIL: 'from your Gmail',
  CALENDAR: 'from your calendar',
  IMPORT: 'from the import',
  NONE: 'nothing observed',
};

export const basisText = (basis: CrmConversationStateBasis) => BASIS_TEXT[basis];

const REVIEW_TEXT: Readonly<Record<CrmReviewReason, string>> = {
  REPLY_CONTENT_UNKNOWN: 'They replied. Gmail metadata cannot tell whether the reply needs an answer; review the conversation or use the governed AI reading.',
  UNCERTAIN_INBOUND: 'A message arrived that rules cannot call a real reply.',
  IMPORTED_HISTORY_ONLY: 'Only imported history is known; where the cadence stands is not.',
};

export const reviewText = (reason: CrmReviewReason | null) => (reason ? REVIEW_TEXT[reason] : null);

/** A time with its precision: a date-only fact is shown as a date; an unknown time says so. */
export function factTime(at: Date | null, precision: CrmTimePrecision, time: TimeView): string {
  if (!at || precision === 'UNKNOWN') return 'Unknown time';
  if (precision === 'DATE') return `${at.toISOString().slice(0, 10)} (date only)`;
  return time.dateTime(at);
}

/** What the viewer's Gmail can vouch for, in words. */
export function mailFreshnessText(mail: CrmMailVisibility, time: TimeView): string {
  if (mail.state === 'UNAVAILABLE') return 'Gmail data unavailable: replies and sends are not known.';
  const through = time.dateTime(mail.observedThrough);
  if (mail.state === 'STALE') return `Gmail data stale: last read ${time.relative(mail.observedThrough)} (${through}).`;
  return `Gmail read through ${through}${mail.observedFrom ? `, from ${time.date(mail.observedFrom)}` : ''}.`;
}

export function replyText(o: CrmOutreachDerivation, mail: CrmMailVisibility, time: TimeView): string {
  const status: CrmReplyStatus = o.replyStatus;
  if (status === 'AWAITING_OUR_RESPONSE') return o.lastInboundAt ? `Replied ${time.relative(o.lastInboundAt)} — awaiting our response` : 'Replied — awaiting our response';
  if (status === 'REPLIED') return o.lastInboundAt ? `Replied ${time.relative(o.lastInboundAt)}` : 'Replied';
  if (status === 'NO_REPLY_OBSERVED' && mail.state !== 'UNAVAILABLE') {
    return `No reply observed through ${time.dateTime(mail.observedThrough)}${mail.state === 'STALE' ? ' (Gmail data stale)' : ''}`;
  }
  return 'Gmail data unavailable';
}

export function lastTouchText(o: CrmOutreachDerivation, time: TimeView): string {
  if (!o.lastTouch) return 'None recorded';
  const when = o.lastTouch.precision === 'DATE' ? o.lastTouch.at.toISOString().slice(0, 10) : time.relative(o.lastTouch.at);
  return `${when} · ${o.lastTouch.source === 'GMAIL' ? 'Gmail' : 'import'}`;
}

export function cadenceText(o: CrmOutreachDerivation): string {
  const c = o.cadence;
  if (c.status === 'ACTIVE' && c.nextTouch) return `Next: ${o.nextAction.kind === 'CADENCE' ? o.nextAction.label.replace(/^Follow up: /, '') : c.nextTouch} · ${c.sends} sent`;
  if (c.status === 'STOPPED') return c.stoppedBy === 'REPLY' ? `Stopped by reply · ${c.sends} sent` : `Paused by a person · ${c.sends} sent`;
  if (c.status === 'UNKNOWN') return 'Position unknown (imported history)';
  return 'Not started';
}

export function dueText(o: CrmOutreachDerivation, time: TimeView): string {
  const n = o.nextAction;
  if (!n.dueAt) return '';
  const day = n.kind === 'HUMAN' && n.dueAt.getUTCHours() === 0 && n.dueAt.getUTCMinutes() === 0 ? n.dueAt.toISOString().slice(0, 10) : time.date(n.dueAt);
  if (n.bucket === 'OVERDUE') return `Overdue · due ${day}`;
  if (n.bucket === 'TODAY') return 'Due today';
  return `Due ${day}`;
}

/** The outcome of an act, for the notice after its redirect. */
export const OUTREACH_OUTCOME_TEXT: Readonly<Record<string, { kind: 'attention' | 'denied' | 'empty'; title: string; body?: string }>> = {
  RECORDED: { kind: 'empty', title: 'Saved.' },
  UNCHANGED: { kind: 'empty', title: 'Nothing changed.', body: 'That was already recorded.' },
  NOT_AUTHORIZED: { kind: 'denied', title: 'You cannot do that here.', body: 'Your membership does not include this act.' },
  NOT_FOUND: { kind: 'attention', title: 'That record is not available.' },
  INVALID: { kind: 'attention', title: 'That was not a valid choice.' },
  INVALID_EMPTY: { kind: 'attention', title: 'Nothing was entered.' },
  INVALID_TOO_LONG: { kind: 'attention', title: 'That is too long.' },
  INVALID_CARRIES_CONTACT_VALUE: {
    kind: 'attention',
    title: 'Contact details cannot go here.',
    body: 'Addresses and phone numbers belong on a contact point, where their own access rules apply. Remove them and try again.',
  },
  INVALID_NOT_A_HUMAN_STATE: { kind: 'attention', title: 'That state comes from mail, not from a person.' },
  INVALID_DUE_DATE_INVALID: { kind: 'attention', title: 'That due date is not a valid date.' },
  ADDED_FROM_DISCOVERY: { kind: 'empty', title: 'Added to People.', body: 'Created and established by you, with their email as a contact point. Their history appears from your own mail.' },
  ALREADY_EXISTS: { kind: 'attention', title: 'This person is already in People.', body: 'That exact address is already recorded for them, so nothing new was created.' },
};

/** The summary strip's words, in one place (the People page imports them; it does not spell them). */
export const PEOPLE_SUMMARY_LABELS = {
  activeContacts: 'Active contacts',
  awaitingReply: 'Awaiting reply',
  dueToday: 'Due today',
  overdue: 'Overdue',
  repliesNeedingResponse: 'Replies needing response',
  activeOrInterested: 'Active or interested',
  meetingsUpcoming: 'Meetings upcoming',
  onHold: 'On hold or circle back',
  recentlyClosed: 'Passed or closed (30 days)',
  touchedThisWeek: 'Touched this week',
  newRepliesThisWeek: 'New replies this week',
  reviewRequired: 'Review required',
  possibleNewPeople: 'Possible new people',
  newPeopleThisWeek: 'New people this week',
} as const;

/** The due filter's words. */
export const DUE_FILTER_LABELS = { overdue: 'Overdue', today: 'Today', upcoming: 'Upcoming' } as const;

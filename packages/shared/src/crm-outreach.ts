// The CRM outreach contract: the People command center (CRM slice 6, 2026-10-08).
//
// Decision record: docs/architecture/crm-people-command-center.md.
//
// THREE KINDS OF THING, NEVER BLENDED:
//   FACT                 a send or a reply Gmail observed in the viewer's own mailbox, a meeting the
//                        viewer's own Calendar holds, a title or a note an import or a person recorded.
//   DERIVED STATE        what this contract concludes from facts: the cadence position, the next touch
//                        and its due date, AWAITING_REPLY, REPLIED_NEEDS_RESPONSE, REVIEW_REQUIRED.
//                        Recomputed on every read; never stored.
//   HUMAN INTERPRETATION a conversation state or a next action a person set. Stored, attributed, and
//                        never written by a rule, a model or an import.
// The read model carries the basis of every state it shows, so a reader can always tell which.
//
// NOT AN OPPORTUNITY STAGE. A conversation state describes the conversation with one person. It is
// never an Opportunity stage, never moves one, and never creates one.
//
// PURE. No clock (callers pass `now`), no I/O, no hashing.

import { crmContactPointReasonCarriesContactValue } from './crm-contact-point';
import { zonedCalendarDay } from './loop-time';

export const CRM_OUTREACH_CONTRACT_VERSION = 'crm.outreach.v1' as const;

// --- Who may do what ------------------------------------------------------------------------

export const CRM_OUTREACH_ACTS = [
  /** The command center, a person's outreach panel, titles, company and creator context, notes. */
  'VIEW',
  /** Set or clear a person's conversation state (a human interpretation). */
  'SET_STATE',
  /** Set or clear a person's next action and its due date (a human interpretation). */
  'SET_NEXT_ACTION',
  /** Record a note on a person. */
  'RECORD_NOTE',
  /** Retract a recorded context fact (it stays in history, marked retracted). */
  'RETRACT_FACT',
  /** Run the historical-context backfill from a reviewed import. */
  'BACKFILL_CONTEXT',
] as const;
export type CrmOutreachAct = (typeof CRM_OUTREACH_ACTS)[number];

const HUMAN_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'] as const;
const EMPLOYEE_AND_ABOVE = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'] as const;
const OWNER_ADMIN = ['OWNER', 'ADMIN'] as const;

/** AI_EMPLOYEE and CREATOR appear nowhere. */
export const CRM_OUTREACH_ACT_ROLES: Readonly<Record<CrmOutreachAct, readonly string[]>> = Object.freeze({
  VIEW: HUMAN_ROLES,
  SET_STATE: EMPLOYEE_AND_ABOVE,
  SET_NEXT_ACTION: EMPLOYEE_AND_ABOVE,
  RECORD_NOTE: EMPLOYEE_AND_ABOVE,
  RETRACT_FACT: OWNER_ADMIN,
  BACKFILL_CONTEXT: OWNER_ADMIN,
});

export const CRM_OUTREACH_FORBIDDEN_ROLES: readonly string[] = Object.freeze(['AI_EMPLOYEE']);

/** Fails closed three ways: a person, a role that is not forbidden, a role the act grants. */
export function crmOutreachActPermitted(request: { readonly act: string; readonly role: string; readonly actorType: string }): boolean {
  if (request.actorType !== 'HUMAN') return false;
  if (CRM_OUTREACH_FORBIDDEN_ROLES.includes(request.role)) return false;
  const roles = (CRM_OUTREACH_ACT_ROLES as Readonly<Record<string, readonly string[]>>)[request.act];
  return Array.isArray(roles) && roles.includes(request.role);
}

// --- Conversation states -----------------------------------------------------------------------

/**
 * Every state the command center shows. UNKNOWN is the honest answer when the viewer's mail cannot
 * be read and nothing else is known: it is shown, never hidden behind NO_OUTREACH.
 */
export const CRM_CONVERSATION_STATES = [
  'NO_OUTREACH',
  'AWAITING_REPLY',
  'REPLIED_NEEDS_RESPONSE',
  'ACTIVE_CONVERSATION',
  'INTERESTED',
  'MEETING_SCHEDULED',
  'NEGOTIATING',
  'ON_HOLD',
  'CIRCLE_BACK',
  'PASSED',
  'CLOSED',
  'REVIEW_REQUIRED',
  'UNKNOWN',
] as const;
export type CrmConversationState = (typeof CRM_CONVERSATION_STATES)[number];

/**
 * The states a PERSON may set. NO_OUTREACH, AWAITING_REPLY, REPLIED_NEEDS_RESPONSE, REVIEW_REQUIRED
 * and UNKNOWN are derived from facts only: a person cannot assert that a reply arrived.
 */
export const CRM_HUMAN_CONVERSATION_STATES = [
  'ACTIVE_CONVERSATION',
  'INTERESTED',
  'MEETING_SCHEDULED',
  'NEGOTIATING',
  'ON_HOLD',
  'CIRCLE_BACK',
  'PASSED',
  'CLOSED',
] as const;
export type CrmHumanConversationState = (typeof CRM_HUMAN_CONVERSATION_STATES)[number];

export function isCrmHumanConversationState(value: unknown): value is CrmHumanConversationState {
  return typeof value === 'string' && (CRM_HUMAN_CONVERSATION_STATES as readonly string[]).includes(value);
}

export const CRM_CONVERSATION_STATE_LABELS: Readonly<Record<CrmConversationState, string>> = Object.freeze({
  NO_OUTREACH: 'No outreach',
  AWAITING_REPLY: 'Awaiting reply',
  REPLIED_NEEDS_RESPONSE: 'Replied — needs response',
  ACTIVE_CONVERSATION: 'Active conversation',
  INTERESTED: 'Interested',
  MEETING_SCHEDULED: 'Meeting scheduled',
  NEGOTIATING: 'Negotiating',
  ON_HOLD: 'On hold',
  CIRCLE_BACK: 'Circle back',
  PASSED: 'Passed',
  CLOSED: 'Closed',
  REVIEW_REQUIRED: 'Review required',
  UNKNOWN: 'Unknown',
});

/** Where a shown state came from. */
export type CrmConversationStateBasis = 'HUMAN' | 'GMAIL' | 'CALENDAR' | 'IMPORT' | 'NONE';

/** States the command center groups as finished (closed out of active outreach). */
export const CRM_CLOSED_STATES: readonly CrmConversationState[] = Object.freeze(['PASSED', 'CLOSED']);
/** States the command center groups as paused. */
export const CRM_HOLD_STATES: readonly CrmConversationState[] = Object.freeze(['ON_HOLD', 'CIRCLE_BACK']);

// --- Human text: next actions and notes --------------------------------------------------------

export const CRM_NEXT_ACTION_MAX = 200;
export const CRM_NOTE_MAX = 2000;
export const CRM_TITLE_MAX = 200;

export type CrmOutreachTextViolation = 'EMPTY' | 'TOO_LONG' | 'CARRIES_CONTACT_VALUE';

/**
 * A next action or a note a person types. Refused when it carries something shaped like a contact
 * value: an address or a number belongs on a Contact Point, whose own authority decides who may
 * read it. A note readable by everyone who may see People must never become a side door to it.
 */
export function validateCrmOutreachText(text: unknown, max: number): { ok: true; value: string } | { ok: false; violation: CrmOutreachTextViolation } {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, violation: 'EMPTY' };
  const value = text.trim();
  if (value.length > max) return { ok: false, violation: 'TOO_LONG' };
  if (crmContactPointReasonCarriesContactValue(value)) return { ok: false, violation: 'CARRIES_CONTACT_VALUE' };
  return { ok: true, value };
}

/**
 * IMPORTED text (a historical note, a title) is not refused -- it is history, and refusing it would
 * lose the rest of the note -- but every address-shaped or number-shaped run in it is replaced
 * before it is stored, and the count of replacements is kept. The same detector as above, so what
 * an operator could not type, an import cannot store.
 */
export const CRM_REDACTED_CONTACT_VALUE = '[contact value withheld]';

export function redactCrmContactValues(text: string): { value: string; redactions: number } {
  let redactions = 0;
  let value = text.replace(/[^\s@<>()[\],;:"']+@[^\s@<>()[\],;:"']+\.[^\s@<>()[\],;:"']+/g, () => {
    redactions += 1;
    return CRM_REDACTED_CONTACT_VALUE;
  });
  // A digit run of 7+ digits (spaces, dots, dashes, parentheses and a plus allowed between), except an
  // ISO date or instant, which is a time.
  value = value.replace(/\+?\d[\d\s().-]*\d/g, (run) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(run.trim())) return run;
    if (run.replace(/\D/g, '').length < 7) return run;
    redactions += 1;
    return CRM_REDACTED_CONTACT_VALUE;
  });
  return { value, redactions };
}

// --- Context facts -----------------------------------------------------------------------------

/**
 * What is recorded about a Party beyond its identity, each with its basis and source:
 *   TITLE                 a person's job title, as the source or an operator gave it;
 *   NOTE                  a historical (imported) or operator note;
 *   SOURCE_STATUS         the status a source recorded, verbatim -- never mapped to a state;
 *   SOURCE_LAST_CONTACTED the last human contact a source recorded (time precision kept);
 *   CREATOR_CONTEXT       the creator the source row was worked for (the reviewed alias);
 *   COMPANY_CONTEXT       the Company the governed import attached the row's contacts to -- a
 *                         context link, NEVER a Relationship and never an affiliation;
 *   ORIGIN                how the Party came to be in the CRM (e.g. human-approved from Gmail discovery).
 */
export const CRM_CONTEXT_FACT_KINDS = ['TITLE', 'NOTE', 'SOURCE_STATUS', 'SOURCE_LAST_CONTACTED', 'CREATOR_CONTEXT', 'COMPANY_CONTEXT', 'ORIGIN'] as const;
export type CrmContextFactKind = (typeof CRM_CONTEXT_FACT_KINDS)[number];

export const CRM_CONTEXT_FACT_BASES = ['IMPORTED', 'OPERATOR_RECORDED'] as const;
export type CrmContextFactBasis = (typeof CRM_CONTEXT_FACT_BASES)[number];

/** How precisely a fact's time is known. UNKNOWN is shown as "unknown time", never as the record time. */
export const CRM_TIME_PRECISIONS = ['INSTANT', 'DATE', 'UNKNOWN'] as const;
export type CrmTimePrecision = (typeof CRM_TIME_PRECISIONS)[number];

export const CRM_ORIGIN_GMAIL_DISCOVERY = 'Human-approved from Gmail discovery' as const;

// --- Message qualification ---------------------------------------------------------------------

/**
 * What one stored message is, for outreach. Decided from stored metadata only -- labels, subject,
 * the sender's address -- by fixed rules; never by a model.
 *   QUALIFYING_SEND  the viewer sent it, the person is a direct (To) recipient, and Gmail does not
 *                    hold it as a draft, spam or trash;
 *   HUMAN_REPLY      it came from the person's own address and no rule marks it automated;
 *   AUTOMATED        an auto-reply, out-of-office, delivery or read receipt, bounce, or spam/trash;
 *   UNCERTAIN        from the person, but Gmail filed it in a bulk tab: a human may have written it,
 *                    or a system may have. Never counted as a reply; surfaces REVIEW_REQUIRED;
 *   NOT_OUTREACH     the viewer sent it but the person was only copied (Cc), or it is a draft.
 */
export type CrmMessageQualification = 'QUALIFYING_SEND' | 'HUMAN_REPLY' | 'AUTOMATED' | 'UNCERTAIN' | 'NOT_OUTREACH';

export const CRM_OUTREACH_QUALIFICATION_VERSION = 'crm.outreach.qualification.v1' as const;

/** Subject openings auto-responders, receipts and bounces use. Anchored: a human's "Re: out of office plans" does not match. */
const AUTOMATED_SUBJECT =
  /^\s*(?:\[?(?:auto(?:matic)?[\s-]?(?:reply|response)|autoreply|auto:|out of (?:the )?office|ooo\b|away from (?:the )?office|on vacation|undeliverable|undelivered mail|delivery status notification|delivery (?:has )?failed|mail delivery (?:failed|subsystem)|returned mail|failure notice|read:|not read:|delivered:|read receipt|message (?:not delivered|blocked))(?![a-z]))/i;

const SPAM_OR_TRASH = new Set(['SPAM', 'TRASH']);
const BULK_TABS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'CATEGORY_UPDATES']);
/** Local parts machines send from (the Mail dashboard's rule, restated here so this contract is self-contained). */
const AUTOMATED_LOCAL =
  /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)([._+-]|$)|^(notifications?|notify|alerts?|newsletters?|digest|updates|automated|robot)([._+-]|$)/i;

export function crmAutomatedAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  return AUTOMATED_LOCAL.test(address.split('@')[0] ?? '');
}

export interface CrmMessageEvidence {
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly labels: readonly string[];
  readonly subject: string | null;
  /** Normalized provider automation evidence; raw header values never reach this contract. */
  readonly automationClass?: 'AUTO_SUBMITTED' | 'MAILING_LIST' | 'BULK' | null;
  /** For OUTBOUND: whether the person is a direct (To) recipient. */
  readonly personInTo?: boolean;
  /** For INBOUND: the sender's own stored address (for the automated-sender rule). */
  readonly senderAddress?: string | null;
}

export function qualifyCrmMessage(m: CrmMessageEvidence): CrmMessageQualification {
  const labels = new Set(m.labels);
  if (m.direction === 'OUTBOUND') {
    if (labels.has('DRAFT')) return 'NOT_OUTREACH';
    if ([...labels].some((l) => SPAM_OR_TRASH.has(l))) return 'NOT_OUTREACH';
    return m.personInTo ? 'QUALIFYING_SEND' : 'NOT_OUTREACH';
  }
  if ([...labels].some((l) => SPAM_OR_TRASH.has(l))) return 'AUTOMATED';
  if (m.automationClass === 'AUTO_SUBMITTED' || m.automationClass === 'MAILING_LIST' || m.automationClass === 'BULK') return 'AUTOMATED';
  if (crmAutomatedAddress(m.senderAddress)) return 'AUTOMATED';
  if (m.subject && AUTOMATED_SUBJECT.test(m.subject)) return 'AUTOMATED';
  if ([...labels].some((l) => BULK_TABS.has(l))) return 'UNCERTAIN';
  return 'HUMAN_REPLY';
}

// --- Cadence ---------------------------------------------------------------------------------

/**
 * THE CADENCE (locked 2026-10-08): the initial send, then three touches 3 days apart, three 7 days
 * apart, three 14 days apart, then monthly for as long as there is no reply. Every interval runs
 * from the ACTUAL time of the previous qualifying send -- never from when it was due -- so a late
 * touch moves everything after it. A genuine human reply stops the cadence; an automated one does
 * not.
 */
export const CRM_CADENCE_VERSION = 'crm.cadence.v1' as const;

export type CrmCadenceTouch =
  | 'INITIAL'
  | 'THREE_DAY_1' | 'THREE_DAY_2' | 'THREE_DAY_3'
  | 'SEVEN_DAY_1' | 'SEVEN_DAY_2' | 'SEVEN_DAY_3'
  | 'FOURTEEN_DAY_1' | 'FOURTEEN_DAY_2' | 'FOURTEEN_DAY_3'
  | 'MONTHLY';

const TOUCHES: readonly CrmCadenceTouch[] = [
  'INITIAL',
  'THREE_DAY_1', 'THREE_DAY_2', 'THREE_DAY_3',
  'SEVEN_DAY_1', 'SEVEN_DAY_2', 'SEVEN_DAY_3',
  'FOURTEEN_DAY_1', 'FOURTEEN_DAY_2', 'FOURTEEN_DAY_3',
];

/** The touch at a 0-based position: 0 is the initial send, 10 and after are monthly. */
export function crmCadenceTouch(index: number): CrmCadenceTouch {
  if (!Number.isInteger(index) || index < 0) return 'INITIAL';
  return TOUCHES[index] ?? 'MONTHLY';
}

/** The cadence stage a touch belongs to, for filters: INITIAL, 3-day, 7-day, 14-day, monthly. */
export type CrmCadenceStage = 'INITIAL' | 'THREE_DAY' | 'SEVEN_DAY' | 'FOURTEEN_DAY' | 'MONTHLY';
export const CRM_CADENCE_STAGES: readonly CrmCadenceStage[] = Object.freeze(['INITIAL', 'THREE_DAY', 'SEVEN_DAY', 'FOURTEEN_DAY', 'MONTHLY']);

export function crmCadenceStage(touch: CrmCadenceTouch): CrmCadenceStage {
  if (touch === 'INITIAL') return 'INITIAL';
  if (touch.startsWith('THREE_DAY')) return 'THREE_DAY';
  if (touch.startsWith('SEVEN_DAY')) return 'SEVEN_DAY';
  if (touch.startsWith('FOURTEEN_DAY')) return 'FOURTEEN_DAY';
  return 'MONTHLY';
}

export function crmCadenceTouchLabel(index: number): string {
  const touch = crmCadenceTouch(index);
  if (touch === 'INITIAL') return 'Initial outreach';
  if (touch === 'MONTHLY') return `Monthly #${index - 9}`;
  const [, n] = /_(\d)$/.exec(touch) ?? [];
  const stage = crmCadenceStage(touch);
  const days = stage === 'THREE_DAY' ? 3 : stage === 'SEVEN_DAY' ? 7 : 14;
  return `${days}-day #${n}`;
}

/**
 * When the touch at `index` (>= 1) falls due, from the actual time of the send before it. Days are
 * exact 24-hour periods (a send at 15:04 is due at 15:04 three days later); a month is the same day
 * and time one calendar month later in UTC, clamped to the month's last day.
 */
export function crmCadenceDueAt(previousSendAt: Date, index: number): Date {
  if (index >= 10) {
    const d = new Date(previousSendAt.getTime());
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d;
  }
  const days = index <= 3 ? 3 : index <= 6 ? 7 : 14;
  return new Date(previousSendAt.getTime() + days * 86_400_000);
}

export interface CrmCadence {
  readonly version: typeof CRM_CADENCE_VERSION;
  /**
   * NOT_STARTED  no qualifying send observed;
   * ACTIVE       sends, no human reply since the first: a next touch is due;
   * STOPPED      a human reply arrived after the first send (or a person set a state);
   * UNKNOWN      the position cannot be evidenced (an imported last-contacted date only).
   */
  readonly status: 'NOT_STARTED' | 'ACTIVE' | 'STOPPED' | 'UNKNOWN';
  readonly stoppedBy: 'REPLY' | 'HUMAN_STATE' | null;
  /** Qualifying sends observed. */
  readonly sends: number;
  readonly lastSendAt: Date | null;
  /** The position of the NEXT touch (0-based), when ACTIVE. */
  readonly nextIndex: number | null;
  readonly nextTouch: CrmCadenceTouch | null;
  readonly nextDueAt: Date | null;
}

/** The cadence over observed sends and replies. Sends and replies may arrive in any order. */
export function computeCrmCadence(input: { readonly sends: readonly Date[]; readonly humanReplies: readonly Date[] }): CrmCadence {
  const sends = [...input.sends].sort((a, b) => a.getTime() - b.getTime());
  const base = { version: CRM_CADENCE_VERSION, sends: sends.length, lastSendAt: sends[sends.length - 1] ?? null };
  if (sends.length === 0) return { ...base, status: 'NOT_STARTED', stoppedBy: null, nextIndex: null, nextTouch: null, nextDueAt: null };
  const first = sends[0]!;
  if (input.humanReplies.some((r) => r.getTime() > first.getTime())) {
    return { ...base, status: 'STOPPED', stoppedBy: 'REPLY', nextIndex: null, nextTouch: null, nextDueAt: null };
  }
  const nextIndex = sends.length;
  return { ...base, status: 'ACTIVE', stoppedBy: null, nextIndex, nextTouch: crmCadenceTouch(nextIndex), nextDueAt: crmCadenceDueAt(base.lastSendAt!, nextIndex) };
}

// --- Due buckets -------------------------------------------------------------------------------

export type CrmDueBucket = 'OVERDUE' | 'TODAY' | 'UPCOMING' | 'NONE';

/** OVERDUE: due on a calendar day before today; TODAY: due today; in the viewer's zone. */
export function crmDueBucket(dueAt: Date | null, now: Date, timeZone: string): CrmDueBucket {
  if (!dueAt) return 'NONE';
  const due = zonedCalendarDay(dueAt, timeZone);
  const today = zonedCalendarDay(now, timeZone);
  if (due < today) return 'OVERDUE';
  if (due === today) return 'TODAY';
  return 'UPCOMING';
}

// --- The outreach derivation -------------------------------------------------------------------

/** What the viewer's own Gmail can say right now. */
export type CrmMailVisibility =
  /** No connection, no grant, or never read: nothing about mail is known. */
  | { readonly state: 'UNAVAILABLE' }
  /** Read, but the last completed read is older than the freshness policy allows. */
  | { readonly state: 'STALE'; readonly observedFrom: Date | null; readonly observedThrough: Date }
  | { readonly state: 'FRESH'; readonly observedFrom: Date | null; readonly observedThrough: Date };

export interface CrmHumanOutreach {
  readonly state: CrmHumanConversationState | null;
  readonly stateSetAt: Date | null;
  readonly nextAction: string | null;
  readonly nextActionDueAt: Date | null;
}

export interface CrmOutreachInput {
  readonly mail: CrmMailVisibility;
  /** Times of the viewer's qualifying sends to this person. */
  readonly sends: readonly Date[];
  readonly humanReplies: readonly Date[];
  readonly automated: readonly Date[];
  readonly uncertain: readonly Date[];
  /** The last human contact an import recorded, when one did. */
  readonly importedLastContact: { readonly at: Date; readonly precision: 'DATE' | 'INSTANT' } | null;
  readonly human: CrmHumanOutreach | null;
  /** The next meeting with this person on the viewer's calendar, when one exists. */
  readonly nextMeetingAt: Date | null;
  readonly now: Date;
  readonly timeZone: string;
}

export type CrmNextActionKind = 'HUMAN' | 'RESPOND' | 'MEETING' | 'CADENCE' | 'REVIEW' | 'NONE';

export interface CrmNextAction {
  readonly kind: CrmNextActionKind;
  readonly label: string;
  readonly dueAt: Date | null;
  readonly bucket: CrmDueBucket;
}

export type CrmReplyStatus =
  /** A human reply is the latest word: ours is owed. */
  | 'AWAITING_OUR_RESPONSE'
  /** They have replied at some point and we answered. */
  | 'REPLIED'
  /**
   * No reply was observed THROUGH the last completed read of the viewer's Gmail. Always shown with
   * that time, and marked stale when the read is older than the freshness policy allows -- a fact
   * about what was read, never a claim about what has happened since.
   */
  | 'NO_REPLY_OBSERVED'
  /** Mail cannot be read: no claim either way. */
  | 'UNKNOWN';

export type CrmReviewReason = 'UNCERTAIN_INBOUND' | 'IMPORTED_HISTORY_ONLY';

export interface CrmOutreachDerivation {
  readonly version: typeof CRM_OUTREACH_CONTRACT_VERSION;
  readonly state: CrmConversationState;
  readonly basis: CrmConversationStateBasis;
  readonly reviewReason: CrmReviewReason | null;
  /** The human-set state when the shown state is derived over it (e.g. a reply arrived after ON_HOLD). */
  readonly humanState: CrmHumanConversationState | null;
  readonly cadence: CrmCadence;
  readonly lastTouch: { readonly at: Date; readonly source: 'GMAIL' | 'IMPORT'; readonly precision: CrmTimePrecision } | null;
  readonly lastInboundAt: Date | null;
  readonly replyStatus: CrmReplyStatus;
  readonly nextAction: CrmNextAction;
}

const latest = (xs: readonly Date[]): Date | null => xs.reduce<Date | null>((m, x) => (m === null || x > m ? x : m), null);

/**
 * THE RESOLUTION ORDER (documented in the decision record, tested one rule at a time):
 *   1. a human reply newer than our last send and newer than any human-set state -> REPLIED_NEEDS_RESPONSE;
 *   2. a human-set state -> that state (cadence stops: a person is steering);
 *   3. an UNCERTAIN inbound newer than our last send -> REVIEW_REQUIRED (UNCERTAIN_INBOUND);
 *   4. an upcoming meeting on the viewer's calendar -> MEETING_SCHEDULED (basis CALENDAR);
 *   5. a human reply at any time, answered by us -> ACTIVE_CONVERSATION (basis GMAIL);
 *   6. qualifying sends -> AWAITING_REPLY, with the cadence;
 *   7. an imported last contact and nothing observed -> REVIEW_REQUIRED (IMPORTED_HISTORY_ONLY): the
 *      cadence position cannot be evidenced, and is not guessed;
 *   8. mail readable (fresh or stale) and nothing at all -> NO_OUTREACH; unreadable -> UNKNOWN.
 */
export function deriveCrmOutreach(input: CrmOutreachInput): CrmOutreachDerivation {
  const mailKnown = input.mail.state !== 'UNAVAILABLE';
  const sends = mailKnown ? input.sends : [];
  const replies = mailKnown ? input.humanReplies : [];
  const uncertain = mailKnown ? input.uncertain : [];
  const lastSend = latest(sends);
  const lastReply = latest(replies);
  const lastUncertain = latest(uncertain);
  const human = input.human;
  const humanState = human?.state ?? null;
  const humanSetAt = human?.stateSetAt ?? null;

  let cadence = computeCrmCadence({ sends, humanReplies: replies });
  const lastTouch: CrmOutreachDerivation['lastTouch'] =
    lastSend && (!input.importedLastContact || lastSend >= input.importedLastContact.at)
      ? { at: lastSend, source: 'GMAIL', precision: 'INSTANT' }
      : input.importedLastContact
        ? { at: input.importedLastContact.at, source: 'IMPORT', precision: input.importedLastContact.precision }
        : null;
  const lastInboundAt = latest([...replies, ...uncertain]);

  const replyStatus: CrmReplyStatus = !mailKnown
    ? 'UNKNOWN'
    : lastReply && (!lastSend || lastReply > lastSend)
      ? 'AWAITING_OUR_RESPONSE'
      : lastReply
        ? 'REPLIED'
        : // True through the last completed read, fresh or stale; the reader is told which, with its time.
          'NO_REPLY_OBSERVED';

  const bucket = (at: Date | null) => crmDueBucket(at, input.now, input.timeZone);
  const humanNext = (): CrmNextAction | null =>
    human?.nextAction ? { kind: 'HUMAN', label: human.nextAction, dueAt: human.nextActionDueAt, bucket: bucket(human.nextActionDueAt) } : null;
  const meetingNext = (): CrmNextAction | null =>
    input.nextMeetingAt ? { kind: 'MEETING', label: 'Meeting', dueAt: input.nextMeetingAt, bucket: bucket(input.nextMeetingAt) } : null;
  const none: CrmNextAction = { kind: 'NONE', label: 'No next action set', dueAt: null, bucket: 'NONE' };
  const out = (state: CrmConversationState, basis: CrmConversationStateBasis, nextAction: CrmNextAction, reviewReason: CrmReviewReason | null = null): CrmOutreachDerivation => ({
    version: CRM_OUTREACH_CONTRACT_VERSION,
    state,
    basis,
    reviewReason,
    humanState,
    cadence,
    lastTouch,
    lastInboundAt,
    replyStatus,
    nextAction,
  });

  // 1. Their word is the latest, and newer than anything a person decided.
  if (lastReply && (!lastSend || lastReply > lastSend) && (!humanSetAt || lastReply > humanSetAt)) {
    return out('REPLIED_NEEDS_RESPONSE', 'GMAIL', humanNext() ?? { kind: 'RESPOND', label: 'Reply needs a response', dueAt: lastReply, bucket: bucket(lastReply) });
  }
  // 2. A person is steering.
  if (humanState) {
    if (cadence.status === 'ACTIVE') cadence = { ...cadence, status: 'STOPPED', stoppedBy: 'HUMAN_STATE', nextIndex: null, nextTouch: null, nextDueAt: null };
    return out(humanState, 'HUMAN', humanNext() ?? meetingNext() ?? none);
  }
  // 3. Something arrived that rules cannot call human or machine.
  if (lastUncertain && (!lastSend || lastUncertain > lastSend) && (!lastReply || lastUncertain > lastReply)) {
    return out('REVIEW_REQUIRED', 'GMAIL', humanNext() ?? { kind: 'REVIEW', label: 'Check whether this was a real reply', dueAt: lastUncertain, bucket: bucket(lastUncertain) }, 'UNCERTAIN_INBOUND');
  }
  // 4. A meeting is booked.
  if (input.nextMeetingAt) return out('MEETING_SCHEDULED', 'CALENDAR', humanNext() ?? meetingNext()!);
  // 5. Two-way exchange, answered.
  if (lastReply) return out('ACTIVE_CONVERSATION', 'GMAIL', humanNext() ?? none);
  // 6. Outreach in progress.
  if (cadence.status === 'ACTIVE') {
    return out('AWAITING_REPLY', 'GMAIL', humanNext() ?? { kind: 'CADENCE', label: `Follow up: ${crmCadenceTouchLabel(cadence.nextIndex!)}`, dueAt: cadence.nextDueAt, bucket: bucket(cadence.nextDueAt) });
  }
  // 7. Only an import knows we were in touch.
  if (input.importedLastContact) {
    cadence = { ...cadence, status: 'UNKNOWN' };
    return out('REVIEW_REQUIRED', 'IMPORT', humanNext() ?? { kind: 'REVIEW', label: 'Confirm where this conversation stands', dueAt: null, bucket: 'NONE' }, 'IMPORTED_HISTORY_ONLY');
  }
  // 8. Nothing observed: say so only when mail could have shown it.
  return out(mailKnown ? 'NO_OUTREACH' : 'UNKNOWN', 'NONE', humanNext() ?? none);
}

// The People command center's read model: rows, filters, presets, summary and paging (CRM slice 6).
//
// Decision record: docs/architecture/crm-people-command-center.md.
//
// A ROW IS TWO AUTHORITIES SIDE BY SIDE, AND SAYS SO:
//   - SHARED CRM facts every viewer who may see People sees alike: the Person, their title, company
//     and creator context, the human-set conversation state and next action, recorded notes;
//   - the VIEWER'S OWN mail and calendar facts (the cadence, last touch, replies, meetings), derived
//     from that viewer's mailbox and nobody else's (daily-loop-employee-intelligence.md §20.1). Two
//     people looking at the same row may see different reply facts; neither ever sees the other's.
// Summary counts over mail-derived states are therefore the viewer's own, and labelled that way.
//
// PURE. Filtering, ordering, counting and paging happen over rows a server built; no I/O here.

import { crmContactPointReasonCarriesContactValue } from './crm-contact-point';
import {
  CRM_CADENCE_STAGES,
  CRM_CLOSED_STATES,
  CRM_CONVERSATION_STATES,
  CRM_HOLD_STATES,
  crmCadenceStage,
  type CrmCadenceStage,
  type CrmConversationState,
  type CrmDueBucket,
  type CrmOutreachDerivation,
  type CrmTimePrecision,
} from './crm-outreach';

export const CRM_PEOPLE_PAGE_SIZE = 50;
/** A larger directory is refused rather than read partially: the counts would lie. */
export const CRM_PEOPLE_MAX_DIRECTORY = 20_000;
export const CRM_PEOPLE_SEARCH_MAX = 100;

/** Active outreach: everything not finished, paused, untouched or unknown. */
export const CRM_ACTIVE_STATES: readonly CrmConversationState[] = Object.freeze([
  'AWAITING_REPLY',
  'REPLIED_NEEDS_RESPONSE',
  'ACTIVE_CONVERSATION',
  'INTERESTED',
  'MEETING_SCHEDULED',
  'NEGOTIATING',
  'REVIEW_REQUIRED',
]);

export interface CrmPeopleRow {
  readonly partyId: string;
  readonly displayName: string;
  readonly establishedAt: Date;
  /** The latest recorded title, with its basis. */
  readonly title: { readonly text: string; readonly basis: 'IMPORTED' | 'OPERATOR_RECORDED' } | null;
  /** The governed Company the person's import row attached to: context, never a Relationship. */
  readonly company: { readonly partyId: string; readonly name: string | null } | null;
  /** The creator the source row was worked for (the reviewed alias label), when recorded. */
  readonly creator: { readonly label: string; readonly partyId: string | null } | null;
  /** IMPORTED when an import recorded this person; MANUAL otherwise. */
  readonly origin: 'IMPORTED' | 'MANUAL';
  readonly latestNote: { readonly text: string; readonly at: Date | null; readonly precision: CrmTimePrecision; readonly basis: 'IMPORTED' | 'OPERATOR_RECORDED' } | null;
  readonly sourceStatus: string | null;
  readonly outreach: CrmOutreachDerivation;
  /** Who last set the human state or next action (a member's id), when anyone did. */
  readonly workedByUserId: string | null;
  readonly humanStateSetAt: Date | null;
  readonly nextMeetingAt: Date | null;
  readonly lastHumanReplyAt: Date | null;
}

// --- Filters -----------------------------------------------------------------------------------

export const CRM_PEOPLE_PRESETS = [
  'needs-follow-up-today',
  'overdue',
  'replied-needs-response',
  'no-reply',
  'three-day',
  'seven-day',
  'fourteen-day',
  'monthly',
  'meetings-this-week',
  'interested',
  'on-hold',
  'passed',
  'all-active',
] as const;
export type CrmPeoplePreset = (typeof CRM_PEOPLE_PRESETS)[number];

export const CRM_PEOPLE_PRESET_LABELS: Readonly<Record<CrmPeoplePreset, string>> = Object.freeze({
  'needs-follow-up-today': 'Needs follow-up today',
  overdue: 'Overdue',
  'replied-needs-response': 'Replied — needs response',
  'no-reply': 'No reply',
  'three-day': '3-day',
  'seven-day': '7-day',
  'fourteen-day': '14-day',
  monthly: 'Monthly',
  'meetings-this-week': 'Meetings this week',
  interested: 'Interested',
  'on-hold': 'On hold',
  passed: 'Passed',
  'all-active': 'All active outreach',
});

export type CrmPeopleGroup = 'active' | 'hold' | 'closed';
export type CrmPeopleContactedRange = '7d' | '30d' | '90d' | 'older' | 'never';

export interface CrmPeopleFilters {
  readonly q: string | null;
  readonly creator: string | null;
  readonly company: string | null;
  readonly title: string | null;
  readonly replied: 'yes' | 'no' | null;
  readonly state: CrmConversationState | null;
  readonly stage: CrmCadenceStage | null;
  readonly due: 'overdue' | 'today' | 'upcoming' | null;
  readonly meeting: 'upcoming' | 'this-week' | null;
  readonly owner: string | null;
  readonly origin: 'imported' | 'manual' | null;
  readonly contacted: CrmPeopleContactedRange | null;
  readonly group: CrmPeopleGroup | null;
  readonly preset: CrmPeoplePreset | null;
}

export const CRM_PEOPLE_FILTER_KEYS = ['q', 'creator', 'company', 'title', 'replied', 'state', 'stage', 'due', 'meeting', 'owner', 'origin', 'contacted', 'group', 'preset'] as const;
export type CrmPeopleFilterKey = (typeof CRM_PEOPLE_FILTER_KEYS)[number];
export type CrmPeopleSearchParams = Partial<Record<CrmPeopleFilterKey | 'page', string | string[]>>;

export const EMPTY_CRM_PEOPLE_FILTERS: CrmPeopleFilters = Object.freeze({
  q: null, creator: null, company: null, title: null, replied: null, state: null, stage: null, due: null,
  meeting: null, owner: null, origin: null, contacted: null, group: null, preset: null,
});

const one = (v: string | string[] | undefined): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : null;
};
const oneOf = <T extends string>(v: string | null, allowed: readonly T[]): T | null => (v && (allowed as readonly string[]).includes(v) ? (v as T) : null);

export type ParsedCrmPeopleFilters =
  | { readonly ok: true; readonly filters: CrmPeopleFilters; readonly params: Readonly<Partial<Record<CrmPeopleFilterKey, string>>>; readonly page: number }
  /** Search text shaped like a contact value: never searched; the caller redirects it away. */
  | { readonly ok: false; readonly params: Readonly<Partial<Record<CrmPeopleFilterKey, string>>> };

/** Read the filters from the URL. Unknown values are dropped, never guessed. */
export function parseCrmPeopleFilters(sp: CrmPeopleSearchParams | undefined): ParsedCrmPeopleFilters {
  const f = {
    q: one(sp?.q)?.slice(0, CRM_PEOPLE_SEARCH_MAX) ?? null,
    creator: one(sp?.creator)?.slice(0, 120) ?? null,
    company: one(sp?.company)?.slice(0, 64) ?? null,
    title: one(sp?.title)?.slice(0, CRM_PEOPLE_SEARCH_MAX) ?? null,
    replied: oneOf(one(sp?.replied), ['yes', 'no'] as const),
    state: oneOf(one(sp?.state), CRM_CONVERSATION_STATES),
    stage: oneOf(one(sp?.stage), CRM_CADENCE_STAGES),
    due: oneOf(one(sp?.due), ['overdue', 'today', 'upcoming'] as const),
    meeting: oneOf(one(sp?.meeting), ['upcoming', 'this-week'] as const),
    owner: one(sp?.owner)?.slice(0, 64) ?? null,
    origin: oneOf(one(sp?.origin), ['imported', 'manual'] as const),
    contacted: oneOf(one(sp?.contacted), ['7d', '30d', '90d', 'older', 'never'] as const),
    group: oneOf(one(sp?.group), ['active', 'hold', 'closed'] as const),
    preset: oneOf(one(sp?.preset), CRM_PEOPLE_PRESETS),
  } satisfies CrmPeopleFilters;
  const params: Partial<Record<CrmPeopleFilterKey, string>> = {};
  for (const k of CRM_PEOPLE_FILTER_KEYS) {
    const v = f[k];
    if (v !== null && k !== 'q' && k !== 'title') params[k] = v;
  }
  for (const k of ['q', 'title'] as const) {
    const v = f[k];
    if (v !== null && crmContactPointReasonCarriesContactValue(v)) return { ok: false, params };
    if (v !== null) params[k] = v;
  }
  const pageRaw = Number.parseInt(one(sp?.page) ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 && pageRaw <= 10_000 ? pageRaw : 1;
  return { ok: true, filters: f, params, page };
}

/** The list URL for these filters and page. Never carries an organization. */
export function crmPeopleHref(base: string, params: Readonly<Partial<Record<string, string>>>, page = 1): string {
  const search = new URLSearchParams();
  for (const k of CRM_PEOPLE_FILTER_KEYS) {
    const v = params[k];
    if (v) search.set(k, v);
  }
  if (page > 1) search.set('page', String(page));
  const s = search.toString();
  return s ? `${base}?${s}` : base;
}

const DAY = 86_400_000;
const within = (at: Date | null, now: Date, days: number) => at !== null && now.getTime() - at.getTime() <= days * DAY && at.getTime() <= now.getTime() + DAY;
const meetingWithin = (at: Date | null, now: Date, days: number) => at !== null && at.getTime() >= now.getTime() && at.getTime() - now.getTime() <= days * DAY;

function group(state: CrmConversationState): CrmPeopleGroup | null {
  if (CRM_CLOSED_STATES.includes(state)) return 'closed';
  if (CRM_HOLD_STATES.includes(state)) return 'hold';
  if (CRM_ACTIVE_STATES.includes(state)) return 'active';
  return null;
}

function presetMatches(preset: CrmPeoplePreset, r: CrmPeopleRow, now: Date): boolean {
  const o = r.outreach;
  const stageIs = (s: CrmCadenceStage) => o.state === 'AWAITING_REPLY' && o.cadence.nextTouch !== null && crmCadenceStage(o.cadence.nextTouch) === s;
  switch (preset) {
    case 'needs-follow-up-today':
      return o.nextAction.bucket === 'TODAY';
    case 'overdue':
      return o.nextAction.bucket === 'OVERDUE';
    case 'replied-needs-response':
      return o.state === 'REPLIED_NEEDS_RESPONSE';
    case 'no-reply':
      return o.state === 'AWAITING_REPLY' && o.replyStatus === 'NO_REPLY_OBSERVED';
    case 'three-day':
      return stageIs('THREE_DAY');
    case 'seven-day':
      return stageIs('SEVEN_DAY');
    case 'fourteen-day':
      return stageIs('FOURTEEN_DAY');
    case 'monthly':
      return stageIs('MONTHLY');
    case 'meetings-this-week':
      return meetingWithin(r.nextMeetingAt, now, 7);
    case 'interested':
      return o.state === 'INTERESTED';
    case 'on-hold':
      return group(o.state) === 'hold';
    case 'passed':
      return o.state === 'PASSED';
    case 'all-active':
      return group(o.state) === 'active';
  }
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase();

/** Every filter given must hold (AND). Text filters are case-insensitive substring matches over names and titles only. */
export function crmPeopleRowMatches(r: CrmPeopleRow, f: CrmPeopleFilters, now: Date): boolean {
  const o = r.outreach;
  if (f.q) {
    const q = norm(f.q);
    const hay = [r.displayName, r.company?.name ?? '', r.title?.text ?? ''].map(norm);
    if (!hay.some((h) => h.includes(q))) return false;
  }
  if (f.title && !(r.title && norm(r.title.text).includes(norm(f.title)))) return false;
  if (f.creator && !(r.creator && (r.creator.partyId === f.creator || norm(r.creator.label) === norm(f.creator)))) return false;
  if (f.company && r.company?.partyId !== f.company) return false;
  if (f.replied === 'yes' && !(o.replyStatus === 'AWAITING_OUR_RESPONSE' || o.replyStatus === 'REPLIED')) return false;
  if (f.replied === 'no' && o.replyStatus !== 'NO_REPLY_OBSERVED') return false;
  if (f.state && o.state !== f.state) return false;
  if (f.stage && !(o.state === 'AWAITING_REPLY' && o.cadence.nextTouch !== null && crmCadenceStage(o.cadence.nextTouch) === f.stage)) return false;
  if (f.due === 'overdue' && o.nextAction.bucket !== 'OVERDUE') return false;
  if (f.due === 'today' && o.nextAction.bucket !== 'TODAY') return false;
  if (f.due === 'upcoming' && o.nextAction.bucket !== 'UPCOMING') return false;
  if (f.meeting === 'upcoming' && !(r.nextMeetingAt && r.nextMeetingAt >= now)) return false;
  if (f.meeting === 'this-week' && !meetingWithin(r.nextMeetingAt, now, 7)) return false;
  if (f.owner && r.workedByUserId !== f.owner) return false;
  if (f.origin === 'imported' && r.origin !== 'IMPORTED') return false;
  if (f.origin === 'manual' && r.origin !== 'MANUAL') return false;
  if (f.contacted) {
    const at = o.lastTouch?.at ?? null;
    if (f.contacted === 'never' && at !== null) return false;
    if (f.contacted === '7d' && !within(at, now, 7)) return false;
    if (f.contacted === '30d' && !within(at, now, 30)) return false;
    if (f.contacted === '90d' && !within(at, now, 90)) return false;
    if (f.contacted === 'older' && !(at !== null && !within(at, now, 90))) return false;
  }
  if (f.group && group(o.state) !== f.group) return false;
  if (f.preset && !presetMatches(f.preset, r, now)) return false;
  return true;
}

const BUCKET_RANK: Readonly<Record<CrmDueBucket, number>> = { OVERDUE: 0, TODAY: 1, UPCOMING: 2, NONE: 3 };

/**
 * One stable order: what is overdue, then due today, then upcoming (soonest first), then everything
 * without a due date; replies owed before other undated rows; then by name, then by id.
 */
export function compareCrmPeopleRows(a: CrmPeopleRow, b: CrmPeopleRow): number {
  const ba = BUCKET_RANK[a.outreach.nextAction.bucket];
  const bb = BUCKET_RANK[b.outreach.nextAction.bucket];
  if (ba !== bb) return ba - bb;
  const da = a.outreach.nextAction.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const db = b.outreach.nextAction.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  const ra = a.outreach.state === 'REPLIED_NEEDS_RESPONSE' ? 0 : 1;
  const rb = b.outreach.state === 'REPLIED_NEEDS_RESPONSE' ? 0 : 1;
  if (ra !== rb) return ra - rb;
  const n = a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' });
  if (n !== 0) return n;
  return a.partyId < b.partyId ? -1 : a.partyId > b.partyId ? 1 : 0;
}

// --- Summary ---------------------------------------------------------------------------------

export interface CrmPeopleSummary {
  readonly totalPeople: number;
  readonly activeContacts: number;
  readonly awaitingReply: number;
  readonly dueToday: number;
  readonly overdue: number;
  readonly repliesNeedingResponse: number;
  readonly activeOrInterested: number;
  readonly meetingsUpcoming: number;
  readonly onHold: number;
  /** PASSED or CLOSED set by a person in the last 30 days. */
  readonly recentlyClosed: number;
  readonly touchedThisWeek: number;
  readonly newRepliesThisWeek: number;
  readonly reviewRequired: number;
  /** People established in the last 7 days. */
  readonly newPeopleThisWeek: number;
}

export function summarizeCrmPeople(rows: readonly CrmPeopleRow[], now: Date): CrmPeopleSummary {
  let s = {
    totalPeople: rows.length, activeContacts: 0, awaitingReply: 0, dueToday: 0, overdue: 0, repliesNeedingResponse: 0,
    activeOrInterested: 0, meetingsUpcoming: 0, onHold: 0, recentlyClosed: 0, touchedThisWeek: 0, newRepliesThisWeek: 0,
    reviewRequired: 0, newPeopleThisWeek: 0,
  };
  for (const r of rows) {
    const o = r.outreach;
    const g = group(o.state);
    s = {
      ...s,
      activeContacts: s.activeContacts + (g === 'active' ? 1 : 0),
      awaitingReply: s.awaitingReply + (o.state === 'AWAITING_REPLY' ? 1 : 0),
      dueToday: s.dueToday + (o.nextAction.bucket === 'TODAY' ? 1 : 0),
      overdue: s.overdue + (o.nextAction.bucket === 'OVERDUE' ? 1 : 0),
      repliesNeedingResponse: s.repliesNeedingResponse + (o.state === 'REPLIED_NEEDS_RESPONSE' ? 1 : 0),
      activeOrInterested: s.activeOrInterested + (['ACTIVE_CONVERSATION', 'INTERESTED', 'NEGOTIATING'].includes(o.state) ? 1 : 0),
      meetingsUpcoming: s.meetingsUpcoming + (r.nextMeetingAt && r.nextMeetingAt >= now ? 1 : 0),
      onHold: s.onHold + (g === 'hold' ? 1 : 0),
      recentlyClosed: s.recentlyClosed + (g === 'closed' && o.basis === 'HUMAN' && within(r.humanStateSetAt, now, 30) ? 1 : 0),
      touchedThisWeek: s.touchedThisWeek + (o.lastTouch?.source === 'GMAIL' && within(o.lastTouch.at, now, 7) ? 1 : 0),
      newRepliesThisWeek: s.newRepliesThisWeek + (within(r.lastHumanReplyAt, now, 7) ? 1 : 0),
      reviewRequired: s.reviewRequired + (o.state === 'REVIEW_REQUIRED' ? 1 : 0),
      newPeopleThisWeek: s.newPeopleThisWeek + (within(r.establishedAt, now, 7) ? 1 : 0),
    };
  }
  return s;
}

export interface CrmPeoplePage {
  readonly rows: readonly CrmPeopleRow[];
  readonly page: number;
  readonly pages: number;
  readonly filteredCount: number;
  readonly totalCount: number;
}

/** Filter, order and cut one page. A page past the end is the last page. */
export function pageCrmPeople(rows: readonly CrmPeopleRow[], filters: CrmPeopleFilters, page: number, now: Date, size = CRM_PEOPLE_PAGE_SIZE): CrmPeoplePage {
  const filtered = rows.filter((r) => crmPeopleRowMatches(r, filters, now)).sort(compareCrmPeopleRows);
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const at = Math.min(Math.max(1, page), pages);
  return { rows: filtered.slice((at - 1) * size, at * size), page: at, pages, filteredCount: filtered.length, totalCount: rows.length };
}

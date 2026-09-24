// "Your tools & spaces" on Loop Home: ONE pure projection of the domain readings the server made into
// tiles, each a doorway into an area of Loop this person can open.
//
// A TILE EXISTS ONLY WHERE TWO THINGS HOLD: its destination is in the navigation this person was
// offered (resolved from their permissions and role authority, workspaces/nav-access.ts -- fail
// closed), AND the domain's own read exists. The label and icon are the registry's own, so a tile
// can never call a destination something the rail does not.
//
// EVERY TILE IS THE DOMAIN'S OWN INTERPRETATION. Its signal and its lines come from that domain's
// own reading -- the Mail domain's `mailDomainIntelligence`, the Chats domain's `chatsIntelligence`,
// the calendar read, the work rows, the intake counts, the creator roster, the Overview's CallGrid
// brief -- and from nothing else: never the briefing, never a Headline, never a figure another tile
// owns. A domain that is not connected, not read yet, or could not be read says so in words; it is
// never an empty tile of zeros.
//
// A TILE LEADS WHERE ITS DOMAIN LIVES. Mail, Chats and Calendar open their own pages. Only a source
// that is NOT CONNECTED leads to Connections ("Connect in Connections"); otherwise Connections appears
// nowhere on a tile.
//
// PURE. No loader, no clock beyond the TimeView handed in, no I/O.

import { HEALTH_BAND_LABEL, counted, type CallGridBrief, type TimeView } from '@emgloop/shared';
import type { ChatsIntelligence } from '../../../daily-loop/chats-intelligence';
import type { BriefingSourceState, BriefingToday, WorkPosture } from './briefing';
import type { HomeKpiStrip } from './kpis';

/** A nav item as the registry describes it; the tile takes its label and icon from here. */
export interface TileNavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: string;
}

/** A settled read: the value, or that the read failed. Null at the call site means "not offered". */
export type TileRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** The Mail domain's own reading of the viewer's mailbox (`mailDomainIntelligence`, @emgloop/shared). */
export interface MailTileInput {
  readonly needsReply: number;
  readonly waiting: number;
  readonly followUps: number;
  readonly lines: readonly string[];
}

export interface RosterRowInput {
  readonly needsEmg: number;
  readonly needsCreator: number;
  readonly inProduction: number;
  readonly dueSoon: number;
}

export interface TilesInput {
  readonly groups: readonly { readonly items: readonly TileNavItem[] }[];
  /** The composed Today section: the viewer's own calendar and mail, as source states. */
  readonly today: BriefingToday;
  /** The Mail domain's reading; null unless the mailbox was read (the state is `today.mail`). */
  readonly mail: MailTileInput | null;
  /** The Chats domain's reading of the viewer's own conversations; null when Chats is not offered. */
  readonly chats: TileRead<ChatsIntelligence> | null;
  /** The viewer's work posture, from the Work OS rows the seat read; `ok: false` when that read failed. */
  readonly work: { readonly kind: 'ADMIN' | 'EMPLOYEE'; readonly posture: TileRead<WorkPosture> } | null;
  /** Intake records per status, from the CRM repository's own count. */
  readonly intake: TileRead<Readonly<Record<string, number>>> | null;
  /** The creator roster; `value: null` while the Creator Hub migration has not reached this database. */
  readonly creators: TileRead<readonly RosterRowInput[] | null> | null;
  readonly callgrid: TileRead<HomeKpiStrip> | null;
  /** The Overview's own brief over the same CallGrid context; null when that context was not read. */
  readonly callgridBrief: TileRead<CallGridBrief> | null;
  readonly time: TimeView;
}

export type TileState = 'OK' | 'EMPTY' | 'NOT_CONNECTED' | 'NOT_READ' | 'UNAVAILABLE' | 'NOT_AVAILABLE';

export interface HomeTile {
  readonly key: 'mail' | 'chats' | 'calendar' | 'work' | 'intake' | 'callgrid' | 'campaigns' | 'creators';
  readonly href: string;
  readonly label: string;
  readonly icon: string;
  /** One primary signal and what it is. Null when the domain has none to state. */
  readonly metric: { readonly value: string; readonly label: string } | null;
  /** One or two lines of the domain's own interpretation. */
  readonly lines: readonly string[];
  readonly state: TileState;
  /** The honest state, in words, when the tile is not OK. */
  readonly stateLine: string | null;
  /** What following the tile does, in words -- honest about where it leads. */
  readonly linkLabel: string;
  /** A small status line (freshness, connection), when the domain has one. */
  readonly status: string | null;
  /** A longer note for the title attribute (a contract's completeness rule). */
  readonly note: string | null;
}

/** The destinations tiles lead to. Every one is a LOOP_NAV href, or a page under one. */
export const TILE_PATHS = Object.freeze({
  mail: '/app/mail',
  chats: '/app/chats',
  calendar: '/app/calendar',
  connections: '/app/connections',
  adminWork: '/app/admin/work',
  employeeWork: '/app/employee/work',
  intake: '/crm/pipeline',
  marketplace: '/app/admin/marketplace',
  campaigns: '/app/admin/marketplace/campaigns',
  creators: '/app/admin/creator-hub',
});

const CONNECT_LABEL = 'Connect in Connections';

function offered(input: TilesInput, href: string): TileNavItem | null {
  for (const group of input.groups) for (const item of group.items) if (item.href === href) return item;
  return null;
}

/** A not-connected source leads to Connections when the rail offers it; otherwise to its own page, which says so. */
function connectWay(input: TilesInput, own: TileNavItem): { href: string; linkLabel: string } {
  return offered(input, TILE_PATHS.connections) ? { href: TILE_PATHS.connections, linkLabel: CONNECT_LABEL } : { href: own.href, linkLabel: `Open ${own.label}` };
}

const sentence = (s: string): string => {
  const t = s.trim();
  if (!t) return t;
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
};

/** How current a Google read is, in a few words, for a tile's status line. */
function readStatus(state: Extract<BriefingSourceState, { state: 'READ' }>, time: TimeView): string {
  const when = state.readAt ? time.relative(state.readAt) : null;
  if (state.current) return when ? `Read ${when}` : 'Up to date';
  if (state.failed) return when ? `Google could not be reached · last read ${when}` : 'Google could not be reached';
  return when ? `Last read ${when}` : 'Not current';
}

/** A Google source Loop could not state anything about: not connected, not read, or unreadable. */
function sourceTile(input: TilesInput, base: Omit<HomeTile, 'metric' | 'lines' | 'state' | 'stateLine'>, own: TileNavItem, state: Exclude<BriefingSourceState, { state: 'READ' } | { state: 'NOT_CONFIGURED' }>): HomeTile {
  if (state.state === 'NOT_CONNECTED') return { ...base, ...connectWay(input, own), metric: null, lines: [], state: 'NOT_CONNECTED', stateLine: 'Not connected' };
  if (state.state === 'NOT_READ') return { ...base, metric: null, lines: [], state: 'NOT_READ', stateLine: state.line };
  return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
}

// --- Mail ------------------------------------------------------------------------------------------

function mailTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'mail' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null, status: null };
  const mail = input.today.mail;
  // Loop is not set up for mail at all: nothing is said.
  if (mail.state === 'NOT_CONFIGURED') return null;
  if (mail.state !== 'READ') return sourceTile(input, base, item, mail);
  const intel = input.mail;
  if (!intel) return { ...base, metric: null, lines: [], state: 'NOT_READ', stateLine: 'Loop has not read your mail yet.' };
  const quiet = intel.needsReply === 0 && intel.lines.length === 0;
  return {
    ...base,
    metric: { value: intel.needsReply.toLocaleString('en-US'), label: intel.needsReply === 1 ? 'needs your reply' : 'need your reply' },
    // The Mail domain's own interpretation, verbatim: the same words the Mail page leads with.
    lines: intel.lines.slice(0, 2),
    state: quiet ? 'EMPTY' : 'OK',
    stateLine: quiet ? (mail.current ? 'Nothing in your mail needs you right now.' : 'Nothing in your mail needed you when Loop last read it.') : null,
    status: readStatus(mail, input.time),
  };
}

// --- Chats ---------------------------------------------------------------------------------------------

/**
 * The Chats tile is the Chats domain's own reading of the viewer's conversations -- its figure, its
 * summary and its status, verbatim. Nothing here reads a message, another person's conversations, or
 * the connector; a conversation that needs the viewer is Chats intelligence, never a Headline.
 */
function chatsTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'chats' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null, status: null };
  const read = input.chats;
  if (read === null) return null;
  if (!read.ok) return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const c = read.value;
  const lines = c.summary.slice(0, 2);
  switch (c.state) {
    case 'NOT_PERMITTED':
      return null;
    case 'NOT_AVAILABLE':
      return { ...base, metric: null, lines: [], state: 'NOT_AVAILABLE', stateLine: lines[0] ?? 'Not available on this deployment yet.', status: c.status };
    case 'NOT_CONNECTED':
      return { ...base, ...connectWay(input, item), metric: null, lines: [], state: 'NOT_CONNECTED', stateLine: 'Not connected', status: c.status };
    case 'UNAVAILABLE':
      return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: lines[0] ?? 'Could not be read', status: c.status };
    case 'QUIET':
      return { ...base, metric: c.metric, lines, state: 'EMPTY', stateLine: null, status: c.status };
    case 'ACTIVE':
    default:
      return { ...base, metric: c.metric, lines, state: 'OK', stateLine: null, status: c.status };
  }
}

// --- Calendar -----------------------------------------------------------------------------------------

function calendarTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'calendar' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null, status: null };
  const cal = input.today.calendar;
  if (cal.state === 'NOT_CONFIGURED') return null;
  if (cal.state !== 'READ') return sourceTile(input, base, item, cal);
  const { events, inProgress, next, minutesUntilNext, allDayCount } = input.today;
  const lines: string[] = [];
  if (inProgress) lines.push(`On now: “${inProgress.summary ?? 'Untitled event'}”`);
  else if (next?.startsAt) lines.push(`Next: “${next.summary ?? 'Untitled event'}” at ${input.time.time(next.startsAt)}${minutesUntilNext !== null && minutesUntilNext <= 120 ? ` (in ${minutesUntilNext} min)` : ''}`);
  else if (events.length > 0) lines.push('No meetings left today');
  if (allDayCount > 0) lines.push(counted(allDayCount, 'all-day event', 'all-day events'));
  const empty = events.length === 0 && allDayCount === 0;
  return {
    ...base,
    metric: { value: events.length.toLocaleString('en-US'), label: events.length === 1 ? 'meeting today' : 'meetings today' },
    lines,
    state: empty ? 'EMPTY' : 'OK',
    stateLine: empty ? 'No meetings on your calendar today.' : null,
    status: readStatus(cal, input.time),
  };
}

// --- My Work --------------------------------------------------------------------------------------------

/** "1 overdue · 2 due today", from the rows' own dates; "at least" when the rows were a capped slice. */
export function datedWorkWords(p: WorkPosture): string | null {
  const floor = p.datesPartial ? 'at least ' : '';
  const parts = [p.overdue > 0 ? `${floor}${p.overdue} overdue` : null, p.dueToday > 0 ? `${floor}${p.dueToday} due today` : null].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function workTile(input: TilesInput): HomeTile | null {
  const work = input.work;
  if (!work) return null;
  const item = offered(input, work.kind === 'ADMIN' ? TILE_PATHS.adminWork : TILE_PATHS.employeeWork);
  if (!item) return null;
  const base = { key: 'work' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null, status: null };
  if (!work.posture.ok) return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const p = work.posture.value;
  const standing = [p.readyNow > 0 ? `${p.readyNow} ready now` : null, p.blocked > 0 ? `${p.blocked} ${work.kind === 'ADMIN' ? 'waiting or blocked' : 'waiting on someone else'}` : null].filter((x): x is string => x !== null);
  const lines = [datedWorkWords(p), standing.length > 0 ? standing.join(' · ') : null].filter((x): x is string => x !== null);
  const empty = p.assigned === 0 && lines.length === 0;
  return {
    ...base,
    metric: { value: p.assigned.toLocaleString('en-US'), label: 'assigned to you' },
    lines,
    state: empty ? 'EMPTY' : 'OK',
    stateLine: empty ? 'No work is assigned to you.' : null,
  };
}

// --- Intake Board ------------------------------------------------------------------------------------

/** The later intake statuses the tile names, in board order; the rest are counted into the total only. */
const INTAKE_LATER: readonly string[] = Object.freeze(['Contacted', 'Quoted', 'Booked']);

function intakeTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'intake' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null, status: null };
  const read = input.intake;
  if (read === null) return null;
  if (!read.ok) return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const counts = read.value;
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total === 0) return { ...base, metric: null, lines: [], state: 'EMPTY', stateLine: 'No intake records yet.' };
  const fresh = counts.New;
  const later = INTAKE_LATER.flatMap((status) => {
    const n = counts[status];
    return n !== undefined && n > 0 ? [`${n.toLocaleString('en-US')} ${status.toLowerCase()}`] : [];
  });
  return {
    ...base,
    // The board's own statuses, interpreted: a record still "New" has not been contacted.
    metric: fresh !== undefined ? { value: fresh.toLocaleString('en-US'), label: fresh === 1 ? 'new record awaits first contact' : 'new records await first contact' } : null,
    lines: [later.length > 0 ? `Further along: ${later.join(' · ')}` : null, `${counted(total, 'record', 'records')} on the board`].filter((x): x is string => x !== null),
    state: 'OK',
    stateLine: null,
  };
}

// --- CallGrid Intelligence and Campaigns -------------------------------------------------------------

/**
 * "What is happening in the numbers" is the Overview's own brief: the health model's band, why, and
 * the first thing it says changed. The KPI row owns the figures, so the tile repeats none of them.
 */
function callgridTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'callgrid' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null, status: null };
  const read = input.callgrid;
  if (read === null) return null;
  if (!read.ok || read.value.state === 'UNAVAILABLE') return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const strip = read.value;
  if (strip.state === 'NO_DATA') return { ...base, metric: null, lines: [strip.freshness.detail], state: 'NOT_CONNECTED', stateLine: strip.freshness.word };
  const status = strip.freshness.word;
  const brief = input.callgridBrief;
  if (brief === null || !brief.ok) return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Loop could not read the analysis just now.', status };
  const b = brief.value;
  const lines = [b.reason ? sentence(b.reason) : null, b.sentences[0]?.text ?? null].filter((x): x is string => x !== null && x.length > 0).slice(0, 2);
  return {
    ...base,
    metric: { value: HEALTH_BAND_LABEL[b.band], label: 'business health' },
    lines,
    state: b.band === 'UNKNOWN' ? 'NOT_READ' : 'OK',
    stateLine: null,
    status,
    note: b.sentences[0]?.detail ?? null,
  };
}

function campaignsTile(input: TilesInput, parent: TileNavItem): HomeTile | null {
  const base = { key: 'campaigns' as const, href: TILE_PATHS.campaigns, label: 'Campaigns', icon: 'target', linkLabel: 'Open Campaigns', note: null, status: null };
  const read = input.callgrid;
  if (read === null) return null;
  if (!read.ok || read.value.state === 'UNAVAILABLE') return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const strip = read.value;
  const kpi = strip.kpis.find((k) => k.key === 'activeCampaigns') ?? null;
  if (strip.state === 'NO_DATA' || strip.activeCampaigns === null) return { ...base, metric: null, lines: [], state: 'NOT_CONNECTED', stateLine: strip.freshness.word, linkLabel: `Open ${parent.label}`, href: parent.href };
  const lead = strip.leadingCampaign;
  return {
    ...base,
    metric: { value: strip.activeCampaigns.toLocaleString('en-US'), label: `active ${strip.periodLabel.toLowerCase()}` },
    lines: [lead ? `${lead.label} is earning the most ${strip.periodLabel.toLowerCase()}` : null, kpi?.subline ?? 'Campaigns with a billable call or revenue in the period.'].filter((l): l is string => l !== null),
    state: strip.activeCampaigns === 0 ? 'EMPTY' : 'OK',
    stateLine: strip.activeCampaigns === 0 ? 'No campaign has a billable call or revenue yet in this period.' : null,
    note: kpi?.note ?? null,
    status: 'Observed in calls, not a roster',
  };
}

// --- Creator Hub -------------------------------------------------------------------------------------

function creatorsTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'creators' as const, href: item.href, label: 'Creator Hub', icon: item.icon, linkLabel: `Open ${item.label}`, note: null, status: null };
  const read = input.creators;
  if (read === null) return null;
  if (!read.ok) return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const rows = read.value;
  if (rows === null) return { ...base, metric: null, lines: [], state: 'NOT_AVAILABLE', stateLine: 'Not available on this deployment yet.' };
  if (rows.length === 0) return { ...base, metric: null, lines: [], state: 'EMPTY', stateLine: 'No creators yet.' };
  const needsEmg = rows.reduce((n, r) => n + r.needsEmg, 0);
  const inProduction = rows.reduce((n, r) => n + r.inProduction, 0);
  const dueSoon = rows.reduce((n, r) => n + r.dueSoon, 0);
  const work = [needsEmg > 0 ? `${needsEmg} need your team` : null, inProduction > 0 ? `${inProduction} in production` : null].filter((l): l is string => l !== null);
  return {
    ...base,
    metric: { value: rows.length.toLocaleString('en-US'), label: rows.length === 1 ? 'managed creator' : 'managed creators' },
    lines: [work.length > 0 ? work.join(' · ') : 'Nothing is waiting on your team.', dueSoon > 0 ? `${dueSoon} due soon` : null].filter((l): l is string => l !== null),
    state: 'OK',
    stateLine: null,
  };
}

// --- The grid ----------------------------------------------------------------------------------------

/** The tiles this person gets, in a fixed order. A destination not in their nav yields no tile. */
export function projectTiles(input: TilesInput): HomeTile[] {
  const out: (HomeTile | null)[] = [];
  const mail = offered(input, TILE_PATHS.mail);
  if (mail) out.push(mailTile(input, mail));
  const chats = offered(input, TILE_PATHS.chats);
  if (chats) out.push(chatsTile(input, chats));
  const calendar = offered(input, TILE_PATHS.calendar);
  if (calendar) out.push(calendarTile(input, calendar));
  out.push(workTile(input));
  const intake = offered(input, TILE_PATHS.intake);
  if (intake) out.push(intakeTile(input, intake));
  const marketplace = offered(input, TILE_PATHS.marketplace);
  if (marketplace) out.push(callgridTile(input, marketplace), campaignsTile(input, marketplace));
  const creators = offered(input, TILE_PATHS.creators);
  if (creators) out.push(creatorsTile(input, creators));
  return out.filter((t): t is HomeTile => t !== null);
}

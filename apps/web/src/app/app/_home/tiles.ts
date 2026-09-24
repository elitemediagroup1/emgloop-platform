// "Your tools & spaces" on Loop Home: ONE pure projection of the domain reads the server made into
// tiles, each a doorway into an area of Loop this person can open.
//
// A TILE EXISTS ONLY WHERE TWO THINGS HOLD: its destination is in the navigation this person was
// offered (resolved from their permissions and role authority, workspaces/nav-access.ts -- fail
// closed), AND the domain's own read exists. The label and icon are the registry's own, so a tile
// can never call a destination something the rail does not.
//
// EVERY TILE IS DOMAIN-LOCAL. Its metric and its lines come from that domain's own read model (the
// mail dashboard, the calendar read, the connection status, the work summary, the intake counts,
// the creator roster, the CallGrid command context) and from nothing else: never the briefing
// sentence, never a Headline, never a figure another tile owns. A domain that is not connected,
// not read yet, or could not be read says so in words; it is never an empty tile of zeros.
//
// PURE. No loader, no clock beyond the TimeView handed in, no I/O.

import { counted, type TimeView } from '@emgloop/shared';
import type { BriefingToday, QueueInstance } from './briefing';
import type { HomeKpiStrip } from './kpis';

/** A nav item as the registry describes it; the tile takes its label and icon from here. */
export interface TileNavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: string;
}

/** A settled read: the value, or that the read failed. Null at the call site means "not offered". */
export type TileRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** The viewer's own Telegram connection, already put into the Connections page's own words. */
export interface TelegramTileInput {
  /** False when the person may not view connections at all (the status read said so). */
  readonly permitted: boolean;
  readonly configured: boolean;
  readonly state: string;
  readonly words: { readonly label: string; readonly tone: 'good' | 'attention' | 'neutral' | 'critical'; readonly detail: string | null };
  readonly lastObservedAt: Date | null;
}

export interface WorkSummaryInput {
  readonly assignedToMe: number;
  readonly readyNow: number;
  readonly waitingBlocked: number;
  readonly completedToday: number;
}

export interface RosterRowInput {
  readonly needsEmg: number;
  readonly needsCreator: number;
  readonly inProduction: number;
  readonly dueSoon: number;
}

export interface TilesInput {
  readonly groups: readonly { readonly items: readonly TileNavItem[] }[];
  /** The composed Today section: the viewer's own calendar and mail, as source states and counts. */
  readonly today: BriefingToday;
  /** How many of the viewer's own "needs you" items there are (the same rows Needs you lists). */
  readonly needsYouCount: number;
  readonly telegram: TileRead<TelegramTileInput | null> | null;
  readonly work:
    | { readonly kind: 'ADMIN'; readonly summary: TileRead<WorkSummaryInput> }
    | { readonly kind: 'EMPLOYEE'; readonly queue: readonly QueueInstance[]; readonly userId: string }
    | null;
  /** Intake records per status, from the CRM repository's own count. */
  readonly intake: TileRead<Readonly<Record<string, number>>> | null;
  /** The creator roster; `value: null` while the Creator Hub migration has not reached this database. */
  readonly creators: TileRead<readonly RosterRowInput[] | null> | null;
  readonly callgrid: TileRead<HomeKpiStrip> | null;
  readonly time: TimeView;
}

export type TileState = 'OK' | 'EMPTY' | 'NOT_CONNECTED' | 'NOT_READ' | 'UNAVAILABLE' | 'NOT_AVAILABLE';

export interface HomeTile {
  readonly key: 'mail' | 'chats' | 'calendar' | 'work' | 'intake' | 'callgrid' | 'campaigns' | 'creators';
  readonly href: string;
  readonly label: string;
  readonly icon: string;
  /** One primary figure and what it counts. Null when the domain has none to state. */
  readonly metric: { readonly value: string; readonly label: string } | null;
  /** One or two lines from the domain's own read. */
  readonly lines: readonly string[];
  readonly state: TileState;
  /** The honest state, in words, when the tile is not OK. */
  readonly stateLine: string | null;
  /** What following the tile does, in words -- honest about where it leads. */
  readonly linkLabel: string;
  /** A longer note for the title attribute (a contract's completeness rule). */
  readonly note: string | null;
}

/** The destinations tiles lead to. Every one is a LOOP_NAV href, or a page under one. */
export const TILE_PATHS = Object.freeze({
  mail: '/app/mail',
  connections: '/app/connections',
  adminWork: '/app/admin/work',
  employeeWork: '/app/employee/work',
  intake: '/crm/pipeline',
  marketplace: '/app/admin/marketplace',
  campaigns: '/app/admin/marketplace/campaigns',
  creators: '/app/admin/creator-hub',
});

/** The intake statuses named on the tile, in board order; the rest are counted into the total only. */
const INTAKE_NAMED: readonly string[] = Object.freeze(['New', 'Contacted', 'Quoted', 'Booked']);

function offered(input: TilesInput, href: string): TileNavItem | null {
  for (const group of input.groups) for (const item of group.items) if (item.href === href) return item;
  return null;
}

// --- Mail ------------------------------------------------------------------------------------------

function mailTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'mail' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null };
  const mail = input.today.mail;
  // Loop is not set up for mail at all: nothing is said, as the Today panel says nothing.
  if (mail.state === 'NOT_CONFIGURED') return null;
  if (mail.state === 'NOT_CONNECTED') return { ...base, metric: null, lines: [], state: 'NOT_CONNECTED', stateLine: 'Not connected', linkLabel: 'Connect in Connections', href: TILE_PATHS.connections };
  if (mail.state === 'NOT_READ') return { ...base, metric: null, lines: [], state: 'NOT_READ', stateLine: mail.line };
  if (mail.state === 'UNAVAILABLE') return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const counts = input.today.mailCounts;
  if (!counts) return { ...base, metric: null, lines: [], state: 'NOT_READ', stateLine: 'Loop has not read your mail yet.' };
  const lines = [
    counts.followUps > 0 ? `${counted(counts.followUps, 'follow-up', 'follow-ups')} due` : null,
    counts.waiting > 0 ? `${counts.waiting} waiting on others` : null,
  ].filter((s): s is string => s !== null);
  if (!counts.current) lines.push(mail.readAt ? `As Loop last read it, ${input.time.relative(mail.readAt)}.` : 'As Loop last read it.');
  return {
    ...base,
    metric: { value: String(counts.needsReply), label: counts.needsReply === 1 ? 'needs a reply' : 'need a reply' },
    lines,
    state: counts.needsReply === 0 && lines.length === 0 ? 'EMPTY' : 'OK',
    stateLine: counts.needsReply === 0 && lines.length === 0 ? 'Nothing in your mail needs you right now.' : null,
  };
}

// --- Chats (Telegram) ---------------------------------------------------------------------------------

function chatsTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'chats' as const, href: item.href, label: 'Chats', icon: 'chat', linkLabel: `Manage in ${item.label}`, note: null };
  const read = input.telegram;
  if (read === null) return null;
  if (!read.ok) return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const t = read.value;
  if (t === null || !t.permitted) return null;
  if (!t.configured) return { ...base, metric: null, lines: [], state: 'NOT_AVAILABLE', stateLine: 'Telegram is not set up on this deployment yet.' };
  const live = t.state === 'READY' || t.state === 'CONNECTED_LIMITED' || t.state === 'SETTING_UP' || t.state === 'CONNECTING' || t.state === 'RECONNECT_REQUIRED';
  if (!live) return { ...base, metric: null, lines: [], state: 'NOT_CONNECTED', stateLine: t.words.label, linkLabel: `Connect in ${item.label}` };
  const lines = [`Telegram · ${t.words.label}`];
  if (t.words.detail) lines.push(t.words.detail);
  return {
    ...base,
    metric: { value: String(input.needsYouCount), label: input.needsYouCount === 1 ? 'chat needs you' : 'chats need you' },
    lines,
    state: 'OK',
    stateLine: null,
  };
}

// --- Calendar -----------------------------------------------------------------------------------------

function calendarTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'calendar' as const, href: item.href, label: 'Calendar', icon: 'calendar', linkLabel: `Manage in ${item.label}`, note: null };
  const cal = input.today.calendar;
  if (cal.state === 'NOT_CONFIGURED') return null;
  if (cal.state === 'NOT_CONNECTED') return { ...base, metric: null, lines: [], state: 'NOT_CONNECTED', stateLine: 'Not connected', linkLabel: `Connect in ${item.label}` };
  if (cal.state === 'NOT_READ') return { ...base, metric: null, lines: [], state: 'NOT_READ', stateLine: cal.line };
  if (cal.state === 'UNAVAILABLE') return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const { events, inProgress, next, minutesUntilNext, allDayCount } = input.today;
  const lines: string[] = [];
  if (inProgress) lines.push(`On now: “${inProgress.summary ?? 'Untitled event'}”`);
  else if (next?.startsAt) lines.push(`Next: “${next.summary ?? 'Untitled event'}” at ${input.time.time(next.startsAt)}${minutesUntilNext !== null && minutesUntilNext <= 120 ? ` (in ${minutesUntilNext} min)` : ''}`);
  else if (events.length > 0) lines.push('None left today');
  if (allDayCount > 0) lines.push(`${counted(allDayCount, 'all-day event', 'all-day events')}`);
  if (!cal.current) lines.push(cal.readAt ? `As Loop last read it, ${input.time.relative(cal.readAt)}.` : 'As Loop last read it.');
  return {
    ...base,
    metric: { value: String(events.length), label: events.length === 1 ? 'meeting today' : 'meetings today' },
    lines,
    state: events.length === 0 && allDayCount === 0 ? 'EMPTY' : 'OK',
    stateLine: events.length === 0 && allDayCount === 0 ? 'No meetings on your calendar today.' : null,
  };
}

// --- My Work --------------------------------------------------------------------------------------------

function workTile(input: TilesInput): HomeTile | null {
  const work = input.work;
  if (!work) return null;
  if (work.kind === 'ADMIN') {
    const item = offered(input, TILE_PATHS.adminWork);
    if (!item) return null;
    const base = { key: 'work' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null };
    if (!work.summary.ok) return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
    const s = work.summary.value;
    const lines = [
      s.readyNow > 0 ? `${s.readyNow} ready now` : null,
      s.waitingBlocked > 0 ? `${s.waitingBlocked} waiting or blocked` : null,
      s.completedToday > 0 ? `${s.completedToday} completed today` : null,
    ].filter((l): l is string => l !== null);
    const empty = s.assignedToMe === 0 && lines.length === 0;
    return {
      ...base,
      metric: { value: String(s.assignedToMe), label: 'assigned to you' },
      lines,
      state: empty ? 'EMPTY' : 'OK',
      stateLine: empty ? 'No work is assigned to you.' : null,
    };
  }
  const item = offered(input, TILE_PATHS.employeeWork);
  if (!item) return null;
  const base = { key: 'work' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null };
  // The same rule as "due today": a row is yours to act on only when its CURRENT stage is yours and ready.
  const mine = work.queue.filter((row) => {
    const current = row.stages.find((s) => s.id === row.currentStageId);
    return current !== undefined && current.ownerUserId === work.userId && (current.status === 'ready' || current.status === 'in_progress');
  });
  const waiting = work.queue.length - mine.length;
  const lines = [mine.length > 0 ? `${mine.length} ready for you` : null, waiting > 0 ? `${waiting} waiting on someone else` : null].filter((l): l is string => l !== null);
  return {
    ...base,
    metric: { value: String(work.queue.length), label: work.queue.length === 1 ? 'item in your queue' : 'items in your queue' },
    lines,
    state: work.queue.length === 0 ? 'EMPTY' : 'OK',
    stateLine: work.queue.length === 0 ? 'Nothing is in your queue.' : null,
  };
}

// --- Intake Board ------------------------------------------------------------------------------------

function intakeTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'intake' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null };
  const read = input.intake;
  if (read === null) return null;
  if (!read.ok) return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const counts = read.value;
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const named: string[] = [];
  for (const status of INTAKE_NAMED) {
    const n = counts[status];
    if (n !== undefined && n > 0) named.push(`${status} ${n.toLocaleString('en-US')}`);
  }
  return {
    ...base,
    metric: { value: total.toLocaleString('en-US'), label: total === 1 ? 'intake record' : 'intake records' },
    lines: named.length > 0 ? [named.join(' · ')] : [],
    state: total === 0 ? 'EMPTY' : 'OK',
    stateLine: total === 0 ? 'No intake records yet.' : null,
  };
}

// --- CallGrid Intelligence and Campaigns -------------------------------------------------------------

function callgridTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'callgrid' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null };
  const read = input.callgrid;
  if (read === null) return null;
  if (!read.ok || read.value.state === 'UNAVAILABLE') return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const strip = read.value;
  if (strip.state === 'NO_DATA') return { ...base, metric: null, lines: [strip.freshness.detail], state: 'NOT_CONNECTED', stateLine: strip.freshness.word };
  const billable = strip.billableCalls;
  return {
    ...base,
    metric: billable === null ? null : { value: billable.toLocaleString('en-US'), label: `billable ${billable === 1 ? 'call' : 'calls'} ${strip.periodLabel.toLowerCase()}` },
    lines: [`${strip.freshness.word} · ${strip.freshness.detail}`],
    state: billable === null ? 'NOT_READ' : 'OK',
    stateLine: billable === null ? 'Billable calls not stated for this period.' : null,
  };
}

function campaignsTile(input: TilesInput, parent: TileNavItem): HomeTile | null {
  const base = { key: 'campaigns' as const, href: TILE_PATHS.campaigns, label: 'Campaigns', icon: 'target', linkLabel: 'Open Campaigns', note: null };
  const read = input.callgrid;
  if (read === null) return null;
  if (!read.ok || read.value.state === 'UNAVAILABLE') return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const strip = read.value;
  const kpi = strip.kpis.find((k) => k.key === 'activeCampaigns') ?? null;
  if (strip.state === 'NO_DATA' || strip.activeCampaigns === null) return { ...base, metric: null, lines: [], state: 'NOT_CONNECTED', stateLine: strip.freshness.word, linkLabel: `Open ${parent.label}`, href: parent.href };
  return {
    ...base,
    metric: { value: strip.activeCampaigns.toLocaleString('en-US'), label: `active ${strip.periodLabel.toLowerCase()}` },
    lines: [kpi?.subline ?? 'Campaigns with a billable call or revenue in the period.', 'Observed in calls, not a roster.'],
    state: strip.activeCampaigns === 0 ? 'EMPTY' : 'OK',
    stateLine: strip.activeCampaigns === 0 ? 'No campaign has a billable call or revenue yet in this period.' : null,
    note: kpi?.note ?? null,
  };
}

// --- Creator Hub -------------------------------------------------------------------------------------

function creatorsTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'creators' as const, href: item.href, label: 'Creator Hub', icon: item.icon, linkLabel: `Open ${item.label}`, note: null };
  const read = input.creators;
  if (read === null) return null;
  if (!read.ok) return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const rows = read.value;
  if (rows === null) return { ...base, metric: null, lines: [], state: 'NOT_AVAILABLE', stateLine: 'Not available on this deployment yet.' };
  const needsEmg = rows.reduce((n, r) => n + r.needsEmg, 0);
  const inProduction = rows.reduce((n, r) => n + r.inProduction, 0);
  const dueSoon = rows.reduce((n, r) => n + r.dueSoon, 0);
  const lines = [needsEmg > 0 ? `${needsEmg} need your team` : null, inProduction > 0 ? `${inProduction} in production` : null, dueSoon > 0 ? `${dueSoon} due soon` : null].filter((l): l is string => l !== null);
  return {
    ...base,
    metric: { value: String(rows.length), label: rows.length === 1 ? 'managed creator' : 'managed creators' },
    lines,
    state: rows.length === 0 ? 'EMPTY' : 'OK',
    stateLine: rows.length === 0 ? 'No creators yet.' : null,
  };
}

// --- The grid ----------------------------------------------------------------------------------------

/** The tiles this person gets, in a fixed order. A destination not in their nav yields no tile. */
export function projectTiles(input: TilesInput): HomeTile[] {
  const out: (HomeTile | null)[] = [];
  const mail = offered(input, TILE_PATHS.mail);
  if (mail) out.push(mailTile(input, mail));
  const connections = offered(input, TILE_PATHS.connections);
  if (connections) out.push(chatsTile(input, connections), calendarTile(input, connections));
  out.push(workTile(input));
  const intake = offered(input, TILE_PATHS.intake);
  if (intake) out.push(intakeTile(input, intake));
  const marketplace = offered(input, TILE_PATHS.marketplace);
  if (marketplace) out.push(callgridTile(input, marketplace), campaignsTile(input, marketplace));
  const creators = offered(input, TILE_PATHS.creators);
  if (creators) out.push(creatorsTile(input, creators));
  return out.filter((t): t is HomeTile => t !== null);
}

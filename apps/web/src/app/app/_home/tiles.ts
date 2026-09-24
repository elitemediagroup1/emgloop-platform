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
  /** Whether this person authorized content triage: without it nothing is ever flagged, by design. */
  readonly contentAuthorized: boolean;
  /**
   * What Loop observed in this person's own conversations since `since`, as content-free counts from
   * the governed observation store. Null when that read failed (a failure is said, never a zero).
   */
  readonly activity: { readonly since: Date; readonly messages: number; readonly conversations: number } | null;
}

/**
 * One of the viewer's own "needs you" items, as the tile needs it: the triage category, the source's
 * own label for the conversation, and the minimized topic. The same rows Needs you lists -- loaded once
 * by the page with the session principal, never re-read or widened here.
 */
export interface NeedsYouTileItem {
  readonly provider: string;
  readonly category: string | null;
  readonly counterparty: string | null;
  readonly topic: string | null;
  readonly title: string;
  readonly deadline: string | null;
  readonly at: Date;
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
  /** The viewer's own "needs you" items (the same rows Needs you lists), for the Chats summary. */
  readonly needsYou: readonly NeedsYouTileItem[];
  /** What arrived in the viewer's own mail in the last day, from the mail read model; null when not read. */
  readonly mailInflow: { readonly needsReply: number; readonly followUps: number; readonly waiting: number } | null;
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
  /** Supporting status under the summary (e.g. "Connected · Triage on"), when the domain has one. */
  readonly status: string | null;
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
  const base = { key: 'mail' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null, status: null };
  const mail = input.today.mail;
  // Loop is not set up for mail at all: nothing is said, as the Today panel says nothing.
  if (mail.state === 'NOT_CONFIGURED') return null;
  if (mail.state === 'NOT_CONNECTED') return { ...base, metric: null, lines: [], state: 'NOT_CONNECTED', stateLine: 'Not connected', linkLabel: 'Connect in Connections', href: TILE_PATHS.connections };
  if (mail.state === 'NOT_READ') return { ...base, metric: null, lines: [], state: 'NOT_READ', stateLine: mail.line };
  if (mail.state === 'UNAVAILABLE') return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const counts = input.today.mailCounts;
  if (!counts) return { ...base, metric: null, lines: [], state: 'NOT_READ', stateLine: 'Loop has not read your mail yet.' };
  const inflow = input.mailInflow;
  const arrived = inflow
    ? [
        inflow.needsReply > 0 ? `${counted(inflow.needsReply, 'new message', 'new messages')} that need a reply` : null,
        inflow.followUps > 0 ? `${counted(inflow.followUps, 'follow-up', 'follow-ups')} came due` : null,
      ].filter((x): x is string => x !== null)
    : [];
  const lines = [
    arrived.length > 0 ? `Since yesterday: ${arrived.join(', ')}` : null,
    counts.followUps > 0 ? `${counted(counts.followUps, 'follow-up', 'follow-ups')} due` : null,
    counts.waiting > 0 ? `${counts.waiting} waiting on others` : null,
  ].filter((s): s is string => s !== null).slice(0, 2);
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

/** The triage category, in plain words, lower-cased for a tally. Presentation only; the vocabulary is the AI task's. */
const CATEGORY_TALLY: Readonly<Record<string, [string, string]>> = Object.freeze({
  REQUEST: ['request', 'requests'],
  DECISION_NEEDED: ['decision needed', 'decisions needed'],
  COMMITMENT: ['commitment', 'commitments'],
  DEADLINE: ['deadline', 'deadlines'],
  BUSINESS_CHANGE: ['change', 'changes'],
  PROBLEM: ['problem', 'problems'],
  FOLLOW_UP: ['follow-up', 'follow-ups'],
});
/** The order a tally names the kinds in: the most pressing first, matching Needs you's own weights. */
const TALLY_ORDER: readonly string[] = Object.freeze(['DECISION_NEEDED', 'DEADLINE', 'PROBLEM', 'REQUEST', 'COMMITMENT', 'BUSINESS_CHANGE', 'FOLLOW_UP']);

/** "2 requests, 1 decision needed and 1 change" -- the kinds the viewer's own items carry, and nothing else. */
function tallyKinds(items: readonly NeedsYouTileItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.category !== null && CATEGORY_TALLY[item.category] ? item.category : 'OTHER';
    const prev = counts.get(key);
    counts.set(key, prev === undefined ? 1 : prev + 1);
  }
  const parts: string[] = [];
  for (const key of TALLY_ORDER) {
    const n = counts.get(key);
    if (n) parts.push(counted(n, CATEGORY_TALLY[key]![0], CATEGORY_TALLY[key]![1]));
  }
  const other = counts.get('OTHER');
  if (other) parts.push(counted(other, 'other item that needs you', 'other items that need you'));
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The Chats tile answers "what is happening in my chats?", not "is the connector working?". Everything
 * it says is the signed-in person's own: the obligations the governed triage already raised for them
 * (Needs you's rows), and content-free activity counts from their own observation store. Nothing here
 * reads a message, reads another person's conversations, or invents a discussion. The connection state
 * is supporting status, drawn under the summary.
 */
function chatsTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'chats' as const, href: item.href, label: 'Chats', icon: 'chat', linkLabel: `Manage in ${item.label}`, note: null, status: null };
  const read = input.telegram;
  if (read === null) return null;
  if (!read.ok) return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const t = read.value;
  if (t === null || !t.permitted) return null;
  if (!t.configured) return { ...base, metric: null, lines: [], state: 'NOT_AVAILABLE', stateLine: 'Telegram is not set up on this deployment yet.' };
  const live = t.state === 'READY' || t.state === 'CONNECTED_LIMITED' || t.state === 'SETTING_UP' || t.state === 'CONNECTING' || t.state === 'RECONNECT_REQUIRED';
  if (!live) return { ...base, metric: null, lines: [], state: 'NOT_CONNECTED', stateLine: t.words.label, linkLabel: `Connect in ${item.label}` };

  const status = `Telegram · ${t.words.label} · Triage ${t.contentAuthorized ? 'on' : 'off'}`;
  const items = input.needsYou.filter((i) => i.provider === 'TELEGRAM');
  // A conversation is the source's own label for it; an item without one counts as its own.
  const conversations = new Set(items.map((i, n) => i.counterparty ?? `#${n}`)).size;
  const activity = t.activity;
  const activityLine =
    activity === null
      ? 'Activity could not be read.'
      : activity.messages === 0
        ? 'No new messages observed since yesterday.'
        : `${counted(activity.messages, 'message', 'messages')} observed across ${counted(activity.conversations, 'conversation', 'conversations')} since yesterday.`;

  if (items.length === 0) {
    // Quiet -- but the reason differs: with triage on, Loop looked and found nothing owed; with it off,
    // Loop reads no message and so can flag nothing, which is not the same as "nothing is happening".
    const quiet = t.contentAuthorized ? 'No conversations currently need your attention.' : 'Triage is off, so Loop observes activity but flags nothing.';
    const metric = activity !== null && activity.messages > 0 ? { value: activity.messages.toLocaleString('en-US'), label: 'messages since yesterday' } : null;
    return { ...base, metric, lines: [activityLine], state: 'EMPTY', stateLine: quiet, status };
  }

  // The lead: the latest change a conversation named (the viewer's own minimized topic), then the tally
  // of everything else they owe. Never a message, never a paraphrase of anyone else's chats.
  const change = [...items].filter((i) => i.category === 'BUSINESS_CHANGE' && (i.topic ?? i.title)).sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
  const rest = change ? items.filter((i) => i !== change) : items;
  const withDeadline = items.filter((i) => i.deadline !== null).length;
  const leadParts = [
    change ? `New discussion: ${change.topic ?? change.title}${change.counterparty ? ` (with ${change.counterparty})` : ''}` : null,
    rest.length > 0 ? `${tallyKinds(rest)} unresolved` : null,
    withDeadline > 0 ? `${withDeadline} with a deadline` : null,
  ].filter((x): x is string => x !== null);
  return {
    ...base,
    metric: { value: String(conversations), label: conversations === 1 ? 'conversation needs you' : 'conversations need you' },
    lines: [leadParts.join(' · '), activityLine],
    state: 'OK',
    stateLine: null,
    status,
  };
}

// --- Calendar -----------------------------------------------------------------------------------------

function calendarTile(input: TilesInput, item: TileNavItem): HomeTile | null {
  const base = { key: 'calendar' as const, href: item.href, label: 'Calendar', icon: 'calendar', linkLabel: `Manage in ${item.label}`, note: null, status: null };
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
    const base = { key: 'work' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null, status: null };
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
  const base = { key: 'work' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null, status: null };
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
  const base = { key: 'intake' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null, status: null };
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
  const base = { key: 'callgrid' as const, href: item.href, label: item.label, icon: item.icon, linkLabel: `Open ${item.label}`, note: null, status: null };
  const read = input.callgrid;
  if (read === null) return null;
  if (!read.ok || read.value.state === 'UNAVAILABLE') return { ...base, metric: null, lines: [], state: 'UNAVAILABLE', stateLine: 'Could not be read' };
  const strip = read.value;
  if (strip.state === 'NO_DATA') return { ...base, metric: null, lines: [strip.freshness.detail], state: 'NOT_CONNECTED', stateLine: strip.freshness.word };
  const billable = strip.billableCalls;
  // What moved, in the contract's own words, against the window's own comparison -- or why nothing is compared.
  const moved = strip.kpis.filter((k) => k.key !== 'activeCampaigns' && k.state === 'VALUE' && k.change !== null && k.change.direction !== 'flat');
  const compared = strip.kpis.find((k) => k.key !== 'activeCampaigns' && k.state === 'VALUE');
  const movement =
    moved.length > 0
      ? `${moved.map((k) => `${k.label} ${k.change!.direction === 'up' ? '▲' : '▼'} ${k.change!.text}`).join(' · ')} against ${strip.comparisonLabel ?? 'the comparison period'}`.replace(/^(.)/, (c) => c)
      : compared?.noChangeReason
        ? compared.noChangeReason
        : compared
          ? `No movement against ${strip.comparisonLabel ?? 'the comparison period'}.`
          : null;
  return {
    ...base,
    metric: billable === null ? null : { value: billable.toLocaleString('en-US'), label: `billable ${billable === 1 ? 'call' : 'calls'} ${strip.periodLabel.toLowerCase()}` },
    lines: [movement, `${strip.freshness.word} · ${strip.freshness.detail}`].filter((l): l is string => l !== null).slice(0, 2),
    state: billable === null ? 'NOT_READ' : 'OK',
    stateLine: billable === null ? 'Billable calls not stated for this period.' : null,
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
    lines: [
      lead ? `Most revenue ${strip.periodLabel.toLowerCase()}: ${lead.label}` : null,
      kpi?.subline ?? 'Campaigns with a billable call or revenue in the period.',
    ].filter((l): l is string => l !== null),
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

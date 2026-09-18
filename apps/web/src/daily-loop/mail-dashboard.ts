// The Mail dashboard, assembled for one signed-in employee. SERVER ONLY.
//
// WHOSE MAIL. The principal comes from the signed session and nowhere else; every read below is
// scoped by organization AND user, exactly as the Inbox (GM-2) and Your Mail (GM-3) are. There is
// no organization-level view of anybody's mail, and nothing here adds one.
//
// NOTHING NEW TALKS TO GOOGLE. The dashboard is a READ MODEL over what GM-1 already stored:
// `loadMail` (the same visit refresh, freshness and draft state as the Inbox), GM-3's correctable
// items (`loadMailAttention`, which also keeps them current), the employee's corrections, the
// stored correspondents, and each conversation's stored message facts. The pure rules
// (`classifyMailThread`) decide the lanes, the opportunity signals and the areas, and say why.
//
// IT CONCLUDES NOTHING FROM A MAILBOX IT COULD NOT READ. Categories are only computed from a read
// Loop made (current, stale, or -- after a failed sync -- the last good one, labelled as such). A
// mailbox Loop cannot read shows why, never an empty dashboard.

import 'server-only';

import {
  NO_CORRECTIONS,
  classifyMailThread,
  recentImportant,
  summarizeMail,
  type MailCorrections,
  type MailInsight,
  type MailMessageEvidence,
  type MailSummary,
} from '@emgloop/shared';
import { GoogleConnectionRepository, WorkGraphRepository, WorkItemRepository, prisma, type WorkPrincipal } from '@emgloop/database';

import { loadMail, type MailThreadSummary, type MailView } from './mail';
import { loadMailAttention } from './mail-attention';

export interface MailDashboardRow {
  readonly insight: MailInsight;
  /** The Inbox's own summary of the conversation: people, draft and delivery state. */
  readonly thread: MailThreadSummary;
}

export interface MailDashboard {
  readonly mail: MailView;
  /** Whether categories may be concluded at all: Loop has a read to conclude from. */
  readonly concludable: boolean;
  /** Whether that read is current enough to call an empty category empty. */
  readonly current: boolean;
  readonly now: Date;
  readonly rows: readonly MailDashboardRow[];
  readonly summary: MailSummary;
  readonly recent: readonly MailDashboardRow[];
}

/** The organization's own domains, as the stored Google connection records them. No Google call. */
async function internalDomainsFor(principal: WorkPrincipal): Promise<string[]> {
  try {
    const connections = new GoogleConnectionRepository(prisma);
    const [connection, configured] = await Promise.all([
      connections.find(principal.organizationId, principal.userId),
      connections.allowedHostedDomains(principal.organizationId),
    ]);
    const hosted = connection?.hostedDomain ? [connection.hostedDomain.toLowerCase()] : [];
    return [...new Set([...hosted, ...configured.map((d) => d.toLowerCase())])];
  } catch {
    // Without them, a colleague is judged like anybody else -- which only ever widens "opportunity"
    // to someone at the organization's own domain; it never invents one from notification mail.
    return [];
  }
}

/** What the employee told Loop, per conversation: GM-3 corrections, read from their own items. */
function correctionsByThread(
  items: Awaited<ReturnType<WorkItemRepository['items']>>,
  feedback: Awaited<ReturnType<WorkItemRepository['feedback']>>,
): Map<string, MailCorrections> {
  const out = new Map<string, { closed: MailCorrections['closed'][number][]; snoozedUntil: Date | null; waitingOnThemAt: Date | null }>();
  const entry = (threadId: string) => {
    let e = out.get(threadId);
    if (!e) {
      e = { closed: [], snoozedUntil: null, waitingOnThemAt: null };
      out.set(threadId, e);
    }
    return e;
  };
  for (const item of items) {
    if (item.subjectKind !== 'THREAD') continue;
    const cls = item.class;
    if (cls !== 'NEEDS_YOU' && cls !== 'WAITING_ON_THEM' && cls !== 'GONE_QUIET') continue;
    if (item.state === 'RESOLVED' || item.state === 'DISMISSED') {
      const at = item.resolvedAt ?? item.stateChangedAt;
      if (at) entry(item.subjectRef).closed.push({ class: cls, at });
    }
    if (item.state === 'SNOOZED' && item.snoozedUntil) {
      const e = entry(item.subjectRef);
      if (!e.snoozedUntil || item.snoozedUntil > e.snoozedUntil) e.snoozedUntil = item.snoozedUntil;
    }
  }
  for (const row of feedback) {
    if (row.kind !== 'NOT_WAITING' || row.subjectKind !== 'THREAD') continue;
    const e = entry(row.subjectRef);
    if (!e.waitingOnThemAt || row.createdAt > e.waitingOnThemAt) e.waitingOnThemAt = row.createdAt;
  }
  return out as Map<string, MailCorrections>;
}

/**
 * The dashboard for one person. Null when this principal has no mailbox at all (not permitted).
 *
 * `allowRefresh` is false where a server action already decided whether to spend a Google call.
 */
export async function loadMailDashboard(
  principal: WorkPrincipal,
  options: { readonly timeZone?: string; readonly allowRefresh?: boolean } = {},
): Promise<MailDashboard | null> {
  const mail = await loadMail(principal, { limit: 100, ...(options.allowRefresh === undefined ? {} : { allowRefresh: options.allowRefresh }) });
  if (!mail) return null;
  const now = mail.now;
  const concludable = mail.lastSyncedAt !== null && (mail.knows || mail.freshness === 'SYNC_FAILED');
  const empty: MailDashboard = {
    mail,
    concludable,
    current: mail.knows,
    now,
    rows: [],
    summary: summarizeMail([], now),
    recent: [],
  };
  if (!concludable) return empty;

  const graph = new WorkGraphRepository(prisma);
  const workItems = new WorkItemRepository(prisma);
  // GM-3's correctable items, brought up to date first, so every conversation its rules raise has an
  // item the employee can correct on the conversation itself -- and the corrections read below are
  // the current ones.
  await loadMailAttention(principal, { ...(options.timeZone ? { timeZone: options.timeZone } : {}) });
  const [evidence, correspondents, items, feedback, internalDomains] = await Promise.all([
    graph.threadEvidence(principal, mail.threads.map((t) => t.threadId)),
    graph.correspondents(principal, { limit: 500 }),
    workItems.items(principal, { limit: 200 }),
    workItems.feedback(principal),
    internalDomainsFor(principal),
  ]);

  const byHash = new Map(correspondents.map((c) => [c.addressHash, { address: c.displayAddress, name: c.displayName }]));
  const messagesByThread = new Map<string, MailMessageEvidence[]>();
  for (const m of evidence) {
    const sender = m.fromHash ? byHash.get(m.fromHash) : undefined;
    const list = messagesByThread.get(m.threadId) ?? [];
    list.push({
      at: m.internalDate,
      direction: m.direction === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND',
      fromAddress: sender?.address ?? null,
      fromName: sender?.name ?? null,
      labels: m.labels,
      inReplyTo: m.inReplyTo,
    });
    messagesByThread.set(m.threadId, list);
  }
  const corrections = correctionsByThread(items, feedback);

  const rows: MailDashboardRow[] = mail.threads.map((thread) => ({
    thread,
    insight: classifyMailThread(
      {
        threadId: thread.threadId,
        subject: thread.subject,
        lastMessageAt: thread.lastMessageAt,
        lastDirection: thread.lastDirection,
        unread: thread.unread,
        messages: messagesByThread.get(thread.threadId) ?? [],
        people: thread.people,
      },
      corrections.get(thread.threadId) ?? NO_CORRECTIONS,
      now,
      internalDomains,
    ),
  }));

  const byId = new Map(rows.map((r) => [r.insight.threadId, r]));
  return {
    mail,
    concludable,
    current: mail.knows,
    now,
    rows,
    summary: summarizeMail(rows.map((r) => r.insight), now),
    recent: recentImportant(rows.map((r) => r.insight), now).map((i) => byId.get(i.threadId)!),
  };
}

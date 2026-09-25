// The employee's mail, assembled for one signed-in person. SERVER ONLY.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6 (GM-2).
//
// WHOSE MAIL. The principal comes from the signed session and from nowhere else -- no query
// parameter, no route segment, no body, no header. Every read is scoped by organization AND user
// through the DL-1 repositories, so there is no shape of request that shows one person another
// person's mail, whatever role they hold.
//
// THE LIST IS STORED METADATA; THE CONVERSATION IS READ THROUGH. The inbox is built from
// `work_threads` / `work_messages` / `work_correspondents`, which hold headers and never bodies.
// Opening a thread reads that one conversation from Gmail, renders it, and keeps none of it.
//
// A VISIT MAY REFRESH, AT MOST EVERY FIVE MINUTES, and only when the connection is usable -- and
// it reads only what CHANGED since Loop's position in the mailbox, a few seconds' worth at most.
// The first 14-day read is never done here, while somebody waits: the scheduled cycle does it,
// and until then the mailbox says it is initializing. A refusal to refresh changes how current
// Loop says it is, never what it shows.

import 'server-only';

import {
  GMAIL_FRESHNESS_POLICY,
  WORK_FRESHNESS_ADMITS_EMPTY,
  shouldRefreshWorkSourceOnVisit,
  type GmailThreadView,
  type WorkSourceFreshness,
} from '@emgloop/shared';
import {
  WorkDraftRepository,
  WorkGraphRepository,
  prisma,
  readEmployeeGmailThread,
  type WorkPrincipal,
} from '@emgloop/database';

import { googleWorkspace, googleSigningKeys } from '../google/google-runtime';
import { readGoogleEnvironment } from '../google/google-environment';
import { refreshEmployeeGmail } from './mail-runtime';
import { loadSourceState } from './source-state';

export interface MailCorrespondent {
  readonly address: string;
  readonly name: string | null;
}

export interface MailThreadSummary {
  readonly threadId: string;
  readonly subject: string | null;
  readonly lastMessageAt: Date | null;
  readonly messageCount: number;
  readonly unread: boolean;
  /** Which way the newest message went, so "waiting on" is a fact rather than an impression. */
  readonly lastDirection: 'INBOUND' | 'OUTBOUND' | null;
  readonly people: readonly MailCorrespondent[];
  readonly hasDraft: boolean;
  /** A reply to this conversation whose delivery Loop has not been able to confirm. */
  readonly sendUnconfirmed: boolean;
}

export interface MailView {
  readonly now: Date;
  readonly freshness: WorkSourceFreshness;
  readonly lastSyncedAt: Date | null;
  readonly syncInProgress: boolean;
  /**
   * Whether Refresh can do anything. It reads only what changed since Loop's position in the
   * mailbox, so before the first read (which the scheduled cycle performs) it has nothing to do.
   */
  readonly canRefresh: boolean;
  readonly refreshed: boolean;
  readonly threads: readonly MailThreadSummary[];
  /** True in the states where an empty list means an empty inbox rather than "I could not look". */
  readonly knows: boolean;
}

/** The Gmail read configuration this server holds (also the Mail intelligence pass's read-through). */
export const GMAIL_CONFIG = () => {
  const env = readGoogleEnvironment();
  return { prisma, google: env.state === 'CONFIGURED' ? env : null, signingKeys: googleSigningKeys() };
};

/** How current Loop is about this person's mail, from the connection and their own sync state. */
export async function mailFreshness(principal: WorkPrincipal, now: Date) {
  const status = await googleWorkspace().status(principal);
  if (!status.permitted) return null;
  const state = await loadSourceState(principal, 'GMAIL', status, now);
  return {
    freshness: state.freshness,
    lastSyncCompletedAt: state.lastReadAt,
    // Bounded: a run the platform cut off never records its end, and must not read as "reading
    // now" forever (WORK_SYNC_IN_FLIGHT_MS).
    syncInProgress: state.inFlight,
    hasPosition: state.hasPosition,
  };
}

/**
 * The inbox, for the person the caller resolved from the session.
 *
 * `allowRefresh` is false when a server action has already decided whether to spend a Google
 * call, so one interaction can never turn into two.
 */
export async function loadMail(
  principal: WorkPrincipal,
  options: { readonly allowRefresh?: boolean; readonly limit?: number } = {},
): Promise<MailView | null> {
  const now = new Date();
  const before = await mailFreshness(principal, now);
  if (!before) return null;

  let refreshed = false;
  if ((options.allowRefresh ?? true) && shouldRefreshWorkSourceOnVisit(before.freshness, before.lastSyncCompletedAt, now, GMAIL_FRESHNESS_POLICY)) {
    refreshed = await refreshEmployeeGmail(principal);
  }
  const state = refreshed ? ((await mailFreshness(principal, new Date())) ?? before) : before;

  const graph = new WorkGraphRepository(prisma);
  const drafts = new WorkDraftRepository(prisma);
  const rows = await graph.threads(principal, { limit: Math.min(Math.max(options.limit ?? 40, 1), 100) });
  const mine = await drafts.drafts(principal, 200);
  const open = new Set(mine.filter((d) => d.sendState === 'DRAFT').map((d) => d.threadId));
  // In flight or in doubt: the inbox says so, because the conversation is where it gets settled.
  const unconfirmed = new Set(mine.filter((d) => d.sendState === 'SENDING' || d.sendState === 'SEND_UNKNOWN').map((d) => d.threadId));

  // Correspondents are read once and joined by hash: the list has to show who wrote, and the
  // messages themselves hold only hashes.
  const people = await graph.correspondents(principal, { limit: 500 });
  const byHash = new Map(people.map((p) => [p.addressHash, { address: p.displayAddress, name: p.displayName }]));

  const threads = rows.map((row): MailThreadSummary => ({
    threadId: row.threadId,
    subject: row.subject,
    lastMessageAt: row.lastMessageAt,
    messageCount: row.messageCount,
    unread: row.labels.includes('UNREAD'),
    lastDirection: (row.lastDirection as 'INBOUND' | 'OUTBOUND' | null) ?? null,
    people: row.participantHashes.map((hash) => byHash.get(hash)).filter((p): p is MailCorrespondent => p !== undefined),
    hasDraft: open.has(row.threadId),
    sendUnconfirmed: unconfirmed.has(row.threadId),
  }));

  return {
    now: new Date(),
    freshness: state.freshness,
    lastSyncedAt: state.lastSyncCompletedAt,
    syncInProgress: state.syncInProgress,
    canRefresh: state.hasPosition,
    refreshed,
    threads,
    knows: WORK_FRESHNESS_ADMITS_EMPTY.includes(state.freshness),
  };
}

/** One conversation, read from Gmail for the person who asked, and kept nowhere. */
export async function loadThread(principal: WorkPrincipal, threadId: string): Promise<
  | { readonly ok: true; readonly thread: GmailThreadView; readonly selfAddress: string | null }
  | { readonly ok: false; readonly failure: string }
> {
  const config = GMAIL_CONFIG();
  const result = await readEmployeeGmailThread(config, principal, threadId);
  if (!result.ok) return { ok: false, failure: result.failure };
  const { employeeGmailIdentity } = await import('@emgloop/database');
  const identity = await employeeGmailIdentity(config, principal);
  return { ok: true, thread: result.thread, selfAddress: identity.selfAddress };
}

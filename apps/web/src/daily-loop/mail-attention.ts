// What the employee's mail needs from them, assembled for one signed-in person. SERVER ONLY.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §12, §19 (GM-3).
//
// WHOSE ATTENTION. The principal comes from the signed session. Items, corrections and counts are
// all scoped by organization AND user; there is no org-level view of anybody's mail states, and
// adding one would be a product decision about surveillance, not a feature.
//
// IT REFRESHES FROM WHAT IS STORED, NOT FROM GOOGLE. The rules read `work_threads`, which the sync
// keeps current. A visit that refreshes mail therefore refreshes attention too, and a visit that
// does not still shows the last honest picture with its age.

import 'server-only';

import {
  mailPeriodSummary,
  startOfZonedDay,
  type MailPeriodSummary,
  type MailThreadFacts,
  type WorkClass,
} from '@emgloop/shared';
import {
  MailAttentionService,
  WorkGraphRepository,
  WorkItemRepository,
  prisma,
  type WorkItemRecord,
  type WorkPrincipal,
} from '@emgloop/database';

export interface MailAttentionItem {
  readonly id: string;
  readonly class: WorkClass;
  readonly threadId: string;
  readonly title: string | null;
  readonly lastMessageAt: Date | null;
  readonly unread: boolean;
  readonly rule: string;
  readonly snoozedUntil: Date | null;
}

export interface MailAttentionView {
  readonly needsYou: readonly MailAttentionItem[];
  readonly waitingOnThem: readonly MailAttentionItem[];
  readonly goneQuiet: readonly MailAttentionItem[];
  readonly summary: MailPeriodSummary;
  /** The window the summary counts, in the reader's own zone. */
  readonly since: Date;
}

const DAY_MS = 86_400_000;

/** The stored facts the rules read. Headers and counts; nothing from a body. */
export async function mailThreadFacts(principal: WorkPrincipal, limit = 200): Promise<MailThreadFacts[]> {
  const graph = new WorkGraphRepository(prisma);
  const rows = await graph.threads(principal, { limit });
  return rows.map((row) => ({
    threadId: row.threadId,
    subject: row.subject,
    lastMessageAt: row.lastMessageAt,
    firstMessageAt: row.firstMessageAt,
    lastDirection: (row.lastDirection as 'INBOUND' | 'OUTBOUND' | null) ?? null,
    messageCount: row.messageCount,
    unread: row.labels.includes('UNREAD'),
    // Treated as a two-sided conversation when it holds more than one message. That is coarser
    // than "both sides have spoken" -- two messages from the same side also pass -- and it is
    // stated as what it is: a count, which is a fact, standing in until direction per message is
    // summarised on the thread.
    hasExchange: row.messageCount > 1,
  }));
}

const itemOf = (record: WorkItemRecord): MailAttentionItem => {
  const evidence = (record.evidence ?? {}) as { lastMessageAt?: string; unread?: boolean; rule?: string };
  return {
    id: record.id,
    class: record.class,
    threadId: record.subjectRef,
    title: record.title,
    lastMessageAt: evidence.lastMessageAt ? new Date(evidence.lastMessageAt) : null,
    unread: evidence.unread === true,
    rule: evidence.rule ?? 'UNKNOWN',
    snoozedUntil: record.snoozedUntil,
  };
};

/**
 * Bring the employee's attention items up to date, then read them back.
 *
 * `refresh` is false where a caller has already done it this request, so one page render does not
 * recompute twice.
 */
export async function loadMailAttention(
  principal: WorkPrincipal,
  options: { readonly refresh?: boolean; readonly timeZone?: string } = {},
): Promise<MailAttentionView> {
  const service = new MailAttentionService({ items: new WorkItemRepository(prisma) });
  const facts = await mailThreadFacts(principal);
  if (options.refresh ?? true) await service.refresh(principal, facts);

  const open = await service.open(principal);
  const now = new Date();
  // "Since yesterday" in the reader's own day, never the server's (Loop Time Authority).
  const since = startOfZonedDay(new Date(now.getTime() - DAY_MS), options.timeZone ?? 'UTC');

  return {
    needsYou: open.filter((i) => i.class === 'NEEDS_YOU').map(itemOf),
    waitingOnThem: open.filter((i) => i.class === 'WAITING_ON_THEM').map(itemOf),
    goneQuiet: open.filter((i) => i.class === 'GONE_QUIET').map(itemOf),
    summary: mailPeriodSummary(facts, { from: since, to: now }, now),
    since,
  };
}

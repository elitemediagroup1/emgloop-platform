// What a mailbox is waiting on, decided from stored facts only. PURE -- no I/O, no clock, no model.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §12, §19 (GM-3).
//
// EVERY CONCLUSION HERE IS ARITHMETIC OVER HEADERS. Which way the newest message went, how long
// ago, how many messages, whether the newest is unread, and whether both sides have ever spoken.
// That is all Stage 1 evidence can support, and it is enough for the four states an employee
// actually navigates by.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not read a body, does not guess urgency, does not
// score importance and does not decide what a conversation is ABOUT. "Ben is asking about pricing"
// is a Stage 2 claim that needs content and citations; "the newest message is theirs, it is two
// days old, and you have not answered" is a fact. Loop says the second and waits for the first.
//
// SIGNIFICANCE AND RELEVANCE STAY APART. This file answers "what state is this conversation in",
// never "how much should you care" -- there is no score, no ranking weight and no threshold that
// mixes the two. Ordering is by time, which is a fact, and the employee's own corrections filter
// what they are shown.

import type { WorkClass } from './work-state';

/** The stored facts one thread contributes. Nothing here is read from a body. */
export interface MailThreadFacts {
  readonly threadId: string;
  readonly subject: string | null;
  readonly lastMessageAt: Date | null;
  readonly firstMessageAt: Date | null;
  readonly lastDirection: 'INBOUND' | 'OUTBOUND' | null;
  readonly messageCount: number;
  readonly unread: boolean;
  /** True when both sides have sent at least one message: a conversation, not a broadcast. */
  readonly hasExchange: boolean;
}

/**
 * The thresholds, stated once.
 *
 * They are OPERATING POLICY, not constants of nature: an employee's own rhythm is a Stage 2
 * refinement (`work_threads.medianReplyMinutes`, which nothing computes yet), and until then one
 * honest number beats a per-person guess.
 */
export const MAIL_ATTENTION_POLICY = Object.freeze({
  /** An unanswered inbound message is "needs you" once it is this old, or as soon as it is unread. */
  needsYouAfterMs: 4 * 60 * 60 * 1000,
  /** A message you sent with no reply is "waiting on them" after this. */
  waitingAfterMs: 2 * 24 * 60 * 60 * 1000,
  /** A conversation both sides were having, silent for this long, has gone quiet. */
  quietAfterMs: 14 * 24 * 60 * 60 * 1000,
  /** Nothing older than this is raised at all: Loop is a work surface, not an archive. */
  horizonMs: 45 * 24 * 60 * 60 * 1000,
});

export interface MailAttention {
  readonly threadId: string;
  readonly class: WorkClass;
  /** The subject line, for a title a person recognises. It is content, and it is theirs. */
  readonly title: string | null;
  /** The facts that raised it -- references and durations, never words. */
  readonly evidence: {
    readonly lastMessageAt: string;
    readonly lastDirection: 'INBOUND' | 'OUTBOUND';
    readonly ageMs: number;
    readonly messageCount: number;
    readonly unread: boolean;
    readonly rule: string;
  };
  /** Stable across passes, so re-detecting widens one item rather than making another. */
  readonly recurrenceKey: string;
}

/** The version of these rules. It travels with every item, so a change is explainable later. */
export const MAIL_ATTENTION_PRODUCER = 'mail-attention';
export const MAIL_ATTENTION_VERSION = '1.0.0';

/**
 * What state one conversation is in, or null when it is in none worth raising.
 *
 * ORDER MATTERS AND IS DELIBERATE: a thread you owe a reply on is that, even if it is also old.
 */
export function mailAttentionFor(thread: MailThreadFacts, now: Date, policy = MAIL_ATTENTION_POLICY): MailAttention | null {
  const at = thread.lastMessageAt;
  if (!at || !thread.lastDirection) return null;
  const ageMs = now.getTime() - at.getTime();
  if (ageMs < 0 || ageMs > policy.horizonMs) return null;

  const base = {
    threadId: thread.threadId,
    title: thread.subject,
    evidence: {
      lastMessageAt: at.toISOString(),
      lastDirection: thread.lastDirection,
      ageMs,
      messageCount: thread.messageCount,
      unread: thread.unread,
    },
  };

  if (thread.lastDirection === 'INBOUND') {
    // They wrote last and you have not answered. Unread makes it immediate; otherwise it becomes
    // "needs you" once it has sat for the policy's window.
    if (thread.unread || ageMs >= policy.needsYouAfterMs) {
      return {
        ...base,
        class: 'NEEDS_YOU',
        evidence: { ...base.evidence, rule: thread.unread ? 'INBOUND_UNREAD' : 'INBOUND_UNANSWERED' },
        recurrenceKey: mailRecurrenceKey(thread.threadId, 'NEEDS_YOU'),
      };
    }
    return null;
  }

  // You wrote last. Quiet first, because a conversation that stopped months ago is not something
  // you are "waiting on" this week -- it is one that ended without anybody saying so.
  if (thread.hasExchange && ageMs >= policy.quietAfterMs) {
    return {
      ...base,
      class: 'GONE_QUIET',
      evidence: { ...base.evidence, rule: 'EXCHANGE_SILENT' },
      recurrenceKey: mailRecurrenceKey(thread.threadId, 'GONE_QUIET'),
    };
  }
  if (ageMs >= policy.waitingAfterMs) {
    return {
      ...base,
      class: 'WAITING_ON_THEM',
      evidence: { ...base.evidence, rule: 'OUTBOUND_UNANSWERED' },
      recurrenceKey: mailRecurrenceKey(thread.threadId, 'WAITING_ON_THEM'),
    };
  }
  return null;
}

/** Stable per thread and class, so a state change closes one item and opens another honestly. */
export function mailRecurrenceKey(threadId: string, workClass: WorkClass): string {
  return `gmail:thread:${threadId}:${workClass}`;
}

/** Every conversation's state, newest first. Threads in no state at all are simply absent. */
export function mailAttention(threads: readonly MailThreadFacts[], now: Date, policy = MAIL_ATTENTION_POLICY): MailAttention[] {
  return threads
    .map((thread) => mailAttentionFor(thread, now, policy))
    .filter((a): a is MailAttention => a !== null)
    .sort((a, b) => new Date(b.evidence.lastMessageAt).getTime() - new Date(a.evidence.lastMessageAt).getTime());
}

// --- What changed, for the daily summary ------------------------------------------------------

export interface MailPeriodSummary {
  /** Conversations that moved in the window, however they moved. */
  readonly moved: number;
  /** Inbound messages that arrived on conversations you were part of. */
  readonly replies: number;
  readonly needsYou: number;
  readonly waitingOnThem: number;
  readonly goneQuiet: number;
  /** Conversations you answered in the window. */
  readonly answered: number;
}

/**
 * What happened in one window, counted from stored facts.
 *
 * COUNTS, NOT NARRATIVE. "Three conversations moved and two need you" is arithmetic over rows.
 * "Ben is unhappy about pricing" is a claim about content, and Stage 1 does not make it.
 */
export function mailPeriodSummary(
  threads: readonly MailThreadFacts[],
  window: { readonly from: Date; readonly to: Date },
  now: Date,
  policy = MAIL_ATTENTION_POLICY,
): MailPeriodSummary {
  const inWindow = threads.filter((t) => t.lastMessageAt !== null && t.lastMessageAt >= window.from && t.lastMessageAt < window.to);
  const states = mailAttention(threads, now, policy);
  const countOf = (workClass: WorkClass) => states.filter((s) => s.class === workClass).length;
  return {
    moved: inWindow.length,
    replies: inWindow.filter((t) => t.lastDirection === 'INBOUND').length,
    answered: inWindow.filter((t) => t.lastDirection === 'OUTBOUND').length,
    needsYou: countOf('NEEDS_YOU'),
    waitingOnThem: countOf('WAITING_ON_THEM'),
    goneQuiet: countOf('GONE_QUIET'),
  };
}

// Turning a mailbox's state into an employee's work items, and respecting what they told Loop.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §12 (GM-3).
//
// THE RULES ARE PURE AND LIVE ELSEWHERE (@emgloop/shared `mailAttention`). This service persists
// what they concluded, which is a different job with different dangers -- and the dangerous one is
// this: A DETECTION MUST NEVER OVERRULE A PERSON.
//
// An employee who says "handled" has said something Loop does not know how to derive. So a closed
// item is only reopened by NEW EVIDENCE -- a message that arrived after they closed it -- and
// never by the same facts being seen again on the next pass. A snoozed item stays asleep until its
// time. This is why `detect` widens rather than reopens, and why this service checks the closed
// item's own state before raising anything.
//
// AND IT NEVER REWRITES THE EVIDENCE TO AGREE WITH ITSELF. A correction is recorded beside the
// facts (an observation, and where the employee gave a reason, a `work_feedback` row). The stored
// headers are untouched: Loop was wrong about what the facts MEANT, and the facts stay as they are.

import {
  MAIL_ATTENTION_PRODUCER,
  MAIL_ATTENTION_VERSION,
  mailAttention,
  type MailAttention,
  type MailThreadFacts,
  type WorkClass,
} from '@emgloop/shared';

import type { WorkItemRepository, WorkItemRecord } from '../../repositories/work-state/work-item.repository';
import type { WorkGraphRepository } from '../../repositories/work-state/work-graph.repository';
import type { WorkPrincipal } from '../../repositories/work-state/work-principal';

/**
 * The stored facts the attention rules read, for one person. Headers and counts; nothing from a body.
 *
 * ONE ASSEMBLY, FOR EVERY CALLER. A page visit and the scheduled cycle's post-read detection pass
 * must hand the rules the same facts, or the queue a person sees would depend on which of them ran
 * last. It lives here, beside the rules' persistence, rather than in the web tier.
 */
export async function mailThreadFacts(graph: WorkGraphRepository, principal: WorkPrincipal, limit = 200): Promise<MailThreadFacts[]> {
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

export interface MailAttentionDeps {
  readonly items: WorkItemRepository;
  readonly now?: () => Date;
}

export interface MailAttentionOutcome {
  readonly raised: number;
  readonly widened: number;
  readonly skippedClosed: number;
  readonly reopened: number;
}

export class MailAttentionService {
  constructor(private readonly deps: MailAttentionDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /**
   * Bring this employee's attention items up to date with what their mailbox now says.
   *
   * Their own, always: every read and write takes the principal, and the items produced are
   * theirs. Nothing about this pass is visible to anybody else, whatever role they hold.
   */
  async refresh(principal: WorkPrincipal, threads: readonly MailThreadFacts[]): Promise<MailAttentionOutcome> {
    const now = this.now();
    const states = mailAttention(threads, now);
    const existing = await this.deps.items.items(principal, { limit: 200 });
    const byKey = new Map(existing.map((item) => [item.recurrenceKey, item]));

    let raised = 0;
    let widened = 0;
    let skippedClosed = 0;
    let reopened = 0;

    for (const state of states) {
      const known = byKey.get(state.recurrenceKey);
      if (known && (known.state === 'RESOLVED' || known.state === 'DISMISSED')) {
        // They closed it. Only a message that arrived AFTER they did reopens it -- the same
        // conversation being seen again is not news, and telling them twice is how a queue
        // becomes noise they stop reading.
        const closedAt = known.resolvedAt ?? known.stateChangedAt;
        const movedSince = closedAt !== null && new Date(state.evidence.lastMessageAt) > closedAt;
        if (!movedSince) {
          skippedClosed += 1;
          continue;
        }
        await this.deps.items.record(principal, known.id, {
          state: 'OPEN',
          observationType: 'REOPENED',
          occurredAt: now,
          actorType: 'SYSTEM',
          reason: 'the conversation moved again',
        });
        reopened += 1;
      }

      const written = await this.deps.items.detect(principal, {
        recurrenceKey: state.recurrenceKey,
        class: state.class,
        subjectKind: 'THREAD',
        subjectRef: state.threadId,
        title: state.title,
        producerKind: 'RULE',
        producerId: MAIL_ATTENTION_PRODUCER,
        producerVersion: MAIL_ATTENTION_VERSION,
        evidence: state.evidence as unknown as Record<string, unknown>,
        detectedAt: now,
      });
      // A RULE detection on a mail thread is never refused: detect re-checks a content authorization
      // only for a MODEL item on a derived subject. The null is still honoured rather than assumed
      // away -- a refusal is not a raise.
      if (written === null) continue;
      if (known) widened += 1;
      else raised += 1;
    }

    return { raised, widened, skippedClosed, reopened };
  }

  /** The open items a surface may show, newest evidence first, with snoozed ones still asleep. */
  async open(principal: WorkPrincipal, workClass?: WorkClass): Promise<WorkItemRecord[]> {
    const now = this.now();
    const items = await this.deps.items.items(principal, { limit: 200 });
    return items
      .filter((item) => {
        if (item.state === 'RESOLVED' || item.state === 'DISMISSED') return false;
        if (item.state === 'SNOOZED') return item.snoozedUntil !== null && item.snoozedUntil <= now;
        return true;
      })
      .filter((item) => (workClass ? item.class === workClass : true))
      .sort((a, b) => b.lastDetectedAt.getTime() - a.lastDetectedAt.getTime());
  }
}

// The reply an employee is writing, and the state of sending it (GM-2).
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6.11, §6.11a.
//
// ONE OPEN DRAFT PER THREAD PER PERSON, enforced by a unique index rather than by a caller.
//
// EVERY METHOD TAKES A PRINCIPAL. No method reads or writes a draft by id alone -- the id is
// always scoped by (organization, user), so another employee's draft is not-found rather than
// forbidden, and no role makes it found.
//
// EVERY SEND TRANSITION IS A CONDITIONAL UPDATE, and the state machine lives in the WHERE clause:
//
//   DRAFT        -> SENDING        claim, storing the attempt's identity in the same write
//   SENDING      -> SENT           Gmail proved it (conditional on THIS attempt)
//   SENDING      -> DRAFT          Gmail proved it did not happen (a DEFINITIVE failure)
//   SENDING      -> SEND_UNKNOWN   the answer was lost, or the process that claimed it is gone
//   SEND_UNKNOWN -> SENT           reconciliation found it in Sent mail
//   SEND_UNKNOWN -> DRAFT          reconciliation proved it absent, or the employee released it
//
// THERE IS NO TIME-BASED RELEASE. The previous design let a claim expire back into sendable after
// two minutes, and released it on any failure; both made a message Gmail had already accepted
// sendable again. Nothing here moves an attempt to DRAFT without either proof or a person.
//
// WHILE AN ATTEMPT IS IN FLIGHT OR IN DOUBT, THE DRAFT IS FROZEN. Its words are the evidence of
// what may already be in somebody's inbox, so `save` and `discard` refuse it rather than letting
// an edit turn one uncertain message into two different ones.

import type { PrismaClient } from '@prisma/client';
import type { WorkDraftSource, WorkProvider, WorkReplyMode, WorkSendFailureClass, WorkSendResolution } from '@emgloop/shared';

import { workScope, type WorkPrincipal } from './work-principal';

export interface DraftContent {
  readonly provider: WorkProvider;
  readonly threadId: string;
  readonly inReplyToMessageId: string;
  readonly mode: WorkReplyMode;
  readonly toAddresses: readonly string[];
  readonly ccAddresses: readonly string[];
  readonly subject: string | null;
  readonly body: string;
  readonly source: WorkDraftSource;
  readonly aiInvocationId?: string | null;
  readonly aiTaskVersion?: string | null;
  readonly aiUnedited?: boolean;
}

/** What is stored about an attempt BEFORE Gmail is called. */
export interface SendAttempt {
  readonly attemptId: string;
  readonly startedAt: Date;
  /** SHA-256 of the exact words being sent, normalized (`gmailSendFingerprintText`). */
  readonly bodyHash: string;
}

/** The fields that clear an attempt, used by every transition back to DRAFT. */
const NO_ATTEMPT = { sendAttemptId: null, sendAttemptStartedAt: null, sendAttemptBodyHash: null } as const;

export class WorkDraftRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** This person's draft on this conversation, or null. Never anybody else's. */
  async draft(principal: WorkPrincipal, provider: WorkProvider, threadId: string) {
    return this.prisma.workDraft.findFirst({ where: { ...workScope(principal), provider, threadId } });
  }

  async draftById(principal: WorkPrincipal, id: string) {
    return this.prisma.workDraft.findFirst({ where: { ...workScope(principal), id } });
  }

  /**
   * Write what the employee has composed so far.
   *
   * Returns null -- and writes nothing -- while an attempt is SENDING or SEND_UNKNOWN: those words
   * may already be in somebody's inbox, and they stay exactly as they were until the doubt is
   * settled. A draft that was SENT starts a new reply cleanly.
   */
  async save(principal: WorkPrincipal, content: DraftContent): Promise<string | null> {
    const scope = workScope(principal);
    const where = { ...scope, provider: content.provider, threadId: content.threadId };
    const fields = {
      inReplyToMessageId: content.inReplyToMessageId,
      mode: content.mode,
      toAddresses: [...content.toAddresses],
      ccAddresses: [...content.ccAddresses],
      subject: content.subject ?? null,
      body: content.body,
      source: content.source,
      aiInvocationId: content.aiInvocationId ?? null,
      aiTaskVersion: content.aiTaskVersion ?? null,
      aiUnedited: content.aiUnedited ?? false,
    };
    const existing = await this.prisma.workDraft.findFirst({ where });
    if (!existing) {
      const created = await this.prisma.workDraft.create({ data: { ...where, ...fields, sendState: 'DRAFT' } });
      return created.id;
    }
    if (existing.sendState === 'SENT') {
      // The previous reply on this thread was sent; this is a new one, and it starts clean.
      const replaced = await this.prisma.workDraft.updateMany({
        where: { ...scope, id: existing.id, sendState: 'SENT' },
        data: {
          ...fields,
          ...NO_ATTEMPT,
          sendState: 'DRAFT',
          sentAt: null,
          sentMessageId: null,
          sendFailureClass: null,
          sendReconciledAt: null,
          sendResolution: null,
        },
      });
      return replaced.count === 1 ? existing.id : null;
    }
    // Only an ordinary draft may be edited. The condition is in the write itself, so an attempt
    // claimed between the read above and this line is not overwritten.
    const updated = await this.prisma.workDraft.updateMany({
      where: { ...scope, id: existing.id, sendState: 'DRAFT' },
      data: { ...fields, sendFailureClass: null },
    });
    return updated.count === 1 ? existing.id : null;
  }

  /** Throw the draft away -- only an ordinary one. An attempt in doubt is settled, not discarded. */
  async discard(principal: WorkPrincipal, provider: WorkProvider, threadId: string): Promise<boolean> {
    const done = await this.prisma.workDraft.deleteMany({ where: { ...workScope(principal), provider, threadId, sendState: 'DRAFT' } });
    return done.count === 1;
  }

  /**
   * DRAFT -> SENDING, storing the attempt's identity in the SAME conditional write.
   *
   * It succeeds once. A second click, a retried request or a second tab gets null, and so does any
   * row that is not an ordinary draft -- including one whose earlier attempt is still in doubt.
   * Because the identity is written before Gmail is called, a process that dies after Gmail
   * accepts the message still leaves behind exactly what reconciliation needs.
   */
  async claimForSend(principal: WorkPrincipal, id: string, attempt: SendAttempt) {
    const claimed = await this.prisma.workDraft.updateMany({
      where: { ...workScope(principal), id, sendState: 'DRAFT' },
      data: {
        sendState: 'SENDING',
        sendAttemptId: attempt.attemptId,
        sendAttemptStartedAt: attempt.startedAt,
        sendAttemptBodyHash: attempt.bodyHash,
        sendFailureClass: null,
        sendResolution: null,
        sendReconciledAt: null,
      },
    });
    if (claimed.count !== 1) return null;
    return this.draftById(principal, id);
  }

  /**
   * SENDING | SEND_UNKNOWN -> SENT. The proof is Gmail's own id, and the body is no longer Loop's
   * to hold. Conditional on the attempt, so a stale answer cannot settle a newer attempt.
   */
  async recordSent(
    principal: WorkPrincipal,
    id: string,
    attemptId: string,
    sent: { readonly sentAt: Date; readonly sentMessageId: string; readonly resolution?: WorkSendResolution | null },
  ): Promise<boolean> {
    const done = await this.prisma.workDraft.updateMany({
      where: { ...workScope(principal), id, sendAttemptId: attemptId, sendState: { in: ['SENDING', 'SEND_UNKNOWN'] } },
      data: {
        sendState: 'SENT',
        sentAt: sent.sentAt,
        sentMessageId: sent.sentMessageId,
        body: '',
        sendFailureClass: null,
        sendResolution: sent.resolution ?? null,
      },
    });
    return done.count === 1;
  }

  /**
   * A DRAFT that could not even be attempted -- no mailbox identity, or a message Loop refused to
   * build. Nothing was claimed and nothing left; the reason is recorded beside the words.
   */
  async noteNotAttempted(principal: WorkPrincipal, id: string, failureClass: WorkSendFailureClass): Promise<boolean> {
    const done = await this.prisma.workDraft.updateMany({
      where: { ...workScope(principal), id, sendState: 'DRAFT' },
      data: { sendFailureClass: failureClass },
    });
    return done.count === 1;
  }

  /**
   * SENDING -> DRAFT before Gmail was ever called: the claim won a race with an edit, so the words
   * in the row are not the words the attempt was fingerprinted from. Nothing left, nothing failed.
   */
  async abandonClaim(principal: WorkPrincipal, id: string, attemptId: string): Promise<boolean> {
    const done = await this.prisma.workDraft.updateMany({
      where: { ...workScope(principal), id, sendAttemptId: attemptId, sendState: 'SENDING' },
      data: { ...NO_ATTEMPT, sendState: 'DRAFT' },
    });
    return done.count === 1;
  }

  /** SENDING -> DRAFT, for a DEFINITIVE failure only: it is known that nothing left. */
  async recordNotSent(principal: WorkPrincipal, id: string, attemptId: string, failureClass: WorkSendFailureClass): Promise<boolean> {
    const done = await this.prisma.workDraft.updateMany({
      where: { ...workScope(principal), id, sendAttemptId: attemptId, sendState: 'SENDING' },
      data: { ...NO_ATTEMPT, sendState: 'DRAFT', sendFailureClass: failureClass },
    });
    return done.count === 1;
  }

  /** SENDING -> SEND_UNKNOWN: the answer was lost. The attempt's identity stays, for reconciliation. */
  async recordUnknown(principal: WorkPrincipal, id: string, attemptId: string, reason: WorkSendFailureClass): Promise<boolean> {
    const done = await this.prisma.workDraft.updateMany({
      where: { ...workScope(principal), id, sendAttemptId: attemptId, sendState: 'SENDING' },
      data: { sendState: 'SEND_UNKNOWN', sendFailureClass: reason },
    });
    return done.count === 1;
  }

  /**
   * SENDING -> SEND_UNKNOWN for an attempt whose process is gone: it has been SENDING longer than
   * any request can live, so nobody is going to record its answer. This is the crash path -- no
   * failure handler ran -- and it leads to reconciliation, never to DRAFT.
   */
  async markStaleAttemptUnknown(principal: WorkPrincipal, id: string, staleBefore: Date): Promise<boolean> {
    const done = await this.prisma.workDraft.updateMany({
      where: { ...workScope(principal), id, sendState: 'SENDING', sendAttemptStartedAt: { lt: staleBefore } },
      data: { sendState: 'SEND_UNKNOWN', sendFailureClass: 'UNAVAILABLE' },
    });
    return done.count === 1;
  }

  /** Gmail was asked about this attempt, and could not settle it. */
  async recordReconciled(principal: WorkPrincipal, id: string, attemptId: string, at: Date): Promise<boolean> {
    const done = await this.prisma.workDraft.updateMany({
      where: { ...workScope(principal), id, sendAttemptId: attemptId, sendState: 'SEND_UNKNOWN' },
      data: { sendReconciledAt: at },
    });
    return done.count === 1;
  }

  /**
   * SEND_UNKNOWN -> DRAFT: Gmail proved the message absent (`RECONCILED_NOT_SENT`), or the employee
   * checked their own Sent mail and released it (`RELEASED_BY_EMPLOYEE`). The words come back,
   * sendable, and how the doubt was settled is recorded beside them.
   */
  async releaseUnknown(
    principal: WorkPrincipal,
    id: string,
    attemptId: string,
    release: { readonly resolution: 'RECONCILED_NOT_SENT' | 'RELEASED_BY_EMPLOYEE'; readonly at: Date },
  ): Promise<boolean> {
    const done = await this.prisma.workDraft.updateMany({
      where: { ...workScope(principal), id, sendAttemptId: attemptId, sendState: 'SEND_UNKNOWN' },
      data: {
        ...NO_ATTEMPT,
        sendState: 'DRAFT',
        sendFailureClass: release.resolution === 'RECONCILED_NOT_SENT' ? 'NOT_DELIVERED' : null,
        sendResolution: release.resolution,
        sendReconciledAt: release.at,
      },
    });
    return done.count === 1;
  }

  /** This person's recent drafts, newest first. Their own, by construction. */
  async drafts(principal: WorkPrincipal, limit = 50) {
    return this.prisma.workDraft.findMany({
      where: workScope(principal),
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }
}

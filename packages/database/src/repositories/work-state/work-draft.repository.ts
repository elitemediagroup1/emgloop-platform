// The reply an employee is writing, or has sent (GM-2).
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6.11.
//
// ONE OPEN DRAFT PER THREAD PER PERSON, enforced by a unique index rather than by a caller. A
// retry updates it; two tabs update it; nothing multiplies it.
//
// EVERY METHOD TAKES A PRINCIPAL. There is no method here that reads or writes a draft by id
// alone -- the id is always scoped by (organization, user), so another employee's draft is
// not-found rather than forbidden, and no role makes it found.
//
// A SEND IS CLAIMED BEFORE IT HAPPENS. `claimForSend` is a conditional update: it succeeds once,
// and a second attempt inside the claim window gets nothing back. That is what stops a
// double-click, a retried request or two browser tabs becoming two messages in somebody's inbox.

import type { PrismaClient } from '@prisma/client';
import type { WorkDraftSource, WorkProvider, WorkReplyMode, WorkSendFailureClass } from '@emgloop/shared';

import { workScope, type WorkPrincipal } from './work-principal';

/** How long a claimed send blocks another attempt before the claim is treated as abandoned. */
export const WORK_SEND_CLAIM_MS = 2 * 60 * 1000;

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

export class WorkDraftRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** This person's open draft on this conversation, or null. Never anybody else's. */
  async draft(principal: WorkPrincipal, provider: WorkProvider, threadId: string) {
    return this.prisma.workDraft.findFirst({ where: { ...workScope(principal), provider, threadId } });
  }

  async draftById(principal: WorkPrincipal, id: string) {
    return this.prisma.workDraft.findFirst({ where: { ...workScope(principal), id } });
  }

  /**
   * Write what the employee has composed so far.
   *
   * A draft that was already sent is never reopened by a save: the row keeps its send as a fact,
   * and a new reply to the same conversation starts a new draft after that row is cleared.
   */
  async save(principal: WorkPrincipal, content: DraftContent): Promise<string> {
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
      sendFailureClass: null,
    };
    const existing = await this.prisma.workDraft.findFirst({ where });
    if (!existing) {
      const created = await this.prisma.workDraft.create({ data: { ...where, ...fields } });
      return created.id;
    }
    if (existing.sentAt) {
      // The previous reply on this thread was sent; this is a new one, and it starts clean.
      const replaced = await this.prisma.workDraft.update({
        where: { id: existing.id },
        data: { ...fields, sentAt: null, sentMessageId: null, sendClaimedAt: null },
      });
      return replaced.id;
    }
    await this.prisma.workDraft.update({ where: { id: existing.id }, data: fields });
    return existing.id;
  }

  /** Throw the draft away. The employee changed their mind; nothing is kept. */
  async discard(principal: WorkPrincipal, provider: WorkProvider, threadId: string): Promise<boolean> {
    const done = await this.prisma.workDraft.deleteMany({ where: { ...workScope(principal), provider, threadId, sentAt: null } });
    return done.count === 1;
  }

  /**
   * Claim this draft for sending, once.
   *
   * Conditional on the row being unsent and unclaimed (or claimed long enough ago to be
   * abandoned), so the claim itself is the lock. It returns the row it claimed, which is the row
   * the send must use -- the caller never sends what the browser submitted without it.
   */
  async claimForSend(principal: WorkPrincipal, id: string, now: Date) {
    const cutoff = new Date(now.getTime() - WORK_SEND_CLAIM_MS);
    const claimed = await this.prisma.workDraft.updateMany({
      where: {
        ...workScope(principal),
        id,
        sentAt: null,
        OR: [{ sendClaimedAt: null }, { sendClaimedAt: { lt: cutoff } }],
      },
      data: { sendClaimedAt: now, sendFailureClass: null },
    });
    if (claimed.count !== 1) return null;
    return this.draftById(principal, id);
  }

  /** The send happened. The proof is Gmail's own id, and the body is no longer Loop's to hold. */
  async recordSent(principal: WorkPrincipal, id: string, sent: { readonly sentAt: Date; readonly sentMessageId: string }): Promise<boolean> {
    const done = await this.prisma.workDraft.updateMany({
      where: { ...workScope(principal), id, sentAt: null },
      data: { sentAt: sent.sentAt, sentMessageId: sent.sentMessageId, body: '', sendFailureClass: null, sendClaimedAt: null },
    });
    return done.count === 1;
  }

  /** The send did not happen. The claim is released so the employee can try again. */
  async recordSendFailure(principal: WorkPrincipal, id: string, failureClass: WorkSendFailureClass): Promise<boolean> {
    const done = await this.prisma.workDraft.updateMany({
      where: { ...workScope(principal), id, sentAt: null },
      data: { sendFailureClass: failureClass, sendClaimedAt: null },
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

// Sending one employee's reply, as themselves (GM-2).
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6.11.
//
// THIS IS THE ONLY PATH OUT OF LOOP INTO SOMEBODY ELSE'S INBOX, and every rule it keeps is here
// rather than in a caller:
//
//   1. A PERSON ASKS. The caller has already established an authenticated human principal and
//      `employeeMail:send` (which AI_EMPLOYEE can never hold, whatever a Permission row says).
//      This service takes a principal and a draft id -- never a body, a recipient or an address
//      from a request, and never a model's output.
//   2. WHAT IS SENT IS WHAT WAS STORED. The message is built from the CLAIMED DRAFT ROW, not from
//      what the browser submitted with the send. A composer saves first and sends second, so the
//      thing that leaves is the thing the employee last saw.
//   3. ONCE. The claim is a conditional update: a double-click, a retried request and two tabs
//      resolve to one send, and a claim is only reusable after it is plainly abandoned.
//   4. AS THEMSELVES. The From address is the connected account's own, read from the connection.
//      There is no parameter for sending as somebody else, which is why there is no delegated
//      mailbox and no administrator impersonation to reason about.
//   5. THREADED. The headers come from the STORED message being replied to (GM-1 keeps
//      `Message-ID`, `In-Reply-To` and `References`), and the reply carries all three parts of
//      Google's own threading contract.
//
// AND THE ONE IT DOES NOT KEEP: it does not decide WHETHER to send. Nothing here reads a model,
// and no model output reaches it -- a proposed draft is a stored draft like any other, and a
// person is what turns it into a message.

import {
  buildGmailReply,
  type GmailAddress,
  type GmailReplyMode,
  type GmailSendResult,
  type WorkSendFailureClass,
} from '@emgloop/shared';

import type { WorkDraftRepository } from '../../repositories/work-state/work-draft.repository';
import type { WorkGraphRepository } from '../../repositories/work-state/work-graph.repository';
import type { WorkPrincipal } from '../../repositories/work-state/work-principal';

export interface MailSendPort {
  /** The connected account's own address. A person may only ever send as themselves. */
  identity(principal: WorkPrincipal): Promise<{ readonly selfAddress: string | null }>;
  send(principal: WorkPrincipal, message: { readonly rawMessage: string; readonly threadId: string | null }): Promise<GmailSendResult>;
}

export interface MailSendDeps {
  readonly drafts: WorkDraftRepository;
  readonly graph: WorkGraphRepository;
  readonly mail: MailSendPort;
  readonly now?: () => Date;
}

export type MailSendOutcome =
  | { readonly outcome: 'SENT'; readonly messageId: string; readonly threadId: string }
  | { readonly outcome: 'ALREADY_SENDING' }
  | { readonly outcome: 'NOT_FOUND' }
  | { readonly outcome: 'FAILED'; readonly failureClass: WorkSendFailureClass };

export class MailSendService {
  constructor(private readonly deps: MailSendDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /**
   * Send the draft this employee has open on this conversation.
   *
   * The only inputs are WHO is asking and WHICH of their own drafts. Everything else -- the body,
   * the recipients, the subject, the threading headers, the From address -- is read from what was
   * stored, which is the difference between "send this" and "send whatever this request says".
   */
  async sendDraft(principal: WorkPrincipal, draftId: string): Promise<MailSendOutcome> {
    const now = this.now();
    const existing = await this.deps.drafts.draftById(principal, draftId);
    if (!existing) return { outcome: 'NOT_FOUND' };
    if (existing.sentAt) return { outcome: 'ALREADY_SENDING' };

    const claimed = await this.deps.drafts.claimForSend(principal, draftId, now);
    if (!claimed) return { outcome: 'ALREADY_SENDING' };

    const identity = await this.deps.mail.identity(principal);
    if (!identity.selfAddress) {
      await this.deps.drafts.recordSendFailure(principal, draftId, 'NOT_CONNECTED');
      return { outcome: 'FAILED', failureClass: 'NOT_CONNECTED' };
    }

    // The message being answered, as Loop stored it. A reply to a message Loop does not hold is
    // still sent -- the threadId and the subject carry it -- but nothing is invented for it.
    const target = await this.deps.graph.messageByProviderId(principal, 'GOOGLE', claimed.inReplyToMessageId);
    const built = buildGmailReply({
      target: {
        messageId: claimed.inReplyToMessageId,
        threadId: claimed.threadId,
        headerMessageId: target?.headerMessageId ?? null,
        references: target?.references ?? [],
        subject: claimed.subject ?? target?.subject ?? null,
        from: null,
        to: [],
        cc: [],
      },
      mode: claimed.mode as GmailReplyMode,
      from: { address: identity.selfAddress, name: null },
      body: claimed.body,
      // The recipients the employee last saw and saved, normalized when they were stored.
      to: claimed.toAddresses.map((address): GmailAddress => ({ address, name: null })),
      cc: claimed.ccAddresses.map((address): GmailAddress => ({ address, name: null })),
    });
    if (!built.ok) {
      // Loop refused to build it: an unsafe header, no recipient, an empty body. Nothing left.
      await this.deps.drafts.recordSendFailure(principal, draftId, 'REFUSED');
      return { outcome: 'FAILED', failureClass: 'REFUSED' };
    }

    const sent = await this.deps.mail.send(principal, { rawMessage: built.message.raw, threadId: built.message.threadId });
    if (!sent.ok) {
      const failureClass = sent.failure === 'CURSOR_EXPIRED' ? 'UNAVAILABLE' : (sent.failure as WorkSendFailureClass);
      await this.deps.drafts.recordSendFailure(principal, draftId, failureClass);
      return { outcome: 'FAILED', failureClass };
    }

    await this.deps.drafts.recordSent(principal, draftId, { sentAt: this.now(), sentMessageId: sent.messageId });
    return { outcome: 'SENT', messageId: sent.messageId, threadId: sent.threadId };
  }
}

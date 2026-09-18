// Sending one employee's reply, as themselves -- and never twice (GM-2).
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6.11, §6.11a.
//
// THIS IS THE ONLY PATH OUT OF LOOP INTO SOMEBODY ELSE'S INBOX, and every rule it keeps is here
// rather than in a caller:
//
//   1. A PERSON ASKS. The caller has already established an authenticated human principal and
//      `employeeMail:send` (which AI_EMPLOYEE can never hold, whatever a Permission row says).
//      This service takes a principal and a draft id -- never a body, a recipient or an address
//      from a request, and never a model's output.
//   2. WHAT IS SENT IS WHAT WAS STORED. The message is built from the stored draft, and the claim
//      is abandoned if an edit slipped in between reading it and claiming it.
//   3. AS THEMSELVES. The From address is the connected account's own.
//   4. THREADED. The headers come from the stored message being replied to, and the reply carries
//      all three parts of Google's documented threading contract.
//   5. AND ONCE -- WHICH IS THE HARD ONE.
//
// WHY "ONCE" NEEDS A STATE MACHINE AND NOT A LOCK. Gmail's `messages.send` has no idempotency key.
// A lock stops two clicks; it does nothing about the attempt whose ANSWER was lost: a timeout, a
// dropped connection, a 5xx, a 200 Loop could not read, or a process that stopped after Gmail
// accepted the message and before Loop wrote that down. Each of those may already be in somebody's
// inbox. So:
//
//   * the attempt's identity -- its id, its start and a fingerprint of its exact words -- is stored
//     in the SAME write that claims the draft, before Gmail is called;
//   * only a DEFINITIVE failure (Gmail refused it, or it never left) returns the draft to DRAFT;
//   * an ambiguous one becomes SEND_UNKNOWN and is RECONCILED against the employee's own Sent
//     mail. Found -> SENT, without sending. Proven absent -> DRAFT, retryable. Neither -> it stays
//     SEND_UNKNOWN until Loop can tell, or until the employee decides, explicitly and on record;
//   * a SENDING row older than any request can live is a crashed attempt, and becomes
//     SEND_UNKNOWN -- never DRAFT. There is no time-based way back to "sendable".
//
// AND IT DOES NOT DECIDE WHETHER TO SEND. Nothing here reads a model, and no model output reaches
// it: a proposed draft is a stored draft like any other, and a person turns it into a message.

import { createHash, randomUUID } from 'node:crypto';

import {
  WORK_SEND_POLICY,
  buildGmailReply,
  gmailReplySubject,
  gmailSendFingerprintText,
  gmailSendWindow,
  reconcileGmailSend,
  type GmailAddress,
  type GmailReplyMode,
  type GmailSendOutcome,
  type GmailSentLookup,
  type WorkSendFailureClass,
} from '@emgloop/shared';

import type { WorkDraftRepository } from '../../repositories/work-state/work-draft.repository';
import type { WorkGraphRepository } from '../../repositories/work-state/work-graph.repository';
import type { WorkPrincipal } from '../../repositories/work-state/work-principal';

export interface MailSendPort {
  /** The connected account's own address. A person may only ever send as themselves. */
  identity(principal: WorkPrincipal): Promise<{ readonly selfAddress: string | null }>;
  send(principal: WorkPrincipal, message: { readonly rawMessage: string; readonly threadId: string | null }): Promise<GmailSendOutcome>;
  /** The employee's own Sent mail around one attempt. Read, compared and forgotten. */
  lookupSent(principal: WorkPrincipal, query: { readonly from: Date; readonly to: Date; readonly settled: boolean }): Promise<GmailSentLookup>;
}

export interface MailSendDeps {
  readonly drafts: WorkDraftRepository;
  readonly graph: WorkGraphRepository;
  readonly mail: MailSendPort;
  readonly now?: () => Date;
  readonly newAttemptId?: () => string;
  /** SHA-256 of normalized text. Injected so tests and production agree on one definition. */
  readonly fingerprint?: (normalizedText: string) => string;
  readonly policy?: typeof WORK_SEND_POLICY;
}

export type MailSendOutcome =
  /** Gmail proved it: its own id. */
  | { readonly outcome: 'SENT'; readonly messageId: string }
  | { readonly outcome: 'ALREADY_SENT' }
  /** Another request holds this attempt, and may still be waiting on Gmail. Nothing was sent. */
  | { readonly outcome: 'IN_PROGRESS' }
  /** Nothing can be claimed right now -- an edit or another request got there first. */
  | { readonly outcome: 'BUSY' }
  | { readonly outcome: 'NOT_FOUND' }
  /** DEFINITIVE: it is known that nothing left. The draft is back, and may be sent again. */
  | { readonly outcome: 'FAILED'; readonly failureClass: WorkSendFailureClass }
  /** In doubt. It will not be sent again until Loop can tell, or the employee decides. */
  | { readonly outcome: 'UNCONFIRMED'; readonly reason: string }
  /** Reconciliation proved it was never sent. The draft is back, and may be sent again. */
  | { readonly outcome: 'NOT_DELIVERED' }
  /** The employee released an unconfirmed attempt, on record. The draft is back. */
  | { readonly outcome: 'RELEASED' }
  /** A release asked for before the attempt could possibly have finished. */
  | { readonly outcome: 'TOO_SOON' };

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export class MailSendService {
  private readonly policy: typeof WORK_SEND_POLICY;

  constructor(private readonly deps: MailSendDeps) {
    this.policy = deps.policy ?? WORK_SEND_POLICY;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private fingerprint(text: string): string {
    return (this.deps.fingerprint ?? sha256)(gmailSendFingerprintText(text));
  }

  /**
   * Send the draft this employee has open on this conversation.
   *
   * The only inputs are WHO is asking and WHICH of their own drafts. An attempt already in flight
   * or in doubt is never sent again from here: this call reconciles it instead.
   */
  async sendDraft(principal: WorkPrincipal, draftId: string): Promise<MailSendOutcome> {
    const existing = await this.deps.drafts.draftById(principal, draftId);
    if (!existing) return { outcome: 'NOT_FOUND' };
    if (existing.sendState === 'SENT') return { outcome: 'ALREADY_SENT' };
    // In flight or in doubt: settle what is known. Never a second transmission.
    if (existing.sendState === 'SENDING' || existing.sendState === 'SEND_UNKNOWN') return this.reconcile(principal, draftId);

    const identity = await this.deps.mail.identity(principal);
    if (!identity.selfAddress) {
      await this.deps.drafts.noteNotAttempted(principal, draftId, 'NOT_CONNECTED');
      return { outcome: 'FAILED', failureClass: 'NOT_CONNECTED' };
    }

    // The message being answered, as Loop stored it. A reply to a message Loop does not hold is
    // still sent -- the threadId and the subject carry it -- but nothing is invented for it.
    const target = await this.deps.graph.messageByProviderId(principal, 'GOOGLE', existing.inReplyToMessageId);
    const built = buildGmailReply({
      target: {
        messageId: existing.inReplyToMessageId,
        threadId: existing.threadId,
        headerMessageId: target?.headerMessageId ?? null,
        references: target?.references ?? [],
        subject: existing.subject ?? target?.subject ?? null,
        from: null,
        to: [],
        cc: [],
      },
      mode: existing.mode as GmailReplyMode,
      from: { address: identity.selfAddress, name: null },
      body: existing.body,
      to: existing.toAddresses.map((address): GmailAddress => ({ address, name: null })),
      cc: existing.ccAddresses.map((address): GmailAddress => ({ address, name: null })),
    });
    if (!built.ok) {
      // Loop refused to build it: an unsafe header, no recipient, an empty body. Nothing left.
      await this.deps.drafts.noteNotAttempted(principal, draftId, 'REFUSED');
      return { outcome: 'FAILED', failureClass: 'REFUSED' };
    }

    // DRAFT -> SENDING, with the attempt's identity in the same write, BEFORE Gmail is called.
    const attempt = {
      attemptId: (this.deps.newAttemptId ?? randomUUID)(),
      startedAt: this.now(),
      bodyHash: this.fingerprint(existing.body),
    };
    const claimed = await this.deps.drafts.claimForSend(principal, draftId, attempt);
    if (!claimed) return { outcome: 'BUSY' };
    const sameWords =
      claimed.body === existing.body &&
      claimed.toAddresses.join('\n') === existing.toAddresses.join('\n') &&
      claimed.ccAddresses.join('\n') === existing.ccAddresses.join('\n');
    if (!sameWords) {
      // An edit landed between the read and the claim. Nothing has left yet; step back rather than
      // send words that are not the ones the attempt was fingerprinted from.
      await this.deps.drafts.abandonClaim(principal, draftId, attempt.attemptId);
      return { outcome: 'BUSY' };
    }

    let sent: GmailSendOutcome;
    try {
      sent = await this.deps.mail.send(principal, { rawMessage: built.message.raw, threadId: built.message.threadId });
    } catch {
      // The port should not throw; if it did, it may have done so after transmitting.
      sent = { delivery: 'UNKNOWN', reason: 'NETWORK' };
    }

    if (sent.delivery === 'SENT') {
      // If THIS write never happens -- the process dies right here -- the row stays SENDING, goes
      // stale, and is reconciled against Sent mail. It is never released to be sent again.
      await this.deps.drafts.recordSent(principal, draftId, attempt.attemptId, { sentAt: this.now(), sentMessageId: sent.messageId });
      return { outcome: 'SENT', messageId: sent.messageId };
    }
    if (sent.delivery === 'NOT_SENT') {
      // Checked, not cast: every definitive send failure is a class `work_drafts` stores.
      const failureClass: WorkSendFailureClass = sent.failure;
      await this.deps.drafts.recordNotSent(principal, draftId, attempt.attemptId, failureClass);
      return { outcome: 'FAILED', failureClass };
    }

    // UNKNOWN. Record the doubt first, then look once -- a reply that did go through is usually
    // already in Sent mail, and finding it now saves the employee a question.
    await this.deps.drafts.recordUnknown(principal, draftId, attempt.attemptId, sent.reason);
    return this.reconcile(principal, draftId);
  }

  /**
   * Settle an attempt that is in doubt, against the employee's own Sent mail. READ-ONLY toward
   * Gmail: it looks, it never sends.
   *
   * `force` skips the per-attempt floor, for a person who has just asked Loop to check.
   */
  async reconcile(principal: WorkPrincipal, draftId: string, options: { readonly force?: boolean } = {}): Promise<MailSendOutcome> {
    let row = await this.deps.drafts.draftById(principal, draftId);
    if (!row) return { outcome: 'NOT_FOUND' };
    if (row.sendState === 'SENT') return { outcome: 'ALREADY_SENT' };
    if (row.sendState === 'DRAFT') return row.sendFailureClass ? { outcome: 'FAILED', failureClass: row.sendFailureClass as WorkSendFailureClass } : { outcome: 'BUSY' };

    const now = this.now();
    if (row.sendState === 'SENDING') {
      const startedAt = row.sendAttemptStartedAt!;
      if (now.getTime() - startedAt.getTime() < this.policy.inFlightMs) return { outcome: 'IN_PROGRESS' };
      // The crash path: nobody is going to record this attempt's answer. It is in doubt, not free.
      await this.deps.drafts.markStaleAttemptUnknown(principal, draftId, new Date(now.getTime() - this.policy.inFlightMs));
      row = await this.deps.drafts.draftById(principal, draftId);
      if (!row || row.sendState !== 'SEND_UNKNOWN') return row?.sendState === 'SENT' ? { outcome: 'ALREADY_SENT' } : { outcome: 'IN_PROGRESS' };
    }

    if (!options.force && row.sendReconciledAt && now.getTime() - row.sendReconciledAt.getTime() < this.policy.reconcileFloorMs) {
      return { outcome: 'UNCONFIRMED', reason: 'RECENTLY_CHECKED' };
    }

    const attempt = {
      threadId: row.threadId,
      startedAt: row.sendAttemptStartedAt!,
      subject: gmailReplySubject(row.subject),
      recipients: [...row.toAddresses, ...row.ccAddresses],
      bodyFingerprint: row.sendAttemptBodyHash!,
    };
    const attemptId = row.sendAttemptId!;
    const window = gmailSendWindow(attempt, this.policy);
    const settled = now.getTime() - attempt.startedAt.getTime() >= this.policy.settleMs;

    let lookup: GmailSentLookup;
    try {
      lookup = await this.deps.mail.lookupSent(principal, { from: window.from, to: window.to, settled });
    } catch {
      lookup = { ok: false, failure: 'UNAVAILABLE' };
    }
    const verdict = reconcileGmailSend(attempt, lookup, now, (text) => (this.deps.fingerprint ?? sha256)(text), this.policy);

    if (verdict.verdict === 'SENT') {
      await this.deps.drafts.recordSent(principal, draftId, attemptId, { sentAt: now, sentMessageId: verdict.messageId, resolution: 'RECONCILED_SENT' });
      return { outcome: 'SENT', messageId: verdict.messageId };
    }
    if (verdict.verdict === 'NOT_SENT') {
      await this.deps.drafts.releaseUnknown(principal, draftId, attemptId, { resolution: 'RECONCILED_NOT_SENT', at: now });
      return { outcome: 'NOT_DELIVERED' };
    }
    await this.deps.drafts.recordReconciled(principal, draftId, attemptId, now);
    return { outcome: 'UNCONFIRMED', reason: verdict.reason };
  }

  /**
   * The employee's explicit decision about an attempt Loop could not settle: "I checked my Sent
   * mail, and it is not there -- let me send it again."
   *
   * Two guards stand in front of it. It is refused while the attempt could still be in flight, so
   * a person cannot race their own request. And Loop looks ONE more time first: if the message is
   * there after all, it is marked SENT and nothing is released -- the employee is protected from
   * their own mistake. Only when Loop still cannot tell is the draft released, and the release is
   * recorded as theirs.
   */
  async releaseUnconfirmed(principal: WorkPrincipal, draftId: string): Promise<MailSendOutcome> {
    const row = await this.deps.drafts.draftById(principal, draftId);
    if (!row) return { outcome: 'NOT_FOUND' };
    if (row.sendState === 'SENT') return { outcome: 'ALREADY_SENT' };
    if (row.sendState === 'DRAFT') return { outcome: 'RELEASED' };

    const now = this.now();
    if (now.getTime() - row.sendAttemptStartedAt!.getTime() < this.policy.releaseAfterMs) return { outcome: 'TOO_SOON' };

    const checked = await this.reconcile(principal, draftId, { force: true });
    if (checked.outcome !== 'UNCONFIRMED') return checked;

    const current = await this.deps.drafts.draftById(principal, draftId);
    if (!current || current.sendState !== 'SEND_UNKNOWN') return checked;
    await this.deps.drafts.releaseUnknown(principal, draftId, current.sendAttemptId!, { resolution: 'RELEASED_BY_EMPLOYEE', at: now });
    return { outcome: 'RELEASED' };
  }
}

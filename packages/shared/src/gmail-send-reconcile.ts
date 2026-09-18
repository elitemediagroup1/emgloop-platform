// Deciding whether an unconfirmed send actually left. PURE -- no I/O, no clock, no crypto.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6.11a (GM-2).
//
// WHY THIS EXISTS. Gmail's `messages.send` has no idempotency key (its reference lists no
// parameter for one, verified 2026-09-18), so a request whose answer was lost -- a timeout, a
// dropped connection, a 5xx, a process that stopped after Gmail accepted the message -- leaves
// Loop not knowing whether the employee's reply is already in somebody's inbox. Sending again is
// the one thing that must not happen.
//
// WHAT IT DOES NOT RELY ON, AND WHY. A Loop-chosen `Message-ID` would be the obvious correlation
// key, and Gmail's search even has `rfc822msgid:` -- but the Gmail API does not honour a
// client-supplied Message-ID on send (it generates its own; reported by Mixmax, a large Gmail API
// sender, and not contradicted anywhere in Google's documentation). A custom `X-` header's
// survival is undocumented. Neither is used, because a proof that depends on undocumented
// behaviour is not a proof.
//
// WHAT IT RELIES ON INSTEAD: things Gmail documents and Loop controls.
//   * the attempt's thread, recipients and subject, stored before the call;
//   * a fingerprint of the exact words sent, stored before the call -- the message is plain text
//     Loop built itself, so what Gmail keeps in Sent is those same words;
//   * the employee's own Sent mail for the attempt's time window, listed by the SENT label.
//
// THE ASYMMETRY IS THE WHOLE DESIGN.
//   SENT      needs POSITIVE proof: a Sent message in the window whose words match exactly.
//   NOT_SENT  needs proof of ABSENCE: a COMPLETE look at the window, after it has settled, that
//             found no message that could be this reply. A look that could not be completed, or
//             that was made too soon, proves nothing.
//   UNKNOWN   everything else -- including a message that COULD be this reply but whose words do
//             not match. That might be Gmail altering the text; it might be the employee replying
//             from Gmail at the same moment. Loop cannot tell, so it does not guess: it asks.

import { WORK_SEND_POLICY } from './work-state';
import type { GmailSentCandidate } from './gmail-sensor';

/** What was stored about an attempt before Gmail was called. */
export interface GmailSendAttempt {
  readonly threadId: string;
  readonly startedAt: Date;
  /** The reply's subject as sent (with its "Re:"), and the recipients it was addressed to. */
  readonly subject: string | null;
  readonly recipients: readonly string[];
  /** The fingerprint of the exact words sent (see `gmailSendFingerprintText`). */
  readonly bodyFingerprint: string;
}

export type GmailSendReconciliation =
  | { readonly verdict: 'SENT'; readonly messageId: string }
  | { readonly verdict: 'NOT_SENT' }
  | { readonly verdict: 'UNKNOWN'; readonly reason: 'TOO_SOON' | 'INCOMPLETE_LOOK' | 'UNATTRIBUTABLE_CANDIDATE' | 'LOOK_FAILED' };

/**
 * The text a fingerprint is taken of. Line endings and trailing whitespace are normalized, because
 * MIME carries CRLF and a trailing newline is not a different reply; nothing else is.
 */
export function gmailSendFingerprintText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
}

/** A subject as a conversation knows it: without its reply and forward prefixes. */
export function normalizeReplySubject(subject: string | null): string {
  let text = (subject ?? '').trim().toLowerCase();
  for (;;) {
    const next = text.replace(/^(re|fw|fwd)\s*:\s*/i, '');
    if (next === text) return text.replace(/\s+/g, ' ');
    text = next;
  }
}

/** The window of Sent mail one attempt could have produced. */
export function gmailSendWindow(attempt: Pick<GmailSendAttempt, 'startedAt'>, policy = WORK_SEND_POLICY): { readonly from: Date; readonly to: Date } {
  return {
    from: new Date(attempt.startedAt.getTime() - policy.windowBeforeMs),
    to: new Date(attempt.startedAt.getTime() + policy.windowAfterMs),
  };
}

/**
 * Could this Sent message be the attempt? Same conversation -- or the same subject to at least one
 * of the same people, which is how a reply that Gmail threaded elsewhere would still look.
 */
function couldBe(candidate: GmailSentCandidate, attempt: GmailSendAttempt): boolean {
  if (candidate.threadId === attempt.threadId) return true;
  const sameSubject = normalizeReplySubject(candidate.subject) === normalizeReplySubject(attempt.subject);
  const recipients = new Set(attempt.recipients.map((r) => r.toLowerCase()));
  const sharesRecipient = candidate.recipients.some((r) => recipients.has(r.toLowerCase()));
  return sameSubject && sharesRecipient;
}

/**
 * The verdict for one unconfirmed attempt, given what Gmail's Sent mail showed.
 *
 * `fingerprint` is injected (the caller owns the hash function), and it is applied to
 * `gmailSendFingerprintText(candidate.text)`.
 */
export function reconcileGmailSend(
  attempt: GmailSendAttempt,
  lookup: { readonly ok: true; readonly candidates: readonly GmailSentCandidate[]; readonly complete: boolean } | { readonly ok: false },
  now: Date,
  fingerprint: (normalizedText: string) => string,
  policy = WORK_SEND_POLICY,
): GmailSendReconciliation {
  if (!lookup.ok) return { verdict: 'UNKNOWN', reason: 'LOOK_FAILED' };

  const window = gmailSendWindow(attempt, policy);
  const inWindow = lookup.candidates.filter((c) => c.internalDate >= window.from && c.internalDate <= window.to);
  const plausible = inWindow.filter((c) => couldBe(c, attempt));

  // Positive proof first, at any age: the exact words, in a message that could be this reply.
  for (const candidate of plausible) {
    if (candidate.text === null) continue;
    if (fingerprint(gmailSendFingerprintText(candidate.text)) === attempt.bodyFingerprint) {
      return { verdict: 'SENT', messageId: candidate.messageId };
    }
  }

  // Something that could be it, whose words Loop cannot match. Not proof either way.
  if (plausible.length > 0) return { verdict: 'UNKNOWN', reason: 'UNATTRIBUTABLE_CANDIDATE' };

  // Absence is only proof once the attempt has settled AND the look covered the whole window.
  if (now.getTime() - attempt.startedAt.getTime() < policy.settleMs) return { verdict: 'UNKNOWN', reason: 'TOO_SOON' };
  if (!lookup.complete) return { verdict: 'UNKNOWN', reason: 'INCOMPLETE_LOOK' };
  return { verdict: 'NOT_SENT' };
}

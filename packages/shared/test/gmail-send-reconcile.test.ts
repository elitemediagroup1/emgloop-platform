// Deciding whether an unconfirmed send actually left: the verdicts, and the asymmetry between them.
//
// SENT needs positive proof -- a Sent message in the window with exactly these words.
// NOT_SENT needs proof of absence -- a COMPLETE look at a SETTLED window that found nothing that
// could be this reply. Everything else is UNKNOWN, and UNKNOWN is never a resend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  gmailSendFingerprintText,
  gmailSendWindow,
  normalizeReplySubject,
  reconcileGmailSend,
  type GmailSendAttempt,
} from '../src/gmail-send-reconcile';
import { WORK_DRAFT_SEND_STATES, WORK_SEND_POLICY } from '../src/work-state';
import type { GmailSentCandidate } from '../src/gmail-sensor';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const STARTED = new Date('2026-09-18T12:00:00Z');
const MIN = 60_000;
const BODY = 'Ben — revised rates attached.\nTalk Friday.';

const attempt: GmailSendAttempt = {
  threadId: 't1',
  startedAt: STARTED,
  subject: 'Re: Cashion pricing',
  recipients: ['ben@cashion.example'],
  bodyFingerprint: sha(gmailSendFingerprintText(BODY)),
};

const candidate = (over: Partial<GmailSentCandidate> = {}): GmailSentCandidate => ({
  messageId: 'sent1',
  threadId: 't1',
  internalDate: new Date(STARTED.getTime() + 3_000),
  subject: 'Re: Cashion pricing',
  recipients: ['ben@cashion.example'],
  text: BODY,
  ...over,
});

const at = (ms: number) => new Date(STARTED.getTime() + ms);
const look = (candidates: GmailSentCandidate[], complete = true) => ({ ok: true as const, candidates, complete });

test('the state machine has exactly four states, and no clock leads out of doubt', () => {
  assert.deepEqual([...WORK_DRAFT_SEND_STATES], ['DRAFT', 'SENDING', 'SEND_UNKNOWN', 'SENT']);
  // The policy's clocks all serve settling a doubt; none of them releases one.
  assert.ok(WORK_SEND_POLICY.settleMs > WORK_SEND_POLICY.inFlightMs);
  assert.ok(WORK_SEND_POLICY.releaseAfterMs > WORK_SEND_POLICY.inFlightMs, 'an employee cannot release an attempt that may still be running');
});

test('the exact words in the window are proof it was sent -- at any age', () => {
  const soon = reconcileGmailSend(attempt, look([candidate()], false), at(5_000), sha);
  assert.deepEqual(soon, { verdict: 'SENT', messageId: 'sent1' }, 'found seconds later, from an incomplete look');

  // Line endings and trailing whitespace are how MIME travels, not a different reply.
  const crlf = reconcileGmailSend(attempt, look([candidate({ text: BODY.replace(/\n/g, '\r\n') + '\r\n' })]), at(20 * MIN), sha);
  assert.equal(crlf.verdict, 'SENT');

  // Threaded elsewhere by Gmail, but the same subject to the same person with the same words.
  const elsewhere = reconcileGmailSend(attempt, look([candidate({ threadId: 'other' })]), at(20 * MIN), sha);
  assert.equal(elsewhere.verdict, 'SENT');
});

test('absence proves nothing too soon, or from a look that could not be completed', () => {
  assert.deepEqual(reconcileGmailSend(attempt, look([], true), at(2 * MIN), sha), { verdict: 'UNKNOWN', reason: 'TOO_SOON' });
  assert.deepEqual(reconcileGmailSend(attempt, look([], false), at(20 * MIN), sha), { verdict: 'UNKNOWN', reason: 'INCOMPLETE_LOOK' });
  assert.deepEqual(reconcileGmailSend(attempt, { ok: false }, at(20 * MIN), sha), { verdict: 'UNKNOWN', reason: 'LOOK_FAILED' });
  // Settled and complete, and nothing there: that is proof.
  assert.deepEqual(reconcileGmailSend(attempt, look([], true), at(WORK_SEND_POLICY.settleMs), sha), { verdict: 'NOT_SENT' });
});

test('a message that could be this reply but whose words differ is not guessed either way', () => {
  // Same conversation, same window, different words: Gmail altering the text, or the employee
  // replying from Gmail at the same moment. Loop cannot tell, so it asks.
  const other = reconcileGmailSend(attempt, look([candidate({ text: 'A different reply typed in Gmail.' })]), at(20 * MIN), sha);
  assert.deepEqual(other, { verdict: 'UNKNOWN', reason: 'UNATTRIBUTABLE_CANDIDATE' });
  // No readable words at all is the same answer.
  assert.equal(reconcileGmailSend(attempt, look([candidate({ text: null })]), at(20 * MIN), sha).verdict, 'UNKNOWN');
});

test('Sent mail that cannot be this reply is ignored, and cannot make it look sent', () => {
  const unrelated = [
    candidate({ messageId: 'x1', threadId: 'other', subject: 'Lunch?', recipients: ['lexi@emg.example'], text: BODY }),
    // Outside the window: before the attempt started, or long after.
    candidate({ messageId: 'x2', internalDate: at(-10 * MIN) }),
    candidate({ messageId: 'x3', internalDate: at(30 * MIN) }),
  ];
  assert.deepEqual(reconcileGmailSend(attempt, look(unrelated), at(20 * MIN), sha), { verdict: 'NOT_SENT' });
});

test('the window is generous against clock skew, and subjects compare as a conversation does', () => {
  const window = gmailSendWindow(attempt);
  assert.equal(window.from.getTime(), STARTED.getTime() - WORK_SEND_POLICY.windowBeforeMs);
  assert.equal(window.to.getTime(), STARTED.getTime() + WORK_SEND_POLICY.windowAfterMs);
  // A message Gmail stamped a minute BEFORE Loop's clock started the attempt is still in the window.
  assert.equal(reconcileGmailSend(attempt, look([candidate({ internalDate: at(-MIN) })]), at(20 * MIN), sha).verdict, 'SENT');
  assert.equal(normalizeReplySubject('RE: Fwd: re: Cashion   pricing'), 'cashion pricing');
  assert.equal(normalizeReplySubject(null), '');
});

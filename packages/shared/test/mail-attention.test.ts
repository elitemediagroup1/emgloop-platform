// What a mailbox is waiting on: the states, the thresholds, and the claims Loop does not make.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAIL_ATTENTION_POLICY, mailAttention, mailAttentionFor, mailPeriodSummary, type MailThreadFacts } from '../src/mail-attention';

const NOW = new Date('2026-09-18T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function thread(over: Partial<MailThreadFacts> = {}): MailThreadFacts {
  return {
    threadId: 't1',
    subject: 'Cashion pricing',
    lastMessageAt: ago(6 * HOUR),
    firstMessageAt: ago(3 * DAY),
    lastDirection: 'INBOUND',
    messageCount: 3,
    unread: false,
    hasExchange: true,
    ...over,
  };
}

test('they wrote last and you have not answered: that is NEEDS_YOU, and unread makes it immediate', () => {
  const unanswered = mailAttentionFor(thread(), NOW)!;
  assert.equal(unanswered.class, 'NEEDS_YOU');
  assert.equal(unanswered.evidence.rule, 'INBOUND_UNANSWERED');
  assert.equal(unanswered.recurrenceKey, 'gmail:thread:t1:NEEDS_YOU');

  // Unread does not wait for the window: it is the clearest evidence there is.
  const fresh = mailAttentionFor(thread({ lastMessageAt: ago(5 * 60_000), unread: true }), NOW)!;
  assert.equal(fresh.class, 'NEEDS_YOU');
  assert.equal(fresh.evidence.rule, 'INBOUND_UNREAD');

  // A message that arrived minutes ago and has been read is not yet anything.
  assert.equal(mailAttentionFor(thread({ lastMessageAt: ago(5 * 60_000), unread: false }), NOW), null);
});

test('you wrote last and nobody replied: that is WAITING_ON_THEM, after the window and not before', () => {
  assert.equal(mailAttentionFor(thread({ lastDirection: 'OUTBOUND', lastMessageAt: ago(6 * HOUR) }), NOW), null);
  const waiting = mailAttentionFor(thread({ lastDirection: 'OUTBOUND', lastMessageAt: ago(3 * DAY) }), NOW)!;
  assert.equal(waiting.class, 'WAITING_ON_THEM');
  assert.equal(waiting.evidence.rule, 'OUTBOUND_UNANSWERED');
  assert.equal(waiting.evidence.lastDirection, 'OUTBOUND');
});

test('a conversation both sides were having, silent for a fortnight, has gone quiet', () => {
  const quiet = mailAttentionFor(thread({ lastDirection: 'OUTBOUND', lastMessageAt: ago(20 * DAY) }), NOW)!;
  assert.equal(quiet.class, 'GONE_QUIET');
  assert.equal(quiet.evidence.rule, 'EXCHANGE_SILENT');

  // A one-sided thread that nobody answered is still just waiting: "gone quiet" is about a
  // conversation stopping, and one that never started cannot stop.
  const oneSided = mailAttentionFor(thread({ lastDirection: 'OUTBOUND', lastMessageAt: ago(20 * DAY), hasExchange: false, messageCount: 1 }), NOW)!;
  assert.equal(oneSided.class, 'WAITING_ON_THEM');
});

test('nothing beyond the horizon is raised, and nothing without a timestamp is guessed at', () => {
  assert.equal(mailAttentionFor(thread({ lastMessageAt: ago(60 * DAY) }), NOW), null, 'older than the horizon');
  assert.equal(mailAttentionFor(thread({ lastMessageAt: null }), NOW), null, 'no timestamp, no claim');
  assert.equal(mailAttentionFor(thread({ lastDirection: null }), NOW), null, 'no direction, no claim');
  // A clock skew that puts a message in the future is not a conversation state.
  assert.equal(mailAttentionFor(thread({ lastMessageAt: new Date(NOW.getTime() + HOUR) }), NOW), null);
});

test('states are ordered by when they last moved, and carry evidence rather than adjectives', () => {
  const states = mailAttention(
    [
      thread({ threadId: 'old', lastMessageAt: ago(3 * DAY) }),
      thread({ threadId: 'new', lastMessageAt: ago(5 * HOUR) }),
      thread({ threadId: 'mid', lastMessageAt: ago(DAY) }),
    ],
    NOW,
  );
  assert.deepEqual(states.map((s) => s.threadId), ['new', 'mid', 'old']);

  // The evidence is references and durations. There is no score, no priority and no adjective.
  const evidence = states[0]!.evidence;
  assert.deepEqual(Object.keys(evidence).sort(), ['ageMs', 'lastDirection', 'lastMessageAt', 'messageCount', 'rule', 'unread']);
  for (const forbidden of ['score', 'priority', 'importance', 'urgency', 'confidence', 'sentiment']) {
    assert.equal(Object.keys(evidence).includes(forbidden), false, forbidden);
  }
});

test('the summary counts rows, and says nothing about what anybody meant', () => {
  const threads = [
    thread({ threadId: 'a', lastMessageAt: ago(2 * HOUR), lastDirection: 'INBOUND', unread: true }),
    thread({ threadId: 'b', lastMessageAt: ago(5 * HOUR), lastDirection: 'OUTBOUND' }),
    thread({ threadId: 'c', lastMessageAt: ago(3 * DAY), lastDirection: 'OUTBOUND' }),
    thread({ threadId: 'd', lastMessageAt: ago(30 * DAY), lastDirection: 'OUTBOUND' }),
  ];
  const summary = mailPeriodSummary(threads, { from: ago(DAY), to: NOW }, NOW);
  assert.equal(summary.moved, 2, 'two conversations moved inside the window');
  assert.equal(summary.replies, 1);
  assert.equal(summary.answered, 1);
  assert.equal(summary.needsYou, 1);
  assert.equal(summary.waitingOnThem, 1);
  assert.equal(summary.goneQuiet, 1);
});

test('the rules read no body, and state no conclusion a header cannot support', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'mail-attention.ts'), 'utf8');
  for (const forbidden of ['body', 'snippet', 'sentiment', 'urgency', 'importance', 'score', 'priority', 'confidence']) {
    assert.equal(new RegExp(`\\b${forbidden}\\b`).test(src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')), false, forbidden);
  }
  // The thresholds are policy, stated once, and reachable by a caller that wants to vary them.
  assert.equal(MAIL_ATTENTION_POLICY.needsYouAfterMs, 4 * HOUR);
  assert.equal(MAIL_ATTENTION_POLICY.waitingAfterMs, 2 * DAY);
  assert.equal(MAIL_ATTENTION_POLICY.quietAfterMs, 14 * DAY);
  assert.equal(MAIL_ATTENTION_POLICY.horizonMs, 45 * DAY);
});

// The Mail domain's interpretation: at most two sentences, counts and business areas only, read
// from the lanes the classification already decided. Mail and Home show the same lines, so the
// rules are pinned once, here -- including the one that matters most: no subject, address or name
// ever reaches a line.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAIL_INTELLIGENCE_POLICY,
  mailDomainIntelligence,
  mailWaitWords,
  summarizeMail,
  type MailInsight,
} from '../src/mail-intelligence';

const NOW = new Date('2026-09-24T16:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

// Sentinels: private mail content that must never appear in an interpretation.
const SUBJECT = 'SECRET-SUBJECT Cashion creator sponsorship invoice';
const ADDRESS = 'sentinel.person@private.example';
const NAME = 'Sentinel Person';

function insight(over: Partial<MailInsight> & { threadId: string }): MailInsight {
  return {
    subject: SUBJECT,
    lastMessageAt: ago(H),
    unread: false,
    counterpart: { name: NAME, address: ADDRESS, domain: 'private.example' },
    startedBySelf: false,
    lastInboundAt: ago(H),
    lastOutboundAt: null,
    notification: null,
    lane: null,
    laneReason: null,
    laneAt: null,
    opportunity: null,
    areas: [],
    ...over,
  };
}

const read = (insights: MailInsight[]) => mailDomainIntelligence(insights, summarizeMail(insights, NOW), NOW);

test('an empty mailbox says nothing: no lines, never a zero', () => {
  const out = read([]);
  assert.deepEqual(out.lines, []);
  assert.deepEqual([out.needsReply, out.waiting, out.followUps], [0, 0, 0]);
  // Only notification mail: still nothing to say.
  assert.deepEqual(read([insight({ threadId: 'n', notification: 'Gmail files it under Updates', lane: null })]).lines, []);
});

test('needs-reply is broken down by opportunity and business area, with the oldest wait and the last day', () => {
  const out = read([
    insight({ threadId: 'a', lane: 'NEEDS_REPLY', laneReason: 'INBOUND_UNANSWERED', laneAt: ago(3 * D + 2 * H), areas: [{ area: 'TALENT', matched: 'creator' }], opportunity: { kind: 'INBOUND_INQUIRY', at: ago(3 * D), matched: 'sponsorship' } }),
    insight({ threadId: 'b', lane: 'NEEDS_REPLY', laneReason: 'UNREAD_INBOUND', laneAt: ago(2 * H), areas: [{ area: 'OPERATIONS', matched: 'invoice' }] }),
    insight({ threadId: 'c', lane: 'NEEDS_REPLY', laneReason: 'UNREAD_INBOUND', laneAt: ago(5 * H), areas: [{ area: 'TALENT', matched: 'talent' }] }),
  ]);
  assert.equal(out.needsReply, 3);
  assert.deepEqual(out.lines, [
    '3 conversations need your reply, including 1 opportunity, 2 about talent and 1 about operations; the oldest has waited 3 days on you and 2 arrived in the last day.',
  ]);
});

test('a single conversation reads in the singular, and an unclassified one adds no breakdown', () => {
  const out = read([insight({ threadId: 'a', lane: 'NEEDS_REPLY', laneReason: 'INBOUND_UNANSWERED', laneAt: ago(30 * H) })]);
  assert.deepEqual(out.lines, ['1 conversation needs your reply; the oldest has waited 1 day on you.']);
});

test('waiting conversations that have gone quiet past the follow-up threshold are named as such, with follow-ups due', () => {
  const out = read([
    insight({ threadId: 'w1', lane: 'WAITING', laneReason: 'MARKED_WAITING', laneAt: ago(4 * D) }),
    insight({ threadId: 'w2', lane: 'WAITING', laneReason: 'AWAITING_RESPONSE', laneAt: ago(D) }),
    insight({ threadId: 'f1', lane: 'FOLLOW_UP', laneReason: 'NO_RESPONSE_SINCE', laneAt: ago(5 * D) }),
  ]);
  assert.deepEqual([out.needsReply, out.waiting, out.followUps], [0, 2, 1]);
  assert.deepEqual(out.lines, ['1 follow-up is due and 1 of the 2 conversations waiting on others has gone quiet for over 3 days.']);
});

test('waiting with none gone quiet just says how many are waiting', () => {
  const out = read([insight({ threadId: 'w', lane: 'WAITING', laneReason: 'AWAITING_RESPONSE', laneAt: ago(H) })]);
  assert.deepEqual(out.lines, ['1 conversation is waiting on others.']);
});

test('never more than two lines, the reply line first', () => {
  const out = read([
    insight({ threadId: 'a', lane: 'NEEDS_REPLY', laneReason: 'INBOUND_UNANSWERED', laneAt: ago(6 * H) }),
    insight({ threadId: 'w', lane: 'WAITING', laneReason: 'AWAITING_RESPONSE', laneAt: ago(H) }),
    insight({ threadId: 'f', lane: 'FOLLOW_UP', laneReason: 'NO_RESPONSE_SINCE', laneAt: ago(4 * D) }),
  ]);
  assert.equal(out.lines.length, 2);
  assert.match(out.lines[0]!, /need(s)? your reply/);
  for (const line of out.lines) assert.equal(line.split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length, 1, line);
});

test('no subject, address, domain or name ever reaches a line', () => {
  const out = read([
    insight({ threadId: 'a', lane: 'NEEDS_REPLY', laneReason: 'UNREAD_INBOUND', laneAt: ago(H), opportunity: { kind: 'INBOUND_INQUIRY', at: ago(H), matched: 'sponsorship' }, areas: [{ area: 'TALENT', matched: 'creator' }, { area: 'OPERATIONS', matched: 'invoice' }] }),
    insight({ threadId: 'w', lane: 'WAITING', laneReason: 'MARKED_WAITING', laneAt: ago(5 * D) }),
    insight({ threadId: 'f', lane: 'FOLLOW_UP', laneReason: 'OUTREACH_NO_RESPONSE', laneAt: ago(4 * D) }),
  ]);
  const text = out.lines.join(' ');
  for (const secret of ['SECRET-SUBJECT', 'Cashion', 'sponsorship', 'invoice', ADDRESS, 'private.example', NAME, 'Sentinel']) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test('the threshold is the policy\'s, and the wait words never round up', () => {
  assert.equal(mailWaitWords(MAIL_INTELLIGENCE_POLICY.followUpAfterMs), '3 days');
  assert.equal(mailWaitWords(47 * H), '1 day');
  assert.equal(mailWaitWords(90 * 60_000), '1 hour');
  assert.equal(mailWaitWords(10_000), '1 minute');
  const strict = { ...MAIL_INTELLIGENCE_POLICY, followUpAfterMs: D };
  const insights = [insight({ threadId: 'w', lane: 'WAITING', laneReason: 'MARKED_WAITING', laneAt: ago(2 * D) })];
  assert.deepEqual(mailDomainIntelligence(insights, summarizeMail(insights, NOW), NOW, strict).lines, [
    '1 conversation waiting on others has gone quiet for over 1 day.',
  ]);
});

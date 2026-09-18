// Today's Review: many sources, one shape, merged without inventing anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  composeReview,
  isRelevantMail,
  mailActivity,
  namedList,
  type ReviewAttention,
  type ReviewContribution,
} from '../src/executive-review';
import { notificationMessageReason } from '../src/mail-intelligence';

const NOW = new Date('2026-09-18T16:00:00Z');
const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const attention = (key: string, rank: number, sinceH: number, source: ReviewAttention['source'] = 'MAIL'): ReviewAttention => ({
  key, source, rank, since: at(sinceH), who: key, happened: 'x', next: 'Reply', tone: 'attention', href: null,
});

test('the headline is the most important facts, in rank order, and nothing else', () => {
  const review = composeReview([
    { source: 'CALENDAR', state: 'OK', facts: [{ rank: 40, sentence: '6 meetings today.' }] },
    { source: 'MAIL', state: 'OK', facts: [{ rank: 10, sentence: '3 conversations need your reply.' }, { rank: 30, sentence: 'You are waiting on 2.' }] },
    { source: 'CALLGRID', state: 'OK', facts: [{ rank: 20, sentence: 'CallGrid billed 38 calls yesterday.' }] },
    { source: 'WORK', state: 'OK', facts: [{ rank: 50, sentence: 'One work item needs an owner.' }] },
  ]);
  assert.equal(
    review.headline,
    '3 conversations need your reply. CallGrid billed 38 calls yesterday. You are waiting on 2. 6 meetings today.',
    'four facts at most, most important first',
  );
});

test('a source that could not be read contributes nothing -- and is said to be unavailable', () => {
  const review = composeReview([
    { source: 'MAIL', state: 'UNAVAILABLE', note: 'Loop could not read your mail.', facts: [{ rank: 1, sentence: 'SHOULD NOT APPEAR' }] },
    { source: 'CALENDAR', state: 'OK', facts: [{ rank: 40, sentence: '2 meetings today.' }] },
  ]);
  assert.equal(review.headline, '2 meetings today.');
  assert.deepEqual(review.sources[0], { source: 'MAIL', state: 'UNAVAILABLE', note: 'Loop could not read your mail.' });
  assert.equal(composeReview([]).headline, null, 'nothing read, nothing said');
});

test('Need Attention is the feed itself, counted -- the card and the list cannot disagree', () => {
  const review = composeReview([
    { source: 'MAIL', state: 'OK', attention: [attention('a', 1, 5), attention('b', 3, 50)] },
    { source: 'WORK', state: 'OK', attention: [attention('c', 2, 80, 'WORK')], attentionCount: 7 },
  ]);
  assert.deepEqual(review.attention.map((a) => a.key), ['a', 'c', 'b'], 'by rank, then longest waiting');
  assert.equal(review.attentionTotal, 9, 'two listed from mail, seven held by work');
  assert.deepEqual(review.metrics.needAttention, { state: 'VALUE', value: 9, prior: null, href: '#needs-attention', scope: 'across the sources Loop read' });
  assert.equal(composeReview([{ source: 'CALENDAR', state: 'OK' }]).metrics.needAttention.state, 'UNAVAILABLE', 'no attention source was read');
});

test('a card no source can fill says so, and opportunities are not tracked until a source provides them', () => {
  const review = composeReview([{ source: 'CALENDAR', state: 'OK' }]);
  assert.equal(review.metrics.newOpportunities.state, 'NOT_TRACKED');
  assert.equal(review.metrics.relevantEmails.state, 'NOT_TRACKED');
  const withMail = composeReview([
    { source: 'MAIL', state: 'OK', metrics: { newOpportunities: { state: 'VALUE', value: 2, prior: null, href: '/app/mail?view=opportunities', scope: 'from your mail' } } },
  ]);
  assert.equal(withMail.metrics.newOpportunities.state, 'VALUE');
});

test('updates are newest first, and capped', () => {
  const contributions: ReviewContribution[] = [
    { source: 'MAIL', state: 'OK', updates: Array.from({ length: 10 }, (_, i) => ({ key: `m${i}`, source: 'MAIL' as const, at: at(i), who: 'w', what: 'x', status: 'Replied', tone: 'neutral' as const, href: null })) },
  ];
  const review = composeReview(contributions);
  assert.equal(review.updates.length, 8);
  assert.equal(review.updates[0]!.key, 'm0');
});

test('relevant mail is decided by the Mail dashboard’s own notification rule, plus spam and trash', () => {
  const person = (labels: string[], fromAddress: string | null = 'ben@cashion.example') => ({ labels, fromAddress });
  assert.equal(isRelevantMail(person(['INBOX'])), true);
  assert.equal(isRelevantMail(person(['INBOX', 'CATEGORY_PERSONAL'])), true);
  assert.equal(isRelevantMail(person(['INBOX'], null)), true, 'an unknown sender is not presumed automated');
  for (const noise of ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'CATEGORY_UPDATES', 'SPAM', 'TRASH']) {
    assert.equal(isRelevantMail(person(['INBOX', noise])), false, noise);
  }
  assert.equal(isRelevantMail(person(['INBOX'], 'no-reply@payments.example')), false, 'an automated sender in Primary is still notification mail');
  // The same message, judged by the Mail dashboard's rule, reaches the same answer.
  for (const m of [person(['INBOX']), person(['INBOX', 'CATEGORY_UPDATES']), person(['INBOX'], 'notifications@x.example')]) {
    assert.equal(isRelevantMail(m), notificationMessageReason(m) === null);
  }
});

test('mail activity counts relevant arrivals, and only conversations the employee started', () => {
  const window = { from: at(24), to: NOW };
  const firstMessageAt = new Map([
    ['started', at(3)],
    ['old-thread', at(2)], // Loop's read began after the conversation did: its first STORED message is a reply
  ]);
  const counts = mailActivity(
    [
      { threadId: 'x', internalDate: at(1), direction: 'INBOUND', labels: ['INBOX'], fromAddress: 'ben@cashion.example' },
      { threadId: 'y', internalDate: at(2), direction: 'INBOUND', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] },
      { threadId: 'r', internalDate: at(2), direction: 'INBOUND', labels: ['INBOX'], fromAddress: 'no-reply@payments.example' },
      { threadId: 'z', internalDate: at(30), direction: 'INBOUND', labels: ['INBOX'] }, // outside the window
      { threadId: 'started', internalDate: at(3), direction: 'OUTBOUND', labels: ['SENT'], inReplyTo: null },
      { threadId: 'old-thread', internalDate: at(2), direction: 'OUTBOUND', labels: ['SENT'], inReplyTo: '<older@x>' },
    ],
    firstMessageAt,
    window,
  );
  assert.deepEqual(counts, { relevantInbound: 1, conversationsStarted: 1 });
});

test('names are quoted exactly, and the rest are counted', () => {
  assert.equal(namedList(['Cashion pricing']), '“Cashion pricing”');
  assert.equal(namedList(['A', 'B']), '“A” and “B”');
  assert.equal(namedList(['A', 'B', 'C', 'D']), '“A”, “B” and 2 more');
  assert.equal(namedList([]), '');
});

test('the review period starts at the beginning of yesterday in the reader’s own zone', async () => {
  const { reviewPeriod } = await import('../src/executive-review');
  const now = new Date('2026-09-18T15:30:00Z'); // 11:30 in New York, 00:30 on the 19th in Tokyo
  assert.equal(reviewPeriod(now, 'America/New_York').from.toISOString(), '2026-09-17T04:00:00.000Z');
  assert.equal(reviewPeriod(now, 'Asia/Tokyo').from.toISOString(), '2026-09-17T15:00:00.000Z');
  assert.equal(reviewPeriod(now, 'UTC').to, now);
});

test('an item under Needs attention is not repeated under Key updates', () => {
  const at0 = new Date('2026-09-18T12:00:00Z');
  const review = composeReview([
    {
      source: 'MAIL',
      state: 'OK',
      attention: [{ key: 'mail:t1', source: 'MAIL', rank: 1, since: at0, who: 'Ben', happened: 'x', next: 'Reply', tone: 'critical', href: '/app/mail/t1' }],
      updates: [
        { key: 'mail:t1', source: 'MAIL', at: at0, who: 'Ben', what: 'x', status: 'Needs reply', tone: 'critical', href: '/app/mail/t1' },
        { key: 'mail:t2', source: 'MAIL', at: at0, who: 'Kim', what: 'y', status: 'Waiting', tone: 'attention', href: '/app/mail/t2' },
      ],
    },
  ]);
  assert.deepEqual(review.updates.map((u) => u.key), ['mail:t2']);
  assert.deepEqual(review.attention.map((a) => a.key), ['mail:t1']);
});

test('what Home has no room for is counted, per source, with the way to it', () => {
  const at0 = new Date('2026-09-18T12:00:00Z');
  const item = (key: string) => ({ key, source: 'MAIL' as const, rank: 1, since: at0, who: 'x', happened: 'y', next: 'Reply', tone: 'critical' as const, href: null });
  const review = composeReview(
    [
      { source: 'MAIL', state: 'OK', attention: [item('a'), item('b')], attentionCount: 6, attentionHref: '/app/mail' },
      { source: 'WORK', state: 'OK', attention: [] },
    ],
    { facts: 4, updates: 8, attention: 1 },
  );
  assert.equal(review.attentionTotal, 6);
  assert.deepEqual(review.attentionElsewhere, [{ source: 'MAIL', count: 5, href: '/app/mail' }]);
});

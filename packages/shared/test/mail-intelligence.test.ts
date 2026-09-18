// Mail intelligence: every lane, signal and area is a rule over stored facts, and every rule is
// pinned here -- including the ones that must NOT fire (notification mail is never "needs reply",
// promotional mail is never an opportunity) and the employee's corrections, which always win.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAIL_INTELLIGENCE_POLICY,
  NO_CORRECTIONS,
  classifyMailThread,
  isAutomatedAddress,
  mailAreas,
  mailViewRows,
  notificationReason,
  parseMailView,
  recentImportant,
  summarizeMail,
  type MailMessageEvidence,
  type MailThreadEvidence,
} from '../src/mail-intelligence';

const NOW = new Date('2026-09-18T16:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const inbound = (at: Date, over: Partial<MailMessageEvidence> = {}): MailMessageEvidence => ({
  at,
  direction: 'INBOUND',
  fromAddress: 'ben@cashion.example',
  fromName: 'Ben Cashion',
  labels: ['INBOX'],
  inReplyTo: '<prev@x>',
  ...over,
});
const outbound = (at: Date, over: Partial<MailMessageEvidence> = {}): MailMessageEvidence => ({
  at,
  direction: 'OUTBOUND',
  fromAddress: null,
  fromName: null,
  labels: ['SENT'],
  inReplyTo: '<prev@x>',
  ...over,
});

function thread(messages: MailMessageEvidence[], over: Partial<MailThreadEvidence> = {}): MailThreadEvidence {
  const last = messages.at(-1)!;
  return {
    threadId: 't1',
    subject: 'Cashion pricing',
    lastMessageAt: last.at,
    lastDirection: last.direction,
    unread: false,
    messages,
    people: [{ address: 'ben@cashion.example', name: 'Ben Cashion' }],
    ...over,
  };
}

const classify = (t: MailThreadEvidence, corrections = NO_CORRECTIONS) => classifyMailThread(t, corrections, NOW, ['elitemediagroup.io']);

// --- 4. Needs Reply ---------------------------------------------------------------------------

test('4. they wrote last: unread at once, otherwise after four hours -- with the reason', () => {
  const unread = classify(thread([outbound(ago(2 * D), { inReplyTo: null }), inbound(ago(1 * H))], { unread: true }));
  assert.equal(unread.lane, 'NEEDS_REPLY');
  assert.equal(unread.laneReason, 'UNREAD_INBOUND');

  assert.equal(classify(thread([inbound(ago(2 * H), { inReplyTo: null })])).lane, null, 'read, and only two hours old');
  const unanswered = classify(thread([inbound(ago(5 * H), { inReplyTo: null })]));
  assert.equal(unanswered.lane, 'NEEDS_REPLY');
  assert.equal(unanswered.laneReason, 'INBOUND_UNANSWERED');
  assert.equal(unanswered.laneAt!.getTime(), ago(5 * H).getTime());

  const outreachReply = classify(thread([outbound(ago(3 * D), { inReplyTo: null }), inbound(ago(6 * H))]));
  assert.equal(outreachReply.laneReason, 'OUTREACH_REPLY_UNANSWERED', 'they replied to a conversation you started');
});

test('4. notification mail is never "needs reply", however unread', () => {
  for (const [label, message] of [
    ['a noreply sender', inbound(ago(6 * H), { fromAddress: 'noreply@netlify.com', inReplyTo: null })],
    ['GitHub notifications', inbound(ago(6 * H), { fromAddress: 'notifications@github.com', inReplyTo: null })],
    ['LinkedIn', inbound(ago(6 * H), { fromAddress: 'messages-noreply@linkedin.com', inReplyTo: null })],
    ['a bounce', inbound(ago(6 * H), { fromAddress: 'mailer-daemon@googlemail.com', inReplyTo: null })],
    ['Gmail Promotions', inbound(ago(6 * H), { fromAddress: 'hello@brand.example', labels: ['INBOX', 'CATEGORY_PROMOTIONS'], inReplyTo: null })],
    ['Gmail Updates (receipts, alerts)', inbound(ago(6 * H), { fromAddress: 'billing@vendor.example', labels: ['INBOX', 'CATEGORY_UPDATES'], inReplyTo: null })],
    ['Gmail Social', inbound(ago(6 * H), { fromAddress: 'hi@social.example', labels: ['CATEGORY_SOCIAL'], inReplyTo: null })],
  ] as const) {
    const insight = classify(thread([message], { unread: true }));
    assert.equal(insight.lane, null, label);
    assert.ok(insight.notification, `${label}: says why`);
  }
});

test('4. a conversation the employee has written in is people talking, whatever Gmail filed it under', () => {
  const t = thread([outbound(ago(3 * D), { inReplyTo: null }), inbound(ago(6 * H), { labels: ['INBOX', 'CATEGORY_UPDATES'] })]);
  assert.equal(notificationReason(t), null);
  assert.equal(classify(t).lane, 'NEEDS_REPLY');
});

test('automated addresses are matched as whole segments, and ordinary ones are not', () => {
  for (const a of ['noreply@x.com', 'no-reply@x.com', 'do-not-reply@x.com', 'messages-noreply@linkedin.com', 'notifications@github.com', 'alerts@bank.com', 'newsletter@x.com', 'bounces+123@x.com']) {
    assert.equal(isAutomatedAddress(a), true, a);
  }
  for (const a of ['info@brand.com', 'ben@cashion.example', 'replyall@x.com', 'norepl@x.com', 'support@vendor.com', null]) {
    assert.equal(isAutomatedAddress(a as string | null), false, String(a));
  }
});

// --- 5 and 6. Follow-Ups Due versus Waiting --------------------------------------------------

test('6. you wrote last, recently: waiting on them -- not yet a follow-up', () => {
  const insight = classify(thread([inbound(ago(3 * D), { inReplyTo: null }), outbound(ago(1 * D))]));
  assert.equal(insight.lane, 'WAITING');
  assert.equal(insight.laneReason, 'AWAITING_RESPONSE');
});

test('5. you wrote last, three days or more with no answer: a follow-up is due', () => {
  const outreach = classify(thread([outbound(ago(4 * D), { inReplyTo: null })]));
  assert.equal(outreach.lane, 'FOLLOW_UP');
  assert.equal(outreach.laneReason, 'OUTREACH_NO_RESPONSE', 'first outreach, never answered');

  const midConversation = classify(thread([inbound(ago(9 * D), { inReplyTo: null }), outbound(ago(5 * D))]));
  assert.equal(midConversation.lane, 'FOLLOW_UP');
  assert.equal(midConversation.laneReason, 'NO_RESPONSE_SINCE');

  assert.equal(classify(thread([outbound(ago(50 * D), { inReplyTo: null })])).lane, null, 'nothing past the horizon');
  assert.equal(classify(thread([outbound(ago(MAIL_INTELLIGENCE_POLICY.followUpAfterMs - H), { inReplyTo: null })])).lane, 'WAITING', 'one hour before it is due');
});

// --- 9. Corrections --------------------------------------------------------------------------

test('9. corrections are authoritative: handled stays handled until something new arrives', () => {
  const t = thread([inbound(ago(6 * H), { inReplyTo: null })]);
  assert.equal(classify(t, { ...NO_CORRECTIONS, closed: [{ class: 'NEEDS_YOU', at: ago(1 * H) }] }).lane, null, 'handled after their message');
  assert.equal(classify(t, { ...NO_CORRECTIONS, closed: [{ class: 'NEEDS_YOU', at: ago(7 * H) }] }).lane, 'NEEDS_REPLY', 'a newer message reopens it');

  assert.equal(classify(t, { ...NO_CORRECTIONS, snoozedUntil: new Date(NOW.getTime() + H) }).lane, null, 'snoozed');
  assert.equal(classify(t, { ...NO_CORRECTIONS, snoozedUntil: ago(H) }).lane, 'NEEDS_REPLY', 'awake again');

  const waiting = classify(t, { ...NO_CORRECTIONS, waitingOnThemAt: ago(1 * H) });
  assert.equal(waiting.lane, 'WAITING', '"I\'m waiting on them" is respected');
  assert.equal(waiting.laneReason, 'MARKED_WAITING');

  const due = thread([outbound(ago(4 * D), { inReplyTo: null })]);
  assert.equal(classify(due, { ...NO_CORRECTIONS, closed: [{ class: 'WAITING_ON_THEM', at: ago(1 * D) }] }).lane, null, 'follow-up handled');
  assert.equal(classify(due, { ...NO_CORRECTIONS, closed: [{ class: 'GONE_QUIET', at: ago(1 * D) }] }).lane, null);
});

// --- 7 and 8. Opportunities --------------------------------------------------------------------

test('7. a new inbound conversation about something commercial is an opportunity, with the word that made it one', () => {
  const insight = classify(thread([inbound(ago(3 * H), { fromAddress: 'liz@airbnb.com', fromName: 'Liz', inReplyTo: null })], { subject: 'Partnership inquiry: Trevon Hill x Airbnb' }));
  assert.deepEqual(insight.opportunity, { kind: 'INBOUND_INQUIRY', at: ago(3 * H), matched: 'partnership' });
  assert.equal(insight.counterpart!.domain, 'airbnb.com');
});

test('7. a reply to outreach the employee started is an opportunity', () => {
  const insight = classify(thread([outbound(ago(4 * D), { inReplyTo: null }), inbound(ago(2 * H), { fromAddress: 'buyer@acme.example' })], { subject: 'Following up' }));
  assert.equal(insight.opportunity!.kind, 'OUTREACH_REPLY');
  assert.equal(insight.opportunity!.at.getTime(), ago(2 * H).getTime());
});

test('8. ordinary, promotional and automated mail is never an opportunity', () => {
  const subjectOnly = (subject: string, over: Partial<MailMessageEvidence> = {}) =>
    classify(thread([inbound(ago(3 * H), { fromAddress: 'someone@brand.example', inReplyTo: null, ...over })], { subject })).opportunity;
  assert.equal(subjectOnly('Lunch on Friday?'), null, 'no commercial word');
  assert.equal(subjectOnly('New campaign: 20% off everything', { labels: ['CATEGORY_PROMOTIONS'] }), null, 'Gmail Promotions');
  assert.equal(subjectOnly('Partnership opportunities in 2026', { fromAddress: 'newsletter@brand.example' }), null, 'a newsletter');
  assert.equal(subjectOnly('Your campaign report', { fromAddress: 'noreply@ads.example' }), null, 'an automated report');
  // A colleague is never an opportunity, even replying to your outreach.
  const colleague = classify(thread([outbound(ago(2 * D), { inReplyTo: null }), inbound(ago(1 * H), { fromAddress: 'charlie@elitemediagroup.io' })]));
  assert.equal(colleague.opportunity, null);
  // And a signal older than the window has stopped being new.
  assert.equal(subjectOnly('Partnership inquiry', { at: ago(20 * D) } as never), null);
});

// --- Areas ---------------------------------------------------------------------------------------

test('areas come from whole words in the subject, and say which word', () => {
  assert.deepEqual(mailAreas('Re: MSA / IOs'), [
    { area: 'PERFORMANCE', matched: 'ios' },
    { area: 'OPERATIONS', matched: 'msa' },
  ]);
  assert.deepEqual(mailAreas('Creator program for TikTok'), [{ area: 'TALENT', matched: 'creator' }]);
  assert.deepEqual(mailAreas('Studio booking'), [], '"io" inside "Studio" is not a word');
  assert.deepEqual(mailAreas(null), []);
});

// --- 1, 2 and 3. Views, search and counts --------------------------------------------------------

function fixture() {
  const rows: MailThreadEvidence[] = [
    thread([inbound(ago(6 * H), { inReplyTo: null })], { threadId: 'reply', subject: 'Re: IOs for October', unread: true }),
    thread([outbound(ago(4 * D), { inReplyTo: null })], { threadId: 'followup', subject: 'Creator program' }),
    thread([inbound(ago(3 * D), { inReplyTo: null }), outbound(ago(10 * H))], { threadId: 'waiting', subject: 'Invoice 1042' }),
    thread([inbound(ago(2 * H), { fromAddress: 'liz@airbnb.com', inReplyTo: null })], { threadId: 'opp', subject: 'Collaboration inquiry' }),
    thread([inbound(ago(1 * H), { fromAddress: 'notifications@github.com', inReplyTo: null })], { threadId: 'noise', subject: 'Workflow failed: campaign', unread: true }),
  ];
  return rows.map((t) => classify(t));
}

test('1. the summary counts the lanes, the signals and the areas -- and never notification mail', () => {
  const s = summarizeMail(fixture(), NOW);
  assert.deepEqual(
    { needsReply: s.needsReply, followUps: s.followUps, waiting: s.waiting, opportunities: s.opportunities, conversations: s.conversations },
    { needsReply: 1, followUps: 1, waiting: 1, opportunities: 1, conversations: 4 },
    'only the unread IO reply: the Airbnb inquiry is read and two hours old, so it does not need a reply yet',
  );
});

test('1. inflow is a fact about the last day, per card', () => {
  const s = summarizeMail(fixture(), NOW);
  assert.equal(s.inflow.needsReply, 1, 'the IO reply arrived six hours ago');
  assert.equal(s.inflow.waiting, 1, 'you wrote the invoice reply ten hours ago');
  assert.equal(s.inflow.opportunities, 1);
  assert.equal(s.inflow.followUps, 1, 'the creator outreach became due in the last day');
});

test('2 and 3. each view filters, search narrows, and notification mail is opt-in', () => {
  const insights = fixture();
  const ids = (view: string, extra: Partial<{ query: string; unreadOnly: boolean; includeNotifications: boolean }> = {}) =>
    mailViewRows(insights, { view: parseMailView(view), query: '', unreadOnly: false, includeNotifications: false, ...extra }).map((i) => i.threadId);
  assert.deepEqual(ids('needs-reply'), ['reply']);
  assert.deepEqual(ids('follow-ups'), ['followup']);
  assert.deepEqual(ids('waiting'), ['waiting']);
  assert.deepEqual(ids('opportunities'), ['opp']);
  assert.deepEqual(ids('performance'), ['reply']);
  assert.deepEqual(ids('operations'), ['waiting']);
  assert.deepEqual(ids('talent'), ['opp', 'followup'], '"collaboration" is a talent word; newest first');
  assert.equal(ids('all').includes('noise'), false, 'notification mail stays out by default');
  assert.equal(ids('all', { includeNotifications: true }).includes('noise'), true);
  assert.deepEqual(ids('all', { query: 'AIRBNB' }), ['opp'], 'search is case-insensitive over subject, person and domain');
  assert.deepEqual(ids('all', { unreadOnly: true }), ['reply']);
  assert.equal(parseMailView('nonsense'), 'dashboard');
});

test('recent important conversations are people talking, never notification mail', () => {
  const recent = recentImportant(fixture(), NOW).map((i) => i.threadId);
  assert.equal(recent.includes('noise'), false);
  assert.ok(recent.includes('reply') && recent.includes('opp'));
});

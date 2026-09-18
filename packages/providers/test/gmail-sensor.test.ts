// The Gmail adapter: what it asks Google for, what it makes of the answer, and what it refuses.
//
// WHAT THESE PROVE
//
// Every request shape, against a recorded fetch: bounded pages, a bounded message count, the
// metadata-only sync read (Gmail cannot return a body for a request that does not ask for one),
// Google's own incremental mechanism, and the 404 that means a history position is gone.
//
// And the refusals: a mailbox that answers 401, 403, 429 or nonsense produces a CLASS, never a
// half-read page presented as a mailbox.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GOOGLE_GMAIL_MAX_MESSAGES_PER_PASS,
  gmailMessageBody,
  gmailMessageFact,
  readGoogleGmailChanges,
  readGoogleGmailThread,
  readGoogleGmailWindow,
  sendGoogleGmailMessage,
} from '../src/google-workspace/gmail';

const SELF = 'matt@elitemediagroup.io';
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

interface Call {
  url: string;
  method: string;
  body?: string;
}

/** A recording fetch: every request is kept, and answers are queued per path. */
function world(answers: { match: RegExp; status?: number; payload: unknown }[]) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body });
    const answer = answers.find((a) => a.match.test(url));
    if (!answer) throw new Error(`no answer for ${url}`);
    return { status: answer.status ?? 200, json: async () => answer.payload };
  };
  return { calls, fetchImpl, urls: () => calls.map((c) => c.url) };
}

const message = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  threadId: over.threadId ?? 't1',
  internalDate: String(Date.UTC(2026, 8, 18, 12, 0)),
  labelIds: over.labelIds ?? ['INBOX', 'UNREAD'],
  payload: {
    headers: [
      { name: 'From', value: 'Ben Cashion <ben@cashion.example>' },
      { name: 'To', value: SELF },
      { name: 'Cc', value: 'trevon@cashion.example' },
      { name: 'Subject', value: 'Cashion pricing' },
      { name: 'Message-ID', value: `<${id}@mail.gmail.com>` },
      { name: 'In-Reply-To', value: '<prev@mail.gmail.com>' },
      { name: 'References', value: '<first@mail.gmail.com> <prev@mail.gmail.com>' },
    ],
  },
  ...over,
});

test('the first read is bounded by age, by pages and by messages, and asks for metadata only', async () => {
  const w = world([
    { match: /\/profile/, payload: { emailAddress: SELF, historyId: '9001' } },
    { match: /\/messages\?/, payload: { messages: [{ id: 'a' }, { id: 'b' }] } },
    { match: /\/messages\//, payload: message('a') },
  ]);
  const result = await readGoogleGmailWindow({ fetchImpl: w.fetchImpl, accessToken: 'token', selfAddress: SELF, newerThanDays: 14 });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  // The boundary is read BEFORE the listing, so a message that arrives mid-read is replayed.
  assert.match(w.urls()[0]!, /\/profile$/);
  assert.equal(result.page.nextHistoryId, '9001');

  const list = w.urls().find((u) => /\/messages\?/.test(u))!;
  assert.match(list, /q=newer_than%3A14d/, 'bounded by age');
  assert.match(list, /maxResults=100/);

  const get = w.urls().find((u) => /\/messages\/a\?/.test(u))!;
  assert.match(get, /format=metadata/, 'the sync read never asks for a body');
  for (const header of ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'In-Reply-To', 'References']) {
    assert.match(get, new RegExp(`metadataHeaders=${encodeURIComponent(header)}`), header);
  }
  assert.equal(/format=full/.test(get), false);
});

test('a message becomes the facts Loop states, and nothing more', async () => {
  const fact = gmailMessageFact(message('a'), SELF);
  assert.ok(fact);
  assert.equal(fact!.messageId, 'a');
  assert.equal(fact!.threadId, 't1');
  assert.equal(fact!.subject, 'Cashion pricing');
  assert.deepEqual(fact!.from, { address: 'ben@cashion.example', name: 'Ben Cashion' });
  assert.deepEqual(fact!.to.map((a) => a.address), [SELF]);
  assert.deepEqual(fact!.cc.map((a) => a.address), ['trevon@cashion.example']);
  assert.equal(fact!.headerMessageId, '<a@mail.gmail.com>');
  assert.equal(fact!.inReplyTo, '<prev@mail.gmail.com>');
  assert.deepEqual(fact!.references, ['<first@mail.gmail.com>', '<prev@mail.gmail.com>']);
  assert.deepEqual(fact!.labels, ['INBOX', 'UNREAD']);
  assert.equal(fact!.fromSelf, false);
  assert.equal(fact!.internalDate.toISOString(), '2026-09-18T12:00:00.000Z');
  assert.equal('body' in fact!, false);

  // Sent by the connected account: either Gmail's own SENT label or the From address says so.
  assert.equal(gmailMessageFact(message('b', { labelIds: ['SENT'] }), SELF)!.fromSelf, true);
  const mine = message('c');
  mine.payload.headers[0] = { name: 'From', value: `Matt <${SELF}>` };
  assert.equal(gmailMessageFact(mine, SELF)!.fromSelf, true);

  // A duplicated header cannot displace the real one.
  const forged = message('d');
  forged.payload.headers.push({ name: 'From', value: 'attacker@evil.example' });
  assert.equal(gmailMessageFact(forged, SELF)!.from!.address, 'ben@cashion.example');

  // Not a message this contract can state.
  for (const broken of [{}, { id: 'x' }, { id: 'x', threadId: 't', internalDate: 'not-a-number' }]) {
    assert.equal(gmailMessageFact(broken as Record<string, unknown>, SELF), null, JSON.stringify(broken));
  }
});

test('pagination stops at the page bound and says it was truncated, storing no boundary', async () => {
  const w = world([
    { match: /\/profile/, payload: { historyId: '9001' } },
    { match: /\/messages\?/, payload: { messages: [{ id: 'a' }], nextPageToken: 'more' } },
    { match: /\/messages\//, payload: message('a') },
  ]);
  const result = await readGoogleGmailWindow({ fetchImpl: w.fetchImpl, accessToken: 't', selfAddress: SELF, maxPages: 2 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.truncated, true);
  assert.equal(result.page.nextHistoryId, null, 'a truncated read stores no cursor');
  assert.equal(result.page.pagesRead, 2);
  assert.equal(w.urls().filter((u) => /\/messages\?/.test(u)).length, 2);
});

test('the message ceiling bounds one pass however many the mailbox has', async () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ id: `m${i}` }));
  const w = world([
    { match: /\/profile/, payload: { historyId: '1' } },
    { match: /\/messages\?/, payload: { messages: many } },
    { match: /\/messages\//, payload: message('a') },
  ]);
  const result = await readGoogleGmailWindow({ fetchImpl: w.fetchImpl, accessToken: 't', selfAddress: SELF, maxMessages: 25 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.truncated, true);
  assert.equal(w.urls().filter((u) => /\/messages\/m/.test(u)).length, 25);
  assert.ok(GOOGLE_GMAIL_MAX_MESSAGES_PER_PASS <= 250, 'the default ceiling stays bounded');
});

test('the incremental read is Gmail’s history, and it collects changes and deletions', async () => {
  const w = world([
    {
      match: /\/history\?/,
      payload: {
        historyId: '9100',
        history: [
          { id: '1', messagesAdded: [{ message: { id: 'new1', threadId: 't1' } }] },
          { id: '2', labelsRemoved: [{ message: { id: 'read1', threadId: 't2' }, labelIds: ['UNREAD'] }] },
          { id: '3', messagesDeleted: [{ message: { id: 'gone1', threadId: 't3' } }] },
        ],
      },
    },
    { match: /\/messages\//, payload: message('new1') },
  ]);
  const result = await readGoogleGmailChanges({ fetchImpl: w.fetchImpl, accessToken: 't', selfAddress: SELF, startHistoryId: '9001' });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const url = w.urls()[0]!;
  assert.match(url, /startHistoryId=9001/);
  for (const type of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) {
    assert.match(url, new RegExp(`historyTypes=${type}`), type);
  }
  assert.equal(result.page.nextHistoryId, '9100');
  assert.deepEqual(result.page.removedMessageIds, ['gone1']);
  // A message whose labels changed is re-read, because "unread" is what changed about it.
  assert.equal(w.urls().filter((u) => /\/messages\/(new1|read1)/.test(u)).length, 2);
  assert.equal(w.urls().some((u) => /\/messages\/gone1/.test(u)), false, 'a deleted message is not fetched');
});

test('a deletion later in the same page wins over an earlier change to the same message', async () => {
  const w = world([
    {
      match: /\/history\?/,
      payload: {
        historyId: '20',
        history: [
          { id: '1', messagesAdded: [{ message: { id: 'x', threadId: 't' } }] },
          { id: '2', messagesDeleted: [{ message: { id: 'x', threadId: 't' } }] },
        ],
      },
    },
  ]);
  const result = await readGoogleGmailChanges({ fetchImpl: w.fetchImpl, accessToken: 't', selfAddress: SELF, startHistoryId: '1' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.page.removedMessageIds, ['x']);
  assert.deepEqual(result.page.messages, []);
  assert.equal(w.urls().some((u) => /\/messages\/x/.test(u)), false);
});

test('a history position Gmail no longer keeps is CURSOR_EXPIRED, not an empty mailbox', async () => {
  const w = world([{ match: /\/history\?/, status: 404, payload: { error: { code: 404, message: 'Requested entity was not found.' } } }]);
  const result = await readGoogleGmailChanges({ fetchImpl: w.fetchImpl, accessToken: 't', selfAddress: SELF, startHistoryId: 'ancient' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure, 'CURSOR_EXPIRED');
});

test('every provider refusal keeps its class, and none of them is an empty inbox', async () => {
  const cases: [number, unknown, string][] = [
    [401, {}, 'AUTH'],
    [403, { error: { errors: [{ reason: 'forbidden' }] } }, 'FORBIDDEN'],
    [403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 'RATE_LIMITED'],
    [429, {}, 'RATE_LIMITED'],
    [500, {}, 'UNAVAILABLE'],
    [503, {}, 'UNAVAILABLE'],
  ];
  for (const [status, payload, expected] of cases) {
    const w = world([{ match: /\/profile/, status, payload }]);
    const result = await readGoogleGmailWindow({ fetchImpl: w.fetchImpl, accessToken: 't', selfAddress: SELF });
    assert.equal(result.ok, false, `${status}`);
    if (!result.ok) assert.equal(result.failure, expected, `${status}`);
  }

  // A 200 carrying something this contract cannot read is MALFORMED, never a partial answer.
  const malformed = world([{ match: /\/profile/, payload: 'not an object' }]);
  const result = await readGoogleGmailWindow({ fetchImpl: malformed.fetchImpl, accessToken: 't', selfAddress: SELF });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure, 'MALFORMED');

  // A network error and a timeout are different facts.
  const boom = async () => {
    throw new Error('econnreset');
  };
  const network = await readGoogleGmailWindow({ fetchImpl: boom as never, accessToken: 't', selfAddress: SELF });
  assert.equal(network.ok, false);
  if (!network.ok) assert.equal(network.failure, 'NETWORK');
  const abort = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  const timeout = await readGoogleGmailWindow({ fetchImpl: abort as never, accessToken: 't', selfAddress: SELF });
  assert.equal(timeout.ok, false);
  if (!timeout.ok) assert.equal(timeout.failure, 'TIMEOUT');
});

test('a thread read carries bodies and attachment FACTS, in the order the conversation happened', async () => {
  const withBody = (id: string, at: number, text: string) => ({
    id,
    threadId: 't1',
    internalDate: String(at),
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'ben@cashion.example' },
        { name: 'To', value: SELF },
        { name: 'Subject', value: 'Cashion pricing' },
      ],
      parts: [
        { mimeType: 'multipart/alternative', body: {}, parts: [
          { mimeType: 'text/plain', body: { data: b64(text), size: text.length } },
          { mimeType: 'text/html', body: { data: b64(`<p>${text}</p>`), size: text.length + 7 } },
        ] },
        { mimeType: 'application/pdf', filename: 'rates.pdf', body: { size: 81_234, attachmentId: 'att1' } },
      ],
    },
  });
  const w = world([
    {
      match: /\/threads\//,
      payload: { id: 't1', messages: [withBody('m2', Date.UTC(2026, 8, 18, 13), 'second'), withBody('m1', Date.UTC(2026, 8, 18, 12), 'first')] },
    },
  ]);
  const result = await readGoogleGmailThread({ fetchImpl: w.fetchImpl, accessToken: 't', selfAddress: SELF, threadId: 't1' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(w.urls()[0]!, /format=full/);
  assert.deepEqual(result.thread.messages.map((m) => m.fact.messageId), ['m1', 'm2'], 'oldest first');
  assert.equal(result.thread.messages[0]!.body.text, 'first');
  assert.equal(result.thread.messages[0]!.body.html, '<p>first</p>');
  assert.deepEqual(result.thread.messages[0]!.body.attachments, [{ filename: 'rates.pdf', mimeType: 'application/pdf', bytes: 81_234 }]);
  // No attachment was fetched: a name, a type and a size are the whole claim.
  assert.equal(w.urls().some((u) => /attachment/i.test(u)), false);
});

test('a MIME tree that is hostile or deep is bounded rather than followed', () => {
  // A tree deeper than the walk goes is truncated, not crawled.
  let deep: Record<string, unknown> = { mimeType: 'text/plain', body: { data: b64('bottom'), size: 6 } };
  for (let i = 0; i < 40; i += 1) deep = { mimeType: 'multipart/mixed', body: {}, parts: [deep] };
  const bounded = gmailMessageBody('m1', deep);
  assert.equal(bounded.truncated, true);

  // An enormous body is capped, and says so.
  const huge = 'x'.repeat(300_000);
  const capped = gmailMessageBody('m2', { mimeType: 'text/plain', body: { data: b64(huge), size: huge.length } });
  assert.equal(capped.truncated, true);
  assert.equal(capped.text!.length, 200_000);

  // Undecodable content is absent rather than guessed.
  const broken = gmailMessageBody('m3', { mimeType: 'text/plain', body: { data: 12 } });
  assert.equal(broken.text, null);
  assert.equal(broken.html, null);
});

test('send posts the raw message and the threadId, and reports what Gmail did', async () => {
  const w = world([{ match: /\/messages\/send/, payload: { id: 'sent1', threadId: 't1' } }]);
  const result = await sendGoogleGmailMessage({ fetchImpl: w.fetchImpl, accessToken: 't', rawMessage: 'cmF3', threadId: 't1' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.messageId, 'sent1');
  assert.equal(result.threadId, 't1');
  const call = w.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.deepEqual(JSON.parse(call.body!), { raw: 'cmF3', threadId: 't1' });

  // A send Gmail refused is a failure with a class, never a silent success.
  const refused = world([{ match: /\/messages\/send/, status: 403, payload: { error: { errors: [{ reason: 'forbidden' }] } } }]);
  const failed = await sendGoogleGmailMessage({ fetchImpl: refused.fetchImpl, accessToken: 't', rawMessage: 'cmF3', threadId: null });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.failure, 'FORBIDDEN');

  // A 200 that does not say what was sent is MALFORMED: Loop will not claim a send it cannot cite.
  const vague = world([{ match: /\/messages\/send/, payload: { ok: true } }]);
  const unproven = await sendGoogleGmailMessage({ fetchImpl: vague.fetchImpl, accessToken: 't', rawMessage: 'cmF3', threadId: null });
  assert.equal(unproven.ok, false);
  if (!unproven.ok) assert.equal(unproven.failure, 'MALFORMED');
});

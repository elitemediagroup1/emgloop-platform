// Composing a reply Gmail will thread, and refusing one it would not.
//
// WHAT THESE PROVE
//
// Google's Message reference states the threading contract in three parts -- the threadId on the
// message, RFC 2822 References/In-Reply-To, and a matching Subject -- and all three are required.
// A reply that gets any of them wrong arrives as a NEW conversation, which nobody notices until a
// customer replies to the wrong thing. These check all three, on the wire format, by decoding
// what would actually be sent.
//
// And they prove the other half: a header value cannot be smuggled. Recipients, subjects and
// display names arrive from stored correspondence and from an employee's keyboard; a carriage
// return in any of them would end the header and begin another one -- a Bcc, or a second message.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GMAIL_MAX_BODY_CHARS,
  buildGmailReply,
  gmailEncodeHeaderWord,
  gmailFormatAddress,
  gmailReplyRecipients,
  gmailReplyReferences,
  gmailReplySubject,
  type GmailReplyTarget,
} from '../src/gmail-compose';

const SELF = { address: 'matt@elitemediagroup.io', name: 'Matt' };
const BEN = { address: 'ben@cashion.example', name: 'Ben Cashion' };
const TREVON = { address: 'trevon@cashion.example', name: null };
const LEXI = { address: 'lexi@elitemediagroup.io', name: 'Lexi' };

function target(over: Partial<GmailReplyTarget> = {}): GmailReplyTarget {
  return {
    messageId: 'm1',
    threadId: 't1',
    headerMessageId: '<CAG=abc@mail.gmail.com>',
    references: ['<first@mail.gmail.com>'],
    subject: 'Cashion pricing',
    from: BEN,
    to: [SELF],
    cc: [TREVON],
    ...over,
  };
}

/** What Gmail would actually receive, decoded back from base64url. */
function decode(raw: string): string {
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized + '='.repeat((4 - (normalized.length % 4)) % 4), 'base64').toString('utf8');
}

function sent(over: Parameters<typeof buildGmailReply>[0]) {
  const result = buildGmailReply(over);
  assert.equal(result.ok, true, `expected a message, got ${result.ok ? '' : result.refusal}`);
  if (!result.ok) throw new Error('unreachable');
  return { message: result.message, mime: decode(result.message.raw) };
}

test('a reply carries all three parts of Gmail’s threading contract', () => {
  const { message, mime } = sent({ target: target(), mode: 'REPLY', from: SELF, body: 'Thanks Ben -- pricing attached.' });

  // 1. the threadId travels with the message
  assert.equal(message.threadId, 't1');
  // 2. References is the original chain PLUS the message being answered, and In-Reply-To is it
  assert.match(mime, /^In-Reply-To: <CAG=abc@mail\.gmail\.com>$/m);
  assert.match(mime, /^References: <first@mail\.gmail\.com> <CAG=abc@mail\.gmail\.com>$/m);
  // 3. the subject matches, with exactly one Re:
  assert.match(mime, /^Subject: Re: Cashion pricing$/m);

  assert.match(mime, /^From: "Matt" <matt@elitemediagroup\.io>$/m);
  assert.match(mime, /^Content-Transfer-Encoding: base64$/m);
  const body = mime.slice(mime.indexOf('\r\n\r\n') + 4);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Thanks Ben -- pricing attached.');
});

test('Re: is added once and never stacked', () => {
  assert.equal(gmailReplySubject('Cashion pricing'), 'Re: Cashion pricing');
  assert.equal(gmailReplySubject('Re: Cashion pricing'), 'Re: Cashion pricing');
  assert.equal(gmailReplySubject('RE:Cashion pricing'), 'RE:Cashion pricing');
  assert.equal(gmailReplySubject(null), 'Re:');
});

test('the References chain is a chain: ordered, deduplicated, ending in the message answered', () => {
  assert.deepEqual(gmailReplyReferences(target({ references: ['<a@x>', '<b@x>'], headerMessageId: '<c@x>' })), ['<a@x>', '<b@x>', '<c@x>']);
  assert.deepEqual(gmailReplyReferences(target({ references: ['<a@x>', '<a@x>'], headerMessageId: '<a@x>' })), ['<a@x>']);
  assert.deepEqual(gmailReplyReferences(target({ references: [], headerMessageId: null })), []);
});

test('Reply answers the author; Reply All answers everyone who was on it, and never the sender', () => {
  const reply = gmailReplyRecipients(target(), 'REPLY', SELF.address);
  assert.deepEqual(reply.to.map((a) => a.address), ['ben@cashion.example']);
  assert.deepEqual(reply.cc, []);

  const all = gmailReplyRecipients(target({ to: [SELF, LEXI], cc: [TREVON] }), 'REPLY_ALL', SELF.address);
  assert.deepEqual(all.to.map((a) => a.address), ['ben@cashion.example']);
  assert.deepEqual(all.cc.map((a) => a.address), ['lexi@elitemediagroup.io', 'trevon@cashion.example']);
  // The employee never appears in their own reply, in either field, whatever case it arrived in.
  const shouty = gmailReplyRecipients(target({ to: [{ address: 'MATT@ELITEMEDIAGROUP.IO', name: null }, LEXI] }), 'REPLY_ALL', SELF.address);
  assert.equal([...shouty.to, ...shouty.cc].some((a) => a.address.includes('matt@')), false);
});

test('replying to your own message continues it rather than mailing yourself', () => {
  const mine = target({ from: SELF, to: [BEN], cc: [TREVON] });
  const reply = gmailReplyRecipients(mine, 'REPLY', SELF.address);
  assert.deepEqual(reply.to.map((a) => a.address), ['ben@cashion.example']);
  const all = gmailReplyRecipients(mine, 'REPLY_ALL', SELF.address);
  assert.deepEqual(all.to.map((a) => a.address), ['ben@cashion.example']);
  assert.deepEqual(all.cc.map((a) => a.address), ['trevon@cashion.example']);
});

test('an employee’s edited recipients are what is sent, and Cc appears only when there is one', () => {
  const { mime } = sent({
    target: target(),
    mode: 'REPLY',
    from: SELF,
    body: 'ok',
    to: [LEXI],
    cc: [],
  });
  assert.match(mime, /^To: "Lexi" <lexi@elitemediagroup\.io>$/m);
  assert.equal(/^Cc:/m.test(mime), false);
});

test('a header cannot be smuggled through a name, a subject or an address', () => {
  const injected = 'Ben\r\nBcc: attacker@evil.example';
  for (const attempt of [
    { target: target({ subject: injected }), mode: 'REPLY' as const, from: SELF, body: 'x' },
    { target: target({ from: { address: 'ben@cashion.example', name: injected } }), mode: 'REPLY' as const, from: SELF, body: 'x' },
    { target: target({ headerMessageId: '<a@x>\r\nBcc: attacker@evil.example' }), mode: 'REPLY' as const, from: SELF, body: 'x' },
    { target: target({ references: ['<a@x>\nBcc: attacker@evil.example'] }), mode: 'REPLY' as const, from: SELF, body: 'x' },
  ]) {
    const result = buildGmailReply(attempt);
    assert.equal(result.ok, false, JSON.stringify(attempt.target.subject));
    if (!result.ok) assert.equal(result.refusal, 'UNSAFE_HEADER');
  }
  // An address that is not an address is refused rather than written into a header.
  const bad = buildGmailReply({ target: target({ from: { address: 'not an address', name: null } }), mode: 'REPLY', from: SELF, body: 'x' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.refusal, 'INVALID_ADDRESS');
});

test('a body that would be a lie is refused rather than sent', () => {
  for (const [body, refusal] of [
    ['', 'EMPTY_BODY'],
    ['   \n  ', 'EMPTY_BODY'],
    ['x'.repeat(GMAIL_MAX_BODY_CHARS + 1), 'BODY_TOO_LONG'],
  ] as const) {
    const result = buildGmailReply({ target: target(), mode: 'REPLY', from: SELF, body });
    assert.equal(result.ok, false, refusal);
    if (!result.ok) assert.equal(result.refusal, refusal);
  }
  // Nobody to send to is not a send.
  const none = buildGmailReply({ target: target({ from: null, to: [] }), mode: 'REPLY', from: SELF, body: 'x' });
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.refusal, 'NO_RECIPIENT');
});

test('non-ASCII survives the wire in both the subject and the body', () => {
  const { mime } = sent({
    target: target({ subject: 'Café — pricing' }),
    mode: 'REPLY',
    from: { address: 'matt@elitemediagroup.io', name: 'Mätt' },
    body: 'Merci — à bientôt. 👍',
  });
  assert.match(mime, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
  const subject = /^Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/m.exec(mime)![1]!;
  assert.equal(Buffer.from(subject, 'base64').toString('utf8'), 'Re: Café — pricing');
  const body = mime.slice(mime.indexOf('\r\n\r\n') + 4);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Merci — à bientôt. 👍');
  assert.match(mime, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <matt@elitemediagroup\.io>$/m);
});

test('an address is written the way a header expects, and a hostile display name cannot restructure it', () => {
  assert.equal(gmailFormatAddress({ address: 'Ben@Cashion.Example', name: null }), 'ben@cashion.example');
  assert.equal(gmailFormatAddress({ address: 'ben@cashion.example', name: 'Cashion, Ben' }), '"Cashion, Ben" <ben@cashion.example>');
  assert.equal(gmailFormatAddress({ address: 'ben@cashion.example', name: 'Ben "The Closer"' }), '"Ben The Closer" <ben@cashion.example>');
  assert.equal(gmailEncodeHeaderWord('plain'), 'plain');
  assert.match(gmailEncodeHeaderWord('café'), /^=\?UTF-8\?B\?/);
});

test('a reply to a message Loop never saw the Message-ID of is still sent, without inventing one', () => {
  const { message, mime } = sent({
    target: target({ headerMessageId: null, references: [] }),
    mode: 'REPLY',
    from: SELF,
    body: 'ok',
  });
  assert.equal(/^In-Reply-To:/m.test(mime), false);
  assert.equal(/^References:/m.test(mime), false);
  assert.equal(message.threadId, 't1', 'the threadId and the subject still carry it');
  assert.match(mime, /^Subject: Re: Cashion pricing$/m);
});

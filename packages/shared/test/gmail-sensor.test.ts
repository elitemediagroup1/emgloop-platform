// The Gmail sensor contract: what Loop states about a mailbox, and what it refuses to guess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GMAIL_READ_FAILURES,
  gmailFailureForConnectionState,
  normalizeGmailAddress,
  parseGmailAddressList,
  parseGmailReferences,
  workSyncFailureForGmailFailure,
} from '../src/gmail-sensor';

test('an address list is read, and an address Loop cannot read is dropped rather than guessed', () => {
  assert.deepEqual(parseGmailAddressList('Ben Cashion <ben@cashion.example>'), [{ address: 'ben@cashion.example', name: 'Ben Cashion' }]);
  assert.deepEqual(parseGmailAddressList('<ben@cashion.example>'), [{ address: 'ben@cashion.example', name: null }]);
  assert.deepEqual(parseGmailAddressList('ben@cashion.example'), [{ address: 'ben@cashion.example', name: null }]);
  assert.deepEqual(parseGmailAddressList('BEN@Cashion.Example'), [{ address: 'ben@cashion.example', name: null }]);

  // A comma inside a quoted display name is part of the name, not a separator.
  assert.deepEqual(parseGmailAddressList('"Cashion, Ben" <ben@cashion.example>, lexi@emg.example'), [
    { address: 'ben@cashion.example', name: 'Cashion, Ben' },
    { address: 'lexi@emg.example', name: null },
  ]);

  // Undisclosed recipients, groups and malformed entries state nothing.
  for (const nothing of [undefined, null, '', '   ', 'undisclosed-recipients:;', 'not an address', '@nope', 'a@b']) {
    assert.deepEqual(parseGmailAddressList(nothing as string), [], JSON.stringify(nothing));
  }
  assert.equal(normalizeGmailAddress('  BEN@Cashion.Example '), 'ben@cashion.example');
});

test('the References chain is read in order, and nothing else is read as one', () => {
  assert.deepEqual(parseGmailReferences('<a@x> <b@x>\r\n <c@x>'), ['<a@x>', '<b@x>', '<c@x>']);
  assert.deepEqual(parseGmailReferences('no angle brackets here'), []);
  assert.deepEqual(parseGmailReferences(null), []);
});

test('a connection state becomes exactly one read failure, and every failure becomes one run class', () => {
  assert.equal(gmailFailureForConnectionState('NOT_CONNECTED'), 'NOT_CONNECTED');
  assert.equal(gmailFailureForConnectionState('NOT_CONFIGURED'), 'NOT_CONNECTED');
  assert.equal(gmailFailureForConnectionState('NOT_PERMITTED'), 'NOT_CONNECTED');
  assert.equal(gmailFailureForConnectionState('INSUFFICIENT_SCOPE'), 'CAPABILITY_NOT_GRANTED');
  assert.equal(gmailFailureForConnectionState('EXPIRED'), 'AUTHORIZATION_EXPIRED');
  assert.equal(gmailFailureForConnectionState('UNAVAILABLE'), 'UNAVAILABLE');

  // "Could not read" and "nothing is there" never collapse: every failure maps to a failure.
  for (const failure of GMAIL_READ_FAILURES) {
    const cls = workSyncFailureForGmailFailure(failure);
    assert.ok(['NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'AUTH', 'MALFORMED', 'CURSOR_EXPIRED', 'UNAVAILABLE'].includes(cls), failure);
  }
  assert.equal(workSyncFailureForGmailFailure('CURSOR_EXPIRED'), 'CURSOR_EXPIRED');
  assert.equal(workSyncFailureForGmailFailure('AUTHORIZATION_EXPIRED'), 'AUTH');
  assert.equal(workSyncFailureForGmailFailure('RATE_LIMITED'), 'RATE_LIMITED');
});

test('the contract has no body field: what is persisted cannot carry correspondence', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'gmail-sensor.ts'), 'utf8');
  const fact = src.slice(src.indexOf('export interface GmailMessageFact'), src.indexOf('/** One message as a reader sees it'));
  for (const forbidden of ['body', 'snippet', 'attachment', 'html', 'text:']) {
    assert.equal(fact.toLowerCase().includes(forbidden), false, `${forbidden} must not be a persisted message fact`);
  }
  // The thread read, which does carry a body, is a separate shape and says it is not stored.
  assert.match(src, /NEVER STORED|never stored/);
});

// The Google Workspace connection contract: exact scopes, nothing broader, honest states.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GOOGLE_CONNECT_OUTCOMES,
  GOOGLE_IDENTITY_SCOPES,
  GOOGLE_WORKSPACE_CAPABILITIES,
  GOOGLE_WORKSPACE_CAPABILITY_READS,
  GOOGLE_WORKSPACE_CAPABILITY_SCOPES,
  googleCapabilitiesOf,
  googleCapabilityScopes,
  googleCapabilityStates,
  googleScopesFor,
  isGoogleConnectOutcome,
  isGoogleConnectReturnTarget,
  parseGoogleGrantedScopes,
  parseGoogleWorkspaceCapabilities,
} from '../src/google-workspace';

// GM-1: Gmail carries two scopes. `gmail.readonly` is the narrowest scope that returns a body
// (verified against Google's scope reference), and `gmail.send` sends and can do nothing else.
// `gmail.metadata` is the scope Loop asked for before GM-1 and still recognises on a stored
// connection -- it no longer covers the capability, so such a connection asks to reconnect.
const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const GMAIL_LEGACY = 'https://www.googleapis.com/auth/gmail.metadata';
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events.readonly';
const DRIVE = 'https://www.googleapis.com/auth/drive.metadata.readonly';

test('exactly three capabilities, each with exactly its approved scopes', () => {
  assert.deepEqual([...GOOGLE_WORKSPACE_CAPABILITIES], ['gmail', 'calendar', 'drive']);
  assert.deepEqual(
    JSON.parse(JSON.stringify(GOOGLE_WORKSPACE_CAPABILITY_SCOPES)),
    { gmail: [GMAIL_READ, GMAIL_SEND], calendar: [CALENDAR], drive: [DRIVE] },
    'Gmail reads and sends; nothing modifies, labels or deletes',
  );
  assert.deepEqual([...GOOGLE_IDENTITY_SCOPES], ['openid', 'email'], 'no profile scope');
  assert.ok(Object.isFrozen(GOOGLE_WORKSPACE_CAPABILITY_SCOPES));
  for (const capability of GOOGLE_WORKSPACE_CAPABILITIES) {
    assert.match(GOOGLE_WORKSPACE_CAPABILITY_READS[capability], /Never|cannot/, `${capability} says what Loop never does`);
  }
});

test('no broader Google scope is named anywhere in the contract', () => {
  // Comments stripped: the file EXPLAINS which broader scopes Loop deliberately does not hold,
  // and that explanation is the point of the rule rather than a breach of it.
  const src = readFileSync(join(__dirname, '..', 'src', 'google-workspace.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  const named = [...src.matchAll(/https:\/\/(?:www\.googleapis\.com\/auth\/[\w.]+|mail\.google\.com\/?)/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(named)].sort(), [
    CALENDAR,
    DRIVE,
    GMAIL_LEGACY,
    GMAIL_READ,
    GMAIL_SEND,
    'https://www.googleapis.com/auth/userinfo.email',
  ]);
  // The scopes that would let Loop write to, relabel or delete somebody's mailbox or drive are
  // named nowhere -- including the two that would have been the convenient way to add sending.
  for (const forbidden of ['gmail.modify', 'gmail.compose', 'gmail.insert', 'gmail.labels', 'gmail.settings', 'mail.google.com', 'auth/drive"', 'drive.readonly', 'drive.file', 'auth/calendar"', 'calendar.events"', 'userinfo.profile']) {
    assert.equal(src.includes(forbidden), false, forbidden);
  }
});

test('a request names known capabilities only, is refused whole otherwise, and is put in canonical order', () => {
  assert.deepEqual(parseGoogleWorkspaceCapabilities('gmail'), ['gmail']);
  assert.deepEqual(parseGoogleWorkspaceCapabilities('drive,gmail'), ['gmail', 'drive']);
  assert.deepEqual(parseGoogleWorkspaceCapabilities(['calendar', 'gmail']), ['gmail', 'calendar']);
  assert.deepEqual(parseGoogleWorkspaceCapabilities('gmail,gmail'), ['gmail']);
  assert.deepEqual(parseGoogleWorkspaceCapabilities(' calendar '), ['calendar']);
  for (const bad of [undefined, null, '', 'contacts', 'gmail,contacts', ['gmail', 7], 'gmail,calendar,drive,gmail', [], 'GMAIL']) {
    assert.equal(parseGoogleWorkspaceCapabilities(bad), null, JSON.stringify(bad));
  }
});

test('the authorization request asks for identity plus the chosen capabilities, nothing else', () => {
  assert.deepEqual(googleScopesFor(['gmail']), ['openid', 'email', GMAIL_READ, GMAIL_SEND]);
  assert.deepEqual(googleScopesFor(['drive', 'calendar']), ['openid', 'email', CALENDAR, DRIVE]);
  assert.deepEqual(googleCapabilityScopes(['drive', 'gmail']), [GMAIL_READ, GMAIL_SEND, DRIVE]);
  assert.deepEqual(googleCapabilitiesOf([DRIVE, 'openid', GMAIL_READ, GMAIL_SEND, 'https://example.invalid/x']), ['gmail', 'drive']);
  // EVERY scope, not any: half of Gmail is not Gmail, and a legacy metadata grant is not it either.
  assert.deepEqual(googleCapabilitiesOf([GMAIL_READ]), [], 'read without send does not cover the capability');
  assert.deepEqual(googleCapabilitiesOf([GMAIL_SEND]), [], 'send without read does not cover it either');
  assert.deepEqual(googleCapabilitiesOf([GMAIL_LEGACY]), [], 'the pre-GM-1 metadata grant no longer covers it');
});

test('what Google granted is read from its answer; anything beyond the allowlist refuses the whole grant', () => {
  assert.deepEqual(parseGoogleGrantedScopes(`openid https://www.googleapis.com/auth/userinfo.email ${GMAIL_READ} ${GMAIL_SEND}`), {
    ok: true,
    capabilities: ['gmail'],
    capabilityScopes: [GMAIL_READ, GMAIL_SEND],
  });
  // A person may decline half of it on Google's consent screen. What they granted is stored as
  // granted; what it COVERS is a different question and gets the narrower answer.
  assert.deepEqual(parseGoogleGrantedScopes(`openid email ${GMAIL_READ}`), {
    ok: true,
    capabilities: [],
    capabilityScopes: [GMAIL_READ],
  });
  assert.deepEqual(parseGoogleGrantedScopes(`openid email ${GMAIL_LEGACY}`), {
    ok: true,
    capabilities: [],
    capabilityScopes: [GMAIL_LEGACY],
  }, 'a pre-GM-1 connection is readable, and covers nothing until it reconnects');
  assert.deepEqual(parseGoogleGrantedScopes(`email openid ${DRIVE}  ${CALENDAR}`), {
    ok: true,
    capabilities: ['calendar', 'drive'],
    capabilityScopes: [CALENDAR, DRIVE],
  });
  assert.deepEqual(parseGoogleGrantedScopes('openid email'), { ok: true, capabilities: [], capabilityScopes: [] }, 'every capability declined');
  for (const broader of [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.profile',
    'profile',
  ]) {
    assert.deepEqual(parseGoogleGrantedScopes(`openid email ${GMAIL_READ} ${broader}`), { ok: false, reason: 'UNEXPECTED_SCOPE' }, broader);
  }
  for (const missing of [undefined, null, '', '   ', 42]) {
    assert.deepEqual(parseGoogleGrantedScopes(missing), { ok: false, reason: 'MISSING' });
  }
});

test('each capability state is derived from what was granted and asked for, and the connection status', () => {
  const all = (s: string) => ({ gmail: s, calendar: s, drive: s });
  assert.deepEqual({ ...googleCapabilityStates(null) }, all('NOT_CONNECTED'));
  const connected = { status: 'CONNECTED' as const, grantedScopes: [GMAIL_READ, GMAIL_SEND], requestedScopes: [GMAIL_READ, GMAIL_SEND, CALENDAR] };
  assert.deepEqual({ ...googleCapabilityStates(connected) }, { gmail: 'CONNECTED', calendar: 'INSUFFICIENT_SCOPE', drive: 'NOT_CONNECTED' });
  assert.deepEqual({ ...googleCapabilityStates({ ...connected, status: 'EXPIRED' }) }, { gmail: 'EXPIRED', calendar: 'NOT_CONNECTED', drive: 'NOT_CONNECTED' });
  assert.deepEqual({ ...googleCapabilityStates({ ...connected, status: 'REVOKED' }) }, all('NOT_CONNECTED'));
  // A connection made before GM-1, or one where send was declined: asked for, not covered.
  const partial = { status: 'CONNECTED' as const, grantedScopes: [GMAIL_LEGACY], requestedScopes: [GMAIL_LEGACY] };
  assert.equal(googleCapabilityStates(partial).gmail, 'INSUFFICIENT_SCOPE', 'reconnect, not refuse');
  const halfGranted = { status: 'CONNECTED' as const, grantedScopes: [GMAIL_READ], requestedScopes: [GMAIL_READ, GMAIL_SEND] };
  assert.equal(googleCapabilityStates(halfGranted).gmail, 'INSUFFICIENT_SCOPE');
});

test('outcome and return-target vocabularies are closed', () => {
  assert.ok(GOOGLE_CONNECT_OUTCOMES.every(isGoogleConnectOutcome));
  for (const bad of ['connected', 'OK', '', null, 'CONNECTED ']) assert.equal(isGoogleConnectOutcome(bad), false);
  assert.equal(isGoogleConnectReturnTarget('ONBOARDING'), true);
  assert.equal(isGoogleConnectReturnTarget('https://evil.example'), false);
});

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

const GMAIL = 'https://www.googleapis.com/auth/gmail.metadata';
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events.readonly';
const DRIVE = 'https://www.googleapis.com/auth/drive.metadata.readonly';

test('exactly three capabilities, each with exactly its approved read-only scope', () => {
  assert.deepEqual([...GOOGLE_WORKSPACE_CAPABILITIES], ['gmail', 'calendar', 'drive']);
  assert.deepEqual({ ...GOOGLE_WORKSPACE_CAPABILITY_SCOPES }, { gmail: GMAIL, calendar: CALENDAR, drive: DRIVE });
  assert.deepEqual([...GOOGLE_IDENTITY_SCOPES], ['openid', 'email'], 'no profile scope');
  assert.ok(Object.isFrozen(GOOGLE_WORKSPACE_CAPABILITY_SCOPES));
  for (const capability of GOOGLE_WORKSPACE_CAPABILITIES) {
    assert.match(GOOGLE_WORKSPACE_CAPABILITY_READS[capability], /Never|cannot/, `${capability} says what Loop never does`);
  }
});

test('no broader Google scope is named anywhere in the contract', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'google-workspace.ts'), 'utf8');
  const named = [...src.matchAll(/https:\/\/(?:www\.googleapis\.com\/auth\/[\w.]+|mail\.google\.com\/?)/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(named)].sort(), [
    CALENDAR,
    DRIVE,
    GMAIL,
    'https://www.googleapis.com/auth/userinfo.email',
  ]);
  for (const forbidden of ['gmail.readonly', 'gmail.send', 'gmail.modify', 'gmail.compose', 'mail.google.com', 'auth/drive"', 'drive.readonly', 'drive.file', 'auth/calendar"', 'calendar.events"', 'userinfo.profile']) {
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
  assert.deepEqual(googleScopesFor(['gmail']), ['openid', 'email', GMAIL]);
  assert.deepEqual(googleScopesFor(['drive', 'calendar']), ['openid', 'email', CALENDAR, DRIVE]);
  assert.deepEqual(googleCapabilityScopes(['drive', 'gmail']), [GMAIL, DRIVE]);
  assert.deepEqual(googleCapabilitiesOf([DRIVE, 'openid', GMAIL, 'https://example.invalid/x']), ['gmail', 'drive']);
});

test('what Google granted is read from its answer; anything beyond the allowlist refuses the whole grant', () => {
  assert.deepEqual(parseGoogleGrantedScopes(`openid https://www.googleapis.com/auth/userinfo.email ${GMAIL}`), {
    ok: true,
    capabilities: ['gmail'],
    capabilityScopes: [GMAIL],
  });
  assert.deepEqual(parseGoogleGrantedScopes(`email openid ${DRIVE}  ${CALENDAR}`), {
    ok: true,
    capabilities: ['calendar', 'drive'],
    capabilityScopes: [CALENDAR, DRIVE],
  });
  assert.deepEqual(parseGoogleGrantedScopes('openid email'), { ok: true, capabilities: [], capabilityScopes: [] }, 'every capability declined');
  for (const broader of [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.profile',
    'profile',
  ]) {
    assert.deepEqual(parseGoogleGrantedScopes(`openid email ${GMAIL} ${broader}`), { ok: false, reason: 'UNEXPECTED_SCOPE' }, broader);
  }
  for (const missing of [undefined, null, '', '   ', 42]) {
    assert.deepEqual(parseGoogleGrantedScopes(missing), { ok: false, reason: 'MISSING' });
  }
});

test('each capability state is derived from what was granted and asked for, and the connection status', () => {
  const all = (s: string) => ({ gmail: s, calendar: s, drive: s });
  assert.deepEqual({ ...googleCapabilityStates(null) }, all('NOT_CONNECTED'));
  const connected = { status: 'CONNECTED' as const, grantedScopes: [GMAIL], requestedScopes: [GMAIL, CALENDAR] };
  assert.deepEqual({ ...googleCapabilityStates(connected) }, { gmail: 'CONNECTED', calendar: 'INSUFFICIENT_SCOPE', drive: 'NOT_CONNECTED' });
  assert.deepEqual({ ...googleCapabilityStates({ ...connected, status: 'EXPIRED' }) }, { gmail: 'EXPIRED', calendar: 'NOT_CONNECTED', drive: 'NOT_CONNECTED' });
  assert.deepEqual({ ...googleCapabilityStates({ ...connected, status: 'REVOKED' }) }, all('NOT_CONNECTED'));
});

test('outcome and return-target vocabularies are closed', () => {
  assert.ok(GOOGLE_CONNECT_OUTCOMES.every(isGoogleConnectOutcome));
  for (const bad of ['connected', 'OK', '', null, 'CONNECTED ']) assert.equal(isGoogleConnectOutcome(bad), false);
  assert.equal(isGoogleConnectReturnTarget('ONBOARDING'), true);
  assert.equal(isGoogleConnectReturnTarget('https://evil.example'), false);
});

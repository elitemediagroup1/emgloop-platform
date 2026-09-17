// Google Workspace connection (Private V1): persistence, lifecycle and isolation.
//
// Drives the REAL GoogleWorkspaceService, GoogleConnectionRepository, IamRepository and
// token sealer against the in-memory Prisma double, with Google replaced by a recording
// double that returns documented token responses and ID tokens (checked by the real
// claim checker). No network, no database, no real key.
//
// WHAT THESE PROVE
//   - A connect attempt is single-use, expires, and is honoured only for the same
//     organization, person and browser session.
//   - Only what Google GRANTED is stored, never what Loop asked for; a declined capability
//     reads INSUFFICIENT_SCOPE; a broader grant is refused whole and nothing is stored.
//   - One connection per person; a different Google account is refused; a Google account
//     already linked to another person in the organization is refused.
//   - The refresh token is stored only sealed, bound to organization, person and Google
//     account, and nothing secret appears in an outcome, a stored column or an audit row.
//   - Disconnecting, removing a capability, disabling or removing a member deletes the
//     credential in the same transaction and asks Google to revoke it afterwards.
//   - An expired grant stops being used and is deleted.
//   - Nobody reaches another organization's connection, and an AI Employee can hold none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { checkGoogleIdTokenClaims, type GoogleRevokeResult, type GoogleTokenResult } from '@emgloop/providers';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository, GOOGLE_WORKSPACE_GRANTS, matrixAllows } from '../src/repositories/iam.repository';
import { GoogleConnectionRepository, GOOGLE_OAUTH_MAX_OPEN_STATES, GOOGLE_OAUTH_STATE_LIFETIME_MS } from '../src/repositories/google-connection.repository';
import { GoogleWorkspaceService, type GoogleOAuthPort, type GoogleSessionPrincipal } from '../src/services/google/google-workspace.service';
import { GoogleTokenSealer, GoogleTokenUnopenable, googleTokenKeyRef } from '../src/services/google/google-token-sealer';
import { AesGcmBrainPayloadSealer } from '../src/services/brain/brain-payload-sealer';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const CLIENT_ID = '123456789012-abcdef.apps.googleusercontent.com';
const GMAIL = 'https://www.googleapis.com/auth/gmail.metadata';
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events.readonly';
const DRIVE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const T0 = new Date('2026-09-17T12:00:00Z');

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

// --- A recording Google ----------------------------------------------------------------

interface GoogleAccount {
  readonly sub: string;
  readonly email: string;
  readonly hd?: string;
  readonly emailVerified?: boolean;
}

function fakeGoogle(now: () => Date) {
  const requests: { scopes: readonly string[]; state: string; nonce: string; loginHint: string | null }[] = [];
  const exchanged: string[] = [];
  const refreshed: string[] = [];
  const revoked: string[] = [];
  let exchange: (code: string) => GoogleTokenResult = () => ({ ok: false, failure: 'REJECTED' });
  let refresh: (token: string) => GoogleTokenResult = () => ({ ok: false, failure: 'REJECTED' });
  let revoke: (token: string) => GoogleRevokeResult = () => ({ ok: true });
  const port: GoogleOAuthPort = {
    authorizationUrl: (r) => {
      requests.push({ ...r });
      return `https://accounts.google.com/o/oauth2/v2/auth?state=${r.state}`;
    },
    exchangeCode: async (code) => {
      exchanged.push(code);
      return exchange(code);
    },
    refresh: async (token) => {
      refreshed.push(token);
      return refresh(token);
    },
    revoke: async (token) => {
      revoked.push(token);
      return revoke(token);
    },
    checkIdToken: (idToken, expected) => checkGoogleIdTokenClaims(idToken, { clientId: CLIENT_ID, ...expected }),
  };
  const idToken = (account: GoogleAccount, nonce: string) =>
    `${b64({ alg: 'RS256' })}.${b64({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      azp: CLIENT_ID,
      sub: account.sub,
      email: account.email,
      email_verified: account.emailVerified ?? true,
      ...(account.hd ? { hd: account.hd } : {}),
      iat: Math.floor(now().getTime() / 1000),
      exp: Math.floor(now().getTime() / 1000) + 3600,
      nonce,
    })}.c2ln`;
  return {
    port,
    requests,
    exchanged,
    refreshed,
    revoked,
    last: () => requests[requests.length - 1]!,
    /** Google's answer to the next code exchange. */
    answer(account: GoogleAccount, scope: string, over: { refreshToken?: string | null; nonce?: string; idToken?: string | null } = {}) {
      exchange = () => {
        const nonce = over.nonce ?? requests[requests.length - 1]!.nonce;
        return {
          ok: true,
          grant: {
            accessToken: `ya29.access-${exchanged.length}`,
            expiresInSeconds: 3599,
            refreshToken: over.refreshToken === undefined ? `1//refresh-${account.sub}-${exchanged.length}` : over.refreshToken,
            scope,
            idToken: over.idToken === undefined ? idToken(account, nonce) : over.idToken,
          },
        };
      };
    },
    failExchange(failure: 'INVALID_GRANT' | 'REJECTED' | 'NETWORK') {
      exchange = () => ({ ok: false, failure });
    },
    onRefresh(fn: (token: string) => GoogleTokenResult) {
      refresh = fn;
    },
    onRevoke(fn: (token: string) => GoogleRevokeResult) {
      revoke = fn;
    },
  };
}

// --- A world -----------------------------------------------------------------------------

function world(opts: { configured?: boolean; key?: Uint8Array } = {}) {
  const fake: any = makeCognitivePrisma({ also: ['invitation', 'organizationMembership', 'userSession', 'organization'] });
  const prisma = fake as PrismaClient;
  let clock = T0;
  const now = () => clock;
  const google = fakeGoogle(now);
  const key = opts.key ?? randomBytes(32);
  const iam = new IamRepository(prisma);
  const build = (k: Uint8Array, configured = opts.configured !== false) =>
    new GoogleWorkspaceService(prisma, {
      configured: configured ? { oauth: google.port, sealer: new GoogleTokenSealer(k) } : null,
      authorize: (p, action) => iam.can({ organizationId: p.organizationId, userId: p.userId, resource: 'googleWorkspace', action }),
      now,
    });
  return {
    fake,
    prisma,
    iam,
    google,
    key,
    service: build(key),
    serviceWithKey: (k: Uint8Array) => build(k),
    repo: new GoogleConnectionRepository(prisma),
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    now,
  };
}
type World = ReturnType<typeof world>;

let people = 0;
async function person(w: World, org: string, role = 'EMPLOYEE'): Promise<GoogleSessionPrincipal> {
  people += 1;
  const u = await w.iam.createUser({ organizationId: org, email: `person${people}@loop.test`, name: `Person ${people}`, systemRole: role });
  await w.iam.activateUser(org, u.id);
  return { organizationId: org, userId: u.id, name: `Person ${people}`, sessionId: `session_${people}` };
}

const connection = (w: World, who: { organizationId: string; userId: string }) =>
  w.fake.googleConnection.__rows.find((r: any) => r.organizationId === who.organizationId && r.userId === who.userId);
const audits = (w: World, action?: string) => w.fake.auditLog.__rows.filter((r: any) => r.entityType === 'google_connection' && (!action || r.action === action));

/** Start an attempt for `capabilities`, have Google answer as `account` granting `scope`, and finish it. */
async function connect(
  w: World,
  who: GoogleSessionPrincipal,
  capabilities: string,
  account: GoogleAccount,
  scope: string,
  over: Parameters<ReturnType<typeof fakeGoogle>['answer']>[2] = {},
) {
  const begin = await w.service.beginConnect(who, { capabilities, returnTo: 'ONBOARDING' });
  assert.equal(begin.kind, 'redirect', JSON.stringify(begin));
  w.google.answer(account, scope, over);
  return w.service.completeConnect(who, { state: w.google.last().state, code: `4/code-${w.google.requests.length}` });
}

const ALICE: GoogleAccount = { sub: '110000000000000000001', email: 'alice@example.com', hd: 'example.com' };
const BOB: GoogleAccount = { sub: '110000000000000000002', email: 'bob@gmail.com' };

// --- Sealing ------------------------------------------------------------------------------

test('a refresh token is sealed, bound to organization, person and Google account, and opens only there', () => {
  const key = randomBytes(32);
  const sealer = new GoogleTokenSealer(key);
  const binding = { organizationId: ORG_A, userId: 'u1', googleSubject: ALICE.sub };
  const sealed = sealer.seal(binding, '1//refresh-token');
  assert.equal(sealed.sealVersion, 'aes-gcm.1');
  assert.equal(sealed.keyRef, googleTokenKeyRef(key));
  assert.match(sealed.keyRef, /^google-token\/[0-9a-f]{16}$/);
  assert.deepEqual([...sealed.sealed.subarray(0, 4)], [0x4c, 0x47, 0x54, 0x01]);
  assert.equal(Buffer.from(sealed.sealed).includes(Buffer.from('1//refresh-token')), false, 'no plaintext in the sealed bytes');
  assert.equal(sealer.open(binding, sealed), '1//refresh-token');

  for (const other of [
    { ...binding, organizationId: ORG_B },
    { ...binding, userId: 'u2' },
    { ...binding, googleSubject: BOB.sub },
  ]) {
    assert.throws(() => sealer.open(other, sealed), GoogleTokenUnopenable, JSON.stringify(other));
  }
  assert.throws(() => new GoogleTokenSealer(randomBytes(32)).open(binding, sealed), GoogleTokenUnopenable, 'another key');
  assert.throws(() => sealer.open(binding, { ...sealed, keyRef: 'google-token/0000000000000000' }), GoogleTokenUnopenable, 'relabelled');
  const tampered = new Uint8Array(sealed.sealed);
  tampered[tampered.length - 1]! ^= 0xff;
  assert.throws(() => sealer.open(binding, { ...sealed, sealed: tampered }), GoogleTokenUnopenable, 'tampered');
  assert.throws(() => new GoogleTokenSealer(randomBytes(16)), /32-byte/);
  assert.throws(() => sealer.seal(binding, ''), /token is required/);
});

test('the shared AES-GCM core keeps Brain checkpoints and Google tokens apart, and still opens checkpoints sealed before it was shared', async () => {
  // Sealed by AesGcmBrainPayloadSealer BEFORE its core moved to services/sealing (fixed key).
  const key = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
  const brain = new AesGcmBrainPayloadSealer('vector/key-1', key);
  const ctx = { organizationId: 'org_vector', jobId: 'job_vector', stepKey: 'step.vector', inputFingerprint: 'fp_vector', purpose: 'checkpoint' } as any;
  const legacy = Buffer.from('4c425301182add0e3f8d41e1c670a45e8d69b06a13c90150c866752face3ec8247b9e9479c7e35316ac12b34d2bb72f313dcb3ae67b677', 'hex');
  const opened = await brain.open(ctx, { sealVersion: 'aes-gcm.1', keyRef: 'vector/key-1', sealed: new Uint8Array(legacy) });
  assert.equal(new TextDecoder().decode(opened), '{"checkpoint":"vector"}');

  // A checkpoint's bytes are never a Google token, whatever the labels say.
  const google = new GoogleTokenSealer(key);
  const checkpoint = await brain.seal(ctx, new TextEncoder().encode('x'));
  assert.throws(
    () => google.open({ organizationId: 'org_vector', userId: 'job_vector', googleSubject: 'step.vector' }, { ...checkpoint, keyRef: google.keyRef }),
    GoogleTokenUnopenable,
  );
});

// --- Connect attempts ---------------------------------------------------------------------

test('a connect attempt is stored hashed, used once, within ten minutes, by the same person in the same session', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const begin = await w.service.beginConnect(alice, { capabilities: 'gmail', returnTo: 'ONBOARDING' });
  assert.equal(begin.kind, 'redirect');
  const { state, nonce, scopes, loginHint } = w.google.last();
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(scopes, ['openid', 'email', GMAIL], 'identity plus the one capability');
  assert.equal(loginHint, null);
  const row = w.fake.googleOAuthState.__rows[0];
  assert.equal(row.stateHash, sha(state));
  assert.equal(row.nonceHash, sha(nonce));
  assert.equal(JSON.stringify(w.fake.googleOAuthState.__rows).includes(state), false, 'the state value is never stored');
  assert.equal(JSON.stringify(w.fake.googleOAuthState.__rows).includes(nonce), false, 'nor the nonce');
  assert.deepEqual([row.organizationId, row.userId, row.sessionId, row.returnTo, row.capabilities], [ORG_A, alice.userId, alice.sessionId, 'ONBOARDING', ['gmail']]);
  assert.equal(row.expiresAt.getTime() - T0.getTime(), GOOGLE_OAUTH_STATE_LIFETIME_MS);

  const hash = sha(state);
  assert.equal(await w.repo.consumeState(ORG_A, alice.userId, 'another-session', hash, T0), null, 'another session');
  const bob = await person(w, ORG_A);
  assert.equal(await w.repo.consumeState(ORG_A, bob.userId, alice.sessionId, hash, T0), null, 'another person');
  assert.equal(await w.repo.consumeState(ORG_B, alice.userId, alice.sessionId, hash, T0), null, 'another organization');
  assert.equal(await w.repo.returnTargetOf(ORG_A, bob.userId, hash), null, 'nobody else learns where it returns');
  assert.equal(await w.repo.consumeState(ORG_A, alice.userId, alice.sessionId, hash, new Date(T0.getTime() + GOOGLE_OAUTH_STATE_LIFETIME_MS)), null, 'expired');
  assert.deepEqual(await w.repo.consumeState(ORG_A, alice.userId, alice.sessionId, hash, T0), { capabilities: ['gmail'], returnTo: 'ONBOARDING', nonceHash: sha(nonce) });
  assert.equal(await w.repo.consumeState(ORG_A, alice.userId, alice.sessionId, hash, T0), null, 'used once');
});

test('open attempts are capped per person; used and expired ones are cleared first', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  for (let i = 0; i < GOOGLE_OAUTH_MAX_OPEN_STATES; i += 1) {
    assert.equal((await w.service.beginConnect(alice, { capabilities: 'gmail', returnTo: 'CONNECTIONS' })).kind, 'redirect');
  }
  assert.deepEqual(await w.service.beginConnect(alice, { capabilities: 'gmail', returnTo: 'CONNECTIONS' }), {
    kind: 'return', returnTo: 'CONNECTIONS', outcome: 'TOO_MANY_ATTEMPTS',
  });
  const bob = await person(w, ORG_A);
  assert.equal((await w.service.beginConnect(bob, { capabilities: 'gmail', returnTo: 'CONNECTIONS' })).kind, 'redirect', 'the cap is per person');
  w.advance(GOOGLE_OAUTH_STATE_LIFETIME_MS);
  assert.equal((await w.service.beginConnect(alice, { capabilities: 'gmail', returnTo: 'CONNECTIONS' })).kind, 'redirect', 'expired attempts no longer count');
  assert.equal(w.fake.googleOAuthState.__rows.filter((r: any) => r.userId === alice.userId).length, 1);
});

test('a connect is refused before anything is stored when unconfigured, not permitted, or malformed', async () => {
  const off = world({ configured: false });
  const alice = await person(off, ORG_A);
  assert.deepEqual(await off.service.beginConnect(alice, { capabilities: 'gmail', returnTo: 'ONBOARDING' }), { kind: 'return', returnTo: 'ONBOARDING', outcome: 'NOT_CONFIGURED' });

  const w = world();
  const robot = await person(w, ORG_A, 'AI_EMPLOYEE');
  assert.deepEqual(await w.service.beginConnect(robot, { capabilities: 'gmail', returnTo: 'CONNECTIONS' }), { kind: 'return', returnTo: 'CONNECTIONS', outcome: 'NOT_PERMITTED' });
  const carol = await person(w, ORG_A);
  for (const capabilities of ['contacts', '', undefined, 'gmail,drive,calendar,gmail']) {
    assert.deepEqual(await w.service.beginConnect(carol, { capabilities, returnTo: 'nowhere' }), { kind: 'return', returnTo: 'CONNECTIONS', outcome: 'INVALID_REQUEST' });
  }
  assert.equal(off.fake.googleOAuthState.__rows.length + w.fake.googleOAuthState.__rows.length, 0);
  assert.equal(w.google.requests.length, 0);
});

// --- Completing a connect -----------------------------------------------------------------

test('a granted capability is stored sealed, audited by id and scope, and nothing secret is kept in the clear', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  assert.deepEqual(await connect(w, alice, 'gmail', ALICE, `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL}`), { returnTo: 'ONBOARDING', outcome: 'CONNECTED' });

  const row = connection(w, alice);
  assert.equal(row.status, 'CONNECTED');
  assert.equal(row.googleSubject, ALICE.sub);
  assert.equal(row.activeGoogleSubject, ALICE.sub);
  assert.equal(row.emailAtLink, ALICE.email);
  assert.equal(row.hostedDomain, 'example.com');
  assert.deepEqual(row.grantedScopes, [GMAIL]);
  assert.deepEqual(row.requestedScopes, [GMAIL]);
  const sealed = { sealVersion: row.sealVersion, keyRef: row.keyRef, sealed: new Uint8Array(row.refreshTokenSealed) };
  assert.equal(new GoogleTokenSealer(w.key).open({ organizationId: ORG_A, userId: alice.userId, googleSubject: ALICE.sub }, sealed), `1//refresh-${ALICE.sub}-1`);

  const everything = JSON.stringify({ conn: w.fake.googleConnection.__rows, states: w.fake.googleOAuthState.__rows, audit: w.fake.auditLog.__rows });
  for (const secret of ['1//refresh-', 'ya29.', '4/code-', w.google.last().state, w.google.last().nonce]) {
    assert.equal(everything.includes(secret), false, secret);
  }
  const [granted] = audits(w, 'google.connection.granted');
  assert.equal(granted.organizationId, ORG_A);
  assert.equal(granted.userId, alice.userId);
  assert.equal(granted.entityId, row.id);
  assert.deepEqual(granted.metadata.capabilities, ['gmail']);
  assert.equal(JSON.stringify(granted).includes(ALICE.email), false, 'no address in the audit trail');
  assert.equal(JSON.stringify(granted).includes('example.com'), false);

  const status = await w.service.status(alice);
  assert.ok(status.permitted);
  assert.deepEqual({ ...status.capabilities }, { gmail: 'CONNECTED', calendar: 'NOT_CONNECTED', drive: 'NOT_CONNECTED' });
  assert.equal(status.connection?.email, ALICE.email);
});

test('capabilities are added one at a time to the same grant; Google offers the connected account first', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`);
  const before = connection(w, alice).refreshTokenSealed;
  assert.deepEqual(await connect(w, alice, 'calendar', ALICE, `openid email ${GMAIL} ${CALENDAR}`), { returnTo: 'ONBOARDING', outcome: 'CONNECTED' });
  assert.deepEqual(w.google.last().scopes, ['openid', 'email', CALENDAR], 'only the new capability is asked for');
  assert.equal(w.google.last().loginHint, ALICE.sub);
  const row = connection(w, alice);
  assert.deepEqual(row.grantedScopes, [GMAIL, CALENDAR]);
  assert.deepEqual(row.requestedScopes.sort(), [CALENDAR, GMAIL].sort());
  assert.notDeepEqual(row.refreshTokenSealed, before, 'the refresh token is replaced');
  assert.equal(w.fake.googleConnection.__rows.length, 1, 'still one connection');
  assert.equal(audits(w, 'google.connection.scope_changed').length, 1);
  assert.deepEqual(await w.service.beginConnect(alice, { capabilities: 'gmail,calendar', returnTo: 'CONNECTIONS' }), { kind: 'return', returnTo: 'CONNECTIONS', outcome: 'ALREADY_CONNECTED' });
});

test('a capability declined on Google’s screen is INSUFFICIENT_SCOPE; declining everything stores nothing', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  assert.deepEqual(await connect(w, alice, 'gmail', ALICE, 'openid email'), { returnTo: 'ONBOARDING', outcome: 'DECLINED' });
  assert.equal(w.fake.googleConnection.__rows.length, 0, 'no credential that grants nothing');

  await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`);
  assert.deepEqual(await connect(w, alice, 'drive', ALICE, `openid email ${GMAIL}`), { returnTo: 'ONBOARDING', outcome: 'PARTIAL' });
  const status = await w.service.status(alice);
  assert.ok(status.permitted);
  assert.deepEqual({ ...status.capabilities }, { gmail: 'CONNECTED', calendar: 'NOT_CONNECTED', drive: 'INSUFFICIENT_SCOPE' });

  const begin = await w.service.beginConnect(alice, { capabilities: 'calendar', returnTo: 'ONBOARDING' });
  assert.equal(begin.kind, 'redirect');
  assert.deepEqual(
    await w.service.completeConnect(alice, { state: w.google.last().state, error: 'access_denied' }),
    { returnTo: 'ONBOARDING', outcome: 'DECLINED' },
  );
  assert.deepEqual(connection(w, alice).grantedScopes, [GMAIL], 'a refused screen changes nothing');
});

test('a grant broader than Loop asks for is refused whole; nothing is stored', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  for (const broader of ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/calendar']) {
    assert.deepEqual(await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL} ${broader}`), { returnTo: 'ONBOARDING', outcome: 'UNEXPECTED_SCOPE' }, broader);
  }
  assert.equal(w.fake.googleConnection.__rows.length, 0);
});

test('the ID token decides the account: nonce, verified email and any organization domain restriction', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  assert.deepEqual(await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`, { nonce: 'not-the-nonce' }), { returnTo: 'ONBOARDING', outcome: 'FAILED' });
  assert.deepEqual(await connect(w, alice, 'gmail', { ...ALICE, emailVerified: false }, `openid email ${GMAIL}`), { returnTo: 'ONBOARDING', outcome: 'EMAIL_UNVERIFIED' });
  assert.deepEqual(await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`, { idToken: null }), { returnTo: 'ONBOARDING', outcome: 'FAILED' });
  assert.deepEqual(await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`, { refreshToken: null }), { returnTo: 'ONBOARDING', outcome: 'FAILED' });
  assert.equal(w.fake.googleConnection.__rows.length, 0);

  // An organization that restricts domains admits only its own Workspace accounts.
  await w.fake.organization.create({ data: { id: ORG_A, name: 'A', settings: { googleWorkspace: { allowedHostedDomains: ['Example.com', 'not a domain'] } } } });
  assert.deepEqual(await connect(w, alice, 'gmail', BOB, `openid email ${GMAIL}`), { returnTo: 'ONBOARDING', outcome: 'DOMAIN_NOT_ALLOWED' });
  assert.deepEqual(await connect(w, alice, 'gmail', { ...ALICE, hd: 'other.com' }, `openid email ${GMAIL}`), { returnTo: 'ONBOARDING', outcome: 'DOMAIN_NOT_ALLOWED' });
  assert.deepEqual(await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`), { returnTo: 'ONBOARDING', outcome: 'CONNECTED' });
  assert.deepEqual(await w.repo.allowedHostedDomains(ORG_A), ['example.com']);
  assert.deepEqual(await w.repo.allowedHostedDomains(ORG_B), [], 'no restriction by default');
});

test('a replayed, expired or cross-session callback is refused before Google is called', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`);
  const used = w.google.last().state;
  const calls = w.google.exchanged.length;
  assert.deepEqual(await w.service.completeConnect(alice, { state: used, code: '4/code-replay' }), { returnTo: 'ONBOARDING', outcome: 'STATE_INVALID' });

  await w.service.beginConnect(alice, { capabilities: 'calendar', returnTo: 'CONNECTIONS' });
  const fresh = w.google.last().state;
  assert.deepEqual(await w.service.completeConnect({ ...alice, sessionId: 'stolen-elsewhere' }, { state: fresh, code: '4/code-x' }), { returnTo: 'CONNECTIONS', outcome: 'STATE_INVALID' });
  const mallory = await person(w, ORG_A);
  assert.deepEqual(await w.service.completeConnect(mallory, { state: fresh, code: '4/code-x' }), { returnTo: 'CONNECTIONS', outcome: 'STATE_INVALID' }, 'another person cannot finish it');
  assert.deepEqual(await w.service.completeConnect(null, { state: fresh, code: '4/code-x' }), { returnTo: 'CONNECTIONS', outcome: 'STATE_INVALID' });
  assert.deepEqual(await w.service.completeConnect(alice, { state: 'short', code: '4/code-x' }), { returnTo: 'CONNECTIONS', outcome: 'STATE_INVALID' });
  w.advance(GOOGLE_OAUTH_STATE_LIFETIME_MS + 1);
  assert.deepEqual(await w.service.completeConnect(alice, { state: fresh, code: '4/code-x' }), { returnTo: 'CONNECTIONS', outcome: 'STATE_INVALID' });
  assert.equal(w.google.exchanged.length, calls, 'no code was exchanged for any of them');
});

test('an exchange failure, a missing code or a Google error stores nothing and reports a plain class', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  for (const failure of ['INVALID_GRANT', 'REJECTED', 'NETWORK'] as const) {
    await w.service.beginConnect(alice, { capabilities: 'gmail', returnTo: 'ONBOARDING' });
    w.google.failExchange(failure);
    assert.deepEqual(await w.service.completeConnect(alice, { state: w.google.last().state, code: '4/code-fail' }), { returnTo: 'ONBOARDING', outcome: 'FAILED' });
  }
  await w.service.beginConnect(alice, { capabilities: 'gmail', returnTo: 'ONBOARDING' });
  assert.deepEqual(await w.service.completeConnect(alice, { state: w.google.last().state }), { returnTo: 'ONBOARDING', outcome: 'INVALID_REQUEST' });
  await w.service.beginConnect(alice, { capabilities: 'gmail', returnTo: 'ONBOARDING' });
  assert.deepEqual(await w.service.completeConnect(alice, { state: w.google.last().state, error: 'server_error' }), { returnTo: 'ONBOARDING', outcome: 'FAILED' });
  assert.equal(w.fake.googleConnection.__rows.length, 0);
});

// --- One account per person, one person per account ---------------------------------------

test('a different Google account is refused while one is connected; after disconnecting, it may be connected', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`);
  assert.deepEqual(await connect(w, alice, 'calendar', BOB, `openid email ${CALENDAR}`), { returnTo: 'ONBOARDING', outcome: 'DIFFERENT_ACCOUNT' });
  assert.equal(connection(w, alice).googleSubject, ALICE.sub);
  assert.deepEqual(connection(w, alice).grantedScopes, [GMAIL]);
  // The repository refuses it on its own too, whoever calls it.
  const direct = await w.repo.storeGrant(
    ORG_A,
    alice.userId,
    { googleSubject: BOB.sub, emailAtLink: BOB.email, hostedDomain: null, grantedScopes: [CALENDAR], requestedScopes: [CALENDAR], sealed: new GoogleTokenSealer(w.key).seal({ organizationId: ORG_A, userId: alice.userId, googleSubject: BOB.sub }, '1//x'), now: T0 },
    { userId: alice.userId },
  );
  assert.deepEqual(direct, { outcome: 'DIFFERENT_ACCOUNT' });
  assert.equal(connection(w, alice).googleSubject, ALICE.sub);

  assert.equal(await w.service.disconnect(alice), 'DISCONNECTED');
  assert.deepEqual(await connect(w, alice, 'calendar', BOB, `openid email ${CALENDAR}`), { returnTo: 'ONBOARDING', outcome: 'CONNECTED' });
  const row = connection(w, alice);
  assert.equal(row.googleSubject, BOB.sub);
  assert.deepEqual(row.requestedScopes, [CALENDAR], 'a fresh connection asks afresh');
  assert.equal(row.revokedAt, null);
  assert.equal(audits(w, 'google.connection.reconnected').length, 1);
});

test('one Google account links to one person per organization; another organization is independent', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const bob = await person(w, ORG_A);
  const other = await person(w, ORG_B);
  await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`);
  assert.deepEqual(await connect(w, bob, 'gmail', ALICE, `openid email ${GMAIL}`), { returnTo: 'ONBOARDING', outcome: 'ACCOUNT_IN_USE' });
  assert.equal(connection(w, bob), undefined);
  assert.deepEqual(await connect(w, other, 'gmail', ALICE, `openid email ${GMAIL}`), { returnTo: 'ONBOARDING', outcome: 'CONNECTED' }, 'the same account may be linked in another organization');

  await w.service.disconnect(alice);
  assert.deepEqual(await connect(w, bob, 'gmail', ALICE, `openid email ${GMAIL}`), { returnTo: 'ONBOARDING', outcome: 'CONNECTED' }, 'released once revoked');
});

// --- Disconnect, remove, expire -------------------------------------------------------------

test('disconnecting deletes the credential and live link in one step, then asks Google to revoke that token', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  await connect(w, alice, 'gmail,calendar', ALICE, `openid email ${GMAIL} ${CALENDAR}`);
  await w.service.beginConnect(alice, { capabilities: 'drive', returnTo: 'CONNECTIONS' });
  assert.equal(await w.service.disconnect(alice), 'DISCONNECTED');

  const row = connection(w, alice);
  assert.equal(row.status, 'REVOKED');
  assert.equal(row.refreshTokenSealed, null);
  assert.equal(row.sealVersion, null);
  assert.equal(row.keyRef, null);
  assert.equal(row.activeGoogleSubject, null);
  assert.equal(row.revocationReason, 'SELF_DISCONNECT');
  assert.equal(row.revokedByUserId, alice.userId);
  assert.ok(row.revocationConfirmedAt instanceof Date);
  assert.deepEqual(w.google.revoked, [`1//refresh-${ALICE.sub}-1`]);
  assert.equal(w.fake.googleOAuthState.__rows.filter((r: any) => r.userId === alice.userId).length, 0, 'open attempts end too');
  const [revoked] = audits(w, 'google.connection.revoked');
  assert.deepEqual(revoked.metadata.capabilities, ['gmail', 'calendar']);
  assert.equal(revoked.metadata.credentialDeleted, true);
  const status = await w.service.status(alice);
  assert.ok(status.permitted);
  assert.deepEqual({ ...status.capabilities }, { gmail: 'NOT_CONNECTED', calendar: 'NOT_CONNECTED', drive: 'NOT_CONNECTED' });
  assert.equal(await w.service.disconnect(alice), 'NOT_CONNECTED');
});

test('if Google does not confirm, Loop has still deleted its copy, and says so', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`);
  w.google.onRevoke(() => ({ ok: false, failure: 'NETWORK' }));
  assert.equal(await w.service.disconnect(alice), 'DISCONNECTED_UNCONFIRMED');
  const row = connection(w, alice);
  assert.equal(row.refreshTokenSealed, null);
  assert.equal(row.lastFailureClass, 'REVOKE_UNCONFIRMED');
  assert.equal(row.revocationConfirmedAt, null);
  assert.equal(audits(w, 'google.connection.revoke_unconfirmed').length, 1);
  const status = await w.service.status(alice);
  assert.ok(status.permitted);
  assert.equal(status.connection?.revocationUnconfirmed, true);
});

test('revoking never breaks another organization: a shared Google grant is left for its other holder', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const other = await person(w, ORG_B);
  await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`);
  await connect(w, other, 'calendar', ALICE, `openid email ${CALENDAR}`);
  assert.equal(await w.service.disconnect(alice), 'DISCONNECTED_UNCONFIRMED');
  assert.deepEqual(w.google.revoked, [], 'Google was not asked to revoke the account’s grant');
  assert.equal(connection(w, alice).refreshTokenSealed, null, 'Loop’s copy for this person is gone');
  assert.equal(connection(w, alice).lastFailureClass, 'REVOKE_SKIPPED_SHARED_GRANT');
  assert.equal(connection(w, other).status, 'CONNECTED');
  assert.equal(await w.service.disconnect(other), 'DISCONNECTED', 'the last holder revokes');
  assert.equal(w.google.revoked.length, 1);
});

test('removing one capability revokes the grant and returns the capabilities kept, for a fresh approval', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  await connect(w, alice, 'gmail,calendar,drive', ALICE, `openid email ${GMAIL} ${CALENDAR} ${DRIVE}`);
  assert.deepEqual(await w.service.removeCapability(alice, 'gmail'), { outcome: 'DISCONNECTED', reconnect: ['calendar', 'drive'] });
  assert.equal(connection(w, alice).revocationReason, 'CAPABILITY_REMOVED');
  assert.equal(connection(w, alice).refreshTokenSealed, null);
  assert.deepEqual(await connect(w, alice, 'calendar,drive', ALICE, `openid email ${CALENDAR} ${DRIVE}`), { returnTo: 'ONBOARDING', outcome: 'CONNECTED' });
  assert.deepEqual(connection(w, alice).grantedScopes, [CALENDAR, DRIVE]);
  assert.deepEqual(await w.service.removeCapability(alice, 'gmail,drive'), { outcome: 'INVALID_REQUEST', reconnect: [] });
  const bob = await person(w, ORG_A);
  assert.deepEqual(await w.service.removeCapability(bob, 'gmail'), { outcome: 'NOT_CONNECTED', reconnect: [] });
});

test('an access token is fetched per call; a refused grant expires the connection and deletes it', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  await connect(w, alice, 'calendar', ALICE, `openid email ${CALENDAR}`);
  w.google.onRefresh(() => ({ ok: true, grant: { accessToken: 'ya29.fresh', expiresInSeconds: 3600, refreshToken: null, scope: `openid email ${CALENDAR}`, idToken: null } }));
  const token = await w.service.accessToken(alice, 'calendar');
  assert.deepEqual(token, { ok: true, accessToken: 'ya29.fresh', expiresAt: new Date(T0.getTime() + 3600_000) });
  assert.deepEqual(w.google.refreshed, [`1//refresh-${ALICE.sub}-1`]);
  assert.ok(connection(w, alice).lastUsedAt instanceof Date);
  assert.equal(JSON.stringify(w.fake.googleConnection.__rows).includes('ya29.fresh'), false, 'access tokens are never stored');
  assert.deepEqual(await w.service.accessToken(alice, 'gmail'), { ok: false, state: 'INSUFFICIENT_SCOPE' });

  w.google.onRefresh(() => ({ ok: false, failure: 'NETWORK' }));
  assert.deepEqual(await w.service.accessToken(alice, 'calendar'), { ok: false, state: 'UNAVAILABLE' });
  assert.equal(connection(w, alice).status, 'CONNECTED', 'a transient failure changes nothing');

  w.google.onRefresh(() => ({ ok: false, failure: 'INVALID_GRANT' }));
  assert.deepEqual(await w.service.accessToken(alice, 'calendar'), { ok: false, state: 'EXPIRED' });
  const row = connection(w, alice);
  assert.equal(row.status, 'EXPIRED');
  assert.equal(row.refreshTokenSealed, null);
  assert.equal(row.lastFailureClass, 'REFRESH_REFUSED');
  assert.equal(row.activeGoogleSubject, ALICE.sub, 'still this person’s account until they reconnect or disconnect');
  assert.equal(audits(w, 'google.connection.expired').length, 1);
  const calls = w.google.refreshed.length;
  assert.deepEqual(await w.service.accessToken(alice, 'calendar'), { ok: false, state: 'EXPIRED' });
  assert.equal(w.google.refreshed.length, calls, 'Loop stops calling');
  const status = await w.service.status(alice);
  assert.ok(status.permitted);
  assert.equal(status.capabilities.calendar, 'EXPIRED');

  assert.deepEqual(await connect(w, alice, 'calendar', ALICE, `openid email ${CALENDAR}`), { returnTo: 'ONBOARDING', outcome: 'CONNECTED' }, 'reconnecting restores it');
  assert.equal(connection(w, alice).expiredAt, null);
});

test('a withdrawn scope is noticed on refresh; a rotated key expires the connection instead of guessing', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  await connect(w, alice, 'gmail,calendar', ALICE, `openid email ${GMAIL} ${CALENDAR}`);
  w.google.onRefresh(() => ({ ok: true, grant: { accessToken: 'ya29.x', expiresInSeconds: 60, refreshToken: null, scope: `openid email ${CALENDAR}`, idToken: null } }));
  assert.deepEqual(await w.service.accessToken(alice, 'gmail'), { ok: false, state: 'INSUFFICIENT_SCOPE' });
  assert.deepEqual(connection(w, alice).grantedScopes, [CALENDAR]);
  assert.equal(audits(w, 'google.connection.scope_changed').length, 1);

  const rotated = w.serviceWithKey(randomBytes(32));
  assert.deepEqual(await rotated.accessToken(alice, 'calendar'), { ok: false, state: 'EXPIRED' });
  assert.equal(connection(w, alice).lastFailureClass, 'TOKEN_UNOPENABLE');
});

// --- Offboarding ------------------------------------------------------------------------------

test('disabling a member deletes their Google credential in the same transaction; Google is asked afterwards', async () => {
  const w = world();
  const admin = await person(w, ORG_A, 'ADMIN');
  const alice = await person(w, ORG_A);
  await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`);
  await w.service.beginConnect(alice, { capabilities: 'drive', returnTo: 'CONNECTIONS' });

  const ended = await w.iam.disableMember(ORG_A, alice.userId, { userId: admin.userId, name: 'Admin' });
  assert.equal(ended.changed, true);
  assert.ok(ended.googleRevocation);
  assert.equal(ended.googleRevocation!.googleSubject, ALICE.sub);
  const row = connection(w, alice);
  assert.equal(row.status, 'REVOKED');
  assert.equal(row.refreshTokenSealed, null, 'deleted before any call to Google');
  assert.equal(row.revocationReason, 'MEMBER_DISABLED');
  assert.equal(row.revokedByUserId, admin.userId);
  assert.equal(w.fake.googleOAuthState.__rows.filter((r: any) => r.userId === alice.userId).length, 0);
  assert.deepEqual(w.google.revoked, []);

  assert.equal(await w.service.finishRevocation(ended.googleRevocation!, { userId: admin.userId }), 'DISCONNECTED');
  assert.deepEqual(w.google.revoked, [`1//refresh-${ALICE.sub}-1`]);
  assert.ok(connection(w, alice).revocationConfirmedAt instanceof Date);

  // A disabled member can no longer connect anything.
  assert.deepEqual(await w.service.beginConnect(alice, { capabilities: 'gmail', returnTo: 'CONNECTIONS' }), { kind: 'return', returnTo: 'CONNECTIONS', outcome: 'NOT_PERMITTED' });
});

test('removing a member ends their connection the same way; the legacy lifecycle calls delete it too', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const bob = await person(w, ORG_A);
  const carol = await person(w, ORG_A);
  await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`);
  await connect(w, bob, 'gmail', BOB, `openid email ${GMAIL}`);

  const removed = await w.iam.removeMember(ORG_A, alice.userId);
  assert.equal(removed.changed, true);
  assert.equal(connection(w, alice).revocationReason, 'MEMBER_REMOVED');
  assert.equal(connection(w, alice).refreshTokenSealed, null);
  assert.equal(removed.googleRevocation?.connectionId, connection(w, alice).id);

  assert.equal(await w.iam.disableUser(ORG_A, bob.userId), true);
  assert.equal(connection(w, bob).status, 'REVOKED');
  assert.equal(connection(w, bob).refreshTokenSealed, null);

  assert.deepEqual(await w.iam.disableMember(ORG_A, carol.userId), { changed: true, googleRevocation: null }, 'nothing to revoke');
  // A callback that was authorized before the disable cannot store afterwards: standing is
  // re-read inside the storing transaction.
  const late = await w.repo.storeGrant(
    ORG_A,
    carol.userId,
    { googleSubject: 'late-sub', emailAtLink: 'late@example.com', hostedDomain: null, grantedScopes: [GMAIL], requestedScopes: [GMAIL], sealed: new GoogleTokenSealer(w.key).seal({ organizationId: ORG_A, userId: carol.userId, googleSubject: 'late-sub' }, '1//late'), now: T0 },
    { userId: carol.userId },
  );
  assert.deepEqual(late, { outcome: 'NOT_PERMITTED' });
  assert.equal(connection(w, carol), undefined);
  assert.deepEqual(await w.iam.disableMember(ORG_B, alice.userId), { changed: false, googleRevocation: null }, 'another organization cannot reach her');
});

// --- Isolation and authority ------------------------------------------------------------------

test('nobody reaches another organization’s connection or attempts', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  await connect(w, alice, 'gmail', ALICE, `openid email ${GMAIL}`);
  const elsewhere = { organizationId: ORG_B, userId: alice.userId, name: 'x', sessionId: alice.sessionId };
  assert.equal(await w.repo.find(ORG_B, alice.userId), null);
  assert.equal(await w.repo.credential(ORG_B, alice.userId), null);
  assert.equal(await w.repo.revoke(ORG_B, alice.userId, { reason: 'SELF_DISCONNECT', actor: { userId: null }, now: T0 }), null);
  assert.equal(await w.repo.markExpired(ORG_B, alice.userId, connection(w, alice).id, 'REFRESH_REFUSED', T0), false);
  await w.repo.recordRevocationResult(ORG_B, connection(w, alice).id, { confirmed: false, failureClass: 'REVOKE_UNCONFIRMED' }, T0, { userId: null });
  assert.equal(connection(w, alice).status, 'CONNECTED');
  assert.equal(connection(w, alice).lastFailureClass, null);
  assert.equal((await w.service.status(elsewhere)).permitted, false, 'no membership there, no view');
  assert.equal(await w.service.disconnect(elsewhere), 'NOT_PERMITTED');
  assert.equal(connection(w, alice).status, 'CONNECTED');
});

test('every human role connects its own account; only OWNER and ADMIN manage others; an AI Employee never holds one', async () => {
  assert.deepEqual({ ...GOOGLE_WORKSPACE_GRANTS }, {
    OWNER: ['view', 'update', 'manage'],
    ADMIN: ['view', 'update', 'manage'],
    MANAGER: ['view', 'update'],
    EMPLOYEE: ['view', 'update'],
    READ_ONLY: ['view', 'update'],
    AI_EMPLOYEE: [],
  });
  for (const action of ['view', 'create', 'update', 'delete', 'manage', 'approve'] as const) {
    assert.equal(matrixAllows('AI_EMPLOYEE', 'googleWorkspace', action), false, action);
    assert.equal(matrixAllows('SOMETHING_NEW', 'googleWorkspace', action), false, `unknown role: ${action}`);
    for (const role of ['MANAGER', 'EMPLOYEE', 'READ_ONLY']) {
      assert.equal(matrixAllows(role, 'googleWorkspace', action), action === 'view' || action === 'update', `${role} ${action}`);
    }
  }
  assert.equal(matrixAllows('OWNER', 'googleWorkspace', 'delete'), false, 'manage is literal here');

  const w = world();
  const robot = await person(w, ORG_A, 'AI_EMPLOYEE');
  await w.fake.permission.create({ data: { organizationId: ORG_A, userId: robot.userId, resource: 'googleWorkspace', action: 'update', effect: 'ALLOW' } });
  assert.equal(await w.iam.can({ organizationId: ORG_A, userId: robot.userId, resource: 'googleWorkspace', action: 'update' }), false, 'no Permission row makes a machine hold a Google account');
  assert.deepEqual(await w.iam.canEach(ORG_A, robot.userId, [{ resource: 'googleWorkspace', action: 'update' }]), [false]);
  const denied = await person(w, ORG_A);
  await w.fake.permission.create({ data: { organizationId: ORG_A, userId: denied.userId, resource: 'googleWorkspace', action: 'update', effect: 'DENY' } });
  assert.deepEqual(await w.service.beginConnect(denied, { capabilities: 'gmail', returnTo: 'CONNECTIONS' }), { kind: 'return', returnTo: 'CONNECTIONS', outcome: 'NOT_PERMITTED' }, 'an explicit DENY wins');
  const reader = await person(w, ORG_A, 'READ_ONLY');
  assert.equal((await w.service.beginConnect(reader, { capabilities: 'gmail', returnTo: 'CONNECTIONS' })).kind, 'redirect');
});

// --- The migration ------------------------------------------------------------------------------

test('the migration only adds, is ASCII, and pins the three approved scopes in the database', () => {
  const sql = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '20260920000000_google_workspace_connections', 'migration.sql'), 'utf8');
  assert.equal(/[^\x00-\x7f]/.test(sql), false, 'ASCII only');
  const statements = sql.replace(/--.*$/gm, '');
  assert.equal(/\bDROP\b|\bUPDATE\s+"|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bTRUNCATE\b|RENAME/i.test(statements), false, 'additive only');
  assert.deepEqual([...statements.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]), ['google_connections', 'google_oauth_states']);
  const scopes = [...new Set([...statements.matchAll(/'(https:\/\/[^']+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(scopes, [CALENDAR, DRIVE, GMAIL].sort());
  for (const constraint of [
    'google_connections_status_check',
    'google_connections_credential_check',
    'google_connections_active_subject_check',
    'google_connections_revocation_check',
    'google_connections_failure_class_check',
    'google_connections_scopes_check',
    'google_oauth_states_capabilities_check',
    'google_oauth_states_shape_check',
  ]) {
    assert.match(statements, new RegExp(`ADD CONSTRAINT "${constraint}"`), constraint);
  }
  assert.match(statements, /FOREIGN KEY \("userId", "organizationId"\) REFERENCES "organization_memberships"\("userId", "organizationId"\)/);
  assert.match(statements, /CREATE UNIQUE INDEX "google_connections_organizationId_activeGoogleSubject_key"/);
});

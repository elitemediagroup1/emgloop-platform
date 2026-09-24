// TikTok Login Kit connection (Creator Hub): persistence, lifecycle and isolation.
//
// Drives the REAL TikTokService, TikTokConnectionRepository, CreatorRepository, IamRepository
// and token sealer against the in-memory Prisma double, with TikTok replaced by a recording
// double that answers documented token responses and Display API reads. No network, no
// database, no real key.
//
// WHAT THESE PROVE
//   - A connect attempt is single-use, expires, and is honoured only for the same
//     organization, person and browser session.
//   - The authority is the creator profile bound to the login: no profile, no connection.
//   - Only what TikTok GRANTED is stored, never what Loop asked for; a declined scope reads
//     PARTIAL; a broader grant is refused whole and nothing is stored.
//   - Both tokens are stored only sealed, bound to organization, person and TikTok account,
//     and nothing secret appears in an outcome, a stored column, a profile or an audit row.
//   - A read is bounded, merges (never replaces) the profile's TikTok entry, records the
//     follower count as an observation from the platform, and a failed read keeps the grant.
//   - A refresh stores the ROTATED refresh token; a refused refresh expires and deletes.
//   - Disconnecting deletes the credential in one step, withdraws what was read, and asks
//     TikTok to revoke afterwards -- never another organization's grant.
//   - Nobody reaches another organization's connection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { TikTokReadFailure, TikTokRevokeResult, TikTokTokenResult, TikTokVideoListResult } from '@emgloop/providers';
import type { TikTokUserInfo } from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository } from '../src/repositories/iam.repository';
import { CreatorRepository } from '../src/creator/creator.repository';
import { TikTokConnectionRepository, TIKTOK_OAUTH_MAX_OPEN_STATES, TIKTOK_OAUTH_STATE_LIFETIME_MS } from '../src/repositories/tiktok-connection.repository';
import { TikTokService, type TikTokOAuthPort, type TikTokSessionPrincipal } from '../src/services/tiktok/tiktok.service';
import { tiktokCreatorPort, TIKTOK_AUDIENCE_REPEAT_INTERVAL_MS } from '../src/services/tiktok/tiktok-creator-port';
import { TikTokTokenSealer, TikTokTokenUnopenable, tiktokTokenKeyRef } from '../src/services/tiktok/tiktok-token-sealer';
import { GoogleTokenSealer, GoogleTokenUnopenable } from '../src/services/google/google-token-sealer';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const ALL = 'user.info.basic,user.info.profile,user.info.stats,video.list';
const SCOPES = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list'];
const T0 = new Date('2026-09-24T12:00:00Z');
const HOUR = 3_600_000;

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

// --- A recording TikTok ------------------------------------------------------------------

interface Account {
  readonly openId: string;
  readonly username?: string | null;
  readonly followers?: number | null;
  readonly videoCount?: number | null;
}

function fakeTikTok() {
  const requests: { scopes: readonly string[]; state: string }[] = [];
  const exchanged: string[] = [];
  const refreshed: string[] = [];
  const revoked: string[] = [];
  const reads: { kind: 'user' | 'videos'; token: string; scopes?: readonly string[] }[] = [];
  let exchange: (code: string) => TikTokTokenResult = () => ({ ok: false, failure: 'REJECTED' });
  let refresh: (token: string) => TikTokTokenResult = () => ({ ok: false, failure: 'REJECTED' });
  let revoke: (token: string) => TikTokRevokeResult = () => ({ ok: true });
  let account: Account = { openId: 'open-1', username: 'konareyes', followers: 18412, videoCount: 88 };
  let userFailure: TikTokReadFailure | null = null;
  let videoFailure: TikTokReadFailure | null = null;
  let videos: TikTokVideoListResult = {
    videos: [
      { id: 'v1', title: 'Unboxing', shareUrl: 'https://www.tiktok.com/@konareyes/video/v1', createdAt: '2026-09-20T10:00:00.000Z', viewCount: 12000, likeCount: 800, commentCount: 40, shareCount: 12 },
    ],
    cursor: null,
    hasMore: false,
  };
  const port: TikTokOAuthPort = {
    authorizationUrl: (r) => {
      requests.push({ ...r });
      return `https://www.tiktok.com/v2/auth/authorize/?state=${r.state}`;
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
    userInfo: async (token, scopes) => {
      reads.push({ kind: 'user', token, scopes });
      if (userFailure) return { ok: false, failure: userFailure };
      const user: TikTokUserInfo = {
        openId: account.openId,
        displayName: 'Kona',
        username: scopes.includes('user.info.profile') ? (account.username ?? null) : null,
        profileDeepLink: scopes.includes('user.info.profile') ? 'https://www.tiktok.com/@konareyes' : null,
        isVerified: scopes.includes('user.info.profile') ? false : null,
        followerCount: scopes.includes('user.info.stats') ? (account.followers ?? null) : null,
        followingCount: scopes.includes('user.info.stats') ? 120 : null,
        likesCount: scopes.includes('user.info.stats') ? 250000 : null,
        videoCount: scopes.includes('user.info.stats') ? (account.videoCount ?? null) : null,
      };
      return { ok: true, user };
    },
    videoList: async (token) => {
      reads.push({ kind: 'videos', token });
      if (videoFailure) return { ok: false, failure: videoFailure };
      return { ok: true, page: videos };
    },
  };
  let grants = 0;
  return {
    port,
    requests,
    exchanged,
    refreshed,
    revoked,
    reads,
    last: () => requests[requests.length - 1]!,
    /** TikTok's answer to the next code exchange, and the account its reads describe. */
    answer(who: Account, scope: string, over: { refreshToken?: string | null; expiresIn?: number } = {}) {
      account = who;
      exchange = () => {
        grants += 1;
        return {
          ok: true,
          grant: {
            accessToken: `act.${who.openId}.${grants}`,
            expiresInSeconds: over.expiresIn ?? 86400,
            openId: who.openId,
            scope,
            refreshToken: over.refreshToken === undefined ? `rft.${who.openId}.${grants}` : over.refreshToken,
            refreshExpiresInSeconds: 31536000,
          },
        };
      };
    },
    failExchange(failure: 'INVALID_GRANT' | 'REJECTED' | 'NETWORK') {
      exchange = () => ({ ok: false, failure });
    },
    onRefresh(fn: (token: string) => TikTokTokenResult) {
      refresh = fn;
    },
    /** A refresh that rotates: the new tokens carry the old one's suffix plus `.r`. */
    rotate(scope: string | null = ALL) {
      refresh = (token) => ({
        ok: true,
        grant: { accessToken: `act.rotated.${token}`, expiresInSeconds: 86400, openId: account.openId, scope, refreshToken: `${token}.r`, refreshExpiresInSeconds: 31536000 },
      });
    },
    onRevoke(fn: (token: string) => TikTokRevokeResult) {
      revoke = fn;
    },
    account(who: Account) {
      account = who;
    },
    failReads(user: TikTokReadFailure | null, video: TikTokReadFailure | null = null) {
      userFailure = user;
      videoFailure = video;
    },
    setVideos(page: TikTokVideoListResult) {
      videos = page;
    },
  };
}

// --- A world -----------------------------------------------------------------------------

function world(opts: { configured?: boolean; key?: Uint8Array } = {}) {
  const fake: any = makeCognitivePrisma({ also: ['invitation', 'organizationMembership', 'userSession', 'organization', 'creatorProfile', 'creatorAudienceSnapshot'] });
  const prisma = fake as PrismaClient;
  let clock = T0;
  const now = () => clock;
  const tiktok = fakeTikTok();
  const key = opts.key ?? randomBytes(32);
  const iam = new IamRepository(prisma);
  const creator = new CreatorRepository(prisma);
  const build = (k: Uint8Array, configured = opts.configured !== false) =>
    new TikTokService(prisma, {
      configured: configured ? { oauth: tiktok.port, sealer: new TikTokTokenSealer(k) } : null,
      creator: tiktokCreatorPort(creator),
      now,
    });
  return {
    fake,
    prisma,
    iam,
    creator,
    tiktok,
    key,
    service: build(key),
    serviceWithKey: (k: Uint8Array) => build(k),
    repo: new TikTokConnectionRepository(prisma),
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    now,
  };
}
type World = ReturnType<typeof world>;

let people = 0;
async function person(w: World, org: string, opts: { role?: string; profile?: boolean } = {}): Promise<TikTokSessionPrincipal & { profileId: string | null }> {
  people += 1;
  const u = await w.iam.createUser({ organizationId: org, email: `person${people}@loop.test`, name: `Person ${people}`, systemRole: opts.role ?? 'CREATOR' });
  await w.iam.activateUser(org, u.id);
  let profileId: string | null = null;
  if (opts.profile !== false) {
    const profile = await w.creator.createProfile({ organizationId: org, partyId: `party_${people}`, userId: u.id, displayName: `Person ${people}` });
    profileId = profile.id;
  }
  return { organizationId: org, userId: u.id, name: `Person ${people}`, sessionId: `session_${people}`, profileId };
}

const connection = (w: World, who: { organizationId: string; userId: string }) =>
  w.fake.tikTokConnection.__rows.find((r: any) => r.organizationId === who.organizationId && r.userId === who.userId);
const audits = (w: World, action?: string) => w.fake.auditLog.__rows.filter((r: any) => r.entityType === 'tiktok_connection' && (!action || r.action === action));
const profileEntry = (w: World, who: { profileId: string | null }) => {
  const profile = w.fake.creatorProfile.__rows.find((r: any) => r.id === who.profileId);
  return (profile?.socialAccounts ?? []).find((s: any) => s.platform === 'TIKTOK') ?? null;
};
const audience = (w: World, who: { profileId: string | null }) => w.fake.creatorAudienceSnapshot.__rows.filter((r: any) => r.creatorProfileId === who.profileId && r.platform === 'TIKTOK');

/** Start an attempt, have TikTok answer as `account` granting `scope`, and finish it. */
async function connect(w: World, who: TikTokSessionPrincipal, account: Account, scope: string, over: Parameters<ReturnType<typeof fakeTikTok>['answer']>[2] = {}) {
  const begin = await w.service.beginConnect(who);
  assert.equal(begin.kind, 'redirect', JSON.stringify(begin));
  w.tiktok.answer(account, scope, over);
  return w.service.completeConnect(who, { state: w.tiktok.last().state, code: `authcode-${w.tiktok.requests.length}` });
}

const KONA: Account = { openId: 'open-kona', username: 'konareyes', followers: 18412, videoCount: 88 };
const RIVER: Account = { openId: 'open-river', username: 'river', followers: 300, videoCount: 3 };

// --- Sealing ------------------------------------------------------------------------------

test('a token is sealed per purpose, bound to organization, person and TikTok account, and opens only there', () => {
  const key = randomBytes(32);
  const sealer = new TikTokTokenSealer(key);
  const binding = { organizationId: ORG_A, userId: 'u1', tiktokOpenId: KONA.openId };
  const sealed = sealer.seal(binding, 'refresh', 'rft.secret');
  assert.equal(sealed.sealVersion, 'aes-gcm.1');
  assert.equal(sealed.keyRef, tiktokTokenKeyRef(key));
  assert.match(sealed.keyRef, /^tiktok-token\/[0-9a-f]{16}$/);
  assert.deepEqual([...sealed.sealed.subarray(0, 4)], [0x4c, 0x54, 0x54, 0x01]);
  assert.equal(Buffer.from(sealed.sealed).includes(Buffer.from('rft.secret')), false, 'no plaintext in the sealed bytes');
  assert.equal(sealer.open(binding, 'refresh', sealed), 'rft.secret');
  assert.throws(() => sealer.open(binding, 'access', sealed), TikTokTokenUnopenable, 'a refresh token never opens as an access token');
  for (const other of [
    { ...binding, organizationId: ORG_B },
    { ...binding, userId: 'u2' },
    { ...binding, tiktokOpenId: RIVER.openId },
  ]) {
    assert.throws(() => sealer.open(other, 'refresh', sealed), TikTokTokenUnopenable, JSON.stringify(other));
  }
  assert.throws(() => new TikTokTokenSealer(randomBytes(32)).open(binding, 'refresh', sealed), TikTokTokenUnopenable, 'another key');
  assert.throws(() => sealer.open(binding, 'refresh', { ...sealed, keyRef: 'tiktok-token/0000000000000000' }), TikTokTokenUnopenable, 'relabelled');
  const tampered = new Uint8Array(sealed.sealed);
  tampered[tampered.length - 1]! ^= 0xff;
  assert.throws(() => sealer.open(binding, 'refresh', { ...sealed, sealed: tampered }), TikTokTokenUnopenable, 'tampered');
  assert.throws(() => new TikTokTokenSealer(randomBytes(16)), /32-byte/);
  assert.throws(() => sealer.seal(binding, 'access', ''), /token is required/);

  // The same key never lets a TikTok token be read as a Google one, or the reverse.
  const google = new GoogleTokenSealer(key);
  assert.throws(() => google.open({ organizationId: ORG_A, userId: 'u1', googleSubject: KONA.openId }, { ...sealed, keyRef: google.keyRef }), GoogleTokenUnopenable);
  const googleSealed = google.seal({ organizationId: ORG_A, userId: 'u1', googleSubject: KONA.openId }, '1//x');
  assert.throws(() => sealer.open(binding, 'refresh', { ...googleSealed, keyRef: sealer.keyRef }), TikTokTokenUnopenable);
});

// --- Connect attempts ---------------------------------------------------------------------

test('a connect attempt is stored hashed, asks for the four scopes, and is used once, within ten minutes, by the same person in the same session', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  const begin = await w.service.beginConnect(kona);
  assert.equal(begin.kind, 'redirect');
  const { state, scopes } = w.tiktok.last();
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([...scopes], SCOPES, 'exactly the four registered scopes');
  const row = w.fake.tikTokOAuthState.__rows[0];
  assert.equal(row.stateHash, sha(state));
  assert.equal(JSON.stringify(w.fake.tikTokOAuthState.__rows).includes(state), false, 'the state value is never stored');
  assert.deepEqual([row.organizationId, row.userId, row.sessionId], [ORG_A, kona.userId, kona.sessionId]);
  assert.equal(row.expiresAt.getTime() - T0.getTime(), TIKTOK_OAUTH_STATE_LIFETIME_MS);

  const hash = sha(state);
  assert.equal(await w.repo.consumeState(ORG_A, kona.userId, 'another-session', hash, T0), false, 'another session');
  const river = await person(w, ORG_A);
  assert.equal(await w.repo.consumeState(ORG_A, river.userId, kona.sessionId, hash, T0), false, 'another person');
  assert.equal(await w.repo.consumeState(ORG_B, kona.userId, kona.sessionId, hash, T0), false, 'another organization');
  assert.equal(await w.repo.consumeState(ORG_A, kona.userId, kona.sessionId, hash, new Date(T0.getTime() + TIKTOK_OAUTH_STATE_LIFETIME_MS)), false, 'expired');
  assert.equal(await w.repo.consumeState(ORG_A, kona.userId, kona.sessionId, hash, T0), true);
  assert.equal(await w.repo.consumeState(ORG_A, kona.userId, kona.sessionId, hash, T0), false, 'used once');
});

test('open attempts are capped per person; used and expired ones are cleared first', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  for (let i = 0; i < TIKTOK_OAUTH_MAX_OPEN_STATES; i += 1) assert.equal((await w.service.beginConnect(kona)).kind, 'redirect');
  assert.deepEqual(await w.service.beginConnect(kona), { kind: 'return', outcome: 'TOO_MANY_ATTEMPTS' });
  const river = await person(w, ORG_A);
  assert.equal((await w.service.beginConnect(river)).kind, 'redirect', 'the cap is per person');
  w.advance(TIKTOK_OAUTH_STATE_LIFETIME_MS);
  assert.equal((await w.service.beginConnect(kona)).kind, 'redirect', 'expired attempts no longer count');
  assert.equal(w.fake.tikTokOAuthState.__rows.filter((r: any) => r.userId === kona.userId).length, 1);
});

test('a connect is refused before anything is stored when unconfigured or when no creator profile binds the login', async () => {
  const off = world({ configured: false });
  const kona = await person(off, ORG_A);
  assert.deepEqual(await off.service.beginConnect(kona), { kind: 'return', outcome: 'NOT_CONFIGURED' });

  const w = world();
  const employee = await person(w, ORG_A, { role: 'EMPLOYEE', profile: false });
  assert.deepEqual(await w.service.beginConnect(employee), { kind: 'return', outcome: 'NOT_PERMITTED' }, 'an employee is not a creator');
  const unbound = await person(w, ORG_A, { role: 'CREATOR', profile: false });
  assert.deepEqual(await w.service.beginConnect(unbound), { kind: 'return', outcome: 'NOT_PERMITTED' }, 'a CREATOR login with no profile is refused, not defaulted');
  assert.deepEqual(await w.service.status(unbound), { permitted: false });
  assert.equal(off.fake.tikTokOAuthState.__rows.length + w.fake.tikTokOAuthState.__rows.length, 0);
  assert.equal(w.tiktok.requests.length, 0);
});

// --- Completing a connect -----------------------------------------------------------------

test('a granted connection is stored sealed and audited by id and scope; the first read fills the profile; nothing secret is kept in the clear', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  assert.equal(await connect(w, kona, KONA, ALL), 'CONNECTED');

  const row = connection(w, kona);
  assert.equal(row.status, 'CONNECTED');
  assert.equal(row.tiktokOpenId, KONA.openId);
  assert.equal(row.activeTiktokOpenId, KONA.openId);
  assert.equal(row.handleAtLink, 'konareyes', 'the username the first read reported');
  assert.deepEqual(row.grantedScopes, SCOPES);
  assert.deepEqual(row.requestedScopes, SCOPES);
  assert.equal(row.accessTokenExpiresAt.getTime(), T0.getTime() + 86400_000);
  assert.ok(row.lastReadAt instanceof Date);
  const sealer = new TikTokTokenSealer(w.key);
  const binding = { organizationId: ORG_A, userId: kona.userId, tiktokOpenId: KONA.openId };
  assert.equal(sealer.open(binding, 'refresh', { sealVersion: row.sealVersion, keyRef: row.keyRef, sealed: new Uint8Array(row.refreshTokenSealed) }), `rft.${KONA.openId}.1`);
  assert.equal(sealer.open(binding, 'access', { sealVersion: row.sealVersion, keyRef: row.keyRef, sealed: new Uint8Array(row.accessTokenSealed) }), `act.${KONA.openId}.1`);

  const everything = JSON.stringify({ conn: w.fake.tikTokConnection.__rows, states: w.fake.tikTokOAuthState.__rows, audit: w.fake.auditLog.__rows, profiles: w.fake.creatorProfile.__rows });
  for (const secret of ['rft.', 'act.', 'authcode-', w.tiktok.last().state]) assert.equal(everything.includes(secret), false, secret);

  const [granted] = audits(w, 'tiktok.connection.granted');
  assert.equal(granted.organizationId, ORG_A);
  assert.equal(granted.userId, kona.userId);
  assert.equal(granted.entityId, row.id);
  assert.deepEqual(granted.metadata.scopes, SCOPES);
  assert.equal(JSON.stringify(granted).includes('konareyes'), false, 'no handle in the audit trail');
  assert.equal(JSON.stringify(granted).includes(KONA.openId), false, 'no account id in the audit trail');

  // The first read, straight after the grant: the profile's TikTok entry, merged; a follower observation from the platform.
  assert.deepEqual(w.tiktok.reads.map((r) => r.kind), ['user', 'videos']);
  assert.equal(w.tiktok.reads[0]!.token, `act.${KONA.openId}.1`);
  const entry = profileEntry(w, kona);
  assert.equal(entry.state, 'CONNECTED');
  assert.equal(entry.handle, 'konareyes');
  assert.equal(entry.connectedAt, T0.toISOString());
  assert.equal(entry.readAt, T0.toISOString());
  assert.deepEqual(entry.stats, { followers: 18412, following: 120, likes: 250000, videos: 88 });
  assert.equal(entry.audience, 18412);
  assert.equal(entry.recentVideos.length, 1);
  assert.equal(entry.recentVideos[0].id, 'v1');
  assert.deepEqual(audience(w, kona).map((a: any) => [a.followers, a.source, a.growth30dPct]), [[18412, 'PLATFORM', null]]);

  const status = await w.service.status(kona);
  assert.ok(status.permitted);
  assert.equal(status.state, 'CONNECTED');
  assert.equal(status.connection?.handle, 'konareyes');
  assert.deepEqual(status.connection?.missingScopes, []);
  assert.deepEqual(await w.service.beginConnect(kona), { kind: 'return', outcome: 'ALREADY_CONNECTED' });
});

test('a scope declined on TikTok’s screen is stored as declined: PARTIAL, no stats without user.info.stats, no videos without video.list', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  assert.equal(await connect(w, kona, KONA, 'user.info.basic,user.info.profile'), 'PARTIAL');
  const row = connection(w, kona);
  assert.deepEqual(row.grantedScopes, ['user.info.basic', 'user.info.profile']);
  assert.deepEqual(row.requestedScopes, SCOPES, 'what was asked for is remembered');
  const status = await w.service.status(kona);
  assert.ok(status.permitted);
  assert.equal(status.state, 'PARTIAL');
  assert.deepEqual(status.connection?.missingScopes, ['user.info.stats', 'video.list']);
  assert.deepEqual(w.tiktok.reads.map((r) => r.kind), ['user'], 'no video read without the scope');
  assert.deepEqual(w.tiktok.reads[0]!.scopes, ['user.info.basic', 'user.info.profile'], 'the read asks only for what was granted');
  const entry = profileEntry(w, kona);
  assert.equal(entry.state, 'CONNECTED');
  assert.equal(entry.handle, 'konareyes');
  assert.equal('stats' in entry, false, 'no counts were returned, so none are shown');
  assert.equal('recentVideos' in entry, false);
  assert.deepEqual(audience(w, kona), [], 'no follower count, no observation');
  assert.equal((await w.service.beginConnect(kona)).kind, 'redirect', 'a partial grant may be completed by asking again');
});

test('a grant broader than the four scopes, a missing basic scope, a refused screen or a failed exchange stores nothing', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  assert.equal(await connect(w, kona, KONA, `${ALL},video.upload`), 'UNEXPECTED_SCOPE');
  assert.equal(await connect(w, kona, KONA, 'video.list'), 'DECLINED', 'without the basic scope there is no account to name');
  assert.equal(await connect(w, kona, KONA, ALL, { refreshToken: null }), 'FAILED');
  assert.equal(await connect(w, kona, KONA, ALL, { expiresIn: 0 }), 'FAILED');
  for (const failure of ['INVALID_GRANT', 'REJECTED', 'NETWORK'] as const) {
    await w.service.beginConnect(kona);
    w.tiktok.failExchange(failure);
    assert.equal(await w.service.completeConnect(kona, { state: w.tiktok.last().state, code: 'authcode-fail' }), 'FAILED');
  }
  await w.service.beginConnect(kona);
  assert.equal(await w.service.completeConnect(kona, { state: w.tiktok.last().state, error: 'access_denied' }), 'DECLINED');
  await w.service.beginConnect(kona);
  assert.equal(await w.service.completeConnect(kona, { state: w.tiktok.last().state, error: 'server_error' }), 'FAILED');
  await w.service.beginConnect(kona);
  assert.equal(await w.service.completeConnect(kona, { state: w.tiktok.last().state }), 'INVALID_REQUEST');
  assert.equal(w.fake.tikTokConnection.__rows.length, 0);
  assert.equal(profileEntry(w, kona), null);
  assert.equal(audits(w).length, 0);
});

test('a replayed, expired or cross-session callback is refused before TikTok is called', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  await connect(w, kona, KONA, 'user.info.basic');
  const used = w.tiktok.last().state;
  const calls = w.tiktok.exchanged.length;
  assert.equal(await w.service.completeConnect(kona, { state: used, code: 'authcode-replay' }), 'STATE_INVALID');

  await w.service.beginConnect(kona);
  const fresh = w.tiktok.last().state;
  assert.equal(await w.service.completeConnect({ ...kona, sessionId: 'stolen-elsewhere' }, { state: fresh, code: 'authcode-x' }), 'STATE_INVALID');
  const mallory = await person(w, ORG_A);
  assert.equal(await w.service.completeConnect(mallory, { state: fresh, code: 'authcode-x' }), 'STATE_INVALID', 'another person cannot finish it');
  assert.equal(await w.service.completeConnect(null, { state: fresh, code: 'authcode-x' }), 'STATE_INVALID');
  assert.equal(await w.service.completeConnect(kona, { state: 'short', code: 'authcode-x' }), 'STATE_INVALID');
  w.advance(TIKTOK_OAUTH_STATE_LIFETIME_MS + 1);
  assert.equal(await w.service.completeConnect(kona, { state: fresh, code: 'authcode-x' }), 'STATE_INVALID');
  assert.equal(w.tiktok.exchanged.length, calls, 'no code was exchanged for any of them');
});

// --- One account per person, one person per account ---------------------------------------

test('a different TikTok account is refused while one is connected; after disconnecting, it may be connected', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  // A partial grant is the one case a connect is re-offered while a connection is live.
  await connect(w, kona, KONA, 'user.info.basic');
  assert.equal(await connect(w, kona, RIVER, ALL), 'DIFFERENT_ACCOUNT');
  assert.equal(connection(w, kona).tiktokOpenId, KONA.openId);
  assert.deepEqual(connection(w, kona).grantedScopes, ['user.info.basic'], 'nothing changed');
  // The repository refuses it on its own too, whoever calls it.
  const sealer = new TikTokTokenSealer(w.key);
  const binding = { organizationId: ORG_A, userId: kona.userId, tiktokOpenId: RIVER.openId };
  const direct = await w.repo.storeGrant(
    ORG_A,
    kona.userId,
    {
      tiktokOpenId: RIVER.openId,
      handleAtLink: null,
      grantedScopes: SCOPES,
      requestedScopes: SCOPES,
      credential: { refresh: sealer.seal(binding, 'refresh', 'rft.x'), access: sealer.seal(binding, 'access', 'act.x'), accessExpiresAt: new Date(T0.getTime() + HOUR) },
      now: T0,
    },
    { userId: kona.userId },
  );
  assert.deepEqual(direct, { outcome: 'DIFFERENT_ACCOUNT' });
  assert.equal(await w.service.disconnect(kona), 'DISCONNECTED');
  assert.equal(await connect(w, kona, RIVER, ALL), 'CONNECTED');
  const row = connection(w, kona);
  assert.equal(row.tiktokOpenId, RIVER.openId);
  assert.equal(row.revokedAt, null);
  assert.equal(audits(w, 'tiktok.connection.reconnected').length, 1);
  assert.equal(profileEntry(w, kona).handle, 'river');
});

test('one TikTok account links to one person per organization; another organization is independent', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  const river = await person(w, ORG_A);
  const other = await person(w, ORG_B);
  await connect(w, kona, KONA, ALL);
  assert.equal(await connect(w, river, KONA, ALL), 'ACCOUNT_IN_USE');
  assert.equal(connection(w, river), undefined);
  assert.equal(await connect(w, other, KONA, ALL), 'CONNECTED', 'the same account may be linked in another organization');
  await w.service.disconnect(kona);
  assert.equal(await connect(w, river, KONA, ALL), 'CONNECTED', 'released once revoked');
});

// --- Reading -------------------------------------------------------------------------------------

test('a visit reads only when the last read is old enough; the follower observation is recorded on change or once a day', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  await connect(w, kona, KONA, ALL);
  const reads = w.tiktok.reads.length;

  assert.deepEqual(await w.service.readOnVisit(kona), { ok: true, fresh: false, readAt: T0 });
  assert.equal(w.tiktok.reads.length, reads, 'a page render is not a reason to call TikTok');

  w.advance(16 * 60_000);
  w.tiktok.account({ ...KONA, followers: 18500 });
  const read = await w.service.readOnVisit(kona);
  assert.deepEqual(read, { ok: true, fresh: true, readAt: w.now() });
  assert.equal(w.tiktok.reads.length, reads + 2);
  assert.equal(profileEntry(w, kona).stats.followers, 18500);
  assert.equal(profileEntry(w, kona).readAt, w.now().toISOString());
  assert.deepEqual(audience(w, kona).map((a: any) => a.followers), [18412, 18500], 'a changed count is a new observation');

  w.advance(16 * 60_000);
  await w.service.readOnVisit(kona);
  assert.deepEqual(audience(w, kona).map((a: any) => a.followers), [18412, 18500], 'an unchanged count is not re-recorded within a day');
  // A day later the access token has expired too: the read refreshes (rotating the refresh token) first.
  w.advance(TIKTOK_AUDIENCE_REPEAT_INTERVAL_MS);
  w.tiktok.rotate();
  assert.equal((await w.service.readOnVisit(kona)).ok, true);
  assert.equal(w.tiktok.refreshed.length, 1);
  assert.deepEqual(audience(w, kona).map((a: any) => a.followers), [18412, 18500, 18500], 'and is re-recorded once a day while it holds');
  assert.equal(JSON.stringify(w.fake.tikTokConnection.__rows).includes('act.'), false, 'access tokens are never stored in the clear');
});

test('a read that fails records its class and keeps the grant; a video list that fails leaves the last one in place', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  await connect(w, kona, KONA, ALL);
  const before = profileEntry(w, kona);

  w.tiktok.failReads('UNAVAILABLE');
  assert.deepEqual(await w.service.readOnVisit(kona, { force: true }), { ok: false, state: 'UNAVAILABLE' });
  assert.equal(connection(w, kona).status, 'CONNECTED');
  assert.equal(connection(w, kona).lastFailureClass, 'READ_UNAVAILABLE');
  assert.deepEqual(profileEntry(w, kona), before, 'nothing shown changed');

  w.tiktok.failReads('FORBIDDEN');
  assert.deepEqual(await w.service.readOnVisit(kona, { force: true }), { ok: false, state: 'INSUFFICIENT_SCOPE' });
  assert.equal(connection(w, kona).lastFailureClass, 'READ_FORBIDDEN');

  w.tiktok.failReads(null, 'RATE_LIMITED');
  w.tiktok.account({ ...KONA, followers: 19000 });
  assert.equal((await w.service.readOnVisit(kona, { force: true })).ok, true);
  assert.equal(profileEntry(w, kona).stats.followers, 19000, 'the counts are new');
  assert.deepEqual(profileEntry(w, kona).recentVideos, before.recentVideos, 'the videos are the last ones read');
  assert.equal(connection(w, kona).lastFailureClass, null, 'a completed read clears the class');
});

// --- Refresh, expiry ------------------------------------------------------------------------------

test('an access token near expiry is refreshed first, and the ROTATED refresh token is what is kept', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  await connect(w, kona, KONA, ALL);
  const first = await w.service.accessToken(kona);
  assert.ok(first.ok);
  assert.equal(first.accessToken, `act.${KONA.openId}.1`);
  assert.deepEqual(w.tiktok.refreshed, [], 'a live token is used as it is');

  w.advance(24 * HOUR - 30_000);
  w.tiktok.rotate();
  const second = await w.service.accessToken(kona);
  assert.ok(second.ok);
  assert.equal(second.accessToken, `act.rotated.rft.${KONA.openId}.1`);
  assert.deepEqual(w.tiktok.refreshed, [`rft.${KONA.openId}.1`]);
  const row = connection(w, kona);
  assert.equal(row.accessTokenExpiresAt.getTime(), w.now().getTime() + 86400_000);
  const sealer = new TikTokTokenSealer(w.key);
  const binding = { organizationId: ORG_A, userId: kona.userId, tiktokOpenId: KONA.openId };
  assert.equal(sealer.open(binding, 'refresh', { sealVersion: row.sealVersion, keyRef: row.keyRef, sealed: new Uint8Array(row.refreshTokenSealed) }), `rft.${KONA.openId}.1.r`, 'the rotated one');

  w.advance(24 * HOUR);
  await w.service.accessToken(kona);
  assert.deepEqual(w.tiktok.refreshed, [`rft.${KONA.openId}.1`, `rft.${KONA.openId}.1.r`], 'the next refresh uses the rotated token');

  // A withdrawn scope is noticed on refresh.
  w.advance(24 * HOUR);
  w.tiktok.rotate('user.info.basic,user.info.profile');
  const narrowed = await w.service.accessToken(kona);
  assert.ok(narrowed.ok);
  assert.deepEqual(narrowed.record.grantedScopes, ['user.info.basic', 'user.info.profile']);
  assert.deepEqual(connection(w, kona).grantedScopes, ['user.info.basic', 'user.info.profile']);
  assert.equal(audits(w, 'tiktok.connection.scope_changed').length, 1);
});

test('a refused refresh expires the connection and deletes both tokens; a transient failure changes nothing; a rotated key expires instead of guessing', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  await connect(w, kona, KONA, ALL);
  w.advance(25 * HOUR);

  w.tiktok.onRefresh(() => ({ ok: false, failure: 'NETWORK' }));
  assert.deepEqual(await w.service.accessToken(kona), { ok: false, state: 'UNAVAILABLE' });
  assert.equal(connection(w, kona).status, 'CONNECTED');
  assert.deepEqual(await w.service.readOnVisit(kona), { ok: false, state: 'UNAVAILABLE' });

  w.tiktok.onRefresh(() => ({ ok: false, failure: 'INVALID_GRANT' }));
  assert.deepEqual(await w.service.accessToken(kona), { ok: false, state: 'EXPIRED' });
  const row = connection(w, kona);
  assert.equal(row.status, 'EXPIRED');
  assert.equal(row.refreshTokenSealed, null);
  assert.equal(row.accessTokenSealed, null);
  assert.equal(row.accessTokenExpiresAt, null);
  assert.equal(row.lastFailureClass, 'REFRESH_REFUSED');
  assert.equal(row.activeTiktokOpenId, KONA.openId, 'still this person’s account until they reconnect or disconnect');
  assert.equal(audits(w, 'tiktok.connection.expired').length, 1);
  const calls = w.tiktok.refreshed.length;
  assert.deepEqual(await w.service.accessToken(kona), { ok: false, state: 'EXPIRED' });
  assert.deepEqual(await w.service.readOnVisit(kona), { ok: false, state: 'EXPIRED' });
  assert.equal(w.tiktok.refreshed.length, calls, 'Loop stops calling');
  const status = await w.service.status(kona);
  assert.ok(status.permitted);
  assert.equal(status.state, 'EXPIRED');

  assert.equal(await connect(w, kona, KONA, ALL), 'CONNECTED', 'reconnecting restores it');
  assert.equal(connection(w, kona).expiredAt, null);

  const rotated = w.serviceWithKey(randomBytes(32));
  assert.deepEqual(await rotated.accessToken(kona), { ok: false, state: 'EXPIRED' });
  assert.equal(connection(w, kona).lastFailureClass, 'TOKEN_UNOPENABLE');
});

// --- Disconnect ---------------------------------------------------------------------------------

test('disconnecting deletes both tokens and the live link in one step, withdraws what was read, then asks TikTok to revoke the access token', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  await connect(w, kona, KONA, ALL);
  await w.service.beginConnect(kona);
  assert.equal(await w.service.disconnect(kona), 'DISCONNECTED');

  const row = connection(w, kona);
  assert.equal(row.status, 'REVOKED');
  assert.equal(row.refreshTokenSealed, null);
  assert.equal(row.accessTokenSealed, null);
  assert.equal(row.keyRef, null);
  assert.equal(row.activeTiktokOpenId, null);
  assert.equal(row.revocationReason, 'SELF_DISCONNECT');
  assert.equal(row.revokedByUserId, kona.userId);
  assert.ok(row.revocationConfirmedAt instanceof Date);
  assert.deepEqual(w.tiktok.revoked, [`act.${KONA.openId}.1`]);
  assert.deepEqual(w.tiktok.refreshed, [], 'a live access token is revoked as it is');
  assert.equal(w.fake.tikTokOAuthState.__rows.filter((r: any) => r.userId === kona.userId).length, 0, 'open attempts end too');
  const [revoked] = audits(w, 'tiktok.connection.revoked');
  assert.deepEqual(revoked.metadata.scopes, SCOPES);
  assert.equal(revoked.metadata.credentialDeleted, true);
  assert.deepEqual(profileEntry(w, kona), { platform: 'TIKTOK', state: 'NOT_CONNECTED', handle: 'konareyes' }, 'counts and videos read under the grant are withdrawn; the handle stays');
  const status = await w.service.status(kona);
  assert.ok(status.permitted);
  assert.equal(status.state, 'NOT_CONNECTED');
  assert.equal(await w.service.disconnect(kona), 'NOT_CONNECTED');
});

test('an expired access token is replaced before revoking; a grant TikTok already refuses counts as revoked; a failed call is said', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  await connect(w, kona, KONA, ALL);
  w.advance(25 * HOUR);
  w.tiktok.rotate();
  assert.equal(await w.service.disconnect(kona), 'DISCONNECTED');
  assert.deepEqual(w.tiktok.refreshed, [`rft.${KONA.openId}.1`]);
  assert.deepEqual(w.tiktok.revoked, [`act.rotated.rft.${KONA.openId}.1`], 'the fresh access token is the one revoked');

  const river = await person(w, ORG_A);
  await connect(w, river, RIVER, ALL);
  w.advance(25 * HOUR);
  w.tiktok.onRefresh(() => ({ ok: false, failure: 'INVALID_GRANT' }));
  assert.equal(await w.service.disconnect(river), 'DISCONNECTED', 'nothing left at TikTok to revoke');
  assert.ok(connection(w, river).revocationConfirmedAt instanceof Date);

  const sam = await person(w, ORG_A);
  await connect(w, sam, { openId: 'open-sam', username: 'sam', followers: 1, videoCount: 0 }, ALL);
  w.tiktok.onRevoke(() => ({ ok: false, failure: 'NETWORK' }));
  assert.equal(await w.service.disconnect(sam), 'DISCONNECTED_UNCONFIRMED');
  const row = connection(w, sam);
  assert.equal(row.refreshTokenSealed, null, 'Loop’s copy is gone either way');
  assert.equal(row.lastFailureClass, 'REVOKE_UNCONFIRMED');
  assert.equal(row.revocationConfirmedAt, null);
  assert.equal(audits(w, 'tiktok.connection.revoke_unconfirmed').length, 1);
  const status = await w.service.status(sam);
  assert.ok(status.permitted);
  assert.equal(status.connection?.revocationUnconfirmed, true);
});

test('revoking never breaks another organization: a shared TikTok grant is left for its other holder', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  const other = await person(w, ORG_B);
  await connect(w, kona, KONA, ALL);
  await connect(w, other, KONA, ALL);
  assert.equal(await w.service.disconnect(kona), 'DISCONNECTED_UNCONFIRMED');
  assert.deepEqual(w.tiktok.revoked, [], 'TikTok was not asked to revoke the account’s grant');
  assert.equal(connection(w, kona).refreshTokenSealed, null, 'Loop’s copy for this person is gone');
  assert.equal(connection(w, kona).lastFailureClass, 'REVOKE_SKIPPED_SHARED_GRANT');
  assert.equal(connection(w, other).status, 'CONNECTED');
  assert.equal(await w.service.disconnect(other), 'DISCONNECTED', 'the last holder revokes');
  assert.equal(w.tiktok.revoked.length, 1);
});

// --- Isolation and authority ------------------------------------------------------------------

test('nobody reaches another organization’s connection or attempts, and a disabled member cannot store a late grant', async () => {
  const w = world();
  const kona = await person(w, ORG_A);
  await connect(w, kona, KONA, ALL);
  const elsewhere = { organizationId: ORG_B, userId: kona.userId, name: 'x', sessionId: kona.sessionId };
  assert.equal(await w.repo.find(ORG_B, kona.userId), null);
  assert.equal(await w.repo.credential(ORG_B, kona.userId), null);
  assert.equal(await w.repo.revoke(ORG_B, kona.userId, { reason: 'SELF_DISCONNECT', actor: { userId: null }, now: T0 }), null);
  assert.equal(await w.repo.markExpired(ORG_B, kona.userId, connection(w, kona).id, 'REFRESH_REFUSED', T0), false);
  assert.equal(await w.repo.recordRead(ORG_B, kona.userId, connection(w, kona).id, T0), false);
  await w.repo.recordRevocationResult(ORG_B, connection(w, kona).id, { confirmed: false, failureClass: 'REVOKE_UNCONFIRMED' }, T0, { userId: null });
  assert.equal(connection(w, kona).status, 'CONNECTED');
  assert.equal(connection(w, kona).lastFailureClass, null);
  assert.deepEqual(await w.service.status(elsewhere), { permitted: false }, 'no profile there, no view');
  assert.equal(await w.service.disconnect(elsewhere), 'NOT_PERMITTED');
  assert.deepEqual(await w.service.readOnVisit(elsewhere), { ok: false, state: 'NOT_PERMITTED' });
  assert.equal(connection(w, kona).status, 'CONNECTED');

  // Standing is re-read inside the storing transaction.
  const carol = await person(w, ORG_A);
  await w.iam.disableMember(ORG_A, carol.userId, { userId: kona.userId, name: 'Admin' });
  const sealer = new TikTokTokenSealer(w.key);
  const binding = { organizationId: ORG_A, userId: carol.userId, tiktokOpenId: 'open-late' };
  const late = await w.repo.storeGrant(
    ORG_A,
    carol.userId,
    {
      tiktokOpenId: 'open-late',
      handleAtLink: null,
      grantedScopes: ['user.info.basic'],
      requestedScopes: ['user.info.basic'],
      credential: { refresh: sealer.seal(binding, 'refresh', 'rft.late'), access: sealer.seal(binding, 'access', 'act.late'), accessExpiresAt: new Date(T0.getTime() + HOUR) },
      now: T0,
    },
    { userId: carol.userId },
  );
  assert.deepEqual(late, { outcome: 'NOT_PERMITTED' });
  assert.equal(connection(w, carol), undefined);
});

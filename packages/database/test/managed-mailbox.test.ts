import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import {
  GoogleTokenSealer,
  GoogleTokenUnopenable,
} from '../src/services/google/google-token-sealer';
import type {
  GoogleOAuthPort,
  GoogleSessionPrincipal,
} from '../src/services/google/google-workspace.service';
import { ManagedMailboxService } from '../src/creator/managed-mailbox.service';
import { IamRepository } from '../src/repositories/iam.repository';
import { CreatorRepository } from '../src/creator/creator.repository';
import { GoogleConnectionRepository } from '../src/repositories/google-connection.repository';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { googleAuthorizationUrl } from '@emgloop/providers';

const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const T0 = new Date('2026-11-02T17:00:00Z');
async function world() {
  const db = makeCognitivePrisma({
    also: [
      'managedGoogleMailbox',
      'managedGoogleOAuthState',
      'userSession',
      'creatorProfile',
      'organizationMembership',
      'googleConnection',
      'googleOAuthState',
    ],
  }) as unknown as PrismaClient;
  const iam = new IamRepository(db);
  async function member(role: string, email: string, organizationId = 'a') {
    const u = await iam.createUser({ organizationId, email, systemRole: role });
    await iam.activateUser(organizationId, u.id);
    const session = await db.userSession.create({
      data: {
        organizationId,
        userId: u.id,
        revokedAt: null,
        expiresAt: new Date(T0.getTime() + 3600_000),
      },
    });
    return { organizationId, userId: u.id, sessionId: session.id };
  }
  const owner = await member('OWNER', 'matt@elitemediagroup.io');
  const manager = await member('MANAGER', 'manager@example.test');
  const creator = await member('CREATOR', 'creator@example.test');
  const employee = await member('EMPLOYEE', 'employee@example.test');
  const foreign = await member('OWNER', 'foreign@example.test', 'b');
  const profile = await db.creatorProfile.create({
    data: {
      organizationId: 'a',
      partyId: 'party_trevon',
      displayName: 'Trevon Hill',
      userId: creator.userId,
      preferences: { managedMailboxEmail: 'trevon@emgtalentgroup.com' },
    },
  });
  let now = T0,
    seq = 0,
    request: Parameters<GoogleOAuthPort['authorizationUrl']>[0] | null = null;
  let email = 'matt@elitemediagroup.io',
    scopes = `openid email ${READ}`,
    validIdentity = true,
    exchanges = 0,
    reads = 0;
  let onExchange = async () => {},
    onRefresh = async () => {},
    onRead = async () => {};
  const sealer = new GoogleTokenSealer(new Uint8Array(32).fill(19));
  const oauth: GoogleOAuthPort = {
    authorizationUrl: (input) => {
      request = input;
      return googleAuthorizationUrl({
        clientId: 'client',
        redirectUri: 'https://app.example.test/api/integrations/google/callback',
        ...input,
      });
    },
    signingKeysReady: async () => true,
    exchangeCode: async () => {
      exchanges++;
      await onExchange();
      return {
        ok: true,
        grant: {
          accessToken: 'private-access',
          refreshToken: 'private-refresh',
          scope: scopes,
          idToken: 'verified-by-port',
          expiresInSeconds: 3600,
        },
      };
    },
    checkIdToken: async (_token, expected) =>
      validIdentity && request && expected.nonceMatches(request.nonce)
        ? {
            ok: true,
            identity: { subject: `sub:${email}`, email, hostedDomain: email.split('@')[1]! },
          }
        : { ok: false, refusal: 'SIGNATURE' },
    refresh: async (token) => {
      assert.equal(token, 'private-refresh');
      await onRefresh();
      return {
        ok: true,
        grant: {
          accessToken: 'private-access',
          refreshToken: null,
          scope: null,
          idToken: null,
          expiresInSeconds: 3600,
        },
      };
    },
    revoke: async () => {
      throw Error('must not revoke an app-wide Google grant used by other connections');
    },
  };
  const service = new ManagedMailboxService(db, {
    configured: { oauth, sealer },
    now: () => now,
    randomToken: () => String(++seq).padStart(43, 'a'),
    fetchImpl: async () => {
      throw Error('network disabled');
    },
    readThread: async (input) => {
      reads++;
      assert.equal(input.accessToken, 'private-access');
      await onRead();
      return { ok: false, failure: 'AUTH' };
    },
  });
  async function begin(
    p = owner,
    address = 'matt@elitemediagroup.io',
    creatorProfileId: string | null = null,
  ) {
    const r = await service.begin(p, { creatorProfileId, expectedEmail: address, confirmed: true });
    assert.ok('url' in r, JSON.stringify(r));
    return { state: new URL(r.url).searchParams.get('state')!, url: r.url };
  }
  async function connect(
    address = 'matt@elitemediagroup.io',
    creatorProfileId: string | null = null,
    principal = owner,
  ) {
    email = address;
    const start = await begin(principal, address, creatorProfileId);
    assert.equal(
      (await service.complete(principal, { state: start.state, code: 'authorization-code' }))
        .outcome,
      'CONNECTED',
    );
    return (await service.repository.inventory(principal, creatorProfileId))!.find(
      (m) => m.expectedEmail === address,
    )!;
  }
  return {
    db,
    iam,
    service,
    owner,
    manager,
    creator,
    employee,
    foreign,
    profile,
    sealer,
    begin,
    connect,
    exchangeCount: () => exchanges,
    readCount: () => reads,
    email: (value: string) => {
      email = value;
    },
    scopes: (value: string) => {
      scopes = value;
    },
    invalidIdentity: () => {
      validIdentity = false;
    },
    clock: (value: Date) => {
      now = value;
    },
    exchangeHook: (hook: () => Promise<void>) => {
      onExchange = hook;
    },
    refreshHook: (hook: () => Promise<void>) => {
      onRefresh = hook;
    },
    readHook: (hook: () => Promise<void>) => {
      onRead = hook;
    },
  };
}

test('staff authorize once for the roster; multiple staff and a creator source coexist without touching private Google connections', async () => {
  const w = await world();
  await w.db.googleConnection.create({
    data: {
      organizationId: 'a',
      userId: w.owner.userId,
      googleSubject: 'personal',
      status: 'CONNECTED',
      emailAtLink: 'matt@elitemediagroup.io',
      grantedScopes: [READ],
      connectedAt: T0,
    },
  });
  const original = await w.db.googleConnection.findMany();
  for (const address of [
    'matt@elitemediagroup.io',
    'charlie@elitemediagroup.io',
    'francesca@elitemediagroup.io',
  ])
    await w.connect(address);
  const creatorMailbox = await w.connect('trevon@emgtalentgroup.com', w.profile.id);
  assert.equal((await w.service.repository.inventory(w.owner, null))!.length, 3);
  assert.equal((await w.service.repository.inventory(w.owner, w.profile.id))!.length, 1);
  assert.equal(creatorMailbox.kind, 'CREATOR');
  assert.deepEqual(await w.db.googleConnection.findMany(), original);
  await w.connect('matt@elitemediagroup.io');
  assert.equal(
    await w.db.managedGoogleMailbox.count(),
    4,
    'reconnect reuses the staff source, not one copy per creator',
  );
  const data = JSON.stringify(await w.db.managedGoogleMailbox.findMany());
  assert.ok(!data.includes('private-refresh'));
  assert.ok(!data.includes('private-access'));
  const inventory = JSON.stringify(await w.service.repository.inventory(w.owner, null));
  assert.doesNotMatch(inventory, /refreshTokenSealed|keyRef|googleSubject|revision|private-/);
  assert.doesNotMatch(JSON.stringify(await w.db.auditLog.findMany()), /matt@|trevon@|private-/);
});

test('a manager may connect; creators, employees, cross-org profiles and explicit denies cannot', async () => {
  const w = await world();
  await w.connect('charlie@elitemediagroup.io', null, w.manager);
  for (const p of [w.creator, w.employee]) {
    assert.equal(
      (
        (await w.service.begin(p, {
          creatorProfileId: null,
          expectedEmail: 'other@example.test',
          confirmed: true,
        })) as { outcome: string }
      ).outcome,
      'NOT_ALLOWED',
    );
    assert.equal(await w.service.repository.inventory(p, null), null);
  }
  assert.equal(
    (
      (await w.service.begin(w.foreign, {
        creatorProfileId: w.profile.id,
        expectedEmail: 'trevon@emgtalentgroup.com',
        confirmed: true,
      })) as { outcome: string }
    ).outcome,
    'NOT_ALLOWED',
  );
  await w.db.permission.create({
    data: {
      organizationId: 'a',
      userId: w.owner.userId,
      resource: 'managedMailboxes',
      action: 'update',
      effect: 'DENY',
    },
  });
  assert.equal(
    (
      (await w.service.begin(w.owner, {
        creatorProfileId: null,
        expectedEmail: 'other@example.test',
        confirmed: true,
      })) as { outcome: string }
    ).outcome,
    'NOT_ALLOWED',
  );
});

test('OAuth is offline read-only, exact-account checked, single-use and bound to the initiating session', async () => {
  const w = await world();
  const start = await w.begin();
  const query = new URL(start.url).searchParams;
  assert.equal(query.get('access_type'), 'offline');
  assert.equal(query.get('include_granted_scopes'), 'false');
  assert.deepEqual(query.get('scope')!.split(' '), ['openid', 'email', READ]);
  assert.equal(
    (await w.service.complete(w.manager, { state: start.state, code: 'authorization-code' }))
      .outcome,
    'STATE_INVALID',
  );
  assert.equal(
    (
      await w.service.complete(
        { ...w.owner, sessionId: 'other-session' },
        { state: start.state, code: 'authorization-code' },
      )
    ).outcome,
    'STATE_INVALID',
  );
  w.email('wrong@example.test');
  assert.equal(
    (await w.service.complete(w.owner, { state: start.state, code: 'authorization-code' })).outcome,
    'WRONG_ACCOUNT',
  );
  assert.equal(
    (await w.service.complete(w.owner, { state: start.state, code: 'authorization-code' })).outcome,
    'STATE_INVALID',
  );
  assert.equal(await w.db.managedGoogleMailbox.count({ where: { status: 'CONNECTED' } }), 0);
  assert.equal(w.exchangeCount(), 1);
});

test('expired, declined, invalid-signature and widened-scope attempts store no credential', async () => {
  for (const scenario of ['expired', 'declined', 'signature', 'scope'] as const) {
    const w = await world();
    const start = await w.begin();
    if (scenario === 'expired') w.clock(new Date(T0.getTime() + 600_001));
    if (scenario === 'signature') w.invalidIdentity();
    if (scenario === 'scope')
      w.scopes(`openid email ${READ} https://www.googleapis.com/auth/gmail.send`);
    const r = await w.service.complete(w.owner, {
      state: start.state,
      code: 'authorization-code',
      ...(scenario === 'declined' ? { error: 'access_denied' } : {}),
    });
    assert.equal(
      r.outcome,
      {
        expired: 'STATE_INVALID',
        declined: 'DECLINED',
        signature: 'FAILED',
        scope: 'SCOPE_REFUSED',
      }[scenario],
    );
    assert.ok(
      (await w.db.managedGoogleMailbox.findMany()).every((row) => row.refreshTokenSealed === null),
    );
  }
});

test('assignment changes, disconnect during OAuth and manager offboarding cannot attach a late grant', async () => {
  for (const scenario of ['assignment', 'disconnect', 'offboard'] as const) {
    const w = await world();
    w.email('trevon@emgtalentgroup.com');
    const start = await w.begin(w.owner, 'trevon@emgtalentgroup.com', w.profile.id);
    w.exchangeHook(async () => {
      if (scenario === 'assignment')
        await w.db.creatorProfile.update({
          where: { id: w.profile.id },
          data: { preferences: { managedMailboxEmail: 'changed@emgtalentgroup.com' } },
        });
      if (scenario === 'disconnect') {
        const row = (await w.service.repository.inventory(w.owner, w.profile.id))![0]!;
        await w.service.repository.disconnect(w.owner, row.id, T0);
      }
      if (scenario === 'offboard') await w.iam.disableMember('a', w.owner.userId);
    });
    assert.notEqual(
      (await w.service.complete(w.owner, { state: start.state, code: 'authorization-code' }))
        .outcome,
      'CONNECTED',
    );
    assert.ok(
      (await w.db.managedGoogleMailbox.findMany()).every((row) => row.refreshTokenSealed === null),
    );
  }
});

test('refresh uses the saved source without a new login, and revocation during reads discards the result', async () => {
  const w = await world();
  const row = await w.connect();
  assert.deepEqual(await w.service.readThread(w.manager, row.id, 'thread'), {
    ok: false,
    failure: 'AUTH',
  });
  assert.equal(w.exchangeCount(), 1);
  assert.equal(w.readCount(), 1);
  w.readHook(async () => {
    await w.service.repository.disconnect(w.owner, row.id, T0);
  });
  assert.deepEqual(await w.service.readThread(w.owner, row.id, 'thread'), {
    ok: false,
    failure: 'UNAVAILABLE',
  });
  const saved = await w.db.managedGoogleMailbox.findFirst({ where: { id: row.id } });
  assert.equal(saved?.refreshTokenSealed, null);
  assert.equal(await w.service.repository.disconnect(w.foreign, row.id, T0), 'NOT_ALLOWED');
});

test('sealed credentials are mailbox-bound; offboarding and demotion clear them atomically', async () => {
  for (const mode of ['disable', 'remove', 'demote'] as const) {
    const w = await world();
    const row = await w.connect();
    const credential = await w.service.repository.credential(w.owner, row.id);
    assert.ok(credential?.refreshTokenSealed);
    const sealed = credential.refreshTokenSealed;
    assert.throws(
      () =>
        w.sealer.open(
          { organizationId: 'a', userId: w.owner.userId, googleSubject: credential.googleSubject! },
          {
            sealed,
            keyRef: credential.keyRef!,
            sealVersion: credential.sealVersion!,
          },
        ),
      GoogleTokenUnopenable,
    );
    if (mode === 'disable') await w.iam.disableMember('a', w.owner.userId);
    if (mode === 'remove') await w.iam.removeMember('a', w.owner.userId);
    if (mode === 'demote') await w.iam.updateUserRole('a', w.owner.userId, 'EMPLOYEE');
    const stored = await w.db.managedGoogleMailbox.findFirst({ where: { id: row.id } });
    assert.equal(stored?.refreshTokenSealed, null, mode);
    assert.equal(stored?.status, 'DISCONNECTED', mode);
    assert.equal(await w.service.repository.credential(w.manager, row.id), null, mode);
  }
});

test('a changed manager assignment invalidates saved tokens and cannot be undone by a creator preferences save', async () => {
  const w = await world();
  const row = await w.connect('trevon@emgtalentgroup.com', w.profile.id);
  const creators = new CreatorRepository(w.db);
  await creators.updateProfile('a', w.profile.id, {
    preferences: { managedMailboxEmail: 'spoofed@example.test', theme: 'dark' },
  });
  assert.equal(
    await w.service.repository.creatorAddress(w.owner, w.profile.id),
    'trevon@emgtalentgroup.com',
  );
  const preload = (mailboxEmail: string) =>
    creators.preloadAccounts('a', w.owner.userId, w.profile.id, {
      handles: { TIKTOK: '@trevonhill' },
      mailboxEmail,
      followers: {},
      tiktokOneUrl: '',
      medianViews: '',
      engagementPct: '',
      view6sPct: '',
    });
  assert.equal(await preload('changed@emgtalentgroup.com'), 'SAVED');
  assert.equal(await preload('trevon@emgtalentgroup.com'), 'SAVED');
  assert.equal(
    (await w.db.managedGoogleMailbox.findFirst({ where: { id: row.id } }))?.refreshTokenSealed,
    null,
  );
  assert.equal(await w.service.repository.credential(w.owner, row.id), null);
});

test('disconnecting a private Google connection detects the shared grant and does not revoke it for other sources', async () => {
  const w = await world();
  const row = await w.connect();
  const personal = new GoogleConnectionRepository(w.db);
  assert.equal(
    await personal.liveGrantElsewhere('sub:matt@elitemediagroup.io', 'private-connection'),
    true,
  );
  await w.service.repository.disconnect(w.owner, row.id, T0);
  assert.equal(
    await personal.liveGrantElsewhere('sub:matt@elitemediagroup.io', 'private-connection'),
    false,
  );
});

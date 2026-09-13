// Organization membership, separate from the login. CRM Phase Zero P0.2b.
//
// Drives the REAL IamRepository and AuthRepository lifecycle writes against the
// in-memory Prisma double (which enforces @@unique([userId, organizationId]) and
// @@unique([organizationId, email]) the way Postgres does). Proves that every
// User lifecycle write leaves exactly the membership its row implies; that
// memberships are organization-scoped and fail closed; that two same-email
// logins in two organizations stay two principals; that User ids never change;
// that `can()` still resolves from the User row; that nothing here creates a
// Party or a commercial role; and that the migration's SQL backfill encodes the
// same rule as `membershipFromUser`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SystemRole, type PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository, matrixAllows } from '../src/repositories/iam.repository';
import { AuthRepository } from '../src/repositories/auth.repository';
import {
  MembershipRepository,
  compareMembershipCoverage,
  isActiveMembership,
  membershipFromUser,
  syncMembershipFromUser,
} from '../src/repositories/membership.repository';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const ROOT = new URL('../../..', import.meta.url);

function setup() {
  const fake: any = makeCognitivePrisma({ also: ['invitation', 'organizationMembership'] });
  const prisma = fake as PrismaClient;
  return {
    fake,
    iam: new IamRepository(prisma),
    auth: new AuthRepository(prisma),
    memberships: new MembershipRepository(prisma),
  };
}

function code(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

// ---- The derivation --------------------------------------------------------

// The same fixtures the migration was replayed against on real Postgres (PGlite,
// all 31 migrations in order). Each row: User status, metadata -> expected
// membership, or null for "no membership".
const PARITY: Array<[string, Record<string, unknown>, { role: string; status: string; effectiveTo: string | null } | null]> = [
  ['ACTIVE', { systemRole: 'OWNER', passwordHash: 'h' }, { role: 'OWNER', status: 'ACTIVE', effectiveTo: null }],
  ['ACTIVE', { passwordHash: 'h' }, { role: 'EMPLOYEE', status: 'ACTIVE', effectiveTo: null }],
  ['INVITED', { systemRole: null }, { role: 'EMPLOYEE', status: 'INVITED', effectiveTo: null }],
  ['ACTIVE', { systemRole: 7 }, { role: 'EMPLOYEE', status: 'ACTIVE', effectiveTo: null }],
  ['ACTIVE', { systemRole: 'owner' }, null],
  ['DISABLED', { systemRole: 'MANAGER', removedAt: '2026-08-01T10:20:30.123Z' }, { role: 'MANAGER', status: 'REMOVED', effectiveTo: '2026-08-01T10:20:30.123Z' }],
  ['DISABLED', { systemRole: 'EMPLOYEE', removedAt: '2026-02-30T10:20:30Z' }, { role: 'EMPLOYEE', status: 'REMOVED', effectiveTo: null }],
  ['DISABLED', { removedAt: true }, { role: 'EMPLOYEE', status: 'REMOVED', effectiveTo: null }],
  ['DISABLED', { removedAt: '' }, { role: 'EMPLOYEE', status: 'DISABLED', effectiveTo: null }],
  ['DISABLED', { removedAt: 0 }, { role: 'EMPLOYEE', status: 'DISABLED', effectiveTo: null }],
  ['DISABLED', { systemRole: 'READ_ONLY' }, { role: 'READ_ONLY', status: 'DISABLED', effectiveTo: null }],
  ['ACTIVE', { systemRole: 'ADMIN', removedAt: '2026-08-01T00:00:00.000Z' }, { role: 'ADMIN', status: 'ACTIVE', effectiveTo: null }],
  ['INVITED', { systemRole: 'AI_EMPLOYEE' }, { role: 'AI_EMPLOYEE', status: 'INVITED', effectiveTo: null }],
];

test('one existing user derives exactly the membership its row already means', () => {
  for (const [status, metadata, expected] of PARITY) {
    const d = membershipFromUser({ status, metadata });
    const label = `${status} ${JSON.stringify(metadata)}`;
    if (!expected) {
      assert.equal(d.derivable, false, label);
      continue;
    }
    assert.ok(d.derivable, label);
    assert.equal(d.systemRole, expected.role, label);
    assert.equal(d.status, expected.status, label);
    // JS `new Date('2026-02-30T...')` rolls over to March; the derivation must
    // not, matching the migration's parse-or-NULL.
    assert.equal(d.removedAt ? d.removedAt.toISOString() : null, expected.effectiveTo, label);
  }
  assert.equal(membershipFromUser({ status: 'SUSPENDED', metadata: {} }).derivable, false, 'unknown status fails closed');
});

test('the migration backfill encodes the same rule: real roles, real statuses, read-only over users', () => {
  const sql = readFileSync(
    new URL('packages/database/prisma/migrations/20260914000000_crm_p0_2b_organization_membership/migration.sql', ROOT),
    'utf8',
  );
  assert.equal(/[^\x00-\x7F]/.test(sql), false, 'ASCII only');
  const body = sql.replace(/^\s*--.*$/gm, ' ');
  const roleList = body.match(/"role" IN \(([^)]*)\)/)?.[1] ?? '';
  assert.deepEqual(roleList.split(',').map((r) => r.trim().replace(/'/g, '')).sort(), [...Object.values(SystemRole)].sort());
  assert.match(body, /"userStatus" IN \('INVITED', 'ACTIVE', 'DISABLED'\)/);
  assert.match(body, /WHEN 'string' {2}THEN \(u\."metadata" ->> 'removedAt'\) <> ''/);
  assert.match(body, /'mbr_' \|\| d\."userId"/);
  const statements = body.replace(/ON (UPDATE|DELETE) (CASCADE|SET NULL)/g, ' ');
  assert.equal(/\b(DROP|DELETE|TRUNCATE|ALTER TABLE "users"|UPDATE)\b/i.test(statements), false,
    'nothing existing is dropped, deleted or updated');
  assert.equal(/cognitive_identities|identity_/.test(body), false, 'no identity table is touched');
});

// ---- Lifecycle writes -------------------------------------------------------

test('every lifecycle write leaves the membership its User row implies, and the User id never changes', async () => {
  const { fake, iam, memberships } = setup();
  const created = await iam.createUser({ organizationId: ORG_A, email: 'Pat@X.io', systemRole: 'MANAGER' });
  let m = await memberships.findMembership(ORG_A, created.id);
  assert.equal(m?.status, 'INVITED');
  assert.equal(m?.systemRole, 'MANAGER');
  assert.equal(m?.effectiveFrom.getTime(), created.createdAt.getTime());

  await iam.activateUser(ORG_A, created.id);
  assert.equal((await memberships.findMembership(ORG_A, created.id))?.status, 'ACTIVE');

  await iam.updateUserRole(ORG_A, created.id, 'ADMIN');
  assert.equal((await memberships.findMembership(ORG_A, created.id))?.systemRole, 'ADMIN');

  await iam.disableUser(ORG_A, created.id);
  m = await memberships.findMembership(ORG_A, created.id);
  assert.equal(m?.status, 'DISABLED');
  assert.equal(m?.effectiveTo, null, 'disabled is a suspension, not an end');

  await iam.activateUser(ORG_A, created.id);
  await iam.softRemoveUser(ORG_A, created.id);
  m = await memberships.findMembership(ORG_A, created.id);
  assert.equal(m?.status, 'REMOVED');
  assert.ok(m?.effectiveTo instanceof Date, 'removal ends the membership period');

  const outcome = await iam.prepareInvitation({
    organizationId: ORG_A, email: 'pat@x.io', systemRole: 'EMPLOYEE', invitedByUserId: 'user_admin',
  });
  assert.deepEqual(outcome, { ok: true, userId: created.id, reused: true }, 'the same User row is reinstated');
  m = await memberships.findMembership(ORG_A, created.id);
  assert.equal(m?.status, 'INVITED');
  assert.equal(m?.systemRole, 'EMPLOYEE');
  assert.equal(m?.effectiveTo, null, 'a new period');
  assert.equal(m?.invitedByUserId, 'user_admin');

  assert.equal(fake.user.__rows.length, 1);
  assert.equal(fake.organizationMembership.__rows.length, 1, 'exactly one membership row ever');
  assert.equal(fake.user.__rows[0].id, created.id);
});

test('a brand-new invitation records the inviter the caller established from the session', async () => {
  const { iam, memberships } = setup();
  const outcome = await iam.prepareInvitation({
    organizationId: ORG_A, email: 'new@x.io', systemRole: 'READ_ONLY', invitedByUserId: 'user_owner',
  });
  assert.ok(outcome.ok);
  const m = await memberships.findMembership(ORG_A, outcome.userId);
  assert.deepEqual([m?.status, m?.systemRole, m?.invitedByUserId], ['INVITED', 'READ_ONLY', 'user_owner']);

  const actions = code('apps/web/src/crm/admin-actions.ts');
  assert.match(actions, /invitedByUserId: session\.userId/, 'the inviter comes from the session');
  assert.equal(/formData\.get\(['"]invitedBy/.test(actions), false, 'never from a form field');
});

test('login never touches membership, so a lagging migration can never lock anyone out', async () => {
  // `recordLogin` writes status ACTIVE, but `login()` refuses every non-ACTIVE
  // user before reaching it: the write cannot change a membership-relevant fact.
  // Keeping login off the new table means that if this code ever went live before
  // its migration, sign-in would keep working while only team edits failed loudly.
  const { fake, iam, auth } = setup();
  const u = await iam.createUser({ organizationId: ORG_A, email: 'l@x.io', systemRole: 'EMPLOYEE' });
  await iam.activateUser(ORG_A, u.id);
  const before = JSON.stringify(fake.organizationMembership.__rows);
  delete fake.organizationMembership;
  await auth.recordLogin(u.id);
  fake.organizationMembership = { __rows: JSON.parse(before) };
  assert.equal(JSON.stringify(fake.organizationMembership.__rows), before);
  const authCode = code('packages/database/src/repositories/auth.repository.ts');
  assert.equal(/membership/i.test(authCode), false, 'the auth repository names no membership');
  const loginGuard = code('apps/web/src/auth/auth.ts');
  assert.match(loginGuard, /if \(user\.status !== 'ACTIVE'\)[\s\S]*?recordLogin\(user\.id\)/, 'only ACTIVE users reach recordLogin');
});

test('a user whose role names no SystemRole gets no membership: fail closed', async () => {
  const { fake, memberships } = setup();
  const row = await fake.user.create({
    data: { organizationId: ORG_A, email: 'odd@x.io', status: 'ACTIVE', metadata: { systemRole: 'SUPERUSER' } },
  });
  assert.equal(await syncMembershipFromUser(fake, row), null);
  assert.equal(await memberships.findMembership(ORG_A, row.id), null);
  assert.equal((await memberships.coverage(ORG_A)).underivableRole, 1);
});

// ---- Isolation and fail-closed reads ----------------------------------------

test('membership is organization-scoped: another organization reads nothing and writes nothing', async () => {
  const { fake, iam, memberships } = setup();
  const u = await iam.createUser({ organizationId: ORG_A, email: 'a@x.io', systemRole: 'OWNER' });
  await iam.activateUser(ORG_A, u.id);
  const snapshot = JSON.stringify(fake.organizationMembership.__rows);

  assert.equal(await memberships.findMembership(ORG_B, u.id), null);
  assert.equal(await memberships.activeMembership(ORG_B, u.id), null);
  await iam.disableUser(ORG_B, u.id);
  await iam.softRemoveUser(ORG_B, u.id);
  await iam.updateUserRole(ORG_B, u.id, 'READ_ONLY');
  assert.equal(JSON.stringify(fake.organizationMembership.__rows), snapshot, 'cross-org lifecycle writes touch nothing');
  assert.ok(await memberships.activeMembership(ORG_A, u.id));
});

test('membership status fails closed: only a current ACTIVE membership lets a User act', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  const base = { effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: null };
  assert.equal(isActiveMembership({ ...base, status: 'ACTIVE' }, now), true);
  for (const status of ['INVITED', 'DISABLED', 'REMOVED', 'SUSPENDED', '', 'active']) {
    assert.equal(isActiveMembership({ ...base, status: status as never }, now), false, status);
  }
  assert.equal(isActiveMembership(null, now), false);
  assert.equal(isActiveMembership({ status: 'ACTIVE', effectiveFrom: new Date('2026-10-01T00:00:00Z'), effectiveTo: null }, now), false, 'not yet begun');
  assert.equal(isActiveMembership({ ...base, status: 'ACTIVE', effectiveTo: now }, now), false, 'ended');
  assert.equal(isActiveMembership({ ...base, status: 'ACTIVE', effectiveFrom: 'yesterday' as never }, now), false, 'malformed');
});

test('the same email in two organizations stays two authentication principals with two memberships', async () => {
  const { fake, iam, memberships } = setup();
  const a = await iam.createUser({ organizationId: ORG_A, email: 'sam@x.io', systemRole: 'OWNER' });
  const b = await iam.createUser({ organizationId: ORG_B, email: 'sam@x.io', systemRole: 'READ_ONLY' });
  assert.notEqual(a.id, b.id);
  const ma = await memberships.findMembership(ORG_A, a.id);
  const mb = await memberships.findMembership(ORG_B, b.id);
  assert.ok(ma && mb && ma.id !== mb.id);
  assert.equal(await memberships.findMembership(ORG_A, b.id), null, 'no membership crosses to the other login');
  assert.equal(await memberships.findMembership(ORG_B, a.id), null);
  assert.deepEqual([ma.systemRole, mb.systemRole], ['OWNER', 'READ_ONLY'], 'nothing merged, nothing shared');
  assert.equal(fake.user.__rows.length, 2);
});

// ---- Authority is unchanged -------------------------------------------------

test('existing permission behavior is preserved: can() still resolves from the User row alone', async () => {
  const { fake, iam } = setup();
  const u = await iam.createUser({ organizationId: ORG_A, email: 'm@x.io', systemRole: 'MANAGER' });
  await iam.activateUser(ORG_A, u.id);
  const resources = ['customers', 'users', 'organizations', 'commercialIntelligence'] as const;
  const actions = ['view', 'update', 'delete'] as const;
  const answers = async () => {
    const out: boolean[] = [];
    for (const resource of resources) for (const action of actions) {
      out.push(await iam.can({ organizationId: ORG_A, userId: u.id, resource, action }));
    }
    return out;
  };
  const expected = resources.flatMap((r) => actions.map((a) => matrixAllows('MANAGER', r, a)));
  assert.deepEqual(await answers(), expected);

  // Tamper with the membership: an authority that read it would change its answer.
  fake.organizationMembership.__rows[0].status = 'REMOVED';
  fake.organizationMembership.__rows[0].systemRole = 'OWNER';
  assert.deepEqual(await answers(), expected, 'membership is not yet read for authority');

  const canBody = code('packages/database/src/repositories/iam.repository.ts').match(/async can\([\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.ok(canBody.length > 0);
  assert.equal(/membership/i.test(canBody), false);
  assert.equal(/membership/i.test(code('packages/database/src/repositories/auth.repository.ts').match(/async resolveSession\([\s\S]*?\n {2}\}/)?.[0] ?? 'x'), false);
});

test('no Party is created and no commercial role is inferred', async () => {
  const { fake, iam } = setup();
  const u = await iam.createUser({ organizationId: ORG_A, email: 'p@x.io', systemRole: 'EMPLOYEE' });
  await iam.activateUser(ORG_A, u.id);
  await iam.softRemoveUser(ORG_A, u.id);
  for (const d of ['cognitiveIdentity', 'identityRole', 'identityEvidence', 'identityResolutionLink', 'identityRelationship']) {
    assert.equal(fake[d].__rows.length, 0, `${d} untouched`);
  }
  for (const m of fake.organizationMembership.__rows) {
    assert.ok((Object.values(SystemRole) as string[]).includes(m.systemRole), 'a system role, nothing else');
  }
  const src = code('packages/database/src/repositories/membership.repository.ts');
  assert.equal(/\b(cognitive\w*|identity|identities|party|parties|participants?)\b/i.test(src), false, 'no identity or participation vocabulary');
  assert.equal(/\b(IdentityRole|BUYER|VENDOR|CREATOR|SOURCE|BRAND|PUBLISHER|AGENCY|PARTNER)\b/.test(src), false, 'no commercial role');
});

// ---- Coverage (the read P0.2c's production gate depends on) ------------------

test('coverage counts what is missing or disagrees, and nothing else', () => {
  const users = [
    { id: 'u1', status: 'ACTIVE', metadata: { systemRole: 'OWNER' } },
    { id: 'u2', status: 'INVITED', metadata: {} },
    { id: 'u3', status: 'DISABLED', metadata: { removedAt: '2026-08-01T00:00:00.000Z' } },
    { id: 'u4', status: 'ACTIVE', metadata: { systemRole: 'nope' } },
    { id: 'u5', status: 'ACTIVE', metadata: { removedAt: 'x' } },
  ];
  const complete = [
    { userId: 'u1', systemRole: 'OWNER', status: 'ACTIVE' },
    { userId: 'u2', systemRole: 'EMPLOYEE', status: 'INVITED' },
    { userId: 'u3', systemRole: 'EMPLOYEE', status: 'REMOVED' },
    { userId: 'u5', systemRole: 'EMPLOYEE', status: 'ACTIVE' },
  ] as never[];
  assert.deepEqual(compareMembershipCoverage(users, complete), {
    users: 5, memberships: 4, missingMemberships: 0, roleMismatches: 0, statusMismatches: 0,
    underivableRole: 1, underivableStatus: 0, removedMarkerNotDisabled: 1, orphanMemberships: 0,
  });
  const drifted = [
    { userId: 'u1', systemRole: 'ADMIN', status: 'ACTIVE' },
    { userId: 'u3', systemRole: 'EMPLOYEE', status: 'DISABLED' },
    { userId: 'ghost', systemRole: 'OWNER', status: 'ACTIVE' },
  ] as never[];
  const c = compareMembershipCoverage(users, drifted);
  assert.deepEqual(
    [c.missingMemberships, c.roleMismatches, c.statusMismatches, c.orphanMemberships],
    [2, 1, 1, 1],
  );
});

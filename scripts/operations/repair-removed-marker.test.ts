// Repair removed marker -- restoring removals the legacy demo bootstrap undid.
//
// Drives the REAL IamRepository, AuthRepository, AuditRepository,
// MembershipRepository and RemovedMarkerRepairRepository against the in-memory
// Prisma double. Proves the rule selects exactly the resurrected rows, refuses
// every row a human acted on after removal, writes nothing on a dry run or a
// surprise, repairs through the existing governed removal path, is idempotent,
// and prints no id or email.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from '../../packages/database/test/helpers/cognitive-prisma-fake';
import { IamRepository } from '../../packages/database/src/repositories/iam.repository';
import { AuthRepository } from '../../packages/database/src/repositories/auth.repository';
import { AuditRepository } from '../../packages/database/src/repositories/audit.repository';
import { MembershipRepository, syncMembershipFromUser } from '../../packages/database/src/repositories/membership.repository';
import { RemovedMarkerRepairRepository } from '../../packages/database/src/repositories/removed-marker-repair.repository';
import { REPAIR_TAG, readApply, parseArgs, parseExpected, runRepair, type RepairDeps } from './repair-removed-marker';

const ORG = 'org_demo';
const REMOVED_AT = '2026-07-10T15:00:00.000Z';
const AT = (iso: string) => new Date(iso);

const RUNNER_CODE = readFileSync(new URL('./repair-removed-marker.ts', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const REPO_CODE = readFileSync(
  new URL('../../packages/database/src/repositories/removed-marker-repair.repository.ts', import.meta.url), 'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const WORKFLOW = readFileSync(new URL('../../.github/workflows/repair-removed-marker.yml', import.meta.url), 'utf8');

function world() {
  const fake: any = makeCognitivePrisma({ also: ['invitation', 'organizationMembership', 'userSession', 'organization'] });
  const prisma = fake as PrismaClient;
  const lines: string[] = [];
  const memberships = new MembershipRepository(prisma);
  const deps: RepairDeps = {
    organizations: { findBySlug: async (slug) => (slug === 'demo' ? { id: ORG, slug: 'demo' } : null) },
    repair: new RemovedMarkerRepairRepository(prisma),
    iam: new IamRepository(prisma),
    auth: new AuthRepository(prisma),
    audit: new AuditRepository(prisma),
    memberships,
    log: (l) => lines.push(l),
  };
  return { fake, prisma, deps, lines, memberships };
}

/** A member removed by an administrator, then flipped ACTIVE by the legacy bootstrap. */
async function resurrected(fake: any, email: string, role = 'MANAGER') {
  const user = await fake.user.create({
    data: {
      organizationId: ORG, email, status: 'ACTIVE', createdAt: AT('2026-06-25T00:00:00Z'),
      metadata: { systemRole: role, passwordHash: 'scrypt$aa$bb', removedAt: REMOVED_AT },
    },
  });
  await syncMembershipFromUser(fake, user);
  await fake.auditLog.create({ data: { organizationId: ORG, action: 'user.removed', entityType: 'user', entityId: user.id, createdAt: AT('2026-07-01T00:00:00Z') } });
  await fake.auditLog.create({ data: { organizationId: ORG, action: 'user.removed', entityType: 'user', entityId: user.id, createdAt: AT(REMOVED_AT) } });
  await fake.userSession.create({ data: { organizationId: ORG, userId: user.id, tokenHash: `t-${email}`, revokedAt: null, expiresAt: AT('2099-01-01T00:00:00Z') } });
  return user;
}

const snapshot = (fake: any) =>
  JSON.stringify(['user', 'auditLog', 'userSession', 'organizationMembership'].map((d) => fake[d].__rows));

test('a dry run assesses both resurrected members and writes nothing', async () => {
  const { fake, deps, lines } = world();
  await resurrected(fake, 'manager@x.io');
  await resurrected(fake, 'viewer@x.io', 'READ_ONLY');
  const before = snapshot(fake);
  const r = await runRepair({ organizationSlug: 'demo', expected: 2, apply: false }, deps);
  assert.equal(r.overall, 'DRY_RUN');
  assert.deepEqual([r.candidates, r.eligible, r.repaired], [2, 2, 0]);
  assert.equal(snapshot(fake), before);
  assert.match(lines.join('\n'), /event=VERDICT DRY_RUN=true WOULD_REPAIR=2 MATCHES_EXPECTED=true WROTE=false/);
});

test('a real run restores each removal through the governed path, and the coverage gap closes', async () => {
  const { fake, deps, lines, memberships } = world();
  const a = await resurrected(fake, 'manager@x.io');
  const b = await resurrected(fake, 'viewer@x.io', 'READ_ONLY');
  const owner = await fake.user.create({ data: { organizationId: ORG, email: 'owner@x.io', status: 'ACTIVE', metadata: { systemRole: 'OWNER' } } });
  await syncMembershipFromUser(fake, owner);
  assert.equal((await memberships.coverage(ORG)).removedMarkerNotDisabled, 2);

  const r = await runRepair({ organizationSlug: 'demo', expected: 2, apply: true }, deps);
  assert.equal(r.overall, 'REPAIRED');
  assert.equal(r.repaired, 2);

  for (const u of [a, b]) {
    const row = fake.user.__rows.find((x: any) => x.id === u.id);
    assert.equal(row.status, 'DISABLED');
    assert.ok(row.metadata.removedAt, 'still marked removed');
    assert.equal(row.metadata.passwordHash, 'scrypt$aa$bb', 'metadata merged, never replaced');
    const m = await memberships.findMembership(ORG, u.id);
    assert.equal(m?.status, 'REMOVED');
    assert.ok(m?.effectiveTo instanceof Date);
    assert.ok(fake.userSession.__rows.filter((s: any) => s.userId === u.id).every((s: any) => s.revokedAt), 'every session revoked');
    const repairAudit = fake.auditLog.__rows.filter((e: any) => e.entityId === u.id && e.metadata?.repair === REPAIR_TAG);
    assert.equal(repairAudit.length, 1);
    assert.deepEqual(
      [repairAudit[0].action, repairAudit[0].actorType, repairAudit[0].userId, repairAudit[0].metadata.originalRemovedAt],
      ['user.removed', 'SYSTEM', null, REMOVED_AT],
    );
  }
  const coverage = await memberships.coverage(ORG);
  assert.equal(coverage.removedMarkerNotDisabled, 0);
  assert.equal(coverage.missingMemberships + coverage.roleMismatches + coverage.statusMismatches, 0);
  assert.match(lines.join('\n'), /REPAIRED=2 REMOVED_MARKER_NOT_DISABLED_AFTER=0 WROTE=true/);

  const out = lines.join('\n');
  for (const secret of [a.id, b.id, 'manager@x.io', 'viewer@x.io', ORG]) assert.equal(out.includes(secret), false);
});

test('the rule refuses every row a human acted on after the last removal', async () => {
  const { fake, deps } = world();
  const reactivated = await resurrected(fake, 'r@x.io');
  await fake.auditLog.create({ data: { organizationId: ORG, action: 'user.reactivated', entityType: 'user', entityId: reactivated.id, createdAt: AT('2026-07-11T00:00:00Z') } });
  const roleChanged = await resurrected(fake, 'p@x.io');
  await fake.auditLog.create({ data: { organizationId: ORG, action: 'user.permission_changed', entityType: 'user', entityId: roleChanged.id, createdAt: AT('2026-07-12T00:00:00Z') } });
  await resurrected(fake, 'i@x.io');
  await fake.invitation.create({ data: { organizationId: ORG, email: 'i@x.io', status: 'ACCEPTED', tokenHash: 'h', expiresAt: AT('2026-07-20T00:00:00Z'), createdAt: AT('2026-07-12T00:00:00Z'), acceptedAt: AT('2026-07-13T00:00:00Z') } });
  // Eligible: removed, resurrected, nothing since.
  const plain = await fake.user.create({ data: { organizationId: ORG, email: 'n@x.io', status: 'ACTIVE', metadata: { removedAt: REMOVED_AT } } });
  await fake.auditLog.create({ data: { organizationId: ORG, action: 'user.removed', entityType: 'user', entityId: plain.id, createdAt: AT(REMOVED_AT) } });
  // A marker with no removal audit in THIS organization (another tenant's entry does not count).
  const noRemovalAudit = await fake.user.create({ data: { organizationId: ORG, email: 'o@x.io', status: 'ACTIVE', metadata: { removedAt: REMOVED_AT } } });
  await fake.auditLog.create({ data: { organizationId: 'org_other', action: 'user.removed', entityType: 'user', entityId: noRemovalAudit.id, createdAt: AT(REMOVED_AT) } });

  const before = snapshot(fake);
  const r = await runRepair({ organizationSlug: 'demo', expected: 5, apply: true }, deps);
  assert.equal(r.overall, 'FAILED_PRECONDITION', 'a refused candidate stops the whole run');
  assert.deepEqual(r.refused, { HUMAN_ACT_AFTER_REMOVAL: 2, INVITATION_AFTER_REMOVAL: 1, NO_REMOVAL_AUDIT: 1 });
  assert.equal(r.eligible, 1);
  assert.equal(snapshot(fake), before, 'nothing written');
});

test('a count that does not match what the human expects writes nothing', async () => {
  const { fake, deps } = world();
  await resurrected(fake, 'manager@x.io');
  await resurrected(fake, 'viewer@x.io');
  const before = snapshot(fake);
  for (const expected of [1, 3]) {
    const r = await runRepair({ organizationSlug: 'demo', expected, apply: true }, deps);
    assert.equal(r.overall, 'FAILED_PRECONDITION');
  }
  assert.equal(snapshot(fake), before);
});

test('it is idempotent: after a repair there is nothing left to repair', async () => {
  const { fake, deps } = world();
  await resurrected(fake, 'manager@x.io');
  await runRepair({ organizationSlug: 'demo', expected: 1, apply: true }, deps);
  const before = snapshot(fake);
  const again = await runRepair({ organizationSlug: 'demo', expected: 0, apply: true }, deps);
  assert.equal(again.candidates, 0);
  assert.equal(again.overall, 'FAILED_PRECONDITION');
  assert.equal(snapshot(fake), before);
});

test('a human act between assessment and write wins: the run stops before touching that row', async () => {
  const { fake, deps } = world();
  const u = await resurrected(fake, 'manager@x.io');
  let calls = 0;
  const racing: RepairDeps = {
    ...deps,
    repair: {
      candidates: (o) => deps.repair.candidates(o),
      assess: async (o, c) => {
        calls += 1;
        if (calls === 2) {
          await fake.auditLog.create({ data: { organizationId: ORG, action: 'user.reactivated', entityType: 'user', entityId: u.id, createdAt: AT('2026-09-01T00:00:00Z') } });
        }
        return deps.repair.assess(o, c);
      },
    },
  };
  const r = await runRepair({ organizationSlug: 'demo', expected: 1, apply: true }, racing);
  assert.equal(r.overall, 'STOPPED');
  assert.equal(fake.user.__rows.find((x: any) => x.id === u.id).status, 'ACTIVE');
  assert.equal(fake.auditLog.__rows.filter((e: any) => e.metadata?.repair === REPAIR_TAG).length, 0);
});

test('unknown organization and malformed input fail closed before any read', async () => {
  const { deps } = world();
  assert.equal((await runRepair({ organizationSlug: 'nope', expected: 0, apply: true }, deps)).overall, 'FAILED_PRECONDITION');
  assert.equal((await runRepair({ organizationSlug: 'DEMO', expected: 0, apply: true }, deps)).overall, 'FAILED_PRECONDITION');
  assert.equal((await runRepair({ organizationSlug: 'demo', expected: -1, apply: true }, deps)).overall, 'FAILED_PRECONDITION');
  for (const bad of ['', '-1', '1.5', 'two', '01', '99999']) assert.equal(parseExpected(bad), null, bad);
  assert.equal(parseExpected('2'), 2);
  assert.deepEqual(parseArgs(['--org', 'demo', '--expected', '2']), { organization: 'demo', expected: '2' });
});

test('only an explicit DRY_RUN=false writes', () => {
  assert.equal(readApply({ DRY_RUN: 'false' } as NodeJS.ProcessEnv), true);
  for (const v of [undefined, 'true', 'False', 'FALSE', '0', '', 'no']) {
    assert.equal(readApply({ DRY_RUN: v } as NodeJS.ProcessEnv), false, String(v));
  }
});

test('the write path is the existing governed removal, and the assessment writes nothing', () => {
  assert.match(RUNNER_CODE, /deps\.iam\.softRemoveUser\(/);
  assert.match(RUNNER_CODE, /deps\.auth\.revokeAllForUser\(/);
  assert.match(RUNNER_CODE, /action: 'user\.removed'/);
  for (const forbidden of ['activateUser', 'prepareInvitation', 'updateUserRole', 'setPasswordHash', '$executeRaw', '$queryRaw', 'fetch(']) {
    assert.ok(!RUNNER_CODE.includes(forbidden), `runner must not name ${forbidden}`);
  }
  assert.ok(!/prisma\.\w+\./.test(RUNNER_CODE), 'the runner goes through repositories');
  assert.ok(!/\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/.test(REPO_CODE), 'assessment is read-only');
  const queries = [...REPO_CODE.matchAll(/\.(findMany|count)\(\{([\s\S]*?)\}\);/g)];
  assert.ok(queries.length >= 3);
  for (const [, , body] of queries) assert.match(body!, /organizationId/);
});

test('the workflow is human-dispatched, dry by default, proves the boundary first, and interpolates no input', () => {
  assert.ok(WORKFLOW.includes('workflow_dispatch:'));
  for (const trigger of ['\n  schedule:', '\n  push:', '\n  pull_request:', '\n  workflow_call:']) assert.ok(!WORKFLOW.includes(trigger));
  assert.match(WORKFLOW, /dry_run:\n\s+description: [^\n]+\n\s+required: true\n\s+default: true/);
  assert.ok(WORKFLOW.indexOf('test:operations') < WORKFLOW.indexOf('repair:removed-marker'));
  assert.ok(!WORKFLOW.includes('user_id'), 'no user id is an input');
  for (const body of WORKFLOW.split(/\n\s+run: \|/).slice(1)) {
    const step = body.split(/\n\s+- name:/)[0] ?? '';
    assert.ok(!/\$\{\{\s*inputs\./.test(step), 'no input interpolated into a run body');
  }
});

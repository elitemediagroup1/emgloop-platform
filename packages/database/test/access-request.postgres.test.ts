import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AccessRequestRepository } from '../src/repositories/access-request.repository';
import { IamRepository, invitationSystemRole } from '../src/repositories/iam.repository';

const url = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const local = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
test('real Postgres: durable requests, concurrent approval, retry links and tenant isolation', { skip: !local ? 'Disposable localhost Postgres required' : false }, async () => {
  const db = new PrismaClient({ datasources: { db: { url } } });
  const a = `access_a_${randomUUID()}`;
  const b = `access_b_${randomUUID()}`;
  try {
    await db.organization.createMany({ data: [{ id: a, name: 'Request test A', slug: a }, { id: b, name: 'Request test B', slug: b }] });
    const iam = new IamRepository(db);
    const admin = await iam.createUser({ organizationId: a, email: 'admin@example.test', systemRole: 'OWNER' });
    await iam.activateUser(a, admin.id);
    const requests = new AccessRequestRepository(db);
    const input = { fullName: 'Example Request', email: 'request@example.test', company: 'Example', accessType: 'Employee' };
    const row = await requests.submit(a, input);
    assert.equal((await requests.submit(a, { ...input, email: 'REQUEST@example.test' })).id, row.id);
    assert.equal(await db.user.count({ where: { organizationId: a, email: input.email } }), 0);
    assert.equal(await requests.get(b, row.id), null);
    assert.equal(await requests.claim(b, row.id, admin.id, 'wrong', new Date()), null);
    assert.equal(await requests.reject(b, row.id, admin.id, new Date()), false);
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => requests.claim(a, row.id, admin.id, `claim-${i}`, new Date())));
    const winner = claims.find(Boolean)!;
    assert.equal(claims.filter(Boolean).length, 1);
    const claimId = winner.claimId!;
    const prepared = await iam.prepareInvitation({ organizationId: a, email: row.email, name: row.fullName, systemRole: 'EMPLOYEE', invitedByUserId: admin.id });
    assert.equal(prepared.ok, true);
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    const first = await iam.createInvitation({ organizationId: a, email: row.email, inviterId: admin.id, systemRole: 'EMPLOYEE', tokenHash: hash('first-test-token'), accessRequestId: row.id });
    assert.equal(invitationSystemRole(first), 'EMPLOYEE');
    assert.equal(await requests.attach(a, row.id, claimId, first.id), true);
    // Simulate an email provider failure, without sending a message.
    assert.equal(await requests.finish(a, row.id, claimId, 'FAILED', new Date()), true);
    const retry = await requests.claim(a, row.id, admin.id, 'retry', new Date());
    assert.ok(retry);
    assert.equal((await requests.ownedInvitation(a, row.id, row.email))?.id, first.id);
    await iam.revokeInvitation(a, first.id);
    const fresh = await iam.createInvitation({ organizationId: a, email: row.email, inviterId: admin.id, systemRole: 'EMPLOYEE', tokenHash: hash('second-test-token'), accessRequestId: row.id });
    await requests.attach(a, row.id, 'retry', fresh.id);
    assert.equal(await requests.finish(a, row.id, 'retry', 'INVITED', new Date()), true);
    assert.equal(await requests.claim(a, row.id, admin.id, 'duplicate', new Date()), null);
    assert.equal((await db.invitation.findUnique({ where: { id: first.id } }))?.status, 'REVOKED');
    assert.equal(await db.invitation.count({ where: { organizationId: a, email: row.email, status: 'PENDING' } }), 1);
    assert.equal(await db.auditLog.count({ where: { organizationId: a, entityId: row.id, action: 'access_request.invited' } }), 1);
    const pending = await requests.list(a, false);
    assert.equal(pending.find(r => r.id === row.id)?.invitationId, fresh.id);
    await iam.acceptInvitation(fresh.id);
    assert.equal((await requests.list(a, false)).find(r => r.id === row.id)?.invitation?.status, 'ACCEPTED');
  } finally {
    await db.organization.deleteMany({ where: { id: { in: [a, b] } } });
    await db.$disconnect();
  }
});

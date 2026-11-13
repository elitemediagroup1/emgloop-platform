import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { AccessRequestRepository, cleanAccessRequest } from '../src/repositories/access-request.repository';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';

const input = { fullName: 'Request Person', email: 'person@example.test', company: 'Example Company', accessType: 'Employee' };
const now = new Date('2026-11-13T19:00:00Z');
async function world() {
  const db = makeCognitivePrisma({ also: ['organization', 'accessRequest', 'invitation'] }) as unknown as PrismaClient;
  await db.organization.create({ data: { id: 'a', name: 'A', slug: 'a', status: 'ACTIVE' } });
  await db.organization.create({ data: { id: 'b', name: 'B', slug: 'b', status: 'ACTIVE' } });
  return { db, requests: new AccessRequestRepository(db) };
}

test('public requests normalize email, persist once, and never create a user or invitation', async () => {
  const { db, requests } = await world();
  const a = await requests.submit('a', { ...input, email: ' Person@Example.Test ' });
  const duplicate = await requests.submit('a', { ...input, fullName: 'Changed name', accessType: 'Company Administrator' });
  assert.equal(a.id, duplicate.id);
  assert.equal(duplicate.fullName, input.fullName);
  assert.equal(duplicate.accessType, 'Employee');
  assert.equal(await db.user.count(), 0);
  assert.equal(await db.invitation.count(), 0);
  await assert.rejects(requests.submit('missing', input));
});

test('organization isolation covers reads, decisions, links and identical email submissions', async () => {
  const { db, requests } = await world();
  const a = await requests.submit('a', input);
  const b = await requests.submit('b', input);
  assert.notEqual(a.id, b.id);
  assert.equal(await requests.get('b', a.id), null);
  assert.equal(await requests.claim('b', a.id, 'actor-b', 'wrong', now), null);
  assert.equal(await requests.reject('b', a.id, 'actor-b', now), false);
  assert.equal(await requests.attach('b', a.id, 'wrong', 'anything'), false);
  assert.equal(await db.auditLog.count(), 0);
  assert.equal((await requests.get('a', a.id))?.status, 'PENDING');
});

test('simultaneous approvals have one winner; rejected requests cannot be approved by replay', async () => {
  const { requests } = await world();
  const a = await requests.submit('a', input);
  const outcomes = await Promise.all([requests.claim('a', a.id, 'admin', 'one', now), requests.claim('a', a.id, 'admin', 'two', now)]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(await requests.reject('a', a.id, 'admin', now), false);
  const other = await requests.submit('a', { ...input, email: 'other@example.test' });
  assert.equal(await requests.reject('a', other.id, 'admin', now), true);
  assert.equal(await requests.claim('a', other.id, 'admin', 'replay', now), null);
});

test('failed email can retry, an interrupted lease expires, and stale completions cannot win', async () => {
  const { requests } = await world();
  const a = await requests.submit('a', input);
  await requests.claim('a', a.id, 'admin', 'one', now);
  assert.equal(await requests.finish('a', a.id, 'one', 'INVITED', now), false, 'an invitation link must be attached first');
  assert.equal(await requests.finish('a', a.id, 'one', 'FAILED', now), true);
  assert.ok(await requests.claim('a', a.id, 'admin', 'two', now));
  assert.equal(await requests.claim('a', a.id, 'admin', 'three', new Date(now.getTime() + 60_000)), null);
  assert.ok(await requests.claim('a', a.id, 'admin', 'three', new Date(now.getTime() + 301_000)));
  assert.equal(await requests.finish('a', a.id, 'two', 'FAILED', now), false);
});

test('only this request’s invitation can attach; rejection withdraws its failed-delivery links only', async () => {
  const { db, requests } = await world();
  const a = await requests.submit('a', input);
  await requests.claim('a', a.id, 'admin', 'one', now);
  const wrong = await db.invitation.create({ data: { organizationId: 'b', email: input.email, status: 'PENDING', tokenHash: 'wrong', expiresAt: new Date('2026-11-20'), metadata: { accessRequestId: a.id } } });
  assert.equal(await requests.attach('a', a.id, 'one', wrong.id), false);
  const own = await db.invitation.create({ data: { organizationId: 'a', email: input.email, status: 'PENDING', tokenHash: 'own', expiresAt: new Date('2026-11-20'), metadata: { accessRequestId: a.id } } });
  assert.equal(await requests.attach('a', a.id, 'one', own.id), true);
  await requests.finish('a', a.id, 'one', 'FAILED', now);
  await requests.reject('a', a.id, 'admin', now);
  assert.equal((await db.invitation.findFirst({ where: { id: own.id } }))?.status, 'REVOKED');
  assert.equal((await db.invitation.findFirst({ where: { id: wrong.id } }))?.status, 'PENDING');
});

test('successful dispatch is recorded once with audit, and duplicate submissions cannot reopen it', async () => {
  const { db, requests } = await world();
  const a = await requests.submit('a', input);
  await requests.claim('a', a.id, 'admin', 'one', now);
  const invite = await db.invitation.create({ data: { organizationId: 'a', email: input.email, status: 'PENDING', tokenHash: 'own', expiresAt: new Date('2026-11-20'), metadata: { accessRequestId: a.id } } });
  await requests.attach('a', a.id, 'one', invite.id);
  assert.equal(await requests.finish('a', a.id, 'one', 'INVITED', now), true);
  assert.equal(await requests.finish('a', a.id, 'one', 'INVITED', now), false);
  assert.equal((await requests.submit('a', input)).status, 'INVITED');
  assert.equal(await db.auditLog.count({ where: { action: 'access_request.invited' } }), 1);
});

test('input validation rejects malformed addresses, controls and arbitrary roles', () => {
  for (const change of [{ email: 'invalid' }, { accessType: 'OWNER' }, { fullName: 'Injected\r\nName' }, { company: '' }]) assert.throws(() => cleanAccessRequest({ ...input, ...change }));
});

test('resend is explicitly reopened once for the current link and reuses the normal claim/failure path', async () => {
  const { db, requests } = await world();
  const a = await requests.submit('a', input);
  await requests.claim('a', a.id, 'admin', 'one', now);
  const invitation = await db.invitation.create({ data: { organizationId: 'a', email: input.email, tokenHash: 'resend-test', expiresAt: new Date('2026-11-20'), metadata: { accessRequestId: a.id } } });
  await requests.attach('a', a.id, 'one', invitation.id);
  await requests.finish('a', a.id, 'one', 'INVITED', now);
  assert.equal(await requests.reopenForResend('b', a.id, invitation.id, 'admin'), false);
  assert.equal(await requests.reopenForResend('a', a.id, 'not-the-current-link', 'admin'), false);
  assert.equal(await requests.reopenForResend('a', a.id, invitation.id, 'admin'), true);
  assert.equal(await requests.reopenForResend('a', a.id, invitation.id, 'admin'), false);
  assert.ok(await requests.claim('a', a.id, 'admin', 'resend', now));
  await requests.finish('a', a.id, 'resend', 'FAILED', now);
  assert.equal((await requests.get('a', a.id))?.status, 'FAILED');
});

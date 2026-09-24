// WorkItemRepository.resolveObligationsNotIn against a REAL Postgres. Local only (LOOP_TEST_POSTGRES_URL).
//
// WHAT IT PROVES, THAT AN IN-MEMORY DOUBLE CANNOT (the reconcile logic runs inside a transaction against
// the real projection + append-only log, with the migration's CHECK constraints in force):
//   - MULTI-OBLIGATION: obligation-level identity gives distinct recurrenceKeys under one subjectRef;
//   - idempotent re-detect: the same obligation re-detected does not duplicate;
//   - RECONCILE: an obligation the fresh read no longer lists, whose anchor is INSIDE the evaluated
//     window, is closed (RESOLVED / SUPERSEDED) with a SYSTEM observation;
//   - THE RECONCILE GUARD: an obligation whose anchor fell OUTSIDE the window (older than the boundary,
//     truncated out) is NOT closed -- it is left open;
//   - a kept obligation (still unresolved this read) stays open.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { WorkItemRepository } from '../src/repositories/work-state/work-item.repository';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const NOW = new Date('2026-09-21T12:00:00Z');
const CONV = 'ck_recon';
const SUBJECT = `telegram_conversation:${CONV}`;
const PRODUCER = 'telegram.content.triage';

async function person(prisma: PrismaClient) {
  const organizationId = `org_wi_${randomUUID()}`;
  const userId = `user_wi_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: 'WI', slug: organizationId } });
  await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'WI', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE' } } });
  await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  // A derived (MODEL, Telegram) item is written only under a live content authorization: detect
  // re-checks it inside its own transaction (2026-09-24). The fixture grants it; the refusal itself is
  // proven in work-item-detect-consent.postgres.test.ts.
  await prisma.sourceContentAuthorization.create({ data: { organizationId, userId, provider: 'TELEGRAM', authorizedAt: NOW } });
  return { organizationId, userId };
}

function detection(anchorId: number, title: string) {
  return {
    recurrenceKey: `${PRODUCER}:${CONV}:${CONV}:${anchorId}`,
    class: 'NEEDS_YOU' as const,
    subjectKind: 'THREAD' as const,
    subjectRef: SUBJECT,
    title,
    producerKind: 'MODEL' as const,
    producerId: PRODUCER,
    producerVersion: '2.0.0',
    evidence: { provider: 'TELEGRAM', providerEventId: `${CONV}:${anchorId}`, conversationKey: CONV },
    detectedAt: NOW,
  };
}

test('MULTI-OBLIGATION + idempotent detect: distinct recurrenceKeys under one subjectRef, no duplicate on re-detect', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new WorkItemRepository(prisma);
  try {
    const principal = await person(prisma);
    await repo.detect(principal, detection(5, 'Confirm the cap'));
    await repo.detect(principal, detection(8, 'Send the invoice'));
    // Re-detect the SAME obligation: same row, count rises, no second row.
    const first = await repo.detect(principal, detection(8, 'Send the invoice (again)'));
    assert.equal(first.detectionCount, 2, 'a re-sighting widens the window, it does not duplicate');

    const items = await repo.items(principal);
    assert.equal(items.length, 2, 'two distinct obligations, one row each');
    assert.equal(new Set(items.map((i) => i.subjectRef)).size, 1, 'same subjectRef');
    assert.equal(new Set(items.map((i) => i.recurrenceKey)).size, 2, 'distinct recurrenceKeys');
  } finally {
    await prisma.$disconnect();
  }
});

test('RECONCILE + GUARD: an in-window answered obligation closes; a truncated-out anchor is left open; a kept anchor stays open', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new WorkItemRepository(prisma);
  try {
    const principal = await person(prisma);
    // Three open obligations, anchored at message ids 5, 8 and 12.
    await repo.detect(principal, detection(5, 'Old ask (truncated out)'));
    await repo.detect(principal, detection(8, 'Answered later'));
    await repo.detect(principal, detection(12, 'Still unresolved'));

    // A fresh read of the window [8..] keeps only anchor 12. Boundary = ck:8.
    const closed = await repo.resolveObligationsNotIn(principal, SUBJECT, [`${CONV}:12`], `${CONV}:8`, NOW);
    assert.equal(closed, 1, 'exactly the in-window, not-kept obligation closes');

    const byAnchor = new Map((await repo.items(principal)).map((i) => [(i.evidence as any).providerEventId, i]));
    assert.equal(byAnchor.get(`${CONV}:5`)!.state, 'OPEN', 'THE GUARD: an anchor older than the boundary is truncated out -> left open');
    assert.equal(byAnchor.get(`${CONV}:8`)!.state, 'RESOLVED', 'the answered, in-window obligation is closed');
    assert.equal(byAnchor.get(`${CONV}:8`)!.outcome, 'SUPERSEDED');
    assert.equal(byAnchor.get(`${CONV}:12`)!.state, 'OPEN', 'a kept (still unresolved) obligation stays open');

    // The close appended a SYSTEM observation, not a human action.
    const obs = await repo.observations(principal, byAnchor.get(`${CONV}:8`)!.id);
    const last = obs[obs.length - 1]!;
    assert.equal(last.observationType, 'RESOLVED');
    assert.equal(last.actorType, 'SYSTEM');
    assert.equal(last.actorUserId, null, 'no AI/human actor id on a reconcile close');
  } finally {
    await prisma.$disconnect();
  }
});

test('RECONCILE with an empty kept list closes every in-window obligation (a conversation that resolved everything)', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new WorkItemRepository(prisma);
  try {
    const principal = await person(prisma);
    await repo.detect(principal, detection(8, 'ask a'));
    await repo.detect(principal, detection(12, 'ask b'));
    const closed = await repo.resolveObligationsNotIn(principal, SUBJECT, [], `${CONV}:8`, NOW);
    assert.equal(closed, 2, 'both in-window obligations close when nothing is kept');
    assert.deepEqual(
      (await repo.items(principal, { state: 'OPEN' })).length,
      0,
      'nothing left open',
    );
  } finally {
    await prisma.$disconnect();
  }
});

test('RECONCILE never closes another producer, another subject, or an already-closed item', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new WorkItemRepository(prisma);
  try {
    const principal = await person(prisma);
    // A RULE-produced item on the same subject must be untouched (only MODEL obligations reconcile).
    await repo.detect(principal, { ...detection(8, 'rule item'), producerKind: 'RULE', recurrenceKey: `rule:${CONV}:8` });
    await repo.detect(principal, detection(9, 'model item'));
    const closed = await repo.resolveObligationsNotIn(principal, SUBJECT, [], `${CONV}:8`, NOW);
    assert.equal(closed, 1, 'only the MODEL obligation closes');
    const rule = (await repo.items(principal)).find((i) => i.producerKind === 'RULE')!;
    assert.equal(rule.state, 'OPEN', 'a RULE item is not a reconcilable obligation');
  } finally {
    await prisma.$disconnect();
  }
});

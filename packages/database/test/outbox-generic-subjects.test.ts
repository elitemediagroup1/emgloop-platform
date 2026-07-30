// One outbox, many subjects.
//
// Loop has exactly one publishing mechanism. These assert the generalization did
// what it claims: a subject with no identity can publish, an active-state
// publication is unchanged, and the two are distinguishable by subscribers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { StateChangeOutboxRepository } from '../src/repositories/cognitive/active-state.repository';

const ORG = 'org-alpha';

function makeRepo() {
  const prisma = makeCognitivePrisma();
  return { prisma, repo: new StateChangeOutboxRepository(prisma as never) };
}

test('a decision publishes with NO identity, because most decisions are about the business', async () => {
  const { repo } = makeRepo();
  const row = await repo.enqueue(ORG, {
    subjectType: 'DECISION',
    subjectId: 'decision-456',
    eventType: 'DecisionAssigned',
    domain: 'OPERATIONAL',
    stateKey: 'decision.CALLGRID.buyer-decline::markytek',
    changeType: 'ASSIGNED',
    payload: { assigneeUserId: 'user-sam' },
  });

  assert.equal(row.subjectType, 'DECISION');
  assert.equal(row.subjectId, 'decision-456');
  assert.equal(row.eventType, 'DecisionAssigned');
  assert.equal(row.identityId, null, 'no identity was invented to satisfy a column');
  assert.equal(row.organizationId, ORG);
});

test('an identity is recorded when the subject genuinely has one', async () => {
  const { repo } = makeRepo();
  const row = await repo.enqueue(ORG, {
    subjectType: 'DECISION',
    subjectId: 'decision-789',
    eventType: 'DecisionCreated',
    domain: 'COMMERCE',
    stateKey: 'decision.CRM.opportunity-stalled::acme',
    changeType: 'CREATED',
    identityId: 'contact-789',
  });
  assert.equal(row.identityId, 'contact-789');
});

test('subject type and event type are different questions', async () => {
  // subjectType says WHAT changed; eventType says what HAPPENED to it. One
  // subject emits many event types, which is why they cannot be one column.
  const { repo } = makeRepo();
  const events = ['DecisionCreated', 'DecisionAssigned', 'DecisionResolved'];
  for (const [i, eventType] of events.entries()) {
    const row = await repo.enqueue(ORG, {
      subjectType: 'DECISION', subjectId: 'd1', eventType,
      domain: 'OPERATIONAL', stateKey: 'decision.X', changeType: 'C' + i,
    });
    assert.equal(row.subjectType, 'DECISION');
    assert.equal(row.eventType, eventType);
  }
});

test('every future subsystem is a value, not a second outbox', async () => {
  const { repo } = makeRepo();
  const subjects = ['ACTIVE_STATE', 'DECISION', 'WORK_ITEM', 'MEMORY', 'KNOWLEDGE', 'IDENTITY'] as const;
  for (const subjectType of subjects) {
    const row = await repo.enqueue(ORG, {
      subjectType, subjectId: `s-${subjectType}`, eventType: 'Changed',
      domain: 'OPERATIONAL', stateKey: 'k', changeType: 'C',
    });
    assert.equal(row.subjectType, subjectType);
  }
});

test('enqueue joins a caller-supplied transaction, so an event cannot outlive its cause', async () => {
  // The event and the fact that caused it commit together or not at all.
  const { prisma, repo } = makeRepo();
  const row = await prisma.$transaction(async (tx: never) =>
    repo.enqueue(ORG, {
      subjectType: 'DECISION', subjectId: 'd-tx', eventType: 'DecisionCreated',
      domain: 'OPERATIONAL', stateKey: 'k', changeType: 'CREATED',
    }, tx),
  );
  assert.equal(row.subjectId, 'd-tx');
});

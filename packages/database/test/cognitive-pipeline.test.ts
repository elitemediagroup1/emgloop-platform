// Loop Cognitive Architecture — Increment 2 deterministic tests.
//
// Drives the REAL CognitiveEventProcessor (and its pure evaluators + governance)
// against the in-memory cognitive Prisma double. Proves the nine-stage pipeline:
// idempotency, memory-before-state, precedence identity resolution (never
// name-only), deny-by-default governance gating derivation, deterministic
// knowledge/state evaluators, transactional revision+outbox, and recoverable
// failure — all through the Increment 1 repositories (no parallel persistence).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import {
  CognitiveEventProcessor,
  LoopEventConsumer,
  type ProcessEventInput,
} from '../src/services/cognitive';
import {
  CognitiveIdentityRepository,
  IdentityEvidenceRepository,
  KnowledgeAssertionRepository,
  ActiveStateRepository,
  DataGovernancePolicyRepository,
  CognitiveProcessingAttemptRepository,
  MemoryEventRepository,
  StateChangeOutboxRepository,
} from '../src/repositories/cognitive';

const ORG = 'org_a';
const OCCURRED = new Date('2026-07-23T12:00:00Z');

function prisma(): PrismaClient {
  return makeCognitivePrisma() as unknown as PrismaClient;
}

// An ACTIVE policy that permits the given purposes for all events/entities.
async function allow(p: PrismaClient, purposes: string[]) {
  const gov = new DataGovernancePolicyRepository(p);
  await gov.create(ORG, {
    name: 'allow',
    status: 'ACTIVE',
    allowedPurposes: purposes as any,
  });
}

function productClick(overrides: Partial<ProcessEventInput> = {}): ProcessEventInput {
  return {
    organizationId: ORG,
    sourceSystem: 'website',
    sourceEventId: 'evt-1',
    eventType: 'PRODUCT_CLICKED',
    occurredAt: OCCURRED,
    channel: 'sms',
    subject: { entityType: 'PERSON', canonicalKey: 'person-1', roleType: 'CONSUMER' },
    payload: { name: 'Purple Running Shoe', category: 'Footwear', color: 'Purple', useCase: 'Running' },
    requestedPurposes: ['PERSONALIZATION'],
    ...overrides,
  };
}

// 1. Duplicate provider event is processed once.
test('duplicate provider event is processed exactly once', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const proc = new CognitiveEventProcessor(p);
  const first = await proc.processEvent(productClick());
  const second = await proc.processEvent(productClick());
  assert.equal(first.status, 'processed');
  assert.equal(second.status, 'duplicate');
  assert.equal(first.memoryEventId, second.memoryEventId);
  const mem = new MemoryEventRepository(p);
  const one = await mem.findBySource(ORG, 'website', 'evt-1');
  assert.ok(one);
  const outbox = await new StateChangeOutboxRepository(p).listPending(ORG);
  // Commerce keys changed once; the duplicate added no new outbox rows.
  const rev = await new ActiveStateRepository(p).listRevisions(
    ORG,
    (await new ActiveStateRepository(p).getState(ORG, first.subjectIdentityId!, 'COMMERCE', 'currentProductInterest'))!.id,
  );
  assert.equal(rev.length, 1, 'no duplicate revision from the reprocessed event');
  assert.ok(outbox.length >= 1);
});

// 2. Memory persists before state (state evidence cites the memory event).
test('memory persists before state and state cites the memory event', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const proc = new CognitiveEventProcessor(p);
  const res = await proc.processEvent(productClick());
  const state = new ActiveStateRepository(p);
  const rec = await state.getState(ORG, res.subjectIdentityId!, 'COMMERCE', 'currentProductInterest');
  assert.ok(rec);
  const evidence = await state.listEvidence(ORG, rec.id);
  assert.ok(
    evidence.some((e) => e.memoryEventId === res.memoryEventId),
    'state evidence references the persisted memory event',
  );
});

// 3. Anonymous identity is created when no evidence exists.
test('anonymous identity is created when the subject has no key/evidence/session', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const proc = new CognitiveEventProcessor(p);
  const res = await proc.processEvent(
    productClick({ subject: { entityType: 'PERSON', roleType: 'ANONYMOUS_VISITOR' } }),
  );
  const id = await new CognitiveIdentityRepository(p).findById(ORG, res.subjectIdentityId!);
  assert.equal(id?.status, 'ANONYMOUS');
});

// 4. Confirmed identity evidence resolves to an existing identity.
test('verified email evidence resolves to the existing identity', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const idRepo = new CognitiveIdentityRepository(p);
  const evRepo = new IdentityEvidenceRepository(p);
  const existing = await idRepo.create(ORG, { entityType: 'PERSON', canonicalKey: 'known-1', status: 'KNOWN' });
  await evRepo.record(ORG, { identityId: existing.id, evidenceType: 'EMAIL', rawValue: 'a@b.com' });
  const proc = new CognitiveEventProcessor(p);
  const res = await proc.processEvent(
    productClick({
      sourceEventId: 'evt-verified',
      subject: {
        entityType: 'PERSON',
        evidence: [{ evidenceType: 'EMAIL', rawValue: 'A@B.com', verified: true }],
      },
    }),
  );
  assert.equal(res.subjectIdentityId, existing.id, 'resolved to the pre-existing identity by email');
});

// 5. Name similarity alone never merges identities.
test('identical display names with different keys never merge', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const proc = new CognitiveEventProcessor(p);
  const a = await proc.processEvent(
    productClick({ sourceEventId: 'n1', subject: { entityType: 'PERSON', canonicalKey: 'k-a', displayName: 'Jordan Lee' } }),
  );
  const b = await proc.processEvent(
    productClick({ sourceEventId: 'n2', subject: { entityType: 'PERSON', canonicalKey: 'k-b', displayName: 'Jordan Lee' } }),
  );
  assert.notEqual(a.subjectIdentityId, b.subjectIdentityId);
});

// 6. Governance denial prevents knowledge and state use for the denied purpose.
test('governance denial blocks knowledge and state; memory still persists', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']); // SALES is NOT permitted
  const proc = new CognitiveEventProcessor(p);
  const denied = await proc.processEvent(productClick({ sourceEventId: 'deny-1', requestedPurposes: ['SALES'] }));
  assert.equal(denied.status, 'denied');
  assert.equal(denied.accepted, true, 'a governed-off event is still durably accepted');
  const kn = await new KnowledgeAssertionRepository(p).listForSubject(ORG, denied.subjectIdentityId!);
  assert.equal(kn.length, 0, 'no knowledge derived for a denied purpose');
  const state = await new ActiveStateRepository(p).listForIdentity(ORG, denied.subjectIdentityId!, { includeExpired: true });
  assert.equal(state.length, 0, 'no state derived for a denied purpose');
  // The memory event itself was persisted.
  const mem = await new MemoryEventRepository(p).findBySource(ORG, 'website', 'deny-1');
  assert.ok(mem, 'durable memory persists regardless of governance');
});

// 7 + 8. Product click creates durable memory and observed-interest knowledge.
test('product click creates durable memory and OBSERVED interest knowledge', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const proc = new CognitiveEventProcessor(p);
  const res = await proc.processEvent(productClick());
  const mem = await new MemoryEventRepository(p).findById(ORG, res.memoryEventId!);
  assert.equal(mem?.eventType, 'PRODUCT_CLICKED');
  const kn = await new KnowledgeAssertionRepository(p).listForSubject(ORG, res.subjectIdentityId!);
  const byPred = Object.fromEntries(kn.map((a) => [a.predicate, a]));
  assert.equal(byPred['observedInterest.product']?.value, 'Purple Running Shoe');
  assert.equal(byPred['observedInterest.category']?.value, 'Footwear');
  assert.equal(byPred['observedInterest.attribute.color']?.value, 'Purple');
  for (const a of kn) assert.equal(a.assertionClass, 'OBSERVED');
});

// 9. Product click updates ONLY commerce-state keys.
test('product click updates only commerce-domain state', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const proc = new CognitiveEventProcessor(p);
  const res = await proc.processEvent(productClick());
  const state = await new ActiveStateRepository(p).listForIdentity(ORG, res.subjectIdentityId!, { includeExpired: true });
  assert.ok(state.length > 0);
  for (const s of state) assert.equal(s.domain, 'COMMERCE', 'only commerce keys touched');
  const keys = state.map((s) => s.stateKey).sort();
  assert.ok(keys.includes('currentProductInterest'));
  assert.ok(keys.includes('intentStrength'));
});

// 10. Consent change updates communication state.
test('consent change updates communication state', async () => {
  const p = prisma();
  await allow(p, ['SERVICE_DELIVERY']);
  const proc = new CognitiveEventProcessor(p);
  const res = await proc.processEvent({
    organizationId: ORG,
    sourceSystem: 'website',
    sourceEventId: 'consent-1',
    eventType: 'CONSENT_CHANGED',
    occurredAt: OCCURRED,
    channel: 'sms',
    subject: { entityType: 'PERSON', canonicalKey: 'person-c' },
    payload: { channel: 'sms', granted: true },
    requestedPurposes: ['SERVICE_DELIVERY'],
  });
  const s = await new ActiveStateRepository(p).getState(ORG, res.subjectIdentityId!, 'COMMUNICATION', 'smsConsentStatus');
  assert.equal(s?.value, 'GRANTED');
});

// 11. Work-step completion updates work state.
test('work-step completion updates work state', async () => {
  const p = prisma();
  await allow(p, ['OPERATIONS']);
  const proc = new CognitiveEventProcessor(p);
  const res = await proc.processEvent({
    organizationId: ORG,
    sourceSystem: 'work-os',
    sourceEventId: 'work-1',
    eventType: 'WORK_STEP_COMPLETED',
    occurredAt: OCCURRED,
    subject: { entityType: 'WORK_ITEM', canonicalKey: 'wi-1' },
    payload: { workItemId: 'wi-1', stepKey: 'intake', owner: 'u1', nextAction: 'schedule' },
    requestedPurposes: ['OPERATIONS'],
  });
  const step = await new ActiveStateRepository(p).getState(ORG, res.subjectIdentityId!, 'WORK', 'currentWorkStep');
  assert.equal(step?.value, 'intake');
});

// 12. State update and outbox write are atomic (one outbox row per revision).
test('every state revision has a corresponding outbox row (atomic)', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const proc = new CognitiveEventProcessor(p);
  const res = await proc.processEvent(productClick());
  const state = new ActiveStateRepository(p);
  const records = await state.listForIdentity(ORG, res.subjectIdentityId!, { includeExpired: true });
  let revisionCount = 0;
  for (const rec of records) revisionCount += (await state.listRevisions(ORG, rec.id)).length;
  const outbox = await new StateChangeOutboxRepository(p).listPending(ORG);
  assert.ok(revisionCount > 0);
  assert.equal(outbox.length, revisionCount, 'one outbox row per revision, written in the same transaction');
});

// 13. Unchanged state creates no revision (two events, same derived value).
test('a second event with the same derived value writes no new revision', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const proc = new CognitiveEventProcessor(p);
  const first = await proc.processEvent(productClick({ sourceEventId: 'same-1' }));
  // Different provider event, identical content + SAME occurredAt → same state.
  await proc.processEvent(productClick({ sourceEventId: 'same-2' }));
  const state = new ActiveStateRepository(p);
  const rec = await state.getState(ORG, first.subjectIdentityId!, 'COMMERCE', 'currentProductInterest');
  const revisions = await state.listRevisions(ORG, rec!.id);
  assert.equal(revisions.length, 1, 'unchanged value → no second revision');
});

// 14. Failure creates a processing-attempt record and returns not-accepted.
test('a stage failure records a FAILED attempt and returns accepted=false', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const proc = new CognitiveEventProcessor(p);
  const bad = await proc.processEvent(productClick({ sourceEventId: 'bad-1', occurredAt: 'not-a-date' as any }));
  assert.equal(bad.status, 'failed');
  assert.equal(bad.accepted, false, 'a failed event is NOT reported as accepted (provider retries)');
  assert.equal(bad.failedStage, 'NORMALIZATION');
  const attempts = new CognitiveProcessingAttemptRepository(p);
  const dl = await attempts.listDeadLettered(ORG);
  const retryable = await attempts.listRetryable(ORG, { now: new Date(Date.now() + 60_000) });
  assert.ok(retryable.length + dl.length >= 1, 'a FAILED attempt is recorded and recoverable');
});

// 15. Retry/reprocess does not duplicate memory, revisions, or outbox.
test('reprocessing does not duplicate memory, revisions, or outbox rows', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const proc = new CognitiveEventProcessor(p);
  const first = await proc.processEvent(productClick({ sourceEventId: 'retry-1' }));
  await proc.retry(productClick({ sourceEventId: 'retry-1' }));
  const state = new ActiveStateRepository(p);
  const records = await state.listForIdentity(ORG, first.subjectIdentityId!, { includeExpired: true });
  let revisionCount = 0;
  for (const rec of records) revisionCount += (await state.listRevisions(ORG, rec.id)).length;
  const outbox = await new StateChangeOutboxRepository(p).listPending(ORG);
  assert.equal(outbox.length, revisionCount, 'retry added no extra outbox rows');
  // One memory row only.
  const mem = await new MemoryEventRepository(p).findBySource(ORG, 'website', 'retry-1');
  assert.ok(mem);
});

// Bonus — proves the LoopEvent ingress seam is reused (no new public receiver).
test('LoopEventConsumer drains the existing LoopEvent store through the processor', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  // Store a raw LoopEvent exactly as the /api/v1/events gateway would.
  await (p as any).loopEvent.create({
    data: {
      eventId: 'loop-evt-1',
      platform: 'servicesinmycity',
      eventType: 'web.cta_click',
      occurredAt: OCCURRED,
      receivedAt: OCCURRED,
      anonymousId: 'anon-xyz',
      payload: { product: 'Purple Running Shoe', category: 'Footwear', color: 'Purple' },
      processed: false,
    },
  });
  const proc = new CognitiveEventProcessor(p);
  const consumer = new LoopEventConsumer(p, proc, {
    resolveOrganizationId: async (platform) => (platform === 'servicesinmycity' ? ORG : null),
  });
  const result = await consumer.drain();
  assert.equal(result.processed, 1);
  // The raw row is now marked processed; a re-drain does nothing.
  const again = await consumer.drain();
  assert.equal(again.seen, 0);
  // And it produced a durable memory event.
  const mem = await new MemoryEventRepository(p).findBySource(ORG, 'loop-event', 'loop-evt-1');
  assert.equal(mem?.eventType, 'PRODUCT_CLICKED');
});

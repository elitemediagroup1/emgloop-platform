// Loop Cognitive Architecture — Increment 1 deterministic tests.
//
// Runs with the built-in Node test runner (node --import tsx --test). NO
// database and NO credentials: every repository is driven against the in-memory
// cognitive Prisma double, which enforces the org-scoped @@unique constraints
// exactly as Postgres does. These pin the foundation the whole architecture
// rests on: tenant-scoped identity, immutable memory, class-preserving
// knowledge, unique+revisioned+evidenced+outboxed active state, deny-by-default
// governance posture, and non-auto-accepted hypotheses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import {
  CognitiveIdentityRepository,
  IdentityRoleRepository,
  IdentityEvidenceRepository,
  IdentityResolutionLinkRepository,
  MemoryEventRepository,
  KnowledgeAssertionRepository,
  DataGovernancePolicyRepository,
  ActiveStateRepository,
  StateChangeOutboxRepository,
  IntelligenceHypothesisRepository,
  CognitiveDecisionRepository,
} from '../src/repositories/cognitive';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

function prisma(): PrismaClient {
  return makeCognitivePrisma() as unknown as PrismaClient;
}

// Helper: append a memory event and return its id (used as state evidence).
async function seedMemory(memRepo: MemoryEventRepository, org: string, sourceEventId: string) {
  return memRepo.append(org, {
    eventType: 'PRODUCT_CLICKED',
    occurredAt: new Date('2026-07-01T00:00:00Z'),
    sourceSystem: 'website',
    sourceEventId,
  });
}

// 1. Identity uniqueness is organization-scoped.
test('identity uniqueness is organization-scoped (same key resolves to one row)', async () => {
  const repo = new CognitiveIdentityRepository(prisma());
  const a1 = await repo.resolveOrCreate(ORG_A, { entityType: 'PERSON', canonicalKey: 'k1' });
  const a2 = await repo.resolveOrCreate(ORG_A, { entityType: 'PERSON', canonicalKey: 'k1' });
  assert.equal(a1.id, a2.id, 'same (org, type, key) must resolve to the same identity');
  const all = await repo.list(ORG_A, { entityType: 'PERSON' });
  assert.equal(all.length, 1);
});

test('duplicate canonical key insert throws P2002 (constraint is enforced)', async () => {
  const p = prisma();
  const repo = new CognitiveIdentityRepository(p);
  await repo.create(ORG_A, { entityType: 'PERSON', canonicalKey: 'dup' });
  await assert.rejects(
    () => repo.create(ORG_A, { entityType: 'PERSON', canonicalKey: 'dup' }),
    (e: any) => e.code === 'P2002',
  );
});

// 2. Same canonical key may exist in different organizations.
test('same canonical key exists independently across organizations', async () => {
  const repo = new CognitiveIdentityRepository(prisma());
  const a = await repo.resolveOrCreate(ORG_A, { entityType: 'PERSON', canonicalKey: 'shared' });
  const b = await repo.resolveOrCreate(ORG_B, { entityType: 'PERSON', canonicalKey: 'shared' });
  assert.notEqual(a.id, b.id);
  assert.equal(a.organizationId, ORG_A);
  assert.equal(b.organizationId, ORG_B);
});

// 3. One identity supports multiple overlapping roles.
test('one identity holds multiple overlapping active roles', async () => {
  const p = prisma();
  const idRepo = new CognitiveIdentityRepository(p);
  const roleRepo = new IdentityRoleRepository(p);
  const id = await idRepo.create(ORG_A, { entityType: 'PERSON', canonicalKey: 'multi' });
  await roleRepo.addRole(ORG_A, { identityId: id.id, roleType: 'LEAD' });
  await roleRepo.addRole(ORG_A, { identityId: id.id, roleType: 'CONSUMER' });
  await roleRepo.addRole(ORG_A, { identityId: id.id, roleType: 'LEAD' }); // idempotent
  const active = await roleRepo.listForIdentity(ORG_A, id.id, { activeOnly: true });
  assert.equal(active.length, 2, 'LEAD + CONSUMER overlap; the second LEAD is idempotent');
  // The identity entity type is untouched by role assignment.
  const reread = await idRepo.findById(ORG_A, id.id);
  assert.equal(reread?.entityType, 'PERSON');
});

// 4. Identity resolution links are reversible.
test('identity resolution links are reversible and never hard-deleted', async () => {
  const p = prisma();
  const linkRepo = new IdentityResolutionLinkRepository(p);
  const link = await linkRepo.propose(ORG_A, {
    sourceIdentityId: 's',
    targetIdentityId: 't',
    method: 'VERIFIED_EMAIL',
  });
  await linkRepo.confirm(ORG_A, link.id);
  const reversed = await linkRepo.reverse(ORG_A, link.id, { reversedBy: 'u1', reason: 'mismatch' });
  assert.equal(reversed?.status, 'REVERSED');
  assert.ok(reversed?.reversedAt, 'reversal is timestamped');
  const still = await linkRepo.listForIdentity(ORG_A, 's');
  assert.equal(still.length, 1, 'the link row still exists after reversal');
});

// 5. MemoryEvent source IDs are unique per organization and source.
test('memory events are idempotent per (org, source, sourceEventId)', async () => {
  const p = prisma();
  const memRepo = new MemoryEventRepository(p);
  const first = await seedMemory(memRepo, ORG_A, 'evt-1');
  const again = await seedMemory(memRepo, ORG_A, 'evt-1');
  assert.equal(first.id, again.id, 'redelivered provider event resolves to the same row');
  const otherOrg = await seedMemory(memRepo, ORG_B, 'evt-1');
  assert.notEqual(first.id, otherOrg.id, 'same sourceEventId in another org is a distinct row');
});

// 6. MemoryEvent payload is immutable through repositories.
test('memory event payload is immutable; only processing status advances', async () => {
  const p = prisma();
  const memRepo = new MemoryEventRepository(p);
  const ev = await memRepo.append(ORG_A, {
    eventType: 'PRODUCT_CLICKED',
    occurredAt: new Date('2026-07-01T00:00:00Z'),
    sourceSystem: 'website',
    sourceEventId: 'evt-immutable',
    payload: { productId: 'p1' },
  });
  // The repository exposes no payload/eventType/occurredAt mutator.
  assert.equal(typeof (memRepo as any).updatePayload, 'undefined');
  const advanced = await memRepo.setProcessingStatus(ORG_A, ev.id, 'MEMORY_PERSISTED');
  assert.equal(advanced?.processingStatus, 'MEMORY_PERSISTED');
  assert.deepEqual(advanced?.payload, { productId: 'p1' }, 'payload unchanged by status advance');
  assert.equal(advanced?.eventType, 'PRODUCT_CLICKED');
});

// 7. Assertions preserve declared/observed/inferred/predicted distinction.
test('assertion class is preserved, never collapsed to fact', async () => {
  const p = prisma();
  const repo = new KnowledgeAssertionRepository(p);
  for (const cls of ['DECLARED', 'OBSERVED', 'INFERRED', 'PREDICTED'] as const) {
    const a = await repo.create(ORG_A, {
      subjectIdentityId: 'subj',
      predicate: `pred.${cls}`,
      value: cls,
      assertionClass: cls,
    });
    assert.equal(a.assertionClass, cls);
  }
  const list = await repo.listForSubject(ORG_A, 'subj');
  const classes = list.map((a) => a.assertionClass).sort();
  assert.deepEqual(classes, ['DECLARED', 'INFERRED', 'OBSERVED', 'PREDICTED']);
});

// 8. Active-state keys are unique per identity/domain/key.
test('active state is one row per (identity, domain, stateKey)', async () => {
  const p = prisma();
  const memRepo = new MemoryEventRepository(p);
  const state = new ActiveStateRepository(p);
  const ev = await seedMemory(memRepo, ORG_A, 'evt-state');
  const ev2 = await seedMemory(memRepo, ORG_A, 'evt-state-2');
  await state.applyStateChange(ORG_A, {
    identityId: 'id1',
    domain: 'COMMERCE',
    stateKey: 'currentCategoryInterest',
    value: 'Footwear',
    evidence: [{ memoryEventId: ev.id }],
  });
  await state.applyStateChange(ORG_A, {
    identityId: 'id1',
    domain: 'COMMERCE',
    stateKey: 'currentCategoryInterest',
    value: 'Apparel',
    evidence: [{ memoryEventId: ev2.id }],
  });
  const records = await state.listForIdentity(ORG_A, 'id1', { includeExpired: true });
  const forKey = records.filter((r) => r.stateKey === 'currentCategoryInterest');
  assert.equal(forKey.length, 1, 'the same key updates in place, not duplicated');
  const current = await state.getState(ORG_A, 'id1', 'COMMERCE', 'currentCategoryInterest');
  assert.equal(current?.value, 'Apparel');
});

// 9. Every state update creates a revision; an unchanged value creates none.
test('every real state change creates exactly one revision; no-op creates none', async () => {
  const p = prisma();
  const memRepo = new MemoryEventRepository(p);
  const state = new ActiveStateRepository(p);
  const ev = await seedMemory(memRepo, ORG_A, 'evt-rev');
  const first = await state.applyStateChange(ORG_A, {
    identityId: 'id1',
    domain: 'COMMERCE',
    stateKey: 'intentStrength',
    value: 'MEDIUM',
    confidence: 0.5,
    evidence: [{ memoryEventId: ev.id }],
  });
  assert.equal(first.changed, true);
  const second = await state.applyStateChange(ORG_A, {
    identityId: 'id1',
    domain: 'COMMERCE',
    stateKey: 'intentStrength',
    value: 'HIGH',
    confidence: 0.8,
    evidence: [{ memoryEventId: ev.id }],
  });
  assert.equal(second.changed, true);
  // Re-evaluate with the SAME value/confidence — no revision, no publish.
  const noop = await state.applyStateChange(ORG_A, {
    identityId: 'id1',
    domain: 'COMMERCE',
    stateKey: 'intentStrength',
    value: 'HIGH',
    confidence: 0.8,
    evidence: [{ memoryEventId: ev.id }],
  });
  assert.equal(noop.changed, false, 'unchanged value must not create a revision');
  assert.equal(noop.revision, null);
  const revisions = await state.listRevisions(ORG_A, first.record.id);
  assert.equal(revisions.length, 2, 'two real changes → two revisions');
});

// 10. State evidence references a valid memory/knowledge/relationship record.
test('state change requires evidence; evidence cites the source record', async () => {
  const p = prisma();
  const memRepo = new MemoryEventRepository(p);
  const state = new ActiveStateRepository(p);
  const ev = await seedMemory(memRepo, ORG_A, 'evt-ev');
  const res = await state.applyStateChange(ORG_A, {
    identityId: 'id1',
    domain: 'COMMERCE',
    stateKey: 'currentProductInterest',
    value: 'Purple Running Shoe',
    evidence: [{ memoryEventId: ev.id, weight: 1 }],
  });
  const evidence = await state.listEvidence(ORG_A, res.record.id);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.memoryEventId, ev.id);
  // A real change with NO evidence is rejected.
  await assert.rejects(() =>
    state.applyStateChange(ORG_A, {
      identityId: 'id2',
      domain: 'COMMERCE',
      stateKey: 'currentProductInterest',
      value: 'X',
      evidence: [],
    }),
  );
});

// 11. Outbox record is created transactionally with the state update.
test('a state change writes exactly one PENDING outbox row for the revision', async () => {
  const p = prisma();
  const memRepo = new MemoryEventRepository(p);
  const state = new ActiveStateRepository(p);
  const outbox = new StateChangeOutboxRepository(p);
  const ev = await seedMemory(memRepo, ORG_A, 'evt-outbox');
  const res = await state.applyStateChange(ORG_A, {
    identityId: 'id1',
    domain: 'CAMPAIGN',
    stateKey: 'operationalAttentionLevel',
    value: 'HIGH',
    evidence: [{ memoryEventId: ev.id }],
  });
  const pending = await outbox.listPending(ORG_A);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.status, 'PENDING');
  assert.equal(pending[0]?.activeStateRecordId, res.record.id);
  assert.equal(pending[0]?.activeStateRevisionId, res.revision?.id);
});

// 12. Policies default to deny (no ACTIVE policy → no grant).
test('policies default to DRAFT and only ACTIVE policies are applicable (deny-by-default posture)', async () => {
  const p = prisma();
  const repo = new DataGovernancePolicyRepository(p);
  const draft = await repo.create(ORG_A, { name: 'commerce', allowedPurposes: ['PERSONALIZATION'] });
  assert.equal(draft.status, 'DRAFT', 'new policy is not active until deliberately activated');
  const applicableWhileDraft = await repo.findApplicable(ORG_A, { eventType: 'PRODUCT_CLICKED' });
  assert.equal(applicableWhileDraft.length, 0, 'a DRAFT policy grants nothing');
  await repo.setStatus(ORG_A, draft.id, 'ACTIVE');
  const applicable = await repo.findApplicable(ORG_A, { eventType: 'PRODUCT_CLICKED' });
  assert.equal(applicable.length, 1);
});

// 13. Revoked consent (evidence) no longer resolves an identity.
test('revoked identity evidence is excluded from resolution', async () => {
  const p = prisma();
  const idRepo = new CognitiveIdentityRepository(p);
  const evRepo = new IdentityEvidenceRepository(p);
  const id = await idRepo.create(ORG_A, { entityType: 'PERSON', canonicalKey: 'consent' });
  const evidence = await evRepo.record(ORG_A, {
    identityId: id.id,
    evidenceType: 'EMAIL',
    rawValue: 'Person@Example.com ',
    consentBasis: 'CONSENT',
    permittedPurposes: ['PERSONALIZATION'],
  });
  // Case/whitespace-insensitive resolution works before revocation.
  const resolved = await evRepo.findIdentityIdByValue(ORG_A, 'EMAIL', 'person@example.com');
  assert.equal(resolved, id.id);
  await evRepo.revoke(ORG_A, evidence.id);
  const afterRevoke = await evRepo.findIdentityIdByValue(ORG_A, 'EMAIL', 'person@example.com');
  assert.equal(afterRevoke, null, 'revoked evidence no longer resolves the identity');
});

// 14. AI-generated hypotheses do not auto-accept.
test('AI-generated hypotheses are PROPOSED and cannot auto-accept', async () => {
  const p = prisma();
  const repo = new IntelligenceHypothesisRepository(p);
  const h = await repo.propose(ORG_A, {
    hypothesisType: 'churn_risk',
    title: 'Possible churn',
    generatedBy: 'AI_MODEL',
    confidence: 0.99,
  });
  assert.equal(h.status, 'PROPOSED', 'never ACCEPTED on creation, regardless of confidence/source');
  await assert.rejects(() => repo.accept(ORG_A, h.id, ''), 'acceptance needs an attributed actor');
  const accepted = await repo.accept(ORG_A, h.id, 'matt');
  assert.equal(accepted?.status, 'ACCEPTED');
  assert.equal(accepted?.acceptedBy, 'matt');
});

// 15. Every repository enforces organization scope (cross-org read → null).
test('cross-organization reads fail closed to null across repositories', async () => {
  const p = prisma();
  const idRepo = new CognitiveIdentityRepository(p);
  const memRepo = new MemoryEventRepository(p);
  const knRepo = new KnowledgeAssertionRepository(p);
  const govRepo = new DataGovernancePolicyRepository(p);
  const decRepo = new CognitiveDecisionRepository(p);
  const hypRepo = new IntelligenceHypothesisRepository(p);
  const state = new ActiveStateRepository(p);

  const id = await idRepo.create(ORG_A, { entityType: 'PERSON', canonicalKey: 'scoped' });
  const ev = await memRepo.append(ORG_A, {
    eventType: 'PRODUCT_CLICKED',
    occurredAt: new Date(),
    sourceSystem: 'website',
    sourceEventId: 'evt-scope',
  });
  const kn = await knRepo.create(ORG_A, {
    subjectIdentityId: id.id,
    predicate: 'x',
    value: 1,
    assertionClass: 'OBSERVED',
  });
  const pol = await govRepo.create(ORG_A, { name: 'p' });
  const dec = await decRepo.record(ORG_A, { decisionType: 'd', decision: 'NO_ACTION' });
  const hyp = await hypRepo.propose(ORG_A, {
    hypothesisType: 't',
    title: 'T',
    generatedBy: 'DETERMINISTIC_RULE',
  });
  await state.applyStateChange(ORG_A, {
    identityId: id.id,
    domain: 'COMMERCE',
    stateKey: 'k',
    value: 'v',
    evidence: [{ memoryEventId: ev.id }],
  });

  // ORG_A can read its rows.
  assert.ok(await idRepo.findById(ORG_A, id.id));
  // ORG_B cannot — every repository resolves within the org and returns null.
  assert.equal(await idRepo.findById(ORG_B, id.id), null);
  assert.equal(await memRepo.findById(ORG_B, ev.id), null);
  assert.equal(await knRepo.findById(ORG_B, kn.id), null);
  assert.equal(await govRepo.findById(ORG_B, pol.id), null);
  assert.equal(await decRepo.findById(ORG_B, dec.id), null);
  assert.equal(await hypRepo.findById(ORG_B, hyp.id), null);
  assert.equal(await state.getState(ORG_B, id.id, 'COMMERCE', 'k'), null);
});

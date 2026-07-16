// Contract test — @emgloop/shared verified knowledge (kg.v1).
//
// Runs with the built-in Node test runner (node --import tsx --test). Requires NO
// database and NO production credentials: it validates the transport contract and
// the fixture batch shape against LOOP_KNOWLEDGE_CONTRACT.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWLEDGE_CONTRACT_VERSION,
  KNOWLEDGE_ERROR_CODES,
  KNOWLEDGE_ERROR_STATUS,
  KNOWLEDGE_BATCH_LIMITS,
  KNOWLEDGE_VERIFICATIONS,
  KNOWLEDGE_CONFIDENCES,
} from '../src/knowledge';
import {
  CONTRACT_FIXTURE_BATCH,
  CONTRACT_FIXTURE_IDEMPOTENCY_KEY,
} from '../src/knowledge-contract.fixture';

test('contract version is kg.v1', () => {
  assert.equal(KNOWLEDGE_CONTRACT_VERSION, 'kg.v1');
});

test('every typed error code maps to an HTTP status', () => {
  for (const code of KNOWLEDGE_ERROR_CODES) {
    const status = KNOWLEDGE_ERROR_STATUS[code];
    assert.ok(typeof status === 'number' && status >= 400 && status < 600, code + ' -> ' + status);
  }
});

test('conflict / too_large / schema_incompatible have contract statuses', () => {
  assert.equal(KNOWLEDGE_ERROR_STATUS.conflict, 409);
  assert.equal(KNOWLEDGE_ERROR_STATUS.too_large, 413);
  assert.equal(KNOWLEDGE_ERROR_STATUS.schema_incompatible, 422);
  assert.equal(KNOWLEDGE_ERROR_STATUS.unauthorized, 401);
  assert.equal(KNOWLEDGE_ERROR_STATUS.not_found, 404);
});

test('batch limits are positive and ordered sensibly', () => {
  assert.ok(KNOWLEDGE_BATCH_LIMITS.maxBodyBytes > 0);
  assert.ok(KNOWLEDGE_BATCH_LIMITS.maxClaims >= KNOWLEDGE_BATCH_LIMITS.maxEntities);
  assert.ok(KNOWLEDGE_BATCH_LIMITS.maxEntitySources >= KNOWLEDGE_BATCH_LIMITS.maxEntities);
});

test('fixture batch is contract-shaped (kg.v1)', () => {
  assert.equal(CONTRACT_FIXTURE_BATCH.contract_version, KNOWLEDGE_CONTRACT_VERSION);
  assert.ok(Array.isArray(CONTRACT_FIXTURE_BATCH.sources) && CONTRACT_FIXTURE_BATCH.sources.length >= 1);
  assert.ok(Array.isArray(CONTRACT_FIXTURE_BATCH.entities) && CONTRACT_FIXTURE_BATCH.entities.length >= 1);
  assert.ok(Array.isArray(CONTRACT_FIXTURE_BATCH.claims) && CONTRACT_FIXTURE_BATCH.claims.length >= 1);
});

test('fixture entities/claims use known verification + confidence vocab', () => {
  for (const e of CONTRACT_FIXTURE_BATCH.entities ?? []) {
    assert.ok(e.verification == null || KNOWLEDGE_VERIFICATIONS.includes(e.verification as never));
    assert.ok(e.confidence == null || KNOWLEDGE_CONFIDENCES.includes(e.confidence as never));
  }
  for (const c of CONTRACT_FIXTURE_BATCH.claims ?? []) {
    assert.ok(c.verification == null || KNOWLEDGE_VERIFICATIONS.includes(c.verification as never));
    assert.ok(c.confidence == null || KNOWLEDGE_CONFIDENCES.includes(c.confidence as never));
  }
});

test('fixture provenance references only declared sources', () => {
  const sourceIds = new Set((CONTRACT_FIXTURE_BATCH.sources ?? []).map((s) => s.id));
  for (const link of CONTRACT_FIXTURE_BATCH.entity_sources ?? []) {
    assert.ok(sourceIds.has(link.sourceId), 'entity_source refs unknown source ' + link.sourceId);
  }
  for (const link of CONTRACT_FIXTURE_BATCH.claim_sources ?? []) {
    assert.ok(sourceIds.has(link.sourceId), 'claim_source refs unknown source ' + link.sourceId);
  }
});

test('fixture idempotency key is deterministic + dataset-scoped', () => {
  assert.match(CONTRACT_FIXTURE_IDEMPOTENCY_KEY, /^petsinmycity:austin:kg\.v1:/);
});

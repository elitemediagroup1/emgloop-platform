// Synthesis eligibility: "a row exists" is never "current intelligence". Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PARTIAL_COVERAGE_LIMITATION, absenceJustified, digestSynthesisEligibility, type SynthesisEligibilityInput } from '../src';

const NOW = new Date('2026-09-26T12:00:00Z');
const DAY = 864e5;
const LIVE = { connectionLive: true, sourceLastEvidenceAt: null };
const digest = (patch: Partial<SynthesisEligibilityInput> = {}): SynthesisEligibilityInput => ({
  scope: 'ORGANIZATION',
  status: 'CURRENT',
  coverage: 'CONNECTED_SUFFICIENT',
  windowEnd: new Date(NOW.getTime() - DAY),
  expiresAt: new Date(NOW.getTime() + 20 * DAY),
  content: { reading: { statement: 'Calls are down.', status: 'WATCH', confidence: 'HIGH' }, signals: [] },
  provenance: { producerKind: 'RULE' },
  ...patch,
});

test('a CURRENT, SUFFICIENT, live digest is eligible and carries no limitation of its own', () => {
  assert.deepEqual(digestSynthesisEligibility(digest(), LIVE, NOW), { eligible: true, coverage: 'CONNECTED_SUFFICIENT', limitations: [] });
});

test('status must be CURRENT: a STALE or WITHDRAWN row never contributes', () => {
  assert.deepEqual(digestSynthesisEligibility(digest({ status: 'STALE' }), LIVE, NOW), { eligible: false, coverage: 'STALE', reason: 'NOT_CURRENT_STATUS' });
  assert.deepEqual(digestSynthesisEligibility(digest({ status: 'WITHDRAWN' }), LIVE, NOW), { eligible: false, coverage: 'DISCONNECTED', reason: 'NOT_CURRENT_STATUS' });
});

test('freshness decides: newer evidence than the digest read, near-expiry, a source not live, an unknown coverage', () => {
  assert.deepEqual(digestSynthesisEligibility(digest(), { connectionLive: true, sourceLastEvidenceAt: new Date(NOW.getTime() - DAY / 2) }, NOW), { eligible: false, coverage: 'STALE', reason: 'NOT_CURRENT_COVERAGE' }, 'evidence newer than the digest makes it stale');
  assert.equal(digestSynthesisEligibility(digest(), { connectionLive: true, sourceLastEvidenceAt: new Date(NOW.getTime() - 2 * DAY) }, NOW).eligible, true, 'older evidence changes nothing');
  assert.equal(digestSynthesisEligibility(digest({ expiresAt: new Date(NOW.getTime() + DAY / 2) }), LIVE, NOW).coverage, 'STALE', 'about to expire');
  assert.deepEqual(digestSynthesisEligibility(digest(), { connectionLive: false, sourceLastEvidenceAt: null }, NOW), { eligible: false, coverage: 'DISCONNECTED', reason: 'NOT_CURRENT_COVERAGE' });
  assert.deepEqual(digestSynthesisEligibility(digest({ coverage: 'SOMETHING' }), LIVE, NOW), { eligible: false, coverage: 'ERROR', reason: 'NOT_CURRENT_COVERAGE' });
});

test('INSUFFICIENT, DISCONNECTED, STALE and ERROR as recorded coverage contribute nothing; invalid content is ERROR', () => {
  for (const coverage of ['CONNECTED_INSUFFICIENT', 'DISCONNECTED', 'STALE', 'ERROR']) {
    assert.equal(digestSynthesisEligibility(digest({ coverage }), LIVE, NOW).eligible, false, coverage);
  }
  assert.deepEqual(digestSynthesisEligibility(digest({ content: { bogus: 1 } as never }), LIVE, NOW), { eligible: false, coverage: 'ERROR', reason: 'INVALID_CONTENT' });
});

test('PARTIAL is permitted and carries its limitation (the governed words first, then its own)', () => {
  const r = digestSynthesisEligibility(digest({ coverage: 'CONNECTED_PARTIAL', content: { reading: { statement: 'Some calls are down.', status: 'WATCH', confidence: 'MEDIUM' }, signals: [], limitations: ['Only one buyer reported revenue.'] } }), LIVE, NOW);
  assert.deepEqual(r, { eligible: true, coverage: 'CONNECTED_PARTIAL', limitations: [PARTIAL_COVERAGE_LIMITATION, 'Only one buyer reported revenue.'] });
});

test('an absence is justified only by readings that are all SUFFICIENT (and at least one)', () => {
  assert.equal(absenceJustified(['CONNECTED_SUFFICIENT', 'CONNECTED_SUFFICIENT']), true);
  assert.equal(absenceJustified(['CONNECTED_SUFFICIENT', 'CONNECTED_PARTIAL']), false);
  assert.equal(absenceJustified([]), false);
});

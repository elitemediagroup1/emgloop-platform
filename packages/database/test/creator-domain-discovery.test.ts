import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { externalBrandCandidate, creatorMailQuery } from '../src/creator/creator-mail-matching';

test('finds a single business domain without a CRM company', () => {
  assert.equal(externalBrandCandidate(['partnerships@cabocreamery.com', 'press@cabocreamery.com']), 'cabocreamery');
});
test('rejects unrelated business domains and ambiguous attribution', () => {
  assert.equal(externalBrandCandidate(['a@cabocreamery.com', 'b@otherbrand.com']), null);
});
test('ignores consumer inboxes but not a verified business participant', () => {
  assert.equal(externalBrandCandidate(['someone@gmail.com', 'marketing@cabocreamery.com']), 'cabocreamery');
});
test('does not invent brands from personal-only addresses', () => {
  assert.equal(externalBrandCandidate(['someone@gmail.com']), null);
});
test('rejects malformed external addresses', () => {
  assert.equal(externalBrandCandidate(['not-an-email']), null);
});
test('rejects ambiguous country-code domain structures', () => {
  assert.equal(externalBrandCandidate(['hello@example.co.uk']), null);
});

test('all-history capture query omits date cutoff but preserves staff creator filters', () => {
  const profile = { id: 'trevon', displayName: 'Trevon Hill', handle: 'trevonbassmaster', preferences: { staffMailKeywords: ['Trevon Hill', 'Trevon', 'trevonbassmaster'] }, socialAccounts: [] };
  const query = creatorMailQuery(profile, false, new Date(0));
  assert.ok(query);
  assert.equal(query!.includes('after:'), false);
  assert.ok(query!.includes('"trevonbassmaster"'));
  assert.ok(query!.includes('-in:trash'));
});

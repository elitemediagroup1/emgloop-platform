import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { externalBrandCandidate } from '../src/creator/creator-mail-matching';

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

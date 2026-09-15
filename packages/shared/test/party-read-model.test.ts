// Party read-model contract, pure. Identity slice P1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PARTY_READ_MODEL_VERSION,
  PARTY_LIST_DEFAULT_LIMIT,
  PARTY_LIST_MAX_LIMIT,
  PARTY_POSTURE_LIMITATIONS,
  partyListLimit,
} from '../src/party-read-model';

test('versioned contract with stated limitations', () => {
  assert.equal(PARTY_READ_MODEL_VERSION, 'party-read-model.v1');
  assert.deepEqual([...PARTY_POSTURE_LIMITATIONS], ['EVIDENCE_NOT_COLLECTED', 'VERIFICATION_NOT_AVAILABLE']);
});

test('page size is clamped, and anything that is not a number uses the default', () => {
  assert.equal(partyListLimit(10), 10);
  assert.equal(partyListLimit(0), 1);
  assert.equal(partyListLimit(-5), 1);
  assert.equal(partyListLimit(2.9), 2);
  assert.equal(partyListLimit(10_000), PARTY_LIST_MAX_LIMIT);
  for (const v of [undefined, null, '25', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(partyListLimit(v), PARTY_LIST_DEFAULT_LIMIT, String(v));
  }
});

test('fence: the contract carries no contact field and no confidence', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'party-read-model.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /email|phone|address|confidence|score|probabilit/i);
  assert.doesNotMatch(src, /Date\.now|new Date\(|process\.env|fetch\(|prisma/i);
});

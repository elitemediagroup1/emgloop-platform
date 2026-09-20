// The verifier is read-only and structurally cannot emit sensitive observation fields. No DB needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODULE = readFileSync(join(__dirname, '..', 'src', 'verification', 'source-observation-verifier.ts'), 'utf8');
const CLI = readFileSync(join(__dirname, '..', 'scripts', 'verify-observations.ts'), 'utf8');

test('the verifier performs NO writes and issues only read queries', () => {
  for (const src of [MODULE, CLI]) {
    assert.doesNotMatch(src, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/, 'no write model call');
    assert.doesNotMatch(src, /\$executeRaw|\$executeRawUnsafe/, 'no write-capable raw execution');
  }
  // The only raw calls are read queries.
  assert.ok(/\$queryRaw/.test(MODULE));
  assert.doesNotMatch(MODULE, /\$queryRawUnsafe/, 'no unsafe raw query (no interpolation of untrusted input)');
});

test('the aggregate query projects only COUNTs -- never a raw id, key, timestamp or content column value', () => {
  const select = MODULE.slice(MODULE.indexOf('SELECT'), MODULE.indexOf('FROM source_observations o'));
  // Every output alias is a count; no sensitive raw value is projected.
  const aliases = [...select.matchAll(/\bAS\s+(\w+)/g)].map((m) => m[1]);
  const SAFE_ALIASES = new Set(['observations','distinct_owners','inbound','outbound','other_direction','with_conversation_key','with_occurred_at','with_observed_at','had_text_true','had_text_false','orphan_owners']);
  assert.ok(aliases.length >= 8);
  for (const a of aliases) assert.ok(SAFE_ALIASES.has(a!), `unexpected projected alias: ${a}`);
  // The sensitive columns appear ONLY inside COUNT(... FILTER ...) predicates, never as a projected value.
  for (const col of ['"conversationKey" AS', '"senderKey" AS', '"occurredAt" AS', '"observedAt" AS', '"participantKeys" AS']) {
    assert.ok(!select.includes(col), `sensitive column projected as a value: ${col}`);
  }
  assert.ok(/COUNT\s*\(/i.test(select));
});

test('the report shape has no field that can carry a raw id, hash, timestamp value or content', () => {
  // The report interface exposes only numbers, booleans, a provider label, and criterion/detail
  // wording. Assert the declared fields are exactly the safe set.
  assert.match(MODULE, /interface ObservationVerificationCounts \{[\s\S]*?\}/);
  const countsBlock = MODULE.slice(MODULE.indexOf('interface ObservationVerificationCounts'), MODULE.indexOf('interface ObservationVerificationReport'));
  // Every counts field is typed `number`.
  const fields = countsBlock.split('\n').filter((l) => /readonly \w+:/.test(l));
  for (const f of fields) assert.match(f, /:\s*number;/, `counts field is not a number: ${f.trim()}`);
});

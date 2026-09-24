// G2 as a recorded provider policy (2026-09-24): the stored control and the reader the gateway uses.
// In memory; the CHECK constraints are proven against Postgres in intelligence-digest.postgres.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

import { AiControlRepository } from '../src/repositories/brain/ai-control.repository';
import { AI_PROVIDER_POLICY_CACHE_MAX_MS, cachedAiProviderPolicies } from '../src/services/ai-runtime/provider-policy-reader';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';

const OPS = { kind: 'OPERATIONS', reference: 'github-run:42:record-ai-provider-policy' } as const;
const T0 = new Date('2026-09-24T12:00:00Z');

function controls() {
  const fake: any = makeCognitivePrisma({ also: ['organizationMembership', 'aiControl', 'aiControlCurrent'] });
  return { fake, repo: new AiControlRepository(fake as PrismaClient) };
}

test('a provider policy is recorded, versioned, killed and read back -- and never shows up as a switch', async () => {
  const { repo, fake } = controls();
  assert.deepEqual(await repo.providerPolicies(), [], 'nothing recorded: nothing approved');

  const first = await repo.recordProviderPolicy({ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', reason: 'Data terms reviewed 2026-09-24: no training, 30-day retention, US.', expectedVersion: 0, actor: OPS, now: T0 });
  assert.equal(first.ok && first.result, 'APPENDED');
  assert.deepEqual(first.ok && first.entry.target, { scope: 'PROVIDER_POLICY', organizationId: null, value: 'anthropic' });
  assert.equal(fake.aiControl.__rows[0].controlKey, 'PROVIDER_POLICY|-|anthropic');
  assert.equal(fake.aiControl.__rows[0].ceiling, 'COMMUNICATION_CONTENT');

  const same = await repo.recordProviderPolicy({ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', reason: 'again', expectedVersion: 1, actor: OPS });
  assert.equal(same.ok && same.result, 'UNCHANGED', 'the same state and ceiling appends nothing');
  const lower = await repo.recordProviderPolicy({ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'OPERATIONAL', reason: 'Narrowed.', expectedVersion: 1, actor: OPS });
  assert.equal(lower.ok && lower.entry.version, 2, 'moving the ceiling is a change');
  assert.deepEqual(await repo.recordProviderPolicy({ providerId: 'anthropic', state: 'KILLED', ceiling: null, reason: 'x', expectedVersion: 1, actor: OPS }), { ok: false, refusal: 'STALE' });
  const killed = await repo.recordProviderPolicy({ providerId: 'anthropic', state: 'KILLED', ceiling: null, reason: 'Incident.', expectedVersion: 2, actor: OPS });
  assert.equal(killed.ok && killed.entry.version, 3);

  assert.deepEqual(await repo.providerPolicies(), [{ providerId: 'anthropic', state: 'KILLED', ceiling: null, version: 3, recordedAtMs: killed.ok ? killed.entry.recordedAtMs : 0 }]);
  assert.deepEqual((await repo.providerPolicyHistory('anthropic')).map((e) => [e.version, e.state, e.ceiling]), [[1, 'ACTIVE', 'COMMUNICATION_CONTENT'], [2, 'ACTIVE', 'OPERATIONAL'], [3, 'KILLED', null]]);

  // The Brain's effective-controls reader never sees a policy: it is not a PROVIDER switch.
  await repo.recordPlatformControl({ scope: 'PROVIDER', value: 'anthropic', state: 'ACTIVE', reason: 'Switch on.', expectedVersion: 0, operationsReference: 'r' });
  assert.deepEqual((await repo.currentFor('org_a')).map((e) => e.target.scope), ['PROVIDER']);
});

test('an ACTIVE policy must name a ceiling, and a switch may not carry one', async () => {
  const { repo, fake } = controls();
  assert.deepEqual(await repo.recordProviderPolicy({ providerId: 'openai', state: 'ACTIVE', ceiling: null, reason: 'x', expectedVersion: 0, actor: OPS }), { ok: false, refusal: 'CEILING_REQUIRED' });
  assert.deepEqual(await repo.recordProviderPolicy({ providerId: 'openai', state: 'ACTIVE', ceiling: 'EVERYTHING' as never, reason: 'x', expectedVersion: 0, actor: OPS }), { ok: false, refusal: 'UNKNOWN_CEILING' });
  assert.deepEqual(await repo.recordProviderPolicy({ providerId: 'openai', state: 'ACTIVE', ceiling: 'OPERATIONAL', reason: ' ', expectedVersion: 0, actor: OPS }), { ok: false, refusal: 'REASON_REQUIRED' });
  assert.deepEqual(await repo.recordProviderPolicy({ providerId: 'openai', state: 'ACTIVE', ceiling: 'OPERATIONAL', reason: 'x', expectedVersion: 0, actor: { kind: 'OPERATIONS', reference: '' } }), { ok: false, refusal: 'ACTOR_INCOMPLETE' });
  const human = await repo.recordProviderPolicy({ providerId: 'openai', state: 'ACTIVE', ceiling: 'OPERATIONAL', reason: 'Reviewed by the CTO.', expectedVersion: 0, actor: { kind: 'HUMAN', userId: 'user_cto' } });
  assert.equal(human.ok, true, 'a named person may record one too');
  assert.equal(fake.aiControl.__rows.length, 1);
  // Existing switches are written exactly as before: no ceiling column in their data at all.
  await repo.recordPlatformControl({ scope: 'GLOBAL', value: null, state: 'ACTIVE', reason: 'On.', expectedVersion: 0, operationsReference: 'r' });
  assert.equal('ceiling' in fake.aiControl.__rows[1], false);
});

test('an unreadable policy row throws, so the gateway refuses as UNREADABLE rather than guessing', async () => {
  const { repo, fake } = controls();
  await repo.recordProviderPolicy({ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'OPERATIONAL', reason: 'x', expectedVersion: 0, actor: OPS });
  fake.aiControl.__rows[0].ceiling = 'SOMETHING_ELSE';
  await assert.rejects(() => repo.providerPolicies());
});

test('the reader caches a successful read briefly (30 s default, 60 s at most), and never caches a failure', async () => {
  let reads = 0;
  let fail = false;
  let now = 0;
  const source = {
    async providerPolicies() {
      reads += 1;
      if (fail) throw new Error('down');
      return [{ providerId: 'anthropic', state: 'ACTIVE' as const, ceiling: 'COMMUNICATION_CONTENT' as const, version: reads, recordedAtMs: 0 }];
    },
  };
  const read = cachedAiProviderPolicies(source, { nowMs: () => now });
  assert.equal((await read())[0]!.version, 1);
  now = 29_999;
  assert.equal((await read())[0]!.version, 1, 'cached');
  now = 30_000;
  assert.equal((await read())[0]!.version, 2, 'refreshed after 30 s');

  const capped = cachedAiProviderPolicies(source, { ttlMs: 10 * 60_000, nowMs: () => now });
  const v = (await capped())[0]!.version;
  now += AI_PROVIDER_POLICY_CACHE_MAX_MS;
  assert.notEqual((await capped())[0]!.version, v, 'no cache outlives 60 s, whatever it was asked for');

  const flaky = cachedAiProviderPolicies(source, { nowMs: () => now });
  fail = true;
  await assert.rejects(() => flaky());
  fail = false;
  const before = reads;
  await flaky();
  assert.equal(reads, before + 1, 'a failure was not cached: the next call read again');
});

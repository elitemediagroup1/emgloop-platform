// The durable AI usage ledger.
//
// WHAT THESE PROVE
//
// A BUDGET THAT SURVIVES A PROCESS. The in-memory ledger counts in one instance's
// memory, and on serverless a per-instance cap is that cap times however many
// instances are warm. These exercise the table instead.
//
// RESERVE CLOSES THE CONCURRENT-READ WINDOW. Ten simultaneous attempts that all read
// spend-to-date BEFORE any of them finishes must not all see zero. Reserving first is
// the only thing that makes that true, so there is a test that fails without it.
//
// A RETRY IS ONE ROW. `invocationId` is stable across retries and unique per
// organization, so a flaky provider cannot eat a cap several times over.
//
// ESTIMATE AND REPORT STAY APART. A reconciled row counts what the provider said; an
// in-flight one counts what Loop reserved. A provider that reported nothing leaves
// NULL, never 0 -- a zero claims the call was free.
//
// THE BUSINESS DAY IS THE ORGANIZATION'S, AND ONLY FOR THE BUDGET. Two organizations
// in different zones split the same instant onto different reporting days. The
// canonical instants stay UTC and nothing here becomes a display timezone.
//
// NO PROMPT, NO RESPONSE, NO CONTACT VALUE. Planted strings must not reach any
// column. The table has no body column, and the source fence keeps it that way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { AiUsageLedgerRepository, aiContextManifestHash } from '../src/repositories/ai-usage-ledger.repository';
import { DurableAiUsageLedger, isSerializationFailure } from '../src/services/ai-usage-ledger.service';
import type { AiCallReservation } from '../src/services/ai-runtime/gateway';
import type { AiBudgetPolicy } from '@emgloop/shared';
import { aiLedgerCapabilityOf } from '@emgloop/shared';

const ORG = 'org_ledger';
const OTHER = 'org_other';
const AT = new Date('2026-09-16T18:30:00.000Z');

/** Planted where a person's words or a model's answer would go. Neither may be stored. */
const SECRET = 'Dana at dana@example.com asked about her invoice on 555-0101';

function world(timezone = 'UTC', otherTimezone = 'UTC') {
  const fake: any = makeCognitivePrisma({ also: ['organization', 'aiInvocation'] });
  fake.organization.__rows.push({ id: ORG, name: 'Org', timezone });
  fake.organization.__rows.push({ id: OTHER, name: 'Other', timezone: otherTimezone });
  const prisma = fake as PrismaClient;
  const repo = new AiUsageLedgerRepository(prisma);
  const service = new DurableAiUsageLedger(prisma);
  return { fake, prisma, repo, service };
}

const reserveInput = (invocationId: string, over: Record<string, unknown> = {}) => ({
  invocationId,
  principalUserId: 'user_1',
  taskId: 'call.summarise',
  taskVersion: '1',
  capabilityRoute: 'GENERAL_REASONING',
  providerId: 'provider-a',
  requestedModelId: 'model-a',
  routingPolicyVersion: 'policy-1',
  templateId: 'tpl.summary',
  templateVersion: '3',
  contextSourceRefs: ['interaction:i_1', 'interaction:i_2'],
  estimatedInputTokens: 1000,
  estimatedOutputTokens: 500,
  estimatedCostMicros: 4200,
  unitCostBasis: 'pricelist-2026-09',
  businessDate: '2026-09-16',
  requestedAt: AT,
  ...over,
});

const BUDGET: AiBudgetPolicy = {
  version: 'budget.test.1',
  classes: {
    standard: {
      maxInputTokensPerCall: 50_000,
      maxOutputTokensPerCall: 4000,
      taskDaily: { maxInvocations: 100, maxInputTokens: 10_000_000, maxOutputTokens: 1_000_000 },
    },
  },
  organizationDaily: { maxInvocations: 100, maxInputTokens: 10_000_000, maxOutputTokens: 1_000_000 },
  globalDaily: { maxInvocations: 1000, maxInputTokens: 100_000_000, maxOutputTokens: 10_000_000 },
};

function capped(invocations: number): AiBudgetPolicy {
  return { ...BUDGET, organizationDaily: { ...BUDGET.organizationDaily, maxInvocations: invocations } };
}

function reservation(callKey: string, over: Partial<AiCallReservation> = {}): AiCallReservation {
  return {
    organizationId: ORG,
    callKey,
    principalUserId: 'user_1',
    taskId: 'case.explanation',
    taskVersion: '1.0.0',
    capabilityRoute: 'TECHNICAL_ANALYSIS',
    target: {
      providerId: 'provider-a',
      modelId: 'model-a',
      reasoningEffort: 'medium',
      timeoutMs: 30_000,
      maxOutputTokens: 2000,
      pricing: { listVersion: 'list.provider-a.2026-09-16', inputMicrosPerToken: 5, outputMicrosPerToken: 25 },
    },
    routingPolicyVersion: 'routing.test.1',
    budgetClass: 'standard',
    templateId: 'case-explanation',
    templateVersion: '2',
    contextSourceRefs: ['decision-evidence:ev_1'],
    estimate: { inputTokens: 3000, outputTokens: 2000 },
    fellBackFrom: null,
    callOrdinal: 1,
    requestedAt: AT,
    ...over,
  };
}

// --- 1. Reserve closes the window ------------------------------------------------

test('ten concurrent attempts do not all read a spend-to-date of zero', async () => {
  const w = world();
  // Each one reserves before it would dispatch, exactly as the runtime must.
  const ids = Array.from({ length: 10 }, (_, i) => `inv_${i}`);
  await Promise.all(ids.map((id) => w.repo.reserve(ORG, reserveInput(id))));

  const spend = await w.repo.spentOn(ORG, '2026-09-16');
  assert.equal(spend.invocations, 10, 'every in-flight attempt is counted');
  assert.equal(spend.inputTokens, 10_000, 'against the reserve, before any provider replied');
  assert.equal(spend.outputTokens, 5_000);
});

test('a retried attempt is one row, not one row per attempt', async () => {
  const w = world();
  assert.equal(await w.repo.reserve(ORG, reserveInput('inv_same')), true, 'the first reserve creates it');
  assert.equal(await w.repo.reserve(ORG, reserveInput('inv_same')), false, 'the retry finds it already reserved');
  assert.equal(await w.repo.reserve(ORG, reserveInput('inv_same')), false);
  assert.equal(w.fake.aiInvocation.__rows.length, 1);
  assert.equal((await w.repo.spentOn(ORG, '2026-09-16')).invocations, 1, 'and the cap is charged once');
});

test('a concurrent double-reserve is settled by the unique index, not by a read-then-write', async () => {
  const w = world();
  const [a, b] = await Promise.all([
    w.repo.reserve(ORG, reserveInput('inv_race')),
    w.repo.reserve(ORG, reserveInput('inv_race')),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1, 'exactly one call created the row');
  assert.equal(w.fake.aiInvocation.__rows.length, 1);
});

// --- 2. Estimate and report stay apart -------------------------------------------

test('reconciling replaces the estimate with the report, and both columns remain readable', async () => {
  const w = world();
  await w.repo.reserve(ORG, reserveInput('inv_1'));
  assert.equal((await w.repo.spentOn(ORG, '2026-09-16')).inputTokens, 1000, 'the reserve is what counts in flight');

  assert.equal(
    await w.repo.reconcile(ORG, {
      invocationId: 'inv_1',
      outcome: 'ANSWERED',
      servedModel: 'model-a-20260901',
      inputTokens: 1234,
      outputTokens: 99,
      completedAt: AT,
      latencyMs: 812,
    }),
    true,
  );
  const row = w.fake.aiInvocation.__rows[0];
  assert.equal(row.outcome, 'ANSWERED');
  assert.equal(row.inputTokens, 1234, 'the report');
  assert.equal(row.estimatedInputTokens, 1000, 'and the estimate, still there');
  assert.equal(row.servedModel, 'model-a-20260901', 'what actually answered, not what was asked for');

  const spend = await w.repo.spentOn(ORG, '2026-09-16');
  assert.equal(spend.inputTokens, 1234, 'report wins over estimate once it exists');
  assert.equal(spend.outputTokens, 99);
});

test('a provider that reported no count leaves NULL, never a zero that reads as free', async () => {
  const w = world();
  await w.repo.reserve(ORG, reserveInput('inv_quiet', { estimatedInputTokens: null, estimatedOutputTokens: null }));
  await w.repo.reconcile(ORG, { invocationId: 'inv_quiet', outcome: 'FAILED', completedAt: AT });
  const row = w.fake.aiInvocation.__rows[0];
  assert.equal(row.inputTokens, null);
  assert.equal(row.outputTokens, null);
  assert.equal(row.estimatedInputTokens, null);
  // It still counts as an attempt: a failure that reached a provider cost something,
  // even where nobody said how much.
  assert.equal((await w.repo.spentOn(ORG, '2026-09-16')).invocations, 1);
});

test('a reconcile for an attempt nobody reserved writes nothing, and never invents a row', async () => {
  const w = world();
  assert.equal(await w.repo.reconcile(ORG, { invocationId: 'inv_ghost', outcome: 'ANSWERED', completedAt: AT }), false);
  assert.equal(w.fake.aiInvocation.__rows.length, 0);
});

// --- 2b. A reconciled failure that reported no usage is not phantom spend ----------
//
// Staging, businessDate 2026-09-21 (America/New_York): telegram.content.triage sent 50 calls that
// REACHED Anthropic and came back 400 INVALID_REQUEST. Each reserved ~1000 output tokens; each
// reconciled FAILED with NULL usage. sumSpend fell back to the reserve for a reconciled row whose
// actual was null, so 50 x 1000 = 50,000 phantom output tokens hit the task's 50,000/day output cap
// and every later triage was refused BUDGET_TASK_EXHAUSTED -- though those 50 calls processed nothing.

test('50 reconciled INVALID_REQUEST failures with no usage cost zero tokens, not their reserve', async () => {
  const w = world();
  for (let i = 0; i < 50; i++) {
    await w.repo.reserve(ORG, reserveInput(`inv_burst_${i}`, { estimatedInputTokens: 500, estimatedOutputTokens: 1000 }));
    await w.repo.reconcile(ORG, { invocationId: `inv_burst_${i}`, outcome: 'FAILED', failureClass: 'INVALID_REQUEST', completedAt: AT });
  }

  const spend = await w.repo.spentOn(ORG, '2026-09-16');
  // The reconciled failures processed nothing: their actual usage is zero, NOT their reserve.
  assert.equal(spend.inputTokens, 0, 'a 400 that never ran processed no input tokens');
  assert.equal(spend.outputTokens, 0, 'nor any output -- this is exactly where the 50,000 phantom was');
  // The COUNT is unchanged on purpose: each was a real provider round-trip, and maxInvocations is the
  // runaway/rate guard that is meant to stop precisely this malformed-request storm.
  assert.equal(spend.invocations, 50, 'every failed round-trip still counts as one invocation');
});

test('an outstanding reservation still holds its estimate while the failures around it count zero', async () => {
  const w = world();
  // The same burst of reconciled-null failures ...
  for (let i = 0; i < 50; i++) {
    await w.repo.reserve(ORG, reserveInput(`inv_done_${i}`, { estimatedInputTokens: 500, estimatedOutputTokens: 1000 }));
    await w.repo.reconcile(ORG, { invocationId: `inv_done_${i}`, outcome: 'FAILED', failureClass: 'INVALID_REQUEST', completedAt: AT });
  }
  // ... plus one call still in flight: reserved, not yet reconciled.
  await w.repo.reserve(ORG, reserveInput('inv_inflight', { estimatedInputTokens: 2000, estimatedOutputTokens: 1500 }));

  const spend = await w.repo.spentOn(ORG, '2026-09-16');
  // Only the outstanding reservation holds capacity; the 50 reconciled failures hold none.
  assert.equal(spend.inputTokens, 2000, 'the in-flight reserve is still counted, conservatively');
  assert.equal(spend.outputTokens, 1500);
  assert.equal(spend.invocations, 51);
});

// --- 3. Every outcome is recorded -------------------------------------------------

test('refused, rejected, failed and cancelled are all recorded, because each is a fact', async () => {
  const w = world();
  const outcomes = ['ANSWERED', 'REFUSED_BY_MODEL', 'REJECTED_BY_LOOP', 'FAILED', 'CANCELLED'] as const;
  for (const [i, outcome] of outcomes.entries()) {
    await w.repo.reserve(ORG, reserveInput(`inv_${i}`));
    await w.repo.reconcile(ORG, {
      invocationId: `inv_${i}`,
      outcome,
      inputTokens: 100,
      outputTokens: 0,
      rejectionCodes: outcome === 'REJECTED_BY_LOOP' ? ['CITATION_MISSING'] : [],
      failureClass: outcome === 'FAILED' ? 'PROVIDER_TIMEOUT' : null,
      completedAt: AT,
    });
  }
  assert.deepEqual(w.fake.aiInvocation.__rows.map((r: any) => r.outcome), [...outcomes]);
  const spend = await w.repo.spentOn(ORG, '2026-09-16');
  assert.equal(spend.invocations, 5, 'a refusal cost input tokens and is charged for them');
  assert.equal(spend.inputTokens, 500);

  const rejected = w.fake.aiInvocation.__rows.find((r: any) => r.outcome === 'REJECTED_BY_LOOP');
  assert.deepEqual(rejected.rejectionCodes, ['CITATION_MISSING'], "which contract rule the answer broke");
  const failed = w.fake.aiInvocation.__rows.find((r: any) => r.outcome === 'FAILED');
  assert.equal(failed.failureClass, 'PROVIDER_TIMEOUT', "Loop's taxonomy, not a provider's prose");
});

// --- 4. Tenancy --------------------------------------------------------------------

test("one organization's spend is never another's, and a reconcile cannot reach across", async () => {
  const w = world();
  await w.repo.reserve(ORG, reserveInput('inv_shared'));
  await w.repo.reserve(OTHER, reserveInput('inv_shared'));
  assert.equal(w.fake.aiInvocation.__rows.length, 2, 'the same invocation id in two tenants is two rows');

  assert.equal((await w.repo.spentOn(ORG, '2026-09-16')).invocations, 1);
  assert.equal((await w.repo.spentOn(OTHER, '2026-09-16')).invocations, 1);

  await w.repo.reconcile(ORG, { invocationId: 'inv_shared', outcome: 'ANSWERED', inputTokens: 7, completedAt: AT });
  const mine = w.fake.aiInvocation.__rows.find((r: any) => r.organizationId === ORG);
  const theirs = w.fake.aiInvocation.__rows.find((r: any) => r.organizationId === OTHER);
  assert.equal(mine.inputTokens, 7);
  assert.equal(theirs.inputTokens, undefined, "the other tenant's row is untouched");
  assert.equal(theirs.outcome, 'IN_FLIGHT');
});

// --- 5. The business day ------------------------------------------------------------

test("the reporting day is the organization's own, and only the budget uses it", async () => {
  // 18:30 UTC on the 16th is still the 16th in New York (14:30) and already the 17th
  // in Auckland (06:30 the next day). Same instant, two reporting days.
  const w = world('America/New_York', 'Pacific/Auckland');
  assert.equal(await w.service.businessDate(ORG, AT), '2026-09-16');
  assert.equal(await w.service.businessDate(OTHER, AT), '2026-09-17');

  assert.equal((await w.service.reserve(reservation('inv_ny'), BUDGET, [ORG, OTHER])).ok, true);
  assert.equal((await w.service.reserve(reservation('inv_nz', { organizationId: OTHER }), BUDGET, [ORG, OTHER])).ok, true);

  assert.equal((await w.service.spend(ORG, 'case.explanation', AT, [])).organization.invocations, 1);
  assert.equal((await w.service.spend(OTHER, 'case.explanation', AT, [])).organization.invocations, 1);
  // Each lands on ITS OWN day, and neither appears on the other's.
  assert.equal((await w.repo.spentOn(ORG, '2026-09-17')).invocations, 0);
  assert.equal((await w.repo.spentOn(OTHER, '2026-09-16')).invocations, 0);

  // The canonical instant is untouched by any of that.
  assert.equal(w.fake.aiInvocation.__rows[0].requestedAt.toISOString(), AT.toISOString());
});

test('an organization with no usable timezone is budgeted on the UTC day rather than not at all', async () => {
  // Failing open would mean no window, no cap and no ceiling on spend. Of the two
  // wrong answers, the one that still enforces a limit wins.
  const w = world('Not/AZone');
  assert.equal(await w.service.businessDate(ORG, AT), '2026-09-16');
  const missing = new DurableAiUsageLedger(w.prisma);
  assert.equal(await missing.businessDate('org_that_does_not_exist', AT), '2026-09-16');
});

// --- 6. The context manifest is a hash, not the evidence -----------------------------

test('the manifest proves two invocations saw the same evidence and reconstructs none of it', () => {
  const a = aiContextManifestHash(['interaction:i_1', 'interaction:i_2']);
  assert.equal(a, aiContextManifestHash(['interaction:i_1', 'interaction:i_2']));
  assert.notEqual(a, aiContextManifestHash(['interaction:i_2', 'interaction:i_1']), 'order is part of the context');
  assert.notEqual(a, aiContextManifestHash(['interaction:i_1']));
  // Concatenation cannot forge a match across a ref boundary.
  assert.notEqual(aiContextManifestHash(['ab', 'c']), aiContextManifestHash(['a', 'bc']));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(a, /interaction/, 'the refs themselves are not recoverable from it');
});

// --- 7. Privacy: nothing a person said reaches this table ----------------------------

test('no prompt, no response and no contact value reaches any column', async () => {
  const w = world();
  await w.repo.reserve(ORG, reserveInput('inv_p', { contextSourceRefs: [`interaction:${SECRET}`] }));
  await w.repo.reconcile(ORG, {
    invocationId: 'inv_p',
    outcome: 'REJECTED_BY_LOOP',
    inputTokens: 10,
    outputTokens: 0,
    completedAt: AT,
  });
  const stored = JSON.stringify(w.fake.aiInvocation.__rows);
  assert.doesNotMatch(stored, /Dana|dana@example\.com|555-0101|invoice/, 'not even inside a source ref');
});

test('the ledger has no column a body could be written to, and no code path writes one', () => {
  const root = join(__dirname, '..', '..', '..');
  const model = readFileSync(join(root, 'packages/database/prisma/schema.prisma'), 'utf8')
    .split('model AiInvocation {')[1]!
    .split('\n}')[0]!;
  for (const forbidden of ['prompt', 'response', 'completion', 'messages', 'output', 'text', 'body', 'content', 'email', 'phone']) {
    assert.doesNotMatch(model, new RegExp(`^\\s*${forbidden}\\b`, 'mi'), `AiInvocation must have no ${forbidden} column`);
  }
  const repo = readFileSync(join(root, 'packages/database/src/repositories/ai-usage-ledger.repository.ts'), 'utf8');
  const service = readFileSync(join(root, 'packages/database/src/services/ai-usage-ledger.service.ts'), 'utf8');
  for (const [name, src] of [['repository', repo], ['service', service]] as const) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
    assert.doesNotMatch(code, /\bprompt\b|\bcompletion\b|responseText|\.messages\b/i, `the ${name} must not touch a body`);
    // It activates nothing: no client, no credential, no request.
    assert.doesNotMatch(code, /anthropic|openai|apiKey|API_KEY|fetch\(|new .*Client\(/i, `the ${name} must construct no provider`);
  }
});

// --- 8. The gateway-facing surface ---------------------------------------------------

// --- 8. The gateway-facing service ----------------------------------------------------

test('a reservation writes the row the budget will count, priced from the versioned list', async () => {
  const w = world();
  assert.deepEqual(await w.service.reserve(reservation('inv_1'), BUDGET, [ORG]), { ok: true });
  const row = w.fake.aiInvocation.__rows[0];
  assert.equal(row.invocationId, 'inv_1');
  assert.equal(row.outcome, 'IN_FLIGHT');
  assert.equal(row.estimatedInputTokens, 3000);
  assert.equal(row.estimatedOutputTokens, 2000);
  assert.equal(row.estimatedCostMicros, 3000 * 5 + 2000 * 25, 'integer micros from the list, never invented');
  assert.equal(row.unitCostBasis, 'list.provider-a.2026-09-16');
  assert.equal(row.routingPolicyVersion, 'routing.test.1');
  assert.equal(row.attemptCount, 1);
  assert.equal(row.fellBackFrom, null);
  assert.equal(row.inputTokens, undefined, 'nothing is reported before the call');

  const spend = await w.service.spend(ORG, 'case.explanation', AT, [ORG]);
  assert.deepEqual(spend.organization, { invocations: 1, inputTokens: 3000, outputTokens: 2000 });
  assert.deepEqual(spend.task, spend.organization);
  assert.deepEqual(spend.global, spend.organization);
});

test('the profile column records the capability route, and a row written before B2 still reads honestly', async () => {
  const w = world();
  assert.deepEqual(await w.service.reserve(reservation('inv_route'), BUDGET, [ORG]), { ok: true });
  const row = w.fake.aiInvocation.__rows[0];
  assert.equal(row.profile, 'TECHNICAL_ANALYSIS', 'one field: the route the task declared');
  assert.equal('capabilityRoute' in row, false, 'no second column beside it');
  assert.deepEqual(aiLedgerCapabilityOf(row.profile), { kind: 'CAPABILITY_ROUTE', route: 'TECHNICAL_ANALYSIS' });
  // A row from before B2 is not quietly mapped onto a route it never recorded.
  assert.deepEqual(aiLedgerCapabilityOf('EXPLANATION'), { kind: 'RETIRED_PROFILE', profile: 'EXPLANATION' });
  assert.deepEqual(aiLedgerCapabilityOf('SUMMARY'), { kind: 'UNRECOGNIZED', stored: 'SUMMARY' });
});

test('a fallback call records what it stands in for, and an unpriced route records no cost', async () => {
  const w = world();
  const unpriced = { ...reservation('x').target, providerId: 'provider-b', modelId: 'model-b', pricing: null };
  await w.service.reserve(reservation('inv_1.2', { target: unpriced, fellBackFrom: 'provider-a/model-a', callOrdinal: 2 }), BUDGET, [ORG]);
  const row = w.fake.aiInvocation.__rows[0];
  assert.equal(row.fellBackFrom, 'provider-a/model-a');
  assert.equal(row.attemptCount, 2);
  assert.equal(row.estimatedCostMicros, null, 'unpriced is unknown, not free');
  assert.equal(row.unitCostBasis, null);
});

test('the reservation refuses what the budget cannot hold, and writes nothing', async () => {
  const w = world();
  assert.equal((await w.service.reserve(reservation('a'), capped(1), [ORG])).ok, true);
  const second = await w.service.reserve(reservation('b'), capped(1), [ORG]);
  assert.deepEqual(second, { ok: false, refusals: ['BUDGET_ORGANIZATION_EXHAUSTED'] });
  assert.equal(w.fake.aiInvocation.__rows.length, 1);
});

test('twenty concurrent reservations against a cap of five: exactly five rows', async () => {
  const w = world();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => w.service.reserve(reservation(`inv_${i}`), capped(5), [ORG])));
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.equal(w.fake.aiInvocation.__rows.length, 5);
});

test('a duplicate call key is refused, and a unique-index race is reported the same way', async () => {
  const w = world();
  assert.equal((await w.service.reserve(reservation('same'), BUDGET, [ORG])).ok, true);
  assert.deepEqual(await w.service.reserve(reservation('same'), BUDGET, [ORG]), { ok: false, refusals: ['DUPLICATE_INVOCATION'] });

  // The database, not the pre-check, settles two instances inserting the same key at once.
  const racing = {
    organization: { findFirst: async () => ({ timezone: 'UTC' }) },
    $transaction: async () => {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    },
  } as unknown as PrismaClient;
  assert.deepEqual(await new DurableAiUsageLedger(racing).reserve(reservation('k'), BUDGET, [ORG]), { ok: false, refusals: ['DUPLICATE_INVOCATION'] });
});

test('a reservation that loses a serialization race is retried, and refused if it keeps losing', async () => {
  const w = world();
  let failures = 2;
  const flaky = new Proxy(w.prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return async (fn: never, options: never) => {
          if (failures > 0) {
            failures -= 1;
            throw Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { code: 'P2034' });
          }
          return (target as any).$transaction(fn, options);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as PrismaClient;
  assert.deepEqual(await new DurableAiUsageLedger(flaky).reserve(reservation('r1'), BUDGET, [ORG]), { ok: true }, 'third attempt wins');

  failures = 99;
  assert.deepEqual(
    await new DurableAiUsageLedger(flaky, { maxReservationAttempts: 3 }).reserve(reservation('r2'), BUDGET, [ORG]),
    { ok: false, refusals: ['RESERVATION_CONTENDED'] },
    'under contention the answer is "not now", never "try forever"',
  );

  // Anything else is not a race, and is not swallowed.
  const broken = { ...w.prisma, organization: w.prisma.organization, $transaction: async () => { throw new Error('connection refused'); } } as unknown as PrismaClient;
  await assert.rejects(new DurableAiUsageLedger(broken).reserve(reservation('r3'), BUDGET, [ORG]), /connection refused/);
});

test('serialization failures are recognised by code, not by guesswork', () => {
  assert.equal(isSerializationFailure({ code: 'P2034' }), true);
  assert.equal(isSerializationFailure({ meta: { code: '40001' } }), true);
  assert.equal(isSerializationFailure({ message: 'ERROR: could not serialize access due to read/write dependencies' }), true);
  assert.equal(isSerializationFailure({ code: 'P2002' }), false);
  assert.equal(isSerializationFailure(new Error('timeout')), false);
  assert.equal(isSerializationFailure(null), false);
});

test('reconcile replaces the estimate with the report, a reconciled failure counts zero, and only an outstanding call still reserves', async () => {
  const w = world();
  await w.service.reserve(reservation('ok'), BUDGET, [ORG]);
  await w.service.reserve(reservation('failed'), BUDGET, [ORG]);
  // A third call is reserved and never reconciled: genuinely outstanding, so its estimate must hold.
  await w.service.reserve(reservation('inflight'), BUDGET, [ORG]);
  assert.equal(
    await w.service.reconcile(ORG, {
      callKey: 'ok',
      outcome: 'ANSWERED',
      servedModel: 'model-a-1',
      providerRequestId: 'req_1',
      usage: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 800, reasoningTokens: 120 },
      unitCostBasis: 'list.provider-a.2026-09-16',
      failureClass: null,
      rejectionCodes: [],
      completedAt: AT,
      latencyMs: 900,
    }),
    true,
  );
  await w.service.reconcile(ORG, {
    callKey: 'failed',
    outcome: 'FAILED',
    servedModel: null,
    providerRequestId: null,
    usage: null,
    unitCostBasis: 'list.provider-a.2026-09-16',
    failureClass: 'TIMEOUT',
    rejectionCodes: [],
    completedAt: AT,
    latencyMs: 30_000,
  });
  const [ok, failed] = w.fake.aiInvocation.__rows;
  assert.equal(ok.fellBackFrom, null);
  assert.deepEqual([ok.inputTokens, ok.outputTokens, ok.cachedInputTokens, ok.reasoningTokens], [1200, 300, 800, 120]);
  assert.equal(failed.inputTokens, null);
  assert.equal(failed.failureClass, 'TIMEOUT');
  const spend = await w.service.spend(ORG, 'case.explanation', AT, [ORG]);
  // 1200 reported by 'ok' + 0 for 'failed' (reconciled, but the provider reported no usage, so it
  // processed nothing) + 3000 still reserved for 'inflight' (never reconciled, so its estimate holds).
  // The reconciled failure counting zero rather than its 3000 reserve is the phantom-spend fix.
  assert.equal(spend.organization.inputTokens, 4200);
  assert.equal(spend.organization.outputTokens, 2300, '300 reported + 0 for the reconciled failure + 2000 still reserved in flight');
  assert.equal(await w.service.reconcile(OTHER, { callKey: 'ok', outcome: 'FAILED', servedModel: null, providerRequestId: null, usage: null, unitCostBasis: null, failureClass: null, rejectionCodes: [], completedAt: AT, latencyMs: null }), false, 'another tenant cannot reconcile it');
});

test('reconciling a fallback call keeps the record that it was one', async () => {
  const w = world();
  await w.service.reserve(reservation('inv.2', { fellBackFrom: 'provider-a/model-a', callOrdinal: 2 }), BUDGET, [ORG]);
  await w.service.reconcile(ORG, { callKey: 'inv.2', outcome: 'ANSWERED', servedModel: 'm', providerRequestId: null, usage: { inputTokens: 1, outputTokens: 1 }, unitCostBasis: null, failureClass: null, rejectionCodes: [], completedAt: AT, latencyMs: 1 });
  assert.equal(w.fake.aiInvocation.__rows[0].fellBackFrom, 'provider-a/model-a');
});

test('the global window covers every enabled organization over the trailing day, and nothing older', async () => {
  const w = world();
  await w.service.reserve(reservation('mine'), BUDGET, [ORG, OTHER]);
  await w.service.reserve(reservation('theirs', { organizationId: OTHER }), BUDGET, [ORG, OTHER]);
  await w.service.reserve(reservation('old', { requestedAt: new Date(AT.getTime() - 25 * 3600 * 1000) }), BUDGET, [ORG, OTHER]);
  const spend = await w.service.spend(ORG, 'case.explanation', AT, [ORG, OTHER]);
  assert.equal(spend.global.invocations, 2, 'mine and theirs; the 25-hour-old row has left the window');
  const notEnabled = await w.service.spend(ORG, 'case.explanation', AT, []);
  assert.equal(notEnabled.global.invocations, 1, 'only organizations the runtime is enabled for are summed');
});

test('the row carries raw usage and the price list to value it with, never a bare dollar amount', async () => {
  const w = world();
  await w.repo.reserve(ORG, reserveInput('inv_cost'));
  await w.repo.reconcile(ORG, {
    invocationId: 'inv_cost',
    outcome: 'ANSWERED',
    inputTokens: 1000,
    outputTokens: 250,
    cachedInputTokens: 800,
    reasoningTokens: 40,
    unitCostBasis: 'pricelist-2026-10',
    completedAt: AT,
  });
  const row = w.fake.aiInvocation.__rows[0];
  // Everything needed to recompute the cost from a corrected price list.
  assert.equal(row.inputTokens, 1000);
  assert.equal(row.outputTokens, 250);
  assert.equal(row.cachedInputTokens, 800, 'cached input is priced differently and must be separable');
  assert.equal(row.reasoningTokens, 40);
  assert.equal(row.unitCostBasis, 'pricelist-2026-10', 'which price list values these tokens');
  // And the reserve estimate is kept apart from it, never mistaken for the cost.
  assert.equal(row.estimatedCostMicros, 4200);
});

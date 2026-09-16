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
import { DurableAiUsageLedger } from '../src/services/ai-usage-ledger.service';

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
  const service = new DurableAiUsageLedger(prisma, { now: () => AT });
  return { fake, prisma, repo, service };
}

const reserveInput = (invocationId: string, over: Record<string, unknown> = {}) => ({
  invocationId,
  principalUserId: 'user_1',
  taskId: 'call.summarise',
  taskVersion: '1',
  profile: 'SUMMARY',
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
  assert.equal(await w.service.businessDate(ORG), '2026-09-16');
  assert.equal(await w.service.businessDate(OTHER), '2026-09-17');

  await w.service.reserve(ORG, reserveInput('inv_ny') as any);
  await w.service.reserve(OTHER, reserveInput('inv_nz') as any);

  assert.equal((await w.service.spentToday(ORG)).invocations, 1);
  assert.equal((await w.service.spentToday(OTHER)).invocations, 1);
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
  assert.equal(await w.service.businessDate(ORG), '2026-09-16');
  const missing = new DurableAiUsageLedger(w.prisma, { now: () => AT });
  assert.equal(await missing.businessDate('org_that_does_not_exist'), '2026-09-16');
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

test('record reconciles the reserved row rather than adding a second one', async () => {
  const w = world();
  await w.service.reserve(ORG, reserveInput('inv_rec') as any);
  await w.service.record({
    invocationId: 'inv_rec',
    organizationId: ORG,
    taskId: 'call.summarise',
    taskVersion: '1',
    templateId: 'tpl.summary',
    templateVersion: '3',
    requestedModel: { providerId: 'provider-a', modelId: 'model-a', profile: 'SUMMARY' } as any,
    servedModel: 'model-a-20260901',
    providerRequestId: 'req_1',
    viewerUserId: 'user_1',
    contextSourceRefs: ['interaction:i_1'],
    usage: { inputTokens: 55, outputTokens: 12 },
    latencyMs: 400,
    outcome: 'ANSWERED',
    recordedAt: AT.toISOString(),
  });
  assert.equal(w.fake.aiInvocation.__rows.length, 1, 'one attempt, one row');
  assert.equal(w.fake.aiInvocation.__rows[0].inputTokens, 55);
  assert.equal(w.fake.aiInvocation.__rows[0].estimatedInputTokens, 1000, 'the reserve is still visible');
});

test('record without a prior reserve still lands the row, and marks the estimate absent rather than zero', async () => {
  const w = world();
  await w.service.record({
    invocationId: 'inv_late',
    organizationId: ORG,
    taskId: 'call.summarise',
    taskVersion: '1',
    templateId: 'tpl.summary',
    templateVersion: '3',
    requestedModel: { providerId: 'provider-a', modelId: 'model-a', profile: 'SUMMARY' } as any,
    servedModel: null,
    providerRequestId: null,
    viewerUserId: 'user_1',
    contextSourceRefs: ['interaction:i_1'],
    usage: { inputTokens: 7, outputTokens: 3 },
    latencyMs: 250,
    outcome: 'FAILED',
    recordedAt: AT.toISOString(),
  });
  const row = w.fake.aiInvocation.__rows[0];
  assert.equal(row.outcome, 'FAILED');
  assert.equal(row.inputTokens, 7);
  assert.equal(row.estimatedInputTokens, null, 'no reserve was made, so there is no estimate');
  assert.equal(row.estimatedCostMicros, null);
  // requestedAt is derived backwards from the recorded instant and the latency, so
  // the row still sits on the day the work started.
  assert.equal(row.requestedAt.toISOString(), new Date(AT.getTime() - 250).toISOString());
});

// --- 9. Cost stays reproducible -------------------------------------------------------

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

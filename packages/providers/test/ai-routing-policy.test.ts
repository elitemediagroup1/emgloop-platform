// The verified model catalog and the reviewed routing and budget policies. Slice AI-4.
//
// WHAT THESE PROVE
//
// EVERY MODEL IS ONE A PROVIDER DOCUMENTS, PINNED, WITH ITS SOURCE. No entry lacks an
// official URL or a verification date, and no route names a model the catalog does
// not hold.
//
// THE POLICY IS COHERENT WITH ITSELF, THE BUDGET AND THE PLATFORM. Output ceilings sit
// inside the model's limit and the budget class; the primary and fallback deadlines
// fit inside Netlify's 60-second synchronous limit with room to spare; fallback goes
// to a different provider.
//
// A MODEL ID APPEARS IN ONE PLACE. Anywhere else in the source it would be a second,
// unreviewed routing decision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AI_PROVIDER_IDS, AI_REASONING_EFFORTS, AI_TASK_CASE_EXPLANATION, admitAiInvocation, AI_NO_SPEND } from '@emgloop/shared';

import { AI_MODEL_CATALOG, aiCatalogCapabilities, aiCatalogModel } from '../src/ai/policy/model-catalog';
import {
  AI_BUDGET_POLICY,
  AI_MAX_ATTEMPTS_PER_TARGET,
  AI_PLATFORM_REQUEST_LIMIT_MS,
  AI_ROUTING_POLICY,
} from '../src/ai/policy/routing-policy';

const REPO = join(__dirname, '..', '..', '..');

test('every catalog model is documented, pinned, sourced and dated', () => {
  assert.ok(AI_MODEL_CATALOG.length >= 2);
  for (const m of AI_MODEL_CATALOG) {
    assert.ok((AI_PROVIDER_IDS as readonly string[]).includes(m.providerId), m.modelId);
    assert.equal(m.pinned, true);
    assert.match(m.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(m.sources.length >= 2, `${m.modelId} cites its sources`);
    for (const url of m.sources) {
      assert.match(url, /^https:\/\/(platform\.claude\.com|privacy\.claude\.com|developers\.openai\.com)\//, `${url} is an official source`);
    }
    assert.ok(Number.isInteger(m.pricing.inputMicrosPerToken) && m.pricing.inputMicrosPerToken > 0);
    assert.ok(Number.isInteger(m.pricing.outputMicrosPerToken) && m.pricing.outputMicrosPerToken > 0);
    assert.match(m.pricing.listVersion, new RegExp(`^${m.providerId}-api-pricing-${m.verifiedOn}$`), 'the price list names its provider and its day');
    // An alias is a model that can change without a pull request.
    assert.doesNotMatch(m.modelId, /latest|preview|^gpt-\d+(\.\d+)?$/, `${m.modelId} is not an alias`);
  }
});

test('the verified choices, as recorded on 2026-09-16', () => {
  assert.deepEqual(
    AI_MODEL_CATALOG.map((m) => [m.providerId, m.modelId, m.pricing.inputMicrosPerToken, m.pricing.outputMicrosPerToken]),
    [
      ['anthropic', 'claude-opus-5', 5, 25],
      ['openai', 'gpt-6-astra', 10, 50],
    ],
  );
});

test('data handling is never read off documentation as a commitment', () => {
  for (const m of AI_MODEL_CATALOG) {
    assert.equal(aiCatalogCapabilities(m.providerId, m.modelId).dataHandling, 'UNCONFIRMED', 'gate G2 is a contract, not a web page');
    assert.equal(aiCatalogCapabilities(m.providerId, m.modelId).tools, false);
  }
  const unknown = aiCatalogCapabilities('anthropic', 'model-nobody-verified');
  assert.equal(unknown.structuredOutput, 'NONE');
  assert.equal(unknown.maxOutputTokens, 0);
});

test('every route names a catalog model, within its limits, the budget and the platform', () => {
  assert.match(AI_ROUTING_POLICY.version, /^routing\.\d{4}-\d{2}-\d{2}\.\d+$/);
  for (const [taskId, route] of Object.entries(AI_ROUTING_POLICY.tasks)) {
    assert.equal(route.taskId, taskId);
    const budgetClass = AI_BUDGET_POLICY.classes[route.budgetClass];
    assert.ok(budgetClass, `${taskId} names a budget class that exists`);
    const targets = [route.primary, ...(route.fallback ? [route.fallback] : [])];
    for (const t of targets) {
      const model = aiCatalogModel(t.providerId, t.modelId);
      assert.ok(model, `${t.providerId}/${t.modelId} is in the verified catalog`);
      assert.deepEqual(t.pricing, model!.pricing, 'priced from the catalog, not restated');
      assert.ok((AI_REASONING_EFFORTS as readonly string[]).includes(t.reasoningEffort));
      assert.ok(model!.reasoningEfforts.includes(t.reasoningEffort), `${t.modelId} supports ${t.reasoningEffort}`);
      assert.ok(t.maxOutputTokens <= model!.maxOutputTokens);
      assert.ok(t.maxOutputTokens <= budgetClass!.maxOutputTokensPerCall, 'a route the budget would refuse is not a route');
      assert.ok(t.timeoutMs > 0);
    }
    if (route.fallback) {
      assert.notEqual(route.fallback.providerId, route.primary.providerId, 'fallback is for a provider being unavailable');
    }
    // Every call a route can make, back to back, fits inside the platform limit with
    // at least ten seconds left for reads, reservations and reconciliation.
    const worstCase = targets.reduce((ms, t) => ms + t.timeoutMs * AI_MAX_ATTEMPTS_PER_TARGET, 0);
    assert.ok(worstCase + 10_000 <= AI_PLATFORM_REQUEST_LIMIT_MS, `${taskId}: ${worstCase}ms of calls in a ${AI_PLATFORM_REQUEST_LIMIT_MS}ms request`);
  }
  assert.equal(AI_PLATFORM_REQUEST_LIMIT_MS, 60_000);
  assert.equal(AI_MAX_ATTEMPTS_PER_TARGET, 1);
});

test('Case Explanation: Opus 5 primary, GPT-6 Astra fallback, fallback permitted, reviewed against its task version', () => {
  const route = AI_ROUTING_POLICY.tasks['case.explanation']!;
  assert.deepEqual([route.primary.providerId, route.primary.modelId], ['anthropic', 'claude-opus-5']);
  assert.deepEqual([route.fallback?.providerId, route.fallback?.modelId], ['openai', 'gpt-6-astra']);
  assert.equal(route.fallbackPermitted, true);
  assert.equal(route.taskVersion, AI_TASK_CASE_EXPLANATION.version, 'the policy was reviewed against the task as it is');
});

test('the budget bounds the worst case, and the policy admits a real request', () => {
  const cls = AI_BUDGET_POLICY.classes['case-explanation']!;
  const dearest = Math.max(...AI_MODEL_CATALOG.map((m) => m.pricing.outputMicrosPerToken));
  const dearestIn = Math.max(...AI_MODEL_CATALOG.map((m) => m.pricing.inputMicrosPerToken));
  const perCallMicros = cls.maxInputTokensPerCall * dearestIn + cls.maxOutputTokensPerCall * dearest;
  assert.ok(perCallMicros <= 1_000_000, `worst call ${perCallMicros / 1e6} USD`);
  const perDayMicros = AI_BUDGET_POLICY.globalDaily.maxInvocations * perCallMicros;
  assert.ok(perDayMicros <= 50_000_000, `worst day ${perDayMicros / 1e6} USD across every organization`);
  assert.ok(cls.taskDaily.maxInvocations <= AI_BUDGET_POLICY.organizationDaily.maxInvocations);
  assert.ok(AI_BUDGET_POLICY.organizationDaily.maxInvocations <= AI_BUDGET_POLICY.globalDaily.maxInvocations);
  assert.match(AI_BUDGET_POLICY.version, /proposed/, 'labelled a proposal until approved');

  const admitted = admitAiInvocation({
    taskId: 'case.explanation',
    taskVersion: AI_TASK_CASE_EXPLANATION.version,
    organizationId: 'org_a',
    authorized: true,
    activation: { enabled: true, organizations: ['org_a'], tasks: ['case.explanation'], providers: ['anthropic', 'openai'] },
    policy: AI_ROUTING_POLICY,
    killSwitches: [],
    budget: AI_BUDGET_POLICY,
    spend: { organization: AI_NO_SPEND, task: AI_NO_SPEND, global: AI_NO_SPEND },
    estimatedInputTokens: 12_000,
    registeredProviders: ['anthropic', 'openai'],
    contextRefusals: [],
    tools: [],
  });
  assert.equal(admitted.ok, true, 'a policy that could never admit anything would be a quiet way to switch AI off');
});

test('the policies are frozen', () => {
  assert.ok(Object.isFrozen(AI_ROUTING_POLICY));
  assert.ok(Object.isFrozen(AI_ROUTING_POLICY.tasks['case.explanation']));
  assert.ok(Object.isFrozen(AI_ROUTING_POLICY.tasks['case.explanation']!.primary));
  assert.ok(Object.isFrozen(AI_BUDGET_POLICY.classes['case-explanation']));
  assert.ok(Object.isFrozen(AI_MODEL_CATALOG[0]!.pricing));
});

test('a model id is written in the catalog and nowhere else', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (['node_modules', '.next', 'dist'].includes(f)) continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f)) files.push(p);
    }
  };
  for (const root of ['packages/shared/src', 'packages/database/src', 'packages/providers/src', 'packages/brain/src', 'apps/web/src']) walk(join(REPO, root));
  const ids = AI_MODEL_CATALOG.map((m) => m.modelId);
  const offenders = files
    .filter((f) => !f.endsWith(join('ai', 'policy', 'model-catalog.ts')))
    .filter((f) => ids.some((id) => readFileSync(f, 'utf8').includes(`'${id}'`)))
    .map((f) => f.slice(REPO.length + 1));
  assert.deepEqual(offenders.filter((f) => !f.endsWith(join('ai', 'policy', 'routing-policy.ts'))), [], 'only the catalog and the routing policy name a model');
});

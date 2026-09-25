// The worker's AI runtime assembly and activation gate G2 (2026-09-24).
//
// G2 used to be LOOP_AI_PROVIDER_TERMS_CONFIRMED, which the connections stack set automatically for
// every provider it listed -- so listing implied approval. These tests pin that the worker no longer
// reads it at all, that the environment decides only which clients may be CONSTRUCTED, and that the
// gateway is handed the recorded provider policies from the worker's own database. What admission
// does with a missing, KILLED or too-low policy is proven against the gateway and the triage service
// in packages/database/test/ai-provider-policy.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PrismaClient } from '@prisma/client';
import { AI_ROUTING_POLICY } from '@emgloop/providers';

import { assertWorkerProvidersVerified, createWorkerAiRuntime, workerListedProviders, workerTriageRunnable } from '../src/ai-runtime';
import { fatalLogFields, NotConfigured } from '../src/config';

const SOURCE = readFileSync(join(__dirname, '..', 'src', 'ai-runtime.ts'), 'utf8');
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

test('LOOP_AI_PROVIDER_TERMS_CONFIRMED alone admits nothing: the listing floor is LOOP_AI_PROVIDERS only', () => {
  assert.deepEqual(workerListedProviders({ LOOP_AI_PROVIDER_TERMS_CONFIRMED: 'anthropic,openai' }), [], 'terms "confirmed" in the environment constructs nothing');
  assert.deepEqual(workerListedProviders({ LOOP_AI_PROVIDERS: 'anthropic' }), ['anthropic'], 'listing is the credential floor, and no more');
  assert.deepEqual(workerListedProviders({ LOOP_AI_PROVIDERS: 'anthropic, openai ,bad value' }), ['anthropic', 'openai'], 'an unreadable entry is dropped, never guessed at');
});

test('the worker never reads the old terms variable, in any spelling', () => {
  assert.doesNotMatch(CODE, /TERMS_CONFIRMED/);
  assert.doesNotMatch(CODE, /termsConfirmed|confirmed\.includes/);
});

test('the gateway is given the recorded provider policies from the worker\'s own database', () => {
  // PR 1: ONE cached reader over this worker's own database serves every recorded control the gateway
  // admits against -- provider policies, stored KILLED switches and the operating budget.
  assert.match(CODE, /const controls = aiRuntimeControlsReader\(prisma\)/);
  assert.match(CODE, /providerPolicies: controls\.providerPolicies/);
  assert.match(CODE, /storedKillSwitches: controls\.storedKillSwitches/);
  assert.match(CODE, /operatingBudget: controls\.operatingBudget/);
  assert.match(CODE, /import \{[^}]*aiRuntimeControlsReader[^}]*\} from '@emgloop\/database'/);
});

test('PR 1: only the history and hydration sweeps move their calls to BACKGROUND; live triage is called exactly as before', () => {
  const index = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const port = (name: string) => {
    const start = index.indexOf(`const ${name}: `);
    assert.ok(start > -1, name);
    return index.slice(start, index.indexOf('\n  };', start));
  };
  assert.match(port('contentPorts'), /triage: \(principal, input\) => aiRuntime\.service\.triage\(principal, input\),/, 'live triage: unchanged');
  assert.match(port('historicalContentPorts'), /triage: \(principal, input\) => aiRuntime\.service\.triage\(principal, \{ \.\.\.input, lane: 'BACKGROUND' \}\),/);
  assert.match(port('hydrationPorts'), /triage: \(principal, input\) => aiRuntime\.service\.triage\(principal, \{ \.\.\.input, lane: 'BACKGROUND' \}\),/);
  assert.equal((index.match(/lane: 'BACKGROUND'/g) ?? []).length, 2, 'nothing else claims a lane');
});

// --- PR 1 review fix 1: `enabled` means telegram.content.triage itself can run ---------------------------

/** Constructing the runtime reads nothing: every repository and reader is built lazily over this. */
const NO_DB = {} as PrismaClient;
const ON = { LOOP_AI_ENABLED: 'true', LOOP_AI_ORGANIZATIONS: 'org_a', LOOP_AI_PROVIDERS: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key' };

test('triage runs only when it is ACTIVATED and a configured provider is a candidate on its own route', () => {
  const activation = (patch: Partial<{ enabled: boolean; tasks: string[]; providers: string[] }> = {}) => ({
    enabled: true,
    organizations: ['org_a'],
    tasks: ['telegram.content.triage'],
    providers: ['anthropic'],
    ...patch,
  });
  assert.equal(workerTriageRunnable(activation()), true);
  assert.equal(workerTriageRunnable(activation({ enabled: false })), false, 'the runtime is off');
  assert.equal(workerTriageRunnable(activation({ tasks: ['case.explanation'] })), false, 'triage is not activated');
  assert.equal(workerTriageRunnable(activation({ tasks: [] })), false);
  assert.equal(workerTriageRunnable(activation({ providers: [] })), false, 'no configured provider');
  assert.equal(workerTriageRunnable(activation({ providers: ['some-other-provider'] })), false, 'a provider that is not on the triage route');
  // A provider on the route counts, whether it is the primary or the permitted fallback.
  assert.equal(workerTriageRunnable(activation({ providers: ['openai'] })), true, 'openai is the route fallback (refused at startup instead, below)');
  const noFallback = { ...AI_ROUTING_POLICY, tasks: { ...AI_ROUTING_POLICY.tasks, 'telegram.content.triage': { ...AI_ROUTING_POLICY.tasks['telegram.content.triage']!, fallbackPermitted: false } } };
  assert.equal(workerTriageRunnable(activation({ providers: ['openai'] }), noFallback), false, 'a fallback the route does not permit is not a candidate');
});

test('REGRESSION: with telegram.content.triage absent from LOOP_AI_TASKS the runtime is NOT enabled -- whatever else is on', () => {
  assert.equal(createWorkerAiRuntime(NO_DB, { env: { ...ON, LOOP_AI_TASKS: 'telegram.content.triage' } }).enabled, true, 'the control: triage activated');
  assert.equal(createWorkerAiRuntime(NO_DB, { env: { ...ON, LOOP_AI_TASKS: 'case.explanation' } }).enabled, false, 'AI and a provider on, triage absent');
  assert.equal(createWorkerAiRuntime(NO_DB, { env: { ...ON, LOOP_AI_TASKS: '' } }).enabled, false, 'no task at all');
  assert.equal(createWorkerAiRuntime(NO_DB, { env: { ...ON } }).enabled, false, 'LOOP_AI_TASKS unset');
  assert.equal(createWorkerAiRuntime(NO_DB, { env: { ...ON, LOOP_AI_TASKS: 'telegram.content.triage', ANTHROPIC_API_KEY: '' } }).enabled, false, 'no credential');
  assert.equal(createWorkerAiRuntime(NO_DB, { env: { ...ON, LOOP_AI_TASKS: 'telegram.content.triage', LOOP_AI_ENABLED: 'TRUE' } }).enabled, false, 'not exactly "true"');
});

test('REGRESSION: the forward, historical and hydration sweeps -- the only readers of Telegram bodies for AI triage -- start only when triage is enabled', () => {
  const index = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  // Each sweep is invoked exactly once, inside its own wrapper.
  for (const sweep of ['runContentSweep(contentPorts)', 'runHistoricalContentSweep(historicalContentPorts)', 'runChatsHydrationSweep(hydrationPorts)']) {
    assert.equal(index.split(sweep).length - 1, 1, sweep);
  }
  // Every call of a wrapper is behind `aiRuntime.enabled`: the three timers and the three first runs.
  for (const wrapper of ['content', 'historicalContent', 'hydration']) {
    const calls = [...index.matchAll(new RegExp(`[^\\w.]${wrapper}\\(\\)`, 'g'))]
      .map((m) => index.slice(Math.max(0, m.index! - 120), m.index! + 20))
      .filter((site) => !new RegExp(`function ${wrapper}\\(\\)`).test(site));
    assert.equal(calls.length, 2, `${wrapper}() is called from its timer and its first run only`);
    for (const site of calls) assert.match(site, /aiRuntime\.enabled/, `${wrapper}() is gated: ${site}`);
  }
  assert.match(index, /const aiRuntime = createWorkerAiRuntime\(prisma\);/);
});

// --- Chats v5: the PR 1 triage-v4 provider guard is retired with the v4 schema ---------------------------

test('Chats v5: listing openai beside telegram.content.triage no longer refuses startup (schema v5 is portable); the guard stays data-driven', () => {
  // The listing alone never commissions a provider: the recorded provider policy and a key still decide.
  assert.doesNotThrow(() => createWorkerAiRuntime(NO_DB, { env: { ...ON, LOOP_AI_PROVIDERS: 'anthropic,openai', OPENAI_API_KEY: 'sk-test', LOOP_AI_TASKS: 'telegram.content.triage' } }));
  assert.doesNotThrow(() => createWorkerAiRuntime(NO_DB, { env: { ...ON, LOOP_AI_PROVIDERS: 'anthropic,openai', LOOP_AI_TASKS: 'telegram.content.triage' } }));
  assert.doesNotThrow(() => assertWorkerProvidersVerified(['anthropic', 'openai'], ['telegram.content.triage']));
  assert.doesNotThrow(() => assertWorkerProvidersVerified(['anthropic', 'openai'], ['not.a.task']), 'an unknown task names no schema');
});

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

import { workerListedProviders } from '../src/ai-runtime';

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

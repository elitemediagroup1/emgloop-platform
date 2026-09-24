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
  assert.match(CODE, /providerPolicies: aiProviderPolicyReader\(prisma\)/);
  assert.match(CODE, /import \{[^}]*aiProviderPolicyReader[^}]*\} from '@emgloop\/database'/);
});

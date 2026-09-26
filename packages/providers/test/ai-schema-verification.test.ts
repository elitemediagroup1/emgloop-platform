// PR 1 review fix: an exempt output schema is served only by the providers it was verified against.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_PORTABLE_SCHEMA_EXEMPTIONS } from '@emgloop/shared';

import { AI_ROUTING_POLICY, AI_SCHEMA_VERIFIED_PROVIDERS, aiSchemaUnverifiedProviders } from '../src';

test('an exempt schema and its verified-provider list exist together or not at all -- and since Chats v5 neither exists', () => {
  assert.deepEqual(Object.keys(AI_SCHEMA_VERIFIED_PROVIDERS).sort(), Object.keys(AI_PORTABLE_SCHEMA_EXEMPTIONS).sort(), 'no exemption without a verified-provider list, nor the reverse');
  assert.deepEqual(Object.keys(AI_PORTABLE_SCHEMA_EXEMPTIONS), [], 'triage v5 is portable: no exemption remains');
  assert.deepEqual(aiSchemaUnverifiedProviders('telegram-content-triage.v5', ['anthropic', 'openai']), [], 'no provider is ineligible for triage v5');
  assert.deepEqual(aiSchemaUnverifiedProviders('telegram-content-triage.v4', ['anthropic', 'openai']), [], 'the retired schema restricts nobody -- it is sent by nothing');
  // Production triage stays primary-anthropic; OpenAI is the policy's fallback, commissioned by nothing here.
  assert.equal(AI_ROUTING_POLICY.tasks['telegram.content.triage']!.primary.providerId, 'anthropic');
  assert.equal(AI_ROUTING_POLICY.tasks['telegram.content.triage']!.taskVersion, '4.0.0');
});

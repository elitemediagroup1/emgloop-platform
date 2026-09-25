// PR 1 review fix: an exempt output schema is served only by the providers it was verified against.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_PORTABLE_SCHEMA_EXEMPTIONS } from '@emgloop/shared';

import { AI_ROUTING_POLICY, AI_SCHEMA_VERIFIED_PROVIDERS, aiSchemaUnverifiedProviders } from '../src';

test('every exempt schema names the providers it WAS verified against, and only those may serve it (triage v4: anthropic)', () => {
  assert.deepEqual(Object.keys(AI_SCHEMA_VERIFIED_PROVIDERS).sort(), Object.keys(AI_PORTABLE_SCHEMA_EXEMPTIONS).sort(), 'no exemption without a verified-provider list');
  assert.deepEqual([...AI_SCHEMA_VERIFIED_PROVIDERS['telegram-content-triage.v4']!], ['anthropic']);
  assert.deepEqual(aiSchemaUnverifiedProviders('telegram-content-triage.v4', ['anthropic', 'openai']), ['openai']);
  assert.deepEqual(aiSchemaUnverifiedProviders('telegram-content-triage.v4', ['anthropic']), []);
  assert.deepEqual(aiSchemaUnverifiedProviders('mail-reply-draft.v2', ['anthropic', 'openai']), [], 'a portable schema restricts nobody');
  // The verified provider is the triage route's primary: the guard never refuses the production path.
  assert.equal(AI_ROUTING_POLICY.tasks['telegram.content.triage']!.primary.providerId, 'anthropic');
});

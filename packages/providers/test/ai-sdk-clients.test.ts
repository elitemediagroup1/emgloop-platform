// The provider client factory. Slice AI-2.
//
// NO KEY IN THIS FILE IS A KEY. The placeholders below are obviously not credentials
// and could not authenticate anywhere -- and they never have to, because every
// client here is built with a fetch that FAILS THE TEST if it is ever called.
// Building a client must make no request, and these tests are how that is known.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import {
  AI_MINIMUM_NODE_MAJOR,
  AI_SDK_BACKSTOP_TIMEOUT_MS,
  ANTHROPIC_API_BASE_URL,
  OPENAI_API_BASE_URL,
  createAnthropicProvider,
  createOpenAiProvider,
  nodeMajor,
} from '../src/ai/adapters/sdk-clients';

const PLACEHOLDER = 'placeholder-not-a-credential';
let requests = 0;
const refusingFetch = (async () => {
  requests += 1;
  throw new Error('a request was made');
}) as unknown as typeof fetch;

/** Builds both providers and returns the SDK clients the factory constructed. */
function build(nodeVersion = '22.0.0', apiKey = PLACEHOLDER) {
  const clients: Record<string, unknown>[] = [];
  const a = createAnthropicProvider({ apiKey, fetch: refusingFetch, nodeVersion, onClientBuilt: (c) => clients.push(c) });
  const o = createOpenAiProvider({ apiKey, fetch: refusingFetch, nodeVersion, onClientBuilt: (c) => clients.push(c) });
  return { a, o, ac: clients[0]!, oc: clients[1]! };
}

test('building either client makes no request', () => {
  requests = 0;
  const a = createAnthropicProvider({ apiKey: PLACEHOLDER, fetch: refusingFetch, nodeVersion: '22.11.0' });
  const o = createOpenAiProvider({ apiKey: PLACEHOLDER, fetch: refusingFetch, nodeVersion: '22.11.0' });
  assert.equal(a.state, 'CONFIGURED');
  assert.equal(o.state, 'CONFIGURED');
  assert.equal(requests, 0);
});

test('a missing or blank credential is PROVIDER_NOT_CONFIGURED, and builds nothing', () => {
  for (const apiKey of [undefined, null, '', '   ']) {
    const a = createAnthropicProvider({ apiKey, fetch: refusingFetch });
    const o = createOpenAiProvider({ apiKey, fetch: refusingFetch });
    assert.deepEqual(a, { providerId: 'anthropic', state: 'PROVIDER_NOT_CONFIGURED' });
    assert.deepEqual(o, { providerId: 'openai', state: 'PROVIDER_NOT_CONFIGURED' });
  }
});

test('a Node version the SDKs do not support is RUNTIME_UNSUPPORTED, not a client', () => {
  assert.equal(AI_MINIMUM_NODE_MAJOR, 22);
  for (const nodeVersion of ['20.19.4', '18.20.0', 'garbage']) {
    assert.equal(createAnthropicProvider({ apiKey: PLACEHOLDER, nodeVersion }).state, 'RUNTIME_UNSUPPORTED', nodeVersion);
    assert.equal(createOpenAiProvider({ apiKey: PLACEHOLDER, nodeVersion }).state, 'RUNTIME_UNSUPPORTED', nodeVersion);
  }
  assert.equal(createOpenAiProvider({ apiKey: PLACEHOLDER, nodeVersion: '24.1.0', fetch: refusingFetch }).state, 'CONFIGURED');
  assert.equal(nodeMajor('22.3.1'), 22);
  assert.equal(nodeMajor(''), 0);
});

test('the environment cannot redirect, re-authenticate, or make either client talk', () => {
  const hostile: Record<string, string> = {
    ANTHROPIC_BASE_URL: 'https://attacker.example',
    ANTHROPIC_AUTH_TOKEN: 'hostile-token',
    ANTHROPIC_LOG: 'debug',
    OPENAI_BASE_URL: 'https://attacker.example/v1',
    OPENAI_ORG_ID: 'org-hostile',
    OPENAI_PROJECT_ID: 'proj-hostile',
    OPENAI_LOG: 'debug',
  };
  const saved = Object.fromEntries(Object.keys(hostile).map((k) => [k, process.env[k]]));
  Object.assign(process.env, hostile);
  try {
    const { a, o, ac, oc } = build();
    assert.equal(a.state, 'CONFIGURED');
    assert.equal(o.state, 'CONFIGURED');
    assert.equal(ac.baseURL, ANTHROPIC_API_BASE_URL);
    assert.equal(ac.authToken, null, 'no token from the environment');
    assert.equal(ac.logLevel, 'off', 'debug logging would print request bodies');
    assert.equal(oc.baseURL, OPENAI_API_BASE_URL);
    assert.equal(oc.organization, null);
    assert.equal(oc.project, null);
    assert.equal(oc.logLevel, 'off');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('Loop owns retries and deadlines; the SDKs only hold a backstop', () => {
  const { ac, oc } = build();
  for (const c of [ac, oc]) {
    assert.equal(c.maxRetries, 0, 'a retry is a reserved call; the SDK may not make one on its own');
    assert.equal(c.timeout, AI_SDK_BACKSTOP_TIMEOUT_MS);
  }
  assert.ok(AI_SDK_BACKSTOP_TIMEOUT_MS >= 60_000, 'above any route deadline');
});

test('the credential is trimmed on its way in, and no serialization of the result carries it', () => {
  const { a, o, ac } = build('22.0.0', `  ${PLACEHOLDER}\n`);
  assert.equal(ac.apiKey, PLACEHOLDER);
  for (const result of [a, o]) {
    assert.equal(result.state, 'CONFIGURED');
    // A log line, a serialized prop, an error report, a console.log of the whole thing.
    for (const rendered of [
      JSON.stringify(result),
      JSON.stringify({ nested: { result } }),
      inspect(result, { depth: 20, showHidden: true }),
      String(result.state === 'CONFIGURED' ? result.provider : ''),
    ]) {
      assert.doesNotMatch(rendered, /placeholder-not-a-credential/, rendered);
    }
    if (result.state === 'CONFIGURED') {
      assert.deepEqual(JSON.parse(JSON.stringify(result.provider)), { providerId: result.providerId });
      assert.equal(typeof result.provider.invoke, 'function');
      assert.ok(Object.isFrozen(result.provider));
    }
  }
});

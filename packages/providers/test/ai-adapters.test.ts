// The Anthropic and OpenAI adapters. Slice B5 -- NOT ACTIVATED.
//
// NO MODEL IS CALLED HERE, AND NONE CAN BE. Each adapter takes an injected client;
// the tests supply an object with the SDK's shape that records what it was handed
// and returns a recorded response. No credential exists, no socket opens, and the
// adapters themselves read no environment variable -- a runtime that can build its
// own client can make a call nobody authorized.
//
// WHAT THESE PROVE
//
// THE TWO ARE EQUALS. Same interface, same failure taxonomy, same result shape. The
// one real difference -- Anthropic reaches structured output through a forced tool,
// OpenAI declares a JSON schema natively -- lives inside the adapters and nowhere
// else. That difference existing in exactly one place is the reason adapters exist.
//
// AN ADAPTER MAPS; IT DOES NOT DECIDE. Every provider error becomes one of Loop's
// classes. Not one of them decides to retry: `providerFailurePolicy` does, above.
//
// PROVENANCE SURVIVES. What the provider says actually served the request comes back
// separately from what was asked for, because they are not always the same.
//
// AND NOTHING WRITES. No tool is published to either provider.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AiModelCapabilities, AiModelRequest } from '@emgloop/shared';

import { AnthropicAdapter, type AnthropicMessagesClient } from '../src/ai/adapters/anthropic.adapter';
import { OpenAiAdapter, type OpenAiResponsesClient } from '../src/ai/adapters/openai.adapter';
import { classifyProviderError, retryAfterMs } from '../src/ai/adapters/failure-mapping';
import { ModelProviderError } from '../src/ai/model-provider';

const CAPABILITIES = (modelId: string): AiModelCapabilities => ({
  providerId: 'test',
  modelId,
  structuredOutput: 'NATIVE_JSON_SCHEMA',
  tools: false,
  streaming: false,
  contextWindowTokens: 100_000,
  maxOutputTokens: 4096,
  promptCaching: false,
  // Until a contract says otherwise. Nothing above may send sensitive data to it.
  dataHandling: 'UNCONFIRMED',
  region: null,
});

const ANSWER = { schemaId: 'case-explanation.v1', summary: 'Revenue fell.', claims: [], limitations: [] };

function request(patch: Partial<AiModelRequest> = {}): AiModelRequest {
  return {
    invocationId: 'inv_1',
    model: { providerId: 'p', modelId: 'model-x' },
    instructions: 'Explain, citing only what is supplied.',
    input: [
      { blockId: 'b1', kind: 'STRUCTURED', trust: 'GOVERNED_FACT', sourceRef: 'operational-observation:obs_1', content: 'revenue down 4200 cents' },
      { blockId: 'b2', kind: 'TEXT', trust: 'HUMAN_REPORTED', sourceRef: 'crm-note:n_1', content: 'the operator thinks it was seasonal' },
    ],
    tools: [],
    output: { kind: 'JSON_SCHEMA', schemaId: 'case-explanation.v1', schema: { type: 'object' }, strict: true },
    limits: { maxOutputTokens: 1200, timeoutMs: 30_000 },
    ...patch,
  };
}

function anthropic(response: unknown, throws?: unknown) {
  const sent: Record<string, unknown>[] = [];
  const client: AnthropicMessagesClient = {
    messages: {
      async create(body) {
        sent.push(body);
        if (throws) throw throws;
        return response as never;
      },
    },
  };
  return { adapter: new AnthropicAdapter({ client, capabilities: CAPABILITIES, now: () => 1000 }), sent };
}

function openai(response: unknown, throws?: unknown) {
  const sent: Record<string, unknown>[] = [];
  const client: OpenAiResponsesClient = {
    responses: {
      async create(body) {
        sent.push(body);
        if (throws) throw throws;
        return response as never;
      },
    },
  };
  return { adapter: new OpenAiAdapter({ client, capabilities: CAPABILITIES, now: () => 1000 }), sent };
}

// --- 1. Both reach the same result from different provider shapes -----------------------

test('Anthropic returns structured output through a forced tool, and nothing that writes', async () => {
  const { adapter, sent } = anthropic({
    id: 'req_a',
    model: 'model-x-20260101',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'loop_structured_answer', input: ANSWER }],
    usage: { input_tokens: 900, output_tokens: 210, cache_read_input_tokens: 100 },
  });
  const result = await adapter.invoke(request(), new AbortController().signal);

  assert.deepEqual(result.output.json, ANSWER);
  assert.equal(result.stopReason, 'END');
  assert.deepEqual(result.usage, { inputTokens: 900, outputTokens: 210, cachedInputTokens: 100 });
  assert.equal(result.providerRequestId, 'req_a');
  assert.equal(result.reportedModel, 'model-x-20260101', 'what served it, not what was asked for');

  const body = sent[0]!;
  assert.equal(body.model, 'model-x');
  assert.equal(body.max_tokens, 1200);
  // Exactly one tool, and it is a SHAPE: the schema the answer must take.
  const tools = body.tools as { name: string; input_schema: unknown }[];
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, 'loop_structured_answer');
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'loop_structured_answer' });
});

test('OpenAI returns structured output through a declared schema', async () => {
  const { adapter, sent } = openai({
    id: 'req_o',
    model: 'model-x-2026',
    status: 'completed',
    output_text: JSON.stringify(ANSWER),
    usage: { input_tokens: 800, output_tokens: 190, input_tokens_details: { cached_tokens: 50 } },
  });
  const result = await adapter.invoke(request(), new AbortController().signal);

  assert.deepEqual(result.output.json, ANSWER);
  assert.equal(result.stopReason, 'END');
  assert.deepEqual(result.usage, { inputTokens: 800, outputTokens: 190, cachedInputTokens: 50 });
  assert.equal(result.reportedModel, 'model-x-2026');

  const format = (sent[0]!.text as { format: { type: string; strict: boolean; schema: unknown } }).format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.strict, true);
  assert.equal(sent[0]!.tools, undefined, 'no tool is published to either provider');
});

test('both send every block with its trust level and its source, and no credential', async () => {
  for (const make of [anthropic, openai] as const) {
    const { adapter, sent } = make({ id: 'x', status: 'completed', output_text: '{}', content: [], stop_reason: 'end_turn' });
    await adapter.invoke(request(), new AbortController().signal);
    const serialized = JSON.stringify(sent[0]);
    assert.match(serialized, /GOVERNED_FACT/, 'a governed fact says so');
    assert.match(serialized, /HUMAN_REPORTED/, 'and a human-reported line says so too');
    assert.match(serialized, /operational-observation:obs_1/, 'each block names where it came from');
    assert.doesNotMatch(serialized, /api[_-]?key|authorization|bearer/i, 'no credential is in the request body');
  }
});

// --- 2. Stop reasons and refusals ---------------------------------------------------------

test('a refusal, a filter and a truncation are reported as themselves, not as answers', async () => {
  const refusedA = await anthropic({ id: 'a', stop_reason: 'refusal', content: [{ type: 'text', text: 'I cannot help with that.' }] })
    .adapter.invoke(request(), new AbortController().signal);
  assert.equal(refusedA.stopReason, 'REFUSAL');

  const truncatedA = await anthropic({ id: 'a', stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] })
    .adapter.invoke(request(), new AbortController().signal);
  assert.equal(truncatedA.stopReason, 'MAX_TOKENS');

  // A refusal that ALSO carries something parseable. The parseable part must not be
  // shown: a model that declines and then emits a well-formed object has still
  // declined, and treating the object as an answer would launder the refusal.
  const refusedO = await openai({
    id: 'o', status: 'completed',
    output_text: JSON.stringify(ANSWER),
    output: [{ content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }],
  }).adapter.invoke(request(), new AbortController().signal);
  assert.equal(refusedO.stopReason, 'REFUSAL');
  assert.equal(refusedO.output.json, undefined, 'a refusal is never parsed as an answer');
  assert.equal(refusedO.output.text, JSON.stringify(ANSWER), 'the body is kept for the record, unparsed');

  const filteredO = await openai({ id: 'o', status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output_text: '' })
    .adapter.invoke(request(), new AbortController().signal);
  assert.equal(filteredO.stopReason, 'CONTENT_FILTERED');

  const truncatedO = await openai({ id: 'o', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"a":1}' })
    .adapter.invoke(request(), new AbortController().signal);
  assert.equal(truncatedO.stopReason, 'MAX_TOKENS');
});

test('a body that is not the shape asked for yields nothing, not half an answer', async () => {
  const result = await openai({ id: 'o', status: 'completed', output_text: 'Revenue fell, I think.' })
    .adapter.invoke(request(), new AbortController().signal);
  assert.equal(result.output.json, undefined);
});

// --- 3. Failures map into Loop's taxonomy, and decide nothing -------------------------------

test('every provider error becomes one of Loop\'s classes', () => {
  const cases: [unknown, string][] = [
    [{ status: 401 }, 'AUTH'],
    [{ status: 403 }, 'AUTH'],
    [{ name: 'AuthenticationError' }, 'AUTH'],
    [{ status: 429 }, 'RATE_LIMITED'],
    [{ name: 'RateLimitError' }, 'RATE_LIMITED'],
    [{ status: 408 }, 'TIMEOUT'],
    [{ name: 'APIConnectionTimeoutError' }, 'TIMEOUT'],
    [{ status: 400, message: 'prompt is too long: 250000 tokens > maximum' }, 'CONTEXT_TOO_LARGE'],
    [{ status: 400, message: 'unknown parameter' }, 'INVALID_REQUEST'],
    [{ status: 404 }, 'INVALID_REQUEST'],
    [{ status: 500 }, 'UNAVAILABLE'],
    [{ status: 503 }, 'UNAVAILABLE'],
    // Something nobody classified is treated as transient-unknown, which the runtime
    // retries a bounded number of times. It is never silently ignored.
    [new Error('socket hang up'), 'UNAVAILABLE'],
    [null, 'UNAVAILABLE'],
  ];
  for (const [err, expected] of cases) {
    assert.equal(classifyProviderError(err), expected, JSON.stringify(err));
  }
});

test('a retry-after is reported when the provider gave one, and never invented', () => {
  assert.equal(retryAfterMs({ headers: { 'retry-after': '2' } }), 2000);
  assert.equal(retryAfterMs({ headers: { get: (n: string) => (n === 'retry-after' ? '5' : null) } }), 5000);
  assert.equal(retryAfterMs({ headers: {} }), null);
  assert.equal(retryAfterMs({}), null);
  assert.equal(retryAfterMs({ headers: { 'retry-after': 'soon' } }), null);
});

test('both adapters raise a mapped error, and neither decides what to do about it', async () => {
  for (const make of [anthropic, openai] as const) {
    const { adapter } = make(null, Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '3' } }));
    await assert.rejects(
      () => adapter.invoke(request(), new AbortController().signal),
      (err: unknown) => {
        assert.ok(err instanceof ModelProviderError);
        assert.equal((err as ModelProviderError).failure, 'RATE_LIMITED');
        assert.equal((err as ModelProviderError).retryAfterMs, 3000);
        return true;
      },
    );
  }
});

test('an aborted call is CANCELLED, not a provider failure', async () => {
  for (const make of [anthropic, openai] as const) {
    const controller = new AbortController();
    controller.abort();
    const { adapter } = make(null, new Error('aborted'));
    await assert.rejects(
      () => adapter.invoke(request(), controller.signal),
      (err: unknown) => (err as ModelProviderError).failure === 'CANCELLED',
    );
  }
});

// --- 4. Fences ------------------------------------------------------------------------------

test('fence: the adapters read no credential, build no client and call no URL', () => {
  const dir = join(__dirname, '..', 'src', 'ai', 'adapters');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const src = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /process\.env|API_KEY|apiKey/i, `${file} must read no credential`);
    assert.doesNotMatch(src, /new Anthropic|new OpenAI|https?:\/\//, `${file} must build no client and name no host`);
    assert.doesNotMatch(src, /'(claude|gpt)-[\w.-]+'/i, `${file} must hard-code no model id`);
  }
});

test('fence: the two adapters stay symmetric', () => {
  const dir = join(__dirname, '..', 'src', 'ai', 'adapters');
  const a = readFileSync(join(dir, 'anthropic.adapter.ts'), 'utf8');
  const o = readFileSync(join(dir, 'openai.adapter.ts'), 'utf8');
  for (const [name, src] of [['anthropic', a], ['openai', o]] as const) {
    assert.match(src, /implements ModelProvider/, `${name} implements the one interface`);
    assert.match(src, /classifyProviderError/, `${name} maps failures the one way`);
    assert.match(src, /reportedModel:/, `${name} reports what actually served the request`);
    assert.match(src, /readonly client:/, `${name} takes an injected client`);
    // Neither publishes a tool that could act.
    assert.doesNotMatch(src, /writes:\s*true/, `${name} publishes no writing tool`);
  }
});

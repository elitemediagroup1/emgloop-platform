// The Loop AI runtime gateway, driven by recorded fixtures. Slice B5.
//
// NO MODEL IS CALLED HERE, and none can be: the only provider implementation that
// exists replays what somebody recorded. That is the point -- routing, fallback,
// refusal handling, output validation, budgets, kill switches and provenance are all
// exercised end to end with no credential, no network and no bill, and they stay
// exercisable after S1 as the evaluation harness.
//
// WHAT THESE PROVE
//
// AN ANSWER IS CHECKED BEFORE ANYBODY SEES IT. A model that invents a citation,
// states a number the evidence does not contain, scores its own confidence or tells
// the reader what to do has its answer REFUSED WHOLE -- and the provenance still
// records that it happened.
//
// A REFUSAL IS AN OUTCOME, NOT A RETRY. When a model declines, Loop stops. Asking
// the next provider until one agrees would make the fallback list a way to launder a
// refusal into an answer.
//
// EVERY OUTCOME IS RECORDED. Answered, rejected, refused, failed: each leaves a
// provenance row naming who asked, what was sent, which model served it and what
// came back. An answer nobody can trace is a rumour with a timestamp.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AI_TASK_CASE_EXPLANATION, type AiContextPackage, type AiModelResult } from '@emgloop/shared';

import {
  AiRuntimeGateway,
  InMemoryAiUsageLedger,
  type AiProviderPort,
  type AiRunRequest,
} from '../src/services/ai-runtime/gateway';
import {
  CASE_EXPLANATION_SCHEMA,
  CASE_EXPLANATION_TEMPLATE_ID,
  CASE_EXPLANATION_TEMPLATE_VERSION,
  renderCaseExplanationInstructions,
} from '../src/services/ai-runtime/templates/case-explanation';

const ORG = 'org_a';
const REF = 'operational-observation:obs_1';
const NOW = new Date('2026-09-16T12:00:00.000Z');

function context(): AiContextPackage {
  return {
    organizationId: ORG,
    viewerUserId: 'user_1',
    taskId: 'case.explanation',
    sensitivityCeiling: 'OPERATIONAL',
    items: [
      {
        blockId: `${ORG}::block_1`,
        kind: 'STRUCTURED',
        trust: 'GOVERNED_FACT',
        sourceRef: REF,
        content: 'situation detected; revenue down 4200 cents over the period',
        sensitivity: 'OPERATIONAL',
        readUnder: { resource: 'commercialIntelligence', action: 'view' },
      },
    ],
  };
}

function answer(patch: Record<string, unknown> = {}): AiModelResult {
  return {
    output: {
      json: {
        schemaId: 'case-explanation.v1',
        summary: 'Revenue fell over the observed period.',
        claims: [{ statement: 'Revenue fell by 4200 cents.', citations: [REF], figures: [{ label: 'revenueCents', value: 4200 }] }],
        limitations: ['Nothing after the observed period was supplied.'],
        ...patch,
      },
    },
    toolCalls: [],
    stopReason: 'END',
    usage: { inputTokens: 900, outputTokens: 210 },
    providerRequestId: 'req_1',
    reportedModel: 'model-a-20260101',
    latencyMs: 800,
  };
}

/** A provider that replays one recorded outcome and counts how often it was asked. */
function fixture(providerId: string, outcome: AiModelResult | { failure: string }): AiProviderPort & { calls: number } {
  const port = {
    providerId,
    calls: 0,
    async invoke(): Promise<AiModelResult> {
      port.calls += 1;
      if ('failure' in outcome) throw Object.assign(new Error(outcome.failure), { failure: outcome.failure });
      return outcome;
    },
  };
  return port;
}

function gateway(providers: AiProviderPort[], patch: Record<string, unknown> = {}) {
  const ledger = new InMemoryAiUsageLedger();
  const runtime = new AiRuntimeGateway(
    {
      policy: { routes: { EXPLANATION: [{ providerId: 'p1', modelId: 'model-a' }, { providerId: 'p2', modelId: 'model-b' }] } },
      budget: { maxInvocationsPerDay: 50, maxInputTokensPerDay: 1_000_000, maxOutputTokensPerDay: 100_000, maxOutputTokensPerInvocation: 2000 },
      killSwitches: [],
      activated: true,
      maxAttemptsPerTarget: 2,
      ...patch,
    },
    { providers, ledger, now: () => NOW, newInvocationId: () => 'inv_1' },
  );
  return { runtime, ledger };
}

function request(patch: Partial<AiRunRequest> = {}): AiRunRequest {
  const pkg = patch.context ?? context();
  return {
    task: AI_TASK_CASE_EXPLANATION,
    context: pkg,
    instructions: renderCaseExplanationInstructions(pkg.items.map((i) => i.sourceRef)),
    templateId: CASE_EXPLANATION_TEMPLATE_ID,
    templateVersion: CASE_EXPLANATION_TEMPLATE_VERSION,
    schema: CASE_EXPLANATION_SCHEMA,
    supportedFigures: new Set([4200]),
    ...patch,
  };
}

// --- 1. The happy path, and what it records -------------------------------------------

test('a valid answer is returned, and everything about it is recorded', async () => {
  const p1 = fixture('p1', answer());
  const { runtime, ledger } = gateway([p1]);
  const result = await runtime.run(request());

  assert.equal(result.outcome, 'ANSWERED');
  if (result.outcome !== 'ANSWERED') return;
  assert.equal(result.output.claims[0]!.citations[0], REF);

  const p = result.provenance;
  assert.equal(p.organizationId, ORG);
  assert.equal(p.viewerUserId, 'user_1', 'whose authority assembled the context');
  assert.deepEqual(p.contextSourceRefs, [REF]);
  assert.deepEqual(p.requestedModel, { providerId: 'p1', modelId: 'model-a' });
  assert.equal(p.servedModel, 'model-a-20260101', 'what actually answered, not what was asked for');
  assert.equal(p.templateVersion, '1', 'the instruction that produced this is identifiable');
  assert.deepEqual(p.usage, { inputTokens: 900, outputTokens: 210 });
  assert.equal(p.outcome, 'ANSWERED');
  assert.equal(ledger.provenance.length, 1);
  assert.deepEqual(await ledger.spentToday(ORG), { invocations: 1, inputTokens: 900, outputTokens: 210 });
});

// --- 2. The answer is checked ------------------------------------------------------------

test('an answer that breaks its contract is refused whole, and the attempt is still recorded', async () => {
  for (const [name, patch, expected] of [
    ['an invented citation', { claims: [{ statement: 'See the report.', citations: ['report:invented'], figures: [] }] }, 'CITATION_NOT_SUPPLIED'],
    ['an uncited claim', { claims: [{ statement: 'Things got worse.', citations: [], figures: [] }] }, 'UNCITED_CLAIM'],
    ['a number the evidence does not contain', { claims: [{ statement: 'Revenue fell by 9900 cents.', citations: [REF], figures: [{ label: 'x', value: 9900 }] }] }, 'FIGURE_NOT_SUPPORTED'],
    ['a self-scored confidence', { summary: 'I am 85% confident revenue fell.' }, 'NUMERIC_CONFIDENCE_PRESENT'],
    ['a recommendation', { summary: 'You should pause the campaign.' }, 'RECOMMENDS_AN_ACTION'],
  ] as const) {
    const { runtime, ledger } = gateway([fixture('p1', answer(patch as Record<string, unknown>))]);
    const result = await runtime.run(request());
    assert.equal(result.outcome, 'REJECTED_OUTPUT', name);
    if (result.outcome === 'REJECTED_OUTPUT') {
      assert.ok(result.rejections.includes(expected as never), `${name}: ${result.rejections.join(',')}`);
      assert.equal(result.provenance.outcome, 'REJECTED_BY_LOOP', `${name} is recorded`);
    }
    assert.equal(ledger.provenance.length, 1, `${name}: the attempt cost something and is counted`);
  }
});

test('a body that is not the shape asked for is not half an answer', async () => {
  for (const output of [{ text: 'Revenue fell, I think.' }, { text: '{"not":"the schema"}' }, { json: null }]) {
    const { runtime } = gateway([fixture('p1', { ...answer(), output } as AiModelResult)]);
    const result = await runtime.run(request());
    assert.equal(result.outcome, 'REJECTED_OUTPUT', JSON.stringify(output));
  }
});

// --- 3. Routing, retry, fallback and refusal ---------------------------------------------

test('a transient failure retries, then falls back to the next provider', async () => {
  const p1 = fixture('p1', { failure: 'UNAVAILABLE' });
  const p2 = fixture('p2', answer());
  const { runtime } = gateway([p1, p2]);
  const result = await runtime.run(request());

  assert.equal(result.outcome, 'ANSWERED');
  assert.equal(p1.calls, 2, 'retried within its own target, bounded by maxAttemptsPerTarget');
  assert.equal(p2.calls, 1, 'then the fallback served it');
  if (result.outcome === 'ANSWERED') assert.equal(result.provenance.requestedModel.providerId, 'p2');
});

test('a refusal stops: Loop does not ask another provider until one agrees', async () => {
  const p1 = fixture('p1', { ...answer(), stopReason: 'REFUSAL' } as AiModelResult);
  const p2 = fixture('p2', answer());
  const { runtime, ledger } = gateway([p1, p2]);
  const result = await runtime.run(request());

  assert.equal(result.outcome, 'REFUSED_BY_MODEL');
  assert.equal(p2.calls, 0, 'the fallback was never asked');
  assert.equal(ledger.provenance[0]!.outcome, 'REFUSED_BY_MODEL', 'the refusal is a recorded fact');
});

test('a failure nobody may fall back from stops at the first provider', async () => {
  const p1 = fixture('p1', { failure: 'AUTH' });
  const p2 = fixture('p2', answer());
  const { runtime } = gateway([p1, p2]);
  const result = await runtime.run(request());
  assert.equal(result.outcome, 'FAILED');
  if (result.outcome === 'FAILED') assert.equal(result.failure, 'AUTH');
  assert.equal(p1.calls, 1, 'a bad credential is not retried');
  assert.equal(p2.calls, 0, 'and not routed around');
});

test('routing is policy: the same task reaches a different provider by configuration alone', async () => {
  const p1 = fixture('p1', answer());
  const p2 = fixture('p2', answer());
  const { runtime } = gateway([p1, p2], {
    policy: { routes: { EXPLANATION: [{ providerId: 'p2', modelId: 'model-b' }, { providerId: 'p1', modelId: 'model-a' }] } },
  });
  const result = await runtime.run(request());
  assert.equal(result.outcome, 'ANSWERED');
  assert.equal(p2.calls, 1);
  assert.equal(p1.calls, 0);
});

// --- 4. Nothing is sent that should not be ------------------------------------------------

test('the runtime is off until somebody turns it on, and no provider is touched', async () => {
  const p1 = fixture('p1', answer());
  const { runtime, ledger } = gateway([p1], { activated: false });
  const result = await runtime.run(request());
  assert.equal(result.outcome, 'REFUSED_BY_LOOP');
  if (result.outcome === 'REFUSED_BY_LOOP') assert.ok(result.refusals.includes('NOT_ACTIVATED'));
  assert.equal(p1.calls, 0, 'nothing was sent');
  assert.equal(ledger.provenance.length, 0);
});

test('a kill switch, an exhausted budget and a refused context each stop it before dispatch', async () => {
  const cases: [string, Record<string, unknown>, Partial<AiRunRequest>][] = [
    ['global kill switch', { killSwitches: [{ scope: 'GLOBAL' }] }, {}],
    ['task kill switch', { killSwitches: [{ scope: 'TASK', value: 'case.explanation' }] }, {}],
    ['organization kill switch', { killSwitches: [{ scope: 'ORGANIZATION', value: ORG }] }, {}],
    ['exhausted budget', { budget: { maxInvocationsPerDay: 0, maxInputTokensPerDay: 1, maxOutputTokensPerDay: 1, maxOutputTokensPerInvocation: 2000 } }, {}],
  ];
  for (const [name, config, req] of cases) {
    const p1 = fixture('p1', answer());
    const { runtime } = gateway([p1], config);
    const result = await runtime.run(request(req));
    assert.equal(result.outcome, 'REFUSED_BY_LOOP', name);
    assert.equal(p1.calls, 0, `${name}: nothing was sent`);
  }

  // A context above the task's ceiling is refused, not trimmed.
  const p1 = fixture('p1', answer());
  const { runtime } = gateway([p1]);
  const overCeiling = context();
  const result = await runtime.run(
    request({ context: { ...overCeiling, items: [{ ...overCeiling.items[0]!, sensitivity: 'COMMUNICATION_CONTENT' }] } }),
  );
  assert.equal(result.outcome, 'REFUSED_BY_LOOP');
  assert.equal(p1.calls, 0, 'the content never left the process');
});

test('an unregistered provider means no call, not a guess', async () => {
  const { runtime } = gateway([]);
  const result = await runtime.run(request());
  assert.equal(result.outcome, 'REFUSED_BY_LOOP');
  if (result.outcome === 'REFUSED_BY_LOOP') assert.ok(result.refusals.includes('PROVIDER_NOT_REGISTERED'));
});

// --- 5. The instruction --------------------------------------------------------------------

test('the template states the rules the answer will be judged by, and names the allowed citations', () => {
  const instructions = renderCaseExplanationInstructions([REF, 'decision-evidence:ev_2']);
  assert.match(instructions, /only the evidence supplied/i);
  assert.match(instructions, new RegExp(REF));
  assert.match(instructions, /decision-evidence:ev_2/);
  assert.match(instructions, /confidence, probability, likelihood/i);
  assert.match(instructions, /Do not recommend an action/i);
  assert.match(instructions, /honest gap is the correct answer/i);
  // The template is versioned, and the version rides in provenance.
  assert.equal(CASE_EXPLANATION_TEMPLATE_VERSION, '1');
});

// --- 6. Fences -------------------------------------------------------------------------------

test('fence: the runtime imports no SDK, reads no credential and calls nothing itself', () => {
  const dir = join(__dirname, '..', 'src', 'services', 'ai-runtime');
  const files = [
    ...readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f)),
    ...readdirSync(join(dir, 'templates')).map((f) => join(dir, 'templates', f)),
  ];
  assert.ok(files.length >= 2);
  for (const file of files) {
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /from ['"](@anthropic-ai|openai)/, `${file} must import no SDK`);
    assert.doesNotMatch(src, /API_KEY|process\.env|Authorization|Bearer/i, `${file} must read no credential`);
    assert.doesNotMatch(src, /fetch\(|https?:\/\/|XMLHttpRequest/, `${file} must call nothing itself`);
    assert.doesNotMatch(src, /'(claude|gpt)-[\w.-]+'/i, `${file} must hard-code no model`);
    // The gateway writes no domain data: it records provenance through a ledger.
    assert.doesNotMatch(src, /prisma\.|\.create\(\{|\.update\(\{/, `${file} must write no domain row`);
  }
});

test('fence: the gateway mints no time and no ids of its own', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'services', 'ai-runtime', 'gateway.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /Date\.now\(\)|new Date\(\)|randomUUID|Math\.random/);
  assert.match(src, /this\.deps\.now\(\)/);
  assert.match(src, /this\.deps\.newInvocationId\(\)/);
});

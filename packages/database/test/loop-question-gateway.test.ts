import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_TASK_LOOP_QUESTION, BRIEFING_SCHEMA, type AiModelResult } from '@emgloop/shared';
import {
  RecordedModelProvider,
  AI_ROUTING_POLICY,
  AI_BUDGET_POLICY,
  aiCatalogCapabilities,
} from '@emgloop/providers';
import { AiRuntimeGateway, InMemoryAiUsageLedger } from '../src/services/ai-runtime/gateway';

const principal = { organizationId: 'our-org', userId: 'our-user' };
const context = {
  ...principal,
  viewerUserId: principal.userId,
  taskId: AI_TASK_LOOP_QUESTION.taskId,
  sensitivityCeiling: 'COMMUNICATION_CONTENT' as const,
  items: [
    {
      blockId: 'our-org::evidence',
      sourceRef: 'snapshot:callgrid',
      content: '{"revenue":100}',
      kind: 'STRUCTURED' as const,
      trust: 'UNTRUSTED_INPUT' as const,
      sensitivity: 'COMMUNICATION_CONTENT' as const,
      readUnder: { resource: 'employeeIntelligence', action: 'view' as const },
    },
  ],
};
async function run(options: { invalid?: boolean; approved?: boolean } = {}) {
  const output: AiModelResult = {
    output: {
      json: {
        schemaId: 'loop-briefing.v1',
        headline: 'Stored revenue',
        lines: [
          {
            kind: 'CHANGED',
            statement: `Stored revenue is $${options.invalid ? 999 : 100}.`,
            citations: ['snapshot:callgrid'],
          },
        ],
        limitations: [],
      },
    },
    toolCalls: [],
    stopReason: 'END',
    usage: { inputTokens: 500, outputTokens: 100 },
    latencyMs: 50,
    reportedModel: 'gpt-6-astra',
    providerRequestId: 'recorded-test',
  };
  const openai = new RecordedModelProvider(
    'openai',
    [{ modelId: 'gpt-6-astra', result: output }],
    (id) => aiCatalogCapabilities('openai', id),
  );
  const ledger = new InMemoryAiUsageLedger();
  const gateway = new AiRuntimeGateway(
    {
      activation: {
        enabled: true,
        organizations: [principal.organizationId],
        tasks: [AI_TASK_LOOP_QUESTION.taskId],
        providers: ['openai'],
      },
      policy: AI_ROUTING_POLICY,
      budget: AI_BUDGET_POLICY,
      killSwitches: [],
      maxAttemptsPerTarget: 1,
    },
    {
      providers: [openai],
      ledger,
      authorize: async () => true,
      now: () => new Date('2026-10-15T16:00:00Z'),
      newInvocationId: () => 'invocation-question',
      providerPolicies: async () =>
        options.approved === false
          ? []
          : [
              {
                providerId: 'openai',
                state: 'ACTIVE',
                ceiling: 'COMMUNICATION_CONTENT',
                version: 1,
                recordedAtMs: 0,
              },
            ],
    },
  );
  const result = await gateway.run(principal, {
    task: AI_TASK_LOOP_QUESTION,
    context,
    instructions: 'Answer from supplied sources.',
    templateId: 'loop-question',
    templateVersion: '1',
    schema: BRIEFING_SCHEMA as unknown as Record<string, unknown>,
    evidence: { figures: new Map([['snapshot:callgrid', new Set([100])]]), dates: new Set() },
  });
  return { result, ledger };
}
test('the real governed gateway serves the new question task through OpenAI in the interactive lane', async () => {
  const { result, ledger } = await run();
  assert.equal(result.outcome, 'ANSWERED');
  assert.equal(ledger.calls.length, 1);
  assert.equal(ledger.calls[0]!.lane, 'INTERACTIVE');
});
test('unsupported figures are rejected instead of shown as business facts', async () => {
  const { result } = await run({ invalid: true });
  assert.equal(result.outcome, 'REJECTED_OUTPUT');
  if (result.outcome === 'REJECTED_OUTPUT')
    assert.ok(result.rejections.includes('UNSUPPORTED_NUMBER_IN_TEXT'));
});
test('an API key and provider registration cannot bypass the recorded communication-content policy', async () => {
  const { result, ledger } = await run({ approved: false });
  assert.equal(result.outcome, 'REFUSED_BY_LOOP');
  assert.equal(ledger.calls.length, 0);
});

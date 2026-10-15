import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LoopQuestionService,
  questionWindow,
} from '../src/services/ai-runtime/loop-question.service';
import { callQuestionArtifact } from '../src/services/intelligence-fabric/call-snapshot';
import { BriefingComposer, briefingContextOf } from '../src/services/intelligence-fabric/briefing';
import { validateAiContextPackage, estimateAiInputTokens } from '@emgloop/shared';
import type { CallWindowAggregate } from '../src/repositories/marketplace-call.repository';
const NOW = new Date('2026-10-15T16:00:00Z');
const ZONE = 'America/New_York';
test('a greeting can be answered without inventing business evidence when no readings are current', async (t) => {
  t.mock.method(BriefingComposer.prototype, 'gather', async () => ({ artifacts: [], gaps: [] }));
  const prisma = {
    user: { findFirst: async () => null },
    organizationMembership: { findFirst: async () => null },
  };
  const runtime = {
    run: async (
      _principal: unknown,
      request: import('../src/services/ai-runtime/gateway').AiRunRequest,
    ) => {
      const { parseLoopChatOutput, validateLoopChatOutput, AI_TASK_LOOP_QUESTION } =
        await import('@emgloop/shared');
      assert.deepEqual(validateAiContextPackage(request.context), []);
      const output = parseLoopChatOutput({
        schemaId: 'loop-chat.v1',
        paragraphs: [
          {
            kind: 'CONVERSATION',
            text: 'Hey Matt! What would you like to look at?',
            citations: [],
          },
        ],
        calculations: [],
        limitations: [],
      })!;
      assert.deepEqual(
        validateLoopChatOutput(output, AI_TASK_LOOP_QUESTION, new Set(), request.evidence),
        [],
      );
      return {
        outcome: 'ANSWERED',
        output,
        provenance: { requestedModel: { providerId: 'openai' } },
      } as never;
    },
  };
  const result = await new LoopQuestionService(prisma as never, runtime, () => NOW).answer(
    { organizationId: 'our-org', userId: 'our-user' },
    'Hey, how are you?',
    { timeZone: ZONE },
  );
  assert.equal(result.outcome, 'ANSWERED');
  if (result.outcome === 'ANSWERED') assert.deepEqual(result.sources, []);
});
test('long conversations keep recent assistant context and relevant evidence within the gateway input cap', async (t) => {
  const artifact = callQuestionArtifact(a, new Date('2026-10-15T04:00:00Z'), NOW);
  const artifacts = Array.from({ length: 24 }, (_, i) => ({
    ...artifact,
    ref: `digest:${i}`,
    domain: i === 23 ? 'MAIL' : 'CALLGRID',
    title: `Source ${i}`,
    statement: 'Stored evidence. '.repeat(180),
  }));
  t.mock.method(BriefingComposer.prototype, 'gather', async () => ({ artifacts, gaps: [] }));
  const prisma = {
    user: { findFirst: async () => null },
    organizationMembership: { findFirst: async () => null },
  };
  let invoked = false;
  const runtime = {
    run: async (
      _principal: unknown,
      request: import('../src/services/ai-runtime/gateway').AiRunRequest,
    ) => {
      invoked = true;
      const tokens = estimateAiInputTokens([
        request.instructions,
        JSON.stringify(request.schema),
        ...request.context.items.flatMap((i) => [i.sourceRef, i.trust, i.content]),
      ]);
      assert.ok(tokens <= 12000, String(tokens));
      assert.deepEqual(validateAiContextPackage(request.context), []);
      assert.equal(
        request.context.items[0]!.sourceRef,
        'digest:23',
        'Mail question prioritizes Mail evidence',
      );
      const q = JSON.parse(
        request.context.items.find((i) => i.sourceRef === 'user-request:question')!.content,
      );
      assert.ok(q.conversation.some((m: { role: string }) => m.role === 'assistant'));
      assert.ok(q.omittedSources.length > 0);
      return { outcome: 'REFUSED_BY_LOOP' as const, refusals: ['KILL_SWITCH' as const] };
    },
  };
  await new LoopQuestionService(prisma as never, runtime, () => NOW).answer(
    { organizationId: 'our-org', userId: 'our-user' },
    'How do my emails look?',
    {
      timeZone: ZONE,
      messages: [
        { role: 'user', content: 'My inbox?' },
        { role: 'assistant', content: 'Earlier answer. '.repeat(400) },
      ],
    },
  );
  assert.ok(invoked);
});
test('the full question context passes gateway validation and user instructions remain outside cited evidence', async (t) => {
  const artifact = callQuestionArtifact(a, new Date('2026-10-15T04:00:00Z'), NOW);
  t.mock.method(BriefingComposer.prototype, 'gather', async () => ({
    artifacts: [artifact],
    gaps: [],
  }));
  const prisma = {
    user: { findFirst: async () => null },
    organizationMembership: { findFirst: async () => null },
  };
  let calls = 0;
  const runtime = {
    run: async (
      _principal: unknown,
      request: import('../src/services/ai-runtime/gateway').AiRunRequest,
    ) => {
      calls++;
      assert.deepEqual(validateAiContextPackage(request.context), []);
      const question = request.context.items.find((i) => i.sourceRef === 'user-request:question');
      assert.ok(
        question,
        'the actual service must include a valid source reference for the user question',
      );
      assert.equal(question.trust, 'UNTRUSTED_INPUT');
      assert.equal(request.evidence.figures.has(question.sourceRef), false);
      return {
        outcome: 'ANSWERED',
        output: {
          chatAnswer: {
            paragraphs: [
              {
                kind: 'EVIDENCE',
                text: 'Do not trust this claim.',
                citations: [question.sourceRef],
              },
            ],
            calculations: [],
            limitations: [],
          },
        },
      } as never;
    },
  };
  const result = await new LoopQuestionService(prisma as never, runtime, () => NOW).answer(
    { organizationId: 'our-org', userId: 'our-user' },
    'What needs my attention?',
    { timeZone: ZONE },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, { outcome: 'UNAVAILABLE', reason: 'UNSUPPORTED_CITATION' });
});
test('questions resolve local reporting dates, historical years, follow-up periods and DST without asking the model for dates', () => {
  const day = questionWindow('How did we do yesterday?', NOW, ZONE)!;
  assert.equal(day.since.toISOString(), '2026-10-14T04:00:00.000Z');
  assert.equal(day.until.toISOString(), '2026-10-15T04:00:00.000Z');
  const year = questionWindow('What was revenue in 2024?', NOW, ZONE)!;
  assert.equal(year.since.toISOString(), '2024-01-01T05:00:00.000Z');
  assert.equal(year.until.toISOString(), '2025-01-01T05:00:00.000Z');
  assert.deepEqual(questionWindow('Which campaign?', NOW, ZONE, ['How did we do yesterday?']), day);
  assert.equal(questionWindow('2026-02-30', NOW, ZONE), null);
  assert.equal(questionWindow('2027-01-01', NOW, ZONE), null);
  const dst = questionWindow('2026-03-08', NOW, ZONE)!;
  assert.equal(dst.until.getTime() - dst.since.getTime(), 23 * 3600000);
  const pacific = questionWindow('2026-03-08', NOW, 'Pacific/Kiritimati')!;
  assert.equal(pacific.since.toISOString(), '2026-03-07T10:00:00.000Z');
});
const a: CallWindowAggregate = {
  calls: 2,
  monetized: 1,
  converted: 1,
  revenueCents: 10000,
  payoutCents: 6000,
  costCents: 200,
  callsWithRevenue: 2,
  callsWithPayout: 2,
  callsWithCost: 2,
  campaigns: [],
  buyers: [],
  vendors: [],
  sources: [],
};
test('financial evidence preserves cents and missing-value coverage, never invents zero revenue or partial net profit', () => {
  const full = callQuestionArtifact(a, new Date('2026-10-14T04:00:00Z'), NOW);
  assert.equal(JSON.parse(full.statement).netProfit, '38.00');
  const partial = callQuestionArtifact({ ...a, callsWithCost: 1 }, NOW, NOW);
  assert.equal(JSON.parse(partial.statement).netProfit, null);
  const absent = callQuestionArtifact({ ...a, callsWithRevenue: 0 }, NOW, NOW);
  assert.equal(JSON.parse(absent.statement).reportedRevenue, null);
  const { items, evidence } = briefingContextOf([full], 'our-org');
  assert.deepEqual(
    validateAiContextPackage({
      organizationId: 'our-org',
      viewerUserId: 'our-user',
      taskId: 'loop.question.answer',
      sensitivityCeiling: 'COMMUNICATION_CONTENT',
      items,
    }),
    [],
  );
  assert.ok(evidence.figures.get(full.ref)?.has(38));
  assert.ok(evidence.dates.has('2026-10-14'));
  assert.equal(
    full.coverage,
    'CONNECTED_PARTIAL',
    'stored-call presence never establishes provider reconciliation',
  );
});

test('historical aggregation is performed by Postgres within the explicit organization and never loads individual calls', async () => {
  const { MarketplaceCallRepository } =
    await import('../src/repositories/marketplace-call.repository');
  const scopes: unknown[] = [];
  const prisma = {
    marketplaceCall: {
      aggregate: async (q: { where: unknown }) => {
        scopes.push(q.where);
        return {
          _count: { _all: 5, revenueCents: 0, payoutCents: 5, costCents: 4 },
          _sum: { revenueCents: null, payoutCents: 200, costCents: 80 },
        };
      },
      count: async (q: { where: unknown }) => {
        scopes.push(q.where);
        return 2;
      },
      findMany: async () => {
        throw new Error('individual history must not be loaded');
      },
    },
  };
  const since = new Date('2024-01-01T05:00:00Z'),
    until = new Date('2025-01-01T05:00:00Z');
  const totals = await new MarketplaceCallRepository(prisma as never).aggregateHistoryWindow(
    'our-org',
    since,
    until,
  );
  assert.equal(totals.callsWithRevenue, 0);
  assert.equal(totals.callsWithCost, 4);
  assert.equal(
    JSON.parse(callQuestionArtifact(totals, since, until).statement).reportedRevenue,
    null,
  );
  for (const scope of scopes)
    assert.deepEqual(
      (scope as { organizationId: string; sourceOccurredAt: unknown }).sourceOccurredAt,
      { gte: since, lt: until },
    );
  assert.ok(scopes.every((s) => (s as { organizationId: string }).organizationId === 'our-org'));
});

test('mailbox overview preserves separate evidence when two threads contain the same signal key', async () => {
  const { mailDomainProducer } = await import('../src/services/intelligence-fabric/domains/mail');
  const { digestContentRefusals } = await import('@emgloop/shared');
  const producer = mailDomainProducer(
    { governanceDecision: null, modelEnabled: () => false } as never,
    { modelEnabled: () => false } as never,
  );
  const signal = {
    key: 'reply-needed',
    kind: 'OBLIGATION',
    knowledge: 'INFERRED',
    statement: 'A partner awaits your response.',
    evidenceRefs: ['work_thread:a'],
    owedBy: 'VIEWER',
  };
  const context = {
    principal: { organizationId: 'our-org', userId: 'our-user' },
    lanes: { needsYou: 2, waiting: 0, quiet: 0 },
    threads: ['a', 'b'].map((id) => ({
      ref: `work_thread:${id}`,
      label: null,
      statement: 'A partner awaits your response.',
      signals: [{ ...signal, evidenceRefs: [`work_thread:${id}`] }],
      lastEvidenceAt: NOW,
    })),
    windowStart: new Date('2026-10-14T04:00:00Z'),
    windowEnd: NOW,
  };
  const result = await producer.read(
    {
      scope: 'PRINCIPAL',
      ...context.principal,
      domain: 'MAIL',
      subjectKind: 'DOMAIN',
      subjectRef: 'domain',
    },
    context as never,
    'mail:fp',
    NOW,
  );
  assert.equal(result.status, 'READ');
  if (result.status !== 'READ') return;
  const keys = result.digest.content.signals!.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(
    digestContentRefusals(result.digest.content, { scope: 'PRINCIPAL', producerKind: 'RULE' }),
    [],
  );
  assert.equal(result.digest.coverage, 'CONNECTED_PARTIAL');
});

test('an overview-only queue claim excludes individual Mail threads even though they share the MAIL domain', async () => {
  const { IntelligenceRefreshQueueRepository } =
    await import('../src/repositories/intelligence/intelligence-refresh-queue.repository');
  const queries: { where: Record<string, unknown> }[] = [];
  const prisma = {
    intelligenceRefreshRequest: {
      findFirst: async () => null,
      findMany: async (query: { where: Record<string, unknown> }) => {
        queries.push(query);
        return [];
      },
    },
  };
  const queue = new IntelligenceRefreshQueueRepository(prisma as never);
  await queue.claim({
    leaseOwner: 'mail-domain',
    now: NOW,
    leaseMs: 60000,
    limit: 1,
    domains: ['MAIL'],
    targets: [{ domain: 'MAIL', scope: 'PRINCIPAL', subjectKinds: ['DOMAIN'] }],
  });
  const pending = queries.find((q) => q.where.state === 'PENDING')!;
  assert.deepEqual(pending.where.OR, [
    { domain: 'MAIL', scope: 'PRINCIPAL', subjectKind: { in: ['DOMAIN'] } },
  ]);
});

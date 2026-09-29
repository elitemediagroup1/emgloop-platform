// The commissioning proof path against a REAL Postgres (2026-09-29). OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL.
//
// SOURCE -> RULE -> ANTHROPIC -> AI LEDGER -> VALIDATION -> GOVERNED READING -> CURRENT DIGEST, through the real
// producer loop, the real gateway with the DURABLE ledger, the real IAM authorizer and the acting-operator
// resolver (a RecordedModelProvider stands in for Anthropic: no key, no network). Then: the Read Intelligence State
// reader shows that path in codes and counts; the model-read interval holds a model reading against moving
// evidence and reads again once the interval passes; a failed provider is backed off, not re-asked every pass; an
// organization without an acting operator records NO_PRINCIPAL; and none of it makes a Situation call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { RecordedModelProvider, aiCatalogCapabilities, AI_ROUTING_POLICY, AI_BUDGET_POLICY, AI_MAX_ATTEMPTS_PER_TARGET, type RecordedInvocation } from '@emgloop/providers';
import type { AiModelResult, AiProviderPolicy } from '@emgloop/shared';

import { AiRuntimeGateway } from '../src/services/ai-runtime/gateway';
import { iamAiAuthorizer } from '../src/services/ai-runtime/authorizer';
import { DomainReadingService } from '../src/services/ai-runtime/domain-reading.service';
import { DurableAiUsageLedger } from '../src/services/ai-usage-ledger.service';
import { AiUsageLedgerRepository } from '../src/repositories/ai-usage-ledger.repository';
import { DomainFactsRepository } from '../src/repositories/intelligence/domain-facts.repository';
import { IntelligenceDigestRepository } from '../src/repositories/intelligence/intelligence-digest.repository';
import { IntelligenceReadingStateRepository } from '../src/repositories/intelligence/intelligence-reading-state.repository';
import { IntelligenceRefreshQueueRepository } from '../src/repositories/intelligence/intelligence-refresh-queue.repository';
import { forgetIntelligenceFabricPresence } from '../src/repositories/intelligence/intelligence-fabric-presence';
import { readOnlyClient } from '../src/repositories/read-only-client';
import { callgridDomainProducer } from '../src/services/intelligence-fabric/domains/callgrid';
import { DOMAIN_READING_TEMPLATE_ID } from '../src/services/ai-runtime/templates/domain-reading';
import { IntelligenceProducerRegistry } from '../src/services/intelligence-fabric/producer';
import { runIntelligencePass } from '../src/services/intelligence-fabric/intelligence-pass';
import { MODEL_READING_MIN_INTERVAL_MS } from '../src/services/intelligence-fabric/producer-loop';
import { principalResolver } from '../src/services/intelligence-fabric/loop-producers';
import { SituationService } from '../src/services/intelligence-fabric/situations';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;
const HOUR = 36e5;
const POLICY: readonly AiProviderPolicy[] = [{ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', version: 1, recordedAtMs: 0 }];

async function tenant(prisma: PrismaClient, label: string) {
  const organizationId = `0drc_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `DRC ${label}`, slug: organizationId } });
  const userId = `user_drc_${label}_${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'DRC', status: 'ACTIVE', metadata: { systemRole: 'OWNER' } } });
  await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'OWNER', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  return { organizationId, userId };
}

const ANSWER: AiModelResult = {
  output: { json: { schemaId: 'domain-reading.v1', reading: { statement: 'Call economics held steady against the week before.', status: 'CALM', confidence: 'MEDIUM' }, signals: [], limitations: [] } },
  toolCalls: [],
  stopReason: 'END',
  usage: { inputTokens: 900, outputTokens: 120 },
  providerRequestId: 'req_1',
  reportedModel: 'claude-opus-5',
  latencyMs: 40,
};

/** The worker's assembly, in miniature: one gateway, the durable ledger, the IAM authorizer, the kit's ledger backoffs. */
function world(prisma: PrismaClient, organizationId: string, actingUsers: Map<string, string>, recording: Omit<RecordedInvocation, 'modelId'>, clock: { now: Date }) {
  let calls = 0;
  const provider = new RecordedModelProvider('anthropic', [{ modelId: 'claude-opus-5', ...recording }], (m) => aiCatalogCapabilities('anthropic', m));
  const counted = { providerId: 'anthropic', capabilities: (m: string) => provider.capabilities(m), invoke: (r: never, s: AbortSignal) => ((calls += 1), provider.invoke(r, s)) };
  const tasks = ['callgrid.domain.reading'];
  const gateway = new AiRuntimeGateway(
    { activation: { enabled: true, organizations: [organizationId], tasks, providers: ['anthropic'] }, policy: AI_ROUTING_POLICY, budget: AI_BUDGET_POLICY, killSwitches: [], maxAttemptsPerTarget: AI_MAX_ATTEMPTS_PER_TARGET },
    { providers: [counted] as never, ledger: new DurableAiUsageLedger(prisma), authorize: iamAiAuthorizer(prisma), now: () => clock.now, newInvocationId: () => randomUUID(), providerPolicies: async () => POLICY },
  );
  const ledger = new AiUsageLedgerRepository(prisma);
  let volume = 40;
  const dim = () => ({ key: 'c1', label: 'c1', calls: volume, monetized: 30, converted: 0, revenueCents: 400000, payoutCents: 200000, costCents: 0, callsWithRevenue: volume, callsWithPayout: volume, callsWithCost: 0 });
  const port = { firstCallAt: async () => new Date('2026-01-01'), aggregateWindow: async () => ({ ...dim(), buyers: [dim()], vendors: [], sources: [], campaigns: [dim()] }), organizationIdsWithCallsSince: async () => [organizationId] };
  const producer = callgridDomainProducer(port as never, {
    modelEnabled: (id) => tasks.includes(id),
    reader: new DomainReadingService(gateway),
    principalFor: principalResolver(new DomainFactsRepository(prisma), actingUsers, () => clock.now),
    modelRejectedSince: (q) => ledger.rejectedSince(q.organizationId, { taskId: q.taskId, taskVersion: q.taskVersion, templateId: DOMAIN_READING_TEMPLATE_ID, templateVersion: q.templateVersion, principalUserId: q.userId, since: q.since }),
    modelFailedSince: (q) => ledger.failedSince(q.organizationId, { taskId: q.taskId, taskVersion: q.taskVersion, templateId: DOMAIN_READING_TEMPLATE_ID, templateVersion: q.templateVersion, principalUserId: q.userId, since: q.since }),
  });
  const registry = new IntelligenceProducerRegistry([producer] as never, ['callgrid.domain@1']);
  const deps = { registry, queue: new IntelligenceRefreshQueueRepository(prisma), digests: new IntelligenceDigestRepository(prisma), leaseOwner: 'test', now: () => clock.now };
  const pass = () => runIntelligencePass(deps, { limit: 10, leaseMs: 60_000, maxAttempts: 3, discoverLimit: 10 });
  return { pass, calls: () => calls, moreCalls: () => void (volume += 7) };
}

const rows = (prisma: PrismaClient, organizationId: string) => prisma.aiInvocation.findMany({ where: { organizationId }, select: { taskId: true, providerId: true, outcome: true, lane: true, invocationId: true, failureClass: true }, orderBy: { requestedAt: 'asc' } });
const digestOf = (prisma: PrismaClient, organizationId: string) => prisma.intelligenceDigest.findFirst({ where: { organizationId, domain: 'CALLGRID', scope: 'ORGANIZATION' }, select: { status: true, provenance: true, aiInvocationId: true, generatedAt: true } });

test('THE PROOF PATH: CallGrid evidence -> rule -> Anthropic -> durable ledger -> validation -> CURRENT RULE_AND_MODEL digest, shown by the probe in codes', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  const t = await tenant(prisma, 'proof');
  const clock = { now: new Date() };
  try {
    const w = world(prisma, t.organizationId, new Map([[t.organizationId, t.userId]]), { result: ANSWER }, clock);
    await w.pass();
    assert.equal(w.calls(), 1, 'Anthropic was asked once');
    const [call] = await rows(prisma, t.organizationId);
    assert.deepEqual([call!.taskId, call!.providerId, call!.outcome, call!.lane], ['callgrid.domain.reading', 'anthropic', 'ANSWERED', 'BACKGROUND']);
    const d = await digestOf(prisma, t.organizationId);
    const p = d!.provenance as Record<string, unknown>;
    assert.deepEqual([d!.status, p.producerKind, p.modelStage, p.taskId, d!.aiInvocationId], ['CURRENT', 'RULE_AND_MODEL', 'MODEL_READ', 'callgrid.domain.reading', call!.invocationId], 'the digest names the very call the ledger holds');
    assert.match(String(p.readingIdentity), /^model:callgrid\.domain\.reading@/);

    // The eligibility Situations and the Briefing read: this reading may be synthesized from.
    const situations = new SituationService({ prisma: readOnlyClient(prisma), runtime: null, modelEnabled: () => false, principalFor: async () => null, now: () => clock.now });
    const diag = await situations.diagnose({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.equal(diag.domains.find((x) => x.domain === 'CALLGRID')?.eligible, 1);

    // The probe: the reading and the call behind it, codes and counts only.
    const state = await new IntelligenceReadingStateRepository(readOnlyClient(prisma)).read(t.organizationId, new Date(clock.now.getTime() - 24 * HOUR), new Date(clock.now.getTime() + 1000));
    assert.deepEqual(state.readings.map((g) => [g.scope, g.domain, g.status, g.producerKind, g.modelStage, g.taskId, g.digests, g.withInvocation, g.linked, g.ledgerOutcomes, g.providers]), [['ORGANIZATION', 'CALLGRID', 'CURRENT', 'RULE_AND_MODEL', 'MODEL_READ', 'callgrid.domain.reading', 1, 1, 1, { ANSWERED: 1 }, { anthropic: 1 }]]);
    assert.deepEqual(state.ledger.map((l) => [l.taskId, l.providerId, l.outcome, l.lane, l.count]), [['callgrid.domain.reading', 'anthropic', 'ANSWERED', 'BACKGROUND', 1]]);
    const text = JSON.stringify(state);
    for (const secret of [t.organizationId, t.userId, call!.invocationId, 'held steady', 'c1']) assert.equal(text.includes(secret), false, secret);

    // THE INTERVAL: new calls move the evidence, but a model reading under 6 hours old stands -- no call, no write.
    w.moreCalls();
    clock.now = new Date(clock.now.getTime() + HOUR);
    const held = await w.pass();
    assert.equal(w.calls(), 1, 'no second call within the interval');
    assert.equal(held.cycle?.outcomes?.MODEL_INTERVAL, 1, JSON.stringify(held.cycle));
    assert.equal((await rows(prisma, t.organizationId)).length, 1);
    // Past the interval, the moved evidence is read again.
    clock.now = new Date(clock.now.getTime() + MODEL_READING_MIN_INTERVAL_MS);
    await w.pass();
    assert.equal(w.calls(), 2, 'read again once the interval passed');
    assert.equal((await rows(prisma, t.organizationId)).length, 2);

    // NO SITUATION SIDE EFFECT: with synthesis enabled, a model-backed domain reading alone makes no Situation call.
    const spy: string[] = [];
    const live = new SituationService({ prisma, runtime: { run: async (_p: unknown, req: { task: { taskId: string } }) => (spy.push(req.task.taskId), assert.fail('no Situation call')) } as never, modelEnabled: () => true, principalFor: async () => ({ organizationId: t.organizationId, userId: t.userId }), now: () => clock.now });
    const report = await live.pass({ scope: 'ORGANIZATION', organizationId: t.organizationId });
    assert.deepEqual([report.candidates, spy.length], [0, 0]);
  } finally {
    await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('A FAILING PROVIDER is recorded, backed off for hours -- not re-asked every pass -- and retried after the window; the rule reading stands meanwhile', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  const t = await tenant(prisma, 'fail');
  const clock = { now: new Date() };
  try {
    const w = world(prisma, t.organizationId, new Map([[t.organizationId, t.userId]]), { failure: { failure: 'UNAVAILABLE', message: 'upstream 503 with details' } }, clock);
    await w.pass();
    assert.equal(w.calls(), 1);
    let ledger = await rows(prisma, t.organizationId);
    assert.deepEqual(ledger.map((r) => [r.outcome, r.failureClass]), [['FAILED', 'UNAVAILABLE']]);
    const d = await digestOf(prisma, t.organizationId);
    assert.deepEqual([d!.status, (d!.provenance as Record<string, unknown>).producerKind, (d!.provenance as Record<string, unknown>).modelStage, d!.aiInvocationId], ['CURRENT', 'RULE', 'FAILED:UNAVAILABLE', null]);
    // Every pass for the next hours: the reading is re-read (unsatisfied) but the provider is not asked.
    for (let i = 0; i < 8; i += 1) {
      clock.now = new Date(clock.now.getTime() + 15 * 60 * 1000);
      await w.pass();
    }
    assert.equal(w.calls(), 1, 'two hours of passes, one call');
    assert.equal(((await digestOf(prisma, t.organizationId))!.provenance as Record<string, unknown>).modelStage, 'MODEL_BACKOFF:FAILED');
    clock.now = new Date(clock.now.getTime() + 2 * HOUR);
    await w.pass();
    assert.equal(w.calls(), 2, 'tried again after the window, the evidence unchanged');
    ledger = await rows(prisma, t.organizationId);
    assert.equal(ledger.length, 2);
    assert.equal(JSON.stringify(await digestOf(prisma, t.organizationId)).includes('upstream'), false, 'no provider text anywhere');
  } finally {
    await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('NO ACTING OPERATOR: the organization reading is written by the rule with NO_PRINCIPAL, and nothing reaches the provider or the ledger', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  forgetIntelligenceFabricPresence();
  const t = await tenant(prisma, 'noop');
  const clock = { now: new Date() };
  try {
    const w = world(prisma, t.organizationId, new Map(), { result: ANSWER }, clock);
    await w.pass();
    assert.equal(w.calls(), 0);
    assert.equal((await rows(prisma, t.organizationId)).length, 0);
    const p = (await digestOf(prisma, t.organizationId))!.provenance as Record<string, unknown>;
    assert.deepEqual([p.producerKind, p.modelStage], ['RULE', 'NO_PRINCIPAL']);
  } finally {
    await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

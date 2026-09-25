// PR 1 (AI runtime) against a REAL Postgres with migration 20261005000000 applied.
//
// OPT-IN AND LOCAL ONLY, like every *.postgres.test.ts: it runs only when LOOP_TEST_POSTGRES_URL is set and
// refuses any host but localhost / 127.0.0.1.
//
// WHAT IT PROVES, THAT THE FAKES CANNOT
//   - the ledger writes the lane and the reconciled cost to the new columns, and reads cost back per lane,
//     per organization day and over the trailing day -- counting a legacy row conservatively;
//   - the capacity check is ATOMIC with the reservation: many concurrent BACKGROUND reservations from
//     separate connections against a small lane never spend past it;
//   - the operating budget round-trips through `ai_controls` (versioned, UNCHANGED, STALE, refused when
//     invalid) and the database itself refuses a BUDGET row that breaks its shape;
//   - the controls reader returns platform KILLED switches and this organization's, never another's.
//
// The operating budget is ONE platform-wide control, so this file removes every BUDGET row it wrote before
// it ends. No other test in this package reads it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { AI_BUDGET_POLICY } from '@emgloop/providers';
import { AI_OPERATING_BUDGET_INITIAL, aiControlKey, type AiBudgetPolicy, type AiOperatingBudget } from '@emgloop/shared';

import { AiUsageLedgerRepository } from '../src/repositories/ai-usage-ledger.repository';
import { AiControlRepository } from '../src/repositories/brain/ai-control.repository';
import { DurableAiUsageLedger } from '../src/services/ai-usage-ledger.service';
import { aiRuntimeControlsReader } from '../src/services/ai-runtime/controls-reader';
import type { AiCallReservation } from '../src/services/ai-runtime/gateway';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const PRICED = { listVersion: 'list.pg', inputMicrosPerToken: 5, outputMicrosPerToken: 25 };
const OPEN: AiBudgetPolicy = {
  version: 'budget.pg.capacity',
  classes: { standard: { maxInputTokensPerCall: 50_000, maxOutputTokensPerCall: 4000, taskDaily: { maxInvocations: 1000, maxInputTokens: 100_000_000, maxOutputTokens: 10_000_000 } } },
  organizationDaily: { maxInvocations: 1000, maxInputTokens: 100_000_000, maxOutputTokens: 10_000_000 },
  globalDaily: { maxInvocations: 5000, maxInputTokens: 1_000_000_000, maxOutputTokens: 100_000_000 },
};

function reservation(organizationId: string, userId: string, callKey: string, lane: AiCallReservation['lane'], requestedAt = new Date()): AiCallReservation {
  return {
    organizationId,
    callKey,
    principalUserId: userId,
    taskId: 'telegram.content.triage',
    taskVersion: '3.0.0',
    capabilityRoute: 'GENERAL_REASONING',
    // 3000 in x 5 + 2000 out x 25 = 65,000 micros reserved.
    target: { providerId: 'anthropic', modelId: 'model-a', reasoningEffort: 'low', timeoutMs: 20_000, maxOutputTokens: 2000, pricing: PRICED },
    routingPolicyVersion: 'routing.pg.1',
    budgetClass: 'standard',
    templateId: 'telegram-content-triage',
    templateVersion: '5',
    contextSourceRefs: ['telegram_message:x'],
    estimate: { inputTokens: 3000, outputTokens: 2000 },
    fellBackFrom: null,
    callOrdinal: 1,
    requestedAt,
    lane,
  };
}

async function world(prisma: PrismaClient) {
  const organizationId = `org_cap_${randomUUID()}`;
  const userId = `user_cap_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: 'PR 1 capacity', slug: organizationId, timezone: 'UTC' } });
  await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'Capacity' } });
  return { organizationId, userId };
}

async function teardown(prisma: PrismaClient, organizationId: string) {
  await prisma.aiInvocation.deleteMany({ where: { organizationId } });
  await prisma.user.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

test('real Postgres: lane and cost are written, and cost reads back per lane, per day and over the trailing day', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, userId } = await world(prisma);
  try {
    const repo = new AiUsageLedgerRepository(prisma);
    assert.equal(await repo.capacityColumnsPresent(), true, 'the migration is applied');
    const ledger = new DurableAiUsageLedger(prisma, { ledger: repo });

    assert.deepEqual(await ledger.reserve(reservation(organizationId, userId, 'fwd', 'FORWARD'), OPEN, [organizationId]), { ok: true });
    assert.deepEqual(await ledger.reserve(reservation(organizationId, userId, 'bg', 'BACKGROUND'), OPEN, [organizationId]), { ok: true });
    const row = await prisma.aiInvocation.findFirst({ where: { organizationId, invocationId: 'bg' }, select: { lane: true, costMicros: true, estimatedCostMicros: true } });
    assert.deepEqual(row, { lane: 'BACKGROUND', costMicros: null, estimatedCostMicros: 65_000 }, 'reserved at its ceiling cost, in its lane');

    // Reconcile the forward call with a reported cost; leave the background one in flight.
    const at = new Date();
    assert.equal(
      await ledger.reconcile(organizationId, {
        callKey: 'fwd', outcome: 'ANSWERED', servedModel: 'm', providerRequestId: 'r', usage: { inputTokens: 1000, outputTokens: 300 },
        unitCostBasis: 'list.pg', failureClass: null, rejectionCodes: [], completedAt: at, latencyMs: 10, costMicros: 12_500,
      }),
      true,
    );
    // A legacy row (written before the lane and cost existed) that reported usage counts FORWARD at its reserve.
    await prisma.aiInvocation.create({
      data: {
        organizationId, invocationId: 'legacy', principalUserId: userId, taskId: 'telegram.content.triage', taskVersion: '3.0.0',
        profile: 'GENERAL_REASONING', providerId: 'anthropic', requestedModelId: 'model-a', routingPolicyVersion: 'routing.pg.0',
        templateId: 't', templateVersion: '5', contextManifestHash: 'h', contextSourceCount: 1, estimatedCostMicros: 40_000,
        inputTokens: 500, outputTokens: 100, outcome: 'ANSWERED', rejectionCodes: [], requestedAt: at, completedAt: at,
        businessDate: new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`),
      },
    });
    // A failed call counts toward the breaker, and costs nothing when it reported nothing.
    await ledger.reserve(reservation(organizationId, userId, 'failed', 'FORWARD'), OPEN, [organizationId]);
    await ledger.reconcile(organizationId, {
      callKey: 'failed', outcome: 'FAILED', servedModel: null, providerRequestId: null, usage: null, unitCostBasis: 'list.pg',
      failureClass: 'UNAVAILABLE', rejectionCodes: [], completedAt: at, latencyMs: 5, costMicros: null,
    });

    const spend = await ledger.spend(organizationId, 'telegram.content.triage', at, [organizationId], AI_OPERATING_BUDGET_INITIAL);
    assert.equal(spend.cost!.laneMicros.FORWARD, 12_500 + 40_000, 'reported cost + the legacy row at its reserve; the failed call is zero');
    assert.equal(spend.cost!.laneMicros.BACKGROUND, 65_000, 'an in-flight call holds its reserve');
    assert.equal(spend.cost!.organizationMicros, 12_500 + 40_000 + 65_000);
    assert.equal(spend.cost!.laneInvocations.FORWARD, 3);
    assert.equal(spend.cost!.taskRecentFailures, 1);
    assert.ok(spend.cost!.globalMicros >= spend.cost!.organizationMicros);
  } finally {
    await teardown(prisma, organizationId);
    await prisma.$disconnect();
  }
});

test('real Postgres: concurrent BACKGROUND reservations from separate connections never spend past the lane', { skip }, async () => {
  const clients = Array.from({ length: 6 }, () => new PrismaClient({ datasources: { db: { url: URL } } }));
  const setup = clients[0]!;
  const { organizationId, userId } = await world(setup);
  // A $0.30 BACKGROUND lane holds exactly four 65,000-micro reservations.
  const small: AiOperatingBudget = {
    ...AI_OPERATING_BUDGET_INITIAL,
    lanes: { ...AI_OPERATING_BUDGET_INITIAL.lanes, BACKGROUND: { dailyCostMicros: 300_000 } },
    backgroundMaxOrganizationSpendMicros: 20_000_000,
    backgroundMaxForwardUsedFraction: 1,
  };
  try {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        new DurableAiUsageLedger(clients[i % clients.length]!, { maxReservationAttempts: 12 }).reserve(
          reservation(organizationId, userId, `bg_${i}`, 'BACKGROUND'),
          OPEN,
          [organizationId],
          small,
        ),
      ),
    );
    const admitted = results.filter((r) => r.ok).length;
    assert.ok(admitted <= 4, `at most four fit the lane, ${admitted} were admitted`);
    const refused = results.filter((r) => !r.ok).flatMap((r) => (r.ok ? [] : r.refusals));
    assert.ok(refused.every((code) => code === 'BUDGET_LANE_EXHAUSTED' || code === 'RESERVATION_CONTENDED'), refused.join(','));
    const rows = await setup.aiInvocation.count({ where: { organizationId, lane: 'BACKGROUND' } });
    assert.equal(rows, admitted, 'every admitted reservation is exactly one row');
  } finally {
    await teardown(setup, organizationId);
    await Promise.all(clients.map((c) => c.$disconnect()));
  }
});

test('real Postgres: the operating budget round-trips through ai_controls, and the database refuses a malformed BUDGET row', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const controls = new AiControlRepository(prisma);
  const classes = Object.keys(AI_BUDGET_POLICY.classes);
  const key = aiControlKey({ scope: 'BUDGET', organizationId: null, value: 'operating' });
  const clean = async () => {
    await prisma.aiControlCurrent.deleteMany({ where: { controlKey: key } });
    await prisma.aiControl.deleteMany({ where: { controlKey: key } });
  };
  await clean();
  const actor = { kind: 'OPERATIONS', reference: 'test:pr1' } as const;
  try {
    assert.deepEqual(await controls.operatingBudget(classes), { state: 'NONE' });
    const first = await controls.recordOperatingBudget({ settings: AI_OPERATING_BUDGET_INITIAL, knownClasses: classes, reason: 'Initial budget (test).', expectedVersion: 0, actor });
    assert.ok(first.ok && first.result === 'APPENDED' && first.entry.version === 1);
    const read = await controls.operatingBudget(classes);
    assert.equal(read.state, 'RECORDED');
    assert.ok(read.state === 'RECORDED' && read.budget.organizationDailyCostMicros === 20_000_000 && read.version === 1);
    // The same figures in another key order: nothing appended.
    const again = await controls.recordOperatingBudget({ settings: JSON.parse(JSON.stringify(AI_OPERATING_BUDGET_INITIAL)), knownClasses: classes, reason: 'Again.', expectedVersion: 1, actor });
    assert.ok(again.ok && again.result === 'UNCHANGED');
    const stale = await controls.recordOperatingBudget({ settings: { ...AI_OPERATING_BUDGET_INITIAL, label: 'operating.test.2' }, knownClasses: classes, reason: 'Stale.', expectedVersion: 0, actor });
    assert.deepEqual(stale, { ok: false, refusal: 'STALE' });
    const invalid = await controls.recordOperatingBudget({ settings: { ...AI_OPERATING_BUDGET_INITIAL, organizationDailyCostMicros: 500_000_000 }, knownClasses: classes, reason: 'Too much.', expectedVersion: 1, actor });
    assert.deepEqual(invalid, { ok: false, refusal: 'SETTINGS_INVALID' });
    const raised = await controls.recordOperatingBudget({ settings: { ...AI_OPERATING_BUDGET_INITIAL, label: 'operating.test.2' }, knownClasses: classes, reason: 'Raised.', expectedVersion: 1, actor });
    assert.ok(raised.ok && raised.result === 'APPENDED' && raised.entry.version === 2);
    // The cached reader sees it.
    const reader = aiRuntimeControlsReader(prisma, { ttlMs: 0 });
    const cached = await reader.operatingBudget();
    assert.ok(cached.state === 'RECORDED' && cached.budget.label === 'operating.test.2');

    // The database refuses what the contract forbids, even without the repository -- by the shape CHECK.
    const byShape = (e: unknown) => /ai_controls_shape/.test(String((e as Error)?.message ?? e));
    const base = { version: 1, organizationId: null, reason: 'x', actorKind: 'OPERATIONS', actorReference: 'test', recordedAt: new Date() };
    await assert.rejects(
      prisma.aiControl.create({ data: { ...base, controlKey: 'BUDGET|-|operating-x', scope: 'BUDGET', value: 'operating-x', state: 'ACTIVE', settings: {} } }),
      byShape,
      'value must be operating',
    );
    await assert.rejects(
      prisma.aiControl.create({ data: { ...base, controlKey: 'BUDGET|-|operating', version: 99, scope: 'BUDGET', value: 'operating', state: 'KILLED', settings: {} } }),
      byShape,
      'a budget is ACTIVE only',
    );
    await assert.rejects(
      prisma.aiControl.create({ data: { ...base, controlKey: 'BUDGET|-|operating', version: 98, scope: 'BUDGET', value: 'operating', state: 'ACTIVE', settings: [1] } }),
      byShape,
      'settings is a JSON object',
    );
    await assert.rejects(
      prisma.aiControl.create({ data: { ...base, controlKey: 'GLOBAL|-|-', version: 999, scope: 'GLOBAL', value: null, state: 'KILLED', settings: { a: 1 } } }),
      byShape,
      'no other scope carries settings',
    );
  } finally {
    await clean();
    await prisma.$disconnect();
  }
});

test('real Postgres: the reader returns platform KILLED switches and this organization\'s, never another organization\'s', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const a = await world(prisma);
  const b = await world(prisma);
  await prisma.organizationMembership.createMany({
    data: [
      { organizationId: a.organizationId, userId: a.userId, systemRole: 'OWNER', status: 'ACTIVE' } as never,
      { organizationId: b.organizationId, userId: b.userId, systemRole: 'OWNER', status: 'ACTIVE' } as never,
    ],
  });
  const controls = new AiControlRepository(prisma);
  const task = `pr1-test-task-${randomUUID().slice(0, 8)}`;
  const platformKey = aiControlKey({ scope: 'TASK', organizationId: null, value: task });
  try {
    const platform = await controls.recordPlatformControl({ scope: 'TASK', value: task, state: 'KILLED', reason: 'Test stop.', expectedVersion: 0, operationsReference: 'test:pr1' });
    assert.ok(platform.ok);
    const own = await controls.recordOrganizationControl(b.organizationId, { scope: 'TASK', taskId: 'case.explanation', state: 'KILLED', reason: 'B stops it.', expectedVersion: 0, actorUserId: b.userId });
    assert.ok(own.ok, JSON.stringify(own));
    const reader = aiRuntimeControlsReader(prisma, { ttlMs: 0 });
    const forA = await reader.storedKillSwitches(a.organizationId);
    const forB = await reader.storedKillSwitches(b.organizationId);
    assert.ok(forA.some((k) => k.scope === 'TASK' && 'value' in k && k.value === task), 'the platform kill applies to A');
    assert.ok(!forA.some((k) => 'value' in k && k.value === 'case.explanation'), "B's own kill never reaches A");
    assert.ok(forB.some((k) => 'value' in k && k.value === 'case.explanation'), "B's own kill applies to B");
  } finally {
    const keys = [platformKey, aiControlKey({ scope: 'TASK', organizationId: b.organizationId, value: 'case.explanation' })];
    await prisma.aiControlCurrent.deleteMany({ where: { controlKey: { in: keys } } });
    await prisma.aiControl.deleteMany({ where: { controlKey: { in: keys } } });
    for (const w of [a, b]) {
      await prisma.organizationMembership.deleteMany({ where: { organizationId: w.organizationId } });
      await teardown(prisma, w.organizationId);
    }
    await prisma.$disconnect();
  }
});

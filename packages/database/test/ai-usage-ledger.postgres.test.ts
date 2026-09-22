// The durable AI usage ledger, against a REAL Postgres. Slice AI-1.
//
// OPT-IN AND LOCAL ONLY. This file runs only when LOOP_TEST_POSTGRES_URL is set, and
// it refuses any URL whose host is not localhost or 127.0.0.1 -- it creates rows and
// must never be pointed at a shared or production database. Run it against a
// disposable container with the migrations applied:
//
//   docker run -d --name loop-pg -e POSTGRES_PASSWORD=verify -p 127.0.0.1:55432:5432 postgres:16-alpine
//   DATABASE_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres npx prisma migrate deploy
//   LOOP_TEST_POSTGRES_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres \
//     npx tsx --test test/ai-usage-ledger.postgres.test.ts
//
// WHAT IT PROVES, THAT THE IN-MEMORY FAKE CANNOT. The fake runs serializable
// transactions one at a time because that is what Postgres promises. This asks
// Postgres directly: many truly concurrent reservations, from separate connections,
// against a small cap, and exactly the cap succeeds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { AiBudgetPolicy } from '@emgloop/shared';

import { DurableAiUsageLedger } from '../src/services/ai-usage-ledger.service';
import type { AiCallReservation } from '../src/services/ai-runtime/gateway';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

function budget(invocations: number): AiBudgetPolicy {
  return {
    version: 'budget.pg.1',
    classes: {
      standard: {
        maxInputTokensPerCall: 50_000,
        maxOutputTokensPerCall: 4000,
        taskDaily: { maxInvocations: 1000, maxInputTokens: 100_000_000, maxOutputTokens: 10_000_000 },
      },
    },
    organizationDaily: { maxInvocations: invocations, maxInputTokens: 100_000_000, maxOutputTokens: 10_000_000 },
    globalDaily: { maxInvocations: 1000, maxInputTokens: 100_000_000, maxOutputTokens: 10_000_000 },
  };
}

function reservation(organizationId: string, userId: string, callKey: string): AiCallReservation {
  return {
    organizationId,
    callKey,
    principalUserId: userId,
    taskId: 'case.explanation',
    taskVersion: '1.0.0',
    capabilityRoute: 'TECHNICAL_ANALYSIS',
    target: { providerId: 'provider-a', modelId: 'model-a', reasoningEffort: 'medium', timeoutMs: 30_000, maxOutputTokens: 2000, pricing: null },
    routingPolicyVersion: 'routing.pg.1',
    budgetClass: 'standard',
    templateId: 'case-explanation',
    templateVersion: '2',
    contextSourceRefs: ['decision-evidence:ev_1'],
    estimate: { inputTokens: 3000, outputTokens: 2000 },
    fellBackFrom: null,
    callOrdinal: 1,
    requestedAt: new Date(),
  };
}

test('real Postgres: concurrent reservations from separate connections never exceed the cap', { skip }, async () => {
  // Separate clients, so the reservations genuinely race on separate connections.
  const clients = Array.from({ length: 6 }, () => new PrismaClient({ datasources: { db: { url: URL } } }));
  const setup = clients[0]!;
  const organizationId = `org_pg_${randomUUID()}`;
  const userId = `user_pg_${randomUUID()}`;
  try {
    await setup.organization.create({ data: { id: organizationId, name: 'PG ledger test', slug: organizationId, timezone: 'America/New_York' } });
    await setup.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'PG test' } });

    const CAP = 5;
    const ATTEMPTS = 30;
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, i) =>
        new DurableAiUsageLedger(clients[i % clients.length]!, { maxReservationAttempts: 10 }).reserve(
          reservation(organizationId, userId, `inv_${i}`),
          budget(CAP),
          [organizationId],
        ),
      ),
    );
    const rows = await setup.aiInvocation.count({ where: { organizationId } });
    const admitted = results.filter((r) => r.ok).length;
    assert.equal(rows, admitted, 'every admitted reservation is a row, and no refused one is');
    assert.ok(admitted <= CAP, `admitted ${admitted}, cap ${CAP}`);
    // Contention can refuse a reservation that had room ("not now"), so fewer than
    // the cap may succeed -- but never more, and not zero.
    assert.ok(admitted >= 1);
    for (const r of results) {
      if (!r.ok) assert.ok(r.refusals.every((x) => x === 'BUDGET_ORGANIZATION_EXHAUSTED' || x === 'RESERVATION_CONTENDED'), `${r.refusals}`);
    }

    // A duplicate key is refused by the database even when the pre-check races.
    const dup = await Promise.all(
      clients.map((c) => new DurableAiUsageLedger(c).reserve(reservation(organizationId, userId, 'inv_dup'), budget(1000), [organizationId])),
    );
    assert.equal(dup.filter((r) => r.ok).length, 1);
    assert.equal(await setup.aiInvocation.count({ where: { organizationId, invocationId: 'inv_dup' } }), 1);
  } finally {
    await setup.aiInvocation.deleteMany({ where: { organizationId } });
    await setup.user.deleteMany({ where: { id: userId } });
    await setup.organization.deleteMany({ where: { id: organizationId } });
    await Promise.all(clients.map((c) => c.$disconnect()));
  }
});

test('real Postgres: reconciled failures with no usage cost zero tokens, only an outstanding call still reserves', { skip }, async () => {
  // The staging phantom-spend bug, against real Prisma null handling (not the fake). On businessDate
  // 2026-09-21 (America/New_York), 50 telegram triage calls reached Anthropic, came back 400
  // INVALID_REQUEST, and each reconciled FAILED with NULL usage. The ledger used to charge each one's
  // ~1000-token reserve, exhausting the day's token budget on calls that processed nothing.
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizationId = `org_pg_${randomUUID()}`;
  const userId = `user_pg_${randomUUID()}`;
  // 16:00 America/New_York -> businessDate 2026-09-21, the day the burst landed. spend() and every
  // reservation resolve the same org-local day from this one instant.
  const AT = new Date('2026-09-21T20:00:00.000Z');
  const ledger = new DurableAiUsageLedger(prisma);
  const resv = (callKey: string): AiCallReservation => ({ ...reservation(organizationId, userId, callKey), requestedAt: AT });
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'PG phantom test', slug: organizationId, timezone: 'America/New_York' } });
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'PG test' } });

    for (let i = 0; i < 50; i++) {
      const reserved = await ledger.reserve(resv(`inv_fail_${i}`), budget(1000), [organizationId]);
      assert.ok(reserved.ok, `reservation ${i} is admitted`);
      await ledger.reconcile(organizationId, {
        callKey: `inv_fail_${i}`,
        outcome: 'FAILED',
        servedModel: null,
        providerRequestId: null,
        usage: null,
        unitCostBasis: null,
        failureClass: 'INVALID_REQUEST',
        rejectionCodes: [],
        completedAt: AT,
        latencyMs: 10,
      });
    }

    const afterFailures = await ledger.spend(organizationId, 'case.explanation', AT, [organizationId]);
    assert.equal(afterFailures.organization.inputTokens, 0, 'reconciled failures with null usage processed nothing');
    assert.equal(afterFailures.organization.outputTokens, 0, 'so no phantom output tokens -- the staging exhaustion is gone');
    assert.equal(afterFailures.organization.invocations, 50, 'each failed round-trip still counts as one invocation');

    // One more call, reserved and left in flight: its estimate must still be held, conservatively.
    const inflight = await ledger.reserve(resv('inv_inflight'), budget(1000), [organizationId]);
    assert.ok(inflight.ok);
    const withInflight = await ledger.spend(organizationId, 'case.explanation', AT, [organizationId]);
    assert.equal(withInflight.organization.inputTokens, 3000, 'only the outstanding reservation holds capacity');
    assert.equal(withInflight.organization.outputTokens, 2000);
    assert.equal(withInflight.organization.invocations, 51);
  } finally {
    await prisma.aiInvocation.deleteMany({ where: { organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  }
});

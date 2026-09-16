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
    profile: 'EXPLANATION',
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

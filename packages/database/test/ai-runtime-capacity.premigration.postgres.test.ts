// PR 1 (AI runtime) against a REAL Postgres that does NOT have migration 20261005000000 yet.
//
// WHY. Production web deploys when this merges, before anybody dispatches Deploy Prisma Migrations; a
// worker redeploy could, by mistake, come first too. The new code must then behave exactly as the old
// code did: record no lane, no cost and no budget, read no new column, and admit and serve an AI call.
// Every read in this PR that touches a new column probes for it first, or names its columns explicitly.
//
// OPT-IN AND LOCAL ONLY. Set LOOP_TEST_PREMIGRATION_POSTGRES_URL to a local database migrated to the
// migrations BEFORE this PR (main 97816a5), e.g.:
//
//   docker exec loop-pg psql -U postgres -c "CREATE DATABASE loop_premig"
//   (from a checkout of main) DATABASE_URL=postgresql://postgres:verify@127.0.0.1:55432/loop_premig \
//     npx prisma migrate deploy
//   LOOP_TEST_PREMIGRATION_POSTGRES_URL=postgresql://postgres:verify@127.0.0.1:55432/loop_premig \
//     npx tsx --test test/ai-runtime-capacity.premigration.postgres.test.ts
//
// It refuses to run against a database that already HAS the new columns: that would prove nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AI_BUDGET_POLICY } from '@emgloop/providers';
import { AI_OPERATING_BUDGET_INITIAL, AI_TASK_CASE_EXPLANATION, type AiContextPackage, type AiModelResult } from '@emgloop/shared';

import { AiUsageLedgerRepository } from '../src/repositories/ai-usage-ledger.repository';
import { AiControlRepository } from '../src/repositories/brain/ai-control.repository';
import { DurableAiUsageLedger } from '../src/services/ai-usage-ledger.service';
import { aiRuntimeControlsReader } from '../src/services/ai-runtime/controls-reader';
import { AiRuntimeGateway, type AiProviderPort } from '../src/services/ai-runtime/gateway';
import {
  CASE_EXPLANATION_SCHEMA,
  CASE_EXPLANATION_TEMPLATE_ID,
  CASE_EXPLANATION_TEMPLATE_VERSION,
  renderCaseExplanationInstructions,
} from '../src/services/ai-runtime/templates/case-explanation';

const URL = process.env.LOOP_TEST_PREMIGRATION_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_PREMIGRATION_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;
const REF = 'operational-observation:obs_1';

test('BEFORE THE MIGRATION: the ledger, the controls and a full gateway call work exactly as before', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizationId = `org_premig_${randomUUID()}`;
  const userId = `user_premig_${randomUUID()}`;
  const provider = `premig-${randomUUID().slice(0, 8)}`;
  const controls = new AiControlRepository(prisma);
  try {
    const ledgerRepo = new AiUsageLedgerRepository(prisma);
    assert.equal(await ledgerRepo.capacityColumnsPresent(), false, 'this database must NOT have the new columns');

    await prisma.organization.create({ data: { id: organizationId, name: 'Pre-migration', slug: organizationId, timezone: 'UTC' } });
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'Pre' } });

    // The controls: provider policies and switches read through named columns; no budget can exist.
    const recorded = await controls.recordProviderPolicy({ providerId: provider, state: 'ACTIVE', ceiling: 'OPERATIONAL', reason: 'Pre-migration test.', expectedVersion: 0, actor: { kind: 'OPERATIONS', reference: 'test:premig' } });
    assert.ok(recorded.ok, JSON.stringify(recorded));
    assert.ok((await controls.providerPolicies()).some((p) => p.providerId === provider && p.state === 'ACTIVE'));
    assert.ok(Array.isArray(await controls.currentFor(organizationId)));
    const classes = Object.keys(AI_BUDGET_POLICY.classes);
    assert.deepEqual(await controls.operatingBudget(classes), { state: 'NONE' });
    assert.deepEqual(await controls.operatingBudgetVersion(), { version: 0 });
    assert.deepEqual(
      await controls.recordOperatingBudget({ settings: AI_OPERATING_BUDGET_INITIAL, knownClasses: classes, reason: 'x', expectedVersion: 0, actor: { kind: 'OPERATIONS', reference: 'test' } }),
      { ok: false, refusal: 'NOT_MIGRATED' },
      'a budget cannot be recorded until the migration exists -- and nothing was written',
    );

    // A full governed call: the production reader, the durable ledger, the real policy read.
    const port: AiProviderPort = {
      providerId: provider,
      async invoke(): Promise<AiModelResult> {
        return {
          output: { json: { schemaId: 'case-explanation.v2', summary: 'Revenue fell.', claims: [{ kind: 'OBSERVATION', statement: 'Revenue fell by 4200 cents.', citations: [REF], figures: [{ label: 'cents', value: 4200 }] }], limitations: [] } },
          toolCalls: [],
          stopReason: 'END',
          usage: { inputTokens: 900, outputTokens: 200 },
          providerRequestId: 'r',
          reportedModel: 'm',
          latencyMs: 5,
        };
      },
    };
    const reader = aiRuntimeControlsReader(prisma, { ttlMs: 0 });
    const target = { providerId: provider, modelId: 'model-premig', reasoningEffort: 'low', timeoutMs: 20_000, maxOutputTokens: 2000, pricing: { listVersion: 'l', inputMicrosPerToken: 5, outputMicrosPerToken: 25 } } as const;
    const gateway = new AiRuntimeGateway(
      {
        activation: { enabled: true, organizations: [organizationId], tasks: ['case.explanation'], providers: [provider] },
        policy: { version: 'routing.premig', specializationPolicyVersion: 'specialization.premig', tasks: { 'case.explanation': { taskId: 'case.explanation', taskVersion: AI_TASK_CASE_EXPLANATION.version, primary: target, fallback: null, fallbackPermitted: false, budgetClass: 'case-explanation', lane: 'INTERACTIVE' } } },
        budget: AI_BUDGET_POLICY,
        killSwitches: [],
        maxAttemptsPerTarget: 1,
      },
      {
        providers: [port],
        ledger: new DurableAiUsageLedger(prisma),
        authorize: async () => true,
        now: () => new Date(),
        newInvocationId: () => `inv_${randomUUID()}`,
        providerPolicies: reader.providerPolicies,
        storedKillSwitches: reader.storedKillSwitches,
        operatingBudget: reader.operatingBudget,
      },
    );
    const context: AiContextPackage = {
      organizationId,
      viewerUserId: userId,
      taskId: 'case.explanation',
      sensitivityCeiling: 'OPERATIONAL',
      items: [{ blockId: `${organizationId}::b1`, kind: 'STRUCTURED', trust: 'GOVERNED_FACT', sourceRef: REF, content: 'revenue down 4200 cents', sensitivity: 'OPERATIONAL', readUnder: { resource: 'commercialIntelligence', action: 'view' } }],
    };
    const result = await gateway.run({ organizationId, userId }, {
      task: AI_TASK_CASE_EXPLANATION,
      context,
      instructions: renderCaseExplanationInstructions([REF]),
      templateId: CASE_EXPLANATION_TEMPLATE_ID,
      templateVersion: CASE_EXPLANATION_TEMPLATE_VERSION,
      schema: CASE_EXPLANATION_SCHEMA,
      evidence: { figures: new Map([[REF, new Set([4200])]]), dates: new Set<string>() },
    });
    assert.equal(result.outcome, 'ANSWERED', JSON.stringify(result));
    const rows = await prisma.aiInvocation.findMany({ where: { organizationId }, select: { outcome: true, inputTokens: true, outputTokens: true, specializationPolicyVersion: true } });
    assert.deepEqual(rows, [{ outcome: 'ANSWERED', inputTokens: 900, outputTokens: 200, specializationPolicyVersion: 'specialization.premig' }]);

    // Spend reads work too, reporting cost conservatively from the reserve.
    const spend = await new DurableAiUsageLedger(prisma).spend(organizationId, 'case.explanation', new Date(), [organizationId]);
    assert.equal(spend.organization.invocations, 1);
    assert.ok((spend.cost?.organizationMicros ?? -1) > 0);
  } finally {
    await prisma.aiInvocation.deleteMany({ where: { organizationId } });
    const key = `PROVIDER_POLICY|-|${provider}`;
    await prisma.aiControlCurrent.deleteMany({ where: { controlKey: key } });
    await prisma.aiControl.deleteMany({ where: { controlKey: key } });
    await prisma.user.deleteMany({ where: { organizationId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  }
});

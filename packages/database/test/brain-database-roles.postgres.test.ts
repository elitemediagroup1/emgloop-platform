// The Brain restricted database roles, exercised by the real repositories (B4).
//
// OPT-IN AND LOCAL ONLY, like the other *.postgres tests: it runs only when
// LOOP_TEST_POSTGRES_URL points at localhost, because it creates cluster roles and sets
// throwaway passwords on them. It applies scripts/operations/brain-database-roles.sql
// (the reviewed operations script), logs in as each role, and proves two things:
//
//   - each component can do exactly its job through the real repository code;
//   - everything else is refused by the database: product tables, creating jobs,
//     recording replies, and -- above all -- changing what a job IS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

import { BrainJobRepository } from '../src/repositories/brain/brain-job.repository';
import { BrainWaitRepository } from '../src/repositories/brain/brain-wait.repository';
import { BrainStepRepository } from '../src/repositories/brain/brain-step.repository';
import { BrainCommandRepository } from '../src/repositories/brain/brain-command.repository';
import { BrainExecutionReferences } from '../src/repositories/brain/brain-execution-references';
import { AiUsageLedgerRepository } from '../src/repositories/ai-usage-ledger.repository';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'operations', 'brain-database-roles.sql');

/** Statements of the script, split on semicolons outside dollar-quoted bodies. BEGIN/COMMIT are left to psql. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inBody = false;
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line) && !inBody) continue;
    current += `${line}\n`;
    if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inBody = !inBody;
    if (!inBody && /;\s*$/.test(line)) {
      const stmt = current.trim();
      current = '';
      if (!/^(BEGIN|COMMIT);$/i.test(stmt)) out.push(stmt);
    }
  }
  return out;
}

function as(role: string, password: string): PrismaClient {
  const url = new globalThis.URL(URL);
  url.username = role;
  url.password = password;
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

const denied = /permission denied/i;

test('real Postgres: each Brain role can do its job and nothing else', { skip }, async () => {
  const owner = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizationId = `org_b4_roles_${randomUUID()}`;
  const userId = `user_b4_roles_${randomUUID()}`;
  const passwords = Object.fromEntries(['loop_brain_worker', 'loop_brain_dispatcher', 'loop_brain_sweeper'].map((r) => [r, randomBytes(18).toString('hex')]));
  const clients: PrismaClient[] = [];
  try {
    for (const stmt of statements(readFileSync(SCRIPT, 'utf8'))) await owner.$executeRawUnsafe(stmt);
    for (const [role, password] of Object.entries(passwords)) {
      // Local, throwaway, and never written anywhere: the runbook sets real ones with \password.
      await owner.$executeRawUnsafe(`ALTER ROLE ${role} PASSWORD '${password}'`);
    }
    await owner.organization.create({ data: { id: organizationId, name: 'B4 roles', slug: organizationId } });
    await owner.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'B4 roles' } });
    await owner.organizationMembership.create({ data: { organizationId, userId, systemRole: 'ADMIN', status: 'ACTIVE' } });

    // The Brain API (the owner connection today) accepts the job.
    const accepted = await new BrainJobRepository(owner).accept(organizationId, {
      principalUserId: userId,
      task: {
        taskId: 'relationship.review',
        version: '1.0.0',
        capabilityRoute: 'TECHNICAL_ANALYSIS',
        resultType: 'ANALYSIS',
        resultOwner: { authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP' },
        executionClasses: ['DURABLE'],
      },
      submission: {
        taskId: 'relationship.review',
        subject: { type: 'RELATIONSHIP', id: 'rel_roles_1' },
        executionClass: 'DURABLE',
        idempotencyKey: `idem-${randomUUID()}`,
        input: {},
      },
    });
    assert.equal(accepted.kind, 'ACCEPTED');
    const jobId = (accepted as any).job.jobId as string;
    const commandId = (accepted as any).commandId as string;

    const worker = as('loop_brain_worker', passwords.loop_brain_worker!);
    const dispatcher = as('loop_brain_dispatcher', passwords.loop_brain_dispatcher!);
    const sweeper = as('loop_brain_sweeper', passwords.loop_brain_sweeper!);
    clients.push(worker, dispatcher, sweeper);

    // The sweeper finds the undispatched command; the dispatcher records the hand-over.
    const lost = await new BrainExecutionReferences(sweeper).undispatchedCommands(new Date(Date.now() + 60_000), 500);
    assert.ok(lost.some((c) => c.commandId === commandId));
    await assert.rejects(new BrainCommandRepository(sweeper).markDispatched(organizationId, commandId), denied, 'the sweeper only reads');
    assert.equal(await new BrainCommandRepository(dispatcher).markDispatched(organizationId, commandId), true);
    await assert.rejects(dispatcher.brainJob.updateMany({ where: { id: jobId }, data: { state: 'QUEUED' } }), denied);
    assert.ok(await new BrainExecutionReferences(dispatcher).resolveCommand(commandId));

    // The worker advances the job, runs a paid step, and records its ledger row.
    const jobs = new BrainJobRepository(worker);
    const ctx = { supportsDurable: true, taskMayWait: true };
    for (const event of [{ type: 'DISPATCHED' }, { type: 'STARTED' }] as const) {
      assert.equal((await jobs.transition(organizationId, jobId, event, { context: ctx })).ok, true, event.type);
    }
    assert.equal((await jobs.lease(organizationId, jobId, { holder: 'worker-roles', generation: 1, durationMs: 60_000 })).ok, true);
    const steps = new BrainStepRepository(worker);
    const step = { stepKey: 'model.primary', kind: 'MODEL_CALL' as const, inputFingerprint: 'fp-roles' };
    assert.equal((await steps.beginAttempt(organizationId, jobId, { ...step, attempt: 1, paid: true })).ok, true);
    const ledger = new AiUsageLedgerRepository(worker);
    const callKey = `${jobId}:model.primary:1`;
    assert.equal(
      await ledger.reserve(organizationId, {
        invocationId: callKey, principalUserId: userId, taskId: 'relationship.review', taskVersion: '1.0.0', capabilityRoute: 'TECHNICAL_ANALYSIS',
        providerId: 'provider-a', requestedModelId: 'model-a', routingPolicyVersion: 'routing.test', specializationPolicyVersion: 'specialization.test',
        templateId: 't', templateVersion: '1', contextSourceRefs: [], estimatedInputTokens: 1, estimatedOutputTokens: 1,
        estimatedCostMicros: null, unitCostBasis: null, businessDate: '2026-09-17', requestedAt: new Date(), brainJobId: jobId, brainStepKey: step.stepKey,
      }),
      true,
    );
    assert.equal((await steps.resumeState(organizationId, jobId, step.stepKey, step.inputFingerprint)).ok, true);
    assert.equal(await ledger.reconcile(organizationId, { invocationId: callKey, outcome: 'ANSWERED', inputTokens: 1, outputTokens: 1, completedAt: new Date() }), true);
    const sealed = { sealVersion: 'test-seal.1', keyRef: 'test/key', sealed: new Uint8Array([0xff, 0xfe, 0x80, 0x01]) };
    assert.deepEqual(await steps.recordCheckpoint(organizationId, jobId, { ...step, payload: sealed }), { ok: true, recorded: 'NOW' });

    // It opens a question, and the question expires.
    const waits = new BrainWaitRepository(worker);
    const opened = await waits.open(organizationId, jobId, {
      question: { schemaId: 'c', schemaVersion: '1', body: { q: 1 } },
      expiresAt: new Date(Date.now() + 1_000),
      context: ctx,
      leaseHolder: 'worker-roles',
    });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const waitId = (opened as any).waitId as string;
    // Only the Brain API records a reply.
    await assert.rejects(waits.answer(organizationId, { waitId, responderUserId: userId, reply: { a: 1 } }), denied);
    const expired = await waits.expire(organizationId, jobId, waitId, { now: new Date(Date.now() + 5_000) });
    assert.equal(expired.ok && expired.job.state, 'CANCELLED');

    // A policy stop is the worker's to record, command included.
    const second = await new BrainJobRepository(owner).accept(organizationId, {
      principalUserId: userId,
      task: { taskId: 'relationship.review', version: '1.0.0', capabilityRoute: 'TECHNICAL_ANALYSIS', resultType: 'ANALYSIS', resultOwner: { authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP' }, executionClasses: ['DURABLE'] },
      submission: { taskId: 'relationship.review', subject: { type: 'RELATIONSHIP', id: 'rel_roles_2' }, executionClass: 'DURABLE', idempotencyKey: `idem-${randomUUID()}`, input: {} },
    });
    const killed = await jobs.requestCancel(organizationId, (second as any).job.jobId, { actor: { kind: 'POLICY', policy: 'kill-switch:GLOBAL' }, reason: 'KILL_SWITCH' });
    assert.equal(killed.ok && killed.job.state, 'CANCELLED');

    // And it can never change what a job is, create one, or read anything else.
    for (const data of [{ capabilityRoute: 'COMMUNICATION' }, { resultType: 'DRAFT' }, { resultOwnerAuthority: 'COMMUNICATIONS' }, { resultSubjectId: 'x' }, { principalUserId: userId }, { taskId: 'x' }, { input: { a: 1 } }]) {
      await assert.rejects(worker.brainJob.updateMany({ where: { id: jobId, organizationId }, data: data as never }), denied, JSON.stringify(data));
    }
    await assert.rejects(
      jobs.accept(organizationId, {
        principalUserId: userId,
        task: { taskId: 'relationship.review', version: '1.0.0', capabilityRoute: 'TECHNICAL_ANALYSIS', resultType: 'ANALYSIS', resultOwner: { authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP' }, executionClasses: ['DURABLE'] },
        submission: { taskId: 'relationship.review', subject: { type: 'RELATIONSHIP', id: 'rel_roles_3' }, executionClass: 'DURABLE', idempotencyKey: `idem-${randomUUID()}`, input: {} },
      }),
      denied,
      'the worker never creates a job',
    );
    await assert.rejects(worker.user.findMany({ take: 1 }), denied);
    await assert.rejects(worker.customer.findMany({ take: 1 }), denied);
    await assert.rejects(worker.brainEvent.deleteMany({ where: { jobId } }), denied);
    await assert.rejects(worker.aiControl.create({ data: { controlKey: 'GLOBAL|-|-', version: 1, scope: 'GLOBAL', state: 'ACTIVE', reason: 'r', actorKind: 'OPERATIONS', actorReference: 'x', recordedAt: new Date() } }), denied);
    await assert.rejects(sweeper.aiInvocation.findMany({ take: 1 }), denied);
    await assert.rejects(dispatcher.aiInvocation.findMany({ take: 1 }), denied);
    const refs = new BrainExecutionReferences(sweeper);
    assert.ok(Array.isArray(await refs.expiredWaits(new Date())));
    assert.ok(Array.isArray(await refs.staleLeases(new Date())));
  } finally {
    await Promise.all(clients.map((c) => c.$disconnect()));
    await owner.organization.deleteMany({ where: { id: organizationId } });
    await owner.$disconnect();
  }
});

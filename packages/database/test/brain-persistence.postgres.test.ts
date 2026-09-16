// Brain durable persistence (B4), against a REAL Postgres.
//
// OPT-IN AND LOCAL ONLY. This file runs only when LOOP_TEST_POSTGRES_URL is set, and it
// refuses any URL whose host is not localhost or 127.0.0.1 -- it creates rows and must
// never be pointed at a shared or production database. Run it against a disposable
// container with the migrations applied:
//
//   docker run -d --name loop-pg -e POSTGRES_PASSWORD=verify -p 127.0.0.1:55432:5432 postgres:18
//   DATABASE_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres npx prisma migrate deploy
//   LOOP_TEST_POSTGRES_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres \
//     npx tsx --test test/brain-persistence.postgres.test.ts
//
// WHAT IT PROVES, THAT THE IN-MEMORY DOUBLE CANNOT.
//   - The database itself refuses a child row pointing at another organization's job, a
//     job for somebody with no membership there, and every shape the CHECK constraints
//     forbid -- even when the repository is bypassed.
//   - Truly concurrent writers, on separate connections, produce one job per request,
//     one reply per question, one command per identity, one lease holder and one control
//     version.
//   - A failed transaction leaves nothing behind.
//   - A principal cannot be deleted out from under their jobs, and deleting an
//     organization still removes everything it owned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { BrainSubmission } from '@emgloop/shared';

import { BrainJobRepository, type BrainJobAcceptance } from '../src/repositories/brain/brain-job.repository';
import { BrainWaitRepository } from '../src/repositories/brain/brain-wait.repository';
import { BrainStepRepository } from '../src/repositories/brain/brain-step.repository';
import { BrainCommandRepository, BrainEventRepository } from '../src/repositories/brain/brain-command.repository';
import { AiControlRepository } from '../src/repositories/brain/ai-control.repository';
import { BrainExecutionReferences } from '../src/repositories/brain/brain-execution-references';
import { applyBrainJobTransition } from '../src/repositories/brain/brain-job-writes';
import { AiUsageLedgerRepository } from '../src/repositories/ai-usage-ledger.repository';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const TASK: BrainJobAcceptance['task'] = {
  taskId: 'relationship.review',
  version: '1.0.0',
  capabilityRoute: 'TECHNICAL_ANALYSIS',
  resultType: 'ANALYSIS',
  resultOwner: { authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP' },
  executionClasses: ['INTERACTIVE', 'DURABLE'],
};
const DRAFT_TASK: BrainJobAcceptance['task'] = {
  taskId: 'reply.draft',
  version: '1.0.0',
  capabilityRoute: 'COMMUNICATION',
  resultType: 'DRAFT',
  resultOwner: { authority: 'COMMUNICATIONS', subjectType: 'CUSTOMER_CONVERSATION' },
  executionClasses: ['INTERACTIVE', 'DURABLE'],
};
const CTX = { supportsDurable: true, taskMayWait: true };
const SEALED = { sealVersion: 'test-seal.1', keyRef: 'test/key-1', sealed: new Uint8Array([0x4c, 0x42, 0x53, 0x01, 0xff, 0xfe, 0x80, 0x81, 0x00, 0xc3, 0x28]) };

function submission(over: Partial<BrainSubmission> = {}, task = TASK): BrainSubmission {
  return {
    taskId: task.taskId,
    subject: { type: task.resultOwner.subjectType, id: `subj_${randomUUID().slice(0, 8)}` },
    executionClass: 'DURABLE',
    idempotencyKey: `idem-${randomUUID()}`,
    input: { horizonDays: 90 },
    ...over,
  };
}

async function tenant(prisma: PrismaClient, label: string) {
  const organizationId = `org_b4_${label}_${randomUUID()}`;
  const userId = `user_b4_${label}_${randomUUID()}`;
  const otherUserId = `user_b4_${label}_o_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `B4 ${label}`, slug: organizationId } });
  for (const id of [userId, otherUserId]) {
    await prisma.user.create({ data: { id, organizationId, email: `${id}@example.test`, name: 'B4 test' } });
    await prisma.organizationMembership.create({ data: { organizationId, userId: id, systemRole: 'ADMIN', status: 'ACTIVE' } });
  }
  return { organizationId, userId, otherUserId };
}

async function cleanup(prisma: PrismaClient, organizationIds: string[]) {
  // Deleting the organization must remove everything it owned, in one statement.
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
}

async function check(promise: Promise<unknown>, pattern: RegExp, message: string) {
  await assert.rejects(promise, (err: unknown) => pattern.test(String((err as Error).message ?? err)), message);
}

test('real Postgres: a job lives through its whole life in Loop records alone', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const a = await tenant(prisma, 'life');
  try {
    const jobs = new BrainJobRepository(prisma);
    const waits = new BrainWaitRepository(prisma);
    const steps = new BrainStepRepository(prisma);
    const events = new BrainEventRepository(prisma);
    const commands = new BrainCommandRepository(prisma);
    const refs = new BrainExecutionReferences(prisma);

    const out = await jobs.accept(a.organizationId, { principalUserId: a.userId, task: TASK, submission: submission({ executionClass: 'INTERACTIVE' }) });
    assert.equal(out.kind, 'ACCEPTED');
    const jobId = (out as any).job.jobId as string;
    assert.match(jobId, /^[a-z0-9]{20,}$/, 'a real cuid');
    assert.deepEqual((await jobs.get(a.organizationId, jobId))!.job, (out as any).job);
    assert.deepEqual(await refs.resolveCommand((out as any).commandId), { organizationId: a.organizationId, commandId: (out as any).commandId, jobId });
    assert.equal(await commands.markDispatched(a.organizationId, (out as any).commandId), true);

    for (const event of [{ type: 'DISPATCHED' }, { type: 'STARTED' }, { type: 'PROMOTED' }] as const) {
      const t = await jobs.transition(a.organizationId, jobId, event, { context: CTX });
      assert.equal(t.ok, true, `${event.type}: ${JSON.stringify(t)}`);
    }
    const lease = await jobs.lease(a.organizationId, jobId, { holder: 'worker-pg', generation: 1, durationMs: 60_000 });
    assert.equal(lease.ok, true);

    const step = { stepKey: 'model.primary', kind: 'MODEL_CALL' as const, inputFingerprint: 'fp-pg-1' };
    assert.deepEqual(await steps.beginAttempt(a.organizationId, jobId, { ...step, attempt: 1, paid: true }), { ok: true, attempt: 1 });
    assert.deepEqual(await steps.recordCheckpoint(a.organizationId, jobId, { ...step, payload: SEALED }), { ok: true, recorded: 'NOW' });
    const payload = await steps.readCheckpoint(a.organizationId, { jobId, ...step });
    assert.deepEqual([...payload!.sealed], [...SEALED.sealed], 'bytes survive the round trip exactly');

    const opened = await waits.open(a.organizationId, jobId, {
      question: { schemaId: 'clarify', schemaVersion: '1', body: { choose: ['a', 'b'] } },
      expiresAt: new Date(Date.now() + 86_400_000),
      context: CTX,
      leaseHolder: 'worker-pg',
    });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const waitId = (opened as any).waitId as string;
    // The worker lets go while nobody answers: nothing is held running.
    assert.equal(await jobs.releaseLease(a.organizationId, jobId, 'worker-pg'), true);
    const answered = await waits.answer(a.organizationId, { waitId, responderUserId: a.userId, reply: { pick: 'b' } });
    assert.equal(answered.ok && answered.recorded, 'NOW');
    const resumed = await waits.resume(a.organizationId, jobId, { waitId, responderPermitted: true });
    assert.deepEqual(resumed.ok && resumed.reply, { pick: 'b' });

    const ref = { owner: { authority: 'RELATIONSHIPS' as const, subjectType: 'RELATIONSHIP' as const }, subjectId: 'rel_1', artifactId: 'ana_1' };
    const done = await jobs.transition(a.organizationId, jobId, { type: 'RESULT_COMMITTED', resultRefs: [ref] }, { context: CTX });
    assert.equal(done.ok && done.job.state, 'SUCCEEDED');
    const record = (await jobs.get(a.organizationId, jobId))!;
    assert.equal(record.job.executionClass, 'DURABLE');
    assert.equal(record.job.capabilityRoute, 'TECHNICAL_ANALYSIS');
    assert.deepEqual(record.job.resultRefs, [ref]);
    assert.equal(record.lease, null);
    assert.deepEqual((await jobs.transitions(a.organizationId, jobId)).map((t) => t.kind), [
      'ACCEPTED', 'DISPATCHED', 'STARTED', 'PROMOTED', 'USER_INPUT_REQUESTED', 'USER_INPUT_RECEIVED', 'RESULT_COMMITTED',
    ]);
    assert.deepEqual((await events.listForJob(a.organizationId, jobId)).map((e) => e.event.name), [
      'brain.job.accepted', 'brain.job.promoted', 'brain.job.waiting_for_user', 'brain.job.succeeded',
    ]);

    const draft = await jobs.accept(a.organizationId, { principalUserId: a.userId, task: DRAFT_TASK, submission: submission({ executionClass: 'INTERACTIVE' }, DRAFT_TASK) });
    assert.equal(draft.kind, 'ACCEPTED');
    const back = (await jobs.get(a.organizationId, (draft as any).job.jobId))!.job;
    assert.deepEqual([back.capabilityRoute, back.resultType, back.resultOwner.authority, back.subject.type, back.executionClass], [
      'COMMUNICATION', 'DRAFT', 'COMMUNICATIONS', 'CUSTOMER_CONVERSATION', 'INTERACTIVE',
    ]);
  } finally {
    await cleanup(prisma, [a.organizationId]);
    await prisma.$disconnect();
  }
});

test('real Postgres: the database refuses what the repository would never write', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const a = await tenant(prisma, 'shape');
  const b = await tenant(prisma, 'other');
  try {
    const jobs = new BrainJobRepository(prisma);
    const out = await jobs.accept(a.organizationId, { principalUserId: a.userId, task: TASK, submission: submission() });
    const jobId = (out as any).job.jobId as string;
    const now = new Date();

    // Tenancy, enforced by composite keys.
    await check(
      prisma.brainJobTransition.create({ data: { organizationId: b.organizationId, jobId, sequence: 2, kind: 'DISPATCHED', fromState: 'ACCEPTED', toState: 'QUEUED', executionClass: 'DURABLE', actorKind: 'SYSTEM', occurredAt: now } }),
      /Foreign key constraint/i,
      "a transition cannot point at another organization's job",
    );
    await check(
      prisma.brainEvent.create({ data: { id: `${jobId}#9`, organizationId: b.organizationId, jobId, sequence: 9, name: 'brain.job.failed', taskId: 't', resultType: 'ANALYSIS', occurredAt: now, actorKind: 'SYSTEM', reason: 'INTERNAL' } }),
      /Foreign key constraint/i,
      "an event cannot point at another organization's job",
    );
    await check(
      jobs.accept(b.organizationId, { principalUserId: a.userId, task: TASK, submission: submission() }).then((r) => {
        if (r.kind !== 'REFUSED') throw new Error('accepted');
        // Bypass the repository: the membership key refuses it too.
        return prisma.brainJob.create({
          data: {
            organizationId: b.organizationId, principalUserId: a.userId, taskId: 't', taskVersion: '1', capabilityRoute: 'TECHNICAL_ANALYSIS',
            resultType: 'ANALYSIS', resultOwnerAuthority: 'RELATIONSHIPS', resultSubjectType: 'RELATIONSHIP', resultSubjectId: 's',
            executionClass: 'DURABLE', state: 'ACCEPTED', idempotencyKey: 'k-direct-1', submissionFingerprint: 'a'.repeat(64),
          },
        });
      }),
      /Foreign key constraint/i,
      'no job runs on the authority of somebody with no membership in that organization',
    );
    await check(
      prisma.aiInvocation.create({
        data: {
          organizationId: b.organizationId, invocationId: `${jobId}:model.primary:1`, taskId: 't', taskVersion: '1', profile: 'TECHNICAL_ANALYSIS',
          providerId: 'p', requestedModelId: 'm', routingPolicyVersion: 'r', templateId: 't', templateVersion: '1', contextManifestHash: 'h',
          contextSourceCount: 0, outcome: 'IN_FLIGHT', rejectionCodes: [], businessDate: new Date('2026-09-17T00:00:00Z'),
          brainJobId: jobId, brainStepKey: 'model.primary',
        },
        select: { id: true },
      }),
      /Foreign key constraint/i,
      "a ledger row cannot name another organization's job",
    );

    // Shapes, enforced by CHECK constraints.
    const job = { id: jobId, organizationId: a.organizationId };
    for (const [data, why] of [
      [{ state: 'WAITING_FOR_USER' }, 'waiting without a question'],
      [{ state: 'RUNNING', resultRefs: [{ owner: { authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP' }, subjectId: 's', artifactId: 'a' }] }, 'results before success'],
      [{ state: 'SUCCEEDED', endedAt: now }, 'success without results'],
      [{ state: 'FAILED', endedAt: now }, 'failure without a reason'],
      [{ executionClass: 'BATCH' }, 'an unknown execution class'],
      [{ state: 'PAUSED' }, 'an unknown state'],
      [{ promotedAt: now, executionClass: 'INTERACTIVE' }, 'promoted but not durable'],
      [{ leaseHolder: 'w' }, 'a holder without an expiry'],
      [{ cancelRequestedAt: now }, 'a cancel request without its reason and actor'],
      [{ generation: 0 }, 'generation zero'],
      [{ submissionFingerprint: 'not-a-hash' }, 'a fingerprint that is not SHA-256'],
    ] as const) {
      await check(prisma.brainJob.updateMany({ where: job, data: data as never }), /brain_jobs_shape/, why);
    }
    const q = { organizationId: a.organizationId, jobId, principalUserId: a.userId, questionSchemaId: 'c', questionSchemaVersion: '1', question: { q: 1 }, requestedAt: now, expiresAt: new Date(now.getTime() + 1000) };
    await check(prisma.brainJobWait.create({ data: { ...q, status: 'OPEN' } }), /brain_job_waits_shape/, 'an open wait holds its open key');
    await check(prisma.brainJobWait.create({ data: { ...q, status: 'ANSWERED', reply: { a: 1 }, replyFingerprint: 'f', answeredAt: now, responderUserId: a.otherUserId } }), /brain_job_waits_shape/, 'only the principal answers');
    await prisma.brainJobWait.create({ data: { ...q, status: 'OPEN', openJobKey: jobId } });
    await check(prisma.brainJobWait.create({ data: { ...q, status: 'OPEN', openJobKey: jobId } }), /Unique constraint/i, 'one open question per job');
    await check(
      prisma.brainCommand.create({ data: { organizationId: a.organizationId, jobId, type: 'START', generation: 1, dedupeKey: `start:${jobId}:2`, issuerKind: 'HUMAN', issuerUserId: a.userId, issuedAt: now } }),
      /brain_commands_shape/,
      'a command is stored under the identity its fields derive',
    );
    await check(
      prisma.brainEvent.create({ data: { id: `${jobId}#8`, organizationId: a.organizationId, jobId, sequence: 9, name: 'brain.job.failed', taskId: 't', resultType: 'ANALYSIS', occurredAt: now, actorKind: 'SYSTEM', reason: 'INTERNAL' } }),
      /brain_events_shape/,
      "an event's id is derived from its sequence",
    );
    await check(
      prisma.brainEvent.create({ data: { id: `${jobId}#7`, organizationId: a.organizationId, jobId, sequence: 7, name: 'brain.job.summarised', taskId: 't', resultType: 'ANALYSIS', occurredAt: now, actorKind: 'SYSTEM' } }),
      /brain_events_shape/,
      'only approved events',
    );
    await check(
      prisma.brainJobStep.create({ data: { organizationId: a.organizationId, jobId, stepKey: 'model.primary', kind: 'MODEL_CALL', state: 'RUNNING', inputFingerprint: 'f', attempts: 1, paidAttempts: 2 } }),
      /brain_job_steps_shape/,
      'paid attempts never exceed attempts',
    );
    await check(
      prisma.brainJobStep.create({ data: { organizationId: a.organizationId, jobId, stepKey: 'model.primary', kind: 'MODEL_CALL', state: 'SUCCEEDED', inputFingerprint: 'f', attempts: 1 } }),
      /brain_job_steps_shape/,
      'a finished step carries its checkpoint',
    );
    await check(
      prisma.aiControl.create({ data: { controlKey: 'ORGANIZATION|x|y', version: 1, scope: 'ORGANIZATION', organizationId: a.organizationId, value: b.organizationId, state: 'KILLED', reason: 'r', actorKind: 'HUMAN', actorUserId: a.userId, recordedAt: now } }),
      /ai_controls_shape/,
      'an organization cannot control another',
    );
    await check(
      prisma.aiControl.create({ data: { controlKey: 'GLOBAL|-|-', version: 1, scope: 'GLOBAL', state: 'KILLED', reason: 'r', actorKind: 'ENVIRONMENT', actorReference: 'LOOP_AI_ENABLED', recordedAt: now } }),
      /ai_controls_shape/,
      'configuration is never a control actor',
    );
    await check(
      prisma.aiInvocation.create({
        data: {
          organizationId: a.organizationId, invocationId: 'unrelated-key', taskId: 't', taskVersion: '1', profile: 'TECHNICAL_ANALYSIS',
          providerId: 'p', requestedModelId: 'm', routingPolicyVersion: 'r', templateId: 't', templateVersion: '1', contextManifestHash: 'h',
          contextSourceCount: 0, outcome: 'IN_FLIGHT', rejectionCodes: [], businessDate: new Date('2026-09-17T00:00:00Z'),
          brainJobId: jobId, brainStepKey: 'model.primary',
        },
        select: { id: true },
      }),
      /ai_invocations_brain_call/,
      "a Brain call's ledger key is the one its job and step derive",
    );
    const ledger = new AiUsageLedgerRepository(prisma);
    assert.equal(
      await ledger.reserve(a.organizationId, {
        invocationId: `${jobId}:model.primary:1`, principalUserId: a.userId, taskId: 't', taskVersion: '1', capabilityRoute: 'TECHNICAL_ANALYSIS',
        providerId: 'p', requestedModelId: 'm', routingPolicyVersion: 'r', specializationPolicyVersion: 'specialization.test.1', templateId: 't', templateVersion: '1',
        contextSourceRefs: [], estimatedInputTokens: 1, estimatedOutputTokens: 1, estimatedCostMicros: null, unitCostBasis: null,
        businessDate: '2026-09-17', requestedAt: now, brainJobId: jobId, brainStepKey: 'model.primary',
      }),
      true,
    );
    // A legacy-shaped row, with none of the new columns, is still accepted as before.
    assert.equal(
      await ledger.reserve(a.organizationId, {
        invocationId: 'legacy-call-1', principalUserId: a.userId, taskId: 'case.explanation', taskVersion: '2.0.0', capabilityRoute: 'TECHNICAL_ANALYSIS',
        providerId: 'p', requestedModelId: 'm', routingPolicyVersion: 'r', templateId: 't', templateVersion: '1', contextSourceRefs: [],
        estimatedInputTokens: 1, estimatedOutputTokens: 1, estimatedCostMicros: null, unitCostBasis: null, businessDate: '2026-09-17', requestedAt: now,
      }),
      true,
    );

    // A principal cannot be deleted out from under their jobs.
    await check(prisma.user.delete({ where: { id: a.userId } }), /Foreign key constraint|violates/i, 'the principal stays while their jobs exist');
  } finally {
    await cleanup(prisma, [a.organizationId, b.organizationId]);
    const leftovers = await prisma.brainJob.count({ where: { organizationId: { in: [a.organizationId, b.organizationId] } } });
    assert.equal(leftovers, 0, 'deleting the organization removed its jobs, histories, events, commands, waits and ledger rows');
    assert.equal(await prisma.aiInvocation.count({ where: { organizationId: a.organizationId } }), 0);
    await prisma.$disconnect();
  }
});

test('real Postgres: concurrent writers settle on one job, one reply, one command, one lease, one control', { skip }, async () => {
  const clients = Array.from({ length: 6 }, () => new PrismaClient({ datasources: { db: { url: URL } } }));
  const setup = clients[0]!;
  const a = await tenant(setup, 'race');
  const repos = <T>(make: (p: PrismaClient) => T) => clients.map(make);
  const all = <T>(n: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
  try {
    const jobs = repos((p) => new BrainJobRepository(p));
    const same = submission();
    const accepted = await all(12, (i) => jobs[i % clients.length]!.accept(a.organizationId, { principalUserId: a.userId, task: TASK, submission: same }));
    const ids = new Set(accepted.map((r) => (r.kind === 'REFUSED' ? r.refusal : r.job.jobId)));
    assert.equal(ids.size, 1, `one job for one request: ${[...ids]}`);
    assert.equal(accepted.filter((r) => r.kind === 'ACCEPTED').length, 1);
    const jobId = [...ids][0]!;
    assert.equal(await setup.brainJob.count({ where: { organizationId: a.organizationId } }), 1);
    assert.equal(await setup.brainCommand.count({ where: { organizationId: a.organizationId, jobId, type: 'START' } }), 1);

    const dispatched = await all(12, (i) => jobs[i % clients.length]!.transition(a.organizationId, jobId, { type: 'DISPATCHED' }, { context: CTX }));
    assert.equal(dispatched.filter((r) => r.ok).length, 1, 'one writer moves the job');
    for (const r of dispatched) if (!r.ok) assert.ok(['VERSION_CONFLICT', 'EVENT_NOT_ALLOWED_IN_STATE'].includes(r.refusal), r.refusal);
    assert.equal(await setup.brainJobTransition.count({ where: { jobId, kind: 'DISPATCHED' } }), 1);

    await jobs[0]!.transition(a.organizationId, jobId, { type: 'STARTED' }, { context: CTX });
    const leases = await all(12, (i) => jobs[i % clients.length]!.lease(a.organizationId, jobId, { holder: `worker-${i}`, generation: 1, durationMs: 60_000 }));
    assert.equal(leases.filter((r) => r.ok).length, 1, 'one lease holder');

    const holder = (await jobs[0]!.get(a.organizationId, jobId))!.lease!.holder;
    const waits = repos((p) => new BrainWaitRepository(p));
    const opened = await waits[0]!.open(a.organizationId, jobId, {
      question: { schemaId: 'c', schemaVersion: '1', body: { q: 1 } },
      expiresAt: new Date(Date.now() + 3_600_000),
      context: CTX,
      leaseHolder: holder,
    });
    const waitId = (opened as any).waitId as string;
    const answers = await all(12, (i) => waits[i % clients.length]!.answer(a.organizationId, { waitId, responderUserId: a.userId, reply: { pick: 'x' } }));
    assert.equal(answers.filter((r) => r.ok && r.recorded === 'NOW').length, 1, 'one accepted reply');
    for (const r of answers) if (!r.ok) assert.equal(r.refusal, 'REPLY_CONFLICT');
    assert.equal(await setup.brainCommand.count({ where: { organizationId: a.organizationId, jobId, type: 'RESUME' } }), 1);
    const conflicting = await all(6, (i) => waits[i % clients.length]!.answer(a.organizationId, { waitId, responderUserId: a.userId, reply: { pick: `other-${i}` } }));
    assert.ok(conflicting.every((r) => !r.ok && r.refusal === 'WAIT_ALREADY_ANSWERED'));

    await waits[0]!.resume(a.organizationId, jobId, { waitId, responderPermitted: true });
    const cancels = await all(12, (i) =>
      jobs[i % clients.length]!.requestCancel(a.organizationId, jobId, { actor: { kind: 'HUMAN', userId: i % 2 ? a.userId : a.otherUserId }, reason: 'REQUESTED_BY_ADMINISTRATOR' }),
    );
    for (const r of cancels) if (!r.ok) assert.equal(r.refusal, 'VERSION_CONFLICT');
    const retried = await jobs[0]!.requestCancel(a.organizationId, jobId, { actor: { kind: 'HUMAN', userId: a.userId }, reason: 'REQUESTED_BY_PRINCIPAL' });
    assert.equal(retried.ok, true, 'a retried request finds the stored one');
    assert.equal(await setup.brainCommand.count({ where: { organizationId: a.organizationId, jobId, type: 'CANCEL' } }), 1, 'one CANCEL per generation');
    assert.equal(await setup.brainJobTransition.count({ where: { jobId, kind: 'CANCEL_REQUESTED' } }), 1);

    const controls = repos((p) => new AiControlRepository(p));
    const appended = await all(12, (i) =>
      controls[i % clients.length]!.recordOrganizationControl(a.organizationId, { scope: 'ORGANIZATION', state: 'ACTIVE', reason: `writer ${i}`, expectedVersion: 0, actorUserId: a.userId }),
    );
    assert.equal(appended.filter((r) => r.ok && r.result === 'APPENDED').length, 1, 'one version 1');
    for (const r of appended) if (!r.ok) assert.equal(r.refusal, 'STALE');
    assert.equal(await setup.aiControl.count({ where: { organizationId: a.organizationId } }), 1);
  } finally {
    await cleanup(setup, [a.organizationId]);
    await Promise.all(clients.map((c) => c.$disconnect()));
  }
});

test('real Postgres: a transaction that fails leaves no transition, event or state change behind', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const a = await tenant(prisma, 'rollback');
  try {
    const jobs = new BrainJobRepository(prisma);
    const out = await jobs.accept(a.organizationId, { principalUserId: a.userId, task: TASK, submission: submission() });
    const jobId = (out as any).job.jobId as string;
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        const t = await applyBrainJobTransition(tx, a.organizationId, jobId, {
          event: { type: 'CANCEL_REQUESTED', request: { actor: { kind: 'HUMAN', userId: a.userId }, reason: 'REQUESTED_BY_PRINCIPAL' } },
          context: CTX,
          actor: { kind: 'HUMAN', userId: a.userId },
          now: new Date(),
        });
        assert.equal(t.ok, true);
        throw new Error('the command could not be stored');
      }),
      /could not be stored/,
    );
    const record = (await jobs.get(a.organizationId, jobId))!;
    assert.equal(record.job.state, 'ACCEPTED');
    assert.equal(record.job.cancelRequest, null);
    assert.equal(record.version, 0);
    assert.equal(await prisma.brainJobTransition.count({ where: { jobId } }), 1);
    assert.equal(await prisma.brainEvent.count({ where: { jobId } }), 1);
  } finally {
    await cleanup(prisma, [a.organizationId]);
    await prisma.$disconnect();
  }
});

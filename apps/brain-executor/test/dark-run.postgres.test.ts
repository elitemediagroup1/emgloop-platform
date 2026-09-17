// The dark runner against real Postgres, as the restricted Brain roles (B6).
//
// OPT-IN AND LOCAL ONLY: runs only when LOOP_TEST_POSTGRES_URL points at localhost, on a
// database migrated to the current schema. It applies the reviewed roles script
// (scripts/operations/brain-database-roles.sql), then drives real jobs with the
// dispatcher, worker and sweeper each connected as its own role -- proving the grants
// cover everything revision 1 does, with nothing extra. Loop's side (the Brain API and
// the internal API) uses the owner connection, as the web tier does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { AI_TASK_CASE_EXPLANATION, type BrainAdvanceMessage } from '@emgloop/shared';
import { AI_PROVIDER_SPECIALIZATION_POLICY } from '@emgloop/providers';

import { IamRepository } from '../../../packages/database/src/repositories/iam.repository';
import { BrainJobRepository } from '../../../packages/database/src/repositories/brain/brain-job.repository';
import { BrainExecutionReferences } from '../../../packages/database/src/repositories/brain/brain-execution-references';
import { iamAiAuthorizer } from '../../../packages/database/src/services/ai-runtime/authorizer';
import { BrainWorkService } from '../../../packages/database/src/services/brain/brain-work.service';
import { BrainExecutorStore } from '../../../packages/database/src/services/brain/brain-executor-store';
import { BrainInternalService } from '../../../packages/database/src/services/brain/brain-internal.service';
import { AesGcmBrainPayloadSealer } from '../../../packages/database/src/services/brain/brain-payload-sealer';
import { brainSubjectHref } from '../../../packages/database/src/services/brain/brain-subjects';

import { dispatch } from '../src/dispatcher';
import { sweep } from '../src/sweeper';
import { advanceJob } from '../src/worker';
import { createLoopClient } from '../src/loop-client';
import { memoryLogger } from '../src/log';
import { loopStandIn, WORKER_ISSUER, WORKER_SUBJECT } from './loop-stand-in';
import { contextFor, memoryQueues, REVIEW, ROUTING, testSigner } from './world';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;
const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'operations', 'brain-database-roles.sql');

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

test('real Postgres: the dark runner does its whole job as the restricted roles', { skip }, async () => {
  const owner = new PrismaClient({ datasources: { db: { url: URL } } });
  const clients: PrismaClient[] = [owner];
  const as = (role: string, password: string) => {
    const url = new globalThis.URL(URL);
    url.username = role;
    url.password = password;
    const c = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    clients.push(c);
    return c;
  };
  try {
    const passwords = Object.fromEntries(['loop_brain_worker', 'loop_brain_dispatcher', 'loop_brain_sweeper'].map((r) => [r, randomBytes(18).toString('hex')]));
    for (const stmt of statements(readFileSync(SCRIPT, 'utf8'))) await owner.$executeRawUnsafe(stmt);
    for (const [role, password] of Object.entries(passwords)) await owner.$executeRawUnsafe(`ALTER ROLE ${role} PASSWORD '${password}'`);
    const worker = as('loop_brain_worker', passwords.loop_brain_worker!);
    const dispatcherDb = as('loop_brain_dispatcher', passwords.loop_brain_dispatcher!);
    const sweeperDb = as('loop_brain_sweeper', passwords.loop_brain_sweeper!);

    const org = `org_b6_${randomUUID()}`;
    const relationship = `rel_b6_${randomUUID().slice(0, 8)}`;
    await owner.organization.create({ data: { id: org, name: 'B6 dark run', slug: org } });
    const iam = new IamRepository(owner);
    const manager = await iam.createUser({ organizationId: org, email: `${org}@example.test`, systemRole: 'MANAGER', name: 'B6' });
    await iam.activateUser(org, manager.id);
    const principal = { organizationId: org, userId: manager.id };

    let clockMs = Date.now();
    const now = () => new Date(clockMs);
    const internal = new BrainInternalService(owner, {
      authorize: iamAiAuthorizer(owner),
      tasks: [AI_TASK_CASE_EXPLANATION, REVIEW],
      contexts: { [REVIEW.taskId]: async ({ job }) => contextFor(job, `relationship:${relationship}`) },
      readInput: (o, j) => new BrainJobRepository(owner).input(o, j),
      now,
    });
    const work = new BrainWorkService(owner, {
      authorize: iamAiAuthorizer(owner),
      controlFloor: () => ({ activation: { enabled: false, organizations: [], tasks: [], providers: [] }, killSwitches: [] }),
      routing: ROUTING,
      specialization: AI_PROVIDER_SPECIALIZATION_POLICY,
      tasks: [AI_TASK_CASE_EXPLANATION, REVIEW],
      subjects: { exists: async () => true, href: brainSubjectHref },
      ring: async () => 'NOT_CONFIGURED',
      now,
    });

    const signer = testSigner();
    const loopCalls: { purpose: string; status: number }[] = [];
    const loop = createLoopClient(
      { baseUrl: 'http://127.0.0.1:3999', issuer: WORKER_ISSUER, subject: WORKER_SUBJECT },
      {
        signer,
        fetch: loopStandIn({ prisma: owner, internal, keys: new Map([[signer.keyId, signer.publicKey]]), nowSeconds: () => Math.floor(clockMs / 1000), calls: loopCalls as never }),
        nowSeconds: () => Math.floor(clockMs / 1000),
      },
    );
    const sealer = new AesGcmBrainPayloadSealer('test/pg-key:v1', randomBytes(32));
    const queues = memoryQueues();
    const switches = { enabled: true };
    const workerDeps = (holder: string) => ({
      store: new BrainExecutorStore(worker),
      loop,
      sealers: { current: async () => sealer, forKeyRef: async (k: string) => (k === 'test/pg-key:v1' ? sealer : null) },
      queues,
      switches: { workerEnabled: async () => switches.enabled, aiFloor: async () => ({ activation: { enabled: false, organizations: [], tasks: [], providers: [] }, killSwitches: [] }) },
      tasks: [AI_TASK_CASE_EXPLANATION, REVIEW],
      holder,
      leaseMs: 60_000,
      now,
      log: memoryLogger(),
      mode: 'DARK' as const,
    });
    const dispatcherDeps = { store: new BrainExecutorStore(dispatcherDb), queues, trust: { trustedIssuers: [], trustedCallers: [] }, now, log: memoryLogger() };
    const drain = async (holder = 'worker-pg') => {
      const out: string[] = [];
      for (let next = queues.take(); next; next = queues.take()) out.push(await advanceJob(next.message as BrainAdvanceMessage, workerDeps(holder)));
      return out;
    };
    // The Brain API accepts work (owner connection; controls are exercised elsewhere).
    const accept = async (key: string, input: Record<string, boolean> = {}) => {
      const out = await new BrainJobRepository(owner).accept(org, {
        principalUserId: manager.id,
        task: { taskId: REVIEW.taskId, version: REVIEW.version, capabilityRoute: REVIEW.capabilityRoute, resultType: REVIEW.resultType, resultOwner: REVIEW.resultOwner, executionClasses: REVIEW.execution.classes },
        submission: { taskId: REVIEW.taskId, subject: { type: 'RELATIONSHIP', id: relationship }, executionClass: 'DURABLE', idempotencyKey: `idem-${key}-${randomUUID()}`, input },
        now: now(),
      });
      assert.equal(out.kind, 'ACCEPTED');
      return out as Extract<typeof out, { kind: 'ACCEPTED' }>;
    };
    const jobRow = (id: string) => owner.brainJob.findUniqueOrThrow({ where: { id } });

    // 1. Ask, wait, answer, resume, reach the boundary.
    const asked = await accept('ask', { darkAskQuestion: true });
    assert.equal(await dispatch({ kind: 'RECOVERY', commandId: asked.commandId }, dispatcherDeps), 'DISPATCHED');
    assert.deepEqual(await drain(), ['WAITING']);
    const waiting = await jobRow(asked.job.jobId);
    assert.equal(waiting.state, 'WAITING_FOR_USER');
    assert.equal(waiting.leaseHolder, null);
    const answered = await work.respond(principal, waiting.currentWaitId!, { kind: 'CONFIRM', confirmed: true });
    assert.equal(answered.ok, true);
    const resumeCommand = await owner.brainCommand.findFirstOrThrow({ where: { jobId: asked.job.jobId, type: 'RESUME' } });
    assert.equal(await dispatch({ kind: 'RECOVERY', commandId: resumeCommand.id }, dispatcherDeps), 'DISPATCHED');
    assert.deepEqual(await drain(), ['FAILED']);
    const finished = await jobRow(asked.job.jobId);
    assert.equal(finished.state, 'FAILED');
    assert.equal(finished.endReason, 'COMMIT_REFUSED');
    const steps = await owner.brainJobStep.findMany({ where: { jobId: asked.job.jobId }, orderBy: { stepKey: 'asc' } });
    assert.deepEqual(
      steps.map((s) => [s.stepKey, s.state, s.lastFailureClass]),
      [
        ['commit.result', 'FAILED', 'OWNER_GATE_UNAVAILABLE'],
        ['context.load', 'SUCCEEDED', null],
        ['dark.clarify', 'SUCCEEDED', null],
        ['dark.probe', 'SUCCEEDED', null],
      ],
    );
    assert.equal(await owner.aiInvocation.count({ where: { organizationId: org } }), 0, 'no provider call');
    assert.ok((await owner.brainCommand.findUniqueOrThrow({ where: { id: resumeCommand.id } })).dispatchedAt, 'the dispatcher recorded the hand-over');

    // 2. The worker switch stops accepted work, as a named policy.
    const stopped = await accept('stop');
    switches.enabled = false;
    await dispatch({ kind: 'RECOVERY', commandId: stopped.commandId }, dispatcherDeps);
    assert.deepEqual(await drain(), ['STOPPED']);
    assert.equal((await jobRow(stopped.job.jobId)).endReason, 'KILL_SWITCH');
    switches.enabled = true;

    // 3. The sweeper, reading only, finds a lost ring, an expired question and a dead worker's lease.
    const lost = await accept('lost');
    const expiring = await accept('expire', { darkAskQuestion: true });
    await dispatch({ kind: 'RECOVERY', commandId: expiring.commandId }, dispatcherDeps);
    assert.deepEqual(await drain(), ['WAITING']);
    const dead = await accept('dead');
    const deadRef = (await new BrainExecutionReferences(worker).resolveJob({ jobId: dead.job.jobId, generation: 1 }))!;
    assert.equal((await new BrainExecutorStore(worker).claim(deadRef, 'worker-died', 1_000, now())).ok, true);
    await dispatchedDirectly(owner, dead.commandId, now());

    clockMs += REVIEW.execution.durable!.maxUserWaitMs! + 60_000;
    const recovered: string[] = [];
    const summary = await sweep({
      refs: new BrainExecutionReferences(sweeperDb),
      dispatcher: { recover: async (commandId) => void recovered.push(await dispatch({ kind: 'RECOVERY', commandId }, dispatcherDeps)) },
      queues,
      now,
      log: memoryLogger(),
      limit: 500,
    });
    assert.ok(summary.recovered >= 1 && recovered.includes('DISPATCHED'), JSON.stringify(summary));
    assert.ok(summary.timers >= 1);
    assert.ok(summary.takeovers >= 1);
    const outcomes = await drain('worker-pg-2');
    assert.ok(outcomes.includes('EXPIRED'), outcomes.join(','));
    assert.equal((await jobRow(expiring.job.jobId)).endReason, 'WAIT_EXPIRED');
    assert.equal((await jobRow(lost.job.jobId)).endReason, 'COMMIT_REFUSED');
    assert.equal((await jobRow(dead.job.jobId)).endReason, 'COMMIT_REFUSED', 'a dead worker’s job was taken over');
    assert.equal(summary.errors, 0);
  } finally {
    await Promise.all(clients.map((c) => c.$disconnect()));
  }
});

/** The dead worker's START was consumed before it died: mark it dispatched as the dispatcher would have. */
async function dispatchedDirectly(owner: PrismaClient, commandId: string, at: Date) {
  await owner.brainCommand.update({ where: { id: commandId }, data: { dispatchedAt: at, lastDispatchedAt: at, dispatchCount: 1 } });
}

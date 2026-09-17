// The Loop-side Brain boundary (B5), against the in-memory Prisma double.
//
// WHAT THESE PROVE
//
// A PERSON STARTS WORK ONLY AS THEMSELVES, IN THEIR OWN ORGANIZATION. The organization is
// the principal's; a body naming another is refused. Whether they may run the task is
// decided before any control, route or subject is read, and a refusal writes nothing.
//
// OFF IS OFF. The deployment floor AND the recorded controls must both enable the work; a
// kill stops it; a route that no longer honours the specialization policy stops it.
//
// ACCEPTING IS RECORDING. A submission is a job and a START command in Neon before the
// doorbell rings; the same submission is the same job; a lost ring loses nothing.
//
// A JOB IS VISIBLE TO WHOEVER STARTED IT. Status, question and answer are the principal's;
// anyone else is told it does not exist. Work about a subject shows only its state, and
// only to people who may run its task.
//
// STOPPING IS AUTHORIZED, DURABLE, IDEMPOTENT AND VISIBLE TO THE EXECUTOR.
//
// THE EXECUTOR'S SURFACE IS NARROW, AND LOOP'S ANSWERS COME FROM THE JOB. Access is
// re-decided on every call; context is assembled for the job's principal; a commit is
// checked against evidence Loop re-assembles, and lands only through an owner's gate.
//
// END TO END, WITHOUT A PROVIDER. A test-only reference executor drives accepted work
// through context, a stub step, a checkpoint and an owner's commit, through a question
// and its answer, and through cancellation -- with no model, no network, no credential.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  AI_TASK_CASE_EXPLANATION,
  brainEvidenceRefsOf,
  type AiControlFloor,
  type AiRoutingPolicy,
  type AiTaskDefinition,
  type BrainResultEnvelope,
  type BrainTransitionContext,
} from '@emgloop/shared';
import { AI_BUDGET_POLICY, AI_PROVIDER_SPECIALIZATION_POLICY, AI_ROUTING_POLICY } from '@emgloop/providers';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository } from '../src/repositories/iam.repository';
import { AiControlRepository } from '../src/repositories/brain/ai-control.repository';
import { BrainJobRepository } from '../src/repositories/brain/brain-job.repository';
import { BrainExecutionReferences } from '../src/repositories/brain/brain-execution-references';
import { BrainEventActivityAdapter, brainEventTitle } from '../src/repositories/activity/brain-event.adapter';
import { iamAiAuthorizer } from '../src/services/ai-runtime/authorizer';
import { BrainWorkService, brainWorkPhase, type BrainWorkDeps, type BrainWorkPrincipal } from '../src/services/brain/brain-work.service';
import { BrainExecutorStore, type BrainExecutorJob } from '../src/services/brain/brain-executor-store';
import {
  BrainInternalService,
  type BrainContextAssembler,
  type BrainResultOwnerGate,
  type BrainTaskContext,
} from '../src/services/brain/brain-internal.service';
import { PrismaBrainSubjectResolver, brainSubjectHref, type BrainSubjectResolver } from '../src/services/brain/brain-subjects';
import { AesGcmBrainPayloadSealer, BrainPayloadUnopenable } from '../src/services/brain/brain-payload-sealer';
import { brainSealedPayloadRefusals } from '../src/repositories/brain/brain-records';

const ORG = 'org_boundary_a';
const OTHER = 'org_boundary_b';
const T0 = new Date('2026-09-17T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

// A durable task that may ask a question, for this test only. Case Explanation is the
// only registered task and is interactive only.
const REVIEW: AiTaskDefinition = Object.freeze({
  ...AI_TASK_CASE_EXPLANATION,
  taskId: 'test.relationship-review',
  version: '1.0.0',
  resultOwner: Object.freeze({ authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP' } as const),
  execution: Object.freeze({
    classes: Object.freeze(['INTERACTIVE', 'DURABLE'] as const),
    interactive: Object.freeze({ presentationBudgetMs: 10_000, executionDeadlineMs: 30_000, streaming: 'NONE' } as const),
    durable: Object.freeze({ executionDeadlineMs: 3_600_000, maxUserWaitMs: 86_400_000 }),
  }),
  invokerRoles: Object.freeze(['OWNER', 'ADMIN', 'MANAGER']),
  requires: Object.freeze([{ resource: 'commercialIntelligence', action: 'view' } as const]),
  outputSchemaId: 'relationship-review.v1',
}) as AiTaskDefinition;
const TASKS = [AI_TASK_CASE_EXPLANATION, REVIEW];

const ROUTING: AiRoutingPolicy = {
  version: AI_ROUTING_POLICY.version,
  tasks: {
    ...AI_ROUTING_POLICY.tasks,
    [REVIEW.taskId]: { ...AI_ROUTING_POLICY.tasks['case.explanation']!, taskId: REVIEW.taskId, taskVersion: REVIEW.version },
  },
};
const PRIMARY_PROVIDER = AI_ROUTING_POLICY.tasks['case.explanation']!.primary.providerId;

const FLOOR_ON: AiControlFloor = {
  activation: { enabled: true, organizations: [ORG, OTHER], tasks: TASKS.map((t) => t.taskId), providers: [PRIMARY_PROVIDER] },
  killSwitches: [],
};
const FLOOR_OFF: AiControlFloor = { activation: { enabled: false, organizations: [], tasks: [], providers: [] }, killSwitches: [] };

const DURABLE_CTX: BrainTransitionContext = { supportsDurable: true, taskMayWait: true };

const SUBJECTS = {
  [ORG]: { CASE: 'case_boundary_1', RELATIONSHIP: 'rel_boundary_1' },
  [OTHER]: { CASE: 'case_boundary_9', RELATIONSHIP: 'rel_boundary_9' },
} as const;

/** Subjects that exist, per organization, with every lookup recorded. */
function subjectResolver(log: string[]): BrainSubjectResolver {
  return {
    async exists(organizationId, subject) {
      log.push(`subject:${organizationId}:${subject.type}:${subject.id}`);
      const known = (SUBJECTS as Record<string, Record<string, string>>)[organizationId];
      return known?.[subject.type] === subject.id;
    },
    href: brainSubjectHref,
  };
}

async function world() {
  const fake: any = makeCognitivePrisma({
    also: [
      'organization',
      'invitation',
      'organizationMembership',
      'permission',
      'aiInvocation',
      'brainJob',
      'brainJobTransition',
      'brainJobStep',
      'brainJobWait',
      'brainCommand',
      'brainEvent',
      'aiControl',
      'aiControlCurrent',
      'crmRelationship',
      'conversation',
    ],
  });
  let seq = 0;
  for (const name of ['brainJob', 'brainCommand']) {
    const create = fake[name].create.bind(fake[name]);
    fake[name].create = ({ data, ...rest }: { data: Record<string, unknown> }) =>
      create({ data: { id: `c${name.slice(5, 8).toLowerCase()}${String(++seq).padStart(20, '0')}`, ...data }, ...rest });
  }
  fake.organization.__rows.push({ id: ORG, name: 'A', timezone: 'UTC' }, { id: OTHER, name: 'B', timezone: 'UTC' });
  const prisma = fake as PrismaClient;
  const iam = new IamRepository(prisma);
  const hire = async (role: string, org = ORG): Promise<BrainWorkPrincipal> => {
    const u = await iam.createUser({ organizationId: org, email: `${role.toLowerCase()}-${++seq}@boundary.test`, systemRole: role, name: role });
    await iam.activateUser(org, u.id);
    return { organizationId: org, userId: u.id };
  };
  const people = {
    owner: await hire('OWNER'),
    admin: await hire('ADMIN'),
    manager: await hire('MANAGER'),
    employee: await hire('EMPLOYEE'),
    outsider: await hire('OWNER', OTHER),
  };

  const controls = new AiControlRepository(prisma);
  for (const [scope, value] of [
    ['GLOBAL', null],
    ['TASK', AI_TASK_CASE_EXPLANATION.taskId],
    ['TASK', REVIEW.taskId],
    ['PROVIDER', PRIMARY_PROVIDER],
  ] as const) {
    const out = await controls.recordPlatformControl({ scope, value, state: 'ACTIVE', reason: 'test enablement', expectedVersion: 0, operationsReference: 'test-run-1', now: T0 });
    assert.equal(out.ok, true, `${scope} ${JSON.stringify(out)}`);
  }
  for (const [org, actor] of [
    [ORG, people.owner.userId],
    [OTHER, people.outsider.userId],
  ] as const) {
    const out = await controls.recordOrganizationControl(org, { scope: 'ORGANIZATION', state: 'ACTIVE', reason: 'test enablement', expectedVersion: 0, actorUserId: actor, now: T0 });
    assert.equal(out.ok, true, JSON.stringify(out));
  }

  const log: string[] = [];
  const rings: string[] = [];
  const unstoredRings: string[] = [];
  let floor = FLOOR_ON;
  let clock = at(0);
  const authorize = iamAiAuthorizer(prisma);
  const deps: BrainWorkDeps = {
    authorize: async (principal, task) => {
      log.push(`authorize:${principal.userId}:${task.taskId}`);
      return authorize(principal, task);
    },
    controlFloor: () => {
      log.push('controls');
      return floor;
    },
    routing: ROUTING,
    specialization: AI_PROVIDER_SPECIALIZATION_POLICY,
    tasks: TASKS,
    subjects: subjectResolver(log),
    ring: async (commandId) => {
      // Recorded, not asserted: the service swallows a throwing ring by design. Every
      // test checks `unstoredRings` is empty -- a ring for a command not yet committed.
      if (!fake.brainCommand.__rows.some((c: any) => c.id === commandId)) unstoredRings.push(commandId);
      rings.push(commandId);
      return 'RUNG';
    },
    now: () => clock,
  };
  const work = new BrainWorkService(prisma, deps);
  const executor = new BrainExecutorStore(prisma);
  return {
    fake,
    prisma,
    iam,
    people,
    controls,
    log,
    rings,
    unstoredRings,
    deps,
    work,
    executor,
    jobs: new BrainJobRepository(prisma),
    setFloor: (f: AiControlFloor) => {
      floor = f;
    },
    tick: (seconds: number) => {
      clock = at(seconds);
    },
    written: () => fake.brainJob.__rows.length + fake.brainCommand.__rows.length + fake.brainEvent.__rows.length,
  };
}

type World = Awaited<ReturnType<typeof world>>;

const caseSubmission = (over: Record<string, unknown> = {}) => ({
  taskId: 'case.explanation',
  subject: { type: 'CASE', id: SUBJECTS[ORG].CASE },
  executionClass: 'INTERACTIVE',
  idempotencyKey: 'idem-case-0001',
  input: {},
  ...over,
});

const reviewSubmission = (over: Record<string, unknown> = {}) => ({
  taskId: REVIEW.taskId,
  subject: { type: 'RELATIONSHIP', id: SUBJECTS[ORG].RELATIONSHIP },
  executionClass: 'DURABLE',
  idempotencyKey: 'idem-review-0001',
  input: { horizonDays: 90 },
  ...over,
});

async function submitted(w: World, principal: BrainWorkPrincipal, raw: unknown) {
  const out = await w.work.submit(principal, raw);
  assert.equal(out.kind, 'ACCEPTED', JSON.stringify(out));
  assert.deepEqual(w.unstoredRings, [], 'a ring always follows its stored command');
  return (out as Extract<typeof out, { kind: 'ACCEPTED' }>).work;
}

function jobRef(organizationId: string, jobId: string): BrainExecutorJob {
  return { organizationId, jobId, generation: 1 };
}

/** Move accepted work to RUNNING the way an executor does: via its command. */
async function started(w: World, organizationId: string, jobId: string, ctx: BrainTransitionContext = DURABLE_CTX) {
  const job = jobRef(organizationId, jobId);
  assert.equal((await w.executor.transition(job, { type: 'DISPATCHED' }, { context: ctx, now: at(1) })).ok, true);
  const claim = await w.executor.claim(job, 'worker-test-1', 60_000, at(2));
  assert.equal(claim.ok, true, JSON.stringify(claim));
  const moved = await w.executor.transition(job, { type: 'STARTED' }, { context: ctx, holder: 'worker-test-1', now: at(2) });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  return job;
}

const QUESTION = {
  kind: 'CHOOSE_ONE',
  prompt: 'Two relationships match. Which one did you mean?',
  options: [
    { id: 'a', label: 'Acme Plumbing (buyer)', ref: 'relationship:rel_boundary_1' },
    { id: 'b', label: 'Acme Plumbing (vendor)', ref: 'relationship:rel_boundary_2' },
  ],
};

// --- Submission -----------------------------------------------------------------------

test('work is started as the signed-in person, in their organization, and a body cannot say otherwise', async () => {
  const w = await world();
  const view = await submitted(w, w.people.owner, caseSubmission());
  const record = await w.jobs.get(ORG, view.jobId);
  assert.equal(record!.job.organizationId, ORG);
  assert.equal(record!.job.principalUserId, w.people.owner.userId);
  assert.equal(record!.job.executionClass, 'INTERACTIVE');
  assert.equal(record!.job.resultType, 'ANALYSIS', 'the semantic result type is its own declaration');
  assert.equal(record!.job.capabilityRoute, 'TECHNICAL_ANALYSIS');
  assert.equal(view.phase, 'QUEUED');
  assert.equal(view.subject.href, `/app/admin/cases/${SUBJECTS[ORG].CASE}`);
  const start = w.fake.brainCommand.__rows.find((c: any) => c.jobId === view.jobId && c.type === 'START');
  assert.deepEqual(w.rings, [start.id], 'the doorbell rang once, for the stored START command');
  assert.deepEqual(w.unstoredRings, [], 'never before the command was committed');

  const before = w.written();
  for (const smuggled of [
    { organizationId: OTHER },
    { principalUserId: w.people.outsider.userId },
    { role: 'OWNER' },
    { input: { organizationId: OTHER } },
    { provider: 'anthropic' },
  ]) {
    const out = await w.work.submit(w.people.owner, caseSubmission({ idempotencyKey: 'idem-smuggle-1', ...smuggled }));
    assert.deepEqual(out, { kind: 'REFUSED', refusal: 'INVALID_SUBMISSION' }, JSON.stringify(smuggled));
  }
  // Another organization's subject is simply not there for this person.
  const foreign = await w.work.submit(w.people.owner, caseSubmission({ idempotencyKey: 'idem-foreign-1', subject: { type: 'CASE', id: SUBJECTS[OTHER].CASE } }));
  assert.deepEqual(foreign, { kind: 'REFUSED', refusal: 'SUBJECT_NOT_FOUND' });
  assert.equal(w.written(), before, 'nothing was written');
});

test('whether a person may run the task is decided before anything else is read', async () => {
  const w = await world();
  for (const who of [w.people.employee, w.people.manager]) {
    w.log.length = 0;
    const out = await w.work.submit(who, caseSubmission());
    assert.deepEqual(out, { kind: 'REFUSED', refusal: 'NOT_PERMITTED' });
    assert.deepEqual(w.log, [`authorize:${who.userId}:case.explanation`], 'no control, route or subject was consulted');
  }
  // A MANAGER may run the review task; the same person, the same gate.
  w.log.length = 0;
  await submitted(w, w.people.manager, reviewSubmission());
  assert.deepEqual(w.log.slice(0, 2), [`authorize:${w.people.manager.userId}:${REVIEW.taskId}`, 'controls']);
  assert.equal(w.log.at(-1), `subject:${ORG}:RELATIONSHIP:${SUBJECTS[ORG].RELATIONSHIP}`, 'the subject is read last');

  // A person of another organization cannot reach this one's work by naming it.
  w.log.length = 0;
  const cross = await w.work.submit({ organizationId: ORG, userId: w.people.outsider.userId }, caseSubmission({ idempotencyKey: 'idem-cross-1' }));
  assert.equal(cross.kind, 'REFUSED');
  assert.ok(!w.log.some((l) => l.startsWith('subject:')), 'no subject was read');

  // A disabled member is refused at the same gate, and so is a failing authorizer.
  await w.iam.disableUser(ORG, w.people.admin.userId);
  w.log.length = 0;
  assert.deepEqual(await w.work.submit(w.people.admin, caseSubmission({ idempotencyKey: 'idem-disabled' })), { kind: 'REFUSED', refusal: 'NOT_PERMITTED' });
  assert.deepEqual(w.log, [`authorize:${w.people.admin.userId}:case.explanation`]);
  const exploding = new BrainWorkService(w.prisma, { ...w.deps, authorize: async () => { throw new Error('iam down'); } });
  assert.deepEqual(await exploding.submit(w.people.owner, caseSubmission({ idempotencyKey: 'idem-explode' })), { kind: 'REFUSED', refusal: 'NOT_PERMITTED' });
  assert.deepEqual(await w.work.submit(w.people.owner, caseSubmission({ taskId: 'no.such-task' })), { kind: 'REFUSED', refusal: 'UNKNOWN_TASK' });
});

test('work runs only where the deployment floor AND the recorded controls both allow it', async () => {
  const w = await world();
  const refusal = async (key: string) => {
    const out = await w.work.submit(w.people.owner, caseSubmission({ idempotencyKey: key }));
    return out.kind === 'REFUSED' ? out.refusal : out.kind;
  };
  w.setFloor(FLOOR_OFF);
  assert.equal(await refusal('idem-control-c1'), 'NOT_ENABLED', 'the floor is off');
  w.setFloor({ ...FLOOR_ON, activation: { ...FLOOR_ON.activation, providers: [] } });
  assert.equal(await refusal('idem-control-c2'), 'NOT_CONFIGURED', 'no provider the floor admits');
  w.setFloor(FLOOR_ON);

  // Recorded: the organization switches the task off for itself only.
  await w.controls.recordOrganizationControl(ORG, { scope: 'TASK', taskId: 'case.explanation', state: 'KILLED', reason: 'not now', actorUserId: w.people.owner.userId, expectedVersion: 0, now: at(1) });
  assert.equal(await refusal('idem-control-c3'), 'NOT_ENABLED');
  const elsewhere = await w.work.submit(w.people.outsider, caseSubmission({ idempotencyKey: 'idem-control-c3b', subject: { type: 'CASE', id: SUBJECTS[OTHER].CASE } }));
  assert.equal(elsewhere.kind, 'ACCEPTED', 'another organization is unaffected');
  await w.controls.recordOrganizationControl(ORG, { scope: 'TASK', taskId: 'case.explanation', state: 'ACTIVE', reason: 'back on', actorUserId: w.people.owner.userId, expectedVersion: 1, now: at(2) });
  assert.equal(await refusal('idem-control-c4'), 'ACCEPTED', 'an organization cannot enable beyond the platform, only restore');

  // Recorded: a platform kill pauses everyone.
  await w.controls.recordPlatformControl({ scope: 'GLOBAL', value: null, state: 'KILLED', reason: 'incident', operationsReference: 'test-run-2', expectedVersion: 1, now: at(3) });
  assert.equal(await refusal('idem-control-c5'), 'NOT_ENABLED');
  await w.controls.recordPlatformControl({ scope: 'GLOBAL', value: null, state: 'ACTIVE', reason: 'resolved', operationsReference: 'test-run-3', expectedVersion: 2, now: at(4) });
  await w.controls.recordPlatformControl({ scope: 'PROVIDER', value: PRIMARY_PROVIDER, state: 'KILLED', reason: 'provider incident', operationsReference: 'test-run-4', expectedVersion: 1, now: at(5) });
  assert.equal(await refusal('idem-control-c6'), 'PAUSED');
});

test('a route that no longer honours the specialization policy stops submission before the subject is read', async () => {
  const w = await world();
  const drifted: AiRoutingPolicy = {
    ...ROUTING,
    tasks: { ...ROUTING.tasks, 'case.explanation': { ...ROUTING.tasks['case.explanation']!, taskVersion: '1.9.9' } },
  };
  const service = new BrainWorkService(w.prisma, { ...w.deps, routing: drifted });
  w.log.length = 0;
  assert.deepEqual(await service.submit(w.people.owner, caseSubmission()), { kind: 'REFUSED', refusal: 'ROUTING_NOT_CONFORMANT' });
  assert.ok(!w.log.some((l) => l.startsWith('subject:')));
  assert.equal(w.written(), 0);
});

test('execution class is the task’s to allow, and the same submission is the same job', async () => {
  const w = await world();
  assert.deepEqual(await w.work.submit(w.people.owner, caseSubmission({ executionClass: 'DURABLE' })), {
    kind: 'REFUSED',
    refusal: 'EXECUTION_CLASS_NOT_SUPPORTED',
  });
  const durable = await submitted(w, w.people.owner, reviewSubmission());
  assert.equal(durable.executionClass, 'DURABLE');
  assert.equal(durable.resultType, 'ANALYSIS');
  const interactive = await submitted(w, w.people.owner, reviewSubmission({ executionClass: 'INTERACTIVE', idempotencyKey: 'idem-review-0002' }));
  assert.equal(interactive.executionClass, 'INTERACTIVE');
  assert.equal(interactive.resultType, 'ANALYSIS', 'how it runs does not change what it produces');

  const rings = w.rings.length;
  const again = await w.work.submit(w.people.owner, reviewSubmission());
  assert.equal(again.kind, 'EXISTING');
  assert.equal(again.kind === 'EXISTING' && again.work.jobId, durable.jobId);
  assert.equal(w.rings.length, rings, 'a retried submission rings nothing');
  assert.deepEqual(await w.work.submit(w.people.owner, reviewSubmission({ input: { horizonDays: 30 } })), {
    kind: 'REFUSED',
    refusal: 'IDEMPOTENCY_KEY_REUSED',
  });
});

test('a lost, failing or unconfigured doorbell loses no work', async () => {
  const w = await world();
  const throwing = new BrainWorkService(w.prisma, { ...w.deps, ring: async () => { throw new Error('network'); } });
  const out = await throwing.submit(w.people.owner, caseSubmission());
  assert.equal(out.kind, 'ACCEPTED');
  assert.equal(out.kind === 'ACCEPTED' && out.dispatch, 'FAILED');
  const unconfigured = new BrainWorkService(w.prisma, { ...w.deps, ring: undefined });
  const second = await unconfigured.submit(w.people.owner, reviewSubmission());
  assert.equal(second.kind === 'ACCEPTED' && second.dispatch, 'NOT_CONFIGURED');
  // Both commands wait, undispatched, for the executor's sweeper.
  const pending = await w.executor.undispatchedCommands(at(60));
  assert.equal(pending.length, 2);
  assert.ok(pending.every((p) => p.organizationId === ORG));
});

// --- Reading ---------------------------------------------------------------------------

test('a job is visible to the person who started it, and to nobody else', async () => {
  const w = await world();
  const mine = await submitted(w, w.people.manager, reviewSubmission());
  assert.equal((await w.work.status(w.people.manager, mine.jobId))!.jobId, mine.jobId);
  assert.equal(await w.work.status(w.people.owner, mine.jobId), null, 'not even the owner reads another person’s job');
  assert.equal(await w.work.status(w.people.outsider, mine.jobId), null);
  assert.equal(await w.work.status({ organizationId: OTHER, userId: w.people.manager.userId }, mine.jobId), null);

  const view = (await w.work.status(w.people.manager, mine.jobId))!;
  assert.doesNotMatch(JSON.stringify(view), /anthropic|openai|claude|gpt|model|provider|horizonDays/i, 'no provider, model or input');
  assert.deepEqual(Object.keys(view).sort(), [
    'acceptedAt', 'cancelRequested', 'endReason', 'endedAt', 'executionClass', 'finished', 'jobId', 'phase', 'progress',
    'promoted', 'resultType', 'results', 'startedAt', 'state', 'subject', 'taskId', 'waiting',
  ]);

  const count = await w.work.workingCount(w.people.manager);
  assert.equal(count.state, 'success');
  assert.equal(count.state === 'success' && count.value, 1);
  const none = await w.work.workingCount(w.people.employee);
  assert.equal(none.state, 'empty', 'no work is a measured zero, not a missing number');

  // Unfinished first. Navigating away loses nothing: the list is read from records.
  const done = await submitted(w, w.people.manager, reviewSubmission({ idempotencyKey: 'idem-review-0003' }));
  assert.equal((await w.work.cancel(w.people.manager, done.jobId)).ok, true);
  const list = await w.work.listMine(w.people.manager);
  assert.deepEqual(list.map((v) => [v.jobId, v.finished]), [[mine.jobId, false], [done.jobId, true]]);
  assert.deepEqual(await w.work.listMine(w.people.owner), []);
});

test('work about a subject shows only its state, only to people who may run its task', async () => {
  const w = await world();
  const job = await submitted(w, w.people.manager, reviewSubmission());
  const subject = { type: 'RELATIONSHIP' as const, id: SUBJECTS[ORG].RELATIONSHIP };
  const seen = await w.work.forSubject(w.people.owner, subject);
  assert.equal(seen.state, 'success');
  const items = seen.state === 'success' ? seen.value : [];
  assert.deepEqual(items, [{ jobId: job.jobId, taskId: REVIEW.taskId, resultType: 'ANALYSIS', phase: 'QUEUED', startedByUserId: w.people.manager.userId }]);
  const hidden = await w.work.forSubject(w.people.employee, subject);
  assert.equal(hidden.state, 'empty', 'an employee who may not run the task sees none of it');
  const foreign = await w.work.forSubject(w.people.outsider, subject);
  assert.equal(foreign.state, 'empty');
});

// --- Waiting for the principal --------------------------------------------------------

test('a durable job asks its principal a structured question, and resumes on a valid answer', async () => {
  const w = await world();
  const view = await submitted(w, w.people.manager, reviewSubmission());
  const job = await started(w, ORG, view.jobId);

  const invalid = await w.executor.waitForUser(job, { question: { kind: 'FREE_FORM', prompt: 'Anything?' }, expiresAt: at(3600), context: DURABLE_CTX, holder: 'worker-test-1', now: at(3) });
  assert.equal(invalid.ok, false, 'only a well-formed question may wait');
  const opened = await w.executor.waitForUser(job, { question: QUESTION, expiresAt: at(3600), context: DURABLE_CTX, holder: 'worker-test-1', now: at(3) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const waitId = (opened as { waitId: string }).waitId;

  const status = (await w.work.status(w.people.manager, view.jobId))!;
  assert.equal(status.phase, 'WAITING_FOR_YOU');
  assert.equal(status.waiting?.waitId, waitId);

  const question = await w.work.question(w.people.manager, waitId);
  assert.equal(question?.question.kind, 'CHOOSE_ONE');
  assert.equal(question?.status, 'OPEN');
  assert.equal(await w.work.question(w.people.owner, waitId), null, 'another person cannot read it');
  assert.equal(await w.work.question(w.people.outsider, waitId), null);

  assert.deepEqual(await w.work.respond(w.people.owner, waitId, { kind: 'CHOOSE_ONE', optionId: 'a' }), { ok: false, refusal: 'WAIT_NOT_FOUND' });
  assert.deepEqual(await w.work.respond(w.people.outsider, waitId, { kind: 'CHOOSE_ONE', optionId: 'a' }), { ok: false, refusal: 'WAIT_NOT_FOUND' });
  for (const bad of [
    { kind: 'CHOOSE_ONE', optionId: 'c' },
    { kind: 'CONFIRM', confirmed: true },
    { kind: 'CHOOSE_ONE', optionId: 'a', organizationId: OTHER },
    'a',
  ]) {
    assert.deepEqual(await w.work.respond(w.people.manager, waitId, bad), { ok: false, refusal: 'INVALID_REPLY' }, JSON.stringify(bad));
  }
  assert.equal(w.fake.brainCommand.__rows.filter((c: any) => c.type === 'RESUME').length, 0);

  const rings = w.rings.length;
  const answered = await w.work.respond(w.people.manager, waitId, { kind: 'CHOOSE_ONE', optionId: 'a' });
  assert.deepEqual(answered, { ok: true, recorded: 'NOW', dispatch: 'RUNG' });
  assert.deepEqual(await w.work.respond(w.people.manager, waitId, { kind: 'CHOOSE_ONE', optionId: 'a' }), { ok: true, recorded: 'ALREADY', dispatch: 'RUNG' });
  assert.deepEqual(await w.work.respond(w.people.manager, waitId, { kind: 'CHOOSE_ONE', optionId: 'b' }), { ok: false, refusal: 'WAIT_ALREADY_ANSWERED' });
  assert.equal(w.rings.length, rings + 2, 'a duplicate ring is harmless: the command is the same');
  assert.equal(new Set(w.rings.slice(rings)).size, 1);

  // The executor wakes on the RESUME command, re-decides access, and resumes.
  const lookup = await w.executor.command(w.rings.at(-1)!);
  assert.equal(lookup.ok && lookup.commandType, 'RESUME');
  assert.deepEqual(lookup.ok && lookup.disposition, { action: 'EXECUTE' });
  const internal = new BrainInternalService(w.prisma, { authorize: iamAiAuthorizer(w.prisma), tasks: TASKS, contexts: {}, readInput: async () => ({}) });
  const record = (await w.jobs.get(ORG, view.jobId))!;
  const access = await internal.access(record.job);
  assert.equal(access.decision.allowed, true);
  const resumed = await w.executor.resumeAfterReply(job, { waitId, responderPermitted: access.decision.allowed, holder: 'worker-test-1', now: at(10) });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.deepEqual(resumed.ok && resumed.reply, { kind: 'CHOOSE_ONE', optionId: 'a' }, 'the answer is read from Loop, as recorded');
  assert.equal((await w.work.status(w.people.manager, view.jobId))!.phase, 'WORKING');
  const again = await w.executor.command(w.rings.at(-1)!);
  assert.deepEqual(again.ok && again.disposition, { action: 'ALREADY_DONE' }, 'a late duplicate ring changes nothing');
});

test('a resume command is executed only when Loop holds the answer it names', async () => {
  const w = await world();
  const view = await submitted(w, w.people.manager, reviewSubmission());
  const job = await started(w, ORG, view.jobId);
  const opened = await w.executor.waitForUser(job, { question: QUESTION, expiresAt: at(3600), context: DURABLE_CTX, holder: 'worker-test-1', now: at(3) });
  const waitId = (opened as { waitId: string }).waitId;
  const answered = await w.work.respond(w.people.manager, waitId, { kind: 'CHOOSE_ONE', optionId: 'b' });
  assert.equal(answered.ok, true);
  // If the stored wait no longer says ANSWERED (a row changed underneath), the command is not trusted.
  const waitRow = w.fake.brainJobWait.__rows.find((r: any) => r.id === waitId);
  waitRow.status = 'OPEN';
  const lookup = await w.executor.command(w.rings.at(-1)!);
  assert.deepEqual(lookup.ok && lookup.disposition, { action: 'REFUSE', refusals: ['REPLY_NOT_RECORDED'] });
});

test('a principal who has lost the right to the task cannot answer, and an unanswered question expires', async () => {
  const w = await world();
  const view = await submitted(w, w.people.manager, reviewSubmission());
  const job = await started(w, ORG, view.jobId);
  const opened = await w.executor.waitForUser(job, { question: { kind: 'CONFIRM', prompt: 'Use the last 90 days?' }, expiresAt: at(100), context: DURABLE_CTX, holder: 'worker-test-1', now: at(3) });
  const waitId = (opened as { waitId: string }).waitId;
  await w.iam.disableUser(ORG, w.people.manager.userId);
  assert.deepEqual(await w.work.respond(w.people.manager, waitId, { kind: 'CONFIRM', confirmed: true }), { ok: false, refusal: 'NOT_PERMITTED' });

  assert.deepEqual(await w.executor.expiredWaits(at(99)), []);
  const due = await w.executor.expiredWaits(at(100));
  assert.deepEqual(due.map((d) => d.waitId), [waitId]);
  const expired = await w.executor.expireWait(job, waitId, at(100));
  assert.equal(expired.ok && expired.job.state, 'CANCELLED');
  assert.equal(expired.ok && expired.job.endReason, 'WAIT_EXPIRED');
});

// --- Cancellation ---------------------------------------------------------------------

test('a principal or an administrator may stop work; anyone else is told it does not exist', async () => {
  const w = await world();
  const queued = await submitted(w, w.people.manager, reviewSubmission());
  assert.deepEqual(await w.work.cancel(w.people.employee, queued.jobId), { ok: false, refusal: 'JOB_NOT_FOUND' });
  assert.deepEqual(await w.work.cancel(w.people.outsider, queued.jobId), { ok: false, refusal: 'JOB_NOT_FOUND' });

  const stopped = await w.work.cancel(w.people.manager, queued.jobId);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.ok && stopped.stoppedNow, true, 'work that has not started stops at once');
  assert.equal(stopped.ok && stopped.work.phase, 'CANCELLED');
  assert.deepEqual(await w.work.cancel(w.people.manager, queued.jobId), { ok: false, refusal: 'ALREADY_FINISHED' });
  const history = await w.jobs.transitions(ORG, queued.jobId);
  assert.deepEqual(history.at(-1)!.actor, { kind: 'HUMAN', userId: w.people.manager.userId });

  // Running work: the request is durable and visible; the executor settles it.
  const running = await submitted(w, w.people.manager, reviewSubmission({ idempotencyKey: 'idem-review-0009' }));
  const job = await started(w, ORG, running.jobId);
  const byAdmin = await w.work.cancel(w.people.admin, running.jobId);
  assert.equal(byAdmin.ok, true);
  assert.equal(byAdmin.ok && byAdmin.stoppedNow, false);
  assert.equal(byAdmin.ok && byAdmin.work.cancelRequested, true);
  assert.equal(byAdmin.ok && byAdmin.work.phase, 'WORKING', 'still working until the executor stops at a boundary');
  const again = await w.work.cancel(w.people.manager, running.jobId);
  assert.equal(again.ok, true, 'asking twice is the same request');
  assert.equal(w.fake.brainCommand.__rows.filter((c: any) => c.jobId === running.jobId && c.type === 'CANCEL').length, 1);

  const record = (await w.jobs.get(ORG, running.jobId))!;
  assert.equal(record.job.cancelRequest?.reason, 'REQUESTED_BY_ADMINISTRATOR');
  const lookup = await w.executor.command(w.rings.at(-1)!);
  assert.equal(lookup.ok && lookup.commandType, 'CANCEL');
  assert.deepEqual(lookup.ok && lookup.disposition, { action: 'EXECUTE' });
  const settled = await w.executor.transition(job, { type: 'CANCEL_SETTLED' }, { context: DURABLE_CTX, holder: 'worker-test-1', now: at(9) });
  assert.equal(settled.ok, true, JSON.stringify(settled));
  assert.equal((await w.work.status(w.people.manager, running.jobId))!.phase, 'CANCELLED');
  const late = await w.executor.command(w.rings.at(-1)!);
  assert.deepEqual(late.ok && late.disposition, { action: 'ALREADY_DONE' });
});

test('a control stops running work as a named policy, not an anonymous system', async () => {
  const w = await world();
  const view = await submitted(w, w.people.manager, reviewSubmission());
  const job = await started(w, ORG, view.jobId);
  await w.controls.recordPlatformControl({ scope: 'TASK', value: REVIEW.taskId, state: 'KILLED', reason: 'bad output', operationsReference: 'test-run-5', expectedVersion: 1, now: at(4) });
  const effective = await w.executor.controlsFor(job, FLOOR_ON);
  assert.ok(effective.killSwitches.some((k) => k.scope === 'TASK' && k.value === REVIEW.taskId));
  const stopped = await w.executor.stopByPolicy(job, 'ai-control:TASK', at(5));
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  const history = await w.jobs.transitions(ORG, view.jobId);
  assert.deepEqual(history.at(-1)!.actor, { kind: 'POLICY', policy: 'ai-control:TASK' });
  const command = w.fake.brainCommand.__rows.find((c: any) => c.jobId === view.jobId && c.type === 'CANCEL');
  const lookup = await w.executor.command(command.id);
  assert.deepEqual(lookup.ok && lookup.disposition, { action: 'EXECUTE' });
});

// --- The executor's surface -----------------------------------------------------------

test('the executor store resolves one job and acts only within its organization', async () => {
  const w = await world();
  const view = await submitted(w, w.people.manager, reviewSubmission());
  const references = new BrainExecutionReferences(w.prisma);
  assert.deepEqual(await references.locateJob(view.jobId), { organizationId: ORG, jobId: view.jobId, generation: 1 });
  assert.equal(await references.locateJob('cjob_does_not_exist_000'), null);
  assert.equal(await w.executor.resolve({ jobId: view.jobId, generation: 2 }), null, 'a stale generation resolves to nothing');

  const wrongOrg = jobRef(OTHER, view.jobId);
  assert.deepEqual(await w.executor.claim(wrongOrg, 'worker-x', 1000, at(1)), { ok: false, reason: 'JOB_NOT_FOUND' });
  assert.equal((await w.executor.transition(wrongOrg, { type: 'DISPATCHED' }, { context: DURABLE_CTX })).ok, false);
  assert.equal(await w.executor.release(wrongOrg, 'worker-x'), false);
  assert.equal((await w.executor.command('cmd_does_not_exist_00')).ok, false);

  const job = await started(w, ORG, view.jobId);
  // A reservation is recorded against the job and step, under the job's call key.
  const route = ROUTING.tasks[REVIEW.taskId]!;
  const reserved = await w.executor.reserveCall(
    job,
    {
      principalUserId: w.people.manager.userId,
      taskId: REVIEW.taskId,
      taskVersion: REVIEW.version,
      capabilityRoute: REVIEW.capabilityRoute,
      target: route.primary,
      routingPolicyVersion: ROUTING.version,
      specializationPolicyVersion: AI_PROVIDER_SPECIALIZATION_POLICY.version,
      budgetClass: route.budgetClass,
      templateId: 'relationship-review',
      templateVersion: '1',
      contextSourceRefs: ['relationship:rel_boundary_1'],
      estimate: { inputTokens: 1000, outputTokens: 500 },
      fellBackFrom: null,
      requestedAt: at(3),
      stepKey: 'model.review',
      attempt: 1,
      targetOrdinal: 1,
    },
    { ...AI_BUDGET_POLICY, classes: { ...AI_BUDGET_POLICY.classes } },
    [ORG],
  );
  assert.deepEqual(reserved, { ok: true });
  const row = w.fake.aiInvocation.__rows.find((r: any) => r.brainJobId === view.jobId);
  assert.equal(row.invocationId, `${view.jobId}:model.review:1`);
  assert.equal(row.brainStepKey, 'model.review');
  assert.equal(row.organizationId, ORG);
  assert.equal(row.specializationPolicyVersion, AI_PROVIDER_SPECIALIZATION_POLICY.version);
  assert.equal(
    await w.executor.reconcileCall(job, { invocationId: 'someone-elses-call', outcome: 'ANSWERED', completedAt: at(4) }),
    false,
    'a call that is not this job’s is never reconciled through it',
  );
  // Nor is another job's real, in-flight call in the same organization.
  const second = await submitted(w, w.people.manager, reviewSubmission({ idempotencyKey: 'idem-review-0005' }));
  const secondJob = await started(w, ORG, second.jobId);
  const secondCall = {
    principalUserId: w.people.manager.userId,
    taskId: REVIEW.taskId,
    taskVersion: REVIEW.version,
    capabilityRoute: REVIEW.capabilityRoute,
    target: route.primary,
    routingPolicyVersion: ROUTING.version,
    budgetClass: route.budgetClass,
    templateId: 'relationship-review',
    templateVersion: '1',
    contextSourceRefs: [],
    estimate: { inputTokens: 10, outputTokens: 10 },
    fellBackFrom: null,
    requestedAt: at(3),
    stepKey: 'model.review',
    attempt: 1,
    targetOrdinal: 1,
  };
  assert.deepEqual(await w.executor.reserveCall(secondJob, secondCall, AI_BUDGET_POLICY, [ORG]), { ok: true });
  const secondKey = `${second.jobId}:model.review:1`;
  assert.equal(await w.executor.reconcileCall(job, { invocationId: secondKey, outcome: 'ANSWERED', completedAt: at(4) }), false);
  const secondRow = w.fake.aiInvocation.__rows.find((r: any) => r.invocationId === secondKey);
  assert.equal(secondRow.completedAt ?? null, null, 'the other job’s call is untouched');
  assert.equal(await w.executor.reconcileCall(job, { invocationId: `${view.jobId}:model.review:1`, outcome: 'ANSWERED', inputTokens: 900, outputTokens: 400, completedAt: at(4) }), true);
});

test('the executor store has no way to create work, answer for a person, or write a result', () => {
  const methods = Object.getOwnPropertyNames(BrainExecutorStore.prototype).filter((m) => m !== 'constructor').sort();
  assert.deepEqual(methods, [
    'addActiveTime', 'beginStep', 'checkpoint', 'claim', 'command', 'controlsFor', 'expireWait', 'expiredWaits', 'failStep',
    'markDispatched', 'readCheckpoint', 'reconcileCall', 'release', 'reserveCall', 'resolve', 'resumeAfterReply', 'staleLeases',
    'stepState', 'stopByPolicy', 'transition', 'undispatchedCommands', 'waitForUser',
  ]);
  const internal = Object.getOwnPropertyNames(BrainInternalService.prototype).filter((m) => m !== 'constructor' && !m.startsWith('task')).sort();
  assert.deepEqual(internal, ['access', 'commit', 'context']);
});

// --- Loop's answers to the executor ---------------------------------------------------

const SUPPLIED_REF = `relationship:${SUBJECTS[ORG].RELATIONSHIP}`;

function reviewContext(job: { organizationId: string; principalUserId: string }): BrainTaskContext {
  return {
    package: {
      organizationId: job.organizationId,
      viewerUserId: job.principalUserId,
      taskId: REVIEW.taskId,
      sensitivityCeiling: 'OPERATIONAL',
      items: [
        {
          blockId: `${job.organizationId}::relationship-summary`,
          kind: 'STRUCTURED',
          trust: 'GOVERNED_FACT',
          sourceRef: SUPPLIED_REF,
          content: '{"settlementsLast30Days":0}',
          sensitivity: 'OPERATIONAL',
          readUnder: { resource: 'commercialIntelligence', action: 'view' },
        },
      ],
    },
    supplied: [{ ref: SUPPLIED_REF, trust: 'GOVERNED_FACT' }],
    support: {},
    withheld: { notes: 2 },
  };
}

function reviewEnvelope(jobId: string, over: Partial<BrainResultEnvelope> = {}): BrainResultEnvelope {
  const claims = [{ statement: 'Settlements stopped in the last 30 days.', citations: [SUPPLIED_REF] }];
  return {
    resultType: 'ANALYSIS',
    schemaId: 'relationship-review.v1',
    organizationId: ORG,
    subject: { type: 'RELATIONSHIP', id: SUBJECTS[ORG].RELATIONSHIP },
    owner: { authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP' },
    standing: 'NON_AUTHORITATIVE',
    claims,
    evidenceRefs: brainEvidenceRefsOf(claims),
    limitations: [],
    provenance: {
      jobId,
      taskId: REVIEW.taskId,
      taskVersion: REVIEW.version,
      templateId: 'relationship-review',
      templateVersion: '1',
      capabilityRoute: 'TECHNICAL_ANALYSIS',
      specializationPolicyVersion: AI_PROVIDER_SPECIALIZATION_POLICY.version,
      routingPolicyVersion: ROUTING.version,
      invocationIds: [`${jobId}:model.review:1`],
      servedModels: ['test-served-model'],
      fellBackFrom: null,
      contextManifestHash: 'test-manifest',
    },
    payload: { summary: 'test' },
    ...over,
  };
}

/** A test-only owner: stores the artifact once per commit key. */
function testOwner(): BrainResultOwnerGate & { stored: Map<string, string> } {
  const stored = new Map<string, string>();
  return {
    resultType: 'ANALYSIS',
    authority: 'RELATIONSHIPS',
    subjectType: 'RELATIONSHIP',
    stored,
    async commit({ commitKey, envelope }) {
      if (envelope.payload === 'refuse') return { ok: false, reason: 'OWNER_SAYS_NO' };
      if (!stored.has(commitKey)) stored.set(commitKey, `ana_${stored.size + 1}`);
      return { ok: true, artifactId: stored.get(commitKey)! };
    },
  };
}

test('access, context and commit are decided from the job, re-decided on every call', async () => {
  const w = await world();
  const view = await submitted(w, w.people.manager, reviewSubmission());
  await started(w, ORG, view.jobId);
  const job = (await w.jobs.get(ORG, view.jobId))!.job;
  const assembled: string[] = [];
  const assembler: BrainContextAssembler = async ({ job: j, input }) => {
    assembled.push(`${j.organizationId}:${j.principalUserId}:${JSON.stringify(input)}`);
    return reviewContext(j);
  };
  const owner = testOwner();
  const internal = new BrainInternalService(w.prisma, {
    authorize: iamAiAuthorizer(w.prisma),
    tasks: TASKS,
    contexts: { [REVIEW.taskId]: assembler },
    owners: [owner],
    readInput: (organizationId, jobId) => w.jobs.input(organizationId, jobId),
    now: () => at(5),
  });

  const access = await internal.access(job);
  assert.deepEqual(access.decision, { allowed: true, organizationId: ORG, principalUserId: w.people.manager.userId, taskId: REVIEW.taskId, decidedAtMs: at(5).getTime() });
  assert.equal(access.principal?.membershipActive, true);

  const context = await internal.context(job);
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.deepEqual(assembled, [`${ORG}:${w.people.manager.userId}:{"horizonDays":90}`], 'assembled for the job’s own principal and input');

  const committed = await internal.commit(job, 'commit.result', reviewEnvelope(job.jobId));
  assert.deepEqual(committed, {
    ok: true,
    commitKey: `${job.jobId}:commit.result:commit`,
    ref: { owner: { authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP' }, subjectId: SUBJECTS[ORG].RELATIONSHIP, artifactId: 'ana_1' },
  });
  const twice = await internal.commit(job, 'commit.result', reviewEnvelope(job.jobId));
  assert.equal(twice.ok && twice.ref.artifactId, 'ana_1', 'committing again stores nothing new');
  assert.equal(owner.stored.size, 1);

  // Evidence Loop did not supply, another organization, another job or another subject: refused.
  const cite = (ref: string) => [{ statement: 'x', citations: [ref] }];
  for (const [label, envelope, detail] of [
    ['invented evidence', reviewEnvelope(job.jobId, { claims: cite('relationship:rel_invented'), evidenceRefs: ['relationship:rel_invented'] }), 'CITATION_NOT_SUPPLIED'],
    ['another organization', reviewEnvelope(job.jobId, { organizationId: OTHER }), 'ORGANIZATION_MISMATCH'],
    ['another job', reviewEnvelope('cjob_another_job_000001'), 'JOB_MISMATCH'],
    ['another subject', reviewEnvelope(job.jobId, { subject: { type: 'RELATIONSHIP', id: 'rel_boundary_2' } }), 'SUBJECT_MISMATCH'],
    ['another result type', reviewEnvelope(job.jobId, { resultType: 'FINDING' }), 'RESULT_TYPE_MISMATCH'],
  ] as const) {
    const out = await internal.commit(job, 'commit.result', envelope);
    assert.equal(out.ok, false, label);
    assert.equal(!out.ok && out.refusal, 'COMMIT_REFUSED', label);
    assert.ok(!out.ok && out.details.includes(detail), `${label}: ${JSON.stringify(out)}`);
  }
  const refusedByOwner = await internal.commit(job, 'commit.second', reviewEnvelope(job.jobId, { payload: 'refuse' }));
  assert.deepEqual(refusedByOwner, { ok: false, refusal: 'OWNER_REFUSED', details: ['OWNER_SAYS_NO'] });

  // Without an owner's gate there is nowhere for a result to land.
  const ungated = new BrainInternalService(w.prisma, { authorize: iamAiAuthorizer(w.prisma), tasks: TASKS, contexts: { [REVIEW.taskId]: assembler }, readInput: (o, j) => w.jobs.input(o, j) });
  const nowhere = await ungated.commit(job, 'commit.result', reviewEnvelope(job.jobId));
  assert.equal(!nowhere.ok && nowhere.refusal, 'OWNER_GATE_UNAVAILABLE');

  // A context for someone else is refused, and so is a task without an assembler.
  const leaky = new BrainInternalService(w.prisma, {
    authorize: iamAiAuthorizer(w.prisma),
    tasks: TASKS,
    contexts: { [REVIEW.taskId]: async ({ job: j }) => reviewContext({ ...j, organizationId: OTHER }) },
    readInput: (o, j) => w.jobs.input(o, j),
  });
  assert.deepEqual(await leaky.context(job), { ok: false, refusal: 'CONTEXT_REFUSED' });
  const unassembled = new BrainInternalService(w.prisma, { authorize: iamAiAuthorizer(w.prisma), tasks: TASKS, contexts: {}, readInput: (o, j) => w.jobs.input(o, j) });
  assert.deepEqual(await unassembled.context(job), { ok: false, refusal: 'NO_CONTEXT_FOR_TASK' });

  // The principal loses the role: every answer changes at once.
  await w.iam.disableUser(ORG, w.people.manager.userId);
  assembled.length = 0;
  assert.equal((await internal.access(job)).decision.allowed, false);
  assert.deepEqual(await internal.context(job), { ok: false, refusal: 'NOT_PERMITTED' });
  const late = await internal.commit(job, 'commit.late', reviewEnvelope(job.jobId));
  assert.equal(!late.ok && late.refusal, 'NOT_PERMITTED');
  assert.deepEqual(assembled, [], 'nothing was assembled for a principal who may no longer see it');
  assert.equal(owner.stored.size, 1, 'and nothing reached the owner');
});

test('access follows the principal’s role now, and membership is checked even if an authorizer would say yes', async () => {
  const w = await world();
  const view = await submitted(w, w.people.owner, caseSubmission());
  const job = (await w.jobs.get(ORG, view.jobId))!.job;
  const internal = new BrainInternalService(w.prisma, { authorize: iamAiAuthorizer(w.prisma), tasks: TASKS, contexts: {}, readInput: async () => ({}) });
  assert.equal((await internal.access(job)).decision.allowed, true);
  await w.iam.updateUserRole(ORG, w.people.owner.userId, 'MANAGER');
  const demoted = await internal.access(job);
  assert.equal(demoted.principal?.membershipActive, true, 'still a member');
  assert.equal(demoted.decision.allowed, false, 'but no longer allowed to run Case Explanation');

  const permissive = new BrainInternalService(w.prisma, { authorize: async () => true, tasks: TASKS, contexts: {}, readInput: async () => ({}) });
  await w.iam.disableUser(ORG, w.people.owner.userId);
  const disabled = await permissive.access(job);
  assert.equal(disabled.principal?.membershipActive, false);
  assert.equal(disabled.decision.allowed, false, 'an inactive membership is never allowed, whatever the authorizer says');
});

test('a task version Loop no longer serves is not authorized for anything', async () => {
  const w = await world();
  const view = await submitted(w, w.people.manager, reviewSubmission());
  const job = (await w.jobs.get(ORG, view.jobId))!.job;
  const internal = new BrainInternalService(w.prisma, {
    authorize: iamAiAuthorizer(w.prisma),
    tasks: [AI_TASK_CASE_EXPLANATION, { ...REVIEW, version: '2.0.0' }],
    contexts: {},
    readInput: async () => ({}),
  });
  assert.equal((await internal.access(job)).decision.allowed, false);
});

// --- End to end, with a test-only reference executor ----------------------------------

/**
 * What an execution-environment worker does, in process and without a provider. The
 * "model" is a pure function of the context Loop supplied.
 */
const SEALER = new AesGcmBrainPayloadSealer('test/local-dev-key-1', randomBytes(32));

async function referenceExecutor(w: World, internal: BrainInternalService, commandId: string, holder = 'worker-ref-1') {
  const trace: string[] = [];
  const lookup = await w.executor.command(commandId);
  if (!lookup.ok || lookup.disposition.action !== 'EXECUTE') return { trace: [...trace, `skip:${JSON.stringify(lookup)}`] };
  const job = lookup.job;
  await w.executor.markDispatched(job, commandId, at(1));
  const claim = await w.executor.claim(job, holder, 60_000, at(1));
  if (!claim.ok) return { trace: [...trace, `claim:${claim.reason}`] };
  const ctx: BrainTransitionContext = { supportsDurable: true, taskMayWait: true };
  if (claim.job.state === 'ACCEPTED') {
    await w.executor.transition(job, { type: 'DISPATCHED' }, { context: ctx, holder, now: at(1) });
    const s = await w.executor.transition(job, { type: 'STARTED' }, { context: ctx, holder, now: at(2) });
    trace.push(`started:${s.ok}`);
  }
  const controls = await w.executor.controlsFor(job, FLOOR_ON);
  if (!controls.activation.enabled) return { trace: [...trace, 'stopped-by-controls'] };

  const current = (await w.jobs.get(job.organizationId, job.jobId))!.job;
  const context = await internal.context(current);
  if (!context.ok) return { trace: [...trace, `context:${context.refusal}`] };
  trace.push(`context:${context.context.supplied.length}`);

  const step = { stepKey: 'model.review', inputFingerprint: 'fp-review-1' };
  const state = await w.executor.stepState(job, step.stepKey, step.inputFingerprint);
  if (state.ok && !state.checkpointed) {
    const begun = await w.executor.beginStep(job, { ...step, kind: 'MODEL_CALL', attempt: 1, paid: false, now: at(3) });
    trace.push(`step:${begun.ok}`);
    const sealingContext = { organizationId: job.organizationId, jobId: job.jobId, ...step, purpose: 'CHECKPOINT' as const };
    const modelOutput = new TextEncoder().encode(JSON.stringify({ summary: 'stub model output', refs: context.context.supplied.map((s) => s.ref) }));
    const cp = await w.executor.checkpoint(job, { ...step, payload: await SEALER.seal(sealingContext, modelOutput), now: at(4) });
    trace.push(`checkpoint:${cp.ok && cp.recorded}`);
    const stored = await w.executor.readCheckpoint(job, { jobId: job.jobId, ...step });
    const reopened = JSON.parse(new TextDecoder().decode(await SEALER.open(sealingContext, stored!)));
    if (reopened.summary !== 'stub model output') trace.push('checkpoint:unreadable');
  } else {
    trace.push('step:reused-checkpoint');
  }

  // A cancellation that arrived meanwhile is honoured at the step boundary.
  const latest = (await w.jobs.get(job.organizationId, job.jobId))!.job;
  if (latest.cancelRequest) {
    const settled = await w.executor.transition(job, { type: 'CANCEL_SETTLED' }, { context: ctx, holder, now: at(5) });
    return { trace: [...trace, `cancelled:${settled.ok}`] };
  }

  const envelope = reviewEnvelope(job.jobId);
  const committed = await internal.commit(latest, 'commit.result', envelope);
  if (!committed.ok) return { trace: [...trace, `commit:${committed.refusal}`] };
  const done = await w.executor.transition(job, { type: 'RESULT_COMMITTED', resultRefs: [committed.ref] }, { context: ctx, holder, now: at(6) });
  trace.push(`committed:${done.ok}`);
  await w.executor.release(job, holder);
  return { trace, ref: committed.ref };
}

test('end to end: accepted work runs, checkpoints, commits through its owner and is found where it lives', async () => {
  const w = await world();
  const owner = testOwner();
  const internal = new BrainInternalService(w.prisma, {
    authorize: iamAiAuthorizer(w.prisma),
    tasks: TASKS,
    contexts: { [REVIEW.taskId]: async ({ job }) => reviewContext(job) },
    owners: [owner],
    readInput: (o, j) => w.jobs.input(o, j),
  });
  const view = await submitted(w, w.people.manager, reviewSubmission());
  const out = await referenceExecutor(w, internal, w.rings[0]!);
  assert.deepEqual(out.trace, ['started:true', 'context:1', 'step:true', 'checkpoint:NOW', 'committed:true']);

  const status = (await w.work.status(w.people.manager, view.jobId))!;
  assert.equal(status.phase, 'COMPLETED');
  assert.equal(status.finished, true);
  assert.deepEqual(status.results, [{ authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP', subjectId: SUBJECTS[ORG].RELATIONSHIP, artifactId: 'ana_1', href: `/crm/relationships/${SUBJECTS[ORG].RELATIONSHIP}` }]);
  assert.equal(status.progress.completedSteps, 1);
  assert.equal(w.fake.brainCommand.__rows.find((c: any) => c.id === w.rings[0]).dispatchedAt instanceof Date, true);

  // A duplicate ring after completion does nothing.
  const replay = await referenceExecutor(w, internal, w.rings[0]!);
  assert.match(replay.trace[0]!, /^skip:.*ALREADY_DONE/);
  assert.equal(owner.stored.size, 1);

  // Brain Activity says what happened, in words, with no content.
  const events = w.fake.brainEvent.__rows.filter((e: any) => e.jobId === view.jobId).map((e: any) => e.name);
  assert.deepEqual(events, ['brain.job.accepted', 'brain.job.succeeded']);
  assert.equal(brainEventTitle('brain.job.accepted', 'ANALYSIS'), 'Brain analysis started');
  assert.equal(brainEventTitle('brain.job.succeeded', 'ANALYSIS'), 'Brain analysis completed');
  const serialized = JSON.stringify(w.fake.brainEvent.__rows);
  assert.doesNotMatch(serialized, /Settlements stopped|horizonDays|test-served-model|summary/, 'no result, input or model in an event');
});

test('end to end: a cancellation that arrives while the step runs is honoured at its boundary', async () => {
  const w = await world();
  const owner = testOwner();
  let cancelDuringContext: (() => Promise<unknown>) | null = null;
  const internal = new BrainInternalService(w.prisma, {
    authorize: iamAiAuthorizer(w.prisma),
    tasks: TASKS,
    contexts: {
      [REVIEW.taskId]: async ({ job }) => {
        if (cancelDuringContext) await cancelDuringContext();
        return reviewContext(job);
      },
    },
    owners: [owner],
    readInput: (o, j) => w.jobs.input(o, j),
  });
  const view = await submitted(w, w.people.manager, reviewSubmission());
  cancelDuringContext = async () => {
    cancelDuringContext = null;
    const out = await w.work.cancel(w.people.manager, view.jobId);
    assert.equal(out.ok && out.stoppedNow, false);
  };
  const out = await referenceExecutor(w, internal, w.rings[0]!);
  assert.deepEqual(out.trace, ['started:true', 'context:1', 'step:true', 'checkpoint:NOW', 'cancelled:true']);
  assert.equal((await w.work.status(w.people.manager, view.jobId))!.phase, 'CANCELLED');
  assert.equal(owner.stored.size, 0, 'nothing was committed');
  const names = w.fake.brainEvent.__rows.filter((e: any) => e.jobId === view.jobId).map((e: any) => e.name);
  assert.equal(names.at(-1), 'brain.job.cancelled');
  assert.equal(brainEventTitle('brain.job.cancelled', 'ANALYSIS'), 'Brain analysis cancelled');
});

test('the Brain Activity lane shows Brain work to administrators only', async () => {
  const w = await world();
  await submitted(w, w.people.manager, reviewSubmission());
  const adapter = new BrainEventActivityAdapter(w.prisma);
  assert.equal(adapter.supports({ kind: 'ORGANIZATION' } as never), true);
  assert.equal(adapter.supports({ kind: 'CASE', id: 'x' } as never), true);
  assert.equal(adapter.supports({ kind: 'WORK_ITEM', id: 'x' } as never), false);
  assert.equal(brainWorkPhase('WAITING_FOR_USER'), 'WAITING_FOR_YOU');
  assert.equal(brainEventTitle('brain.job.waiting_for_user', 'DRAFT'), 'Brain is waiting for clarification');
  assert.equal(brainEventTitle('brain.job.failed', 'RECOMMENDATION'), 'Brain recommendation failed');
});

test('the default subject resolver finds only live records of the caller’s organization', async () => {
  const w = await world();
  w.fake.operationalPriority.__rows.push({ id: 'case_live_0001', organizationId: ORG });
  w.fake.crmRelationship.__rows.push({ id: 'rel_live_0001', organizationId: ORG, state: 'ACTIVE' }, { id: 'rel_void_0001', organizationId: ORG, state: 'VOIDED' });
  w.fake.conversation.__rows.push({ id: 'conv_live_001', organizationId: ORG });
  const resolver = new PrismaBrainSubjectResolver(w.prisma);
  assert.equal(await resolver.exists(ORG, { type: 'CASE', id: 'case_live_0001' }), true);
  assert.equal(await resolver.exists(OTHER, { type: 'CASE', id: 'case_live_0001' }), false);
  assert.equal(await resolver.exists(ORG, { type: 'RELATIONSHIP', id: 'rel_live_0001' }), true);
  assert.equal(await resolver.exists(ORG, { type: 'RELATIONSHIP', id: 'rel_void_0001' }), false, 'a voided relationship is not a subject');
  assert.equal(await resolver.exists(ORG, { type: 'CUSTOMER_CONVERSATION', id: 'conv_live_001' }), true);
  assert.equal(await resolver.exists(ORG, { type: 'CAMPAIGN', id: 'camp_1' }), false, 'an unbuilt authority is never a subject');
  assert.equal(await resolver.exists(ORG, { type: 'CASE', id: 'bad id!' }), false);
  assert.equal(brainSubjectHref({ type: 'CONVERSATION', id: 'c1' }), null);
  assert.equal(brainSubjectHref({ type: 'CASE', id: '../x' }), null);
});

test('a sealed checkpoint opens only where it was sealed, and never looks like text', async () => {
  const key = randomBytes(32);
  const sealer = new AesGcmBrainPayloadSealer('dev/key-a', key);
  const ctx = { organizationId: ORG, jobId: 'cjob00000000000000000001', stepKey: 'model.review', inputFingerprint: 'fp-1', purpose: 'CHECKPOINT' as const };
  const plaintext = new TextEncoder().encode('{"answer":"Settlements stopped for buyer 7"}');
  const sealed = await sealer.seal(ctx, plaintext);
  assert.equal(sealed.sealVersion, 'aes-gcm.1');
  assert.equal(sealed.keyRef, 'dev/key-a');
  assert.deepEqual(brainSealedPayloadRefusals(sealed), [], 'the persistence fence accepts it');
  assert.equal(Buffer.from(sealed.sealed).includes(Buffer.from('Settlements')), false, 'no plaintext in the bytes');
  assert.deepEqual(await sealer.open(ctx, sealed), plaintext);
  const tiny = await sealer.seal(ctx, new Uint8Array([0x7b]));
  assert.deepEqual(brainSealedPayloadRefusals(tiny), [], 'even a one-byte payload is not mistaken for text');
  assert.notDeepEqual((await sealer.seal(ctx, plaintext)).sealed, sealed.sealed, 'a fresh IV every time');

  for (const other of [
    { ...ctx, organizationId: OTHER },
    { ...ctx, jobId: 'cjob00000000000000000002' },
    { ...ctx, stepKey: 'model.other' },
    { ...ctx, inputFingerprint: 'fp-2' },
  ]) {
    await assert.rejects(sealer.open(other, sealed), BrainPayloadUnopenable, JSON.stringify(other));
  }
  await assert.rejects(new AesGcmBrainPayloadSealer('dev/key-a', randomBytes(32)).open(ctx, sealed), BrainPayloadUnopenable, 'another key');
  await assert.rejects(new AesGcmBrainPayloadSealer('dev/key-b', key).open(ctx, sealed), BrainPayloadUnopenable, 'relabelled key');
  await assert.rejects(sealer.open(ctx, { ...sealed, keyRef: 'dev/key-b' }), BrainPayloadUnopenable);
  await assert.rejects(sealer.open(ctx, { ...sealed, sealVersion: 'aes-gcm.2' }), BrainPayloadUnopenable);
  const tampered = new Uint8Array(sealed.sealed);
  tampered[20] = tampered[20]! ^ 0x01;
  await assert.rejects(sealer.open(ctx, { ...sealed, sealed: tampered }), BrainPayloadUnopenable);
  await assert.rejects(sealer.open(ctx, { ...sealed, sealed: sealed.sealed.slice(0, 20) }), BrainPayloadUnopenable);
  const reheadered = new Uint8Array(sealed.sealed);
  reheadered[3] = 0x02;
  await assert.rejects(sealer.open(ctx, { ...sealed, sealed: reheadered }), BrainPayloadUnopenable, 'the header is checked, since GCM does not cover it');
  try {
    await sealer.open({ ...ctx, jobId: 'x' }, sealed);
  } catch (err) {
    assert.doesNotMatch(String((err as Error).message), /Settlements|dev\/key|cjob/, 'the error says nothing');
  }
  assert.throws(() => new AesGcmBrainPayloadSealer('dev/key-a', randomBytes(16)), /32-byte/);
  assert.throws(() => new AesGcmBrainPayloadSealer('has space', key), /key reference/);
});

// --- Fences -----------------------------------------------------------------------------

test('fence: the Brain services call no provider, read no environment and open no connection', () => {
  const dir = join(__dirname, '..', 'src', 'services', 'brain');
  for (const file of ['brain-work.service.ts', 'brain-executor-store.ts', 'brain-internal.service.ts', 'brain-subjects.ts', 'brain-payload-sealer.ts']) {
    const src = readFileSync(join(dir, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /process\.env|fetch\(|@anthropic-ai|from 'openai'|@aws-sdk|https?:\/\//, file);
    assert.doesNotMatch(src, /@emgloop\/providers/, `${file} takes policies as arguments, never imports them`);
    assert.doesNotMatch(src, /organizationId:\s*(raw|body|submission|reply)\b/, `${file} never takes an organization from input`);
  }
});

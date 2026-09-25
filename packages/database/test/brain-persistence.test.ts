// Brain durable persistence (B4), against the in-memory Prisma double.
//
// WHAT THESE PROVE
//
// THE ROWS ROUND-TRIP TO THE CONTRACTS. INTERACTIVE, DURABLE and DRAFT jobs are stored
// and read back as the same `BrainJobSnapshot` the pure contracts decided, with the four
// declarations -- capability route; result type, owner and subject; execution class --
// in separate columns that nothing collapses, and no provider or model anywhere.
//
// ACCEPTED WORK OUTLIVES WHOEVER ASKED, AND MOVES ONLY BY CONTRACT. Every change is
// decided by `brainJobTransition` and written with its history and its event. Promotion
// changes the execution class and nothing else. A wait survives until it is answered once
// by its principal, expires, or is closed. Cancellation stops idle work at once and
// running work at its boundary. A step whose checkpoint exists is never run again, and a
// lost paid call counts as spent.
//
// ORGANIZATION FIRST. Another organization's job, wait, step, command, event or control
// is not found. The executor's reference lookups are the one unscoped path, and they
// return identities only.
//
// IDEMPOTENT. The same submission is the same job; a command is stored once; an event id
// is unique; a control never overrides a newer decision.
//
// Real constraints, real concurrency and real rollback are proven separately against
// Postgres (brain-persistence.postgres.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  BRAIN_DEFAULT_STEP_POLICIES,
  brainCallKey,
  brainStepResumeDecision,
  validateActivityItem,
  type BrainJobSnapshot,
  type BrainSubmission,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { BrainJobRepository, type BrainJobAcceptance } from '../src/repositories/brain/brain-job.repository';
import { BrainWaitRepository } from '../src/repositories/brain/brain-wait.repository';
import { BrainStepRepository } from '../src/repositories/brain/brain-step.repository';
import { BrainCommandRepository, BrainEventRepository } from '../src/repositories/brain/brain-command.repository';
import { BrainExecutionReferences } from '../src/repositories/brain/brain-execution-references';
import { AiControlRepository } from '../src/repositories/brain/ai-control.repository';
import { appendBrainEvent } from '../src/repositories/brain/brain-job-writes';
import {
  BrainPersistenceInvariantError,
  BrainRecordUnreadable,
  brainJobChanges,
  brainJobSnapshotOf,
  brainSealedPayloadRefusals,
} from '../src/repositories/brain/brain-records';
import { brainTaskRequirements, BrainEventActivityAdapter, brainEventActivityItem } from '../src/repositories/activity/brain-event.adapter';
import { AiUsageLedgerRepository, AI_INVOCATION_IN_FLIGHT } from '../src/repositories/ai-usage-ledger.repository';

const ORG = 'org_brain_a';
const OTHER = 'org_brain_b';
const PRINCIPAL = 'user_principal_1';
const ADMIN = 'user_admin_0001';
const OUTSIDER = 'user_outsider_1';
const DISABLED = 'user_disabled_1';
const T0 = new Date('2026-09-17T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const ANALYSIS_TASK: BrainJobAcceptance['task'] = {
  taskId: 'case.explanation',
  version: '2.0.0',
  capabilityRoute: 'TECHNICAL_ANALYSIS',
  resultType: 'ANALYSIS',
  resultOwner: { authority: 'COMMERCIAL_INTELLIGENCE', subjectType: 'CASE' },
  executionClasses: ['INTERACTIVE'],
};
const REVIEW_TASK: BrainJobAcceptance['task'] = {
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

const DURABLE_CTX = { supportsDurable: true, taskMayWait: true };
const INTERACTIVE_ONLY_CTX = { supportsDurable: false, taskMayWait: false };

function submission(task: BrainJobAcceptance['task'], over: Partial<BrainSubmission> = {}): BrainSubmission {
  const subjectId = { CASE: 'case_00000001', RELATIONSHIP: 'rel_00000001', CUSTOMER_CONVERSATION: 'conv_0000001' }[task.resultOwner.subjectType as string] ?? 'subj_0000001';
  return {
    taskId: task.taskId,
    subject: { type: task.resultOwner.subjectType, id: subjectId },
    executionClass: task.executionClasses[task.executionClasses.length - 1]!,
    idempotencyKey: 'idem-key-0001',
    input: { horizonDays: 90 },
    ...over,
  };
}

function world() {
  const fake: any = makeCognitivePrisma({
    also: ['organizationMembership', 'aiInvocation', 'brainJob', 'brainJobTransition', 'brainJobStep', 'brainJobWait', 'brainCommand', 'brainEvent', 'aiControl', 'aiControlCurrent'],
  });
  // Postgres generates 25-character cuids; the Brain identity contracts require ids of
  // eight characters or more, so the double hands out ids of the same shape.
  let seq = 0;
  for (const name of ['brainJob', 'brainCommand']) {
    const create = fake[name].create.bind(fake[name]);
    fake[name].create = ({ data }: { data: Record<string, unknown> }) =>
      create({ data: { id: `c${name.slice(5, 8).toLowerCase()}${String(++seq).padStart(20, '0')}`, ...data } });
  }
  for (const [organizationId, userId, status] of [
    [ORG, PRINCIPAL, 'ACTIVE'],
    [ORG, ADMIN, 'ACTIVE'],
    [ORG, DISABLED, 'DISABLED'],
    [OTHER, OUTSIDER, 'ACTIVE'],
  ] as const) {
    fake.organizationMembership.__rows.push({ id: `m_${userId}`, organizationId, userId, status, systemRole: 'ADMIN' });
  }
  const prisma = fake as PrismaClient;
  return {
    fake,
    prisma,
    jobs: new BrainJobRepository(prisma),
    waits: new BrainWaitRepository(prisma),
    steps: new BrainStepRepository(prisma),
    commands: new BrainCommandRepository(prisma),
    events: new BrainEventRepository(prisma),
    refs: new BrainExecutionReferences(prisma),
    controls: new AiControlRepository(prisma),
    ledger: new AiUsageLedgerRepository(prisma),
  };
}

type World = ReturnType<typeof world>;

async function accepted(w: World, task = REVIEW_TASK, over: Partial<BrainSubmission> = {}, organizationId = ORG, principal = PRINCIPAL) {
  const out = await w.jobs.accept(organizationId, { principalUserId: principal, task, submission: submission(task, over), now: T0 });
  assert.equal(out.kind, 'ACCEPTED', JSON.stringify(out));
  return out as Extract<typeof out, { kind: 'ACCEPTED' }>;
}

async function running(w: World, task = REVIEW_TASK, over: Partial<BrainSubmission> = {}) {
  const a = await accepted(w, task, over);
  const ctx = task.executionClasses.includes('DURABLE') ? DURABLE_CTX : INTERACTIVE_ONLY_CTX;
  assert.equal((await w.jobs.transition(ORG, a.job.jobId, { type: 'DISPATCHED' }, { context: ctx, now: at(1) })).ok, true);
  const started = await w.jobs.transition(ORG, a.job.jobId, { type: 'STARTED' }, { context: ctx, now: at(2) });
  assert.equal(started.ok, true);
  return a.job.jobId;
}

/** A measured count's value; an unmeasured one is a failure here, never zero. */
function countOf(t: { state: string; value?: unknown }): number {
  assert.ok(t.state === 'success' || t.state === 'empty', `measured: ${t.state}`);
  return t.value as number;
}

const REF = { owner: { authority: 'RELATIONSHIPS' as const, subjectType: 'RELATIONSHIP' as const }, subjectId: 'rel_00000001', artifactId: 'ana_0000001' };

function sealed(tag = 1) {
  // Test-only "sealed" bytes: a binary header and bytes that are not UTF-8 text.
  return { sealVersion: 'test-seal.1', keyRef: 'test/key-1', sealed: new Uint8Array([0x4c, 0x42, 0x53, 0x01, 0xff, 0xfe, 0x80, tag, 0x81, 0x00, 0xc3]) };
}

// --- Round trips ----------------------------------------------------------------------

test('an interactive job is accepted with its history, its event and its START command, and reads back as its snapshot', async () => {
  const w = world();
  const out = await accepted(w, ANALYSIS_TASK, { executionClass: 'INTERACTIVE' });
  const job = out.job;
  assert.equal(job.state, 'ACCEPTED');
  assert.equal(job.executionClass, 'INTERACTIVE');
  assert.equal(job.capabilityRoute, 'TECHNICAL_ANALYSIS');
  assert.equal(job.resultType, 'ANALYSIS');
  assert.deepEqual(job.resultOwner, { authority: 'COMMERCIAL_INTELLIGENCE', subjectType: 'CASE' });
  assert.deepEqual(job.subject, { type: 'CASE', id: 'case_00000001' });
  assert.equal(job.organizationId, ORG);
  assert.equal(job.principalUserId, PRINCIPAL);
  assert.equal(job.generation, 1);
  assert.equal(job.promoted, false);

  const record = await w.jobs.get(ORG, job.jobId);
  assert.deepEqual(record!.job, job, 'the stored row reads back as the same snapshot');
  assert.equal(record!.version, 0);
  assert.equal(record!.lastSequence, 1);
  assert.equal(record!.acceptedAt.getTime(), T0.getTime());
  assert.deepEqual(await w.jobs.input(ORG, job.jobId), { horizonDays: 90 });

  const history = await w.jobs.transitions(ORG, job.jobId);
  assert.deepEqual(history.map((t) => [t.sequence, t.kind, t.fromState, t.toState]), [[1, 'ACCEPTED', null, 'ACCEPTED']]);
  assert.deepEqual(history[0]!.actor, { kind: 'HUMAN', userId: PRINCIPAL });

  const events = await w.events.listForJob(ORG, job.jobId);
  assert.deepEqual(events.map((e) => [e.eventId, e.event.name]), [[`${job.jobId}#1`, 'brain.job.accepted']]);
  assert.equal(out.eventId, `${job.jobId}#1`);

  const command = await w.commands.get(ORG, out.commandId);
  assert.equal(command!.command.type, 'START');
  assert.equal(command!.command.jobId, job.jobId);
  assert.deepEqual(command!.command.issuedBy, { kind: 'HUMAN', userId: PRINCIPAL });
  assert.equal(command!.dispatchedAt, null);
  assert.equal(w.fake.brainCommand.__rows[0].dedupeKey, `start:${job.jobId}:1`);

  const row = w.fake.brainJob.__rows[0];
  for (const column of Object.keys(row)) {
    assert.doesNotMatch(column, /provider|model|fallback|routing|prompt|response|session|browser|connection/i, `brain_jobs has no ${column}`);
  }
});

test('durable and draft jobs round-trip, and the four declarations stay four separate columns', async () => {
  const w = world();
  const durable = await accepted(w, REVIEW_TASK, { executionClass: 'DURABLE' });
  const draft = await accepted(w, DRAFT_TASK, { executionClass: 'INTERACTIVE', idempotencyKey: 'idem-key-draft' });
  for (const out of [durable, draft]) {
    const back = await w.jobs.get(ORG, out.job.jobId);
    assert.deepEqual(back!.job, out.job);
  }
  assert.equal(durable.job.executionClass, 'DURABLE');
  assert.equal(draft.job.resultType, 'DRAFT');
  assert.equal(draft.job.capabilityRoute, 'COMMUNICATION');
  assert.deepEqual(draft.job.resultOwner, { authority: 'COMMUNICATIONS', subjectType: 'CUSTOMER_CONVERSATION' });

  const rows = w.fake.brainJob.__rows;
  const draftRow = rows.find((r: any) => r.id === draft.job.jobId);
  assert.equal(draftRow.capabilityRoute, 'COMMUNICATION');
  assert.equal(draftRow.resultType, 'DRAFT');
  assert.equal(draftRow.resultOwnerAuthority, 'COMMUNICATIONS');
  assert.equal(draftRow.resultSubjectType, 'CUSTOMER_CONVERSATION');
  assert.equal(draftRow.executionClass, 'INTERACTIVE');

  // Any combination the contracts allow is stored as given: the route does not imply the
  // result, and neither implies how it runs.
  const mixed = await accepted(w, { ...REVIEW_TASK, taskId: 'relationship.outreach-review', capabilityRoute: 'COMMUNICATION' }, {
    taskId: 'relationship.outreach-review',
    executionClass: 'DURABLE',
  });
  const technicalDraft = await accepted(w, { ...DRAFT_TASK, taskId: 'incident.writeup', capabilityRoute: 'TECHNICAL_ANALYSIS' }, {
    taskId: 'incident.writeup',
    executionClass: 'INTERACTIVE',
  });
  assert.deepEqual(
    [mixed.job, technicalDraft.job].map((j) => [j.capabilityRoute, j.resultType, j.resultOwner.authority, j.executionClass]),
    [
      ['COMMUNICATION', 'ANALYSIS', 'RELATIONSHIPS', 'DURABLE'],
      ['TECHNICAL_ANALYSIS', 'DRAFT', 'COMMUNICATIONS', 'INTERACTIVE'],
    ],
  );
});

test('the same request is the same job; a different request under a used key is refused', async () => {
  const w = world();
  const first = await accepted(w);
  let inserts = 0;
  const create = w.fake.brainJob.create;
  w.fake.brainJob.create = (args: unknown) => {
    inserts += 1;
    return create(args);
  };
  const again = await w.jobs.accept(ORG, { principalUserId: PRINCIPAL, task: REVIEW_TASK, submission: submission(REVIEW_TASK), now: at(5) });
  assert.equal(inserts, 0, 'a retried request reads its job and attempts no insert');
  w.fake.brainJob.create = create;
  assert.equal(again.kind, 'EXISTING');
  assert.equal((again as any).job.jobId, first.job.jobId);
  const changed = await w.jobs.accept(ORG, {
    principalUserId: PRINCIPAL,
    task: REVIEW_TASK,
    submission: submission(REVIEW_TASK, { input: { horizonDays: 30 } }),
  });
  assert.deepEqual(changed, { kind: 'REFUSED', refusal: 'IDEMPOTENCY_KEY_REUSED' });
  // The key is scoped to (organization, principal, task).
  const otherPerson = await w.jobs.accept(ORG, { principalUserId: ADMIN, task: REVIEW_TASK, submission: submission(REVIEW_TASK) });
  assert.equal(otherPerson.kind, 'ACCEPTED');
  const otherTask = await w.jobs.accept(ORG, {
    principalUserId: PRINCIPAL,
    task: { ...REVIEW_TASK, taskId: 'relationship.health' },
    submission: submission(REVIEW_TASK, { taskId: 'relationship.health' }),
  });
  assert.equal(otherTask.kind, 'ACCEPTED');
  assert.equal(w.fake.brainJob.__rows.length, 3);
  assert.equal(w.fake.brainCommand.__rows.filter((c: any) => c.jobId === first.job.jobId).length, 1, 'one START for the one job');
});

test('acceptance refuses what a Brain record must never be', async () => {
  const w = world();
  const refusal = async (input: Partial<BrainJobAcceptance>, organizationId = ORG) => {
    const out = await w.jobs.accept(organizationId, { principalUserId: PRINCIPAL, task: REVIEW_TASK, submission: submission(REVIEW_TASK), ...input });
    return out.kind === 'REFUSED' ? out.refusal : out.kind;
  };
  assert.equal(await refusal({ submission: { ...submission(REVIEW_TASK), input: { organizationId: OTHER } } }), 'INVALID_SUBMISSION');
  assert.equal(await refusal({ submission: { ...submission(REVIEW_TASK), organizationId: OTHER } as never }), 'INVALID_SUBMISSION');
  assert.equal(await refusal({ task: { ...REVIEW_TASK, capabilityRoute: 'DRAFTING' as never } }), 'UNKNOWN_CAPABILITY_ROUTE');
  assert.equal(
    await refusal({ task: { ...DRAFT_TASK, resultOwner: { authority: 'DECISION_ENGINE', subjectType: 'DECISION' } }, submission: submission(DRAFT_TASK) }),
    'OWNERSHIP_NOT_PERMITTED',
    'a draft never lands on the approval path',
  );
  assert.equal(await refusal({ submission: submission(REVIEW_TASK, { subject: { type: 'CASE', id: 'case_1' } }) }), 'SUBJECT_TYPE_MISMATCH');
  assert.equal(await refusal({ submission: submission(REVIEW_TASK, { taskId: 'another.task' }) }), 'SUBJECT_TYPE_MISMATCH');
  assert.equal(await refusal({ task: ANALYSIS_TASK, submission: submission(ANALYSIS_TASK, { executionClass: 'DURABLE' }) }), 'EXECUTION_CLASS_NOT_SUPPORTED');
  assert.equal(await refusal({ principalUserId: OUTSIDER }), 'PRINCIPAL_NOT_ACTIVE_MEMBER', 'a member of another organization');
  assert.equal(await refusal({ principalUserId: DISABLED }), 'PRINCIPAL_NOT_ACTIVE_MEMBER');
  assert.equal(await refusal({}, OTHER), 'PRINCIPAL_NOT_ACTIVE_MEMBER', 'the organization is never taken from the principal');
  assert.equal(await refusal({ resumesJobId: 'cjob_does_not_exist' }), 'RESUMED_JOB_NOT_RESUMABLE');
  assert.equal(w.fake.brainJob.__rows.length, 0, 'nothing was written');
});

test("another organization's Brain records are not found, by any path", async () => {
  const w = world();
  const jobId = await running(w, REVIEW_TASK, { executionClass: 'DURABLE' });
  const wait = await w.waits.open(ORG, jobId, {
    question: { schemaId: 'clarify', schemaVersion: '1', body: { choose: ['a', 'b'] } },
    expiresAt: at(3600),
    context: DURABLE_CTX,
    now: at(3),
  });
  assert.equal(wait.ok, true);
  const waitId = (wait as any).waitId as string;
  const commandId = w.fake.brainCommand.__rows[0].id as string;

  assert.equal(await w.jobs.get(OTHER, jobId), null);
  assert.equal(await w.jobs.input(OTHER, jobId), null);
  assert.deepEqual(await w.jobs.transitions(OTHER, jobId), []);
  assert.deepEqual(await w.jobs.transition(OTHER, jobId, { type: 'FAILED', reason: 'INTERNAL' }, { context: DURABLE_CTX }), {
    ok: false,
    refusal: 'JOB_NOT_FOUND',
  });
  assert.deepEqual(await w.jobs.requestCancel(OTHER, jobId, { actor: { kind: 'HUMAN', userId: OUTSIDER }, reason: 'REQUESTED_BY_ADMINISTRATOR' }), {
    ok: false,
    refusal: 'JOB_NOT_FOUND',
  });
  assert.equal((await w.jobs.lease(OTHER, jobId, { holder: 'worker-x', generation: 1, durationMs: 1000 })).ok, false);
  assert.equal(await w.waits.get(OTHER, waitId), null);
  assert.deepEqual(await w.waits.answer(OTHER, { waitId, responderUserId: OUTSIDER, reply: { pick: 'a' } }), { ok: false, refusal: 'WAIT_NOT_FOUND' });
  assert.deepEqual(await w.waits.expire(OTHER, jobId, waitId, { now: at(9999) }), { ok: false, refusal: 'WAIT_NOT_FOUND' });
  assert.deepEqual(await w.steps.resumeState(OTHER, jobId, 'model.primary', 'fp-1'), { ok: false, refusal: 'JOB_NOT_FOUND' });
  assert.equal(await w.commands.get(OTHER, commandId), null);
  assert.equal(await w.commands.markDispatched(OTHER, commandId, at(4)), false);
  assert.deepEqual(await w.commands.listForJob(OTHER, jobId), []);
  assert.deepEqual(await w.events.listForJob(OTHER, jobId), []);
  assert.equal(countOf(await w.jobs.countUnfinishedForPrincipal(OTHER, PRINCIPAL)), 0);
  // Nothing was changed by any of it.
  assert.equal((await w.jobs.get(ORG, jobId))!.job.state, 'WAITING_FOR_USER');
  // The executor's reference lookup finds the job's own organization, and only that.
  assert.deepEqual(await w.refs.resolveJob({ jobId, generation: 1 }), { organizationId: ORG, jobId, generation: 1 });
  assert.equal(await w.refs.resolveJob({ jobId, generation: 2 }), null, 'a stale generation resolves to nothing');
  assert.deepEqual(await w.refs.resolveCommand(commandId), { organizationId: ORG, commandId, jobId });
});

// --- Transitions and promotion -----------------------------------------------------------

test('a job moves only by contract, with its history and events, and a terminal job never moves again', async () => {
  const w = world();
  const a = await accepted(w, ANALYSIS_TASK, { executionClass: 'INTERACTIVE' });
  const jobId = a.job.jobId;
  assert.deepEqual(await w.jobs.transition(ORG, jobId, { type: 'STARTED' }, { context: INTERACTIVE_ONLY_CTX }), {
    ok: false,
    refusal: 'EVENT_NOT_ALLOWED_IN_STATE',
  });
  const dispatched = await w.jobs.transition(ORG, jobId, { type: 'DISPATCHED' }, { context: INTERACTIVE_ONLY_CTX, now: at(1), expectedVersion: 0 });
  assert.equal(dispatched.ok && dispatched.job.state, 'QUEUED');
  assert.deepEqual(
    await w.jobs.transition(ORG, jobId, { type: 'STARTED' }, { context: INTERACTIVE_ONLY_CTX, expectedVersion: 0 }),
    { ok: false, refusal: 'VERSION_CONFLICT' },
    'a writer that read an older version changes nothing',
  );
  await w.jobs.transition(ORG, jobId, { type: 'STARTED' }, { context: INTERACTIVE_ONLY_CTX, now: at(2), expectedVersion: 1 });
  const ref = { owner: { authority: 'COMMERCIAL_INTELLIGENCE' as const, subjectType: 'CASE' as const }, subjectId: 'case_00000001', artifactId: 'expl_00001' };
  const done = await w.jobs.transition(ORG, jobId, { type: 'RESULT_COMMITTED', resultRefs: [ref] }, { context: INTERACTIVE_ONLY_CTX, now: at(3) });
  assert.equal(done.ok && done.job.state, 'SUCCEEDED');
  assert.equal(done.ok && done.eventId, `${jobId}#4`);

  const record = await w.jobs.get(ORG, jobId);
  assert.equal(record!.startedAt!.getTime(), at(2).getTime());
  assert.equal(record!.endedAt!.getTime(), at(3).getTime());
  assert.deepEqual(record!.job.resultRefs, [ref]);
  assert.equal(record!.version, 3);
  assert.equal(record!.lastSequence, 4);

  for (const event of [{ type: 'FAILED', reason: 'INTERNAL' }, { type: 'DISPATCHED' }] as const) {
    assert.deepEqual(await w.jobs.transition(ORG, jobId, event, { context: INTERACTIVE_ONLY_CTX }), { ok: false, refusal: 'JOB_IS_TERMINAL' });
  }
  assert.deepEqual((await w.jobs.transitions(ORG, jobId)).map((t) => t.kind), ['ACCEPTED', 'DISPATCHED', 'STARTED', 'RESULT_COMMITTED']);
  const events = await w.events.listForJob(ORG, jobId);
  assert.deepEqual(events.map((e) => [e.sequence, e.event.name]), [[1, 'brain.job.accepted'], [4, 'brain.job.succeeded']]);
  assert.deepEqual(events[1]!.event.resultRefs, [ref], 'a success points at where the result lives');
  assert.deepEqual(events[0]!.event.resultRefs, []);
});

test('promotion makes the job durable and changes nothing else about it', async () => {
  const w = world();
  const jobId = await running(w, REVIEW_TASK, { executionClass: 'INTERACTIVE' });
  const before = (await w.jobs.get(ORG, jobId))!.job;
  assert.equal(before.executionClass, 'INTERACTIVE');
  const promoted = await w.jobs.transition(ORG, jobId, { type: 'PROMOTED' }, { context: DURABLE_CTX, now: at(10) });
  assert.equal(promoted.ok, true);
  const after = (await w.jobs.get(ORG, jobId))!;
  assert.equal(after.job.executionClass, 'DURABLE');
  assert.equal(after.job.promoted, true);
  assert.equal(after.promotedAt!.getTime(), at(10).getTime());
  for (const field of ['jobId', 'generation', 'organizationId', 'principalUserId', 'taskId', 'taskVersion', 'capabilityRoute', 'resultType', 'resultOwner', 'subject', 'state', 'resumesJobId', 'resultRefs'] as const) {
    assert.deepEqual(after.job[field], before[field], `${field} is untouched by promotion`);
  }
  const history = await w.jobs.transitions(ORG, jobId);
  assert.deepEqual(history.map((t) => [t.kind, t.executionClass]), [
    ['ACCEPTED', 'INTERACTIVE'],
    ['DISPATCHED', 'INTERACTIVE'],
    ['STARTED', 'INTERACTIVE'],
    ['PROMOTED', 'DURABLE'],
  ]);
  assert.ok((await w.events.listForJob(ORG, jobId)).some((e) => e.event.name === 'brain.job.promoted'));
  assert.deepEqual(await w.jobs.transition(ORG, jobId, { type: 'PROMOTED' }, { context: DURABLE_CTX }), { ok: false, refusal: 'ALREADY_PROMOTED' });

  const quick = await running(w, ANALYSIS_TASK, { executionClass: 'INTERACTIVE', idempotencyKey: 'idem-key-quick' });
  assert.deepEqual(await w.jobs.transition(ORG, quick, { type: 'PROMOTED' }, { context: INTERACTIVE_ONLY_CTX }), {
    ok: false,
    refusal: 'PROMOTION_NOT_SUPPORTED',
  });
  assert.equal((await w.jobs.get(ORG, quick))!.job.executionClass, 'INTERACTIVE');
});

test('the persistence layer refuses any decided change that would move what a job is', () => {
  const w = world();
  const base: BrainJobSnapshot = {
    jobId: 'cjob00000000000000000001',
    generation: 1,
    organizationId: ORG,
    principalUserId: PRINCIPAL,
    taskId: 'reply.draft',
    taskVersion: '1.0.0',
    capabilityRoute: 'COMMUNICATION',
    resultType: 'DRAFT',
    resultOwner: { authority: 'COMMUNICATIONS', subjectType: 'CUSTOMER_CONVERSATION' },
    subject: { type: 'CUSTOMER_CONVERSATION', id: 'conv_0000001' },
    executionClass: 'INTERACTIVE',
    promoted: false,
    state: 'RUNNING',
    cancelRequest: null,
    wait: null,
    resultRefs: [],
    endReason: null,
    resumesJobId: null,
  };
  void w;
  const moved: Partial<BrainJobSnapshot>[] = [
    { capabilityRoute: 'TECHNICAL_ANALYSIS' },
    { resultType: 'PROPOSED_ACTION' },
    { resultOwner: { authority: 'DECISION_ENGINE', subjectType: 'DECISION' } },
    { subject: { type: 'CUSTOMER_CONVERSATION', id: 'conv_other' } },
    { principalUserId: ADMIN },
    { organizationId: OTHER },
    { taskId: 'another.task' },
    { taskVersion: '2.0.0' },
    { generation: 2 },
    { resumesJobId: 'cjob_other' },
    { executionClass: 'DURABLE' },
    { promoted: true },
  ];
  for (const change of moved) {
    assert.throws(() => brainJobChanges(base, { ...base, ...change }, T0), BrainPersistenceInvariantError, JSON.stringify(change));
  }
  const requested = { ...base, cancelRequest: { actor: { kind: 'HUMAN' as const, userId: PRINCIPAL }, reason: 'REQUESTED_BY_PRINCIPAL' as const } };
  assert.throws(
    () => brainJobChanges(requested, { ...requested, cancelRequest: { actor: { kind: 'HUMAN', userId: ADMIN }, reason: 'REQUESTED_BY_ADMINISTRATOR' } }, T0),
    BrainPersistenceInvariantError,
    'the first cancel request stands',
  );
  assert.throws(() => brainJobChanges(requested, { ...requested, cancelRequest: null }, T0), BrainPersistenceInvariantError);
  const promotion = brainJobChanges(base, { ...base, executionClass: 'DURABLE', promoted: true }, T0);
  assert.deepEqual(promotion, { executionClass: 'DURABLE', promotedAt: T0 }, 'promotion writes the class and its stamp, nothing else');
  assert.deepEqual(brainJobChanges(base, base, T0), {});
});

test('a row outside the current vocabulary is unreadable, never guessed at', async () => {
  const w = world();
  const a = await accepted(w);
  const row = { ...w.fake.brainJob.__rows[0] };
  assert.deepEqual(brainJobSnapshotOf(row), a.job);
  for (const [column, value] of [
    ['resultType', 'SUMMARY'],
    ['capabilityRoute', 'DRAFTING'],
    ['resultOwnerAuthority', 'ACTIVITY'],
    ['resultSubjectType', 'PERSON'],
    ['executionClass', 'BATCH'],
    ['state', 'PAUSED'],
    ['resultRefs', [{ owner: { authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP' }, subjectId: 's', artifactId: 'a', summary: 'x' }]],
    ['resultRefs', {}],
    ['endReason', 'PAGE_CLOSED'],
  ] as const) {
    assert.throws(() => brainJobSnapshotOf({ ...row, [column]: value }), BrainRecordUnreadable, column);
  }
});

// --- Leases -----------------------------------------------------------------------------

test('one worker holds a job at a time; an expired lease is taken over; an ended job holds none', async () => {
  const w = world();
  const jobId = await running(w, ANALYSIS_TASK, { executionClass: 'INTERACTIVE' });
  const first = await w.jobs.lease(ORG, jobId, { holder: 'worker-a', generation: 1, durationMs: 30_000, now: at(10) });
  assert.equal(first.ok && first.decision.action, 'ACQUIRE');
  const busy = await w.jobs.lease(ORG, jobId, { holder: 'worker-b', generation: 1, durationMs: 30_000, now: at(20) });
  assert.deepEqual(busy, { ok: false, reason: 'BUSY', holder: 'worker-a', retryAfterMs: 20_000 });
  const renew = await w.jobs.lease(ORG, jobId, { holder: 'worker-a', generation: 1, durationMs: 30_000, now: at(25) });
  assert.equal(renew.ok && renew.decision.action, 'RENEW');
  const takeover = await w.jobs.lease(ORG, jobId, { holder: 'worker-b', generation: 1, durationMs: 30_000, now: at(56) });
  assert.deepEqual(takeover.ok && takeover.decision, { action: 'TAKE_OVER', previousHolder: 'worker-a' });
  assert.deepEqual(await w.jobs.lease(ORG, jobId, { holder: 'worker-c', generation: 2, durationMs: 1, now: at(57) }), {
    ok: false,
    reason: 'GENERATION_MISMATCH',
  });
  // Advancing requires holding the lease when the writer says it does.
  assert.deepEqual(
    await w.jobs.transition(ORG, jobId, { type: 'FAILED', reason: 'INTERNAL' }, { context: INTERACTIVE_ONLY_CTX, leaseHolder: 'worker-a', now: at(58) }),
    { ok: false, refusal: 'LEASE_NOT_HELD' },
  );
  assert.equal(await w.jobs.addActiveTime(ORG, jobId, 'worker-a', 500), false, 'only the holder records time');
  assert.equal(await w.jobs.addActiveTime(ORG, jobId, 'worker-b', 1500), true);
  const failed = await w.jobs.transition(ORG, jobId, { type: 'FAILED', reason: 'PROVIDER_UNAVAILABLE' }, { context: INTERACTIVE_ONLY_CTX, leaseHolder: 'worker-b', now: at(59) });
  assert.equal(failed.ok, true);
  const record = (await w.jobs.get(ORG, jobId))!;
  assert.equal(record.lease, null, 'an ended job holds no lease');
  assert.equal(record.activeElapsedMs, 1500);
  assert.equal(record.job.endReason, 'PROVIDER_UNAVAILABLE');
  assert.deepEqual(await w.jobs.lease(ORG, jobId, { holder: 'worker-b', generation: 1, durationMs: 1 }), { ok: false, reason: 'JOB_IS_TERMINAL' });
  await assert.rejects(w.jobs.lease(ORG, jobId, { holder: 'has space', generation: 1, durationMs: 1 }), /invalid lease holder/);
  await assert.rejects(w.jobs.lease(ORG, jobId, { holder: 'worker-b', generation: 1, durationMs: 0 }), /lease duration/);
});

// --- WAITING_FOR_USER ---------------------------------------------------------------------

test('a durable job waits for its principal, accepts one reply, and resumes only when access is re-decided', async () => {
  const w = world();
  const jobId = await running(w, REVIEW_TASK, { executionClass: 'DURABLE' });
  const question = { schemaId: 'relationship.clarify', schemaVersion: '1', body: { prompt: 'Which renewal date applies?', options: ['2026-10-01', '2026-11-01'] } };
  const opened = await w.waits.open(ORG, jobId, { question, expiresAt: at(86_400), context: DURABLE_CTX, now: at(3) });
  assert.equal(opened.ok, true);
  const waitId = (opened as any).waitId as string;
  let record = (await w.jobs.get(ORG, jobId))!;
  assert.equal(record.job.state, 'WAITING_FOR_USER');
  assert.deepEqual(record.job.wait, { waitId, expiresAtMs: at(86_400).getTime() });
  assert.equal(countOf(await w.jobs.countUnfinishedForPrincipal(ORG, PRINCIPAL)), 1, 'still "working" while it waits');
  const view = await w.waits.get(ORG, waitId);
  assert.deepEqual(view!.question, question);
  assert.equal(view!.wait.status, 'OPEN');

  assert.deepEqual(await w.waits.resume(ORG, jobId, { waitId, responderPermitted: true, now: at(9) }), {
    ok: false,
    refusal: 'REPLY_NOT_RECORDED',
  }, 'nothing resumes before a reply is recorded');
  // Nobody else may answer, and a refused reply stores nothing.
  assert.deepEqual(await w.waits.answer(ORG, { waitId, responderUserId: ADMIN, reply: { pick: '2026-10-01' }, now: at(10) }), {
    ok: false,
    refusal: 'RESPONDER_IS_NOT_PRINCIPAL',
  });
  assert.equal(w.fake.brainCommand.__rows.filter((c: any) => c.type === 'RESUME').length, 0);

  const recorded = await w.waits.answer(ORG, { waitId, responderUserId: PRINCIPAL, reply: { pick: '2026-10-01' }, now: at(11) });
  assert.equal(recorded.ok && recorded.recorded, 'NOW');
  const again = await w.waits.answer(ORG, { waitId, responderUserId: PRINCIPAL, reply: { pick: '2026-10-01' }, now: at(12) });
  assert.equal(again.ok && again.recorded, 'ALREADY', 'a double click is the same reply');
  assert.equal(again.ok && recorded.ok && again.commandId, recorded.ok && recorded.commandId, 'and the same RESUME command');
  assert.deepEqual(await w.waits.answer(ORG, { waitId, responderUserId: PRINCIPAL, reply: { pick: '2026-11-01' }, now: at(13) }), {
    ok: false,
    refusal: 'WAIT_ALREADY_ANSWERED',
  });
  const resumeCommand = w.fake.brainCommand.__rows.filter((c: any) => c.type === 'RESUME');
  assert.equal(resumeCommand.length, 1);
  assert.equal(resumeCommand[0].dedupeKey, `resume:${jobId}:1:${waitId}`);
  // Recording the reply does not move the job.
  record = (await w.jobs.get(ORG, jobId))!;
  assert.equal(record.job.state, 'WAITING_FOR_USER');

  assert.deepEqual(await w.waits.resume(ORG, jobId, { waitId, responderPermitted: false, now: at(20) }), {
    ok: false,
    refusal: 'RESPONDER_NOT_PERMITTED',
  });
  const resumed = await w.waits.resume(ORG, jobId, { waitId, responderPermitted: true, now: at(21) });
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.ok && resumed.reply, { pick: '2026-10-01' }, 'the reply is read from Loop, never carried');
  record = (await w.jobs.get(ORG, jobId))!;
  assert.equal(record.job.state, 'RUNNING');
  assert.equal(record.job.wait, null);
  assert.equal((await w.waits.get(ORG, waitId))!.wait.status, 'ANSWERED');
  const kinds = (await w.jobs.transitions(ORG, jobId)).map((t) => [t.kind, t.waitId]);
  assert.deepEqual(kinds.slice(-2), [['USER_INPUT_REQUESTED', waitId], ['USER_INPUT_RECEIVED', waitId]]);
  assert.deepEqual((await w.jobs.transitions(ORG, jobId)).at(-1)!.actor, { kind: 'HUMAN', userId: PRINCIPAL });
});

test('only durable work waits, a wait must end in the future, and a job has one open question', async () => {
  const w = world();
  const quick = await running(w, REVIEW_TASK, { executionClass: 'INTERACTIVE' });
  const q = { schemaId: 'clarify', schemaVersion: '1', body: { choose: true } };
  assert.deepEqual(await w.waits.open(ORG, quick, { question: q, expiresAt: at(100), context: DURABLE_CTX, now: at(3) }), {
    ok: false,
    refusal: 'INTERACTIVE_CANNOT_WAIT',
  });
  const durable = await running(w, REVIEW_TASK, { executionClass: 'DURABLE', idempotencyKey: 'idem-key-dur' });
  assert.deepEqual(await w.waits.open(ORG, durable, { question: q, expiresAt: at(100), context: { supportsDurable: true, taskMayWait: false }, now: at(3) }), {
    ok: false,
    refusal: 'TASK_NEVER_WAITS',
  });
  assert.deepEqual(await w.waits.open(ORG, durable, { question: q, expiresAt: at(3), context: DURABLE_CTX, now: at(3) }), {
    ok: false,
    refusal: 'EXPIRY_NOT_IN_FUTURE',
  });
  await assert.rejects(w.waits.open(ORG, durable, { question: { ...q, body: ['not', 'an', 'object'] as never }, expiresAt: at(100), context: DURABLE_CTX, now: at(3) }), BrainPersistenceInvariantError);
  await assert.rejects(
    w.waits.open(ORG, durable, { question: { ...q, body: { blob: 'x'.repeat(20_000) } }, expiresAt: at(100), context: DURABLE_CTX, now: at(3) }),
    /too large/,
  );
  assert.equal((await w.waits.open(ORG, durable, { question: q, expiresAt: at(100), context: DURABLE_CTX, now: at(3) })).ok, true);
  assert.deepEqual(await w.waits.open(ORG, durable, { question: q, expiresAt: at(100), context: DURABLE_CTX, now: at(4) }), {
    ok: false,
    refusal: 'EVENT_NOT_ALLOWED_IN_STATE',
  });
  assert.equal(w.fake.brainJobWait.__rows.length, 1);
});

test('an unanswered question expires into a named cancellation, and a late reply is refused', async () => {
  const w = world();
  const jobId = await running(w, REVIEW_TASK, { executionClass: 'DURABLE' });
  const opened = await w.waits.open(ORG, jobId, { question: { schemaId: 'c', schemaVersion: '1', body: { q: 1 } }, expiresAt: at(100), context: DURABLE_CTX, now: at(3) });
  const waitId = (opened as any).waitId as string;
  assert.deepEqual(await w.waits.expire(ORG, jobId, waitId, { now: at(99) }), { ok: false, refusal: 'NOT_YET_EXPIRED' });
  const expired = await w.waits.expire(ORG, jobId, waitId, { now: at(100) });
  assert.equal(expired.ok && expired.job.state, 'CANCELLED');
  assert.equal(expired.ok && expired.job.endReason, 'WAIT_EXPIRED');
  const view = (await w.waits.get(ORG, waitId))!;
  assert.equal(view.wait.status, 'EXPIRED');
  assert.equal(view.closedAt!.getTime(), at(100).getTime());
  assert.equal(w.fake.brainJobWait.__rows[0].openJobKey, null, 'the open-question key is released');
  assert.deepEqual(await w.waits.answer(ORG, { waitId, responderUserId: PRINCIPAL, reply: { a: 1 }, now: at(101) }), {
    ok: false,
    refusal: 'WAIT_EXPIRED',
  });
  assert.ok((await w.events.listForJob(ORG, jobId)).some((e) => e.event.name === 'brain.job.cancelled' && e.event.reason === 'WAIT_EXPIRED'));
});

// --- Cancellation -----------------------------------------------------------------------

test('cancelling stops idle work at once and running work at its boundary, with one attributed command', async () => {
  const w = world();
  const principal = { kind: 'HUMAN' as const, userId: PRINCIPAL };
  const admin = { kind: 'HUMAN' as const, userId: ADMIN };

  const idle = await accepted(w, REVIEW_TASK, { idempotencyKey: 'idem-key-idle' });
  const stopped = await w.jobs.requestCancel(ORG, idle.job.jobId, { actor: principal, reason: 'REQUESTED_BY_PRINCIPAL' }, { now: at(5) });
  assert.equal(stopped.ok && stopped.stoppedNow, true);
  assert.equal(stopped.ok && stopped.job.state, 'CANCELLED');
  assert.deepEqual(stopped.ok && stopped.job.cancelRequest, { actor: principal, reason: 'REQUESTED_BY_PRINCIPAL' });
  assert.deepEqual(await w.jobs.requestCancel(ORG, idle.job.jobId, { actor: admin, reason: 'REQUESTED_BY_ADMINISTRATOR' }), {
    ok: false,
    refusal: 'JOB_IS_TERMINAL',
  });

  const busy = await running(w, REVIEW_TASK, { idempotencyKey: 'idem-key-busy' });
  const asked = await w.jobs.requestCancel(ORG, busy, { actor: principal, reason: 'REQUESTED_BY_PRINCIPAL' }, { now: at(6) });
  assert.equal(asked.ok && asked.stoppedNow, false);
  assert.equal(asked.ok && asked.job.state, 'RUNNING');
  const second = await w.jobs.requestCancel(ORG, busy, { actor: { kind: 'POLICY', policy: 'kill-switch:GLOBAL' }, reason: 'KILL_SWITCH' }, { now: at(7) });
  assert.equal(second.ok && asked.ok && second.commandId, asked.ok && asked.commandId, 'one CANCEL per generation');
  assert.deepEqual(second.ok && second.job.cancelRequest, { actor: principal, reason: 'REQUESTED_BY_PRINCIPAL' }, 'the first request stands');
  assert.deepEqual(
    await w.jobs.transition(ORG, busy, { type: 'RESULT_COMMITTED', resultRefs: [REF] }, { context: DURABLE_CTX }),
    { ok: false, refusal: 'CANCEL_PENDING' },
    'a result that arrives after a cancel is never applied',
  );
  const settled = await w.jobs.transition(ORG, busy, { type: 'CANCEL_SETTLED' }, { context: DURABLE_CTX, now: at(8) });
  assert.equal(settled.ok && settled.job.state, 'CANCELLED');
  assert.equal(settled.ok && settled.job.endReason, 'REQUESTED_BY_PRINCIPAL');
  const cancels = w.fake.brainCommand.__rows.filter((c: any) => c.jobId === busy && c.type === 'CANCEL');
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].issuerUserId, PRINCIPAL);
  assert.equal(
    (await w.jobs.transitions(ORG, busy)).filter((t) => t.kind === 'CANCEL_REQUESTED').length,
    1,
    'a repeated request that changed nothing wrote no history',
  );

  // A waiting job stops at once, and its question is closed with it.
  const waiting = await running(w, REVIEW_TASK, { executionClass: 'DURABLE', idempotencyKey: 'idem-key-wait' });
  const opened = await w.waits.open(ORG, waiting, { question: { schemaId: 'c', schemaVersion: '1', body: { q: 1 } }, expiresAt: at(500), context: DURABLE_CTX, now: at(9) });
  const waitId = (opened as any).waitId as string;
  const closed = await w.jobs.requestCancel(ORG, waiting, { actor: admin, reason: 'REQUESTED_BY_ADMINISTRATOR' }, { now: at(10) });
  assert.equal(closed.ok && closed.job.state, 'CANCELLED');
  assert.equal((await w.waits.get(ORG, waitId))!.wait.status, 'CLOSED');
  assert.deepEqual(await w.waits.answer(ORG, { waitId, responderUserId: PRINCIPAL, reply: { a: 1 }, now: at(11) }), { ok: false, refusal: 'WAIT_CLOSED' });
  assert.equal(countOf(await w.jobs.countUnfinishedForPrincipal(ORG, PRINCIPAL)), 0);
});

// --- Commands and events ------------------------------------------------------------------

test('a dispatch is recorded idempotently, and the sweeper finds only commands nobody handed over', async () => {
  const w = world();
  const a = await accepted(w);
  const b = await accepted(w, REVIEW_TASK, { idempotencyKey: 'idem-key-0002' });
  assert.equal(await w.commands.markDispatched(ORG, a.commandId, at(1)), true);
  assert.equal(await w.commands.markDispatched(ORG, a.commandId, at(2)), true);
  const record = (await w.commands.get(ORG, a.commandId))!;
  assert.equal(record.dispatchedAt!.getTime(), at(1).getTime(), 'the first hand-over is kept');
  assert.equal(record.lastDispatchedAt!.getTime(), at(2).getTime());
  assert.equal(record.dispatchCount, 2);
  const lost = await w.refs.undispatchedCommands(at(60));
  assert.deepEqual(lost, [{ organizationId: ORG, commandId: b.commandId, jobId: b.job.jobId }]);
  assert.deepEqual(await w.refs.undispatchedCommands(T0), [], 'only commands older than the cut-off');
});

test('an event id is unique and derived from its transition, and an event carries no content', async () => {
  const w = world();
  const a = await accepted(w);
  const event = {
    name: 'brain.job.failed' as const,
    organizationId: ORG,
    jobId: a.job.jobId,
    taskId: a.job.taskId,
    resultType: a.job.resultType,
    occurredAt: at(3).toISOString(),
    actor: { kind: 'SYSTEM' as const },
    resultRefs: [],
    reason: 'INTERNAL',
  };
  await assert.rejects(appendBrainEvent(w.prisma, event, 1), (err: any) => err.code === 'P2002', 'sequence 1 already has its event');
  await assert.rejects(appendBrainEvent(w.prisma, { ...event, summary: 'Revenue fell.' } as never, 9), BrainPersistenceInvariantError);
  await assert.rejects(
    appendBrainEvent(w.prisma, { ...event, resultRefs: [REF] }, 9),
    BrainPersistenceInvariantError,
    'only a success points at results',
  );
  await assert.rejects(appendBrainEvent(w.prisma, { ...event, name: 'brain.job.exploded' as never }, 9), BrainPersistenceInvariantError);
  const allowed = new Set(['id', 'organizationId', 'jobId', 'sequence', 'name', 'taskId', 'resultType', 'occurredAt', 'actorKind', 'actorUserId', 'actorPolicy', 'resultRefs', 'reason', 'createdAt', 'updatedAt']);
  for (const row of w.fake.brainEvent.__rows) {
    for (const key of Object.keys(row)) assert.ok(allowed.has(key), `brain_events stores no ${key}`);
    assert.equal(row.id, `${row.jobId}#${row.sequence}`);
  }
});

// --- Steps and checkpoints ---------------------------------------------------------------

test('a checkpoint is consulted first; a lost paid call counts as spent; a finished step never runs again', async () => {
  const w = world();
  const jobId = await running(w, REVIEW_TASK, { executionClass: 'DURABLE' });
  const policy = BRAIN_DEFAULT_STEP_POLICIES.MODEL_CALL;
  const step = { stepKey: 'model.primary', kind: 'MODEL_CALL' as const, inputFingerprint: 'fp-ctx-0001' };

  let state = await w.steps.resumeState(ORG, jobId, step.stepKey, step.inputFingerprint);
  assert.deepEqual(state, { ok: true, checkpointed: false, checkpoint: null, attemptsMade: 0, paidAttemptsMade: 0, inFlightCallKeys: [] });
  assert.deepEqual(brainStepResumeDecision(policy, state as any), { action: 'EXECUTE', attempt: 1 });
  assert.deepEqual(await w.steps.beginAttempt(ORG, jobId, { ...step, attempt: 1, paid: true, now: at(5) }), { ok: true, attempt: 1 });
  assert.deepEqual(await w.steps.beginAttempt(ORG, jobId, { ...step, attempt: 1, paid: true }), { ok: false, refusal: 'ATTEMPT_CONFLICT' }, 'two workers cannot both start attempt 1');

  // The call was reserved, and the worker died before its result was checkpointed.
  const callKey = brainCallKey(jobId, step.stepKey, 1, 1);
  await w.ledger.reserve(ORG, {
    invocationId: callKey,
    principalUserId: PRINCIPAL,
    taskId: 'relationship.review',
    taskVersion: '1.0.0',
    capabilityRoute: 'TECHNICAL_ANALYSIS',
    providerId: 'provider-a',
    requestedModelId: 'model-a',
    routingPolicyVersion: 'routing.test.1',
    specializationPolicyVersion: 'specialization.test.1',
    templateId: 't',
    templateVersion: '1',
    contextSourceRefs: ['evidence:ev_1'],
    estimatedInputTokens: 100,
    estimatedOutputTokens: 100,
    estimatedCostMicros: null,
    unitCostBasis: null,
    businessDate: '2026-09-17',
    requestedAt: at(5),
    brainJobId: jobId,
    brainStepKey: step.stepKey,
  });
  const ledgerRow = w.fake.aiInvocation.__rows[0];
  assert.equal(ledgerRow.brainJobId, jobId);
  assert.equal(ledgerRow.brainStepKey, step.stepKey);
  assert.equal(ledgerRow.specializationPolicyVersion, 'specialization.test.1');
  assert.equal(ledgerRow.profile, 'TECHNICAL_ANALYSIS', 'the capability route stays in profile');

  // Another step's lost call is that step's business, not this one's.
  await w.steps.beginAttempt(ORG, jobId, { stepKey: 'model.fallback-check', kind: 'MODEL_CALL', inputFingerprint: 'fp-other', attempt: 1, paid: true });
  await w.ledger.reserve(ORG, {
    invocationId: brainCallKey(jobId, 'model.fallback-check', 1, 1),
    principalUserId: PRINCIPAL, taskId: 'relationship.review', taskVersion: '1.0.0', capabilityRoute: 'TECHNICAL_ANALYSIS',
    providerId: 'provider-b', requestedModelId: 'model-b', routingPolicyVersion: 'routing.test.1', templateId: 't', templateVersion: '1',
    contextSourceRefs: [], estimatedInputTokens: 1, estimatedOutputTokens: 1, estimatedCostMicros: null, unitCostBasis: null,
    businessDate: '2026-09-17', requestedAt: at(5), brainJobId: jobId, brainStepKey: 'model.fallback-check',
  });
  state = await w.steps.resumeState(ORG, jobId, step.stepKey, step.inputFingerprint);
  assert.deepEqual(state.ok && state.inFlightCallKeys, [callKey]);
  const decision = brainStepResumeDecision(policy, state as any);
  assert.deepEqual(decision, { action: 'ABANDON_AND_RETRY', abandonedCallKeys: [callKey], attempt: 2 });
  assert.deepEqual(await w.steps.beginAttempt(ORG, jobId, { ...step, attempt: 2, paid: true, now: at(6) }), { ok: true, attempt: 2 });
  state = await w.steps.resumeState(ORG, jobId, step.stepKey, step.inputFingerprint);
  assert.equal(state.ok && state.paidAttemptsMade, 2);
  // Both paid attempts are spent: one more in-flight loss would fail by name.
  assert.deepEqual(brainStepResumeDecision(policy, state as any), { action: 'FAIL', reason: 'PROVIDER_RESULT_LOST' });

  // Plaintext never lands.
  const plain = { sealVersion: 'test-seal.1', keyRef: 'test/key-1', sealed: new TextEncoder().encode('{"summary":"Revenue fell"}') };
  assert.deepEqual(await w.steps.recordCheckpoint(ORG, jobId, { ...step, payload: plain }), { ok: false, refusal: 'LOOKS_LIKE_PLAINTEXT' });
  assert.deepEqual(await w.steps.recordCheckpoint(ORG, jobId, { ...step, payload: sealed(), now: at(7) }), { ok: true, recorded: 'NOW' });
  assert.deepEqual(await w.steps.recordCheckpoint(ORG, jobId, { ...step, payload: sealed(2), now: at(8) }), { ok: true, recorded: 'ALREADY' });
  const payload = await w.steps.readCheckpoint(ORG, { jobId, stepKey: step.stepKey, inputFingerprint: step.inputFingerprint });
  assert.deepEqual([...payload!.sealed], [...sealed().sealed], 'the first checkpoint stands');
  assert.equal(await w.steps.readCheckpoint(OTHER, { jobId, stepKey: step.stepKey, inputFingerprint: step.inputFingerprint }), null);

  state = await w.steps.resumeState(ORG, jobId, step.stepKey, step.inputFingerprint);
  assert.deepEqual(brainStepResumeDecision(policy, state as any), { action: 'RETURN_CHECKPOINT' });
  assert.deepEqual(await w.steps.beginAttempt(ORG, jobId, { ...step, attempt: 3, paid: true }), { ok: false, refusal: 'ALREADY_CHECKPOINTED' });
  assert.deepEqual(await w.steps.resumeState(ORG, jobId, step.stepKey, 'fp-ctx-9999'), { ok: false, refusal: 'STEP_INPUT_CHANGED' });
  assert.deepEqual(await w.steps.beginAttempt(ORG, jobId, { ...step, inputFingerprint: 'fp-ctx-9999', attempt: 1, paid: true }), {
    ok: false,
    refusal: 'STEP_INPUT_CHANGED',
  });
  const summary = await w.steps.listForJob(ORG, jobId);
  assert.deepEqual(summary.map((s) => [s.stepKey, s.state, s.attempts, s.paidAttempts, s.checkpointed, s.checkpointSizeBytes]), [
    ['model.primary', 'SUCCEEDED', 2, 2, true, 11],
    ['model.fallback-check', 'RUNNING', 1, 1, false, null],
  ]);
  assert.ok(!('checkpointSealed' in summary[0]!), 'the operator view never carries a payload');
});

test('a step runs only in a running job, fails with a code, and retries attempt by attempt', async () => {
  const w = world();
  const a = await accepted(w);
  const step = { stepKey: 'context.load', kind: 'LOAD_CONTEXT' as const, inputFingerprint: 'fp-1' };
  assert.deepEqual(await w.steps.beginAttempt(ORG, a.job.jobId, { ...step, attempt: 1, paid: false }), { ok: false, refusal: 'JOB_NOT_RUNNING' });
  const jobId = await running(w, REVIEW_TASK, { idempotencyKey: 'idem-key-step' });
  assert.deepEqual(await w.steps.beginAttempt(ORG, jobId, { ...step, attempt: 2, paid: false }), { ok: false, refusal: 'ATTEMPT_CONFLICT' });
  await w.steps.beginAttempt(ORG, jobId, { ...step, attempt: 1, paid: false });
  await assert.rejects(w.steps.recordFailure(ORG, jobId, { ...step, failureClass: 'The provider said: overloaded' }), /a failure class is a code/);
  assert.equal(await w.steps.recordFailure(ORG, jobId, { ...step, failureClass: 'STORE_UNAVAILABLE' }), true);
  assert.deepEqual(await w.steps.recordCheckpoint(ORG, jobId, { ...step, payload: sealed() }), { ok: false, refusal: 'STEP_NOT_RUNNING' });
  assert.deepEqual(await w.steps.beginAttempt(ORG, jobId, { ...step, kind: 'MODEL_CALL', attempt: 2, paid: true }), { ok: false, refusal: 'KIND_MISMATCH' });
  assert.deepEqual(await w.steps.beginAttempt(ORG, jobId, { ...step, attempt: 2, paid: false }), { ok: true, attempt: 2 });
  const s = (await w.steps.listForJob(ORG, jobId))[0]!;
  assert.deepEqual([s.state, s.attempts, s.paidAttempts, s.lastFailureClass], ['RUNNING', 2, 0, null]);
  await assert.rejects(w.steps.beginAttempt(ORG, jobId, { ...step, stepKey: 'Bad Key', attempt: 1, paid: false }), BrainPersistenceInvariantError);
});

test('resumed work reuses the checkpoints the failed job already paid for, in its own organization only', async () => {
  const w = world();
  const failedId = await running(w, REVIEW_TASK, { idempotencyKey: 'idem-key-fail' });
  const step = { stepKey: 'model.primary', kind: 'MODEL_CALL' as const, inputFingerprint: 'fp-a' };
  await w.steps.beginAttempt(ORG, failedId, { ...step, attempt: 1, paid: true });
  await w.steps.recordCheckpoint(ORG, failedId, { ...step, payload: sealed() });
  await w.jobs.transition(ORG, failedId, { type: 'FAILED', reason: 'COMMIT_REFUSED' }, { context: DURABLE_CTX });

  assert.deepEqual(
    await w.jobs.accept(ORG, { principalUserId: PRINCIPAL, task: { ...REVIEW_TASK, taskId: 'other.task' }, submission: submission(REVIEW_TASK, { taskId: 'other.task', idempotencyKey: 'idem-key-x' }), resumesJobId: failedId }),
    { kind: 'REFUSED', refusal: 'RESUMED_JOB_NOT_RESUMABLE' },
    'only the same task resumes',
  );
  const resumed = await w.jobs.accept(ORG, {
    principalUserId: PRINCIPAL,
    task: REVIEW_TASK,
    submission: submission(REVIEW_TASK, { idempotencyKey: 'idem-key-resume' }),
    resumesJobId: failedId,
  });
  assert.equal(resumed.kind, 'ACCEPTED');
  const resumedId = (resumed as any).job.jobId as string;
  assert.equal((resumed as any).job.resumesJobId, failedId);
  const state = await w.steps.resumeState(ORG, resumedId, step.stepKey, step.inputFingerprint);
  assert.deepEqual(state.ok && state.checkpoint, { jobId: failedId, stepKey: step.stepKey, inputFingerprint: step.inputFingerprint });
  assert.deepEqual(brainStepResumeDecision(BRAIN_DEFAULT_STEP_POLICIES.MODEL_CALL, state as any), { action: 'RETURN_CHECKPOINT' });
  const other = await w.steps.resumeState(ORG, resumedId, step.stepKey, 'fp-b');
  assert.equal(other.ok && other.checkpointed, false, 'a different input never reuses a checkpoint');
  // Another organization cannot resume this organization's job.
  assert.deepEqual(
    await w.jobs.accept(OTHER, {
      principalUserId: OUTSIDER,
      task: REVIEW_TASK,
      submission: submission(REVIEW_TASK, { idempotencyKey: 'idem-key-steal' }),
      resumesJobId: failedId,
    }),
    { kind: 'REFUSED', refusal: 'RESUMED_JOB_NOT_RESUMABLE' },
  );
});

test('a sealed payload is refused when it is empty, oversized, unlabelled, or readable', () => {
  const ok = sealed();
  assert.deepEqual(brainSealedPayloadRefusals(ok), []);
  assert.deepEqual(brainSealedPayloadRefusals({ ...ok, sealed: new Uint8Array() }), ['EMPTY']);
  assert.deepEqual(brainSealedPayloadRefusals({ ...ok, sealed: 'abc' as never }), ['NOT_BYTES']);
  assert.deepEqual(brainSealedPayloadRefusals({ ...ok, sealed: new Uint8Array(1024 * 1024 + 1).fill(0xff) }), ['TOO_LARGE']);
  assert.deepEqual(brainSealedPayloadRefusals({ ...ok, sealVersion: 'Plain Text' }), ['BAD_SEAL_VERSION']);
  assert.deepEqual(brainSealedPayloadRefusals({ ...ok, keyRef: '' }), ['BAD_KEY_REF']);
  assert.deepEqual(brainSealedPayloadRefusals({ ...ok, keyRef: 'arn has spaces' }), ['BAD_KEY_REF']);
  for (const text of ['The customer asked about an invoice.', '["a"]', '  {"x":1}\n', 'sk-live-looking-secret']) {
    assert.deepEqual(brainSealedPayloadRefusals({ ...ok, sealed: new TextEncoder().encode(text) }), ['LOOKS_LIKE_PLAINTEXT'], text);
  }
});

// --- Stored controls ---------------------------------------------------------------------

test('stored controls are appended by version, visible to their own organization, and never stale-overwritten', async () => {
  const w = world();
  const on = await w.controls.recordOrganizationControl(ORG, { scope: 'ORGANIZATION', state: 'ACTIVE', reason: 'Pilot approved.', expectedVersion: 0, actorUserId: ADMIN, now: T0 });
  assert.equal(on.ok && on.result, 'APPENDED');
  assert.deepEqual(on.ok && on.entry.target, { scope: 'ORGANIZATION', organizationId: ORG, value: ORG }, 'an organization can only name itself');
  assert.deepEqual(await w.controls.recordOrganizationControl(ORG, { scope: 'ORGANIZATION', state: 'KILLED', reason: 'x', expectedVersion: 0, actorUserId: ADMIN }), {
    ok: false,
    refusal: 'STALE',
  });
  const same = await w.controls.recordOrganizationControl(ORG, { scope: 'ORGANIZATION', state: 'ACTIVE', reason: 'again', expectedVersion: 1, actorUserId: ADMIN });
  assert.equal(same.ok && same.result, 'UNCHANGED');
  const off = await w.controls.recordOrganizationControl(ORG, { scope: 'ORGANIZATION', state: 'KILLED', reason: 'Paused by owner.', expectedVersion: 1, actorUserId: ADMIN, now: at(5) });
  assert.equal(off.ok && off.entry.version, 2);
  assert.equal(w.fake.aiControl.__rows.length, 2, 'append-only: both versions are kept');
  assert.equal(w.fake.aiControlCurrent.__rows.length, 1);
  assert.equal(w.fake.aiControlCurrent.__rows[0].version, 2, 'the current view moved to the new version');

  const task = await w.controls.recordOrganizationControl(ORG, { scope: 'TASK', taskId: 'case.explanation', state: 'ACTIVE', reason: 'On for us.', expectedVersion: 0, actorUserId: ADMIN });
  assert.equal(task.ok, true);
  assert.deepEqual(
    await w.controls.recordOrganizationControl(ORG, { scope: 'ORGANIZATION', state: 'ACTIVE', reason: 'x', expectedVersion: 2, actorUserId: OUTSIDER }),
    { ok: false, refusal: 'ACTOR_NOT_ACTIVE_MEMBER' },
  );
  assert.deepEqual(
    await w.controls.recordOrganizationControl(ORG, { scope: 'GLOBAL' as never, state: 'KILLED', reason: 'x', expectedVersion: 0, actorUserId: ADMIN }),
    { ok: false, refusal: 'SCOPE_NOT_ALLOWED' },
  );
  assert.deepEqual(
    await w.controls.recordOrganizationControl(ORG, { scope: 'ORGANIZATION', state: 'ACTIVE', reason: '  ', expectedVersion: 2, actorUserId: ADMIN }),
    { ok: false, refusal: 'REASON_REQUIRED' },
  );

  const global = await w.controls.recordPlatformControl({ scope: 'GLOBAL', value: null, state: 'KILLED', reason: 'Incident 2026-09-17.', expectedVersion: 0, operationsReference: 'workflow:record-ai-control:run-1:operator' });
  assert.equal(global.ok, true);
  assert.deepEqual(
    await w.controls.recordPlatformControl({ scope: 'ORGANIZATION' as never, value: OTHER, state: 'KILLED', reason: 'x', expectedVersion: 0, operationsReference: 'r' }),
    { ok: false, refusal: 'SCOPE_NOT_ALLOWED' },
  );
  await w.controls.recordOrganizationControl(OTHER, { scope: 'ORGANIZATION', state: 'ACTIVE', reason: 'Theirs.', expectedVersion: 0, actorUserId: OUTSIDER });

  const mine = await w.controls.currentFor(ORG);
  assert.deepEqual(
    mine.map((e) => [e.target.scope, e.target.organizationId, e.target.value, e.state, e.version]),
    [
      ['GLOBAL', null, null, 'KILLED', 1],
      ['ORGANIZATION', ORG, ORG, 'KILLED', 2],
      ['TASK', ORG, 'case.explanation', 'ACTIVE', 1],
    ],
  );
  assert.ok(!(await w.controls.currentFor(OTHER)).some((e) => e.target.organizationId === ORG), "never another organization's");
  assert.deepEqual(await w.controls.history(OTHER, { scope: 'ORGANIZATION', organizationId: ORG, value: ORG }), []);
  assert.deepEqual((await w.controls.history(ORG, { scope: 'ORGANIZATION', organizationId: ORG, value: ORG })).map((e) => e.state), ['ACTIVE', 'KILLED']);
  assert.deepEqual(mine[0]!.actor, { kind: 'OPERATIONS', reference: 'workflow:record-ai-control:run-1:operator' });
});

// --- Activity -----------------------------------------------------------------------------

test('a Brain event becomes a valid Activity item that points at work, never at a result', async () => {
  const w = world();
  const jobId = await running(w, ANALYSIS_TASK, { executionClass: 'INTERACTIVE' });
  const ref = { owner: { authority: 'COMMERCIAL_INTELLIGENCE' as const, subjectType: 'CASE' as const }, subjectId: 'case_00000001', artifactId: 'expl_00001' };
  await w.jobs.transition(ORG, jobId, { type: 'RESULT_COMMITTED', resultRefs: [ref] }, { context: INTERACTIVE_ONLY_CTX, now: at(3) });
  await accepted(w, REVIEW_TASK, { idempotencyKey: 'idem-key-other-org' }, OTHER, OUTSIDER);
  // The same shipped task in another organization: visible to nobody here.
  await accepted(w, ANALYSIS_TASK, { executionClass: 'INTERACTIVE', idempotencyKey: 'idem-key-other-case' }, OTHER, OUTSIDER);

  const adapter = new BrainEventActivityAdapter(w.prisma);
  assert.equal(adapter.supports({ kind: 'ORGANIZATION' }), true);
  assert.equal(adapter.supports({ kind: 'CASE', priorityId: 'case_00000001' }), true, 'B5: the Case lane');
  assert.equal(adapter.supports({ kind: 'WORK_ITEM', workInstanceId: 'w_1' }), false);
  // The organization lane asks for the organization's own authorities, and NEVER for an
  // employee-private one: a task owned by EMPLOYEE_INTELLIGENCE (Draft with Loop, GM-3) is
  // excluded from this feed in both directions -- its requirement is not demanded here, and an
  // event about one never becomes an item here.
  assert.deepEqual(adapter.requiresFor({ kind: 'ORGANIZATION' }), [{ resource: 'commercialIntelligence', action: 'view' }]);
  assert.equal(brainTaskRequirements('mail.reply.draft'), null, 'an employee-private task has no organization activity item');
  assert.deepEqual(brainTaskRequirements('case.explanation'), [{ resource: 'commercialIntelligence', action: 'view' }]);
  const page = await adapter.page({ organizationId: ORG, subject: { kind: 'ORGANIZATION' }, filter: 'ALL', cursor: null, limit: 10, interactionsIncluded: false });
  assert.deepEqual(page.items.map((i) => i.type), ['brain.job.succeeded', 'brain.job.accepted']);
  assert.equal(page.rowsRead, 2, "another organization's events are never read");
  for (const item of page.items) {
    assert.deepEqual(validateActivityItem(item), [], item.key);
    assert.equal(item.organizationId, ORG);
    assert.equal(item.category, 'STATE_CHANGE');
    assert.equal(item.provenance.epistemic, 'RECORDED');
    assert.equal(item.sensitivity.contentInline, false);
    assert.deepEqual(item.access.requires, [{ resource: 'commercialIntelligence', action: 'view' }]);
    assert.doesNotMatch(JSON.stringify(item), /expl_00001|summary|claim/i, 'the item never carries or names the result itself');
  }
  assert.equal(page.items[0]!.display.semanticStatus, 'ANALYSIS');
  // The other organization's job, and a task this deployment does not know, are not shown.
  assert.equal((await adapter.page({ organizationId: ORG, subject: { kind: 'ORGANIZATION' }, filter: 'COMMUNICATIONS', cursor: null, limit: 10, interactionsIncluded: false })).items.length, 0);
  const unknown = (await w.events.listForJob(OTHER, (w.fake.brainJob.__rows.find((r: any) => r.organizationId === OTHER)).id))[0]!;
  assert.equal(brainEventActivityItem(unknown), null, 'relationship.review is not a shipped task, so its events are not shown');

  // THE GM-3 LEAK, AS A REGRESSION. The very same event, in this organization, about the
  // employee-private Draft with Loop task: it becomes no organization activity item at all, so
  // the existence of one person's private work never reaches a shared feed.
  const shown = (await w.events.listForJob(ORG, jobId))[0]!;
  assert.notEqual(brainEventActivityItem(shown), null, 'the organization task is shown');
  const privateTwin = { ...shown, event: { ...shown.event, taskId: 'mail.reply.draft' } } as typeof shown;
  assert.equal(brainEventActivityItem(privateTwin), null, 'an employee-private task never becomes an organization activity item');
  // And the organization lane never demands the employee-private authority to be read.
  assert.equal(
    adapter.requiresFor({ kind: 'ORGANIZATION' }).some((r) => r.resource === 'employeeIntelligence'),
    false,
  );
});

// --- Fences -------------------------------------------------------------------------------

const SRC = join(__dirname, '..', 'src', 'repositories');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

test('fence: the Brain activity adapter is composed into the live feed only now that its migration is deployed (B5)', () => {
  const composition = read('activity-read-model.repository.ts');
  assert.match(composition, /new BrainEventActivityAdapter\(prisma\)/, 'migration 36 was deployed (run 35160530756) before B5 composed it');
});

test('fence: every Brain repository read and write is scoped by organization, except the reference lookups', () => {
  for (const file of ['brain/brain-job.repository.ts', 'brain/brain-wait.repository.ts', 'brain/brain-step.repository.ts', 'brain/brain-command.repository.ts', 'brain/brain-job-writes.ts']) {
    const src = read(file);
    const calls = [...src.matchAll(/\.(brainJob|brainJobTransition|brainJobStep|brainJobWait|brainCommand|brainEvent|aiInvocation)\.(findFirst|findMany|updateMany|count)\(\{\s*where:\s*\{([^}]*)\}/g)];
    assert.ok(calls.length > 0, file);
    for (const call of calls) assert.match(call[3]!, /organizationId/, `${file}: ${call[0]}`);
  }
  const refs = read('brain/brain-execution-references.ts');
  for (const select of refs.matchAll(/select:\s*\{([^}]*)\}/g)) {
    const fields = select[1]!.split(',').map((f) => f.trim().split(':')[0]).filter(Boolean);
    for (const field of fields) assert.ok(['organizationId', 'id', 'jobId', 'generation'].includes(field!), `references select only identities, not ${field}`);
  }
  assert.doesNotMatch(refs, /\.(update|updateMany|create|createMany|delete|deleteMany|upsert)\(/, 'the reference lookups never write');
});

test('fence: the Brain persistence layer reads no environment, names no provider, and stores no prompt or response', () => {
  for (const file of ['brain/brain-records.ts', 'brain/brain-job.repository.ts', 'brain/brain-wait.repository.ts', 'brain/brain-step.repository.ts', 'brain/brain-command.repository.ts', 'brain/brain-job-writes.ts', 'brain/brain-execution-references.ts', 'brain/ai-control.repository.ts', 'activity/brain-event.adapter.ts']) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /process\.env|LOOP_AI_|fetch\(|@anthropic-ai|from ['"]openai|aws-sdk/, `${file} is persistence only`);
    assert.doesNotMatch(code, /['"`](anthropic|openai)['"`]|claude-|gpt-/i, `${file} names no provider or model`);
  }
});

const SCHEMA = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
const MIGRATION = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '20260919000000_brain_durable_persistence', 'migration.sql'), 'utf8');

function modelBody(model: string): string {
  const start = SCHEMA.indexOf(`model ${model} {`);
  assert.ok(start >= 0, model);
  return SCHEMA.slice(start, SCHEMA.indexOf('\n}', start));
}

test('fence: the four declarations are four sets of columns, and no Brain table knows a provider or a model', () => {
  const job = modelBody('BrainJob');
  const column = (name: string) => new RegExp(`^\\s{2}${name}\\s+String\\b`, 'm');
  for (const name of ['capabilityRoute', 'resultType', 'resultOwnerAuthority', 'resultSubjectType', 'resultSubjectId', 'executionClass']) {
    assert.match(job, column(name), `brain_jobs.${name} is its own column`);
  }
  for (const model of ['BrainJob', 'BrainJobTransition', 'BrainJobStep', 'BrainJobWait', 'BrainCommand', 'BrainEvent', 'AiControl', 'AiControlCurrent']) {
    const fields = [...modelBody(model).matchAll(/^\s{2}(\w+)\s/gm)].map((m) => m[1]!);
    for (const field of fields) {
      assert.doesNotMatch(field, /provider|model|fallback|routing|prompt|response|completion|transcript|apiKey|secret|session|browser/i, `${model}.${field}`);
    }
  }
  // Vocabularies are text: a new result type, route or owner is never a migration.
  assert.doesNotMatch(MIGRATION, /CREATE TYPE/);
  assert.doesNotMatch(MIGRATION, /'(ANSWER|ANALYSIS|DRAFT|PROPOSED_ACTION|COMMUNICATION|TECHNICAL_ANALYSIS|COMMERCIAL_INTELLIGENCE|COMMUNICATIONS)'/, 'no vocabulary is pinned by a CHECK');
  const ledger = modelBody('AiInvocation');
  for (const name of ['brainJobId', 'brainStepKey', 'specializationPolicyVersion']) assert.match(ledger, new RegExp(`^\\s{2}${name}\\s+String\\?`, 'm'));
  const ledgerFields = [...ledger.matchAll(/^\s{2}(\w+)\s/gm)].map((m) => m[1]!);
  for (const field of ledgerFields) assert.doesNotMatch(field, /prompt|response|completion|body|content/i, `the ledger still stores no body: ${field}`);
});

/** Columns later migrations added to the tables this one created. Each is added nullable, and only there. */
const ADDED_LATER: Record<string, readonly { column: string; migration: string }[]> = {
  // G2 (2026-09-24): a provider policy's sensitivity ceiling.
  AiControl: [{ column: 'ceiling', migration: '20261003000001_ai_provider_policy_controls' }],
};

test('fence: the columns added to these tables later are added by their own migration, nullable', () => {
  for (const [model, columns] of Object.entries(ADDED_LATER)) {
    const map = /@@map\("(\w+)"\)/.exec(modelBody(model))![1]!;
    for (const { column, migration } of columns) {
      const later = readFileSync(join(__dirname, '..', 'prisma', 'migrations', migration, 'migration.sql'), 'utf8');
      assert.match(later, new RegExp(`ALTER TABLE "${map}" ADD COLUMN "${column}" TEXT;`), `${map}.${column} is added nullable by ${migration}`);
      assert.doesNotMatch(MIGRATION, new RegExp(`"${column}"`), `${column} is not this migration's`);
    }
  }
});

test('fence: the migration is additive, ASCII, touches one existing table additively, and matches the schema', () => {
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(MIGRATION, /[^\x00-\x7F]/, 'ASCII only');
  const sql = MIGRATION.replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(sql, /\bDROP\b|\bTRUNCATE\b|\bRENAME\b/i);
  assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE|INSERT|SELECT)\s/im, 'no row is read, written or moved');
  assert.doesNotMatch(sql, /ALTER\s+COLUMN|SET\s+NOT\s+NULL|SET\s+DEFAULT|TYPE\s+\w+\s+USING/i, 'no existing column changes');
  const tables = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tables, ['brain_jobs', 'brain_job_transitions', 'brain_job_steps', 'brain_job_waits', 'brain_commands', 'brain_events', 'ai_controls', 'ai_control_current']);
  const altered = [...new Set([...sql.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]))];
  assert.deepEqual(altered.filter((t) => !tables.includes(t)), ['ai_invocations'], 'the only existing table touched');
  const onLedger = [...sql.matchAll(/ALTER TABLE "ai_invocations" (ADD (?:COLUMN|CONSTRAINT))/g)].map((m) => m[1]);
  assert.ok(onLedger.every((s) => /^ADD /.test(s!)));
  for (const column of ['brainJobId', 'brainStepKey', 'specializationPolicyVersion']) {
    assert.match(sql, new RegExp(`ADD COLUMN\\s+"${column}" TEXT(,|;)`), `${column} is added nullable, without a default`);
  }
  for (const table of tables.filter((t) => t !== 'ai_controls' && t !== 'ai_control_current')) {
    assert.match(sql, new RegExp(`"${table}_organizationId_fkey"`), `${table} is owned by an organization`);
  }
  for (const child of ['brain_job_transitions', 'brain_job_steps', 'brain_job_waits', 'brain_commands', 'brain_events']) {
    assert.match(sql, new RegExp(`"${child}_organizationId_jobId_fkey" FOREIGN KEY \\("organizationId", "jobId"\\) REFERENCES "brain_jobs"\\("organizationId", "id"\\)`));
  }
  assert.match(sql, /"brain_jobs_principalUserId_organizationId_fkey" FOREIGN KEY \("principalUserId", "organizationId"\) REFERENCES "organization_memberships"\("userId", "organizationId"\)/);
  for (const model of ['BrainJob', 'BrainJobTransition', 'BrainJobStep', 'BrainJobWait', 'BrainCommand', 'BrainEvent', 'AiControl', 'AiControlCurrent']) {
    const body = modelBody(model);
    const map = /@@map\("(\w+)"\)/.exec(body)![1]!;
    const create = new RegExp(`CREATE TABLE "${map}" \\(([\\s\\S]*?)\\n\\);`).exec(sql)![1]!;
    // Columns a LATER migration added to these tables are that migration's, not this one's; each
    // is named here with the migration that adds it, and asserted to be added there (below).
    const scalar = [...body.matchAll(/^\s{2}(\w+)\s+(String|Int|DateTime|Json|Bytes|Boolean)\??/gm)]
      .map((m) => m[1]!)
      .filter((c) => !(ADDED_LATER[model] ?? []).some((later) => later.column === c));
    for (const c of scalar) assert.match(create, new RegExp(`"${c}"`), `${map}.${c} is created`);
    assert.equal((create.match(/^\s+"\w+"/gm) ?? []).length, scalar.length, `${map} creates exactly the schema's columns`);
  }
  const checks = [...sql.matchAll(/ADD CONSTRAINT "(\w+)"\s+CHECK/g)].map((m) => m[1]);
  assert.deepEqual(checks, [
    'brain_jobs_shape',
    'brain_job_transitions_shape',
    'brain_job_steps_shape',
    'brain_job_waits_shape',
    'brain_commands_shape',
    'brain_events_shape',
    'ai_controls_shape',
    'ai_control_current_shape',
    'ai_invocations_brain_call',
  ]);
});

test('fence: the ledger insert returns only its id, so code ahead of a migration cannot trip on new columns', () => {
  const src = read('ai-usage-ledger.repository.ts');
  const create = src.slice(src.indexOf('db.aiInvocation.create('), src.indexOf('async exists('));
  assert.match(create, /select:\s*\{\s*id:\s*true\s*\}/);
});

test('fence: the restricted-roles script holds no secret, grants no deletion, and reaches no product table', () => {
  const sql = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'operations', 'brain-database-roles.sql'), 'utf8');
  const code = sql.replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(code, /PASSWORD/i, 'passwords are set interactively, never in the script');
  assert.doesNotMatch(code, /GRANT[^;]*\b(DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL)\b/i, 'nothing is deleted, truncated or owned');
  assert.doesNotMatch(code, /\bCREATE\s+(TABLE|INDEX|FUNCTION|SCHEMA|POLICY)\b|\bDROP\b|\bALTER\s+TABLE\b/i, 'roles and grants only');
  assert.doesNotMatch(code, /\bROLE\s+\w+\s+[^;]*\b(?<!NO)(SUPERUSER|CREATEDB|CREATEROLE|REPLICATION|BYPASSRLS)\b/i, 'no role attribute beyond LOGIN');
  const granted = new Set<string>();
  for (const grant of code.matchAll(/GRANT\s+[^;]*?\bON\s+([^;]*?)\s+TO\s/gi)) {
    for (const table of grant[1]!.replace(/^(TABLE|SCHEMA)\s+/i, '').split(',')) granted.add(table.trim());
  }
  const brainTables = ['brain_jobs', 'brain_job_transitions', 'brain_job_steps', 'brain_job_waits', 'brain_commands', 'brain_events', 'ai_controls', 'ai_control_current', 'ai_invocations'];
  assert.deepEqual([...granted].filter((t) => !brainTables.includes(t)).sort(), ['organizations', 'public']);
  assert.match(code, /GRANT SELECT \("id", "timezone"\) ON organizations TO loop_brain_worker;/, 'two organization columns, for the ledger business day');
  const workerJobUpdate = /GRANT UPDATE \(([^)]*)\)\s+ON brain_jobs TO loop_brain_worker/.exec(code)![1]!;
  for (const column of ['capabilityRoute', 'resultType', 'resultOwnerAuthority', 'resultSubjectType', 'resultSubjectId', 'principalUserId', 'organizationId', 'taskId', 'taskVersion', 'input', 'idempotencyKey', 'submissionFingerprint', 'generation', 'resumesJobId']) {
    assert.doesNotMatch(workerJobUpdate, new RegExp(`"${column}"`), `the worker cannot change ${column}`);
  }
  assert.match(workerJobUpdate, /"executionClass"/, "promotion is the worker's to record");
  assert.doesNotMatch(/GRANT UPDATE \(([^)]*)\)\s+ON brain_job_waits TO loop_brain_worker/.exec(code)![1]!, /"reply"|"responderUserId"|"answeredAt"/, 'only the Brain API records a reply');
});

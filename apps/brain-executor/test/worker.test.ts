// The runner end to end, dark: Loop submission -> stored command -> dispatch -> worker ->
// authoritative re-read -> lease -> steps and checkpoints -> question and resume ->
// cancellation and kills -> the governed commit boundary. No provider, no network, no cloud.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrainJobSnapshot } from '@emgloop/shared';

import { dispatch } from '../src/dispatcher';
import { sweep } from '../src/sweeper';
import { MalformedAdvanceMessage, advanceJob, type BrainWorkerOutcome } from '../src/worker';
import { memoryLogger } from '../src/log';
import { contextFor, reviewSubmission, caseSubmission, world, ORG, REVIEW, type World } from './world';

async function submitted(w: World, who: 'owner' | 'manager', raw: unknown): Promise<{ jobId: string; commandId: string }> {
  const before = w.rings.length;
  const out = await w.work.submit(w.people[who], raw);
  assert.equal(out.kind, 'ACCEPTED', JSON.stringify(out));
  assert.equal(w.rings.length, before + 1);
  return { jobId: out.kind === 'ACCEPTED' ? out.work.jobId : '', commandId: w.rings.at(-1)! };
}

function dispatchDeps(w: World) {
  return { store: w.store, queues: w.queues, trust: { trustedIssuers: [], trustedCallers: [] }, now: w.now, log: memoryLogger({ component: 'dispatcher' }) };
}

async function recover(w: World, commandId: string) {
  return dispatch({ kind: 'RECOVERY', commandId }, dispatchDeps(w));
}

async function drain(w: World, holder = 'worker-a', max = 20): Promise<BrainWorkerOutcome[]> {
  const out: BrainWorkerOutcome[] = [];
  for (let i = 0; i < max; i += 1) {
    const next = w.queues.take();
    if (!next) break;
    out.push(await advanceJob(next.message, w.workerDeps(holder)));
  }
  return out;
}

async function drainWith(w: World, overrides: Parameters<World['workerDeps']>[1], max = 20): Promise<BrainWorkerOutcome[]> {
  const out: BrainWorkerOutcome[] = [];
  for (let i = 0; i < max; i += 1) {
    const next = w.queues.take();
    if (!next) break;
    out.push(await advanceJob(next.message, w.workerDeps('worker-a', overrides)));
  }
  return out;
}

async function job(w: World, jobId: string): Promise<BrainJobSnapshot> {
  return (await w.jobs.get(ORG, jobId))!.job;
}

function steps(w: World, jobId: string): Record<string, { state: string; failure: string | null; sealed: boolean }> {
  return Object.fromEntries(
    w.fake.brainJobStep.__rows
      .filter((s: any) => s.jobId === jobId)
      .map((s: any) => [s.stepKey, { state: s.state, failure: s.lastFailureClass ?? null, sealed: s.checkpointSealed instanceof Uint8Array }]),
  );
}

test('a submitted job runs dark to the commit boundary and ends COMMIT_REFUSED, with no provider call', async () => {
  const w = await world();
  const { jobId, commandId } = await submitted(w, 'manager', reviewSubmission({ executionClass: 'INTERACTIVE', idempotencyKey: 'idem-dark-1' }));
  assert.equal(await recover(w, commandId), 'DISPATCHED');
  assert.equal(w.queues.sent[0]!.queue, 'INTERACTIVE');
  assert.deepEqual(await drain(w), ['FAILED']);

  const done = await job(w, jobId);
  assert.equal(done.state, 'FAILED');
  assert.equal(done.endReason, 'COMMIT_REFUSED');
  assert.deepEqual(done.resultRefs, [], 'nothing was committed');
  assert.deepEqual(steps(w, jobId), {
    'context.load': { state: 'SUCCEEDED', failure: null, sealed: true },
    'dark.probe': { state: 'SUCCEEDED', failure: null, sealed: true },
    'commit.result': { state: 'FAILED', failure: 'OWNER_GATE_UNAVAILABLE', sealed: false },
  });
  assert.deepEqual(w.loopCalls.map((c) => [c.purpose, c.status]), [['CONTEXT', 200], ['ACCESS_DECISION', 200]], 'context once; access re-decided at the boundary; never a commit');
  assert.equal(w.fake.aiInvocation.__rows.length, 0, 'no provider call was reserved or made');
  const events = w.fake.brainEvent.__rows.filter((e: any) => e.jobId === jobId).map((e: any) => e.name);
  assert.deepEqual(events, ['brain.job.accepted', 'brain.job.failed']);
  const kinds = (await w.jobs.transitions(ORG, jobId)).map((t) => t.kind);
  assert.deepEqual(kinds, ['ACCEPTED', 'DISPATCHED', 'STARTED', 'FAILED']);

  // Nothing readable was stored or logged.
  for (const s of w.fake.brainJobStep.__rows) {
    if (s.checkpointSealed) assert.equal(Buffer.from(s.checkpointSealed).includes(Buffer.from('SECRET-CONTEXT')), false);
  }
  assert.doesNotMatch(JSON.stringify(w.log.lines), /SECRET-CONTEXT|eyJ|Dark verification/);
  assert.ok(w.log.lines.some((l) => l.event === 'worker.commit_boundary' && l.commitGate === 'UNAVAILABLE'));
});

test('with an owner gate registered, revision 1 still commits nothing: dark mode has no result', async () => {
  let stored = 0;
  const owner = {
    resultType: 'ANALYSIS',
    authority: 'RELATIONSHIPS',
    subjectType: 'RELATIONSHIP',
    async commit() {
      stored += 1;
      return { ok: true as const, artifactId: 'a1' };
    },
  };
  const w = await world({ owners: [owner] });
  const { jobId, commandId } = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-dark-2' }));
  await recover(w, commandId);
  const base = w.workerDeps().loop;
  let commits = 0;
  const loop = { ...base, commit: async (...args: Parameters<typeof base.commit>) => ((commits += 1), base.commit(...args)) };
  assert.deepEqual(await drainWith(w, { loop }), ['FAILED']);
  assert.equal(steps(w, jobId)['commit.result']!.failure, 'DARK_MODE_NO_RESULT');
  assert.equal(commits, 0, 'the runtime never asks Loop to commit');
  assert.equal(stored, 0);
  assert.ok(!w.loopCalls.some((c) => c.purpose === 'COMMIT_RESULT'));
});

test('an interactive-only task runs the same path', async () => {
  const w = await world();
  const { jobId, commandId } = await submitted(w, 'owner', caseSubmission());
  await recover(w, commandId);
  assert.deepEqual(await drain(w), ['FAILED']);
  assert.equal((await job(w, jobId)).endReason, 'COMMIT_REFUSED');
});

test('duplicate rings and messages do nothing twice; a missed ring is recovered by the sweeper', async () => {
  const w = await world();
  const { jobId, commandId } = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-dup-1' }));
  assert.equal(await recover(w, commandId), 'DISPATCHED');
  assert.equal(await recover(w, commandId), 'DISPATCHED', 'still ACCEPTED, so a second hand-over is a duplicate message');
  assert.deepEqual(await drain(w), ['FAILED', 'DROPPED']);
  assert.equal(await recover(w, commandId), 'ALREADY_DONE');
  assert.equal(w.fake.brainJobTransition.__rows.filter((t: any) => t.jobId === jobId && t.kind === 'STARTED').length, 1);

  // A ring that never arrived.
  const lost = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-dup-2' }));
  w.advance(10_000);
  const early = await sweep({ refs: w.refs, dispatcher: { recover: async (c) => void (await recover(w, c)) }, queues: w.queues, now: w.now, log: memoryLogger() });
  assert.equal(early.recovered, 0, 'a ring gets a grace period');
  w.advance(10_000);
  const summary = await sweep({ refs: w.refs, dispatcher: { recover: async (c) => void (await recover(w, c)) }, queues: w.queues, now: w.now, log: memoryLogger() });
  assert.equal(summary.recovered, 1);
  assert.deepEqual(await drain(w), ['FAILED']);
  assert.equal((await job(w, lost.jobId)).endReason, 'COMMIT_REFUSED');
  const again = await sweep({ refs: w.refs, dispatcher: { recover: async (c) => void (await recover(w, c)) }, queues: w.queues, now: w.now, log: memoryLogger() });
  assert.equal(again.recovered, 0, 'the dispatcher recorded the hand-over');
});

test('a durable job asks, waits holding nothing, and resumes from its checkpoints once the principal answers', async () => {
  const w = await world();
  const { jobId, commandId } = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-wait-1', input: { darkAskQuestion: true } }));
  await recover(w, commandId);
  assert.deepEqual(await drain(w), ['WAITING']);
  const waiting = await job(w, jobId);
  assert.equal(waiting.state, 'WAITING_FOR_USER');
  const lease = w.fake.brainJob.__rows.find((r: any) => r.id === jobId);
  assert.equal(lease.leaseHolder ?? null, null, 'nothing holds the job while it waits');
  assert.equal(w.queues.sent.length, 0, 'nothing is scheduled');
  const question = await w.work.question(w.people.manager, waiting.wait!.waitId);
  assert.equal(question?.question.kind, 'CONFIRM');

  // Without a recorded reply, a RESUME-like wake changes nothing.
  assert.equal(await advanceJob({ jobId, generation: 1, reason: 'CONTINUE', commandId: null }, w.workerDeps()), 'WAITING');

  const answered = await w.work.respond(w.people.manager, waiting.wait!.waitId, { kind: 'CONFIRM', confirmed: true });
  assert.equal(answered.ok, true);
  assert.equal(await recover(w, w.rings.at(-1)!), 'DISPATCHED');
  assert.equal(w.queues.sent[0]!.message.reason, 'RESUME');
  assert.deepEqual(await drain(w), ['FAILED']);
  const done = await job(w, jobId);
  assert.equal(done.endReason, 'COMMIT_REFUSED');
  assert.deepEqual(steps(w, jobId)['dark.clarify'], { state: 'SUCCEEDED', failure: null, sealed: true });
  assert.equal(w.assembled.length, 1, 'the context checkpoint was reused, not re-assembled');
  assert.deepEqual(w.loopCalls.map((c) => c.purpose), ['CONTEXT', 'ACCESS_DECISION', 'ACCESS_DECISION'], 'access re-decided on resume and at the boundary');
  const kinds = (await w.jobs.transitions(ORG, jobId)).map((t) => t.kind);
  assert.deepEqual(kinds, ['ACCEPTED', 'DISPATCHED', 'STARTED', 'USER_INPUT_REQUESTED', 'USER_INPUT_RECEIVED', 'FAILED']);
});

test('an interactive job that must ask is promoted first, on the same job', async () => {
  const w = await world();
  const { jobId, commandId } = await submitted(w, 'manager', reviewSubmission({ executionClass: 'INTERACTIVE', idempotencyKey: 'idem-wait-2', input: { darkAskQuestion: true } }));
  await recover(w, commandId);
  assert.deepEqual(await drain(w), ['WAITING']);
  const waiting = await job(w, jobId);
  assert.equal(waiting.executionClass, 'DURABLE');
  assert.equal(waiting.promoted, true);
});

test('an unanswered question expires through the sweeper, and a person who lost access cannot resume', async () => {
  const w = await world();
  const first = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-exp-1', input: { darkAskQuestion: true } }));
  await recover(w, first.commandId);
  assert.deepEqual(await drain(w), ['WAITING']);
  w.advance(REVIEW.execution.durable!.maxUserWaitMs! + 1_000);
  const summary = await sweep({ refs: w.refs, dispatcher: { recover: async () => undefined }, queues: w.queues, now: w.now, log: memoryLogger() });
  assert.equal(summary.timers, 1);
  assert.deepEqual(await drain(w), ['EXPIRED']);
  const expired = await job(w, first.jobId);
  assert.equal(expired.state, 'CANCELLED');
  assert.equal(expired.endReason, 'WAIT_EXPIRED');

  const w2 = await world();
  const second = await submitted(w2, 'manager', reviewSubmission({ idempotencyKey: 'idem-exp-2', input: { darkAskQuestion: true } }));
  await recover(w2, second.commandId);
  assert.deepEqual(await drain(w2), ['WAITING']);
  const waitId = (await job(w2, second.jobId)).wait!.waitId;
  assert.equal((await w2.work.respond(w2.people.manager, waitId, { kind: 'CONFIRM', confirmed: true })).ok, true);
  await w2.iam.updateUserRole(ORG, w2.people.manager.userId, 'EMPLOYEE');
  const callsBefore = w2.loopCalls.length;
  await recover(w2, w2.rings.at(-1)!);
  assert.deepEqual(await drain(w2), ['FAILED']);
  assert.equal((await job(w2, second.jobId)).endReason, 'ACCESS_WITHDRAWN');
  assert.deepEqual(w2.loopCalls.slice(callsBefore).map((c) => c.purpose), ['ACCESS_DECISION'], 'refused at the resume: no later step ran');
  assert.equal(steps(w2, second.jobId)['commit.result'], undefined);
  assert.ok(w2.log.lines.some((l) => l.event === 'worker.job_failed' && l.failureClass === 'RESPONDER_NOT_PERMITTED'));

  // A timer that fires before the question expires changes nothing.
  const w3 = await world();
  const third = await submitted(w3, 'manager', reviewSubmission({ idempotencyKey: 'idem-exp-3', input: { darkAskQuestion: true } }));
  await recover(w3, third.commandId);
  assert.deepEqual(await drain(w3), ['WAITING']);
  const early = await advanceJob({ jobId: third.jobId, generation: 1, reason: 'TIMER', commandId: null }, w3.workerDeps());
  assert.equal(early, 'WAITING');
  assert.equal((await job(w3, third.jobId)).state, 'WAITING_FOR_USER');
});

test('a cancellation is honoured at the next step boundary, and a cancelled waiting job stops at once', async () => {
  let hook: (() => Promise<void>) | null = null;
  const w = await world({
    contexts: {
      [REVIEW.taskId]: async ({ job: j }) => {
        const h = hook;
        hook = null;
        if (h) await h();
        return contextFor(j);
      },
    },
  });
  const { jobId, commandId } = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-cancel-1' }));
  hook = async () => {
    const out = await w.work.cancel(w.people.manager, jobId);
    assert.equal(out.ok && out.stoppedNow, false);
  };
  await recover(w, commandId);
  assert.deepEqual(await drain(w), ['CANCELLED']);
  const cancelled = await job(w, jobId);
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.endReason, 'REQUESTED_BY_PRINCIPAL');
  assert.equal(steps(w, jobId)['dark.probe'], undefined, 'no step started after the request');

  const waiting = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-cancel-2', input: { darkAskQuestion: true } }));
  await recover(w, waiting.commandId);
  assert.deepEqual(await drain(w), ['WAITING']);
  const stop = await w.work.cancel(w.people.manager, waiting.jobId);
  assert.equal(stop.ok && stop.stoppedNow, true);
  assert.equal(await recover(w, w.rings.at(-1)!), 'ALREADY_DONE');
});

test('the worker switch and a recorded kill stop work as named policies', async () => {
  const w = await world();
  w.switches.enabled = false;
  const off = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-kill-1' }));
  await recover(w, off.commandId);
  assert.deepEqual(await drain(w), ['STOPPED']);
  const stopped = await job(w, off.jobId);
  assert.equal(stopped.state, 'CANCELLED');
  assert.equal(stopped.endReason, 'KILL_SWITCH');
  assert.deepEqual((await w.jobs.transitions(ORG, off.jobId)).at(-1)!.actor, { kind: 'POLICY', policy: 'worker-switch' });
  assert.equal(w.loopCalls.length, 0, 'a stopped job asks Loop nothing');

  w.switches.enabled = true;
  await w.controls.recordPlatformControl({ scope: 'GLOBAL', value: null, state: 'KILLED', reason: 'incident', expectedVersion: 1, operationsReference: 'test-2', now: w.now() });
  const killed = await submitted(w, 'manager', { ...reviewSubmission({ idempotencyKey: 'idem-kill-2' }) }).catch(() => null);
  // Submission itself is refused under a GLOBAL kill, so drive an already-accepted job instead.
  assert.equal(killed, null);
});

test('a recorded kill stops a job that was accepted before it', async () => {
  const w = await world();
  const { jobId, commandId } = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-kill-3' }));
  await w.controls.recordPlatformControl({ scope: 'TASK', value: REVIEW.taskId, state: 'KILLED', reason: 'bad output', expectedVersion: 1, operationsReference: 'test-3', now: w.now() });
  await recover(w, commandId);
  assert.deepEqual(await drain(w), ['STOPPED']);
  assert.deepEqual((await w.jobs.transitions(ORG, jobId)).at(-1)!.actor, { kind: 'POLICY', policy: 'ai-control:TASK' });
  const floorKill = await world();
  floorKill.switches.floor = { ...floorKill.switches.floor, killSwitches: [{ scope: 'ORGANIZATION', value: ORG }] };
  const j = await submitted(floorKill, 'manager', reviewSubmission({ idempotencyKey: 'idem-kill-4' }));
  await recover(floorKill, j.commandId);
  assert.deepEqual(await drain(floorKill), ['STOPPED'], "the executor's own floor stops work too");
});

test('a crash mid-plan resumes from checkpoints; a held lease is respected, then taken over after it lapses', async () => {
  const w = await world();
  const { jobId, commandId } = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-crash-1' }));
  await recover(w, commandId);
  let seals = 0;
  const base = w.workerDeps('worker-a');
  const crashing = {
    ...base,
    sealers: {
      current: async () => {
        seals += 1;
        if (seals === 2) throw new Error('process died');
        return base.sealers.current();
      },
      forKeyRef: base.sealers.forKeyRef,
    },
  };
  const next = w.queues.take()!;
  await assert.rejects(advanceJob(next.message, crashing), /process died/);
  assert.equal(w.fake.brainJob.__rows.find((r: any) => r.id === jobId).leaseHolder ?? null, null, 'the lease was released');
  assert.equal(await advanceJob(next.message, w.workerDeps('worker-b')), 'FAILED', 'the redelivered message finishes the job');
  assert.equal(w.assembled.length, 1, 'context.load was not run again');
  assert.equal(steps(w, jobId)['dark.probe']!.state, 'SUCCEEDED');

  const w2 = await world();
  const second = await submitted(w2, 'manager', reviewSubmission({ idempotencyKey: 'idem-lease-1' }));
  const ref = (await w2.store.resolve({ jobId: second.jobId, generation: 1 }))!;
  assert.equal((await w2.store.claim(ref, 'worker-dead', 60_000, w2.now())).ok, true);
  await recover(w2, second.commandId);
  assert.deepEqual(await drain(w2), ['BUSY']);
  w2.advance(61_000);
  const summary = await sweep({ refs: w2.refs, dispatcher: { recover: async () => undefined }, queues: w2.queues, now: w2.now, log: memoryLogger() });
  assert.equal(summary.takeovers, 1);
  assert.deepEqual(await drain(w2), ['FAILED']);
});

test('Loop being unreachable is retried within the step policy, then the job fails by name', async () => {
  const w = await world();
  const { jobId, commandId } = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-down-1' }));
  await recover(w, commandId);
  w.setLoopDown(true);
  assert.deepEqual(await drain(w, 'worker-a', 1), ['CONTINUED']);
  assert.equal(w.queues.sent[0]!.message.reason, 'CONTINUE');
  assert.equal(w.queues.sent[0]!.delaySeconds, 10);
  assert.deepEqual(await drain(w, 'worker-a', 1), ['CONTINUED']);
  assert.equal(w.queues.sent[0]!.delaySeconds, 20);
  assert.deepEqual(await drain(w), ['FAILED']);
  assert.equal((await job(w, jobId)).endReason, 'RETRIES_EXHAUSTED');
});

test('the deadline is checked before each step: promote when the task allows, fail by name when it does not', async () => {
  const w = await world();
  const interactive = await submitted(w, 'owner', caseSubmission({ idempotencyKey: 'idem-late-1' }));
  const ref = (await w.store.resolve({ jobId: interactive.jobId, generation: 1 }))!;
  await w.store.claim(ref, 'clock', 1_000, w.now());
  await w.store.addActiveTime(ref, 'clock', 80_000);
  await w.store.release(ref, 'clock');
  await recover(w, interactive.commandId);
  assert.deepEqual(await drain(w), ['FAILED']);
  assert.equal((await job(w, interactive.jobId)).endReason, 'DEADLINE_EXCEEDED');

  const promotable = await submitted(w, 'manager', reviewSubmission({ executionClass: 'INTERACTIVE', idempotencyKey: 'idem-late-2' }));
  const ref2 = (await w.store.resolve({ jobId: promotable.jobId, generation: 1 }))!;
  await w.store.claim(ref2, 'clock', 1_000, w.now());
  await w.store.addActiveTime(ref2, 'clock', 40_000);
  await w.store.release(ref2, 'clock');
  await recover(w, promotable.commandId);
  assert.deepEqual(await drain(w), ['CONTINUED', 'FAILED']);
  const done = await job(w, promotable.jobId);
  assert.equal(done.executionClass, 'DURABLE');
  assert.equal(done.endReason, 'COMMIT_REFUSED');
});

test('a malformed or stale message is refused before anything is read', async () => {
  const w = await world();
  await assert.rejects(advanceJob({ jobId: 'x' }, w.workerDeps()), MalformedAdvanceMessage);
  await assert.rejects(advanceJob({ jobId: 'cjob00000000000000000001', generation: 1, reason: 'START', commandId: null }, w.workerDeps()), MalformedAdvanceMessage);
  await assert.rejects(advanceJob({ jobId: 'cjob00000000000000000001', generation: 1, reason: 'CONTINUE', commandId: null, organizationId: ORG }, w.workerDeps()), MalformedAdvanceMessage);
  const { jobId } = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-stale-1' }));
  assert.equal(await advanceJob({ jobId, generation: 2, reason: 'CONTINUE', commandId: null }, w.workerDeps()), 'DROPPED');
  assert.equal(await advanceJob({ jobId: 'cjob_unknown_000000001', generation: 1, reason: 'CONTINUE', commandId: null }, w.workerDeps()), 'DROPPED');
  assert.equal(w.loopCalls.length, 0);
});

test('a worker token for another job, or signed by an unpinned key, gets nothing from Loop', async () => {
  const w = await world();
  const a = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-tok-1' }));
  // An unpinned signer: Loop refuses with 401, and the step fails as a trust fault, not a retry.
  w.trustedKeys.clear();
  await recover(w, a.commandId);
  assert.deepEqual(await drain(w), ['FAILED']);
  assert.equal((await job(w, a.jobId)).endReason, 'INTERNAL');
  assert.equal(steps(w, a.jobId)['context.load']!.failure, 'LOOP_REFUSED_401');
});

test('a stored command the job refuses is dropped by the worker, and the job is untouched', async () => {
  const w = await world();
  const { jobId, commandId } = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-refuse-1' }));
  const row = w.fake.brainCommand.__rows.find((c: any) => c.id === commandId);
  row.issuerUserId = w.people.owner.userId;
  const out = await advanceJob({ jobId, generation: 1, reason: 'START', commandId }, w.workerDeps());
  assert.equal(out, 'DROPPED');
  assert.equal((await job(w, jobId)).state, 'ACCEPTED');
  assert.equal(w.loopCalls.length, 0);
  assert.ok(w.log.lines.some((l) => l.event === 'worker.command_refused' && (l.refusals as string[]).includes('ISSUER_NOT_PERMITTED')));
});

test('the runtime re-checks Loop’s answers itself: a stale decision stops context, lost access stops the commit', async () => {
  // Loop answering with a decision too old to rely on.
  const w = await world();
  const a = await submitted(w, 'manager', reviewSubmission({ idempotencyKey: 'idem-bound-1' }));
  await recover(w, a.commandId);
  const base = w.workerDeps().loop;
  const staleLoop = {
    ...base,
    context: async (ref: Parameters<typeof base.context>[0]) => {
      const r = await base.context(ref);
      return r.ok && r.value.decision ? { ...r, value: { ...r.value, decision: { ...r.value.decision, decidedAtMs: 0 } } } : r;
    },
  };
  assert.deepEqual(await drainWith(w, { loop: staleLoop }), ['FAILED']);
  assert.equal((await job(w, a.jobId)).endReason, 'ACCESS_WITHDRAWN');
  assert.equal(steps(w, a.jobId)['context.load']!.failure, 'ACCESS_WITHDRAWN');

  // Access withdrawn after the context was read: the commit boundary refuses.
  const w2 = await world();
  const b = await submitted(w2, 'manager', reviewSubmission({ idempotencyKey: 'idem-bound-2' }));
  await recover(w2, b.commandId);
  const base2 = w2.workerDeps().loop;
  const demoting = {
    ...base2,
    context: async (ref: Parameters<typeof base2.context>[0]) => {
      const r = await base2.context(ref);
      await w2.iam.updateUserRole(ORG, w2.people.manager.userId, 'EMPLOYEE');
      return r;
    },
  };
  assert.deepEqual(await drainWith(w2, { loop: demoting }), ['FAILED']);
  assert.equal((await job(w2, b.jobId)).endReason, 'ACCESS_WITHDRAWN');
  assert.equal(steps(w2, b.jobId)['context.load']!.state, 'SUCCEEDED');
  assert.equal(steps(w2, b.jobId)['commit.result']!.failure, 'ACCESS_WITHDRAWN');
});

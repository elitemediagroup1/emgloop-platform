// The worker: advance one job by one delivery. Slice B6.
//
// Architecture: brain-execution-infrastructure.md §8 (how a job advances), brain-aws-foundation.md §2.
//
// EVERY DELIVERY STARTS FROM LOOP'S RECORDS. A message names a job and a generation. The
// worker resolves them, takes the job's lease (or stops: someone else holds it), re-reads
// the job, and decides from that record -- never from the message -- what to do. Before
// every step it renews the lease, re-reads the job, honours a pending cancel, applies the
// kill controls and checks the deadline. Each step consults its checkpoint first.
//
// WAITING HOLDS NOTHING. A question releases the lease and sends nothing. Only a RESUME
// command for a recorded reply (after access is re-decided) or the sweeper's TIMER wakes
// the job again.
//
// DARK. Revision 1 has no model step and never commits (plans.ts). It needs no provider
// credential and cannot reach a provider: no provider client is imported anywhere in
// this package.

import {
  BRAIN_DEFAULT_STEP_POLICIES,
  brainBoundaryRefusals,
  brainStepResumeDecision,
  brainStepRetryDecision,
  brainStepStartDecision,
  parseBrainAdvanceMessage,
  type AiTaskDefinition,
  type BrainAdvanceMessage,
  type BrainFailureReason,
  type BrainJobRef,
  type BrainJobSnapshot,
  type BrainJobTransitionEvent,
  type BrainTransitionContext,
} from '@emgloop/shared';
import { brainCanonicalFingerprint, type BrainPayloadSealer } from '@emgloop/database/src/repositories/brain/brain-records';
import type { BrainExecutorJob } from '@emgloop/database/src/services/brain/brain-executor-store';

import type { BrainLogger } from './log';
import type { LoopClient } from './loop-client';
import { BRAIN_DARK_PLAN_VERSION, DARK_CLARIFY_QUESTION, brainTaskMayWait, darkPlan, type BrainPlanStep } from './plans';
import type { BrainQueueName, BrainRuntimeSwitches, BrainWorkerStore, BrainWorkQueues } from './ports';
import { BRAIN_EXECUTOR_REVISION, type BrainExecutionMode } from './revision';
import type { BrainTaskInputView } from './types';

/** Where sealing keys come from. The key itself never leaves the source. */
export interface BrainSealerSource {
  /** The sealer for new checkpoints. Each sealed payload names the key that sealed it. */
  current(): Promise<BrainPayloadSealer>;
  forKeyRef(keyRef: string): Promise<BrainPayloadSealer | null>;
}

export interface BrainWorkerDeps {
  readonly store: BrainWorkerStore;
  readonly loop: LoopClient;
  readonly sealers: BrainSealerSource;
  readonly queues: BrainWorkQueues;
  readonly switches: BrainRuntimeSwitches;
  readonly tasks: readonly AiTaskDefinition[];
  /** This invocation's lease holder name. */
  readonly holder: string;
  readonly leaseMs: number;
  readonly now: () => Date;
  readonly log: BrainLogger;
  readonly mode: BrainExecutionMode;
}

export type BrainWorkerOutcome = 'DROPPED' | 'BUSY' | 'WAITING' | 'CANCELLED' | 'STOPPED' | 'EXPIRED' | 'FAILED' | 'CONTINUED';

/** The message can never be processed. Reported as a failure so the queue moves it to its DLQ. */
export class MalformedAdvanceMessage extends Error {
  constructor(readonly refusals: readonly string[]) {
    super('malformed advance message');
    this.name = 'MalformedAdvanceMessage';
  }
}

/** A transient conflict or outage. Reported as a failure so the queue delivers it again. */
export class RetryDelivery extends Error {
  constructor(readonly code: string) {
    super(`retry delivery: ${code}`);
    this.name = 'RetryDelivery';
  }
}

const MAX_DELAY_SECONDS = 900;

type StepResult =
  | { readonly kind: 'OUTPUT'; readonly value: Record<string, unknown> }
  | { readonly kind: 'END'; readonly outcome: BrainWorkerOutcome };

type StepExecution =
  | { readonly kind: 'OUTPUT'; readonly value: Record<string, unknown> }
  | { readonly kind: 'RETRYABLE'; readonly failureClass: string }
  | { readonly kind: 'FAIL'; readonly failureClass: string; readonly reason: BrainFailureReason }
  | { readonly kind: 'END'; readonly outcome: BrainWorkerOutcome };

function transitionContext(task: AiTaskDefinition): BrainTransitionContext {
  return { supportsDurable: task.execution.classes.includes('DURABLE'), taskMayWait: brainTaskMayWait(task) };
}

function queueFor(job: Pick<BrainJobSnapshot, 'executionClass'>): BrainQueueName {
  return job.executionClass === 'DURABLE' ? 'DURABLE' : 'INTERACTIVE';
}

function fingerprint(stepKey: string, input: BrainTaskInputView): string {
  return brainCanonicalFingerprint({ plan: BRAIN_DARK_PLAN_VERSION, step: stepKey, input });
}

export async function advanceJob(raw: unknown, deps: BrainWorkerDeps): Promise<BrainWorkerOutcome> {
  const parsed = parseBrainAdvanceMessage(raw);
  if (!parsed.ok) {
    deps.log.error('worker.malformed_message', { outcome: 'MALFORMED', refusals: [...parsed.refusals] });
    throw new MalformedAdvanceMessage(parsed.refusals);
  }
  const message = parsed.message;
  const ref: BrainJobRef = { jobId: message.jobId, generation: message.generation };
  const base = { jobId: ref.jobId, generation: ref.generation, reason: message.reason, commandId: message.commandId };

  const job = await deps.store.resolve(ref);
  if (!job) return dropped(deps, base, 'STALE_OR_UNKNOWN');

  if (message.commandId) {
    const lookup = await deps.store.command(message.commandId);
    if (!lookup.ok || lookup.job.jobId !== job.jobId) return dropped(deps, base, 'COMMAND_NOT_FOUND');
    if (lookup.disposition.action === 'REFUSE') {
      deps.log.error('worker.command_refused', { ...base, organizationId: job.organizationId, outcome: 'DROPPED', refusals: [...lookup.disposition.refusals] });
      return 'DROPPED';
    }
    // ALREADY_DONE means the command's own effect happened (the job started, or resumed).
    // The job may still need a worker -- a delivery that failed after starting it leaves it
    // RUNNING with no lease -- so the lease, the job's state and its checkpoints decide
    // from here. A finished job is refused at the lease.
    if (lookup.disposition.action === 'ALREADY_DONE') deps.log.info('worker.command_already_applied', { ...base, organizationId: job.organizationId });
  }

  const startedAt = deps.now();
  const claim = await deps.store.claim(job, deps.holder, deps.leaseMs, startedAt);
  if (!claim.ok) {
    if (claim.reason === 'BUSY') {
      deps.log.info('worker.busy', { ...base, organizationId: job.organizationId, outcome: 'BUSY' });
      return 'BUSY';
    }
    if (claim.reason === 'VERSION_CONFLICT') throw new RetryDelivery('LEASE_CONFLICT');
    return dropped(deps, base, claim.reason);
  }

  let outcome: BrainWorkerOutcome = 'DROPPED';
  try {
    outcome = await drive(job, claim.job, claim.input, claim.record.activeElapsedMs, message, deps, startedAt);
    return outcome;
  } finally {
    const elapsed = Math.max(0, deps.now().getTime() - startedAt.getTime());
    await deps.store.addActiveTime(job, deps.holder, elapsed).catch(() => false);
    await deps.store.release(job, deps.holder).catch(() => false);
    deps.log.info('worker.delivery_done', { ...base, organizationId: job.organizationId, outcome, durationMs: elapsed });
    deps.log.metric('WorkerOutcome', 1, { outcome });
  }
}

function dropped(deps: BrainWorkerDeps, base: Record<string, string | number | null>, why: string): BrainWorkerOutcome {
  deps.log.info('worker.dropped', { ...base, outcome: 'DROPPED', refusals: [why] });
  return 'DROPPED';
}

async function drive(
  ref: BrainExecutorJob,
  initial: BrainJobSnapshot,
  input: BrainTaskInputView,
  activeElapsedMs: number,
  message: BrainAdvanceMessage,
  deps: BrainWorkerDeps,
  startedAt: Date,
): Promise<BrainWorkerOutcome> {
  const log = (event: string, fields: Record<string, string | number | boolean | null | readonly string[]> = {}) =>
    deps.log.info(event, { jobId: ref.jobId, generation: ref.generation, organizationId: ref.organizationId, ...fields });
  let snap = initial;
  const task = deps.tasks.find((t) => t.taskId === snap.taskId && t.version === snap.taskVersion) ?? null;
  if (!task) return fail(ref, 'INTERNAL', null, deps, 'UNKNOWN_TASK_VERSION');
  const ctx = transitionContext(task);

  const move = async (event: BrainJobTransitionEvent): Promise<BrainJobSnapshot> => {
    const out = await deps.store.transition(ref, event as Parameters<BrainWorkerStore['transition']>[1], { context: ctx, holder: deps.holder, now: deps.now() });
    if (!out.ok) throw new RetryDelivery(`TRANSITION_${out.refusal}`);
    log('worker.transition', { state: out.job.state, reason: event.type });
    return out.job;
  };

  const stopped = await killPolicy(ref, snap, deps);
  if (stopped) return stop(ref, snap, stopped, ctx, deps);
  if (snap.state === 'RUNNING' && snap.cancelRequest) return settle(ref, ctx, deps);

  switch (snap.state) {
    case 'ACCEPTED':
      snap = await move({ type: 'DISPATCHED' });
      snap = await move({ type: 'STARTED' });
      break;
    case 'QUEUED':
      snap = await move({ type: 'STARTED' });
      break;
    case 'WAITING_FOR_USER': {
      const waitId = snap.wait?.waitId ?? null;
      if (!waitId) throw new RetryDelivery('WAIT_MISSING');
      if (message.reason === 'TIMER') {
        const expired = await deps.store.expireWait(ref, waitId, deps.now());
        if (expired.ok) {
          log('worker.wait_expired', { waitId, state: expired.job.state, outcome: 'EXPIRED' });
          return 'EXPIRED';
        }
        return expired.refusal === 'NOT_YET_EXPIRED' ? 'WAITING' : 'DROPPED';
      }
      if (message.reason !== 'RESUME') return 'WAITING';
      const access = await deps.loop.access(ref);
      if (!access.ok) {
        if (access.failureClass === 'UNAVAILABLE') throw new RetryDelivery('LOOP_UNAVAILABLE');
        return fail(ref, 'ACCESS_WITHDRAWN', ctx, deps, 'ACCESS_REFUSED');
      }
      const refusals = brainBoundaryRefusals(snap, access.value.principal, access.value.decision, { nowMs: deps.now().getTime() });
      const resumed = await deps.store.resumeAfterReply(ref, { waitId, responderPermitted: refusals.length === 0, holder: deps.holder, now: deps.now() });
      if (!resumed.ok) {
        if (resumed.refusal === 'RESPONDER_NOT_PERMITTED') return fail(ref, 'ACCESS_WITHDRAWN', ctx, deps, 'RESPONDER_NOT_PERMITTED');
        if (resumed.refusal === 'REPLY_NOT_RECORDED') return 'WAITING';
        throw new RetryDelivery(`RESUME_${resumed.refusal}`);
      }
      snap = resumed.job;
      await recordAnswer(ref, input, resumed.reply, deps);
      log('worker.resumed', { waitId, state: snap.state });
      break;
    }
    case 'RUNNING':
      break;
    default:
      return 'DROPPED';
  }

  const plan = darkPlan(task, input);
  const outputs: Record<string, Record<string, unknown>> = {};
  for (const step of plan) {
    // A step boundary: renew the lease and re-read the job before anything else.
    const fresh = await deps.store.claim(ref, deps.holder, deps.leaseMs, deps.now());
    if (!fresh.ok) {
      if (fresh.reason === 'VERSION_CONFLICT') throw new RetryDelivery('LEASE_CONFLICT');
      return 'DROPPED';
    }
    snap = fresh.job;
    if (snap.state !== 'RUNNING') return snap.state === 'CANCELLED' ? 'CANCELLED' : 'DROPPED';
    if (snap.cancelRequest) return settle(ref, ctx, deps);
    const policy = await killPolicy(ref, snap, deps);
    if (policy) return stop(ref, snap, policy, ctx, deps);

    const elapsedMs = activeElapsedMs + (deps.now().getTime() - startedAt.getTime());
    const start = brainStepStartDecision({ contract: task.execution, executionClass: snap.executionClass, elapsedMs, stepMaxDurationMs: step.maxDurationMs });
    if (start.action === 'FAIL') return fail(ref, 'DEADLINE_EXCEEDED', ctx, deps, 'DEADLINE_BEFORE_STEP');
    if (start.action === 'PROMOTE') {
      snap = await move({ type: 'PROMOTED' });
      await requeue(ref, snap, deps, 0);
      return 'CONTINUED';
    }

    const result = await runStep(ref, snap, step, input, task, ctx, outputs, deps);
    if (result.kind === 'END') return result.outcome;
    outputs[step.key] = result.value;
  }
  // Every plan ends at the commit boundary, which ends the job.
  return fail(ref, 'INTERNAL', ctx, deps, 'PLAN_ENDED_WITHOUT_BOUNDARY');
}

async function runStep(
  ref: BrainExecutorJob,
  snap: BrainJobSnapshot,
  step: BrainPlanStep,
  input: BrainTaskInputView,
  task: AiTaskDefinition,
  ctx: BrainTransitionContext,
  outputs: Readonly<Record<string, Record<string, unknown>>>,
  deps: BrainWorkerDeps,
): Promise<StepResult> {
  const fp = fingerprint(step.key, input);
  const policy = BRAIN_DEFAULT_STEP_POLICIES[step.kind];
  const fields = { jobId: ref.jobId, generation: ref.generation, organizationId: ref.organizationId, stepKey: step.key, stepKind: step.kind };
  const state = await deps.store.stepState(ref, step.key, fp);
  if (!state.ok) return { kind: 'END', outcome: await fail(ref, 'INTERNAL', ctx, deps, state.refusal) };
  const decision = brainStepResumeDecision(policy, state);

  if (decision.action === 'RETURN_CHECKPOINT') {
    const value = state.checkpoint ? await openCheckpoint(ref, state.checkpoint, deps) : null;
    if (!value) return { kind: 'END', outcome: await fail(ref, 'INTERNAL', ctx, deps, 'CHECKPOINT_UNREADABLE') };
    deps.log.info('worker.step_checkpoint_reused', { ...fields, outcome: 'REUSED' });
    return { kind: 'OUTPUT', value };
  }
  if (decision.action === 'FAIL') return { kind: 'END', outcome: await fail(ref, decision.reason, ctx, deps, 'STEP_' + decision.reason) };
  if (decision.action === 'ABANDON_AND_RETRY') {
    // Only a paid step has in-flight calls, and revision 1 has none.
    return { kind: 'END', outcome: await fail(ref, 'INTERNAL', ctx, deps, 'UNEXPECTED_IN_FLIGHT_CALL') };
  }

  const attempt = decision.attempt;
  const begun = await deps.store.beginStep(ref, { stepKey: step.key, kind: step.kind, inputFingerprint: fp, attempt, paid: false, now: deps.now() });
  if (!begun.ok) {
    if (begun.refusal === 'ATTEMPT_CONFLICT') throw new RetryDelivery('STEP_ATTEMPT_CONFLICT');
    if (begun.refusal === 'JOB_NOT_RUNNING') return { kind: 'END', outcome: 'DROPPED' };
    return { kind: 'END', outcome: await fail(ref, 'INTERNAL', ctx, deps, `STEP_${begun.refusal}`) };
  }
  deps.log.info('worker.step_started', { ...fields, attempt, outcome: 'STARTED' });

  const exec = await executeStep(ref, snap, step, task, ctx, outputs, deps);
  switch (exec.kind) {
    case 'OUTPUT': {
      const sealer = await deps.sealers.current();
      const payload = await sealer.seal(
        { organizationId: ref.organizationId, jobId: ref.jobId, stepKey: step.key, inputFingerprint: fp, purpose: 'CHECKPOINT' },
        Buffer.from(JSON.stringify(exec.value), 'utf8'),
      );
      const recorded = await deps.store.checkpoint(ref, { stepKey: step.key, inputFingerprint: fp, payload, now: deps.now() });
      if (!recorded.ok) return { kind: 'END', outcome: await fail(ref, 'INTERNAL', ctx, deps, `CHECKPOINT_${recorded.refusal}`) };
      deps.log.info('worker.step_checkpointed', { ...fields, attempt, outcome: recorded.recorded });
      return { kind: 'OUTPUT', value: exec.value };
    }
    case 'RETRYABLE': {
      await deps.store.failStep(ref, { stepKey: step.key, inputFingerprint: fp, failureClass: exec.failureClass, now: deps.now() });
      const retry = brainStepRetryDecision(policy, { attemptsMade: attempt, paidAttemptsMade: 0, failureClass: exec.failureClass });
      deps.log.warn('worker.step_failed', { ...fields, attempt, failureClass: exec.failureClass, outcome: retry.action });
      if (retry.action === 'FAIL') return { kind: 'END', outcome: await fail(ref, 'RETRIES_EXHAUSTED', ctx, deps, exec.failureClass) };
      await requeue(ref, snap, deps, Math.min(MAX_DELAY_SECONDS, 5 * 2 ** attempt));
      return { kind: 'END', outcome: 'CONTINUED' };
    }
    case 'FAIL':
      await deps.store.failStep(ref, { stepKey: step.key, inputFingerprint: fp, failureClass: exec.failureClass, now: deps.now() });
      deps.log.warn('worker.step_failed', { ...fields, attempt, failureClass: exec.failureClass, outcome: 'FAIL' });
      return { kind: 'END', outcome: await fail(ref, exec.reason, ctx, deps, exec.failureClass) };
    case 'END':
      return { kind: 'END', outcome: exec.outcome };
  }
}

async function executeStep(
  ref: BrainExecutorJob,
  snap: BrainJobSnapshot,
  step: BrainPlanStep,
  task: AiTaskDefinition,
  ctx: BrainTransitionContext,
  outputs: Readonly<Record<string, Record<string, unknown>>>,
  deps: BrainWorkerDeps,
): Promise<StepExecution> {
  switch (step.kind) {
    case 'LOAD_CONTEXT': {
      const answer = await deps.loop.context(ref);
      if (!answer.ok) return loopFailure(answer);
      const refusals = brainBoundaryRefusals(snap, answer.value.principal, answer.value.decision, { nowMs: deps.now().getTime() });
      if (refusals.length > 0) return { kind: 'FAIL', failureClass: 'ACCESS_WITHDRAWN', reason: 'ACCESS_WITHDRAWN' };
      const refs = answer.value.supplied.map((s) => s.ref).sort();
      return {
        kind: 'OUTPUT',
        value: {
          planVersion: BRAIN_DARK_PLAN_VERSION,
          manifestHash: brainCanonicalFingerprint(refs),
          supplied: refs.length,
          items: answer.value.itemCount,
          withheld: answer.value.withheld,
          commitGate: answer.value.commitGate,
        },
      };
    }
    case 'SYNTHETIC':
      return { kind: 'OUTPUT', value: { mode: deps.mode, providerCalled: false, revision: BRAIN_EXECUTOR_REVISION } };
    case 'REQUEST_USER_INPUT': {
      let current = snap;
      if (current.executionClass !== 'DURABLE') {
        // A job waits only as durable work; promotion is a state change on the same job.
        const promoted = await deps.store.transition(ref, { type: 'PROMOTED' }, { context: ctx, holder: deps.holder, now: deps.now() });
        if (!promoted.ok) return { kind: 'FAIL', failureClass: `PROMOTE_${promoted.refusal}`, reason: 'INTERNAL' };
        current = promoted.job;
      }
      const maxWaitMs = task.execution.durable?.maxUserWaitMs ?? null;
      if (maxWaitMs === null) return { kind: 'FAIL', failureClass: 'TASK_NEVER_WAITS', reason: 'INTERNAL' };
      const opened = await deps.store.waitForUser(ref, {
        question: DARK_CLARIFY_QUESTION,
        expiresAt: new Date(deps.now().getTime() + maxWaitMs),
        context: ctx,
        holder: deps.holder,
        now: deps.now(),
      });
      if (!opened.ok) return { kind: 'FAIL', failureClass: `WAIT_${opened.refusal}`, reason: 'INTERNAL' };
      deps.log.info('worker.waiting', { jobId: ref.jobId, organizationId: ref.organizationId, waitId: opened.waitId, state: current.state, outcome: 'WAITING' });
      return { kind: 'END', outcome: 'WAITING' };
    }
    case 'COMMIT_RESULT': {
      // The governed boundary: access is re-decided now, from Loop's records.
      const access = await deps.loop.access(ref);
      if (!access.ok) return loopFailure(access);
      const refusals = brainBoundaryRefusals(snap, access.value.principal, access.value.decision, { nowMs: deps.now().getTime() });
      if (refusals.length > 0) return { kind: 'FAIL', failureClass: 'ACCESS_WITHDRAWN', reason: 'ACCESS_WITHDRAWN' };
      const gate = outputs['context.load']?.commitGate === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE';
      deps.log.info('worker.commit_boundary', { jobId: ref.jobId, organizationId: ref.organizationId, commitGate: gate, mode: deps.mode });
      // Revision 1 is dark: there is no model output to commit, so nothing is sent to an owner.
      return { kind: 'FAIL', failureClass: gate === 'AVAILABLE' ? 'DARK_MODE_NO_RESULT' : 'OWNER_GATE_UNAVAILABLE', reason: 'COMMIT_REFUSED' };
    }
    default:
      return { kind: 'FAIL', failureClass: 'STEP_KIND_NOT_IN_REVISION', reason: 'INTERNAL' };
  }
}

function loopFailure(call: { readonly failureClass: 'UNAVAILABLE' | 'REFUSED'; readonly status: number | null; readonly refusals?: readonly string[] }): StepExecution {
  if (call.failureClass === 'UNAVAILABLE') return { kind: 'RETRYABLE', failureClass: 'UNAVAILABLE' };
  const refusals = call.refusals ?? [];
  if (refusals.includes('NOT_PERMITTED')) return { kind: 'FAIL', failureClass: 'ACCESS_WITHDRAWN', reason: 'ACCESS_WITHDRAWN' };
  if (call.status === 409) return { kind: 'FAIL', failureClass: 'CONTEXT_REFUSED', reason: 'CONTEXT_UNAVAILABLE' };
  // 400/401/403 with anything else is a trust or configuration fault, never retried blindly.
  return { kind: 'FAIL', failureClass: `LOOP_REFUSED_${call.status ?? 0}`, reason: 'INTERNAL' };
}

async function recordAnswer(ref: BrainExecutorJob, input: BrainTaskInputView, reply: Record<string, unknown>, deps: BrainWorkerDeps): Promise<void> {
  const fp = fingerprint('dark.clarify', input);
  const sealer = await deps.sealers.current();
  const value = { answered: true, replyKind: typeof reply.kind === 'string' ? reply.kind : null };
  const payload = await sealer.seal(
    { organizationId: ref.organizationId, jobId: ref.jobId, stepKey: 'dark.clarify', inputFingerprint: fp, purpose: 'CHECKPOINT' },
    Buffer.from(JSON.stringify(value), 'utf8'),
  );
  // Already recorded (a duplicate RESUME) is fine.
  await deps.store.checkpoint(ref, { stepKey: 'dark.clarify', inputFingerprint: fp, payload, now: deps.now() });
}

async function openCheckpoint(
  ref: BrainExecutorJob,
  checkpoint: { readonly jobId: string; readonly stepKey: string; readonly inputFingerprint: string },
  deps: BrainWorkerDeps,
): Promise<Record<string, unknown> | null> {
  const payload = await deps.store.readCheckpoint(ref, checkpoint);
  if (!payload) return null;
  const sealer = await deps.sealers.forKeyRef(payload.keyRef);
  if (!sealer) return null;
  try {
    const bytes = await sealer.open(
      { organizationId: ref.organizationId, jobId: checkpoint.jobId, stepKey: checkpoint.stepKey, inputFingerprint: checkpoint.inputFingerprint, purpose: 'CHECKPOINT' },
      payload,
    );
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Which control, if any, stops this job now: the worker switch, or a kill that names it. */
async function killPolicy(ref: BrainExecutorJob, snap: BrainJobSnapshot, deps: BrainWorkerDeps): Promise<string | null> {
  if (!(await deps.switches.workerEnabled())) return 'worker-switch';
  const effective = await deps.store.controlsFor(ref, await deps.switches.aiFloor());
  const kill = effective.killSwitches.find(
    (k) => k.scope === 'GLOBAL' || (k.scope === 'ORGANIZATION' && k.value === snap.organizationId) || (k.scope === 'TASK' && k.value === snap.taskId),
  );
  return kill ? `ai-control:${kill.scope}` : null;
}

async function stop(ref: BrainExecutorJob, snap: BrainJobSnapshot, policy: string, ctx: BrainTransitionContext, deps: BrainWorkerDeps): Promise<BrainWorkerOutcome> {
  const out = await deps.store.stopByPolicy(ref, policy, deps.now());
  if (!out.ok) {
    if (out.refusal === 'JOB_IS_TERMINAL') return 'DROPPED';
    throw new RetryDelivery(`STOP_${out.refusal}`);
  }
  deps.log.warn('worker.stopped_by_policy', { jobId: ref.jobId, organizationId: ref.organizationId, reason: policy, state: snap.state, outcome: 'STOPPED' });
  if (!out.stoppedNow) {
    const settled = await deps.store.transition(ref, { type: 'CANCEL_SETTLED' }, { context: ctx, holder: deps.holder, now: deps.now() });
    if (!settled.ok) throw new RetryDelivery(`SETTLE_${settled.refusal}`);
  }
  return 'STOPPED';
}

async function settle(ref: BrainExecutorJob, ctx: BrainTransitionContext, deps: BrainWorkerDeps): Promise<BrainWorkerOutcome> {
  const settled = await deps.store.transition(ref, { type: 'CANCEL_SETTLED' }, { context: ctx, holder: deps.holder, now: deps.now() });
  if (!settled.ok) throw new RetryDelivery(`SETTLE_${settled.refusal}`);
  deps.log.info('worker.cancel_settled', { jobId: ref.jobId, organizationId: ref.organizationId, state: settled.job.state, outcome: 'CANCELLED' });
  return 'CANCELLED';
}

async function fail(
  ref: BrainExecutorJob,
  reason: BrainFailureReason,
  ctx: BrainTransitionContext | null,
  deps: BrainWorkerDeps,
  failureClass: string,
): Promise<BrainWorkerOutcome> {
  const out = await deps.store.transition(ref, { type: 'FAILED', reason }, {
    context: ctx ?? { supportsDurable: false, taskMayWait: false },
    holder: deps.holder,
    now: deps.now(),
  });
  if (!out.ok) {
    if (out.refusal === 'JOB_IS_TERMINAL') return 'DROPPED';
    throw new RetryDelivery(`FAIL_${out.refusal}`);
  }
  deps.log.warn('worker.job_failed', { jobId: ref.jobId, organizationId: ref.organizationId, endReason: reason, failureClass, state: out.job.state, outcome: 'FAILED' });
  return 'FAILED';
}

async function requeue(ref: BrainExecutorJob, snap: BrainJobSnapshot, deps: BrainWorkerDeps, delaySeconds: number): Promise<void> {
  const queue = queueFor(snap);
  const sent = await deps.queues.send(queue, { jobId: ref.jobId, generation: ref.generation, reason: 'CONTINUE', commandId: null }, { delaySeconds });
  deps.log.info('worker.requeued', { jobId: ref.jobId, organizationId: ref.organizationId, queue, delaySeconds, messageId: sent.messageId });
}

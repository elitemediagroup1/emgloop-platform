// The Brain execution contracts (B2).
//
// WHAT THESE PROVE
//
// THREE DIMENSIONS, NEVER ONE. Execution class says how work runs, result type says
// what it means and who owns it, and capability route says what it needs. Each is its
// own declaration, and any combination the tables allow is a valid task.
//
// ACCEPTED WORK OUTLIVES WHOEVER ASKED. No transition describes a client, a session or
// a connection. A reference execution below loses its submitter, crashes mid-way and
// still finishes exactly once, without paying for a step twice.
//
// THE JOB IS NOT THE ARTIFACT, AND AI IS NOT TRUTH. A result reaches only the authority
// that owns its kind of result, never Activity or the job; it is never more than
// proposed; every claim stands on evidence Loop supplied; and a model's earlier output is
// never cited as a governed fact.
//
// AUTHORITY COMES FROM LOOP'S RECORDS. A request cannot name its organization or its
// principal, a doorbell ring can only point at a stored command, and every consequential
// boundary re-decides access against the job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AI_CAPABILITY_ROUTES,
  AI_RETIRED_CAPABILITY_PROFILES,
  AI_TASK_CASE_EXPLANATION,
  AI_TASKS,
  aiLedgerCapabilityOf,
  aiTaskContractViolations,
  BRAIN_CANCEL_REASONS,
  BRAIN_CLIENT_AUTHORITY_KEYS,
  BRAIN_DEFAULT_STEP_POLICIES,
  BRAIN_EXECUTION_CLASSES,
  BRAIN_EXECUTOR_OBLIGATIONS,
  BRAIN_FAILURE_REASONS,
  BRAIN_JOB_EVENT_NAMES,
  BRAIN_JOB_STATES,
  BRAIN_NEVER_OWNERS,
  BRAIN_OWNERSHIP_RULES,
  BRAIN_RESULT_TYPES,
  BRAIN_STEP_KINDS,
  BRAIN_TRANSITION_EVENT_TYPES,
  brainAcceptedJob,
  brainBoundaryRefusals,
  brainCallKey,
  brainCheckpointKey,
  brainCommandDisposition,
  brainCommitRefusals,
  brainDeadlineDecision,
  brainDoorbellCheck,
  brainEvidenceRefsOf,
  brainExecutionContractViolations,
  brainFallbackRefusals,
  brainJobEventRefusals,
  brainJobTransition,
  brainMayWaitForUser,
  brainModelStepProvenance,
  brainPresentation,
  brainProgressFraction,
  brainStepPolicyViolations,
  brainStepResumeDecision,
  brainStepRetryDecision,
  brainSubmissionDecision,
  brainSubmissionFingerprint,
  brainSubmissionRefusals,
  parseBrainSubmission,
  type AiTaskDefinition,
  type BrainAccessDecision,
  type BrainCommand,
  type BrainDoorbellClaims,
  type BrainExecutionContract,
  type BrainJobSnapshot,
  type BrainJobTransitionEvent,
  type BrainResultEnvelope,
  type BrainSubmission,
  type BrainSubmitter,
  type BrainTransitionContext,
} from '../src';

const ORG = 'org_a';
const OTHER_ORG = 'org_b';
const PRINCIPAL = 'user_1';

// --- Builders ------------------------------------------------------------------------

const DURABLE_CONTRACT: BrainExecutionContract = {
  classes: ['INTERACTIVE', 'DURABLE'],
  interactive: { presentationBudgetMs: 10_000, executionDeadlineMs: 30_000, streaming: 'PROGRESS' },
  durable: { executionDeadlineMs: 3_600_000, maxUserWaitMs: 86_400_000 },
};

const submitter = (over: Partial<BrainSubmitter> = {}): BrainSubmitter => ({
  organizationId: ORG,
  userId: PRINCIPAL,
  kind: 'HUMAN',
  membershipActive: true,
  allowed: true,
  ...over,
});

const submission = (over: Partial<BrainSubmission> = {}): BrainSubmission => ({
  taskId: 'relationship.review',
  subject: { type: 'RELATIONSHIP', id: 'rel_1' },
  executionClass: 'DURABLE',
  idempotencyKey: 'idem-key-0001',
  input: { horizonDays: 90 },
  ...over,
});

function job(over: Partial<BrainJobSnapshot> = {}): BrainJobSnapshot {
  return {
    ...brainAcceptedJob({
      jobId: 'job_1',
      submitter: submitter(),
      submission: submission(),
      task: { taskId: 'relationship.review', version: '1.0.0', capabilityRoute: 'TECHNICAL_ANALYSIS', resultType: 'ANALYSIS' },
    }),
    ...over,
  };
}

const DURABLE_CTX: BrainTransitionContext = { supportsDurable: true, taskMayWait: true };
const REF = { owner: { authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP' }, subjectId: 'rel_1', artifactId: 'ana_1' } as const;

function run(start: BrainJobSnapshot, events: readonly BrainJobTransitionEvent[], ctx: BrainTransitionContext = DURABLE_CTX) {
  let current = start;
  const emitted: string[] = [];
  for (const event of events) {
    const t = brainJobTransition(current, event, ctx);
    assert.ok(t.ok, `${event.type} from ${current.state} was refused: ${t.ok ? '' : t.refusal}`);
    current = t.job;
    if (t.emits) emitted.push(t.emits);
  }
  return { job: current, emitted };
}

function refusal(start: BrainJobSnapshot, event: BrainJobTransitionEvent, ctx: BrainTransitionContext = DURABLE_CTX): string {
  const t = brainJobTransition(start, event, ctx);
  assert.equal(t.ok, false, `${event.type} from ${start.state} should be refused`);
  return t.ok ? '' : t.refusal;
}

// --- Dimensions -----------------------------------------------------------------------

test('execution class, result type and capability route are three separate vocabularies', () => {
  const sets = [BRAIN_EXECUTION_CLASSES, BRAIN_RESULT_TYPES, AI_CAPABILITY_ROUTES].map((v) => new Set<string>(v));
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      assert.deepEqual([...sets[i]!].filter((v) => sets[j]!.has(v)), [], 'no word means two things');
    }
  }
  assert.deepEqual([...BRAIN_EXECUTION_CLASSES], ['INTERACTIVE', 'DURABLE']);
  assert.deepEqual([...BRAIN_RESULT_TYPES], ['ANSWER', 'ANALYSIS', 'FINDING', 'RECOMMENDATION', 'PROPOSED_ACTION']);
  assert.deepEqual([...AI_CAPABILITY_ROUTES], ['COMMUNICATION', 'TECHNICAL_ANALYSIS', 'GENERAL_REASONING']);
  // A task declares each on its own; none is derived from another.
  const t = AI_TASK_CASE_EXPLANATION;
  assert.equal(t.capabilityRoute, 'TECHNICAL_ANALYSIS');
  assert.equal(t.resultType, 'ANALYSIS');
  assert.deepEqual([...t.execution.classes], ['INTERACTIVE']);
});

function task(over: Partial<AiTaskDefinition>): AiTaskDefinition {
  return { ...AI_TASK_CASE_EXPLANATION, ...over } as AiTaskDefinition;
}

test('any allowed combination is a coherent task: durable communication, interactive analysis', () => {
  const durableDraft = task({
    capabilityRoute: 'COMMUNICATION',
    resultType: 'ANSWER',
    resultOwner: { authority: 'BRAIN_CONVERSATIONS', subjectType: 'CONVERSATION' },
    execution: DURABLE_CONTRACT,
  });
  assert.deepEqual(aiTaskContractViolations(durableDraft), []);
  const interactiveTechnical = task({ capabilityRoute: 'TECHNICAL_ANALYSIS', resultType: 'ANALYSIS' });
  assert.deepEqual(aiTaskContractViolations(interactiveTechnical), []);
  for (const t of AI_TASKS) assert.deepEqual(aiTaskContractViolations(t), [], `${t.taskId} is coherent`);
});

test('a task cannot confuse what it produces with what it may do, or declare the retired profile', () => {
  assert.deepEqual(
    aiTaskContractViolations(task({ resultType: 'FINDING', consequence: 'READ_ONLY' })),
    ['CONSEQUENCE_DOES_NOT_MATCH_RESULT'],
    'a finding is a proposal',
  );
  assert.deepEqual(
    aiTaskContractViolations(task({ resultType: 'ANALYSIS', consequence: 'PROPOSES_FOR_APPROVAL' })),
    ['CONSEQUENCE_DOES_NOT_MATCH_RESULT'],
    'an analysis proposes nothing',
  );
  assert.deepEqual(
    aiTaskContractViolations(task({ resultType: 'FINDING', resultOwner: { authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP' } })),
    ['OWNERSHIP_NOT_PERMITTED'],
  );
  assert.deepEqual(aiTaskContractViolations(task({ capabilityRoute: 'EXPLANATION' as never })), ['UNKNOWN_CAPABILITY_ROUTE']);
  assert.deepEqual(aiTaskContractViolations(task({ invokerRoles: [] })), ['NO_INVOKER']);
  assert.deepEqual(
    aiTaskContractViolations(task({ execution: { classes: ['DURABLE'], interactive: null, durable: null } })),
    ['EXECUTION_CONTRACT_INVALID'],
  );
});

test('the ledger reads a capability route as a route, a pre-B2 profile as retired, and anything else as unrecognised', () => {
  for (const route of AI_CAPABILITY_ROUTES) assert.deepEqual(aiLedgerCapabilityOf(route), { kind: 'CAPABILITY_ROUTE', route });
  for (const profile of AI_RETIRED_CAPABILITY_PROFILES) {
    assert.deepEqual(aiLedgerCapabilityOf(profile), { kind: 'RETIRED_PROFILE', profile }, `${profile} is never guessed onto a route`);
  }
  assert.deepEqual(aiLedgerCapabilityOf('technical_analysis'), { kind: 'UNRECOGNIZED', stored: 'technical_analysis' });
});

// --- Execution classes ------------------------------------------------------------------

test('an execution contract is refused when its envelopes do not match its classes', () => {
  assert.deepEqual(brainExecutionContractViolations(DURABLE_CONTRACT, 'ANALYSIS'), []);
  assert.deepEqual(brainExecutionContractViolations({ classes: [], interactive: null, durable: null }, 'ANALYSIS'), ['NO_EXECUTION_CLASS']);
  assert.deepEqual(
    brainExecutionContractViolations({ ...DURABLE_CONTRACT, interactive: null }, 'ANALYSIS'),
    ['INTERACTIVE_ENVELOPE_MISSING'],
  );
  assert.deepEqual(
    brainExecutionContractViolations({ classes: ['INTERACTIVE'], interactive: DURABLE_CONTRACT.interactive, durable: DURABLE_CONTRACT.durable }, 'ANALYSIS'),
    ['ENVELOPE_WITHOUT_CLASS'],
  );
  assert.deepEqual(
    brainExecutionContractViolations(
      { ...DURABLE_CONTRACT, interactive: { presentationBudgetMs: 40_000, executionDeadlineMs: 30_000, streaming: 'NONE' } },
      'ANALYSIS',
    ),
    ['PRESENTATION_BUDGET_EXCEEDS_DEADLINE'],
  );
  assert.deepEqual(
    brainExecutionContractViolations({ ...DURABLE_CONTRACT, durable: { executionDeadlineMs: 0, maxUserWaitMs: null } }, 'ANALYSIS'),
    ['LIMIT_NOT_POSITIVE'],
  );
});

test('unvalidated text is never streamed to a reader, for any result type, until Product approves one', () => {
  for (const type of BRAIN_RESULT_TYPES) {
    const contract = { ...DURABLE_CONTRACT, interactive: { ...DURABLE_CONTRACT.interactive!, streaming: 'PROVISIONAL_TEXT' as const } };
    assert.deepEqual(brainExecutionContractViolations(contract, type), ['PROVISIONAL_TEXT_NOT_APPROVED'], type);
  }
});

test('when interactive time runs out, the same job is promoted if it can be, and fails by name if not', () => {
  const interactiveOnly: BrainExecutionContract = { classes: ['INTERACTIVE'], interactive: DURABLE_CONTRACT.interactive, durable: null };
  assert.deepEqual(brainDeadlineDecision({ contract: DURABLE_CONTRACT, executionClass: 'INTERACTIVE', elapsedMs: 29_999 }), { action: 'CONTINUE' });
  assert.deepEqual(brainDeadlineDecision({ contract: DURABLE_CONTRACT, executionClass: 'INTERACTIVE', elapsedMs: 30_000 }), { action: 'PROMOTE' });
  assert.deepEqual(brainDeadlineDecision({ contract: interactiveOnly, executionClass: 'INTERACTIVE', elapsedMs: 30_000 }), {
    action: 'FAIL',
    reason: 'DEADLINE_EXCEEDED',
  });
  assert.deepEqual(brainDeadlineDecision({ contract: DURABLE_CONTRACT, executionClass: 'DURABLE', elapsedMs: 3_599_999 }), { action: 'CONTINUE' });
  assert.deepEqual(brainDeadlineDecision({ contract: DURABLE_CONTRACT, executionClass: 'DURABLE', elapsedMs: 3_600_000 }), {
    action: 'FAIL',
    reason: 'DEADLINE_EXCEEDED',
  });
  assert.equal(brainPresentation(DURABLE_CONTRACT.interactive, 9_999), 'IN_PLACE');
  assert.equal(brainPresentation(DURABLE_CONTRACT.interactive, 10_000), 'BACKGROUND', 'presentation, not a job change');
  assert.equal(brainMayWaitForUser(DURABLE_CONTRACT, 'INTERACTIVE'), false);
  assert.equal(brainMayWaitForUser(DURABLE_CONTRACT, 'DURABLE'), true);
  assert.equal(brainMayWaitForUser({ ...DURABLE_CONTRACT, durable: { executionDeadlineMs: 1, maxUserWaitMs: null } }, 'DURABLE'), false);
});

test('fence: no hosting limit or infrastructure product is part of the execution contract', () => {
  const dir = join(__dirname, '..', 'src', 'ai');
  for (const file of ['capability.ts', 'brain-execution.ts', 'brain-result.ts', 'brain-job.ts', 'brain-step.ts', 'brain-trust.ts', 'brain-executor.ts', 'brain-dispatch.ts']) {
    const src = readFileSync(join(dir, file), 'utf8');
    assert.doesNotMatch(src, /\blambda\b|step functions|\bsqs\b|eventbridge|api gateway|\becs\b|fargate|temporal|netlify|inngest|\baws\b|vercel|cloudflare/i, `${file} names no infrastructure`);
    assert.doesNotMatch(src, /60_?000|sixty seconds|60 ?s\b/i, `${file} carries no platform request limit`);
  }
});

// --- Jobs -----------------------------------------------------------------------------

test('a durable job runs to success and tells Activity only where the result lives', () => {
  const { job: done, emitted } = run(job(), [
    { type: 'DISPATCHED' },
    { type: 'STARTED' },
    { type: 'RESULT_COMMITTED', resultRefs: [REF] },
  ]);
  assert.equal(done.state, 'SUCCEEDED');
  assert.deepEqual(done.resultRefs, [REF]);
  assert.deepEqual(emitted, ['brain.job.succeeded']);
  for (const name of emitted) assert.ok((BRAIN_JOB_EVENT_NAMES as readonly string[]).includes(name));
});

test("accepted work belongs to the submitter's organization and person, taken from the session", () => {
  const accepted = job();
  assert.equal(accepted.state, 'ACCEPTED');
  assert.equal(accepted.organizationId, ORG);
  assert.equal(accepted.principalUserId, PRINCIPAL);
  assert.equal(accepted.generation, 1);
  assert.equal(accepted.promoted, false);
  // Even a submission object that somehow carries an organization cannot move the job.
  const smuggled = { ...submission(), organizationId: OTHER_ORG, principalUserId: 'user_9' } as unknown as BrainSubmission;
  const safe = brainAcceptedJob({
    jobId: 'job_2',
    submitter: submitter(),
    submission: smuggled,
    task: { taskId: 'relationship.review', version: '1.0.0', capabilityRoute: 'TECHNICAL_ANALYSIS', resultType: 'ANALYSIS' },
  });
  assert.equal(safe.organizationId, ORG);
  assert.equal(safe.principalUserId, PRINCIPAL);
});

test('a terminal job never moves again, and success needs a result', () => {
  for (const state of ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
    for (const type of BRAIN_TRANSITION_EVENT_TYPES) {
      const event = { type, reason: 'INTERNAL', resultRefs: [REF], waitId: 'w', responderUserId: PRINCIPAL, wait: { waitId: 'w', expiresAtMs: 1 }, request: { actor: { kind: 'SYSTEM' }, reason: 'KILL_SWITCH' } } as unknown as BrainJobTransitionEvent;
      assert.equal(refusal(job({ state }), event), 'JOB_IS_TERMINAL', `${type} after ${state}`);
    }
  }
  assert.equal(refusal(job({ state: 'RUNNING' }), { type: 'RESULT_COMMITTED', resultRefs: [] }), 'NO_RESULT');
  assert.equal(refusal(job({ state: 'QUEUED' }), { type: 'RESULT_COMMITTED', resultRefs: [REF] }), 'EVENT_NOT_ALLOWED_IN_STATE');
  assert.equal(refusal(job(), { type: 'STARTED' }), 'EVENT_NOT_ALLOWED_IN_STATE', 'nothing starts before an executor acknowledged it');
});

test('only durable work waits for a person, and only when its task may ask', () => {
  const wait = { waitId: 'wait_1', expiresAtMs: 5_000 };
  assert.equal(
    refusal(job({ state: 'RUNNING', executionClass: 'INTERACTIVE' }), { type: 'USER_INPUT_REQUESTED', wait }),
    'INTERACTIVE_CANNOT_WAIT',
  );
  assert.equal(
    refusal(job({ state: 'RUNNING' }), { type: 'USER_INPUT_REQUESTED', wait }, { supportsDurable: true, taskMayWait: false }),
    'TASK_NEVER_WAITS',
  );
  const { job: waiting, emitted } = run(job({ state: 'RUNNING' }), [{ type: 'USER_INPUT_REQUESTED', wait }]);
  assert.equal(waiting.state, 'WAITING_FOR_USER');
  assert.deepEqual(waiting.wait, wait);
  assert.deepEqual(emitted, ['brain.job.waiting_for_user']);
});

test('a waiting job resumes only for the right wait, answered by its principal, whose access was just re-checked', () => {
  const waiting = job({ state: 'WAITING_FOR_USER', wait: { waitId: 'wait_1', expiresAtMs: 5_000 } });
  const answered = { type: 'USER_INPUT_RECEIVED', waitId: 'wait_1', responderUserId: PRINCIPAL } as const;
  assert.equal(refusal(waiting, { ...answered, waitId: 'wait_0' }, { ...DURABLE_CTX, responderPermitted: true }), 'WAIT_MISMATCH');
  assert.equal(
    refusal(waiting, { ...answered, responderUserId: 'user_2' }, { ...DURABLE_CTX, responderPermitted: true }),
    'RESPONDER_IS_NOT_PRINCIPAL',
  );
  assert.equal(refusal(waiting, answered, { ...DURABLE_CTX }), 'RESPONDER_NOT_PERMITTED', 'an unchecked responder is not permitted');
  assert.equal(refusal(waiting, answered, { ...DURABLE_CTX, responderPermitted: false }), 'RESPONDER_NOT_PERMITTED');
  const { job: resumed } = run(waiting, [answered], { ...DURABLE_CTX, responderPermitted: true });
  assert.equal(resumed.state, 'RUNNING');
  assert.equal(resumed.wait, null);
  assert.equal(refusal(job({ state: 'RUNNING' }), answered, { ...DURABLE_CTX, responderPermitted: true }), 'EVENT_NOT_ALLOWED_IN_STATE');
});

test('an unanswered wait expires into a named cancellation', () => {
  const waiting = job({ state: 'WAITING_FOR_USER', wait: { waitId: 'wait_1', expiresAtMs: 5_000 } });
  assert.equal(refusal(waiting, { type: 'WAIT_EXPIRED', waitId: 'wait_x' }), 'WAIT_MISMATCH');
  const { job: expired, emitted } = run(waiting, [{ type: 'WAIT_EXPIRED', waitId: 'wait_1' }]);
  assert.equal(expired.state, 'CANCELLED');
  assert.equal(expired.endReason, 'WAIT_EXPIRED');
  assert.deepEqual(emitted, ['brain.job.cancelled']);
});

test('cancelling stops idle work at once, and running work at its next boundary with its late result unapplied', () => {
  const byPrincipal = { actor: { kind: 'HUMAN', userId: PRINCIPAL }, reason: 'REQUESTED_BY_PRINCIPAL' } as const;
  for (const state of ['ACCEPTED', 'QUEUED'] as const) {
    const { job: stopped } = run(job({ state }), [{ type: 'CANCEL_REQUESTED', request: byPrincipal }]);
    assert.equal(stopped.state, 'CANCELLED', state);
    assert.equal(stopped.endReason, 'REQUESTED_BY_PRINCIPAL');
  }
  const waiting = job({ state: 'WAITING_FOR_USER', wait: { waitId: 'w', expiresAtMs: 1 } });
  assert.equal(run(waiting, [{ type: 'CANCEL_REQUESTED', request: byPrincipal }]).job.state, 'CANCELLED');

  const kill = { actor: { kind: 'POLICY', policy: 'kill-switch:GLOBAL' }, reason: 'KILL_SWITCH' } as const;
  const { job: stopping } = run(job({ state: 'RUNNING' }), [
    { type: 'CANCEL_REQUESTED', request: byPrincipal },
    { type: 'CANCEL_REQUESTED', request: kill },
  ]);
  assert.equal(stopping.state, 'RUNNING', 'a step may be mid-call');
  assert.deepEqual(stopping.cancelRequest, byPrincipal, 'the first request stands');
  assert.equal(refusal(stopping, { type: 'RESULT_COMMITTED', resultRefs: [REF] }), 'CANCEL_PENDING');
  assert.equal(refusal(stopping, { type: 'USER_INPUT_REQUESTED', wait: { waitId: 'w', expiresAtMs: 1 } }), 'CANCEL_PENDING');
  assert.equal(refusal(job({ state: 'RUNNING' }), { type: 'CANCEL_SETTLED' }), 'NO_CANCEL_REQUESTED');
  const { job: stopped, emitted } = run(stopping, [{ type: 'CANCEL_SETTLED' }]);
  assert.equal(stopped.state, 'CANCELLED');
  assert.equal(stopped.endReason, 'REQUESTED_BY_PRINCIPAL');
  assert.deepEqual(emitted, ['brain.job.cancelled']);
});

test('promotion turns an interactive job durable once, keeps its identity, and is recorded', () => {
  const interactive = job({ state: 'RUNNING', executionClass: 'INTERACTIVE' });
  assert.equal(refusal(interactive, { type: 'PROMOTED' }, { supportsDurable: false, taskMayWait: false }), 'PROMOTION_NOT_SUPPORTED');
  const { job: promoted, emitted } = run(interactive, [{ type: 'PROMOTED' }]);
  assert.equal(promoted.executionClass, 'DURABLE');
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.jobId, interactive.jobId);
  assert.equal(promoted.state, 'RUNNING', 'nothing restarts');
  assert.deepEqual(emitted, ['brain.job.promoted']);
  assert.equal(refusal(promoted, { type: 'PROMOTED' }), 'ALREADY_PROMOTED');
  assert.equal(refusal(job({ state: 'RUNNING' }), { type: 'PROMOTED' }), 'EVENT_NOT_ALLOWED_IN_STATE', 'a durable job has nothing to promote');
  // Once durable, it may ask a person.
  assert.equal(run(promoted, [{ type: 'USER_INPUT_REQUESTED', wait: { waitId: 'w', expiresAtMs: 9 } }]).job.state, 'WAITING_FOR_USER');
});

test('a failure ends the job with a named reason from any live state', () => {
  for (const state of ['ACCEPTED', 'QUEUED', 'RUNNING', 'WAITING_FOR_USER'] as const) {
    const { job: failed, emitted } = run(job({ state, wait: state === 'WAITING_FOR_USER' ? { waitId: 'w', expiresAtMs: 1 } : null }), [
      { type: 'FAILED', reason: 'ACCESS_WITHDRAWN' },
    ]);
    assert.equal(failed.state, 'FAILED', state);
    assert.equal(failed.endReason, 'ACCESS_WITHDRAWN');
    assert.equal(failed.wait, null);
    assert.deepEqual(emitted, ['brain.job.failed']);
  }
});

test('no job state or event describes a browser, a session or a connection', () => {
  const words = [
    ...BRAIN_JOB_STATES,
    ...BRAIN_TRANSITION_EVENT_TYPES,
    ...BRAIN_JOB_EVENT_NAMES,
    ...BRAIN_CANCEL_REASONS,
    ...BRAIN_FAILURE_REASONS,
  ].join(' ');
  assert.doesNotMatch(words, /CLIENT|BROWSER|SESSION|CONNECT|DISCONNECT|ABORT|TAB|PAGE/i);
  const src = readFileSync(join(__dirname, '..', 'src', 'ai', 'brain-job.ts'), 'utf8');
  assert.match(src, /BrainJobIgnoresConnections/, 'the compile-time guard is in place');
  assert.deepEqual(Object.keys(job()).sort(), [
    'cancelRequest', 'capabilityRoute', 'endReason', 'executionClass', 'generation', 'jobId', 'organizationId', 'principalUserId',
    'promoted', 'resultRefs', 'resultType', 'resumesJobId', 'state', 'subject', 'taskId', 'taskVersion', 'wait',
  ]);
});

// --- A reference execution: the submitter leaves, the worker crashes, the job finishes once ---

test('reference execution: accepted work finishes without its submitter, and a crash re-pays nothing', () => {
  // Loop's records. Nothing here can see the submitter once the job is accepted.
  const checkpoints = new Map<string, string>();
  const ledger = new Map<string, 'IN_FLIGHT' | 'RECONCILED' | 'ABANDONED'>();
  let providerCalls = 0;
  let current = job();
  let submitterConnected = true;
  const plan = ['load-context', 'model.primary', 'validate', 'commit'] as const;
  const kinds = { 'load-context': 'LOAD_CONTEXT', 'model.primary': 'MODEL_CALL', validate: 'VALIDATE_OUTPUT', commit: 'COMMIT_RESULT' } as const;
  const attempts = new Map<string, { made: number; paid: number }>();

  const step = (key: (typeof plan)[number], crashAfterPaidCall: boolean): boolean => {
    const policy = BRAIN_DEFAULT_STEP_POLICIES[kinds[key]];
    const cpKey = brainCheckpointKey(current.jobId, key, 'fp');
    const a = attempts.get(key) ?? { made: 0, paid: 0 };
    const inFlight = [...ledger].filter(([k, v]) => v === 'IN_FLIGHT' && k.startsWith(`${current.jobId}:${key}:`)).map(([k]) => k);
    const decision = brainStepResumeDecision(policy, { checkpointed: checkpoints.has(cpKey), attemptsMade: a.made, paidAttemptsMade: a.paid, inFlightCallKeys: inFlight });
    if (decision.action === 'RETURN_CHECKPOINT') return true;
    assert.notEqual(decision.action, 'FAIL');
    if (decision.action === 'ABANDON_AND_RETRY') for (const k of decision.abandonedCallKeys) ledger.set(k, 'ABANDONED');
    const attempt = decision.action === 'FAIL' ? 0 : decision.attempt;
    attempts.set(key, { made: attempt, paid: policy.paid ? a.paid + 1 : a.paid });
    if (policy.paid) {
      const callKey = brainCallKey(current.jobId, key, attempt, 1);
      assert.equal(ledger.has(callKey), false, 'a call key is never reused');
      ledger.set(callKey, 'IN_FLIGHT');
      providerCalls += 1;
      if (crashAfterPaidCall) return false; // the worker dies before the result is recorded
      ledger.set(callKey, 'RECONCILED');
    }
    checkpoints.set(cpKey, `${key}:done`);
    return true;
  };

  // Accepted, handed to an executor -- and the submitter closes the tab.
  current = run(current, [{ type: 'DISPATCHED' }, { type: 'STARTED' }]).job;
  submitterConnected = false;

  // First pass: the worker dies right after paying for the model call.
  assert.equal(step('load-context', false), true);
  assert.equal(step('model.primary', true), false);
  // The executor starts again from the top. Completed steps return their checkpoints.
  for (const key of plan) assert.equal(step(key, false), true, key);
  // And once more, as a duplicate delivery would: nothing runs, nothing is paid.
  const callsBefore = providerCalls;
  for (const key of plan) assert.equal(step(key, false), true);
  assert.equal(providerCalls, callsBefore, 'a finished step never calls a provider again');

  current = run(current, [{ type: 'RESULT_COMMITTED', resultRefs: [REF] }]).job;
  assert.equal(current.state, 'SUCCEEDED');
  assert.equal(submitterConnected, false, 'it finished with nobody watching');
  assert.equal(providerCalls, 2, 'one call lost after payment, one that served -- never more');
  assert.deepEqual([...ledger.values()].sort(), ['ABANDONED', 'RECONCILED'], 'the lost call stays counted as spent');
});

// --- Submission ---------------------------------------------------------------------

test('a request that names its own organization, principal or role is refused, not trusted', () => {
  for (const key of BRAIN_CLIENT_AUTHORITY_KEYS) {
    const parsed = parseBrainSubmission({ ...submission(), [key]: OTHER_ORG });
    assert.equal(parsed.ok, false, key);
    assert.ok(!parsed.ok && parsed.refusals.includes('CLIENT_SUPPLIED_AUTHORITY'), key);
    const hidden = parseBrainSubmission({ ...submission(), input: { [key]: OTHER_ORG } });
    assert.deepEqual(hidden, { ok: false, refusals: ['CLIENT_SUPPLIED_AUTHORITY'] }, `${key} inside input`);
  }
  const ok = parseBrainSubmission(submission());
  assert.ok(ok.ok);
  assert.equal('organizationId' in (ok.ok ? ok.submission : {}), false);
  assert.deepEqual(parseBrainSubmission({ ...submission(), extra: 1 }), { ok: false, refusals: ['UNEXPECTED_FIELD'] });
  assert.deepEqual(parseBrainSubmission({ taskId: 'x' }), { ok: false, refusals: ['MISSING_FIELD'] });
  assert.deepEqual(parseBrainSubmission({ ...submission(), idempotencyKey: 'short' }), { ok: false, refusals: ['INVALID_FIELD'] });
  assert.deepEqual(parseBrainSubmission({ ...submission(), executionClass: 'BATCH' }), { ok: false, refusals: ['INVALID_FIELD'] });
  assert.deepEqual(parseBrainSubmission({ ...submission(), input: { nested: { a: 1 } } }), { ok: false, refusals: ['INVALID_FIELD'] });
  assert.deepEqual(parseBrainSubmission([1]), { ok: false, refusals: ['NOT_AN_OBJECT'] });
});

test('only an active, permitted person may start work, and anyone else learns only that', () => {
  const t = { taskId: 'relationship.review', executionClasses: ['DURABLE'] as const, subjectType: 'RELATIONSHIP' as const };
  assert.deepEqual(brainSubmissionRefusals(t, submission(), submitter()), []);
  assert.deepEqual(brainSubmissionRefusals(t, submission(), submitter({ kind: 'AI_EMPLOYEE' })), ['NOT_PERMITTED']);
  assert.deepEqual(brainSubmissionRefusals(t, submission(), submitter({ kind: 'SERVICE' })), ['NOT_PERMITTED']);
  assert.deepEqual(brainSubmissionRefusals(t, submission(), submitter({ membershipActive: false })), ['NOT_PERMITTED']);
  assert.deepEqual(brainSubmissionRefusals(t, submission(), submitter({ allowed: false })), ['NOT_PERMITTED']);
  assert.deepEqual(brainSubmissionRefusals(null, submission(), submitter({ allowed: false })), ['NOT_PERMITTED'], 'not even whether the task exists');
  assert.deepEqual(brainSubmissionRefusals(null, submission(), submitter()), ['UNKNOWN_TASK']);
  assert.deepEqual(brainSubmissionRefusals(t, submission({ executionClass: 'INTERACTIVE' }), submitter()), ['EXECUTION_CLASS_NOT_SUPPORTED']);
  assert.deepEqual(brainSubmissionRefusals(t, submission({ subject: { type: 'CASE', id: 'c' } }), submitter()), ['SUBJECT_TYPE_MISMATCH']);
});

test('the same request under the same key is the same job; a different one under that key is refused', () => {
  const s = submitter();
  const fp = brainSubmissionFingerprint(s, submission({ input: { a: 1, b: 'x' } }));
  assert.equal(fp, brainSubmissionFingerprint(s, submission({ input: { b: 'x', a: 1 } })), 'key order does not matter');
  for (const variant of [
    brainSubmissionFingerprint(submitter({ organizationId: OTHER_ORG }), submission({ input: { a: 1, b: 'x' } })),
    brainSubmissionFingerprint(submitter({ userId: 'user_2' }), submission({ input: { a: 1, b: 'x' } })),
    brainSubmissionFingerprint(s, submission({ input: { a: 2, b: 'x' } })),
    brainSubmissionFingerprint(s, submission({ input: { a: 1, b: 'x' }, subject: { type: 'RELATIONSHIP', id: 'rel_2' } })),
    brainSubmissionFingerprint(s, submission({ input: { a: 1, b: 'x' }, executionClass: 'INTERACTIVE' })),
  ]) {
    assert.notEqual(variant, fp);
  }
  assert.deepEqual(brainSubmissionDecision(null, fp), { kind: 'ACCEPT_NEW' });
  assert.deepEqual(brainSubmissionDecision({ jobId: 'job_1', fingerprint: fp }, fp), { kind: 'RETURN_EXISTING', jobId: 'job_1' });
  assert.deepEqual(brainSubmissionDecision({ jobId: 'job_1', fingerprint: fp }, `${fp}x`), { kind: 'REFUSE', refusal: 'IDEMPOTENCY_KEY_REUSED' });
});

test('progress is a named step and a count, and a fraction only when the plan is fixed', () => {
  const base = { state: 'RUNNING' as const, currentStep: { key: 'model.primary', kind: 'MODEL_CALL' as const, label: 'Explaining' } };
  assert.equal(brainProgressFraction({ ...base, completedSteps: 2, plannedSteps: null }), null);
  assert.equal(brainProgressFraction({ ...base, completedSteps: 2, plannedSteps: 4 }), 0.5);
  assert.equal(brainProgressFraction({ ...base, completedSteps: 5, plannedSteps: 4 }), null, 'never above the plan');
  assert.equal(brainProgressFraction({ ...base, completedSteps: 0, plannedSteps: 0 }), null);
  assert.equal(brainProgressFraction({ ...base, completedSteps: 1.5, plannedSteps: 4 }), null);
});

// --- Steps ----------------------------------------------------------------------------

test('every default step policy is coherent; a model call is paid and bounded; validation never retries', () => {
  for (const kind of BRAIN_STEP_KINDS) assert.deepEqual(brainStepPolicyViolations(BRAIN_DEFAULT_STEP_POLICIES[kind]), [], kind);
  const model = BRAIN_DEFAULT_STEP_POLICIES.MODEL_CALL;
  assert.equal(model.paid, true);
  assert.equal(model.maxPaidAttempts, 2);
  assert.ok(!model.retryOn.includes('UNAVAILABLE'), 'availability is the routing fallback, not a step retry');
  assert.equal(BRAIN_DEFAULT_STEP_POLICIES.VALIDATE_OUTPUT.maxAttempts, 1);
  for (const kind of BRAIN_STEP_KINDS) {
    if (kind !== 'MODEL_CALL') assert.equal(BRAIN_DEFAULT_STEP_POLICIES[kind].paid, false, kind);
  }
  assert.deepEqual(brainStepPolicyViolations({ ...model, maxPaidAttempts: 0 }), ['PAID_WITHOUT_PAID_LIMIT']);
  assert.deepEqual(brainStepPolicyViolations({ ...BRAIN_DEFAULT_STEP_POLICIES.COMMIT_RESULT, maxPaidAttempts: 1 }), ['UNPAID_WITH_PAID_LIMIT']);
  assert.deepEqual(brainStepPolicyViolations({ ...model, maxAttempts: 0 }), ['NO_ATTEMPTS', 'PAID_LIMIT_ABOVE_ATTEMPTS']);
});

test('retries are bounded by failure class, attempts and paid attempts', () => {
  const load = BRAIN_DEFAULT_STEP_POLICIES.LOAD_CONTEXT;
  assert.deepEqual(brainStepRetryDecision(load, { attemptsMade: 1, paidAttemptsMade: 0, failureClass: 'UNAVAILABLE' }), { action: 'RETRY', nextAttempt: 2 });
  assert.deepEqual(brainStepRetryDecision(load, { attemptsMade: 3, paidAttemptsMade: 0, failureClass: 'UNAVAILABLE' }), {
    action: 'FAIL',
    reason: 'RETRIES_EXHAUSTED',
  });
  assert.deepEqual(brainStepRetryDecision(load, { attemptsMade: 1, paidAttemptsMade: 0, failureClass: 'UNCLASSIFIED' }), {
    action: 'FAIL',
    reason: 'NOT_RETRYABLE',
  });
  const model = BRAIN_DEFAULT_STEP_POLICIES.MODEL_CALL;
  assert.deepEqual(brainStepRetryDecision(model, { attemptsMade: 1, paidAttemptsMade: 2, failureClass: 'RESULT_LOST' }), {
    action: 'FAIL',
    reason: 'PAID_ATTEMPTS_EXHAUSTED',
  });
  assert.deepEqual(brainStepRetryDecision(model, { attemptsMade: 1, paidAttemptsMade: 1, failureClass: 'REFUSED' }), {
    action: 'FAIL',
    reason: 'NOT_RETRYABLE',
  });
});

test('resuming a step consults its checkpoint first, and treats a lost paid call as spent', () => {
  const model = BRAIN_DEFAULT_STEP_POLICIES.MODEL_CALL;
  assert.deepEqual(
    brainStepResumeDecision(model, { checkpointed: true, attemptsMade: 1, paidAttemptsMade: 1, inFlightCallKeys: ['job_1:model:1'] }),
    { action: 'RETURN_CHECKPOINT' },
    'a checkpoint wins even over an unreconciled row',
  );
  assert.deepEqual(brainStepResumeDecision(model, { checkpointed: false, attemptsMade: 0, paidAttemptsMade: 0, inFlightCallKeys: [] }), {
    action: 'EXECUTE',
    attempt: 1,
  });
  assert.deepEqual(
    brainStepResumeDecision(model, { checkpointed: false, attemptsMade: 1, paidAttemptsMade: 1, inFlightCallKeys: ['job_1:model:1'] }),
    { action: 'ABANDON_AND_RETRY', abandonedCallKeys: ['job_1:model:1'], attempt: 2 },
  );
  assert.deepEqual(
    brainStepResumeDecision(model, { checkpointed: false, attemptsMade: 2, paidAttemptsMade: 2, inFlightCallKeys: ['job_1:model:2'] }),
    { action: 'FAIL', reason: 'PROVIDER_RESULT_LOST' },
  );
  assert.deepEqual(
    brainStepResumeDecision(BRAIN_DEFAULT_STEP_POLICIES.VALIDATE_OUTPUT, { checkpointed: false, attemptsMade: 1, paidAttemptsMade: 0, inFlightCallKeys: [] }),
    { action: 'FAIL', reason: 'RETRIES_EXHAUSTED' },
  );
});

test('step and call keys are unambiguous, and a fallback target reuses the gateway convention', () => {
  assert.equal(brainCallKey('job_1', 'model.primary', 1, 1), 'job_1:model.primary:1');
  assert.equal(brainCallKey('job_1', 'model.primary', 1, 2), 'job_1:model.primary:1.2');
  assert.equal(brainCallKey('job_1', 'model.primary', 2, 1), 'job_1:model.primary:2');
  assert.notEqual(brainCallKey('job_1', 'model.primary', 1, 1), brainCallKey('job_2', 'model.primary', 1, 1));
  assert.equal(brainCheckpointKey('job_1', 'load-context', 'fp1'), 'job_1:load-context:fp1');
  assert.notEqual(brainCheckpointKey('job_1', 'load-context', 'fp1'), brainCheckpointKey('job_1', 'load-context', 'fp2'));
  assert.throws(() => brainCallKey('job_1', 'bad:key', 1, 1));
  assert.throws(() => brainCheckpointKey('job_1', 'Bad', 'x'));
  assert.throws(() => brainCallKey('job_1', 'model', 0, 1));
});

test('a fallback is always recorded, and never follows an outcome that forbids one', () => {
  const primary = { providerId: 'provider-a', modelId: 'model-a' };
  const fallback = { providerId: 'provider-b', modelId: 'model-b' };
  const direct = brainModelStepProvenance(primary, [{ callKey: 'k1', target: primary, outcome: 'SERVED', reason: null }]);
  assert.equal(direct.fellBackFrom, null);
  assert.deepEqual(brainFallbackRefusals(direct), []);

  const afterOutage = brainModelStepProvenance(primary, [
    { callKey: 'k1', target: primary, outcome: 'FAILED', reason: 'UNAVAILABLE' },
    { callKey: 'k1.2', target: fallback, outcome: 'SERVED', reason: null },
  ]);
  assert.equal(afterOutage.fellBackFrom, 'provider-a/model-a');
  assert.equal(afterOutage.fallbackReason, 'FAILED:UNAVAILABLE');
  assert.deepEqual(afterOutage.servedBy, fallback);
  assert.deepEqual(brainFallbackRefusals(afterOutage), []);

  const afterKill = brainModelStepProvenance(primary, [
    { callKey: null, target: primary, outcome: 'SKIPPED', reason: 'KILL_SWITCH' },
    { callKey: 'k1', target: fallback, outcome: 'SERVED', reason: null },
  ]);
  assert.equal(afterKill.fellBackFrom, 'provider-a/model-a');
  assert.equal(afterKill.fallbackReason, 'SKIPPED:KILL_SWITCH');

  for (const reason of ['REFUSED', 'CONTENT_FILTERED', 'AUTH', 'INVALID_REQUEST', 'UNCLASSIFIED', 'OUTPUT_INVALID']) {
    const shopped = brainModelStepProvenance(primary, [
      { callKey: 'k1', target: primary, outcome: 'FAILED', reason },
      { callKey: 'k1.2', target: fallback, outcome: 'SERVED', reason: null },
    ]);
    assert.deepEqual(brainFallbackRefusals(shopped), ['FALLBACK_AFTER_NON_FALLBACK_FAILURE'], reason);
  }
  const second = brainModelStepProvenance(primary, [
    { callKey: 'k1', target: primary, outcome: 'SERVED', reason: null },
    { callKey: 'k1.2', target: fallback, outcome: 'SERVED', reason: null },
  ]);
  assert.deepEqual(brainFallbackRefusals(second), ['FALLBACK_AFTER_SERVED'], 'no second opinion');
  assert.deepEqual(brainFallbackRefusals({ ...afterOutage, fellBackFrom: null }), ['FALLBACK_UNRECORDED']);
});

// --- Results --------------------------------------------------------------------------

function envelope(over: Partial<BrainResultEnvelope> = {}): BrainResultEnvelope {
  const claims = [
    { statement: 'Settlements from buyer #1 stopped.', citations: ['evidence:ev_1'] },
    { statement: 'Revenue fell in the same window.', citations: ['headline:hl_1', 'evidence:ev_1'] },
  ];
  return {
    resultType: 'ANALYSIS',
    schemaId: 'relationship-analysis.v1',
    organizationId: ORG,
    subject: { type: 'RELATIONSHIP', id: 'rel_1' },
    owner: { authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP' },
    standing: 'NON_AUTHORITATIVE',
    claims,
    evidenceRefs: brainEvidenceRefsOf(claims),
    limitations: ['Two days reported late.'],
    provenance: {
      jobId: 'job_1',
      taskId: 'relationship.review',
      taskVersion: '1.0.0',
      templateId: 'relationship-review',
      templateVersion: '1',
      capabilityRoute: 'TECHNICAL_ANALYSIS',
      specializationPolicyVersion: 'specialization.2026-09-16.1',
      routingPolicyVersion: 'routing.test.1',
      invocationIds: ['job_1:model.primary:1'],
      servedModels: ['model-a'],
      fellBackFrom: null,
      contextManifestHash: 'abc123',
    },
    payload: {},
    ...over,
  };
}

const EXPECTED = {
  jobId: 'job_1',
  organizationId: ORG,
  resultType: 'ANALYSIS' as const,
  owner: { authority: 'RELATIONSHIPS' as const, subjectType: 'RELATIONSHIP' as const },
  subject: { type: 'RELATIONSHIP' as const, id: 'rel_1' },
};
const SUPPLIED = [
  { ref: 'evidence:ev_1', trust: 'GOVERNED_FACT' as const },
  { ref: 'headline:hl_1', trust: 'GOVERNED_FACT' as const },
  { ref: 'brain-result:ana_0', trust: 'UNTRUSTED_INPUT' as const },
];

test('the ownership table: every result type has an owner, and no recorder or runner owns anything', () => {
  for (const type of BRAIN_RESULT_TYPES) assert.ok(BRAIN_OWNERSHIP_RULES.some((r) => r.resultType === type), type);
  for (const r of BRAIN_OWNERSHIP_RULES) {
    assert.ok(!(BRAIN_NEVER_OWNERS as readonly string[]).includes(r.authority));
    assert.equal(r.standing, ['FINDING', 'RECOMMENDATION', 'PROPOSED_ACTION'].includes(r.resultType) ? 'PROPOSED' : 'NON_AUTHORITATIVE', r.resultType);
  }
  const find = (t: string, a: string) => BRAIN_OWNERSHIP_RULES.find((r) => r.resultType === t && r.authority === a);
  assert.equal(find('ANALYSIS', 'COMMERCIAL_INTELLIGENCE')?.subjectType, 'CASE');
  assert.equal(find('PROPOSED_ACTION', 'DECISION_ENGINE')?.subjectType, 'DECISION');
  assert.equal(find('RECOMMENDATION', 'COMMERCIAL_INTELLIGENCE')?.subjectType, 'CASE');
});

test('a well-formed result may be handed to its owner, and nothing else is', () => {
  assert.deepEqual(brainCommitRefusals(envelope(), EXPECTED, SUPPLIED), []);
});

test('a result cannot cross organizations, jobs, subjects, types or owners', () => {
  assert.deepEqual(brainCommitRefusals(envelope({ organizationId: OTHER_ORG }), EXPECTED, SUPPLIED), ['ORGANIZATION_MISMATCH']);
  assert.deepEqual(
    brainCommitRefusals(envelope({ provenance: { ...envelope().provenance, jobId: 'job_9' } }), EXPECTED, SUPPLIED),
    ['JOB_MISMATCH'],
  );
  assert.deepEqual(brainCommitRefusals(envelope({ subject: { type: 'RELATIONSHIP', id: 'rel_2' } }), EXPECTED, SUPPLIED), ['SUBJECT_MISMATCH']);
  assert.deepEqual(brainCommitRefusals(envelope({ resultType: 'FINDING' }), EXPECTED, SUPPLIED), [
    'RESULT_TYPE_MISMATCH',
    'OWNER_NOT_PERMITTED',
    'STANDING_NOT_PERMITTED',
  ]);
});

test('Activity and the job never own a result, and a result is never more than proposed', () => {
  const activityOwned = envelope({ owner: { authority: 'ACTIVITY' as never, subjectType: 'RELATIONSHIP' } });
  assert.deepEqual(brainCommitRefusals(activityOwned, { ...EXPECTED, owner: activityOwned.owner }, SUPPLIED), [
    'OWNER_NOT_PERMITTED',
    'STANDING_NOT_PERMITTED',
  ]);
  const jobOwned = envelope({ owner: { authority: 'BRAIN_EXECUTION' as never, subjectType: 'RELATIONSHIP' } });
  assert.ok(brainCommitRefusals(jobOwned, { ...EXPECTED, owner: jobOwned.owner }, SUPPLIED).includes('OWNER_NOT_PERMITTED'));
  for (const standing of ['ESTABLISHED', 'ACCEPTED', 'EXECUTED', 'PROPOSED']) {
    assert.deepEqual(brainCommitRefusals(envelope({ standing: standing as never }), EXPECTED, SUPPLIED), ['STANDING_NOT_PERMITTED'], standing);
  }
  const wrongSubject = envelope({ owner: { authority: 'COMMERCIAL_INTELLIGENCE', subjectType: 'RELATIONSHIP' } });
  assert.ok(
    brainCommitRefusals(wrongSubject, { ...EXPECTED, owner: wrongSubject.owner }, SUPPLIED).includes('OWNER_NOT_PERMITTED'),
    'an owner holds results only about its own kind of subject',
  );
});

test('evidence references survive: uncited, unsupplied, dropped or missing evidence is refused', () => {
  const uncited = [{ statement: 'Something.', citations: [] }];
  assert.deepEqual(brainCommitRefusals(envelope({ claims: uncited, evidenceRefs: [] }), EXPECTED, SUPPLIED), ['UNCITED_CLAIM', 'EVIDENCE_MISSING']);
  const invented = [{ statement: 'Something.', citations: ['evidence:ev_404'] }];
  assert.deepEqual(brainCommitRefusals(envelope({ claims: invented, evidenceRefs: ['evidence:ev_404'] }), EXPECTED, SUPPLIED), [
    'CITATION_NOT_SUPPLIED',
  ]);
  assert.deepEqual(brainCommitRefusals(envelope({ evidenceRefs: ['evidence:ev_1'] }), EXPECTED, SUPPLIED), ['EVIDENCE_REFS_INCONSISTENT'], 'a dropped reference');
  assert.deepEqual(
    brainCommitRefusals(envelope({ evidenceRefs: [...envelope().evidenceRefs, 'evidence:extra'] }), EXPECTED, SUPPLIED),
    ['EVIDENCE_REFS_INCONSISTENT'],
    'an added reference',
  );
  const answer = envelope({ resultType: 'ANSWER', owner: { authority: 'BRAIN_CONVERSATIONS', subjectType: 'CONVERSATION' }, subject: { type: 'CONVERSATION', id: 'conv_1' }, claims: [], evidenceRefs: [] });
  assert.deepEqual(
    brainCommitRefusals(answer, { ...EXPECTED, resultType: 'ANSWER', owner: answer.owner, subject: answer.subject }, SUPPLIED),
    [],
    'an answer with nothing to assert needs no citation',
  );
});

test("a model's own earlier output is never cited as a governed fact", () => {
  const leaning = [{ statement: 'As previously concluded.', citations: ['brain-result:ana_0'] }];
  assert.deepEqual(brainCommitRefusals(envelope({ claims: leaning, evidenceRefs: ['brain-result:ana_0'] }), EXPECTED, SUPPLIED), []);
  const laundered = [...SUPPLIED.slice(0, 2), { ref: 'brain-result:ana_0', trust: 'GOVERNED_FACT' as const }];
  assert.deepEqual(
    brainCommitRefusals(envelope({ claims: leaning, evidenceRefs: ['brain-result:ana_0'] }), EXPECTED, laundered),
    ['MODEL_OUTPUT_CITED_AS_FACT'],
  );
});

test('a result without full provenance is refused', () => {
  const p = envelope().provenance;
  for (const broken of [
    { ...p, invocationIds: [] },
    { ...p, routingPolicyVersion: '' },
    { ...p, specializationPolicyVersion: ' ' },
    { ...p, templateVersion: '' },
    { ...p, capabilityRoute: '' },
    { ...p, contextManifestHash: '' },
  ]) {
    assert.deepEqual(brainCommitRefusals(envelope({ provenance: broken }), EXPECTED, SUPPLIED), ['PROVENANCE_INCOMPLETE']);
  }
});

test('an event points at results and carries no content and no ownership', () => {
  const event = {
    name: 'brain.job.succeeded',
    organizationId: ORG,
    jobId: 'job_1',
    taskId: 'relationship.review',
    resultType: 'ANALYSIS',
    occurredAt: '2026-09-16T20:00:00.000Z',
    actor: { kind: 'SYSTEM' },
    resultRefs: [REF],
    reason: null,
  };
  assert.deepEqual(brainJobEventRefusals(event), []);
  assert.deepEqual(brainJobEventRefusals({ ...event, summary: 'Revenue fell.' }), ['EVENT_CARRIES_CONTENT']);
  assert.deepEqual(brainJobEventRefusals({ ...event, resultRefs: [{ ...REF, claims: ['x'] }] }), ['EVENT_CARRIES_CONTENT']);
  assert.deepEqual(
    brainJobEventRefusals({ ...event, resultRefs: [{ ...REF, owner: { authority: 'ACTIVITY', subjectType: 'RELATIONSHIP' } }] }),
    ['EVENT_CLAIMS_OWNERSHIP'],
  );
  assert.deepEqual(brainJobEventRefusals({ ...event, name: 'brain.job.failed' }), ['REFS_ON_UNSUCCESSFUL_EVENT']);
  assert.deepEqual(brainJobEventRefusals({ ...event, name: 'brain.job.exploded', resultRefs: [] }), ['UNKNOWN_EVENT']);
});

// --- Trust ----------------------------------------------------------------------------

const NOW = 1_800_000_000;
const claims = (over: Partial<BrainDoorbellClaims> = {}): BrainDoorbellClaims => ({
  iss: 'https://loop.example/brain',
  aud: 'loop-brain-doorbell',
  sub: 'deployment-production',
  scope: 'brain.dispatch',
  jti: 'ring-1',
  iat: NOW - 5,
  exp: NOW + 55,
  ...over,
});
const OPTS = { nowSeconds: NOW, trustedIssuers: ['https://loop.example/brain'], trustedCallers: ['deployment-production'] };

test('a doorbell ring yields only who rang and which stored command to read', () => {
  const ok = brainDoorbellCheck(claims(), { commandId: 'cmd_000001' }, OPTS);
  assert.deepEqual(ok, { ok: true, caller: { kind: 'DEPLOYMENT', subject: 'deployment-production', tokenId: 'ring-1' }, commandId: 'cmd_000001' });
});

test('a ring that tries to carry authority, or whose token is wrong, is refused', () => {
  const refused = (c: BrainDoorbellClaims, body: unknown) => {
    const r = brainDoorbellCheck(c, body, OPTS);
    return r.ok ? [] : [...r.refusals];
  };
  const body = { commandId: 'cmd_000001' };
  for (const key of ['organizationId', 'principalUserId', 'jobId', 'role']) {
    assert.deepEqual(refused(claims(), { ...body, [key]: 'x' }), ['CLIENT_SUPPLIED_AUTHORITY'], key);
  }
  assert.deepEqual(refused(claims(), { ...body, note: 'x' }), ['UNEXPECTED_FIELD']);
  assert.deepEqual(refused(claims(), { commandId: 'bad id' }), ['MALFORMED_BODY']);
  assert.deepEqual(refused(claims(), 'cmd_000001'), ['MALFORMED_BODY']);
  assert.deepEqual(refused(claims({ aud: 'another-audience' }), body), ['WRONG_AUDIENCE']);
  assert.deepEqual(refused(claims({ aud: ['x', 'loop-brain-doorbell'] }), body), []);
  assert.deepEqual(refused(claims({ aud: undefined as never }), body), ['WRONG_AUDIENCE'], 'a token without an audience is refused, not a crash');
  assert.deepEqual(refused(claims({ scope: 'brain.read' }), body), ['WRONG_SCOPE']);
  assert.deepEqual(refused(claims({ iss: 'https://evil.example' }), body), ['ISSUER_NOT_TRUSTED']);
  assert.deepEqual(refused(claims({ sub: 'someone-else' }), body), ['CALLER_NOT_TRUSTED']);
  assert.deepEqual(refused(claims({ jti: '' }), body), ['MISSING_TOKEN_ID']);
  assert.deepEqual(refused(claims({ exp: NOW - 31, iat: NOW - 90 }), body), ['EXPIRED']);
  assert.deepEqual(refused(claims({ iat: NOW + 60, exp: NOW + 120 }), body), ['NOT_YET_VALID']);
  assert.deepEqual(refused(claims({ iat: NOW - 5, exp: NOW + 3600 }), body), ['LIFETIME_TOO_LONG']);
});

function command(over: Partial<BrainCommand> = {}): BrainCommand {
  return {
    commandId: 'cmd_000001',
    type: 'START',
    organizationId: ORG,
    jobId: 'job_1',
    generation: 1,
    waitId: null,
    issuedBy: { kind: 'HUMAN', userId: PRINCIPAL },
    issuedAtMs: 1,
    ...over,
  };
}

test('a stored command is acted on only when it and the job agree, and a repeat is harmless', () => {
  const none = { replyRecorded: false };
  assert.deepEqual(brainCommandDisposition(null, job(), none), { action: 'REFUSE', refusals: ['COMMAND_NOT_FOUND'] });
  assert.deepEqual(brainCommandDisposition(command(), null, none), { action: 'REFUSE', refusals: ['JOB_NOT_FOUND'] });
  assert.deepEqual(brainCommandDisposition(command({ organizationId: OTHER_ORG }), job(), none), { action: 'REFUSE', refusals: ['ORGANIZATION_MISMATCH'] });
  assert.deepEqual(brainCommandDisposition(command({ generation: 2 }), job(), none), { action: 'REFUSE', refusals: ['GENERATION_MISMATCH'] });
  assert.deepEqual(brainCommandDisposition(command({ issuedBy: { kind: 'HUMAN', userId: 'user_2' } }), job(), none), {
    action: 'REFUSE',
    refusals: ['ISSUER_NOT_PERMITTED'],
  });
  assert.deepEqual(brainCommandDisposition(command({ issuedBy: { kind: 'SYSTEM' } }), job(), none), { action: 'REFUSE', refusals: ['ISSUER_NOT_PERMITTED'] });
  assert.deepEqual(brainCommandDisposition(command(), job(), none), { action: 'EXECUTE' });
  assert.deepEqual(brainCommandDisposition(command(), job({ state: 'QUEUED' }), none), { action: 'ALREADY_DONE' });
  assert.deepEqual(brainCommandDisposition(command(), job({ state: 'CANCELLED' }), none), { action: 'ALREADY_DONE' });

  const cancel = command({ type: 'CANCEL', issuedBy: { kind: 'POLICY', policy: 'kill-switch:GLOBAL' } });
  assert.deepEqual(brainCommandDisposition(cancel, job({ state: 'RUNNING' }), none), { action: 'EXECUTE' });
  assert.deepEqual(brainCommandDisposition(command({ type: 'CANCEL', issuedBy: { kind: 'SYSTEM' } }), job({ state: 'RUNNING' }), none), {
    action: 'REFUSE',
    refusals: ['ISSUER_NOT_PERMITTED'],
  });

  const waiting = job({ state: 'WAITING_FOR_USER', wait: { waitId: 'wait_1', expiresAtMs: 9 } });
  const resume = command({ type: 'RESUME', waitId: 'wait_1' });
  assert.deepEqual(brainCommandDisposition(resume, waiting, none), { action: 'REFUSE', refusals: ['REPLY_NOT_RECORDED'] });
  assert.deepEqual(brainCommandDisposition(resume, waiting, { replyRecorded: true }), { action: 'EXECUTE' });
  assert.deepEqual(brainCommandDisposition(command({ type: 'RESUME', waitId: 'wait_0' }), waiting, { replyRecorded: true }), {
    action: 'REFUSE',
    refusals: ['WAIT_MISMATCH'],
  });
  assert.deepEqual(brainCommandDisposition(resume, job({ state: 'RUNNING' }), { replyRecorded: true }), { action: 'ALREADY_DONE' });
  assert.deepEqual(brainCommandDisposition(resume, job({ state: 'QUEUED' }), { replyRecorded: true }), {
    action: 'REFUSE',
    refusals: ['STATE_DOES_NOT_ACCEPT_COMMAND'],
  });
  assert.deepEqual(brainCommandDisposition(command({ type: 'RESUME', waitId: 'wait_1', issuedBy: { kind: 'HUMAN', userId: 'user_2' } }), waiting, { replyRecorded: true }), {
    action: 'REFUSE',
    refusals: ['ISSUER_NOT_PERMITTED'],
  });
});

const decision = (over: Partial<BrainAccessDecision> = {}): BrainAccessDecision => ({
  allowed: true,
  organizationId: ORG,
  principalUserId: PRINCIPAL,
  taskId: 'relationship.review',
  decidedAtMs: 1_000,
  ...over,
});
const principal = (over: Record<string, unknown> = {}) => ({ userId: PRINCIPAL, organizationId: ORG, kind: 'HUMAN' as const, membershipActive: true, ...over });

test('every consequential boundary re-decides access against the job, freshly', () => {
  const j = job();
  const at = { nowMs: 1_500 };
  assert.deepEqual(brainBoundaryRefusals(j, principal(), decision(), at), []);
  assert.deepEqual(brainBoundaryRefusals(j, principal(), decision({ organizationId: OTHER_ORG }), at), ['DECISION_FOR_ANOTHER_ORGANIZATION']);
  assert.deepEqual(brainBoundaryRefusals(j, principal(), decision({ principalUserId: 'user_2' }), at), ['DECISION_FOR_ANOTHER_PRINCIPAL']);
  assert.deepEqual(brainBoundaryRefusals(j, principal(), decision({ taskId: 'other.task' }), at), ['DECISION_FOR_ANOTHER_TASK']);
  assert.deepEqual(brainBoundaryRefusals(j, principal(), decision({ allowed: false }), at), ['NOT_PERMITTED']);
  assert.deepEqual(brainBoundaryRefusals(j, principal(), null, at), ['NOT_PERMITTED']);
  assert.deepEqual(brainBoundaryRefusals(j, principal(), decision({ decidedAtMs: 1_000 }), { nowMs: 31_001 }), ['DECISION_STALE']);
  assert.deepEqual(brainBoundaryRefusals(j, principal(), decision({ decidedAtMs: 1_000 }), { nowMs: 31_000 }), [], 'exactly at the limit is still fresh');
  assert.deepEqual(brainBoundaryRefusals(j, principal(), decision({ decidedAtMs: 2_000 }), at), ['DECISION_STALE'], 'not from the future');
  assert.deepEqual(brainBoundaryRefusals(j, principal({ kind: 'AI_EMPLOYEE' }), decision(), at), ['PRINCIPAL_NOT_HUMAN']);
  assert.deepEqual(brainBoundaryRefusals(j, principal({ membershipActive: false }), decision(), at), ['PRINCIPAL_NOT_ACTIVE']);
  assert.deepEqual(brainBoundaryRefusals(j, principal({ organizationId: OTHER_ORG }), decision(), at), ['PRINCIPAL_IN_ANOTHER_ORGANIZATION']);
  assert.deepEqual(brainBoundaryRefusals(j, principal({ userId: 'user_2' }), decision(), at), ['PRINCIPAL_NOT_FOUND']);
});

// --- Executor ----------------------------------------------------------------------------

test('the executor contract names what must hold, and hands over nothing but a reference', () => {
  const ids = BRAIN_EXECUTOR_OBLIGATIONS.map((o) => o.id);
  for (const id of ['DETACHED', 'IDEMPOTENT_START', 'REFERENCES_ONLY', 'CHECKPOINT_FIRST', 'PAID_AT_MOST_ONCE_PER_ATTEMPT', 'BOUNDED_RETRY', 'RECHECK_AT_BOUNDARIES', 'WAIT_WITHOUT_RUNNING', 'CANCEL_AT_BOUNDARY', 'LOOP_IS_AUTHORITY', 'NO_CONTENT_OUTSIDE_LOOP', 'RESULTS_THROUGH_OWNERS']) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(Object.isFrozen(BRAIN_EXECUTOR_OBLIGATIONS));
  const src = readFileSync(join(__dirname, '..', 'src', 'ai', 'brain-executor.ts'), 'utf8');
  assert.match(src, /BrainJobRefIsReferenceOnly/, 'the compile-time guard is in place');
});

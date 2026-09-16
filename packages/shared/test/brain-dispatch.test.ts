// Handing Brain work to an executor, and advancing it safely (B3).
//
// WHAT THESE PROVE
//
// A DUPLICATE DELIVERY MOVES NOTHING TWICE. Commits and events have durable
// identities, advance messages carry only a reference, and one lease lets one worker
// advance a job; an expired lease is taken over, never shared.
//
// THE WORKER CANNOT CHOOSE WHOSE DATA IT GETS. Its token names a job, a purpose and a
// body hash. Loop answers from the job it loads, for the organization and person that
// job records, and only in states where that purpose makes sense.
//
// NOBODY PAYS FOR A STEP THAT CANNOT FINISH. An interactive job that would overrun is
// promoted before the step when it can be, and ends by name when it cannot.
//
// A ROUTE THAT STOPPED CONFORMING STOPS SERVING, at run time as well as in tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRAIN_ADVANCE_REASONS,
  BRAIN_FAILURE_REASONS,
  BRAIN_WORKER_AUDIENCE,
  BRAIN_WORKER_PURPOSE_STATES,
  brainEventId,
  brainLeaseDecision,
  brainLeaseDurationMs,
  brainResultCommitKey,
  brainRouteGate,
  brainStepStartDecision,
  brainWorkerRequestCheck,
  parseBrainAdvanceMessage,
  type AiProviderSpecializationPolicy,
  type AiRoutingPolicy,
  type BrainExecutionContract,
  type BrainWorkerClaims,
} from '../src';

test('commit and event identities are deterministic, distinct and validated', () => {
  assert.equal(brainResultCommitKey('job_1', 'commit.analysis'), 'job_1:commit.analysis:commit');
  assert.notEqual(brainResultCommitKey('job_1', 'commit.analysis'), brainResultCommitKey('job_2', 'commit.analysis'));
  assert.equal(brainEventId('job_1', 3), 'job_1#3');
  assert.notEqual(brainEventId('job_1', 3), brainEventId('job_1', 4));
  assert.throws(() => brainResultCommitKey('job_1', 'Bad:Key'));
  assert.throws(() => brainEventId('job_1', 0));
  assert.throws(() => brainEventId('job_1', 1.5));
});

test('an advance message is a reference and a reason, and nothing else gets through', () => {
  const ok = parseBrainAdvanceMessage({ jobId: 'job_00001', generation: 1, reason: 'START', commandId: 'cmd_00001' });
  assert.deepEqual(ok, { ok: true, message: { jobId: 'job_00001', generation: 1, reason: 'START', commandId: 'cmd_00001' } });
  assert.deepEqual(parseBrainAdvanceMessage({ jobId: 'job_00001', generation: 1, reason: 'CONTINUE', commandId: null }).ok, true);
  for (const key of ['organizationId', 'principalUserId', 'input', 'prompt']) {
    assert.deepEqual(
      parseBrainAdvanceMessage({ jobId: 'job_00001', generation: 1, reason: 'CONTINUE', commandId: null, [key]: 'x' }),
      { ok: false, refusals: ['UNEXPECTED_FIELD'] },
      key,
    );
  }
  for (const reason of ['START', 'RESUME', 'CANCEL']) {
    assert.deepEqual(
      parseBrainAdvanceMessage({ jobId: 'job_00001', generation: 1, reason, commandId: null }),
      { ok: false, refusals: ['COMMAND_REQUIRED'] },
      `${reason} names the command that caused it`,
    );
  }
  assert.deepEqual(parseBrainAdvanceMessage({ jobId: 'job_00001', generation: 0, reason: 'TIMER', commandId: null }), { ok: false, refusals: ['INVALID_FIELD'] });
  assert.deepEqual(parseBrainAdvanceMessage({ jobId: 'x', generation: 1, reason: 'TIMER', commandId: null }), { ok: false, refusals: ['INVALID_FIELD'] });
  assert.deepEqual(parseBrainAdvanceMessage({ jobId: 'job_00001', generation: 1, reason: 'CLIENT_GONE', commandId: null }), { ok: false, refusals: ['INVALID_FIELD'] });
  assert.deepEqual(parseBrainAdvanceMessage('job_00001'), { ok: false, refusals: ['NOT_AN_OBJECT'] });
  assert.doesNotMatch(BRAIN_ADVANCE_REASONS.join(' '), /CLIENT|SESSION|BROWSER|CONNECT/);
});

test('one worker advances a job; a duplicate backs off; a dead holder is taken over', () => {
  assert.deepEqual(brainLeaseDecision(null, 'w1', 1_000), { action: 'ACQUIRE' });
  assert.deepEqual(brainLeaseDecision({ holder: 'w1', expiresAtMs: 5_000 }, 'w1', 1_000), { action: 'RENEW' });
  assert.deepEqual(brainLeaseDecision({ holder: 'w1', expiresAtMs: 5_000 }, 'w2', 1_000), { action: 'BUSY', holder: 'w1', retryAfterMs: 4_000 });
  assert.deepEqual(brainLeaseDecision({ holder: 'w1', expiresAtMs: 5_000 }, 'w2', 5_000), { action: 'TAKE_OVER', previousHolder: 'w1' });
  assert.deepEqual(brainLeaseDecision({ holder: 'w1', expiresAtMs: 5_000 }, 'w2', 9_000), { action: 'TAKE_OVER', previousHolder: 'w1' });
  assert.equal(brainLeaseDurationMs(25_000, 60_000), 85_000, 'a lease outlives the step it covers');
  assert.throws(() => brainLeaseDurationMs(0, 1));
  assert.throws(() => brainLeaseDurationMs(1, 0));
});

const CONTRACT: BrainExecutionContract = {
  classes: ['INTERACTIVE', 'DURABLE'],
  interactive: { presentationBudgetMs: 10_000, executionDeadlineMs: 30_000, streaming: 'NONE' },
  durable: { executionDeadlineMs: 100_000, maxUserWaitMs: null },
};
const INTERACTIVE_ONLY: BrainExecutionContract = { classes: ['INTERACTIVE'], interactive: CONTRACT.interactive, durable: null };

test('a step that could outlast its job is not started: promote first, or end by name', () => {
  assert.deepEqual(brainStepStartDecision({ contract: CONTRACT, executionClass: 'INTERACTIVE', elapsedMs: 1_000, stepMaxDurationMs: 25_000 }), { action: 'START' });
  assert.deepEqual(brainStepStartDecision({ contract: CONTRACT, executionClass: 'INTERACTIVE', elapsedMs: 10_000, stepMaxDurationMs: 25_000 }), { action: 'PROMOTE' });
  assert.deepEqual(brainStepStartDecision({ contract: INTERACTIVE_ONLY, executionClass: 'INTERACTIVE', elapsedMs: 10_000, stepMaxDurationMs: 25_000 }), {
    action: 'FAIL',
    reason: 'DEADLINE_EXCEEDED',
  });
  assert.deepEqual(brainStepStartDecision({ contract: CONTRACT, executionClass: 'INTERACTIVE', elapsedMs: 30_000, stepMaxDurationMs: 1 }), { action: 'PROMOTE' });
  assert.deepEqual(brainStepStartDecision({ contract: CONTRACT, executionClass: 'DURABLE', elapsedMs: 80_000, stepMaxDurationMs: 25_000 }), {
    action: 'FAIL',
    reason: 'DEADLINE_EXCEEDED',
  });
  assert.deepEqual(brainStepStartDecision({ contract: CONTRACT, executionClass: 'DURABLE', elapsedMs: 70_000, stepMaxDurationMs: 25_000 }), { action: 'START' });
});

const primary = { providerId: 'anthropic', modelId: 'model-a', reasoningEffort: 'medium', timeoutMs: 25_000, maxOutputTokens: 6_000, pricing: null } as const;
const ROUTING: AiRoutingPolicy = {
  version: 'routing.test',
  tasks: { 'case.explanation': { taskId: 'case.explanation', taskVersion: '2.0.0', primary, fallback: null, fallbackPermitted: false, budgetClass: 'x' } },
};
const SPECIALIZATION: AiProviderSpecializationPolicy = {
  version: 'specialization.test',
  routes: {
    COMMUNICATION: { preferredProviderId: 'openai', rationale: 'r' },
    TECHNICAL_ANALYSIS: { preferredProviderId: 'anthropic', rationale: 'r' },
    GENERAL_REASONING: { preferredProviderId: null, rationale: 'r' },
  },
};

test('the run-time routing gate refuses a route that no longer conforms, with a named failure reason', () => {
  const task = { taskId: 'case.explanation', version: '2.0.0', capabilityRoute: 'TECHNICAL_ANALYSIS' };
  assert.deepEqual(brainRouteGate(task, ROUTING, SPECIALIZATION), { ok: true });
  assert.deepEqual(brainRouteGate({ ...task, capabilityRoute: 'COMMUNICATION' }, ROUTING, SPECIALIZATION), {
    ok: false,
    reason: 'ROUTING_NOT_CONFORMANT',
    findings: ['PREFERENCE_DEPARTED_WITHOUT_REASON'],
  });
  assert.deepEqual(brainRouteGate({ ...task, version: '3.0.0' }, ROUTING, SPECIALIZATION), {
    ok: false,
    reason: 'ROUTING_NOT_CONFORMANT',
    findings: ['ROUTE_TASK_VERSION_MISMATCH'],
  });
  assert.deepEqual(brainRouteGate({ ...task, taskId: 'missing.task' }, ROUTING, SPECIALIZATION), {
    ok: false,
    reason: 'ROUTING_NOT_CONFORMANT',
    findings: ['NO_ROUTE_FOR_TASK'],
  });
  assert.ok((BRAIN_FAILURE_REASONS as readonly string[]).includes('ROUTING_NOT_CONFORMANT'));
});

const NOW = 1_900_000_000;
const HASH = 'a'.repeat(64);
const claims = (over: Partial<BrainWorkerClaims> = {}): BrainWorkerClaims => ({
  iss: 'loop-brain-worker-staging',
  aud: BRAIN_WORKER_AUDIENCE,
  sub: 'brain-worker',
  jti: 'req-1',
  iat: NOW - 5,
  exp: NOW + 55,
  jobId: 'job_1',
  generation: 1,
  purpose: 'CONTEXT',
  bodySha256: HASH,
  ...over,
});
const JOB = { jobId: 'job_1', generation: 1, state: 'RUNNING' as const, organizationId: 'org_a', principalUserId: 'user_1' };
const OPTS = { nowSeconds: NOW, trustedIssuers: ['loop-brain-worker-staging'], trustedWorkers: ['brain-worker'] };
const refused = (c: BrainWorkerClaims, purpose: 'CONTEXT' | 'COMMIT_RESULT' | 'ACCESS_DECISION', body: string, job: typeof JOB | null) => {
  const r = brainWorkerRequestCheck(c, { purpose, bodySha256: body }, job, OPTS);
  return r.ok ? [] : [...r.refusals];
};

test("a worker request is answered for the job Loop loads -- that job's organization and person, nobody else's", () => {
  const ok = brainWorkerRequestCheck(claims(), { purpose: 'CONTEXT', bodySha256: HASH.toUpperCase() }, JOB, OPTS);
  assert.deepEqual(ok, { ok: true, jobId: 'job_1', organizationId: 'org_a', principalUserId: 'user_1', worker: 'brain-worker', tokenId: 'req-1' });
  // A token cannot carry an organization; even if one is smuggled in, the answer comes from the job.
  const smuggled = { ...claims(), organizationId: 'org_b' } as unknown as BrainWorkerClaims;
  const r = brainWorkerRequestCheck(smuggled, { purpose: 'CONTEXT', bodySha256: HASH }, JOB, OPTS);
  assert.ok(r.ok && r.organizationId === 'org_a');
});

test('a worker request is refused for the wrong key, audience, time, purpose, body, job, generation or state', () => {
  assert.deepEqual(refused(claims({ iss: 'someone' }), 'CONTEXT', HASH, JOB), ['ISSUER_NOT_TRUSTED']);
  assert.deepEqual(refused(claims({ sub: 'other-worker' }), 'CONTEXT', HASH, JOB), ['CALLER_NOT_TRUSTED']);
  assert.deepEqual(refused(claims({ aud: 'loop-brain-doorbell' }), 'CONTEXT', HASH, JOB), ['WRONG_AUDIENCE'], 'a doorbell token is not a worker token');
  assert.deepEqual(refused(claims({ aud: undefined as never }), 'CONTEXT', HASH, JOB), ['WRONG_AUDIENCE']);
  assert.deepEqual(refused(claims({ jti: '' }), 'CONTEXT', HASH, JOB), ['MISSING_TOKEN_ID']);
  assert.deepEqual(refused(claims({ exp: NOW - 31, iat: NOW - 60 }), 'CONTEXT', HASH, JOB), ['EXPIRED']);
  assert.deepEqual(refused(claims({ iat: NOW + 60, exp: NOW + 100 }), 'CONTEXT', HASH, JOB), ['NOT_YET_VALID']);
  assert.deepEqual(refused(claims({ exp: NOW + 600 }), 'CONTEXT', HASH, JOB), ['LIFETIME_TOO_LONG']);
  assert.deepEqual(refused(claims(), 'COMMIT_RESULT', HASH, JOB), ['PURPOSE_MISMATCH'], 'a context token cannot commit');
  assert.deepEqual(refused(claims(), 'CONTEXT', 'b'.repeat(64), JOB), ['BODY_MISMATCH'], 'a token for one body cannot carry another');
  assert.deepEqual(refused(claims({ jobId: 'job_2' }), 'CONTEXT', HASH, JOB), ['JOB_NOT_FOUND']);
  assert.deepEqual(refused(claims(), 'CONTEXT', HASH, null), ['JOB_NOT_FOUND']);
  assert.deepEqual(refused(claims({ generation: 2 }), 'CONTEXT', HASH, JOB), ['GENERATION_MISMATCH']);
  for (const state of ['ACCEPTED', 'QUEUED', 'WAITING_FOR_USER', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
    assert.deepEqual(refused(claims(), 'CONTEXT', HASH, { ...JOB, state }), ['JOB_STATE_REFUSES_PURPOSE'], `no context in ${state}`);
  }
  assert.deepEqual(refused(claims({ purpose: 'ACCESS_DECISION' }), 'ACCESS_DECISION', HASH, { ...JOB, state: 'WAITING_FOR_USER' }), [], 'access is re-decided before applying a reply');
  assert.deepEqual(refused(claims({ purpose: 'ACCESS_DECISION' }), 'ACCESS_DECISION', HASH, { ...JOB, state: 'CANCELLED' }), ['JOB_STATE_REFUSES_PURPOSE']);
  assert.deepEqual([...BRAIN_WORKER_PURPOSE_STATES.COMMIT_RESULT], ['RUNNING']);
});

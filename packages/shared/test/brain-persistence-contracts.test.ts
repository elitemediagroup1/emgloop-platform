// The pure contracts B4's persistence relies on (B4).
//
// WHAT THESE PROVE
//
// A WAIT IS ANSWERED ONCE, BY ITS PRINCIPAL. The same reply twice is the same reply; a
// different one, a late one, or one from anybody else is refused by name -- and a
// stranger learns nothing about the wait's state.
//
// A COMMAND IS STORED ONCE. One START and one CANCEL per job generation, one RESUME per
// wait, whatever retries or double clicks happen.
//
// A STORED CONTROL IS RECORDED AUTHORITY, NOT CONFIGURATION. Its target is coherent,
// its history is versioned and append-only, a stale writer cannot override a newer
// decision, and an organization only ever sees platform controls and its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_CONTROL_SCOPES,
  AI_CONTROL_STATES,
  AI_KILL_SWITCH_SCOPES,
  BRAIN_WAIT_STATUSES,
  aiControlAppendDecision,
  aiControlKey,
  aiControlRefusals,
  aiControlsApplyingTo,
  brainCommandDedupeKey,
  brainWaitExpiryDue,
  brainWaitReplyDecision,
  type AiControlEntry,
  type BrainWaitRecord,
} from '../src';

const JOB = {
  jobId: 'job_00000001',
  organizationId: 'org_a',
  principalUserId: 'user_1',
  state: 'WAITING_FOR_USER' as const,
  wait: { waitId: 'wait_0000001', expiresAtMs: 2_000 },
};
const WAIT: BrainWaitRecord = {
  waitId: 'wait_0000001',
  jobId: 'job_00000001',
  organizationId: 'org_a',
  principalUserId: 'user_1',
  status: 'OPEN',
  expiresAtMs: 2_000,
  replyFingerprint: null,
};
const REPLY = { waitId: 'wait_0000001', responderUserId: 'user_1', replyFingerprint: 'fp-a' };

test('a wait is answered once, only by its principal, before it expires', () => {
  assert.deepEqual([...BRAIN_WAIT_STATUSES], ['OPEN', 'ANSWERED', 'EXPIRED', 'CLOSED']);
  assert.deepEqual(brainWaitReplyDecision(JOB, WAIT, REPLY, 1_000), { action: 'RECORD' });

  const answered = { ...WAIT, status: 'ANSWERED' as const, replyFingerprint: 'fp-a' };
  assert.deepEqual(brainWaitReplyDecision(JOB, answered, REPLY, 1_000), { action: 'RETURN_RECORDED' }, 'the same reply again');
  assert.deepEqual(brainWaitReplyDecision(JOB, answered, { ...REPLY, replyFingerprint: 'fp-b' }, 1_000), {
    action: 'REFUSE',
    refusal: 'WAIT_ALREADY_ANSWERED',
  });
  // Even a repeat is refused once the answered wait is no longer this principal's.
  assert.deepEqual(brainWaitReplyDecision(JOB, answered, { ...REPLY, responderUserId: 'user_2' }, 1_000), {
    action: 'REFUSE',
    refusal: 'RESPONDER_IS_NOT_PRINCIPAL',
  });

  const refusal = (job: typeof JOB | null, wait: BrainWaitRecord | null, reply = REPLY, now = 1_000) => {
    const d = brainWaitReplyDecision(job, wait, reply, now);
    return d.action === 'REFUSE' ? d.refusal : d.action;
  };
  assert.equal(refusal(JOB, null), 'WAIT_NOT_FOUND');
  assert.equal(refusal(null, WAIT), 'WAIT_NOT_FOUND');
  assert.equal(refusal(JOB, WAIT, { ...REPLY, waitId: 'wait_0000002' }), 'WAIT_NOT_FOUND');
  assert.equal(refusal({ ...JOB, jobId: 'job_00000002' }, WAIT), 'WAIT_MISMATCH');
  assert.equal(refusal({ ...JOB, organizationId: 'org_b' }, WAIT), 'WAIT_MISMATCH');
  assert.equal(refusal(JOB, WAIT, { ...REPLY, responderUserId: 'user_2' }), 'RESPONDER_IS_NOT_PRINCIPAL');
  assert.equal(refusal({ ...JOB, principalUserId: 'user_2' }, WAIT), 'RESPONDER_IS_NOT_PRINCIPAL', 'the wait and the job must agree');
  assert.equal(refusal(JOB, WAIT, REPLY, 2_000), 'WAIT_EXPIRED', 'the expiry instant itself is too late');
  assert.equal(refusal(JOB, { ...WAIT, status: 'EXPIRED' }), 'WAIT_EXPIRED');
  assert.equal(refusal(JOB, { ...WAIT, status: 'CLOSED' }), 'WAIT_CLOSED');
  assert.equal(refusal({ ...JOB, state: 'RUNNING' as never }, WAIT), 'WAIT_MISMATCH');
  assert.equal(refusal({ ...JOB, wait: { waitId: 'wait_0000009', expiresAtMs: 2_000 } }, WAIT), 'WAIT_MISMATCH', 'a newer question');
  assert.equal(refusal({ ...JOB, wait: null }, WAIT), 'WAIT_MISMATCH');
  // A stranger learns nothing about whether the wait was answered, expired or closed.
  for (const status of ['ANSWERED', 'EXPIRED', 'CLOSED'] as const) {
    assert.equal(refusal(JOB, { ...WAIT, status, replyFingerprint: 'fp-a' }, { ...REPLY, responderUserId: 'user_9' }), 'RESPONDER_IS_NOT_PRINCIPAL', status);
  }
});

test('a wait expires only once its time has passed, and only while open', () => {
  assert.equal(brainWaitExpiryDue(WAIT, 1_999), false);
  assert.equal(brainWaitExpiryDue(WAIT, 2_000), true);
  assert.equal(brainWaitExpiryDue({ ...WAIT, status: 'ANSWERED' }, 9_000), false, 'an answer beats the clock');
  assert.equal(brainWaitExpiryDue({ ...WAIT, status: 'CLOSED' }, 9_000), false);
});

test('a command has one stored identity per job generation, or per wait', () => {
  const base = { jobId: 'job_00000001', generation: 1, waitId: null };
  assert.equal(brainCommandDedupeKey({ ...base, type: 'START' }), 'start:job_00000001:1');
  assert.equal(brainCommandDedupeKey({ ...base, type: 'CANCEL' }), 'cancel:job_00000001:1');
  assert.equal(brainCommandDedupeKey({ ...base, type: 'START', generation: 2 }), 'start:job_00000001:2', 'a new generation is a new start');
  assert.equal(brainCommandDedupeKey({ ...base, type: 'RESUME', waitId: 'wait_0000001' }), 'resume:job_00000001:1:wait_0000001');
  assert.notEqual(
    brainCommandDedupeKey({ ...base, type: 'RESUME', waitId: 'wait_0000001' }),
    brainCommandDedupeKey({ ...base, type: 'RESUME', waitId: 'wait_0000002' }),
    'each question is resumed once',
  );
  assert.throws(() => brainCommandDedupeKey({ ...base, type: 'RESUME' }), /RESUME names its wait/);
  assert.throws(() => brainCommandDedupeKey({ ...base, type: 'START', waitId: 'wait_0000001' }), /names no wait/);
  assert.throws(() => brainCommandDedupeKey({ ...base, type: 'CANCEL', waitId: 'wait_0000001' }), /names no wait/);
  assert.throws(() => brainCommandDedupeKey({ ...base, type: 'START', generation: 0 }), /generation/);
  assert.throws(() => brainCommandDedupeKey({ ...base, type: 'START', jobId: 'job:1' }), /job id/, 'no separator can be smuggled in');
  assert.throws(() => brainCommandDedupeKey({ ...base, type: 'RESUME', waitId: 'w:1:x' }), /RESUME names its wait/);
  assert.throws(() => brainCommandDedupeKey({ ...base, type: 'PAUSE' as never }), /unknown command type/);
});

const human = { kind: 'HUMAN' as const, userId: 'user_1' };
const ops = { kind: 'OPERATIONS' as const, reference: 'workflow:record-ai-control:run-1:operator' };

test('a stored control names a coherent target, a reason and who recorded it', () => {
  assert.deepEqual([...AI_CONTROL_SCOPES], [...AI_KILL_SWITCH_SCOPES], 'the same five scopes the kill switches use');
  assert.deepEqual([...AI_CONTROL_STATES], ['ACTIVE', 'KILLED']);
  const ok = (target: { scope: string; organizationId: string | null; value: string | null }, actor: typeof human | typeof ops = ops) =>
    aiControlRefusals({ target: target as never, state: 'KILLED', reason: 'Provider incident 2026-09-16.', actor });
  assert.deepEqual(ok({ scope: 'GLOBAL', organizationId: null, value: null }), []);
  assert.deepEqual(ok({ scope: 'PROVIDER', organizationId: null, value: 'openai' }), []);
  assert.deepEqual(ok({ scope: 'MODEL', organizationId: null, value: 'provider-a/model-x' }), []);
  assert.deepEqual(ok({ scope: 'TASK', organizationId: null, value: 'case.explanation' }), [], 'a platform-wide task control');
  assert.deepEqual(ok({ scope: 'TASK', organizationId: 'org_a', value: 'case.explanation' }, human), [], "a task within one organization");
  assert.deepEqual(ok({ scope: 'ORGANIZATION', organizationId: 'org_a', value: 'org_a' }, human), []);

  assert.deepEqual(ok({ scope: 'GLOBAL', organizationId: 'org_a', value: null }), ['ORGANIZATION_NOT_ALLOWED_FOR_SCOPE']);
  assert.deepEqual(ok({ scope: 'PROVIDER', organizationId: 'org_a', value: 'openai' }), ['ORGANIZATION_NOT_ALLOWED_FOR_SCOPE']);
  assert.deepEqual(ok({ scope: 'GLOBAL', organizationId: null, value: 'x' }), ['VALUE_NOT_ALLOWED_FOR_SCOPE']);
  assert.deepEqual(ok({ scope: 'MODEL', organizationId: null, value: null }), ['VALUE_REQUIRED']);
  assert.deepEqual(ok({ scope: 'TASK', organizationId: null, value: ' spaced' }), ['VALUE_REQUIRED']);
  assert.deepEqual(ok({ scope: 'ORGANIZATION', organizationId: null, value: 'org_a' }), ['ORGANIZATION_REQUIRED']);
  assert.deepEqual(
    ok({ scope: 'ORGANIZATION', organizationId: 'org_a', value: 'org_b' }, human),
    ['ORGANIZATION_VALUE_MISMATCH'],
    'an organization can never control another',
  );
  assert.deepEqual(ok({ scope: 'TENANT' as never, organizationId: null, value: 'x' }), ['UNKNOWN_SCOPE']);
  assert.deepEqual(
    aiControlRefusals({ target: { scope: 'GLOBAL', organizationId: null, value: null }, state: 'PAUSED' as never, reason: 'r', actor: ops }),
    ['UNKNOWN_STATE'],
  );
  assert.deepEqual(
    aiControlRefusals({ target: { scope: 'GLOBAL', organizationId: null, value: null }, state: 'ACTIVE', reason: '  ', actor: ops }),
    ['REASON_REQUIRED'],
  );
  for (const actor of [{ kind: 'HUMAN', userId: '' }, { kind: 'OPERATIONS', reference: ' ' }, { kind: 'ENVIRONMENT', reference: 'LOOP_AI_ENABLED' }]) {
    assert.deepEqual(
      aiControlRefusals({ target: { scope: 'GLOBAL', organizationId: null, value: null }, state: 'ACTIVE', reason: 'r', actor: actor as never }),
      ['ACTOR_INCOMPLETE'],
      `${actor.kind}: configuration is never an actor`,
    );
  }
});

test("a control's history has one key, grows one version at a time, and never overrides a newer decision", () => {
  assert.equal(aiControlKey({ scope: 'GLOBAL', organizationId: null, value: null }), 'GLOBAL|-|-');
  assert.equal(aiControlKey({ scope: 'TASK', organizationId: 'org_a', value: 'case.explanation' }), 'TASK|org_a|case.explanation');
  assert.notEqual(
    aiControlKey({ scope: 'TASK', organizationId: null, value: 'case.explanation' }),
    aiControlKey({ scope: 'TASK', organizationId: 'org_a', value: 'case.explanation' }),
    'a platform task control and an organization task control are different histories',
  );
  assert.deepEqual(aiControlAppendDecision(null, { expectedVersion: 0, state: 'ACTIVE' }), { action: 'APPEND', version: 1 });
  assert.deepEqual(aiControlAppendDecision({ version: 1, state: 'ACTIVE' }, { expectedVersion: 1, state: 'KILLED' }), { action: 'APPEND', version: 2 });
  assert.deepEqual(aiControlAppendDecision({ version: 1, state: 'ACTIVE' }, { expectedVersion: 1, state: 'ACTIVE' }), { action: 'UNCHANGED' });
  assert.deepEqual(aiControlAppendDecision({ version: 2, state: 'KILLED' }, { expectedVersion: 1, state: 'ACTIVE' }), {
    action: 'STALE',
    currentVersion: 2,
  });
  assert.deepEqual(aiControlAppendDecision(null, { expectedVersion: 1, state: 'ACTIVE' }), { action: 'STALE', currentVersion: 0 });
});

test('an organization is subject to platform controls and its own, never another organization\'s', () => {
  const entry = (organizationId: string | null, scope: 'GLOBAL' | 'TASK' | 'ORGANIZATION', value: string | null): AiControlEntry => ({
    target: { scope, organizationId, value },
    state: 'KILLED',
    version: 1,
    reason: 'r',
    actor: ops,
    recordedAtMs: 1,
  });
  const all = [
    entry(null, 'GLOBAL', null),
    entry(null, 'TASK', 'case.explanation'),
    entry('org_a', 'ORGANIZATION', 'org_a'),
    entry('org_b', 'ORGANIZATION', 'org_b'),
    entry('org_b', 'TASK', 'case.explanation'),
  ];
  assert.deepEqual(
    aiControlsApplyingTo('org_a', all).map((e) => aiControlKey(e.target)),
    ['GLOBAL|-|-', 'TASK|-|case.explanation', 'ORGANIZATION|org_a|org_a'],
  );
  assert.equal(aiControlsApplyingTo('org_c', all).length, 2);
});

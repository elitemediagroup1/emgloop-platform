// The execution clock, and everything it refuses to say.
//
// WHAT THESE PROVE
//
// THE CLOCK COUNTS ACTIONABLE TIME, NOT WALL TIME. Work that spent a day waiting
// on a buyer has not been ignored, and a policy that counted that day would page
// somebody for somebody else's silence.
//
// WAITING PAUSES ACCOUNTABILITY AND DOES NOT ERASE IT. Time already accrued
// survives a wait. If it did not, "mark it as waiting" would be the cheapest way
// to make an overdue item look healthy, and somebody would find that out.
//
// UNMEASURED IS NOT COMPLIANT. Every work item created before this foundation
// has no history, and reports UNKNOWN rather than WITHIN_POLICY.
//
// ELIGIBILITY EXISTS WITHOUT A DESTINATION. Loop can say something is eligible
// for escalation without pretending it knows who the manager is, because this
// platform has no reporting relationship and inventing one would move real
// accountability onto somebody who never accepted it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_TRANSITIONS,
  ESCALATION_AFTER_ACTIONABLE_MS,
  ESCALATION_DESTINATION_ABSENT,
  REMINDER_AFTER_ACTIONABLE_MS,
  TERMINAL_STATES,
  WAIT_REASONS,
  WAIT_STATE_FOR_REASON,
  WORK_EXECUTION_RULE_VERSION,
  WORK_EXECUTION_STATES,
  assessExecution,
  extensionCount,
  isActionable,
  isTerminal,
  isWaiting,
  replayDurations,
  transitionAllowed,
  wouldCreateCycle,
  type WorkExecutionState,
  type WorkStageEventRecord,
} from '../src/index';

const HOUR = 3_600_000;
const T0 = new Date('2026-09-01T09:00:00.000Z');
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

let seq = 0;
function change(to: WorkExecutionState, hours: number, from: WorkExecutionState | null = null, extra: Partial<WorkStageEventRecord> = {}): WorkStageEventRecord {
  return {
    eventType: 'STATE_CHANGED',
    occurredAt: at(hours),
    sequence: ++seq,
    fromStatus: from,
    toStatus: to,
    waitReason: null,
    expectedResolutionAt: null,
    dueAt: null,
    actorUserId: 'usr_matt',
    ...extra,
  };
}
function due(hours: number, type: 'DUE_SET' | 'DUE_EXTENDED', dueAt: Date): WorkStageEventRecord {
  return {
    eventType: type,
    occurredAt: at(hours),
    sequence: ++seq,
    fromStatus: null,
    toStatus: null,
    waitReason: null,
    expectedResolutionAt: null,
    dueAt,
    actorUserId: 'usr_matt',
  };
}

// --- 1. Vocabulary ------------------------------------------------------------------

test('1. the five original statuses survive, spelled exactly as they were', () => {
  // Every existing work_stages row uses these. A rename would have been a data
  // migration wearing a vocabulary change.
  for (const s of ['pending', 'ready', 'in_progress', 'completed', 'skipped']) {
    assert.ok((WORK_EXECUTION_STATES as readonly string[]).includes(s), s);
  }
  assert.equal(WORK_EXECUTION_STATES.length, 8, 'five original plus exactly three new');
});

test('1b. a wait state and its reason cannot disagree', () => {
  // If the two were independent, a row could claim to be waiting internally on
  // an external response and nothing would catch it.
  for (const reason of WAIT_REASONS) {
    const state = WAIT_STATE_FOR_REASON[reason];
    assert.ok(isWaiting(state), `${reason} maps to a waiting state`);
  }
  assert.equal(WAIT_STATE_FOR_REASON.AWAITING_INTERNAL_INPUT, 'waiting_internal');
  assert.equal(WAIT_STATE_FOR_REASON.AWAITING_EXTERNAL_RESPONSE, 'waiting_external');
  assert.equal(WAIT_STATE_FOR_REASON.AWAITING_DEPENDENCY, 'blocked');
});

test('1c. completed work has no exits', () => {
  // Reopening finished work is a different act with a different name. Allowing
  // it through a status write would erase the completion from the only place it
  // is recorded.
  for (const s of TERMINAL_STATES) {
    assert.deepEqual(ALLOWED_TRANSITIONS[s], []);
    for (const to of WORK_EXECUTION_STATES) {
      assert.equal(transitionAllowed(s, to), false, `${s} → ${to} is refused`);
    }
  }
});

test('1d. pending cannot jump straight to waiting or completed', () => {
  // A step nobody has reached is not something somebody is waiting on.
  assert.equal(transitionAllowed('pending', 'waiting_external'), false);
  assert.equal(transitionAllowed('pending', 'completed'), false);
  assert.equal(transitionAllowed('pending', 'ready'), true);
});

// --- 2. Durations are replayed, never counted ------------------------------------------

test('2. time is attributed to the state it was spent in', () => {
  seq = 0;
  const events = [
    change('ready', 0),
    change('waiting_external', 2, 'ready'),
    change('in_progress', 10, 'waiting_external'),
    change('completed', 13, 'in_progress'),
  ];
  const d = replayDurations(events, at(20));
  assert.equal(d.actionableMs, 5 * HOUR, '2 hours ready + 3 hours in progress');
  assert.equal(d.waitingExternalMs, 8 * HOUR);
  assert.equal(d.waitingInternalMs, 0);
  assert.equal(d.blockedMs, 0);
  assert.equal(d.elapsedToCompletionMs, 13 * HOUR, 'first actionable to completion');
});

test('2b. the open interval counts up to the moment being asked about', () => {
  // A stage sitting actionable right now is accruing accountability right now. A
  // report that only counted closed intervals would show zero on the worst item
  // in the queue.
  seq = 0;
  const d = replayDurations([change('ready', 0)], at(9));
  assert.equal(d.actionableMs, 9 * HOUR);
  assert.equal(d.elapsedToCompletionMs, null, 'unfinished work has no elapsed time');
});

test('2c. finished work stops accruing', () => {
  seq = 0;
  const events = [change('ready', 0), change('completed', 4, 'ready')];
  const early = replayDurations(events, at(5));
  const late = replayDurations(events, at(500));
  assert.equal(early.actionableMs, late.actionableMs, 'the answer does not grow after completion');
  assert.equal(late.actionableMs, 4 * HOUR);
});

test('2d. the log is ordered by sequence, never by timestamp', () => {
  // Two events can share a millisecond. The monotonic sequence is what gives the
  // log a deterministic order, exactly as on the Case side.
  seq = 0;
  const a = change('ready', 0);
  const b = change('completed', 0, 'ready');
  const forwards = replayDurations([a, b], at(5));
  const backwards = replayDurations([b, a], at(5));
  assert.deepEqual(forwards, backwards, 'shuffling the array changes nothing');
});

test('2e. extensions are derived from the log, so they cannot be reset', () => {
  seq = 0;
  const events = [
    change('ready', 0),
    due(1, 'DUE_SET', at(8)),
    due(6, 'DUE_EXTENDED', at(20)),
    due(18, 'DUE_EXTENDED', at(40)),
  ];
  assert.equal(extensionCount(events), 2, 'the first setting is not an extension');
});

// --- 3. Policy ---------------------------------------------------------------------------

test('3. twelve actionable hours is reminder-eligible, twenty-four is escalation-eligible', () => {
  seq = 0;
  const events = [change('ready', 0)];
  const early = assessExecution({ state: 'ready', dueAt: null, events, waiting: null, openDependencies: 0, now: at(5) });
  const twelve = assessExecution({ state: 'ready', dueAt: null, events, waiting: null, openDependencies: 0, now: at(12) });
  const day = assessExecution({ state: 'ready', dueAt: null, events, waiting: null, openDependencies: 0, now: at(24) });

  assert.equal(early.sla, 'WITHIN_POLICY');
  assert.equal(early.reminderEligible, false);
  assert.equal(twelve.sla, 'REMINDER_ELIGIBLE');
  assert.equal(twelve.escalationEligible, false);
  assert.equal(day.sla, 'ESCALATION_ELIGIBLE');
  // Escalation-eligible implies reminder-eligible: it did not stop being late.
  assert.equal(day.reminderEligible, true);
  assert.equal(day.escalationEligible, true);
  assert.equal(REMINDER_AFTER_ACTIONABLE_MS, 12 * HOUR);
  assert.equal(ESCALATION_AFTER_ACTIONABLE_MS, 24 * HOUR);
});

test('3b. a day spent waiting on a buyer does not make anybody late', () => {
  // THE CENTRAL PROPERTY. Wall-clock time is 30 hours; actionable time is 2.
  seq = 0;
  const events = [
    change('ready', 0),
    change('waiting_external', 2, 'ready'),
  ];
  const a = assessExecution({
    state: 'waiting_external',
    dueAt: null,
    events,
    waiting: { reason: 'AWAITING_EXTERNAL_RESPONSE', subject: 'CEM', expectedResolutionAt: at(48), note: null },
    openDependencies: 0,
    now: at(30),
  });
  assert.equal(a.sla, 'PAUSED_WAITING');
  assert.equal(a.escalationEligible, false);
  assert.equal(a.durations.actionableMs, 2 * HOUR);
  assert.equal(a.durations.waitingExternalMs, 28 * HOUR);
});

test('3c. a wait pauses the clock and KEEPS what already accrued', () => {
  // 20 actionable hours, then a week of waiting, then actionable again. Four
  // hours later it is escalation-eligible -- not twenty-four hours later.
  seq = 0;
  const events = [
    change('ready', 0),
    change('waiting_internal', 20, 'ready'),
    change('in_progress', 188, 'waiting_internal'), // a week later
  ];
  const justAfter = assessExecution({ state: 'in_progress', dueAt: null, events, waiting: null, openDependencies: 0, now: at(190) });
  assert.equal(justAfter.sla, 'REMINDER_ELIGIBLE', '22 actionable hours');

  const fourLater = assessExecution({ state: 'in_progress', dueAt: null, events, waiting: null, openDependencies: 0, now: at(192) });
  assert.equal(fourLater.sla, 'ESCALATION_ELIGIBLE', 'the 20 hours were not forgiven');
  assert.equal(fourLater.durations.waitingInternalMs, 168 * HOUR);
});

test('3d. repeated extensions stay visible in the explanation', () => {
  seq = 0;
  const events = [change('ready', 0), due(1, 'DUE_SET', at(4)), due(3, 'DUE_EXTENDED', at(8)), due(7, 'DUE_EXTENDED', at(16))];
  const a = assessExecution({ state: 'ready', dueAt: at(16), events, waiting: null, openDependencies: 0, now: at(10) });
  assert.equal(a.extensions, 2);
  assert.ok(a.explanation.some((l) => l.includes('moved 2 times')), a.explanation.join(' | '));
});

test('3e. finished work is not late, whatever its due time said', () => {
  seq = 0;
  const events = [change('ready', 0), change('completed', 40, 'ready')];
  const a = assessExecution({ state: 'completed', dueAt: at(4), events, waiting: null, openDependencies: 0, now: at(100) });
  assert.equal(a.sla, 'CLOSED');
  assert.equal(a.reminderEligible, false);
  assert.equal(a.escalationEligible, false);
  // Overdue is still reported honestly -- it WAS past its time -- but it is not
  // an accountability state.
  assert.equal(a.overdue, true);
});

// --- 4. Unknown is not compliant ----------------------------------------------------------

test('4. a stage with no history is UNKNOWN, never WITHIN_POLICY', () => {
  // Every work item created before this foundation existed is in exactly this
  // position. Reporting them as compliant would be Loop issuing a clean bill of
  // health for work it has never measured.
  const a = assessExecution({ state: 'ready', dueAt: null, events: [], waiting: null, openDependencies: 0, now: at(500) });
  assert.equal(a.sla, 'UNKNOWN');
  assert.equal(a.reminderEligible, false);
  assert.equal(a.escalationEligible, false);
  assert.ok(a.explanation[0]?.includes('cannot say'), a.explanation.join(' | '));
});

test('4b. a due time nobody set reports null, not false', () => {
  seq = 0;
  const a = assessExecution({ state: 'ready', dueAt: null, events: [change('ready', 0)], waiting: null, openDependencies: 0, now: at(1) });
  assert.equal(a.overdue, null, 'no due time is unknown, not on-time');
});

test('4c. a wait with nothing declared says so rather than inventing a reason', () => {
  seq = 0;
  const a = assessExecution({
    state: 'waiting_internal',
    dueAt: null,
    events: [change('ready', 0), change('waiting_internal', 1, 'ready')],
    waiting: null,
    openDependencies: 0,
    now: at(4),
  });
  assert.equal(a.sla, 'PAUSED_WAITING');
  assert.ok(a.explanation.some((l) => l.includes('no reason recorded')), a.explanation.join(' | '));
});

// --- 5. Escalation without a destination ----------------------------------------------------

test('5. eligibility exists; the destination does not, and says why', () => {
  seq = 0;
  const a = assessExecution({ state: 'ready', dueAt: null, events: [change('ready', 0)], waiting: null, openDependencies: 0, now: at(30) });
  assert.equal(a.escalationEligible, true);
  // NULL, DELIBERATELY. This platform has no Team, no Division and no reporting
  // relationship; `iam.repository.ts` already refuses to read MANAGER as "the
  // people they manage", and contradicting that here would be worse than
  // silence -- naming a wrong person moves real accountability onto somebody who
  // never accepted it.
  assert.equal(a.escalationDestinationUserId, null);
  assert.ok(a.explanation.includes(ESCALATION_DESTINATION_ABSENT));
  assert.ok(ESCALATION_DESTINATION_ABSENT.includes('permission level, not a manager'));
});

// --- 6. Dependencies ----------------------------------------------------------------------

test('6. an open dependency means it is not actionable', () => {
  seq = 0;
  const a = assessExecution({
    state: 'blocked',
    dueAt: null,
    events: [change('ready', 0), change('blocked', 1, 'ready')],
    waiting: { reason: 'AWAITING_DEPENDENCY', subject: 'wi_other', expectedResolutionAt: null, note: null },
    openDependencies: 2,
    now: at(50),
  });
  assert.equal(a.actionable, false);
  assert.equal(a.sla, 'PAUSED_WAITING');
  assert.ok(a.explanation.some((l) => l.includes('2 things')), a.explanation.join(' | '));
});

test('6b. work cannot wait for itself', () => {
  assert.equal(wouldCreateCycle([], 'wi_a', 'wi_a'), true);
});

test('6c. a cycle is refused however long the chain is', () => {
  // A → B → C already exists. Adding C → A closes the loop, and every work item
  // in it would wait forever with nothing ever saying why.
  const edges = [
    { from: 'wi_a', to: 'wi_b' },
    { from: 'wi_b', to: 'wi_c' },
  ];
  assert.equal(wouldCreateCycle(edges, 'wi_c', 'wi_a'), true);
  assert.equal(wouldCreateCycle(edges, 'wi_a', 'wi_d'), false, 'an unrelated edge is fine');
});

test('6d. a graph that already contains a cycle terminates instead of recursing forever', () => {
  const edges = [
    { from: 'wi_a', to: 'wi_b' },
    { from: 'wi_b', to: 'wi_a' },
  ];
  // Bounded by the visited set. Without it this is a stack overflow, which is a
  // production outage rather than a refused write.
  assert.equal(wouldCreateCycle(edges, 'wi_c', 'wi_a'), false);
});

// --- 7. Determinism -------------------------------------------------------------------------

test('7. the same question about the same moment always gets the same answer', () => {
  seq = 0;
  const events = [change('ready', 0), change('waiting_external', 3, 'ready'), change('in_progress', 9, 'waiting_external')];
  const input = { state: 'in_progress' as const, dueAt: at(30), events, waiting: null, openDependencies: 0, now: at(21) };
  const a = assessExecution(input);
  const b = assessExecution(input);
  assert.deepEqual(a, b);
  assert.equal(a.ruleVersion, WORK_EXECUTION_RULE_VERSION);
});

test('7b. the state helpers agree with the state lists', () => {
  for (const s of WORK_EXECUTION_STATES) {
    const buckets = [isActionable(s), isWaiting(s), isTerminal(s)].filter(Boolean).length;
    // `pending` is in none of them, and that is correct: a step nobody has
    // reached is neither live, waiting, nor finished.
    assert.ok(buckets <= 1, `${s} is in at most one bucket`);
  }
  assert.equal(isActionable('pending'), false);
  assert.equal(isWaiting('pending'), false);
  assert.equal(isTerminal('pending'), false);
});

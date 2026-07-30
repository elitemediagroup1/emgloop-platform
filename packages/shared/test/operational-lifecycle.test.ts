import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  projectLifecycle,
  summarizeHistory,
  summarizeDecisionActivity,
  orderLog,
  isClosed,
  standingOf,
  LIFECYCLE_PROJECTION_VERSION,
  MIN_CLOSED_FOR_RATES,
  type LifecycleObservation,
  type ObservationType,
  type OperationalOutcome,
} from '../src/operational-lifecycle';

// A fixed instant. These tests reason about durations, and a fixture pinned to a
// literal date is only safe because nothing here reads a clock — the projection
// takes no `now`, so no TTL can expire underneath it as the calendar moves.
const T0 = new Date('2026-03-02T14:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let seq = 0;
function obs(
  observationType: ObservationType,
  minutes: number,
  extra: Partial<LifecycleObservation> = {},
): LifecycleObservation {
  seq += 1;
  return {
    id: `o${seq}`,
    sequence: seq,
    observationType,
    occurredAt: at(minutes),
    recordedAt: at(minutes),
    actorType: 'HUMAN',
    actorUserId: 'user-matt',
    source: 'operator',
    note: null,
    assignedToUserId: null,
    outcome: null,
    measuredEffectCents: null,
    measuredEffectBasis: null,
    ...extra,
  };
}
function detected(minutes = 0): LifecycleObservation {
  return obs('SITUATION_DETECTED', minutes, {
    actorType: 'SYSTEM',
    actorUserId: null,
    source: 'callgrid-intelligence',
  });
}
function reset() {
  seq = 0;
}

// --- The opening state ------------------------------------------------------

test('an empty log is NEEDS_REVIEW, never resolved', () => {
  reset();
  const p = projectLifecycle([]);
  assert.equal(p.state, 'NEEDS_REVIEW');
  assert.equal(p.ownerUserId, null);
  assert.equal(p.resolvedAt, null);
  assert.equal(p.outcome, null);
  assert.equal(p.observationCount, 0);
  assert.equal(p.projectionVersion, LIFECYCLE_PROJECTION_VERSION);
});

test('detection opens the item and stamps when the review clock started', () => {
  reset();
  const p = projectLifecycle([detected(0)]);
  assert.equal(p.state, 'NEEDS_REVIEW');
  assert.deepEqual(p.stateChangedAt, at(0));
});

// --- The queue is cleared by deciding, not by reading ------------------------

test('REVIEWED records that a human looked but does NOT clear the lane', () => {
  reset();
  const p = projectLifecycle([detected(0), obs('REVIEWED', 10)]);
  assert.equal(p.state, 'NEEDS_REVIEW', 'reading is not deciding');
  assert.equal(p.observationCount, 2, 'but the fact that someone looked is kept');
});

test('assigning moves the lane and records the ASSIGNEE, not the owner', () => {
  reset();
  const p = projectLifecycle([detected(0), obs('ASSIGNED', 5, { assignedToUserId: 'user-sam' })]);
  assert.equal(p.state, 'ASSIGNED');
  assert.equal(p.assigneeUserId, 'user-sam', 'assignment is execution');
  assert.equal(p.ownerUserId, null, 'and it does NOT make Sam accountable for the outcome');
  assert.deepEqual(p.stateChangedAt, at(5));
});

// --- Ownership and assignment are different dimensions -----------------------
//
// Accountability ("who owns this problem") and execution ("who is working it
// today") answer different questions, and the platform must be able to answer
// each without deriving it from the other. A manager owns revenue quality; a
// specialist works the item; the item sits in a lane. Three answers, three
// sources.

test('owner and assignee are independent, and neither is derived from the lane', () => {
  reset();
  const p = projectLifecycle([
    detected(0),
    obs('OWNER_CHANGED', 5, { assignedToUserId: 'user-matt' }),
    obs('ASSIGNED', 10, { assignedToUserId: 'user-sam' }),
  ]);
  assert.equal(p.ownerUserId, 'user-matt');
  assert.equal(p.assigneeUserId, 'user-sam');
  assert.equal(p.state, 'ASSIGNED');
});

test('taking ownership does not take the work, and does not move the lane', () => {
  reset();
  const p = projectLifecycle([detected(0), obs('OWNER_CHANGED', 5, { assignedToUserId: 'user-matt' })]);
  assert.equal(p.ownerUserId, 'user-matt');
  assert.equal(p.assigneeUserId, null, 'owning it is not working it');
  assert.equal(p.state, 'NEEDS_REVIEW', 'and it still needs somebody to pick it up');
});

test('handover changes who works it and nothing else', () => {
  reset();
  const p = projectLifecycle([
    detected(0),
    obs('OWNER_CHANGED', 5, { assignedToUserId: 'user-matt' }),
    obs('ASSIGNED', 10, { assignedToUserId: 'user-sam' }),
    obs('WATCH_STARTED', 15),
    obs('REASSIGNED', 20, { assignedToUserId: 'user-lisa' }),
  ]);
  assert.equal(p.assigneeUserId, 'user-lisa');
  assert.equal(p.ownerUserId, 'user-matt', 'ownership survives every handover');
  assert.equal(p.state, 'WATCHING', 'reassigning a watched item does not stop the watch');
});

test('unassigning returns it to the queue but leaves accountability intact', () => {
  reset();
  const p = projectLifecycle([
    detected(0),
    obs('OWNER_CHANGED', 5, { assignedToUserId: 'user-matt' }),
    obs('ASSIGNED', 10, { assignedToUserId: 'user-sam' }),
    obs('UNASSIGNED', 20),
  ]);
  assert.equal(p.assigneeUserId, null);
  assert.equal(p.state, 'NEEDS_REVIEW', 'nobody is working it, so it is the queue\'s problem again');
  assert.equal(p.ownerUserId, 'user-matt', 'but Matt still answers for it');
});

test('unassigning a watched or closed item does not drag it out of that position', () => {
  reset();
  const watched = projectLifecycle([
    detected(0),
    obs('ASSIGNED', 5, { assignedToUserId: 'user-sam' }),
    obs('WATCH_STARTED', 10),
    obs('UNASSIGNED', 15),
  ]);
  assert.equal(watched.state, 'WATCHING', 'watching is a deliberate position');
  assert.equal(watched.assigneeUserId, null);

  reset();
  const closed = projectLifecycle([
    detected(0),
    obs('ASSIGNED', 5, { assignedToUserId: 'user-sam' }),
    obs('RESOLVED', 10, { outcome: 'RECOVERED' }),
    obs('UNASSIGNED', 15),
  ]);
  assert.equal(closed.state, 'RESOLVED', 'losing an assignee cannot reopen a decision');
});

test('attribute changes are recorded but move nothing', () => {
  reset();
  const p = projectLifecycle([
    detected(0),
    obs('ASSIGNED', 5, { assignedToUserId: 'user-sam' }),
    obs('PRIORITY_CHANGED', 10),
    obs('SEVERITY_CHANGED', 11),
    obs('EVIDENCE_ADDED', 12),
  ]);
  assert.equal(p.state, 'ASSIGNED');
  assert.equal(p.assigneeUserId, 'user-sam');
  assert.equal(p.observationCount, 5, 'but each is kept: "who raised this to urgent" is a real question');
});

// --- Facts that must NOT disturb the lane -----------------------------------

test('re-sighting an owned item does not drag it back to needing review', () => {
  reset();
  const p = projectLifecycle([
    detected(0),
    obs('ASSIGNED', 5, { assignedToUserId: 'user-sam' }),
    obs('SITUATION_RESIGHTED', 1440, { actorType: 'SYSTEM', actorUserId: null, source: 'callgrid-intelligence' }),
  ]);
  assert.equal(p.state, 'ASSIGNED');
  assert.equal(p.assigneeUserId, 'user-sam');
});

test('progress inside a lane never changes the lane', () => {
  reset();
  const progress: ObservationType[] = [
    'NOTE_ADDED',
    'CONTACT_ATTEMPTED',
    'CONTACT_COMPLETED',
    'AWAITING_RESPONSE',
    'RESPONSE_RECEIVED',
    'ESCALATED',
  ];
  const p = projectLifecycle([
    detected(0),
    obs('ASSIGNED', 5, { assignedToUserId: 'user-sam' }),
    ...progress.map((t, i) => obs(t, 10 + i)),
  ]);
  assert.equal(p.state, 'ASSIGNED');
  assert.equal(p.assigneeUserId, 'user-sam');
});

test('reassigning a watched item keeps it watched, and reassigning a closed one does not resurrect it', () => {
  reset();
  const watched = projectLifecycle([
    detected(0),
    obs('WATCH_STARTED', 5),
    obs('OWNER_CHANGED', 10, { assignedToUserId: 'user-sam' }),
  ]);
  assert.equal(watched.state, 'WATCHING');
  assert.equal(watched.ownerUserId, 'user-sam');
  assert.equal(watched.assigneeUserId, null, 'ownership never implies assignment');

  reset();
  const closed = projectLifecycle([
    detected(0),
    obs('RESOLVED', 20, { outcome: 'RECOVERED' }),
    obs('OWNER_CHANGED', 30, { assignedToUserId: 'user-sam' }),
  ]);
  assert.equal(closed.state, 'RESOLVED');
  assert.equal(closed.ownerUserId, 'user-sam');
});

test('stopping a watch returns an owned item to its owner and an unowned one to the queue', () => {
  reset();
  const owned = projectLifecycle([
    detected(0),
    obs('ASSIGNED', 5, { assignedToUserId: 'user-sam' }),
    obs('WATCH_STARTED', 10),
    obs('WATCH_STOPPED', 15),
  ]);
  assert.equal(owned.state, 'ASSIGNED', 'it returns to the person working it');

  reset();
  const unowned = projectLifecycle([detected(0), obs('WATCH_STARTED', 10), obs('WATCH_STOPPED', 15)]);
  assert.equal(unowned.state, 'NEEDS_REVIEW');
});

// --- Closing, and the resolution that did not hold ---------------------------

test('resolving records when and with what outcome', () => {
  reset();
  const p = projectLifecycle([
    detected(0),
    obs('ASSIGNED', 5, { assignedToUserId: 'user-sam' }),
    obs('RESOLVED', 60, { outcome: 'RECOVERED', measuredEffectCents: 198_000 }),
  ]);
  assert.equal(p.state, 'RESOLVED');
  assert.deepEqual(p.resolvedAt, at(60));
  assert.equal(p.outcome, 'RECOVERED');
  assert.equal(p.measuredEffectCents, 198_000);
  assert.ok(isClosed(p.state));
});

test('reopening clears the resolution, counts, and returns it to the queue', () => {
  reset();
  const p = projectLifecycle([
    detected(0),
    obs('RESOLVED', 60, { outcome: 'RECOVERED', measuredEffectCents: 198_000 }),
    obs('REOPENED', 10_000, { actorType: 'SYSTEM', actorUserId: null, source: 'callgrid-intelligence' }),
  ]);
  assert.equal(p.state, 'NEEDS_REVIEW');
  assert.equal(p.reopenCount, 1);
  assert.equal(p.resolvedAt, null, 'a resolution that did not hold is not a resolution');
  assert.equal(p.outcome, null);
});

test('a full journey with a relapse replays to the right place', () => {
  reset();
  const p = projectLifecycle([
    detected(0),
    obs('ASSIGNED', 30, { assignedToUserId: 'user-matt' }),
    obs('CONTACT_ATTEMPTED', 60),
    obs('AWAITING_RESPONSE', 61),
    obs('RESPONSE_RECEIVED', 500),
    obs('OUTCOME_RECORDED', 600, { outcome: 'RECOVERED', measuredEffectCents: 198_000 }),
    obs('RESOLVED', 700, { outcome: 'RECOVERED' }),
    obs('REOPENED', 40_000, { actorType: 'SYSTEM', actorUserId: null, source: 'callgrid-intelligence' }),
    obs('ASSIGNED', 40_100, { assignedToUserId: 'user-sam' }),
  ]);
  assert.equal(p.state, 'ASSIGNED');
  assert.equal(p.assigneeUserId, 'user-sam');
  assert.equal(p.reopenCount, 1);
  assert.equal(p.resolvedAt, null);
});

// --- Ordering ---------------------------------------------------------------

test('state follows the order Loop LEARNED things, not the order they happened', () => {
  reset();
  // A backdated note about a call made before the item was even assigned. It must
  // not reorder the decision that was made in full knowledge of what preceded it.
  const log = [
    detected(0),
    obs('RESOLVED', 100, { outcome: 'RECOVERED' }),
    obs('CONTACT_COMPLETED', 50), // recorded last, occurred earlier
  ];
  const p = projectLifecycle(log);
  assert.equal(p.state, 'RESOLVED', 'the late-recorded earlier fact did not undo the resolution');

  // And the ordering is by sequence, not by time.
  assert.deepEqual(
    orderLog([...log].reverse()).map((o) => o.sequence),
    [1, 2, 3],
  );
});

test('the projection is independent of the order rows arrive in', () => {
  reset();
  const log = [
    detected(0),
    obs('ASSIGNED', 5, { assignedToUserId: 'user-sam' }),
    obs('WATCH_STARTED', 10),
    obs('RESOLVED', 20, { outcome: 'NOT_RECOVERED' }),
  ];
  const forward = projectLifecycle(log);
  const backward = projectLifecycle([...log].reverse());
  const shuffled = projectLifecycle([log[2]!, log[0]!, log[3]!, log[1]!]);
  assert.deepEqual(backward, forward);
  assert.deepEqual(shuffled, forward);
});

// --- The core claim: the log is the truth ------------------------------------

test('the projection is a pure function of the log, so a stored copy is always rebuildable', () => {
  reset();
  const log = [
    detected(0),
    obs('REVIEWED', 5),
    obs('ASSIGNED', 10, { assignedToUserId: 'user-sam' }),
    obs('CONTACT_ATTEMPTED', 20),
    obs('RESOLVED', 90, { outcome: 'PARTIALLY_RECOVERED', measuredEffectCents: 45_000 }),
  ];
  // Replaying any prefix and then the remainder must equal replaying the whole,
  // which is what makes the cached columns safe to write incrementally.
  const whole = projectLifecycle(log);
  const rebuilt = projectLifecycle([...log]);
  assert.deepEqual(rebuilt, whole);
  assert.deepEqual(projectLifecycle(log.slice(0, 5)), whole);
});

test('a correction supersedes rather than accumulates, so recoveries cannot inflate', () => {
  reset();
  const p = projectLifecycle([
    detected(0),
    obs('OUTCOME_RECORDED', 10, { outcome: 'RECOVERED', measuredEffectCents: 500_000 }),
    obs('OUTCOME_RECORDED', 20, { outcome: 'PARTIALLY_RECOVERED', measuredEffectCents: 120_000 }),
  ]);
  assert.equal(p.measuredEffectCents, 120_000, 'last write wins; 620,000 would be a fabricated total');
  assert.equal(p.outcome, 'PARTIALLY_RECOVERED');

  // ...but both are still visible in the history, so the correction is auditable.
  reset();
  const h = summarizeHistory([
    detected(0),
    obs('OUTCOME_RECORDED', 10, { outcome: 'RECOVERED', measuredEffectCents: 500_000 }),
    obs('OUTCOME_RECORDED', 20, { outcome: 'PARTIALLY_RECOVERED', measuredEffectCents: 120_000 }),
  ]);
  assert.equal(h.recordedOutcomes.length, 2);
});

// --- History ----------------------------------------------------------------

test('history measures durations only when both ends are real', () => {
  reset();
  const h = summarizeHistory([
    detected(0),
    obs('REVIEWED', 30),
    obs('ASSIGNED', 60, { assignedToUserId: 'user-sam' }),
    obs('CONTACT_ATTEMPTED', 90),
    obs('RESOLVED', 600, { outcome: 'RECOVERED' }),
  ]);
  assert.equal(h.msToFirstDecision, 60 * 60_000, 'REVIEWED is not a decision; ASSIGNED is');
  assert.equal(h.msToResolution, 600 * 60_000);
  assert.equal(h.contactAttempts, 1);
  assert.deepEqual(h.humanActors, ['user-matt']);

  // No detection row at all -> no durations invented from epoch.
  reset();
  const orphan = summarizeHistory([obs('RESOLVED', 10, { outcome: 'UNKNOWN' })]);
  assert.equal(orphan.msToResolution, null);
  assert.equal(orphan.firstDetectedAt, null);
});

test('a reopened item reports no resolution time, because it was not resolved', () => {
  reset();
  const h = summarizeHistory([
    detected(0),
    obs('RESOLVED', 100, { outcome: 'RECOVERED' }),
    obs('REOPENED', 5_000, { actorType: 'SYSTEM', actorUserId: null, source: 'callgrid-intelligence' }),
  ]);
  assert.equal(h.msToResolution, null);
  assert.equal(h.timesReopened, 1);
});

test('detection count counts sightings, not reopens', () => {
  reset();
  const h = summarizeHistory([
    detected(0),
    obs('SITUATION_RESIGHTED', 1440, { actorType: 'SYSTEM', actorUserId: null, source: 'x' }),
    obs('SITUATION_RESIGHTED', 2880, { actorType: 'SYSTEM', actorUserId: null, source: 'x' }),
  ]);
  assert.equal(h.detectionCount, 3);
  assert.equal(h.timesReopened, 0);
});

// --- Decision activity ------------------------------------------------------

test('rates are withheld with a reason rather than rendered as 0%', () => {
  const a = summarizeDecisionActivity([
    { state: 'NEEDS_REVIEW', outcome: null, measuredEffectCents: null, reopenCount: 0, msToResolution: null },
    { state: 'ASSIGNED', outcome: null, measuredEffectCents: null, reopenCount: 0, msToResolution: null },
  ]);
  assert.equal(a.total, 2);
  assert.equal(a.open, 2);
  assert.equal(a.falsePositiveRate.percent, null);
  assert.ok(a.falsePositiveRate.unavailableReason);
  assert.equal(a.reopenRate.percent, null);
  assert.equal(a.measuredEffectCents, null, 'no measured effect is not $0');
  assert.ok(a.insufficientHistory);
});

test('a small sample is reported as insufficient even when a rate is arithmetically computable', () => {
  const a = summarizeDecisionActivity([
    { state: 'RESOLVED', outcome: 'RECOVERED', measuredEffectCents: 100, reopenCount: 0, msToResolution: 10 },
  ]);
  assert.equal(a.falsePositiveRate.percent, 0, 'the arithmetic is available...');
  assert.ok(
    a.insufficientHistory?.includes(String(MIN_CLOSED_FOR_RATES)),
    '...but it is labelled as not yet meaningful, with the requirement stated',
  );
});

test('false-positive rate counts only closed items that recorded an outcome', () => {
  const rows: Parameters<typeof summarizeDecisionActivity>[0] = [
    { state: 'RESOLVED', outcome: 'RECOVERED', measuredEffectCents: 1_000, reopenCount: 0, msToResolution: 100 },
    { state: 'DISMISSED', outcome: 'FALSE_POSITIVE', measuredEffectCents: null, reopenCount: 0, msToResolution: 50 },
    { state: 'DISMISSED', outcome: 'NO_ACTION_NEEDED', measuredEffectCents: null, reopenCount: 0, msToResolution: 70 },
    { state: 'RESOLVED', outcome: 'NOT_RECOVERED', measuredEffectCents: 2_000, reopenCount: 1, msToResolution: 300 },
    { state: 'RESOLVED', outcome: null, measuredEffectCents: null, reopenCount: 0, msToResolution: 10 },
    { state: 'NEEDS_REVIEW', outcome: null, measuredEffectCents: null, reopenCount: 0, msToResolution: null },
  ];
  const a = summarizeDecisionActivity(rows);
  assert.equal(a.falsePositiveRate.denominator, 4, 'the outcome-less closed item is not counted against Loop');
  assert.equal(a.falsePositiveRate.numerator, 2);
  assert.equal(a.falsePositiveRate.percent, 50);
  assert.equal(a.measuredEffectCents, 3_000);
  assert.equal(a.measuredEffectSample, 2);
  assert.equal(a.insufficientHistory, null, '5 closed clears the minimum');
});

test('typical resolution time is a median, so one straggler cannot define it', () => {
  const long = 400 * 24 * 3_600_000;
  const a = summarizeDecisionActivity([
    { state: 'RESOLVED', outcome: 'RECOVERED', measuredEffectCents: null, reopenCount: 0, msToResolution: 1_000 },
    { state: 'RESOLVED', outcome: 'RECOVERED', measuredEffectCents: null, reopenCount: 0, msToResolution: 2_000 },
    { state: 'RESOLVED', outcome: 'RECOVERED', measuredEffectCents: null, reopenCount: 0, msToResolution: 3_000 },
    { state: 'RESOLVED', outcome: 'RECOVERED', measuredEffectCents: null, reopenCount: 0, msToResolution: long },
  ]);
  assert.equal(a.medianResolutionMs, 2_500);
  assert.equal(a.medianResolutionSample, 4);
});

test('every outcome value is a legal input to the false-positive classification', () => {
  const outcomes: OperationalOutcome[] = [
    'RECOVERED', 'PARTIALLY_RECOVERED', 'NOT_RECOVERED', 'NO_ACTION_NEEDED',
    'FALSE_POSITIVE', 'ACCEPTED_RISK', 'NOT_ACTIONABLE', 'UNKNOWN',
  ];
  const a = summarizeDecisionActivity(
    outcomes.map((outcome) => ({
      state: 'RESOLVED' as const, outcome, measuredEffectCents: null, reopenCount: 0, msToResolution: 1,
    })),
  );
  assert.equal(a.falsePositiveRate.denominator, 8);
  assert.equal(a.falsePositiveRate.numerator, 2, 'FALSE_POSITIVE and NO_ACTION_NEEDED');
});

// --- Standing ---------------------------------------------------------------

test('a first sighting is NEW, a persistent one is HOLDING, a relapse outranks both', () => {
  const fresh = standingOf({ detectionCount: 1, reopenCount: 0 });
  assert.equal(fresh.state, 'NEW');
  assert.equal(fresh.relapsed, false);

  const persistent = standingOf({ detectionCount: 12, reopenCount: 0 });
  assert.equal(persistent.state, 'HOLDING');
  assert.match(persistent.basis, /12 analysis periods/);

  // A resolution that did not hold is a stronger signal than one nobody closed,
  // so it must win even when the sighting count is low.
  const relapsed = standingOf({ detectionCount: 2, reopenCount: 1 });
  assert.equal(relapsed.state, 'GETTING_WORSE');
  assert.equal(relapsed.relapsed, true);
  assert.match(relapsed.basis, /did not hold/i);
});

test('standing never claims the underlying number is moving', () => {
  // It counts sightings; it does not read the metric series. Saying "getting
  // worse" from a sighting count alone would be a claim about the business made
  // from a fact about Loop.
  const s = standingOf({ detectionCount: 40, reopenCount: 0 });
  assert.equal(s.state, 'HOLDING');
  assert.match(s.basis, /separate question/i);
});

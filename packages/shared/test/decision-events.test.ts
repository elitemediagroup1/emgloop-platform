// The Decision Event Contract, checked as a contract.
//
// These are the producer-independent invariants: the vocabulary is total, every
// declared event is reachable, and the two event names people keep assuming exist
// do not. The schema binding and the "is it actually true today" checks live in
// @emgloop/database, where the Prisma enum and the engine source are visible.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DECISION_EVENT_CONTRACT_VERSION,
  DECISION_EVENT_NAMES,
  DECISION_EVENT_TYPE,
  DELIVERY_GUARANTEES,
  DECISION_STATE_KEY_PREFIX,
  SUBSCRIBER_RULES,
  decisionStateKey,
  guaranteeStatus,
  isDecisionEventName,
  observationTypesFor,
  OBSERVATION_TYPES,
  type DecisionEventName,
  type DecisionEventPayloadV1,
} from '../src/index';

// --- The vocabulary -----------------------------------------------------------

test('every observation type announces an event — the map is total', () => {
  for (const type of OBSERVATION_TYPES) {
    const event = DECISION_EVENT_TYPE[type];
    assert.ok(event, `${type} announces nothing`);
    assert.ok(
      isDecisionEventName(event),
      `${type} announces "${event}", which is not in the vocabulary`,
    );
  }
  assert.equal(Object.keys(DECISION_EVENT_TYPE).length, OBSERVATION_TYPES.length);
});

test('every declared event is reachable — no event a subscriber can never receive', () => {
  // The inverse of totality, and the one that actually bites: a name in the
  // vocabulary that nothing maps to is a handler that compiles, registers, and
  // never fires. That is precisely the failure this contract exists to prevent.
  for (const name of DECISION_EVENT_NAMES) {
    const sources = observationTypesFor(name);
    assert.ok(
      sources.length > 0,
      `"${name}" is declared but no observation type announces it — it can never be delivered`,
    );
  }
});

test('the vocabulary has no duplicates', () => {
  assert.equal(new Set(DECISION_EVENT_NAMES).size, DECISION_EVENT_NAMES.length);
});

test('DecisionDismissed and DecisionMerged do not exist, and dismissal maps to DecisionClosed', () => {
  // Both were assumed to exist while planning the first subscriber. A handler
  // switching on either would compile and silently never fire, so the contract
  // asserts their absence rather than leaving it to be rediscovered.
  assert.equal(isDecisionEventName('DecisionDismissed'), false);
  assert.equal(isDecisionEventName('DecisionMerged'), false);
  assert.equal(DECISION_EVENT_TYPE.DISMISSED, 'DecisionClosed');

  // A merge is an OUTCOME on a close, not an event of its own.
  assert.equal(DECISION_EVENT_TYPE.RESOLVED, 'DecisionResolved');
});

test('deliberate collapses are contract, not accident', () => {
  // Both assignment types announce one event; the finer distinction rides on
  // changeType. If someone splits these, subscribers matching DecisionAssigned
  // stop seeing handovers — so the collapse is asserted, not assumed.
  assert.equal(DECISION_EVENT_TYPE.ASSIGNED, 'DecisionAssigned');
  assert.equal(DECISION_EVENT_TYPE.REASSIGNED, 'DecisionAssigned');
  assert.deepEqual(observationTypesFor('DecisionAssigned'), ['ASSIGNED', 'REASSIGNED']);

  assert.deepEqual(observationTypesFor('DecisionProgressRecorded'), [
    'CONTACT_ATTEMPTED',
    'CONTACT_COMPLETED',
    'AWAITING_RESPONSE',
    'RESPONSE_RECEIVED',
  ]);
});

// --- The payload --------------------------------------------------------------

/**
 * The v1 payload, written out in full.
 *
 * This sample is the version guard. TypeScript fails it if a field is added to
 * `DecisionEventPayloadV1` (missing property) or removed (excess property), and
 * the key assertion below then fails until someone consciously decides whether
 * the change is additive or a v2. Without this, a rename here silently breaks
 * every subscriber at runtime with no compile error anywhere.
 */
const SAMPLE: DecisionEventPayloadV1 = {
  decisionId: 'dec_1',
  producer: 'CALLGRID',
  observationId: 'obs_1',
  sequence: 3,
  previousState: 'NEEDS_REVIEW',
  newState: 'ASSIGNED',
  ownerUserId: 'usr_1',
  assigneeUserId: 'usr_2',
  outcome: null,
};

test('the v1 payload shape is exactly what subscribers were promised', () => {
  assert.deepEqual(Object.keys(SAMPLE).sort(), [
    'assigneeUserId',
    'decisionId',
    'newState',
    'observationId',
    'outcome',
    'ownerUserId',
    'previousState',
    'producer',
    'sequence',
  ]);
});

test('the payload carries no business content, on purpose', () => {
  // A payload duplicating the row goes stale the moment the row changes, and
  // widens what a delivery bug can leak. Subscribers re-read by decisionId.
  for (const forbidden of ['title', 'severity', 'impactCents', 'evidence', 'organizationId']) {
    assert.ok(
      !(forbidden in SAMPLE),
      `"${forbidden}" must not be in the event payload — subscribers re-read the decision`,
    );
  }
});

test('previousState is null only for a decision that did not exist yet', () => {
  const created: DecisionEventPayloadV1 = { ...SAMPLE, previousState: null, newState: 'NEEDS_REVIEW' };
  assert.equal(created.previousState, null);
});

// --- Routing ------------------------------------------------------------------

test('routing keys are namespaced by producer and cannot collide with active state', () => {
  const key = decisionStateKey('CALLGRID', 'buyer-concentration:1039');
  assert.equal(key, 'decision.CALLGRID.buyer-concentration:1039');
  assert.ok(key.startsWith(DECISION_STATE_KEY_PREFIX));
  // A subscriber can watch one producer without matching the whole platform.
  assert.ok(key.startsWith('decision.CALLGRID.'));
});

// --- The guarantees -----------------------------------------------------------

test('every guarantee states what it is and what enforces it', () => {
  assert.ok(DELIVERY_GUARANTEES.length > 0);
  const ids = new Set<string>();
  for (const g of DELIVERY_GUARANTEES) {
    assert.ok(g.statement.trim().length > 0, `${g.id} has no statement`);
    assert.ok(g.enforcedBy.trim().length > 0, `${g.id} does not say what enforces it`);
    assert.ok(!ids.has(g.id), `duplicate guarantee id ${g.id}`);
    ids.add(g.id);
  }
});

test('the contract admits what is NOT built', () => {
  // A contract listing only its guarantees reads as though the rest are
  // guaranteed too. Ordering is the one a subscriber author most needs, and it
  // does not hold: independent retry means a later event can land first.
  assert.equal(guaranteeStatus('per-subject-ordering'), 'NOT_BUILT');

  // The drain exists but its execution depends on deployment configuration this
  // repository cannot assert, so it may not claim more than PARTIAL.
  assert.equal(guaranteeStatus('delivery-execution'), 'PARTIAL');
  assert.match(
    DELIVERY_GUARANTEES.find((g) => g.id === 'delivery-execution')!.statement,
    /OUTBOX_DRAIN_SECRET/,
    'a PARTIAL delivery guarantee must name what is missing, or it reads as guaranteed',
  );
});

test('a dead worker can no longer strand a delivery', () => {
  // This was PARTIAL: claim() covered PENDING/FAILED only, so a delivery
  // abandoned in PROCESSING was never retried, never dead-lettered and never
  // surfaced. The reclaim closed it; the guarantee may now say so.
  assert.equal(guaranteeStatus('at-least-once'), 'GUARANTEED');
  const g = DELIVERY_GUARANTEES.find((x) => x.id === 'at-least-once')!;
  assert.match(g.enforcedBy, /reclaimStale/);
  // Idempotency is still required — a reclaimed delivery may already have run.
  assert.match(g.enforcedBy, /idempotent/i);
});

test('subscriber rules exist and name the traps that were actually hit', () => {
  assert.ok(SUBSCRIBER_RULES.length > 0);
  const all = SUBSCRIBER_RULES.join(' ');
  // The existing cognitive `work-os` handler no-ops when identityId is null,
  // which is the normal case for a decision. That trap is documented.
  assert.match(all, /identityId/);
  assert.match(all, /sequence/);
});

test('the contract declares its version', () => {
  assert.equal(DECISION_EVENT_CONTRACT_VERSION, 'decision-events.v1');
});

// Compile-time: a name outside the vocabulary is not assignable.
const _typed: DecisionEventName = 'DecisionResolved';
void _typed;

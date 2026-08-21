// The design fixtures must stay attached to the real contracts.
//
// A fixture layer earns its keep only while it is the SAME shape production
// produces. These assertions are what make that true rather than hoped: every
// vocabulary value used below is checked against the shipped vocabulary, so a
// renamed state or a widened enum fails here instead of silently teaching a
// surface to render something that will never arrive.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_AWAITING_APPROVAL,
  COVERAGE_HEALTHY,
  COVERAGE_HEALTH_STATUSES,
  COVERAGE_NEVER_PROVEN,
  COVERAGE_STALE,
  DISMISSED_ATTENTION,
  FACT_CONVERGENCE_DECISIONS,
  HEADLINE_DISMISSAL_BASES,
  HEALTHY_KNOWN_METRIC,
  INCOMPLETE_CAPTURE,
  INFORMATIONAL_ATTENTION,
  MATERIALITY_WITHHOLDINGS,
  MATERIALITY_WITHHOLDING_LABELS,
  MATERIALITY_WITHHOLDING_NEXT_ACTIONS,
  NOTHING_KNOWN_YET,
  NOTHING_NEEDS_ATTENTION,
  OBSERVATION_SOURCES,
  PRIORITY_STATES,
  PRODUCT_STATES,
  PROVIDER_FACT_CONFLICT,
  RECONCILIATION_STATES,
  RECOVERY_ISSUE,
  UNDECLARED_GAP,
  UNKNOWN_FACT,
  WITHHELD_METRIC,
  WITHHELD_METRIC_AWAITING,
  headlineTone,
  isHeadlineOpen,
} from '../src/index';

test('all ten required product states are named', () => {
  assert.deepEqual([...PRODUCT_STATES].sort(), [
    'ACTION_AWAITING_APPROVAL',
    'HEALTHY_KNOWN_METRIC',
    'HIGH_PRIORITY_ATTENTION',
    'INCOMPLETE_CAPTURE',
    'INFORMATIONAL_ATTENTION',
    'NOTHING_NEEDS_ATTENTION',
    'PROVIDER_FACT_CONFLICT',
    'RECOVERY_ISSUE',
    'UNKNOWN_FACT',
    'WITHHELD_METRIC',
  ]);
});

test('every withholding fixture names a SHIPPED reason that has a label and a next action', () => {
  for (const f of [WITHHELD_METRIC, WITHHELD_METRIC_AWAITING]) {
    assert.ok(MATERIALITY_WITHHOLDINGS.includes(f.withheld), `${f.withheld} is not a shipped reason`);
    assert.ok(MATERIALITY_WITHHOLDING_LABELS[f.withheld], 'and it has a label to render');
    assert.ok(MATERIALITY_WITHHOLDING_NEXT_ACTIONS[f.nextActionKey], 'and something to offer');
  }
  // The two withholding CLASSES read differently on purpose: one is missing
  // configuration, the other is data that has not arrived yet.
  assert.notEqual(WITHHELD_METRIC.displayValue, WITHHELD_METRIC_AWAITING.displayValue);
});

test('every reconciliation fixture names a SHIPPED state', () => {
  for (const f of [INCOMPLETE_CAPTURE, RECOVERY_ISSUE, UNDECLARED_GAP]) {
    assert.ok(RECONCILIATION_STATES.includes(f.reconciliation));
  }
  // INCONCLUSIVE is the only one that impeaches its own numbers.
  assert.equal(INCOMPLETE_CAPTURE.providerIsLowerBound, true);
  assert.equal(RECOVERY_ISSUE.providerIsLowerBound, false);
  assert.equal(UNDECLARED_GAP.providerIsLowerBound, false);
});

test('a conflict fixture leaves the canonical value UNMOVED', () => {
  assert.ok(FACT_CONVERGENCE_DECISIONS.includes(PROVIDER_FACT_CONFLICT.decision));
  assert.equal(PROVIDER_FACT_CONFLICT.decision, 'CONFLICT');
  // appliedAt null IS the meaning of a conflict. A fixture that filled it in would
  // teach a surface that conflicts resolve themselves.
  assert.equal(PROVIDER_FACT_CONFLICT.appliedAt, null);
  assert.notEqual(PROVIDER_FACT_CONFLICT.storedValue, PROVIDER_FACT_CONFLICT.observedValue);
  assert.ok(OBSERVATION_SOURCES.includes(PROVIDER_FACT_CONFLICT.observedVia));
  // No raw provider identity is exposed, even in a fixture.
  assert.match(PROVIDER_FACT_CONFLICT.identityDigest, /^[0-9a-f]{12}$/);
});

test('an unknown fact stays NULL and is never a false', () => {
  assert.equal(UNKNOWN_FACT.storedValue, null);
  assert.equal(UNKNOWN_FACT.decision, 'REMAIN_UNKNOWN');
  assert.ok(FACT_CONVERGENCE_DECISIONS.includes(UNKNOWN_FACT.decision));
  // The whole trap in one assertion: what arrived looks exactly like a settled no.
  assert.equal(UNKNOWN_FACT.observedRaw, '0');
});

test('a known metric still carries what it could not account for', () => {
  assert.notEqual(HEALTHY_KNOWN_METRIC.measurement.currentValue, null);
  assert.ok(HEALTHY_KNOWN_METRIC.limitations.length > 0, 'caveats travel with a good number too');
  assert.equal(headlineTone(HEALTHY_KNOWN_METRIC), 'AGAINST');
  assert.equal(isHeadlineOpen(HEALTHY_KNOWN_METRIC), true);
});

test('an informational item runs WITH the objective and is still first-class', () => {
  assert.equal(headlineTone(INFORMATIONAL_ATTENTION), 'WITH');
  assert.equal(INFORMATIONAL_ATTENTION.measurement.againstObjective, false);
  assert.equal(isHeadlineOpen(INFORMATIONAL_ATTENTION), true);
});

test('a dismissed item is closed, keeps a shipped basis, and keeps recurring', () => {
  assert.equal(isHeadlineOpen(DISMISSED_ATTENTION), false);
  assert.ok(HEADLINE_DISMISSAL_BASES.includes(DISMISSED_ATTENTION.dismissalBasis!));
  assert.ok(DISMISSED_ATTENTION.detectionCount > 1, 'dismissal never suppressed detection');
});

test('a pending action uses the shipped priority vocabulary and drafts nothing', () => {
  assert.ok(PRIORITY_STATES.includes(ACTION_AWAITING_APPROVAL.state));
  assert.equal(ACTION_AWAITING_APPROVAL.requiresHumanApproval, true);
  // Loop does not draft outbound content today, and the fixture must not imply it.
  assert.equal(ACTION_AWAITING_APPROVAL.draftedBody, null);
});

test('coverage fixtures name shipped statuses, and NEVER_PROVEN is null rather than zero', () => {
  for (const c of [COVERAGE_HEALTHY, COVERAGE_STALE, COVERAGE_NEVER_PROVEN]) {
    assert.ok(COVERAGE_HEALTH_STATUSES.includes(c.status));
  }
  assert.equal(COVERAGE_NEVER_PROVEN.completedThrough, null);
  assert.equal(COVERAGE_NEVER_PROVEN.lagMs, null, 'a zero lag would read as up to date');
  assert.ok(COVERAGE_STALE.lagMs! > COVERAGE_HEALTHY.lagMs!);
});

test('THE ALL-CLEAR AND THE LOOK-ALIKE ARE DISTINGUISHABLE', () => {
  // Both have zero open items. Only one of them has any standing to say so, and a
  // surface that renders them identically is the empty state that reads as an
  // all-clear.
  assert.equal(NOTHING_NEEDS_ATTENTION.openAttentionItems, 0);
  assert.equal(NOTHING_KNOWN_YET.openAttentionItems, 0);

  assert.ok(NOTHING_NEEDS_ATTENTION.objectivesMeasured > 0);
  assert.equal(NOTHING_NEEDS_ATTENTION.objectivesWithheld, 0);
  assert.equal(NOTHING_NEEDS_ATTENTION.coverage.status, 'HEALTHY');
  assert.notEqual(NOTHING_NEEDS_ATTENTION.reconciliationThrough, '');

  assert.equal(NOTHING_KNOWN_YET.objectivesMeasured, 0);
  assert.ok(NOTHING_KNOWN_YET.objectivesWithheld > 0);
  assert.equal(NOTHING_KNOWN_YET.coverage.status, 'NEVER_PROVEN');
});

test('no fixture invents a briefing narrative or a confidence score', () => {
  // Loop has no LLM today. A fixture carrying generated prose would teach a
  // surface to display something that will never arrive.
  const json = JSON.stringify([
    HEALTHY_KNOWN_METRIC, INFORMATIONAL_ATTENTION, ACTION_AWAITING_APPROVAL,
    WITHHELD_METRIC, INCOMPLETE_CAPTURE, PROVIDER_FACT_CONFLICT, UNKNOWN_FACT,
  ]);
  for (const forbidden of ['confidence', 'narrative', 'summary', 'aiGenerated', 'recommendation']) {
    assert.ok(!json.includes(forbidden), `a fixture invented a ${forbidden}`);
  }
  // `statement` is allowed and is DISPLAY ONLY -- deterministically composed from
  // the numbers beside it, which is what headline.ts already says about it.
  assert.ok(HEALTHY_KNOWN_METRIC.statement.includes('41.2%'));
});

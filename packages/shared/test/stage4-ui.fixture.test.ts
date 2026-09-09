// The Stage 4 fixtures are the real contracts, or they are worth nothing.
//
// WHAT THESE PROVE
//
// EVERY GOVERNED VALUE IS A REAL SHIPPED VOCABULARY MEMBER. Not a string that
// looks like one. A fixture describing a state the engines cannot produce would
// teach a surface to render something that will never arrive, and that mistake
// is only discovered after the screens are built.
//
// THE ATTENTION FIXTURES ARE PRODUCED BY THE REAL ASSESSOR. A hand-written
// all-clear could claim a state the rule would never produce — which is the one
// thing a fixture for this contract must not be able to do.
//
// NOTHING HERE PROMISES WHAT THE BACKEND CANNOT DELIVER. No confidence
// percentage, no causal claim, no escalation recipient, no executed sequence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ATTENTION_STATES,
  DEPENDENCY_KINDS,
  MONITORING_INSUFFICIENCIES,
  MONITORING_VERDICTS,
  PATTERN_MATURITIES,
  READINESS_OUTCOMES,
  READINESS_WITHHOLDINGS,
  SLA_STATES,
  WAIT_REASONS,
  WORK_EXECUTION_STATES,
  OPERATIONAL_OUTCOMES,
  CASE_CONTRIBUTIONS,
  STAGE4_UI_STATES,
  STAGE4_FIXTURE_RULE_VERSIONS,
  MORNING_ALL_CLEAR,
  MORNING_CANT_TELL,
  MORNING_NEEDS_ATTENTION,
  MORNING_NOTHING_TO_CHECK,
  WORK_IN_PROGRESS,
  WORK_BLOCKED,
  WORK_ESCALATION_ELIGIBLE,
  WORK_NOT_MEASURED,
  WORK_REFERENCE_DANGLING,
  MONITORING_INCONCLUSIVE,
  MONITORING_HELD,
  MONITORING_IN_PROGRESS,
  MONITORING_PLAN,
  OUTCOME_RECOVERED_NO_CAUSE,
  OUTCOME_UNESTABLISHED,
  PATTERN_OBSERVATION,
  PATTERN_EMERGING,
  assessAttention,
  isAllClear,
  productLabel,
} from '../src/index';

const SRC = readFileSync(new URL('../src/stage4-ui.fixture.ts', import.meta.url), 'utf8');
const inVocab = (v: string, list: readonly string[]) => list.includes(v);

// --- 1. Every governed value is real ---------------------------------------------------

test('1. every attention state is a shipped member', () => {
  for (const a of [MORNING_ALL_CLEAR, MORNING_CANT_TELL, MORNING_NEEDS_ATTENTION, MORNING_NOTHING_TO_CHECK]) {
    assert.ok(inVocab(a.state, ATTENTION_STATES), a.state);
  }
});

test('1b. every readiness outcome and withholding is a shipped member', () => {
  const all = [MORNING_ALL_CLEAR, MORNING_CANT_TELL, MORNING_NEEDS_ATTENTION, MORNING_NOTHING_TO_CHECK];
  for (const a of all) {
    for (const o of a.unmeasurable) {
      assert.ok(o.readiness === null || inVocab(o.readiness, READINESS_OUTCOMES), String(o.readiness));
      for (const w of o.withholdings) {
        assert.ok(inVocab(w, READINESS_WITHHOLDINGS), w);
      }
    }
  }
});

test('1c. every execution state, SLA state and wait reason is a shipped member', () => {
  for (const v of [WORK_IN_PROGRESS, WORK_BLOCKED, WORK_ESCALATION_ELIGIBLE, WORK_NOT_MEASURED, WORK_REFERENCE_DANGLING]) {
    for (const w of v.work) {
      if (!w.execution) continue;
      assert.ok(inVocab(w.execution.state, WORK_EXECUTION_STATES), w.execution.state);
      assert.ok(inVocab(w.execution.sla, SLA_STATES), w.execution.sla);
      if (w.execution.waiting) assert.ok(inVocab(w.execution.waiting.reason, WAIT_REASONS));
      for (const b of w.blockers) assert.ok(inVocab(b.kind, DEPENDENCY_KINDS), b.kind);
    }
    for (const ask of v.asks) assert.ok(inVocab(ask.contribution, CASE_CONTRIBUTIONS), ask.contribution);
  }
});

test('1d. every monitoring verdict, insufficiency and outcome is a shipped member', () => {
  for (const m of [MONITORING_INCONCLUSIVE, MONITORING_HELD, MONITORING_IN_PROGRESS]) {
    assert.ok(inVocab(m.verdict, MONITORING_VERDICTS), m.verdict);
    if (m.insufficiency) assert.ok(inVocab(m.insufficiency, MONITORING_INSUFFICIENCIES), m.insufficiency);
  }
  for (const o of [OUTCOME_RECOVERED_NO_CAUSE, OUTCOME_UNESTABLISHED]) {
    if (o.outcome) assert.ok(inVocab(o.outcome, OPERATIONAL_OUTCOMES), o.outcome);
    if (o.lineage.monitoringVerdict) assert.ok(inVocab(o.lineage.monitoringVerdict, MONITORING_VERDICTS));
  }
  for (const p of [PATTERN_OBSERVATION, PATTERN_EMERGING]) {
    assert.ok(inVocab(p.maturity, PATTERN_MATURITIES), p.maturity);
  }
});

test('1e. every governed state in a fixture has a human label', () => {
  // A fixture state with no product label is a state a designer would meet on
  // screen as a raw enum. Catching it here is cheaper than catching it in review.
  const states: string[] = [
    ...[MORNING_ALL_CLEAR, MORNING_CANT_TELL, MORNING_NEEDS_ATTENTION, MORNING_NOTHING_TO_CHECK].map((a) => a.state),
    ...[WORK_IN_PROGRESS, WORK_BLOCKED, WORK_ESCALATION_ELIGIBLE, WORK_NOT_MEASURED]
      .flatMap((v) => v.work.flatMap((w) => (w.execution ? [w.execution.state, w.execution.sla] : []))),
    ...[MONITORING_INCONCLUSIVE, MONITORING_HELD, MONITORING_IN_PROGRESS].map((m) => m.verdict),
    ...[MORNING_CANT_TELL].flatMap((a) => a.unmeasurable.flatMap((o) => o.withholdings)),
  ];
  for (const s of states) {
    const label = productLabel(s);
    assert.ok(label, `${s} has no product label`);
    assert.equal(label!.from, s, `${s} keeps its governed name`);
  }
});

// --- 2. The attention fixtures come from the real rule ------------------------------------

test('2. the all-clear fixture is one the rule actually produces', () => {
  assert.equal(MORNING_ALL_CLEAR.state, 'ALL_CLEAR');
  assert.equal(isAllClear(MORNING_ALL_CLEAR), true);
  assert.deepEqual(MORNING_ALL_CLEAR.notKnown, [], 'an all-clear carries no caveats');
  assert.equal(MORNING_ALL_CLEAR.objectivesConsidered, MORNING_ALL_CLEAR.objectivesMeasurable);
});

test('2b. no fixture produces an all-clear from an empty Headline list alone', () => {
  // THE CENTRAL PROPERTY, checked on the fixtures themselves. Three of the four
  // mornings have zero Headlines and only ONE of them is an all-clear.
  const zeroHeadline = [MORNING_ALL_CLEAR, MORNING_CANT_TELL, MORNING_NOTHING_TO_CHECK];
  for (const a of zeroHeadline) assert.equal(a.headlineCount, 0);
  assert.deepEqual(zeroHeadline.map(isAllClear), [true, false, false]);
});

test('2c. the can\'t-tell fixture names what it could not measure', () => {
  assert.equal(MORNING_CANT_TELL.state, 'INSUFFICIENT_COVERAGE');
  assert.equal(MORNING_CANT_TELL.unmeasurable.length, 3);
  assert.ok(MORNING_CANT_TELL.notKnown[0]?.includes('3 of 6'));
  // Three DIFFERENT reasons, because they lead to three different next moves.
  const outcomes = new Set(MORNING_CANT_TELL.unmeasurable.map((o) => o.readiness));
  assert.equal(outcomes.size, 3, 'waiting, not-set-up and conflicting are all represented');
});

test('2d. an empty organization is not a healthy one', () => {
  assert.equal(MORNING_NOTHING_TO_CHECK.state, 'NOTHING_TO_CHECK');
  assert.equal(isAllClear(MORNING_NOTHING_TO_CHECK), false);
});

test('2e. attention with a Headline still reports the coverage gap', () => {
  assert.equal(MORNING_NEEDS_ATTENTION.state, 'NEEDS_ATTENTION');
  assert.equal(MORNING_NEEDS_ATTENTION.notKnown.length, 1);
});

// --- 3. Nothing promises what the backend cannot deliver ------------------------------------

test('3. no fixture carries a causal claim', () => {
  for (const o of [OUTCOME_RECOVERED_NO_CAUSE, OUTCOME_UNESTABLISHED]) {
    assert.equal(o.causalClaim, null);
    assert.ok(o.causalCaveat.includes('cannot say'));
    for (const verb of ['caused', 'because', 'led to', 'resulted in']) {
      assert.equal(o.statement.toLowerCase().includes(verb), false, `"${o.statement}" must not say "${verb}"`);
    }
  }
});

test('3b. no fixture names an escalation recipient', () => {
  // The fixture the escalation screen has to be built against: eligible, and no
  // destination. A design that assumed one would be un-shippable.
  const escalating = WORK_ESCALATION_ELIGIBLE.work[0]!.execution!;
  assert.equal(escalating.escalationEligible, true);
  assert.equal(escalating.escalationDestinationUserId, null);
  for (const v of [WORK_IN_PROGRESS, WORK_BLOCKED, WORK_NOT_MEASURED, WORK_ESCALATION_ELIGIBLE]) {
    for (const w of v.work) {
      assert.equal(w.execution?.escalationDestinationUserId ?? null, null);
    }
  }
});

test('3c. no fixture invents a confidence percentage or a score', () => {
  for (const forbidden of [/\bconfidence\s*:/i, /\bscore\s*:/i, /\bprobability\s*:/i, /\blikelihood\s*:/i]) {
    assert.equal(forbidden.test(SRC), false, `fixtures must not contain ${forbidden}`);
  }
});

test('3d. unmeasured work is UNKNOWN, and never labelled healthy', () => {
  const exec = WORK_NOT_MEASURED.work[0]!.execution!;
  assert.equal(exec.sla, 'UNKNOWN');
  assert.equal(productLabel('UNKNOWN')?.label, 'Not measured');
  assert.notEqual(productLabel('UNKNOWN')?.label, productLabel('WITHIN_POLICY')?.label);
  assert.equal(WORK_NOT_MEASURED.notKnown.length, 1);
});

test('3e. an inconclusive monitor is not a successful one', () => {
  assert.equal(MONITORING_INCONCLUSIVE.verdict, 'INCONCLUSIVE');
  assert.equal(MONITORING_INCONCLUSIVE.measured, null);
  assert.deepEqual(MONITORING_INCONCLUSIVE.evidenceIds, []);
  assert.notEqual(productLabel('INCONCLUSIVE')?.label, productLabel('HELD')?.label);
});

test('3f. a pattern never claims doctrine', () => {
  for (const p of [PATTERN_OBSERVATION, PATTERN_EMERGING]) {
    assert.notEqual(p.maturity, 'ESTABLISHED_OPERATING_PATTERN');
    assert.ok(p.cannotConclude.some((l) => l.includes('decision a person takes')));
    assert.ok(p.cannotConclude.some((l) => l.includes('does not say what caused what')));
  }
});

// --- 4. Coverage of the states a surface must render -----------------------------------------

test('4. the catalogue covers every state the brief names', () => {
  const names = Object.keys(STAGE4_UI_STATES);
  for (const required of [
    'Morning · all clear', "Morning · can't tell", 'Morning · needs attention', 'Morning · nothing to check',
    'Work · blocked', 'Work · escalation eligible, no recipient', 'Work · never measured',
    'Monitoring · inconclusive', 'Monitoring · held',
    'Outcome · recovered, cause not established',
    'Learning · one observation', 'Learning · emerging pattern',
  ]) {
    assert.ok(names.includes(required), `catalogue is missing "${required}"`);
  }
  assert.equal(names.length, 16);
});

test('4b. the fixtures name the rule versions they were written against', () => {
  // A fixture written against an older rule is a fixture that quietly describes
  // a system that no longer exists.
  for (const [k, v] of Object.entries(STAGE4_FIXTURE_RULE_VERSIONS)) {
    assert.ok(typeof v === 'string' && v.length > 0, k);
  }
  assert.equal(STAGE4_FIXTURE_RULE_VERSIONS.attention, MORNING_ALL_CLEAR.ruleVersion);
  assert.equal(STAGE4_FIXTURE_RULE_VERSIONS.monitoring, MONITORING_HELD.ruleVersion);
  assert.equal(STAGE4_FIXTURE_RULE_VERSIONS.coordination, WORK_IN_PROGRESS.ruleVersion);
});

test('4c. a monitoring plan declares success and failure BEFORE the answer', () => {
  assert.ok(MONITORING_PLAN.plannedAt < MONITORING_PLAN.observationEnd);
  assert.ok(MONITORING_PLAN.success.statement.length > 0);
  assert.ok(MONITORING_PLAN.failure.statement.length > 0);
  assert.notEqual(MONITORING_PLAN.success.comparison, MONITORING_PLAN.failure.comparison);
  assert.ok(MONITORING_PLAN.requires.minimumObservations > 0);
});

// --- 5. It is a design aid, not a production source -------------------------------------------

test('5. no production module imports the Stage 4 fixtures', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = new URL('../src/', import.meta.url);
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.includes('fixture') || file === 'index.ts') continue;
    const src = readFileSync(new URL(file, dir), 'utf8');
    assert.equal(
      src.includes('stage4-ui.fixture'),
      false,
      `${file} must not import the fixtures`,
    );
  }
});

test('5b. the fixtures import the real contracts rather than redeclaring them', () => {
  // A parallel fake UI schema would compile forever while production drifted
  // away from it. These are typed as the shipped views, so a contract change
  // breaks this file — which is the entire point of having it.
  assert.ok(SRC.includes("from './index'"));
  assert.ok(SRC.includes('AttentionAssessment'));
  assert.ok(SRC.includes('CaseCoordinationView'));
  assert.ok(SRC.includes('CaseOutcomeView'));
  // And the all-clear is produced, not asserted.
  assert.ok(SRC.includes('assessAttention({'));
  assert.equal(/interface [A-Z]/.test(SRC), false, 'declares no types of its own');
});

test('5c. the fixture attention states match a fresh run of the rule', () => {
  // Belt and braces: re-derive one from its inputs and compare. If the rule
  // changes, the fixture changes with it or this fails.
  const fresh = assessAttention({ objectives: [], headlineCount: 0 });
  assert.deepEqual(fresh, MORNING_NOTHING_TO_CHECK);
});

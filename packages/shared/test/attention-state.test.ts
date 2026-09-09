// "Nothing needs your attention" and "I can't tell" — and never confusing them.
//
// WHAT THESE PROVE
//
// ABSENCE OF HEADLINES ALONE CANNOT PRODUCE AN ALL-CLEAR. An empty list has two
// causes: Loop looked at everything and found nothing, or Loop had nothing to
// look at. One is good news and one is an outage.
//
// ONE UNMEASURABLE OBJECTIVE IS ENOUGH. Not most, not a majority — one place a
// problem could be sitting unseen.
//
// AN EMPTY ORGANIZATION IS NOT A HEALTHY ONE. Zero objectives trivially has
// complete coverage of nothing.
//
// AN ALL-CLEAR CARRIES NO CAVEATS. If `notKnown` is non-empty it is not an
// all-clear, and that is enforced rather than documented.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTENTION_LANGUAGE,
  ATTENTION_RULE_VERSION,
  ATTENTION_STATES,
  assessAttention,
  isAllClear,
  type ObjectiveCoverage,
} from '../src/index';

const ready = (id: string): ObjectiveCoverage => ({
  performanceObjectiveId: id, objectiveTitle: `Objective ${id}`, readiness: 'READY', withholdings: [],
});
const notReady = (id: string, outcome: 'NOT_READY' | 'CONFIG_ERROR' | 'INCONCLUSIVE' = 'NOT_READY'): ObjectiveCoverage => ({
  performanceObjectiveId: id, objectiveTitle: `Objective ${id}`, readiness: outcome, withholdings: ['WINDOW_NOT_OBSERVED'],
});
const noVerdict = (id: string): ObjectiveCoverage => ({
  performanceObjectiveId: id, objectiveTitle: `Objective ${id}`, readiness: null, withholdings: [],
});

// --- 1. The property this file exists for ------------------------------------------

test('1. no Headlines plus full coverage is ALL_CLEAR', () => {
  const a = assessAttention({ objectives: [ready('a'), ready('b')], headlineCount: 0 });
  assert.equal(a.state, 'ALL_CLEAR');
  assert.equal(isAllClear(a), true);
  assert.equal(a.objectivesConsidered, 2);
  assert.equal(a.objectivesMeasurable, 2);
  // IT NAMES WHAT IT CHECKED. An all-clear that does not say what it looked at
  // is indistinguishable from one that looked at nothing.
  assert.ok(a.statement.includes('2 active objectives'));
});

test('1b. no Headlines plus ONE unmeasurable objective is NOT an all-clear', () => {
  // THE CENTRAL ASSERTION. One objective Loop could not see is one place a
  // problem could be sitting.
  const a = assessAttention({ objectives: [ready('a'), ready('b'), notReady('c')], headlineCount: 0 });
  assert.equal(a.state, 'INSUFFICIENT_COVERAGE');
  assert.equal(isAllClear(a), false);
  assert.ok(a.statement.includes("can't determine"));
  assert.ok(a.notKnown[0]?.includes('Objective c'), 'named, so the gap is actionable');
});

test('1c. an objective with NO verdict at all counts as unmeasurable', () => {
  // A caller that could not obtain a verdict has not shown the objective was
  // measurable, and null must never read as READY.
  const a = assessAttention({ objectives: [ready('a'), noVerdict('b')], headlineCount: 0 });
  assert.equal(a.state, 'INSUFFICIENT_COVERAGE');
  assert.equal(a.objectivesMeasurable, 1);
});

test('1d. every non-READY outcome blocks the all-clear', () => {
  for (const outcome of ['NOT_READY', 'CONFIG_ERROR', 'INCONCLUSIVE'] as const) {
    const a = assessAttention({ objectives: [notReady('a', outcome)], headlineCount: 0 });
    assert.equal(a.state, 'INSUFFICIENT_COVERAGE', outcome);
  }
});

// --- 2. The other two states ---------------------------------------------------------

test('2. a Headline outranks everything, including a coverage gap', () => {
  // A Headline exists only when Stage 3 already said its measurement was ready,
  // so its presence is never in doubt.
  const a = assessAttention({ objectives: [ready('a'), notReady('b')], headlineCount: 3 });
  assert.equal(a.state, 'NEEDS_ATTENTION');
  assert.ok(a.statement.includes('3 things'));
  // AND THE GAP IS STILL REPORTED. Acting on one Headline should not hide that
  // an objective went unmeasured.
  assert.equal(a.notKnown.length, 1);
});

test('2b. an empty organization is NOTHING_TO_CHECK, never ALL_CLEAR', () => {
  // Zero objectives trivially has complete coverage of nothing, and calling that
  // all-clear would be the most literal possible way to be wrong.
  const a = assessAttention({ objectives: [], headlineCount: 0 });
  assert.equal(a.state, 'NOTHING_TO_CHECK');
  assert.equal(isAllClear(a), false);
  assert.ok(a.statement.includes('nothing to check'));
});

test('2c. the four states are distinct and exhaustive', () => {
  assert.equal(ATTENTION_STATES.length, 4);
  const seen = new Set([
    assessAttention({ objectives: [ready('a')], headlineCount: 1 }).state,
    assessAttention({ objectives: [ready('a')], headlineCount: 0 }).state,
    assessAttention({ objectives: [notReady('a')], headlineCount: 0 }).state,
    assessAttention({ objectives: [], headlineCount: 0 }).state,
  ]);
  assert.equal(seen.size, 4, 'every state is reachable');
});

// --- 3. An all-clear carries no caveats ------------------------------------------------

test('3. ALL_CLEAR is the only state with an empty notKnown, and it always is', () => {
  const clear = assessAttention({ objectives: [ready('a')], headlineCount: 0 });
  assert.deepEqual(clear.notKnown, []);

  for (const input of [
    { objectives: [notReady('a')], headlineCount: 0 },
    { objectives: [], headlineCount: 0 },
    { objectives: [notReady('a')], headlineCount: 2 },
  ]) {
    const a = assessAttention(input);
    assert.ok(a.notKnown.length > 0, `${a.state} carries what it could not establish`);
  }
});

test('3b. isAllClear is the only correct test, and the tempting one is wrong', () => {
  // `state !== 'NEEDS_ATTENTION'` is true for INSUFFICIENT_COVERAGE and
  // NOTHING_TO_CHECK. A surface using it would render an unmeasured morning as a
  // clean one, which is the defect this whole file prevents.
  const unmeasured = assessAttention({ objectives: [notReady('a')], headlineCount: 0 });
  assert.equal(unmeasured.state !== 'NEEDS_ATTENTION', true, 'the tempting comparison passes');
  assert.equal(isAllClear(unmeasured), false, 'and the correct one does not');
});

// --- 4. Determinism and product language --------------------------------------------------

test('4. the assessment is deterministic and versioned', () => {
  const input = { objectives: [ready('a'), notReady('b')], headlineCount: 0 };
  assert.deepEqual(assessAttention(input), assessAttention(input));
  assert.equal(assessAttention(input).ruleVersion, ATTENTION_RULE_VERSION);
});

test('4b. INSUFFICIENT_COVERAGE is never labelled "all clear"', () => {
  // The whole reason the two states are separate survives the last step, where
  // it would be easiest to lose.
  assert.equal(ATTENTION_LANGUAGE.INSUFFICIENT_COVERAGE.label, "Can't tell");
  assert.notEqual(ATTENTION_LANGUAGE.INSUFFICIENT_COVERAGE.label, ATTENTION_LANGUAGE.ALL_CLEAR.label);
  assert.equal(ATTENTION_LANGUAGE.ALL_CLEAR.label, 'All clear');
  for (const state of ATTENTION_STATES) {
    assert.equal(ATTENTION_LANGUAGE[state].from, state, 'every label carries its governed state');
  }
});

test('4c. more than three unmeasurable objectives are summarised, not truncated silently', () => {
  const a = assessAttention({
    objectives: [notReady('a'), notReady('b'), notReady('c'), notReady('d'), notReady('e')],
    headlineCount: 0,
  });
  assert.ok(a.notKnown[0]?.includes('and 2 more'), a.notKnown[0]);
  assert.equal(a.unmeasurable.length, 5, 'and the full list is still carried');
});

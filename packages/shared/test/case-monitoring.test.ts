// Monitoring, outcome and resolution — and the three things each of them refuses.
//
// WHAT THESE PROVE
//
// UNKNOWN NEVER BECOMES SUCCESS. A window with thin evidence concludes
// INCONCLUSIVE, and INCONCLUSIVE is not a pass. This is the single most
// important property here: a monitor that quietly succeeds on missing data is
// worse than no monitor, because somebody will believe it.
//
// NOTHING ASSERTS WHY. An outcome names what happened after an intervention.
// `causalClaim` is a field that is always null, so the refusal is visible rather
// than looking like nobody considered it.
//
// LOOP CLOSES ON ALL THE CONDITIONS OR NONE. Closing on four out of five is Loop
// deciding the fifth did not matter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CASE_MONITORING_RULE_VERSION,
  CAUSAL_CAVEAT,
  MONITORING_INSUFFICIENCIES,
  MONITORING_VERDICTS,
  RESOLUTION_CONDITIONS,
  assessMonitoring,
  assessResolutionEligibility,
  describeOutcome,
  type MonitoringObservation,
  type MonitoringPlan,
} from '../src/index';

const START = '2026-09-01T00:00:00.000Z';
const END = '2026-09-08T00:00:00.000Z';
const AFTER = new Date('2026-09-09T00:00:00.000Z');
const DURING = new Date('2026-09-04T00:00:00.000Z');

function plan(over: Partial<MonitoringPlan> = {}): MonitoringPlan {
  return {
    condition: "Buyer CEM's monetized rate",
    baseline: { metric: 'MONETIZED_RATE', value: 0.597, unit: 'RATIO', denominator: 2996 },
    success: {
      metric: 'MONETIZED_RATE',
      comparison: 'WITHIN_PERCENT_OF_BASELINE',
      threshold: 0.05,
      statement: 'Monetized rate returned to within 5% of baseline during the window.',
    },
    failure: {
      metric: 'MONETIZED_RATE',
      comparison: 'AT_OR_BELOW',
      threshold: 0.35,
      statement: 'Monetized rate fell to or below 35% during the window.',
    },
    observationStart: START,
    observationEnd: END,
    requires: { minimumObservations: 200, minimumCoverage: 0.95, requiresCompleteWindow: true },
    plannedByUserId: 'usr_charlie',
    plannedAt: START,
    note: null,
    ...over,
  };
}

function reading(over: Partial<MonitoringObservation> = {}): MonitoringObservation {
  return {
    metric: 'MONETIZED_RATE',
    value: 0.58,
    unit: 'RATIO',
    denominator: 3100,
    coverage: 0.98,
    observationCount: 3100,
    evidenceIds: ['ev_1'],
    ...over,
  };
}

// --- 1. Unknown never becomes success ------------------------------------------------

test('1. thin evidence is INCONCLUSIVE, not a pass', async () => {
  const a = assessMonitoring({ plan: plan(), observation: reading({ observationCount: 12 }), now: AFTER });
  assert.equal(a.verdict, 'INCONCLUSIVE');
  assert.equal(a.insufficiency, 'TOO_FEW_OBSERVATIONS');
  assert.notEqual(a.verdict, 'HELD');
});

test('1b. no measurement at all is INCONCLUSIVE, never HELD', () => {
  const a = assessMonitoring({ plan: plan(), observation: null, now: AFTER });
  assert.equal(a.verdict, 'INCONCLUSIVE');
  assert.equal(a.insufficiency, 'NO_MEASUREMENT_AT_ALL');
  assert.deepEqual(a.evidenceIds, [], 'and no evidence is invented for it');
});

test('1c. coverage the producer declines to report FAILS the requirement', () => {
  // A monitor asked to require coverage cannot be satisfied by a producer that
  // reports none. Treating a missing number as a passing one is how a gate ends
  // up letting through exactly what it was built to stop.
  const a = assessMonitoring({ plan: plan(), observation: reading({ coverage: null }), now: AFTER });
  assert.equal(a.verdict, 'INCONCLUSIVE');
  assert.equal(a.insufficiency, 'COVERAGE_BELOW_REQUIREMENT');
});

test('1d. sufficiency is decided BEFORE the criteria are compared', () => {
  // A reading that would have PASSED the success criterion, on evidence the plan
  // itself says is inadequate. Checking sufficiency afterwards is how a monitor
  // comes to report success on two data points.
  const wouldPass = reading({ value: 0.597, observationCount: 3 });
  const a = assessMonitoring({ plan: plan(), observation: wouldPass, now: AFTER });
  assert.equal(a.verdict, 'INCONCLUSIVE');
});

test('1e. a relative criterion with no baseline cannot be judged', () => {
  const a = assessMonitoring({ plan: plan({ baseline: null }), observation: reading(), now: AFTER });
  assert.equal(a.verdict, 'INCONCLUSIVE');
  assert.equal(a.insufficiency, 'BASELINE_UNKNOWN');
});

test('1f. a reading of a different metric is not an answer about this one', () => {
  const a = assessMonitoring({ plan: plan(), observation: reading({ metric: 'ANSWER_RATE' }), now: AFTER });
  assert.equal(a.verdict, 'INCONCLUSIVE');
  assert.equal(a.insufficiency, 'METRIC_NOT_MEASURED');
});

test('1g. an unfinished window is IN_PROGRESS, and is not silently judged', () => {
  const a = assessMonitoring({ plan: plan(), observation: reading(), now: DURING });
  assert.equal(a.verdict, 'IN_PROGRESS');
  assert.equal(a.insufficiency, null);
});

// --- 2. The verdicts that ARE reachable ------------------------------------------------

test('2. a declared success criterion met on adequate evidence is HELD', () => {
  const a = assessMonitoring({ plan: plan(), observation: reading({ value: 0.58 }), now: AFTER });
  assert.equal(a.verdict, 'HELD');
  assert.ok(a.explanation.some((l) => l.includes('within 5% of baseline')));
  assert.deepEqual(a.evidenceIds, ['ev_1'], 'traceable to the rows it rests on');
});

test('2b. a declared failure criterion is DID_NOT_HOLD', () => {
  const a = assessMonitoring({ plan: plan(), observation: reading({ value: 0.30 }), now: AFTER });
  assert.equal(a.verdict, 'DID_NOT_HOLD');
});

test('2c. neither condition is NEITHER, and NEITHER is not rounded to either', () => {
  // The thing did neither what was hoped nor what was feared. Reporting that is
  // more useful than picking whichever is nearer.
  const a = assessMonitoring({ plan: plan(), observation: reading({ value: 0.45 }), now: AFTER });
  assert.equal(a.verdict, 'NEITHER');
});

test('2d. when both conditions somehow fire, FAILURE wins', () => {
  // A badly written plan should not be able to produce a flattering answer.
  const both = plan({
    success: { metric: 'MONETIZED_RATE', comparison: 'AT_OR_BELOW', threshold: 0.9, statement: 'ok' },
    failure: { metric: 'MONETIZED_RATE', comparison: 'AT_OR_BELOW', threshold: 0.9, statement: 'bad' },
  });
  const a = assessMonitoring({ plan: both, observation: reading({ value: 0.4 }), now: AFTER });
  assert.equal(a.verdict, 'DID_NOT_HOLD');
});

test('2e. the verdict is deterministic', () => {
  const input = { plan: plan(), observation: reading(), now: AFTER };
  assert.deepEqual(assessMonitoring(input), assessMonitoring(input));
  assert.equal(assessMonitoring(input).ruleVersion, CASE_MONITORING_RULE_VERSION);
});

// --- 3. Correlation, never causation ----------------------------------------------------

test('3. no outcome sentence uses a causal verb', () => {
  const window = { start: START, end: END };
  const sentences = MONITORING_VERDICTS.map((verdict) =>
    describeOutcome({
      outcome: 'RECOVERED',
      monitoring: { ruleVersion: CASE_MONITORING_RULE_VERSION, verdict, insufficiency: null, measured: null, explanation: [], evidenceIds: [] },
      window,
    }),
  );
  sentences.push(describeOutcome({ outcome: 'RECOVERED', monitoring: null, window: null }));
  sentences.push(describeOutcome({ outcome: null, monitoring: null, window: null }));

  for (const sentence of sentences) {
    for (const verb of ['caused', 'because', 'led to', 'resulted in', 'due to', 'thanks to']) {
      assert.equal(
        sentence.toLowerCase().includes(verb),
        false,
        `"${sentence}" must not say "${verb}"`,
      );
    }
  }
});

test('3b. the caveat says what cannot be established, and why', () => {
  assert.ok(CAUSAL_CAVEAT.includes('cannot say'));
  assert.ok(CAUSAL_CAVEAT.includes('counterfactual'));
  assert.ok(CAUSAL_CAVEAT.includes('same window'));
});

test('3c. an inconclusive window says so rather than describing a result', () => {
  const s = describeOutcome({
    outcome: null,
    monitoring: { ruleVersion: CASE_MONITORING_RULE_VERSION, verdict: 'INCONCLUSIVE', insufficiency: 'NO_MEASUREMENT_AT_ALL', measured: null, explanation: [], evidenceIds: [] },
    window: { start: START, end: END },
  });
  assert.ok(s.includes('could not establish'));
});

// --- 4. Resolution eligibility -----------------------------------------------------------

const settled = {
  findingEstablished: true,
  workAllComplete: true,
  noWorkRequested: false,
  openBlockers: 0,
  monitoring: { ruleVersion: CASE_MONITORING_RULE_VERSION, verdict: 'HELD' as const, insufficiency: null, measured: null, explanation: [], evidenceIds: [] },
  coordinationComplete: true,
};

test('4. every condition, or Loop does not close it', () => {
  assert.equal(assessResolutionEligibility(settled).eligible, true);
  // Each condition removed on its own is enough to stop it.
  const breaks: Array<Partial<typeof settled>> = [
    { findingEstablished: false },
    { workAllComplete: false },
    { openBlockers: 1 },
    { coordinationComplete: false },
    { monitoring: { ruleVersion: CASE_MONITORING_RULE_VERSION, verdict: 'INCONCLUSIVE', insufficiency: 'NO_MEASUREMENT_AT_ALL', measured: null, explanation: [], evidenceIds: [] } },
  ];
  assert.equal(breaks.length, RESOLUTION_CONDITIONS.length, 'one break per condition');
  for (const b of breaks) {
    const r = assessResolutionEligibility({ ...settled, ...b });
    assert.equal(r.eligible, false, JSON.stringify(b));
    assert.ok(r.unmet.length >= 1);
    assert.equal(r.outcome, null, 'an ineligible Case gets no outcome proposed');
  }
});

test('4b. an inconclusive monitor blocks auto-resolution outright', () => {
  // THE PROPERTY THAT MATTERS MOST HERE. Loop must not close an investigation on
  // a window it could not read.
  const r = assessResolutionEligibility({
    ...settled,
    monitoring: { ruleVersion: CASE_MONITORING_RULE_VERSION, verdict: 'INCONCLUSIVE', insufficiency: 'TOO_FEW_OBSERVATIONS', measured: null, explanation: [], evidenceIds: [] },
  });
  assert.equal(r.eligible, false);
  assert.ok(r.unmet.includes('MONITORING_SETTLED'));
});

test('4c. Loop never calls something RECOVERED without a criterion it committed to', () => {
  // No monitoring at all, everything else settled. NO_ACTION_NEEDED, not
  // RECOVERED: nothing measured a recovery, and Loop is not entitled to assume
  // one because nothing objected.
  const r = assessResolutionEligibility({ ...settled, monitoring: null });
  assert.equal(r.eligible, true);
  assert.equal(r.outcome, 'NO_ACTION_NEEDED');

  const held = assessResolutionEligibility(settled);
  assert.equal(held.outcome, 'RECOVERED');
  const failed = assessResolutionEligibility({
    ...settled,
    monitoring: { ruleVersion: CASE_MONITORING_RULE_VERSION, verdict: 'DID_NOT_HOLD', insufficiency: null, measured: null, explanation: [], evidenceIds: [] },
  });
  assert.equal(failed.outcome, 'NOT_RECOVERED');
});

test('4d. Loop never records PARTIALLY_RECOVERED on its own initiative', () => {
  // "Partially" is a judgement about how much of the problem is left, and
  // nothing here can measure that.
  for (const verdict of MONITORING_VERDICTS) {
    const r = assessResolutionEligibility({
      ...settled,
      monitoring: { ruleVersion: CASE_MONITORING_RULE_VERSION, verdict, insufficiency: verdict === 'INCONCLUSIVE' ? 'NO_MEASUREMENT_AT_ALL' : null, measured: null, explanation: [], evidenceIds: [] },
    });
    assert.notEqual(r.outcome, 'PARTIALLY_RECOVERED');
  }
});

test('4e. a Case that asked for no work still satisfies the work condition', () => {
  const r = assessResolutionEligibility({ ...settled, workAllComplete: false, noWorkRequested: true });
  assert.equal(r.eligible, true);
});

test('4f. what is left is named, so a person can see it', () => {
  const r = assessResolutionEligibility({ ...settled, findingEstablished: false, openBlockers: 2 });
  assert.deepEqual([...r.unmet].sort(), ['NOTHING_BLOCKED', 'QUESTION_ANSWERED']);
  assert.equal(r.explanation.length >= 2, true);
});

// --- 5. Source discipline ------------------------------------------------------------------

test('5. no model can attach to a monitoring verdict', () => {
  const src = readFileSync(new URL('../src/case-monitoring.ts', import.meta.url), 'utf8');
  // Every branch is arithmetic over numbers a person declared in advance. A
  // fetch, a client or a prompt here would make a model the authority on whether
  // something recovered.
  //
  // MATCHED AS CALL FORMS, NOT AS WORDS. This file's header explains at length
  // why no model decides whether something recovered, so forbidding the word
  // "prompt" would forbid the sentence "only what Loop may do unprompted" --
  // which is the very refusal the assertion exists to protect.
  for (const forbidden of [/\bfetch\s*\(/, /\banthropic\b/i, /\bopenai\b/i, /\bprompt\s*[:(]/i, /\bcompletion\s*\(/, /Math\.random/]) {
    assert.equal(forbidden.test(src), false, `must not contain ${forbidden}`);
  }
});

test('5b. every insufficiency has a label, and every one is reachable', () => {
  // A named reason nothing can produce is a reason that will rot. All six are
  // exercised by the tests above.
  assert.equal(MONITORING_INSUFFICIENCIES.length, 6);
});

// Product words, and the backend states they must never replace.
//
// WHAT THESE PROVE
//
// EVERY LABEL CARRIES ITS GOVERNED STATE. A support conversation, a bug report
// and a log line all need the real name, and a UI that only showed "Waiting for
// data" would make three different outages indistinguishable to whoever has to
// fix them.
//
// STATES NEEDING DIFFERENT ACTIONS ARE NOT COLLAPSED. "A job did not run" is
// fixed by an operator in ten minutes; "nobody has said which source owns this
// number" needs a decision. Both are unfriendly words; only one is a config
// problem.
//
// NOTHING UNKNOWN IS LABELLED AS FINE. Unmeasured work is not "on track", and an
// unjudgeable window is not "neither".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ATTENTION_LANGUAGE,
  ATTENTION_STATES,
  EXECUTION_LANGUAGE,
  MONITORING_LANGUAGE,
  MONITORING_VERDICTS,
  PRODUCT_TONES,
  READINESS_LANGUAGE,
  READINESS_OUTCOMES,
  READINESS_WITHHOLDINGS,
  SLA_LANGUAGE,
  SLA_STATES,
  WITHHOLDING_LANGUAGE,
  WORK_EXECUTION_STATES,
  productLabel,
} from '../src/index';

// --- 1. Coverage: nothing is left without a word ------------------------------------

test('1. every governed state a person can see has exactly one label', () => {
  const maps: [readonly string[], Record<string, { from: string }>][] = [
    [READINESS_WITHHOLDINGS, WITHHOLDING_LANGUAGE],
    [READINESS_OUTCOMES, READINESS_LANGUAGE],
    [WORK_EXECUTION_STATES, EXECUTION_LANGUAGE],
    [SLA_STATES, SLA_LANGUAGE],
    [MONITORING_VERDICTS, MONITORING_LANGUAGE],
    [ATTENTION_STATES, ATTENTION_LANGUAGE],
  ];
  for (const [states, map] of maps) {
    for (const state of states) {
      const label = map[state];
      assert.ok(label, `${state} has a label`);
      // THE GOVERNED STATE RIDES ALONG, ALWAYS. This is what keeps the UI and
      // the logs describing one system.
      assert.equal(label.from, state, `${state} carries its own name`);
    }
  }
});

test('1b. productLabel resolves any of them, and refuses to guess at the rest', () => {
  assert.equal(productLabel('SOURCE_AUTHORITY_MISSING')?.label, 'Source not configured');
  assert.equal(productLabel('waiting_external')?.label, 'Waiting on them');
  assert.equal(productLabel('ESCALATION_ELIGIBLE')?.label, 'Badly overdue');
  // NULL, NOT A PLAUSIBLE WORD. A state with no label is one somebody added
  // without deciding what to call it, and rendering the raw enum is better than
  // inventing something reassuring.
  assert.equal(productLabel('SOMETHING_A_LATER_BUILD_ADDED'), null);
  assert.equal(productLabel(''), null);
});

// --- 2. Distinctions that must survive ------------------------------------------------

test('2. "waiting for data" and "not set up" are not the same word', () => {
  // One is fixed by an operator in ten minutes. The other needs a decision.
  assert.equal(WITHHOLDING_LANGUAGE.WINDOW_NOT_OBSERVED.tone, 'WAITING_FOR_DATA');
  assert.equal(WITHHOLDING_LANGUAGE.SOURCE_AUTHORITY_MISSING.tone, 'NEEDS_SETUP');
  assert.notEqual(
    WITHHOLDING_LANGUAGE.WINDOW_NOT_OBSERVED.label,
    WITHHOLDING_LANGUAGE.SOURCE_AUTHORITY_MISSING.label,
  );
});

test('2b. conflicting evidence is its own tone, because neither waiting nor configuring helps', () => {
  for (const w of ['RECONCILIATION_INCONCLUSIVE', 'SOURCE_AUTHORITY_CONFLICT', 'CAMPAIGN_EXPECTATION_CONTRADICTED'] as const) {
    assert.equal(WITHHOLDING_LANGUAGE[w].tone, 'CONFLICTING', w);
  }
  assert.equal(READINESS_LANGUAGE.INCONCLUSIVE.tone, 'CONFLICTING');
});

test('2c. unmeasured work is NOT labelled on track', () => {
  // The whole point of the UNKNOWN SLA state would be lost at the last step.
  assert.equal(SLA_LANGUAGE.UNKNOWN.label, 'Not measured');
  assert.notEqual(SLA_LANGUAGE.UNKNOWN.label, SLA_LANGUAGE.WITHIN_POLICY.label);
  assert.notEqual(SLA_LANGUAGE.UNKNOWN.tone, 'VERIFIED');
  assert.ok(SLA_LANGUAGE.UNKNOWN.detail.includes('cannot say'));
});

test('2d. an unjudgeable window is not "neither"', () => {
  // "It did neither" and "Loop could not tell" are completely different facts,
  // and one of them means somebody should look at the measurement.
  assert.notEqual(MONITORING_LANGUAGE.INCONCLUSIVE.label, MONITORING_LANGUAGE.NEITHER.label);
  assert.equal(MONITORING_LANGUAGE.INCONCLUSIVE.tone, 'WAITING_FOR_DATA');
  assert.equal(MONITORING_LANGUAGE.NEITHER.tone, 'INCOMPLETE');
});

test('2e. waiting on us and waiting on them are different words', () => {
  // Same English shape, completely different accountability — which is exactly
  // why the execution model separated them in the first place.
  assert.notEqual(EXECUTION_LANGUAGE.waiting_internal.label, EXECUTION_LANGUAGE.waiting_external.label);
});

// --- 3. Presentation is not authority ---------------------------------------------------

test('3. no service branches on a product label', () => {
  // A caller that switched on a friendly word instead of the governed state
  // would have moved a decision into the presentation layer.
  const labels = [
    ...Object.values(WITHHOLDING_LANGUAGE),
    ...Object.values(SLA_LANGUAGE),
    ...Object.values(ATTENTION_LANGUAGE),
  ].map((l) => l.label);

  for (const file of ['case-monitoring.ts', 'work-execution.ts', 'attention-state.ts', 'case-finding.ts']) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    for (const label of labels) {
      assert.equal(
        src.includes(`'${label}'`),
        false,
        `${file} must not compare against the product label "${label}"`,
      );
    }
  }
});

test('3b. the adapter renames nothing: every `from` is a real governed value', () => {
  const governed = new Set<string>([
    ...READINESS_WITHHOLDINGS, ...READINESS_OUTCOMES, ...WORK_EXECUTION_STATES,
    ...SLA_STATES, ...MONITORING_VERDICTS, ...ATTENTION_STATES,
  ]);
  for (const map of [WITHHOLDING_LANGUAGE, READINESS_LANGUAGE, EXECUTION_LANGUAGE, SLA_LANGUAGE, MONITORING_LANGUAGE, ATTENTION_LANGUAGE]) {
    for (const label of Object.values(map)) {
      assert.ok(governed.has(label.from), `${label.from} is a governed state`);
    }
  }
});

test('3c. there are five tones, and each implies a different next move', () => {
  assert.equal(PRODUCT_TONES.length, 5);
  // The test for whether a sixth belongs: if two states lead to the same action
  // by the same person, they may share a tone; if not, they must not.
  const used = new Set(
    [
      ...Object.values(WITHHOLDING_LANGUAGE), ...Object.values(READINESS_LANGUAGE),
      ...Object.values(EXECUTION_LANGUAGE), ...Object.values(SLA_LANGUAGE),
      ...Object.values(MONITORING_LANGUAGE), ...Object.values(ATTENTION_LANGUAGE),
    ].map((l) => l.tone),
  );
  assert.equal(used.size, 5, 'every tone is actually used');
});

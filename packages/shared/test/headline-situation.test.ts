// Where a Headline stands: a projection over two authorities, never a state.
//
// WHAT THESE PROVE
//
// EVERY COMBINATION HAS EXACTLY ONE ANSWER, and the answer comes from the two
// records that own the facts: the Headline's own dismissal first, then the
// Case's lane. Nothing is stored, nothing transitions, and the function cannot be
// asked to set anything.
//
// SET ASIDE BEATS A CASE. A person's judgement about THIS Headline stands
// whatever happened in the Decision Center.
//
// RESOLVED REQUIRES THE LANE. An outcome or a close time alone does not make a
// Headline resolved; a reopened Case reads as under investigation again.
//
// THE WORDS ARE GOVERNED, carried with the situation they translate, and kept
// out of the flat lookup so a Headline's RESOLVED never answers for a Case's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CASE_OUTCOME_LANGUAGE,
  CASE_STATE_LANGUAGE,
  HEADLINE_SECTIONS,
  HEADLINE_SITUATIONS,
  HEADLINE_SITUATION_LANGUAGE,
  OPERATIONAL_OUTCOMES,
  PRIORITY_STATES,
  PRODUCT_TONES,
  caseOutcomeLabel,
  headlineAcceptsDecision,
  headlineSection,
  headlineSituation,
  headlineSituationLabel,
  isCurrentSituation,
  isHeadlineSituation,
  productLabel,
  type CaseStandingInput,
  type HeadlineSituation,
  type HeadlineStandingInput,
  type OperationalOutcome,
  type PriorityState,
} from '../src/index';

const OPEN: HeadlineStandingInput = { dismissedAt: null, dismissalBasis: null };
const SET_ASIDE: HeadlineStandingInput = { dismissedAt: '2026-08-23T09:00:00.000Z', dismissalBasis: 'IMMATERIAL' };

const kase = (state: PriorityState, over: Partial<CaseStandingInput> = {}): CaseStandingInput => ({
  state,
  outcome: null,
  resolvedAt: null,
  ...over,
});

// --- 1. Every combination -----------------------------------------------------------------

test('1. the projection answers every combination of the two authorities, and the table is closed', () => {
  const expected: Record<PriorityState, HeadlineSituation> = {
    NEEDS_REVIEW: 'UNDER_INVESTIGATION',
    ASSIGNED: 'UNDER_INVESTIGATION',
    WATCHING: 'UNDER_INVESTIGATION',
    RESOLVED: 'RESOLVED',
    DISMISSED: 'DISMISSED_BY_INVESTIGATION',
  };
  assert.equal(headlineSituation(OPEN, null), 'NEW');
  for (const state of PRIORITY_STATES) {
    assert.equal(headlineSituation(OPEN, kase(state)), expected[state], state);
    // With every combination of the other two lifecycle columns as well.
    for (const outcome of [null, 'RECOVERED', 'NO_ACTION_NEEDED'] as const) {
      for (const resolvedAt of [null, '2026-08-24T10:00:00.000Z']) {
        assert.equal(
          headlineSituation(OPEN, kase(state, { outcome, resolvedAt })),
          expected[state],
          `${state} / ${outcome} / ${resolvedAt}`,
        );
      }
    }
  }
  assert.deepEqual([...HEADLINE_SITUATIONS].sort(), [
    'DISMISSED_BY_INVESTIGATION', 'NEW', 'RESOLVED', 'SET_ASIDE', 'UNDER_INVESTIGATION',
  ]);
  assert.equal(isHeadlineSituation('NEW'), true);
  assert.equal(isHeadlineSituation('ARCHIVED'), false, 'there is no archive');
});

test('1b. SET ASIDE BEATS A CASE, in every lane', () => {
  assert.equal(headlineSituation(SET_ASIDE, null), 'SET_ASIDE');
  for (const state of PRIORITY_STATES) {
    assert.equal(headlineSituation(SET_ASIDE, kase(state, { outcome: 'RECOVERED', resolvedAt: '2026-08-24T10:00:00.000Z' })), 'SET_ASIDE', state);
  }
  // The basis is not what decides it; the dismissal is. A dismissal with no
  // basis (which the repository does not write, but the shape allows) still stands.
  assert.equal(headlineSituation({ dismissedAt: '2026-08-23T09:00:00.000Z', dismissalBasis: null }, kase('ASSIGNED')), 'SET_ASIDE');
});

test('1c. RESOLVED REQUIRES THE LANE: an outcome or a close time alone does not resolve anything', () => {
  // A monitoring Case that has recorded an outcome is still open.
  assert.equal(headlineSituation(OPEN, kase('WATCHING', { outcome: 'RECOVERED', resolvedAt: '2026-08-24T10:00:00.000Z' })), 'UNDER_INVESTIGATION');
  // A reopened Case: the projection returns the lane to NEEDS_REVIEW and keeps
  // the earlier close on the log. It is under investigation again.
  assert.equal(headlineSituation(OPEN, kase('NEEDS_REVIEW', { outcome: 'NOT_RECOVERED', resolvedAt: '2026-08-24T10:00:00.000Z' })), 'UNDER_INVESTIGATION');
  // And a resolved lane with nothing else recorded is still resolved.
  assert.equal(headlineSituation(OPEN, kase('RESOLVED')), 'RESOLVED');
  assert.equal(headlineSituation(OPEN, kase('DISMISSED')), 'DISMISSED_BY_INVESTIGATION');
});

test('1d. the projection is a pure function: same inputs, same answer, no clock and no store', () => {
  const a = headlineSituation(OPEN, kase('ASSIGNED'));
  const b = headlineSituation(OPEN, kase('ASSIGNED'));
  assert.equal(a, b);
  const src = readFileSync(new URL('../src/headline-situation.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const forbidden of ['prisma', 'Date.now', 'new Date', 'fetch(', 'process.env', 'Math.random']) {
    assert.equal(code.includes(forbidden), false, `must not contain ${forbidden}`);
  }
  // NO LIFECYCLE BY DESIGN, said in the header so the next reader hits the
  // tripwire before the migration does.
  assert.match(src, /PROJECTION/);
  assert.match(src, /never a state/i);
  assert.match(src, /no work lifecycle/);
});

// --- 2. Sections and decisions ------------------------------------------------------------

test('2. current, investigating and history are three places in one list, and nothing falls off', () => {
  assert.deepEqual([...HEADLINE_SECTIONS], ['CURRENT', 'INVESTIGATING', 'HISTORY']);
  assert.equal(headlineSection('NEW'), 'CURRENT');
  assert.equal(headlineSection('UNDER_INVESTIGATION'), 'INVESTIGATING');
  for (const s of ['RESOLVED', 'DISMISSED_BY_INVESTIGATION', 'SET_ASIDE'] as const) {
    assert.equal(headlineSection(s), 'HISTORY', s);
  }
  // Every situation lands somewhere. There is no fourth section and no null.
  for (const s of HEADLINE_SITUATIONS) assert.ok(HEADLINE_SECTIONS.includes(headlineSection(s)), s);
});

test('2b. only NEW and UNDER_INVESTIGATION are current, and only NEW takes a decision', () => {
  assert.equal(isCurrentSituation('NEW'), true);
  assert.equal(isCurrentSituation('UNDER_INVESTIGATION'), true);
  for (const s of ['RESOLVED', 'DISMISSED_BY_INVESTIGATION', 'SET_ASIDE'] as const) {
    assert.equal(isCurrentSituation(s), false, s);
  }
  assert.equal(headlineAcceptsDecision('NEW'), true);
  for (const s of HEADLINE_SITUATIONS.filter((x) => x !== 'NEW')) {
    assert.equal(headlineAcceptsDecision(s), false, `${s} offers neither Investigate nor Set aside`);
  }
});

// --- 3. Governed words --------------------------------------------------------------------------

test('3. every situation has exactly one governed label that carries its own name', () => {
  for (const s of HEADLINE_SITUATIONS) {
    const label = headlineSituationLabel(s);
    assert.equal(label, HEADLINE_SITUATION_LANGUAGE[s]);
    assert.equal(label.from, s, `${s} carries its own name`);
    assert.ok(PRODUCT_TONES.includes(label.tone), `${s} uses a real tone`);
    assert.ok(label.label.length > 0 && label.detail.length > 0, s);
  }
  // Five situations, five different words.
  assert.equal(new Set(HEADLINE_SITUATIONS.map((s) => headlineSituationLabel(s).label)).size, HEADLINE_SITUATIONS.length);
});

test('3b. the situation words stay OUT of the flat lookup, so a Headline\'s RESOLVED never answers for a Case\'s', () => {
  assert.equal(productLabel('SET_ASIDE'), null);
  assert.equal(productLabel('DISMISSED_BY_INVESTIGATION'), null);
  assert.equal(productLabel('UNDER_INVESTIGATION'), null);
  assert.equal(productLabel('NEW'), null);
  // The Case's own word still answers for the Case's lane.
  assert.equal(productLabel('RESOLVED'), CASE_STATE_LANGUAGE.RESOLVED);
  assert.equal(productLabel('RESOLVED')?.from, 'RESOLVED');
});

test('3c. nothing closed or set aside is dressed as "Loop stands behind it"', () => {
  // A set-aside Headline and a Case closed without acting are NOT good news
  // rendered with a tick; they are attention feedback Loop keeps measuring behind.
  assert.notEqual(headlineSituationLabel('SET_ASIDE').tone, 'VERIFIED');
  assert.notEqual(headlineSituationLabel('DISMISSED_BY_INVESTIGATION').tone, 'VERIFIED');
  // And an undecided Headline is not "verified" either: nobody has decided anything.
  assert.notEqual(headlineSituationLabel('NEW').tone, 'VERIFIED');
  // The closed-without-acting situation reads with the same tone as the Case
  // lane it is derived from, so the two surfaces agree.
  assert.equal(headlineSituationLabel('DISMISSED_BY_INVESTIGATION').tone, CASE_STATE_LANGUAGE.DISMISSED.tone);
});

test('3d. every outcome has a word, the word carries its governed name, and it has no tone', () => {
  for (const o of OPERATIONAL_OUTCOMES) {
    const word = CASE_OUTCOME_LANGUAGE[o];
    assert.ok(word, `${o} has a word`);
    assert.equal(word.from, o);
    assert.equal(caseOutcomeLabel(o), word);
    // AN OUTCOME IS WHAT A PERSON RECORDED, not what Loop knows: no epistemic tone.
    assert.equal('tone' in word, false, `${o} carries no tone`);
  }
  assert.deepEqual(Object.keys(CASE_OUTCOME_LANGUAGE).sort(), [...OPERATIONAL_OUTCOMES].sort());
  assert.equal(caseOutcomeLabel('SOMETHING_A_LATER_BUILD_ADDED'), null, 'never a guess');
  // And it is not in the flat lookup: no state badge can render a person's report as a state.
  assert.equal(productLabel('RECOVERED'), null);
  const unknown: OperationalOutcome = 'UNKNOWN';
  assert.match(CASE_OUTCOME_LANGUAGE[unknown].label, /unknown/i, 'an unknown outcome says so');
});

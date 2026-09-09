// What EMG may learn — and the four things it may never conclude.
//
// WHAT THESE PROVE
//
// ONE SUCCESSFUL CASE CANNOT BECOME DOCTRINE. No count reaches
// ESTABLISHED_OPERATING_PATTERN, and no function here can set it.
//
// SEQUENCE IS NOT CAUSE, AND AGREEMENT IS NOT EVIDENCE. The two counts are kept
// apart, and the refusals ride on every pattern at every maturity.
//
// UNMONITORED IS UNKNOWN, NOT NEUTRAL. Cases nobody watched are excluded from
// the recovery denominator and reported, rather than folded in as failures.
//
// DURABLE KNOWLEDGE IS NOT DUPLICATED. Nomination points at the authority that
// already exists, names the schema fact that blocks the write, and always
// carries the human-approval blocker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EMERGING_PATTERN_MINIMUM,
  KNOWLEDGE_AUTHORITY,
  LEARNING_REFUSALS,
  NOMINATION_BLOCKERS,
  PATTERN_MATURITIES,
  RELEVANCE_REQUIRES_AUTHORIZATION,
  assessPattern,
  comparableKey,
  findRelevantObjectives,
  groupComparable,
  nominateForKnowledge,
  type LearningObservation,
  type MonitoringVerdict,
} from '../src/index';

const option = (key: string, rank = 1) => ({
  key, label: key, posture: 'REVERSIBLE_MITIGATION', rank, actions: ['Evaluate', 'Monitor'],
});

function observation(over: Partial<LearningObservation> = {}): LearningObservation {
  return {
    caseId: 'case_1',
    subject: 'headline:hl_cem',
    machineOptions: [option('protect-revenue', 1), option('learn-first', 2)],
    selected: option('protect-revenue'),
    revised: null,
    executed: null,
    outcome: 'RECOVERED',
    monitoringVerdict: 'HELD',
    evidenceAtDecision: { findingEstablished: true, readinessOutcome: 'READY', supportingCount: 3 },
    closedAt: '2026-09-08T00:00:00.000Z',
    ...over,
  };
}

const many = (n: number, over: Partial<LearningObservation> = {}) =>
  Array.from({ length: n }, (_, i) => observation({ caseId: `case_${i}`, ...over }));

// --- 1. One Case is not a policy ------------------------------------------------------

test('1. one Case is an OBSERVATION and says so', () => {
  const p = assessPattern('headline:hl_cem', [observation()]);
  assert.equal(p.maturity, 'OBSERVATION');
  assert.ok(p.cannotConclude.includes(LEARNING_REFUSALS.SMALL_N));
  assert.ok(p.explanation.some((l) => l.includes(String(EMERGING_PATTERN_MINIMUM))));
});

test('1b. no number of Cases reaches ESTABLISHED_OPERATING_PATTERN', () => {
  // THE PROPERTY. A pattern seen a thousand times is still worth a person
  // looking at, never how EMG operates -- that is a decision, and no threshold
  // produces one.
  for (const n of [1, 3, 10, 100, 1000]) {
    const p = assessPattern('headline:hl_cem', many(n));
    assert.notEqual(p.maturity, 'ESTABLISHED_OPERATING_PATTERN', `n=${n}`);
    assert.ok(p.cannotConclude.includes(LEARNING_REFUSALS.PROMOTION), `n=${n}`);
  }
  assert.equal(PATTERN_MATURITIES.length, 3);
});

test('1c. enough comparable Cases is EMERGING, and no more', () => {
  const p = assessPattern('headline:hl_cem', many(EMERGING_PATTERN_MINIMUM));
  assert.equal(p.maturity, 'EMERGING_PATTERN');
  assert.equal(p.cannotConclude.includes(LEARNING_REFUSALS.SMALL_N), false);
  assert.ok(p.cannotConclude.includes(LEARNING_REFUSALS.PROMOTION), 'the promotion refusal never drops off');
});

// --- 2. Preference and outcome are separate measurements ---------------------------------

test('2. what people chose and what was followed by recovery are counted apart', () => {
  const p = assessPattern('headline:hl_cem', [
    observation({ caseId: 'a', selected: option('protect-revenue'), monitoringVerdict: 'HELD' }),
    observation({ caseId: 'b', selected: option('protect-revenue'), monitoringVerdict: 'DID_NOT_HOLD' }),
    observation({ caseId: 'c', selected: option('protect-revenue'), monitoringVerdict: 'DID_NOT_HOLD' }),
  ]);
  const chosen = p.chosen.find((c) => c.optionKey === 'protect-revenue');
  const recovered = p.followedByRecovery.find((c) => c.optionKey === 'protect-revenue');
  assert.equal(chosen?.count, 3, 'chosen three times');
  assert.equal(recovered?.count, 1, 'followed by recovery once');
  assert.equal(recovered?.ofMonitored, 3);
  // AND THE PATTERN SAYS WHY THEY ARE APART. Averaging them would make
  // agreement look like evidence.
  assert.ok(p.cannotConclude.includes(LEARNING_REFUSALS.PREFERENCE));
});

test('2b. there is no score, no confidence and no ranking by effectiveness', () => {
  const p = assessPattern('headline:hl_cem', many(5));
  const keys = Object.keys(p);
  for (const forbidden of ['score', 'confidence', 'effectiveness', 'probability', 'recommendation']) {
    assert.equal(keys.some((k) => k.toLowerCase().includes(forbidden)), false, `no ${forbidden} field`);
  }
});

test('2c. every pattern carries the causation refusal, at every maturity', () => {
  for (const n of [1, 3, 50]) {
    assert.ok(assessPattern('s', many(n)).cannotConclude.includes(LEARNING_REFUSALS.CAUSE));
  }
});

// --- 3. Unmonitored is unknown, not neutral ------------------------------------------------

test('3. Cases nobody monitored are excluded from the denominator and reported', () => {
  const p = assessPattern('headline:hl_cem', [
    observation({ caseId: 'a', monitoringVerdict: 'HELD' }),
    observation({ caseId: 'b', monitoringVerdict: null }),
    observation({ caseId: 'c', monitoringVerdict: null }),
  ]);
  const recovered = p.followedByRecovery.find((c) => c.optionKey === 'protect-revenue');
  // ONE of one monitored, not one of three. Folding unwatched Cases in would
  // quietly make every option look worse.
  assert.equal(recovered?.ofMonitored, 1);
  assert.equal(recovered?.count, 1);
  assert.ok(p.cannotConclude.includes(LEARNING_REFUSALS.UNMEASURED));
  assert.ok(p.explanation.some((l) => l.includes('2 of 3')));
});

test('3b. an inconclusive verdict counts as monitored but not as a recovery', () => {
  const p = assessPattern('s', [
    observation({ caseId: 'a', monitoringVerdict: 'INCONCLUSIVE' as MonitoringVerdict }),
  ]);
  const r = p.followedByRecovery.find((c) => c.optionKey === 'protect-revenue');
  assert.equal(r?.ofMonitored, 1);
  assert.equal(r?.count, 0, 'INCONCLUSIVE is never a recovery');
});

test('3c. a Case where nobody selected anything contributes to neither count', () => {
  const p = assessPattern('s', [observation({ selected: null })]);
  assert.deepEqual(p.chosen, []);
  assert.deepEqual(p.followedByRecovery, []);
  assert.deepEqual(p.caseIds, ['case_1'], 'but it is still one of the Cases');
});

// --- 4. Comparability is narrow and deterministic -----------------------------------------

test('4. two Cases are comparable when the producer says they are about the same thing', () => {
  const groups = groupComparable([
    observation({ caseId: 'a', subject: 'headline:hl_cem' }),
    observation({ caseId: 'b', subject: 'HEADLINE:HL_CEM' }),
    observation({ caseId: 'c', subject: 'headline:hl_other' }),
  ]);
  assert.equal(groups.size, 2);
  assert.equal(groups.get(comparableKey('headline:hl_cem'))?.length, 2);
});

test('4b. comparability never guesses', () => {
  const src = readFileSync(new URL('../src/case-learning.ts', import.meta.url), 'utf8');
  // Anything looser than the producer's own key -- an embedding, a similarity
  // score, a model's judgement -- makes the denominator of every pattern
  // unfalsifiable.
  //
  // MATCHED AS CODE, NOT AS WORDS. The file's header names each of these to
  // explain why it refuses them; forbidding the words would forbid the
  // explanation, which is the assertion eating the thing it protects. These
  // match identifier and call positions only.
  for (const forbidden of [
    /\bembeddings?\s*[.(=]/i,
    /\bsimilarity\s*[.(=]/i,
    /\bcosine[A-Za-z]*\s*\(/i,
    /\blevenshtein\b/i,
  ]) {
    assert.equal(forbidden.test(src), false, `must not contain ${forbidden}`);
  }
  // And the comparability key is a trimmed, lowercased copy of what the producer
  // wrote -- nothing else.
  assert.ok(/return subject\.trim\(\)\.toLowerCase\(\);/.test(src));
  // The metric comparison is exact equality, in one place.
  assert.ok(/c\.metric === input\.metric/.test(src));
});

// --- 5. The knowledge boundary --------------------------------------------------------------

test('5. nomination points at the authority that already exists', () => {
  const p = assessPattern('s', many(5));
  const n = nominateForKnowledge(p, 'Reaching the buyer first tends to precede recovery.');
  assert.equal(n.destination, KNOWLEDGE_AUTHORITY);
  assert.equal(KNOWLEDGE_AUTHORITY, 'KnowledgeAssertion');
  assert.equal(n.assertionClass, 'ORGANIZATIONAL');
  assert.equal(n.proposedStatus, 'PROPOSED', 'never ACTIVE');
});

test('5b. human approval is always a blocker, at every maturity', () => {
  for (const n of [1, 3, 500]) {
    const nomination = nominateForKnowledge(assessPattern('s', many(n)), 'claim');
    assert.ok(nomination.blockers.includes('HUMAN_APPROVAL_REQUIRED'), `n=${n}`);
    // Not a condition that clears -- the shape of the boundary.
    assert.ok(nomination.blockers.includes('NO_IDENTITY_SUBJECT'), `n=${n}`);
  }
});

test('5c. the schema fact that blocks the write is named, not worked around', () => {
  // `knowledge_assertions.subjectIdentityId` is required: every assertion is
  // ABOUT an identity. An operating pattern is about a way of working. Naming a
  // fabricated identity would put a non-entity into the identity graph.
  const n = nominateForKnowledge(assessPattern('s', many(5)), 'claim');
  assert.equal(n.blockers[0], 'NO_IDENTITY_SUBJECT');
  assert.equal(NOMINATION_BLOCKERS.length, 3);
});

test('5d. the nomination carries everything the pattern cannot conclude', () => {
  const p = assessPattern('s', many(5));
  const n = nominateForKnowledge(p, 'claim');
  assert.deepEqual(n.pattern.cannotConclude, p.cannotConclude);
  assert.ok(n.pattern.cannotConclude.includes(LEARNING_REFUSALS.CAUSE));
});

test('5e. a thin pattern cannot even be proposed', () => {
  const n = nominateForKnowledge(assessPattern('s', many(1)), 'claim');
  assert.ok(n.blockers.includes('NOT_MATURE_ENOUGH'));
});

// --- 6. Cross-objective relevance ----------------------------------------------------------

const candidates = [
  { id: 'obj_aca', title: 'Grow ACA enrolments', metric: 'MONETIZED_RATE', scopeUserId: 'usr_lexi', active: true },
  { id: 'obj_medicare', title: 'Grow Medicare answer rate', metric: 'ANSWER_RATE', scopeUserId: null, active: true },
  { id: 'obj_archived', title: 'Old thing', metric: 'MONETIZED_RATE', scopeUserId: null, active: false },
  { id: 'obj_origin', title: 'Where it came from', metric: 'MONETIZED_RATE', scopeUserId: null, active: true },
];

test('6. a Finding reaches an objective elsewhere that measures the same thing', () => {
  const found = findRelevantObjectives({ originObjectiveId: 'obj_origin', metric: 'MONETIZED_RATE', candidates });
  assert.deepEqual(found.map((f) => f.performanceObjectiveId), ['obj_aca']);
  assert.equal(found[0]?.basis, 'SHARED_METRIC');
  assert.equal(found[0]?.scopeUserId, 'usr_lexi');
});

test('6b. relevance is a reason to look, never a decision to act', () => {
  const found = findRelevantObjectives({ originObjectiveId: 'obj_origin', metric: 'MONETIZED_RATE', candidates });
  // NOT an Opportunity, NOT a Case. A person still has to authorize an
  // investigation from a Headline -- anything else would let a Finding in one
  // part of the business quietly create work in another.
  assert.equal(found[0]?.requires, RELEVANCE_REQUIRES_AUTHORIZATION);
  assert.ok(RELEVANCE_REQUIRES_AUTHORIZATION.includes('authorize an investigation'));
});

test('6c. the origin objective, archived ones and different metrics are excluded', () => {
  const found = findRelevantObjectives({ originObjectiveId: 'obj_origin', metric: 'MONETIZED_RATE', candidates });
  const ids = found.map((f) => f.performanceObjectiveId);
  assert.equal(ids.includes('obj_origin'), false, 'not itself');
  assert.equal(ids.includes('obj_archived'), false, 'not an objective nobody is pursuing');
  assert.equal(ids.includes('obj_medicare'), false, 'not a different metric');
});

test('6d. the metric match is exact, never fuzzy', () => {
  // A fuzzy match would be a model's judgement wearing a string comparison, and
  // the result would be a Headline shown to somebody for a reason nobody could
  // check.
  const found = findRelevantObjectives({
    originObjectiveId: 'obj_origin',
    metric: 'MONETIZED_RATE_V2',
    candidates,
  });
  assert.deepEqual(found, []);
});

// --- 7. Source discipline ---------------------------------------------------------------------

test('7. nothing here creates knowledge, and no model attaches to it', () => {
  const src = readFileSync(new URL('../src/case-learning.ts', import.meta.url), 'utf8');
  for (const forbidden of [/\bfetch\s*\(/, /\banthropic\b/i, /\bopenai\b/i, /Math\.random/]) {
    assert.equal(forbidden.test(src), false, `must not contain ${forbidden}`);
  }
  // And there is no path to ACTIVE anywhere in the file.
  assert.equal(/['"]ACTIVE['"]/.test(src), false, 'nothing here can make an assertion active');
});

// Recommendations — the ceiling on how firmly Loop may say what to do.
//
// WHAT THESE PROVE
//
// AN OPTION MAY NEVER COMMIT FURTHER THAN ITS EVIDENCE. A DEVELOPING finding can
// justify looking and can justify a change you can take back; it cannot justify
// spend or a contractual position. The set is refused whole rather than silently
// downgraded, because quietly weakening somebody's proposal is worse than
// telling them it was not allowed.
//
// LOOP MAY NOT SAY WHAT TO CHANGE. The shipped verb guard is enforced
// structurally: "Increase the bid" is unrepresentable, "Evaluate the bid" is
// fine. This is the same rule `callgrid-intelligence.ts` already shipped, reused
// rather than restated.
//
// RANKING IS EXPLAINED, NOT SCORED. Every factor lands in exactly one of
// favours-left / favours-right / incomparable, in a declared order, with no
// weighting and no sum. UNKNOWN never silently becomes MODERATE.
//
// A REVISION SAYS WHAT MOVED, NEVER WHAT IT MEANS. The diff is arithmetic; the
// tradeoff is a business judgement and this layer refuses to assert one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FACTOR_LABEL,
  FACTOR_POLARITY,
  FORBIDDEN_RECOMMENDATION_VERBS,
  POSTURE_RANK,
  RECOMMENDATION_DECISION_TYPE,
  RECOMMENDATION_FACTORS,
  RECOMMENDATION_POSTURES,
  RECOMMENDATION_RECORDED_REASON,
  RECOMMENDATION_REJECTION_LABELS,
  RECOMMENDATION_REJECTIONS,
  RECOMMENDATION_SELECTED_REASON,
  compareOptions,
  diffSequence,
  factorsAffectedBy,
  findingEvidenceStrength,
  isRecommendationEvent,
  levelOf,
  maxPostureFor,
  optionsInRank,
  postureIsSupported,
  sequenceIsSafe,
  validateRecommendationSet,
  type EvidenceStrength,
  type FactorAssessment,
  type RecommendationOption,
  type RecommendedAction,
} from '../src/index';

function action(position: number, verb: RecommendedAction['verb'], rest: string): RecommendedAction {
  return { position, verb, statement: `${verb} ${rest}`, intent: null };
}

function factor(
  f: FactorAssessment['factor'],
  level: FactorAssessment['level'],
  basis = 'Stated for the fixture.',
): FactorAssessment {
  return { factor: f, level, basis: level === 'UNKNOWN' ? null : basis };
}

function option(over: Partial<RecommendationOption> = {}): RecommendationOption {
  return {
    key: 'protect-revenue',
    label: 'Protect Revenue First',
    summary: 'Move volume away from the buyer while the cause is established.',
    posture: 'DIAGNOSTIC',
    factors: [factor('EXPECTED_BENEFIT', 'HIGH'), factor('RELATIONSHIP_RISK', 'MODERATE')],
    actions: [action(1, 'Review', 'the buyer’s recent dispositions.')],
    rank: 1,
    ...over,
  };
}

// --- The ceiling ------------------------------------------------------------------

test('the strongest posture each evidence strength allows', () => {
  assert.equal(maxPostureFor('HIGH'), 'COMMITTED_CHANGE');
  assert.equal(maxPostureFor('MODERATE'), 'REVERSIBLE_MITIGATION');
  assert.equal(maxPostureFor('LOW'), 'REVERSIBLE_MITIGATION');
  // MITIGATING A CONDITION YOU HAVE NOT ESTABLISHED IS ACTING ON A GUESS.
  assert.equal(maxPostureFor('INSUFFICIENT'), 'DIAGNOSTIC');
});

test('a developing finding cannot support a committed change', () => {
  const strength: EvidenceStrength = 'LOW';
  assert.equal(postureIsSupported('COMMITTED_CHANGE', strength), false);
  assert.equal(postureIsSupported('REVERSIBLE_MITIGATION', strength), true);

  const v = validateRecommendationSet({
    options: [option({ posture: 'COMMITTED_CHANGE' })],
    evidenceStrength: strength,
  });
  assert.equal(v.ok, false);
  assert.deepEqual(v.rejections, ['POSTURE_EXCEEDS_EVIDENCE']);
  assert.deepEqual(v.offendingKeys, ['protect-revenue']);
});

test('an established, measurement-backed finding can support a committed change', () => {
  const v = validateRecommendationSet({
    options: [option({ posture: 'COMMITTED_CHANGE' })],
    evidenceStrength: 'HIGH',
  });
  assert.equal(v.ok, true);
});

test('learning and diagnosing are always available, at every strength', () => {
  for (const strength of ['HIGH', 'MODERATE', 'LOW', 'INSUFFICIENT'] as EvidenceStrength[]) {
    assert.equal(postureIsSupported('LEARN_BEFORE_ACTING', strength), true, strength);
    assert.equal(postureIsSupported('DIAGNOSTIC', strength), true, strength);
  }
});

test('postures are ordered safest-first, and the ceiling respects that order', () => {
  const ranks = RECOMMENDATION_POSTURES.map((p) => POSTURE_RANK[p]);
  assert.deepEqual(ranks, [0, 1, 2, 3]);
});

// --- Evidence strength from a Finding ----------------------------------------------

test('evidence strength is derived from the establishment verdict, not a confidence number', () => {
  const base = { establishment: { eligible: true }, supportingCount: 2 };
  assert.equal(
    findingEvidenceStrength({ ...base, state: 'ESTABLISHED', establishedBy: 'DETERMINISTIC_POLICY' }),
    'HIGH',
  );
  // A PERSON TAKING RESPONSIBILITY IS NOT A MEASUREMENT. Capping at MODERATE is
  // what stops an opinion authorizing a committed change.
  assert.equal(
    findingEvidenceStrength({ ...base, state: 'ESTABLISHED', establishedBy: 'HUMAN_ACCEPTANCE' }),
    'MODERATE',
  );
  assert.equal(
    findingEvidenceStrength({ ...base, state: 'DEVELOPING', establishedBy: null }),
    'LOW',
  );
  assert.equal(
    findingEvidenceStrength({ ...base, state: 'DEVELOPING', establishedBy: null, supportingCount: 0 }),
    'INSUFFICIENT',
  );
});

test('a rejected or superseded finding supports nothing beyond diagnosis', () => {
  for (const state of ['REJECTED', 'SUPERSEDED', 'EXPIRED'] as const) {
    const strength = findingEvidenceStrength({
      state,
      establishedBy: null,
      establishment: { eligible: false },
      supportingCount: 5,
    });
    assert.equal(strength, 'INSUFFICIENT', state);
    assert.equal(maxPostureFor(strength), 'DIAGNOSTIC');
  }
});

// --- Loop may say what to look at, never what to change -------------------------------

test('a step that tells someone to change something is refused', () => {
  const unsafe = validateRecommendationSet({
    options: [
      option({
        actions: [{ position: 1, verb: 'Review', statement: 'Increase the bid to 42.', intent: null }],
      }),
    ],
    evidenceStrength: 'HIGH',
  });
  assert.equal(unsafe.ok, false);
  assert.deepEqual(unsafe.rejections, ['UNSAFE_ACTION_VERB']);
});

test('every forbidden verb is genuinely unrepresentable as a step', () => {
  for (const verb of FORBIDDEN_RECOMMENDATION_VERBS) {
    const v = validateRecommendationSet({
      options: [
        option({ actions: [{ position: 1, verb: 'Review', statement: `${verb} the routing.`, intent: null }] }),
      ],
      evidenceStrength: 'HIGH',
    });
    assert.equal(v.ok, false, `${verb} must be refused`);
  }
});

test('a sequence numbered out of order is refused', () => {
  const v = validateRecommendationSet({
    options: [
      option({
        actions: [action(1, 'Review', 'the dispositions.'), action(3, 'Contact', 'the buyer.')],
      }),
    ],
    evidenceStrength: 'HIGH',
  });
  assert.equal(v.ok, false);
  assert.ok(v.rejections.includes('SEQUENCE_OUT_OF_ORDER'));
});

test('a well-formed sequence passes the guard', () => {
  assert.equal(
    sequenceIsSafe([
      action(1, 'Contact', 'the buyer about the settlement change.'),
      action(2, 'Confirm', 'whether the policy changed.'),
      action(3, 'Monitor', 'recovery over the next two days.'),
    ]),
    true,
  );
});

// --- Alternatives ----------------------------------------------------------------------

test('a set carries several legitimate options and keeps the author’s order', () => {
  const options = [
    option({ key: 'relationship', label: 'Protect Relationship First', rank: 2 }),
    option({ key: 'revenue', label: 'Protect Revenue First', rank: 1 }),
    option({ key: 'learn', label: 'Learn Before Acting', posture: 'LEARN_BEFORE_ACTING', rank: 3 }),
  ];
  const v = validateRecommendationSet({ options, evidenceStrength: 'HIGH' });
  assert.equal(v.ok, true);
  assert.deepEqual(optionsInRank({ options }).map((o) => o.key), ['revenue', 'relationship', 'learn']);
});

test('two options claiming the same position, or the same key, are refused', () => {
  const dupRank = validateRecommendationSet({
    options: [option({ key: 'a', rank: 1 }), option({ key: 'b', rank: 1 })],
    evidenceStrength: 'HIGH',
  });
  assert.ok(dupRank.rejections.includes('DUPLICATE_RANK'));

  const dupKey = validateRecommendationSet({
    options: [option({ key: 'a', rank: 1 }), option({ key: 'a', rank: 2 })],
    evidenceStrength: 'HIGH',
  });
  assert.ok(dupKey.rejections.includes('DUPLICATE_OPTION_KEY'));
});

test('an empty set is refused', () => {
  const v = validateRecommendationSet({ options: [], evidenceStrength: 'HIGH' });
  assert.deepEqual(v.rejections, ['NO_OPTIONS']);
});

// --- Ranking is explained, not scored --------------------------------------------------

test('a comparison names the factors that favour each side', () => {
  const revenue = option({
    key: 'revenue',
    rank: 1,
    factors: [
      factor('EXPECTED_BENEFIT', 'HIGH'),
      factor('RELATIONSHIP_RISK', 'HIGH'),
      factor('REVERSIBILITY', 'HIGH'),
    ],
  });
  const relationship = option({
    key: 'relationship',
    rank: 2,
    factors: [
      factor('EXPECTED_BENEFIT', 'MODERATE'),
      factor('RELATIONSHIP_RISK', 'LOW'),
      factor('REVERSIBILITY', 'HIGH'),
    ],
  });

  const c = compareOptions(revenue, relationship);
  assert.deepEqual(c.favouringLeft.map((d) => d.factor), ['EXPECTED_BENEFIT']);
  // HIGHER IS NOT ALWAYS BETTER. Higher relationship risk favours the other side.
  assert.deepEqual(c.favouringRight.map((d) => d.factor), ['RELATIONSHIP_RISK']);
  // Equal factors are neither, and are not noise in the answer.
  assert.equal(c.favouringLeft.concat(c.favouringRight).some((d) => d.factor === 'REVERSIBILITY'), false);
});

test('every factor declares which direction is better, and the comparison honours it', () => {
  for (const f of RECOMMENDATION_FACTORS) {
    const polarity = FACTOR_POLARITY[f];
    assert.ok(polarity, `${f} has no declared polarity`);
    const high = option({ key: 'high', factors: [factor(f, 'HIGH')] });
    const low = option({ key: 'low', factors: [factor(f, 'LOW')] });
    const c = compareOptions(high, low);
    const winner = polarity === 'HIGHER_IS_BETTER' ? c.favouringLeft : c.favouringRight;
    assert.deepEqual(winner.map((d) => d.factor), [f], `${f} compared the wrong way`);
  }
});

test('an unassessed factor is incomparable, never a quiet MODERATE', () => {
  const assessed = option({ key: 'a', factors: [factor('EFFORT', 'LOW')] });
  const silent = option({ key: 'b', factors: [] });
  assert.equal(levelOf(silent, 'EFFORT'), 'UNKNOWN');

  const c = compareOptions(assessed, silent);
  assert.ok(c.incomparable.includes('EFFORT'));
  assert.equal(c.favouringLeft.length, 0);
  assert.equal(c.favouringRight.length, 0);
});

test('a comparison is total — every factor lands in exactly one list', () => {
  const c = compareOptions(
    option({ key: 'a', factors: [factor('EFFORT', 'LOW'), factor('URGENCY', 'HIGH')] }),
    option({ key: 'b', factors: [factor('EFFORT', 'HIGH'), factor('URGENCY', 'HIGH')] }),
  );
  const named = new Set([
    ...c.favouringLeft.map((d) => d.factor),
    ...c.favouringRight.map((d) => d.factor),
    ...c.incomparable,
  ]);
  // URGENCY is equal on both sides, so it is deliberately in none of the three.
  assert.equal(named.has('URGENCY'), false);
  for (const f of RECOMMENDATION_FACTORS) {
    if (f === 'URGENCY') continue;
    assert.ok(named.has(f), `${f} vanished from the comparison`);
  }
});

test('a comparison is deterministic and carries no score', () => {
  const a = option({ key: 'a', factors: [factor('EFFORT', 'LOW')] });
  const b = option({ key: 'b', factors: [factor('EFFORT', 'HIGH')] });
  assert.deepEqual(compareOptions(a, b), compareOptions(a, b));
  const serialized = JSON.stringify(compareOptions(a, b));
  assert.equal(/"score"|"weight"|"total"/.test(serialized), false);
});

test('a factor assessed without a stated basis is refused', () => {
  const v = validateRecommendationSet({
    options: [option({ factors: [{ factor: 'EFFORT', level: 'HIGH', basis: null }] })],
    evidenceStrength: 'HIGH',
  });
  assert.ok(v.rejections.includes('ASSESSED_FACTOR_WITHOUT_BASIS'));
});

test('an UNKNOWN factor needs no basis — nobody assessed it', () => {
  const v = validateRecommendationSet({
    options: [option({ factors: [{ factor: 'EFFORT', level: 'UNKNOWN', basis: null }] })],
    evidenceStrength: 'HIGH',
  });
  assert.equal(v.ok, true);
});

// --- Revision --------------------------------------------------------------------------

test('a revision reports what moved', () => {
  const original = [
    action(1, 'Evaluate', 'shifting traffic to the backup buyer.'),
    action(2, 'Contact', 'the buyer.'),
    action(3, 'Monitor', 'recovery.'),
  ];
  const revised = [
    action(1, 'Contact', 'the buyer.'),
    action(2, 'Evaluate', 'shifting traffic to the backup buyer.'),
    action(3, 'Validate', 'the disposition feed.'),
  ];
  const d = diffSequence(original, revised);
  assert.deepEqual(d.added, ['Validate the disposition feed.']);
  assert.deepEqual(d.removed, ['Monitor recovery.']);
  assert.deepEqual(
    d.reordered.map((r) => [r.from, r.to]),
    [
      [1, 2],
      [2, 1],
    ],
  );
  assert.equal(d.unchanged, false);
});

test('an identical revision is reported as unchanged and affects nothing', () => {
  const seq = [action(1, 'Review', 'the dispositions.')];
  const d = diffSequence(seq, seq);
  assert.equal(d.unchanged, true);
  assert.deepEqual(factorsAffectedBy(d), []);
});

test('reordering steps can never change how well established the finding is', () => {
  const d = diffSequence([action(1, 'Review', 'a.'), action(2, 'Contact', 'b.')], [
    action(1, 'Contact', 'b.'),
    action(2, 'Review', 'a.'),
  ]);
  const affected = factorsAffectedBy(d);
  assert.equal(affected.includes('EVIDENCE_STRENGTH'), false);
  assert.ok(affected.includes('RELATIONSHIP_RISK'));
});

// --- The log predicates -----------------------------------------------------------------

test('the case-log predicates match only their own exact line', () => {
  const recorded = { observationType: 'NOTE_ADDED', reason: RECOMMENDATION_RECORDED_REASON };
  assert.equal(isRecommendationEvent(recorded, 'RECORDED'), true);
  assert.equal(isRecommendationEvent(recorded, 'SELECTED'), false);
  assert.equal(
    isRecommendationEvent({ observationType: 'REVIEWED', reason: RECOMMENDATION_SELECTED_REASON }, 'SELECTED'),
    false,
  );
});

// --- What the contract must NOT carry ------------------------------------------------------

const SOURCE_TEXT = readFileSync(new URL('../src/case-recommendation.ts', import.meta.url), 'utf8');

test('no probability, no expected value, no confidence percentage', () => {
  // MATCHED IN DECLARATION POSITION, NOT AS A WORD. The header explains at
  // length why there is no probability here, and an assertion that forbids
  // naming the thing being refused forbids explaining the refusal.
  for (const forbidden of ['probability', 'percentChance', 'expectedValue', 'successRate', 'confidence']) {
    assert.equal(
      new RegExp(`\\b${forbidden}\\s*[?]?\\s*:`).test(SOURCE_TEXT),
      false,
      `no field may declare ${forbidden}`,
    );
  }
});

test('the vocabularies are reused, not forked', () => {
  // Evidence strength and the approved verbs already exist and ship. A second
  // copy of either would be two answers to one question.
  assert.ok(SOURCE_TEXT.includes("from './callgrid-decision-support'"));
  assert.ok(SOURCE_TEXT.includes("from './callgrid-intelligence'"));
  assert.equal(/export (const|type) EVIDENCE_STRENGTHS?\b/.test(SOURCE_TEXT), false);
  assert.equal(/export const RECOMMENDATION_VERBS/.test(SOURCE_TEXT), false);
});

test('every rejection has a sentence a person can read, and the decision type is namespaced', () => {
  for (const r of RECOMMENDATION_REJECTIONS) {
    assert.ok(RECOMMENDATION_REJECTION_LABELS[r]?.length > 20, `${r} has no readable label`);
  }
  for (const f of RECOMMENDATION_FACTORS) assert.ok(FACTOR_LABEL[f]?.length > 5);
  assert.equal(RECOMMENDATION_DECISION_TYPE, 'case-recommendation');
});

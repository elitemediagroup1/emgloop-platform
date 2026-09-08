// Business significance and personal relevance, and the fact that they never
// become one number.
//
// WHAT THESE PROVE
//
// THE TWO QUESTIONS STAY APART. A view carries both and no function anywhere
// combines them; the contract exports nothing that returns a score. Asserted
// against the source, because the pressure to add one arrives the first time a
// queue needs sorting.
//
// EVERY REASON NAMES A ROW. "Why is this first" is answered by facts somebody can
// go and look at — a participant row, an owner column, an objective — never by a
// weighting of features.
//
// THE ORDERING EXPLAINS ITSELF, AND THE EXPLANATION CANNOT DRIFT. `explainOrder`
// walks the same three facts as `compareForUser`, so a rationalisation that
// disagreed with the sort is impossible rather than merely unlikely.
//
// WHAT IS NOT KNOWN IS SAID. Revenue exposure, client value, workload and
// reporting lines are absent from this schema, and the view names them rather
// than letting a ranking imply it weighed them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PERSONAL_PRIORITY_RULE_VERSION,
  PRIORITY_COMPARISON_REASONS,
  PRIORITY_NOT_CONSIDERED,
  RELEVANCE_TIERS,
  RELEVANCE_TIER_LABELS,
  RELEVANCE_TIER_RANK,
  assessPersonalPriority,
  compareForUser,
  explainOrder,
  orderForUser,
  type BusinessSignificance,
  type PersonalPriorityInput,
} from '../src/index';

const CASE = 'pri_1';
const ME = 'usr_matt';
const SOMEBODY_ELSE = 'usr_charlie';

function significance(over: Partial<BusinessSignificance> = {}): BusinessSignificance {
  return {
    severity: 'NOTABLE',
    againstObjective: true,
    measuredImpactCents: null,
    percentageChange: -0.31,
    ...over,
  };
}

function input(over: Partial<PersonalPriorityInput> = {}): PersonalPriorityInput {
  return {
    caseId: CASE,
    userId: ME,
    significance: significance(),
    participation: [],
    ownerUserId: null,
    assigneeUserId: null,
    objective: null,
    ...over,
  };
}

const asked = (contribution: any, active = true) => ({
  id: `cp_${contribution}`,
  contribution,
  request: 'Whether we move volume off CEM this week.',
  active,
});

// --- The tier is a fact about a relationship ---------------------------------------

test('being asked to decide puts the case at the top of your relevance', () => {
  const v = assessPersonalPriority(input({ participation: [asked('DECIDE')] }));
  assert.equal(v.tier, 'AWAITED_DECISION');
  assert.equal(v.reasons[0]?.source, 'CASE_PARTICIPANT');
  assert.equal(v.reasons[0]?.sourceId, 'cp_DECIDE');
  assert.ok(v.reasons[0]?.statement.includes('waiting on you'));
});

test('being asked for anything else is relevant, but not awaited', () => {
  const v = assessPersonalPriority(input({ participation: [asked('INVESTIGATE')] }));
  assert.equal(v.tier, 'ASKED_TO_HELP');
});

test('being asked outranks owning it — ownership is standing, being asked is an event', () => {
  const v = assessPersonalPriority(
    input({ participation: [asked('DECIDE')], ownerUserId: ME, assigneeUserId: ME }),
  );
  assert.equal(v.tier, 'AWAITED_DECISION');
  // EVERY relationship is still reported, strongest first, so a surface can show
  // all of them rather than only the one that won.
  assert.deepEqual(v.reasons.map((r) => r.tier), ['AWAITED_DECISION', 'ACCOUNTABLE', 'WORKING_IT']);
});

test('a released participant no longer makes the case yours', () => {
  const v = assessPersonalPriority(input({ participation: [asked('DECIDE', false)] }));
  assert.equal(v.tier, 'ORGANIZATION_WIDE');
  assert.deepEqual(v.reasons, []);
});

test('owning the objective it was measured against is a relationship, and names the objective', () => {
  const v = assessPersonalPriority(
    input({ objective: { id: 'obj_1', scopeUserId: ME } }),
  );
  assert.equal(v.tier, 'YOUR_OBJECTIVE');
  assert.equal(v.reasons[0]?.source, 'PERFORMANCE_OBJECTIVE');
  assert.equal(v.reasons[0]?.sourceId, 'obj_1');
});

test('somebody else’s objective, owner and assignee create no relationship', () => {
  const v = assessPersonalPriority(
    input({
      ownerUserId: SOMEBODY_ELSE,
      assigneeUserId: SOMEBODY_ELSE,
      objective: { id: 'obj_1', scopeUserId: SOMEBODY_ELSE },
    }),
  );
  assert.equal(v.tier, 'ORGANIZATION_WIDE');
  assert.deepEqual(v.reasons, []);
});

test('every case gets a tier — a queue never silently drops one', () => {
  const v = assessPersonalPriority(input());
  assert.equal(v.tier, 'ORGANIZATION_WIDE');
  assert.equal(v.ruleVersion, PERSONAL_PRIORITY_RULE_VERSION);
});

// --- Business significance is carried, never merged -----------------------------------

test('significance is carried through unchanged, including what was not measured', () => {
  const v = assessPersonalPriority(
    input({ significance: significance({ severity: 'CRITICAL', measuredImpactCents: null }) }),
  );
  assert.equal(v.significance.severity, 'CRITICAL');
  // NULL MEANS NOBODY MEASURED IT, and is not quietly turned into zero — which
  // would read as "measured, and it was nothing".
  assert.equal(v.significance.measuredImpactCents, null);
});

test('a critical case nobody asked you about is still ORGANIZATION_WIDE', () => {
  // THE TWO AXES DO NOT LEAK INTO EACH OTHER. Severity cannot promote a case into
  // being yours, and being yours cannot make a case severe.
  const v = assessPersonalPriority(input({ significance: significance({ severity: 'CRITICAL' }) }));
  assert.equal(v.tier, 'ORGANIZATION_WIDE');
  assert.equal(v.significance.severity, 'CRITICAL');
});

// --- Ordering -----------------------------------------------------------------------

test('what is yours reaches you before what is merely severe', () => {
  const mine = assessPersonalPriority(
    input({ participation: [asked('DECIDE')], significance: significance({ severity: 'NOTABLE' }) }),
  );
  const theirs = assessPersonalPriority(
    input({ caseId: 'pri_2', significance: significance({ severity: 'CRITICAL' }) }),
  );

  assert.deepEqual(orderForUser([theirs, mine]).map((v) => v.caseId), [CASE, 'pri_2']);
  assert.equal(explainOrder(mine, theirs).reason, 'TIER');
});

test('at equal relevance, the more severe case comes first', () => {
  const high = assessPersonalPriority(
    input({ participation: [asked('DECIDE')], significance: significance({ severity: 'CRITICAL' }) }),
  );
  const low = assessPersonalPriority(
    input({ caseId: 'pri_2', participation: [asked('DECIDE')], significance: significance({ severity: 'NOTABLE' }) }),
  );
  assert.deepEqual(orderForUser([low, high]).map((v) => v.caseId), [CASE, 'pri_2']);
  assert.equal(explainOrder(high, low).reason, 'SEVERITY');
});

test('at equal relevance and severity, a move against a stated objective comes first', () => {
  const against = assessPersonalPriority(input({ significance: significance({ againstObjective: true }) }));
  const withIt = assessPersonalPriority(
    input({ caseId: 'pri_2', significance: significance({ againstObjective: false }) }),
  );
  assert.deepEqual(orderForUser([withIt, against]).map((v) => v.caseId), [CASE, 'pri_2']);
  assert.equal(explainOrder(against, withIt).reason, 'AGAINST_OBJECTIVE');
});

test('nothing separating two items keeps the order they arrived in', () => {
  const a = assessPersonalPriority(input({ caseId: 'a' }));
  const b = assessPersonalPriority(input({ caseId: 'b' }));
  assert.equal(compareForUser(a, b), 0);
  assert.equal(explainOrder(a, b).reason, 'TIED');
  assert.deepEqual(orderForUser([b, a]).map((v) => v.caseId), ['b', 'a']);
});

test('the explanation cannot disagree with the ordering', () => {
  // THE SAME THREE FACTS, WALKED IN THE SAME ORDER. If these ever diverge, the
  // explanation is a rationalisation and the product is lying about its own
  // reasoning — so this checks every combination rather than a sample.
  const tiers = [
    { participation: [asked('DECIDE')] },
    { participation: [asked('INVESTIGATE')] },
    { ownerUserId: ME },
    {},
  ];
  const severities = ['CRITICAL', 'HIGH', 'NOTABLE', 'INFORMATIONAL'] as const;
  const objectives = [true, false];

  const built = tiers.flatMap((t, ti) =>
    severities.flatMap((sev, si) =>
      objectives.map((against, oi) =>
        assessPersonalPriority(
          input({ ...t, caseId: `c${ti}${si}${oi}`, significance: significance({ severity: sev, againstObjective: against }) }),
        ),
      ),
    ),
  );

  for (const a of built) {
    for (const b of built) {
      const order = compareForUser(a, b);
      const { reason } = explainOrder(a, b);
      if (order === 0) assert.equal(reason, 'TIED', `${a.caseId} vs ${b.caseId}`);
      else assert.notEqual(reason, 'TIED', `${a.caseId} vs ${b.caseId}`);
    }
  }
});

test('ordering is deterministic and total', () => {
  const items = [
    assessPersonalPriority(input({ caseId: 'a', participation: [asked('DECIDE')] })),
    assessPersonalPriority(input({ caseId: 'b', ownerUserId: ME })),
    assessPersonalPriority(input({ caseId: 'c' })),
  ];
  assert.deepEqual(orderForUser(items), orderForUser([...items].reverse()).slice().sort((x, y) => compareForUser(x, y)));
  assert.deepEqual(orderForUser(items).map((v) => v.caseId), ['a', 'b', 'c']);
});

// --- What is not known is said ------------------------------------------------------

test('the view names what a ranking could not take into account', () => {
  const v = assessPersonalPriority(input());
  assert.deepEqual(v.notConsidered, PRIORITY_NOT_CONSIDERED);
  assert.ok(v.notConsidered.some((s) => s.toLowerCase().includes('revenue is exposed')));
  assert.ok(v.notConsidered.some((s) => s.toLowerCase().includes('relationship')));
  assert.ok(v.notConsidered.some((s) => s.toLowerCase().includes('reports to whom')));
  for (const s of v.notConsidered) assert.ok(s.length > 30, 'each gap is explained, not labelled');
});

// --- The vocabulary ------------------------------------------------------------------

test('every tier has a rank and a label, ordered strongest first', () => {
  assert.deepEqual(
    RELEVANCE_TIERS.map((t) => RELEVANCE_TIER_RANK[t]),
    [0, 1, 2, 3, 4, 5],
  );
  for (const t of RELEVANCE_TIERS) assert.ok(RELEVANCE_TIER_LABELS[t]?.length > 5, `${t} has no label`);
  for (const r of Object.values(PRIORITY_COMPARISON_REASONS)) assert.ok(r.length > 20);
});

// --- What the contract must NOT carry --------------------------------------------------

const SOURCE_TEXT = readFileSync(new URL('../src/personal-priority.ts', import.meta.url), 'utf8');

test('nothing here computes a score', () => {
  // The moment one number exists, "a revenue fall nobody is handling" and "a
  // small question three people are waiting on you for" become one figure, and
  // neither question can be asked again.
  for (const forbidden of ['score', 'weight', 'points', 'coefficient']) {
    assert.equal(
      new RegExp(`\\\\b${forbidden}\\\\s*[?]?\\\\s*:`).test(SOURCE_TEXT),
      false,
      `no field may declare ${forbidden}`,
    );
  }
  const serialized = JSON.stringify(assessPersonalPriority(input({ participation: [asked('DECIDE')] })));
  assert.equal(/"score"|"weight"|"rank":\s*[0-9]/.test(serialized), false);
});

test('significance and relevance are two fields, and nothing combines them', () => {
  const v = assessPersonalPriority(input());
  assert.ok('significance' in v && 'tier' in v);
  // MATCHED IN DECLARATION POSITION. The header explains at length that the two
  // are never combined, and an assertion that forbids the word forbids the
  // explanation.
  for (const combined of ['overall', 'combined', 'totalPriority', 'finalScore', 'priorityScore']) {
    assert.equal(
      new RegExp(`\\b${combined}\\s*[?]?\\s*[:(]`).test(SOURCE_TEXT),
      false,
      `must not expose ${combined}`,
    );
  }
});

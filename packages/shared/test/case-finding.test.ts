// The establishment gate — the ways a claim must refuse to call itself true.
//
// THE PROPERTY UNDER TEST, ONCE
//
// A claim may reach ESTABLISHED autonomously only when the deterministic Stage 3
// gate says the measurement under it is eligible. Every case below is a way that
// proof can be absent, stale, withheld, incomplete or contradicted, and in every
// one of them the verdict must be a named refusal rather than a yes.
//
// THE COUNTER-PROPERTY MATTERS AS MUCH. A measurement-backed claim over a clean,
// READY window with complete evidence MUST establish. A gate that refuses
// everything is safe and useless, and would leave the product with a state
// nothing can ever be in.
//
// THE VERDICTS ARE REAL. Nothing here hand-writes a `MeasurementReadiness`
// literal: every one comes out of `assessReadiness` over a deliberately broken
// population, so the mapping is pinned against the gate's actual output and not
// against what this test believes that output looks like.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FINDING_CLAIM_KINDS,
  FINDING_ESTABLISHMENT_BASES,
  FINDING_ESTABLISHMENT_RULE_VERSION,
  FINDING_INELIGIBILITY_LABELS,
  FINDING_INELIGIBILITY_REASONS,
  FINDING_REASON_BY_WITHHOLDING,
  FINDING_EVIDENCE_STATES,
  FINDING_JUDGMENTS,
  FINDING_LIFECYCLES,
  FINDING_TYPE_PREFIX,
  MEASUREMENT_READINESS_RULE_VERSION,
  READINESS_WITHHOLDINGS,
  assessFindingEstablishment,
  assessReadiness,
  assessWindowObservation,
  findEvidenceContradictions,
  findingClaimKind,
  findingEvidenceState,
  findingHypothesisType,
  findingJudgment,
  findingLifecycle,
  isFindingRecorded,
  isFindingSuperseded,
  FINDING_RECORDED_REASON,
  FINDING_SUPERSEDED_REASON,
  type BusinessDate,
  type FindingEstablishmentInput,
  type FindingEvidenceRef,
  type FindingRecordFacts,
  type MeasureSourceAuthorityDeclaration,
  type MeasurementReadiness,
  type MeasurementSourceDefinition,
  type ProviderObservationStatus,
  type ReadinessInput,
  type ReconciliationCounts,
  type ReconciliationDayFact,
  type ReconciliationMemberFact,
} from '../src/index';

const SOURCE_TEXT = readFileSync(new URL('../src/case-finding.ts', import.meta.url), 'utf8');

const DATES: BusinessDate[] = ['2026-08-04', '2026-08-05'];
const CAMPAIGN = 'camp-delivering';

const SOURCE: MeasurementSourceDefinition = {
  key: 'provider-calls',
  kind: 'PROVIDER_STREAM',
  displayName: 'Call provider',
  supportedMetrics: ['CALL_VOLUME', 'REVENUE'],
  measureDefinitionIds: { CALL_VOLUME: 'calls.provider.v1', REVENUE: 'revenue.provider.v1' },
  provider: 'callgrid',
  stream: 'calls',
};

function observation(overrides: Record<string, ProviderObservationStatus | null> = {}) {
  const m = new Map<BusinessDate, ProviderObservationStatus>();
  for (const d of DATES) m.set(d, 'SUCCESS');
  for (const [d, s] of Object.entries(overrides)) {
    if (s === null) m.delete(d);
    else m.set(d, s);
  }
  return assessWindowObservation(DATES, m);
}

function counts(over: Partial<ReconciliationCounts> = {}): ReconciliationCounts {
  return {
    providerUnique: 100,
    providerDuplicateIds: 0,
    localUnique: 100,
    localDuplicateIds: 0,
    intersection: 100,
    providerOnly: 0,
    localOnly: 0,
    providerOnlyExpected: 0,
    providerOnlyNotConfigured: 0,
    providerOnlyExcluded: 0,
    providerOnlyUnknownMember: 0,
    ...over,
  };
}

function member(over: Partial<ReconciliationMemberFact> = {}): ReconciliationMemberFact {
  return {
    dimension: 'CAMPAIGN',
    memberExternalId: CAMPAIGN,
    providerCount: 100,
    localCount: 100,
    providerOnly: 0,
    expectation: 'EXPECTED',
    ...over,
  };
}

function day(date: BusinessDate, over: Partial<ReconciliationDayFact> = {}): ReconciliationDayFact {
  return {
    businessDate: date,
    state: 'RECONCILED',
    counts: counts(),
    members: [member()],
    ruleVersion: 'provider-reconciliation.v1',
    ...over,
  };
}

const AUTHORITY: MeasureSourceAuthorityDeclaration = {
  dimension: 'CAMPAIGN',
  memberExternalId: CAMPAIGN,
  metric: 'REVENUE',
  sourceKey: 'provider-calls',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
};

function readinessInput(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    metric: 'REVENUE',
    dates: DATES,
    observation: observation(),
    partitions: [{ dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN, localCalls: 200 }],
    unattributedCalls: 0,
    reconciliation: DATES.map((d) => day(d)),
    authorities: [AUTHORITY],
    sources: [SOURCE],
    outcomeDays: [],
    ...over,
  };
}

const READY: MeasurementReadiness = assessReadiness(readinessInput());

function evidence(over: Partial<FindingEvidenceRef> = {}): FindingEvidenceRef {
  return {
    id: 'ev-1',
    source: 'commercial-intelligence',
    metricKey: 'REVENUE',
    window: '2026-08-04..2026-08-05',
    value: 12_500,
    completeness: 1,
    ...over,
  };
}

function input(over: Partial<FindingEstablishmentInput> = {}): FindingEstablishmentInput {
  return {
    claimKind: 'MEASUREMENT_BACKED',
    current: true,
    readiness: READY,
    supporting: [evidence()],
    contradicting: [],
    ...over,
  };
}

const UNJUDGED: FindingRecordFacts = {
  status: 'PROPOSED',
  supersededById: null,
  acceptedBy: null,
  acceptedAt: null,
  rejectedBy: null,
  rejectedAt: null,
};
const ACCEPTED: FindingRecordFacts = {
  ...UNJUDGED,
  status: 'ACCEPTED',
  acceptedBy: 'user_lexi',
  acceptedAt: '2026-08-26T14:05:00.000Z',
};
const REJECTED: FindingRecordFacts = {
  ...UNJUDGED,
  status: 'REJECTED',
  rejectedBy: 'user_charlie',
  rejectedAt: '2026-08-26T15:40:00.000Z',
};

// --- The path that must work ------------------------------------------------------

test('a measurement-backed claim over a READY window with complete evidence establishes', () => {
  assert.equal(READY.ready, true, 'the fixture window must be READY or nothing below means anything');
  const v = assessFindingEstablishment(input());
  assert.equal(v.eligible, true);
  assert.equal(v.basis, 'DETERMINISTIC_POLICY');
  assert.deepEqual(v.reasons, []);
  assert.deepEqual(v.readinessWithholdings, []);
  assert.equal(v.ruleVersion, FINDING_ESTABLISHMENT_RULE_VERSION);
});

// --- The claim itself ----------------------------------------------------------------

test('a non-measurement claim can never establish itself, whatever else is true', () => {
  const v = assessFindingEstablishment(input({ claimKind: 'NON_MEASUREMENT' }));
  assert.equal(v.eligible, false);
  assert.deepEqual(v.reasons, ['CLAIM_NOT_MEASUREMENT_BACKED']);
  // AND NOTHING ELSE IS LISTED. Fixing the evidence would not help, so listing
  // evidence problems underneath would suggest it might.
  assert.equal(v.basis, null);
});

test('a claim that is no longer current cannot establish', () => {
  const v = assessFindingEstablishment(input({ current: false }));
  assert.deepEqual(v.reasons, ['FINDING_NOT_CURRENT']);
});

// --- The Stage 3 proof -----------------------------------------------------------------

test('no readiness verdict is a refusal, never a pass', () => {
  const v = assessFindingEstablishment(input({ readiness: null }));
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.includes('READINESS_NOT_PROVEN'));
});

test('a verdict from a superseded gate version establishes nothing', () => {
  const stale: MeasurementReadiness = { ...READY, ruleVersion: 'measurement-readiness.v0' };
  const v = assessFindingEstablishment(input({ readiness: stale }));
  assert.deepEqual(v.reasons, ['READINESS_RULE_SUPERSEDED']);
});

test('an unobserved day in the window blocks autonomous establishment as incomplete coverage', () => {
  const readiness = assessReadiness(readinessInput({ observation: observation({ '2026-08-05': null }) }));
  assert.equal(readiness.ready, false);
  const v = assessFindingEstablishment(input({ readiness }));
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.includes('COVERAGE_INCOMPLETE'));
  assert.ok(v.readinessWithholdings.includes('WINDOW_NOT_OBSERVED'));
});

test('an unreconciled day blocks autonomous establishment', () => {
  const readiness = assessReadiness(readinessInput({ reconciliation: [day('2026-08-04')] }));
  const v = assessFindingEstablishment(input({ readiness }));
  assert.ok(v.reasons.includes('RECONCILIATION_INCOMPLETE'));
  assert.ok(v.readinessWithholdings.includes('RECONCILIATION_MISSING'));
});

test('unresolved source authority blocks autonomous establishment', () => {
  const readiness = assessReadiness(readinessInput({ authorities: [] }));
  const v = assessFindingEstablishment(input({ readiness }));
  assert.ok(v.reasons.includes('SOURCE_AUTHORITY_UNRESOLVED'));
  assert.ok(v.readinessWithholdings.includes('SOURCE_AUTHORITY_MISSING'));
});

test('two sources claiming the same measure blocks autonomous establishment', () => {
  const readiness = assessReadiness(
    readinessInput({
      authorities: [AUTHORITY, { ...AUTHORITY, sourceKey: 'provider-calls', effectiveFrom: '2026-02-01' }],
    }),
  );
  const v = assessFindingEstablishment(input({ readiness }));
  assert.ok(v.reasons.includes('SOURCE_AUTHORITY_UNRESOLVED'));
  assert.ok(v.readinessWithholdings.includes('SOURCE_AUTHORITY_CONFLICT'));
});

test('a withheld measurement a person must answer is reported as withheld, not as coverage', () => {
  const undeclared = DATES.map((d) => day(d, { members: [member({ expectation: 'UNKNOWN' })] }));
  const readiness = assessReadiness(readinessInput({ reconciliation: undeclared }));
  const v = assessFindingEstablishment(input({ readiness }));
  assert.ok(v.reasons.includes('MEASUREMENT_WITHHELD'));
  assert.ok(v.readinessWithholdings.includes('CAMPAIGN_EXPECTATION_UNKNOWN'));
});

test('every readiness withholding maps to a refusal — no silent fall-through', () => {
  for (const w of READINESS_WITHHOLDINGS) {
    const mapped = FINDING_REASON_BY_WITHHOLDING[w];
    assert.ok(mapped, `${w} maps to nothing`);
    assert.ok(FINDING_INELIGIBILITY_REASONS.includes(mapped), `${w} maps outside the vocabulary`);
  }
});

test('a verdict that is not ready but names nothing is still refused', () => {
  const impossible: MeasurementReadiness = { ...READY, ready: false, findings: [] };
  const v = assessFindingEstablishment(input({ readiness: impossible }));
  assert.deepEqual(v.reasons, ['MEASUREMENT_WITHHELD']);
});

// --- The evidence on the case ----------------------------------------------------------

test('a claim with nothing supporting it cannot establish', () => {
  const v = assessFindingEstablishment(input({ supporting: [] }));
  assert.deepEqual(v.reasons, ['NO_SUPPORTING_EVIDENCE']);
});

test('evidence that only partly reported cannot establish a claim', () => {
  const v = assessFindingEstablishment(input({ supporting: [evidence({ completeness: 0.82 })] }));
  assert.deepEqual(v.reasons, ['EVIDENCE_INCOMPLETE']);
});

test('unstated completeness is its own refusal — silence is not "all of it"', () => {
  const v = assessFindingEstablishment(input({ supporting: [evidence({ completeness: null })] }));
  assert.deepEqual(v.reasons, ['EVIDENCE_COMPLETENESS_UNSTATED']);
});

test('contradicting evidence blocks establishment', () => {
  const v = assessFindingEstablishment(
    input({
      contradicting: [
        {
          metricKey: 'REVENUE',
          window: '2026-08-04..2026-08-05',
          evidenceIds: ['ev-1', 'ev-2'],
          values: [12_500, 9_900],
          sources: ['commercial-intelligence', 'buyer-report'],
        },
      ],
    }),
  );
  assert.deepEqual(v.reasons, ['EVIDENCE_CONFLICTED']);
});

test('every refusal accumulates, deduped, so one pass shows every problem', () => {
  const readiness = assessReadiness(readinessInput({ authorities: [], reconciliation: [day('2026-08-04')] }));
  const v = assessFindingEstablishment(
    input({
      readiness,
      supporting: [evidence({ completeness: 0.5 }), evidence({ id: 'ev-2', completeness: 0.5 })],
    }),
  );
  assert.ok(v.reasons.includes('RECONCILIATION_INCOMPLETE'));
  assert.ok(v.reasons.includes('SOURCE_AUTHORITY_UNRESOLVED'));
  assert.ok(v.reasons.includes('EVIDENCE_INCOMPLETE'));
  assert.equal(new Set(v.reasons).size, v.reasons.length, 'reasons must be deduped');
});

test('the gate is deterministic — same input, same verdict', () => {
  const built = input();
  assert.deepEqual(assessFindingEstablishment(built), assessFindingEstablishment(built));
});

// --- Contradiction detection ----------------------------------------------------------

test('two sources disagreeing about the same metric and window contradict', () => {
  const found = findEvidenceContradictions([
    evidence({ id: 'a', source: 'commercial-intelligence', value: 12_500 }),
    evidence({ id: 'b', source: 'buyer-report', value: 9_900 }),
  ]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]?.evidenceIds, ['a', 'b']);
});

test('one source restating its own number is a revision, not a contradiction', () => {
  const found = findEvidenceContradictions([
    evidence({ id: 'a', source: 'commercial-intelligence', value: 12_500 }),
    evidence({ id: 'b', source: 'commercial-intelligence', value: 9_900 }),
  ]);
  assert.deepEqual(found, []);
});

test('two sources agreeing is not a contradiction', () => {
  const found = findEvidenceContradictions([
    evidence({ id: 'a', source: 'commercial-intelligence', value: 12_500 }),
    evidence({ id: 'b', source: 'buyer-report', value: 12_500 }),
  ]);
  assert.deepEqual(found, []);
});

test('different windows are different measurements and cannot contradict', () => {
  const found = findEvidenceContradictions([
    evidence({ id: 'a', source: 'commercial-intelligence', window: 'w1', value: 1 }),
    evidence({ id: 'b', source: 'buyer-report', window: 'w2', value: 2 }),
  ]);
  assert.deepEqual(found, []);
});

test('evidence expressing no value cannot disagree with anything', () => {
  const found = findEvidenceContradictions([
    evidence({ id: 'a', source: 'commercial-intelligence', value: null }),
    evidence({ id: 'b', source: 'buyer-report', value: 9_900 }),
  ]);
  assert.deepEqual(found, []);
});

// --- The vocabulary --------------------------------------------------------------------

test('a stored hypothesis type round-trips to its claim kind', () => {
  for (const kind of FINDING_CLAIM_KINDS) {
    assert.equal(findingClaimKind(findingHypothesisType(kind)), kind);
    assert.ok(findingHypothesisType(kind).startsWith(FINDING_TYPE_PREFIX));
  }
});

test('a hypothesis written by some other producer is not a Finding', () => {
  assert.equal(findingClaimKind('callgrid-anomaly'), null);
  assert.equal(findingClaimKind(`${FINDING_TYPE_PREFIX}SOMETHING_ELSE`), null);
});

// --- The three axes -----------------------------------------------------------------

test('evidence state is the gate\'s verdict and nothing else', () => {
  assert.deepEqual([...FINDING_EVIDENCE_STATES], ['DEVELOPING', 'ESTABLISHED']);
  assert.equal(findingEvidenceState(assessFindingEstablishment(input())), 'ESTABLISHED');
  assert.equal(
    findingEvidenceState(assessFindingEstablishment(input({ supporting: [] }))),
    'DEVELOPING',
  );
});

test('accepting a claim is not a way to establish it', () => {
  // THE PROPERTY THIS WHOLE PR EXISTS FOR. There is no argument, and no input,
  // through which a person's acceptance reaches the gate: the only basis the
  // vocabulary has is the deterministic one.
  assert.deepEqual([...FINDING_ESTABLISHMENT_BASES], ['DETERMINISTIC_POLICY']);
  // IN THE CODE, NOT IN THE PROSE. The comments explain why the human basis was
  // removed, so the check strips them first rather than depending on wording
  // nobody is allowed to edit.
  const code = SOURCE_TEXT.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.equal(/HUMAN_ACCEPTANCE/.test(code), false);
  // AND THE GATE ITSELF CANNOT SEE A JUDGEMENT. Its whole body, comments
  // stripped, never mentions one -- there is nothing for an acceptance to reach.
  const gate = code.slice(
    code.indexOf('export function assessFindingEstablishment('),
    code.indexOf('function refused('),
  );
  assert.ok(gate.length > 200, 'the gate body was found');
  assert.equal(/accept|reject|judg/i.test(gate), false, 'no judgement reaches the gate');
  // A claim with nothing under it stays developing however it is judged.
  const bare = assessFindingEstablishment(input({ supporting: [] }));
  for (const facts of [ACCEPTED, REJECTED, UNJUDGED]) {
    assert.equal(findingEvidenceState(bare), 'DEVELOPING', facts.status);
  }
});

test('a rejected claim is still evaluated, and can be established', () => {
  // Rejection is a judgment. It is not a lifecycle and it is not evidence, so a
  // rejected claim goes through the gate exactly as an unjudged one does.
  assert.equal(findingLifecycle(REJECTED), 'CURRENT');
  assert.equal(findingEvidenceState(assessFindingEstablishment(input())), 'ESTABLISHED');
  assert.equal(findingJudgment(REJECTED)?.judgment, 'REJECTED');
});

test('a judgment carries who made it and when', () => {
  const accepted = findingJudgment(ACCEPTED);
  assert.equal(accepted?.judgment, 'ACCEPTED');
  assert.equal(accepted?.byUserId, 'user_lexi');
  assert.equal(accepted?.at, '2026-08-26T14:05:00.000Z');
  assert.equal(findingJudgment(UNJUDGED), null, 'nobody judging is an absence, not a verdict');
  assert.deepEqual([...FINDING_JUDGMENTS], ['ACCEPTED', 'REJECTED']);
});

test('the latest judgment wins, and an unattributed status is still reported', () => {
  // The columns are overwritten in place, so the later timestamp is the latest
  // act. Anything earlier is lost until a hypothesis lifecycle log exists.
  const acceptedThenRejected: FindingRecordFacts = {
    ...ACCEPTED,
    status: 'REJECTED',
    rejectedBy: 'user_charlie',
    rejectedAt: '2026-08-27T09:00:00.000Z',
  };
  assert.equal(findingJudgment(acceptedThenRejected)?.judgment, 'REJECTED');
  const reaccepted: FindingRecordFacts = {
    ...acceptedThenRejected,
    status: 'ACCEPTED',
    acceptedAt: '2026-08-28T09:00:00.000Z',
  };
  assert.equal(findingJudgment(reaccepted)?.judgment, 'ACCEPTED');
  const untimed: FindingRecordFacts = { ...UNJUDGED, status: 'ACCEPTED' };
  assert.deepEqual(findingJudgment(untimed), { judgment: 'ACCEPTED', byUserId: null, at: null });
});

test('lifecycle answers only whether this is still the claim', () => {
  assert.deepEqual([...FINDING_LIFECYCLES], ['CURRENT', 'SUPERSEDED', 'EXPIRED']);
  assert.equal(findingLifecycle(UNJUDGED), 'CURRENT');
  assert.equal(findingLifecycle({ ...UNJUDGED, supersededById: 'fnd_2' }), 'SUPERSEDED');
  assert.equal(findingLifecycle({ ...UNJUDGED, status: 'SUPERSEDED' }), 'SUPERSEDED');
  assert.equal(findingLifecycle({ ...UNJUDGED, status: 'EXPIRED' }), 'EXPIRED');
  // AND NOT WHAT ANYBODY DECIDED.
  assert.equal(findingLifecycle(ACCEPTED), 'CURRENT');
  assert.equal(findingLifecycle(REJECTED), 'CURRENT');
});

test('the three axes are independent: all four combinations are representable', () => {
  const combinations = [
    [findingEvidenceState(assessFindingEstablishment(input())), findingJudgment(ACCEPTED)?.judgment],
    [findingEvidenceState(assessFindingEstablishment(input())), findingJudgment(REJECTED)?.judgment],
    [
      findingEvidenceState(assessFindingEstablishment(input({ supporting: [] }))),
      findingJudgment(ACCEPTED)?.judgment,
    ],
    [
      findingEvidenceState(assessFindingEstablishment(input({ supporting: [] }))),
      findingJudgment(REJECTED)?.judgment,
    ],
  ];
  assert.deepEqual(combinations, [
    ['ESTABLISHED', 'ACCEPTED'],
    ['ESTABLISHED', 'REJECTED'],
    ['DEVELOPING', 'ACCEPTED'],
    ['DEVELOPING', 'REJECTED'],
  ]);
});

test('every refusal has a sentence a person can read', () => {
  for (const r of FINDING_INELIGIBILITY_REASONS) {
    const label = FINDING_INELIGIBILITY_LABELS[r];
    assert.ok(label && label.length > 20, `${r} has no readable label`);
  }
});

test('the case-log predicates match only their own exact line', () => {
  assert.equal(isFindingRecorded({ observationType: 'NOTE_ADDED', reason: FINDING_RECORDED_REASON }), true);
  assert.equal(isFindingRecorded({ observationType: 'REVIEWED', reason: FINDING_RECORDED_REASON }), false);
  assert.equal(isFindingRecorded({ observationType: 'NOTE_ADDED', reason: 'a note' }), false);
  assert.equal(isFindingRecorded({ observationType: 'NOTE_ADDED', reason: FINDING_SUPERSEDED_REASON }), false);
  assert.equal(
    isFindingSuperseded({ observationType: 'NOTE_ADDED', reason: FINDING_SUPERSEDED_REASON }),
    true,
  );
});

// --- What the contract must NOT carry ---------------------------------------------------

test('the Finding contract carries no confidence percentage', () => {
  // `IntelligenceHypothesis.confidence` exists and nothing reads it, so it has no
  // governed meaning. A number with no governed meaning rendered beside a claim
  // is read as authority it does not have.
  assert.equal(
    /\bconfidence\s*[?]?\s*:/.test(SOURCE_TEXT),
    false,
    'no field in the Finding contract may declare a confidence value',
  );
});

test('the gate reads a readiness verdict and never re-derives one', () => {
  // THERE IS NO SECOND READINESS ENGINE. If this file ever imports the gate's
  // inputs or judges a business date itself, it has become the thing it exists
  // to prevent.
  assert.equal(SOURCE_TEXT.includes('assessReadiness('), false);
  assert.equal(SOURCE_TEXT.includes('ReadinessInput'), false);
  assert.ok(SOURCE_TEXT.includes('MEASUREMENT_READINESS_RULE_VERSION'));
  assert.equal(MEASUREMENT_READINESS_RULE_VERSION, READY.ruleVersion);
});

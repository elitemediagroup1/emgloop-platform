// Governed Findings — what Loop concludes on an investigation, and what it is
// allowed to call settled.
//
// WHAT THESE PROVE
//
// Four properties carry the PR.
//
// ESTABLISHMENT CANNOT BE SELF-AWARDED. A measurement-backed claim reaches
// ESTABLISHED only when the deterministic Stage 3 verdict says the measure under
// it is eligible; a non-measurement claim never reaches it autonomously at all,
// whatever generated it and however sure it sounds. Both are proved by driving
// the real service against real readiness verdicts produced by `assessReadiness`
// over deliberately broken populations, not against hand-written literals.
//
// ESTABLISHMENT DECAYS ON ITS OWN. It is derived on every read, so the SAME
// stored Finding is ESTABLISHED under a clean verdict and DEVELOPING under a
// degraded one, with no job run and no row corrected in between.
//
// A CLAIM IS NEVER EDITED. There is no update path. Recording over an existing
// Finding writes nothing unless the caller says it is superseding, and a
// supersession leaves the previous claim's words, window and generator exactly
// as they were.
//
// THE HUMAN PATH IS THE ONE THAT ALREADY EXISTED. Acceptance goes through
// `IntelligenceHypothesisRepository`, which still refuses an unattributed actor.
// Nothing in Stage 4 reaches around it.
//
// They run on the in-memory Prisma double with the REAL Decision Engine and the
// REAL hypothesis repository underneath, so tenancy, linkage and supersession are
// exercised rather than mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FINDING_RECORDED_REASON,
  FINDING_SUPERSEDED_REASON,
  INVESTIGATION_PRODUCER,
  assessReadiness,
  assessWindowObservation,
  investigationRecurrenceKey,
  isFindingRecorded,
  isFindingSuperseded,
  type BusinessDate,
  type HeadlineView,
  type MeasureSourceAuthorityDeclaration,
  type MeasurementReadiness,
  type MeasurementSourceDefinition,
  type ProviderObservationStatus,
  type ReadinessInput,
  type ReconciliationCounts,
  type ReconciliationDayFact,
  type ReconciliationMemberFact,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { IntelligenceHypothesisRepository } from '../src/repositories/cognitive/hypothesis.repository';
import { CaseFindingService, type CaseFindingDeps } from '../src/services/case-finding.service';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';
const HEADLINE_ID = 'hl_cem';
const OBJECTIVE_ID = 'obj_medicare';
const NOW = new Date('2026-08-23T14:30:00.000Z');

const SYSTEM = { type: 'SYSTEM' as const, userId: null, source: INVESTIGATION_PRODUCER };
const HUMAN = { type: 'HUMAN' as const, userId: 'usr_matt', source: 'operator' };

// --- Readiness fixtures. Real verdicts, from the real gate. ------------------------

const DATES: BusinessDate[] = ['2026-08-04', '2026-08-05'];
const CAMPAIGN = 'cmp-medicare';

const SOURCE: MeasurementSourceDefinition = {
  key: 'provider-calls',
  kind: 'PROVIDER_STREAM',
  displayName: 'Call provider',
  supportedMetrics: ['CALL_VOLUME', 'REVENUE'],
  measureDefinitionIds: { CALL_VOLUME: 'calls.provider.v1', REVENUE: 'revenue.provider.v1' },
  provider: 'callgrid',
  stream: 'calls',
};

const AUTHORITY: MeasureSourceAuthorityDeclaration = {
  dimension: 'CAMPAIGN',
  memberExternalId: CAMPAIGN,
  metric: 'REVENUE',
  sourceKey: 'provider-calls',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
};

function observedWindow(drop?: BusinessDate) {
  const m = new Map<BusinessDate, ProviderObservationStatus>();
  for (const d of DATES) if (d !== drop) m.set(d, 'SUCCESS');
  return assessWindowObservation(DATES, m);
}

function counts(): ReconciliationCounts {
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

function verdict(over: Partial<ReadinessInput> = {}): MeasurementReadiness {
  return assessReadiness({
    metric: 'REVENUE',
    dates: DATES,
    observation: observedWindow(),
    partitions: [{ dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN, localCalls: 200 }],
    unattributedCalls: 0,
    reconciliation: DATES.map((d) => day(d)),
    authorities: [AUTHORITY],
    sources: [SOURCE],
    outcomeDays: [],
    ...over,
  });
}

const READY = verdict();

// --- The world ----------------------------------------------------------------------

function headline(over: Partial<HeadlineView> = {}): HeadlineView {
  return {
    id: HEADLINE_ID,
    performanceObjectiveId: OBJECTIVE_ID,
    objectiveTitle: 'Grow Medicare answer rate',
    measureBindingId: 'bind_1',
    measureBindingVersion: 3,
    measurement: {
      metric: 'MONETIZED_RATE',
      metricLabel: 'Monetized rate',
      unit: 'RATIO',
      movement: 'DECREASE',
      againstObjective: true,
      currentValue: 0.412,
      priorValue: 0.597,
      absoluteChange: -0.185,
      percentageChange: -0.31,
      currentDenominator: 3184,
      priorDenominator: 2996,
      currentCoverage: 0.98,
      priorCoverage: 0.99,
      comparisonBasis: 'Trailing 7 complete Eastern business days.',
      currentWindowStart: '2026-08-15T04:00:00.000Z',
      currentWindowEnd: '2026-08-22T04:00:00.000Z',
      priorWindowStart: '2026-08-08T04:00:00.000Z',
      priorWindowEnd: '2026-08-15T04:00:00.000Z',
    },
    statement: "Buyer CEM's monetized rate fell from 59.7% to 41.2%.",
    limitations: ['Postback destinations settle after the call.'],
    unknowns: ['2% of calls carry no billable answer yet.'],
    ruleId: 'ci.objective-measure-change',
    ruleVersion: 'v1',
    producerVersion: 'ci-headline.v1',
    ruleDescription: 'A move of at least 15% over at least 200 calls.',
    firstDetectedAt: '2026-08-20T11:02:00.000Z',
    lastDetectedAt: '2026-08-22T06:15:00.000Z',
    detectionCount: 3,
    dismissedAt: null,
    dismissedByUserId: null,
    dismissedByName: null,
    dismissalBasis: null,
    createdAt: '2026-08-20T11:02:00.000Z',
    ...over,
  };
}

/** A Headline read that answers only for the organization that owns it. */
function headlines(org = ORG) {
  return {
    async get(organizationId: string, id: string) {
      return organizationId === org && id === HEADLINE_ID ? headline() : null;
    },
  };
}

/** A readiness seam that answers only for the objective the Headline names. */
function readinessOf(readiness: MeasurementReadiness | null) {
  const asked: string[] = [];
  return {
    asked,
    reader: {
      async readinessFor(organizationId: string, performanceObjectiveId: string) {
        asked.push(`${organizationId}:${performanceObjectiveId}`);
        if (performanceObjectiveId !== OBJECTIVE_ID || !readiness) return null;
        return { readiness };
      },
    },
  };
}

type EvidenceSpec = {
  source?: string;
  metricKey?: string;
  window?: string | null;
  derivedValue?: number | null;
  completeness?: number | null;
  unknowns?: string[];
};

async function world(
  options: {
    readiness?: MeasurementReadiness | null;
    evidence?: EvidenceSpec[];
    deps?: CaseFindingDeps;
  } = {},
) {
  const prisma = makeCognitivePrisma();
  const engine = new DecisionEngine(prisma as never);
  const hypotheses = new IntelligenceHypothesisRepository(prisma as never);
  const seam = readinessOf(options.readiness === undefined ? READY : options.readiness);

  const findings = new CaseFindingService(prisma as never, {
    cases: engine,
    headlines: headlines(),
    hypotheses,
    readiness: seam.reader,
    ...options.deps,
  });

  const { decision } = await engine.create(ORG, {
    producer: INVESTIGATION_PRODUCER,
    recurrenceKey: investigationRecurrenceKey(HEADLINE_ID),
    detectionKey: `promotion:${HEADLINE_ID}`,
    detectedAt: NOW,
    title: "Buyer CEM's monetized rate fell from 59.7% to 41.2%.",
    severity: 'NOTABLE',
    sourceReference: HEADLINE_ID,
    evidence: (options.evidence ?? [{}]).map((e) => ({
      source: e.source ?? INVESTIGATION_PRODUCER,
      metricKey: e.metricKey ?? 'MONETIZED_RATE',
      window: e.window === undefined ? 'Trailing 7 business days' : e.window,
      derivedValue: e.derivedValue === undefined ? 0.412 : e.derivedValue,
      completeness: e.completeness === undefined ? 1 : e.completeness,
      unknowns: e.unknowns ?? [],
    })),
  });

  return { prisma, engine, hypotheses, findings, caseId: decision.id, seam };
}

const CLAIM = {
  claim: 'CEM stopped settling same-day, so monetized rate reads low.',
  conclusion: 'The fall is a settlement-timing artefact, not lost demand.',
  claimKind: 'MEASUREMENT_BACKED' as const,
  generatedBy: 'DETERMINISTIC_RULE' as const,
  actor: SYSTEM,
};

// --- Linkage --------------------------------------------------------------------------

test('a finding links to the case, and the case records that it did', async () => {
  const { findings, engine, caseId, prisma } = await world();

  const result = await findings.record(ORG, caseId, CLAIM);
  assert.equal(result.outcome, 'RECORDED');
  assert.ok(result.findingId);

  const view = await engine.get(ORG, caseId);
  assert.equal(view?.decision.hypothesisId, result.findingId);

  // The attachment is on the investigation's own append-only log, matched by the
  // shared predicate rather than by reading the text here.
  const log = await prisma.operationalObservation.findMany({ where: { priorityId: caseId } });
  assert.equal(log.filter((o: any) => isFindingRecorded(o)).length, 1);

  const finding = await findings.get(ORG, caseId, NOW);
  assert.equal(finding?.findingId, result.findingId);
  assert.equal(finding?.caseId, caseId);
  assert.equal(finding?.claim, CLAIM.claim);
  assert.equal(finding?.conclusion, CLAIM.conclusion);
});

test('a finding is stored PROPOSED and carries no confidence number', async () => {
  const { findings, hypotheses, caseId } = await world();
  const { findingId } = await findings.record(ORG, caseId, CLAIM);
  const stored = await hypotheses.findById(ORG, findingId!);
  assert.equal(stored?.status, 'PROPOSED');
  assert.equal(stored?.confidence, null);
});

// --- Developing --------------------------------------------------------------------

test('a developing finding can exist with unknowns, and exposes them', async () => {
  const { findings, caseId } = await world({
    readiness: null,
    evidence: [{ completeness: null, unknowns: ['2% of calls carry no billable answer yet.'] }],
  });
  await findings.record(ORG, caseId, CLAIM);

  const finding = await findings.get(ORG, caseId, NOW);
  assert.equal(finding?.state, 'DEVELOPING');
  assert.ok(finding?.reasoning.missing.includes('2% of calls carry no billable answer yet.'));
});

test('a developing finding exposes known, inferred, missing and contradictory', async () => {
  const { findings, caseId } = await world({
    readiness: null,
    evidence: [
      { source: 'commercial-intelligence', derivedValue: 0.412 },
      { source: 'buyer-report', derivedValue: 0.59 },
    ],
  });
  await findings.record(ORG, caseId, CLAIM);
  const r = (await findings.get(ORG, caseId, NOW))!.reasoning;

  assert.equal(r.known.length, 2, 'every piece of evidence is a known fact citing its row');
  assert.ok(r.known.every((k) => k.evidenceId));

  // INFERRED IS EMPTY AND SAYS SO. Nothing writes out the steps between a
  // measurement and a conclusion, and restating the claim here would look like
  // Loop had shown its working.
  assert.deepEqual(r.inferred, []);
  assert.ok(r.unavailable.INFERRED);

  assert.ok(r.missing.length > 0, 'a developing finding names what would settle it');
  assert.equal(r.contradictory.length, 1);
  assert.deepEqual(r.contradictory[0]?.sources, ['commercial-intelligence', 'buyer-report']);
});

// --- Autonomous establishment ------------------------------------------------------

test('a measurement-backed finding establishes when the Stage 3 verdict is READY', async () => {
  const { findings, caseId, seam } = await world();
  await findings.record(ORG, caseId, CLAIM);

  const finding = await findings.get(ORG, caseId, NOW);
  assert.equal(finding?.state, 'ESTABLISHED');
  assert.equal(finding?.establishedBy, 'DETERMINISTIC_POLICY');
  // NO ACTOR, BECAUSE NO PERSON DECIDED. A policy establishment is an evaluation.
  assert.equal(finding?.establishedByUserId, null);
  assert.deepEqual(finding?.establishment.reasons, []);
  assert.deepEqual(seam.asked, [`${ORG}:${OBJECTIVE_ID}`]);
});

test('establishment is DERIVED — the same stored finding un-establishes when its evidence degrades', async () => {
  const { findings, caseId, prisma, hypotheses } = await world();
  const { findingId } = await findings.record(ORG, caseId, CLAIM);
  assert.equal((await findings.get(ORG, caseId, NOW))?.state, 'ESTABLISHED');

  // NOTHING IS CORRECTED. The stored row is untouched; only the world changed.
  const degraded = new CaseFindingService(prisma as never, {
    cases: new DecisionEngine(prisma as never),
    headlines: headlines(),
    hypotheses,
    readiness: readinessOf(verdict({ reconciliation: [day('2026-08-04')] })).reader,
  });
  const after = await degraded.get(ORG, caseId, NOW);
  assert.equal(after?.findingId, findingId);
  assert.equal(after?.state, 'DEVELOPING');
  assert.ok(after?.establishment.reasons.includes('RECONCILIATION_INCOMPLETE'));
});

test('a withheld measurement cannot autonomously establish', async () => {
  const undeclared = DATES.map((d) => day(d, { members: [member({ expectation: 'UNKNOWN' })] }));
  const { findings, caseId } = await world({ readiness: verdict({ reconciliation: undeclared }) });
  await findings.record(ORG, caseId, CLAIM);
  const finding = await findings.get(ORG, caseId, NOW);
  assert.equal(finding?.state, 'DEVELOPING');
  assert.ok(finding?.establishment.reasons.includes('MEASUREMENT_WITHHELD'));
  assert.ok(finding?.establishment.readinessWithholdings.includes('CAMPAIGN_EXPECTATION_UNKNOWN'));
});

test('incomplete coverage cannot autonomously establish', async () => {
  const { findings, caseId } = await world({
    readiness: verdict({ observation: observedWindow('2026-08-05') }),
  });
  await findings.record(ORG, caseId, CLAIM);
  const finding = await findings.get(ORG, caseId, NOW);
  assert.equal(finding?.state, 'DEVELOPING');
  assert.ok(finding?.establishment.reasons.includes('COVERAGE_INCOMPLETE'));
});

test('unresolved source authority cannot autonomously establish', async () => {
  const { findings, caseId } = await world({ readiness: verdict({ authorities: [] }) });
  await findings.record(ORG, caseId, CLAIM);
  const finding = await findings.get(ORG, caseId, NOW);
  assert.equal(finding?.state, 'DEVELOPING');
  assert.ok(finding?.establishment.reasons.includes('SOURCE_AUTHORITY_UNRESOLVED'));
});

test('contradicting evidence blocks autonomous establishment even over a READY window', async () => {
  const { findings, caseId } = await world({
    evidence: [
      { source: 'commercial-intelligence', derivedValue: 0.412 },
      { source: 'buyer-report', derivedValue: 0.59 },
    ],
  });
  await findings.record(ORG, caseId, CLAIM);
  const finding = await findings.get(ORG, caseId, NOW);
  assert.equal(finding?.state, 'DEVELOPING');
  assert.ok(finding?.establishment.reasons.includes('EVIDENCE_CONFLICTED'));
});

test('no readiness seam at all fails closed rather than open', async () => {
  const { findings, caseId } = await world({ readiness: null });
  await findings.record(ORG, caseId, CLAIM);
  const finding = await findings.get(ORG, caseId, NOW);
  assert.equal(finding?.state, 'DEVELOPING');
  assert.ok(finding?.establishment.reasons.includes('READINESS_NOT_PROVEN'));
});

test('a non-measurement finding never establishes itself, even generated by a model', async () => {
  const { findings, caseId, seam } = await world();
  await findings.record(ORG, caseId, {
    ...CLAIM,
    claimKind: 'NON_MEASUREMENT',
    generatedBy: 'AI_MODEL',
  });
  const finding = await findings.get(ORG, caseId, NOW);
  assert.equal(finding?.state, 'DEVELOPING');
  assert.equal(finding?.generatedBy, 'AI_MODEL');
  assert.deepEqual(finding?.establishment.reasons, ['CLAIM_NOT_MEASUREMENT_BACKED']);
  // AND THE GATE IS NOT EVEN CONSULTED. A verdict cannot be made to look like
  // permission for a claim it says nothing about.
  assert.deepEqual(seam.asked, []);
});

test('a person can establish a non-measurement finding by accepting it', async () => {
  const { findings, caseId } = await world();
  const { findingId } = await findings.record(ORG, caseId, {
    ...CLAIM,
    claimKind: 'NON_MEASUREMENT',
    generatedBy: 'HUMAN',
  });
  await findings.accept(ORG, findingId!, HUMAN.userId);

  const finding = await findings.get(ORG, caseId, NOW);
  assert.equal(finding?.state, 'ESTABLISHED');
  assert.equal(finding?.establishedBy, 'HUMAN_ACCEPTANCE');
  assert.equal(finding?.establishedByUserId, HUMAN.userId);
  assert.ok(finding?.establishedAt);
});

// --- The human path, unchanged -------------------------------------------------------

test('acceptance still refuses an unattributed actor', async () => {
  const { findings, caseId } = await world();
  const { findingId } = await findings.record(ORG, caseId, CLAIM);
  await assert.rejects(() => findings.accept(ORG, findingId!, '  '), /attributed actor/);
});

test('a person can reject a finding, and it stays on the case as history', async () => {
  const { findings, caseId, hypotheses } = await world();
  const { findingId } = await findings.record(ORG, caseId, CLAIM);
  await findings.reject(ORG, findingId!, HUMAN.userId);

  const stored = await hypotheses.findById(ORG, findingId!);
  assert.equal(stored?.status, 'REJECTED');
  assert.equal(stored?.rejectedBy, HUMAN.userId);

  const finding = await findings.get(ORG, caseId, NOW);
  assert.equal(finding?.state, 'REJECTED');
  // A REJECTED CLAIM CANNOT BE ESTABLISHED BY A CLEAN WINDOW. History does not
  // re-open because the measurement happens to be sound.
  assert.equal(finding?.establishedBy, null);
  assert.deepEqual(finding?.establishment.reasons, ['FINDING_NOT_LIVE']);
});

// --- Not silently editable ------------------------------------------------------------

test('the finding service and the hypothesis repository expose no edit path', async () => {
  const service = Object.getOwnPropertyNames(CaseFindingService.prototype);
  for (const forbidden of ['update', 'edit', 'revise', 'setClaim', 'establish']) {
    assert.equal(service.includes(forbidden), false, `CaseFindingService must not expose ${forbidden}`);
  }
  const repo = Object.getOwnPropertyNames(IntelligenceHypothesisRepository.prototype);
  for (const forbidden of ['update', 'edit', 'revise']) {
    assert.equal(repo.includes(forbidden), false, `the repository must not expose ${forbidden}`);
  }
});

test('recording over an existing finding writes nothing unless it says it is superseding', async () => {
  const { findings, caseId, prisma } = await world();
  const first = await findings.record(ORG, caseId, CLAIM);

  const second = await findings.record(ORG, caseId, { ...CLAIM, claim: 'A different story.' });
  assert.equal(second.outcome, 'FINDING_ALREADY_RECORDED');
  assert.equal(second.findingId, first.findingId);

  // NOTHING WAS WRITTEN. Not a second hypothesis, not an observation.
  const stored = await prisma.intelligenceHypothesis.findMany({ where: { organizationId: ORG } });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].title, CLAIM.claim);
});

test('supersession preserves the previous finding in full', async () => {
  const { findings, engine, hypotheses, caseId, prisma } = await world();
  const first = await findings.record(ORG, caseId, CLAIM);

  const second = await findings.record(ORG, caseId, {
    ...CLAIM,
    claim: 'CEM cut spend; the settlement story was wrong.',
    conclusion: 'Demand really did fall.',
    supersedeExisting: true,
  });
  assert.equal(second.outcome, 'SUPERSEDED_PREVIOUS');
  assert.equal(second.supersededFindingId, first.findingId);

  // THE OLD CLAIM KEEPS ITS WORDS. Only its status and successor pointer moved.
  const old = await hypotheses.findById(ORG, first.findingId!);
  assert.equal(old?.title, CLAIM.claim);
  assert.equal(old?.summary, CLAIM.conclusion);
  assert.equal(old?.status, 'SUPERSEDED');
  assert.equal(old?.supersededById, second.findingId);

  const view = await engine.get(ORG, caseId);
  assert.equal(view?.decision.hypothesisId, second.findingId);

  const finding = await findings.get(ORG, caseId, NOW);
  assert.equal(finding?.findingId, second.findingId);
  assert.equal(finding?.lineage.length, 1);
  assert.equal(finding?.lineage[0]?.findingId, first.findingId);
  assert.equal(finding?.lineage[0]?.claim, CLAIM.claim);
  assert.equal(finding?.lineage[0]?.state, 'SUPERSEDED');

  const log = await prisma.operationalObservation.findMany({ where: { priorityId: caseId } });
  assert.equal(log.filter((o: any) => isFindingSuperseded(o)).length, 1);
});

test('lineage cannot be rewritten — a second successor is refused', async () => {
  const { hypotheses, findings, caseId } = await world();
  const first = await findings.record(ORG, caseId, CLAIM);
  await findings.record(ORG, caseId, { ...CLAIM, claim: 'Second.', supersedeExisting: true });

  const rival = await hypotheses.propose(ORG, {
    hypothesisType: 'case-finding:MEASUREMENT_BACKED',
    title: 'A rival successor.',
    generatedBy: 'DETERMINISTIC_RULE',
  });
  await assert.rejects(
    () => hypotheses.supersede(ORG, first.findingId!, rival.id),
    /already superseded/,
  );
});

test('a read mid-repair still shows the current claim', async () => {
  // A supersession interrupted between marking the old claim and relinking the
  // case leaves the column pointing backwards. The read follows the chain
  // forward, so a surface never shows a claim that has already been replaced.
  const { findings, hypotheses, engine, caseId, prisma } = await world();
  const first = await findings.record(ORG, caseId, CLAIM);
  const successor = await hypotheses.propose(ORG, {
    hypothesisType: 'case-finding:MEASUREMENT_BACKED',
    title: 'The claim that actually stands.',
    generatedBy: 'DETERMINISTIC_RULE',
  });
  await hypotheses.supersede(ORG, first.findingId!, successor.id);

  const finding = await findings.get(ORG, caseId, NOW);
  assert.equal(finding?.findingId, successor.id);
  // The stale column is still pointing at the old claim: the read did not fix it.
  const before = await engine.get(ORG, caseId);
  assert.equal(before?.decision.hypothesisId, first.findingId);

  // The next WRITE repairs it.
  await findings.record(ORG, caseId, { ...CLAIM, claim: 'Third.', supersedeExisting: true });
  const after = await prisma.operationalPriority.findFirst({ where: { id: caseId } });
  assert.notEqual(after.hypothesisId, first.findingId);
});

// --- Tenancy --------------------------------------------------------------------------

test('a case in another organization is not-found, and nothing is written', async () => {
  const { findings, caseId, prisma } = await world();
  const result = await findings.record(OTHER_ORG, caseId, CLAIM);
  assert.equal(result.outcome, 'CASE_NOT_FOUND');
  assert.equal(result.findingId, null);
  assert.equal((await prisma.intelligenceHypothesis.findMany({})).length, 0);
  assert.equal(await findings.get(OTHER_ORG, caseId, NOW), null);
});

test('a finding from another organization cannot be linked to this one', async () => {
  const { engine, hypotheses, caseId } = await world();
  const foreign = await hypotheses.propose(OTHER_ORG, {
    hypothesisType: 'case-finding:MEASUREMENT_BACKED',
    title: 'Another tenant’s belief.',
    generatedBy: 'DETERMINISTIC_RULE',
  });
  await assert.rejects(() =>
    engine.linkHypothesis(ORG, caseId, { hypothesisId: foreign.id, actor: SYSTEM }),
  );
});

test('a finding cannot be accepted or rejected across a tenant boundary', async () => {
  const { findings, caseId, hypotheses } = await world();
  const { findingId } = await findings.record(ORG, caseId, CLAIM);
  assert.equal(await findings.accept(OTHER_ORG, findingId!, HUMAN.userId), null);
  assert.equal(await findings.reject(OTHER_ORG, findingId!, HUMAN.userId), null);
  assert.equal((await hypotheses.findById(ORG, findingId!))?.status, 'PROPOSED');
});

test('lineage cannot be read across a tenant boundary', async () => {
  const { findings, hypotheses, caseId } = await world();
  const first = await findings.record(ORG, caseId, CLAIM);
  await findings.record(ORG, caseId, { ...CLAIM, claim: 'Second.', supersedeExisting: true });
  assert.deepEqual(await hypotheses.lineageOf(OTHER_ORG, first.findingId!), []);
});

// --- The case is not mutated outside its own path -------------------------------------

test('the case lane, owner, assignee and evidence are untouched by recording a finding', async () => {
  const { findings, engine, caseId } = await world();
  const before = await engine.get(ORG, caseId);
  await findings.record(ORG, caseId, CLAIM);
  await findings.record(ORG, caseId, { ...CLAIM, claim: 'Second.', supersedeExisting: true });
  const after = await engine.get(ORG, caseId);

  assert.equal(after?.currentState, before?.currentState);
  assert.equal(after?.ownerUserId, before?.ownerUserId);
  assert.equal(after?.assigneeUserId, before?.assigneeUserId);
  assert.equal(after?.evidence.length, before?.evidence.length);
  assert.equal(after?.decision.title, before?.decision.title);
  assert.equal(after?.decision.severity, before?.decision.severity);
});

test('the engine refuses to repoint a case belief without naming what it replaces', async () => {
  const { engine, hypotheses, findings, caseId } = await world();
  await findings.record(ORG, caseId, CLAIM);
  const other = await hypotheses.propose(ORG, {
    hypothesisType: 'case-finding:MEASUREMENT_BACKED',
    title: 'Sneaking a belief in.',
    generatedBy: 'DETERMINISTIC_RULE',
  });
  await assert.rejects(
    () => engine.linkHypothesis(ORG, caseId, { hypothesisId: other.id, actor: SYSTEM }),
    /linkHypothesis/,
  );
});

test('linking the belief already linked is a no-op, so a retry writes nothing', async () => {
  const { engine, findings, caseId, prisma } = await world();
  const { findingId } = await findings.record(ORG, caseId, CLAIM);
  const before = (await prisma.operationalObservation.findMany({ where: { priorityId: caseId } })).length;

  const again = await engine.linkHypothesis(ORG, caseId, { hypothesisId: findingId!, actor: SYSTEM });
  assert.equal(again.effect, 'UNCHANGED');
  assert.equal(again.observation, null);
  const after = (await prisma.operationalObservation.findMany({ where: { priorityId: caseId } })).length;
  assert.equal(after, before);
});

// --- What this stage must NOT do -------------------------------------------------------

test('no work, no recommendation, no outbound anything is created by a finding', async () => {
  const { findings, caseId, prisma } = await world();
  await findings.record(ORG, caseId, CLAIM);
  await findings.get(ORG, caseId, NOW);

  // A Recommendation is a CognitiveDecision. Stage 4 PR #4 writes those; PR #3
  // must not, or the two would be two authorities for one thing.
  assert.equal((await prisma.cognitiveDecision.findMany({})).length, 0);
  // WORK OS IS NOW MODELLED ON THIS DOUBLE, so "the table does not exist" is no
  // longer available as a proxy -- and what replaces it is stronger. The tables
  // are present and reachable, and Commercial Intelligence still writes nothing
  // into any of them. Absence of a capability proved nothing about restraint;
  // this proves restraint.
  for (const table of ['workInstance', 'workStage', 'workStageEvent', 'workDependency']) {
    assert.equal((await (prisma as never as Record<string, { findMany(a: object): Promise<unknown[]> }>)[table]!.findMany({})).length, 0, `a finding must not create ${table}`);
  }
});

const SERVICE_SOURCE = readFileSync(
  new URL('../src/services/case-finding.service.ts', import.meta.url),
  'utf8',
);

test('no model is called, and no place is left for one to hide', async () => {
  for (const forbidden of ['anthropic', 'openai', 'fetch(', 'llm', 'prompt', 'completion']) {
    assert.equal(
      SERVICE_SOURCE.toLowerCase().includes(forbidden),
      false,
      `the finding service must not reference ${forbidden}`,
    );
  }
});

test('the service reads the Stage 3 verdict and never re-derives one', async () => {
  // THERE IS NO SECOND READINESS ENGINE. The verdict is asked for, never built.
  // Matched as a CALL, not as a word: the file header names the gate on purpose,
  // and an assertion that forbids saying its name forbids explaining the design.
  assert.equal(/\bassessReadiness\s*\(/.test(SERVICE_SOURCE), false);
  assert.ok(SERVICE_SOURCE.includes('readinessFor('));
});

test('the service writes exactly two things: a hypothesis and the case link', async () => {
  // Persistence goes through the repository and the engine. A direct `prisma.`
  // write here would bypass the hypothesis invariant, the observation log, or
  // both — each of which fails silently.
  assert.equal(/this\.prisma\./.test(SERVICE_SOURCE), false);
});

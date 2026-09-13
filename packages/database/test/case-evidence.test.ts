// Human-reported evidence -- what a person knows, on a Case, without becoming
// something Loop claims.
//
// WHAT THESE PROVE
//
// Four properties carry the PR.
//
// A REPORT ESTABLISHES THAT IT WAS REPORTED. It is written as its own evidence
// class, attributed to the person from the session, with their words kept exactly
// as typed. Nothing about it asserts that the thing described is true.
//
// STAGE 3 TRUTH IS UNTOUCHED BY IT. A report cannot satisfy measurement
// readiness, cannot change a population's completeness, cannot establish a
// measurement-backed Finding -- and, the direction that is easy to miss, cannot
// DEMOTE an established one either. The second is the real risk: a report has no
// completeness, and the gate reads a missing completeness as a measurement
// concern, so the isolation has to be a filter rather than a convention.
//
// AUTHORITY IS RESOLVED, NOT ASSERTED. Who may report is decided by running the
// REAL permission matrix and the REAL participant repository against the
// database: organization -> Case -> active participant -> person. An active
// participant may report with a read-only global grant; a view-only non-
// participant may not; a released participant may not any more; another tenant's
// Case is not-found.
//
// A REPORT IS NEVER COLLAPSED. Two people saying the same sentence are two pieces
// of evidence, and so is one person saying it again later. Nothing dedupes by
// text.
//
// They run on the in-memory Prisma double with the REAL Decision Engine, the REAL
// IamRepository and the REAL CaseParticipantRepository underneath, so the
// authorization path is exercised rather than mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EVIDENCE_CLASSES,
  INVESTIGATION_PRODUCER,
  assessReadiness,
  assessWindowObservation,
  investigationRecurrenceKey,
  type BusinessDate,
  type HeadlineView,
  type MeasurementReadiness,
  type ProviderObservationStatus,
  type ReadinessInput,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { syncMembershipFromUser } from '../src/repositories/membership.repository';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { CaseEvidenceService } from '../src/services/case-evidence.service';
import { CaseBriefService } from '../src/services/case-brief.service';
import { CaseFindingService } from '../src/services/case-finding.service';
import { IntelligenceHypothesisRepository } from '../src/repositories/cognitive/hypothesis.repository';

const ORG = 'org_emg';
const OTHER_ORG = 'org_someone_else';
const HEADLINE_ID = 'hl_cem_monetized';
const NOW = new Date('2026-08-26T13:00:00.000Z');

const OWNER = 'usr_owner';
const ADMIN = 'usr_admin';
const EMPLOYEE = 'usr_employee';
const PARTICIPANT = 'usr_participant';
const RELEASED = 'usr_released';

const DATES: BusinessDate[] = ['2026-08-24', '2026-08-25'];
const CAMPAIGN = 'camp-cem';

/** A READY window, or one whose second day was never observed. Real verdicts. */
function readiness(unobserved: BusinessDate | null): MeasurementReadiness {
  const byDate = new Map<BusinessDate, ProviderObservationStatus>();
  for (const d of DATES) if (d !== unobserved) byDate.set(d, 'SUCCESS');
  const input: ReadinessInput = {
    metric: 'REVENUE',
    dates: DATES,
    observation: assessWindowObservation(DATES, byDate),
    partitions: [{ dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN, localCalls: 400 }],
    unattributedCalls: 0,
    reconciliation: DATES.map((businessDate) => ({
      businessDate,
      state: 'RECONCILED' as const,
      counts: {
        providerUnique: 200,
        providerDuplicateIds: 0,
        localUnique: 200,
        localDuplicateIds: 0,
        intersection: 200,
        providerOnly: 0,
        localOnly: 0,
        providerOnlyExpected: 0,
        providerOnlyNotConfigured: 0,
        providerOnlyExcluded: 0,
        providerOnlyUnknownMember: 0,
      },
      members: [
        {
          dimension: 'CAMPAIGN' as const,
          memberExternalId: CAMPAIGN,
          providerCount: 200,
          localCount: 200,
          providerOnly: 0,
          expectation: 'EXPECTED' as const,
        },
      ],
      ruleVersion: 'provider-reconciliation.v1',
    })),
    authorities: [
      {
        dimension: 'CAMPAIGN',
        memberExternalId: CAMPAIGN,
        metric: 'REVENUE',
        sourceKey: 'provider-calls',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      },
    ],
    sources: [
      {
        key: 'provider-calls',
        kind: 'PROVIDER_STREAM',
        displayName: 'Call provider',
        supportedMetrics: ['CALL_VOLUME', 'REVENUE'],
        measureDefinitionIds: { CALL_VOLUME: 'calls.provider.v1', REVENUE: 'revenue.provider.v1' },
        provider: 'callgrid',
        stream: 'calls',
      },
    ],
    outcomeDays: [],
  };
  return assessReadiness(input);
}

const READY = readiness(null);

const HEADLINE: HeadlineView = {
  id: HEADLINE_ID,
  performanceObjectiveId: 'obj_1',
  objectiveTitle: 'Hold SSDI revenue per call',
  measureBindingId: 'bind_1',
  recurrenceKey: 'bind_1:REVENUE:rule:DOWN',
  statement: 'SSDI revenue per call fell.',
  measurement: {
    metric: 'REVENUE',
    movement: 'DOWN',
    againstObjective: true,
    currentValue: 18_420,
    priorValue: 24_100,
    absoluteChange: -5_680,
    percentageChange: -0.235,
    currentDenominator: 200,
    priorDenominator: 200,
    currentCoverage: 1,
    priorCoverage: 1,
    comparisonBasis: 'Trailing 2 complete Eastern business days against the 2 before them.',
    currentWindowStart: '2026-08-24T04:00:00.000Z',
    currentWindowEnd: '2026-08-26T04:00:00.000Z',
    priorWindowStart: '2026-08-22T04:00:00.000Z',
    priorWindowEnd: '2026-08-24T04:00:00.000Z',
  },
  limitations: [],
  unknowns: [],
  ruleId: 'rule',
  ruleVersion: 'v1',
  producerVersion: 'ci-headline.v1',
  firstDetectedAt: '2026-08-26T09:00:00.000Z',
  lastDetectedAt: '2026-08-26T09:00:00.000Z',
  detectionCount: 1,
  dismissedAt: null,
  dismissedByUserId: null,
  dismissalBasis: null,
  observedDayCount: 2,
  observationRuleVersion: 'provider-observation.v1',
};

async function world(options: { withMeasuredEvidence?: boolean } = {}) {
  // CRM P0.2c: authority comes from membership, so the double carries it.
  const prisma = makeCognitivePrisma({ also: ['organizationMembership'] });
  const engine = new DecisionEngine(prisma as never);
  const evidence = new CaseEvidenceService(prisma as never, { cases: engine });

  // THE REAL PEOPLE, with their roles -- and, as every production User has since
  // P0.2b, the membership derived from that row, which is where authority is read.
  for (const [id, systemRole] of [
    [OWNER, 'OWNER'],
    [ADMIN, 'ADMIN'],
    [EMPLOYEE, 'EMPLOYEE'],
    [PARTICIPANT, 'EMPLOYEE'],
    [RELEASED, 'EMPLOYEE'],
  ] as const) {
    const user = await prisma.user.create({
      data: { id, organizationId: ORG, email: `${id}@emg.test`, status: 'ACTIVE', metadata: { systemRole } },
    });
    await syncMembershipFromUser(prisma as never, user as never);
  }

  const { decision } = await engine.create(ORG, {
    producer: INVESTIGATION_PRODUCER,
    recurrenceKey: investigationRecurrenceKey(HEADLINE_ID),
    detectionKey: `promotion:${HEADLINE_ID}`,
    detectedAt: NOW,
    title: 'SSDI revenue per call fell.',
    severity: 'NOTABLE',
    sourceReference: HEADLINE_ID,
    evidence: options.withMeasuredEvidence
      ? [
          {
            source: INVESTIGATION_PRODUCER,
            metricKey: 'REVENUE',
            window: '2026-08-24..2026-08-25',
            derivedValue: 18_420,
            completeness: 1,
          },
        ]
      : [],
  });

  const caseId = decision.id;

  // One active participant, and one who was released.
  const participants = new (await import('../src/repositories/case-participant.repository')).CaseParticipantRepository(
    prisma as never,
  );
  await participants.add(ORG, caseId, {
    userId: PARTICIPANT,
    contribution: 'DECIDE',
    request: 'Decide whether to move volume.',
    addedByUserId: OWNER,
  });
  await participants.add(ORG, caseId, {
    userId: RELEASED,
    contribution: 'INVESTIGATE',
    request: 'Look at the settlement feed.',
    addedByUserId: OWNER,
  });
  await participants.release(ORG, caseId, RELEASED, 'INVESTIGATE', OWNER);

  return { prisma, engine, evidence, caseId, participants };
}

const STATEMENT = 'CEM told me on Friday they had paused same-day settlement while re-papering.';

// --- 1. Who may report -------------------------------------------------------------------

test('1. an owner may report', async () => {
  const { evidence, caseId } = await world();
  const r = await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: OWNER });
  assert.equal(r.outcome, 'RECORDED');
  assert.ok(r.evidenceId);
});

test('2. an admin may report', async () => {
  const { evidence, caseId } = await world();
  const r = await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: ADMIN });
  assert.equal(r.outcome, 'RECORDED');
});

test('3. an ACTIVE participant may report, with only a read-only global grant', async () => {
  // THE INSTANCE-SCOPED GRANT. This person cannot author anything else in
  // Commercial Intelligence -- the matrix gives EMPLOYEE view only -- and can
  // still answer the investigation they were asked to contribute to.
  const { evidence, caseId, prisma } = await world();
  const iam = new (await import('../src/repositories/iam.repository')).IamRepository(prisma as never);
  assert.equal(
    await iam.can({ organizationId: ORG, userId: PARTICIPANT, resource: 'commercialIntelligence', action: 'update' }),
    false,
    'the global grant really is read-only',
  );

  const r = await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: PARTICIPANT });
  assert.equal(r.outcome, 'RECORDED');
});

test('4. a view-only person who is NOT a participant may not report', async () => {
  const { evidence, caseId, prisma } = await world();
  const r = await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: EMPLOYEE });
  assert.equal(r.outcome, 'NOT_AUTHORIZED');
  // AND NOTHING WAS WRITTEN. A refusal that still appended would be worse than
  // one that threw.
  assert.equal((await prisma.decisionEvidence.findMany({})).length, 0);
});

test('5. a RELEASED participant may not report any more', async () => {
  // The grant is derived from the participant row rather than copied out of it,
  // so releasing somebody ends it with no second place to revoke.
  const { evidence, caseId, prisma } = await world();
  const r = await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: RELEASED });
  assert.equal(r.outcome, 'NOT_AUTHORIZED');
  assert.equal((await prisma.decisionEvidence.findMany({})).length, 0);
});

test('6. a Case in another organization is NOT-FOUND, never forbidden', async () => {
  const { evidence, caseId, prisma } = await world();
  const r = await evidence.report(OTHER_ORG, caseId, { statement: STATEMENT, reportedByUserId: OWNER });
  assert.equal(r.outcome, 'CASE_NOT_FOUND');
  assert.equal((await prisma.decisionEvidence.findMany({})).length, 0);
  // A Case that does not exist answers identically, which is what stops this
  // being used to find out that one does.
  const missing = await evidence.report(ORG, 'case_nope', {
    statement: STATEMENT,
    reportedByUserId: OWNER,
  });
  assert.equal(missing.outcome, 'CASE_NOT_FOUND');
});

test('6b. canReport answers the same question the write asks', async () => {
  const { evidence, caseId } = await world();
  assert.equal(await evidence.canReport(ORG, caseId, OWNER), true);
  assert.equal(await evidence.canReport(ORG, caseId, PARTICIPANT), true);
  assert.equal(await evidence.canReport(ORG, caseId, EMPLOYEE), false);
  assert.equal(await evidence.canReport(ORG, caseId, RELEASED), false);
  assert.equal(await evidence.canReport(OTHER_ORG, caseId, OWNER), false);
});

// --- 2. What gets written ----------------------------------------------------------------

test('7. the reporter is the session actor, and no input can name somebody else', async () => {
  const { evidence, caseId, prisma } = await world();
  await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: PARTICIPANT });
  const [row] = await prisma.decisionEvidence.findMany({});
  assert.equal(row.reportedByUserId, PARTICIPANT);

  // AND THE ENGINE, NOT THE CALLER, DECIDES IT. Handing the engine a different
  // reporter in the payload changes nothing: it writes the actor.
  const engine = new DecisionEngine(prisma as never);
  await engine.addEvidence(
    ORG,
    caseId,
    {
      source: 'operator',
      evidenceClass: 'HUMAN_REPORTED',
      statement: 'A second report.',
      ...({ reportedByUserId: EMPLOYEE } as Record<string, unknown>),
    },
    { type: 'HUMAN', userId: OWNER, source: 'operator' },
  );
  const rows = await prisma.decisionEvidence.findMany({});
  const second = rows.find((r: any) => r.statement === 'A second report.');
  assert.equal(second.reportedByUserId, OWNER, 'the actor, not the payload');
});

test('8. the statement is stored exactly as it was written', async () => {
  const { evidence, caseId, prisma } = await world();
  const said = '  The token expired at 09:15.\n\nI checked the dashboard twice.  ';
  await evidence.report(ORG, caseId, { statement: said, reportedByUserId: OWNER });
  const [row] = await prisma.decisionEvidence.findMany({});
  assert.equal(row.statement, said, 'not trimmed, not collapsed, not summarized');
});

test('9. reported evidence is immutable -- there is no update path to it', async () => {
  const source = readFileSync(
    new URL('../src/services/case-evidence.service.ts', import.meta.url),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  assert.equal(/\.update\(|\.delete\(|\.upsert\(/.test(source), false);
  // THE TABLE ITSELF CANNOT RECORD AN EDIT. It has no updatedAt to write to, and
  // that is a property of the schema rather than of this service's manners.
  // COLUMNS ONLY. The model's own doc comments say the word `updatedAt` -- in
  // the sentence explaining why there isn't one -- so behaviour must not be read
  // off prose here any more than anywhere else.
  const model = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8')
    .split('model DecisionEvidence {')[1]!
    .split('\n}')[0]!
    .replace(/^\s*\/\/.*$/gm, ' ');
  assert.equal(/updatedAt/.test(model), false, 'evidence has no updatedAt column');
  assert.ok(/statement\s+String\?/.test(model), 'and the statement column is the nullable one');

  // And nothing in the engine updates an evidence row after writing it.
  const engineSource = readFileSync(
    new URL('../src/services/decision/decision-engine.ts', import.meta.url),
    'utf8',
  );
  assert.equal(/decisionEvidence\.(update|delete|upsert)/.test(engineSource), false);
});

test('10. a report is HUMAN_REPORTED, and 11. producer evidence stays MEASURED', async () => {
  const { evidence, caseId, prisma } = await world({ withMeasuredEvidence: true });
  await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: OWNER });
  const rows = await prisma.decisionEvidence.findMany({});
  const report = rows.find((r: any) => r.statement !== null);
  const measured = rows.find((r: any) => r.statement === null);
  assert.equal(report.evidenceClass, 'HUMAN_REPORTED');
  assert.equal(measured.evidenceClass, 'MEASURED');
  assert.deepEqual([...EVIDENCE_CLASSES], ['MEASURED', 'HUMAN_REPORTED']);
});

test('12. a report carries no metric, and 13. no sentinel is invented for one', async () => {
  const { evidence, caseId, prisma } = await world();
  await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: OWNER });
  const [row] = await prisma.decisionEvidence.findMany({});
  assert.equal(row.metricKey, null);
  for (const sentinel of ['HUMAN_REPORT', 'NON_METRIC', 'MANUAL', 'UNKNOWN', 'NONE', 'REPORT']) {
    assert.notEqual(row.metricKey, sentinel);
  }
  // And nothing numeric was filled in either.
  assert.equal(row.rawValue, null);
  assert.equal(row.normalizedValue, null);
  assert.equal(row.derivedValue, null);
  assert.equal(row.completeness, null);
  assert.equal(row.window, null);
});

test('12b. the engine refuses a report that tries to carry a measurement', async () => {
  const { caseId, prisma } = await world();
  const engine = new DecisionEngine(prisma as never);
  const actor = { type: 'HUMAN' as const, userId: OWNER, source: 'operator' };
  for (const bad of [
    { metricKey: 'REVENUE' },
    { derivedValue: 12 },
    { completeness: 1 },
  ]) {
    await assert.rejects(
      () =>
        engine.addEvidence(
          ORG,
          caseId,
          { source: 'operator', evidenceClass: 'HUMAN_REPORTED', statement: STATEMENT, ...bad },
          actor,
        ),
      /human report/i,
      JSON.stringify(bad),
    );
  }
  // And the mirror: measured evidence must name a measure, and may not carry a
  // person's sentence.
  await assert.rejects(
    () => engine.addEvidence(ORG, caseId, { source: 'ci', metricKey: '' }, actor),
    /must name what it measures/i,
  );
  await assert.rejects(
    () => engine.addEvidence(ORG, caseId, { source: 'ci', metricKey: 'REVENUE', statement: 'x' }, actor),
    /no reported statement/i,
  );
  // A report written by a SYSTEM actor is unattributable, and refused.
  await assert.rejects(
    () =>
      engine.addEvidence(
        ORG,
        caseId,
        { source: 'operator', evidenceClass: 'HUMAN_REPORTED', statement: STATEMENT },
        { type: 'SYSTEM', userId: null, source: 'callgrid-intelligence' },
      ),
    /attributed person/i,
  );
});

test('12c. an empty statement is not evidence of anything', async () => {
  const { evidence, caseId, prisma } = await world();
  const r = await evidence.report(ORG, caseId, { statement: '   \n  ', reportedByUserId: OWNER });
  assert.equal(r.outcome, 'EMPTY_STATEMENT');
  assert.equal((await prisma.decisionEvidence.findMany({})).length, 0);
});

test('12d. the report is on the Case log, citing the evidence it wrote', async () => {
  const { evidence, caseId, prisma } = await world();
  const r = await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: OWNER });
  const log = await prisma.operationalObservation.findMany({ where: { priorityId: caseId } });
  const added = log.filter((o: any) => o.observationType === 'EVIDENCE_ADDED');
  assert.equal(added.length, 1);
  assert.equal(added[0].evidenceId, r.evidenceId);
  assert.equal(added[0].actorType, 'HUMAN');
  assert.equal(added[0].actorUserId, OWNER);
});

// --- 3. Stage 3 is untouched -------------------------------------------------------------

/** A Case with a measured claim established, plus one human report on it. */
async function findingContextWorld() {
  const w = await findingWorld();
  await w.evidence.report(ORG, w.caseId, { statement: STATEMENT, reportedByUserId: OWNER });
  return w;
}

async function findingWorld() {
  const w = await world({ withMeasuredEvidence: true });
  const hypotheses = new IntelligenceHypothesisRepository(w.prisma as never);
  const findings = new CaseFindingService(w.prisma as never, {
    cases: w.engine,
    hypotheses,
    headlines: { async get() { return HEADLINE; } },
    readiness: { async readinessFor() { return { readiness: READY }; } },
  });
  await findings.record(ORG, w.caseId, {
    claim: 'Revenue per call fell because one buyer stopped settling.',
    conclusion: null,
    claimKind: 'MEASUREMENT_BACKED',
    generatedBy: 'DETERMINISTIC_RULE',
    actor: { type: 'SYSTEM', userId: null, source: INVESTIGATION_PRODUCER },
  });
  return { ...w, findings };
}

test('14-17. a human report cannot establish a measurement-backed finding, and cannot demote one', async () => {
  const { evidence, findings, caseId } = await findingWorld();

  const before = await findings.get(ORG, caseId, NOW);
  assert.equal(before?.evidenceState, 'ESTABLISHED', 'the measured claim starts established');
  assert.equal(before?.supporting.length, 1);

  await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: OWNER });

  const after = await findings.get(ORG, caseId, NOW);
  // 17. NOT DEMOTED. The report has no completeness -- and a missing completeness
  // is a measurement concern the gate would otherwise have counted against the
  // claim. Adding a note to a Case must not weaken what the evidence supports.
  assert.equal(after?.evidenceState, 'ESTABLISHED');
  assert.deepEqual(after?.establishment.reasons, []);
  // 15. THE MEASURED SET IS UNCHANGED. The report is not in it at all.
  assert.equal(after?.supporting.length, 1);
  assert.deepEqual(before?.supporting, after?.supporting);
  assert.deepEqual(before?.establishment, after?.establishment);
});

test('16. a report alone establishes nothing -- a Case with only reports stays developing', async () => {
  const w = await world();
  const hypotheses = new IntelligenceHypothesisRepository(w.prisma as never);
  const findings = new CaseFindingService(w.prisma as never, {
    cases: w.engine,
    hypotheses,
    headlines: { async get() { return HEADLINE; } },
    readiness: { async readinessFor() { return { readiness: READY }; } },
  });
  await findings.record(ORG, w.caseId, {
    claim: 'The token expired.',
    conclusion: null,
    claimKind: 'MEASUREMENT_BACKED',
    generatedBy: 'DETERMINISTIC_RULE',
    actor: { type: 'SYSTEM', userId: null, source: INVESTIGATION_PRODUCER },
  });
  await w.evidence.report(ORG, w.caseId, { statement: STATEMENT, reportedByUserId: OWNER });

  const finding = await findings.get(ORG, w.caseId, NOW);
  assert.equal(finding?.evidenceState, 'DEVELOPING');
  assert.equal(finding?.supporting.length, 0, 'no report reaches the gate');
  assert.ok(finding?.establishment.reasons.includes('NO_SUPPORTING_EVIDENCE'));
});

test('14b. the gate is handed measured evidence only, structurally', async () => {
  const source = readFileSync(
    new URL('../src/services/case-finding.service.ts', import.meta.url),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  assert.ok(/view\.evidence\.filter\(isMeasuredEvidence\)/.test(source));
});

// --- 4. Reports are never collapsed ------------------------------------------------------

test('19. two people reporting the same sentence are two pieces of evidence', async () => {
  const { evidence, caseId, prisma } = await world();
  await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: OWNER });
  await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: ADMIN });
  const rows = await prisma.decisionEvidence.findMany({});
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r: any) => r.reportedByUserId).sort(), [ADMIN, OWNER].sort());
});

test('20. the same person saying it again later is new evidence, not a duplicate', async () => {
  // A person repeating themselves a week on is a fact about the week. Collapsing
  // it by text would destroy the only record that they said it twice.
  const { evidence, caseId, prisma } = await world();
  await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: OWNER });
  await evidence.report(ORG, caseId, {
    statement: STATEMENT,
    reportedByUserId: OWNER,
    observedAt: new Date('2026-09-02T10:00:00.000Z'),
  });
  const rows = await prisma.decisionEvidence.findMany({});
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
});

test('21. no reporter reliability, trust or weight is recorded anywhere', async () => {
  // STAGE 5 FORBIDS PERSON-LEVEL TRUST. Evidence-class reliability by claim type
  // and context is later work; "this person is 82% reliable" is not, ever.
  const sources = [
    '../src/services/case-evidence.service.ts',
    '../src/services/decision/decision-engine.ts',
  ].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' '));
  for (const source of sources) {
    assert.equal(/reliability|trustScore|credibility|reporterWeight|accuracyScore/i.test(source), false);
  }
  const { evidence, caseId, prisma } = await world();
  await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: OWNER });
  const [row] = await prisma.decisionEvidence.findMany({});
  for (const field of Object.keys(row)) {
    assert.equal(/reliab|trust|credib|weight|score/i.test(field), false, `${field} must not exist`);
  }
});

// --- 4b. Evidence context: additive, never an edit ---------------------------------------

/** A Case carrying one measurement and one report, ready to be related. */
async function contextWorld() {
  const w = await world({ withMeasuredEvidence: true });
  const reported = await w.evidence.report(ORG, w.caseId, {
    statement: STATEMENT,
    reportedByUserId: OWNER,
  });
  const rows = await w.prisma.decisionEvidence.findMany({});
  const measured = rows.find((r: any) => r.statement === null);
  return { ...w, reportId: reported.evidenceId as string, measuredId: measured.id as string };
}

test('c1. context is appended and the evidence it is about is untouched', async () => {
  const { evidence, caseId, prisma, reportId, measuredId } = await contextWorld();
  const before = await prisma.decisionEvidence.findFirst({ where: { id: reportId } });

  const r = await evidence.addContext(ORG, caseId, {
    subjectEvidenceId: reportId,
    relation: 'CORROBORATED_BY',
    basisEvidenceId: measuredId,
    note: 'The measured rate moved the same day.',
    actorUserId: OWNER,
  });
  assert.equal(r.outcome, 'RECORDED');
  assert.ok(r.contextId);

  // THE ORIGINAL ROW IS BYTE-FOR-BYTE WHAT IT WAS.
  const after = await prisma.decisionEvidence.findFirst({ where: { id: reportId } });
  assert.deepEqual(after, before);
});

test('c2. a correction is a NEW report plus a relation — both stay', async () => {
  const { evidence, caseId, prisma, reportId } = await contextWorld();
  const r = await evidence.addContext(ORG, caseId, {
    subjectEvidenceId: reportId,
    relation: 'CORRECTED_BY',
    basisStatement: 'I was looking at staging, not production.',
    actorUserId: OWNER,
  });
  assert.equal(r.outcome, 'RECORDED');
  assert.ok(r.evidenceId, 'the correction is itself evidence');

  const rows = await prisma.decisionEvidence.findMany({});
  const original = rows.find((e: any) => e.id === reportId);
  const correction = rows.find((e: any) => e.id === r.evidenceId);
  assert.equal(original.statement, STATEMENT, 'the original words are unchanged');
  assert.equal(correction.statement, 'I was looking at staging, not production.');
  // AND THE CORRECTION IS A REPORT LIKE ANY OTHER: attributed, verbatim, and
  // still not a measurement.
  assert.equal(correction.evidenceClass, 'HUMAN_REPORTED');
  assert.equal(correction.reportedByUserId, OWNER);
  assert.equal(correction.metricKey, null);
});

test('c3. context does not reclassify evidence, and cannot reach the Stage 3 gate', async () => {
  const { evidence, findings, caseId, prisma } = await findingContextWorld();

  const before = await findings.get(ORG, caseId, NOW);
  assert.equal(before?.evidenceState, 'ESTABLISHED');

  const rows = await prisma.decisionEvidence.findMany({});
  const measured = rows.find((r: any) => r.statement === null);
  const report = rows.find((r: any) => r.statement !== null);

  // Somebody records that the MEASUREMENT is contradicted by a person's report.
  const r = await evidence.addContext(ORG, caseId, {
    subjectEvidenceId: measured.id,
    relation: 'CONTRADICTED_BY',
    basisEvidenceId: report.id,
    actorUserId: OWNER,
  });
  assert.equal(r.outcome, 'RECORDED');

  const after = await findings.get(ORG, caseId, NOW);
  // 12. CONTEXT DOES NOT BYPASS OR MOVE ESTABLISHMENT. A disagreement recorded
  // by a person is not a governed measurement comparison, and the gate never
  // reads context at all.
  assert.equal(after?.evidenceState, 'ESTABLISHED');
  assert.deepEqual(after?.establishment, before?.establishment);
  assert.deepEqual(after?.supporting, before?.supporting);

  // 11. AND NO CLASS CHANGED. Corroboration is not measurement.
  const classesAfter = (await prisma.decisionEvidence.findMany({})).map((e: any) => [e.id, e.evidenceClass]);
  assert.deepEqual(
    classesAfter.sort(),
    rows.map((e: any) => [e.id, e.evidenceClass]).sort(),
  );
});

test('c4. a relation across a Case or a tenant boundary fails closed', async () => {
  const { evidence, engine, caseId, prisma, reportId } = await contextWorld();

  // Another Case in the SAME tenant, with its own evidence.
  const { decision: other } = await engine.create(ORG, {
    producer: INVESTIGATION_PRODUCER,
    recurrenceKey: 'headline:other',
    detectionKey: 'promotion:other',
    detectedAt: NOW,
    title: 'A different investigation.',
    severity: 'NOTABLE',
    sourceReference: 'hl_other',
    evidence: [{ source: INVESTIGATION_PRODUCER, metricKey: 'REVENUE', derivedValue: 1, completeness: 1 }],
  });
  const otherEvidence = (await prisma.decisionEvidence.findMany({})).find(
    (e: any) => e.priorityId === other.id,
  );

  // Subject from this Case, basis from another: refused.
  assert.equal(
    (await evidence.addContext(ORG, caseId, {
      subjectEvidenceId: reportId,
      relation: 'CORROBORATED_BY',
      basisEvidenceId: otherEvidence.id,
      actorUserId: OWNER,
    })).outcome,
    'EVIDENCE_NOT_FOUND',
  );

  // Subject from another Case: refused.
  assert.equal(
    (await evidence.addContext(ORG, caseId, {
      subjectEvidenceId: otherEvidence.id,
      relation: 'CORROBORATED_BY',
      basisEvidenceId: reportId,
      actorUserId: OWNER,
    })).outcome,
    'EVIDENCE_NOT_FOUND',
  );

  // Another tenant naming this Case: not-found, exactly as a missing Case.
  assert.equal(
    (await evidence.addContext(OTHER_ORG, caseId, {
      subjectEvidenceId: reportId,
      relation: 'NO_LONGER_APPLICABLE',
      note: 'x',
      actorUserId: OWNER,
    })).outcome,
    'CASE_NOT_FOUND',
  );

  // Nothing was written by any of them.
  const ctx = (await prisma.operationalObservation.findMany({})).filter(
    (o: any) => o.observationType === 'EVIDENCE_CONTEXT_RECORDED',
  );
  assert.equal(ctx.length, 0);
});

test('c5. authority is the same narrow grant reporting uses', async () => {
  const { evidence, caseId, reportId, measuredId } = await contextWorld();
  const attempt = (userId: string) =>
    evidence.addContext(ORG, caseId, {
      subjectEvidenceId: reportId,
      relation: 'CLARIFIED_BY',
      basisEvidenceId: measuredId,
      actorUserId: userId,
    });

  assert.equal((await attempt(PARTICIPANT)).outcome, 'RECORDED', 'an active participant may');
  assert.equal((await attempt(EMPLOYEE)).outcome, 'NOT_AUTHORIZED', 'a non-participant may not');
  assert.equal((await attempt(RELEASED)).outcome, 'NOT_AUTHORIZED', 'a released one may not');
});

test('c6. an ungoverned relation records nothing', async () => {
  const { evidence, caseId, prisma, reportId } = await contextWorld();
  const r = await evidence.addContext(ORG, caseId, {
    subjectEvidenceId: reportId,
    // The member that deliberately does not exist: provider restatement and
    // claim supersession are owned elsewhere.
    relation: 'SUPERSEDED_BY' as never,
    basisEvidenceId: null,
    actorUserId: OWNER,
  });
  assert.equal(r.outcome, 'UNGOVERNED_RELATION');
  const ctx = (await prisma.operationalObservation.findMany({})).filter(
    (o: any) => o.observationType === 'EVIDENCE_CONTEXT_RECORDED',
  );
  assert.equal(ctx.length, 0);
});

test('c7. a relation needing a basis refuses without one, and self-reference is refused', async () => {
  const { evidence, engine, caseId, reportId } = await contextWorld();
  assert.equal(
    (await evidence.addContext(ORG, caseId, {
      subjectEvidenceId: reportId,
      relation: 'CONTRADICTED_BY',
      actorUserId: OWNER,
    })).outcome,
    'BASIS_REQUIRED',
  );

  // The engine refuses the degenerate shapes outright.
  const actor = { type: 'HUMAN' as const, userId: OWNER, source: 'operator' };
  await assert.rejects(
    () => engine.relateEvidence(ORG, caseId, {
      subjectEvidenceId: reportId,
      relation: 'CORROBORATED_BY',
      basisEvidenceId: reportId,
    }, actor),
    /its own context/i,
  );
  await assert.rejects(
    () => engine.relateEvidence(ORG, caseId, {
      subjectEvidenceId: reportId,
      relation: 'NO_LONGER_APPLICABLE',
    }, actor),
    /what changed/i,
  );
});

test('c8. the context is on the Case log, attributed, and readable from the brief', async () => {
  const { evidence, engine, caseId, prisma, reportId, measuredId } = await contextWorld();
  await evidence.addContext(ORG, caseId, {
    subjectEvidenceId: reportId,
    relation: 'CORROBORATED_BY',
    basisEvidenceId: measuredId,
    note: 'Same day.',
    actorUserId: PARTICIPANT,
  });

  const log = (await prisma.operationalObservation.findMany({})).filter(
    (o: any) => o.observationType === 'EVIDENCE_CONTEXT_RECORDED',
  );
  assert.equal(log.length, 1);
  assert.equal(log[0].evidenceId, reportId);
  assert.equal(log[0].relatedEvidenceId, measuredId);
  assert.equal(log[0].evidenceRelation, 'CORROBORATED_BY');
  assert.equal(log[0].actorType, 'HUMAN');
  assert.equal(log[0].actorUserId, PARTICIPANT);

  const brief = await new CaseBriefService(null as never, {
    cases: engine,
    headlines: { async get() { return HEADLINE; } },
  }).get(ORG, caseId);

  const report = brief!.evidence.find((e) => e.id === reportId)!;
  assert.equal(report.context.length, 1);
  assert.equal(report.context[0]!.relation, 'CORROBORATED_BY');
  assert.equal(report.context[0]!.basisEvidenceId, measuredId);
  assert.equal(report.context[0]!.actorUserId, PARTICIPANT);
  // The statement is still the statement.
  assert.equal(report.statement, STATEMENT);
});

// --- 5. Existing reads still work --------------------------------------------------------

test('22. the Case brief carries both classes, and invents nothing for the report', async () => {
  const { evidence, engine, caseId } = await world({ withMeasuredEvidence: true });
  await evidence.report(ORG, caseId, { statement: STATEMENT, reportedByUserId: OWNER });

  const brief = await new CaseBriefService(null as never, {
    cases: engine,
    headlines: { async get() { return HEADLINE; } },
  }).get(ORG, caseId);

  assert.equal(brief?.evidence.length, 2);
  const report = brief!.evidence.find((e) => e.evidenceClass === 'HUMAN_REPORTED')!;
  const measured = brief!.evidence.find((e) => e.evidenceClass === 'MEASURED')!;

  assert.equal(report.statement, STATEMENT);
  assert.equal(report.reportedByUserId, OWNER);
  assert.equal(report.metricKey, null);
  assert.equal(report.value, null);
  assert.equal(report.completeness, null);
  assert.equal(measured.metricKey, 'REVENUE');

  // THE UNCERTAINTY COUNTS ARE ABOUT MEASUREMENTS. A report has no population, so
  // it is not a population that failed to report.
  assert.equal(brief?.uncertainty.completenessUnstatedCount, 0);
  assert.equal(brief?.uncertainty.incompleteEvidenceCount, 0);

  // 18. AND IT IS PLACED UNDER WHAT AS AN ATTRIBUTED REPORT, never as a bare fact.
  const what = brief!.fiveWs.what.find((w) => w.evidenceId === report.id)!;
  assert.ok(what.label.includes(`${OWNER} reported`));
  assert.ok(what.label.includes(STATEMENT));
});

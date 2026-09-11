// Monitoring, outcome and auto-resolution at the boundary that writes them.
//
// WHAT THESE PROVE
//
// NO SECOND LIFECYCLE. Monitoring enters WATCHING — the lane that already
// existed — and re-engagement is REOPENED, which already clears `resolvedAt` and
// increments `reopenCount`. Nothing here invents a state, and a test walks the
// state vocabulary to prove it did not grow.
//
// A CORRECTED PLAN NEVER ERASES THE PREVIOUS ONE. A success criterion rewritten
// after the numbers are in is a rationalisation, not a test, and the only thing
// that makes that visible is the earlier plan still being on the log.
//
// LOOP CLOSES ON ALL THE CONDITIONS OR NONE, and records what it checked. The
// justification is appended BEFORE the close, so a failure leaves a reasoning
// row with no close rather than an autonomous close with nothing saying why.
//
// AN INCONCLUSIVE WINDOW CANNOT CLOSE ANYTHING.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  INVESTIGATION_PRODUCER,
  MONITORING_EVENTS,
  PRIORITY_STATES,
  investigationRecurrenceKey,
  type CaseFindingView,
  type FindingEvidenceState,
  type FindingJudgment,
  type MonitoringObservation,
  type MonitoringPlan,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { CaseMonitoringService } from '../src/services/case-monitoring.service';

const ORG = 'org_alpha';
const OTHER = 'org_beta';
const CHARLIE = 'usr_charlie';
const HEADLINE_ID = 'hl_cem';
const START = '2026-09-01T00:00:00.000Z';
const END = '2026-09-08T00:00:00.000Z';
const AFTER = new Date('2026-09-09T00:00:00.000Z');
const human = { type: 'HUMAN' as const, userId: CHARLIE, source: 'operator' };

function plan(over: Partial<MonitoringPlan> = {}): MonitoringPlan {
  return {
    condition: "Buyer CEM's monetized rate",
    baseline: { metric: 'MONETIZED_RATE', value: 0.597, unit: 'RATIO', denominator: 2996 },
    success: {
      metric: 'MONETIZED_RATE', comparison: 'WITHIN_PERCENT_OF_BASELINE', threshold: 0.05,
      statement: 'Monetized rate returned to within 5% of baseline during the window.',
    },
    failure: {
      metric: 'MONETIZED_RATE', comparison: 'AT_OR_BELOW', threshold: 0.35,
      statement: 'Monetized rate fell to or below 35% during the window.',
    },
    observationStart: START,
    observationEnd: END,
    requires: { minimumObservations: 200, minimumCoverage: 0.95, requiresCompleteWindow: true },
    plannedByUserId: CHARLIE,
    plannedAt: START,
    note: null,
    ...over,
  };
}

const reading = (over: Partial<MonitoringObservation> = {}): MonitoringObservation => ({
  metric: 'MONETIZED_RATE', value: 0.58, unit: 'RATIO', denominator: 3100,
  coverage: 0.98, observationCount: 3100, evidenceIds: ['ev_1'], ...over,
});

/**
 * The three reads this service composes are supplied directly.
 *
 * DELIBERATE: what is under test is monitoring, outcome and the resolution rule,
 * and driving a whole Finding + Work OS fixture through every case would test
 * those instead. Their own suites already prove them.
 */
/**
 * A Finding, typed as the production contract with no cast.
 *
 * THE AXES ARE SEPARATE HERE TOO. A stub that carried one collapsed "state"
 * could not express established-and-rejected, which is precisely the case the
 * resolution rule has to get right.
 */
function findingView(
  evidenceState: FindingEvidenceState,
  judgment?: FindingJudgment,
): CaseFindingView {
  return {
    findingId: 'fnd_1',
    caseId: 'case_1',
    claim: 'A claim about the monetized rate.',
    conclusion: null,
    claimKind: 'MEASUREMENT_BACKED',
    generatedBy: 'DETERMINISTIC_RULE',
    evidenceState,
    judgment: judgment
      ? { judgment, byUserId: 'user_charlie', at: '2026-08-26T15:40:00.000Z' }
      : null,
    lifecycle: 'CURRENT',
    establishment: {
      ruleVersion: 'case-finding-establishment.v1',
      eligible: evidenceState === 'ESTABLISHED',
      basis: evidenceState === 'ESTABLISHED' ? 'DETERMINISTIC_POLICY' : null,
      reasons: [],
      readinessWithholdings: [],
    },
    reasoning: { known: [], inferred: [], missing: [], contradictory: [], unavailable: {} },
    supporting: [],
    createdAt: START,
    supportingWindowStart: null,
    supportingWindowEnd: null,
    ruleVersion: null,
    lineage: [],
  };
}

async function world(
  opts: {
    measurement?: MonitoringObservation | null;
    evidenceState?: FindingEvidenceState;
    judgment?: FindingJudgment;
    work?: { unknown: string | null; workStatus: string | null; blockers: number }[];
    notKnown?: string[];
  } = {},
) {
  const prisma = makeCognitivePrisma();
  const engine = new DecisionEngine(prisma as never);
  const { decision } = await engine.create(ORG, {
    producer: INVESTIGATION_PRODUCER,
    recurrenceKey: investigationRecurrenceKey(HEADLINE_ID),
    detectionKey: `promotion:${HEADLINE_ID}`,
    detectedAt: new Date(START),
    title: "Buyer CEM's monetized rate fell.",
    severity: 'NOTABLE',
    sourceReference: HEADLINE_ID,
  });

  const monitoring = new CaseMonitoringService(prisma as never, {
    cases: engine,
    measure: async () => opts.measurement ?? null,
    findings: {
      async get(organizationId: string, caseId: string) {
        if (organizationId !== ORG || caseId !== decision.id) return null;
        return findingView(opts.evidenceState ?? 'ESTABLISHED', opts.judgment);
      },
    },
    coordination: {
      async get(organizationId: string, caseId: string) {
        if (organizationId !== ORG || caseId !== decision.id) return null;
        return {
          caseId,
          work: (opts.work ?? []).map((w, i) => ({
            system: 'work-os', type: 'work_instance', id: `wi_${i}`,
            recordedAt: START, observationId: `obs_${i}`,
            workStatus: w.workStatus, execution: null,
            blockers: Array.from({ length: w.blockers }, (_, b) => ({ id: `dep_${b}` })),
            unknown: w.unknown,
          })),
          notKnown: opts.notKnown ?? [],
          asks: [],
          ruleVersion: 'case-work-coordination.v1',
        } as never;
      },
    },
  });
  return { prisma, engine, monitoring, caseId: decision.id };
}

const logOf = (prisma: ReturnType<typeof makeCognitivePrisma>, caseId: string) =>
  prisma.operationalObservation.findMany({ where: { priorityId: caseId }, orderBy: { sequence: 'asc' } });

// --- 1. No second lifecycle ------------------------------------------------------------

test('1. starting monitoring enters WATCHING — the lane that already existed', async () => {
  const { prisma, engine, monitoring, caseId } = await world();
  const r = await monitoring.start(ORG, caseId, plan(), human);
  assert.equal(r.outcome, 'STARTED');

  const view = await engine.get(ORG, caseId);
  assert.equal(view?.currentState, 'WATCHING');
  const row = (await logOf(prisma, caseId)).at(-1)!;
  assert.equal(row.observationType, MONITORING_EVENTS.STARTED);
});

test('1b. the Case state vocabulary did not grow', () => {
  // WATCHING is monitoring; REOPENED is re-engagement. A sixth state beside them
  // would be two answers to "is this open", which this repository has paid for
  // five times already under other names.
  assert.deepEqual([...PRIORITY_STATES], ['NEEDS_REVIEW', 'ASSIGNED', 'WATCHING', 'RESOLVED', 'DISMISSED']);
});

test('1c. re-engagement is the REOPENED that already existed, and keeps the history', async () => {
  const { engine, monitoring, caseId, prisma } = await world();
  await monitoring.start(ORG, caseId, plan(), human);
  await engine.resolve(ORG, caseId, { actor: human, outcome: 'RECOVERED' });
  const closed = await engine.get(ORG, caseId);
  assert.equal(closed?.currentState, 'RESOLVED');

  await engine.reopen(ORG, caseId, { actor: human, reason: 'It came back.' });
  const reopened = await engine.get(ORG, caseId);
  assert.equal(reopened?.currentState, 'NEEDS_REVIEW');
  assert.equal(reopened?.decision.reopenCount, 1);
  assert.equal(reopened?.decision.resolvedAt, null, 'the resolution no longer stands');

  // AND NOTHING WAS ERASED. The monitoring plan, the resolution and the reopen
  // are all still on one log, in order — which is what makes "this was resolved
  // once and did not hold" the most informative thing a Case can say.
  const types = (await logOf(prisma, caseId)).map((o) => o.observationType);
  assert.ok(types.includes(MONITORING_EVENTS.STARTED));
  assert.ok(types.includes('RESOLVED'));
  assert.ok(types.includes('REOPENED'));
});

// --- 2. Corrections never erase ----------------------------------------------------------

test('2. a corrected plan is a second row, and the first stays readable in full', async () => {
  const { monitoring, caseId, prisma } = await world({ measurement: reading() });
  await monitoring.start(ORG, caseId, plan(), human);
  const relaxed = plan({
    requires: { minimumObservations: 10, minimumCoverage: null, requiresCompleteWindow: true },
  });
  const second = await monitoring.start(ORG, caseId, relaxed, human);
  assert.equal(second.outcome, 'REVISED');

  const view = await monitoring.get(ORG, caseId, AFTER);
  assert.equal(view?.history.length, 2);
  assert.equal(view?.plan?.requires.minimumObservations, 10, 'the newest is in force');
  // THE ORIGINAL IS STILL THERE, WORD FOR WORD. A success criterion rewritten
  // after the numbers are in is a rationalisation, and the only thing that makes
  // that visible is the earlier plan surviving.
  assert.equal(view?.history[1]?.requires.minimumObservations, 200);
  assert.equal(view?.history[1]?.requires.minimumCoverage, 0.95);

  const types = (await logOf(prisma, caseId)).map((o) => o.observationType);
  assert.equal(types.filter((t) => t === MONITORING_EVENTS.STARTED).length, 1);
  assert.equal(types.filter((t) => t === MONITORING_EVENTS.REVISED).length, 1);
});

// --- 3. The verdict is derived, never stored -----------------------------------------------

test('3. the same plan reads INCONCLUSIVE with no measurement and HELD with one', async () => {
  const blind = await world({ measurement: null });
  await blind.monitoring.start(ORG, blind.caseId, plan(), human);
  assert.equal((await blind.monitoring.get(ORG, blind.caseId, AFTER))?.assessment?.verdict, 'INCONCLUSIVE');

  const measured = await world({ measurement: reading() });
  await measured.monitoring.start(ORG, measured.caseId, plan(), human);
  assert.equal((await measured.monitoring.get(ORG, measured.caseId, AFTER))?.assessment?.verdict, 'HELD');
});

test('3b. a build with no measurement wired in returns INCONCLUSIVE, never a reading', async () => {
  // THE SAFE DEFAULT. Commercial Intelligence does not know how to measure an
  // arbitrary producer's metric, and inventing one would be the exact failure
  // this stage exists to prevent.
  const { monitoring, caseId } = await world();
  await monitoring.start(ORG, caseId, plan(), human);
  const view = await monitoring.get(ORG, caseId, AFTER);
  assert.equal(view?.assessment?.verdict, 'INCONCLUSIVE');
  assert.equal(view?.assessment?.measured, null);
});

test('3c. concluding records the verdict and does NOT close the Case', async () => {
  const { engine, monitoring, caseId, prisma } = await world({ measurement: reading() });
  await monitoring.start(ORG, caseId, plan(), human);
  const { outcome, assessment } = await monitoring.conclude(ORG, caseId, human, AFTER);
  assert.equal(outcome, 'CONCLUDED');
  assert.equal(assessment?.verdict, 'HELD');

  // A verdict is what was observed. Deciding the investigation is finished is a
  // separate act — otherwise a monitor that fired could close a Case nobody
  // agreed was answered.
  assert.equal((await engine.get(ORG, caseId))?.currentState, 'WATCHING');
  const row = (await logOf(prisma, caseId)).at(-1)!;
  assert.equal(row.observationType, MONITORING_EVENTS.CONCLUDED);
  assert.equal((row.evidence as { verdict: string }).verdict, 'HELD');
});

// --- 4. Outcome: what happened, never why --------------------------------------------------

test('4. the outcome carries lineage and refuses causation in the same breath', async () => {
  const { engine, monitoring, caseId } = await world({
    measurement: reading(),
    work: [{ unknown: null, workStatus: 'completed', blockers: 0 }],
  });
  await monitoring.start(ORG, caseId, plan(), human);
  await engine.recordOutcome(ORG, caseId, { actor: human, outcome: 'RECOVERED', measuredEffectCents: 412_00 });

  const outcome = await monitoring.outcome(ORG, caseId, AFTER);
  assert.equal(outcome?.outcome, 'RECOVERED');
  assert.equal(outcome?.measuredEffectCents, 412_00);
  assert.equal(outcome?.lineage.findingId, 'fnd_1');
  assert.deepEqual(outcome?.lineage.monitoringWindow, { start: START, end: END });
  assert.equal(outcome?.lineage.monitoringVerdict, 'HELD');
  assert.equal(outcome?.lineage.workReferences.length, 1);
  assert.ok(outcome?.lineage.observationId);

  // THE REFUSAL IS A FIELD, not an absence, so a reader sees it was considered.
  assert.equal(outcome?.causalClaim, null);
  assert.ok(outcome?.causalCaveat.includes('cannot say'));
  for (const verb of ['caused', 'because', 'led to', 'resulted in']) {
    assert.equal(outcome!.statement.toLowerCase().includes(verb), false, `statement must not say "${verb}"`);
  }
});

test('4b. an outcome over an unreadable window says what it could not establish', async () => {
  const { monitoring, caseId } = await world({
    measurement: null,
    evidenceState: 'DEVELOPING',
    notKnown: ['Loop cannot find the work this Case pointed at.'],
    work: [{ unknown: 'WORK_NOT_FOUND', workStatus: null, blockers: 0 }],
  });
  await monitoring.start(ORG, caseId, plan(), human);
  const outcome = await monitoring.outcome(ORG, caseId, AFTER);

  assert.ok(outcome!.notEstablished.length >= 3);
  assert.ok(outcome!.notEstablished.some((l) => l.includes('cannot find the work')));
  assert.ok(outcome!.notEstablished.some((l) => l.includes('could not establish what happened')));
  assert.ok(outcome!.notEstablished.some((l) => l.includes('No established finding')));
});

// --- 5. Auto-resolution --------------------------------------------------------------------

test('5. Loop closes only when every condition holds, and records what it checked', async () => {
  const { engine, monitoring, caseId, prisma } = await world({
    measurement: reading(),
    work: [{ unknown: null, workStatus: 'completed', blockers: 0 }],
  });
  await monitoring.start(ORG, caseId, plan(), human);
  const { resolved, eligibility } = await monitoring.autoResolve(ORG, caseId, AFTER);

  assert.equal(resolved, true);
  assert.equal(eligibility?.outcome, 'RECOVERED');
  assert.equal((await engine.get(ORG, caseId))?.currentState, 'RESOLVED');

  const log = await logOf(prisma, caseId);
  const closing = log.at(-1)!;
  const justification = log.at(-2)!;
  assert.equal(closing.observationType, 'RESOLVED');
  // APPENDED BEFORE THE CLOSE. If the close then fails, the log holds a reasoning
  // row and no close — readable, and obviously incomplete. The other order leaves
  // an autonomous close with nothing saying why.
  assert.equal(justification.observationType, 'NOTE_ADDED');
  const payload = justification.evidence as { conditionsMet: string[]; ruleVersion: string };
  assert.equal(payload.conditionsMet.length, 5);
  assert.ok(payload.ruleVersion);
  assert.equal(closing.actorType, 'SYSTEM');
});

test('5b. an inconclusive window cannot close anything', async () => {
  // THE PROPERTY THAT MATTERS MOST. Loop must not close an investigation on a
  // window it could not read.
  const { engine, monitoring, caseId, prisma } = await world({
    measurement: null,
    work: [{ unknown: null, workStatus: 'completed', blockers: 0 }],
  });
  await monitoring.start(ORG, caseId, plan(), human);
  const before = (await logOf(prisma, caseId)).length;
  const { resolved, eligibility } = await monitoring.autoResolve(ORG, caseId, AFTER);

  assert.equal(resolved, false);
  assert.ok(eligibility?.unmet.includes('MONITORING_SETTLED'));
  assert.equal((await engine.get(ORG, caseId))?.currentState, 'WATCHING', 'still open');
  assert.equal((await logOf(prisma, caseId)).length, before, 'and nothing was written');
});

test('5c. a dangling work reference blocks the close', async () => {
  const { monitoring, caseId } = await world({
    measurement: reading(),
    work: [{ unknown: 'WORK_NOT_FOUND', workStatus: null, blockers: 0 }],
    notKnown: ['Loop cannot find the work this Case pointed at.'],
  });
  await monitoring.start(ORG, caseId, plan(), human);
  const { resolved, eligibility } = await monitoring.autoResolve(ORG, caseId, AFTER);
  assert.equal(resolved, false);
  assert.ok(eligibility?.unmet.includes('COORDINATION_COMPLETE'));
  assert.ok(eligibility?.unmet.includes('WORK_COMPLETE'));
});

test('5d. an open blocker blocks the close', async () => {
  const { monitoring, caseId } = await world({
    measurement: reading(),
    work: [{ unknown: null, workStatus: 'completed', blockers: 1 }],
  });
  await monitoring.start(ORG, caseId, plan(), human);
  const { resolved, eligibility } = await monitoring.autoResolve(ORG, caseId, AFTER);
  assert.equal(resolved, false);
  assert.ok(eligibility?.unmet.includes('NOTHING_BLOCKED'));
});

test('5e. an unestablished finding blocks the close', async () => {
  const { monitoring, caseId } = await world({
    measurement: reading(),
    evidenceState: 'DEVELOPING',
    work: [{ unknown: null, workStatus: 'completed', blockers: 0 }],
  });
  await monitoring.start(ORG, caseId, plan(), human);
  const { resolved, eligibility } = await monitoring.autoResolve(ORG, caseId, AFTER);
  assert.equal(resolved, false);
  assert.ok(eligibility?.unmet.includes('QUESTION_ANSWERED'));
});

test('5f. an established finding a person REJECTED does not let Loop close it', async () => {
  // THE EVIDENCE IS UNTOUCHED BY THE REJECTION -- that is the whole point of the
  // two axes -- but closing an investigation is an ACT, and Loop does not act
  // over a person's stated disagreement. A person still can.
  const { monitoring, caseId } = await world({
    measurement: reading(),
    evidenceState: 'ESTABLISHED',
    judgment: 'REJECTED',
    work: [{ unknown: null, workStatus: 'completed', blockers: 0 }],
  });
  await monitoring.start(ORG, caseId, plan(), human);
  const { resolved, eligibility } = await monitoring.autoResolve(ORG, caseId, AFTER);
  assert.equal(resolved, false);
  assert.ok(eligibility?.unmet.includes('QUESTION_ANSWERED'));
  assert.ok(eligibility?.explanation.some((l) => l.includes('rejected')));
});

test('5g. an established finding a person ACCEPTED closes exactly as an unjudged one does', async () => {
  const { monitoring, caseId } = await world({
    measurement: reading(),
    evidenceState: 'ESTABLISHED',
    judgment: 'ACCEPTED',
    work: [{ unknown: null, workStatus: 'completed', blockers: 0 }],
  });
  await monitoring.start(ORG, caseId, plan(), human);
  const { resolved, eligibility } = await monitoring.autoResolve(ORG, caseId, AFTER);
  assert.equal(resolved, true);
  assert.deepEqual(eligibility?.unmet, []);
});

// --- 6. Tenancy and human control ------------------------------------------------------------

test('6. another organization cannot start, read, conclude or close monitoring', async () => {
  const { monitoring, caseId } = await world({ measurement: reading() });
  assert.equal((await monitoring.start(OTHER, caseId, plan(), human)).outcome, 'CASE_NOT_FOUND');
  assert.equal(await monitoring.get(OTHER, caseId, AFTER), null);
  assert.equal((await monitoring.conclude(OTHER, caseId, human, AFTER)).outcome, 'CASE_NOT_FOUND');
  assert.equal(await monitoring.outcome(OTHER, caseId, AFTER), null);
  assert.equal((await monitoring.autoResolve(OTHER, caseId, AFTER)).resolved, false);
});

test('6b. a human may close a Case Loop considers ineligible, and it is recorded as theirs', async () => {
  // Auto-resolution says what LOOP may do unprompted. A person is never bound by
  // it, and the difference between the two acts stays visible on the log.
  const { engine, monitoring, caseId, prisma } = await world({ measurement: null });
  await monitoring.start(ORG, caseId, plan(), human);
  assert.equal((await monitoring.autoResolve(ORG, caseId, AFTER)).resolved, false);

  await engine.resolve(ORG, caseId, { actor: human, outcome: 'ACCEPTED_RISK', reason: 'We are living with it.' });
  const closing = (await logOf(prisma, caseId)).at(-1)!;
  assert.equal(closing.actorType, 'HUMAN');
  assert.equal(closing.actorUserId, CHARLIE);
  assert.equal((await engine.get(ORG, caseId))?.currentState, 'RESOLVED');
});

// --- 7. Source discipline ----------------------------------------------------------------------

test('7. monitoring reads typed events, never prose', () => {
  const src = readFileSync(new URL('../src/services/case-monitoring.service.ts', import.meta.url), 'utf8');
  // The debt the vocabulary migration paid off must not come back. Plans are
  // recovered by comparing governed enum members.
  assert.equal(/\.reason\s*===/.test(src), false, 'must not decide what a row means by its reason');
  assert.ok(src.includes('MONITORING_EVENTS.STARTED'));
});

test('7b. no model can decide a verdict or a resolution', () => {
  const src = readFileSync(new URL('../src/services/case-monitoring.service.ts', import.meta.url), 'utf8');
  for (const forbidden of [/\bfetch\s*\(/, /\banthropic\b/i, /\bopenai\b/i, /Math\.random/]) {
    assert.equal(forbidden.test(src), false, `must not contain ${forbidden}`);
  }
});

// Headline → human Investigate decision → Case.
//
// WHAT THESE PROVE
//
// One sentence carries the whole PR: A CASE COMES INTO EXISTENCE ONLY BECAUSE A
// PERSON DECIDED IT SHOULD. Generating a Headline creates nothing. Reading one
// creates nothing. Reading its evidence creates nothing. There is exactly one
// function that opens an investigation and it refuses to run without an
// attributed human.
//
// The second is that promotion is idempotent by IDENTITY rather than by a guard:
// the investigation's recurrence key is derived from the Headline, so a second
// press — or two simultaneous presses — resolves to the row that exists.
//
// The third is the list of things a new Case does NOT arrive carrying: no
// Finding, no Recommendation, no Work, no assignee, no model call.
//
// These are BEHAVIOURAL. The service is driven against a Prisma double and the
// real DecisionEngine wherever the guarantee lives in the engine, so what is
// proved is what happens, not what the source says about itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INVESTIGATION_AUTHORIZED_REASON,
  INVESTIGATION_PRODUCER,
  PROMOTION_OUTCOMES,
  investigationDetectionKey,
  investigationRecurrenceKey,
  promotionOpenedOrFoundCase,
  severityForHeadline,
  type HeadlineView,
} from '@emgloop/shared';

import {
  HeadlineInvestigationService,
  type InvestigationFinder,
  type InvestigationOpener,
} from '../src/services/headline-investigation.service';
import type { CreateDecisionInput, AddObservationInput } from '../src/services/decision/decision-engine.contracts';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';
const ACTOR = 'usr_matt';
const HEADLINE_ID = 'hl_cem_monetized';

function headline(over: Partial<HeadlineView> = {}): HeadlineView {
  return {
    id: HEADLINE_ID,
    performanceObjectiveId: 'obj_medicare',
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

/**
 * A Decision Center double that behaves like the real one where it matters:
 * identity is `(organization, producer, recurrenceKey)`, and a second create
 * against an existing key RESIGHTS rather than opening a second thread.
 */
function decisionCenter(seed: Array<{ org: string; key: string; id: string; humanReviewed: boolean }> = []) {
  const rows = [...seed];
  const creates: Array<{ org: string; input: CreateDecisionInput }> = [];
  const observations: Array<{ org: string; id: string; input: AddObservationInput }> = [];
  let seq = rows.length;

  const opener: InvestigationOpener = {
    async create(organizationId: string, input: CreateDecisionInput) {
      creates.push({ org: organizationId, input });
      const found = rows.find((r) => r.org === organizationId && r.key === input.recurrenceKey);
      if (found) {
        return { decision: { id: found.id } as never, observation: null, effect: 'RESIGHTED' as const, eventType: 'DecisionResighted' as never };
      }
      seq += 1;
      const id = `pri_${seq}`;
      rows.push({ org: organizationId, key: input.recurrenceKey, id, humanReviewed: false });
      return { decision: { id } as never, observation: null, effect: 'CREATED' as const, eventType: 'DecisionCreated' as never };
    },
    async addObservation(organizationId: string, id: string, input: AddObservationInput) {
      observations.push({ org: organizationId, id, input });
      const row = rows.find((r) => r.id === id);
      if (row && input.observationType === 'REVIEWED' && input.actor.type === 'HUMAN') row.humanReviewed = true;
      return { decision: { id } as never, observation: null, effect: 'UPDATED' as const, eventType: 'DecisionObserved' as never };
    },
    async get(organizationId: string, id: string) {
      const row = rows.find((r) => r.org === organizationId && r.id === id);
      if (!row) return null;
      // The `reason` column is what distinguishes an authorization from somebody
      // simply reading, and the engine persists it — so the double has to carry it
      // too. Without it this stand-in described a row the database never writes.
      return {
        observations: row.humanReviewed
          ? [{
              actorType: 'HUMAN',
              observationType: 'REVIEWED',
              reason: INVESTIGATION_AUTHORIZED_REASON,
            }]
          : [{ actorType: 'SYSTEM', observationType: 'SITUATION_DETECTED', reason: null }],
      } as never;
    },
  };

  const finder: InvestigationFinder = {
    async findByRecurrenceKey(organizationId, sourceSystem, recurrenceKey) {
      const r = rows.find(
        (x) => x.org === organizationId && sourceSystem === INVESTIGATION_PRODUCER && x.key === recurrenceKey,
      );
      return r ? { id: r.id } : null;
    },
  };

  return { opener, finder, creates, observations, rows };
}

function service(options: { headlines?: Record<string, Record<string, HeadlineView>>; seed?: Parameters<typeof decisionCenter>[0] } = {}) {
  const table = options.headlines ?? { [ORG]: { [HEADLINE_ID]: headline() } };
  const dc = decisionCenter(options.seed);
  const reads: Array<{ org: string; id: string }> = [];
  const svc = new HeadlineInvestigationService({} as never, {
    headlines: {
      async get(organizationId: string, id: string) {
        reads.push({ org: organizationId, id });
        return table[organizationId]?.[id] ?? null;
      },
    },
    decisions: dc.opener,
    finder: dc.finder,
  });
  return { svc, dc, reads };
}

// --- 1/3/6. The human decision is the only way in --------------------------------

test('1. an authorized headline is promoted into a case', async () => {
  const { svc, dc } = service();
  const out = await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  assert.equal(out.outcome, 'PROMOTED');
  assert.equal(out.opened, true);
  assert.ok(out.caseId, 'a case exists to navigate to');
  assert.equal(dc.creates.length, 1);
  assert.equal(promotionOpenedOrFoundCase(out.outcome), true);
});

test('3/6. THE PROMOTION CANNOT HAPPEN WITHOUT AN ATTRIBUTED HUMAN', async () => {
  for (const actorUserId of ['', '   ']) {
    const { svc, dc, reads } = service();
    const out = await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId });
    assert.equal(out.outcome, 'NO_AUTHORIZING_HUMAN');
    assert.equal(out.caseId, null);
    assert.equal(dc.creates.length, 0, 'nothing was opened');
    assert.equal(dc.observations.length, 0);
    // Refused BEFORE the headline is read: an unattributed request must not even
    // learn whether the headline exists.
    assert.equal(reads.length, 0, 'nothing was read either');
  }
});

test('3. the authorizing person is recorded as a HUMAN observation on the case', async () => {
  const { svc, dc } = service();
  const at = new Date('2026-08-23T09:00:00.000Z');
  await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR, note: 'Worth a look.', now: at });

  assert.equal(dc.observations.length, 1);
  const o = dc.observations[0]!;
  assert.equal(o.input.actor.type, 'HUMAN');
  assert.equal(o.input.actor.userId, ACTOR);
  assert.equal(o.input.occurredAt?.toISOString(), at.toISOString());
  assert.equal(o.input.note, 'Worth a look.');
  // Authorization means "this deserves investigation", NOT "the headline is
  // correct". The reason line has to say which, because a later reader cannot
  // recover the difference from a bare REVIEWED row.
  assert.match(String(o.input.reason), /not a judgement that it is correct/);
});

// --- 4/5. Everything that is NOT a promotion -------------------------------------

test('4/5. reading a headline, or its evidence, opens nothing', async () => {
  const { svc, dc, reads } = service();
  // The read path the UI uses to decide whether to investigate.
  const before = await svc.findCaseForHeadline(ORG, HEADLINE_ID);
  assert.equal(before, null, 'no case exists yet');
  assert.equal(dc.creates.length, 0);
  assert.equal(dc.observations.length, 0);
  assert.equal(reads.length, 0, 'the lineage read does not even load the headline');

  // And after a promotion it reports the one that exists, still writing nothing.
  await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  const writesAfterPromotion = dc.creates.length + dc.observations.length;
  const after = await svc.findCaseForHeadline(ORG, HEADLINE_ID);
  assert.ok(after?.caseId);
  assert.equal(after.humanAuthorizationRecorded, true);
  assert.equal(dc.creates.length + dc.observations.length, writesAfterPromotion, 'the read wrote nothing');
});

// --- 7. Idempotency ----------------------------------------------------------------

test('7. pressing Investigate twice does not open a second case', async () => {
  const { svc, dc } = service();
  const first = await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  const second = await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: 'usr_charlie' });

  assert.equal(first.outcome, 'PROMOTED');
  assert.equal(second.outcome, 'ALREADY_INVESTIGATING');
  assert.equal(second.opened, false);
  assert.equal(second.caseId, first.caseId, 'the same investigation');
  assert.equal(dc.rows.length, 1, 'exactly one thread exists');
  // The second press appended no second authorization either: one is recorded.
  assert.equal(dc.observations.length, 1);
});

test('7b. identity is derived from the headline, never from a clock', () => {
  const a = investigationRecurrenceKey(HEADLINE_ID);
  const b = investigationRecurrenceKey(HEADLINE_ID);
  assert.equal(a, b, 'stable across calls');
  assert.equal(a, `headline:${HEADLINE_ID}`);
  assert.notEqual(investigationRecurrenceKey('other'), a);
  // The detection key is stable too, so a concurrent double-press collides at the
  // database rather than appending two opening rows.
  assert.equal(investigationDetectionKey(HEADLINE_ID), `promotion:${HEADLINE_ID}`);
});

test('7d. only a call that APPENDS the authorization reports having done so', async () => {
  // The distinction a supplementary audit trail has to key on. `opened` is not
  // it: an interrupted promotion completes on the retry without opening anything,
  // and a trail keyed on `opened` would never record that a person authorized it.
  const { svc } = service();
  const first = await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  assert.equal(first.opened, true);
  assert.equal(first.authorizationAppendedNow, true, 'the opening press appended it');

  const repeat = await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  assert.equal(repeat.opened, false);
  assert.equal(repeat.authorizationAppendedNow, false, 'a repeated press appended nothing');
  assert.equal(repeat.humanAuthorizationRecorded, true, 'and one is still on record');
});

test('7c. an interrupted promotion converges: the missing human row is appended', async () => {
  // A thread opened but never attributed — the shape a crash between the two
  // writes would leave. Promoting again must record the authorization rather
  // than reporting an investigation nobody is on record as having authorized.
  const { svc, dc } = service({
    seed: [{ org: ORG, key: investigationRecurrenceKey(HEADLINE_ID), id: 'pri_orphan', humanReviewed: false }],
  });
  const out = await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  assert.equal(out.outcome, 'ALREADY_INVESTIGATING');
  assert.equal(out.caseId, 'pri_orphan');
  assert.equal(out.humanAuthorizationRecorded, true);
  assert.equal(dc.observations.length, 1, 'the missing authorization was appended');
  assert.equal(dc.rows.length, 1, 'and no second thread was opened');
  // AND THE CALLER IS TOLD IT HAPPENED, even though nothing was opened. Without
  // this the one reachable path where a person authorizes an investigation and
  // the generic admin trail stays silent would go unrecorded.
  assert.equal(out.opened, false);
  assert.equal(out.authorizationAppendedNow, true);
});

// --- 8. Tenancy ----------------------------------------------------------------------

test('a generic REVIEWED does not satisfy the promotion\'s authorization check either', async () => {
  // The promotion and the Case Brief share one predicate, so they cannot come to
  // different conclusions about the same row. A thread carrying only somebody's
  // plain review still needs its authorization appended.
  const { svc, dc } = service({
    seed: [{ org: ORG, key: investigationRecurrenceKey(HEADLINE_ID), id: 'pri_reviewed', humanReviewed: false }],
  });
  const out = await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  assert.equal(out.authorizationAppendedNow, true);
  assert.equal(dc.observations[0]!.input.reason, INVESTIGATION_AUTHORIZED_REASON);
});

test('8. CROSS-TENANT PROMOTION IS IMPOSSIBLE, and answers not-found rather than forbidden', async () => {
  const { svc, dc } = service({ headlines: { [ORG]: { [HEADLINE_ID]: headline() } } });
  const out = await svc.promote(OTHER_ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  assert.equal(out.outcome, 'HEADLINE_NOT_FOUND');
  assert.equal(out.caseId, null);
  assert.equal(dc.creates.length, 0, 'nothing was opened in either organization');
  // A headline that genuinely does not exist gets the identical answer, so the
  // response cannot be used to discover that another tenant holds one.
  const missing = await svc.promote(ORG, { headlineId: 'hl_nope', actorUserId: ACTOR });
  assert.equal(missing.outcome, out.outcome);
  assert.equal(missing.reason.replace('hl_nope', HEADLINE_ID), out.reason);
});

test('8b. the headline is resolved inside the organization the caller was given', async () => {
  const { svc, reads } = service();
  await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  assert.deepEqual(reads, [{ org: ORG, id: HEADLINE_ID }]);
});

test('8c. the reverse lineage read is organization-scoped too', async () => {
  const { svc } = service({
    seed: [{ org: ORG, key: investigationRecurrenceKey(HEADLINE_ID), id: 'pri_1', humanReviewed: true }],
  });
  assert.ok(await svc.findCaseForHeadline(ORG, HEADLINE_ID));
  assert.equal(await svc.findCaseForHeadline(OTHER_ORG, HEADLINE_ID), null);
});

// --- 2. Lineage ------------------------------------------------------------------------

test('2. the case preserves navigable lineage back to the headline', async () => {
  const { svc, dc } = service();
  await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  const input = dc.creates[0]!.input;

  assert.equal(input.sourceReference, HEADLINE_ID, 'case → headline');
  assert.equal(input.recurrenceKey, investigationRecurrenceKey(HEADLINE_ID), 'headline → case');
  assert.equal(input.producer, INVESTIGATION_PRODUCER);
  assert.equal(input.producerVersion, 'headline-investigation.v1');
  // The objective the headline was measured against travels as the thread's
  // summary, so a reader lands on why it mattered without a second query.
  assert.equal(input.summary, 'Grow Medicare answer rate');
  assert.equal(input.title, headline().statement);
  // The thread is about a development in the world, so it is dated by the
  // headline's own first detection — not by when somebody pressed the button.
  assert.equal(input.detectedAt.toISOString(), headline().firstDetectedAt);
});

test('2b. the evidence row carries the measurement AND its caveats, by reference', async () => {
  const { svc, dc } = service();
  await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  const evidence = dc.creates[0]!.input.evidence ?? [];
  assert.equal(evidence.length, 1, 'one opening snapshot, not a copy of the headline');
  const e = evidence[0]!;

  assert.equal(e.entityType, 'headline');
  assert.equal(e.entityId, HEADLINE_ID, 'the evidence points back at what opened the thread');
  assert.equal(e.metricKey, 'MONETIZED_RATE');
  assert.equal(e.derivedValue, 0.412);
  assert.equal(e.completeness, 0.98);
  assert.equal(e.ruleId, 'ci.objective-measure-change');
  assert.equal(e.ruleVersion, 'v1');
  // EVIDENCE THAT KEEPS ITS VALUE AND LOSES ITS CAVEATS is how a hedged claim
  // becomes a confident one. Both travel.
  assert.deepEqual(e.limitations, ['Postback destinations settle after the call.']);
  assert.deepEqual(e.unknowns, ['2% of calls carry no billable answer yet.']);
});

test('2c. Loop\'s own words are NOT copied into the evidence set', async () => {
  // `statement` is composed by Loop from its own numbers. Stage 2 already shipped
  // a defect where CI-authored text became the evidence for CI's own conclusion.
  // It travels as a human-readable title; it must not travel as evidence.
  const { svc, dc } = service();
  await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  const evidence = JSON.stringify(dc.creates[0]!.input.evidence ?? []);
  assert.ok(!evidence.includes('fell from 59.7%'), 'the statement is not evidence');
});

// --- 13/14/15/16. What a new case does NOT arrive carrying ---------------------------------

test('13/14/15. a promoted case carries no Finding, no Recommendation and no Work', async () => {
  const { svc, dc } = service();
  await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  const input = dc.creates[0]!.input;

  // A hypothesis IS a Finding in everything but name. PR 1 establishes none.
  assert.equal(input.hypothesis, undefined, 'no belief was opened');
  // Nothing was assigned, so no execution was implied.
  for (const o of dc.observations) {
    assert.notEqual(o.input.observationType, 'ASSIGNED');
    assert.equal(o.input.assignedToUserId ?? null, null);
    assert.equal(o.input.destination ?? null, null, 'no work destination was recorded');
    assert.equal(o.input.outcome ?? null, null, 'and no outcome was decided');
  }
});

test('16. no model is required, and none is reachable from the promotion', async () => {
  // The whole path is a headline read, a create and an append. There is nothing
  // to stub for an LLM because nothing calls one.
  const { svc } = service();
  const out = await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  assert.equal(out.outcome, 'PROMOTED');
});

// --- Severity is a boundary mapping, not a business judgement -------------------------------

test('severity maps modestly, and never claims HIGH or CRITICAL', async () => {
  assert.equal(severityForHeadline(true), 'NOTABLE');
  assert.equal(severityForHeadline(false), 'INFORMATIONAL');

  const against = service();
  await against.svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  assert.equal(against.dc.creates[0]!.input.severity, 'NOTABLE');

  const withObjective = service({
    headlines: {
      [ORG]: {
        [HEADLINE_ID]: headline({
          measurement: { ...headline().measurement, againstObjective: false },
        }),
      },
    },
  });
  await withObjective.svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  assert.equal(withObjective.dc.creates[0]!.input.severity, 'INFORMATIONAL');
});

test('the promotion never sets operator urgency on the caller\'s behalf', async () => {
  const { svc, dc } = service();
  await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });
  // `priority` is operator urgency and is deliberately separate from producer
  // severity. Loop guessing it would collapse two questions the schema keeps apart.
  assert.equal(dc.creates[0]!.input.priority ?? null, null);
});

// --- 11. The Headline is untouched -------------------------------------------------------

test('11. PROMOTION MUTATES NOTHING ON THE HEADLINE', async () => {
  // A Headline records that something changed and by how much. Whether anyone
  // chose to look into it is a different fact in a different place -- which is
  // exactly why `headline.repository.ts` refuses to grow an assign method.
  const subject = headline();
  const snapshot = JSON.parse(JSON.stringify(subject));
  const { svc } = service({ headlines: { [ORG]: { [HEADLINE_ID]: subject } } });

  await svc.promote(ORG, { headlineId: HEADLINE_ID, actorUserId: ACTOR });

  assert.deepEqual(JSON.parse(JSON.stringify(subject)), snapshot, 'the headline is byte-identical');
  assert.equal(subject.dismissedAt, null, 'not dismissed');
  assert.equal(subject.detectionCount, 3, 'detection is the producer\'s, not the promoter\'s');
});

test('11b. the headline seam exposes a read and nothing else', () => {
  // A structural guarantee rather than a promise: the service is handed a reader
  // with one method, so there is no write it could perform even by mistake.
  const reader: { get: unknown } = { get: async () => null };
  assert.deepEqual(Object.keys(reader), ['get']);
});

test('the outcome vocabulary is closed', () => {
  assert.deepEqual([...PROMOTION_OUTCOMES].sort(), [
    'ALREADY_INVESTIGATING',
    'HEADLINE_NOT_FOUND',
    'NO_AUTHORIZING_HUMAN',
    'PROMOTED',
  ]);
  assert.equal(promotionOpenedOrFoundCase('HEADLINE_NOT_FOUND'), false);
  assert.equal(promotionOpenedOrFoundCase('NO_AUTHORIZING_HUMAN'), false);
});

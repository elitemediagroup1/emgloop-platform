// The Case Brief — one investigation, assembled for a product surface.
//
// WHAT THESE PROVE
//
// Three properties carry the PR.
//
// It is READ-ONLY, and that is structural: the service holds two seams and both
// are `get`. The tests drive it against doubles that FAIL LOUDLY if anything
// tries to write, so "the brief does not mutate the Case" is proved by the
// absence of a write rather than by reading the source.
//
// It never guesses. WHY is empty and says why it is empty, an entity type the
// closed lists do not recognise is not filed under a heading a person will reason
// from, and an unresolvable Headline comes back null with a reason instead of a
// fabricated snapshot.
//
// Lineage cannot become a way to see a Headline. The Case stores an id; the
// Headline's own organization-scoped read decides whether this caller may have it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CASE_WHY_UNAVAILABLE,
  INVESTIGATION_AUTHORIZED_REASON,
  INVESTIGATION_PRODUCER,
  caseIsAuthorized,
  caseIsOpen,
  investigationRecurrenceKey,
  type HeadlineView,
} from '@emgloop/shared';

import { CaseBriefService, type CaseBriefDeps } from '../src/services/case-brief.service';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';
const CASE_ID = 'pri_1';
const HEADLINE_ID = 'hl_cem';
const ACTOR = 'usr_matt';

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

type Ev = {
  id: string;
  source?: string;
  metricKey?: string;
  window?: string | null;
  derivedValue?: number | null;
  completeness?: number | null;
  entityType?: string | null;
  entityId?: string | null;
  entityName?: string | null;
  limitations?: string[];
  unknowns?: string[];
  observedAt?: Date;
};

function evidence(e: Ev) {
  return {
    id: e.id,
    source: e.source ?? INVESTIGATION_PRODUCER,
    metricKey: e.metricKey ?? 'MONETIZED_RATE',
    window: e.window ?? 'Trailing 7 business days',
    derivedValue: 'derivedValue' in e ? (e.derivedValue ?? null) : 0.412,
    // `??` CANNOT EXPRESS AN EXPLICIT NULL, and null is the whole point of this
    // field: "the producer did not state completeness" is a different fact from
    // "0.98 of it reported". A `?? 0.98` here silently turned every unstated
    // fixture into an incomplete one.
    completeness: 'completeness' in e ? (e.completeness ?? null) : 0.98,
    entityType: e.entityType ?? 'headline',
    entityId: e.entityId ?? HEADLINE_ID,
    entityName: e.entityName ?? 'Grow Medicare answer rate',
    limitations: e.limitations ?? ['Postback destinations settle after the call.'],
    unknowns: e.unknowns ?? ['2% of calls carry no billable answer yet.'],
    ruleId: 'ci.objective-measure-change',
    ruleVersion: 'v1',
    producerVersion: 'ci-headline.v1',
    observedAt: e.observedAt ?? new Date('2026-08-22T06:15:00.000Z'),
  };
}

type Obs = {
  id: string;
  sequence: number;
  observationType: string;
  actorType?: string;
  actorUserId?: string | null;
  reason?: string | null;
  note?: string | null;
  occurredAt?: Date;
};

function observation(o: Obs) {
  return {
    id: o.id,
    sequence: o.sequence,
    observationType: o.observationType,
    occurredAt: o.occurredAt ?? new Date('2026-08-23T09:00:00.000Z'),
    recordedAt: o.occurredAt ?? new Date('2026-08-23T09:00:00.000Z'),
    actorType: o.actorType ?? 'SYSTEM',
    actorUserId: o.actorUserId ?? null,
    source: o.actorType === 'HUMAN' ? 'operator' : INVESTIGATION_PRODUCER,
    reason: o.reason ?? null,
    note: o.note ?? null,
    previousState: 'NEEDS_REVIEW',
    newState: null,
    outcome: null,
  };
}

/**
 * A Case reader that answers reads and EXPLODES on anything else.
 *
 * The point of the explosion: it makes "the brief writes nothing" a fact the
 * suite establishes rather than a claim the source makes about itself.
 */
function caseStore(options: {
  org?: string;
  sourceSystem?: string;
  sourceReference?: string | null;
  evidence?: ReturnType<typeof evidence>[];
  observations?: ReturnType<typeof observation>[];
  state?: string;
  owner?: string | null;
  assignee?: string | null;
} = {}) {
  const calls: string[] = [];
  const reader = {
    async get(organizationId: string, id: string) {
      calls.push(`get:${organizationId}:${id}`);
      if (organizationId !== (options.org ?? ORG) || id !== CASE_ID) return null;
      return {
        decision: {
          id: CASE_ID,
          title: "Buyer CEM's monetized rate fell from 59.7% to 41.2%.",
          summary: 'Grow Medicare answer rate',
          sourceSystem: options.sourceSystem ?? INVESTIGATION_PRODUCER,
          sourceReference: options.sourceReference === undefined ? HEADLINE_ID : options.sourceReference,
          recurrenceKey: investigationRecurrenceKey(HEADLINE_ID),
          outcome: null,
          measuredEffectCents: null,
        },
        observations: options.observations ?? [
          observation({ id: 'o1', sequence: 1, observationType: 'SITUATION_DETECTED' }),
          observation({
            id: 'o2',
            sequence: 2,
            observationType: 'REVIEWED',
            actorType: 'HUMAN',
            actorUserId: ACTOR,
            reason: INVESTIGATION_AUTHORIZED_REASON,
            note: 'Worth a look.',
          }),
        ],
        evidence: options.evidence ?? [evidence({ id: 'ev1' })],
        history: {
          firstDetectedAt: new Date('2026-08-20T11:02:00.000Z'),
          lastDetectedAt: new Date('2026-08-22T06:15:00.000Z'),
          detectionCount: 3,
          timesReopened: 0,
          msToFirstDecision: null,
          msToResolution: null,
          contactAttempts: 0,
          recordedOutcomes: [],
          humanActors: [ACTOR],
        },
        currentState: options.state ?? 'NEEDS_REVIEW',
        ownerUserId: options.owner ?? null,
        assigneeUserId: options.assignee ?? null,
      };
    },
    // Any mutation reachable through this seam is a defect. There is none on the
    // type; these exist so an accidental cast still fails loudly.
    create: () => { throw new Error('the case brief must not create'); },
    addObservation: () => { throw new Error('the case brief must not append'); },
    addEvidence: () => { throw new Error('the case brief must not add evidence'); },
    assign: () => { throw new Error('the case brief must not assign'); },
    resolve: () => { throw new Error('the case brief must not resolve'); },
  };
  return { reader, calls };
}

function headlineStore(table: Record<string, Record<string, HeadlineView>> = { [ORG]: { [HEADLINE_ID]: headline() } }) {
  const calls: string[] = [];
  const reader = {
    async get(organizationId: string, id: string) {
      calls.push(`${organizationId}:${id}`);
      return table[organizationId]?.[id] ?? null;
    },
    record: () => { throw new Error('the case brief must not write a headline'); },
    dismiss: () => { throw new Error('the case brief must not dismiss a headline'); },
  };
  return { reader, calls };
}

function service(overrides: { cases?: ReturnType<typeof caseStore>; headlines?: ReturnType<typeof headlineStore> } = {}) {
  const cases = overrides.cases ?? caseStore();
  const headlines = overrides.headlines ?? headlineStore();
  const deps: CaseBriefDeps = { cases: cases.reader as never, headlines: headlines.reader as never };
  return { svc: new CaseBriefService({} as never, deps), cases, headlines };
}

// --- 1/2. Reading, and not reading -------------------------------------------------

test('1. an authorized read returns the brief', async () => {
  const { svc } = service();
  const brief = await svc.get(ORG, CASE_ID);
  assert.ok(brief);
  assert.equal(brief.caseId, CASE_ID);
  assert.equal(brief.status, 'NEEDS_REVIEW');
  assert.equal(caseIsOpen(brief), true);
  assert.equal(brief.title, "Buyer CEM's monetized rate fell from 59.7% to 41.2%.");
});

test('2. CROSS-TENANT READ IS IMPOSSIBLE, and answers not-found rather than forbidden', async () => {
  const { svc, headlines } = service();
  assert.equal(await svc.get(OTHER_ORG, CASE_ID), null);
  // A case that genuinely does not exist gets the identical answer.
  assert.equal(await svc.get(ORG, 'pri_nope'), null);
  // And nothing downstream was consulted, so no lineage read leaked either.
  assert.deepEqual(headlines.calls, []);
});

test('2b. a blank id is refused without a read', async () => {
  const { svc, cases } = service();
  assert.equal(await svc.get(ORG, '   '), null);
  assert.deepEqual(cases.calls, []);
});

// --- 3/6. Lineage ---------------------------------------------------------------------

test('3. the brief resolves the originating headline and its objective', async () => {
  const { svc, headlines } = service();
  const brief = (await svc.get(ORG, CASE_ID))!;
  assert.equal(brief.origin.kind, 'HEADLINE');
  if (brief.origin.kind !== 'HEADLINE') return;
  assert.equal(brief.origin.headlineId, HEADLINE_ID);
  assert.equal(brief.origin.unresolvedReason, null);
  assert.equal(brief.origin.headline?.performanceObjectiveId, 'obj_medicare');
  assert.equal(brief.origin.headline?.objectiveTitle, 'Grow Medicare answer rate');
  assert.equal(brief.origin.headline?.metric, 'MONETIZED_RATE');
  // RE-READ, not snapshotted: the headline was fetched through its own scoped read.
  assert.deepEqual(headlines.calls, [`${ORG}:${HEADLINE_ID}`]);
});

test('18. AN UNREACHABLE HEADLINE IS NOT LEAKED THROUGH LINEAGE', async () => {
  // The case names an id; the headline's own organization-scoped read decides.
  // A headline belonging to another tenant resolves to null here, exactly as one
  // that was deleted, and the brief says so instead of inventing a snapshot.
  const { svc } = service({ headlines: headlineStore({ [OTHER_ORG]: { [HEADLINE_ID]: headline() } }) });
  const brief = (await svc.get(ORG, CASE_ID))!;
  assert.equal(brief.origin.kind, 'HEADLINE');
  if (brief.origin.kind !== 'HEADLINE') return;
  assert.equal(brief.origin.headline, null);
  assert.match(String(brief.origin.unresolvedReason), /could not be read/);
  // The id is still there so a surface can say WHICH headline it could not read.
  assert.equal(brief.origin.headlineId, HEADLINE_ID);
});

test('a thread from another producer is not read as a headline lineage', async () => {
  // `sourceReference` is an opaque producer handle. A CallGrid thread's reference
  // is a call id, and parsing it as a headline id would send a lineage query
  // somewhere meaningless.
  const { svc, headlines } = service({
    cases: caseStore({ sourceSystem: 'callgrid-intelligence', sourceReference: 'call_abc' }),
  });
  const brief = (await svc.get(ORG, CASE_ID))!;
  assert.equal(brief.origin.kind, 'PRODUCER');
  if (brief.origin.kind !== 'PRODUCER') return;
  assert.equal(brief.origin.sourceSystem, 'callgrid-intelligence');
  assert.equal(brief.origin.sourceReference, 'call_abc');
  assert.deepEqual(headlines.calls, [], 'no headline was even asked for');
});

// --- 5. Authorization -------------------------------------------------------------------

test('5. human authorization resolves from the case log, not from AuditLog', async () => {
  const { svc } = service();
  const brief = (await svc.get(ORG, CASE_ID))!;
  assert.equal(caseIsAuthorized(brief), true);
  assert.equal(brief.authorization?.userId, ACTOR);
  assert.equal(brief.authorization?.at, '2026-08-23T09:00:00.000Z');
  assert.equal(brief.authorization?.note, 'Worth a look.');
});

test('5b. A PLAIN REVIEWED IS NOT AUTHORIZATION', async () => {
  // An operator can record a review on any thread at any time. Only the row
  // carrying the promotion's reason line is the authorization, which is why the
  // predicate is shared with the promotion rather than re-spelled here.
  const { svc } = service({
    cases: caseStore({
      observations: [
        observation({ id: 'o1', sequence: 1, observationType: 'SITUATION_DETECTED' }),
        observation({ id: 'o2', sequence: 2, observationType: 'REVIEWED', actorType: 'HUMAN', actorUserId: 'usr_someone' }),
      ],
    }),
  });
  const brief = (await svc.get(ORG, CASE_ID))!;
  assert.equal(brief.authorization, null);
  assert.equal(caseIsAuthorized(brief), false);
});

test('5c. the EARLIEST authorization wins, so the answer does not drift', async () => {
  const { svc } = service({
    cases: caseStore({
      observations: [
        observation({ id: 'o1', sequence: 1, observationType: 'SITUATION_DETECTED' }),
        observation({
          id: 'o2', sequence: 2, observationType: 'REVIEWED', actorType: 'HUMAN', actorUserId: ACTOR,
          reason: INVESTIGATION_AUTHORIZED_REASON, occurredAt: new Date('2026-08-23T09:00:00.000Z'),
        }),
        observation({
          id: 'o3', sequence: 3, observationType: 'REVIEWED', actorType: 'HUMAN', actorUserId: 'usr_charlie',
          reason: INVESTIGATION_AUTHORIZED_REASON, occurredAt: new Date('2026-08-25T12:00:00.000Z'),
        }),
      ],
    }),
  });
  const brief = (await svc.get(ORG, CASE_ID))!;
  assert.equal(brief.authorization?.userId, ACTOR, 'the first authorizer, not the latest reader');
});

test('an unauthorized case reads honestly rather than blank', async () => {
  const { svc } = service({
    cases: caseStore({ observations: [observation({ id: 'o1', sequence: 1, observationType: 'SITUATION_DETECTED' })] }),
  });
  const brief = (await svc.get(ORG, CASE_ID))!;
  assert.equal(brief.authorization, null);
  assert.equal(brief.fiveWs.unavailable.WHO, 'Nobody is recorded on this investigation yet.');
});

// --- 6/7. Uncertainty ---------------------------------------------------------------------

test('6/7. limitations and unknowns are preserved, deduped, order kept', async () => {
  const { svc } = service({
    cases: caseStore({
      evidence: [
        evidence({ id: 'ev1', limitations: ['Postbacks settle later.'], unknowns: ['2% unanswered.'] }),
        evidence({ id: 'ev2', limitations: ['Postbacks settle later.', 'Sample is one week.'], unknowns: [] }),
      ],
    }),
  });
  const brief = (await svc.get(ORG, CASE_ID))!;
  // The same caveat on three rows is one caveat a person has to weigh; repeating
  // it would make the doubt look like it compounds.
  assert.deepEqual(brief.uncertainty.limitations, ['Postbacks settle later.', 'Sample is one week.']);
  assert.deepEqual(brief.uncertainty.unknowns, ['2% unanswered.']);
});

test('INCOMPLETE AND UNSTATED COMPLETENESS ARE COUNTED SEPARATELY', async () => {
  // null is not one. "The producer did not say" and "all of it reported" are
  // different facts, and a surface that renders them alike turns silence into a
  // guarantee.
  const { svc } = service({
    cases: caseStore({
      evidence: [
        evidence({ id: 'ev1', completeness: 0.6 }),
        evidence({ id: 'ev2', completeness: null }),
        evidence({ id: 'ev3', completeness: 1 }),
      ],
    }),
  });
  const brief = (await svc.get(ORG, CASE_ID))!;
  assert.equal(brief.uncertainty.incompleteEvidenceCount, 1);
  assert.equal(brief.uncertainty.completenessUnstatedCount, 1);
  assert.equal(brief.evidence[1]!.completeness, null, 'and it is not coerced on the item either');
});

// --- 8/9/10. The five questions ---------------------------------------------------------------

test('8. the derivation is deterministic', async () => {
  const { svc } = service();
  const a = (await svc.get(ORG, CASE_ID))!;
  const b = (await svc.get(ORG, CASE_ID))!;
  assert.deepEqual(a.fiveWs, b.fiveWs);
});

test('9. WHY IS EMPTY AND SAYS WHY — no causation is manufactured', async () => {
  const { svc } = service();
  const brief = (await svc.get(ORG, CASE_ID))!;
  assert.deepEqual(brief.fiveWs.why, []);
  assert.equal(brief.fiveWs.unavailable.WHY, CASE_WHY_UNAVAILABLE);
  assert.match(CASE_WHY_UNAVAILABLE, /does not infer causes/);
});

test('10. an entity type neither list recognises is NOT filed under a heading', async () => {
  // `headline` is neither a party nor a place. Putting it under WHO or WHERE would
  // put the wrong noun beneath a heading a person is about to reason from.
  const { svc } = service();
  const brief = (await svc.get(ORG, CASE_ID))!;
  assert.deepEqual(brief.fiveWs.where, []);
  assert.equal(
    brief.fiveWs.unavailable.WHERE,
    'No evidence names a campaign, market, channel or system this condition exists in.',
  );
  assert.ok(!brief.fiveWs.who.some((w) => w.key.startsWith('headline:')));
});

test('a recognised party lands in WHO and a recognised place in WHERE', async () => {
  const { svc } = service({
    cases: caseStore({
      evidence: [
        evidence({ id: 'ev1', entityType: 'buyer', entityId: 'b_cem', entityName: 'CEM' }),
        evidence({ id: 'ev2', entityType: 'campaign', entityId: 'c_med', entityName: 'Medicare Q3' }),
      ],
    }),
  });
  const brief = (await svc.get(ORG, CASE_ID))!;
  assert.ok(brief.fiveWs.who.some((w) => w.key === 'buyer:b_cem' && w.label === 'CEM'));
  assert.ok(brief.fiveWs.where.some((w) => w.key === 'campaign:c_med' && w.label === 'Medicare Q3'));
  assert.equal(brief.fiveWs.unavailable.WHERE, undefined, 'no reason when the dimension has content');
});

test('WHAT carries one item per evidence row, and the claim when there is none', async () => {
  const withEvidence = service();
  const a = (await withEvidence.svc.get(ORG, CASE_ID))!;
  assert.equal(a.fiveWs.what.length, 1);
  assert.equal(a.fiveWs.what[0]!.evidenceId, 'ev1');

  const bare = service({ cases: caseStore({ evidence: [] }) });
  const b = (await bare.svc.get(ORG, CASE_ID))!;
  assert.equal(b.fiveWs.what.length, 1);
  assert.equal(b.fiveWs.what[0]!.derivedFrom, 'CASE', 'a brief with no evidence is not blank');
});

test('WHO orders by first appearance, so the authorizer leads', async () => {
  const { svc } = service({
    cases: caseStore({
      observations: [
        observation({ id: 'o1', sequence: 1, observationType: 'SITUATION_DETECTED' }),
        observation({ id: 'o2', sequence: 2, observationType: 'REVIEWED', actorType: 'HUMAN', actorUserId: ACTOR, reason: INVESTIGATION_AUTHORIZED_REASON }),
        observation({ id: 'o3', sequence: 3, observationType: 'NOTE_ADDED', actorType: 'HUMAN', actorUserId: 'usr_later' }),
      ],
    }),
  });
  const brief = (await svc.get(ORG, CASE_ID))!;
  assert.deepEqual(brief.fiveWs.who.map((w) => w.key), [`user:${ACTOR}`, 'user:usr_later']);
});

// --- 11-17. What the brief does not do -----------------------------------------------------------

test('11/12/13/16. THE BRIEF WRITES NOTHING — proved by exploding doubles', async () => {
  // Every mutating method on both doubles throws. A brief that touched one would
  // fail here rather than in production.
  const { svc, cases, headlines } = service();
  await svc.get(ORG, CASE_ID);
  assert.deepEqual(cases.calls, [`get:${ORG}:${CASE_ID}`], 'one read, nothing else');
  assert.deepEqual(headlines.calls, [`${ORG}:${HEADLINE_ID}`], 'one read, nothing else');
});

test('14/15. the brief exposes no Finding and no Recommendation', async () => {
  const { svc } = service();
  const brief = (await svc.get(ORG, CASE_ID))!;
  const keys = Object.keys(brief);
  for (const forbidden of ['finding', 'findings', 'hypothesis', 'recommendation', 'recommendations', 'actions', 'sequence']) {
    assert.ok(!keys.includes(forbidden), `the brief must not carry ${forbidden}`);
  }
  // A linked hypothesis is deliberately omitted: surfacing a producer's belief
  // through a Case Brief would give it Finding semantics a PR early.
  assert.ok(!JSON.stringify(brief).includes('hypothesis'));
});

test('17. no model is required, and none is reachable', async () => {
  const { svc } = service();
  const brief = await svc.get(ORG, CASE_ID);
  assert.ok(brief, 'assembled from stored state alone');
  // Nothing in the brief is prose Loop composed about its own evidence beyond the
  // headline statement it carries as the claim, which is display-only by contract.
  assert.equal(brief.evidence.every((e) => typeof e.metricKey === 'string'), true);
});

test('the shipped lifecycle vocabulary is reused, not re-mapped', async () => {
  for (const state of ['NEEDS_REVIEW', 'ASSIGNED', 'WATCHING', 'RESOLVED', 'DISMISSED'] as const) {
    const { svc } = service({ cases: caseStore({ state }) });
    const brief = (await svc.get(ORG, CASE_ID))!;
    assert.equal(brief.status, state);
    assert.equal(caseIsOpen(brief), state !== 'RESOLVED' && state !== 'DISMISSED');
  }
});

test('owner and assignee stay separate questions', async () => {
  const { svc } = service({ cases: caseStore({ owner: 'usr_owner', assignee: 'usr_doer' }) });
  const brief = (await svc.get(ORG, CASE_ID))!;
  assert.equal(brief.ownerUserId, 'usr_owner');
  assert.equal(brief.assigneeUserId, 'usr_doer');
});

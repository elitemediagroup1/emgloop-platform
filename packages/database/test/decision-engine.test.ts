// The Decision Engine — the canonical producer-facing service.
//
// These tests are written from the position of a producer that is NOT CallGrid,
// deliberately. If any of them needed a buyer, a campaign, a call or revenue to
// make sense, the engine would have leaked its first producer's shape into the
// platform. They use ACCOUNTING and WEBSITE subjects throughout for that reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import {
  DecisionNotFoundError,
  InvalidDecisionInputError,
  InvalidTransitionError,
} from '../src/services/decision/decision-engine.errors';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';
// Every scenario runs entirely on this fixture clock. Actions pass an explicit
// `occurredAt` rather than letting the engine default to the real clock: mixing
// the two makes ordering depend on what time the suite happens to run, which is
// exactly the flake this repo has been bitten by before.
const T0 = new Date('2026-07-30T18:00:00.000Z');
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

const HUMAN = { type: 'HUMAN' as const, userId: 'user-matt', source: 'operator' };

function make() {
  const prisma = makeCognitivePrisma();
  return { prisma, engine: new DecisionEngine(prisma as never) };
}

/** An Accounting decision. No CallGrid vocabulary anywhere. */
function invoiceRisk(over: Record<string, unknown> = {}) {
  return {
    producer: 'ACCOUNTING',
    recurrenceKey: 'invoice-aging::acme-corp',
    detectionKey: 'month:2026-07',
    detectedAt: T0,
    title: 'Acme Corp invoices ageing past 90 days',
    summary: 'Three invoices have passed the 90-day threshold.',
    severity: 'HIGH',
    impactCents: 1_240_000,
    impactLabel: 'Measured exposure',
    sourceReference: 'customer:acme-corp',
    producerVersion: 'accounting-engine@2.1.0',
    ...over,
  };
}

// --- Tenant isolation --------------------------------------------------------

test('a decision from another organization is not-found, and no write happens', async () => {
  const { engine } = make();
  const { decision } = await engine.create(ORG, invoiceRisk());

  assert.equal(await engine.get(OTHER_ORG, decision.id), null);
  assert.equal(await engine.getCurrentState(OTHER_ORG, decision.id), null);
  await assert.rejects(
    () => engine.assign(OTHER_ORG, decision.id, { actor: HUMAN, assigneeUserId: 'attacker' }),
    DecisionNotFoundError,
  );
  await assert.rejects(
    () => engine.resolve(OTHER_ORG, decision.id, { actor: HUMAN, outcome: 'RECOVERED' }),
    DecisionNotFoundError,
  );

  const view = await engine.get(ORG, decision.id);
  assert.equal(view!.observations.length, 1, 'no observation for a refused write');
  assert.equal(view!.currentState, 'NEEDS_REVIEW');
});

// --- Creation and duplicate prevention ---------------------------------------

test('creating twice in the same analysis period is one decision and one sighting', async () => {
  const { engine } = make();
  const first = await engine.create(ORG, invoiceRisk());
  assert.equal(first.effect, 'CREATED');

  for (let i = 0; i < 20; i++) {
    const again = await engine.create(ORG, invoiceRisk());
    assert.equal(again.effect, 'UNCHANGED');
    assert.equal(again.observation, null);
    assert.equal(again.eventType, null, 'a no-op publishes nothing');
  }
  const view = await engine.get(ORG, first.decision.id);
  assert.equal(view!.observations.length, 1);
  assert.equal(view!.decision.detectionCount, 1);
});

test('a new analysis period records exactly one re-sighting', async () => {
  const { engine } = make();
  const first = await engine.create(ORG, invoiceRisk());
  const next = await engine.create(
    ORG,
    invoiceRisk({ detectionKey: 'month:2026-08', detectedAt: day(31) }),
  );
  assert.equal(next.effect, 'RESIGHTED');
  assert.equal(next.eventType, 'DecisionObserved');
  assert.equal(next.decision.detectionCount, 2);
  const view = await engine.get(ORG, first.decision.id);
  assert.deepEqual(
    view!.observations.map((o) => o.observationType),
    ['SITUATION_DETECTED', 'SITUATION_RESIGHTED'],
  );
});

test('a producer inventing its own severity scale is rejected at the boundary', async () => {
  const { engine } = make();
  await assert.rejects(
    () => engine.create(ORG, invoiceRisk({ severity: 'P1' })),
    InvalidDecisionInputError,
  );
});

test('a producer that cannot name its analysis period is rejected', async () => {
  const { engine } = make();
  await assert.rejects(
    () => engine.create(ORG, invoiceRisk({ detectionKey: '' })),
    InvalidDecisionInputError,
  );
});

// --- Owner and assignee are independent --------------------------------------

test('ownership is accountability, assignment is execution, and neither derives the other', async () => {
  const { engine } = make();
  const { decision } = await engine.create(ORG, invoiceRisk());

  await engine.setOwner(ORG, decision.id, { actor: HUMAN, ownerUserId: 'user-controller' });
  let view = await engine.get(ORG, decision.id);
  assert.equal(view!.ownerUserId, 'user-controller');
  assert.equal(view!.assigneeUserId, null, 'owning it is not working it');
  assert.equal(view!.currentState, 'NEEDS_REVIEW', 'and it still needs picking up');

  await engine.assign(ORG, decision.id, { actor: HUMAN, assigneeUserId: 'user-staff' });
  view = await engine.get(ORG, decision.id);
  assert.equal(view!.assigneeUserId, 'user-staff');
  assert.equal(view!.ownerUserId, 'user-controller', 'assignment never moves accountability');
  assert.equal(view!.currentState, 'ASSIGNED');

  await engine.assign(ORG, decision.id, { actor: HUMAN, assigneeUserId: 'user-lisa' });
  view = await engine.get(ORG, decision.id);
  assert.equal(view!.assigneeUserId, 'user-lisa');
  assert.equal(view!.ownerUserId, 'user-controller', 'ownership survives every handover');
  assert.equal(
    view!.observations.at(-1)!.observationType,
    'REASSIGNED',
    'handover is a different fact from first assignment',
  );
});

// --- Lifecycle guards --------------------------------------------------------

test('closing an already-closed decision is an error, not a second closing observation', async () => {
  const { engine } = make();
  const { decision } = await engine.create(ORG, invoiceRisk());
  await engine.resolve(ORG, decision.id, { actor: HUMAN, outcome: 'RECOVERED' });

  await assert.rejects(
    () => engine.resolve(ORG, decision.id, { actor: HUMAN, outcome: 'RECOVERED' }),
    InvalidTransitionError,
  );
  const view = await engine.get(ORG, decision.id);
  assert.equal(view!.observations.filter((o) => o.observationType === 'RESOLVED').length, 1);
});

test('reopening something that is open is an error', async () => {
  const { engine } = make();
  const { decision } = await engine.create(ORG, invoiceRisk());
  await assert.rejects(
    () => engine.reopen(ORG, decision.id, { actor: HUMAN }),
    InvalidTransitionError,
  );
});

test('ignore is an action; the OUTCOME says why, and that is what survives', async () => {
  const { engine } = make();
  const { decision } = await engine.create(ORG, invoiceRisk());
  await engine.ignore(ORG, decision.id, {
    actor: HUMAN,
    outcome: 'DUPLICATE',
    reason: 'Already tracked under the Q3 receivables review',
  });
  const view = await engine.get(ORG, decision.id);
  assert.equal(view!.currentState, 'DISMISSED');
  assert.equal(view!.decision.outcome, 'DUPLICATE', 'not merely "dismissed"');
  assert.match(view!.observations.at(-1)!.reason!, /Q3 receivables/);
});

test('an unattributed human action is refused', async () => {
  const { engine } = make();
  const { decision } = await engine.create(ORG, invoiceRisk());
  await assert.rejects(
    () => engine.review(ORG, decision.id, { actor: { type: 'HUMAN', userId: null, source: 'operator' } }),
    InvalidDecisionInputError,
  );
});

// --- CONVERTED_TO_WORK stays generic -----------------------------------------

test('converting to work records THAT work was created, never which product', async () => {
  const { engine } = make();
  const { decision } = await engine.create(ORG, invoiceRisk());
  await engine.resolve(ORG, decision.id, {
    actor: HUMAN,
    occurredAt: day(1),
    outcome: 'CONVERTED_TO_WORK',
    destination: { system: 'CRM', type: 'Opportunity', id: 'opp-991' },
  });
  const timeline = await engine.getTimeline(ORG, decision.id);
  const closing = timeline.at(-1)!;
  assert.equal(closing.outcome, 'CONVERTED_TO_WORK');
  assert.deepEqual(closing.destination, { system: 'CRM', type: 'Opportunity', id: 'opp-991' });
  // The engine never imports a Work OS or CRM type to do this.
});

// --- Evidence is append-only -------------------------------------------------

test('evidence appends, and the engine offers no way to change one', async () => {
  const { engine } = make();
  const { decision } = await engine.create(ORG, invoiceRisk({
    evidence: [{
      source: 'accounting-ledger', metricKey: 'invoice.age_days',
      ruleId: 'invoice-aging', ruleVersion: 'v3', producerVersion: 'accounting-engine@2.1.0',
      rawValue: 94, normalizedValue: 94, confidence: 0.9,
      limitations: ['Excludes credit notes issued after period end'],
      observedAt: T0,
    }],
  }));

  const added = await engine.addEvidence(ORG, decision.id, {
    source: 'accounting-ledger', metricKey: 'invoice.balance_cents',
    rawValue: 1_240_000, normalizedValue: 1_240_000, observedAt: day(1),
  }, HUMAN);

  const evidence = await engine.getEvidence(ORG, decision.id);
  assert.equal(evidence.length, 2, 'appended, not replaced');
  assert.deepEqual(
    evidence[0]!.limitations,
    ['Excludes credit notes issued after period end'],
    'caveats travel with the value forever',
  );
  assert.equal(added.result.eventType, 'DecisionEvidenceAdded');

  const surface = Object.getOwnPropertyNames(DecisionEngine.prototype);
  for (const forbidden of ['updateEvidence', 'deleteEvidence', 'setState', 'setEvidence']) {
    assert.ok(!surface.includes(forbidden), `${forbidden} must not exist`);
  }
});

// --- State is a projection ---------------------------------------------------

test('getCurrentState reads the log, not the cached column', async () => {
  const { prisma, engine } = make();
  const { decision } = await engine.create(ORG, invoiceRisk());
  await engine.assign(ORG, decision.id, { actor: HUMAN, assigneeUserId: 'user-staff' });

  // Corrupt the cache the way a bad migration or a stray write would.
  await prisma.operationalPriority.update({
    where: { id: decision.id },
    data: { state: 'DISMISSED', assigneeUserId: null },
  });

  assert.equal(
    await engine.getCurrentState(ORG, decision.id),
    'ASSIGNED',
    'the log is the truth',
  );
  const view = await engine.get(ORG, decision.id);
  assert.equal(view!.currentState, 'ASSIGNED');
  assert.equal(view!.assigneeUserId, 'user-staff');
});

test('the projection is fully rebuildable from the log', async () => {
  const { prisma, engine } = make();
  const { decision } = await engine.create(ORG, invoiceRisk());
  await engine.setOwner(ORG, decision.id, { actor: HUMAN, ownerUserId: 'user-controller' });
  await engine.assign(ORG, decision.id, { actor: HUMAN, assigneeUserId: 'user-staff' });
  await engine.watch(ORG, decision.id, { actor: HUMAN });
  const truth = await prisma.operationalPriority.findFirst({ where: { id: decision.id } });

  await prisma.operationalPriority.update({
    where: { id: decision.id },
    data: { state: 'RESOLVED', ownerUserId: null, assigneeUserId: null, reopenCount: 42 },
  });
  const rebuilt = await engine.rebuildProjection(ORG, decision.id);

  assert.equal(rebuilt!.state, truth.state);
  assert.equal(rebuilt!.ownerUserId, truth.ownerUserId);
  assert.equal(rebuilt!.assigneeUserId, truth.assigneeUserId);
  assert.equal(rebuilt!.reopenCount, truth.reopenCount);
});

// --- Timeline is a projection ------------------------------------------------

test('the timeline is derived from the log and records what each step changed', async () => {
  const { engine } = make();
  const { decision } = await engine.create(ORG, invoiceRisk());
  await engine.assign(ORG, decision.id, { actor: HUMAN, occurredAt: day(1), assigneeUserId: 'user-staff' });
  await engine.resolve(ORG, decision.id, { actor: HUMAN, occurredAt: day(2), outcome: 'RECOVERED' });

  const timeline = await engine.getTimeline(ORG, decision.id);
  assert.equal(timeline.length, 3);
  assert.deepEqual(
    timeline.map((t) => [t.previousState, t.newState]),
    [
      ['NEEDS_REVIEW', null],
      ['NEEDS_REVIEW', 'ASSIGNED'],
      ['ASSIGNED', 'RESOLVED'],
    ],
  );
});

// --- Publication -------------------------------------------------------------

test('every lifecycle operation publishes exactly one event, in the same transaction', async () => {
  const { prisma, engine } = make();
  const { decision } = await engine.create(ORG, invoiceRisk());
  await engine.assign(ORG, decision.id, { actor: HUMAN, assigneeUserId: 'user-staff' });
  await engine.escalate(ORG, decision.id, { actor: HUMAN });
  await engine.resolve(ORG, decision.id, { actor: HUMAN, outcome: 'RECOVERED' });

  const events = await prisma.stateChangeOutbox.findMany({ where: { organizationId: ORG } });
  assert.deepEqual(
    events.map((e: { eventType: string }) => e.eventType),
    ['DecisionCreated', 'DecisionAssigned', 'DecisionEscalated', 'DecisionResolved'],
  );
  for (const e of events) {
    assert.equal(e.subjectType, 'DECISION');
    assert.equal(e.subjectId, decision.id);
    assert.equal(e.identityId, null, 'an accounting exposure is not a person');
    assert.equal(e.stateKey, 'decision.ACCOUNTING.invoice-aging::acme-corp');
  }
});

test('an identity is published when the subject genuinely has one', async () => {
  const { prisma, engine } = make();
  await engine.create(ORG, invoiceRisk({ identityId: 'identity-acme' }));
  const [event] = await prisma.stateChangeOutbox.findMany({ where: { organizationId: ORG } });
  assert.equal(event.identityId, 'identity-acme');
});

test('the engine names no subscriber anywhere in its published payload', async () => {
  const { prisma, engine } = make();
  const { decision } = await engine.create(ORG, invoiceRisk());
  const [event] = await prisma.stateChangeOutbox.findMany({ where: { organizationId: ORG } });
  const serialized = JSON.stringify(event);
  for (const consumer of ['WorkOS', 'work_os', 'Notification', 'CRM_SUBSCRIBER', 'Dashboard']) {
    assert.ok(!serialized.includes(consumer), `payload must not name ${consumer}`);
  }
  assert.equal(event.subjectId, decision.id);
});

// --- Replay and reappearance -------------------------------------------------

test('a sighting after a resolution reopens; one from before it does not', async () => {
  const { engine } = make();
  const created = await engine.create(ORG, invoiceRisk({ detectionKey: 'm:07', detectedAt: day(5) }));
  await engine.resolve(ORG, created.decision.id, { actor: HUMAN, occurredAt: day(6), outcome: 'RECOVERED' });

  const historical = await engine.create(
    ORG,
    invoiceRisk({ detectionKey: 'm:06', detectedAt: day(0) }),
  );
  assert.equal(historical.effect, 'RESIGHTED');
  assert.equal(historical.decision.state, 'RESOLVED', 'reading history is not relapsing');

  const relapse = await engine.create(
    ORG,
    invoiceRisk({ detectionKey: 'm:09', detectedAt: day(60) }),
  );
  assert.equal(relapse.effect, 'REOPENED');
  assert.equal(relapse.decision.state, 'NEEDS_REVIEW');
  assert.equal(relapse.decision.reopenCount, 1);
});

// --- Generic by construction -------------------------------------------------

test('two unrelated producers coexist without knowing about each other', async () => {
  const { engine } = make();
  await engine.create(ORG, invoiceRisk());
  await engine.create(ORG, {
    producer: 'WEBSITE',
    recurrenceKey: 'funnel-drop::/pricing',
    detectionKey: 'week:2026-W31',
    detectedAt: T0,
    title: 'Checkout completion fell on /pricing',
    severity: 'NOTABLE',
    // No impactCents: a website funnel drop is not measured in money, and the
    // engine does not require it to pretend otherwise.
    impactLabel: 'Sessions affected',
    sourceReference: 'page:/pricing',
  });

  const accounting = await engine.list(ORG, { producer: 'ACCOUNTING' });
  const website = await engine.list(ORG, { producer: 'WEBSITE' });
  assert.equal(accounting.length, 1);
  assert.equal(website.length, 1);
  assert.equal(website[0]!.impactCents, null, 'unmeasured, not zero');

  const counts = await engine.countsByState(ORG);
  assert.equal(counts.NEEDS_REVIEW, 2, 'one queue, both producers');
});

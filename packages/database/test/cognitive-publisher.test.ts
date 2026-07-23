// Loop Cognitive Architecture — Increment 3 deterministic tests.
//
// Drives the REAL publisher / context service / decision policies / subscribers
// against the in-memory cognitive Prisma double, on state produced by the REAL
// Increment-2 processor. Proves the governed read surface, the outbox publisher's
// exactly-once + independent-retry + dead-letter guarantees, deterministic
// decision precedence, and that decisions are RECORDED, never executed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import {
  CognitiveEventProcessor,
  CognitiveContextService,
  StateChangePublisher,
  DecisionPolicyRegistry,
  resolveDecisionPrecedence,
  resolveOutcomePrecedence,
  type ProcessEventInput,
  type PolicyEvaluation,
} from '../src/services/cognitive';
import {
  DataGovernancePolicyRepository,
  ActiveStateRepository,
  StateChangeSubscriptionRepository,
  StateChangeDeliveryRepository,
  StateChangeOutboxRepository,
  CognitiveDecisionRepository,
} from '../src/repositories/cognitive';

const ORG = 'org_a';
const OTHER_ORG = 'org_b';
const OCCURRED = new Date('2026-07-23T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function prisma(): PrismaClient {
  return makeCognitivePrisma() as unknown as PrismaClient;
}

async function allow(p: PrismaClient, purposes: string[]) {
  await new DataGovernancePolicyRepository(p).create(ORG, {
    name: 'allow',
    status: 'ACTIVE',
    allowedPurposes: purposes as never,
  });
}

function productClick(overrides: Partial<ProcessEventInput> = {}): ProcessEventInput {
  return {
    organizationId: ORG,
    sourceSystem: 'website',
    sourceEventId: 'evt-click-1',
    eventType: 'PRODUCT_CLICKED',
    occurredAt: OCCURRED,
    channel: 'sms',
    subject: { entityType: 'PERSON', canonicalKey: 'person-1', roleType: 'CONSUMER' },
    payload: { name: 'Purple Running Shoe', category: 'Footwear', color: 'Purple' },
    requestedPurposes: ['PERSONALIZATION'],
    ...overrides,
  };
}

function consentRevoked(overrides: Partial<ProcessEventInput> = {}): ProcessEventInput {
  return {
    organizationId: ORG,
    sourceSystem: 'website',
    sourceEventId: 'evt-consent-1',
    eventType: 'CONSENT_CHANGED',
    occurredAt: OCCURRED,
    channel: 'sms',
    subject: { entityType: 'PERSON', canonicalKey: 'person-1', roleType: 'CONSUMER' },
    payload: { channel: 'sms', granted: false },
    requestedPurposes: ['SERVICE_DELIVERY'],
    ...overrides,
  };
}

function campaignHigh(overrides: Partial<ProcessEventInput> = {}): ProcessEventInput {
  return {
    organizationId: ORG,
    sourceSystem: 'callgrid',
    sourceEventId: 'evt-campaign-1',
    eventType: 'CAMPAIGN_STATUS_CHANGED',
    occurredAt: OCCURRED,
    channel: null,
    subject: { entityType: 'CAMPAIGN', canonicalKey: 'campaign-9', roleType: 'CAMPAIGN' },
    payload: { status: 'ACTIVE', attentionLevel: 'HIGH' },
    requestedPurposes: ['OPERATIONS'],
    ...overrides,
  };
}

async function subscribe(
  p: PrismaClient,
  handlerKey: string,
  opts: { domain?: string | null; pattern?: string | null; required?: boolean } = {},
) {
  return new StateChangeSubscriptionRepository(p).create(ORG, {
    subscriberType: 'INTERNAL_HANDLER',
    subscriberKey: handlerKey,
    endpointOrHandler: handlerKey,
    domain: (opts.domain ?? null) as never,
    stateKeyPattern: opts.pattern ?? '*',
    required: opts.required ?? false,
  });
}

// --- 1. Publish to the audit subscriber ------------------------------------
test('publisher delivers a state change to the audit subscriber and marks it published', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const res = await new CognitiveEventProcessor(p).processEvent(productClick());
  assert.equal(res.status, 'processed');
  await subscribe(p, 'audit', { domain: 'COMMERCE' });

  const result = await new StateChangePublisher(p).run(ORG);
  assert.ok(result.outboxSeen > 0, 'saw outbox rows');
  assert.equal(result.outboxPublished, result.outboxSeen, 'every seen row published');
  assert.equal(result.outboxDeadLettered, 0);
  assert.ok(result.deliveriesSucceeded > 0, 'audit deliveries succeeded');

  // Every delivery is terminal SUCCEEDED; an audit row exists per publication.
  const deliveries = await (p as any).stateChangeDelivery.findMany({ where: { organizationId: ORG } });
  assert.ok(deliveries.length > 0);
  assert.ok(deliveries.every((d: any) => d.status === 'SUCCEEDED'));
  const audits = await (p as any).auditLog.findMany({ where: { organizationId: ORG } });
  assert.equal(audits.length, deliveries.length);
  assert.ok(audits.every((a: any) => a.action === 'cognitive.state_change.published'));
});

// --- 2. Idempotency / single-claim -----------------------------------------
test('re-running the publisher never re-dispatches a succeeded delivery', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  await new CognitiveEventProcessor(p).processEvent(productClick());
  await subscribe(p, 'audit', { domain: 'COMMERCE' });

  const first = await new StateChangePublisher(p).run(ORG);
  const deliveriesAfterFirst = (await (p as any).stateChangeDelivery.findMany({ where: { organizationId: ORG } })).length;
  const auditsAfterFirst = (await (p as any).auditLog.findMany({ where: { organizationId: ORG } })).length;

  const second = await new StateChangePublisher(p).run(ORG);
  const deliveriesAfterSecond = (await (p as any).stateChangeDelivery.findMany({ where: { organizationId: ORG } })).length;
  const auditsAfterSecond = (await (p as any).auditLog.findMany({ where: { organizationId: ORG } })).length;

  assert.ok(first.deliveriesDispatched > 0);
  assert.equal(second.outboxSeen, 0, 'nothing left to publish on the second pass');
  assert.equal(second.deliveriesDispatched, 0, 'no re-dispatch');
  assert.equal(deliveriesAfterSecond, deliveriesAfterFirst, 'no duplicate deliveries');
  assert.equal(auditsAfterSecond, auditsAfterFirst, 'no duplicate audit rows');
});

// --- 3. Audit never leaks the raw value ------------------------------------
test('audit subscriber records a safe summary, never the raw state value', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  await new CognitiveEventProcessor(p).processEvent(productClick());
  await subscribe(p, 'audit', { domain: 'COMMERCE' });
  await new StateChangePublisher(p).run(ORG);

  const audits = await (p as any).auditLog.findMany({ where: { organizationId: ORG } });
  for (const a of audits) {
    assert.ok(!('value' in (a.metadata ?? {})), 'no raw value in audit metadata');
    assert.equal(typeof a.metadata.summary, 'string');
    assert.ok(a.metadata.domain && a.metadata.stateKey && a.metadata.changeType);
  }
});

// --- 4. Decision-evaluation subscriber, idempotent -------------------------
test('decision-evaluation records exactly one RECOMMEND for a fresh commerce interest, idempotently', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  await new CognitiveEventProcessor(p).processEvent(productClick());
  await subscribe(p, 'decision-evaluation', { domain: 'COMMERCE', pattern: 'currentProductInterest' });

  await new StateChangePublisher(p).run(ORG);
  let decisions = await new CognitiveDecisionRepository(p).list(ORG);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.decision, 'RECOMMEND');
  assert.equal(decisions[0]!.decisionType, 'commerce-personalization-eligibility');
  assert.equal(decisions[0]!.requiresApproval, false);

  // A second pass over the same revision must not add a second decision.
  await new StateChangePublisher(p).run(ORG);
  decisions = await new CognitiveDecisionRepository(p).list(ORG);
  assert.equal(decisions.length, 1, 'decision is idempotent by (revision, policy, version, channel)');
});

// --- 5. SUPPRESS precedence (integration) ----------------------------------
test('communication suppression takes precedence over commerce RECOMMEND', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION', 'SERVICE_DELIVERY']);
  const proc = new CognitiveEventProcessor(p);
  await proc.processEvent(productClick()); // commerce interest → would RECOMMEND
  await proc.processEvent(consentRevoked()); // frequencyLimitReached=true → SUPPRESS
  await subscribe(p, 'decision-evaluation'); // all domains

  await new StateChangePublisher(p).run(ORG);
  const decisions = await new CognitiveDecisionRepository(p).list(ORG);
  assert.ok(decisions.length > 0, 'at least one decision recorded');
  assert.ok(
    decisions.every((d) => d.decision === 'SUPPRESS'),
    'suppression wins for every triggered evaluation',
  );
  assert.ok(decisions.every((d) => d.decisionType === 'communication-frequency-suppression'));
});

// --- 6. Precedence is pure and order-independent ---------------------------
test('resolveDecisionPrecedence is deterministic and order-independent', async () => {
  const mk = (policyId: string, decision: PolicyEvaluation['decision']): PolicyEvaluation => ({
    policyId,
    version: 'v1',
    decision,
    requiresApproval: false,
    decisionPurpose: 'PERSONALIZATION',
    channel: 'sms',
    confidence: 0.6,
    reason: 'x',
    evidenceStateIds: [],
  });
  const rec = mk('commerce-personalization-eligibility', 'RECOMMEND');
  const sup = mk('communication-frequency-suppression', 'SUPPRESS');

  assert.equal(resolveDecisionPrecedence([rec, sup])?.decision, 'SUPPRESS');
  assert.equal(resolveDecisionPrecedence([sup, rec])?.decision, 'SUPPRESS');
  assert.equal(resolveOutcomePrecedence(['NO_ACTION', 'RECOMMEND', 'SUPPRESS']), 'SUPPRESS');
  assert.equal(resolveOutcomePrecedence(['RECOMMEND', 'NO_ACTION']), 'RECOMMEND');
  // CREATE_WORK / ESCALATE are operational, never ranked as messaging outcomes.
  assert.equal(resolveOutcomePrecedence(['CREATE_WORK']), null);
  assert.equal(resolveDecisionPrecedence([]), null);
});

// --- 7. Work OS subscriber: approval-required CREATE_WORK, records only -----
test('work-os subscriber records an approval-required CREATE_WORK for HIGH campaign attention', async () => {
  const p = prisma();
  await allow(p, ['OPERATIONS']);
  await new CognitiveEventProcessor(p).processEvent(campaignHigh());
  await subscribe(p, 'work-os', { domain: 'CAMPAIGN', pattern: 'operationalAttentionLevel' });

  await new StateChangePublisher(p).run(ORG);
  const decisions = await new CognitiveDecisionRepository(p).list(ORG);
  const work = decisions.filter((d) => d.decision === 'CREATE_WORK');
  assert.equal(work.length, 1);
  assert.equal(work[0]!.requiresApproval, true, 'CREATE_WORK is approval-required, never auto');
  // Recorded only — the decision carries no execution timestamp.
  assert.equal(work[0]!.executedAt ?? null, null);
});

// --- 8. Required subscriber dead-letter fails the parent --------------------
test('a required subscriber that cannot be handled dead-letters and fails the parent', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  await new CognitiveEventProcessor(p).processEvent(productClick());
  // Unknown handler key + required → fails closed after one attempt.
  await subscribe(p, 'nonexistent-required', { domain: 'COMMERCE', required: true });

  const result = await new StateChangePublisher(p, { maxAttempts: 1 }).run(ORG);
  assert.equal(result.outboxPublished, 0);
  assert.equal(result.outboxDeadLettered, result.outboxSeen, 'every parent dead-lettered');
  assert.ok(result.deliveriesDeadLettered > 0);

  const deliveries = await (p as any).stateChangeDelivery.findMany({ where: { organizationId: ORG } });
  assert.ok(deliveries.every((d: any) => d.status === 'DEAD_LETTERED'));
  const outbox = await new StateChangeOutboxRepository(p).findById(
    ORG,
    (await (p as any).stateChangeOutbox.findFirst({ where: { organizationId: ORG } })).id,
  );
  assert.equal(outbox!.status, 'DEAD_LETTERED');
});

// --- 9. Optional subscriber dead-letter does NOT block publication ----------
test('an optional subscriber dead-letter does not block a healthy publication', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  await new CognitiveEventProcessor(p).processEvent(productClick());
  await subscribe(p, 'audit', { domain: 'COMMERCE' }); // succeeds
  await subscribe(p, 'nonexistent-optional', { domain: 'COMMERCE', required: false }); // dead-letters

  const result = await new StateChangePublisher(p, { maxAttempts: 1 }).run(ORG);
  assert.equal(result.outboxDeadLettered, 0, 'optional failure never fails the parent');
  assert.equal(result.outboxPublished, result.outboxSeen, 'parent still published');
  assert.ok(result.deliveriesDeadLettered > 0, 'the optional delivery dead-lettered');
  assert.ok(result.deliveriesSucceeded > 0, 'the audit delivery succeeded');
});

// --- 10. Failed (transient) delivery retries, does not dead-letter early ----
test('a failed delivery below the attempt ceiling re-queues rather than dead-letters', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  await new CognitiveEventProcessor(p).processEvent(productClick());
  await subscribe(p, 'nonexistent', { domain: 'COMMERCE', required: false });

  // maxAttempts 3, long back-off: first pass fails but must NOT dead-letter.
  const result = await new StateChangePublisher(p, { maxAttempts: 3, retryDelayMs: 60_000 }).run(ORG);
  assert.ok(result.deliveriesFailed > 0);
  assert.equal(result.deliveriesDeadLettered, 0);
  assert.equal(result.outboxInFlight, result.outboxSeen, 'parent stays in-flight while retrying');

  const deliveries = await (p as any).stateChangeDelivery.findMany({ where: { organizationId: ORG } });
  assert.ok(deliveries.every((d: any) => d.status === 'FAILED' && d.availableAt > d.startedAt));
});

// --- 11. explainActiveState: inspectable, evidence-cited account ------------
test('explainActiveState assembles an inspectable, evidence-cited account from stored rows', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const res = await new CognitiveEventProcessor(p).processEvent(productClick());
  const record = await new ActiveStateRepository(p).getState(
    ORG,
    res.subjectIdentityId!,
    'COMMERCE',
    'currentProductInterest',
  );
  assert.ok(record);

  const svc = new CognitiveContextService(p);
  const exp = await svc.explainActiveState({
    organizationId: ORG,
    activeStateRecordId: record!.id,
    requestedPurpose: 'PERSONALIZATION',
  });
  assert.equal(exp.found, true);
  assert.equal(exp.currentValue, 'Purple Running Shoe');
  assert.ok(exp.supportingEvidence.length > 0, 'evidence is cited');
  assert.equal(exp.lastChangingEvent?.eventType, 'PRODUCT_CLICKED');
  assert.equal(exp.lastChangingEvent?.channel, 'sms');
  assert.match(exp.explanation, /Supported by/);
  assert.doesNotMatch(exp.explanation, /Caused by/);
});

// --- 12. explainActiveState withholds a value for an unpermitted purpose ----
test('explainActiveState withholds the value when the purpose is not permitted', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const res = await new CognitiveEventProcessor(p).processEvent(productClick());
  const record = await new ActiveStateRepository(p).getState(
    ORG,
    res.subjectIdentityId!,
    'COMMERCE',
    'currentProductInterest',
  );

  const exp = await new CognitiveContextService(p).explainActiveState({
    organizationId: ORG,
    activeStateRecordId: record!.id,
    requestedPurpose: 'SALES', // not allowed
  });
  assert.equal(exp.found, true);
  assert.equal(exp.currentValue, null, 'value withheld');
  assert.ok(exp.unknowns.some((u) => /not permitted/.test(u)));
  assert.match(exp.explanation, /withheld/);
});

// --- 13. Cross-org isolation ------------------------------------------------
test('explainActiveState for another organization returns not-found, never a leak', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const res = await new CognitiveEventProcessor(p).processEvent(productClick());
  const record = await new ActiveStateRepository(p).getState(
    ORG,
    res.subjectIdentityId!,
    'COMMERCE',
    'currentProductInterest',
  );

  const exp = await new CognitiveContextService(p).explainActiveState({
    organizationId: OTHER_ORG,
    activeStateRecordId: record!.id,
    requestedPurpose: 'PERSONALIZATION',
  });
  assert.equal(exp.found, false);
  assert.equal(exp.currentValue, null);
});

// --- 14. getIdentityContext governance + validation -------------------------
test('getIdentityContext denies an unpermitted purpose and discloses the omission', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const res = await new CognitiveEventProcessor(p).processEvent(productClick());
  const svc = new CognitiveContextService(p);

  const ctx = await svc.getIdentityContext({
    organizationId: ORG,
    identityId: res.subjectIdentityId!,
    requestedPurpose: 'SALES', // not allowed by the single PERSONALIZATION policy
    domains: ['COMMERCE'],
  });
  assert.equal(ctx.activeState.length, 0, 'no governed data for a denied purpose');
  assert.equal(ctx.policyDecisions[0]!.outcome, 'DENY');
  assert.ok(ctx.unknowns.some((u) => /not permitted/.test(u)));

  // A permitted purpose returns the commerce interest, freshness-labelled.
  const ok = await svc.getIdentityContext({
    organizationId: ORG,
    identityId: res.subjectIdentityId!,
    requestedPurpose: 'PERSONALIZATION',
    domains: ['COMMERCE'],
  });
  assert.ok(ok.activeState.some((s) => s.stateKey === 'currentProductInterest'));
  assert.ok(ok.activeState.every((s) => s.freshness === 'CURRENT' || s.freshness === 'STALE'));
});

// --- 15. getIdentityContext refuses an unscoped query -----------------------
test('getIdentityContext refuses an empty-domain or purposeless query (deny-by-default)', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const res = await new CognitiveEventProcessor(p).processEvent(productClick());
  const svc = new CognitiveContextService(p);

  await assert.rejects(
    () =>
      svc.getIdentityContext({
        organizationId: ORG,
        identityId: res.subjectIdentityId!,
        requestedPurpose: 'PERSONALIZATION',
        domains: [],
      }),
    /domains must be explicitly requested/,
  );
  await assert.rejects(
    () =>
      svc.getIdentityContext({
        organizationId: ORG,
        identityId: res.subjectIdentityId!,
        requestedPurpose: '',
        domains: ['COMMERCE'],
      }),
    /requestedPurpose is required/,
  );
});

// --- 16. Expired state is omitted and disclosed -----------------------------
test('getIdentityContext omits expired state and discloses the count', async () => {
  const p = prisma();
  await allow(p, ['PERSONALIZATION']);
  const res = await new CognitiveEventProcessor(p).processEvent(productClick());
  const svc = new CognitiveContextService(p);

  // Commerce states carry a 1-day TTL; query well past it.
  const later = new Date(Date.now() + 3 * DAY_MS);
  const ctx = await svc.getIdentityContext({
    organizationId: ORG,
    identityId: res.subjectIdentityId!,
    requestedPurpose: 'PERSONALIZATION',
    domains: ['COMMERCE'],
    now: later,
  });
  assert.equal(ctx.activeState.length, 0, 'expired commerce state is not returned');
  assert.ok(ctx.freshness.omittedExpiredCount > 0);
  assert.ok(ctx.unknowns.some((u) => /expired\/inactive/.test(u)));
});

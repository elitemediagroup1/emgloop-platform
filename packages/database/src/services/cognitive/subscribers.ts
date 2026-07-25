// Internal state-change subscribers (Increment 3).
//
// Four internal handlers the StateChangePublisher dispatches to. None execute an
// external action, send a message, or create a Work Item — decisions are
// RECORDED, dashboards are (for now) a documented no-op. Every handler is
// org-scoped and reads governed context ONLY through CognitiveContextService
// (never unrestricted repository reads). Idempotency at the handler level is
// backed by the delivery single-claim (a SUCCEEDED delivery is never
// re-dispatched) and, for decisions, by a stable (revision, policy, version)
// idempotency key.

import type {
  StateChangeOutbox,
  StateChangeSubscription,
  StateChangeDelivery,
  DataPurpose,
} from '@prisma/client';

import type { AuditRepository } from '../../repositories/audit.repository';
import type { CognitiveDecisionRepository } from '../../repositories/cognitive';
import type { CognitiveContextService } from './context-service';
import {
  DecisionPolicyRegistry,
  resolveDecisionPrecedence,
  type PolicyEvaluation,
} from './decision-policies';

export interface SubscriberContext {
  organizationId: string;
  outbox: StateChangeOutbox;
  subscription: StateChangeSubscription;
  delivery: StateChangeDelivery;
  now: Date;
}

export interface SubscriberDeps {
  contextService: CognitiveContextService;
  decisions: CognitiveDecisionRepository;
  audit: Pick<AuditRepository, 'record'>;
}

export interface HandlerResult {
  status: 'ok' | 'noop';
  summary: string;
  reason?: string;
}

export type SubscriberHandler = (
  ctx: SubscriberContext,
  deps: SubscriberDeps,
) => Promise<HandlerResult>;

function revisionKey(outbox: StateChangeOutbox): string {
  return outbox.activeStateRevisionId ?? outbox.id;
}

// --- A. Audit subscriber ---------------------------------------------------
// Records the publication through the existing audit system. Idempotent via the
// delivery single-claim. NO raw sensitive payload (never the state value) — a
// safe summary and structural ids only.
const auditSubscriber: SubscriberHandler = async (ctx, deps) => {
  const o = ctx.outbox;
  await deps.audit.record({
    organizationId: ctx.organizationId,
    action: 'cognitive.state_change.published',
    actorType: 'SYSTEM',
    actorName: 'Cognitive Publisher',
    entityType: 'ActiveStateRecord',
    entityId: o.activeStateRecordId ?? o.id,
    metadata: {
      domain: o.domain,
      stateKey: o.stateKey,
      changeType: o.changeType,
      activeStateRecordId: o.activeStateRecordId,
      activeStateRevisionId: o.activeStateRevisionId,
      deliveryIdempotencyKey: ctx.delivery.idempotencyKey,
      summary: `${o.domain}/${o.stateKey} ${o.changeType}`,
    },
  });
  return { status: 'ok', summary: `audit: ${o.domain}/${o.stateKey} ${o.changeType}` };
};

// --- B. Decision-evaluation subscriber -------------------------------------
// Runs the messaging DecisionPolicyRegistry policies over GOVERNED context,
// resolves precedence deterministically, and records ONE decision (idempotent by
// revision+policy+version+channel). Executes nothing.
const decisionEvaluationSubscriber: SubscriberHandler = async (ctx, deps) => {
  const org = ctx.organizationId;
  const identityId = ctx.outbox.identityId;
  const recordId = ctx.outbox.activeStateRecordId;

  // Resolve the source channel of this change THROUGH the context service.
  let channel: string | null = null;
  if (recordId) {
    const exp = await deps.contextService.explainActiveState({
      organizationId: org,
      activeStateRecordId: recordId,
      requestedPurpose: 'PERSONALIZATION',
      channel: null,
      now: ctx.now,
    });
    channel = exp.lastChangingEvent?.channel ?? null;
  }

  const candidates: PolicyEvaluation[] = [];
  for (const policy of DecisionPolicyRegistry.messagingPolicies()) {
    const context = await deps.contextService.getIdentityContext({
      organizationId: org,
      identityId,
      requestedPurpose: policy.contextPurpose,
      channel,
      domains: policy.inputDomains,
      includeEvidence: true,
      now: ctx.now,
    });
    const evaluation = policy.evaluate({ context, channel, now: ctx.now });
    if (evaluation) candidates.push(evaluation);
  }

  const winner = resolveDecisionPrecedence(candidates);
  if (!winner) return { status: 'noop', summary: 'no messaging decision applies' };

  const idempotencyKey = `${revisionKey(ctx.outbox)}:${winner.policyId}:${winner.version}:${channel ?? 'none'}`;
  await deps.decisions.recordIdempotent(org, {
    decisionType: winner.policyId,
    decision: winner.decision,
    subjectIdentityId: identityId,
    requestedPurpose: winner.decisionPurpose as DataPurpose,
    channel,
    reason: winner.reason,
    confidence: winner.confidence,
    requiresApproval: winner.requiresApproval,
    inputStateSnapshot: { domain: ctx.outbox.domain, stateKey: ctx.outbox.stateKey },
    policyEvaluation: { winner, candidates: candidates.map((c) => ({ policyId: c.policyId, decision: c.decision })) },
    idempotencyKey,
  });
  return { status: 'ok', summary: `decision ${winner.decision} via ${winner.policyId}` };
};

// --- C. Work OS subscriber -------------------------------------------------
// Records an approval-required CREATE_WORK recommendation for a HIGH-attention
// campaign. Records the decision ONLY — no WorkInstance, Task, assignment, or
// notification. Idempotent by (revision, policy, version).
const workOsSubscriber: SubscriberHandler = async (ctx, deps) => {
  const org = ctx.organizationId;
  const identityId = ctx.outbox.identityId;
  const policy = DecisionPolicyRegistry.get('campaign-operational-review');
  if (!policy) return { status: 'noop', summary: 'no campaign work policy registered' };

  const context = await deps.contextService.getIdentityContext({
    organizationId: org,
    identityId,
    requestedPurpose: policy.contextPurpose,
    channel: null,
    domains: policy.inputDomains,
    includeEvidence: true,
    now: ctx.now,
  });
  const evaluation = policy.evaluate({ context, channel: null, now: ctx.now });
  if (!evaluation) {
    return { status: 'noop', summary: 'campaign attention below threshold or evidence missing' };
  }

  const idempotencyKey = `${revisionKey(ctx.outbox)}:${evaluation.policyId}:${evaluation.version}`;
  await deps.decisions.recordIdempotent(org, {
    decisionType: 'CREATE_WORK',
    decision: 'CREATE_WORK',
    subjectIdentityId: identityId,
    requestedPurpose: 'OPERATIONS' as DataPurpose,
    channel: null,
    reason: evaluation.reason,
    confidence: evaluation.confidence,
    requiresApproval: true,
    inputStateSnapshot: { domain: ctx.outbox.domain, stateKey: ctx.outbox.stateKey, value: 'HIGH' },
    policyEvaluation: { evaluation: { policyId: evaluation.policyId, decision: evaluation.decision } },
    idempotencyKey,
  });
  return { status: 'ok', summary: 'recorded approval-required CREATE_WORK' };
};

// --- D. Dashboard-invalidation subscriber ----------------------------------
// No safe, org/projection-scoped invalidation mechanism is callable from the
// database layer (Next's revalidatePath is runtime-only and not org-scoped), so
// this is a DOCUMENTED no-op rather than a new caching system. It succeeds so it
// never blocks the parent publication.
const dashboardInvalidationSubscriber: SubscriberHandler = async () => ({
  status: 'noop',
  summary: 'dashboard invalidation deferred',
  reason:
    'No org/projection-scoped cache-invalidation mechanism is callable from the database layer; revalidatePath is Next-runtime-only and not org-scoped. Deferred — see docs/architecture/loop-cognitive-architecture.md.',
});

export const SUBSCRIBER_HANDLERS: Record<string, SubscriberHandler> = {
  audit: auditSubscriber,
  'decision-evaluation': decisionEvaluationSubscriber,
  'work-os': workOsSubscriber,
  'dashboard-invalidation': dashboardInvalidationSubscriber,
};

/** The internal handler for a subscription's endpointOrHandler, or undefined. */
export function resolveSubscriber(key: string): SubscriberHandler | undefined {
  return SUBSCRIBER_HANDLERS[key];
}

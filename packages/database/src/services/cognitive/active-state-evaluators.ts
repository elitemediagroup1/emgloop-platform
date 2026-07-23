// Stage 7 — ActiveStateEvaluatorRegistry (PURE).
//
// Maps an event (and the knowledge just derived) to the AFFECTED state keys
// only — never a full rebuild. Each proposed change declares value, confidence,
// expiration, decay, scope, sensitivity, permitted purposes, rule version, a
// reason, and which knowledge predicates back it (evidence). The processor turns
// each proposal into a transactional applyStateChange (record + revision +
// evidence + outbox).

import type { MemoryEventType } from '@prisma/client';
import type { ActiveStateEvaluator, ProposedStateChange, StateEvaluatorInput } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

function commerceChange(
  stateKey: string,
  value: unknown,
  confidence: number | null,
  ruleVersion: string,
  reason: string,
  evidencePredicates: string[],
): ProposedStateChange {
  return {
    domain: 'COMMERCE',
    stateKey,
    value,
    valueType: 'STRING',
    confidence,
    permittedPurposes: ['PERSONALIZATION'],
    sensitivity: 'INTERNAL',
    scope: 'INDIVIDUAL',
    decayModel: 'FIXED_EXPIRATION',
    ttlMs: DAY_MS,
    ruleVersion,
    changeReason: reason,
    evidencePredicates,
  };
}

// Commerce — reacts to browse/search/click signals.
const commerce: ActiveStateEvaluator = {
  eventType: 'PRODUCT_CLICKED',
  ruleVersion: 'state.commerce.v1',
  domains: ['COMMERCE'],
  evaluate({ event, assertions }: StateEvaluatorInput): ProposedStateChange[] {
    const v = this.ruleVersion;
    const out: ProposedStateChange[] = [];
    const product = assertions['observedInterest.product'];
    const category = assertions['observedInterest.category'];
    const color = assertions['observedInterest.attribute.color'];
    if (product !== undefined)
      out.push(commerceChange('currentProductInterest', product, 0.6, v, 'product signal', ['observedInterest.product']));
    if (category !== undefined)
      out.push(commerceChange('currentCategoryInterest', category, 0.55, v, 'category signal', ['observedInterest.category']));
    if (color !== undefined)
      out.push(commerceChange('currentAttributeInterest.color', color, 0.5, v, 'attribute signal', ['observedInterest.attribute.color']));

    // intentStrength is a deterministic function of the signal type.
    const intent = INTENT_BY_EVENT[event.eventType];
    if (intent) out.push(commerceChange('intentStrength', intent, INTENT_CONFIDENCE[intent] ?? null, v, 'intent from signal type', []));

    out.push(commerceChange('lastCommerceSignalAt', event.occurredAt.toISOString(), null, v, 'signal timestamp', []));
    return out;
  },
};

const INTENT_BY_EVENT: Partial<Record<MemoryEventType, string>> = {
  PRODUCT_CLICKED: 'HIGH',
  PRODUCT_VIEWED: 'MEDIUM',
  SEARCH_PERFORMED: 'MEDIUM',
  PAGE_VIEWED: 'LOW',
};
const INTENT_CONFIDENCE: Record<string, number> = { HIGH: 0.8, MEDIUM: 0.5, LOW: 0.3 };

// A shared commerce evaluator body reused for the other commerce-signal events.
function commerceFor(eventType: MemoryEventType): ActiveStateEvaluator {
  return { ...commerce, eventType };
}

// Communication — reacts to consent changes.
const communication: ActiveStateEvaluator = {
  eventType: 'CONSENT_CHANGED',
  ruleVersion: 'state.communication.v1',
  domains: ['COMMUNICATION'],
  evaluate({ event, assertions }: StateEvaluatorInput): ProposedStateChange[] {
    const v = this.ruleVersion;
    const out: ProposedStateChange[] = [];
    const sms = assertions['consent.sms'];
    const email = assertions['consent.email'];
    const base = {
      domain: 'COMMUNICATION' as const,
      valueType: 'STRING' as const,
      permittedPurposes: ['SERVICE_DELIVERY'] as ProposedStateChange['permittedPurposes'],
      sensitivity: 'CONFIDENTIAL' as const,
      scope: 'INDIVIDUAL' as const,
      decayModel: 'NONE' as const,
      ruleVersion: v,
    };
    if (sms !== undefined) {
      out.push({ ...base, stateKey: 'smsConsentStatus', value: sms, confidence: 1.0, changeReason: 'consent change', evidencePredicates: ['consent.sms'] });
      out.push({ ...base, stateKey: 'frequencyLimitReached', value: sms === 'REVOKED', valueType: 'BOOLEAN', confidence: 1.0, changeReason: 'consent gating', evidencePredicates: ['consent.sms'] });
    }
    if (email !== undefined) {
      out.push({ ...base, stateKey: 'emailConsentStatus', value: email, confidence: 1.0, changeReason: 'consent change', evidencePredicates: ['consent.email'] });
    }
    return out;
  },
};

// Work — reacts to work lifecycle events (payload-driven, deterministic).
const work: ActiveStateEvaluator = {
  eventType: 'WORK_STEP_COMPLETED',
  ruleVersion: 'state.work.v1',
  domains: ['WORK'],
  evaluate({ event, assertions }: StateEvaluatorInput): ProposedStateChange[] {
    const v = this.ruleVersion;
    const p = event.payload;
    const out: ProposedStateChange[] = [];
    const base = {
      domain: 'WORK' as const,
      valueType: 'STRING' as const,
      confidence: 1.0,
      permittedPurposes: ['OPERATIONS'] as ProposedStateChange['permittedPurposes'],
      sensitivity: 'INTERNAL' as const,
      scope: 'OPERATIONAL' as const,
      decayModel: 'NONE' as const,
      ruleVersion: v,
      evidencePredicates: ['observed.work.lastCompletedStep'],
    };
    if (typeof p['workItemId'] === 'string') out.push({ ...base, stateKey: 'currentWorkItem', value: p['workItemId'], changeReason: 'work item' });
    if (typeof p['stepKey'] === 'string') out.push({ ...base, stateKey: 'currentWorkStep', value: p['stepKey'], changeReason: 'work step' });
    if (typeof p['owner'] === 'string') out.push({ ...base, stateKey: 'currentWorkOwner', value: p['owner'], changeReason: 'work owner' });
    if (typeof p['nextAction'] === 'string') out.push({ ...base, stateKey: 'nextWorkAction', value: p['nextAction'], changeReason: 'next action' });
    return out;
  },
};

// Campaign — reacts to campaign status changes.
const campaign: ActiveStateEvaluator = {
  eventType: 'CAMPAIGN_STATUS_CHANGED',
  ruleVersion: 'state.campaign.v1',
  domains: ['CAMPAIGN'],
  evaluate({ event }: StateEvaluatorInput): ProposedStateChange[] {
    const v = this.ruleVersion;
    const p = event.payload;
    const out: ProposedStateChange[] = [];
    const base = {
      domain: 'CAMPAIGN' as const,
      valueType: 'STRING' as const,
      confidence: 1.0,
      permittedPurposes: ['OPERATIONS'] as ProposedStateChange['permittedPurposes'],
      sensitivity: 'INTERNAL' as const,
      scope: 'OPERATIONAL' as const,
      decayModel: 'NONE' as const,
      ruleVersion: v,
      evidencePredicates: ['observed.campaign.status'],
    };
    if (typeof p['status'] === 'string') out.push({ ...base, stateKey: 'currentStatus', value: p['status'], changeReason: 'status change' });
    if (typeof p['revenueDirection'] === 'string') out.push({ ...base, stateKey: 'recentRevenueDirection', value: p['revenueDirection'], changeReason: 'revenue direction' });
    if (typeof p['callDirection'] === 'string') out.push({ ...base, stateKey: 'recentCallDirection', value: p['callDirection'], changeReason: 'call direction' });
    if (typeof p['attentionLevel'] === 'string') out.push({ ...base, stateKey: 'operationalAttentionLevel', value: p['attentionLevel'], changeReason: 'attention level' });
    return out;
  },
};

const REGISTRY: Map<MemoryEventType, ActiveStateEvaluator> = new Map(
  [
    commerce,
    commerceFor('PRODUCT_VIEWED'),
    commerceFor('SEARCH_PERFORMED'),
    commerceFor('PAGE_VIEWED'),
    communication,
    work,
    campaign,
  ].map((e) => [e.eventType, e]),
);

export const ActiveStateEvaluatorRegistry = {
  get(eventType: MemoryEventType): ActiveStateEvaluator | undefined {
    return REGISTRY.get(eventType);
  },
  /** Deterministic: returns [] when no evaluator is registered. Never throws. */
  evaluate(input: StateEvaluatorInput): ProposedStateChange[] {
    const evaluator = REGISTRY.get(input.event.eventType);
    if (!evaluator) return [];
    return evaluator.evaluate(input);
  },
};

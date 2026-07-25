// Stage 6 — KnowledgeEvaluatorRegistry (PURE).
//
// Maps event types to deterministic knowledge evaluators. Each evaluator
// declares which predicates it may write, its assertion class, a fixed
// confidence (the "confidence method" is a documented constant per rule — NO
// LLM, no inference beyond what the rule states), and an expiration. It cites
// its source event at persist time (the processor attaches sourceEventId) and
// versions its rule.
//
// Implemented event types (Increment 2 scope): PRODUCT_CLICKED, PAGE_VIEWED,
// SEARCH_PERFORMED, FORM_SUBMITTED, CONSENT_CHANGED, WORK_STEP_COMPLETED,
// CAMPAIGN_STATUS_CHANGED. Any other event type yields no assertions.

import type { MemoryEventType } from '@prisma/client';
import type { EvaluatorEvent, KnowledgeEvaluator, ProposedAssertion } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

function str(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}
function bool(payload: Record<string, unknown>, key: string): boolean | null {
  const v = payload[key];
  return typeof v === 'boolean' ? v : null;
}

// A small builder to keep each assertion's governance defaults consistent.
function observed(
  predicate: string,
  value: unknown,
  confidence: number,
  ruleVersion: string,
  purposes: ProposedAssertion['permittedPurposes'],
  ttlMs: number | null = DAY_MS,
): ProposedAssertion {
  return {
    predicate,
    value,
    valueType: 'STRING',
    assertionClass: 'OBSERVED',
    confidence,
    permittedPurposes: purposes,
    sensitivity: 'INTERNAL',
    scope: 'INDIVIDUAL',
    ttlMs,
    ruleVersion,
  };
}

const productClicked: KnowledgeEvaluator = {
  eventType: 'PRODUCT_CLICKED',
  ruleVersion: 'knowledge.product_clicked.v1',
  declaredPredicates: [
    'observedInterest.product',
    'observedInterest.category',
    'observedInterest.attribute.color',
  ],
  evaluate(ev: EvaluatorEvent): ProposedAssertion[] {
    const v = this.ruleVersion;
    const out: ProposedAssertion[] = [];
    const name = str(ev.payload, 'name') ?? str(ev.payload, 'product');
    const category = str(ev.payload, 'category');
    const color = str(ev.payload, 'color');
    if (name) out.push(observed('observedInterest.product', name, 0.6, v, ['PERSONALIZATION']));
    if (category) out.push(observed('observedInterest.category', category, 0.55, v, ['PERSONALIZATION']));
    if (color) out.push(observed('observedInterest.attribute.color', color, 0.5, v, ['PERSONALIZATION']));
    return out;
  },
};

const pageViewed: KnowledgeEvaluator = {
  eventType: 'PAGE_VIEWED',
  ruleVersion: 'knowledge.page_viewed.v1',
  declaredPredicates: ['observedInterest.topic', 'observedInterest.category'],
  evaluate(ev: EvaluatorEvent): ProposedAssertion[] {
    const v = this.ruleVersion;
    const out: ProposedAssertion[] = [];
    const topic = str(ev.payload, 'topic');
    const category = str(ev.payload, 'category');
    if (topic) out.push(observed('observedInterest.topic', topic, 0.4, v, ['PERSONALIZATION']));
    if (category) out.push(observed('observedInterest.category', category, 0.45, v, ['PERSONALIZATION']));
    return out;
  },
};

const searchPerformed: KnowledgeEvaluator = {
  eventType: 'SEARCH_PERFORMED',
  ruleVersion: 'knowledge.search_performed.v1',
  declaredPredicates: ['observedInterest.searchTerm'],
  evaluate(ev: EvaluatorEvent): ProposedAssertion[] {
    const term = str(ev.payload, 'query') ?? str(ev.payload, 'term');
    if (!term) return [];
    return [observed('observedInterest.searchTerm', term, 0.5, this.ruleVersion, ['PERSONALIZATION'])];
  },
};

const formSubmitted: KnowledgeEvaluator = {
  eventType: 'FORM_SUBMITTED',
  ruleVersion: 'knowledge.form_submitted.v1',
  declaredPredicates: ['declared.formType', 'declared.contactProvided'],
  evaluate(ev: EvaluatorEvent): ProposedAssertion[] {
    // Form fields are DECLARED (the person stated them), high confidence, no TTL.
    const out: ProposedAssertion[] = [];
    const formType = str(ev.payload, 'formType') ?? 'unknown';
    out.push({
      predicate: 'declared.formType',
      value: formType,
      valueType: 'STRING',
      assertionClass: 'DECLARED',
      confidence: 0.95,
      permittedPurposes: ['SERVICE_DELIVERY', 'PERSONALIZATION'],
      sensitivity: 'CONFIDENTIAL',
      scope: 'INDIVIDUAL',
      ttlMs: null,
      ruleVersion: this.ruleVersion,
    });
    out.push({
      predicate: 'declared.contactProvided',
      value: true,
      valueType: 'BOOLEAN',
      assertionClass: 'DECLARED',
      confidence: 0.95,
      permittedPurposes: ['SERVICE_DELIVERY'],
      sensitivity: 'CONFIDENTIAL',
      scope: 'INDIVIDUAL',
      ttlMs: null,
      ruleVersion: this.ruleVersion,
    });
    return out;
  },
};

const consentChanged: KnowledgeEvaluator = {
  eventType: 'CONSENT_CHANGED',
  ruleVersion: 'knowledge.consent_changed.v1',
  declaredPredicates: ['consent.sms', 'consent.email'],
  evaluate(ev: EvaluatorEvent): ProposedAssertion[] {
    const channel = str(ev.payload, 'channel'); // 'sms' | 'email'
    const granted = bool(ev.payload, 'granted');
    if (!channel || granted === null) return [];
    return [
      {
        predicate: `consent.${channel.toLowerCase()}`,
        value: granted ? 'GRANTED' : 'REVOKED',
        valueType: 'STRING',
        assertionClass: 'DECLARED',
        confidence: 1.0,
        permittedPurposes: ['SERVICE_DELIVERY'],
        sensitivity: 'CONFIDENTIAL',
        scope: 'INDIVIDUAL',
        ttlMs: null,
        ruleVersion: this.ruleVersion,
      },
    ];
  },
};

const workStepCompleted: KnowledgeEvaluator = {
  eventType: 'WORK_STEP_COMPLETED',
  ruleVersion: 'knowledge.work_step_completed.v1',
  declaredPredicates: ['observed.work.lastCompletedStep'],
  evaluate(ev: EvaluatorEvent): ProposedAssertion[] {
    const step = str(ev.payload, 'stepKey');
    if (!step) return [];
    return [observed('observed.work.lastCompletedStep', step, 1.0, this.ruleVersion, ['OPERATIONS'], null)];
  },
};

const campaignStatusChanged: KnowledgeEvaluator = {
  eventType: 'CAMPAIGN_STATUS_CHANGED',
  ruleVersion: 'knowledge.campaign_status_changed.v1',
  declaredPredicates: ['observed.campaign.status'],
  evaluate(ev: EvaluatorEvent): ProposedAssertion[] {
    const status = str(ev.payload, 'status');
    if (!status) return [];
    return [observed('observed.campaign.status', status, 1.0, this.ruleVersion, ['OPERATIONS'], null)];
  },
};

const REGISTRY: Map<MemoryEventType, KnowledgeEvaluator> = new Map(
  [
    productClicked,
    pageViewed,
    searchPerformed,
    formSubmitted,
    consentChanged,
    workStepCompleted,
    campaignStatusChanged,
  ].map((e) => [e.eventType, e]),
);

export const KnowledgeEvaluatorRegistry = {
  get(eventType: MemoryEventType): KnowledgeEvaluator | undefined {
    return REGISTRY.get(eventType);
  },
  /** Deterministic: returns [] when no evaluator is registered. Never throws. */
  evaluate(event: EvaluatorEvent): ProposedAssertion[] {
    const evaluator = REGISTRY.get(event.eventType);
    if (!evaluator) return [];
    return evaluator.evaluate(event);
  },
  eventTypes(): MemoryEventType[] {
    return [...REGISTRY.keys()];
  },
};

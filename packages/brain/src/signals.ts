// @emgloop/brain — first-class Signal Registry.
//
// Sprint 12: promote Signals to a first-class registry. A Signal definition now
// carries the full metadata the platform needs to reason about it: type,
// confidence, evidence, timestamp, expiration/decay, priority, owning
// organization, allowed uses, source provider, and the events that support it.
//
// This is the ARCHITECTURE / catalog. The deterministic enrichment engine that
// actually derives signals from events continues to live in
// @emgloop/database (services/signal-registry.ts) and is unchanged by Sprint 12.
// This registry is the contract future detectors and the database engine align to.

import type { Confidence, Evidence, Lifespan, Priority, Visibility } from './types';

/** High-level signal category. Mirrors the platform SignalType vocabulary while
 *  staying decoupled from @prisma/client so the Brain package has no DB dep. */
export type BrainSignalType =
  | 'INTENT'
  | 'SENTIMENT'
  | 'CHURN_RISK'
  | 'LIFECYCLE'
  | 'VALUE'
  | 'PREFERENCE'
  | 'CUSTOM';

/** How a signal is permitted to be used. Enforced by the Trust layer. */
export type SignalUse =
  | 'routing'
  | 'recommendation'
  | 'workflow_trigger'
  | 'analytics'
  | 'personalization'
  | 'revenue_attribution';

/** A first-class signal DEFINITION (catalog entry). */
export interface BrainSignalDefinition {
  key: string;
  type: BrainSignalType;
  label: string;
  description: string;
  /** Default priority when this signal is asserted. */
  priority: Priority;
  /** Default confidence floor for deterministic detection. */
  baseConfidence: Confidence;
  /** Default lifespan (expiry/decay) for instances of this signal. */
  defaultLifespan?: Lifespan;
  /** Default visibility for instances (private to tenant unless generalized). */
  defaultVisibility: Visibility;
  /** Uses this signal is allowed to drive. */
  allowedUses: SignalUse[];
  /** Providers that can legitimately source this signal. '*' = any. */
  sourceProviders: string[];
  /** Loop event types that can support/trigger this signal. */
  supportingEvents: string[];
}

/** A concrete signal INSTANCE asserted about a customer/org. */
export interface BrainSignalInstance {
  key: string;
  type: BrainSignalType;
  organizationId: string;
  subjectId: string; // customer or org id
  confidence: Confidence;
  priority: Priority;
  visibility: Visibility;
  evidence: Evidence[];
  observedAt: Date;
  lifespan?: Lifespan;
  sourceProvider?: string;
  valueString?: string;
  valueNumber?: number;
}

const THIRTY_DAYS = 30 * 24 * 60 * 60;
const NINETY_DAYS = 90 * 24 * 60 * 60;

function def(d: BrainSignalDefinition): BrainSignalDefinition {
  return d;
}

/** Production-ready signal catalog required by Sprint 12. Deterministic only. */
export const BRAIN_SIGNAL_REGISTRY: Record<string, BrainSignalDefinition> = {
  homeowner: def({
    key: 'homeowner',
    type: 'CUSTOM',
    label: 'Homeowner',
    description: 'Contact context indicates the person owns a home.',
    priority: 'normal',
    baseConfidence: 0.5,
    defaultVisibility: 'private',
    allowedUses: ['routing', 'recommendation', 'personalization'],
    sourceProviders: ['callgrid', 'ga4', '*'],
    supportingEvents: ['call.inbound', 'call.answered', 'web.form_submit'],
  }),
  pet_owner: def({
    key: 'pet_owner',
    type: 'CUSTOM',
    label: 'Pet Owner',
    description: 'Context references pets or pet-related services.',
    priority: 'normal',
    baseConfidence: 0.5,
    defaultVisibility: 'private',
    allowedUses: ['routing', 'recommendation', 'personalization'],
    sourceProviders: ['*'],
    supportingEvents: ['call.inbound', 'web.form_submit', 'sms.inbound'],
  }),
  emergency_intent: def({
    key: 'emergency_intent',
    type: 'INTENT',
    label: 'Emergency Intent',
    description: 'Language or context implies an urgent / emergency need.',
    priority: 'critical',
    baseConfidence: 0.8,
    defaultLifespan: { decayHalfLifeSeconds: THIRTY_DAYS },
    defaultVisibility: 'private',
    allowedUses: ['routing', 'recommendation', 'workflow_trigger'],
    sourceProviders: ['callgrid', '*'],
    supportingEvents: ['call.inbound', 'call.missed', 'sms.inbound'],
  }),
  business_owner: def({
    key: 'business_owner',
    type: 'CUSTOM',
    label: 'Business Owner',
    description: 'Contact represents or operates a business.',
    priority: 'high',
    baseConfidence: 0.5,
    defaultVisibility: 'private',
    allowedUses: ['routing', 'recommendation', 'revenue_attribution'],
    sourceProviders: ['*'],
    supportingEvents: ['call.inbound', 'web.form_submit'],
  }),
  creator: def({
    key: 'creator',
    type: 'CUSTOM',
    label: 'Creator',
    description: 'Contact is a content creator / influencer.',
    priority: 'normal',
    baseConfidence: 0.5,
    defaultVisibility: 'private',
    allowedUses: ['routing', 'recommendation'],
    sourceProviders: ['*'],
    supportingEvents: ['web.form_submit'],
  }),
  caregiver: def({
    key: 'caregiver',
    type: 'CUSTOM',
    label: 'Caregiver',
    description: 'Contact is acting on behalf of someone they care for.',
    priority: 'high',
    baseConfidence: 0.5,
    defaultVisibility: 'private',
    allowedUses: ['routing', 'recommendation', 'personalization'],
    sourceProviders: ['*'],
    supportingEvents: ['call.inbound', 'web.form_submit'],
  }),
  wedding_planning: def({
    key: 'wedding_planning',
    type: 'INTENT',
    label: 'Wedding Planning',
    description: 'Context references wedding or marriage planning.',
    priority: 'normal',
    baseConfidence: 0.6,
    defaultLifespan: { decayHalfLifeSeconds: NINETY_DAYS },
    defaultVisibility: 'private',
    allowedUses: ['recommendation', 'personalization'],
    sourceProviders: ['*'],
    supportingEvents: ['web.form_submit', 'call.inbound'],
  }),
  insurance_shopper: def({
    key: 'insurance_shopper',
    type: 'INTENT',
    label: 'Insurance Shopper',
    description: 'Context indicates shopping for insurance.',
    priority: 'normal',
    baseConfidence: 0.6,
    defaultVisibility: 'private',
    allowedUses: ['recommendation', 'revenue_attribution'],
    sourceProviders: ['*'],
    supportingEvents: ['web.form_submit', 'call.inbound'],
  }),
  hvac_need: def({
    key: 'hvac_need',
    type: 'INTENT',
    label: 'HVAC Need',
    description: 'Customer needs HVAC repair, install, or maintenance.',
    priority: 'high',
    baseConfidence: 0.6,
    defaultVisibility: 'private',
    allowedUses: ['routing', 'recommendation', 'workflow_trigger'],
    sourceProviders: ['callgrid', '*'],
    supportingEvents: ['call.inbound', 'web.form_submit'],
  }),
  high_value_lead: def({
    key: 'high_value_lead',
    type: 'VALUE',
    label: 'High Value Lead',
    description: 'Lead exhibits high expected value (intent + service fit).',
    priority: 'high',
    baseConfidence: 0.6,
    defaultVisibility: 'private',
    allowedUses: ['routing', 'recommendation', 'revenue_attribution'],
    sourceProviders: ['*'],
    supportingEvents: ['call.inbound', 'web.form_submit'],
  }),
  repeat_customer: def({
    key: 'repeat_customer',
    type: 'LIFECYCLE',
    label: 'Repeat Customer',
    description: 'Contact has prior interactions/bookings with the organization.',
    priority: 'high',
    baseConfidence: 0.9,
    defaultVisibility: 'private',
    allowedUses: ['routing', 'recommendation', 'personalization'],
    sourceProviders: ['*'],
    supportingEvents: ['crm.booking_created', 'call.inbound'],
  }),
  revenue_opportunity: def({
    key: 'revenue_opportunity',
    type: 'VALUE',
    label: 'Revenue Opportunity',
    description: 'Signal that an interaction could convert to revenue.',
    priority: 'high',
    baseConfidence: 0.6,
    defaultVisibility: 'private',
    allowedUses: ['recommendation', 'revenue_attribution'],
    sourceProviders: ['*'],
    supportingEvents: ['call.inbound', 'web.goal_conversion', 'payment.initiated'],
  }),
};

/** Look up a signal definition by key. */
export function getSignalDefinition(key: string): BrainSignalDefinition | undefined {
  return BRAIN_SIGNAL_REGISTRY[key];
}

/** All defined signal keys. */
export function listSignalKeys(): string[] {
  return Object.keys(BRAIN_SIGNAL_REGISTRY);
}

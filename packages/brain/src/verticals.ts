// @emgloop/brain — Vertical Brain definitions.
//
// Sprint 12: every vertical shares the SAME infrastructure (pipeline, identity,
// memory, signals, recommendations, trust) but specializes its knowledge and the
// signals it prioritizes. A Vertical Brain is a thin configuration over the
// shared Brain core — not a fork. This file defines the config contract and the
// eight launch verticals.

/** Identifiers for the supported vertical Brains. */
export type VerticalBrainId =
  | 'care'
  | 'pets'
  | 'marriage'
  | 'services'
  | 'homes'
  | 'creator'
  | 'business'
  | 'revenue';

/** A vertical's specialization over the shared Brain core. */
export interface VerticalBrainDefinition {
  id: VerticalBrainId;
  label: string;
  description: string;
  /** Signal keys this vertical prioritizes (must exist in the Signal Registry). */
  prioritySignals: string[];
  /** Knowledge topics this vertical draws on. */
  knowledgeTopics: string[];
  /** Default industries that map to this vertical. */
  industries: string[];
}

function v(d: VerticalBrainDefinition): VerticalBrainDefinition {
  return d;
}

/** The launch set of vertical Brains. All share the core infrastructure. */
export const VERTICAL_BRAINS: Record<VerticalBrainId, VerticalBrainDefinition> = {
  care: v({
    id: 'care',
    label: 'Care Brain',
    description: 'Caregiving and personal/home care services.',
    prioritySignals: ['caregiver', 'emergency_intent', 'repeat_customer'],
    knowledgeTopics: ['care_services', 'scheduling', 'safety'],
    industries: ['medical', 'home_services'],
  }),
  pets: v({
    id: 'pets',
    label: 'Pets Brain',
    description: 'Pet care, grooming, veterinary and related services.',
    prioritySignals: ['pet_owner', 'repeat_customer', 'high_value_lead'],
    knowledgeTopics: ['pet_care', 'grooming', 'veterinary'],
    industries: ['generic'],
  }),
  marriage: v({
    id: 'marriage',
    label: 'Marriage Brain',
    description: 'Wedding and marriage planning services.',
    prioritySignals: ['wedding_planning', 'high_value_lead', 'revenue_opportunity'],
    knowledgeTopics: ['weddings', 'events', 'vendors'],
    industries: ['generic'],
  }),
  services: v({
    id: 'services',
    label: 'Services Brain',
    description: 'General local/home services (the ServicesInMyCity vertical).',
    prioritySignals: ['hvac_need', 'emergency_intent', 'homeowner', 'high_value_lead'],
    knowledgeTopics: ['home_services', 'dispatch', 'estimates'],
    industries: ['home_services', 'automotive'],
  }),
  homes: v({
    id: 'homes',
    label: 'Homes Brain',
    description: 'Real estate, home buying/selling and homeownership.',
    prioritySignals: ['homeowner', 'high_value_lead', 'revenue_opportunity'],
    knowledgeTopics: ['real_estate', 'mortgage', 'home_ownership'],
    industries: ['generic'],
  }),
  creator: v({
    id: 'creator',
    label: 'Creator Brain',
    description: 'Content creators and creator-led commerce.',
    prioritySignals: ['creator', 'revenue_opportunity', 'high_value_lead'],
    knowledgeTopics: ['creators', 'monetization', 'audience'],
    industries: ['generic'],
  }),
  business: v({
    id: 'business',
    label: 'Business Brain',
    description: 'B2B and small-business operations.',
    prioritySignals: ['business_owner', 'high_value_lead', 'repeat_customer'],
    knowledgeTopics: ['b2b', 'operations', 'growth'],
    industries: ['law_firm', 'generic'],
  }),
  revenue: v({
    id: 'revenue',
    label: 'Revenue Brain',
    description: 'Cross-vertical revenue intelligence and attribution.',
    prioritySignals: ['revenue_opportunity', 'high_value_lead', 'repeat_customer'],
    knowledgeTopics: ['revenue', 'attribution', 'pricing'],
    industries: ['generic'],
  }),
};

/** Look up a vertical Brain definition by id. */
export function getVerticalBrain(id: VerticalBrainId): VerticalBrainDefinition {
  return VERTICAL_BRAINS[id];
}
// @emgloop/brain — Vertical Brain definitions.
//
// Sprint 12: every vertical shares the SAME infrastructure (pipeline, identity,
// memory, signals, recommendations, trust) but specializes its knowledge and the
// signals it prioritizes. A Vertical Brain is a thin configuration over the
// shared Brain core — not a fork. This file defines the config contract and the
// eight launch verticals.

/** Identifiers for the supported vertical Brains. */
export type VerticalBrainId =
  | 'care'
  | 'pets'
  | 'marriage'
  | 'services'
  | 'homes'
  | 'creator'
  | 'business'
  | 'revenue';

/** A vertical's specialization over the shared Brain core. */
export interface VerticalBrainDefinition {
  id: VerticalBrainId;
  label: string;
  description: string;
  /** Signal keys this vertical prioritizes (must exist in the Signal Registry). */
  prioritySignals: string[];
  /** Knowledge topics this vertical draws on. */
  knowledgeTopics: string[];
  /** Default industries that map to this vertical. */
  industries: string[];
}

function v(d: VerticalBrainDefinition): VerticalBrainDefinition {
  return d;
}

/** The launch set of vertical Brains. All share the core infrastructure. */
export const VERTICAL_BRAINS: Record<VerticalBrainId, VerticalBrainDefinition> = {
  care: v({
    id: 'care',
    label: 'Care Brain',
    description: 'Caregiving and personal/home care services.',
    prioritySignals: ['caregiver', 'emergency_intent', 'repeat_customer'],
    knowledgeTopics: ['care_services', 'scheduling', 'safety'],
    industries: ['medical', 'home_services'],
  }),
  pets: v({
    id: 'pets',
    label: 'Pets Brain',
    description: 'Pet care, grooming, veterinary and related services.',
    prioritySignals: ['pet_owner', 'repeat_customer', 'high_value_lead'],
    knowledgeTopics: ['pet_care', 'grooming', 'veterinary'],
    industries: ['generic'],
  }),
  marriage: v({
    id: 'marriage',
    label: 'Marriage Brain',
    description: 'Wedding and marriage planning services.',
    prioritySignals: ['wedding_planning', 'high_value_lead', 'revenue_opportunity'],
    knowledgeTopics: ['weddings', 'events', 'vendors'],
    industries: ['generic'],
  }),
  services: v({
    id: 'services',
    label: 'Services Brain',
    description: 'General local/home services (the ServicesInMyCity vertical).',
    prioritySignals: ['hvac_need', 'emergency_intent', 'homeowner', 'high_value_lead'],
    knowledgeTopics: ['home_services', 'dispatch', 'estimates'],
    industries: ['home_services', 'automotive'],
  }),
  homes: v({
    id: 'homes',
    label: 'Homes Brain',
    description: 'Real estate, home buying/selling and homeownership.',
    prioritySignals: ['homeowner', 'high_value_lead', 'revenue_opportunity'],
    knowledgeTopics: ['real_estate', 'mortgage', 'home_ownership'],
    industries: ['generic'],
  }),
  creator: v({
    id: 'creator',
    label: 'Creator Brain',
    description: 'Content creators and creator-led commerce.',
    prioritySignals: ['creator', 'revenue_opportunity', 'high_value_lead'],
    knowledgeTopics: ['creators', 'monetization', 'audience'],
    industries: ['generic'],
  }),
  business: v({
    id: 'business',
    label: 'Business Brain',
    description: 'B2B and small-business operations.',
    prioritySignals: ['business_owner', 'high_value_lead', 'repeat_customer'],
    knowledgeTopics: ['b2b', 'operations', 'growth'],
    industries: ['law_firm', 'generic'],
  }),
  revenue: v({
    id: 'revenue',
    label: 'Revenue Brain',
    description: 'Cross-vertical revenue intelligence and attribution.',
    prioritySignals: ['revenue_opportunity', 'high_value_lead', 'repeat_customer'],
    knowledgeTopics: ['revenue', 'attribution', 'pricing'],
    industries: ['generic'],
  }),
};

/** Look up a vertical Brain definition by id. Returns undefined for unknown ids
 *  (strict index access), so callers handle the miss explicitly. */
export function getVerticalBrain(
  id: VerticalBrainId,
): VerticalBrainDefinition | undefined {
  return VERTICAL_BRAINS[id];
}

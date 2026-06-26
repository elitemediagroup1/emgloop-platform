// @emgloop/brain — Recommendation & Next Best Action.
//
// Sprint 12: promote Next Best Action into a platform service. Sprint 11 already
// ships a working rules-based NextBestActionService in @emgloop/database; this
// file defines the PLATFORM contract it (and future callers) conform to. Every
// recommendation is fully explainable: action, reason, supporting signals,
// confidence, priority, recommended human, recommended AI employee, suggested
// workflow, and suppressions. Rules-based only — no AI reasoning in Sprint 12.

import type { Confidence, Priority } from './types';

/** The catalog of recommendation actions the platform supports. */
export type NextBestActionKind =
  | 'assign_human'
  | 'assign_ai'
  | 'create_follow_up'
  | 'recommend_guide'
  | 'book_appointment'
  | 'escalate'
  | 'notify_dispatcher'
  | 'suppress_marketing'
  | 'recommend_product'
  | 'recommend_creator'
  | 'recommend_workflow'
  | 'recommend_channel'
  | 'operational_recommendation';

/** A single, fully-explained recommendation. */
export interface Recommendation {
  id?: string;
  organizationId: string;
  subjectId?: string; // customer/identity id
  action: NextBestActionKind;
  /** Human-readable justification. */
  reason: string;
  /** Signal keys that support this recommendation. */
  supportingSignals: string[];
  confidence: Confidence;
  priority: Priority;
  /** Suggested human assignee (user id), if applicable. */
  recommendedHuman?: string;
  /** Suggested AI Employee (id), if applicable. */
  recommendedAIEmployee?: string;
  /** Suggested workflow to run (id or name), if applicable. */
  suggestedWorkflow?: string;
  /** Actions explicitly suppressed by this recommendation (e.g. marketing). */
  suppressions: NextBestActionKind[];
}

/** Context passed to the recommendation engine for a single decision. */
export interface RecommendationContext {
  organizationId: string;
  subjectId?: string;
  /** Signal keys currently known about the subject. */
  signalKeys: string[];
  /** Canonical event type that triggered the decision. */
  eventType?: string;
  /** Channel of the triggering interaction. */
  channel?: string;
}

/** Result: an ordered list of recommendations (highest priority first). */
export interface RecommendationResult {
  recommendations: Recommendation[];
}

/** Platform contract for the Next Best Action engine. Deterministic in Sprint 12. */
export interface RecommendationEngine {
  recommend(context: RecommendationContext): Promise<RecommendationResult>;
}

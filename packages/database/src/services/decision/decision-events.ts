// Lifecycle change -> domain event.
//
// ONE event per lifecycle operation, published through the platform's single
// outbox. The Decision Engine knows nothing about who consumes them: no
// subscriber is named here, no delivery is attempted here, and adding a consumer
// never requires touching this file.

import type { OperationalObservationType } from '@prisma/client';

/**
 * The event a given observation announces.
 *
 * A total map rather than a lookup with a fallback: a new observation type must
 * force a deliberate decision about what the world gets told, and TypeScript's
 * exhaustiveness check is what makes that happen at compile time rather than in
 * production as a silently unpublished change.
 */
export const DECISION_EVENT_TYPE: Record<OperationalObservationType, string> = {
  SITUATION_DETECTED: 'DecisionCreated',
  SITUATION_RESIGHTED: 'DecisionObserved',
  REOPENED: 'DecisionReopened',
  REVIEWED: 'DecisionReviewed',
  ASSIGNED: 'DecisionAssigned',
  REASSIGNED: 'DecisionAssigned',
  UNASSIGNED: 'DecisionUnassigned',
  OWNER_CHANGED: 'DecisionOwnerChanged',
  PRIORITY_CHANGED: 'DecisionPriorityChanged',
  SEVERITY_CHANGED: 'DecisionSeverityChanged',
  EVIDENCE_ADDED: 'DecisionEvidenceAdded',
  WATCH_STARTED: 'DecisionWatched',
  WATCH_STOPPED: 'DecisionUnwatched',
  NOTE_ADDED: 'DecisionNoteAdded',
  CONTACT_ATTEMPTED: 'DecisionProgressRecorded',
  CONTACT_COMPLETED: 'DecisionProgressRecorded',
  AWAITING_RESPONSE: 'DecisionProgressRecorded',
  RESPONSE_RECEIVED: 'DecisionProgressRecorded',
  ESCALATED: 'DecisionEscalated',
  OUTCOME_RECORDED: 'DecisionOutcomeRecorded',
  RESOLVED: 'DecisionResolved',
  DISMISSED: 'DecisionClosed',
};

/**
 * The subscription routing key for a decision.
 *
 * Namespaced by producer so a subscriber can watch one producer's decisions
 * without matching every decision in the platform, and prefixed with `decision.`
 * so it can never collide with an active-state key.
 */
export function decisionStateKey(producer: string, recurrenceKey: string): string {
  return `decision.${producer}.${recurrenceKey}`;
}

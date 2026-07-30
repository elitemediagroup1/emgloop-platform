// The Decision Engine — the ONLY producer-facing surface.
//
// Producers import from here and nowhere else. Reaching past this barrel into a
// repository, or into Prisma, bypasses the transaction boundary, the projection
// maintenance and the outbox publication all at once — and each of those
// failures is silent. The engine is the boundary precisely so that a producer
// cannot half-record something.

export { DecisionEngine, createDecisionEngine } from './decision-engine';
export {
  DecisionEngineError,
  DecisionNotFoundError,
  InvalidDecisionInputError,
  InvalidTransitionError,
} from './decision-engine.errors';
export { DECISION_EVENT_TYPE, decisionStateKey } from './decision-events';
export type {
  DecisionActor,
  DecisionEvidenceInput,
  CreateDecisionInput,
  UpdateDecisionInput,
  DecisionActionInput,
  AssignInput,
  SetOwnerInput,
  CloseInput,
  RecordOutcomeInput,
  AddObservationInput,
  DecisionResult,
  DecisionView,
  DecisionTimelineEntry,
  ListDecisionsOptions,
} from './decision-engine.contracts';

// Typed failures from the Decision Engine.
//
// A producer must be able to tell "you asked for something impossible" from
// "the database is down", because the first is a bug in the producer and the
// second is an incident. Untyped Errors make every caller guess.

export class DecisionEngineError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'DecisionEngineError';
  }
}

/**
 * The decision does not exist IN THIS ORGANIZATION.
 *
 * Deliberately not distinguished from "exists in another organization": that
 * distinction is exactly what leaks the existence of other tenants' rows.
 */
export class DecisionNotFoundError extends DecisionEngineError {
  constructor(id: string) {
    super(`Decision ${id} not found`, 'DECISION_NOT_FOUND');
  }
}

/** The producer supplied something the contract does not allow. */
export class InvalidDecisionInputError extends DecisionEngineError {
  constructor(message: string) {
    super(message, 'INVALID_INPUT');
  }
}

/**
 * The lifecycle does not permit this move.
 *
 * Kept as a real error rather than a silent no-op: a producer that resolves an
 * already-resolved decision has a bug, and swallowing it hides the bug while
 * quietly appending a second closing observation.
 */
export class InvalidTransitionError extends DecisionEngineError {
  constructor(from: string, action: string) {
    super(`Cannot ${action} a decision that is ${from}`, 'INVALID_TRANSITION');
  }
}

// The Decision Engine's public contract.
//
// These are the types a PRODUCER sees. They deliberately expose no Prisma model
// and no repository: a producer describes what happened in its own terms and the
// engine decides what that means for storage, projection and publication.
//
// Nothing here names CallGrid, a buyer, a campaign, a call or revenue. If a type
// in this file could not be filled in by an Accounting or Website Intelligence
// producer, it is wrong.

import type {
  OperationalPriority,
  OperationalObservation,
  DecisionEvidence,
  OperationalPriorityState,
  OperationalOutcome,
  OperationalObservationType,
  OperationalActorType,
} from '@prisma/client';
import type { LifecycleHistory, PriorityState } from '@emgloop/shared';

/** Who is acting. Every lifecycle write is attributed. */
export interface DecisionActor {
  type: OperationalActorType;
  /** Required for HUMAN, null for SYSTEM. Enforced by the engine, not by types. */
  userId?: string | null;
  /** What performed the action: a producer name, or 'operator'. */
  source: string;
}

/** One piece of evidence, in producer-neutral terms. */
export interface DecisionEvidenceInput {
  source: string;
  metricKey: string;
  window?: string | null;
  ruleId?: string | null;
  ruleVersion?: string | null;
  formulaVersion?: string | null;
  calculationVersion?: string | null;
  producerVersion?: string | null;
  confidence?: number | null;
  rawValue?: number | null;
  normalizedValue?: number | null;
  derivedValue?: number | null;
  completeness?: number | null;
  entityType?: string | null;
  entityId?: string | null;
  entityName?: string | null;
  limitations?: string[];
  unknowns?: string[];
  payload?: Record<string, unknown>;
  /** When the evidence describes the world. Defaults to the operation's `now`. */
  observedAt?: Date;
}

/**
 * What a producer knows when it notices something worth deciding about.
 *
 * `recurrenceKey` and `detectionKey` are the two identities that make this
 * idempotent: the first says "this is the same situation as before", the second
 * says "this is the same analysis period as before". A producer that cannot
 * supply both cannot be trusted not to duplicate itself on every run.
 */
export interface CreateDecisionInput {
  producer: string;
  recurrenceKey: string;
  detectionKey: string;
  detectedAt: Date;
  title: string;
  summary?: string | null;
  /** Must be one of DECISION_SEVERITIES; the engine rejects anything else. */
  severity: string;
  priority?: string | null;
  confidence?: number | null;
  impactCents?: number | null;
  impactLabel?: string | null;
  sourceReference?: string | null;
  producerVersion?: string | null;
  /** The belief this was opened from. Recorded on a FIRST sighting only. */
  hypothesis?: {
    hypothesisType: string;
    title: string;
    summary?: string | null;
    confidence?: number | null;
    ruleVersion?: string | null;
    supportingWindowStart?: Date | null;
    supportingWindowEnd?: Date | null;
  };
  /** Evidence to attach on a first sighting. Appended, never replaced. */
  evidence?: DecisionEvidenceInput[];
  /** The opening snapshot, kept on the detection observation. */
  evidenceSnapshot?: Record<string, unknown>;
  /**
   * Identity, when the subject genuinely has one. Most decisions are about the
   * business rather than a person and leave this null; it is published onto the
   * outbox so identity-scoped subscribers can find the ones that do.
   */
  identityId?: string | null;
}

/** Fields a producer may revise on a decision it already opened. */
export interface UpdateDecisionInput {
  title?: string;
  summary?: string | null;
  severity?: string;
  priority?: string | null;
  confidence?: number | null;
  impactCents?: number | null;
  impactLabel?: string | null;
  reason?: string | null;
}

export interface DecisionActionInput {
  actor: DecisionActor;
  note?: string | null;
  reason?: string | null;
  /** When it happened in the world. Defaults to the operation's `now`. */
  occurredAt?: Date;
  /** Evidence cited by this action. */
  evidenceId?: string | null;
}

export interface AssignInput extends DecisionActionInput {
  /** The person who will do the work. Validated to belong to the organization. */
  assigneeUserId: string;
}

export interface SetOwnerInput extends DecisionActionInput {
  /** The person accountable for the outcome. */
  ownerUserId: string;
}

export interface CloseInput extends DecisionActionInput {
  outcome: OperationalOutcome;
  measuredEffectCents?: number | null;
  measuredEffectBasis?: string | null;
  /** Where work was created, when the outcome is CONVERTED_TO_WORK. */
  destination?: {
    system: string;
    type?: string | null;
    id?: string | null;
  };
}

export interface RecordOutcomeInput extends CloseInput {}

export interface AddObservationInput extends DecisionActionInput {
  observationType: OperationalObservationType;
  assignedToUserId?: string | null;
  outcome?: OperationalOutcome | null;
  measuredEffectCents?: number | null;
  measuredEffectBasis?: string | null;
  evidencePayload?: Record<string, unknown>;
  destination?: { system: string; type?: string | null; id?: string | null };
}

/** What every mutating operation returns. */
export interface DecisionResult {
  decision: OperationalPriority;
  /** The observation this operation appended, or null when it was a no-op. */
  observation: OperationalObservation | null;
  /** What actually happened, so a caller can report it honestly. */
  effect: 'CREATED' | 'RESIGHTED' | 'REOPENED' | 'UPDATED' | 'UNCHANGED';
  /** The event written to the outbox, when one was. */
  eventType: string | null;
}

/** The full read model. */
export interface DecisionView {
  decision: OperationalPriority;
  observations: OperationalObservation[];
  evidence: DecisionEvidence[];
  history: LifecycleHistory;
  currentState: PriorityState;
  ownerUserId: string | null;
  assigneeUserId: string | null;
}

/** One entry of the human-readable timeline. A projection, never a table. */
export interface DecisionTimelineEntry {
  id: string;
  sequence: number;
  observationType: OperationalObservationType;
  occurredAt: Date;
  recordedAt: Date;
  actorType: OperationalActorType;
  actorUserId: string | null;
  source: string;
  previousState: OperationalPriorityState | null;
  newState: OperationalPriorityState | null;
  reason: string | null;
  note: string | null;
  outcome: OperationalOutcome | null;
  measuredEffectCents: number | null;
  evidenceId: string | null;
  destination: { system: string | null; type: string | null; id: string | null } | null;
}

export interface ListDecisionsOptions {
  producer?: string;
  state?: OperationalPriorityState;
  states?: OperationalPriorityState[];
  ownerUserId?: string;
  assigneeUserId?: string;
  take?: number;
}

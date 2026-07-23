// Loop Cognitive Architecture — pipeline types (Increment 2).
//
// The contracts shared across the processor and its PURE evaluators. Evaluators
// (governance, knowledge, active-state) take these plain inputs and return plain
// proposals; they perform NO I/O and never touch Prisma. The processor is the
// only component that persists, and it does so exclusively through the
// Increment 1 repositories.

import type {
  MemoryEventType,
  CognitiveEntityType,
  IdentityRoleType,
  IdentityEvidenceType,
  CognitiveValueType,
  AssertionClass,
  ActiveStateDomain,
  DecayModel,
  DataPurpose,
  DataScope,
  DataSensitivity,
  ConsentBasis,
} from '@prisma/client';

/** A hint used to resolve/attach an identity. rawValue is hashed on persist. */
export interface EvidenceHint {
  evidenceType: IdentityEvidenceType;
  rawValue: string;
  verified?: boolean;
  consentBasis?: ConsentBasis;
  permittedPurposes?: DataPurpose[];
}

/** How a participating identity is described by the caller. Never a name-only match. */
export interface IdentityDescriptor {
  entityType: CognitiveEntityType;
  /** Precedence 1: an already-authenticated canonical identity id. */
  authenticatedIdentityId?: string;
  /** Precedence 5: a known pseudonymous key. */
  canonicalKey?: string;
  displayName?: string | null;
  /** Precedence 3: verified email/phone; Precedence 4: session continuity. */
  evidence?: EvidenceHint[];
  sessionId?: string;
  roleType?: IdentityRoleType;
}

/** The processor's input. organizationId is TRUSTED (server-derived), never client. */
export interface ProcessEventInput {
  organizationId: string;
  sourceSystem: string;
  sourceEventId: string;
  eventType: MemoryEventType;
  occurredAt: Date | string;
  channel?: string | null;
  actor?: IdentityDescriptor;
  subject?: IdentityDescriptor;
  object?: IdentityDescriptor;
  payload?: Record<string, unknown>;
  context?: Record<string, unknown>;
  consentContext?: { consentBasis?: ConsentBasis };
  requestedPurposes?: DataPurpose[];
  sensitivity?: DataSensitivity;
  aggregationEligibility?: boolean;
}

/** Output of normalization — a canonical, provider-agnostic event. */
export interface NormalizedEvent {
  organizationId: string;
  sourceSystem: string;
  sourceEventId: string;
  eventType: MemoryEventType;
  occurredAt: Date;
  channel: string | null;
  payload: Record<string, unknown>;
  context: Record<string, unknown>;
  sensitivity: DataSensitivity;
  consentBasis: ConsentBasis;
  requestedPurposes: DataPurpose[];
  aggregationEligibility: boolean;
}

/** The minimal, pure event shape evaluators reason over. */
export interface EvaluatorEvent {
  eventType: MemoryEventType;
  occurredAt: Date;
  channel: string | null;
  payload: Record<string, unknown>;
}

/** A knowledge assertion an evaluator proposes. TTL is relative to occurredAt. */
export interface ProposedAssertion {
  predicate: string;
  value: unknown;
  valueType: CognitiveValueType;
  assertionClass: AssertionClass;
  confidence: number;
  permittedPurposes: DataPurpose[];
  sensitivity: DataSensitivity;
  scope: DataScope;
  ttlMs?: number | null;
  ruleVersion: string;
}

export interface KnowledgeEvaluator {
  eventType: MemoryEventType;
  ruleVersion: string;
  /** The predicates this evaluator is allowed to write. */
  declaredPredicates: string[];
  evaluate(event: EvaluatorEvent): ProposedAssertion[];
}

/** An active-state change an evaluator proposes for ONE impacted state key. */
export interface ProposedStateChange {
  domain: ActiveStateDomain;
  stateKey: string;
  value: unknown;
  valueType: CognitiveValueType;
  confidence: number | null;
  permittedPurposes: DataPurpose[];
  sensitivity: DataSensitivity;
  scope: DataScope;
  decayModel: DecayModel;
  ttlMs?: number | null;
  ruleVersion: string;
  changeReason: string;
  /** Predicates whose persisted assertions become evidence for this change. */
  evidencePredicates: string[];
}

export interface StateEvaluatorInput {
  event: EvaluatorEvent;
  /** predicate -> value, from knowledge just derived this pass. */
  assertions: Record<string, unknown>;
}

export interface ActiveStateEvaluator {
  eventType: MemoryEventType;
  ruleVersion: string;
  domains: ActiveStateDomain[];
  evaluate(input: StateEvaluatorInput): ProposedStateChange[];
}

// ---- Governance ------------------------------------------------------------

export type GovernanceOutcome = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

export interface GovernanceDecision {
  outcome: GovernanceOutcome;
  reasons: string[];
  /** The subset of requested purposes actually permitted (empty on DENY). */
  allowedPurposes: DataPurpose[];
}

// ---- Processor result ------------------------------------------------------

export type ProcessStatus = 'processed' | 'duplicate' | 'denied' | 'failed';

export interface ProcessResult {
  status: ProcessStatus;
  /**
   * True when the event was DURABLY accepted (memory persisted; derivation may
   * be governed off). False ONLY when a stage failed before durable acceptance
   * — the provider must then retry. This is the contract returned to ingestion.
   */
  accepted: boolean;
  memoryEventId: string | null;
  subjectIdentityId: string | null;
  governance?: GovernanceDecision;
  stateChanged?: boolean;
  assertionsWritten?: number;
  failedStage?: string;
  errorCode?: string;
}

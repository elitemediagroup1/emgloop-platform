// Loop Cognitive Architecture — governed context response contract (Increment 3).
//
// These are TRANSPORT / DTO types: the explicit shapes CognitiveContextService
// returns to consumers. They intentionally do NOT import Prisma — the database
// layer maps rows into these. Consumers (decision subscribers today; an admin
// validation surface in Increment 4) depend on THIS contract, never on Prisma
// models, so persistence can change without breaking readers.
//
// Governance is deny-by-default: anything expired, revoked, suppressed, or not
// permitted for the requested purpose is OMITTED from the projection, and what
// was omitted is disclosed in `unknowns`. Stale-but-live state is never dropped
// silently — it is returned and LABELLED (`freshness: 'STALE'`).

export const COGNITIVE_CONTEXT_CONTRACT_VERSION = 'cognitive-context.v1';

/** Outcome of a governance evaluation. Mirrors GovernanceEvaluator. */
export type GovernanceOutcome = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

/**
 * Whether a returned active-state value is current as of query time. EXPIRED /
 * revoked / suppressed values are omitted entirely (never returned), so only
 * CURRENT and STALE appear on returned rows.
 */
export type ActiveStateFreshness = 'CURRENT' | 'STALE' | 'EXPIRED';

// Enum-valued fields are typed as `string` on purpose: this contract must stay
// Prisma-free and drift-proof. The values are the corresponding Prisma enum
// members (e.g. domain 'COMMERCE', purpose 'PERSONALIZATION').

export interface IdentityDTO {
  id: string;
  entityType: string;
  displayName: string | null;
  status: string;
}

export interface RoleDTO {
  roleType: string;
  status: string;
  effectiveFrom: string; // ISO
  effectiveTo: string | null;
}

export interface RelationshipDTO {
  id: string;
  /** Direction relative to the queried identity. */
  direction: 'FROM' | 'TO';
  otherIdentityId: string;
  relationshipType: string;
  status: string;
}

export interface ActiveStateDTO {
  id: string;
  domain: string;
  stateKey: string;
  valueType: string;
  value: unknown;
  confidence: number | null;
  status: string;
  freshness: ActiveStateFreshness;
  effectiveAt: string; // ISO
  lastEvaluatedAt: string; // ISO
  expiresAt: string | null;
  decayModel: string;
  ruleVersion: string | null;
  scope: string;
  sensitivity: string;
  permittedPurposes: string[];
}

export interface KnowledgeDTO {
  id: string;
  predicate: string;
  valueType: string;
  value: unknown;
  /** DECLARED / OBSERVED / INFERRED / PREDICTED / ORGANIZATIONAL — never collapsed. */
  assertionClass: string;
  status: string;
  confidence: number | null;
  effectiveFrom: string; // ISO
  sensitivity: string;
  permittedPurposes: string[];
}

/**
 * A SUMMARY of recent durable memory — counts and timing only. Raw event
 * payloads are never included here (they can be highly sensitive); a payload is
 * only ever surfaced through an explicitly-permitted, evidence-scoped path.
 */
export interface RecentMemorySummaryDTO {
  total: number;
  byType: Record<string, number>;
  lastEventAt: string | null; // ISO
  windowConsidered: number;
}

export interface PolicyDecisionDTO {
  requestedPurpose: string;
  channel: string | null;
  domain: string | null;
  outcome: GovernanceOutcome;
  allowedPurposes: string[];
  reasons: string[];
}

export interface EvidenceDTO {
  activeStateRecordId: string;
  memoryEventId: string | null;
  knowledgeAssertionId: string | null;
  relationshipId: string | null;
  weight: number | null;
  contribution: number | null;
  observedAt: string; // ISO
}

export interface FreshnessDTO {
  asOf: string; // ISO — query time
  staleThresholdMs: number;
  hasStale: boolean;
  omittedExpiredCount: number;
}

/**
 * Governed projection of everything currently known about one identity, scoped
 * to a mandatory purpose and the explicitly-requested domains.
 */
export interface IdentityContext {
  contractVersion: typeof COGNITIVE_CONTEXT_CONTRACT_VERSION;
  organizationId: string;
  requestedPurpose: string;
  channel: string | null;
  requestedDomains: string[];
  identity: IdentityDTO | null;
  roles: RoleDTO[];
  relationships: RelationshipDTO[];
  activeState: ActiveStateDTO[];
  relevantKnowledge: KnowledgeDTO[];
  recentMemorySummary: RecentMemorySummaryDTO;
  policyDecisions: PolicyDecisionDTO[];
  evidence: EvidenceDTO[];
  freshness: FreshnessDTO;
  /** What could not be determined or was deliberately omitted, stated plainly. */
  unknowns: string[];
}

export interface ExplanationEvidenceDTO {
  kind: 'MEMORY_EVENT' | 'KNOWLEDGE_ASSERTION' | 'RELATIONSHIP';
  refId: string;
  weight: number | null;
  contribution: number | null;
  observedAt: string; // ISO
}

export interface LastChangingEventDTO {
  memoryEventId: string;
  eventType: string;
  occurredAt: string; // ISO
  sourceSystem: string;
  /** The channel the source event arrived on, if any (e.g. 'sms', 'email'). */
  channel: string | null;
}

/**
 * A fully inspectable account of WHY one active-state record holds its value,
 * assembled ONLY from stored rows (state record + revision + evidence + source
 * events + assertions + relationships + policy result). No LLM, no invented
 * causation: evidence is described as "supported by", never "caused by".
 */
export interface ActiveStateExplanation {
  contractVersion: typeof COGNITIVE_CONTEXT_CONTRACT_VERSION;
  organizationId: string;
  found: boolean;
  identityId: string | null;
  domain: string | null;
  stateKey: string | null;
  currentValue: unknown;
  valueType: string | null;
  confidence: number | null;
  status: string | null;
  freshness: ActiveStateFreshness | null;
  effectiveAt: string | null;
  lastEvaluatedAt: string | null;
  lastChangedAt: string | null;
  expiresAt: string | null;
  decayModel: string | null;
  /** The calculation rule identifier (state record `calculationRule`). */
  ruleId: string | null;
  ruleVersion: string | null;
  scope: string | null;
  sensitivity: string | null;
  permittedPurposes: string[];
  governanceResult: GovernanceOutcome | null;
  governanceReasons: string[];
  supportingEvidence: ExplanationEvidenceDTO[];
  lastChangingEvent: LastChangingEventDTO | null;
  /** Plain-language, correlation-not-causation account, generated from rows only. */
  explanation: string;
  /** Gaps: missing evidence, no source event on file, denied purpose, etc. */
  unknowns: string[];
}

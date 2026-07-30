// The canonical Decision — the platform's contract for the Decision Center.
//
// ONE MODEL FOR EVERY PRODUCER. CallGrid Intelligence is the first producer to
// arrive; CRM, Accounting, Marketing, Website, Support, Compliance and Creator
// intelligence are expected to follow, and each of them must be a `producer`
// value rather than a new table, a new lifecycle or a new queue. This file is
// where that promise is written down precisely enough to be checked.
//
// WHY THIS FILE EXISTS RATHER THAN A DOCUMENT. `docs/EVENT_BUS.md` describes a
// system that was never built, and three other docs now cite it — a doc for
// unbuilt work is worse than no doc, because it gets quoted as though it were
// true. So the canonical model is declared here as types and data, and
// `DECISION_FIELDS` below marks every field either PERSISTED or RESERVED. A test
// in @emgloop/database walks that list against the real Prisma columns, so:
//
//   - a field claimed PERSISTED that has no column fails the build, and
//   - a field marked RESERVED that someone quietly added a column for fails too.
//
// The contract therefore cannot describe a system that does not exist. RESERVED
// means "named so producers agree what it will be called", NOT "available" — and
// nothing may read or write a RESERVED field until it is implemented and moved.

export const DECISION_CONTRACT_VERSION = 'decision.v1';

// --- Producers ---------------------------------------------------------------

/**
 * Who noticed. A plain string in the database on purpose, so a new intelligence
 * module is a value rather than a migration; this list is the registry of the
 * ones we have agreed on, not a constraint the column enforces.
 */
export const DECISION_PRODUCERS = [
  'CALLGRID',
  'CRM',
  'ACCOUNTING',
  'MARKETING',
  'WEBSITE',
  'SUPPORT',
  'COMPLIANCE',
  'CREATOR',
  'WORK_OS',
] as const;
export type DecisionProducer = (typeof DECISION_PRODUCERS)[number];

// --- Severity ----------------------------------------------------------------

/**
 * The one severity vocabulary, shared by every producer.
 *
 * The column is a String so a producer is not blocked by a migration, but the
 * words are NOT a producer's choice. A cross-producer queue has to rank an
 * accounting decision against a marketing one, and it cannot do that if one
 * module says CRITICAL and another says P1 — the queue would silently order them
 * alphabetically and nobody would notice for months.
 *
 * A producer whose native scale differs maps into this on the way in and says so
 * in its evidence snapshot. Mapping at the boundary is visible; a second
 * vocabulary in the shared column is not.
 */
export const DECISION_SEVERITIES = ['INFORMATIONAL', 'NOTABLE', 'HIGH', 'CRITICAL'] as const;
export type DecisionSeverity = (typeof DECISION_SEVERITIES)[number];

export const DECISION_SEVERITY_RANK: Record<DecisionSeverity, number> = {
  CRITICAL: 0, HIGH: 1, NOTABLE: 2, INFORMATIONAL: 3,
};

export function isDecisionSeverity(value: string): value is DecisionSeverity {
  return (DECISION_SEVERITIES as readonly string[]).includes(value);
}

// --- Impact ------------------------------------------------------------------

/**
 * What a decision's number MEASURES.
 *
 * Today the column is `impactCents`, which silently assumes every producer's
 * impact is money. That holds for CallGrid and Accounting and fails for Website
 * Intelligence (sessions), Support (breached SLAs) and Compliance (findings). The
 * unit is therefore RESERVED rather than pretended: until it exists, a producer
 * whose impact is not currency must leave the amount NULL and say what it is in
 * the label, rather than writing a count into a cents column where every other
 * surface will render it as dollars.
 */
export const DECISION_IMPACT_UNITS = ['CENTS', 'COUNT', 'HOURS', 'PERCENTAGE_POINTS'] as const;
export type DecisionImpactUnit = (typeof DECISION_IMPACT_UNITS)[number];

// --- Evidence ----------------------------------------------------------------
//
// The snapshot that makes "every conclusion points to evidence" true of the
// RECORD and not merely of the live analysis.
//
// The distinction matters more than it sounds. The engine recomputes findings on
// every request, so an open decision can always show its evidence — but a
// decision resolved six weeks ago, under a rule version that has since changed,
// cannot. Without a snapshot, the moment a threshold moves, every historical
// decision silently loses the reason it was ever raised, and the outcome data
// that Loop will use to judge its own recommendations becomes uninterpretable.

export interface DecisionEvidenceValue {
  /** The metric this row is about, in the producer's contract vocabulary. */
  metricKey: string;
  /** The provider report or canonical service the value came from. */
  source: string;
  /** Which period the value describes, in operator language. */
  window: string;
  entityType: string | null;
  entityId: string | null;
  entityName: string | null;
  /** As the provider expressed it. */
  rawValue: number | null;
  /** After normalization into our units. */
  normalizedValue: number | null;
  /** After our formula, when the metric is derived. */
  derivedValue: number | null;
  formula: string | null;
  formulaVersion: string | null;
  /** Fraction of the population that reported the value, when partial. */
  completeness: number | null;
}

/** One step of the reasoning, preserved as it was stated at the time. */
export interface DecisionClaim {
  statement: string;
  basis: string | null;
}

/**
 * Everything the producer knew when it opened the decision.
 *
 * Written once, into the `evidence` field of the SITUATION_DETECTED observation,
 * and never edited — it is part of an append-only log. Later sightings do not
 * rewrite it; if the picture changes materially, that is a new observation.
 */
export interface DecisionEvidenceSnapshot {
  contractVersion: string;
  producer: string;
  /** Which rules fired, and at which versions. The key to interpreting history. */
  rules: { ruleId: string; ruleVersion: string }[];
  /** The producer's own confidence, 0–1, when it expresses one. */
  confidence: number | null;
  /** How many underlying findings were merged into this decision. */
  observationCount: number;
  claims: DecisionClaim[];
  values: DecisionEvidenceValue[];
  /** What the producer said it could NOT determine. Never dropped. */
  limitations: string[];
  unknowns: string[];
  /**
   * Set when `values` was capped. Truncation is disclosed rather than silent —
   * a snapshot that quietly dropped half its evidence is worse than one that
   * admits it, because only the second can be audited.
   */
  truncated: { kept: number; total: number } | null;
}

/** Beyond this a snapshot is a liability rather than a record. */
export const MAX_EVIDENCE_VALUES = 24;
export const MAX_EVIDENCE_CLAIMS = 8;

/**
 * Build the snapshot, capping honestly.
 *
 * Pure: no clock, no I/O. The caps exist because a decision row is read on every
 * queue render and an unbounded JSON blob per row is how a fast page becomes a
 * slow one; the truncation notice exists because a silent cap would make the
 * evidence look complete when it is not.
 */
export function buildEvidenceSnapshot(input: {
  producer: string;
  rules: { ruleId: string; ruleVersion: string }[];
  confidence?: number | null;
  observationCount: number;
  claims: DecisionClaim[];
  values: DecisionEvidenceValue[];
  limitations: string[];
  unknowns: string[];
}): DecisionEvidenceSnapshot {
  const total = input.values.length;
  const kept = Math.min(total, MAX_EVIDENCE_VALUES);
  return {
    contractVersion: DECISION_CONTRACT_VERSION,
    producer: input.producer,
    // De-duplicated: one rule firing over four entities is one rule.
    rules: [...new Map(input.rules.map((r) => [`${r.ruleId}@${r.ruleVersion}`, r])).values()],
    confidence: input.confidence ?? null,
    observationCount: input.observationCount,
    claims: input.claims.slice(0, MAX_EVIDENCE_CLAIMS),
    values: input.values.slice(0, MAX_EVIDENCE_VALUES),
    limitations: [...new Set(input.limitations)],
    unknowns: [...new Set(input.unknowns)],
    truncated: total > kept ? { kept, total } : null,
  };
}

// --- The canonical field list ------------------------------------------------

export type FieldStatus = 'PERSISTED' | 'RESERVED';

export interface DecisionField {
  /** The canonical name. Where PERSISTED, this is the actual column name. */
  name: string;
  status: FieldStatus;
  /** Which table holds it (or would). */
  table: 'operational_priorities' | 'operational_observations' | 'decision_evidence';
  /** What it is, and — for RESERVED — what has to happen before it exists. */
  note: string;
}

/**
 * The canonical Decision, field by field.
 *
 * This is the list a new producer reads to know what it may rely on. It is also
 * the list the enforcement test walks, which is what stops it becoming fiction.
 */
export const DECISION_FIELDS: readonly DecisionField[] = [
  // --- Identity -------------------------------------------------------------
  { name: 'id', status: 'PERSISTED', table: 'operational_priorities', note: 'Surrogate key.' },
  { name: 'organizationId', status: 'PERSISTED', table: 'operational_priorities', note: 'Tenant. Always from the signed session, never from input.' },
  { name: 'sourceSystem', status: 'PERSISTED', table: 'operational_priorities', note: 'The producer. See DECISION_PRODUCERS.' },
  { name: 'recurrenceKey', status: 'PERSISTED', table: 'operational_priorities', note: 'Producer rule + entity, never a timestamp. Makes the same situation tomorrow the same row.' },
  { name: 'hypothesisId', status: 'PERSISTED', table: 'operational_priorities', note: 'The belief this was opened from (IntelligenceHypothesis). What Loop THOUGHT, as opposed to what the org DID.' },
  { name: 'sourceReference', status: 'PERSISTED', table: 'operational_priorities', note: "The producer's own handle for the subject — an invoice id, a page path. Opaque to the platform and never parsed here." },
  { name: 'producerVersion', status: 'PERSISTED', table: 'operational_priorities', note: "Which build of the producer opened this, so history stays interpretable after the producer's logic changes." },

  // --- Description ----------------------------------------------------------
  { name: 'title', status: 'PERSISTED', table: 'operational_priorities', note: 'One line, business language.' },
  { name: 'summary', status: 'PERSISTED', table: 'operational_priorities', note: 'What happened. Measured, no interpretation.' },
  { name: 'severity', status: 'PERSISTED', table: 'operational_priorities', note: 'DECISION_SEVERITIES. A producer maps its own scale into this at the boundary.' },
  { name: 'priority', status: 'PERSISTED', table: 'operational_priorities', note: 'Operator-settable urgency, independent of producer severity. A CRITICAL finding scheduled for next month is both.' },
  { name: 'confidence', status: 'PERSISTED', table: 'operational_priorities', note: "The producer's confidence, 0-1. Null when it does not express one — never defaulted, because a defaulted confidence is a claim." },

  // --- Impact ---------------------------------------------------------------
  { name: 'impactCents', status: 'PERSISTED', table: 'operational_priorities', note: 'Measured amount. NULL means unmeasured — never 0.' },
  { name: 'impactLabel', status: 'PERSISTED', table: 'operational_priorities', note: 'What the amount IS: exposure, decline, gap. Never "upside".' },
  { name: 'impactUnit', status: 'RESERVED', table: 'operational_priorities', note: 'DECISION_IMPACT_UNITS. Needs a column + migration. Until then a non-currency producer leaves the amount NULL rather than writing a count into a cents field.' },
  { name: 'costCents', status: 'RESERVED', table: 'operational_priorities', note: 'What acting COST, as against what it recovered. Needs a column. Not inferable from anything stored today.' },

  // --- Detection ------------------------------------------------------------
  { name: 'firstDetectedAt', status: 'PERSISTED', table: 'operational_priorities', note: 'First sighting.' },
  { name: 'lastDetectedAt', status: 'PERSISTED', table: 'operational_priorities', note: 'Most recent sighting. Moves forward only.' },
  { name: 'detectionCount', status: 'PERSISTED', table: 'operational_priorities', note: 'Distinct analysis periods that saw it.' },
  { name: 'detectionKey', status: 'PERSISTED', table: 'operational_observations', note: 'Analysis-period identity. Makes a sighting idempotent per period.' },

  // --- Lifecycle (a projection of the log, never set directly) --------------
  { name: 'state', status: 'PERSISTED', table: 'operational_priorities', note: 'Projection. NEEDS_REVIEW / ASSIGNED / WATCHING / RESOLVED / DISMISSED.' },
  { name: 'ownerUserId', status: 'PERSISTED', table: 'operational_priorities', note: 'Projection. ACCOUNTABILITY — who answers for the outcome. Changes rarely.' },
  { name: 'assigneeUserId', status: 'PERSISTED', table: 'operational_priorities', note: 'Projection. EXECUTION — who is working it now, or null. Changes often. Never derived from owner or from state.' },
  { name: 'stateChangedAt', status: 'PERSISTED', table: 'operational_priorities', note: 'Projection. When the lane last changed.' },
  { name: 'reopenCount', status: 'PERSISTED', table: 'operational_priorities', note: 'Projection. Resolutions that did not hold.' },
  { name: 'resolvedAt', status: 'PERSISTED', table: 'operational_priorities', note: 'Projection. Cleared on reopen.' },
  { name: 'outcome', status: 'PERSISTED', table: 'operational_priorities', note: 'Projection. How it ended, including whether Loop was wrong.' },
  { name: 'measuredEffectCents', status: 'PERSISTED', table: 'operational_priorities', note: 'Projection. Observed by a human; Loop never estimates it.' },
  { name: 'projectionVersion', status: 'PERSISTED', table: 'operational_priorities', note: 'Which reducer wrote the cache, so a changed reducer can be detected.' },

  // --- The log --------------------------------------------------------------
  { name: 'observationType', status: 'PERSISTED', table: 'operational_observations', note: 'The lifecycle vocabulary.' },
  { name: 'sequence', status: 'PERSISTED', table: 'operational_observations', note: 'Monotonic per decision. The ordering key for state.' },
  { name: 'occurredAt', status: 'PERSISTED', table: 'operational_observations', note: 'When it happened in the world.' },
  { name: 'recordedAt', status: 'PERSISTED', table: 'operational_observations', note: 'When Loop learned it.' },
  { name: 'actorType', status: 'PERSISTED', table: 'operational_observations', note: 'HUMAN or SYSTEM. There is no AI actor because there is no LLM.' },
  { name: 'actorUserId', status: 'PERSISTED', table: 'operational_observations', note: 'Who did it.' },
  { name: 'evidence', status: 'PERSISTED', table: 'operational_observations', note: 'DecisionEvidenceSnapshot on the opening observation. Why the record can still explain itself after a rule version changes.' },
  { name: 'note', status: 'PERSISTED', table: 'operational_observations', note: "The operator's own words about the moment." },
  { name: 'reason', status: 'PERSISTED', table: 'operational_observations', note: 'Why the transition happened. Belongs to the change; `note` belongs to the moment.' },
  { name: 'previousState', status: 'PERSISTED', table: 'operational_observations', note: 'The lane before this observation, when it moved one.' },
  { name: 'newState', status: 'PERSISTED', table: 'operational_observations', note: 'The lane after, so a timeline answers "what changed" without replaying the log.' },
  { name: 'destinationSystem', status: 'PERSISTED', table: 'operational_observations', note: 'Where a CONVERTED_TO_WORK outcome went. Generic: the engine records that work was created somewhere, never which product.' },
  { name: 'destinationType', status: 'PERSISTED', table: 'operational_observations', note: 'What kind of thing was created in the destination system.' },
  { name: 'destinationId', status: 'PERSISTED', table: 'operational_observations', note: 'Its id in that system. Opaque here.' },
  { name: 'evidenceId', status: 'PERSISTED', table: 'operational_observations', note: 'The evidence this observation cites, when it cites some.' },
  { name: 'decisionId', status: 'PERSISTED', table: 'operational_observations', note: 'Link to a CognitiveDecision when one evaluated this.' },

  // --- Evidence (immutable, append-only) ------------------------------------
  { name: 'source', status: 'PERSISTED', table: 'decision_evidence', note: 'Where the value came from: a provider report, a canonical service, a person.' },
  { name: 'metricKey', status: 'PERSISTED', table: 'decision_evidence', note: "What it measures, in the producer's contract vocabulary." },
  { name: 'ruleId', status: 'PERSISTED', table: 'decision_evidence', note: 'The rule that produced it.' },
  { name: 'ruleVersion', status: 'PERSISTED', table: 'decision_evidence', note: 'At which version — the key to interpreting evidence after a rule changes.' },
  { name: 'formulaVersion', status: 'PERSISTED', table: 'decision_evidence', note: 'Version of the formula behind a derived value.' },
  { name: 'calculationVersion', status: 'PERSISTED', table: 'decision_evidence', note: 'Version of the calculation that produced derivedValue.' },
  { name: 'producerVersion', status: 'PERSISTED', table: 'decision_evidence', note: 'Which build of the producer emitted this evidence.' },
  { name: 'rawValue', status: 'PERSISTED', table: 'decision_evidence', note: 'As the provider expressed it. Kept alongside the other two because an argument about a number is usually an argument about which one.' },
  { name: 'normalizedValue', status: 'PERSISTED', table: 'decision_evidence', note: 'After normalization into our units.' },
  { name: 'derivedValue', status: 'PERSISTED', table: 'decision_evidence', note: 'After our formula.' },
  { name: 'completeness', status: 'PERSISTED', table: 'decision_evidence', note: 'Fraction of the population that reported the value, when partial.' },
  { name: 'limitations', status: 'PERSISTED', table: 'decision_evidence', note: 'What this evidence cannot support, carried with it forever.' },
  { name: 'unknowns', status: 'PERSISTED', table: 'decision_evidence', note: 'What it leaves undetermined.' },
  { name: 'observedAt', status: 'PERSISTED', table: 'decision_evidence', note: 'When the evidence describes the world.' },

  // --- Reserved -------------------------------------------------------------
  { name: 'category', status: 'RESERVED', table: 'operational_priorities', note: 'Cross-producer grouping (revenue / risk / compliance / quality). Needs a column and, more importantly, a vocabulary agreed across producers — inventing one from CallGrid alone would bake in a marketplace shape.' },
  { name: 'tags', status: 'RESERVED', table: 'operational_priorities', note: 'Free-form operator labels. Needs a column; deliberately after category, so tags do not become a substitute for a missing taxonomy.' },
  { name: 'relatedDecisionIds', status: 'RESERVED', table: 'operational_priorities', note: 'The reasoning graph across decisions. It exists in-memory per analysis run and is not persisted; making it durable is a join table, not a column.' },
  { name: 'dueAt', status: 'RESERVED', table: 'operational_priorities', note: 'A promised-by date. Needs a column AND an answer to what happens when it passes — a date nothing acts on is decoration.' },
] as const;

export function decisionFields(status: FieldStatus): DecisionField[] {
  return DECISION_FIELDS.filter((f) => f.status === status);
}

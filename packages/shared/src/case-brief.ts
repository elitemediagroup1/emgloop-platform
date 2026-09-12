// What is this investigation, and how much of it does Loop actually know?
//
// A DERIVED VIEW, NOT A TRUTH LAYER. Every value in a CaseBriefView is assembled
// from state that already exists and stays authoritative where it is: the
// investigation and its append-only observation log in the Decision Center, its
// evidence in `decision_evidence`, and the Headline that opened it in Commercial
// Intelligence. Nothing here is persisted, cached or written back. If two of them
// ever disagree, they are the answer and this is the bug.
//
// PRODUCT VOCABULARY, WITHOUT RENAMING ANYTHING. Charlie and Lexi say Case,
// Evidence and Headline; the architecture says OperationalPriority,
// DecisionEvidence and HeadlineView, and it keeps saying them -- the Decision
// Center is producer-neutral platform machinery that several producers open
// threads in, and renaming it after one producer's product language would be the
// wrong direction of coupling. So this file translates at the boundary and
// exposes no Prisma model to a surface.
//
// WHAT IT DELIBERATELY DOES NOT CARRY. No Finding, no Recommendation, no action,
// no ranking, no expected impact, and no sentence Loop wrote about its own
// evidence. Those are later decisions, and a contract that carried empty slots
// for them would teach a surface to render something that will never arrive from
// this PR.
//
// THE LIFECYCLE VOCABULARY IS THE SHIPPED ONE. `PriorityState` is already
// readable -- NEEDS_REVIEW, ASSIGNED, WATCHING, RESOLVED, DISMISSED -- and a
// second product-facing mapping of it would be two vocabularies for one fact,
// which is how this repository got three workflow systems.

import type { EvidenceClass } from './evidence-class';
import type {
  LifecycleHistory,
  ObservationType,
  OperationalOutcome,
  PriorityState,
} from './operational-lifecycle';

/**
 * Who caused an observation.
 *
 * Mirrors the platform enum, and there is deliberately no AI member: there is no
 * LLM in this codebase, and a vocabulary that describes a capability the product
 * does not have is the same failure as a button that does nothing.
 */
export type CaseActorType = 'HUMAN' | 'SYSTEM';

// --- Origin -------------------------------------------------------------------

/**
 * Why this investigation exists, and what opened it.
 *
 * A DISCRIMINATED UNION rather than a nullable headline id, because "opened from
 * a Headline whose record we could not read" and "opened by a producer that is
 * not Commercial Intelligence" are different facts and a surface has to render
 * them differently.
 */
export type CaseOrigin =
  | {
      kind: 'HEADLINE';
      headlineId: string;
      /** Null when the Headline could not be resolved. `unresolvedReason` says why. */
      headline: CaseHeadlineLineage | null;
      unresolvedReason: string | null;
    }
  | {
      kind: 'PRODUCER';
      /** The producer that opened it, e.g. 'callgrid-intelligence'. */
      sourceSystem: string;
      /** The producer's own opaque handle. Never parsed. */
      sourceReference: string | null;
    };

/**
 * The Headline this investigation was opened from, re-read live.
 *
 * RE-READ, NOT SNAPSHOTTED. The Case stores only the Headline's id, so this is
 * resolved through the Headline's own organization-scoped read every time. That is
 * what makes lineage safe: a Headline the caller may not reach comes back null
 * rather than arriving through a Case that referenced it.
 */
export interface CaseHeadlineLineage {
  headlineId: string;
  /** Loop's own one-line description of the measured development. Display only. */
  statement: string;
  performanceObjectiveId: string;
  objectiveTitle: string | null;
  metric: string;
  metricLabel: string;
  /** True when the move ran against the objective's stated direction. */
  againstObjective: boolean;
  currentValue: number | null;
  priorValue: number | null;
  /** A fraction, not a percentage. Null when there was no non-zero baseline. */
  percentageChange: number | null;
  /** 0-1, or null where the metric has no coverage concept. */
  currentCoverage: number | null;
  comparisonBasis: string;
  currentWindowStart: string;
  currentWindowEnd: string;
  /** Set when a person has judged the Headline itself. Independent of the Case. */
  dismissedAt: string | null;
}

// --- Authorization ---------------------------------------------------------------

/**
 * The person who authorized this investigation, and when.
 *
 * FROM THE CASE'S OWN APPEND-ONLY LOG, which is authoritative for this question.
 * The platform-wide AuditLog carries a supplementary row and is never consulted
 * here: it has no per-case query, it is written outside the transaction that
 * records the observation, and one reachable path leaves it silent.
 */
export interface CaseAuthorization {
  userId: string;
  /** When the person decided. */
  at: string;
  /** When Loop recorded it. Equal to `at` for anything recorded live. */
  recordedAt: string;
  /** The authorizer's own words, when they left any. */
  note: string | null;
}

// --- Evidence ---------------------------------------------------------------------

/** One immutable piece of evidence, in product terms. */
export interface CaseEvidenceItem {
  id: string;
  /** Where the value came from: a producer, a canonical service, a person. */
  source: string;
  /**
   * HOW IT ARRIVED. Measured, or reported by a person.
   *
   * NOT A RANKING. It says nothing about whether to believe the evidence; what
   * it decides is which fields below mean anything, and whether the Stage 3 gate
   * may read it at all.
   */
  evidenceClass: EvidenceClass;
  /**
   * What a person reported, in their own words, exactly as they wrote it.
   *
   * NULL FOR MEASURED EVIDENCE, and never a summary. A surface may shorten it on
   * screen; the original has to remain readable, because what a person actually
   * said is the evidence.
   */
  statement: string | null;
  /** Who reported it. Null for anything a producer measured. */
  reportedByUserId: string | null;
  /**
   * What it measures, in the producer's contract vocabulary.
   *
   * NULL FOR A HUMAN REPORT, because a sentence is not necessarily about a
   * metric. There is deliberately no sentinel: a `HUMAN_REPORT` or `UNKNOWN`
   * metric key would be a referent nothing in the platform measures, and every
   * query grouping by metric would then have a fake member in it.
   */
  metricKey: string | null;
  /** Which period it describes, in operator language. Null when it names none. */
  window: string | null;
  /** After our formula. Null when the producer expressed no number. */
  value: number | null;
  /**
   * Fraction of the population that reported the value, 0-1.
   *
   * NULL IS NOT ONE. A null means the producer did not express completeness at
   * all, which is a different fact from "all of it reported", and a surface that
   * renders them the same way turns silence into a guarantee.
   */
  completeness: number | null;
  entityType: string | null;
  entityId: string | null;
  entityName: string | null;
  /** What this evidence CANNOT support. Travels with it forever. */
  limitations: string[];
  /** What it leaves undetermined. */
  unknowns: string[];
  /** Which rule produced it, at which version. */
  ruleId: string | null;
  ruleVersion: string | null;
  producerVersion: string | null;
  /** When the evidence describes the world. */
  observedAt: string;
}

/**
 * What this investigation does NOT know, kept apart from what it does.
 *
 * THREE DISTINCT SHAPES, NOT ONE EMPTY FIELD. A limitation is something the
 * evidence cannot support; an unknown is something it leaves open; incomplete
 * evidence is a population that only partly reported. Collapsing them would be
 * the empty state that reads as an all-clear.
 *
 * WHAT IS DELIBERATELY ABSENT: withheld, conflicted and not-applicable. Those are
 * Stage 3 measurement and fact-convergence states that live on measurements and
 * on `provider_fact_revisions`, and no Case carries one today. Inventing a
 * Case-level field for them would be a second uncertainty vocabulary.
 */
export interface CaseUncertainty {
  limitations: string[];
  unknowns: string[];
  /** Evidence rows whose population only partly reported. */
  incompleteEvidenceCount: number;
  /** Evidence rows that expressed no completeness at all. Not the same thing. */
  completenessUnstatedCount: number;
}

// --- The five questions -------------------------------------------------------------

export const CASE_DIMENSIONS = ['WHO', 'WHAT', 'WHEN', 'WHERE', 'WHY'] as const;
export type CaseDimension = (typeof CASE_DIMENSIONS)[number];

/**
 * Entity types that name a PARTY. Closed and explicit.
 *
 * An entity type outside both this list and the place list is not guessed into a
 * dimension -- it stays in WHAT, where the measurement it belongs to already is.
 */
export const CASE_PARTY_ENTITY_TYPES = [
  'buyer',
  'vendor',
  'source',
  'publisher',
  'customer',
  'contact',
  'user',
] as const;

/** Entity types that name a PLACE the condition exists in. Closed and explicit. */
export const CASE_PLACE_ENTITY_TYPES = [
  'campaign',
  'market',
  'channel',
  'system',
  'property',
  'business_unit',
  'vertical',
] as const;

/** One thing the investigation currently knows about a dimension. */
export interface CaseDimensionItem {
  /** Stable within the brief, so a surface can key on it. */
  key: string;
  label: string;
  /** Where this came from: an evidence row, or the case's own log. */
  derivedFrom: 'EVIDENCE' | 'TIMELINE' | 'CASE';
  /** The evidence row it came from, when it came from one. */
  evidenceId: string | null;
}

/**
 * The investigative organization of what is already known.
 *
 * DERIVED, NEVER PERSISTED, and derived only from evidence, entities and times
 * that already exist. Placement asserts RELEVANCE and nothing else.
 *
 * WHY IS THE ONE THAT MATTERS. Placing evidence under WHY means it is relevant to
 * answering why -- it does NOT mean it explains anything, and this PR infers no
 * causation at all. Nothing in the current contracts marks a piece of evidence as
 * relevant to explanation, so WHY is EMPTY and says so, rather than being filled
 * with the nearest available number dressed as a reason.
 */
export interface CaseFiveWs {
  who: CaseDimensionItem[];
  what: CaseDimensionItem[];
  when: CaseDimensionItem[];
  where: CaseDimensionItem[];
  why: CaseDimensionItem[];
  /**
   * Why a dimension is empty, when the emptiness is structural rather than
   * incidental. A surface should render this instead of an empty list.
   */
  unavailable: Partial<Record<CaseDimension, string>>;
}

/**
 * Why WHY is empty, in one sentence a person can read.
 *
 * Stated once, here, so every surface says the same thing and none of them
 * invents a friendlier version that implies Loop looked and found nothing.
 */
export const CASE_WHY_UNAVAILABLE =
  'Nothing recorded on this investigation is marked as relevant to explaining why. ' +
  'Loop does not infer causes, so this stays empty until evidence says otherwise.';

// --- Timeline -----------------------------------------------------------------------

/** One entry of the investigation's history. A projection, never a table. */
export interface CaseTimelineEntry {
  id: string;
  sequence: number;
  type: ObservationType;
  occurredAt: string;
  recordedAt: string;
  actorType: CaseActorType;
  actorUserId: string | null;
  source: string;
  reason: string | null;
  note: string | null;
  previousState: PriorityState | null;
  newState: PriorityState | null;
  outcome: OperationalOutcome | null;
}

// --- The brief ------------------------------------------------------------------------

export interface CaseBriefView {
  caseId: string;
  /** The shipped lifecycle vocabulary. Not a second, product-facing copy of it. */
  status: PriorityState;
  /** THE CLAIM. What Loop noticed, in one line. */
  title: string;
  /** WHY IT MATTERS. The objective this was measured against, when there is one. */
  subject: string | null;

  origin: CaseOrigin;
  authorization: CaseAuthorization | null;

  /** Accountability. Who answers for this reaching an outcome. */
  ownerUserId: string | null;
  /** Execution. Who is actively working it. Deliberately not the same question. */
  assigneeUserId: string | null;

  evidence: CaseEvidenceItem[];
  uncertainty: CaseUncertainty;
  fiveWs: CaseFiveWs;
  timeline: CaseTimelineEntry[];
  /** Detection, recurrence and elapsed times, from the shipped projection. */
  history: LifecycleHistory;

  /** How it ended, when it has. Null while open. */
  outcome: OperationalOutcome | null;
  measuredEffectCents: number | null;

  /** The producer that owns this thread, and its stable identity within it. */
  sourceSystem: string;
  recurrenceKey: string;
}

/** True when the investigation is still open. */
export function caseIsOpen(brief: Pick<CaseBriefView, 'status'>): boolean {
  return brief.status !== 'RESOLVED' && brief.status !== 'DISMISSED';
}

/** True when the brief carries an attributed human authorization. */
export function caseIsAuthorized(brief: Pick<CaseBriefView, 'authorization'>): boolean {
  return brief.authorization !== null;
}

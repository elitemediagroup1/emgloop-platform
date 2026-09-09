// What Loop concludes about an investigation, and what it is allowed to call
// established. THE AUTHORITY BOUNDARY, WITHOUT A GENERATOR BEHIND IT.
//
// A FINDING IS A CLAIM, NOT A FACT. It is the analytical conclusion drawn on a
// Case -- "SSDI's conversion rate fell because one buyer stopped settling on the
// day" -- and it is the first thing in this platform that is Loop's own sentence
// rather than a measurement. That is exactly why it needs a gate: a claim that
// can promote itself into truth is how a system starts lying confidently.
//
// TWO PRODUCT STATES, AND ONLY ONE OF THEM IS AUTONOMOUS.
//
//   DEVELOPING   Loop has a claim and is still assembling the evidence for it.
//                Anything may be DEVELOPING, including a claim a model wrote.
//   ESTABLISHED  The claim is backed. Reached in exactly two ways: a person
//                accepted it, or the deterministic Stage 3 gate proved the
//                measurement underneath it is eligible. There is no third way,
//                and no argument that produces one.
//
// ESTABLISHED IS NOT `ACCEPTED`. `IntelligenceHypothesis.status` already carries
// a hard invariant -- a hypothesis is only ever created PROPOSED, and acceptance
// demands an attributed human -- and this file does not touch it. `ACCEPTED`
// remains the human act it has always been. Autonomous establishment is a
// SEPARATE, DERIVED property computed from Stage 3 evidence on every read, which
// is what makes it safe: a Finding whose evidence degrades stops being
// established by itself, with no job to run and no row to correct. A stored
// establishment flag would have to be un-set by something, and nothing would.
//
// THERE IS NO SECOND READINESS ENGINE. Eligibility is decided from a
// `MeasurementReadiness` verdict produced by `assessReadiness` -- the same gate
// that decides whether a Headline may exist at all. Nothing here re-derives
// observation, reconciliation, authority or coverage; it maps that verdict's
// refusals onto reasons a product surface can render. If this file ever begins
// to judge a business date, it has become the thing it exists to prevent.
//
// NO CONFIDENCE PERCENTAGE. `IntelligenceHypothesis.confidence` is a nullable
// Float that one producer path writes and NOTHING reads: no rule consumes it, no
// threshold compares against it, no surface renders it. It therefore has no
// governed meaning, and a number with no governed meaning shown next to a claim
// is read as authority it does not have. This contract has no confidence field
// and the service that writes Findings leaves the column null.
//
// PURE. No clock, no I/O, no randomness. Same inputs, same verdict.

import type { MeasurementReadiness, ReadinessWithholding } from './measurement-readiness';
import { MEASUREMENT_READINESS_RULE_VERSION } from './measurement-readiness';
import { CASE_EVENT_REASONS, isCaseEvent } from './case-observation';

export const FINDING_ESTABLISHMENT_RULE_VERSION = 'case-finding-establishment.v1';

/** The namespace every Finding's `hypothesisType` carries. Never parsed loosely. */
export const FINDING_TYPE_PREFIX = 'case-finding:';

// --- What kind of claim it is ---------------------------------------------------

/**
 * The two kinds of claim, and the whole reason the distinction exists.
 *
 * MEASUREMENT_BACKED  The claim rests on a Stage 3 measure, so there is a
 *                     deterministic gate that can prove it eligible.
 * NON_MEASUREMENT     Everything else: a pattern in conversation text, a
 *                     relationship read, an inference from a counterparty's
 *                     behaviour. Real intelligence, and there is no governed
 *                     standard for establishing it yet.
 *
 * A NON_MEASUREMENT Finding can never establish itself, no matter what generated
 * it and no matter how sure it sounds. It can still be ESTABLISHED by a person,
 * because a person taking responsibility is the standard that already exists.
 */
export const FINDING_CLAIM_KINDS = ['MEASUREMENT_BACKED', 'NON_MEASUREMENT'] as const;
export type FindingClaimKind = (typeof FINDING_CLAIM_KINDS)[number];

export function isFindingClaimKind(value: string): value is FindingClaimKind {
  return (FINDING_CLAIM_KINDS as readonly string[]).includes(value);
}

/** The `hypothesisType` a Finding of this kind is stored under. */
export function findingHypothesisType(kind: FindingClaimKind): string {
  return `${FINDING_TYPE_PREFIX}${kind}`;
}

/**
 * The claim kind a stored `hypothesisType` names, or null when it names none.
 *
 * NULL IS NOT A DEFAULT. A hypothesis written by some other producer is not a
 * Finding, and guessing it into MEASUREMENT_BACKED would put a row nobody
 * governed in front of the gate.
 */
export function findingClaimKind(hypothesisType: string): FindingClaimKind | null {
  if (!hypothesisType.startsWith(FINDING_TYPE_PREFIX)) return null;
  const rest = hypothesisType.slice(FINDING_TYPE_PREFIX.length);
  return isFindingClaimKind(rest) ? rest : null;
}

// --- Lifecycle ------------------------------------------------------------------

/**
 * The product state of a Finding. DERIVED from the stored hypothesis lifecycle
 * plus the establishment assessment -- never stored as a column of its own.
 *
 * The three terminal members are the stored lifecycle showing through unchanged,
 * because "a person rejected this" and "a newer claim replaced it" are facts the
 * repository already records and a second vocabulary for them would drift.
 */
export const FINDING_STATES = [
  'DEVELOPING',
  'ESTABLISHED',
  'REJECTED',
  'SUPERSEDED',
  'EXPIRED',
] as const;
export type FindingState = (typeof FINDING_STATES)[number];

/** Whether a Finding is still a live belief, as opposed to history. */
export function findingIsLive(state: FindingState): boolean {
  return state === 'DEVELOPING' || state === 'ESTABLISHED';
}

/**
 * How a Finding came to be established, when it is.
 *
 * HUMAN_ACCEPTANCE       A person accepted the hypothesis. The existing,
 *                        attributed, human-only path.
 * DETERMINISTIC_POLICY   The Stage 3 gate proved the measurement eligible. No
 *                        person, no model, no judgement -- an evaluation.
 */
export const FINDING_ESTABLISHMENT_BASES = ['HUMAN_ACCEPTANCE', 'DETERMINISTIC_POLICY'] as const;
export type FindingEstablishmentBasis = (typeof FINDING_ESTABLISHMENT_BASES)[number];

// --- Why a claim may not establish itself ------------------------------------------

/**
 * Every reason autonomous establishment can be refused. Closed, and each names a
 * DIFFERENT next move -- the test `measurement-readiness.ts` already sets.
 */
export const FINDING_INELIGIBILITY_REASONS = [
  /** Rejected, superseded or expired. History does not establish. */
  'FINDING_NOT_LIVE',
  /** Non-measurement intelligence. Only a person can establish this today. */
  'CLAIM_NOT_MEASUREMENT_BACKED',
  /** No Stage 3 verdict could be obtained for the measure behind this claim. */
  'READINESS_NOT_PROVEN',
  /** The verdict was produced by a gate version this build no longer honours. */
  'READINESS_RULE_SUPERSEDED',
  /** Days were not observed, or the bound population did not fully report. */
  'COVERAGE_INCOMPLETE',
  /** A day in the window was never reconciled, or its comparison is unsound. */
  'RECONCILIATION_INCOMPLETE',
  /** Nobody has declared whose number this measure is, or two sources claim it. */
  'SOURCE_AUTHORITY_UNRESOLVED',
  /** The gate refused for a reason a person must answer. */
  'MEASUREMENT_WITHHELD',
  /** Nothing on the Case supports the claim. */
  'NO_SUPPORTING_EVIDENCE',
  /** Two pieces of evidence measure the same thing and disagree. */
  'EVIDENCE_CONFLICTED',
  /** A cited population only partly reported. */
  'EVIDENCE_INCOMPLETE',
  /** A cited producer never said how much of the population reported. */
  'EVIDENCE_COMPLETENESS_UNSTATED',
] as const;
export type FindingIneligibilityReason = (typeof FINDING_INELIGIBILITY_REASONS)[number];

/**
 * Which refusal each Stage 3 withholding maps onto.
 *
 * A MAP, NOT A BRANCH, so a new member of `READINESS_WITHHOLDINGS` is a compile
 * error here rather than a silent fall-through into "withheld, unspecified".
 */
export const FINDING_REASON_BY_WITHHOLDING: Record<
  ReadinessWithholding,
  FindingIneligibilityReason
> = {
  WINDOW_NOT_OBSERVED: 'COVERAGE_INCOMPLETE',
  POPULATION_INCOMPLETE: 'COVERAGE_INCOMPLETE',
  AUTHORITATIVE_DATA_PENDING: 'COVERAGE_INCOMPLETE',
  AUTHORITATIVE_DATA_INCOMPLETE: 'COVERAGE_INCOMPLETE',
  RECONCILIATION_MISSING: 'RECONCILIATION_INCOMPLETE',
  RECONCILIATION_INCONCLUSIVE: 'RECONCILIATION_INCOMPLETE',
  SOURCE_AUTHORITY_MISSING: 'SOURCE_AUTHORITY_UNRESOLVED',
  SOURCE_AUTHORITY_CONFLICT: 'SOURCE_AUTHORITY_UNRESOLVED',
  MEASURE_NOT_SUPPORTED_BY_SOURCE: 'SOURCE_AUTHORITY_UNRESOLVED',
  MIXED_SOURCE_AGGREGATION_UNSUPPORTED: 'SOURCE_AUTHORITY_UNRESOLVED',
  CAMPAIGN_EXPECTATION_UNKNOWN: 'MEASUREMENT_WITHHELD',
  CAMPAIGN_EXPECTATION_CONTRADICTED: 'MEASUREMENT_WITHHELD',
  CALL_UNATTRIBUTED: 'MEASUREMENT_WITHHELD',
};

/** One sentence per refusal. Said once, so every surface says the same thing. */
export const FINDING_INELIGIBILITY_LABELS: Record<FindingIneligibilityReason, string> = {
  FINDING_NOT_LIVE: 'This finding is no longer the current one on the case.',
  CLAIM_NOT_MEASUREMENT_BACKED:
    'This finding is not based on a measured number, so Loop cannot establish it on its own. ' +
    'A person can accept it.',
  READINESS_NOT_PROVEN:
    'Loop could not check whether the measurement behind this finding is sound, so it will not ' +
    'treat the finding as established.',
  READINESS_RULE_SUPERSEDED:
    'The measurement check behind this finding was made under an older rule and has to be redone.',
  COVERAGE_INCOMPLETE: 'Part of the period this finding covers was never fully recorded.',
  RECONCILIATION_INCOMPLETE:
    'At least one day in this period has not been checked against the provider.',
  SOURCE_AUTHORITY_UNRESOLVED:
    'It is not settled whose numbers this measure comes from, so the value cannot be trusted yet.',
  MEASUREMENT_WITHHELD: 'Loop withheld the measurement behind this finding, and said why.',
  NO_SUPPORTING_EVIDENCE: 'Nothing recorded on this case supports the finding yet.',
  EVIDENCE_CONFLICTED:
    'Two pieces of evidence measure the same thing over the same period and disagree.',
  EVIDENCE_INCOMPLETE: 'Some evidence covers only part of the population it describes.',
  EVIDENCE_COMPLETENESS_UNSTATED:
    'Some evidence never said how much of the population it covers, which is not the same as all of it.',
};

// --- What the gate is given ----------------------------------------------------------

/**
 * One piece of evidence, reduced to what establishment actually depends on.
 *
 * DELIBERATELY NOT THE WHOLE EVIDENCE ROW. The gate does not read values,
 * entities or payloads -- it reads whether the producer said how much of the
 * population reported, and whether two rows about the same thing disagree.
 */
export interface FindingEvidenceRef {
  id: string;
  source: string;
  metricKey: string;
  window: string | null;
  value: number | null;
  /**
   * 0-1, or null when the producer expressed none.
   *
   * NULL IS NOT ONE. "Nobody said" and "all of it reported" are different facts,
   * they get different refusals, and collapsing them would let silence establish
   * a claim.
   */
  completeness: number | null;
}

/**
 * Two pieces of evidence that measure the same thing over the same period and do
 * not agree.
 *
 * DERIVED FROM EVIDENCE, NOT DECLARED. Nothing in the schema marks a row as
 * contradicting another, and inventing a flag for it would be a second evidence
 * system. What CAN be computed is arithmetic: same metric, same window,
 * different sources, different numbers. That is a real contradiction and it is
 * the only one this contract claims to see.
 */
export interface FindingContradiction {
  metricKey: string;
  window: string | null;
  /** The disagreeing rows, in the order the evidence was given. */
  evidenceIds: readonly string[];
  values: readonly number[];
  sources: readonly string[];
}

/** Everything the gate judges. Nothing is fetched, defaulted or inferred here. */
export interface FindingEstablishmentInput {
  claimKind: FindingClaimKind;
  /** False for a rejected, superseded or expired Finding. */
  live: boolean;
  /**
   * The Stage 3 verdict for the measure this claim rests on, re-read live.
   *
   * NULL MEANS NOT PROVEN, AND THAT IS A REFUSAL. It is never read as "fine":
   * a caller that could not obtain a verdict has not shown the claim is eligible,
   * and the difference between those two is the entire point of this file.
   */
  readiness: MeasurementReadiness | null;
  supporting: readonly FindingEvidenceRef[];
  contradicting: readonly FindingContradiction[];
}

/** What the gate concluded, and everything it concluded it from. */
export interface FindingEstablishment {
  ruleVersion: string;
  /** True only when nothing objected. */
  eligible: boolean;
  /** Non-null exactly when `eligible` is true and nothing else established it. */
  basis: FindingEstablishmentBasis | null;
  /** Every refusal, in a fixed order. Empty when eligible. */
  reasons: readonly FindingIneligibilityReason[];
  /**
   * The Stage 3 withholdings behind the refusals, unchanged.
   *
   * Carried so a surface can show the operator the day and campaign the gate
   * named, rather than a translated summary of it.
   */
  readinessWithholdings: readonly ReadinessWithholding[];
}

// --- The gate --------------------------------------------------------------------------

/**
 * May this Finding establish itself?
 *
 * ORDER IS DELIBERATE AND STRUCTURAL-REFUSAL-FIRST. A finding that is no longer
 * live, or that is not measurement-backed, is refused before any evidence is
 * read: those are properties of the claim rather than of its support, and
 * listing evidence problems underneath them would suggest that fixing the
 * evidence would help.
 *
 * EVERYTHING AFTER THAT ACCUMULATES, so an operator sees every problem in one
 * pass. Deduped, first-seen order preserved.
 */
export function assessFindingEstablishment(
  input: FindingEstablishmentInput,
): FindingEstablishment {
  const reasons: FindingIneligibilityReason[] = [];
  const withholdings: ReadinessWithholding[] = [];
  const add = (r: FindingIneligibilityReason) => {
    if (!reasons.includes(r)) reasons.push(r);
  };

  if (!input.live) return refused(['FINDING_NOT_LIVE'], []);
  if (input.claimKind !== 'MEASUREMENT_BACKED') {
    return refused(['CLAIM_NOT_MEASUREMENT_BACKED'], []);
  }

  // 1 · THE STAGE 3 VERDICT. Absent is a refusal, not a pass.
  const readiness = input.readiness;
  if (!readiness) {
    add('READINESS_NOT_PROVEN');
  } else if (readiness.ruleVersion !== MEASUREMENT_READINESS_RULE_VERSION) {
    // A verdict from a gate this build no longer runs proves nothing about what
    // this build would decide, and honouring it would let a rule change silently
    // grandfather in every claim made under the old one.
    add('READINESS_RULE_SUPERSEDED');
  } else if (!readiness.ready) {
    for (const f of readiness.findings) {
      if (!withholdings.includes(f.reason)) withholdings.push(f.reason);
      add(FINDING_REASON_BY_WITHHOLDING[f.reason]);
    }
    // A verdict that is not ready but names nothing is still a refusal. The gate
    // cannot produce that shape today; treating it as eligible if it ever did is
    // the failure mode worth spending one branch on.
    if (readiness.findings.length === 0) add('MEASUREMENT_WITHHELD');
  }

  // 2 · THE EVIDENCE ON THE CASE.
  if (input.supporting.length === 0) add('NO_SUPPORTING_EVIDENCE');
  for (const e of input.supporting) {
    if (e.completeness === null) add('EVIDENCE_COMPLETENESS_UNSTATED');
    else if (e.completeness < 1) add('EVIDENCE_INCOMPLETE');
  }
  if (input.contradicting.length > 0) add('EVIDENCE_CONFLICTED');

  if (reasons.length > 0) return refused(reasons, withholdings);
  return {
    ruleVersion: FINDING_ESTABLISHMENT_RULE_VERSION,
    eligible: true,
    basis: 'DETERMINISTIC_POLICY',
    reasons: [],
    readinessWithholdings: [],
  };
}

function refused(
  reasons: readonly FindingIneligibilityReason[],
  withholdings: readonly ReadinessWithholding[],
): FindingEstablishment {
  return {
    ruleVersion: FINDING_ESTABLISHMENT_RULE_VERSION,
    eligible: false,
    basis: null,
    reasons,
    readinessWithholdings: withholdings,
  };
}

/**
 * The contradictions inside a set of evidence.
 *
 * SAME METRIC, SAME WINDOW, DIFFERENT SOURCES, DIFFERENT NUMBERS. Rows from the
 * SAME source are not a contradiction -- a producer restating its own number is
 * a revision, and `provider_fact_revisions` already owns that story. Rows with
 * no value cannot disagree with anything.
 *
 * DETERMINISTIC. Groups come back in the order their first member appeared.
 */
export function findEvidenceContradictions(
  evidence: readonly FindingEvidenceRef[],
): FindingContradiction[] {
  const groups = new Map<string, FindingEvidenceRef[]>();
  const order: string[] = [];
  for (const e of evidence) {
    if (e.value === null) continue;
    const key = `${e.metricKey} ${e.window ?? ''}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(e);
    else {
      groups.set(key, [e]);
      order.push(key);
    }
  }

  const out: FindingContradiction[] = [];
  for (const key of order) {
    const bucket = groups.get(key) ?? [];
    if (bucket.length < 2) continue;
    const distinctValues = new Set(bucket.map((e) => e.value));
    const distinctSources = new Set(bucket.map((e) => e.source));
    if (distinctValues.size < 2 || distinctSources.size < 2) continue;
    const first = bucket[0];
    if (!first) continue;
    out.push({
      metricKey: first.metricKey,
      window: first.window,
      evidenceIds: bucket.map((e) => e.id),
      values: bucket.map((e) => e.value as number),
      sources: bucket.map((e) => e.source),
    });
  }
  return out;
}

// --- What a surface reads ----------------------------------------------------------------

/**
 * How this claim came to exist. The platform enum, unchanged and not narrowed.
 *
 * AI_MODEL IS IN THE VOCABULARY AND NOT IN THE PRODUCT. No model writes a
 * Finding today, and this contract does not pretend one does -- but the column
 * can hold the value, and a type that could not represent a row the database can
 * store would be a lie in the other direction.
 */
export type FindingGeneratedBy =
  | 'DETERMINISTIC_RULE'
  | 'STATISTICAL_MODEL'
  | 'AI_MODEL'
  | 'HUMAN';

/**
 * What a Finding leaves open, kept in the four shapes it can distinguish.
 *
 * KNOWN and INFERRED are different claims about the same sentence. Known is what
 * the evidence states; inferred is what Loop concluded FROM it. A product that
 * shows them in one list teaches an operator to read a conclusion as a
 * measurement, which is the specific mistake this whole stage exists to prevent.
 */
export interface FindingReasoning {
  /** Statements the evidence supports directly, each citing its row. */
  known: readonly FindingStatement[];
  /** What Loop concluded from those. Never a measurement. */
  inferred: readonly FindingStatement[];
  /** What would be needed to settle the claim and is not there. */
  missing: readonly string[];
  /** Evidence that disagrees with itself, computed rather than declared. */
  contradictory: readonly FindingContradiction[];
  /** Why a section is empty when the emptiness is structural. */
  unavailable: Partial<Record<'KNOWN' | 'INFERRED' | 'MISSING' | 'CONTRADICTORY', string>>;
}

export interface FindingStatement {
  text: string;
  /** The evidence row it rests on, when it rests on one. */
  evidenceId: string | null;
}

/**
 * Why INFERRED is empty, in one sentence.
 *
 * Stated once so no surface invents a friendlier version that implies Loop
 * reasoned and found nothing.
 */
export const FINDING_INFERENCE_UNAVAILABLE =
  'Loop records the claim and the evidence under it. It does not yet write out the steps ' +
  'between them, so nothing is listed here.';

export const FINDING_CONTRADICTION_NONE =
  'No two pieces of evidence measure the same thing over the same period and disagree.';

/** One superseded ancestor, kept so a claim can never be silently rewritten. */
export interface FindingLineageEntry {
  findingId: string;
  claim: string;
  conclusion: string | null;
  state: FindingState;
  generatedBy: FindingGeneratedBy;
  createdAt: string;
  /** The Finding that replaced it. */
  supersededById: string | null;
}

/** One Finding, in product terms. Assembled on read; never a table. */
export interface CaseFindingView {
  findingId: string;
  caseId: string;
  /** THE CLAIM, in one line. */
  claim: string;
  /** The analytical conclusion, when the author wrote one. */
  conclusion: string | null;
  claimKind: FindingClaimKind;
  state: FindingState;
  generatedBy: FindingGeneratedBy;

  /** How it became established, or null while it has not. */
  establishedBy: FindingEstablishmentBasis | null;
  /** Set only for HUMAN_ACCEPTANCE. A policy has no actor. */
  establishedByUserId: string | null;
  establishedAt: string | null;
  /** The deterministic assessment, in full, including every refusal. */
  establishment: FindingEstablishment;

  reasoning: FindingReasoning;
  supporting: readonly FindingEvidenceRef[];

  createdAt: string;
  /** The window the claim is about, when it names one. */
  supportingWindowStart: string | null;
  supportingWindowEnd: string | null;
  /** The rule that produced it, at its version. Null for a human's claim. */
  ruleVersion: string | null;

  /** Every claim this one replaced, newest first. Never edited, never deleted. */
  lineage: readonly FindingLineageEntry[];
}

/** True when the Finding is the current belief on its Case. */
export function findingIsCurrent(view: Pick<CaseFindingView, 'state'>): boolean {
  return findingIsLive(view.state);
}

// --- The Case's own log ------------------------------------------------------------------

/**
 * The line recorded on the Case when a Finding is attached to it.
 *
 * THE DEBT THIS USED TO CARRY IS PAID. Until the vocabulary migration there was
 * no observation type meaning "a finding was recorded", so `NOTE_ADDED` carried
 * it and this sentence was the only thing separating a finding from a note.
 * `FINDING_RECORDED` and `FINDING_SUPERSEDED` are governed enum members now, and
 * this text is what a person reads on the timeline.
 *
 * STILL WRITTEN, STILL VERBATIM. A Case whose log spans the migration must read
 * as one continuous story, and `case-observation.ts` is the single place that
 * knows both shapes mean the same thing.
 */
export const FINDING_RECORDED_REASON = CASE_EVENT_REASONS.FINDING_RECORDED;

export const FINDING_SUPERSEDED_REASON = CASE_EVENT_REASONS.FINDING_SUPERSEDED;

export function isFindingRecorded(observation: {
  observationType: string;
  reason: string | null;
}): boolean {
  return isCaseEvent(observation, 'FINDING_RECORDED');
}

export function isFindingSuperseded(observation: {
  observationType: string;
  reason: string | null;
}): boolean {
  return isCaseEvent(observation, 'FINDING_SUPERSEDED');
}

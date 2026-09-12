// What Loop concludes about an investigation, and what it is allowed to call
// established. THE AUTHORITY BOUNDARY, WITHOUT A GENERATOR BEHIND IT.
//
// A FINDING IS A CLAIM, NOT A FACT. It is the analytical conclusion drawn on a
// Case -- "SSDI's conversion rate fell because one buyer stopped settling on the
// day" -- and it is the first thing in this platform that is Loop's own sentence
// rather than a measurement. That is exactly why it needs a gate: a claim that
// can promote itself into truth is how a system starts lying confidently.
//
// THREE INDEPENDENT AXES, AND NONE OF THEM MAY STAND IN FOR ANOTHER.
//
//   EVIDENCE STATE  What the evidence supports. DEVELOPING or ESTABLISHED, and
//                   derived from governed evidence ONLY. Reached in exactly one
//                   way today: the deterministic Stage 3 gate proved the
//                   measurement underneath the claim is eligible.
//   JUDGMENT        What a person decided. ACCEPTED, REJECTED or nothing yet,
//                   with who and when.
//   LIFECYCLE       Whether this is still the claim on the Case. CURRENT, or
//                   SUPERSEDED by a newer claim, or EXPIRED.
//
// HUMAN AUTHORITY MAY AUTHORIZE ACTION UNDER UNCERTAINTY, BUT IT CANNOT
// AUTHORIZE CERTAINTY. A person accepting a claim does not establish it, and a
// person rejecting one does not weaken its evidence or stop Loop evaluating it.
// Established + Rejected and Developing + Accepted are both true, ordinary
// states. Until Stage 5 PR 1 a person's acceptance established a claim outright,
// which let an opinion stand where evidence should have.
//
// ESTABLISHMENT IS NEVER STORED. `IntelligenceHypothesis.status` carries the
// judgment -- a hypothesis is only ever created PROPOSED, and acceptance demands
// an attributed human -- and this file does not touch that invariant. Evidence
// state is a SEPARATE, DERIVED property computed from Stage 3 evidence on every
// read, which is what makes it safe: a Finding whose evidence degrades stops
// being established by itself, with no job to run and no row to correct. A
// stored establishment flag would have to be un-set by something, and nothing
// would.
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
 * A NON_MEASUREMENT Finding cannot be established today, no matter what generated
 * it, how sure it sounds or who accepts it. There is no governed evidence
 * standard for claims of that kind yet, and a person's acceptance is a judgment
 * rather than evidence. It stays DEVELOPING, says why, and can still be accepted
 * or rejected like any other claim.
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

// --- The three axes ----------------------------------------------------------------

/**
 * WHAT THE EVIDENCE SUPPORTS. Derived from the establishment assessment on every
 * read and never stored -- see `findingEvidenceState`.
 *
 * Two members and no third. Rejected, superseded and expired are not evidence
 * states: the first is a person's judgment and the other two are lifecycle, and
 * folding either into this axis is how "somebody disagreed" came to read as "the
 * evidence stopped counting".
 */
export const FINDING_EVIDENCE_STATES = ['DEVELOPING', 'ESTABLISHED'] as const;
export type FindingEvidenceState = (typeof FINDING_EVIDENCE_STATES)[number];

/** Whether a stored value is a governed evidence state. Anything else is not one. */
export function isFindingEvidenceState(value: unknown): value is FindingEvidenceState {
  return typeof value === 'string' && (FINDING_EVIDENCE_STATES as readonly string[]).includes(value);
}

/**
 * WHAT A PERSON DECIDED. The hypothesis's own attributed acceptance and
 * rejection, shown through unchanged. No judgment at all is `null` on the view,
 * not a third member: "nobody has judged this" is an absence, and a value for it
 * would be one more thing a surface could mistake for a decision.
 */
export const FINDING_JUDGMENTS = ['ACCEPTED', 'REJECTED'] as const;
export type FindingJudgment = (typeof FINDING_JUDGMENTS)[number];

/** One person's judgment of a claim, with who made it and when. */
export interface FindingJudgmentView {
  judgment: FindingJudgment;
  /**
   * Who judged. Null only when the stored row carries no attribution -- which the
   * repository refuses to write for an acceptance -- and a surface must then say
   * the attribution is missing rather than imply nobody was involved.
   */
  byUserId: string | null;
  /** When. Null only when the stored row carries no time, which is the same defect. */
  at: string | null;
}

/**
 * WHETHER THIS IS STILL THE CLAIM ON THE CASE. A superseded claim is kept in full
 * as lineage, and an expired one aged out; neither is evaluated any further,
 * because history does not establish. Rejection is NOT a lifecycle: a rejected
 * claim is still the current claim, and Loop still evaluates its evidence.
 */
export const FINDING_LIFECYCLES = ['CURRENT', 'SUPERSEDED', 'EXPIRED'] as const;
export type FindingLifecycle = (typeof FINDING_LIFECYCLES)[number];

/**
 * The stored facts the judgment and lifecycle axes are read from.
 *
 * THE HYPOTHESIS ROW, IN PLAIN VALUES. Kept free of Prisma so the same derivation
 * serves the service that reads the row and the fixtures that exercise the
 * surface, and neither can grow its own idea of what a status means.
 */
export interface FindingRecordFacts {
  /** The stored `HypothesisStatus`, e.g. PROPOSED, ACCEPTED, REJECTED, SUPERSEDED. */
  status: string;
  supersededById: string | null;
  acceptedBy: string | null;
  /** ISO-8601 UTC (`Date#toISOString`), which orders correctly as text. */
  acceptedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
}

/** Whether the claim is still the one on the Case. Rejection does not enter into it. */
export function findingLifecycle(facts: FindingRecordFacts): FindingLifecycle {
  if (facts.supersededById || facts.status === 'SUPERSEDED') return 'SUPERSEDED';
  if (facts.status === 'EXPIRED') return 'EXPIRED';
  return 'CURRENT';
}

/**
 * The most recent judgment a person recorded, or null when nobody has judged.
 *
 * READ FROM THE ATTRIBUTED COLUMNS, NOT FROM THE STATUS ALONE. Accepting writes
 * `acceptedBy`/`acceptedAt` and rejecting writes `rejectedBy`/`rejectedAt`, and
 * neither clears the other -- so the later of the two times is the latest act,
 * and it survives a supersession that overwrote the status. What does NOT
 * survive is anything earlier: the repository overwrites in place, so a claim
 * accepted, then rejected, then accepted again reports only the last. That
 * history belongs to a hypothesis lifecycle log that does not exist yet.
 *
 * A STATUS NAMING A JUDGMENT NOBODY TIMESTAMPED is reported as that judgment with
 * no time, rather than dropped. The repository cannot write that shape; if a row
 * ever carries it, hiding the judgment would be the worse lie.
 */
export function findingJudgment(facts: FindingRecordFacts): FindingJudgmentView | null {
  const accepted = facts.acceptedAt;
  const rejected = facts.rejectedAt;
  if (accepted && (!rejected || accepted >= rejected)) {
    return { judgment: 'ACCEPTED', byUserId: facts.acceptedBy, at: accepted };
  }
  if (rejected) return { judgment: 'REJECTED', byUserId: facts.rejectedBy, at: rejected };
  if (facts.status === 'ACCEPTED') return { judgment: 'ACCEPTED', byUserId: facts.acceptedBy, at: null };
  if (facts.status === 'REJECTED') return { judgment: 'REJECTED', byUserId: facts.rejectedBy, at: null };
  return null;
}

/**
 * What the evidence supports, from the gate's own verdict and nothing else.
 *
 * DELIBERATELY TAKES NO JUDGMENT. There is no argument through which a person's
 * acceptance could raise this or a rejection lower it; the type is the guarantee.
 */
export function findingEvidenceState(
  establishment: Pick<FindingEstablishment, 'eligible'>,
): FindingEvidenceState {
  return establishment.eligible ? 'ESTABLISHED' : 'DEVELOPING';
}

/**
 * How a Finding came to be established, when it is.
 *
 * ONE MEMBER, DELIBERATELY. DETERMINISTIC_POLICY is the Stage 3 gate proving the
 * measurement eligible: no person, no model, no judgement -- an evaluation.
 * HUMAN_ACCEPTANCE used to be the second member, and was removed because a
 * person's authority is not evidence. A second basis arrives only with a
 * governed evidence standard behind it.
 */
export const FINDING_ESTABLISHMENT_BASES = ['DETERMINISTIC_POLICY'] as const;
export type FindingEstablishmentBasis = (typeof FINDING_ESTABLISHMENT_BASES)[number];

// --- Why a claim may not establish itself ------------------------------------------

/**
 * Every reason autonomous establishment can be refused. Closed, and each names a
 * DIFFERENT next move -- the test `measurement-readiness.ts` already sets.
 */
export const FINDING_INELIGIBILITY_REASONS = [
  /** Superseded or expired. History does not establish. Rejection is not here. */
  'FINDING_NOT_CURRENT',
  /** Non-measurement intelligence. No governed standard can establish it yet. */
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
  FINDING_NOT_CURRENT: 'This finding is no longer the current one on the case.',
  CLAIM_NOT_MEASUREMENT_BACKED:
    'This finding is not based on a measured number, and Loop has no governed standard yet for ' +
    'establishing a claim of this kind, so it stays developing. A person can accept or reject it; ' +
    'that records their judgement and does not establish it.',
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
  /**
   * The measure this evidence is about.
   *
   * NULL IS POSSIBLE AND IS NOT A GROUPING KEY. Evidence that names no measure
   * cannot disagree with evidence that does, so it takes no part in contradiction
   * detection. Only MEASURED evidence reaches this contract at all -- a human
   * report is not an input to the gate -- but a measured row that named no
   * measure would still be one the gate must not group on.
   */
  metricKey: string | null;
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
  /**
   * False for a superseded or expired Finding. TRUE for a rejected one: a
   * person's judgment does not stop Loop evaluating the evidence.
   */
  current: boolean;
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
  /** Non-null exactly when `eligible` is true. */
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
 * current, or that is not measurement-backed, is refused before any evidence is
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

  if (!input.current) return refused(['FINDING_NOT_CURRENT'], []);
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
    // A ROW THAT NAMES NO MEASURE CANNOT CONTRADICT ONE THAT DOES. Grouping on a
    // null key would make every such row "the same measurement" as every other.
    if (e.metricKey === null) continue;
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
    if (!first || first.metricKey === null) continue;
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

/**
 * One superseded ancestor, kept so a claim can never be silently rewritten.
 *
 * NO EVIDENCE STATE, deliberately. History is not evaluated, so an ancestor has
 * no current evidentiary standing to report -- and showing the standing it
 * would have TODAY would pass off a fresh reading as what was known then.
 */
export interface FindingLineageEntry {
  findingId: string;
  claim: string;
  conclusion: string | null;
  lifecycle: FindingLifecycle;
  /** The last judgment recorded on it before it was replaced, if any. */
  judgment: FindingJudgmentView | null;
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
  generatedBy: FindingGeneratedBy;

  /**
   * WHAT THE EVIDENCE SUPPORTS. From the gate below and from nothing else.
   * Always DEVELOPING for a claim that is not CURRENT, because history is not
   * evaluated.
   */
  evidenceState: FindingEvidenceState;
  /** WHAT A PERSON DECIDED, with who and when. Null when nobody has judged it. */
  judgment: FindingJudgmentView | null;
  /** WHETHER THIS IS STILL THE CLAIM ON THE CASE. */
  lifecycle: FindingLifecycle;

  /**
   * The deterministic assessment, in full, including every refusal. Its `basis`
   * is the only way evidence state is ever ESTABLISHED.
   */
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

/**
 * True when the Finding is the current claim on its Case.
 *
 * A REJECTED FINDING IS CURRENT. Rejection is a person's judgment of the claim,
 * not its replacement; only supersession and expiry end a claim's time on the
 * Case.
 */
export function findingIsCurrent(view: Pick<CaseFindingView, 'lifecycle'>): boolean {
  return view.lifecycle === 'CURRENT';
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

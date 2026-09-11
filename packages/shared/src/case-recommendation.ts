// What a person could do about a Finding — and the ceiling on how firmly Loop is
// allowed to say it.
//
// DECISION SUPPORT, NOT INSTRUCTION. This repository already settled this
// argument once, in `callgrid-decision-support.ts`: "A recommendation says 'do
// X'. Decision support says here is what was measured, here is why it matters,
// here is what you would need to know before deciding." The inputs that decide
// the first -- contractual caps, inventory, budgets, commercial terms -- are not
// in this system and will not be. So this contract reuses that layer's
// vocabularies rather than inventing a second set, and reuses its verb guard to
// make "Increase the bid" unrepresentable rather than merely discouraged.
//
// WHY THIS IS NOT A NEW TABLE. `CognitiveDecision` already records a decision
// made from state, policy and evidence, already carries the RECOMMEND outcome,
// already carries an approval primitive (`requiresApproval` / `approvedAt` /
// `approvedBy`), and its repository header already says a RECOMMEND row "is a
// durable record with its input state snapshot and policy evaluation attached,
// not an action". And `OperationalObservation.decisionId` is already an FK to it,
// so the Case's own append-only log is already the link. Everything below is the
// TYPED CONTRACT for what goes in that row -- not a second recommendation store.
//
// MULTIPLE ANSWERS ARE THE NORMAL CASE. Protect revenue first, protect the
// relationship first, learn before acting -- these are genuinely different
// choices with different risk, and a product that always names one winner is
// asserting a business judgement it cannot make. So a recommendation SET carries
// options, and the order is whatever the author declared.
//
// RANKING IS EXPLAINED, NOT SCORED. There is no ranking engine here, because
// nothing in this repository justifies one yet. What there is instead is enough
// structured basis to answer "why is this above that" from inspectable inputs:
// each option carries a categorical profile across named factors, each factor
// declares which direction is better, and `compareOptions` reports the factors on
// which one beats the other. A scalar would have been quicker and would have made
// the answer unreconstructable.
//
// NO INVENTED PRECISION. Factors are categorical. There is no probability of
// success, no expected value, and no confidence percentage -- the same refusal
// the Finding contract makes, for the same reason: a number with no governed
// derivation is read as authority nobody granted it. UNKNOWN is a first-class
// level and is never defaulted into MODERATE.
//
// PURE. No clock, no I/O, no randomness.

import type { EvidenceStrength } from './callgrid-decision-support';
import { EVIDENCE_STRENGTH_RANK } from './callgrid-decision-support';
import { RECOMMENDATION_VERBS, isSafeRecommendation } from './callgrid-intelligence';
import type { RecommendationVerb } from './callgrid-intelligence';
import type { FindingEvidenceState, FindingLifecycle } from './case-finding';
import { CASE_EVENT_REASONS, isCaseEvent } from './case-observation';

export const RECOMMENDATION_RULE_VERSION = 'case-recommendation.v1';

/** The `decisionType` every Case recommendation is stored under. Never parsed loosely. */
export const RECOMMENDATION_DECISION_TYPE = 'case-recommendation';

// --- Who wrote it -------------------------------------------------------------------

/**
 * What produced an option.
 *
 * MACHINE       A deterministic producer. No model exists today; when one does,
 *               it arrives as MODEL and does not get to claim this.
 * MODEL         Generated text, reasoning over governed facts. NOT AN AUTHORITY:
 *               a model may phrase an option and weigh stated tradeoffs; it may
 *               not assert a measurement, an impact or a causal claim.
 * HUMAN         A person wrote or rewrote it.
 *
 * The distinction is persisted, because generated text that is stored becomes
 * indistinguishable from a measured fact the moment its provenance is dropped.
 */
export const RECOMMENDATION_AUTHORS = ['MACHINE', 'MODEL', 'HUMAN'] as const;
export type RecommendationAuthor = (typeof RECOMMENDATION_AUTHORS)[number];

// --- How far an option is allowed to go -------------------------------------------

/**
 * The POSTURE of an option: how consequential and how reversible it is.
 *
 * Ordered from safest to most committing, and that order is the ceiling that
 * evidence strength enforces. This is not a category of action -- it is a
 * statement about what going wrong would cost.
 */
export const RECOMMENDATION_POSTURES = [
  /** Gather information. Costs time; changes nothing. Always available. */
  'LEARN_BEFORE_ACTING',
  /** Establish what is actually happening. Always available. */
  'DIAGNOSTIC',
  /** A change that can be undone within the period, at known cost. */
  'REVERSIBLE_MITIGATION',
  /** A change that cannot be cheaply undone: spend, contracts, relationships. */
  'COMMITTED_CHANGE',
] as const;
export type RecommendationPosture = (typeof RECOMMENDATION_POSTURES)[number];

export const POSTURE_RANK: Record<RecommendationPosture, number> = {
  LEARN_BEFORE_ACTING: 0,
  DIAGNOSTIC: 1,
  REVERSIBLE_MITIGATION: 2,
  COMMITTED_CHANGE: 3,
};

export const POSTURE_LABEL: Record<RecommendationPosture, string> = {
  LEARN_BEFORE_ACTING: 'Learn before acting',
  DIAGNOSTIC: 'Find out what is happening',
  REVERSIBLE_MITIGATION: 'A change you can undo',
  COMMITTED_CHANGE: 'A change that commits you',
};

/**
 * The strongest posture this evidence may support.
 *
 * THE CEILING, AND THE WHOLE POINT OF THIS FILE. A DEVELOPING Finding is Loop
 * still assembling a case for a claim; it can justify going and looking, and it
 * can justify a change you can take back tomorrow. It cannot justify committing
 * spend or a contractual position, because if the claim turns out to be wrong
 * there is nothing to take back.
 *
 * INSUFFICIENT evidence stops at DIAGNOSTIC and never reaches mitigation:
 * mitigating a condition you have not established is acting on a guess.
 */
export function maxPostureFor(strength: EvidenceStrength): RecommendationPosture {
  switch (strength) {
    case 'HIGH':
      return 'COMMITTED_CHANGE';
    case 'MODERATE':
      return 'REVERSIBLE_MITIGATION';
    case 'LOW':
      return 'REVERSIBLE_MITIGATION';
    case 'INSUFFICIENT':
      return 'DIAGNOSTIC';
  }
}

/** True when an option's posture is within what its evidence can support. */
export function postureIsSupported(
  posture: RecommendationPosture,
  strength: EvidenceStrength,
): boolean {
  return POSTURE_RANK[posture] <= POSTURE_RANK[maxPostureFor(strength)];
}

/**
 * How strong the evidence under a Stage 4 Finding is, in the platform's existing
 * vocabulary.
 *
 * DERIVED FROM THE EVIDENCE STATE, NOT FROM A CONFIDENCE NUMBER. The Finding
 * contract deliberately carries no confidence, so this reads the gate's own
 * answer instead:
 *
 *   established (by the deterministic gate)  → HIGH          (a measurement proved it)
 *   developing, with supporting evidence     → LOW
 *   developing, with nothing under it        → INSUFFICIENT
 *   superseded / expired                     → INSUFFICIENT  (history is not evaluated)
 *
 * A PERSON'S JUDGMENT IS NOT AN INPUT, AND THE TYPE ENFORCES IT. Accepting a
 * claim does not make its evidence stronger and rejecting it does not make it
 * weaker, so there is no field here through which either could reach the posture
 * ceiling. Until Stage 5 PR 1 an acceptance raised a developing claim to
 * MODERATE, which let an opinion unlock a mitigation the evidence could not. A
 * person who wants to act beyond what the evidence supports is authorizing
 * action under uncertainty, and that is recorded where the action is -- it does
 * not make the claim any more certain.
 */
export function findingEvidenceStrength(finding: {
  evidenceState: FindingEvidenceState;
  lifecycle: FindingLifecycle;
  supportingCount: number;
}): EvidenceStrength {
  if (finding.lifecycle !== 'CURRENT') return 'INSUFFICIENT';
  if (finding.evidenceState === 'ESTABLISHED') return 'HIGH';
  return finding.supportingCount > 0 ? 'LOW' : 'INSUFFICIENT';
}

// --- The tradeoff profile -------------------------------------------------------------

/**
 * The considerations an option is assessed on.
 *
 * CLOSED AND NAMED, so a surface can render the same headings for every option
 * and a comparison can be computed rather than written. Each one is a business
 * question an operator actually weighs.
 */
export const RECOMMENDATION_FACTORS = [
  'EVIDENCE_STRENGTH',
  'EXPECTED_BENEFIT',
  'DOWNSIDE_RISK',
  'REVERSIBILITY',
  'URGENCY',
  'EFFORT',
  'OPERATIONAL_RISK',
  'RELATIONSHIP_RISK',
  'TIME_TO_RESULT',
] as const;
export type RecommendationFactor = (typeof RECOMMENDATION_FACTORS)[number];

/**
 * The levels a factor can take.
 *
 * CATEGORICAL, NEVER NUMERIC. "83% likely to succeed" would be a fabricated
 * probability; "the benefit here is high and the downside is low" is a judgement
 * a person can check. UNKNOWN is not a polite MODERATE -- it means nobody
 * assessed it, and a surface must render it differently.
 */
export const FACTOR_LEVELS = ['LOW', 'MODERATE', 'HIGH', 'UNKNOWN'] as const;
export type FactorLevel = (typeof FACTOR_LEVELS)[number];

/** Ordering within a factor. UNKNOWN sits outside it and never compares. */
const LEVEL_RANK: Record<Exclude<FactorLevel, 'UNKNOWN'>, number> = {
  LOW: 0,
  MODERATE: 1,
  HIGH: 2,
};

/**
 * Which direction is better for each factor.
 *
 * DECLARED, NOT ASSUMED. "High benefit" is good and "high risk" is bad, and a
 * comparison that treated every HIGH as an improvement would rank the most
 * dangerous option first. Stated as data so the rule is inspectable rather than
 * buried in a comparison function.
 */
export const FACTOR_POLARITY: Record<RecommendationFactor, 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER'> =
  {
    EVIDENCE_STRENGTH: 'HIGHER_IS_BETTER',
    EXPECTED_BENEFIT: 'HIGHER_IS_BETTER',
    REVERSIBILITY: 'HIGHER_IS_BETTER',
    URGENCY: 'HIGHER_IS_BETTER',
    DOWNSIDE_RISK: 'LOWER_IS_BETTER',
    EFFORT: 'LOWER_IS_BETTER',
    OPERATIONAL_RISK: 'LOWER_IS_BETTER',
    RELATIONSHIP_RISK: 'LOWER_IS_BETTER',
    TIME_TO_RESULT: 'LOWER_IS_BETTER',
  };

export const FACTOR_LABEL: Record<RecommendationFactor, string> = {
  EVIDENCE_STRENGTH: 'How well established this is',
  EXPECTED_BENEFIT: 'What it could protect or gain',
  DOWNSIDE_RISK: 'What it could cost if it is wrong',
  REVERSIBILITY: 'How easily it can be undone',
  URGENCY: 'How much waiting costs',
  EFFORT: 'What it takes to do',
  OPERATIONAL_RISK: 'Risk to how the business runs',
  RELATIONSHIP_RISK: 'Risk to a client or partner relationship',
  TIME_TO_RESULT: 'How long before you would know',
};

/** One factor's assessment, with the sentence behind it. */
export interface FactorAssessment {
  factor: RecommendationFactor;
  level: FactorLevel;
  /**
   * Why, in one sentence. REQUIRED for anything but UNKNOWN, because a level
   * with no stated basis is a number wearing a word.
   */
  basis: string | null;
}

// --- The proposed sequence -------------------------------------------------------------

/**
 * One step of a proposed sequence.
 *
 * THE VERB IS CONSTRAINED, AND THAT IS THE ENTIRE SAFETY MECHANISM. This
 * repository already ships `RECOMMENDATION_VERBS` (Review, Investigate, Confirm,
 * Compare, Check, Evaluate, Monitor, Contact, Consider, Validate) and
 * `FORBIDDEN_RECOMMENDATION_VERBS` (Increase, Pause, Reroute, Optimize, ...) with
 * the rule that Loop may tell somebody to go and LOOK at something and may never
 * tell them to change a bid, a cap, a route or a payout -- because it cannot see
 * the constraints those decisions depend on.
 *
 * A CONSEQUENCE WORTH STATING PLAINLY: "Temporarily shift traffic" is not
 * expressible. "Evaluate shifting traffic to the backup buyer" is. That is not a
 * limitation being worked around; it is the boundary being enforced in the type
 * system rather than in review.
 */
export interface RecommendedAction {
  /** 1-based. Position in the sequence as PROPOSED. */
  position: number;
  verb: RecommendationVerb;
  /** The step, in full. Must open with `verb`. */
  statement: string;
  /** What this step is meant to establish or protect. Null when unstated. */
  intent: string | null;
}

/** True when every step opens with an approved verb and the sequence is ordered 1..n. */
export function sequenceIsSafe(actions: readonly RecommendedAction[]): boolean {
  return actions.every(
    (a, i) =>
      a.position === i + 1 &&
      (RECOMMENDATION_VERBS as readonly string[]).includes(a.verb) &&
      isSafeRecommendation(a.statement),
  );
}

// --- An option ---------------------------------------------------------------------------

export interface RecommendationOption {
  /** Stable within the set, so a person can select one by name. */
  key: string;
  /** "Protect revenue first". A name, not a sentence. */
  label: string;
  /** What this option is, in one paragraph. */
  summary: string;
  posture: RecommendationPosture;
  /** Assessed factors. A factor absent here is UNKNOWN, and says so. */
  factors: readonly FactorAssessment[];
  /** The proposed sequence. May be empty: an option need not be a plan. */
  actions: readonly RecommendedAction[];
  /**
   * Where the author placed it. 1 is first.
   *
   * NOT A SCORE, AND NOT COMPUTED HERE. Nothing in this repository justifies a
   * ranking engine yet, so the order is declared and the BASIS for comparing any
   * two options is carried alongside it. `compareOptions` answers "why is this
   * above that" from the factors; it does not decide the order.
   */
  rank: number;
}

/** The level an option assessed a factor at. UNKNOWN when it did not. */
export function levelOf(
  option: Pick<RecommendationOption, 'factors'>,
  factor: RecommendationFactor,
): FactorLevel {
  return option.factors.find((f) => f.factor === factor)?.level ?? 'UNKNOWN';
}

/** One factor on which two options genuinely differ. */
export interface FactorDifference {
  factor: RecommendationFactor;
  label: string;
  /** The level each option assessed. */
  left: FactorLevel;
  right: FactorLevel;
  /** Which option this factor favours. */
  favours: 'LEFT' | 'RIGHT';
}

export interface OptionComparison {
  leftKey: string;
  rightKey: string;
  /** Factors on which LEFT is better. */
  favouringLeft: readonly FactorDifference[];
  /** Factors on which RIGHT is better. */
  favouringRight: readonly FactorDifference[];
  /**
   * Factors that cannot be compared because at least one side is UNKNOWN.
   *
   * FIRST-CLASS, NOT DROPPED. "We did not assess relationship risk on either
   * option" is exactly the thing a person needs to see before trusting an order.
   */
  incomparable: readonly RecommendationFactor[];
}

/**
 * Why one option sits above another.
 *
 * DETERMINISTIC AND TOTAL: every factor lands in exactly one of the three lists,
 * in the declared order of `RECOMMENDATION_FACTORS`. There is no weighting, no
 * sum and no tie-break -- deliberately. Weighting revenue protection against
 * relationship risk is a business judgement, and inventing coefficients for it
 * here would put a number where a decision belongs.
 */
export function compareOptions(
  left: RecommendationOption,
  right: RecommendationOption,
): OptionComparison {
  const favouringLeft: FactorDifference[] = [];
  const favouringRight: FactorDifference[] = [];
  const incomparable: RecommendationFactor[] = [];

  for (const factor of RECOMMENDATION_FACTORS) {
    const l = levelOf(left, factor);
    const r = levelOf(right, factor);
    if (l === 'UNKNOWN' || r === 'UNKNOWN') {
      incomparable.push(factor);
      continue;
    }
    if (l === r) continue;
    const higherIsBetter = FACTOR_POLARITY[factor] === 'HIGHER_IS_BETTER';
    const leftWins = higherIsBetter ? LEVEL_RANK[l] > LEVEL_RANK[r] : LEVEL_RANK[l] < LEVEL_RANK[r];
    const difference: FactorDifference = {
      factor,
      label: FACTOR_LABEL[factor],
      left: l,
      right: r,
      favours: leftWins ? 'LEFT' : 'RIGHT',
    };
    (leftWins ? favouringLeft : favouringRight).push(difference);
  }

  return { leftKey: left.key, rightKey: right.key, favouringLeft, favouringRight, incomparable };
}

// --- The set ------------------------------------------------------------------------------

/**
 * Everything Loop proposed about one Finding, at one moment.
 *
 * A SET, NOT A WINNER. It carries the ceiling its evidence allowed, so a reader
 * can see that "no committed change is offered here" is a consequence of the
 * evidence rather than an oversight.
 */
export interface RecommendationSet {
  caseId: string;
  findingId: string;
  /**
   * What the evidence supported WHEN THIS WAS WRITTEN. A snapshot, deliberately.
   * Evidence state only: a person's judgment of the claim is not what bounds a
   * recommendation, so it is not what the snapshot records.
   */
  findingEvidenceStateAtIssue: FindingEvidenceState;
  evidenceStrengthAtIssue: EvidenceStrength;
  /** The strongest posture the evidence allowed at that moment. */
  postureCeiling: RecommendationPosture;
  author: RecommendationAuthor;
  ruleVersion: string;
  options: readonly RecommendationOption[];
  /** When Loop proposed it. */
  issuedAt: string;
}

// --- Validation ----------------------------------------------------------------------------

export const RECOMMENDATION_REJECTIONS = [
  'NO_OPTIONS',
  'DUPLICATE_OPTION_KEY',
  'DUPLICATE_RANK',
  'RANKS_NOT_CONTIGUOUS',
  'POSTURE_EXCEEDS_EVIDENCE',
  'UNSAFE_ACTION_VERB',
  'SEQUENCE_OUT_OF_ORDER',
  'ASSESSED_FACTOR_WITHOUT_BASIS',
  'UNKNOWN_FACTOR',
] as const;
export type RecommendationRejection = (typeof RECOMMENDATION_REJECTIONS)[number];

export const RECOMMENDATION_REJECTION_LABELS: Record<RecommendationRejection, string> = {
  NO_OPTIONS: 'A recommendation must offer at least one option.',
  DUPLICATE_OPTION_KEY: 'Two options share a key, so neither could be selected unambiguously.',
  DUPLICATE_RANK: 'Two options claim the same position.',
  RANKS_NOT_CONTIGUOUS: 'The options are not ranked 1..n.',
  POSTURE_EXCEEDS_EVIDENCE:
    'An option commits further than the evidence behind the finding can support.',
  UNSAFE_ACTION_VERB:
    'A step tells someone to change something. Loop may say what to look at, never what to change.',
  SEQUENCE_OUT_OF_ORDER: 'A sequence is not numbered 1..n in order.',
  ASSESSED_FACTOR_WITHOUT_BASIS: 'A factor was assessed without stating why.',
  UNKNOWN_FACTOR: 'An option assessed something that is not a recognised factor.',
};

export interface RecommendationValidation {
  ok: boolean;
  rejections: readonly RecommendationRejection[];
  /** Which option each rejection came from, in the same order. */
  offendingKeys: readonly string[];
}

/**
 * Is this set representable?
 *
 * REFUSED, NOT TRIMMED. A set carrying an option its evidence cannot support is
 * rejected whole rather than silently downgraded, because quietly weakening
 * somebody's proposal is worse than telling them it was not allowed.
 *
 * Accumulates every problem in one pass, in a fixed order.
 */
export function validateRecommendationSet(input: {
  options: readonly RecommendationOption[];
  evidenceStrength: EvidenceStrength;
}): RecommendationValidation {
  const rejections: RecommendationRejection[] = [];
  const offendingKeys: string[] = [];
  const fail = (r: RecommendationRejection, key: string) => {
    rejections.push(r);
    offendingKeys.push(key);
  };

  if (input.options.length === 0) {
    return { ok: false, rejections: ['NO_OPTIONS'], offendingKeys: [''] };
  }

  const keys = new Set<string>();
  const ranks = new Set<number>();
  for (const option of input.options) {
    if (keys.has(option.key)) fail('DUPLICATE_OPTION_KEY', option.key);
    keys.add(option.key);
    if (ranks.has(option.rank)) fail('DUPLICATE_RANK', option.key);
    ranks.add(option.rank);

    if (!postureIsSupported(option.posture, input.evidenceStrength)) {
      fail('POSTURE_EXCEEDS_EVIDENCE', option.key);
    }

    for (const f of option.factors) {
      if (!(RECOMMENDATION_FACTORS as readonly string[]).includes(f.factor)) {
        fail('UNKNOWN_FACTOR', option.key);
      } else if (f.level !== 'UNKNOWN' && !f.basis?.trim()) {
        fail('ASSESSED_FACTOR_WITHOUT_BASIS', option.key);
      }
    }

    for (const [i, a] of option.actions.entries()) {
      if (a.position !== i + 1) fail('SEQUENCE_OUT_OF_ORDER', option.key);
      if (!(RECOMMENDATION_VERBS as readonly string[]).includes(a.verb) || !isSafeRecommendation(a.statement)) {
        fail('UNSAFE_ACTION_VERB', option.key);
      }
    }
  }

  const expected = [...input.options].map((_, i) => i + 1);
  if (expected.some((n) => !ranks.has(n))) fail('RANKS_NOT_CONTIGUOUS', '');

  return { ok: rejections.length === 0, rejections, offendingKeys };
}

/** Options in the order the author declared. Stable, and never re-sorted by score. */
export function optionsInRank(
  set: Pick<RecommendationSet, 'options'>,
): readonly RecommendationOption[] {
  return [...set.options].sort((a, b) => a.rank - b.rank);
}

// --- Identity ------------------------------------------------------------------------------

/**
 * The stable key one option is stored under.
 *
 * DERIVED, NEVER RANDOM, for the reason `investigationRecurrenceKey` exists: it
 * makes recording a set IDEMPOTENT. Re-running the same producer over the same
 * case and the same set number converges on the same rows rather than
 * accumulating a second copy of everything it proposed.
 *
 * The set number is what supersession moves. Set 1 stays exactly as written when
 * set 2 arrives, which is how "do not silently rewrite historical
 * recommendations" becomes a property of the key rather than a rule somebody
 * remembers.
 */
export function recommendationKey(caseId: string, setNumber: number, optionKey: string): string {
  return `${RECOMMENDATION_DECISION_TYPE}:${caseId}:${setNumber}:${optionKey}`;
}

/** The prefix every option on one case shares. Used to list them, tenant-scoped. */
export function recommendationKeyPrefix(caseId: string): string {
  return `${RECOMMENDATION_DECISION_TYPE}:${caseId}:`;
}

/**
 * The key a person's revision of an option is stored under.
 *
 * A SEPARATE ROW, ALWAYS. The machine's option keeps its own key and its own
 * row; the revision names what it was derived from and never overwrites it.
 */
export function revisionKey(caseId: string, setNumber: number, optionKey: string): string {
  return `${recommendationKey(caseId, setNumber, optionKey)}:revision`;
}

// --- What a person did about it ------------------------------------------------------------

/**
 * How a person responded to a set.
 *
 * SELECTED is recorded through `CognitiveDecision`'s EXISTING approval columns --
 * `approvedAt` / `approvedBy` -- because an approval primitive already exists and
 * a second one would be a second answer to "did anybody sign off on this".
 * DISMISSED and REVISED are recorded on the Case's log, which is append-only, so
 * the machine's original wording is never touched by either.
 */
export const RECOMMENDATION_RESPONSES = ['SELECTED', 'DISMISSED', 'REVISED'] as const;
export type RecommendationResponse = (typeof RECOMMENDATION_RESPONSES)[number];

/** The exact line written on the Case when a recommendation set is recorded. */
export const RECOMMENDATION_RECORDED_REASON = CASE_EVENT_REASONS.RECOMMENDATION_RECORDED;

/** The exact line written when a person selects one option. */
export const RECOMMENDATION_SELECTED_REASON = CASE_EVENT_REASONS.RECOMMENDATION_SELECTED;

/** The exact line written when a person dismisses an option. */
export const RECOMMENDATION_DISMISSED_REASON = CASE_EVENT_REASONS.RECOMMENDATION_DISMISSED;

/** The exact line written when a person proposes their own revision of an option. */
export const RECOMMENDATION_REVISED_REASON = CASE_EVENT_REASONS.RECOMMENDATION_REVISED;

/**
 * True when this log row records a recommendation event of the given kind.
 *
 * THE DEDICATED MEMBERS NOW EXIST. Each of the four responses has its own
 * `OperationalObservationType`, so this reads a governed enum rather than an
 * English sentence. The kind names line up with the type names on purpose, and
 * `case-observation.ts` holds the mapping — including how the pre-migration rows
 * were written, which is the only reason any prose is compared at all any more.
 */
export function isRecommendationEvent(
  observation: { observationType: string; reason: string | null },
  kind: 'RECORDED' | RecommendationResponse,
): boolean {
  return isCaseEvent(observation, `RECOMMENDATION_${kind}` as const);
}

// --- Tradeoff re-evaluation: the extension point, and nothing more ---------------------------

/**
 * What changes when a person reorders or edits a sequence.
 *
 * DETERMINISTIC, AND DELIBERATELY NARROW. Given the machine's option and a
 * person's revision of it, this reports what MOVED -- steps added, removed,
 * reordered -- and the factors whose comparison could therefore change. It does
 * NOT say what the new tradeoff is: "contacting the buyer first reduces
 * relationship risk but delays revenue protection" is a business judgement, and
 * asserting it from a diff would be manufacturing the reasoning this whole stage
 * exists to refuse.
 *
 * THIS IS THE EXTENSION POINT. When a model is added, it reasons over exactly
 * this structure and the factor profiles above -- governed facts, not free text --
 * and whatever it produces is stored with `author: 'MODEL'` so it can never be
 * mistaken for a measurement.
 */
export interface SequenceRevision {
  /** Steps in the revision that were not in the original, by statement. */
  added: readonly string[];
  /** Steps in the original that the revision dropped. */
  removed: readonly string[];
  /** Steps present in both whose position changed. */
  reordered: readonly { statement: string; from: number; to: number }[];
  /** True when the two sequences are the same steps in the same order. */
  unchanged: boolean;
}

/** What a person changed about a proposed sequence. Pure set arithmetic. */
export function diffSequence(
  original: readonly RecommendedAction[],
  revised: readonly RecommendedAction[],
): SequenceRevision {
  const originalByStatement = new Map(original.map((a) => [a.statement, a.position]));
  const revisedByStatement = new Map(revised.map((a) => [a.statement, a.position]));

  const added = revised.filter((a) => !originalByStatement.has(a.statement)).map((a) => a.statement);
  const removed = original.filter((a) => !revisedByStatement.has(a.statement)).map((a) => a.statement);
  const reordered: { statement: string; from: number; to: number }[] = [];
  for (const a of original) {
    const to = revisedByStatement.get(a.statement);
    if (to !== undefined && to !== a.position) {
      reordered.push({ statement: a.statement, from: a.position, to });
    }
  }

  return {
    added,
    removed,
    reordered,
    unchanged: added.length === 0 && removed.length === 0 && reordered.length === 0,
  };
}

/**
 * Which comparisons a revision could have changed.
 *
 * STATES THE QUESTION, NEVER THE ANSWER. Reordering steps cannot change how well
 * established the finding is, so EVIDENCE_STRENGTH is never listed. Everything
 * else is a factor a person should re-weigh, and Loop says so without claiming to
 * know which way it moved.
 */
export function factorsAffectedBy(revision: SequenceRevision): readonly RecommendationFactor[] {
  if (revision.unchanged) return [];
  return RECOMMENDATION_FACTORS.filter((f) => f !== 'EVIDENCE_STRENGTH');
}

/** Ranks by the platform's existing evidence-strength ordering. Re-exported for surfaces. */
export { EVIDENCE_STRENGTH_RANK };
export type { EvidenceStrength, RecommendationVerb };

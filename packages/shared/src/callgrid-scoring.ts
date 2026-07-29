// The Intelligence Score — the one ordering used everywhere a finding competes
// for attention.
//
// WHY THIS EXISTS
// Severity alone cannot order an executive brief. A CRITICAL finding over 40% of
// data, about an entity that has behaved this way for six straight periods, does
// not deserve the top slot over a HIGH finding that is fully evidenced, new, and
// still moving. Ordering has to weigh magnitude, trust, novelty and urgency
// together, and it has to do so the same way on every surface.
//
// WHAT IT IS NOT
// It is not a value, a cost, or a forecast. It orders ATTENTION. A score of 82 does
// not mean "$82" or "82% likely" — it means this should be read before the 61.
//
// THE HONESTY RULE THAT SHAPES THE WHOLE FILE
// A component whose input is missing is NOT scored zero. Zero would mean "measured,
// and it contributed nothing", which is a claim. An unmeasurable component is
// WITHHELD: it leaves both the numerator and the denominator, and its absence is
// recorded on the result so the surface can say which parts of the score could not
// be computed. This is the same rule the metric layer applies to money, applied to
// judgement.

import {
  SEVERITY_RANK,
  type CallGridFinding,
  type Severity,
} from './callgrid-intelligence';

export const INTELLIGENCE_SCORE_VERSION = 'v1';

export type ScoreComponentId = 'impact' | 'confidence' | 'novelty' | 'urgency' | 'reviewPriority';

export interface ScoreComponent {
  id: ScoreComponentId;
  /** Points earned. Null when the component could not be measured. */
  points: number | null;
  /** Points available for this component. */
  max: number;
  /** False when the inputs this component needs were absent. */
  available: boolean;
  /** Why it scored what it scored — shown in the evidence drawer verbatim. */
  explanation: string;
}

export interface IntelligenceScore {
  /** 0–100, normalized over the components that could actually be measured. */
  score: number;
  components: ScoreComponent[];
  /** Component ids that could not be measured — never silently treated as zero. */
  unmeasured: ScoreComponentId[];
  /**
   * Share of the total weight that was measurable. Below 1 the ordering is made
   * on partial information and the surface must be able to say so.
   */
  determinacy: number;
  formulaVersion: string;
}

export interface ScoreInputs {
  finding: CallGridFinding;
  /**
   * How many of the last `recurrenceWindow` comparable periods ALSO produced this
   * rule for this entity. Null when no history is loaded — novelty is then
   * unmeasurable, not "novel".
   */
  recurrenceCount: number | null;
  recurrenceWindow: number | null;
  /**
   * Total revenue of the selected window, for scaling a money move into a share of
   * the business. Null when revenue is unknown — impact then falls back to severity
   * alone and says so.
   */
  windowRevenueCents: number | null;
}

const WEIGHTS: Record<ScoreComponentId, number> = {
  impact: 40,
  confidence: 20,
  novelty: 15,
  urgency: 15,
  reviewPriority: 10,
};

const SEVERITY_FRACTION: Record<Severity, number> = {
  CRITICAL: 1,
  HIGH: 0.72,
  NOTABLE: 0.42,
  INFORMATIONAL: 0.15,
};

/**
 * Impact — how much of the business this finding moves.
 *
 * Preferred basis is the move as a SHARE of window revenue, because $3,000 means
 * something different in a $9,000 week than in a $900,000 one. Severity is the
 * fallback basis when there is no revenue denominator, and the explanation names
 * which basis was used so the two are never confused.
 */
function impactComponent(inputs: ScoreInputs): ScoreComponent {
  const { finding, windowRevenueCents } = inputs;
  const max = WEIGHTS.impact;
  const severityFloor = SEVERITY_FRACTION[finding.severity];

  const move = finding.absoluteChange;
  const denominator = windowRevenueCents;
  const isMoney = finding.primaryMetric === 'revenue' || finding.primaryMetric === 'profit';

  if (isMoney && move !== null && denominator !== null && denominator > 0) {
    const share = Math.min(1, Math.abs(move) / denominator);
    // A move worth a third of the window's revenue is full impact. Beyond that the
    // scale saturates — there is no meaningful difference in urgency between 40%
    // and 80% of revenue moving; both are the most important thing on the page.
    const scaled = Math.min(1, share / 0.33);
    // Severity is a floor, never a ceiling: a CRITICAL finding cannot be demoted
    // to trivial impact just because the window happened to be large.
    const fraction = Math.max(scaled, severityFloor * 0.6);
    return {
      id: 'impact',
      points: Math.round(fraction * max),
      max,
      available: true,
      explanation:
        `Moved ${fmtMoney(Math.abs(move))} against ${fmtMoney(denominator)} of window revenue ` +
        `(${Math.round(share * 100)}% of the period), graded on a scale that saturates at 33%.`,
    };
  }

  // No money denominator: severity is the only honest basis.
  return {
    id: 'impact',
    points: Math.round(severityFloor * max),
    max,
    available: true,
    explanation:
      denominator === null && isMoney
        ? `Graded from severity (${finding.severity}) alone — window revenue is unknown, so the move could not be scaled against the business.`
        : `Graded from severity (${finding.severity}) — this metric has no monetary denominator.`,
  };
}

/** Confidence — the finding's own deterministic confidence, carried into the ordering. */
function confidenceComponent(inputs: ScoreInputs): ScoreComponent {
  const max = WEIGHTS.confidence;
  const c = inputs.finding.confidence;
  return {
    id: 'confidence',
    points: Math.round(c * max),
    max,
    available: true,
    explanation: `Finding confidence ${Math.round(c * 100)}%, derived from data coverage and sample size.`,
  };
}

/**
 * Novelty — is this new information, or the sixth period in a row of the same thing?
 *
 * UNMEASURABLE WITHOUT HISTORY. A single comparison period cannot distinguish
 * "new" from "ongoing", and guessing would be the exact fabrication this engine
 * exists to prevent. With no series loaded the component is withheld.
 */
function noveltyComponent(inputs: ScoreInputs): ScoreComponent {
  const max = WEIGHTS.novelty;
  const { recurrenceCount, recurrenceWindow } = inputs;

  if (recurrenceCount === null || recurrenceWindow === null || recurrenceWindow <= 0) {
    return {
      id: 'novelty',
      points: null,
      max,
      available: false,
      explanation:
        'Not measurable: no historical series is loaded, so Loop cannot tell whether this is new or ongoing.',
    };
  }

  // Never seen before in the observed series → fully novel. Seen in every period →
  // no novelty, because it is the standing state of the business rather than news.
  const rate = Math.min(1, recurrenceCount / recurrenceWindow);
  const fraction = 1 - rate;
  return {
    id: 'novelty',
    points: Math.round(fraction * max),
    max,
    available: true,
    explanation:
      recurrenceCount === 0
        ? `Not observed in the previous ${recurrenceWindow} comparable periods — this is new.`
        : `Observed in ${recurrenceCount} of the previous ${recurrenceWindow} comparable periods — an ongoing pattern, not news.`,
  };
}

/**
 * Urgency — does this get worse if left alone?
 *
 * Deliberately conservative. Loop cannot see routing, caps or demand, so it never
 * claims something is deteriorating; it scores the properties it CAN observe:
 * direction, severity, and whether the finding concerns a live (still-moving)
 * window.
 */
function urgencyComponent(inputs: ScoreInputs): ScoreComponent {
  const max = WEIGHTS.urgency;
  const f = inputs.finding;

  let fraction = SEVERITY_FRACTION[f.severity] * 0.5;
  const reasons: string[] = [`severity ${f.severity}`];

  const adverse =
    (f.percentageChange !== null && f.percentageChange < 0 &&
      (f.primaryMetric === 'revenue' || f.primaryMetric === 'profit' || f.primaryMetric === 'totalCalls')) ||
    f.findingType === 'RISK' ||
    f.findingType === 'ANOMALY';

  if (adverse) {
    fraction += 0.3;
    reasons.push('adverse direction');
  }
  if (f.findingType === 'CONCENTRATION') {
    fraction += 0.15;
    reasons.push('dependency concentration');
  }
  if (f.actionSafety === 'INSUFFICIENT_EVIDENCE') {
    // Nothing can be done with it yet, so it should not crowd out actionable work.
    fraction -= 0.2;
    reasons.push('insufficient evidence to act');
  }

  fraction = Math.max(0, Math.min(1, fraction));
  return {
    id: 'urgency',
    points: Math.round(fraction * max),
    max,
    available: true,
    explanation: `Graded from observable properties only (${reasons.join(', ')}). Loop does not claim deterioration it cannot see.`,
  };
}

/** Review priority — is there a safe, specific thing a person can go and check? */
function reviewComponent(inputs: ScoreInputs): ScoreComponent {
  const max = WEIGHTS.reviewPriority;
  const f = inputs.finding;
  if (!f.recommendedReview) {
    return {
      id: 'reviewPriority',
      points: 0,
      max,
      available: true,
      explanation: 'No review is recommended for this finding, so it carries no review priority.',
    };
  }
  const fraction =
    f.actionSafety === 'SAFE_TO_REVIEW' ? 1 :
    f.actionSafety === 'REQUIRES_HUMAN_JUDGMENT' ? 0.6 :
    0.2;
  return {
    id: 'reviewPriority',
    points: Math.round(fraction * max),
    max,
    available: true,
    explanation: `A specific review is available and classified ${f.actionSafety}.`,
  };
}

/**
 * Score one finding.
 *
 * Normalized over MEASURED weight only, so a finding is never punished for an
 * input the platform could not load. `determinacy` reports how much of the scale
 * was actually available.
 */
export function scoreFinding(inputs: ScoreInputs): IntelligenceScore {
  const components = [
    impactComponent(inputs),
    confidenceComponent(inputs),
    noveltyComponent(inputs),
    urgencyComponent(inputs),
    reviewComponent(inputs),
  ];

  const measured = components.filter((c) => c.available);
  const totalMax = measured.reduce((s, c) => s + c.max, 0);
  const earned = measured.reduce((s, c) => s + (c.points ?? 0), 0);
  const allMax = components.reduce((s, c) => s + c.max, 0);

  return {
    score: totalMax === 0 ? 0 : Math.round((earned / totalMax) * 100),
    components,
    unmeasured: components.filter((c) => !c.available).map((c) => c.id),
    determinacy: allMax === 0 ? 0 : Math.round((totalMax / allMax) * 100) / 100,
    formulaVersion: INTELLIGENCE_SCORE_VERSION,
  };
}

/** A finding paired with its score — the unit every attention-ordered surface renders. */
export interface ScoredFinding {
  finding: CallGridFinding;
  score: IntelligenceScore;
}

/**
 * Order by score, then severity, then confidence, then id.
 *
 * The final id tiebreak matters: without it two equally-scored findings could
 * swap places between renders, and an executive brief that reorders itself on
 * refresh is not trustworthy.
 */
export function byIntelligenceScore(a: ScoredFinding, b: ScoredFinding): number {
  if (b.score.score !== a.score.score) return b.score.score - a.score.score;
  const sev = SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity];
  if (sev !== 0) return sev;
  if (b.finding.confidence !== a.finding.confidence) return b.finding.confidence - a.finding.confidence;
  return a.finding.id.localeCompare(b.finding.id);
}

/** Score and rank a set of findings in one pass. */
export function rankFindings(
  findings: readonly CallGridFinding[],
  context: {
    windowRevenueCents: number | null;
    /** ruleId+entity → how many prior periods also produced it. Empty when no history. */
    recurrence: ReadonlyMap<string, number> | null;
    recurrenceWindow: number | null;
  },
): ScoredFinding[] {
  return findings
    .map((finding) => ({
      finding,
      score: scoreFinding({
        finding,
        windowRevenueCents: context.windowRevenueCents,
        recurrenceCount: context.recurrence
          ? context.recurrence.get(recurrenceKey(finding)) ?? 0
          : null,
        recurrenceWindow: context.recurrence ? context.recurrenceWindow : null,
      }),
    }))
    .sort(byIntelligenceScore);
}

/**
 * The identity a finding recurs under: its rule plus the entity it is about.
 *
 * Rule alone would collapse "Buyer A declined" and "Buyer B declined" into one
 * recurring pattern, which would wrongly mark a brand-new buyer's decline as
 * ongoing.
 */
export function recurrenceKey(finding: CallGridFinding): string {
  const entity = finding.affectedEntities[0]?.entityId ?? finding.affectedEntities[0]?.entityName ?? 'window';
  return `${finding.ruleId}::${entity}`;
}

function fmtMoney(cents: number): string {
  return '$' + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
}

// @emgloop/intelligence — the reusable Intelligence Module framework.
//
// INTELLIGENCE MODULE 1 established the pattern the platform will repeat: an
// Intelligence Module takes windowed, sensor-neutral facts and produces one
// standard OUTPUT that the Executive Briefing consumes. Today only CallGrid
// exists; tomorrow "In My City Intelligence" or "Talent Intelligence" implement
// the SAME `IntelligenceModule` contract and the briefing simply reads their
// outputs — no briefing rewrite per module.
//
// Design law (inherited from the Platform Constitution and @emgloop/brain):
//   - The Brain owns decisions. Every opportunity/risk a module emits IS a
//     `RecommendationEnvelope` and every insight IS a `BrainActivity` — the
//     canonical, fully-explainable Brain contracts, never a stripped-down copy.
//   - "Unknown" is a first-class answer. A module NEVER fabricates a metric,
//     a recommendation, or a trend. When evidence is absent it says
//     "Not enough data" via `notEnoughData()` and carries `missingEvidence`.
//   - Pure & deterministic. A module is a function over caller-supplied facts +
//     a caller-supplied clock/id prefix; it does no I/O, reads no real clock,
//     and given the same input returns the same output.
//
// Revenue is deliberately the ONLY headline metric. Everything else a module
// produces is EXPLANATION — what changed, why, what to do — not another KPI.

import type { Confidence, Evidence, Priority } from '@emgloop/brain';
import type { RecommendationEnvelope, BrainActivity } from '@emgloop/brain';

// ---------------------------------------------------------------------------
// Time & change primitives.
// ---------------------------------------------------------------------------

/** The window a module reasoned over, plus the prior window it compared against
 * (absent when there is no comparable prior period — then "what changed" is
 * honestly "Not enough data" rather than a fabricated delta). */
export interface IntelligenceTimeWindow {
  /** Human label, e.g. "Last 7 days". */
  label: string;
  /** ISO start of the current window (inclusive). */
  since: string;
  /** ISO end of the current window (exclusive). */
  until: string;
  /** ISO start of the prior comparison window, when one exists. */
  priorSince?: string;
  /** ISO end of the prior comparison window, when one exists. */
  priorUntil?: string;
}

export type ChangeDirection = 'up' | 'down' | 'flat';
export type ChangeSignificance = 'minor' | 'notable' | 'major';
export type MetricUnit = 'usd_cents' | 'percent' | 'count' | 'ratio';

/**
 * ONE thing that changed between the prior and current window. This is NOT a
 * metric readout — it is a CHANGE, stated as a fact. `changePercent` is
 * `undefined` (never 0-filled) when the prior value was 0, because a percentage
 * change from zero is undefined, not infinite — honesty over a fake number.
 */
export interface IntelligenceChange {
  /** Machine key, e.g. 'revenue' | 'qualified_rate' | 'margin'. */
  metric: string;
  /** Optional subject the change is about, e.g. 'buyer:Acme Insurance'. */
  subject?: string;
  /** Plain-language phrasing, e.g. "Qualified-call rate fell". */
  label: string;
  direction: ChangeDirection;
  /** Current-window value, in `unit`. */
  current: number;
  /** Prior-window value, in `unit`. */
  prior: number;
  /** Signed percentage change; undefined when prior is 0 (undefined, not faked). */
  changePercent?: number;
  unit: MetricUnit;
  /** How much this change matters, graded by deterministic thresholds. */
  significance: ChangeSignificance;
}

// ---------------------------------------------------------------------------
// Optimization actions (the concrete "do this" layer).
// ---------------------------------------------------------------------------

export type OptimizationKind =
  | 'increase'
  | 'decrease'
  | 'pause'
  | 'negotiate'
  | 'scale'
  | 'reallocate';

/** A single, evidence-backed tuning action on a marketplace lever. Every field
 * the mission requires — reason, expected impact, confidence — is mandatory. */
export interface OptimizationAction {
  kind: OptimizationKind;
  /** Machine target, e.g. 'source:XYZ' | 'buyer:Acme' | 'campaign:Spring'. */
  target: string;
  /** Human label for the target. */
  targetLabel: string;
  /** Why — the diagnosis in plain language, grounded in the numbers. */
  reason: string;
  /** Expected impact of acting, stated honestly (may be directional). */
  expectedImpact: string;
  confidence: Confidence;
  /** The real rows behind this action. */
  evidence: Evidence[];
}

// ---------------------------------------------------------------------------
// Non-economic intelligence sections. Each carries an explicit "not enough
// data" reason instead of an empty silence, so a consumer always knows WHY a
// section is empty.
// ---------------------------------------------------------------------------

/** Deterministic, extraction-only transcript intelligence. NEVER a summary of a
 * transcript — structured signals pulled from one. Absent transcripts →
 * available:false with a reason, never invented intent. */
export interface TranscriptIntelligence {
  available: boolean;
  /** How many transcripts were actually analyzed (0 when none exist). */
  analyzed: number;
  /** Extracted intent distribution, when transcripts exist. */
  intents: { intent: string; count: number }[];
  /** Most common rejection/objection causes extracted from transcripts. */
  rejectionCauses: { cause: string; count: number }[];
  /** Buying-signal / appointment-likelihood counts, extraction-only. */
  buyingSignals: { signal: string; count: number }[];
  /** Present when available:false — states exactly why (e.g. sensor sends none). */
  notEnoughDataReason?: string;
}

export interface MarketObservation {
  label: string;
  detail: string;
  confidence: Confidence;
}

export interface MarketIntelligence {
  observations: MarketObservation[];
  notEnoughDataReason?: string;
}

export interface PredictiveProjection {
  /** What is projected, e.g. 'If nothing changes, margin declines next period'. */
  statement: string;
  metric: string;
  /** Projected value in `unit`, when estimable; undefined when not. */
  projected?: number;
  unit: MetricUnit;
  confidence: Confidence;
  /** The basis of the projection, stated plainly (e.g. "linear from a 1-period
   * trend" — low confidence by construction). */
  basis: string;
}

export interface PredictiveIntelligence {
  projections: PredictiveProjection[];
  notEnoughDataReason?: string;
}

// ---------------------------------------------------------------------------
// The module output — the ONE shape the Executive Briefing consumes.
// ---------------------------------------------------------------------------

/** The single revenue headline. Revenue is the only KPI the briefing shows;
 * every other field on the module output is explanation. Values are `null`, not
 * 0, when revenue evidence is absent — an unmeasured business is not a $0 one. */
export interface RevenueHeadline {
  currentCents: number | null;
  priorCents: number | null;
  changePercent: number | null;
  direction: ChangeDirection;
}

/** How much of the window the module could actually see, so confidence and the
 * executive summary can be honest about coverage. */
export interface DataCoverage {
  calls: number;
  /** Calls in the window that carried a revenue value (economics coverage). */
  callsWithRevenue: number;
  /** True when a prior comparison window was available. */
  hasPrior: boolean;
  /** True when bid/auction report facts were supplied. */
  hasBidFacts: boolean;
  /** True when any transcript text was supplied. */
  hasTranscripts: boolean;
}

/**
 * The canonical output of ANY intelligence module. The Executive Briefing reads
 * this and only this. `opportunities`/`risks` are `RecommendationEnvelope`s and
 * `activities` are `BrainActivity`s — the Brain's own contracts — so the
 * briefing can project them through `projectBrainBriefing` without knowing a
 * single thing about CallGrid.
 */
export interface IntelligenceModuleOutput {
  /** Stable module id, e.g. 'callgrid'. */
  moduleId: string;
  /** Human label, e.g. 'CallGrid'. */
  moduleLabel: string;
  /** ISO timestamp the caller supplied (deterministic; no internal clock). */
  generatedAt: string;
  window: IntelligenceTimeWindow;
  /** The sole KPI. */
  revenue: RevenueHeadline;
  /** 4–6 sentences: what changed, why, what matters. No fluff, no fabrication. */
  executiveSummary: string[];
  /** Upside worth pursuing. Each is a fully-explained Brain recommendation. */
  opportunities: RecommendationEnvelope[];
  /** Downside worth heading off. Each is a fully-explained Brain recommendation. */
  risks: RecommendationEnvelope[];
  /** Changes (not metrics), ranked by significance. */
  whatChanged: IntelligenceChange[];
  /** Concrete lever tuning. */
  optimizations: OptimizationAction[];
  transcriptIntelligence: TranscriptIntelligence;
  marketIntelligence: MarketIntelligence;
  predictiveIntelligence: PredictiveIntelligence;
  /** Every opportunity/risk as a BrainActivity, for briefing projection. */
  activities: BrainActivity[];
  /** Overall confidence in this module's read, [0,1]. 0 when it saw nothing. */
  confidence: Confidence;
  /** Open questions the module could not resolve. */
  unknowns: string[];
  /** Evidence the module wished it had (drives "not enough data"). */
  missingEvidence: string[];
  coverage: DataCoverage;
}

/** The contract every intelligence module implements. */
export interface IntelligenceModule<TInput> {
  readonly id: string;
  readonly label: string;
  /** Pure: identity/time are supplied so the run is reproducible. */
  run(input: TInput, ctx: IntelligenceRunContext): IntelligenceModuleOutput;
}

/** Deterministic identity/time a module run is given (never read internally). */
export interface IntelligenceRunContext {
  now: Date;
  /** Prefix for generated activity ids, so ids are stable and traceable. */
  idPrefix: string;
}

// ---------------------------------------------------------------------------
// Small honesty/number helpers shared across modules. Pure.
// ---------------------------------------------------------------------------

export const PERCENT_SIGNIFICANCE = { notable: 10, major: 25 } as const;

/** Signed percentage change from prior→current. Returns `undefined` when prior
 * is 0 — a change from nothing has no defined percentage, and we refuse to
 * invent one. */
export function changePercent(current: number, prior: number): number | undefined {
  if (prior === 0) return undefined;
  return ((current - prior) / Math.abs(prior)) * 100;
}

/** Direction of a change with a small dead-band so trivial noise reads 'flat'. */
export function directionOf(current: number, prior: number, deadBand = 0): ChangeDirection {
  const d = current - prior;
  if (Math.abs(d) <= deadBand) return 'flat';
  return d > 0 ? 'up' : 'down';
}

/** Grade a percentage magnitude into a significance band (deterministic). */
export function significanceOf(pct: number | undefined): ChangeSignificance {
  if (pct === undefined) return 'notable';
  const mag = Math.abs(pct);
  if (mag >= PERCENT_SIGNIFICANCE.major) return 'major';
  if (mag >= PERCENT_SIGNIFICANCE.notable) return 'notable';
  return 'minor';
}

/** A safe ratio in [0,1]; returns `undefined` when the denominator is 0 rather
 * than dividing by zero or defaulting to a misleading value. */
export function ratio(numerator: number, denominator: number): number | undefined {
  if (denominator === 0) return undefined;
  return numerator / denominator;
}

/** Coarse priority from a percentage magnitude, for ranking Brain output. */
export function priorityFromMagnitude(pct: number | undefined): Priority {
  if (pct === undefined) return 'normal';
  const mag = Math.abs(pct);
  if (mag >= 40) return 'critical';
  if (mag >= 25) return 'high';
  if (mag >= 10) return 'normal';
  return 'low';
}

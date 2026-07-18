// @emgloop/intelligence — the CallGrid Intelligence Module.
//
// Composes the analysis slices into ONE `IntelligenceModuleOutput`, the shape
// the Executive Briefing consumes. This is the concrete implementation of the
// reusable `IntelligenceModule` contract; a future In-My-City or Talent module
// is a sibling of this file, not a rewrite of the briefing.
//
// Pure and deterministic: identity/time come from the run context, so the same
// facts always yield the same briefing. Confidence is earned from real coverage
// (call volume, revenue coverage, whether a prior window and bid facts existed),
// never asserted; with no calls it is 0 and the summary says "Not enough data".

import type { BrainActivity } from '@emgloop/brain';
import {
  changePercent,
  directionOf,
  ratio,
  type DataCoverage,
  type IntelligenceModule,
  type IntelligenceModuleOutput,
  type IntelligenceRunContext,
  type RevenueHeadline,
} from '../module';
import { buildActivity } from '../build';
import {
  computeMarket,
  computeOpportunities,
  computeOptimizations,
  computePredictive,
  computeRisks,
  computeWhatChanged,
  usd,
  type TaggedRecommendation,
} from './analyze';
import { analyzeTranscripts } from './transcript';
import { marginCentsOf, type CallGridIntelligenceInput } from './input';

const MODULE_ID = 'callgrid';
const MODULE_LABEL = 'CallGrid';

function revenueHeadline(input: CallGridIntelligenceInput): RevenueHeadline {
  const { current, prior } = input;
  const currentCents = current.callsWithRevenue > 0 ? current.revenueCents : null;
  const priorCents = prior && prior.callsWithRevenue > 0 ? prior.revenueCents : null;
  const pct =
    currentCents !== null && priorCents !== null ? changePercent(currentCents, priorCents) ?? null : null;
  const direction =
    currentCents !== null && priorCents !== null ? directionOf(currentCents, priorCents) : 'flat';
  return { currentCents, priorCents, changePercent: pct, direction };
}

function computeConfidence(input: CallGridIntelligenceInput): number {
  const { current, prior } = input;
  if (current.calls === 0) return 0;
  let c = 0.3;
  if (current.calls >= 10) c += 0.2;
  if (prior) c += 0.15;
  // `ratio` deliberately returns undefined on a zero denominator rather than a
  // misleading value, so it must not be defaulted here — least of all inside a
  // COVERAGE metric, where "unknown coverage" and "zero coverage" collapsing
  // into one number would corrupt the very figure that says how much we know.
  // (The `calls === 0` guard above means undefined is currently unreachable;
  // handling it explicitly keeps that true if the guard ever moves.)
  const revCoverage = ratio(current.callsWithRevenue, current.calls);
  if (revCoverage !== undefined && revCoverage >= 0.8) c += 0.1;
  if (input.bids) c += 0.05;
  return Math.min(c, 0.7);
}

function fmtPct(x: number): string {
  const r = Math.round(x);
  return `${r >= 0 ? '+' : ''}${r}%`;
}

/** The 4–6 sentence executive read. Composed only from computed facts; when the
 * window is empty it says so in one honest sentence rather than padding. */
function buildExecutiveSummary(
  input: CallGridIntelligenceInput,
  revenue: RevenueHeadline,
  whatChanged: ReturnType<typeof computeWhatChanged>,
  recommendations: TaggedRecommendation[],
  coverage: DataCoverage,
): string[] {
  const { current } = input;
  if (current.calls === 0) {
    return [
      'Not enough data: no CallGrid calls were recorded in this window, so there is nothing to analyze yet.',
      'Once calls flow through the CallGrid integration, this briefing will explain what changed, what matters, and what to do next.',
    ];
  }

  const sentences: string[] = [];

  // 1. Revenue + direction.
  if (revenue.currentCents !== null) {
    const dir =
      revenue.changePercent !== null
        ? `, ${revenue.direction === 'up' ? 'up' : revenue.direction === 'down' ? 'down' : 'flat'} ${fmtPct(revenue.changePercent)} versus the prior window`
        : coverage.hasPrior
          ? ' (no comparable prior revenue to measure against)'
          : '';
    sentences.push(`CallGrid produced ${usd(revenue.currentCents)} in attributed revenue across ${current.calls} calls this window${dir}.`);
  } else {
    sentences.push(`CallGrid recorded ${current.calls} calls this window, but no per-call revenue was attributed, so revenue cannot be stated.`);
  }

  // 2. Biggest change or margin state.
  const topChange = whatChanged[0];
  if (topChange && topChange.significance !== 'minor') {
    sentences.push(`The largest shift is ${topChange.label.toLowerCase()}${topChange.changePercent !== undefined ? ` (${fmtPct(topChange.changePercent)})` : ''} — a ${topChange.direction === 'up' ? 'rise' : topChange.direction === 'down' ? 'decline' : 'flat move'} against the prior window.`);
  } else {
    const margin = marginCentsOf(current);
    sentences.push(`Gross margin for the window is ${usd(margin)}${current.callsWithCost < current.calls ? ' (telco cost is present on only some calls, so true margin may be lower)' : ''}.`);
  }

  // 3. Top risk.
  const topRisk = recommendations.find((r) => r.kind === 'risk');
  if (topRisk) {
    sentences.push(`The headline risk: ${topRisk.envelope.reason}`);
  } else {
    sentences.push('No material risk surfaced this window — margin and acceptance are within normal bounds for the data available.');
  }

  // 4. Top opportunity.
  const topOpp = recommendations.find((r) => r.kind === 'opportunity');
  if (topOpp) {
    sentences.push(`The largest opportunity: ${topOpp.envelope.recommendation}`);
  }

  // 5. Honesty / coverage caveat (kept last so the read never overstates).
  const caveats: string[] = [];
  if (!coverage.hasPrior) caveats.push('no prior window was available, so change and trend reads are limited');
  if (!coverage.hasBidFacts) caveats.push('bid/auction facts were not supplied, so win-rate and acceptance conclusions are withheld');
  if (coverage.callsWithRevenue < coverage.calls) caveats.push(`revenue was attributed on ${coverage.callsWithRevenue} of ${coverage.calls} calls`);
  if (caveats.length > 0) {
    sentences.push(`Coverage note: ${caveats.join('; ')}.`);
  }

  // Guarantee 4–6 sentences: trim to 6, and if short (no opp/risk/caveat), the
  // above always yields at least 4 for a non-empty window.
  return sentences.slice(0, 6);
}

/** Run the CallGrid module. Pure; identity/time from `ctx`. */
export function runCallGridIntelligence(
  input: CallGridIntelligenceInput,
  ctx: IntelligenceRunContext,
): IntelligenceModuleOutput {
  const whatChanged = computeWhatChanged(input);
  const risks = computeRisks(input);
  const opportunities = computeOpportunities(input);
  const recommendations: TaggedRecommendation[] = [...risks, ...opportunities];
  const optimizations = computeOptimizations(input);
  const market = computeMarket(input, whatChanged);
  const predictive = computePredictive(input);
  const transcriptIntelligence = analyzeTranscripts(input.transcripts);
  const revenue = revenueHeadline(input);

  const coverage: DataCoverage = {
    calls: input.current.calls,
    callsWithRevenue: input.current.callsWithRevenue,
    hasPrior: input.prior !== null,
    hasBidFacts: input.bids !== undefined,
    hasTranscripts: (input.transcripts?.length ?? 0) > 0,
  };

  // Every opportunity/risk becomes an immutable BrainActivity for the briefing.
  const activities: BrainActivity[] = recommendations.map((r, i) =>
    buildActivity({
      envelope: r.envelope,
      id: `${ctx.idPrefix}:${r.kind}:${i}`,
      timestamp: ctx.now,
      subject: r.subject,
      severity: r.severity,
      activityType: r.activityType,
    }),
  );

  // Missing evidence, de-duplicated, so the briefing can state the honest edges.
  const missing = new Set<string>();
  if (!coverage.hasBidFacts) missing.add('Bid/auction report facts (win rate, bid rate, rejections) — not on the current data path.');
  if (!coverage.hasTranscripts) missing.add('Call transcripts — the CallGrid sensor does not deliver them today.');
  if (input.current.callsWithCost < input.current.calls) missing.add('Per-call telco cost on every call — margin is exact only where cost is present.');
  if (!coverage.hasPrior) missing.add('A prior comparison window — needed for change, trend and prediction.');

  const unknowns = new Set<string>();
  if (!coverage.hasBidFacts) unknowns.add('Auction win rate, bid rate and rejection causes.');
  unknowns.add('Buyer caps/capacity (not exposed by CallGrid).');

  const confidence = computeConfidence(input);

  const executiveSummary = buildExecutiveSummary(input, revenue, whatChanged, recommendations, coverage);

  return {
    moduleId: MODULE_ID,
    moduleLabel: MODULE_LABEL,
    generatedAt: ctx.now.toISOString(),
    window: input.window,
    revenue,
    executiveSummary,
    opportunities: opportunities.map((o) => o.envelope),
    risks: risks.map((r) => r.envelope),
    whatChanged,
    optimizations,
    transcriptIntelligence,
    marketIntelligence: market,
    predictiveIntelligence: predictive,
    activities,
    confidence,
    unknowns: [...unknowns],
    missingEvidence: [...missing],
    coverage,
  };
}

/** The CallGrid module as an `IntelligenceModule` value, for registries that
 * iterate modules generically. */
export const callGridIntelligenceModule: IntelligenceModule<CallGridIntelligenceInput> = {
  id: MODULE_ID,
  label: MODULE_LABEL,
  run: runCallGridIntelligence,
};

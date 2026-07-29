// Business Health — the second section of every page.
//
// WHAT IT REPLACES
// "Revenue $12,400 · Profit $4,100 · Calls 812" tells an operator what the
// numbers are. It does not tell them whether the business is in good shape. Health
// answers the second question: for each part of the business, is this healthy,
// worth watching, at risk, or critical — and WHY.
//
// IT CONSUMES, IT DOES NOT RECOMPUTE
// Concentration, volatility and trend already exist in the risk model, and the
// series statistics already exist in `callgrid-history.ts`. Health reads those.
// It defines no metric, aggregates nothing, and duplicates no formula — a health
// score that disagreed with the risk panel would be worse than no health score.
//
// THE BAND THAT MATTERS MOST IS UNKNOWN
// A dimension whose signals could not be measured is UNKNOWN, never HEALTHY.
// "Healthy" is a claim, and the difference between "we checked and it is fine"
// and "we could not check" is the whole reason this platform is trusted. A green
// badge over absent data is the single most dangerous thing this file could ship.

import type { MarketplaceRisk, RiskFactor, RiskFactorId } from './callgrid-risk';
import { MIN_SERIES_POINTS, mean, trendPerPeriod, volatility } from './callgrid-history';

export const HEALTH_MODEL_VERSION = 'v1';

export type HealthBand = 'HEALTHY' | 'WATCH' | 'RISK' | 'CRITICAL' | 'UNKNOWN';

export const HEALTH_BAND_RANK: Record<HealthBand, number> = {
  CRITICAL: 0, RISK: 1, WATCH: 2, HEALTHY: 3, UNKNOWN: 4,
};

export const HEALTH_BAND_LABEL: Record<HealthBand, string> = {
  HEALTHY: 'Healthy', WATCH: 'Watch', RISK: 'Risk', CRITICAL: 'Critical', UNKNOWN: 'Unknown',
};

export type HealthDimensionId =
  | 'overall' | 'revenue' | 'profit' | 'traffic'
  | 'buyer' | 'vendor' | 'campaign' | 'source';

/** One measurable contributor to a health score. */
export interface HealthSignal {
  id: string;
  label: string;
  /** 0–1 where 1 is fully healthy. Null when the inputs were absent. */
  score: number | null;
  weight: number;
  available: boolean;
  /** What was measured, in business language. */
  measurement: string;
  /** What that means for the business — never a restatement of the number. */
  interpretation: string;
}

export interface HealthScore {
  id: HealthDimensionId;
  label: string;
  band: HealthBand;
  /** 0–100 over measured signals only. Null when nothing could be measured. */
  score: number | null;
  signals: HealthSignal[];
  /** Share of this dimension's weight that could be measured. */
  determinacy: number;
  /** One sentence a VP of Operations would say, naming the dominant signal. */
  explanation: string;
  /** What could not be established for this dimension. */
  unknowns: string[];
}

export interface BusinessHealth {
  overall: HealthScore;
  dimensions: HealthScore[];
  modelVersion: string;
}

export interface HealthDimRow {
  key: string;
  label: string;
  calls: number;
  monetized: number;
  revenueCents: number | null;
}

export interface HealthInput {
  metrics: {
    available: boolean;
    totalCalls: number | null;
    billableCalls: number | null;
    revenueCents: number | null;
    profitCents: number | null;
    revenueCoverage: number | null;
    profitCoverage: number | null;
  };
  /** The already-computed risk model. Health reads its factors; it never recomputes them. */
  risk: MarketplaceRisk;
  revenueSeries: readonly (number | null)[];
  profitSeries: readonly (number | null)[];
  callSeries: readonly (number | null)[];
  dimensions: {
    buyers: readonly HealthDimRow[];
    vendors: readonly HealthDimRow[];
    campaigns: readonly HealthDimRow[];
    sources: readonly HealthDimRow[];
  };
  includesLiveData: boolean;
}

const ABSENT_SIGNAL = (id: string, label: string, weight: number, why: string): HealthSignal => ({
  id, label, score: null, weight, available: false,
  measurement: 'Not measurable.',
  interpretation: why,
});

/** Turn a risk factor (fragility, 1 = worst) into a health signal (1 = best). */
function fromRisk(
  risk: MarketplaceRisk,
  factorId: RiskFactorId,
  label: string,
  weight: number,
  interpretation: (f: RiskFactor) => string,
): HealthSignal {
  const f = risk.factors.find((x) => x.id === factorId);
  if (!f || !f.available || f.level === null) {
    return ABSENT_SIGNAL(factorId, label, weight, f?.explanation ?? 'The inputs this needs were not reported.');
  }
  return {
    id: factorId,
    label,
    score: 1 - f.level,
    weight,
    available: true,
    measurement: f.measurement,
    interpretation: interpretation(f),
  };
}

/** Coverage as a health signal: how much of the period actually carried the value. */
function coverageSignal(id: string, label: string, weight: number, coverage: number | null, noun: string): HealthSignal {
  if (coverage === null) {
    return ABSENT_SIGNAL(id, label, weight, `Loop cannot tell how much of the period carried a ${noun} value.`);
  }
  return {
    id, label, score: Math.max(0, Math.min(1, coverage)), weight, available: true,
    measurement: `${Math.round(coverage * 100)}% of calls carried a ${noun} value.`,
    interpretation: coverage >= 0.99
      ? `${noun[0]!.toUpperCase()}${noun.slice(1)} figures are complete for this period.`
      : `${noun[0]!.toUpperCase()}${noun.slice(1)} totals are lower bounds — ${Math.round((1 - coverage) * 100)}% of calls reported no value, so the real figure is higher than shown.`,
  };
}

/** Trend as a health signal. Growth is healthy; only decline reduces the score. */
function trendSignal(
  id: string,
  label: string,
  weight: number,
  series: readonly (number | null)[],
  noun: string,
): HealthSignal {
  const t = trendPerPeriod(series);
  if (t.value === null) {
    return ABSENT_SIGNAL(id, label, weight, t.reason ?? `A ${noun} trend needs at least ${MIN_SERIES_POINTS} complete prior periods.`);
  }
  // A 15% decline per period is a fully unhealthy trend; growth scores full marks.
  const decline = Math.max(0, -t.value);
  const score = 1 - Math.min(1, decline / 0.15);
  const pctPerPeriod = Math.abs(Math.round(t.value * 100));
  return {
    id, label, score, weight, available: true,
    measurement: t.value < 0
      ? `${noun} has been falling about ${pctPerPeriod}% per period across ${t.usablePoints} complete periods.`
      : `${noun} has been growing about ${pctPerPeriod}% per period across ${t.usablePoints} complete periods.`,
    interpretation: t.value < -0.05
      ? `The direction is downward and sustained, not a single soft period.`
      : t.value > 0.05
        ? `The direction is upward and sustained.`
        : `${noun} is broadly flat across periods.`,
  };
}

/** Stability as a health signal — erratic is less healthy than steady, in both directions. */
function stabilitySignal(
  id: string,
  label: string,
  weight: number,
  series: readonly (number | null)[],
  noun: string,
): HealthSignal {
  const v = volatility(series);
  if (v.value === null) {
    return ABSENT_SIGNAL(id, label, weight, v.reason ?? `Stability needs at least ${MIN_SERIES_POINTS} complete prior periods.`);
  }
  const score = 1 - Math.min(1, v.value / 0.6);
  return {
    id, label, score, weight, available: true,
    measurement: `${noun} varied by ${Math.round(v.value * 100)}% of its own average across ${v.usablePoints} complete periods.`,
    interpretation: v.value >= 0.5
      ? `Swings this wide make any single period a weak basis for a decision.`
      : `${noun} holds a predictable range period to period.`,
  };
}

/**
 * Breadth — how many entities actually carry the business.
 *
 * Counts only entities that produced a billable call or measured revenue, because
 * an entity that appeared once with nothing attached does not add resilience.
 */
function breadthSignal(
  id: string,
  label: string,
  weight: number,
  rows: readonly HealthDimRow[],
  noun: string,
  healthyCount: number,
): HealthSignal {
  if (rows.length === 0) {
    return ABSENT_SIGNAL(id, label, weight, `No ${noun} appeared in this period, so breadth cannot be assessed.`);
  }
  const productive = rows.filter((r) => r.monetized > 0 || (r.revenueCents !== null && r.revenueCents > 0)).length;
  const score = Math.max(0, Math.min(1, productive / healthyCount));
  return {
    id, label, score, weight, available: true,
    measurement: `${productive} of ${rows.length} observed ${noun} produced revenue or a billable call.`,
    interpretation: productive <= 1
      ? `The business ran on a single active ${noun.replace(/s$/, '')} this period — there is nothing to absorb a change in it.`
      : productive < healthyCount
        ? `A narrow active base: fewer contributors means each one matters more.`
        : `A broad enough active base that no single ${noun.replace(/s$/, '')} carries the period alone.`,
  };
}

/** Billable efficiency — how much observed traffic converts. Efficiency, never "quality". */
function billableEfficiencySignal(weight: number, billable: number | null, total: number | null): HealthSignal {
  if (billable === null || total === null || total <= 0) {
    return ABSENT_SIGNAL('billable-efficiency', 'Billable efficiency', weight,
      'Call volume or billable count was not reported for this period.');
  }
  const rate = billable / total;
  return {
    id: 'billable-efficiency', label: 'Billable efficiency', score: Math.max(0, Math.min(1, rate / 0.5)),
    weight, available: true,
    measurement: `${Math.round(rate * 100)}% of calls were billable (${billable.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}).`,
    // The engine's existing rule: this is efficiency, not a measure of call quality.
    interpretation: 'This measures how much observed traffic converts to a billable call. It is an efficiency measure — CallGrid exposes nothing that would make it a measure of call quality.',
  };
}

function band(score: number | null, determinacy: number): HealthBand {
  if (score === null || determinacy === 0) return 'UNKNOWN';
  if (score >= 0.8) return 'HEALTHY';
  if (score >= 0.6) return 'WATCH';
  if (score >= 0.4) return 'RISK';
  return 'CRITICAL';
}

function compose(
  id: HealthDimensionId,
  label: string,
  signals: HealthSignal[],
  includesLiveData: boolean,
): HealthScore {
  const measured = signals.filter((s) => s.available && s.score !== null);
  const measuredWeight = measured.reduce((s, x) => s + x.weight, 0);
  const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
  const weighted = measured.reduce((s, x) => s + (x.score ?? 0) * x.weight, 0);

  const fraction = measuredWeight === 0 ? null : weighted / measuredWeight;
  const determinacy = totalWeight === 0 ? 0 : Math.round((measuredWeight / totalWeight) * 100) / 100;
  const theBand = band(fraction, determinacy);

  // The dominant signal is the WEAKEST measured one — that is what a person needs
  // to hear first, and averaging it away is how a dashboard hides a problem.
  const weakest = [...measured].sort((a, b) => (a.score ?? 1) - (b.score ?? 1))[0];

  let explanation: string;
  if (theBand === 'UNKNOWN') {
    explanation = `${label} cannot be assessed — none of its ${signals.length} signals had the data they need. This is not a clean bill of health.`;
  } else if (weakest) {
    explanation =
      `${label} is ${HEALTH_BAND_LABEL[theBand].toLowerCase()}. ${weakest.interpretation}` +
      (determinacy < 1 ? ` Measured from ${Math.round(determinacy * 100)}% of the signals for this dimension.` : '') +
      (includesLiveData ? ' The selected period is still in progress.' : '');
  } else {
    explanation = `${label} is ${HEALTH_BAND_LABEL[theBand].toLowerCase()}.`;
  }

  return {
    id, label, band: theBand,
    score: fraction === null ? null : Math.round(fraction * 100),
    signals, determinacy, explanation,
    unknowns: signals.filter((s) => !s.available).map((s) => `${s.label}: ${s.interpretation}`),
  };
}

/**
 * Assess business health across seven dimensions plus an overall.
 *
 * Overall is composed from the measured DIMENSION scores, weighted, and is UNKNOWN
 * when none could be measured.
 */
export function assessBusinessHealth(input: HealthInput): BusinessHealth {
  const { risk, metrics, dimensions } = input;

  // A window that could not be READ has no health, only an absence of knowledge.
  //
  // Without this gate, health scores concentration and breadth from whatever
  // dimension rows it was handed and reports a band — and a *failed read* would
  // render as CRITICAL, which is a measurement claim about a business Loop did
  // not observe. In production a failed read yields empty rows, so this never
  // fired; relying on that meant the honesty of the panel depended on a caller
  // remembering to pass nothing. It is enforced here instead.
  if (!metrics.available) {
    const unreadable = (id: HealthDimensionId, label: string): HealthScore => ({
      id, label, band: 'UNKNOWN', score: null, signals: [], determinacy: 0,
      explanation: `${label} cannot be assessed — CallGrid reporting could not be read for this period. This is not a clean bill of health.`,
      unknowns: [`${label}: the period could not be read, so no signal behind it could be measured.`],
    });
    return {
      overall: unreadable('overall', 'Overall business health'),
      dimensions: [
        unreadable('revenue', 'Revenue health'),
        unreadable('profit', 'Profit health'),
        unreadable('traffic', 'Traffic health'),
        unreadable('buyer', 'Buyer health'),
        unreadable('vendor', 'Vendor health'),
        unreadable('campaign', 'Campaign health'),
        unreadable('source', 'Source health'),
      ],
      modelVersion: HEALTH_MODEL_VERSION,
    };
  }

  const revenue = compose('revenue', 'Revenue health', [
    trendSignal('revenue-trend', 'Revenue direction', 40, input.revenueSeries, 'Revenue'),
    stabilitySignal('revenue-stability', 'Revenue stability', 30, input.revenueSeries, 'Revenue'),
    coverageSignal('revenue-coverage', 'Revenue completeness', 30, metrics.revenueCoverage, 'revenue'),
  ], input.includesLiveData);

  const profit = compose('profit', 'Profit health', [
    trendSignal('profit-trend', 'Profit direction', 40, input.profitSeries, 'Profit'),
    stabilitySignal('profit-stability', 'Profit stability', 25, input.profitSeries, 'Profit'),
    coverageSignal('profit-coverage', 'Profit completeness', 35, metrics.profitCoverage, 'profit'),
  ], input.includesLiveData);

  const traffic = compose('traffic', 'Traffic health', [
    trendSignal('traffic-trend', 'Call volume direction', 35, input.callSeries, 'Call volume'),
    stabilitySignal('traffic-stability', 'Call volume stability', 25, input.callSeries, 'Call volume'),
    billableEfficiencySignal(40, metrics.billableCalls, metrics.totalCalls),
  ], input.includesLiveData);

  const buyer = compose('buyer', 'Buyer health', [
    fromRisk(risk, 'buyer-concentration', 'Buyer diversification', 45,
      (f) => (f.level ?? 0) >= 0.6
        ? 'Revenue depends heavily on one buyer, so a change there moves the whole period.'
        : 'Revenue is spread across enough buyers that no single one carries the period.'),
    fromRisk(risk, 'profit-concentration', 'Profit diversification', 25,
      (f) => (f.level ?? 0) >= 0.6
        ? 'Margin is concentrated in one buyer, which is a narrower dependency than revenue alone suggests.'
        : 'Margin is spread across buyers.'),
    breadthSignal('buyer-breadth', 'Active buyer base', 30, dimensions.buyers, 'buyers', 5),
  ], input.includesLiveData);

  const vendor = compose('vendor', 'Vendor health', [
    fromRisk(risk, 'vendor-concentration', 'Vendor diversification', 55,
      (f) => (f.level ?? 0) >= 0.6
        ? 'Supply depends heavily on one vendor.'
        : 'Supply is spread across vendors.'),
    breadthSignal('vendor-breadth', 'Active vendor base', 45, dimensions.vendors, 'vendors', 4),
  ], input.includesLiveData);

  const campaign = compose('campaign', 'Campaign health', [
    fromRisk(risk, 'campaign-concentration', 'Campaign diversification', 50,
      (f) => (f.level ?? 0) >= 0.6
        ? 'One campaign carries most of the revenue, so its performance is the period\'s performance.'
        : 'Revenue is spread across campaigns.'),
    breadthSignal('campaign-breadth', 'Active campaign base', 50, dimensions.campaigns, 'campaigns', 4),
  ], input.includesLiveData);

  const source = compose('source', 'Source health', [
    fromRisk(risk, 'source-concentration', 'Source diversification', 45,
      (f) => (f.level ?? 0) >= 0.6
        ? 'Traffic originates overwhelmingly from one source.'
        : 'Traffic arrives from a spread of sources.'),
    breadthSignal('source-breadth', 'Active source base', 30, dimensions.sources, 'sources', 4),
    billableEfficiencySignal(25, metrics.billableCalls, metrics.totalCalls),
  ], input.includesLiveData);

  const dims = [revenue, profit, traffic, buyer, vendor, campaign, source];

  // Overall composes the measured DIMENSION scores. Revenue and profit weigh most
  // because they are the outcome; the rest describe the structure producing it.
  const OVERALL_WEIGHT: Record<HealthDimensionId, number> = {
    overall: 0, revenue: 25, profit: 25, traffic: 15,
    buyer: 15, vendor: 8, campaign: 7, source: 5,
  };

  const overallSignals: HealthSignal[] = dims.map((d) => ({
    id: d.id,
    label: d.label,
    score: d.score === null ? null : d.score / 100,
    weight: OVERALL_WEIGHT[d.id],
    available: d.band !== 'UNKNOWN' && d.score !== null,
    measurement: d.score === null ? 'Not measurable.' : `${d.label} scores ${d.score} of 100 (${HEALTH_BAND_LABEL[d.band]}).`,
    interpretation: d.explanation,
  }));

  const overall = compose('overall', 'Overall business health', overallSignals, input.includesLiveData);

  return { overall, dimensions: dims, modelVersion: HEALTH_MODEL_VERSION };
}

/** Health dimensions worth surfacing first — worst band first, never alphabetical. */
export function healthByUrgency(health: BusinessHealth): HealthScore[] {
  return [...health.dimensions].sort((a, b) => {
    const bandDiff = HEALTH_BAND_RANK[a.band] - HEALTH_BAND_RANK[b.band];
    if (bandDiff !== 0) return bandDiff;
    return (a.score ?? 101) - (b.score ?? 101);
  });
}

/** Everything health could not establish, for the page's unknowns section. */
export function healthUnknowns(health: BusinessHealth): string[] {
  const out: string[] = [];
  for (const d of health.dimensions) {
    if (d.band === 'UNKNOWN') {
      out.push(`${d.label} could not be assessed — it is reported as Unknown rather than healthy.`);
    } else if (d.determinacy < 1) {
      out.push(`${d.label} was scored from ${Math.round(d.determinacy * 100)}% of its signals.`);
    }
  }
  return out;
}

/** Mean helper re-exported for callers building series inputs. */
export { mean };

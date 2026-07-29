// The Marketplace Risk Score.
//
// WHAT IT MEASURES
// Structural fragility — how exposed the marketplace is to one thing going wrong.
// It is NOT a prediction, a probability of loss, or a judgement of anyone's
// performance. A high score does not mean something bad is happening; it means
// that if it did, there is little to absorb it.
//
// THE TRAP THIS FILE AVOIDS
// A composite score is the easiest place in a product to fabricate. Roll nine
// factors into one number, let the missing ones default to zero, and you get a
// reassuring "LOW" built mostly out of data you never had. So: a factor that
// cannot be measured is WITHHELD from both the numerator and the denominator, it
// is named in `unmeasured`, and `determinacy` reports how much of the model
// actually ran. A score computed from three of nine factors says so.
//
// CONCENTRATION IS DEPENDENCY, NOT FAULT
// Every concentration factor describes the SHAPE of the business, never the
// intentions of a counterparty. Loop cannot see a buyer's plans, contracts or
// capacity, so it never suggests one is likely to leave, reduce, or renegotiate.

import type { CallGridFinding } from './callgrid-intelligence';
import { volatility, trendPerPeriod, MIN_SERIES_POINTS, type SeriesStat } from './callgrid-history';

export const RISK_MODEL_VERSION = 'v1';

export type RiskBand = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';

export const RISK_BAND_RANK: Record<RiskBand, number> = {
  CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3,
};

export type RiskFactorId =
  | 'buyer-concentration'
  | 'vendor-concentration'
  | 'source-concentration'
  | 'campaign-concentration'
  | 'profit-concentration'
  | 'revenue-volatility'
  | 'revenue-trend'
  | 'bid-rejection'
  | 'rate-limiting';

export interface RiskFactor {
  id: RiskFactorId;
  label: string;
  /** 0–1 fragility contribution. Null when the inputs were absent. */
  level: number | null;
  weight: number;
  available: boolean;
  /** The measured quantity in plain language — what the level was derived FROM. */
  measurement: string;
  /** Why this shape is fragile, stated without predicting anyone's behaviour. */
  explanation: string;
  /** What this factor specifically cannot tell you. */
  unknowns: string[];
}

export interface MarketplaceRisk {
  band: RiskBand;
  /** 0–100 over MEASURED weight only. */
  score: number;
  factors: RiskFactor[];
  unmeasured: RiskFactorId[];
  /** Share of the model's total weight that could be measured. */
  determinacy: number;
  /** One sentence naming the dominant contributor, or the absence of evidence. */
  headline: string;
  /** The factors that drove the band, strongest first. */
  drivers: RiskFactor[];
  modelVersion: string;
}

export interface RiskDimRow {
  key: string;
  label: string;
  calls: number;
  revenueCents: number | null;
  marginCents: number | null;
}

export interface RiskInput {
  /** Rows per dimension, revenue-desc, from the canonical report. */
  buyers: readonly RiskDimRow[];
  vendors: readonly RiskDimRow[];
  sources: readonly RiskDimRow[];
  campaigns: readonly RiskDimRow[];
  windowRevenueCents: number | null;
  /** Revenue across prior complete periods, most-recent-first. Empty when no history. */
  revenueSeries: readonly (number | null)[];
  /** Provider-reported reject rate across bid sources, 0–1. Null when unreported. */
  bidRejectRate: number | null;
  /** Rate-limited outcomes as a share of all observed destination failures, 0–1. */
  rateLimitedShare: number | null;
  /** True when the selected window is still in progress. */
  includesLiveData: boolean;
}

const WEIGHTS: Record<RiskFactorId, number> = {
  'buyer-concentration': 20,
  'profit-concentration': 15,
  'vendor-concentration': 12,
  'source-concentration': 12,
  'campaign-concentration': 8,
  'revenue-volatility': 12,
  'revenue-trend': 9,
  'bid-rejection': 6,
  'rate-limiting': 6,
};

/**
 * Top-1 share of a dimension's measured total.
 *
 * Rows with unknown value are EXCLUDED from both numerator and denominator rather
 * than counted as zero — an unpriced buyer must not inflate the leader's apparent
 * share, which would manufacture concentration risk out of missing data.
 */
export function topShare(
  rows: readonly RiskDimRow[],
  field: 'revenueCents' | 'marginCents' | 'calls',
): { share: number | null; leader: string | null; measuredRows: number; totalRows: number } {
  const measured = rows
    .map((r) => ({ label: r.label, value: field === 'calls' ? r.calls : r[field] }))
    .filter((r): r is { label: string; value: number } => r.value !== null && Number.isFinite(r.value) && r.value > 0);

  const total = measured.reduce((s, r) => s + r.value, 0);
  if (measured.length === 0 || total <= 0) {
    return { share: null, leader: null, measuredRows: measured.length, totalRows: rows.length };
  }
  const top = measured.reduce((a, b) => (b.value > a.value ? b : a));
  return { share: top.value / total, leader: top.label, measuredRows: measured.length, totalRows: rows.length };
}

/**
 * Map a concentration share to a fragility level.
 *
 * Below 35% of a dimension in one entity is an ordinary marketplace. The curve
 * rises through 50% and saturates at 85%, past which the distinction between
 * "very concentrated" and "almost entirely one entity" changes nothing about what
 * a person should do.
 */
function concentrationLevel(share: number): number {
  if (share <= 0.35) return Math.max(0, (share / 0.35) * 0.25);
  if (share >= 0.85) return 1;
  return 0.25 + ((share - 0.35) / 0.5) * 0.75;
}

function concentrationFactor(
  id: RiskFactorId,
  label: string,
  rows: readonly RiskDimRow[],
  field: 'revenueCents' | 'marginCents',
  noun: string,
): RiskFactor {
  const { share, leader, measuredRows, totalRows } = topShare(rows, field);
  const weight = WEIGHTS[id];
  const valueWord = field === 'marginCents' ? 'profit' : 'revenue';

  if (share === null) {
    return {
      id, label, level: null, weight, available: false,
      measurement: `No ${noun} carried a measured ${valueWord} value in this period.`,
      explanation: `Concentration cannot be computed without at least one measured ${valueWord} figure.`,
      unknowns: [`Whether ${noun} ${valueWord} is concentrated — ${measuredRows} of ${totalRows} rows carried a value.`],
    };
  }

  const unknowns = [
    `Whether this concentration is intentional. Loop cannot see contracts, caps, or commercial arrangements.`,
  ];
  if (measuredRows < totalRows) {
    unknowns.push(
      `${totalRows - measuredRows} of ${totalRows} ${noun} carried no ${valueWord} value and were excluded, so the true share may differ.`,
    );
  }

  return {
    id, label, level: concentrationLevel(share), weight, available: true,
    measurement: `${leader} accounts for ${Math.round(share * 100)}% of measured ${noun} ${valueWord} (${measuredRows} of ${totalRows} rows measured).`,
    explanation:
      `The more of ${valueWord} that sits with one ${noun.replace(/s$/, '')}, the less there is to absorb a change in it. ` +
      `This describes dependency, not any expectation about that ${noun.replace(/s$/, '')}'s behaviour.`,
    unknowns,
  };
}

function volatilityFactor(series: readonly (number | null)[]): RiskFactor {
  const id: RiskFactorId = 'revenue-volatility';
  const weight = WEIGHTS[id];
  const v: SeriesStat = volatility(series);
  if (v.value === null) {
    return {
      id, label: 'Revenue volatility', level: null, weight, available: false,
      measurement: 'Not measurable.',
      explanation: v.reason ?? `Volatility needs at least ${MIN_SERIES_POINTS} complete prior periods.`,
      unknowns: ['Whether revenue is stable or erratic across periods.'],
    };
  }
  // A coefficient of variation of 0.6 is a business whose revenue routinely swings
  // by more than half its own average — treated as full fragility on this factor.
  const level = Math.max(0, Math.min(1, v.value / 0.6));
  return {
    id, label: 'Revenue volatility', level, weight, available: true,
    measurement: `Revenue varied by ${Math.round(v.value * 100)}% of its own average across ${v.usablePoints} complete prior periods.`,
    explanation: 'Wide period-to-period swings make any single period a weak basis for a decision.',
    unknowns: ['Whether the variation is seasonal, operational, or driven by a single entity.'],
  };
}

function trendFactor(series: readonly (number | null)[]): RiskFactor {
  const id: RiskFactorId = 'revenue-trend';
  const weight = WEIGHTS[id];
  const t: SeriesStat = trendPerPeriod(series);
  if (t.value === null) {
    return {
      id, label: 'Revenue trend', level: null, weight, available: false,
      measurement: 'Not measurable.',
      explanation: t.reason ?? `A trend needs at least ${MIN_SERIES_POINTS} complete prior periods.`,
      unknowns: ['The direction of revenue across periods.'],
    };
  }
  // Only a DECLINING trend contributes fragility. Growth is not risk, and scoring
  // it as such would be the model quietly punishing a healthy business.
  const decline = Math.max(0, -t.value);
  const level = Math.min(1, decline / 0.15);
  return {
    id, label: 'Revenue trend', level, weight, available: true,
    measurement:
      t.value < 0
        ? `Revenue declined by about ${Math.round(Math.abs(t.value) * 100)}% per period across ${t.usablePoints} complete prior periods.`
        : `Revenue grew by about ${Math.round(t.value * 100)}% per period across ${t.usablePoints} complete prior periods.`,
    explanation: 'A sustained decline compounds; only the declining direction contributes to risk.',
    unknowns: ['Whether the trend reflects demand, routing, pricing, or entity mix — none of which CallGrid exposes.'],
  };
}

function bidRejectionFactor(rate: number | null): RiskFactor {
  const id: RiskFactorId = 'bid-rejection';
  const weight = WEIGHTS[id];
  if (rate === null) {
    return {
      id, label: 'Bid rejection', level: null, weight, available: false,
      measurement: 'The provider did not report a reject rate for this snapshot.',
      explanation: 'Reject rate is read verbatim from the provider and is never recomputed from counts.',
      unknowns: ['The share of bid opportunities being rejected.'],
    };
  }
  return {
    id, label: 'Bid rejection', level: Math.max(0, Math.min(1, rate / 0.8)), weight, available: true,
    measurement: `The provider reported a ${Math.round(rate * 100)}% reject rate across bid sources.`,
    explanation: 'A high reject rate narrows the pool of opportunities that can convert.',
    unknowns: [
      'How much of the rejection is expected configuration working as intended, rather than a preventable loss.',
      'Bid data is a single snapshot, so this cannot be compared to an earlier period.',
    ],
  };
}

function rateLimitFactor(share: number | null): RiskFactor {
  const id: RiskFactorId = 'rate-limiting';
  const weight = WEIGHTS[id];
  if (share === null) {
    return {
      id, label: 'Rate limiting', level: null, weight, available: false,
      measurement: 'No destination failure outcomes were reported for this snapshot.',
      explanation: 'Rate limiting is a destination-grain outcome and is only known when ping stats are stored.',
      unknowns: ['The share of destination failures caused by rate limits.'],
    };
  }
  return {
    id, label: 'Rate limiting', level: Math.max(0, Math.min(1, share / 0.6)), weight, available: true,
    measurement: `Rate-limited outcomes are ${Math.round(share * 100)}% of all observed destination failures.`,
    explanation: 'Concentrated rate limiting suggests capacity is being reached at a destination rather than demand being absent.',
    unknowns: [
      'Whether the limit is configured deliberately. CallGrid exposes caps as configuration, never as a report metric.',
      'Bid and ping data is a single snapshot, so no trend can be established.',
    ],
  };
}

function band(score: number): RiskBand {
  if (score >= 75) return 'CRITICAL';
  if (score >= 55) return 'HIGH';
  if (score >= 30) return 'MODERATE';
  return 'LOW';
}

/**
 * Compute the marketplace risk score.
 *
 * Deliberately returns a LOW band with zero determinacy when nothing could be
 * measured — and the headline says exactly that, so "LOW" is never read as
 * "verified safe".
 */
export function assessMarketplaceRisk(input: RiskInput): MarketplaceRisk {
  const factors: RiskFactor[] = [
    concentrationFactor('buyer-concentration', 'Buyer concentration', input.buyers, 'revenueCents', 'buyers'),
    concentrationFactor('profit-concentration', 'Profit concentration', input.buyers, 'marginCents', 'buyers'),
    concentrationFactor('vendor-concentration', 'Vendor concentration', input.vendors, 'revenueCents', 'vendors'),
    concentrationFactor('source-concentration', 'Source concentration', input.sources, 'revenueCents', 'sources'),
    concentrationFactor('campaign-concentration', 'Campaign concentration', input.campaigns, 'revenueCents', 'campaigns'),
    volatilityFactor(input.revenueSeries),
    trendFactor(input.revenueSeries),
    bidRejectionFactor(input.bidRejectRate),
    rateLimitFactor(input.rateLimitedShare),
  ];

  const measured = factors.filter((f) => f.available && f.level !== null);
  const measuredWeight = measured.reduce((s, f) => s + f.weight, 0);
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const weighted = measured.reduce((s, f) => s + (f.level ?? 0) * f.weight, 0);
  const score = measuredWeight === 0 ? 0 : Math.round((weighted / measuredWeight) * 100);

  const drivers = [...measured].sort((a, b) => (b.level ?? 0) * b.weight - (a.level ?? 0) * a.weight);
  const determinacy = totalWeight === 0 ? 0 : Math.round((measuredWeight / totalWeight) * 100) / 100;

  let headline: string;
  if (measured.length === 0) {
    headline = 'Marketplace risk could not be assessed — none of the nine factors had the data they require.';
  } else {
    const top = drivers[0]!;
    headline =
      `Risk is ${band(score).toLowerCase()}, driven most by ${top.label.toLowerCase()}. ` +
      `${measured.length} of ${factors.length} factors could be measured` +
      (input.includesLiveData ? ', and the selected period is still in progress.' : '.');
  }

  return {
    band: band(score),
    score,
    factors,
    unmeasured: factors.filter((f) => !f.available).map((f) => f.id),
    determinacy,
    headline,
    drivers: drivers.slice(0, 3),
    modelVersion: RISK_MODEL_VERSION,
  };
}

/** Risk findings for the brief — one per factor that is materially fragile. */
export function riskFactorsWorthAttention(risk: MarketplaceRisk, threshold = 0.5): RiskFactor[] {
  return risk.drivers.filter((f) => (f.level ?? 0) >= threshold);
}

/** Unknowns the risk model itself introduces, for the page's "cannot determine" section. */
export function riskUnknowns(risk: MarketplaceRisk): string[] {
  const out: string[] = [];
  if (risk.determinacy < 1) {
    out.push(
      `The risk score was computed from ${Math.round(risk.determinacy * 100)}% of the model — ` +
      `${risk.unmeasured.length} factor(s) had no data and were excluded rather than counted as safe.`,
    );
  }
  for (const f of risk.factors) if (!f.available) out.push(...f.unknowns);
  return [...new Set(out)];
}

export type { CallGridFinding };

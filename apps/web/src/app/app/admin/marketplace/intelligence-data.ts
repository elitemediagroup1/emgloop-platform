import 'server-only';

// The adapter between the canonical reports and the intelligence engine.
//
// It does exactly one thing: shape data. It performs no arithmetic, applies no
// threshold, and makes no judgement — those live in the metric contract, the
// significance registry and the engine, so that a conclusion on the Overview and
// the same conclusion on a subpage cannot come from different code.

import {
  analyzeCallGrid, analyzeDimension, analyzeBids, analyzeBidSnapshotChange,
  describeCallGridWindow,
  type IntelligenceInput, type CallGridIntelligence, type DimensionIntelligence,
  type IntelligenceDimension, type BidIntelligenceInput, type BidIntelligence,
  type CallGridFinding, type HistorySeries,
} from '@emgloop/shared';
import type { CallGridReport } from './callgrid-report';
import type { BidReport } from './bid-report';

/**
 * Build the engine's input from a canonical report. `now` is the request clock.
 *
 * `extras` carries the inputs that only some surfaces can afford or possess: the
 * historical series (8 extra reads) and the bid snapshot rates. Every one is
 * OPTIONAL and every rule that needs one degrades to silence without it, so a
 * subpage that omits them gets narrower intelligence rather than wrong
 * intelligence.
 */
export function toIntelligenceInput(
  report: CallGridReport,
  now: Date,
  extras?: {
    history?: HistorySeries;
    bidRejectRate?: number | null;
    rateLimitedShare?: number | null;
  },
): IntelligenceInput {
  const desc = describeCallGridWindow(report.window, now);
  return {
    now,
    reportOk: report.ok,
    windowLabel: desc.periodTitle,
    comparisonLabel: report.comparison ? desc.comparisonTitle : null,
    comparisonBasis: report.window.comparisonBasis,
    includesLiveData: report.window.includesLiveData,
    metrics: report.metrics,
    comparison: report.comparison,
    dimensions: report.dimensions,
    comparisonDimensions: report.comparisonDimensions,
    history: extras?.history,
    bidRejectRate: extras?.bidRejectRate ?? null,
    rateLimitedShare: extras?.rateLimitedShare ?? null,
    // Already built by the canonical report service — passed through, never rebuilt.
    comparisonByKey: report.comparisonByKey,
  };
}

/** Window-level intelligence for the Overview. */
export function callGridIntelligence(
  report: CallGridReport,
  now: Date,
  extras?: {
    history?: HistorySeries;
    bidRejectRate?: number | null;
    rateLimitedShare?: number | null;
  },
): CallGridIntelligence {
  return analyzeCallGrid(toIntelligenceInput(report, now, extras));
}

/** Intelligence for one dimension page — same engine, same rules, scoped. */
export function dimensionIntelligence(
  report: CallGridReport,
  dim: IntelligenceDimension,
  now: Date,
  extras?: { history?: HistorySeries },
): DimensionIntelligence {
  return analyzeDimension(toIntelligenceInput(report, now, extras), dim);
}

/**
 * Build the bid engine's input.
 *
 * `prior` is null until historical bid snapshots are ingested — the reader stores
 * one window. Passing null is what makes the engine withhold every trend claim
 * rather than presenting the latest snapshot as if it were history.
 */
export function toBidIntelligenceInput(
  bid: BidReport,
  now: Date,
  selectedPeriodLabel: string,
  matchesSelectedPeriod: boolean,
): BidIntelligenceInput {
  return {
    now,
    ok: bid.ok,
    hasData: bid.hasData,
    fetchedAt: bid.meta?.fetchedAt ?? null,
    reportTimezone: bid.meta?.reportTimezone ?? null,
    snapshot: bid.meta
      ? {
          windowStart: bid.meta.windowStart,
          windowEnd: bid.meta.windowEnd,
          sources: bid.sources.map((s) => ({
            key: s.key, name: s.name,
            total: s.total, bids: s.bids, won: s.won, rejected: s.rejected,
            rejectRatePct: s.rejectRatePct,
            rejections: s.rejections,
          })),
          destinations: bid.destinations.map((d) => ({
            key: d.key, name: d.name,
            accepted: d.accepted, rateLimited: d.rateLimited, pingTimeout: d.pingTimeout,
            minRevenue: d.minRevenue, failedTagRules: d.failedTagRules,
            failedAcceptance: d.failedAcceptance, apiFailed: d.apiFailed,
            suppressed: d.suppressed, invalidNumber: d.invalidNumber, missingAmount: d.missingAmount,
          })),
        }
      : null,
    prior: null,
    selectedPeriodLabel,
    matchesSelectedPeriod,
  };
}

export interface BidIntelligenceResult extends BidIntelligence {
  /** Empty until historical snapshots exist — never a fabricated trend. */
  snapshotChanges: CallGridFinding[];
}

export function bidIntelligence(
  bid: BidReport,
  now: Date,
  selectedPeriodLabel: string,
  matchesSelectedPeriod: boolean,
): BidIntelligenceResult {
  const input = toBidIntelligenceInput(bid, now, selectedPeriodLabel, matchesSelectedPeriod);
  return { ...analyzeBids(input), snapshotChanges: analyzeBidSnapshotChange(input) };
}

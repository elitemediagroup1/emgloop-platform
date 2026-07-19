// @emgloop/intelligence — CallGrid module self-verification (pure, deterministic).
//
// Follows the repo convention of a co-located verification harness. It runs the
// module over three fixed fixtures and asserts the HONESTY invariants that make
// this an intelligence engine and not a metrics dump:
//   1. An empty window yields confidence 0 and a "Not enough data" summary — no
//      fabricated revenue, no invented recommendations.
//   2. A margin-compressing window yields a real risk carrying a
//      RecommendationEnvelope (reason + expected outcome + confidence) and a
//      matching BrainActivity for the briefing.
//   3. With no bid facts and no transcripts, those sections report
//      "Not enough data" with a reason rather than empty silence.
//
// Everything is deterministic: identity/time are passed in, so given the same
// fixtures the output is byte-for-byte identical. No I/O, no clock, no RNG.

import { runCallGridIntelligence } from './module';
import { assembleExecutiveBriefing } from '../briefing';
import type { CallGridIntelligenceInput, CallGridWindow } from './input';
import type { IntelligenceRunContext } from '../module';

const CTX: IntelligenceRunContext = {
  now: new Date('2026-07-17T12:00:00.000Z'),
  idPrefix: 'verify:callgrid',
};

const WINDOW = {
  label: 'Last 7 days',
  since: '2026-07-10T00:00:00.000Z',
  until: '2026-07-17T00:00:00.000Z',
  priorSince: '2026-07-03T00:00:00.000Z',
  priorUntil: '2026-07-10T00:00:00.000Z',
} as const;

function emptyWindow(): CallGridWindow {
  return {
    calls: 0,
    qualified: 0,
    converted: 0,
    revenueCents: 0,
    payoutCents: 0,
    costCents: 0,
    callsWithRevenue: 0,
    callsWithPayout: 0,
    callsWithCost: 0,
    buyers: [],
    vendors: [],
    sources: [],
    campaigns: [],
  };
}

/** Assertion helper — throws with context so a failing invariant is loud. */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[callgrid-intelligence verification] ${message}`);
}

export interface VerificationResult {
  passed: boolean;
  checks: string[];
}

export function verifyCallGridIntelligence(): VerificationResult {
  const checks: string[] = [];

  // --- Fixture 1: empty window → honest "not enough data", confidence 0. ---
  const empty: CallGridIntelligenceInput = {
    organizationId: 'org_verify',
    window: WINDOW,
    current: emptyWindow(),
    prior: null,
  };
  const emptyOut = runCallGridIntelligence(empty, CTX);
  assert(emptyOut.confidence === 0, 'empty window must have confidence 0');
  assert(emptyOut.revenue.currentCents === null, 'empty window revenue must be null, not 0');
  assert(emptyOut.opportunities.length === 0 && emptyOut.risks.length === 0, 'empty window must fabricate no recommendations');
  assert(emptyOut.executiveSummary.join(' ').includes('Not enough data'), 'empty summary must say "Not enough data"');
  assert(emptyOut.transcriptIntelligence.available === false && !!emptyOut.transcriptIntelligence.notEnoughDataReason, 'transcripts must report not-enough-data with a reason');
  checks.push('empty window: confidence 0, revenue null, no fabricated recommendations, honest summary');

  // --- Fixture 2: margin compression → a real risk with a Brain envelope. ---
  const prior: CallGridWindow = {
    calls: 120,
    qualified: 72,
    converted: 40,
    revenueCents: 600_000,
    payoutCents: 300_000,
    costCents: 30_000,
    callsWithRevenue: 120,
    callsWithPayout: 120,
    callsWithCost: 120,
    buyers: [
      { key: 'acme', label: 'Acme Insurance', calls: 60, qualified: 42, converted: 24, revenueCents: 360_000, payoutCents: 160_000, costCents: 15_000 },
    ],
    vendors: [],
    sources: [
      { key: 'src-a', label: 'Search A', calls: 60, qualified: 40, converted: 22, revenueCents: 300_000, payoutCents: 140_000, costCents: 12_000 },
    ],
    campaigns: [],
  };
  const current: CallGridWindow = {
    calls: 125,
    qualified: 60,
    converted: 30,
    revenueCents: 610_000,
    payoutCents: 430_000,
    costCents: 60_000,
    callsWithRevenue: 125,
    callsWithPayout: 125,
    callsWithCost: 125,
    buyers: [
      { key: 'acme', label: 'Acme Insurance', calls: 62, qualified: 30, converted: 15, revenueCents: 360_000, payoutCents: 240_000, costCents: 30_000 },
    ],
    vendors: [],
    sources: [
      { key: 'src-a', label: 'Search A', calls: 60, qualified: 34, converted: 18, revenueCents: 300_000, payoutCents: 150_000, costCents: 20_000 },
      { key: 'src-b', label: 'Display B', calls: 30, qualified: 2, converted: 0, revenueCents: 0, payoutCents: 0, costCents: 40_000 },
    ],
    campaigns: [],
  };
  const compressing: CallGridIntelligenceInput = {
    organizationId: 'org_verify',
    window: WINDOW,
    current,
    prior,
  };
  const out = runCallGridIntelligence(compressing, CTX);
  assert(out.confidence > 0, 'non-empty window must have positive confidence');
  assert(out.revenue.currentCents === 610_000, 'revenue headline must equal summed real revenue');
  assert(out.whatChanged.length > 0, 'a prior window must yield "what changed"');
  assert(out.risks.length > 0, 'margin compression must yield at least one risk');
  const risk = out.risks[0];
  assert(!!risk && risk.reason.length > 0 && !!risk.expectedOutcome.statement && typeof risk.trust.confidence === 'number', 'a risk must carry reason + expected outcome + confidence');
  assert(out.activities.length === out.risks.length + out.opportunities.length, 'every recommendation must have a matching BrainActivity');
  assert(out.optimizations.some((o) => o.target.startsWith('source:')), 'a money-wasting source must produce an optimization');
  assert(out.marketIntelligence.observations.length > 0 || !!out.marketIntelligence.notEnoughDataReason, 'market intelligence must state observations or a not-enough-data reason');
  assert(out.missingEvidence.some((m) => m.toLowerCase().includes('bid')), 'missing bid facts must be declared');
  checks.push('margin-compression window: positive confidence, real risk with envelope, matching activities, source optimization, honest gaps');

  // --- Fixture 3: the Executive Briefing composes module output. ---
  const briefing = assembleExecutiveBriefing([out], CTX.now);
  assert(briefing.revenue.currentCents === 610_000, 'briefing revenue must aggregate module revenue');
  assert(briefing.brainBriefing.total === out.activities.length, 'briefing must project every activity');
  assert(briefing.hasData === true, 'briefing over a non-empty module must report data');
  assert(briefing.risks.length > 0, 'briefing must surface module risks');
  checks.push('executive briefing: revenue-only KPI aggregated, all activities projected');

  return { passed: true, checks };
}

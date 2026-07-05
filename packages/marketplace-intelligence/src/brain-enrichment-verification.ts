// @emgloop/marketplace-intelligence — Brain Enrichment verification harness (pure).
//
// PR #46 (Brain Enrichment). PR #46 introduced enrichMarketplaceIntelligence(),
// a pure, deterministic reasoning step that turns an already-assembled (but
// un-reasoned, BRAIN_NOT_WIRED) Marketplace Intelligence snapshot into an
// enriched one carrying health, confidence, recommendations, and insights.
//
// This module extends the exact PROOF pattern established by the PR #45 CallGrid
// assembler harness to that enrichment step: it builds FIXED, provider-neutral
// MarketplaceIntelligence snapshots, runs the REAL enrichMarketplaceIntelligence
// function over them, and checks the invariants the PR demands with a tiny
// internal assert helper, returning a structured report.
//
// Consistent with the repo's tooling (only 'typecheck'/'build' via turbo, no
// test runner — and none may be added), this is a set of PURE functions. It
// performs NO I/O, NO persistence, NO DB reads/writes, touches NO CallGrid path,
// uses NO LLM, adds NO UI/API, and is NOT wired into any runtime. It compiles as
// part of the normal typecheck/build; a caller or a future test runner may
// additionally invoke runBrainEnrichmentVerification() to execute the checks.

import {
  enrichMarketplaceIntelligence,
  BRAIN_NOT_WIRED,
  NO_DIAGNOSIS_CONFIDENCE,
} from './brain-enrichment';
import type { MarketplaceIntelligence } from './marketplace-intelligence';
import type { BuyerIntelligence } from './buyer-intelligence';
import type { SourceIntelligence } from './source-intelligence';
import type { MarketplaceProfitability } from './profitability';
import type { MarketplaceFunnel } from './marketplace-funnel';

// ---------------------------------------------------------------------------
// Tiny, framework-free assertion helper (mirrors the PR #45 harness style).
// ---------------------------------------------------------------------------

/** One recorded check. */
export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

/** The result of one named scenario (a group of checks). */
export interface ScenarioResult {
  scenario: string;
  checks: CheckResult[];
  passed: boolean;
}

/** The whole harness run. */
export interface VerificationReport {
  passed: boolean;
  total: number;
  failures: number;
  scenarios: ScenarioResult[];
}

/** A minimal check recorder — the entire "framework". Pure: it only accumulates
 * results into its own array. */
class Checker {
  readonly checks: CheckResult[] = [];
  ok(name: string, condition: boolean, detail?: string): void {
    this.checks.push({
      name,
      passed: condition,
      detail: condition ? undefined : detail ?? 'expected true',
    });
  }
  eq<T>(name: string, actual: T, expected: T): void {
    const passed = actual === expected;
    this.ok(name, passed, passed ? undefined : 'expected ' + String(expected) + ', got ' + String(actual));
  }
  /** Assert a value is strictly undefined (proves "missing stays missing"). */
  undef(name: string, actual: unknown): void {
    this.ok(name, actual === undefined, 'expected undefined, got ' + String(actual));
  }
  /** Assert two finite numbers are equal within a small epsilon. */
  close(name: string, actual: number | undefined, expected: number): void {
    const passed = typeof actual === 'number' && Math.abs(actual - expected) < 1e-9;
    this.ok(name, passed, 'expected ~' + expected + ', got ' + String(actual));
  }
}

function finalize(scenario: string, c: Checker): ScenarioResult {
  const passed = c.checks.every((x) => x.passed);
  return { scenario, checks: c.checks, passed };
}

// ---------------------------------------------------------------------------
// Deterministic fixtures — fixed, provider-neutral MarketplaceIntelligence
// snapshots. No clock, no RNG. 'now' is pinned so results are reproducible.
// ---------------------------------------------------------------------------

const ORG = 'org-42';
const NOW = new Date('2025-01-08T00:00:00.000Z');
const WINDOW = {
  startAt: new Date('2025-01-01T00:00:00.000Z'),
  endAt: new Date('2025-01-07T23:59:59.000Z'),
  label: 'fixed_week',
};

/** Build a fixed profitability block; netProfit is the only field the rules
 * read, so it is the parameter. Passing undefined keeps it honestly unknown. */
function profitability(netProfit: number | undefined): MarketplaceProfitability {
  return {
    organizationId: ORG,
    timeWindow: WINDOW,
    netProfit,
    confidence: NO_DIAGNOSIS_CONFIDENCE,
    unknowns: [],
    missingEvidence: [BRAIN_NOT_WIRED],
  };
}

/** Build a fixed buyer with a chosen (or unknown) billable rate. */
function buyer(id: string, billableRate: number | undefined): BuyerIntelligence {
  return {
    organizationId: ORG,
    id,
    name: 'Buyer ' + id,
    sensor: 'callgrid',
    timeWindow: WINDOW,
    confidence: NO_DIAGNOSIS_CONFIDENCE,
    trends: [],
    recommendations: [],
    unknowns: [],
    missingEvidence: [BRAIN_NOT_WIRED],
    buyerId: id,
    buyerName: 'Buyer ' + id,
    health: 'unknown',
    billableRate,
  };
}

/** Build a fixed source with chosen bid counts / fulfillment (any may be
 * undefined to prove a rule stays silent without its evidence). */
function source(
  id: string,
  opts: { bidsSent?: number; bidsAccepted?: number; fulfillment?: number },
): SourceIntelligence {
  return {
    organizationId: ORG,
    id,
    name: 'Source ' + id,
    sensor: 'callgrid',
    timeWindow: WINDOW,
    confidence: NO_DIAGNOSIS_CONFIDENCE,
    trends: [],
    recommendations: [],
    unknowns: [],
    missingEvidence: [BRAIN_NOT_WIRED],
    sourceId: id,
    sourceName: 'Source ' + id,
    bidsSent: opts.bidsSent,
    bidsAccepted: opts.bidsAccepted,
    fulfillment: opts.fulfillment,
  };
}

const EMPTY_FUNNEL: MarketplaceFunnel = {
  organizationId: ORG,
  timeWindow: WINDOW,
  stages: [],
  confidence: NO_DIAGNOSIS_CONFIDENCE,
  unknowns: [],
};

/** Assemble a fixed, un-reasoned snapshot exactly as PR #44 would leave it:
 * BRAIN_NOT_WIRED present, health 'unknown', floor confidence, empty rec/insights. */
function snapshot(parts: {
  profit?: number;
  buyers?: BuyerIntelligence[];
  sources?: SourceIntelligence[];
}): MarketplaceIntelligence {
  return {
    organizationId: ORG,
    generatedAt: NOW,
    timeWindow: WINDOW,
    health: 'unknown',
    confidence: NO_DIAGNOSIS_CONFIDENCE,
    recommendations: [],
    unknowns: [],
    missingEvidence: [BRAIN_NOT_WIRED],
    campaigns: [],
    buyers: parts.buyers ?? [],
    sources: parts.sources ?? [],
    vendors: [],
    profitability: profitability(parts.profit),
    funnel: EMPTY_FUNNEL,
    insights: [],
    metadata: { sensor: 'callgrid', note: BRAIN_NOT_WIRED },
  };
}

// ---------------------------------------------------------------------------
// Scenarios. Each runs the REAL enrichment over a fixed snapshot and asserts
// the exact behaviour the PR requires.
// ---------------------------------------------------------------------------

/** Profitability issue fires; snapshot is graded and un-marked. */
function scenarioProfitabilityIssue(): ScenarioResult {
  const c = new Checker();
  const before = snapshot({ profit: -500 });
  const out = enrichMarketplaceIntelligence(before, NOW);

  c.eq('one recommendation produced', out.recommendations.length, 1);
  c.eq('one insight produced', out.insights.length, 1);
  const rec = out.recommendations[0];
  c.eq('rec action is operational_recommendation', rec.action, 'operational_recommendation');
  c.eq('rec rootCause is emg', rec.rootCause, 'emg');
  c.ok('rec confidence above floor', rec.confidence > NO_DIAGNOSIS_CONFIDENCE);
  c.eq('negative net profit is critical health', out.health, 'critical');
  c.ok('snapshot confidence above floor', out.confidence > NO_DIAGNOSIS_CONFIDENCE);
  c.ok('BRAIN_NOT_WIRED removed from missingEvidence', !out.missingEvidence.includes(BRAIN_NOT_WIRED));
  c.ok('BRAIN_NOT_WIRED removed from metadata.note', out.metadata?.note !== BRAIN_NOT_WIRED);
  c.eq('insight subject is marketplace', out.insights[0].subject, 'marketplace');
  c.eq('insight carries its envelope', out.insights[0].recommendationEnvelope, rec);
  c.ok('input was not mutated', before.recommendations.length === 0 && before.health === 'unknown');
  return finalize('profitability_issue', c);
}

/** Low billable buyer fires with buyer rootCause. */
function scenarioLowBillableRate(): ScenarioResult {
  const c = new Checker();
  const out = enrichMarketplaceIntelligence(
    snapshot({ buyers: [buyer('acme', 0.2)] }),
    NOW,
  );
  c.eq('one recommendation produced', out.recommendations.length, 1);
  c.eq('rec rootCause is buyer', out.recommendations[0].rootCause, 'buyer');
  c.eq('insight subject is the buyer', out.insights[0].subject, 'buyer:acme');
  c.eq('high-severity finding grades at_risk', out.health, 'at_risk');
  return finalize('low_billable_rate', c);
}

/** High rejection source fires; reject rate derived from bid counts. */
function scenarioHighRejectionRate(): ScenarioResult {
  const c = new Checker();
  // 1000 sent, 400 accepted -> reject rate 0.6 (>= 0.4 threshold).
  const out = enrichMarketplaceIntelligence(
    snapshot({ sources: [source('src-1', { bidsSent: 1000, bidsAccepted: 400 })] }),
    NOW,
  );
  c.eq('one recommendation produced', out.recommendations.length, 1);
  c.eq('rec subject is the source', out.recommendations[0].id, 'rec:high_rejection_rate:source:src-1');
  c.eq('insight subject is the source', out.insights[0].subject, 'source:src-1');
  c.eq('rejection finding grades at_risk', out.health, 'at_risk');
  return finalize('high_rejection_rate', c);
}

/** Poor fulfillment source fires with vendor rootCause and 'watch' health. */
function scenarioPoorFulfillment(): ScenarioResult {
  const c = new Checker();
  const out = enrichMarketplaceIntelligence(
    snapshot({ sources: [source('src-2', { fulfillment: 0.3 })] }),
    NOW,
  );
  c.eq('one recommendation produced', out.recommendations.length, 1);
  c.eq('rec rootCause is vendor', out.recommendations[0].rootCause, 'vendor');
  c.eq('normal-severity finding grades watch', out.health, 'watch');
  return finalize('poor_source_fulfillment', c);
}

/** Insufficient evidence: nothing fires, snapshot stays honestly unknown and
 * BRAIN_NOT_WIRED is preserved everywhere. */
function scenarioUnknownWhenInsufficient(): ScenarioResult {
  const c = new Checker();
  // Positive profit, buyer with unknown billable, source with no evidence.
  const before = snapshot({
    profit: 1000,
    buyers: [buyer('b1', undefined)],
    sources: [source('s1', {})],
  });
  const out = enrichMarketplaceIntelligence(before, NOW);
  c.eq('no recommendations', out.recommendations.length, 0);
  c.eq('no insights', out.insights.length, 0);
  c.eq('health stays unknown', out.health, 'unknown');
  c.close('confidence stays at floor', out.confidence, NO_DIAGNOSIS_CONFIDENCE);
  c.ok('BRAIN_NOT_WIRED preserved in missingEvidence', out.missingEvidence.includes(BRAIN_NOT_WIRED));
  c.eq('BRAIN_NOT_WIRED preserved in metadata.note', out.metadata?.note, BRAIN_NOT_WIRED);
  return finalize('unknown_when_insufficient', c);
}

/** Missing values stay undefined; enrichment invents no metrics on entities. */
function scenarioMissingStaysMissing(): ScenarioResult {
  const c = new Checker();
  const s = source('s9', { fulfillment: 0.3 }); // fires, but bid counts absent
  const out = enrichMarketplaceIntelligence(snapshot({ sources: [s] }), NOW);
  c.undef('source bidsSent still undefined', out.sources[0].bidsSent);
  c.undef('source bidsAccepted still undefined', out.sources[0].bidsAccepted);
  c.undef('source revenueGenerated still undefined', out.sources[0].revenueGenerated);
  c.undef('profitability revenue still undefined', out.profitability.revenue);
  return finalize('missing_stays_missing', c);
}

/** Output stays provider-neutral: no CallGrid vocabulary leaks into the Brain
 * output, and canonical fields (sourceId) are preserved. */
function scenarioProviderNeutral(): ScenarioResult {
  const c = new Checker();
  const out = enrichMarketplaceIntelligence(
    snapshot({
      profit: -1,
      buyers: [buyer('acme', 0.1)],
      sources: [source('src-1', { bidsSent: 100, bidsAccepted: 10, fulfillment: 0.2 })],
    }),
    NOW,
  );
  const blob = JSON.stringify(out.recommendations) + JSON.stringify(out.insights);
  const leaks = ['callerId', 'duplicateBids', 'failedTagRules', 'bidStats', 'avgWinningBid', 'CallGrid'];
  for (const leak of leaks) {
    c.ok('no CallGrid term "' + leak + '" in Brain output', !blob.includes(leak));
  }
  // Canonical PR #43 field remains addressable on the entity.
  c.eq('canonical sourceId preserved', out.sources[0].sourceId, 'src-1');
  // Every recommendation uses only the neutral operational action.
  c.ok(
    'all recommendations use canonical action',
    out.recommendations.every((r) => r.action === 'operational_recommendation'),
  );
  return finalize('provider_neutral', c);
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

/** Run every scenario and aggregate. Pure: constructs fixtures, calls the real
 * enrichment, and returns a structured report. Safe to call from a future test
 * runner or a script; it performs no I/O itself. */
export function runBrainEnrichmentVerification(): VerificationReport {
  const scenarios: ScenarioResult[] = [
    scenarioProfitabilityIssue(),
    scenarioLowBillableRate(),
    scenarioHighRejectionRate(),
    scenarioPoorFulfillment(),
    scenarioUnknownWhenInsufficient(),
    scenarioMissingStaysMissing(),
    scenarioProviderNeutral(),
  ];
  const total = scenarios.reduce((n, s) => n + s.checks.length, 0);
  const failures = scenarios.reduce(
    (n, s) => n + s.checks.filter((x) => !x.passed).length,
    0,
  );
  return {
    passed: failures === 0,
    total,
    failures,
    scenarios,
  };
}

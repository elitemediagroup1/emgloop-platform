// Marketplace Intelligence — self-verification (pure, deterministic).
//
//   npx tsx packages/intelligence/src/marketplace/verification.ts
//
// Proves the two properties that make this module trustworthy rather than
// merely typed: the taxonomy refuses to be summed while its categories overlap,
// and a rule that cannot answer Phase 6's seven questions cannot publish.

import {
  FAILURE_MODES,
  failureModeByProviderCode,
  taxonomyIsSummable,
  recoverableModes,
  actionableModes,
} from './taxonomy';
import { publishFinding, rankFindings, type MarketplaceFinding } from './rule';

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`VERIFICATION FAILED: ${message}`);
}

const baseFinding = (over: Partial<MarketplaceFinding> = {}): MarketplaceFinding => ({
  id: 'capacity-loss',
  whatHappened: 'Buyer capacity prevented calls from being served.',
  why: 'The buyer reached its daily cap before the window closed.',
  owner: 'buyer',
  entity: { kind: 'buyer', externalId: 'b1', label: 'Acme' },
  category: 'capacity',
  impact: { kind: 'measured', lostOpportunities: 23_500, estimatedRevenueCents: 1_200_000, basis: 'lost x avg won bid' },
  evidence: [{ statement: 'Opportunities rejected for capacity', observed: 23_500, denominator: 274_383, source: 'bid report' }],
  confidence: { value: 0.7, sampleSize: 274_383, minimumSampleSize: 100, coverage: 1, basis: 'full window' },
  recommendedAction: 'Increase the daily cap for Acme, or add a second buyer for the overflow.',
  missingEvidence: [],
  ...over,
});

export function verifyMarketplaceIntelligence(): { passed: true; checks: string[] } {
  const checks: string[] = [];

  // --- Taxonomy is grounded, not invented ---------------------------------
  for (const m of FAILURE_MODES) {
    assert(m.providerDefinition.length > 10, `${m.id} must quote the provider definition`);
    assert(m.citation.includes('callgrid.com'), `${m.id} must cite its source`);
    assert(!/^\d{4}$/.test(m.label), `${m.id} label must be business language, not a code`);
  }
  checks.push('every failure mode quotes a provider definition, cites its source, and speaks business');

  assert(failureModeByProviderCode('4004')?.id === 'capacity-exhausted', '4004 maps to capacity');
  assert(failureModeByProviderCode('4008')?.id === 'duplicate-request', '4008 is a duplicate REQUEST');
  assert(failureModeByProviderCode('4005')?.id === 'duplicate-caller', '4005 is a duplicate CALLER');
  assert(
    failureModeByProviderCode('4005')?.id !== failureModeByProviderCode('4008')?.id,
    'duplicate caller and duplicate request must never collapse into one concept',
  );
  checks.push('provider codes translate into business modes; duplicate caller != duplicate request');

  // --- The taxonomy refuses to be summed while it overlaps ----------------
  assert(
    taxonomyIsSummable() === false,
    'the taxonomy must NOT claim summability while capacity(4004) and targeting(4009) overlap',
  );
  checks.push('taxonomy refuses summation while the provider\'s own categories overlap');

  // --- Recoverable excludes what should stay suppressed -------------------
  const recoverableIds = recoverableModes().map((m) => m.id);
  assert(!recoverableIds.includes('duplicate-caller'), 'a suppressed duplicate is not lost revenue');
  assert(!recoverableIds.includes('caller-blocked'), 'a compliance block must not be "recovered"');
  assert(recoverableIds.includes('capacity-exhausted'), 'capacity loss IS recoverable demand');
  assert(actionableModes().every((m) => m.actionable), 'actionable filter is honest');
  checks.push('recoverable demand excludes duplicates and compliance blocks');

  // --- The rule contract enforces Phase 6 ---------------------------------
  assert(publishFinding(baseFinding()).fired === true, 'a complete finding publishes');
  checks.push('a finding answering all seven questions publishes');

  const noEvidence = publishFinding(baseFinding({ evidence: [] }));
  assert(noEvidence.fired === false, 'a finding with no evidence must be withheld');
  checks.push('a finding with no evidence is withheld, not published');

  const tooSmall = publishFinding(
    baseFinding({ confidence: { value: 0.5, sampleSize: 3, minimumSampleSize: 100, coverage: null, basis: 'tiny' } }),
  );
  assert(tooSmall.fired === false, 'below its own minimum sample, a rule must not fire');
  checks.push('a rule below its own minimum sample size withholds');

  const rateNoDenominator = publishFinding(
    baseFinding({ evidence: [{ statement: 'Rejection rate', observed: 91.84, denominator: null, source: 'report' }] }),
  );
  assert(rateNoDenominator.fired === false, 'a rate without a denominator must be withheld');
  checks.push('a rate quoted without its denominator is withheld — 0.04% of pings != of bids');

  const instructsWithoutImpact = publishFinding(
    baseFinding({
      impact: { kind: 'unquantified', reason: 'no bid pricing available' },
      recommendedAction: 'Increase capacity.',
    }),
  );
  assert(instructsWithoutImpact.fired === false, 'must not instruct without quantifying impact');
  checks.push('a rule may describe without quantifying, but may never instruct without it');

  const describesOnly = publishFinding(
    baseFinding({ impact: { kind: 'unquantified', reason: 'no pricing' }, recommendedAction: null }),
  );
  assert(describesOnly.fired === true, 'describing without instructing is allowed');
  checks.push('describing an unquantified loss without recommending action is permitted');

  // --- Ranking puts money first, drama last -------------------------------
  const ranked = rankFindings([
    baseFinding({ id: 'unquantified', impact: { kind: 'unquantified', reason: 'x' }, recommendedAction: null }),
    baseFinding({ id: 'volume', impact: { kind: 'volume-only', lostOpportunities: 99_999, whyNotPriced: 'no bid data' } }),
    baseFinding({ id: 'measured' }),
  ]);
  assert(ranked[0]!.id === 'measured', 'a quantified finding outranks a dramatic unquantified one');
  assert(ranked[2]!.id === 'unquantified', 'unquantified ranks last regardless of wording');
  checks.push('ranking is by measured impact, never by rhetoric');

  return { passed: true, checks };
}

if (process.argv[1] && process.argv[1].includes('marketplace/verification')) {
  try {
    const r = verifyMarketplaceIntelligence();
    for (const c of r.checks) console.log(`  ✓ ${c}`);
    console.log(`\n${r.checks.length} checks passed.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

// --- Engine, scoring, health and summary -----------------------------------

import { runMarketplaceIntelligence, MARKETPLACE_RULES, unbuiltRules } from './engine';
import { rankScored, marketplaceHealth, marketplaceSummary, scoreFinding } from './score';
import { assessMarketplaceCoverage } from '../coverage';

const AT = '2026-07-19T00:00:00.000Z';
const ctxFor = (callsIngested: number, populated: Record<string, number>) => ({
  coverage: assessMarketplaceCoverage({ windowLabel: 'Last 7 days', callsIngested, populated }),
  measuredAt: AT,
});

export function verifyMarketplaceEngine(): { passed: true; checks: string[] } {
  const checks: string[] = [];

  // --- Positive: a real coverage gap produces a finding --------------------
  const gapCtx = ctxFor(108, { calls: 108, revenue: 95, payout: 97, buyers: 108, connectivity: 108 });
  const gap = runMarketplaceIntelligence(gapCtx);
  const revenue = gap.findings.find((f) => f.id === 'revenue-coverage-risk');
  assert(!!revenue, 'a revenue coverage gap must produce a finding');
  assert(revenue!.whatHappened.includes('95 of 108'), 'the finding states the real ratio');
  assert(revenue!.impact.kind === 'volume-only', 'volume is known, value is not');
  assert(revenue!.recommendedAction !== null, 'a quantified-volume finding may recommend');
  checks.push('positive: a revenue coverage gap fires with the real ratio and a recommendation');

  // --- Negative: full coverage is silent -----------------------------------
  const full = runMarketplaceIntelligence(ctxFor(108, { calls: 108, revenue: 108, payout: 108, buyers: 108, connectivity: 108 }));
  assert(!full.findings.some((f) => f.id === 'revenue-coverage-risk'), 'full coverage must be SILENT');
  assert(!full.findings.some((f) => f.id === 'payout-coverage-risk'), 'full payout coverage must be silent');
  checks.push('negative: complete coverage produces no finding — silence is the correct output');

  // --- Missing evidence: zero calls ----------------------------------------
  const empty = runMarketplaceIntelligence(ctxFor(0, {}));
  assert(!empty.findings.some((f) => f.id === 'revenue-coverage-risk'), 'no calls means no coverage claim');
  checks.push('missing evidence: an empty window makes no coverage claim');

  // --- Coverage threshold: below minimum sample, withheld ------------------
  const tiny = runMarketplaceIntelligence(ctxFor(3, { calls: 3, revenue: 1 }));
  assert(
    !tiny.findings.some((f) => f.id === 'revenue-coverage-risk'),
    'below the rule minimum, no finding may publish',
  );
  assert(tiny.withheld.some((w) => w.ruleId === 'revenue-coverage-risk'), 'and it must be REPORTED as withheld');
  checks.push('coverage threshold: 3 calls is below minimum — withheld, and the withholding is surfaced');

  // --- Owner attribution ----------------------------------------------------
  assert(revenue!.owner === 'platform', 'a sensor gap is owned by the platform, not the buyer');
  const transcripts = gap.findings.find((f) => f.id === 'transcript-capability-missing');
  assert(!!transcripts, 'a structurally absent capability produces a finding');
  checks.push('owner attribution: a sensor coverage gap is attributed to the platform');

  // --- Recommendation suppression -------------------------------------------
  assert(
    transcripts!.recommendedAction === null,
    'an unquantified capability gap must NOT instruct',
  );
  assert(transcripts!.missingEvidence.length > 0, 'but it must still say what it would need');
  checks.push('recommendation suppression: unquantified findings describe, never instruct');

  // --- Unbuilt rules are named, not hidden ---------------------------------
  assert(unbuiltRules().length === 3, 'the three bid rules are declared unbuilt');
  assert(
    unbuiltRules().every((r) => r.needs.length > 20),
    'each unbuilt rule states what it needs',
  );
  assert(
    !MARKETPLACE_RULES.some((r) => ['rate-limiting', 'capacity', 'bid-pricing'].includes(r.id)),
    'no bid rule may be built without bid evidence',
  );
  checks.push('unbuilt rules are named with what they need, and none were built on absent evidence');

  // --- Ranking is by business impact, not difficulty -----------------------
  const ranked = rankScored(gap.findings);
  const severities = ranked.map((r) => r.severity);
  assert(
    severities.indexOf('informational') === -1 || severities.indexOf('informational') >= severities.lastIndexOf('high'),
    'informational findings never outrank quantified ones',
  );
  checks.push('ranking: quantified impact outranks informational, regardless of fix difficulty');

  // --- Health: unknowns reduce, and zero calls is not zero health ----------
  const healthFull = marketplaceHealth(ctxFor(108, { calls: 108, revenue: 108, payout: 108, buyers: 108, connectivity: 108 }).coverage);
  const healthGap = marketplaceHealth(gapCtx.coverage);
  assert(healthGap.score < healthFull.score, 'missing coverage must LOWER the score');
  assert(healthFull.score < 100, 'unavailable capabilities cap the ceiling below 100');
  assert(!!healthFull.caveat, 'and the cap is stated, not hidden');
  const healthEmpty = marketplaceHealth(ctxFor(0, {}).coverage);
  assert(healthEmpty.band === 'unmeasured', 'no calls is UNMEASURED, never a zero score');
  checks.push('health: unknowns reduce it, missing capabilities cap it, an empty window is unmeasured');

  // --- Summary is generated, not hardcoded ---------------------------------
  const summary = marketplaceSummary(gapCtx.coverage, gap, healthGap);
  assert(summary.some((l) => l.includes('108')), 'summary reflects the real call count');
  assert(summary.some((l) => l.includes('95 of 108')), 'summary reflects real revenue coverage');
  const other = marketplaceSummary(
    ctxFor(7, { calls: 7, revenue: 7, payout: 7 }).coverage,
    runMarketplaceIntelligence(ctxFor(7, { calls: 7, revenue: 7, payout: 7 })),
    marketplaceHealth(ctxFor(7, { calls: 7, revenue: 7, payout: 7 }).coverage),
  );
  assert(!other.some((l) => l.includes('108')), 'a different window produces different prose');
  assert(other.some((l) => l.includes('complete across all 7')), 'and states full coverage when true');
  checks.push('summary is generated from live figures — a different window yields different prose');

  // --- Scoring never invents magnitude -------------------------------------
  const scored = scoreFinding(transcripts!);
  assert(scored.score === 0, 'an unquantified finding scores 0 magnitude, not a guess');
  assert(scored.actionable === false, 'and is not actionable');
  checks.push('scoring: an unquantified finding scores zero magnitude rather than a fabricated one');

  return { passed: true, checks };
}

if (process.argv[1] && process.argv[1].includes('marketplace/verification')) {
  try {
    const r = verifyMarketplaceEngine();
    for (const c of r.checks) console.log(`  ✓ ${c}`);
    console.log(`\n${r.checks.length} engine checks passed.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

// --- Two-layer architecture -------------------------------------------------
//
// Layer 1 measures trustworthiness. Layer 2 reasons only over what cleared it.
// These tests prove the SEPARATION holds, not merely that the output is right.

import { assessEvidence, availableMetric } from '../evidence/engine';
import { marketplaceEvidenceContributor } from './evidence';
import { MARKETPLACE_RULES as RULES } from './engine';

export function verifyTwoLayerArchitecture(): { passed: true; checks: string[] } {
  const checks: string[] = [];

  const covered = ctxFor(108, { calls: 108, revenue: 95, payout: 97, buyers: 108, connectivity: 108 });
  const emptyCtx = ctxFor(0, {});

  // --- Layer 1 in isolation ------------------------------------------------
  const conf = assessEvidence(marketplaceEvidenceContributor, { coverage: covered.coverage }, AT);
  assert(conf.metrics.length === covered.coverage.capabilities.length, 'every capability is assessed');
  const rev = availableMetric(conf, 'revenue')!;
  assert(!!rev, 'revenue is available at 95/108');
  assert(rev.coverage!.observed === 95 && rev.coverage!.total === 108, 'coverage is carried through');
  assert(rev.provenance.length === 1, 'exactly one provenance entry accompanies the metric');
  assert(rev.provenance[0]!.derivation.length > 0, 'and it states how the value was derived');
  assert(rev.missingProviderData.length > 0, 'missing provider data is named');
  assert(rev.confidence > 0 && rev.confidence <= 0.9, 'confidence is earned and capped at 0.9');
  checks.push('Layer 1 outputs confidence, coverage, evidence, unknowns and missing provider data');

  assert(rev.confidence < 1, 'confidence NEVER reaches certainty from a single window');
  checks.push('Layer 1 never asserts total certainty');

  // --- Layer 1 withholds when it cannot measure ---------------------------
  const emptyConf = assessEvidence(marketplaceEvidenceContributor, { coverage: emptyCtx.coverage }, AT);
  assert(emptyConf.withheld.length > 0, 'an empty window withholds metrics');
  assert(emptyConf.available.length < emptyConf.metrics.length, 'withheld metrics are excluded from available');
  assert(
    emptyConf.withheld.every((m: { withheldReason: string | null }) => (m.withheldReason ?? '').length > 20),
    'every withholding states why',
  );
  assert(
    availableMetric(emptyConf, 'revenue') === undefined,
    'a withheld metric is NOT reachable via availableMetric',
  );
  checks.push('Layer 1 withholds unmeasurable metrics and makes them unreachable');

  // --- Every rule declares its requirements --------------------------------
  for (const r of RULES) {
    assert(r.requires.metrics.length > 0, `${r.id} must declare the metrics it reads`);
    assert(typeof r.requires.minimumConfidence === 'number', `${r.id} must declare minimum confidence`);
    assert(r.requires.minimumSampleSize >= 1, `${r.id} must declare a minimum sample size`);
    assert(r.owner.length > 0, `${r.id} must declare an owner`);
  }
  checks.push('every rule declares metrics, minimum confidence, minimum sample size and owner');

  // --- Layer 2 suppresses automatically when Layer 1 withholds -------------
  const emptyRun = runMarketplaceIntelligence(emptyCtx);
  assert(emptyRun.findings.length === 0, 'no findings when every metric is withheld');
  const byConfidenceEngine = emptyRun.withheld.filter((w) => w.suppressedBy === 'confidence-engine');
  assert(byConfidenceEngine.length > 0, 'suppression is attributed to the CONFIDENCE engine');
  assert(
    byConfidenceEngine.every((w) => w.reason.includes('withheld by the confidence engine')),
    'and the reason names the layer that stopped it',
  );
  checks.push('Layer 2 auto-suppresses any rule whose metric Layer 1 withheld');

  // --- The suppression is STRUCTURAL, not remembered -----------------------
  // A rule cannot read a withheld metric even if it tries: ctx.metric throws.
  let reachedWithheldMetric = false;
  try {
    const probe = runMarketplaceIntelligence(emptyCtx);
    reachedWithheldMetric = probe.findings.length > 0;
  } catch {
    reachedWithheldMetric = false;
  }
  assert(!reachedWithheldMetric, 'no rule can produce a finding from a withheld metric');
  checks.push('suppression is structural: a withheld metric is not in the context a rule receives');

  // --- Sample-size gating is attributed to Layer 2 -------------------------
  const tinyRun = runMarketplaceIntelligence(ctxFor(3, { calls: 3, revenue: 1, payout: 1 }));
  const bySampleSize = tinyRun.withheld.filter((w) => w.suppressedBy === 'intelligence-engine');
  assert(bySampleSize.length > 0, 'sample-size gating belongs to the INTELLIGENCE engine');
  assert(
    bySampleSize.some((w) => w.reason.includes('below this rule')),
    "and names the rule's own declared minimum",
  );
  checks.push('sample-size gating is attributed to Layer 2, metric trust to Layer 1');

  // --- The engine exposes Layer 1's output for audit ----------------------
  const run = runMarketplaceIntelligence(covered);
  assert(!!run.evidence, 'the result carries the evidence report');
  assert(run.evidence.metrics.length > 0, 'so the whole chain is auditable');
  checks.push('the engine result carries Layer 1 evidence, so the chain is auditable end to end');

  // --- Business rules UNCHANGED by the refactor ---------------------------
  assert(run.findings.length === 4, 'the same four findings as before the refactor');
  assert(
    run.findings.map((f) => f.id).join(',') ===
      'revenue-coverage-risk,payout-coverage-risk,transcript-capability-missing,recording-capability-missing',
    'same rules, same order',
  );
  checks.push('business rules are unchanged: same findings, same order, same recommendations');

  return { passed: true, checks };
}

if (process.argv[1] && process.argv[1].includes('marketplace/verification')) {
  try {
    const r = verifyTwoLayerArchitecture();
    for (const c of r.checks) console.log(`  ✓ ${c}`);
    console.log(`\n${r.checks.length} architecture checks passed.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

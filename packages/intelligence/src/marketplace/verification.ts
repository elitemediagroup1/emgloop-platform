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

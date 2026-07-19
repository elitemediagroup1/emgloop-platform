// Auction intelligence — architecture verification.
//
// Run:  npx tsx packages/intelligence/src/marketplace/auction.verification.ts
//
// These are not unit tests of arithmetic. They pin the PROPERTIES that make the
// auction layer trustworthy, each of which is a mistake this sprint could
// plausibly have made:
//
//   • a rule reading across grains
//   • a metric with no proven denominator being published as a rate
//   • an absent field rendering as zero
//   • money reasoned over before its unit was proven
//   • a funnel stage with no provider source being filled in from the nearest
//     plausible field
//
// Every one of those would produce output that looks correct.

import {
  assessAuction,
  observe,
  metricId,
  assertSingleGrain,
  type AuctionObservation,
} from './auction-evidence';
import { runAuctionIntelligence, AUCTION_RULES, unbuiltAuctionRules } from './auction-rules';
import {
  AUCTION_FUNNEL_STAGES,
  AUCTION_FUNNEL_TRANSITIONS,
  verifyDenominators,
  transitionIsPublishable,
} from './auction-funnel';
import { grainOf } from './auction-evidence';
import { CONFIDENCE_CEILING } from '../evidence/engine';

const AT = '2026-07-19T00:00:00.000Z';

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function check(name: string, pass: boolean, detail: string): Check {
  return { name, pass, detail };
}

/** A window with real destination activity, for the rules to reason over. */
function destinationRows() {
  return [
    { accepted: 1000, rateLimited: 40, pingTimeout: 12, apiFailed: 3, suppressed: 0, minRevenue: 5, missingAmount: 0, invalidNumber: 2, failedAcceptance: 7, failedTagRules: 1 },
    { accepted: 500, rateLimited: 20, pingTimeout: 5, apiFailed: 1, suppressed: 0, minRevenue: 2, missingAmount: 0, invalidNumber: 1, failedAcceptance: 3, failedTagRules: 0 },
  ];
}

function sourceRows() {
  return [
    { total: 2000, bids: 800, rated: 200, won: 4, rejected: 1200, duplicateBids: 10, duplicateCaller: 6, failedAcceptance: 30, failedTagRules: 8, paused: 12, closed: 5, callerIdRejected: 3, bidRatePercent: 40, winRatePercent: 0.5, rejectRatePercent: 60 },
    { total: 1000, bids: 400, rated: 100, won: 2, rejected: 600, duplicateBids: 5, duplicateCaller: 2, failedAcceptance: 15, failedTagRules: 4, paused: 6, closed: 2, callerIdRejected: 1, bidRatePercent: 40, winRatePercent: 0.5, rejectRatePercent: 60 },
  ];
}

function buildObservations(opts: { source: Array<Record<string, unknown>>; destination: Array<Record<string, unknown>> }): AuctionObservation[] {
  const sourceTotal = opts.source.reduce((a, r) => a + (typeof r['total'] === 'number' ? r['total'] : 0), 0) || null;
  const accepted = opts.destination.reduce((a, r) => a + (typeof r['accepted'] === 'number' ? r['accepted'] : 0), 0) || null;
  const s = (name: string, label: string) => observe(opts.source, name, label, 'source', { denominator: sourceTotal });
  const d = (name: string, label: string) => observe(opts.destination, name, label, 'destination', { denominator: accepted });
  return [
    s('total', 'Bid report total'), s('bids', 'Bids'), s('rated', 'Rated'), s('won', 'Won'),
    s('rejected', 'Rejected'), s('duplicateBids', 'Duplicate bids'), s('duplicateCaller', 'Duplicate callers'),
    s('failedAcceptance', 'Failed acceptance'), s('failedTagRules', 'Failed tag rules'),
    s('paused', 'Rejected because paused'), s('closed', 'Rejected because closed'),
    s('callerIdRejected', 'Rejected on caller id'),
    d('accepted', 'Pings accepted'), d('rateLimited', 'Pings rejected by rate limiting'),
    d('pingTimeout', 'Pings that timed out'), d('apiFailed', 'Pings lost to API failure'),
    d('suppressed', 'Suppressed pings'), d('minRevenue', 'Pings below the minimum-revenue floor'),
    d('missingAmount', 'Pings missing an amount'), d('invalidNumber', 'Pings with an invalid number'),
    d('failedAcceptance', 'Pings failing acceptance'), d('failedTagRules', 'Pings failing tag rules'),
  ];
}

export function verifyAuctionIntelligence(): Check[] {
  const checks: Check[] = [];

  // --- Grain separation ------------------------------------------------------

  checks.push(
    check(
      'every auction rule reads exactly one grain',
      AUCTION_RULES.every((r) => assertSingleGrain(r.requires.metrics) === null),
      'A rule mixing source and destination metrics would assert a relationship no provider data supports.',
    ),
  );

  const crossGrain = {
    id: 'deliberate-cross-grain-rule',
    purpose: 'tripwire',
    owner: 'platform' as const,
    requires: {
      metrics: [metricId('source', 'won'), metricId('destination', 'accepted')],
      minimumConfidence: 0, minimumSampleSize: 0, coverageRequirement: null,
    },
    evaluate: () => { throw new Error('a cross-grain rule must never evaluate'); },
  };
  const crossAssessment = assessAuction({
    measuredAt: AT, windowLabel: 'test',
    observations: buildObservations({ source: sourceRows(), destination: destinationRows() }),
    sourceRowsExamined: 2, destinationRowsExamined: 2, moneyUnitProven: true,
  });
  const crossResult = runAuctionIntelligence({
    // Source evidence, deliberately: the tripwire rule also names a destination
    // metric, which is unreachable from this report. Suppression must come from
    // the grain check, not from the metric merely being absent.
    evidence: crossAssessment.source,
    values: crossAssessment.values,
    rules: [crossGrain],
  });
  checks.push(
    check(
      'a cross-grain rule is suppressed BEFORE it evaluates',
      crossResult.findings.length === 0 && crossResult.withheld.length === 1,
      'Suppression happens before evaluate() so there is no partially-formed cross-grain finding to leak. The tripwire rule throws if it ever runs.',
    ),
  );

  checks.push(
    check(
      'every auction metric id declares its grain',
      AUCTION_RULES.every((r) => r.requires.metrics.every((m) => grainOf(m) !== null)),
      'Grain is carried in the id so a function can check it, not only a reviewer.',
    ),
  );

  // --- Null is not zero ------------------------------------------------------

  const noRateLimitField = destinationRows().map(({ rateLimited: _drop, ...rest }) => rest);
  const absent = assessAuction({
    measuredAt: AT, windowLabel: 'test',
    observations: buildObservations({ source: sourceRows(), destination: noRateLimitField }),
    sourceRowsExamined: 2, destinationRowsExamined: 2, moneyUnitProven: true,
  });
  const rateLimitedMetric = absent.destination.metrics.find(
    (m) => m.metricId === metricId('destination', 'rateLimited'),
  );
  checks.push(
    check(
      'a field no row reported is WITHHELD, not reported as zero',
      rateLimitedMetric?.withheld === true &&
        absent.values.get(metricId('destination', 'rateLimited')) === null,
      'A confident 0 on rateLimited reads as "no rate limiting is happening", which is the exact failure category this sprint exists to detect.',
    ),
  );

  const absentEngine = runAuctionIntelligence({
    evidence: absent.destination,
    values: absent.values,
  });
  checks.push(
    check(
      'a rule whose metric was withheld never fires',
      !absentEngine.findings.some((f) => f.id === 'auction-destination-rate-limited'),
      'The gate is what stops it, not the rule body.',
    ),
  );

  // --- Money gating ----------------------------------------------------------

  const moneyObs = observe(
    [{ avgBidCents: 1109 }], 'avgBidCents', 'Average bid', 'source', { denominator: 100 },
  );
  const unprovenMoney = assessAuction({
    measuredAt: AT, windowLabel: 'test', observations: [moneyObs],
    sourceRowsExamined: 1, destinationRowsExamined: 0, moneyUnitProven: false,
  });
  const provenMoney = assessAuction({
    measuredAt: AT, windowLabel: 'test', observations: [moneyObs],
    sourceRowsExamined: 1, destinationRowsExamined: 0, moneyUnitProven: true,
  });
  checks.push(
    check(
      'money metrics are withheld until the unit is PROVEN',
      unprovenMoney.source.withheld.length === 1 && provenMoney.source.withheld.length === 0,
      'A 100x error in a financial figure is a wrong answer, not a degraded one, so it is withheld rather than published with low confidence.',
    ),
  );

  // --- Denominators ----------------------------------------------------------

  // Snapshot columns carry the unit in their name (`bidRatePercent`); the
  // hypothesis tester reads the provider's own field names. Mapping here mirrors
  // exactly what the page loader does, so the two cannot drift.
  const rateRows = sourceRows().map((r) => ({
    bids: r.bids, total: r.total, won: r.won, rejected: r.rejected,
    bidRate: r.bidRatePercent, winRate: r.winRatePercent, rejectRate: r.rejectRatePercent,
  }));
  const verdicts = verifyDenominators(rateRows);
  const bidRate = verdicts.find((v) => v.rate === 'bidRate');
  const winRateAlt = verdicts.find((v) => v.rate === 'winRateAlt');
  checks.push(
    check(
      'a denominator hypothesis that holds on every row is PROVEN',
      bidRate?.verdict === 'proven',
      'bids/total = 800/2000 = 40% matches the reported bidRate on both rows, so `total` is bidRate\'s denominator.',
    ),
  );
  checks.push(
    check(
      'a denominator hypothesis contradicted by a row is DISPROVEN',
      winRateAlt?.verdict === 'disproven' && (winRateAlt?.disagreed ?? 0) > 0,
      'won/total = 4/2000 = 0.2% contradicts the reported winRate of 0.5%, so `total` is NOT winRate\'s denominator. One counterexample is enough — a denominator that holds on 90% of rows is a coincidence, not the denominator.',
    ),
  );

  const noRates = verifyDenominators([{ bids: 5, total: 10 }]);
  checks.push(
    check(
      'a hypothesis with no testable row is insufficient-evidence, not proven',
      noRates.every((v) => v.verdict === 'insufficient-evidence'),
      'Absence of contradiction is not proof.',
    ),
  );

  // --- Funnel ----------------------------------------------------------------

  const pings = AUCTION_FUNNEL_STAGES.find((s) => s.id === 'pings');
  checks.push(
    check(
      'the Pings stage has NO provider source and no field is substituted for it',
      pings?.status === 'no-provider-source' && pings?.providerField === null,
      '`pings` exists on no endpoint that returned data. Filling it from `accepted` would be the single most believable fabrication available here.',
    ),
  );

  const rated = AUCTION_FUNNEL_STAGES.find((s) => s.id === 'rated');
  checks.push(
    check(
      'Rated is labelled Rated, not Made, and its equivalence is unproven',
      rated?.status === 'unproven-equivalence' && rated?.label === 'Rated',
      'Using the provider\'s own name keeps the unproven equivalence visible in the UI.',
    ),
  );

  const crossGrainTransition = AUCTION_FUNNEL_TRANSITIONS.find((t) => t.id === 'accepted-to-bid-total');
  const publishable = crossGrainTransition
    ? transitionIsPublishable(crossGrainTransition, verdicts, 1_000_000)
    : { publishable: true, reason: 'missing' };
  checks.push(
    check(
      'a not-comparable transition stays unpublishable at ANY sample size',
      crossGrainTransition?.comparability === 'not-comparable' && !publishable.publishable,
      'The obstacle is the grain, and more rows do not change a grain.',
    ),
  );

  // --- Withheld capabilities are declared, not silently missing ---------------

  const unbuilt = unbuiltAuctionRules();
  const required = [
    'bid-pricing-recommendation', 'recoverable-revenue', 'dominant-failure-reason',
    'pings-to-made-to-won-funnel', 'response-time-finding', 'capped-finding',
    'buyer-or-source-blame', 'provider-rate-relabelling',
  ];
  checks.push(
    check(
      'every capability this sprint refused is declared with the evidence it needs',
      required.every((id) => unbuilt.some((u) => u.id === id && u.needs.length > 20)),
      'A withheld capability with a stated reason is information; a missing one with no explanation is a gap someone fills badly later.',
    ),
  );

  // --- Findings carry a denominator ------------------------------------------

  // Both grains, run SEPARATELY — this is the intended calling pattern. There
  // is no combined evidence report to pass, which is the point: the separation
  // is enforced by what the caller is able to construct, not by discipline.
  const healthyAssessment = assessAuction({
    measuredAt: AT, windowLabel: 'test',
    observations: buildObservations({ source: sourceRows(), destination: destinationRows() }),
    sourceRowsExamined: 2, destinationRowsExamined: 2, moneyUnitProven: true,
  });
  const healthySource = runAuctionIntelligence({
    evidence: healthyAssessment.source, values: healthyAssessment.values,
  });
  const healthyDestination = runAuctionIntelligence({
    evidence: healthyAssessment.destination, values: healthyAssessment.values,
  });
  const healthy = {
    findings: [...healthySource.findings, ...healthyDestination.findings],
  };
  checks.push(
    check(
      'every published finding carries an explicit denominator on its evidence',
      healthy.findings.length > 0 &&
        healthy.findings.every((f) => f.evidence.every((e) => e.denominator !== null && e.denominator > 0)),
      `${healthy.findings.length} finding(s) published. "982 rate-limited" is a number; "982 of 478,504" is a finding.`,
    ),
  );
  checks.push(
    check(
      'no published finding prices its impact',
      healthy.findings.every((f) => f.impact.kind === 'volume-only'),
      'No endpoint that returned data attaches revenue to an opportunity, so a money impact would be invented.',
    ),
  );

  // --- Empty window ----------------------------------------------------------

  const emptyReport = assessAuction({
    measuredAt: AT, windowLabel: 'test',
    observations: buildObservations({ source: [], destination: [] }),
    sourceRowsExamined: 0, destinationRowsExamined: 0, moneyUnitProven: false,
  });
  const emptySource = runAuctionIntelligence({
    evidence: emptyReport.source, values: emptyReport.values,
  });
  const emptyDestination = runAuctionIntelligence({
    evidence: emptyReport.destination, values: emptyReport.values,
  });
  checks.push(
    check(
      'an empty window produces no findings and every metric withheld',
      emptySource.findings.length === 0 &&
        emptyDestination.findings.length === 0 &&
        emptyReport.source.available.length === 0 &&
        emptyReport.destination.available.length === 0,
      'Zero rows examined is not zero failures observed.',
    ),
  );

  // --- Confidence is earned, never asserted ----------------------------------

  const saturated = assessAuction({
    measuredAt: AT, windowLabel: 'test',
    observations: [
      observe([{ rejected: 1 }], 'rejected', 'Rejected', 'source', { denominator: 1 }),
    ],
    sourceRowsExamined: 10_000, destinationRowsExamined: 0, moneyUnitProven: true,
  });
  checks.push(
    check(
      'confidence never reaches 1.0, at any sample size',
      saturated.source.metrics.every((m) => m.confidence <= CONFIDENCE_CEILING),
      'Loop cannot see the events behind a provider aggregate, so certainty is not available at any sample size. The ceiling is the platform engine\'s, applied uniformly rather than re-derived here.',
    ),
  );

  return checks;
}

if (process.argv[1] && process.argv[1].includes('marketplace/auction.verification')) {
  const checks = verifyAuctionIntelligence();
  for (const c of checks) {
    // eslint-disable-next-line no-console
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.pass);
  // eslint-disable-next-line no-console
  console.log(`\n${checks.length - failed.length}/${checks.length} auction checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

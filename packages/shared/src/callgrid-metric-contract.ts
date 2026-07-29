// The canonical CallGrid metric contract — the ONE definition of every business
// metric CallGrid Intelligence displays, and the ONE implementation of every
// formula behind them.
//
// No page, tile, table, or intelligence rule may define a business metric
// independently. A metric that is not declared here does not exist; a formula
// computed anywhere but here is a defect. This is what makes a number on the
// Overview and the same number on a subpage provably the same number.
//
// Every definition carries its provenance (which provider report and fields it
// comes from), its grain, its versioned formula, and — the part that matters for
// trust — what a zero, an unknown, and an unavailable each MEAN for that metric.
// "Missing" is never "zero": see `zeroSemantics` / `unknownSemantics` per metric.
//
// Pure declarations + pure arithmetic. No I/O, no provider calls, no clock.

// --- Classification -----------------------------------------------------------
// The epistemic status of a displayed value or conclusion. This is a different
// axis from the platform Truth state (which describes data availability): a
// VERIFIED metric can still be UNKNOWN for a given window.
export const METRIC_CLASSIFICATIONS = ['VERIFIED', 'DERIVED', 'INFERRED', 'UNKNOWN', 'UNAVAILABLE'] as const;
export type MetricClassification = (typeof METRIC_CLASSIFICATIONS)[number];

/** Grains CallGrid data exists at. Source-grain bid metrics and destination-grain
 *  ping outcomes are DIFFERENT populations and may never be combined. */
export const METRIC_GRAINS = [
  'window',           // whole selected reporting window
  'buyer', 'vendor', 'source', 'campaign',
  'bid_source',       // bidStats / bidRejections — one row per traffic source
  'bid_destination',  // pingStats — one row per destination endpoint
] as const;
export type MetricGrain = (typeof METRIC_GRAINS)[number];

/** Which reporting periods a metric can be asked for. */
export type DateWindowSupport =
  | 'arbitrary_window'      // any Eastern window, including comparisons
  | 'latest_snapshot_only'; // provider exposes only its most recent synced window

export type ComparisonSupport =
  | 'elapsed_matched'   // comparable across windows, cut at equal elapsed time
  | 'snapshot_only'     // comparable only against another stored snapshot
  | 'none';

export interface CallGridMetricDefinition {
  metricKey: string;
  displayName: string;
  description: string;
  /** The BEST classification this metric can achieve when its data is present. */
  classification: Extract<MetricClassification, 'VERIFIED' | 'DERIVED'>;
  providerSource: string;
  providerFields: readonly string[];
  grain: readonly MetricGrain[];
  formula: string;
  formulaVersion: string;
  timezoneRule: string;
  dateWindowSupport: DateWindowSupport;
  comparisonSupport: ComparisonSupport;
  /** When a rendered 0 is genuinely true. */
  zeroSemantics: string;
  /** What it means when we cannot determine the value. */
  unknownSemantics: string;
  /** When the provider cannot supply this at all. */
  unavailableSemantics: string;
  /** How partial coverage is decided and disclosed. */
  completenessRule: string;
  /** The raw fields an evidence drawer must show to justify the value. */
  evidenceFields: readonly string[];
  /** Dimensions this metric may legitimately be broken down by. */
  validDimensions: readonly MetricGrain[];
  /** Named uses that would be wrong, kept explicit so they are not re-invented. */
  invalidCrossGrainUses: readonly string[];
}

// --- Shared boilerplate -------------------------------------------------------

const CALL_SOURCE = 'MarketplaceCall projection (marketplaceCalls.aggregateWindow) — derived from CallGrid call records at ingestion';
const CALL_DIMS: readonly MetricGrain[] = ['window', 'buyer', 'vendor', 'source', 'campaign'];
const EASTERN_RULE = 'Window boundaries are America/New_York calendar boundaries; rows are selected on sourceOccurredAt.';
const SNAPSHOT_RULE = 'The provider report endpoint accepts no arbitrary range. Ingestion stores its latest synchronized window; the reporting timezone is the provider\'s, not Eastern.';
const BID_SOURCE_SNAPSHOT = 'MarketplaceBidSourceSnapshot (CallGrid /api/reports/bidStats + /api/reports/bidRejections)';
const PING_SNAPSHOT = 'MarketplacePingDestinationSnapshot (CallGrid /api/reports/pingStats)';

const NEVER_CROSS_GRAIN = [
  'Never added to, divided by, or expressed as a share of a bid-destination metric — they count different populations.',
];

// --- Call performance ---------------------------------------------------------

const CALL_PERFORMANCE: CallGridMetricDefinition[] = [
  {
    metricKey: 'revenue',
    displayName: 'Revenue',
    description: 'Total revenue attributed to calls in the selected period.',
    classification: 'DERIVED',
    providerSource: CALL_SOURCE,
    providerFields: ['revenueCents'],
    grain: CALL_DIMS,
    formula: 'sum(revenueCents) over calls where revenueCents IS NOT NULL',
    formulaVersion: 'v1',
    timezoneRule: EASTERN_RULE,
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'Zero only when the window contains calls and every one of them carried a revenue value of 0, or the window genuinely contains no calls at all.',
    unknownSemantics: 'Calls exist in the window but none carried a revenue value — the amount is Unknown. It is never rendered as $0.',
    unavailableSemantics: 'The economics read failed. Nothing is displayed as a number.',
    completenessRule: 'callsWithRevenue / calls. Below 1 the total is a LOWER BOUND and must be disclosed as partial.',
    evidenceFields: ['revenueCents', 'callsWithRevenue', 'calls'],
    validDimensions: CALL_DIMS,
    invalidCrossGrainUses: ['Never attributed to a bid opportunity — CallGrid exposes no per-opportunity revenue.'],
  },
  {
    metricKey: 'profit',
    displayName: 'Profit',
    description: 'Revenue less vendor payout and call cost for the selected period.',
    classification: 'DERIVED',
    providerSource: CALL_SOURCE,
    providerFields: ['revenueCents', 'payoutCents', 'costCents'],
    grain: CALL_DIMS,
    formula: 'sum(revenueCents) - sum(payoutCents) - sum(costCents)',
    formulaVersion: 'v1',
    timezoneRule: EASTERN_RULE,
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'Zero only when all three components are known and net to zero, or the window genuinely contains no calls.',
    unknownSemantics: 'No call in the window carried revenue — profit is Unknown, never $0.',
    unavailableSemantics: 'The economics read failed.',
    completenessRule: 'Completeness is the WEAKEST of the revenue, payout and cost coverages: profit computed over rows missing payout or cost OVERSTATES profit, so partial coverage must be disclosed.',
    evidenceFields: ['revenueCents', 'payoutCents', 'costCents', 'callsWithRevenue', 'callsWithPayout', 'callsWithCost', 'calls'],
    validDimensions: CALL_DIMS,
    invalidCrossGrainUses: [
      'Never allocated to an entity by proportional share of revenue — cost is attributed per call, and inventing a share is fabrication.',
    ],
  },
  {
    metricKey: 'billableCalls',
    displayName: 'Billable Calls',
    description: 'Calls the provider marked as billable (monetized) in the selected period.',
    classification: 'VERIFIED',
    providerSource: CALL_SOURCE,
    providerFields: ['monetized'],
    grain: CALL_DIMS,
    formula: 'count(calls where monetized = true)',
    formulaVersion: 'v1',
    timezoneRule: EASTERN_RULE,
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'A true zero: calls were observed and none were billable.',
    unknownSemantics: 'Not applicable — a call either carries the flag or does not count toward it.',
    unavailableSemantics: 'The call read failed.',
    completenessRule: 'Complete whenever the window read succeeded.',
    evidenceFields: ['monetized', 'calls'],
    validDimensions: CALL_DIMS,
    invalidCrossGrainUses: ['Never equated with bids won — a won bid is not a billable call.'],
  },
  {
    metricKey: 'totalCalls',
    displayName: 'Total Calls',
    description: 'All calls attributed to the selected period.',
    classification: 'VERIFIED',
    providerSource: CALL_SOURCE,
    providerFields: ['sourceOccurredAt'],
    grain: CALL_DIMS,
    formula: 'count(calls in window)',
    formulaVersion: 'v1',
    timezoneRule: EASTERN_RULE,
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'A true zero: the window was read and contained no calls.',
    unknownSemantics: 'Not applicable.',
    unavailableSemantics: 'The call read failed.',
    completenessRule: 'Complete whenever the window read succeeded.',
    evidenceFields: ['calls'],
    validDimensions: CALL_DIMS,
    invalidCrossGrainUses: [
      'Never used as the denominator for bid or ping outcomes — not every call is a bid opportunity and not every opportunity becomes a call.',
    ],
  },
  {
    metricKey: 'revenuePerBillableCall',
    displayName: 'Revenue per Billable Call',
    description: 'Average revenue earned per billable call — the value side of performance.',
    classification: 'DERIVED',
    providerSource: CALL_SOURCE,
    providerFields: ['revenueCents', 'monetized'],
    grain: CALL_DIMS,
    formula: 'revenue / billableCalls',
    formulaVersion: 'v1',
    timezoneRule: EASTERN_RULE,
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'Zero only when billable calls exist and carried zero revenue.',
    unknownSemantics: 'Unknown when there are no billable calls (no denominator) or revenue is unknown. Never rendered as 0.',
    unavailableSemantics: 'The economics read failed.',
    completenessRule: 'Inherits revenue completeness; partial revenue coverage understates it.',
    evidenceFields: ['revenueCents', 'monetized', 'callsWithRevenue'],
    validDimensions: CALL_DIMS,
    invalidCrossGrainUses: ['Never divided by total calls — that is a different metric (see revenue / totalCalls is not defined here).'],
  },
  {
    metricKey: 'profitPerBillableCall',
    displayName: 'Profit per Billable Call',
    description: 'Average profit per billable call — the margin side of performance.',
    classification: 'DERIVED',
    providerSource: CALL_SOURCE,
    providerFields: ['revenueCents', 'payoutCents', 'costCents', 'monetized'],
    grain: CALL_DIMS,
    formula: 'profit / billableCalls',
    formulaVersion: 'v1',
    timezoneRule: EASTERN_RULE,
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'Zero only when profit is known and nets to zero over known billable calls.',
    unknownSemantics: 'Unknown when profit is unknown or there are no billable calls.',
    unavailableSemantics: 'The economics read failed.',
    completenessRule: 'Inherits profit completeness (weakest of revenue/payout/cost coverage).',
    evidenceFields: ['revenueCents', 'payoutCents', 'costCents', 'monetized'],
    validDimensions: CALL_DIMS,
    invalidCrossGrainUses: ['Not computed at campaign grain unless payout and cost are both attributable there.'],
  },
  {
    metricKey: 'billableRate',
    displayName: 'Billable Rate',
    description: 'Share of calls that were billable. An efficiency measure, not a quality measure.',
    classification: 'DERIVED',
    providerSource: CALL_SOURCE,
    providerFields: ['monetized'],
    grain: CALL_DIMS,
    formula: 'billableCalls / totalCalls',
    formulaVersion: 'v1',
    timezoneRule: EASTERN_RULE,
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'A true zero: calls were observed and none were billable.',
    unknownSemantics: 'Unknown when there are no calls (no denominator).',
    unavailableSemantics: 'The call read failed.',
    completenessRule: 'Complete whenever the window read succeeded.',
    evidenceFields: ['monetized', 'calls'],
    validDimensions: CALL_DIMS,
    invalidCrossGrainUses: [
      'Never described as call QUALITY — CallGrid billability reflects buyer acceptance and duration rules, which the provider does not expose as a quality judgement.',
    ],
  },
  {
    metricKey: 'revenueShare',
    displayName: 'Share of Revenue',
    description: "An entity's revenue as a share of the period's total revenue.",
    classification: 'DERIVED',
    providerSource: CALL_SOURCE,
    providerFields: ['revenueCents'],
    grain: ['buyer', 'vendor', 'source', 'campaign'],
    formula: 'entity.revenue / window.revenue',
    formulaVersion: 'v1',
    timezoneRule: EASTERN_RULE,
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'Zero when the entity earned no revenue in a period that did.',
    unknownSemantics: 'Unknown when window revenue is 0 or unknown — there is no denominator.',
    unavailableSemantics: 'The economics read failed.',
    completenessRule: 'Both numerator and denominator must come from the SAME window read.',
    evidenceFields: ['revenueCents'],
    validDimensions: ['buyer', 'vendor', 'source', 'campaign'],
    invalidCrossGrainUses: ['Shares from different dimensions are never added — every dimension already sums to 100%.'],
  },
  {
    metricKey: 'callShare',
    displayName: 'Share of Call Volume',
    description: "An entity's calls as a share of the period's total calls.",
    classification: 'DERIVED',
    providerSource: CALL_SOURCE,
    providerFields: ['sourceOccurredAt'],
    grain: ['buyer', 'vendor', 'source', 'campaign'],
    formula: 'entity.totalCalls / window.totalCalls',
    formulaVersion: 'v1',
    timezoneRule: EASTERN_RULE,
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'Zero when the entity had no calls in a period that did.',
    unknownSemantics: 'Unknown when the window had no calls.',
    unavailableSemantics: 'The call read failed.',
    completenessRule: 'Both numerator and denominator must come from the SAME window read.',
    evidenceFields: ['calls'],
    validDimensions: ['buyer', 'vendor', 'source', 'campaign'],
    invalidCrossGrainUses: ['Shares from different dimensions are never added.'],
  },
];

// --- Entity counts ------------------------------------------------------------
// IMPORTANT: CallGrid exposes no roster endpoint. An entity is only observable
// through the calls attributed to it, so "total" here means "appeared in this
// period" — NOT "exists on the account". A buyer configured but idle this period
// is invisible to us, and we say so rather than implying a roster we do not have.

const ENTITY_COUNT_NOTE =
  'Counts entities OBSERVED in the selected period. CallGrid exposes no roster of configured entities, so an entity with no calls this period cannot be counted or distinguished from one that does not exist.';

function entityCount(dim: 'buyer' | 'vendor' | 'source' | 'campaign', plural: string): CallGridMetricDefinition[] {
  const cap = plural[0]!.toUpperCase() + plural.slice(1);
  return [
    {
      metricKey: `total${cap}`,
      displayName: `${cap} Observed`,
      description: `Distinct ${plural} with at least one call attributed in the selected period.`,
      classification: 'DERIVED',
      providerSource: CALL_SOURCE,
      providerFields: [`${dim}ExternalId`],
      grain: ['window'],
      formula: `count(distinct ${dim}ExternalId in window)`,
      formulaVersion: 'v1',
      timezoneRule: EASTERN_RULE,
      dateWindowSupport: 'arbitrary_window',
      comparisonSupport: 'elapsed_matched',
      zeroSemantics: 'A true zero: the window was read and no such entity appeared.',
      unknownSemantics: 'Not applicable.',
      unavailableSemantics: 'The call read failed.',
      completenessRule: ENTITY_COUNT_NOTE,
      evidenceFields: [`${dim}ExternalId`, `${dim}Label`],
      validDimensions: ['window'],
      invalidCrossGrainUses: [
        `Never presented as the number of configured ${plural} on the CallGrid account — that roster is not exposed.`,
      ],
    },
    {
      metricKey: `active${cap}`,
      displayName: `Active ${cap}`,
      description: `${cap} that produced revenue or billable calls in the selected period.`,
      classification: 'DERIVED',
      providerSource: CALL_SOURCE,
      providerFields: [`${dim}ExternalId`, 'monetized', 'revenueCents'],
      grain: ['window'],
      formula: `count(distinct ${dim}ExternalId where billableCalls > 0 or revenue > 0)`,
      formulaVersion: 'v2',
      timezoneRule: EASTERN_RULE,
      dateWindowSupport: 'arbitrary_window',
      comparisonSupport: 'elapsed_matched',
      zeroSemantics: 'A true zero: entities appeared but none produced revenue or a billable call.',
      unknownSemantics: 'Not applicable.',
      unavailableSemantics: 'The call read failed.',
      completenessRule: `${ENTITY_COUNT_NOTE} "Active" is strictly narrower than observed: it requires economic activity, not merely a call.`,
      evidenceFields: [`${dim}ExternalId`, 'monetized', 'revenueCents'],
      validDimensions: ['window'],
      invalidCrossGrainUses: [],
    },
  ];
}

const ENTITY_COUNTS: CallGridMetricDefinition[] = [
  ...entityCount('buyer', 'buyers'),
  ...entityCount('vendor', 'vendors'),
  ...entityCount('source', 'sources'),
  ...entityCount('campaign', 'campaigns'),
];

// --- Bid metrics: SOURCE grain -------------------------------------------------

function bidSourceMetric(
  metricKey: string,
  displayName: string,
  field: string,
  description: string,
  extraInvalid: readonly string[] = [],
): CallGridMetricDefinition {
  return {
    metricKey,
    displayName,
    description,
    classification: 'VERIFIED',
    providerSource: BID_SOURCE_SNAPSHOT,
    providerFields: [field],
    grain: ['bid_source'],
    formula: `provider field ${field}, stored verbatim`,
    formulaVersion: 'v1',
    timezoneRule: SNAPSHOT_RULE,
    dateWindowSupport: 'latest_snapshot_only',
    comparisonSupport: 'snapshot_only',
    zeroSemantics: 'Zero only when the provider reported 0 for this source.',
    unknownSemantics: 'The report returned no row for this source. That is NOT zero, and is never summed as zero.',
    unavailableSemantics: 'No bid snapshot has been synchronized.',
    completenessRule: 'A sum across sources counts only sources that reported the field, and discloses how many did.',
    evidenceFields: [field, 'sourceExternalId', 'reportWindowStart', 'reportWindowEnd', 'fetchedAt'],
    validDimensions: ['bid_source'],
    invalidCrossGrainUses: [...NEVER_CROSS_GRAIN, ...extraInvalid],
  };
}

const BID_SOURCE_METRICS: CallGridMetricDefinition[] = [
  bidSourceMetric('bidOpportunities', 'Bid Opportunities', 'total', 'Opportunities the source presented for bidding.'),
  bidSourceMetric('bidsSubmitted', 'Bids Submitted', 'bids', 'Opportunities on which a bid was actually submitted.'),
  bidSourceMetric('bidsWon', 'Bids Won', 'won', 'Submitted bids that won.'),
  bidSourceMetric('rejectedOpportunities', 'Rejected Opportunities', 'rejected', 'Opportunities rejected rather than bid on or won.'),
  {
    metricKey: 'sourceWinRate',
    displayName: 'Source Win Rate',
    description: 'Share of SUBMITTED bids that won.',
    classification: 'DERIVED',
    providerSource: BID_SOURCE_SNAPSHOT,
    providerFields: ['won', 'bids'],
    grain: ['bid_source'],
    formula: 'won / bids',
    formulaVersion: 'v1',
    timezoneRule: SNAPSHOT_RULE,
    dateWindowSupport: 'latest_snapshot_only',
    comparisonSupport: 'snapshot_only',
    zeroSemantics: 'Zero when bids were submitted and none won.',
    unknownSemantics: 'Unknown when no bids were submitted — there is no denominator.',
    unavailableSemantics: 'No bid snapshot has been synchronized.',
    completenessRule: 'Both fields must come from the same snapshot row.',
    evidenceFields: ['won', 'bids', 'sourceExternalId'],
    validDimensions: ['bid_source'],
    invalidCrossGrainUses: [
      ...NEVER_CROSS_GRAIN,
      'NEVER won / total (opportunities). Opportunities include those never bid on; dividing by them conflates two different failures and understates the rate.',
    ],
  },
  {
    metricKey: 'sourceRejectRate',
    displayName: 'Source Reject Rate',
    description: "The provider's own reject rate for the source, stored verbatim.",
    classification: 'VERIFIED',
    providerSource: BID_SOURCE_SNAPSHOT,
    providerFields: ['rejectRatePercent'],
    grain: ['bid_source'],
    formula: 'provider field rejectRatePercent, stored verbatim',
    formulaVersion: 'v1',
    timezoneRule: SNAPSHOT_RULE,
    dateWindowSupport: 'latest_snapshot_only',
    comparisonSupport: 'snapshot_only',
    zeroSemantics: 'Zero when the provider reported a 0% reject rate.',
    unknownSemantics: 'Unknown when the provider did not report a rate. It is NOT recomputed from counts — the provider owns this denominator.',
    unavailableSemantics: 'No bid snapshot has been synchronized.',
    completenessRule: 'Used only as reported; never reconstructed.',
    evidenceFields: ['rejectRatePercent', 'sourceExternalId'],
    validDimensions: ['bid_source'],
    invalidCrossGrainUses: NEVER_CROSS_GRAIN,
  },
  bidSourceMetric('failedAcceptance', 'Failed Acceptance', 'failedAcceptance', 'Opportunities where the bid was not accepted downstream.'),
  bidSourceMetric('duplicateBids', 'Duplicate Bids', 'duplicateBids', 'Bids rejected as duplicates of an existing bid.', [
    'Never summed with duplicateCaller — the provider reports them as distinct conditions.',
  ]),
  bidSourceMetric('closedTarget', 'Closed Target', 'closed', 'Opportunities rejected because the target was closed.'),
  bidSourceMetric('pausedTarget', 'Paused Target', 'paused', 'Opportunities rejected because the target was paused.'),
  bidSourceMetric('failedTagRules', 'Failed Tag Rules', 'failedTagRules', 'Opportunities rejected by tag-rule evaluation at source grain.'),
  bidSourceMetric('duplicateCaller', 'Duplicate Caller', 'duplicateCaller', 'Opportunities rejected because the caller was already seen.', [
    'Never summed with duplicateBids.',
  ]),
  bidSourceMetric('callerIdRejected', 'Caller ID Rejected', 'callerIdRejected', 'Opportunities rejected on caller-ID rules.'),
];

// --- Bid metrics: DESTINATION grain --------------------------------------------

function destinationMetric(metricKey: string, displayName: string, field: string, description: string): CallGridMetricDefinition {
  return {
    metricKey,
    displayName,
    description,
    classification: 'VERIFIED',
    providerSource: PING_SNAPSHOT,
    providerFields: [field],
    grain: ['bid_destination'],
    formula: `provider field ${field}, stored verbatim`,
    formulaVersion: 'v1',
    timezoneRule: SNAPSHOT_RULE,
    dateWindowSupport: 'latest_snapshot_only',
    comparisonSupport: 'snapshot_only',
    zeroSemantics: 'Zero only when the provider reported 0 for this destination.',
    unknownSemantics: 'The report returned no row for this destination. That is NOT zero.',
    unavailableSemantics: 'No ping snapshot has been synchronized.',
    completenessRule: 'A sum counts only destinations that reported the field, and discloses how many did.',
    evidenceFields: [field, 'destinationExternalId', 'reportWindowStart', 'reportWindowEnd', 'fetchedAt'],
    validDimensions: ['bid_destination'],
    invalidCrossGrainUses: [
      'Never added to, or divided by, a bid-SOURCE metric — a destination outcome is not a source opportunity.',
      'Destination "accepted" is not a total-pings denominator and is never labelled as one.',
    ],
  };
}

const BID_DESTINATION_METRICS: CallGridMetricDefinition[] = [
  destinationMetric('destinationAccepted', 'Accepted', 'accepted', 'Pings the destination accepted.'),
  destinationMetric('destinationRateLimited', 'Rate Limited', 'rateLimited', 'Pings rejected because the destination was at its configured throughput limit.'),
  destinationMetric('destinationTimedOut', 'Timed Out', 'pingTimeout', 'Pings that did not receive a response in time.'),
  destinationMetric('destinationBelowMinimumRevenue', 'Below Minimum Revenue', 'minRevenue', 'Pings rejected because the offer was under the destination minimum.'),
  destinationMetric('destinationFailedTagRules', 'Failed Tag Rules', 'failedTagRules', 'Pings rejected by tag-rule evaluation at destination grain.'),
  destinationMetric('destinationFailedAcceptance', 'Failed Acceptance', 'failedAcceptance', 'Pings the destination did not accept.'),
  destinationMetric('destinationApiFailed', 'API Failed', 'apiFailed', 'Pings that failed because the destination endpoint errored.'),
  destinationMetric('destinationSuppressed', 'Suppressed', 'suppressed', 'Pings suppressed before reaching the destination.'),
  destinationMetric('destinationInvalidNumber', 'Invalid Number', 'invalidNumber', 'Pings rejected for an invalid number.'),
  destinationMetric('destinationMissingAmount', 'Missing Amount', 'missingAmount', 'Pings rejected because no bid amount was supplied.'),
];

// --- Trend metrics --------------------------------------------------------------

const TREND_METRICS: CallGridMetricDefinition[] = [
  {
    metricKey: 'absoluteChange',
    displayName: 'Absolute Change',
    description: 'Current value less comparison value, in the metric\'s own unit.',
    classification: 'DERIVED',
    providerSource: 'Two canonical window reads of the same underlying metric',
    providerFields: [],
    grain: CALL_DIMS,
    formula: 'current - comparison',
    formulaVersion: 'v1',
    timezoneRule: 'Both windows are Eastern and, for an in-progress selection, cut at equal elapsed time.',
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'A true zero: both periods are known and equal.',
    unknownSemantics: 'Unknown when either side is unknown or unavailable.',
    unavailableSemantics: 'No comparison window is defined for the selection.',
    completenessRule: 'Both sides must have the same completeness, or the difference is disclosed as partial.',
    evidenceFields: ['current', 'comparison'],
    validDimensions: CALL_DIMS,
    invalidCrossGrainUses: ['Never computed across a partial and a complete period.'],
  },
  {
    metricKey: 'percentageChange',
    displayName: 'Percentage Change',
    description: 'Change relative to the comparison value.',
    classification: 'DERIVED',
    providerSource: 'Two canonical window reads of the same underlying metric',
    providerFields: [],
    grain: CALL_DIMS,
    formula: '(current - comparison) / comparison',
    formulaVersion: 'v1',
    timezoneRule: 'Both windows are Eastern and, for an in-progress selection, cut at equal elapsed time.',
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'A true zero: both periods are known and equal.',
    unknownSemantics: 'Unknown when the comparison value is 0, unknown or unavailable — there is no denominator, and "infinite growth" is not reported.',
    unavailableSemantics: 'No comparison window is defined for the selection.',
    completenessRule: 'Never computed against a comparison of a different elapsed length.',
    evidenceFields: ['current', 'comparison'],
    validDimensions: CALL_DIMS,
    invalidCrossGrainUses: ['Never computed against a zero baseline.'],
  },
  {
    metricKey: 'shareChange',
    displayName: 'Share Change',
    description: "Change in an entity's share of its dimension, in percentage points.",
    classification: 'DERIVED',
    providerSource: 'Two canonical window reads',
    providerFields: [],
    grain: ['buyer', 'vendor', 'source', 'campaign'],
    formula: 'currentShare - comparisonShare (percentage points, never a percentage of a percentage)',
    formulaVersion: 'v1',
    timezoneRule: 'Both windows Eastern, equal elapsed length.',
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'Share held steady.',
    unknownSemantics: 'Unknown when either window total is 0 or unknown.',
    unavailableSemantics: 'No comparison window.',
    completenessRule: 'Both shares must be computed within their own window.',
    evidenceFields: ['currentShare', 'comparisonShare'],
    validDimensions: ['buyer', 'vendor', 'source', 'campaign'],
    invalidCrossGrainUses: ['Percentage points are never described as a percentage change.'],
  },
  {
    metricKey: 'rankChange',
    displayName: 'Rank Change',
    description: "Movement in an entity's position within the same ranked dimension report.",
    classification: 'DERIVED',
    providerSource: 'Two canonical window reads, ranked by the same key',
    providerFields: [],
    grain: ['buyer', 'vendor', 'source', 'campaign'],
    formula: 'comparisonRank - currentRank (positive = moved up)',
    formulaVersion: 'v1',
    timezoneRule: 'Both windows Eastern, equal elapsed length.',
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'Rank unchanged.',
    unknownSemantics: 'Unknown when the entity is absent from one of the periods — that is an entry/exit, reported as such rather than as a rank move.',
    unavailableSemantics: 'No comparison window.',
    completenessRule: 'Both ranks must come from the SAME ranked collection and sort key the subpage displays.',
    evidenceFields: ['currentRank', 'comparisonRank'],
    validDimensions: ['buyer', 'vendor', 'source', 'campaign'],
    invalidCrossGrainUses: ['Ranks from differently-sorted tables are never compared.'],
  },
  {
    metricKey: 'contributionToChange',
    displayName: 'Contribution to Change',
    description: "How much of the window's total change an entity accounts for.",
    classification: 'DERIVED',
    providerSource: 'Two canonical window reads',
    providerFields: [],
    grain: ['buyer', 'vendor', 'source', 'campaign'],
    formula: 'entity.absoluteChange / window.absoluteChange',
    formulaVersion: 'v1',
    timezoneRule: 'Both windows Eastern, equal elapsed length.',
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'The entity did not move.',
    unknownSemantics: 'Unknown when the window change is 0 — offsetting movements have no meaningful share.',
    unavailableSemantics: 'No comparison window.',
    completenessRule: 'Entity changes must sum to the window change; a mismatch means the dimension is incomplete and the analysis is withheld.',
    evidenceFields: ['entityChange', 'windowChange'],
    validDimensions: ['buyer', 'vendor', 'source', 'campaign'],
    invalidCrossGrainUses: [
      'Contribution is NOT causation. An entity accounting for a share of a decline is the largest contributor to it, never proven to have caused it.',
    ],
  },
  {
    metricKey: 'concentrationChange',
    displayName: 'Concentration Change',
    description: 'Change in how concentrated a dimension is in its top entities.',
    classification: 'DERIVED',
    providerSource: 'Two canonical window reads',
    providerFields: [],
    grain: ['buyer', 'vendor', 'source', 'campaign'],
    formula: 'currentTopShare - comparisonTopShare (percentage points)',
    formulaVersion: 'v1',
    timezoneRule: 'Both windows Eastern, equal elapsed length.',
    dateWindowSupport: 'arbitrary_window',
    comparisonSupport: 'elapsed_matched',
    zeroSemantics: 'Concentration held steady.',
    unknownSemantics: 'Unknown when either window has no total to divide by.',
    unavailableSemantics: 'No comparison window.',
    completenessRule: 'Top-N must be the same N on both sides.',
    evidenceFields: ['currentTopShare', 'comparisonTopShare'],
    validDimensions: ['buyer', 'vendor', 'source', 'campaign'],
    invalidCrossGrainUses: ['Concentration is a dependency measure, never a judgement that a dimension is unhealthy.'],
  },
];

// --- Metrics the provider does not support -------------------------------------
// Declared so that surfaces can state WHY something is absent instead of leaving a
// blank, and so nobody re-derives them from data that cannot support them.

export interface UnavailableMetric {
  metricKey: string;
  displayName: string;
  /** Why it cannot be produced — shown to operators in the Unknowns section. */
  reason: string;
}

export const CALLGRID_UNAVAILABLE_METRICS: readonly UnavailableMetric[] = [
  {
    metricKey: 'volatility',
    displayName: 'Volatility',
    reason: 'Volatility needs a rolling series of comparable windows. CallGrid Intelligence reads the selected window and one comparison window, so there is no baseline distribution to measure against.',
  },
  {
    metricKey: 'consecutiveDirectionDays',
    displayName: 'Sustained Direction',
    reason: 'Counting consecutive days of movement needs per-day history for the selection. Only the selected window and its comparison are read, so a run length cannot be established.',
  },
  {
    metricKey: 'buyerCapacity',
    displayName: 'Buyer Capacity / Caps',
    reason: 'CallGrid does not expose buyer capacity, caps, schedules, or availability. A drop in a buyer\'s volume therefore cannot be attributed to a cap being reached.',
  },
  {
    metricKey: 'bidOpportunityValue',
    displayName: 'Per-Opportunity Value',
    reason: 'Bid reports carry no revenue per opportunity, so revenue can never be attached to an individual bid failure and "recoverable revenue" cannot be computed.',
  },
  {
    metricKey: 'vendorCost',
    displayName: 'Vendor Cost',
    reason: 'Cost is attributed per call, not per vendor agreement. Vendor-level cost is not separately exposed.',
  },
  {
    metricKey: 'bidHistory',
    displayName: 'Historical Bid Snapshots',
    reason: 'The bid report endpoints accept no date range. Only the latest synchronized snapshot is stored, so bid metrics cannot be compared over time or aligned to the selected calendar period.',
  },
  {
    metricKey: 'routeFallback',
    displayName: 'Route Fallback Behaviour',
    reason: 'CallGrid does not report whether an alternate destination was tried after a rejection, so the downstream consequence of a rejection is unknown.',
  },
];

// --- The registry ---------------------------------------------------------------

export const CALLGRID_METRICS: readonly CallGridMetricDefinition[] = [
  ...CALL_PERFORMANCE,
  ...ENTITY_COUNTS,
  ...BID_SOURCE_METRICS,
  ...BID_DESTINATION_METRICS,
  ...TREND_METRICS,
];

const BY_KEY = new Map(CALLGRID_METRICS.map((m) => [m.metricKey, m] as const));

/** Look up a metric definition. Returns null for an unknown key — a caller that
 *  needs a definition it cannot find must not invent one. */
export function metricDefinition(metricKey: string): CallGridMetricDefinition | null {
  return BY_KEY.get(metricKey) ?? null;
}

/** Whether a metric may legitimately be broken down by a grain. */
export function isValidDimensionFor(metricKey: string, grain: MetricGrain): boolean {
  return metricDefinition(metricKey)?.validDimensions.includes(grain) ?? false;
}

/** Why a metric cannot be produced at all, or null when it can. */
export function unavailableReason(metricKey: string): string | null {
  return CALLGRID_UNAVAILABLE_METRICS.find((m) => m.metricKey === metricKey)?.reason ?? null;
}

// --- Canonical formulas ---------------------------------------------------------
// The ONE implementation of each formula the contract declares. Every one returns
// null rather than a placeholder when its inputs cannot support an answer — that
// null is what becomes "Unknown" on screen instead of a fabricated zero.

/** Revenue less payout and cost. Null when revenue is unknown. */
export function profitCents(revenueCents: number | null, payoutCents: number, costCents: number): number | null {
  return revenueCents === null ? null : revenueCents - payoutCents - costCents;
}

/** Revenue per billable call. Null when there is no billable denominator. */
export function revenuePerBillableCall(revenueCents: number | null, billableCalls: number): number | null {
  if (revenueCents === null || billableCalls <= 0) return null;
  return Math.round(revenueCents / billableCalls);
}

/** Profit per billable call. Null when profit is unknown or no billable calls. */
export function profitPerBillableCall(profit: number | null, billableCalls: number): number | null {
  if (profit === null || billableCalls <= 0) return null;
  return Math.round(profit / billableCalls);
}

/** Billable calls as a fraction (0–1) of total calls. Null with no denominator. */
export function billableRate(billableCalls: number, totalCalls: number): number | null {
  if (totalCalls <= 0) return null;
  return billableCalls / totalCalls;
}

/** A part as a fraction (0–1) of a whole. Null when the whole is 0 or unknown. */
export function share(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null;
  return part / whole;
}

/** Won divided by SUBMITTED bids — never by opportunities. Null with no bids. */
export function sourceWinRate(won: number | null, bidsSubmitted: number | null): number | null {
  if (won === null || bidsSubmitted === null || bidsSubmitted <= 0) return null;
  return won / bidsSubmitted;
}

/** Current less comparison. Null when either side is unknown. */
export function absoluteChange(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null) return null;
  return current - comparison;
}

/** Relative change as a fraction. Null when there is no non-zero baseline — an
 *  increase from zero is reported as an entry, never as an infinite percentage. */
export function percentageChange(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null || comparison === 0) return null;
  return (current - comparison) / comparison;
}

/** An entity's share of the window's total change. Null when the window did not
 *  move (offsetting movements have no meaningful denominator). Uses magnitudes so
 *  a contribution to a decline reads as a positive share OF that decline. */
export function contributionToChange(entityChange: number | null, windowChange: number | null): number | null {
  if (entityChange === null || windowChange === null || windowChange === 0) return null;
  return entityChange / windowChange;
}

/** Percentage-point difference between two shares. Null when either is unknown. */
export function shareChangePoints(currentShare: number | null, comparisonShare: number | null): number | null {
  if (currentShare === null || comparisonShare === null) return null;
  return (currentShare - comparisonShare) * 100;
}

/**
 * Sum a nullable field across rows WITHOUT coercing absence to zero.
 *
 * Returns the total plus how many rows actually reported the field, so a caller
 * can disclose partial coverage. `total` is null when NO row reported it — the
 * difference between "they all reported 0" and "nobody told us" is the whole
 * point of this function existing.
 */
export function sumReported<T>(rows: readonly T[], pick: (row: T) => number | null): {
  total: number | null;
  reported: number;
  of: number;
} {
  let total = 0;
  let reported = 0;
  for (const row of rows) {
    const v = pick(row);
    if (typeof v === 'number' && Number.isFinite(v)) {
      total += v;
      reported += 1;
    }
  }
  return { total: reported > 0 ? total : null, reported, of: rows.length };
}

/** Coverage as a fraction (0–1): how much of a window carried a value. Null when
 *  there is nothing to cover. */
export function coverage(withValue: number, total: number): number | null {
  if (total <= 0) return null;
  return withValue / total;
}

/** The classification a value earns given whether it resolved and how it was made. */
export function classifyValue(
  value: number | null,
  available: boolean,
  best: 'VERIFIED' | 'DERIVED',
): MetricClassification {
  if (!available) return 'UNAVAILABLE';
  if (value === null) return 'UNKNOWN';
  return best;
}

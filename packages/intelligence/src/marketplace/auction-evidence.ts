// Auction metrics → the platform Evidence Engine's contract.
//
// This is an `EvidenceContributor`, the same contract the marketplace call
// projection implements. Auction findings therefore pass through the SAME gate
// as marketplace coverage findings. There is deliberately no second engine: a
// parallel gate would drift, and the first thing to drift would be the
// suppression rules — the one part of this system whose purpose is strictness.
//
// It emits observations only. Coverage, sample size, confidence, freshness and
// withholding are derived by the platform, uniformly.
//
// TWO GRAINS, STRUCTURALLY SEPARATED
//
// Every metric id is prefixed `auction.source.` or `auction.destination.`.
// `assertSingleGrain` refuses a rule that names both. Source and destination are
// opposite sides of the marketplace, and a rule that quietly reads one of each
// would produce a finding about a relationship no provider data asserts.
// Enforcing it in the id rather than in review is the point — a naming
// convention that a function checks is a rule; one that only a human checks is a
// suggestion.
//
// Pure. Timestamps are passed in.

import type {
  Contradiction,
  EvidenceContributor,
  EvidenceReport,
  MetricObservation,
} from '../evidence/types';
import { assessEvidence } from '../evidence/engine';

export type AuctionGrain = 'source' | 'destination';

export const SOURCE_PREFIX = 'auction.source.';
export const DESTINATION_PREFIX = 'auction.destination.';

/** One measured auction quantity, before it earns a confidence. */
export interface AuctionObservation {
  /** Bare metric name, e.g. 'rejected'. The prefix is applied here, not by callers. */
  name: string;
  label: string;
  grain: AuctionGrain;
  /** Summed across rows that reported the field. Null when no row did. */
  value: number | null;
  /** Rows that reported this field. */
  rowsReporting: number;
  /** Rows examined at this grain. */
  rowsExamined: number;
  /**
   * The denominator this metric is measured against, when one is PROVEN.
   * Null means no proven denominator — a rate over it may not be published.
   */
  denominator: number | null;
  denominatorName: string | null;
  /** What Loop could not establish about this metric. */
  unknowns?: readonly string[];
  /** Fields the PROVIDER did not supply that this metric would benefit from. */
  missingProviderData?: readonly string[];
  /**
   * Two sources disagreeing about this metric — for example a bid-report total
   * that conflicts with the canonical call projection. Reachable now that a
   * second source exists; the engine withholds on any contradiction.
   */
  contradictions?: readonly Contradiction[];
}

/** One grain's worth of auction observations. Assessed independently — see the contributor. */
export interface AuctionEvidenceInput {
  grain: AuctionGrain;
  windowLabel: string;
  observations: readonly AuctionObservation[];
  /** Rows examined at THIS grain. Drives the engine's sample gate. */
  rowsExamined: number;
  /**
   * True only when a money field carried a fractional part on this run.
   * Money metrics are unusable when false, because a 100x unit error in a
   * financial figure is not a degraded answer — it is a wrong one.
   */
  moneyUnitProven: boolean;
  /** The endpoint these rows came from, recorded as provenance citation. */
  endpoint?: string | null;
}

export function metricId(grain: AuctionGrain, name: string): string {
  return (grain === 'source' ? SOURCE_PREFIX : DESTINATION_PREFIX) + name;
}

export function grainOf(id: string): AuctionGrain | null {
  if (id.startsWith(SOURCE_PREFIX)) return 'source';
  if (id.startsWith(DESTINATION_PREFIX)) return 'destination';
  return null;
}

/**
 * Refuse a rule that reads across grains.
 *
 * Returns the reason it was refused, or null when the rule is grain-consistent.
 * Callers suppress rather than throw so one badly declared rule cannot take the
 * whole engine down — but the suppression reason names the defect plainly.
 */
export function assertSingleGrain(metricIds: readonly string[]): string | null {
  const grains = new Set(metricIds.map(grainOf));
  if (grains.has(null)) {
    return 'Rule names a metric outside the auction namespace; auction rules may only read auction.source.* or auction.destination.* metrics.';
  }
  if (grains.size > 1) {
    return 'Rule reads BOTH source-grain and destination-grain metrics. Those are opposite sides of the marketplace and no cross-grain contract exists; a finding combining them would assert a relationship the provider does not.';
  }
  return null;
}

/** Money-denominated metrics, unusable until the provider unit is proven. */
const MONEY_METRICS: readonly string[] = [
  'totalBidAmountCents', 'totalWonAmountCents', 'avgBidCents', 'avgWinningBidCents',
];

/**
 * Auction reporting as an Evidence Engine contributor.
 *
 * ONE CONTRIBUTOR, INVOKED ONCE PER GRAIN.
 *
 * The engine derives a metric's sample factor from `populationSize`, which is a
 * single number per report. Source and destination grains have independent row
 * counts, so a combined report would lend one grain's sample weight to the
 * other — 50 source rows would make a 2-row destination metric look better
 * evidenced than it is.
 *
 * Assessing each grain separately fixes that, and does something better: it
 * makes the grain separation STRUCTURAL. Two reports that are never merged
 * cannot produce a cross-grain finding, because there is no report containing
 * both sides to read from. The `auction.source.` / `auction.destination.`
 * prefixes and `assertSingleGrain` remain as a second line of defence.
 */
export const auctionEvidenceContributor: EvidenceContributor<AuctionEvidenceInput> = {
  domain: 'marketplace',

  // Rows at THIS grain only — see the note above.
  populationSize: (input) => input.rowsExamined,
  scopeLabel: (input) => `${input.windowLabel} (${input.grain} grain)`,

  // The GET report endpoints return no per-row timestamp and accept no
  // reportTimeZone parameter, so there is nothing to measure an age against.
  // Declaring a threshold would imply a check that cannot run.
  staleAfterMs: null,

  emptyScopeReason: (input) =>
    `No ${input.grain} rows were reported in ${input.windowLabel}, so this metric has nothing to measure. Unknown is not zero.`,

  observe(input): readonly MetricObservation[] {
    return input.observations.map((o) => {
      const unknowns = [...(o.unknowns ?? [])];
      if (o.denominator === null) {
        unknowns.push(
          `No proven denominator for ${o.label}, so it may be reported as a count but not as a rate.`,
        );
      }

      // Ordered by how fundamental the obstacle is. `rowsExamined === 0` is not
      // handled here — that is the engine's empty-scope rule, and duplicating it
      // would give the same condition two different sentences.
      let unusable: { reason: string } | null = null;
      if (o.value === null && o.rowsExamined > 0) {
        unusable = { reason: `No ${input.grain} row reported ${o.label}. This is unknown, NOT zero.` };
      } else if (MONEY_METRICS.includes(o.name) && !input.moneyUnitProven) {
        unusable = {
          reason:
            'The provider money unit was not PROVEN on this run — every money value came back a whole number, which is consistent with dollars and equally consistent with cents. A 100x error in a financial figure is a wrong answer, not a degraded one.',
        };
      }

      return {
        metricId: metricId(o.grain, o.name),
        label: o.label,
        observed: o.rowsReporting,
        total: o.rowsExamined,
        // An auction metric is never STRUCTURALLY absent: the field exists on
        // the contract. A field no row reported is a measured absence, which is
        // why it becomes `unusable` rather than `structurallyAbsent` — the
        // latter scores at the confidence ceiling and does not withhold.
        structurallyAbsent: null,
        provenance: [
          {
            sourceId: `callgrid-${o.grain}-report`,
            sourceLabel: `CallGrid aggregate report (${o.grain} grain)`,
            derivation:
              o.value === null
                ? `SUM of ${o.name} across ${o.rowsExamined} ${o.grain} row(s); no row reported the field`
                : `SUM of ${o.name} across ${o.rowsReporting} of ${o.rowsExamined} ${o.grain} row(s)`,
            citation: input.endpoint ?? null,
          },
        ],
        unknowns,
        contradictions: o.contradictions ?? [],
        missingProviderData: o.missingProviderData ?? [],
        sourceObservedAt: null,
        unusable,
      };
    });
  },
};

/**
 * The measured scalars, keyed by metric id.
 *
 * Values live here rather than on `MetricEvidence` because the Evidence Engine
 * records the evidential position on a metric, not the quantity. A rule reads
 * this through `GatedContext.value` only AFTER the gate has cleared the metric.
 */
export function auctionValues(input: AuctionEvidenceInput): ReadonlyMap<string, number | null> {
  return new Map(input.observations.map((o) => [metricId(o.grain, o.name), o.value]));
}

/**
 * Sum one field across snapshot rows, null-aware, and shape it as an observation.
 *
 * Returns `value: null` when NO row reported the field. Summing absent fields as
 * zero would turn "the provider never sent this" into a confident 0 — and a
 * confident 0 on `rateLimited` reads as "no rate limiting is happening", which
 * is precisely the failure category this sprint exists to detect.
 */
export function observe(
  rows: ReadonlyArray<Record<string, unknown>>,
  name: string,
  label: string,
  grain: AuctionGrain,
  opts: { denominator?: number | null; denominatorName?: string | null; missingProviderData?: readonly string[] } = {},
): AuctionObservation {
  let total = 0;
  let rowsReporting = 0;
  for (const row of rows) {
    const v = row[name];
    if (typeof v === 'number' && Number.isFinite(v)) {
      total += v;
      rowsReporting += 1;
    }
  }
  return {
    name,
    label,
    grain,
    value: rowsReporting > 0 ? total : null,
    rowsReporting,
    rowsExamined: rows.length,
    denominator: opts.denominator ?? null,
    denominatorName: opts.denominatorName ?? null,
    missingProviderData: opts.missingProviderData ?? [],
  };
}

/**
 * Assess both grains, as two reports that are never merged.
 *
 * A single entry point for callers, without a single report: the two
 * `EvidenceReport`s stay separate all the way to `runAuctionIntelligence`,
 * which is called once per grain. There is deliberately no combined report to
 * hand to a rule.
 *
 * The value maps ARE merged, and safely so — metric ids carry their grain, so
 * a source key cannot collide with a destination key. Merging the values is a
 * lookup convenience; merging the evidence would be a claim about the data.
 */
export interface AuctionAssessment {
  source: EvidenceReport;
  destination: EvidenceReport;
  values: ReadonlyMap<string, number | null>;
}

export function assessAuction(input: {
  measuredAt: string;
  windowLabel: string;
  observations: readonly AuctionObservation[];
  /** Rows examined at each grain. Kept apart — see the contributor. */
  sourceRowsExamined: number;
  destinationRowsExamined: number;
  moneyUnitProven: boolean;
  sourceEndpoint?: string | null;
  destinationEndpoint?: string | null;
}): AuctionAssessment {
  const forGrain = (grain: AuctionGrain): AuctionEvidenceInput => ({
    grain,
    windowLabel: input.windowLabel,
    observations: input.observations.filter((o) => o.grain === grain),
    rowsExamined: grain === 'source' ? input.sourceRowsExamined : input.destinationRowsExamined,
    moneyUnitProven: input.moneyUnitProven,
    endpoint: (grain === 'source' ? input.sourceEndpoint : input.destinationEndpoint) ?? null,
  });

  const source = forGrain('source');
  const destination = forGrain('destination');

  return {
    source: assessEvidence(auctionEvidenceContributor, source, input.measuredAt),
    destination: assessEvidence(auctionEvidenceContributor, destination, input.measuredAt),
    values: new Map([...auctionValues(source), ...auctionValues(destination)]),
  };
}

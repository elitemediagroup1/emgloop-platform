// Auction intelligence rules — only what the observed contracts support.
//
// Every rule here reads a VERIFIED provider count and reports it as a count,
// with an explicit denominator taken from the same row. Nothing here relabels a
// provider rate, prices a failure, or names a dominant cause.
//
// WHAT IS DELIBERATELY NOT BUILT, AND WHY — see `unbuiltAuctionRules()`.
// That list is part of the product. A withheld capability with a stated reason
// is information; a missing capability with no explanation is just a gap someone
// will fill badly later.
//
// Pure. Runs through the shared `runRules` gate, not a private one.

import type { MarketplaceRule, RuleSuppression } from './engine';
import { runRules } from './engine';
import type { EvidenceReport } from '../evidence/types';
import type { MarketplaceFinding, RuleOutcome } from './rule';
import { publishFinding } from './rule';
import type { FailureCategory, FailureOwner } from './taxonomy';
import { assertSingleGrain, metricId, type AuctionGrain } from './auction-evidence';

/**
 * A failure category measured as a count against a same-row denominator.
 *
 * The denominator matters more than the count. "982 rate-limited" is a number;
 * "982 rate-limited out of 478,504 examined" is a finding. `publishFinding`
 * refuses any evidence statement phrased as a rate without one, which is what
 * stops a large-looking count from being published against nothing.
 */
interface VolumeRuleSpec {
  id: string;
  grain: AuctionGrain;
  /** Bare metric name; the grain prefix is applied by `metricId`. */
  metric: string;
  /** Metric supplying the denominator, at the SAME grain. */
  denominatorMetric: string;
  label: string;
  category: FailureCategory;
  owner: FailureOwner;
  whatHappened: (count: number, denominator: number) => string;
  why: string;
  recommendedAction: string;
  /** Below this share of the denominator the rule stays silent. */
  minimumShare: number;
  minimumSampleSize: number;
  minimumConfidence: number;
}

function volumeRule(spec: VolumeRuleSpec): MarketplaceRule {
  const id = metricId(spec.grain, spec.metric);
  const denomId = metricId(spec.grain, spec.denominatorMetric);

  return {
    id: spec.id,
    purpose: `${spec.label} volume at ${spec.grain} grain`,
    owner: spec.owner,
    requires: {
      metrics: [id, denomId],
      minimumConfidence: spec.minimumConfidence,
      minimumSampleSize: spec.minimumSampleSize,
      // Aggregate rows either report a field or do not; there is no partial
      // coverage of a row the way there is of a call. The metric-level
      // confidence already carries rows-reporting/rows-examined.
      coverageRequirement: null,
    },
    evaluate(ctx): RuleOutcome | null {
      const m = ctx.metric(id);
      const d = ctx.metric(denomId);

      // Values come from the domain, not from the evidence record — the
      // Evidence Engine holds the evidential position on a metric, not the
      // quantity. Reading them through the gated context keeps the ordering
      // guarantee: nothing is read until checkRequirements has cleared it.
      const count = ctx.value(id);
      const denominator = ctx.value(denomId);

      if (count === null || denominator === null || denominator <= 0) return null;
      if (count <= 0) return null; // zero failures is a healthy silence, not a finding
      if (count / denominator < spec.minimumShare) return null;

      const finding: MarketplaceFinding = {
        id: spec.id,
        whatHappened: spec.whatHappened(count, denominator),
        why: spec.why,
        owner: spec.owner,
        entity: null,
        category: spec.category,
        impact: {
          kind: 'volume-only',
          lostOpportunities: count,
          // Pricing this would need per-opportunity revenue at the auction
          // grain, which no endpoint that returned data supplies.
          whyNotPriced:
            'No endpoint that returned data attaches revenue to a bid or ping opportunity, so the money value of these failures is not measurable from the auction reports. Pricing it would mean inventing a per-opportunity value.',
        },
        evidence: [
          {
            statement: `${spec.label}: ${count} of ${denominator} examined`,
            observed: count,
            denominator,
            source: `callgrid aggregate report (${spec.grain} grain)`,
          },
        ],
        confidence: {
          value: Math.min(m.confidence, d.confidence),
          sampleSize: m.sampleSize,
          minimumSampleSize: spec.minimumSampleSize,
          // `total` is nullable on the platform type: null means the
          // denominator itself is unknown, which is not the same as zero and
          // must not become a 0/0 ratio.
          coverage:
            m.coverage && m.coverage.total !== null && m.coverage.total > 0
              ? m.coverage.observed / m.coverage.total
              : null,
          basis: `${m.coverage?.observed ?? 0} of ${m.coverage?.total ?? 0} ${spec.grain} rows reported this field`,
        },
        recommendedAction: spec.recommendedAction,
        missingEvidence: [
          'Per-opportunity revenue at the auction grain (not exposed by any verified endpoint).',
          `The timezone CallGrid buckets this report in (the GET report endpoints accept no reportTimeZone parameter).`,
        ],
      };
      return publishFinding(finding);
    },
  };
}

/** Destination-grain rules. Every metric is verified on pingStats. */
export const DESTINATION_RULES: readonly MarketplaceRule[] = [
  volumeRule({
    id: 'auction-destination-rate-limited',
    grain: 'destination', metric: 'rateLimited', denominatorMetric: 'accepted',
    label: 'Pings rejected by rate limiting', category: 'capacity', owner: 'platform',
    whatHappened: (c, d) => `${c} ping(s) were rejected by rate limiting, against ${d} accepted at the same grain.`,
    why: 'A rate-limited ping never became a bid opportunity. This is a configured throughput ceiling being reached, not a quality problem.',
    recommendedAction: 'Review the destination rate limits against actual ping volume. If the ceiling is intentional, no action; if not, raising it converts rejected pings into bid opportunities.',
    minimumShare: 0.001, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
  volumeRule({
    id: 'auction-destination-ping-timeout',
    grain: 'destination', metric: 'pingTimeout', denominatorMetric: 'accepted',
    label: 'Pings that timed out', category: 'latency', owner: 'platform',
    whatHappened: (c, d) => `${c} ping(s) timed out, against ${d} accepted at the same grain.`,
    why: 'A timeout is a failure to answer in time, not a decision to decline. The opportunity was lost to latency.',
    recommendedAction: 'Compare the destination response deadline against its observed latency. This is an infrastructure question, not a bidding-strategy one.',
    minimumShare: 0.001, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
  volumeRule({
    id: 'auction-destination-api-failed',
    grain: 'destination', metric: 'apiFailed', denominatorMetric: 'accepted',
    label: 'Pings lost to API failure', category: 'provider', owner: 'platform',
    whatHappened: (c, d) => `${c} ping(s) failed at the API layer, against ${d} accepted at the same grain.`,
    why: 'An API failure is an error on the integration path. The opportunity was never evaluated on its merits.',
    recommendedAction: 'Check the destination endpoint health and error responses for this window.',
    minimumShare: 0.001, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
  volumeRule({
    id: 'auction-destination-suppressed',
    grain: 'destination', metric: 'suppressed', denominatorMetric: 'accepted',
    label: 'Suppressed pings', category: 'configuration', owner: 'platform',
    whatHappened: (c, d) => `${c} ping(s) were suppressed, against ${d} accepted at the same grain.`,
    why: 'Suppression is a deliberate filter. Volume here is worth knowing precisely because it is intentional and therefore easy to leave misconfigured.',
    recommendedAction: 'Confirm the suppression rules still match current intent for this destination.',
    minimumShare: 0.001, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
  volumeRule({
    id: 'auction-destination-min-revenue',
    grain: 'destination', metric: 'minRevenue', denominatorMetric: 'accepted',
    label: 'Pings below the minimum-revenue floor', category: 'configuration', owner: 'platform',
    whatHappened: (c, d) => `${c} ping(s) fell below the minimum-revenue floor, against ${d} accepted at the same grain.`,
    why: 'A configured floor rejected these before any bid was possible. Whether that is correct depends on the floor, which is a business decision, not a defect.',
    recommendedAction: 'Review the minimum-revenue floor against current market pricing. This is a threshold decision; the report does not say whether the threshold is right.',
    minimumShare: 0.001, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
  volumeRule({
    id: 'auction-destination-missing-amount',
    grain: 'destination', metric: 'missingAmount', denominatorMetric: 'accepted',
    label: 'Pings missing an amount', category: 'eligibility', owner: 'platform',
    whatHappened: (c, d) => `${c} ping(s) arrived without an amount, against ${d} accepted at the same grain.`,
    why: 'A missing amount is a data-quality failure upstream of any pricing decision.',
    recommendedAction: 'Trace which upstream sources omit the amount field.',
    minimumShare: 0.001, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
  volumeRule({
    id: 'auction-destination-invalid-number',
    grain: 'destination', metric: 'invalidNumber', denominatorMetric: 'accepted',
    label: 'Pings with an invalid number', category: 'eligibility', owner: 'platform',
    whatHappened: (c, d) => `${c} ping(s) carried an invalid number, against ${d} accepted at the same grain.`,
    why: 'An invalid number cannot be routed. This is upstream data quality, not marketplace economics.',
    recommendedAction: 'Identify the upstream sources producing invalid numbers.',
    minimumShare: 0.001, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
  volumeRule({
    id: 'auction-destination-failed-tag-rules',
    grain: 'destination', metric: 'failedTagRules', denominatorMetric: 'accepted',
    label: 'Pings failing tag rules', category: 'targeting', owner: 'platform',
    whatHappened: (c, d) => `${c} ping(s) failed tag rules, against ${d} accepted at the same grain.`,
    why: 'Tag rules are configured filters. This is the provider-native field name — `failedTagRules`, not `tagRules`.',
    recommendedAction: 'Review the tag rules on this destination against the traffic they are rejecting.',
    minimumShare: 0.001, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
];

/** Source-grain rules. Every metric is verified on bidStats or bidStats/rejections. */
export const SOURCE_RULES: readonly MarketplaceRule[] = [
  volumeRule({
    id: 'auction-source-duplicate-bids',
    grain: 'source', metric: 'duplicateBids', denominatorMetric: 'total',
    label: 'Duplicate bids', category: 'duplicates', owner: 'platform',
    whatHappened: (c, d) => `${c} duplicate bid(s) were rejected, against a bid-report total of ${d}.`,
    why: 'A duplicate bid is a repeated submission, distinct from a duplicate CALLER. The provider reports the two separately and Loop keeps them separate.',
    recommendedAction: 'Check whether the source is resubmitting bids, which usually indicates a retry loop rather than genuine demand.',
    minimumShare: 0.0005, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
  volumeRule({
    id: 'auction-source-duplicate-caller',
    grain: 'source', metric: 'duplicateCaller', denominatorMetric: 'total',
    label: 'Duplicate callers', category: 'duplicates', owner: 'platform',
    whatHappened: (c, d) => `${c} opportunit(ies) were rejected as duplicate callers, against a bid-report total of ${d}.`,
    why: 'The provider field is `duplicate`, and it is NOT the same as `duplicateBids`. Summing the two would double-count.',
    recommendedAction: 'Review the duplicate-caller window against how often genuine repeat callers are expected in this vertical.',
    minimumShare: 0.0005, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
  volumeRule({
    id: 'auction-source-failed-acceptance',
    grain: 'source', metric: 'failedAcceptance', denominatorMetric: 'total',
    label: 'Failed acceptance', category: 'configuration', owner: 'platform',
    whatHappened: (c, d) => `${c} opportunit(ies) failed acceptance criteria, against a bid-report total of ${d}.`,
    why: 'Acceptance criteria rejected these before a bid could win.',
    recommendedAction: 'Review the acceptance criteria against the traffic they are rejecting.',
    minimumShare: 0.0005, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
  volumeRule({
    id: 'auction-source-failed-tag-rules',
    grain: 'source', metric: 'failedTagRules', denominatorMetric: 'total',
    label: 'Failed tag rules', category: 'targeting', owner: 'platform',
    whatHappened: (c, d) => `${c} opportunit(ies) failed tag rules, against a bid-report total of ${d}.`,
    why: 'Configured tag filters rejected these at the source grain.',
    recommendedAction: 'Review the tag rules applied to this source.',
    minimumShare: 0.0005, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
  volumeRule({
    id: 'auction-source-paused',
    grain: 'source', metric: 'paused', denominatorMetric: 'total',
    label: 'Rejected because paused', category: 'configuration', owner: 'platform',
    whatHappened: (c, d) => `${c} opportunit(ies) were rejected because a target was paused, against a bid-report total of ${d}.`,
    why: 'A paused target cannot bid. This is a state someone set, and states that were meant to be temporary are the ones worth surfacing.',
    recommendedAction: 'Confirm every paused target is intentionally paused.',
    minimumShare: 0.0005, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
  volumeRule({
    id: 'auction-source-closed',
    grain: 'source', metric: 'closed', denominatorMetric: 'total',
    label: 'Rejected because closed', category: 'configuration', owner: 'platform',
    whatHappened: (c, d) => `${c} opportunit(ies) were rejected because a target was closed, against a bid-report total of ${d}.`,
    why: 'Closed targets reject on schedule. Volume here indicates traffic arriving outside operating hours.',
    recommendedAction: 'Compare traffic timing against configured hours. This is a coverage decision, not a defect.',
    minimumShare: 0.0005, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
  volumeRule({
    id: 'auction-source-caller-id-rejected',
    grain: 'source', metric: 'callerIdRejected', denominatorMetric: 'total',
    label: 'Rejected on caller id', category: 'eligibility', owner: 'platform',
    whatHappened: (c, d) => `${c} opportunit(ies) were rejected on caller id, against a bid-report total of ${d}.`,
    why: 'The provider field is a COUNT named `callerId`. It is not an identifier and Loop never stores one.',
    recommendedAction: 'Review the caller-id rules against the volume they reject.',
    minimumShare: 0.0005, minimumSampleSize: 1, minimumConfidence: 0.4,
  }),
];

export const AUCTION_RULES: readonly MarketplaceRule[] = [...SOURCE_RULES, ...DESTINATION_RULES];

export interface UnbuiltAuctionRule {
  id: string;
  purpose: string;
  needs: string;
}

/**
 * Capabilities deliberately NOT built, and the exact evidence each one needs.
 *
 * These are the requests this sprint refused. Each is refused for a specific
 * missing fact, not out of caution — name the fact and the rule becomes
 * buildable.
 */
export const unbuiltAuctionRules = (): readonly UnbuiltAuctionRule[] => [
  {
    id: 'bid-pricing-recommendation',
    purpose: 'Recommend a bid price change.',
    needs: 'A proven money unit AND per-opportunity revenue at the auction grain. No endpoint that returned data attaches revenue to a bid, so a price recommendation would be arithmetic over an invented value.',
  },
  {
    id: 'recoverable-revenue',
    purpose: 'Estimate revenue recoverable by fixing a failure category.',
    needs: 'Proof that a recovered opportunity would have won, and at what price. The reports supply neither. Every number this rule could produce would be a guess wearing a currency symbol.',
  },
  {
    id: 'dominant-failure-reason',
    purpose: 'Name the single largest cause of pre-call failure.',
    needs: 'Proof that the failure categories are mutually exclusive and exhaustive. The provider does not state this, and without it the largest category may simply be the one counted most often.',
  },
  {
    id: 'pings-to-made-to-won-funnel',
    purpose: 'Publish the Pings → Made → Won funnel.',
    needs: '`pings` and `made` do not exist on any endpoint that returned data, and `accepted` is destination-grain while `won` is source-grain. Two of the four stages have no source and the remaining two are not comparable.',
  },
  {
    id: 'response-time-finding',
    purpose: 'Report slow bid response times.',
    needs: 'A response-time field. None exists on any endpoint that returned data; the UI report\'s "Average Bid response: 521 ms" has no API source.',
  },
  {
    id: 'capped-finding',
    purpose: 'Report capacity caps being hit.',
    needs: 'A `capped` report metric. `capped` exists only as configuration on the Destination and Buyer entities — a configured limit, not a measurement of it being reached.',
  },
  {
    id: 'buyer-or-source-blame',
    purpose: 'Attribute a failure to a specific buyer or source as fault.',
    needs: 'Owner attribution proven against exclusivity. The reports say which source a rejection is counted under, not who caused it.',
  },
  {
    id: 'provider-rate-relabelling',
    purpose: 'Present the provider\'s rejectRate as the UI report\'s "Reject %".',
    needs: 'A proven denominator. `verifyDenominators` tests the candidates against live rows; until one is proven, the provider rate is displayed as the provider\'s own figure and never renamed.',
  },
];

export interface AuctionEngineResult {
  evidence: EvidenceReport;
  findings: MarketplaceFinding[];
  withheld: RuleSuppression[];
  unbuilt: readonly UnbuiltAuctionRule[];
  rulesEvaluated: number;
}

/**
 * Run auction intelligence through the shared Layer 2 gate.
 *
 * Cross-grain rules are suppressed BEFORE evaluation, not filtered from the
 * output afterwards — a rule that reads both grains never gets to compute
 * anything, so there is no partially-formed cross-grain finding to leak.
 */
export function runAuctionIntelligence(input: {
  /** ONE grain's evidence. Call once per grain — never a merged report. */
  evidence: EvidenceReport;
  /** The measured scalars for that grain, from `auctionValues`. */
  values: ReadonlyMap<string, number | null>;
  rules?: readonly MarketplaceRule[];
}): AuctionEngineResult {
  const rules = input.rules ?? AUCTION_RULES;
  const permitted: MarketplaceRule[] = [];
  const withheld: RuleSuppression[] = [];

  for (const rule of rules) {
    const violation = assertSingleGrain(rule.requires.metrics);
    if (violation) {
      withheld.push({
        ruleId: rule.id,
        reason: violation,
        needs: 'An explicit cross-grain contract, which does not exist.',
        suppressedBy: 'intelligence-engine',
      });
      continue;
    }
    permitted.push(rule);
  }

  const result = runRules(
    permitted,
    input.evidence,
    () => undefined,
    (metricId) => input.values.get(metricId) ?? null,
  );

  return {
    evidence: input.evidence,
    findings: result.findings,
    withheld: [...withheld, ...result.withheld],
    unbuilt: unbuiltAuctionRules(),
    rulesEvaluated: rules.length,
  };
}

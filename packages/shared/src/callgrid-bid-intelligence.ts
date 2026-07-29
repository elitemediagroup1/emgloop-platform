// CallGrid bid intelligence — what the bid and ping reports MEAN operationally.
//
// Counting rejections is not intelligence. Most rejections are configuration
// working exactly as intended: a closed target rejecting traffic is the system
// obeying its own rules, not a failure. This module encodes which outcomes are
// expected, which might be preventable, and — critically — what Loop cannot
// determine about either.
//
// Two hard rules, because breaking them produces confident nonsense:
//
//   1. SOURCE grain and DESTINATION grain are different populations. A source
//      opportunity is not a destination ping. They are never added together, and
//      neither is ever the other's denominator.
//   2. Bid reports carry no revenue. "Recoverable revenue" cannot be computed
//      from them, so it is never stated, estimated, or implied.
//
// Bid reporting is also snapshot-only: the provider's endpoints accept no date
// range, so these metrics do NOT honor the calendar selection and say so.

import {
  type CallGridFinding, type CallGridEvidenceReference, type Severity,
  type ActionSafety, type EntityType, type IntelligenceUnknown, type MetricClassification,
  SEVERITY_RANK, escalate,
} from './callgrid-intelligence';
import { sourceWinRate, share as shareOf, sumReported } from './callgrid-metric-contract';

// --- Rejection classification -------------------------------------------------

export const REJECTION_CATEGORIES = [
  'EXPECTED_CONFIGURATION',   // the system obeying rules someone set on purpose
  'POTENTIALLY_PREVENTABLE',  // may indicate a fixable operational problem
  'TRAFFIC_OR_IDENTITY',      // properties of the caller or the traffic itself
  'COMMERCIAL_OR_ACCEPTANCE', // a commercial term was not met
  'UNKNOWN',                  // provider semantics unclear
] as const;
export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number];

export type BidGrain = 'bid_source' | 'bid_destination';

/** How confidently an outcome could have been avoided. Never "certain". */
export type Preventability = 'EXPECTED' | 'POSSIBLY_PREVENTABLE' | 'NOT_DETERMINABLE';

export interface RejectionClassification {
  /** Stable key used in ids and evidence. */
  key: string;
  displayName: string;
  grain: BidGrain;
  category: RejectionCategory;
  providerField: string;
  /** What the outcome means operationally, in plain language. */
  operationalMeaning: string;
  preventability: Preventability;
  /** What would have to be known before acting on it. */
  requiredEvidence: string;
  /** The only recommendation this category may produce. Review language only. */
  safeRecommendation: string;
  /** Claims that would exceed the evidence — enforced by the test suite. */
  unsafeClaims: string[];
  ruleVersion: string;
}

const V = 'v1';

export const BID_REJECTION_CLASSIFICATIONS: readonly RejectionClassification[] = [
  // --- Source grain -----------------------------------------------------------
  {
    key: 'closed', displayName: 'Closed Target', grain: 'bid_source',
    category: 'EXPECTED_CONFIGURATION', providerField: 'closed',
    operationalMeaning: 'The target was closed when the opportunity arrived, so no bid was placed. This is configuration behaving as configured.',
    preventability: 'EXPECTED',
    requiredEvidence: 'The target\'s intended open hours or status at the time of the opportunity.',
    safeRecommendation: 'Confirm the target\'s intended open schedule matches when this traffic arrives.',
    unsafeClaims: ['Calling this a system failure', 'Implying revenue was lost', 'Recommending the target be opened'],
    ruleVersion: V,
  },
  {
    key: 'paused', displayName: 'Paused Target', grain: 'bid_source',
    category: 'EXPECTED_CONFIGURATION', providerField: 'paused',
    operationalMeaning: 'The target was paused, so no bid was placed. Someone paused it deliberately, or an automated rule did.',
    preventability: 'EXPECTED',
    requiredEvidence: 'Who paused the target and whether the pause is still intended.',
    safeRecommendation: 'Confirm whether this target is still intended to be paused.',
    unsafeClaims: ['Calling this a system failure', 'Recommending the target be resumed', 'Estimating revenue lost to the pause'],
    ruleVersion: V,
  },
  {
    key: 'failedAcceptance', displayName: 'Failed Acceptance', grain: 'bid_source',
    category: 'COMMERCIAL_OR_ACCEPTANCE', providerField: 'failedAcceptance',
    operationalMeaning: 'A bid was placed but the opportunity was not accepted on commercial terms.',
    preventability: 'NOT_DETERMINABLE',
    requiredEvidence: 'The acceptance criteria in force and what the bid offered against them.',
    safeRecommendation: 'Review the acceptance criteria for this source against the bids being submitted.',
    unsafeClaims: ['Recommending a bid price change', 'Asserting the bid was too low', 'Attaching a revenue figure'],
    ruleVersion: V,
  },
  {
    key: 'duplicateBids', displayName: 'Duplicate Bids', grain: 'bid_source',
    category: 'TRAFFIC_OR_IDENTITY', providerField: 'duplicateBids',
    operationalMeaning: 'A bid was rejected as a duplicate of one already submitted for the same opportunity.',
    preventability: 'POSSIBLY_PREVENTABLE',
    requiredEvidence: 'Whether the duplicate came from a retry, a misconfiguration, or genuinely repeated traffic.',
    safeRecommendation: 'Review this source\'s bidding configuration for repeated submissions on one opportunity.',
    unsafeClaims: ['Summing with duplicate-caller counts', 'Asserting a bug without inspecting the configuration'],
    ruleVersion: V,
  },
  {
    key: 'duplicateCaller', displayName: 'Duplicate Caller', grain: 'bid_source',
    category: 'TRAFFIC_OR_IDENTITY', providerField: 'duplicateCaller',
    operationalMeaning: 'The caller had already been seen inside the provider\'s duplicate window, so the opportunity was rejected.',
    preventability: 'EXPECTED',
    requiredEvidence: 'The configured duplicate window and whether repeat callers are expected for this traffic.',
    safeRecommendation: 'Confirm the duplicate-caller window is set as intended for this source.',
    unsafeClaims: ['Calling repeat callers fraud', 'Summing with duplicate-bid counts', 'Implying the caller had value that was lost'],
    ruleVersion: V,
  },
  {
    key: 'callerIdRejected', displayName: 'Caller ID Rejected', grain: 'bid_source',
    category: 'TRAFFIC_OR_IDENTITY', providerField: 'callerIdRejected',
    operationalMeaning: 'The opportunity was rejected on caller-ID rules.',
    preventability: 'NOT_DETERMINABLE',
    requiredEvidence: 'Which caller-ID rules applied and whether they are still intended.',
    safeRecommendation: 'Review the caller-ID rules applying to this source.',
    unsafeClaims: ['Characterising the traffic as fraudulent', 'Recommending the rules be relaxed'],
    ruleVersion: V,
  },
  {
    key: 'failedTagRules', displayName: 'Failed Tag Rules', grain: 'bid_source',
    category: 'POTENTIALLY_PREVENTABLE', providerField: 'failedTagRules',
    operationalMeaning: 'Tag-rule evaluation rejected the opportunity at source grain. Tag rules are authored, so a high count can mean the rules and the traffic have drifted apart.',
    preventability: 'POSSIBLY_PREVENTABLE',
    requiredEvidence: 'Which tag rules fired and whether the traffic or the rules changed.',
    safeRecommendation: 'Review the tag rules applied to this source against the traffic it is sending.',
    unsafeClaims: ['Recommending specific rule changes', 'Asserting the rules are wrong'],
    ruleVersion: V,
  },

  // --- Destination grain --------------------------------------------------------
  {
    key: 'rateLimited', displayName: 'Rate Limited', grain: 'bid_destination',
    category: 'POTENTIALLY_PREVENTABLE', providerField: 'rateLimited',
    operationalMeaning: 'The destination was at its configured throughput limit, so the ping was not delivered. Rate limiting can prevent otherwise eligible opportunities from reaching a destination.',
    preventability: 'POSSIBLY_PREVENTABLE',
    requiredEvidence: 'The destination\'s configured throughput limit, whether it is contractual, and whether alternate routing was available.',
    safeRecommendation: 'Confirm the destination\'s configured throughput limit and whether alternate routing was available.',
    unsafeClaims: [
      'Recommending the cap be raised',
      'Estimating revenue that would have been recovered',
      'Assuming the limit was accidental',
    ],
    ruleVersion: V,
  },
  {
    key: 'pingTimeout', displayName: 'Timed Out', grain: 'bid_destination',
    category: 'POTENTIALLY_PREVENTABLE', providerField: 'pingTimeout',
    operationalMeaning: 'The destination did not respond within the allowed time. Timeouts usually point at endpoint responsiveness rather than a commercial decision.',
    preventability: 'POSSIBLY_PREVENTABLE',
    requiredEvidence: 'The destination\'s response-time behaviour and the configured timeout.',
    safeRecommendation: 'Review this destination\'s endpoint responsiveness and the configured timeout.',
    unsafeClaims: ['Asserting the destination is broken', 'Estimating lost revenue'],
    ruleVersion: V,
  },
  {
    key: 'apiFailed', displayName: 'API Failed', grain: 'bid_destination',
    category: 'POTENTIALLY_PREVENTABLE', providerField: 'apiFailed',
    operationalMeaning: 'The destination endpoint returned an error. An error is an operational signal, but the provider does not report what the error was.',
    preventability: 'POSSIBLY_PREVENTABLE',
    requiredEvidence: 'The destination\'s own error logs for the snapshot window.',
    safeRecommendation: 'Contact the destination or check its endpoint logs for errors during this snapshot window.',
    unsafeClaims: ['Naming a cause', 'Guaranteeing the failures are preventable', 'Estimating lost revenue'],
    ruleVersion: V,
  },
  {
    key: 'invalidNumber', displayName: 'Invalid Number', grain: 'bid_destination',
    category: 'POTENTIALLY_PREVENTABLE', providerField: 'invalidNumber',
    operationalMeaning: 'The ping carried a number the destination rejected as invalid.',
    preventability: 'POSSIBLY_PREVENTABLE',
    requiredEvidence: 'Whether the numbers were genuinely malformed or the destination\'s validation changed.',
    safeRecommendation: 'Review the number format this destination expects against what is being sent.',
    unsafeClaims: ['Blaming a specific source without per-source evidence'],
    ruleVersion: V,
  },
  {
    key: 'missingAmount', displayName: 'Missing Amount', grain: 'bid_destination',
    category: 'POTENTIALLY_PREVENTABLE', providerField: 'missingAmount',
    operationalMeaning: 'No bid amount was supplied on the ping, so the destination could not evaluate it.',
    preventability: 'POSSIBLY_PREVENTABLE',
    requiredEvidence: 'Whether the amount was omitted by configuration or dropped in transit.',
    safeRecommendation: 'Review whether a bid amount is being supplied for pings to this destination.',
    unsafeClaims: ['Recommending a specific amount', 'Estimating the value of the missing bids'],
    ruleVersion: V,
  },
  {
    key: 'minRevenue', displayName: 'Below Minimum Revenue', grain: 'bid_destination',
    category: 'COMMERCIAL_OR_ACCEPTANCE', providerField: 'minRevenue',
    operationalMeaning: 'The offer was below the destination\'s configured minimum. This is expected behaviour when the minimum is set deliberately, and a commercial signal when it is not.',
    preventability: 'NOT_DETERMINABLE',
    requiredEvidence: 'The destination\'s configured minimum and whether it is intended at its current level.',
    safeRecommendation: 'Confirm this destination\'s configured minimum is set as intended.',
    unsafeClaims: ['Recommending the minimum be lowered', 'Recommending a bid increase', 'Estimating recoverable revenue'],
    ruleVersion: V,
  },
  {
    key: 'destFailedTagRules', displayName: 'Failed Tag Rules', grain: 'bid_destination',
    category: 'POTENTIALLY_PREVENTABLE', providerField: 'failedTagRules',
    operationalMeaning: 'Tag-rule evaluation rejected the ping at destination grain.',
    preventability: 'POSSIBLY_PREVENTABLE',
    requiredEvidence: 'Which destination tag rules fired and whether they are current.',
    safeRecommendation: 'Review the tag rules on this destination against the traffic being routed to it.',
    unsafeClaims: ['Recommending specific rule changes'],
    ruleVersion: V,
  },
  {
    key: 'destFailedAcceptance', displayName: 'Failed Acceptance', grain: 'bid_destination',
    category: 'COMMERCIAL_OR_ACCEPTANCE', providerField: 'failedAcceptance',
    operationalMeaning: 'The destination declined the ping on its acceptance criteria.',
    preventability: 'NOT_DETERMINABLE',
    requiredEvidence: 'The destination\'s acceptance criteria.',
    safeRecommendation: 'Review this destination\'s acceptance criteria against what is being sent.',
    unsafeClaims: ['Asserting the offer was too low', 'Recommending a price change'],
    ruleVersion: V,
  },
  {
    key: 'suppressed', displayName: 'Suppressed', grain: 'bid_destination',
    category: 'UNKNOWN', providerField: 'suppressed',
    operationalMeaning: 'The provider suppressed the ping before it reached the destination. CallGrid does not document which suppression rules produce this outcome.',
    preventability: 'NOT_DETERMINABLE',
    requiredEvidence: 'The provider\'s definition of suppression, which is not currently documented to us.',
    safeRecommendation: 'Contact CallGrid to confirm what suppression means for this destination.',
    unsafeClaims: ['Assigning a cause', 'Classifying it as preventable or expected', 'Estimating impact'],
    ruleVersion: V,
  },
];

const CLASS_BY_KEY = new Map(BID_REJECTION_CLASSIFICATIONS.map((c) => [c.key, c] as const));

export function rejectionClassification(key: string): RejectionClassification | null {
  return CLASS_BY_KEY.get(key) ?? null;
}

// --- Review priority ------------------------------------------------------------
// A deterministic ORDERING score. It answers "what should a person look at
// first", never "what is this worth" — the bid reports carry no revenue, so any
// monetary claim would be invented.

export const BID_PRIORITY_FORMULA_VERSION = 'v1';

export type ReviewPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface PriorityInputs {
  /** How many events of this kind the snapshot reported. */
  eventCount: number;
  /** Share (0–1) of its OWN grain's total outcomes. Null when no denominator. */
  shareOfGrain: number | null;
  preventability: Preventability;
  /** How many distinct sources or destinations show this outcome. */
  affectedEntities: number;
  /** Fraction of rows that reported the field (0–1), or null when unknown. */
  completeness: number | null;
  /** Whole days between the snapshot and now. */
  snapshotAgeDays: number;
}

export interface PriorityResult {
  priority: ReviewPriority;
  /** 0–100. Ordering only — this is not a value, a cost, or an amount. */
  score: number;
  formulaVersion: string;
  /** The components, so the queue's ordering is inspectable. */
  components: { label: string; points: number }[];
}

/**
 * Score an outcome for review order.
 *
 * Weighting rationale: share of its own grain matters most (a big count in a big
 * population is normal); preventability next (expected configuration should not
 * outrank a possible fault); then breadth, volume, and freshness. Stale or
 * poorly-covered snapshots are damped so an old report cannot dominate the queue.
 */
export function scoreReviewPriority(inputs: PriorityInputs): PriorityResult {
  const components: { label: string; points: number }[] = [];

  const sharePoints = inputs.shareOfGrain === null ? 0 : Math.min(40, Math.round(inputs.shareOfGrain * 100));
  components.push({ label: 'Share of its grain\'s outcomes', points: sharePoints });

  const preventPoints =
    inputs.preventability === 'POSSIBLY_PREVENTABLE' ? 25
    : inputs.preventability === 'NOT_DETERMINABLE' ? 12
    : 0; // EXPECTED configuration is not a problem to be ranked highly
  components.push({ label: 'Preventability class', points: preventPoints });

  const breadthPoints = Math.min(15, inputs.affectedEntities * 5);
  components.push({ label: 'Entities affected', points: breadthPoints });

  // Volume matters but must not dominate: log-scaled so 100k does not swamp 1k.
  const volumePoints = inputs.eventCount <= 0 ? 0 : Math.min(15, Math.round(Math.log10(inputs.eventCount) * 4));
  components.push({ label: 'Event volume', points: volumePoints });

  const freshnessPoints = inputs.snapshotAgeDays <= 1 ? 5 : inputs.snapshotAgeDays <= 3 ? 3 : 0;
  components.push({ label: 'Snapshot freshness', points: freshnessPoints });

  const raw = sharePoints + preventPoints + breadthPoints + volumePoints + freshnessPoints;
  // Partial reporting damps the whole score — an incomplete picture should not
  // out-rank a complete one on the strength of what happened to be reported.
  const completeness = inputs.completeness === null ? 1 : Math.max(0.5, Math.min(1, inputs.completeness));
  const score = Math.max(0, Math.min(100, Math.round(raw * completeness)));

  const priority: ReviewPriority = score >= 70 ? 'CRITICAL' : score >= 50 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';
  return { priority, score, formulaVersion: BID_PRIORITY_FORMULA_VERSION, components };
}

// --- Engine input ------------------------------------------------------------------

export interface BidSourceInput {
  key: string;
  name: string;
  total: number | null;
  bids: number | null;
  won: number | null;
  rejected: number | null;
  rejectRatePct: number | null;
  rejections: {
    failedAcceptance: number | null;
    duplicateBids: number | null;
    closed: number | null;
    paused: number | null;
    failedTagRules: number | null;
    duplicateCaller: number | null;
    callerIdRejected: number | null;
  };
}

export interface BidDestinationInput {
  key: string;
  name: string;
  accepted: number | null;
  rateLimited: number | null;
  pingTimeout: number | null;
  minRevenue: number | null;
  failedTagRules: number | null;
  failedAcceptance: number | null;
  apiFailed: number | null;
  suppressed: number | null;
  invalidNumber: number | null;
  missingAmount: number | null;
}

export interface BidSnapshotSet {
  windowStart: Date;
  windowEnd: Date;
  sources: BidSourceInput[];
  destinations: BidDestinationInput[];
}

export interface BidIntelligenceInput {
  now: Date;
  ok: boolean;
  hasData: boolean;
  fetchedAt: Date | null;
  reportTimezone: string | null;
  snapshot: BidSnapshotSet | null;
  /** A genuinely earlier stored snapshot, when one exists. Null means no history
   *  — and then NO historical comparison is produced at all. */
  prior: BidSnapshotSet | null;
  /** The CallGrid calendar period the operator selected, for grain honesty. */
  selectedPeriodLabel: string;
  matchesSelectedPeriod: boolean;
}

// --- Output --------------------------------------------------------------------------

export interface BidReviewItem {
  id: string;
  priority: ReviewPriority;
  score: number;
  issue: string;
  entityLabel: string;
  entityType: EntityType;
  category: RejectionCategory;
  count: number;
  /** Rate within its own grain, or null when there is no valid denominator. */
  ratePct: number | null;
  whyItMatters: string;
  recommendedReview: string;
  findingId: string;
}

export interface BidIntelligence {
  /** The single biggest bid issue, in one sentence. */
  headline: string;
  findings: CallGridFinding[];
  priorityQueue: BidReviewItem[];
  unknowns: IntelligenceUnknown[];
  evidenceReferences: CallGridEvidenceReference[];
  /** Snapshot provenance for the surface's honesty banner. */
  snapshotAgeDays: number | null;
}

// --- Helpers ---------------------------------------------------------------------------

const SOURCE_REPORT = 'CallGrid bid reporting (bidStats + bidRejections)';
const PING_REPORT = 'CallGrid ping reporting (pingStats)';

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000));
}

function pctText(fraction: number | null): string {
  return fraction === null ? 'an unknown share' : Math.round(fraction * 100) + '%';
}
function n(v: number | null): string {
  return v === null ? 'an unknown number of' : v.toLocaleString('en-US');
}

interface CategoryTotal {
  classification: RejectionClassification;
  total: number;
  reported: number;
  of: number;
  /** The single entity with the largest count for this category. */
  topEntity: { key: string; name: string; count: number } | null;
  entitiesAffected: number;
}

function tallySource(rows: readonly BidSourceInput[], key: string, pick: (r: BidSourceInput) => number | null): CategoryTotal | null {
  const classification = rejectionClassification(key);
  if (!classification) return null;
  const { total, reported, of } = sumReported(rows, pick);
  if (total === null) return null;
  const withCounts = rows
    .map((r) => ({ key: r.key, name: r.name, count: pick(r) }))
    .filter((x): x is { key: string; name: string; count: number } => x.count !== null && x.count > 0)
    .sort((a, b) => b.count - a.count);
  return { classification, total, reported, of, topEntity: withCounts[0] ?? null, entitiesAffected: withCounts.length };
}

function tallyDest(rows: readonly BidDestinationInput[], key: string, pick: (r: BidDestinationInput) => number | null): CategoryTotal | null {
  const classification = rejectionClassification(key);
  if (!classification) return null;
  const { total, reported, of } = sumReported(rows, pick);
  if (total === null) return null;
  const withCounts = rows
    .map((r) => ({ key: r.key, name: r.name, count: pick(r) }))
    .filter((x): x is { key: string; name: string; count: number } => x.count !== null && x.count > 0)
    .sort((a, b) => b.count - a.count);
  return { classification, total, reported, of, topEntity: withCounts[0] ?? null, entitiesAffected: withCounts.length };
}

const SOURCE_PICKERS: { key: string; pick: (r: BidSourceInput) => number | null }[] = [
  { key: 'closed', pick: (r) => r.rejections.closed },
  { key: 'paused', pick: (r) => r.rejections.paused },
  { key: 'failedAcceptance', pick: (r) => r.rejections.failedAcceptance },
  { key: 'duplicateBids', pick: (r) => r.rejections.duplicateBids },
  { key: 'duplicateCaller', pick: (r) => r.rejections.duplicateCaller },
  { key: 'callerIdRejected', pick: (r) => r.rejections.callerIdRejected },
  { key: 'failedTagRules', pick: (r) => r.rejections.failedTagRules },
];

const DEST_PICKERS: { key: string; pick: (r: BidDestinationInput) => number | null }[] = [
  { key: 'rateLimited', pick: (r) => r.rateLimited },
  { key: 'pingTimeout', pick: (r) => r.pingTimeout },
  { key: 'apiFailed', pick: (r) => r.apiFailed },
  { key: 'invalidNumber', pick: (r) => r.invalidNumber },
  { key: 'missingAmount', pick: (r) => r.missingAmount },
  { key: 'minRevenue', pick: (r) => r.minRevenue },
  { key: 'destFailedTagRules', pick: (r) => r.failedTagRules },
  { key: 'destFailedAcceptance', pick: (r) => r.failedAcceptance },
  { key: 'suppressed', pick: (r) => r.suppressed },
];

// --- The engine -----------------------------------------------------------------------

/**
 * Analyze the latest bid snapshot.
 *
 * Every finding answers the same seven questions: what happened, where, how
 * large, why it matters, what is known, what is NOT known, and what to review.
 */
export function analyzeBids(input: BidIntelligenceInput): BidIntelligence {
  const unknowns = bidUnknowns(input);

  if (!input.ok) {
    return {
      headline: 'Bid reporting could not be read.',
      findings: [], priorityQueue: [], unknowns, evidenceReferences: [], snapshotAgeDays: null,
    };
  }
  if (!input.hasData || !input.snapshot) {
    return {
      headline: 'No bid report data has been synchronized yet.',
      findings: [], priorityQueue: [], unknowns, evidenceReferences: [], snapshotAgeDays: null,
    };
  }

  const snap = input.snapshot;
  const ageDays = input.fetchedAt ? daysBetween(input.fetchedAt, input.now) : daysBetween(snap.windowEnd, input.now);
  const snapshotWindow = `Latest synchronized bid snapshot (${snap.windowStart.toISOString().slice(0, 10)})`;

  // Grain denominators — each computed within its OWN grain, never across.
  const sourceCategories = SOURCE_PICKERS
    .map((p) => tallySource(snap.sources, p.key, p.pick))
    .filter((c): c is CategoryTotal => c !== null && c.total > 0);
  const destCategories = DEST_PICKERS
    .map((p) => tallyDest(snap.destinations, p.key, p.pick))
    .filter((c): c is CategoryTotal => c !== null && c.total > 0);

  const sourceGrainTotal = sourceCategories.reduce((s, c) => s + c.total, 0);
  const destGrainTotal = destCategories.reduce((s, c) => s + c.total, 0);

  const findings: CallGridFinding[] = [];
  const queue: BidReviewItem[] = [];

  const emit = (c: CategoryTotal, grainTotal: number, grain: BidGrain) => {
    const cls = c.classification;
    const shareOfGrain = shareOf(c.total, grainTotal);
    const entityType: EntityType = grain;
    const completeness = c.of > 0 ? c.reported / c.of : null;

    const priority = scoreReviewPriority({
      eventCount: c.total,
      shareOfGrain,
      preventability: cls.preventability,
      affectedEntities: c.entitiesAffected,
      completeness,
      snapshotAgeDays: ageDays,
    });

    // Severity follows share within its own grain, escalated one step when the
    // category might be preventable rather than expected configuration.
    let severity: Severity =
      shareOfGrain === null ? 'INFORMATIONAL'
      : shareOfGrain >= 0.3 ? 'HIGH'
      : shareOfGrain >= 0.15 ? 'NOTABLE'
      : 'INFORMATIONAL';
    if (cls.preventability === 'POSSIBLY_PREVENTABLE' && severity !== 'INFORMATIONAL') {
      severity = escalate(severity);
    }

    const where = c.topEntity
      ? `${c.topEntity.name} accounts for the largest share (${n(c.topEntity.count)})`
      : 'No single entity dominates the count';
    const findingId = `bid:${grain}:${cls.key}`;

    const summary =
      `${cls.displayName} accounts for ${n(c.total)} outcomes — ${pctText(shareOfGrain)} of ` +
      `${grain === 'bid_source' ? 'source-side rejections' : 'destination-side outcomes'} in the latest snapshot. ` +
      `${where}. ${cls.operationalMeaning}`;

    findings.push({
      id: findingId,
      findingType: grain === 'bid_source' ? 'BID_REJECTION' : 'BID_DESTINATION',
      title: `${cls.displayName}: ${n(c.total)} outcomes`,
      plainLanguageSummary: summary,
      classification: cls.category === 'UNKNOWN' ? 'UNKNOWN' : 'VERIFIED',
      severity,
      // Deterministic: coverage of the field across the grain's rows.
      confidence: Math.round(Math.min(0.95, 0.5 + 0.45 * (completeness ?? 1)) * 100) / 100,
      currentWindow: snapshotWindow,
      comparisonWindow: null,
      primaryMetric: cls.providerField,
      currentValue: c.total,
      comparisonValue: null,
      absoluteChange: null,
      percentageChange: null,
      affectedEntities: c.topEntity
        ? [{
            entityType, entityId: c.topEntity.key, entityName: c.topEntity.name,
            currentValue: c.topEntity.count, comparisonValue: null, absoluteChange: null,
            contributionToChange: shareOf(c.topEntity.count, c.total),
            currentShare: shareOf(c.topEntity.count, c.total), comparisonShare: null,
            currentRank: 1, comparisonRank: null,
          }]
        : [],
      drivers: [],
      supportingEvidence: [
        bidEvidence(findingId, 1, {
          metricKey: cls.key, grain, providerReport: grain === 'bid_source' ? SOURCE_REPORT : PING_REPORT,
          providerField: cls.providerField, window: snapshotWindow,
          rawValue: c.total, classification: cls.category === 'UNKNOWN' ? 'UNKNOWN' : 'VERIFIED',
          completeness,
          notes: `Reported by ${c.reported} of ${c.of} ${grain === 'bid_source' ? 'sources' : 'destinations'}. Rows that did not report the field are excluded, not counted as zero.`,
        }),
        ...(c.topEntity ? [bidEvidence(findingId, 2, {
          metricKey: cls.key, grain, providerReport: grain === 'bid_source' ? SOURCE_REPORT : PING_REPORT,
          providerField: cls.providerField, window: snapshotWindow,
          entityId: c.topEntity.key, entityName: c.topEntity.name,
          rawValue: c.topEntity.count, classification: 'VERIFIED', completeness: null,
        })] : []),
        bidEvidence(findingId, 3, {
          metricKey: 'shareOfGrain', grain, providerReport: 'Derived within grain',
          providerField: null, window: snapshotWindow,
          derivedValue: shareOfGrain,
          formula: `${cls.providerField} / total ${grain === 'bid_source' ? 'source-grain rejections' : 'destination-grain outcomes'}`,
          classification: 'DERIVED', completeness: null,
          notes: 'The denominator is this grain only. Source and destination counts are never combined.',
        }),
      ],
      limitations: [
        'Bid reporting is snapshot-only: the provider accepts no date range, so this does not reflect the selected calendar period.',
        `Counts come from ${c.reported} of ${c.of} ${grain === 'bid_source' ? 'sources' : 'destinations'}; the rest did not report this field, which is not the same as reporting zero.`,
        ...(cls.preventability === 'EXPECTED'
          ? ['This category is configuration behaving as configured, not a fault.']
          : cls.preventability === 'POSSIBLY_PREVENTABLE'
            ? ['Whether these outcomes were preventable depends on configuration Loop cannot see.']
            : ['Whether these outcomes were avoidable cannot be determined from the report.']),
      ],
      unknowns: [
        cls.requiredEvidence,
        'Bid reports carry no revenue, so no amount can be attached to these outcomes.',
      ],
      recommendedReview: cls.safeRecommendation,
      recommendedActionType: 'REVIEW_BID_CATEGORY',
      actionTarget: `${grain}:${cls.key}`,
      actionSafety: cls.category === 'UNKNOWN' ? 'INSUFFICIENT_EVIDENCE' : 'SAFE_TO_REVIEW',
      createdAt: input.now.toISOString(),
      ruleId: 'bid-outcome-volume',
      ruleVersion: 'v1',
    });

    queue.push({
      id: findingId,
      priority: priority.priority,
      score: priority.score,
      issue: cls.displayName,
      entityLabel: c.topEntity?.name ?? '—',
      entityType,
      category: cls.category,
      count: c.total,
      ratePct: shareOfGrain === null ? null : Math.round(shareOfGrain * 100),
      whyItMatters: cls.operationalMeaning,
      recommendedReview: cls.safeRecommendation,
      findingId,
    });
  };

  for (const c of sourceCategories) emit(c, sourceGrainTotal, 'bid_source');
  for (const c of destCategories) emit(c, destGrainTotal, 'bid_destination');

  // Win-rate context — highest and lowest above the minimum sample.
  findings.push(...winRateFindings(input, snap, snapshotWindow));

  // Concentration, within each grain separately.
  const oppConc = opportunityConcentration(input, snap, snapshotWindow);
  if (oppConc) findings.push(oppConc);
  const acceptConc = acceptedConcentration(input, snap, snapshotWindow);
  if (acceptConc) findings.push(acceptConc);

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.confidence - a.confidence);
  queue.sort((a, b) => b.score - a.score || a.issue.localeCompare(b.issue));

  const top = queue[0];
  const headline = top
    ? `${top.issue} is the largest bid issue in the latest snapshot: ${n(top.count)} outcomes` +
      (top.ratePct === null ? '' : ` (${top.ratePct}% of its grain)`) +
      (top.entityLabel !== '—' ? `, concentrated on ${top.entityLabel}` : '') +
      `. ${top.category === 'EXPECTED_CONFIGURATION' ? 'This is expected configuration behaviour.' : 'It may be preventable, but the configuration behind it is not visible to Loop.'}`
    : 'No bid rejections or destination failures were reported in the latest snapshot.';

  return {
    headline,
    findings,
    priorityQueue: queue,
    unknowns,
    evidenceReferences: findings.flatMap((f) => f.supportingEvidence),
    snapshotAgeDays: ageDays,
  };
}

interface BidEvidenceSpec {
  metricKey: string;
  grain: BidGrain;
  providerReport: string;
  providerField: string | null;
  window: string;
  entityId?: string;
  entityName?: string;
  rawValue?: number | null;
  derivedValue?: number | null;
  formula?: string;
  classification: MetricClassification;
  completeness: number | null;
  notes?: string;
}

function bidEvidence(findingId: string, index: number, spec: BidEvidenceSpec): CallGridEvidenceReference {
  return {
    id: `${findingId}:e${index}`,
    findingId,
    sourceType: spec.grain === 'bid_source' ? 'bid_source_snapshot' : 'ping_destination_snapshot',
    providerReport: spec.providerReport,
    metricKey: spec.metricKey,
    entityType: spec.grain,
    entityId: spec.entityId ?? null,
    entityName: spec.entityName ?? null,
    window: spec.window,
    providerField: spec.providerField,
    rawValue: spec.rawValue ?? null,
    normalizedValue: spec.rawValue ?? null,
    derivedValue: spec.derivedValue ?? null,
    formula: spec.formula ?? null,
    formulaVersion: spec.formula ? 'v1' : null,
    classification: spec.classification,
    completeness: spec.completeness,
    notes: spec.notes ?? null,
  };
}

/** Highest and lowest source win rate, each above the registry's minimum sample. */
function winRateFindings(input: BidIntelligenceInput, snap: BidSnapshotSet, window: string): CallGridFinding[] {
  const MIN_BIDS = 50;
  const eligible = snap.sources
    .map((s) => ({ s, rate: sourceWinRate(s.won, s.bids) }))
    .filter((x): x is { s: BidSourceInput; rate: number } => x.rate !== null && (x.s.bids ?? 0) >= MIN_BIDS)
    .sort((a, b) => b.rate - a.rate);

  if (eligible.length < 2) return [];

  const make = (entry: { s: BidSourceInput; rate: number }, kind: 'highest' | 'lowest'): CallGridFinding => {
    const id = `bid:winrate:${kind}:${entry.s.key}`;
    return {
      id,
      findingType: 'BID_REJECTION',
      title: `${entry.s.name} has the ${kind} source win rate (${Math.round(entry.rate * 100)}%)`,
      plainLanguageSummary:
        `${entry.s.name} won ${n(entry.s.won)} of ${n(entry.s.bids)} submitted bids — ${Math.round(entry.rate * 100)}%, the ${kind} ` +
        `among sources with at least ${MIN_BIDS} submitted bids. Win rate is measured against bids SUBMITTED, not opportunities presented.`,
      classification: 'DERIVED',
      severity: 'INFORMATIONAL',
      confidence: 0.9,
      currentWindow: window,
      comparisonWindow: null,
      primaryMetric: 'sourceWinRate',
      currentValue: entry.rate,
      comparisonValue: null,
      absoluteChange: null,
      percentageChange: null,
      affectedEntities: [{
        entityType: 'bid_source', entityId: entry.s.key, entityName: entry.s.name,
        currentValue: entry.rate, comparisonValue: null, absoluteChange: null,
        contributionToChange: null, currentShare: null, comparisonShare: null,
        currentRank: null, comparisonRank: null,
      }],
      drivers: [],
      supportingEvidence: [
        bidEvidence(id, 1, { metricKey: 'bidsWon', grain: 'bid_source', providerReport: SOURCE_REPORT, providerField: 'won', window, entityId: entry.s.key, entityName: entry.s.name, rawValue: entry.s.won, classification: 'VERIFIED', completeness: null }),
        bidEvidence(id, 2, { metricKey: 'bidsSubmitted', grain: 'bid_source', providerReport: SOURCE_REPORT, providerField: 'bids', window, entityId: entry.s.key, entityName: entry.s.name, rawValue: entry.s.bids, classification: 'VERIFIED', completeness: null }),
        bidEvidence(id, 3, { metricKey: 'sourceWinRate', grain: 'bid_source', providerReport: 'Derived', providerField: null, window, entityId: entry.s.key, entityName: entry.s.name, derivedValue: entry.rate, formula: 'won / bids', classification: 'DERIVED', completeness: null, notes: 'Opportunities presented are NOT the denominator — that would conflate never-bid-on with lost.' }),
      ],
      limitations: [
        `Only sources with at least ${MIN_BIDS} submitted bids are ranked; smaller samples produce meaningless rates.`,
        'Snapshot-only: this does not reflect the selected calendar period.',
      ],
      unknowns: [
        'A win rate does not indicate whether the source is good or bad — the terms it bids under are not exposed.',
      ],
      recommendedReview: kind === 'lowest'
        ? 'Compare this source\'s bidding terms against the sources winning more often.'
        : 'Review what distinguishes this source, in case the pattern is repeatable.',
      recommendedActionType: 'REVIEW_ENTITY',
      actionTarget: `bid_source:${entry.s.key}`,
      actionSafety: 'SAFE_TO_REVIEW',
      createdAt: input.now.toISOString(),
      ruleId: 'bid-win-rate',
      ruleVersion: 'v1',
    };
  };

  return [make(eligible[0]!, 'highest'), make(eligible[eligible.length - 1]!, 'lowest')];
}

function opportunityConcentration(input: BidIntelligenceInput, snap: BidSnapshotSet, window: string): CallGridFinding | null {
  const { total } = sumReported(snap.sources, (s) => s.total);
  if (total === null || total <= 0 || snap.sources.length < 2) return null;
  const ranked = [...snap.sources].filter((s) => s.total !== null).sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  const top = ranked[0];
  if (!top) return null;
  const topShare = shareOf(top.total, total);
  if (topShare === null || topShare < 0.4) return null;

  const id = 'bid:concentration:opportunities';
  return {
    id,
    findingType: 'CONCENTRATION',
    title: `${top.name} presents ${pctText(topShare)} of bid opportunities`,
    plainLanguageSummary:
      `${top.name} accounts for ${pctText(topShare)} of all bid opportunities in the latest snapshot ` +
      `(${n(top.total)} of ${n(total)}). Bid volume depends heavily on this one source.`,
    classification: 'DERIVED',
    severity: topShare >= 0.7 ? 'HIGH' : 'NOTABLE',
    confidence: 0.9,
    currentWindow: window,
    comparisonWindow: null,
    primaryMetric: 'bidOpportunities',
    currentValue: top.total,
    comparisonValue: null,
    absoluteChange: null,
    percentageChange: null,
    affectedEntities: [{
      entityType: 'bid_source', entityId: top.key, entityName: top.name,
      currentValue: top.total, comparisonValue: null, absoluteChange: null,
      contributionToChange: null, currentShare: topShare, comparisonShare: null,
      currentRank: 1, comparisonRank: null,
    }],
    drivers: [],
    supportingEvidence: [
      bidEvidence(id, 1, { metricKey: 'bidOpportunities', grain: 'bid_source', providerReport: SOURCE_REPORT, providerField: 'total', window, entityId: top.key, entityName: top.name, rawValue: top.total, classification: 'VERIFIED', completeness: null }),
      bidEvidence(id, 2, { metricKey: 'bidOpportunities', grain: 'bid_source', providerReport: SOURCE_REPORT, providerField: 'total', window, rawValue: total, classification: 'VERIFIED', completeness: null, notes: `Total across ${snap.sources.length} sources in the snapshot.` }),
    ],
    limitations: [
      'Concentration describes dependency within this snapshot, not over time.',
      'Snapshot-only: this does not reflect the selected calendar period.',
    ],
    unknowns: ['Whether this source can be substituted, or what its own supply depends on, is not exposed.'],
    recommendedReview: 'Confirm what would absorb bid volume if this source paused.',
    recommendedActionType: 'REVIEW_ENTITY',
    actionTarget: `bid_source:${top.key}`,
    actionSafety: 'SAFE_TO_REVIEW',
    createdAt: input.now.toISOString(),
    ruleId: 'bid-outcome-volume',
    ruleVersion: 'v1',
  };
}

function acceptedConcentration(input: BidIntelligenceInput, snap: BidSnapshotSet, window: string): CallGridFinding | null {
  const { total } = sumReported(snap.destinations, (d) => d.accepted);
  if (total === null || total <= 0 || snap.destinations.length < 2) return null;
  const ranked = [...snap.destinations].filter((d) => d.accepted !== null).sort((a, b) => (b.accepted ?? 0) - (a.accepted ?? 0));
  const top = ranked[0];
  if (!top) return null;
  const topShare = shareOf(top.accepted, total);
  if (topShare === null || topShare < 0.4) return null;

  const id = 'bid:concentration:accepted';
  return {
    id,
    findingType: 'CONCENTRATION',
    title: `${top.name} takes ${pctText(topShare)} of accepted pings`,
    plainLanguageSummary:
      `${top.name} accounts for ${pctText(topShare)} of accepted pings in the latest snapshot ` +
      `(${n(top.accepted)} of ${n(total)}). Accepted volume depends heavily on this one destination.`,
    classification: 'DERIVED',
    severity: topShare >= 0.7 ? 'HIGH' : 'NOTABLE',
    confidence: 0.9,
    currentWindow: window,
    comparisonWindow: null,
    primaryMetric: 'destinationAccepted',
    currentValue: top.accepted,
    comparisonValue: null,
    absoluteChange: null,
    percentageChange: null,
    affectedEntities: [{
      entityType: 'bid_destination', entityId: top.key, entityName: top.name,
      currentValue: top.accepted, comparisonValue: null, absoluteChange: null,
      contributionToChange: null, currentShare: topShare, comparisonShare: null,
      currentRank: 1, comparisonRank: null,
    }],
    drivers: [],
    supportingEvidence: [
      bidEvidence(id, 1, { metricKey: 'destinationAccepted', grain: 'bid_destination', providerReport: PING_REPORT, providerField: 'accepted', window, entityId: top.key, entityName: top.name, rawValue: top.accepted, classification: 'VERIFIED', completeness: null }),
      bidEvidence(id, 2, { metricKey: 'destinationAccepted', grain: 'bid_destination', providerReport: PING_REPORT, providerField: 'accepted', window, rawValue: total, classification: 'VERIFIED', completeness: null, notes: `Accepted across ${snap.destinations.length} destinations. This is a sum of accepted pings — it is NOT a total-pings denominator.` }),
    ],
    limitations: [
      'Accepted pings are not a complete funnel denominator; the provider does not report total pings attempted per destination.',
      'Snapshot-only: this does not reflect the selected calendar period.',
    ],
    unknowns: ['Whether other destinations could absorb this volume is not exposed by CallGrid.'],
    recommendedReview: 'Confirm which destinations could take this volume if this one became unavailable.',
    recommendedActionType: 'REVIEW_ENTITY',
    actionTarget: `bid_destination:${top.key}`,
    actionSafety: 'SAFE_TO_REVIEW',
    createdAt: input.now.toISOString(),
    ruleId: 'bid-outcome-volume',
    ruleVersion: 'v1',
  };
}

function bidUnknowns(input: BidIntelligenceInput): IntelligenceUnknown[] {
  const out: IntelligenceUnknown[] = [
    {
      id: 'bid-unknown:revenue',
      statement: 'No revenue can be attached to any individual bid failure.',
      reason: 'The bid and ping reports carry counts only. Any figure for "recoverable revenue" would be invented, so none is produced.',
    },
    {
      id: 'bid-unknown:grain',
      statement: 'Source-side and destination-side numbers describe different populations and are never combined.',
      reason: 'A source opportunity and a destination ping are different events. Adding them, or using one as the other\'s denominator, would produce a funnel that does not exist.',
    },
    {
      id: 'bid-unknown:accepted-denominator',
      statement: 'Accepted pings are not a complete funnel denominator.',
      reason: 'CallGrid does not report total pings attempted per destination, so an acceptance RATE cannot be computed.',
    },
    {
      id: 'bid-unknown:fallback',
      statement: 'Loop cannot tell whether an alternate destination was tried after a rejection.',
      reason: 'Route fallback behaviour is not exposed, so the downstream consequence of any rejection is unknown.',
    },
  ];

  if (!input.matchesSelectedPeriod) {
    out.push({
      id: 'bid-unknown:period',
      statement: `Bid metrics do not reflect ${input.selectedPeriodLabel}.`,
      reason: 'The provider\'s bid endpoints accept no date range. Only the latest synchronized snapshot exists, and it is shown as-is rather than being relabelled to the selected period.',
    });
  }

  if (!input.prior) {
    out.push({
      id: 'bid-unknown:history',
      statement: 'No change over time can be reported for bid metrics.',
      reason: 'Only one bid snapshot is stored. Without an earlier snapshot there is nothing to compare against, so no trend is shown.',
    });
  }

  return out;
}

/**
 * Change against a genuinely earlier snapshot.
 *
 * Returns an empty list when no prior snapshot exists — the product shows no
 * bid trend at all rather than implying the latest snapshot represents history.
 */
export function analyzeBidSnapshotChange(input: BidIntelligenceInput): CallGridFinding[] {
  if (!input.ok || !input.snapshot || !input.prior) return [];
  const cur = input.snapshot;
  const pri = input.prior;
  if (cur.windowStart.getTime() === pri.windowStart.getTime()) return [];

  const out: CallGridFinding[] = [];
  const window = `Latest snapshot (${cur.windowStart.toISOString().slice(0, 10)})`;
  const priorWindow = `Prior snapshot (${pri.windowStart.toISOString().slice(0, 10)})`;

  for (const p of DEST_PICKERS) {
    const cls = rejectionClassification(p.key);
    if (!cls || cls.preventability !== 'POSSIBLY_PREVENTABLE') continue;
    const curTotal = sumReported(cur.destinations, p.pick).total;
    const priTotal = sumReported(pri.destinations, p.pick).total;
    if (curTotal === null || priTotal === null || priTotal <= 0) continue;
    const rel = (curTotal - priTotal) / priTotal;
    if (Math.abs(rel) < 0.25 || Math.abs(curTotal - priTotal) < 100) continue;

    const id = `bid:change:${p.key}`;
    out.push({
      id,
      findingType: 'BID_DESTINATION',
      title: `${cls.displayName} ${rel > 0 ? 'rose' : 'fell'} ${Math.abs(Math.round(rel * 100))}% versus the prior snapshot`,
      plainLanguageSummary:
        `${cls.displayName} moved from ${n(priTotal)} to ${n(curTotal)} between the two stored snapshots.`,
      classification: 'DERIVED',
      severity: rel > 0 ? 'NOTABLE' : 'INFORMATIONAL',
      confidence: 0.8,
      currentWindow: window,
      comparisonWindow: priorWindow,
      primaryMetric: cls.providerField,
      currentValue: curTotal,
      comparisonValue: priTotal,
      absoluteChange: curTotal - priTotal,
      percentageChange: rel,
      affectedEntities: [],
      drivers: [],
      supportingEvidence: [
        bidEvidence(id, 1, { metricKey: cls.key, grain: 'bid_destination', providerReport: PING_REPORT, providerField: cls.providerField, window, rawValue: curTotal, classification: 'VERIFIED', completeness: null }),
        bidEvidence(id, 2, { metricKey: cls.key, grain: 'bid_destination', providerReport: PING_REPORT, providerField: cls.providerField, window: priorWindow, rawValue: priTotal, classification: 'VERIFIED', completeness: null }),
      ],
      limitations: [
        'The two snapshots are the provider\'s own windows, which may differ in length. This is a change between stored snapshots, not a like-for-like daily comparison.',
      ],
      unknowns: [cls.requiredEvidence],
      recommendedReview: cls.safeRecommendation,
      recommendedActionType: 'REVIEW_BID_CATEGORY',
      actionTarget: `bid_destination:${cls.key}`,
      actionSafety: 'SAFE_TO_REVIEW',
      createdAt: input.now.toISOString(),
      ruleId: 'bid-outcome-volume',
      ruleVersion: 'v1',
    });
  }
  return out;
}

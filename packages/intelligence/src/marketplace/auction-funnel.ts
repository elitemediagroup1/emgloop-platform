// The auction funnel contract — what Loop may and may not claim about the path
// from a ping to a paid call.
//
// This file exists because the funnel is the single easiest place in this
// product to fabricate something believable. "478,504 pings became 106 wins" is
// a sentence any executive would accept without question, and every number in it
// comes from a different grain, a different denominator, or in two cases from no
// API field at all.
//
// So the contract is declared BEFORE any transition is published, and every
// stage carries its own verification status. A stage that has no provider source
// is `no-provider-source` and stays that way until one exists — it is never
// filled in with the nearest plausible field.
//
// Pure. No I/O, no clock. Everything is passed in.

/** Where a stage's number comes from, and whether Loop may use it. */
export type StageStatus =
  /** A verified provider field on a verified endpoint. */
  | 'verified'
  /** A field exists, but its equivalence to the named concept is unproven. */
  | 'unproven-equivalence'
  /** No field on any endpoint that returned data supplies this. */
  | 'no-provider-source'
  /** Comes from Loop's own call projection, not the auction reports. */
  | 'loop-derived';

export type Grain = 'source' | 'destination' | 'call' | 'none';

export interface FunnelStage {
  id: string;
  label: string;
  status: StageStatus;
  grain: Grain;
  /** The provider field, or null when there is none. */
  providerField: string | null;
  providerEndpoint: string | null;
  note: string;
}

/**
 * Whether a transition between two stages may be expressed as a rate.
 *
 * `not-comparable` is the important value. Two stages at different grains
 * produce a number when divided, and that number is meaningless — dividing a
 * destination-grain count by a source-grain count is arithmetic performed on
 * two different populations.
 */
export type Comparability = 'comparable' | 'not-comparable' | 'unverified';

export interface FunnelTransition {
  id: string;
  from: string;
  to: string;
  numerator: string;
  denominator: string;
  comparability: Comparability;
  /** Minimum records before this transition may be published at all. */
  minimumSample: number;
  /** Minimum confidence the underlying metrics must carry. */
  minimumConfidence: number;
  status: StageStatus;
  why: string;
}

/**
 * The stages, as the observed contracts actually support them.
 *
 * Note what is NOT here: `Pings`, `Made`, and `Response time`. All three are
 * columns in CallGrid's own UI report and none of them exists on any endpoint
 * that returned data. Adding them as stages sourced from the nearest available
 * field is exactly the fabrication this contract prevents.
 */
export const AUCTION_FUNNEL_STAGES: readonly FunnelStage[] = [
  {
    id: 'pings',
    label: 'Pings',
    status: 'no-provider-source',
    grain: 'none',
    providerField: null,
    providerEndpoint: null,
    note: 'No `pings` field exists on pingStats or any other endpoint that returned data. pingStats reports `accepted` plus failure reasons. A ping TOTAL could in principle be reconstructed by summing accepted + every failure reason, but only if those categories are proven mutually exclusive and exhaustive — which the provider does not state and Loop has not tested. Until then this stage has no number.',
  },
  {
    id: 'pings-accepted',
    label: 'Pings accepted',
    status: 'verified',
    grain: 'destination',
    providerField: 'accepted',
    providerEndpoint: '/api/reports/pingStats',
    note: 'Verified field. DESTINATION grain — this counts pings a destination accepted, not pings the marketplace received.',
  },
  {
    id: 'bid-total',
    label: 'Bid report total',
    status: 'unproven-equivalence',
    grain: 'source',
    providerField: 'total',
    providerEndpoint: '/api/reports/bidStats',
    note: '`total` is verified as a field. What it counts is NOT verified. It is the natural denominator for bidRate and rejectRate, which suggests bid opportunities, but the provider does not define it and it must not be presented as "pings".',
  },
  {
    id: 'bids',
    label: 'Bids',
    status: 'verified',
    grain: 'source',
    providerField: 'bids',
    providerEndpoint: '/api/reports/bidStats',
    note: 'Verified field at source grain.',
  },
  {
    id: 'rated',
    label: 'Rated',
    status: 'unproven-equivalence',
    grain: 'source',
    providerField: 'rated',
    providerEndpoint: '/api/reports/bidStats',
    note: '`rated` is verified as a field. Its equivalence to the UI report\'s "Made" column is NOT proven and must not be assumed. Loop labels this stage "Rated" — the provider\'s own name — precisely so the unproven equivalence stays visible.',
  },
  {
    id: 'won',
    label: 'Won',
    status: 'verified',
    grain: 'source',
    providerField: 'won',
    providerEndpoint: '/api/reports/bidStats',
    note: 'Verified field at source grain.',
  },
  {
    id: 'calls',
    label: 'Calls',
    status: 'loop-derived',
    grain: 'call',
    providerField: null,
    providerEndpoint: null,
    note: 'Loop\'s MarketplaceCall projection. A different system, a different ingestion path, and — importantly — a different window semantic: the call path requests reportTimeZone US/Eastern while the report endpoints accept no timezone parameter at all.',
  },
];

/**
 * The transitions, each declaring its own denominator.
 *
 * A transition with `comparability: 'not-comparable'` is published as a
 * DECLARATION, never as a number. It exists in this list so that the reason it
 * cannot be computed is visible, rather than the transition silently missing and
 * someone re-deriving it badly six months from now.
 */
export const AUCTION_FUNNEL_TRANSITIONS: readonly FunnelTransition[] = [
  {
    id: 'accepted-to-bid-total',
    from: 'pings-accepted',
    to: 'bid-total',
    numerator: 'bidStats.total (source grain)',
    denominator: 'pingStats.accepted (destination grain)',
    comparability: 'not-comparable',
    minimumSample: 0,
    minimumConfidence: 1,
    status: 'verified',
    why: 'Different grains. `accepted` is per destination and `total` is per source; they count populations on opposite sides of the marketplace. Dividing one by the other produces a number with no referent. No cross-grain contract exists, and inventing one would be the single most expensive error available here.',
  },
  {
    id: 'total-to-bids',
    from: 'bid-total',
    to: 'bids',
    numerator: 'bidStats.bids',
    denominator: 'bidStats.total',
    comparability: 'unverified',
    minimumSample: 100,
    minimumConfidence: 0.5,
    status: 'unproven-equivalence',
    why: 'Same endpoint, same grain, same row — so the arithmetic is at least well-formed. It becomes `comparable` once bids/total is shown to equal the provider\'s own bidRate on live rows, which is the test that proves `total` really is bidRate\'s denominator.',
  },
  {
    id: 'bids-to-rated',
    from: 'bids',
    to: 'rated',
    numerator: 'bidStats.rated',
    denominator: 'bidStats.bids',
    comparability: 'unverified',
    minimumSample: 100,
    minimumConfidence: 0.5,
    status: 'unproven-equivalence',
    why: 'Well-formed within one row, but `rated`\'s meaning is unproven, so the ratio\'s meaning is unproven with it. It must not be labelled "Made %".',
  },
  {
    id: 'bids-to-won',
    from: 'bids',
    to: 'won',
    numerator: 'bidStats.won',
    denominator: 'bidStats.bids',
    comparability: 'unverified',
    minimumSample: 100,
    minimumConfidence: 0.5,
    status: 'verified',
    why: 'Both fields verified and on the same row. Becomes `comparable` once won/bids is shown to equal the provider\'s winRate — until then Loop does not know whether winRate\'s denominator is `bids` or `total`, and the two give very different answers.',
  },
  {
    id: 'won-to-calls',
    from: 'won',
    to: 'calls',
    numerator: 'MarketplaceCall count',
    denominator: 'bidStats.won',
    comparability: 'unverified',
    minimumSample: 1,
    minimumConfidence: 0.5,
    status: 'loop-derived',
    why: 'Two independent systems over nominally the same window. A mismatch here is a REPORTABLE OBSERVATION, not an error to be reconciled away: the report window is bucketed by the provider in an unknown timezone while the call path requests US/Eastern, so a boundary-straddling call would appear on one side and not the other. Report the delta and the two window semantics; do not invent the explanation.',
  },
];

// --- Denominator verification -------------------------------------------------

/**
 * The formulas Loop SUSPECTS the provider uses, and the arithmetic that would
 * prove or disprove each.
 *
 * These are hypotheses. `verifyDenominators` tests them against live rows; until
 * it does, nothing here may be used to relabel a provider rate.
 */
export const DENOMINATOR_HYPOTHESES = [
  { rate: 'bidRate', numerator: 'bids', denominator: 'total' },
  { rate: 'winRate', numerator: 'won', denominator: 'bids' },
  { rate: 'winRateAlt', numerator: 'won', denominator: 'total' },
  { rate: 'rejectRate', numerator: 'rejected', denominator: 'total' },
  { rate: 'rejectRateAlt', numerator: 'rejected', denominator: 'bids' },
] as const;

export interface DenominatorVerdict {
  rate: string;
  numerator: string;
  denominator: string;
  /** Rows where the hypothesis held to tolerance. */
  agreed: number;
  /** Rows where it did not. */
  disagreed: number;
  /** Rows skipped because a field was null or the denominator was zero. */
  skipped: number;
  verdict: 'proven' | 'disproven' | 'insufficient-evidence';
  note: string;
}

/**
 * Test each denominator hypothesis against live rows.
 *
 * `proven` requires EVERY testable row to agree, not a majority. A denominator
 * that holds on 90% of rows is not the denominator — it is a coincidence with a
 * counterexample, and the counterexample is the interesting part.
 */
export function verifyDenominators(
  rows: ReadonlyArray<Record<string, number | null | undefined>>,
  tolerancePercentagePoints = 0.01,
): DenominatorVerdict[] {
  return DENOMINATOR_HYPOTHESES.map((h) => {
    let agreed = 0;
    let disagreed = 0;
    let skipped = 0;

    // `rateField` strips the Alt suffix used to test two candidates for one rate.
    const rateField = h.rate.replace(/Alt$/, '');

    for (const row of rows) {
      const n = row[h.numerator];
      const d = row[h.denominator];
      const reported = row[rateField];
      if (
        typeof n !== 'number' || typeof d !== 'number' || typeof reported !== 'number' ||
        !Number.isFinite(n) || !Number.isFinite(d) || !Number.isFinite(reported) || d === 0
      ) {
        skipped += 1;
        continue;
      }
      // Provider rates are percentage POINTS, so the hypothesis is scaled to match.
      const expected = (n / d) * 100;
      if (Math.abs(expected - reported) <= tolerancePercentagePoints) agreed += 1;
      else disagreed += 1;
    }

    const verdict: DenominatorVerdict['verdict'] =
      agreed + disagreed === 0 ? 'insufficient-evidence'
        : disagreed > 0 ? 'disproven'
        : 'proven';

    return {
      rate: h.rate,
      numerator: h.numerator,
      denominator: h.denominator,
      agreed,
      disagreed,
      skipped,
      verdict,
      note:
        verdict === 'proven'
          ? `Every one of the ${agreed} testable rows satisfies ${h.rate} = ${h.numerator} / ${h.denominator} × 100.`
          : verdict === 'disproven'
            ? `${disagreed} of ${agreed + disagreed} rows contradict ${h.numerator} / ${h.denominator}. This is NOT the denominator.`
            : 'No row carried all three fields with a non-zero denominator. Nothing is proven either way.',
    };
  });
}

/**
 * Whether a transition may be published as a number, given what has been proven.
 *
 * Called at read time. A transition whose comparability is `not-comparable`
 * never becomes publishable, no matter how much data arrives — the obstacle is
 * the grain, and more rows do not change a grain.
 */
export function transitionIsPublishable(
  transition: FunnelTransition,
  proven: ReadonlyArray<DenominatorVerdict>,
  sampleSize: number,
): { publishable: boolean; reason: string } {
  if (transition.comparability === 'not-comparable') {
    return { publishable: false, reason: transition.why };
  }
  if (sampleSize < transition.minimumSample) {
    return {
      publishable: false,
      reason: `Sample of ${sampleSize} is below this transition's declared minimum of ${transition.minimumSample}.`,
    };
  }
  if (transition.status === 'no-provider-source') {
    return { publishable: false, reason: 'No provider field supplies this stage.' };
  }
  if (transition.comparability === 'unverified') {
    const relevant = proven.filter((p) => p.verdict === 'proven');
    if (relevant.length === 0) {
      return {
        publishable: false,
        reason: 'No denominator hypothesis has been proven against live rows, so the ratio\'s denominator is unknown.',
      };
    }
  }
  return { publishable: true, reason: 'Declared requirements met.' };
}

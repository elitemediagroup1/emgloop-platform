// Marketplace Failure Taxonomy — why opportunity is lost before a call exists.
//
// A PERMANENT PLATFORM CONCEPT, not a CallGrid mirror.
//
// Loop speaks business. `4004` is not a business concept; "the buyer had no
// capacity" is. Every category below is stated in language an operator can act
// on, with the provider's own code retained only as evidence.
//
// SOURCE OF TRUTH FOR THESE DEFINITIONS
//
// https://callgrid.com/knowledge-base/call-bidding-error-codes-explained —
// CallGrid's published error codes, each with its own explanation and, crucially,
// who can fix it. Quoted verbatim in `providerDefinition` so a reader can check
// the mapping rather than trust it.
//
// This is BUSINESS reference material, not an API contract. It tells us what the
// concepts mean; it does not tell us what any endpoint returns. Field names still
// require live verification — see docs/CALLGRID_AUCTION_FUNNEL.md §Discovery.

/** Stable business categories. These outlive any one provider. */
export type FailureCategory =
  /** Something is switched off, paused, or misconfigured. */
  | 'configuration'
  /** A ceiling was reached: caps, concurrency, operating hours, rate limits. */
  | 'capacity'
  /** The opportunity did not qualify: caller data invalid or incomplete. */
  | 'eligibility'
  /** Targeting rules excluded it. */
  | 'targeting'
  /** Already seen: the same caller or the same request. */
  | 'duplicates'
  /** Blocked for compliance or fraud reasons. */
  | 'compliance'
  /** The provider could not service the request. */
  | 'provider'
  /** Price lost the auction. */
  | 'pricing'
  /** Too slow to participate. */
  | 'latency'
  /** Routing could not complete. */
  | 'routing'
  /** Unclassified. Deliberately present — a taxonomy that cannot say "I don't know" lies. */
  | 'unknown';

/** Who can actually resolve it. Determines who a recommendation is addressed to. */
export type FailureOwner =
  | 'campaign-owner'
  | 'buyer'
  | 'source' // the publisher/vendor sending traffic
  | 'platform' // CallGrid or Loop configuration
  | 'unknown';

export interface FailureMode {
  /** Loop's business-language identifier. This is the primary vocabulary. */
  id: string;
  /** What an operator sees. Never a provider code. */
  label: string;
  category: FailureCategory;
  owner: FailureOwner;
  /** Whether an operator can act on it at all. Some failures are working as intended. */
  actionable: boolean;
  /** Loop's business meaning, in operator language. */
  meaning: string;
  /** The provider's own words, verbatim, so the mapping is checkable. */
  providerDefinition: string;
  /** The provider's code, retained as EVIDENCE only — never as the primary language. */
  providerCode: string | null;
  /** Where the definition came from. */
  citation: string;
  /**
   * Whether this mode can co-occur with others on the same opportunity.
   * NOT a guess — see the note on capacity/targeting overlap below.
   */
  exclusive: boolean | 'unknown';
}

const KB = 'callgrid.com/knowledge-base/call-bidding-error-codes-explained';
/** The authoritative machine contract: api.callgrid.com/openapi (public, OpenAPI 3.0.0). */
const OAS = 'api.callgrid.com/openapi';

/**
 * The verified failure modes.
 *
 * Every `providerDefinition` is quoted from CallGrid's published error-code
 * documentation. Every `owner` is CallGrid's own attribution, not our inference.
 */
export const FAILURE_MODES: readonly FailureMode[] = [
  {
    id: 'campaign-disabled',
    label: 'Campaign is disabled',
    category: 'configuration',
    owner: 'campaign-owner',
    actionable: true,
    meaning: 'The campaign cannot receive traffic at all. Every opportunity is lost until it is re-enabled.',
    providerDefinition: 'Your campaign is currently disabled and cannot process calls',
    providerCode: '4001',
    citation: KB,
    exclusive: true,
  },
  {
    id: 'campaign-paused',
    label: 'Campaign is paused',
    category: 'configuration',
    owner: 'campaign-owner',
    actionable: true,
    meaning:
      'Deliberately and temporarily stopped by its owner. Distinct from disabled: pausing is expected operational behaviour, so volume lost here is often intentional.',
    providerDefinition: 'The campaign has been temporarily paused by the campaign owner',
    providerCode: '4002',
    citation: KB,
    exclusive: true,
  },
  {
    id: 'caller-id-invalid',
    label: 'Caller number was not usable',
    category: 'eligibility',
    owner: 'source',
    actionable: true,
    meaning:
      'The caller number failed validation — missing country code, stray formatting, or an invalid area code. This is a traffic-quality problem at the source, not a buyer problem.',
    providerDefinition: "The caller ID provided doesn't meet CallGrid's validation criteria",
    providerCode: '4003',
    citation: KB,
    exclusive: true,
  },
  {
    id: 'capacity-exhausted',
    label: 'No capacity to take the call',
    category: 'capacity',
    owner: 'buyer',
    actionable: true,
    meaning:
      'A ceiling was reached: outside operating hours, a daily or monthly cap hit, or the buyer was full. This is the category most likely to represent RECOVERABLE revenue, because the demand existed and could not be served.',
    providerDefinition: 'The call was rejected due to capacity or filtering rules',
    providerCode: '4004',
    citation: KB,
    // CallGrid's own description of 4004 includes "tag rule failure", which is
    // ALSO 4009. The two overlap by the provider's own account, so neither can
    // be treated as exclusive without live evidence.
    exclusive: 'unknown',
  },
  {
    id: 'duplicate-caller',
    label: 'Caller already paid out',
    category: 'duplicates',
    owner: 'platform',
    actionable: false,
    meaning:
      'This caller was already processed and paid for within the protection window. Working as intended — suppressing it is the point, so this is not lost revenue.',
    providerDefinition: 'A call from this caller ID has already been processed and paid out',
    providerCode: '4005',
    citation: KB,
    exclusive: true,
  },
  {
    id: 'no-numbers-available',
    label: 'No phone numbers available',
    category: 'provider',
    owner: 'platform',
    actionable: true,
    meaning: 'The number pool was exhausted. A provisioning problem, not a marketplace one.',
    providerDefinition:
      'There are no available phone numbers in your pool for Public Switched Telephone Network',
    providerCode: '4006',
    citation: KB,
    exclusive: true,
  },
  {
    id: 'caller-blocked',
    label: 'Caller is blocked',
    category: 'compliance',
    owner: 'platform',
    actionable: false,
    meaning:
      'Explicitly blocked by a suppression list, a fraud or compliance restriction, or an administrator. Recovering this volume is generally NOT desirable.',
    providerDefinition:
      'The caller ID has been explicitly blocked by platform-level controls or campaign rules',
    providerCode: '4007',
    citation: KB,
    exclusive: true,
  },
  {
    id: 'duplicate-request',
    label: 'The same request was sent twice',
    category: 'duplicates',
    owner: 'source',
    actionable: true,
    meaning:
      'A bid request was submitted more than once for the same caller. DISTINCT from a duplicate caller: this is the source re-sending a request, not a repeat customer. High volume here indicates a source integration problem, and CallGrid notes it can be permitted via "Allow repeat pings".',
    providerDefinition: 'A bid request was submitted more than once for the same caller ID',
    providerCode: '4008',
    citation: KB,
    exclusive: true,
  },
  {
    id: 'targeting-rules-failed',
    label: 'Did not match targeting rules',
    category: 'targeting',
    owner: 'source',
    actionable: true,
    meaning:
      'Required tags were missing, out of range, or mismatched on geography, intent or vertical. Usually a source data-quality problem rather than a demand problem.',
    providerDefinition:
      'The incoming call or bid did not satisfy one or more campaign tag-based targeting rules',
    providerCode: '4009',
    citation: KB,
    exclusive: 'unknown', // see capacity-exhausted
  },
  {
    id: 'rate-limited',
    label: 'Too many requests too quickly',
    category: 'capacity',
    owner: 'source',
    actionable: true,
    meaning:
      'The request rate exceeded the allowed limit. A throughput constraint, distinct from a buyer being full — the opportunity was never evaluated.',
    providerDefinition: 'Your application has made too many API requests in a short time period',
    providerCode: '5001',
    citation: KB,
    exclusive: true,
  },
  // --- Verified from the OpenAPI report contracts -------------------------
  // These come from /api/reports/bidStats/rejections and /api/reports/pingStats.
  // The rejection vocabulary there is RICHER than the published error codes:
  // minRevenue, missingAmount, invalidNumber, durationElapsed, pingTimeout,
  // apiFailed and suppressed have no 4001-5001 equivalent at all. A taxonomy
  // built only from the error-codes article would have silently dropped them.
  {
    id: 'destination-closed',
    label: 'Destination was closed',
    category: 'configuration',
    owner: 'buyer',
    actionable: true,
    meaning: 'The destination was outside its operating hours or otherwise closed to traffic.',
    providerDefinition: 'Rejected: destination closed',
    providerCode: 'rejections.closed',
    citation: OAS,
    exclusive: 'unknown',
  },
  {
    id: 'acceptance-parse-failed',
    label: "Buyer's acceptance response could not be read",
    category: 'provider',
    owner: 'buyer',
    actionable: true,
    meaning:
      "The buyer replied, but the response could not be parsed. An integration fault on the buyer side, NOT a decline — counting it as a rejection would blame the wrong party.",
    providerDefinition: 'Rejected: failed acceptance parsing',
    providerCode: 'rejections.failedAcceptance',
    citation: OAS,
    exclusive: 'unknown',
  },
  {
    id: 'below-minimum-revenue',
    label: 'Bid was below the minimum accepted price',
    category: 'pricing',
    owner: 'buyer',
    actionable: true,
    meaning:
      'The bid did not clear the destination\'s revenue floor. The first genuinely PRICING-driven loss in the taxonomy — distinct from losing an auction on price.',
    providerDefinition: 'Rejected: below minimum revenue',
    providerCode: 'pingStats.minRevenue',
    citation: OAS,
    exclusive: 'unknown',
  },
  {
    id: 'bid-amount-missing',
    label: 'Bid arrived with no amount',
    category: 'provider',
    owner: 'source',
    actionable: true,
    meaning: 'A bid was submitted without a price. An integration defect, not a commercial decision.',
    providerDefinition: 'Rejected: missing bid amount',
    providerCode: 'pingStats.missingAmount',
    citation: OAS,
    exclusive: 'unknown',
  },
  {
    id: 'invalid-number',
    label: 'Phone number was invalid',
    category: 'eligibility',
    owner: 'source',
    actionable: true,
    meaning: 'The supplied number failed validation. A traffic-quality problem at the source.',
    providerDefinition: 'Rejected: invalid phone number',
    providerCode: 'pingStats.invalidNumber',
    citation: OAS,
    exclusive: 'unknown',
  },
  {
    id: 'duration-elapsed',
    label: 'Offer expired before it could be used',
    category: 'latency',
    owner: 'source',
    actionable: true,
    meaning: 'The permitted duration elapsed before the opportunity was converted.',
    providerDefinition: 'Rejected: duration seconds exceeded',
    providerCode: 'pingStats.durationElapsed',
    citation: OAS,
    exclusive: 'unknown',
  },
  {
    id: 'ping-timeout',
    label: 'Buyer did not respond in time',
    category: 'latency',
    owner: 'buyer',
    actionable: true,
    meaning:
      'The destination did not answer the ping within the allowed window. Latency, not price — a fast cheap buyer beats a slow expensive one here.',
    providerDefinition: 'Rejected: ping timeout',
    providerCode: 'pingStats.pingTimeout',
    citation: OAS,
    exclusive: 'unknown',
  },
  {
    id: 'buyer-api-failed',
    label: "Buyer's system errored",
    category: 'provider',
    owner: 'buyer',
    actionable: true,
    meaning: 'The destination API failed outright. An availability problem on the buyer side.',
    providerDefinition: 'Rejected: api failure',
    providerCode: 'pingStats.apiFailed',
    citation: OAS,
    exclusive: 'unknown',
  },
  {
    id: 'suppressed',
    label: 'Suppressed by policy',
    category: 'compliance',
    owner: 'platform',
    actionable: false,
    meaning: 'Deliberately suppressed. Working as intended; not recoverable demand.',
    providerDefinition: 'Rejected: suppressed',
    providerCode: 'pingStats.suppressed',
    citation: OAS,
    exclusive: 'unknown',
  },
] as const;

const BY_ID = new Map(FAILURE_MODES.map((m) => [m.id, m]));
const BY_CODE = new Map(FAILURE_MODES.filter((m) => m.providerCode).map((m) => [m.providerCode!, m]));

export const failureModeById = (id: string): FailureMode | undefined => BY_ID.get(id);

/** Translate a provider code into business language. Unknown codes stay unknown. */
export const failureModeByProviderCode = (code: string): FailureMode | undefined => BY_CODE.get(code);

/**
 * Whether the taxonomy may be summed into a total.
 *
 * FALSE while any mode is non-exclusive. CallGrid's own description of 4004
 * includes tag-rule failure, which is separately 4009 — so the same underlying
 * cause can surface under two codes, and adding the categories would double
 * count. A "dominant failure reason" is not a valid claim until this is
 * resolved against live data.
 */
export const taxonomyIsSummable = (): boolean => FAILURE_MODES.every((m) => m.exclusive === true);

/** Modes an operator can actually do something about. */
export const actionableModes = (): readonly FailureMode[] => FAILURE_MODES.filter((m) => m.actionable);

/**
 * Modes representing potentially RECOVERABLE demand — the opportunity existed
 * and could have been served. Deliberately excludes duplicates and compliance
 * blocks, where suppression is the desired behaviour and "recovering" it would
 * be a mistake.
 */
export const recoverableModes = (): readonly FailureMode[] =>
  FAILURE_MODES.filter(
    (m) => m.actionable && m.category !== 'duplicates' && m.category !== 'compliance',
  );

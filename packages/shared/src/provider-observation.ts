// Provider observation — proving a business date was actually looked at.
//
// THE FACT THIS FILE EXISTS TO CARRY
//
// "We looked and saw zero" and "we do not know whether we looked" are different
// facts about the world, and until now Loop could not tell them apart. Every
// artefact the platform stored was evidence of PRESENCE — an Interaction, a
// MarketplaceCall, an integration_event — and none was evidence of ABSENCE. Zero
// rows for a day was indistinguishable from a day nobody queried, so a three-day
// ingestion outage in August 2026 would have been measured as a commercial
// collapse by a rule that was working exactly as written.
//
// Completeness therefore cannot be DERIVED. It has to be ASSERTED by a deliberate
// bounded read against the provider, and persisted. This file is the pure half of
// that: the vocabulary, the certification rule, and the window verdict. It reads
// no clock, performs no I/O and knows nothing about CallGrid.
//
// THE STATUS VOCABULARY IS BORROWED, NOT INVENTED. Every member below is copied
// from `MarketplaceReportRunStatus`, the enum the auction-report ledger has used
// since PR #147. Its members already name every outcome a bounded provider query
// can have, and its `EMPTY` — "read cleanly, provider returned no rows, a real
// reportable fact" — is precisely the proven-quiet-day concept this design needs.
// A second enum meaning the same six things would be exactly the parallel-system
// failure mode CLAUDE.md names first. The database reuses the Prisma enum; this
// union mirrors it for the pure layer, and a test asserts the two agree.

import type { BusinessDate } from './business-time';

/** Which build of the completeness rule governed a decision. Stored on Headlines. */
export const OBSERVATION_RULE_VERSION = 'observation-completeness.v1';

/**
 * The outcome of one bounded provider read over one business date.
 *
 * Mirrors `MarketplaceReportRunStatus` in the Prisma schema, member for member.
 */
export const PROVIDER_OBSERVATION_STATUSES = [
  /** Every page the provider offered was read, and rows were stored. */
  'SUCCESS',
  /** Read cleanly, provider returned no rows. A real, reportable fact. */
  'EMPTY',
  /** Non-2xx or network failure. */
  'ENDPOINT_FAILURE',
  /** 2xx whose body was not JSON. */
  'MALFORMED_RESPONSE',
  /** 2xx JSON whose shape we could not read. NEVER treated as empty. */
  'UNKNOWN_ENVELOPE',
  /** We stopped at our own page budget while the provider still had more. */
  'PARTIAL_PAGINATION',
] as const;

export type ProviderObservationStatus = (typeof PROVIDER_OBSERVATION_STATUSES)[number];

/** Plain-language meaning, for a surface that has to explain a withheld measurement. */
export const PROVIDER_OBSERVATION_STATUS_LABELS: Record<ProviderObservationStatus, string> = {
  SUCCESS: 'Observed in full.',
  EMPTY: 'Observed in full; the provider reported no calls that day.',
  ENDPOINT_FAILURE: 'The provider could not be reached, so the day was never observed.',
  MALFORMED_RESPONSE: 'The provider returned a body Loop could not read.',
  UNKNOWN_ENVELOPE: 'The provider returned a shape Loop does not recognise. Never read as zero.',
  PARTIAL_PAGINATION: 'Only part of the day was read before the page budget ran out.',
};

/**
 * THE CERTIFICATION RULE. One expression, one place.
 *
 * A day counts as observed ONLY when a bounded query covering the whole business
 * date exhausted the provider's pagination without error. SUCCESS is that with
 * rows; EMPTY is that without. Everything else — truncated, failed, malformed,
 * unrecognised — is a day Loop does not know about, and so is the absence of a
 * row entirely.
 *
 * Note what is deliberately NOT here: the existence of an Interaction, a
 * MarketplaceCall or an integration_event; webhook activity; a human's assertion;
 * the health of adjacent days. Each of those is evidence that something arrived,
 * never evidence that everything did.
 */
export function certifiesObservation(status: ProviderObservationStatus | null | undefined): boolean {
  return status === 'SUCCESS' || status === 'EMPTY';
}

/** One business date that did not certify, and why. */
export interface UncertifiedDay {
  businessDate: BusinessDate;
  /** The recorded outcome, or null when no observation was ever attempted. */
  status: ProviderObservationStatus | null;
  /** Plain-language reason, always populated. */
  reason: string;
}

/** Whether a comparison's underlying days were sufficiently observed. */
export interface WindowObservation {
  /** Which rule version produced this verdict. */
  ruleVersion: string;
  /** Every business date the comparison covers, both windows, in order. */
  dates: readonly BusinessDate[];
  /** How many of those certified. Equals `dates.length` when fully observed. */
  observedDayCount: number;
  /** The dates that did NOT certify. Empty means the comparison may proceed. */
  uncertified: readonly UncertifiedDay[];
  /** True only when every date certified. */
  fullyObserved: boolean;
}

const NEVER_OBSERVED_REASON = 'No observation was ever recorded for this day.';

/**
 * Assess whether a set of business dates was observed.
 *
 * FAILS CLOSED IN BOTH DIRECTIONS. A date with no entry is uncertified, and a
 * date whose status does not certify is uncertified. There is no branch that
 * treats a missing lookup as satisfied, because that is the exact substitution —
 * absence read as zero — this whole mechanism exists to prevent.
 *
 * @param dates  every business date the comparison covers. Order is preserved.
 * @param byDate what the ledger holds for each. A date absent from the map has
 *               never been observed; that is different from being present with a
 *               failing status, and both are reported with their own reason.
 */
export function assessWindowObservation(
  dates: readonly BusinessDate[],
  byDate: ReadonlyMap<BusinessDate, ProviderObservationStatus>,
): WindowObservation {
  const uncertified: UncertifiedDay[] = [];
  let observedDayCount = 0;

  for (const businessDate of dates) {
    const status = byDate.get(businessDate) ?? null;
    if (certifiesObservation(status)) {
      observedDayCount += 1;
      continue;
    }
    uncertified.push({
      businessDate,
      status,
      reason: status === null ? NEVER_OBSERVED_REASON : PROVIDER_OBSERVATION_STATUS_LABELS[status],
    });
  }

  return {
    ruleVersion: OBSERVATION_RULE_VERSION,
    dates,
    observedDayCount,
    uncertified,
    fullyObserved: uncertified.length === 0,
  };
}

/**
 * One line naming what was not observed, for a measurement's `unknowns`.
 *
 * Lists the dates rather than counting them: "3 days were not observed" tells a
 * reader the scale, and "2026-08-11, 2026-08-12, 2026-08-13 were not observed"
 * tells them what to go and fix. Long runs are capped so a pathological window
 * cannot produce an unreadable string, and the cap states that it applied.
 */
export function describeUnobserved(observation: WindowObservation, limit = 10): string {
  const shown = observation.uncertified.slice(0, limit).map((d) => d.businessDate);
  const remainder = observation.uncertified.length - shown.length;
  const list = shown.join(', ') + (remainder > 0 ? ` and ${remainder} more` : '');
  return (
    `${observation.uncertified.length} of ${observation.dates.length} days in the compared ` +
    `periods were not observed (${list}), so a change cannot be measured over them.`
  );
}

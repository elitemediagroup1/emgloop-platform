// How Loop observed a provider event.
//
// ONE CANONICAL EVENT, MANY OBSERVATIONS. A CallGrid call has exactly one
// identity and exactly one IntegrationEvent row. It may be observed several
// times: the webhook delivers it live, a poller re-reads the window it falls
// in, and a recovery operation may fetch it deliberately months later. Those
// are not three calls and they are not three rows. They are three OBSERVATIONS
// of one fact, and this vocabulary names which is which.
//
// A CLOSED LIST OF THREE, and each member names a genuinely different act:
//
//   WEBHOOK       the provider pushed it to us as it happened.
//   API_POLL      routine polling read it back, on its own schedule.
//   API_RECOVERY  a person deliberately went and got it, because it was missing.
//
// The third is not a variant of the second. "We poll continuously and this
// arrived" and "somebody noticed a gap and went to fill it" are different
// stories about the same row, and a reader six months from now needs to be able
// to tell them apart -- especially for the 2026-08-11 to 08-13 population, where
// every local row will eventually carry API_RECOVERY and none of them arrived
// the way the rest of the ledger did.
//
// STORED AS TEXT, not as a database enum, following the convention the
// expectation, reconciliation and measurement-source vocabularies already
// established: the list can widen without production DDL, which means a row can
// outlive the build that wrote it. Readers therefore FAIL CLOSED on a value they
// do not recognise rather than guessing which of three it meant.

export const OBSERVATION_SOURCES = ['WEBHOOK', 'API_POLL', 'API_RECOVERY'] as const;

export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

/** Whether a stored string names an observation path. Fails closed. */
export function isObservationSource(value: unknown): value is ObservationSource {
  return typeof value === 'string' && (OBSERVATION_SOURCES as readonly string[]).includes(value);
}

export const OBSERVATION_SOURCE_LABELS: Record<ObservationSource, string> = {
  WEBHOOK: 'Delivered live by the provider.',
  API_POLL: 'Read back by routine polling.',
  API_RECOVERY: 'Fetched deliberately because it was missing.',
};

/**
 * The observation set a row should carry after being observed again.
 *
 * A SET, NOT A LOG. The question this answers is "which paths have ever seen
 * this call", which has at most three answers. A poller re-reading a 48-hour
 * overlap every fifteen minutes would append roughly two hundred rows per call
 * to a ledger, to record a fact that never grows past three values -- so the
 * set is the honest shape and the ledger would be storage spent on repetition.
 *
 * ORDER IS FIRST-SEEN and preserved, so the array reads as the history it is.
 * An unrecognised stored value is KEPT rather than dropped: it came from
 * somewhere, and silently discarding it would make a widened vocabulary look
 * like an observation that never happened.
 */
export function withObservation(existing: readonly string[], source: ObservationSource): string[] {
  return existing.includes(source) ? [...existing] : [...existing, source];
}

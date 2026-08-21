// Is provider coverage keeping up? — the question an alert should ask.
//
// PURE. A stored boundary, a clock and a policy go in; a status comes out.
//
// WHY THIS IS NOT "DID THE LAST RUN SUCCEED"
//
// A scheduled job that FAILS is visible. A scheduled job that STOPS RUNNING is
// silent, and silence currently reads as health — which is the August failure
// mode wearing different clothes. This repository has already proved that a red
// scheduled run is not an alert: `drain-outbox.yml` failed on a hundred
// consecutive runs, for months, because two secrets were never set, and nobody
// noticed.
//
// So the question this answers is deliberately about the DURABLE BOUNDARY rather
// than about any run. `completedThrough` is a row in the database. It goes stale
// whether the poller failed, never started, was switched off, or the whole
// deployment is down — and something outside Loop can read it and find out. A
// health signal that only exists while the thing being watched is working is not
// a health signal.
//
// THE THRESHOLDS ARE POLICY, and they are stated as policy. Nothing about CallGrid
// says when coverage is late; what says it is the cadence we chose to poll at.

export const COVERAGE_HEALTH_STATUSES = [
  /** Coverage is within the expected lag for the configured cadence. */
  'HEALTHY',
  /** Later than expected. Something is wrong but nothing is lost yet. */
  'LAGGING',
  /** Far enough behind to be the shape of an incident. */
  'STALE',
  /** No coverage has ever been proven for this stream. */
  'NEVER_PROVEN',
] as const;

export type CoverageHealthStatus = (typeof COVERAGE_HEALTH_STATUSES)[number];

export interface CoverageHealthPolicy {
  /**
   * Beyond this, coverage is LAGGING.
   *
   * THREE MISSED HOURLY PASSES. One late pass is GitHub's scheduler being coarse
   * under load, which it documents and which the overlap absorbs. Three in a row
   * is not weather.
   */
  laggingAfterMs: number;
  /**
   * Beyond this, coverage is STALE.
   *
   * HALF A DAY. The August incident ran for about three days before anybody
   * noticed; half a day is short enough to catch that shape on its first morning
   * and long enough that a maintenance window or a slow catch-up chunk does not
   * cry wolf.
   */
  staleAfterMs: number;
}

export const DEFAULT_COVERAGE_HEALTH_POLICY: CoverageHealthPolicy = {
  laggingAfterMs: 3 * 60 * 60 * 1000,
  staleAfterMs: 12 * 60 * 60 * 1000,
};

export interface CoverageHealthInput {
  /** The proven boundary, or null when nothing has ever been proven. */
  completedThrough: Date | null;
  now: Date;
  policy: CoverageHealthPolicy;
}

export interface CoverageHealth {
  status: CoverageHealthStatus;
  /**
   * How far behind the clock proven coverage sits. Null when nothing is proven.
   *
   * NEGATIVE IS POSSIBLE and is not clamped: a boundary ahead of the clock means
   * clock skew between whatever advanced it and whatever is reading it, and
   * hiding that behind a zero would turn a real fault into a healthy-looking one.
   */
  lagMs: number | null;
}

/**
 * Judge one stream's coverage.
 *
 * FAILS TOWARD ATTENTION. An unusable policy or an unreadable boundary reports
 * NEVER_PROVEN rather than HEALTHY, because the cost of a false alarm is a person
 * looking at a dashboard and the cost of a false all-clear is three days of
 * missing calls.
 */
export function assessCoverageHealth(input: CoverageHealthInput): CoverageHealth {
  const { completedThrough, now, policy } = input;
  if (!completedThrough || !Number.isFinite(completedThrough.getTime())) {
    return { status: 'NEVER_PROVEN', lagMs: null };
  }
  if (!Number.isFinite(now.getTime())) return { status: 'NEVER_PROVEN', lagMs: null };
  if (
    !Number.isFinite(policy.laggingAfterMs) ||
    !Number.isFinite(policy.staleAfterMs) ||
    policy.laggingAfterMs < 0 ||
    policy.staleAfterMs < 0
  ) {
    return { status: 'NEVER_PROVEN', lagMs: null };
  }

  const lagMs = now.getTime() - completedThrough.getTime();
  // STALE IS TESTED FIRST. If somebody ever configures the two thresholds the
  // wrong way round, the answer that gets more attention should win.
  if (lagMs > policy.staleAfterMs) return { status: 'STALE', lagMs };
  if (lagMs > policy.laggingAfterMs) return { status: 'LAGGING', lagMs };
  return { status: 'HEALTHY', lagMs };
}

/** Whether a status means somebody should look. NEVER_PROVEN is judged by the caller. */
export function coverageNeedsAttention(status: CoverageHealthStatus): boolean {
  return status === 'LAGGING' || status === 'STALE';
}

/**
 * The worst status across several streams.
 *
 * ONE STALE STREAM MAKES THE PLATFORM STALE. A healthy tenant must never be able
 * to average away an unhealthy one, which is the failure mode every rolled-up
 * status page eventually has.
 */
export function worstCoverageStatus(
  statuses: readonly CoverageHealthStatus[],
): CoverageHealthStatus {
  const order: CoverageHealthStatus[] = ['HEALTHY', 'NEVER_PROVEN', 'LAGGING', 'STALE'];
  let worst: CoverageHealthStatus = 'HEALTHY';
  for (const status of statuses) {
    if (order.indexOf(status) > order.indexOf(worst)) worst = status;
  }
  return worst;
}

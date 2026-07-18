// Marketplace Coverage — server data loader.
//
// Reads counted observations from the canonical call record and hands them to
// the pure coverage assessor. The split matters: the repository counts, the
// assessor judges, and neither invents. Nothing here authors a status.
//
// Deliberately returns a discriminated result rather than an empty report on
// failure. A read that FAILED and a marketplace with NO CALLS are different
// facts about the world, and collapsing them is how a dashboard ends up
// confidently rendering "0 buyers" during a database outage.

import {
  assessMarketplaceCoverage,
  rankUnblockingWork,
  type MarketplaceCoverageReport,
  type CapabilityCoverage,
} from '@emgloop/intelligence';
import {
  measure,
  success,
  empty,
  measuredCount,
  type Truth,
  type TruthMeta,
} from '@emgloop/shared';
import { crmRepos } from '../../../../crm/crm-data';

/** Matches the traffic window the rest of the Marketplace reports against. */
const WINDOW_DAYS = 7;
const WINDOW_LABEL = 'Last 7 days';

export interface MarketplaceCoverageResult {
  /** The coverage report itself. ERROR when the read failed — never an empty report. */
  report: Truth<MarketplaceCoverageReport>;
  /** Ranked unblocking work, derived from the report. */
  priority: CapabilityCoverage[];
  /** Calls ingested in the window, as its own measurement. EMPTY when truly zero. */
  callsIngested: Truth<number>;
}

/**
 * Load marketplace coverage as Truth.
 *
 * `measure()` converts a thrown read into ERROR, so a database outage can never
 * arrive at the page as an empty report. That distinction is the entire point:
 * "no calls in this window" and "we could not ask" are different facts, and the
 * operator must be able to tell them apart.
 */
export async function loadMarketplaceCoverage(
  organizationId: string,
  now: Date = new Date(),
): Promise<MarketplaceCoverageResult> {
  const until = now;
  const since = new Date(until.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const meta: TruthMeta = { measuredAt: until.toISOString(), subject: 'marketplace.coverage' };

  const report = await measure<MarketplaceCoverageReport>(
    async () => {
      const observations = await crmRepos.marketplaceCalls.coverageObservations(
        organizationId,
        since,
        until,
      );
      return assessMarketplaceCoverage({
        windowLabel: WINDOW_LABEL,
        callsIngested: observations.callsIngested,
        populated: observations.populated,
      });
    },
    // A coverage report is never "empty" — it always describes 13 capabilities,
    // even when every one of them is undetermined. So a completed read is SUCCESS.
    (value, m) => success(value, m),
    meta,
  );

  // Calls ingested is a separate measurement with its own posture: a completed
  // count of 0 is EMPTY (measured, genuinely none), not UNKNOWN.
  const callsIngested: Truth<number> =
    report.state === 'success'
      ? measuredCount(report.value.callsIngested, { ...meta, subject: 'marketplace.callsIngested' })
      : report.state === 'error'
        ? { ...report, subject: 'marketplace.callsIngested' }
        : empty(0, { ...meta, subject: 'marketplace.callsIngested' });

  return {
    report,
    priority: report.state === 'success' ? rankUnblockingWork(report.value) : [],
    callsIngested,
  };
}

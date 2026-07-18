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
import { crmRepos } from '../../../../crm/crm-data';

/** Matches the traffic window the rest of the Marketplace reports against. */
const WINDOW_DAYS = 7;
const WINDOW_LABEL = 'Last 7 days';

export type CoverageLoad =
  | { ok: true; report: MarketplaceCoverageReport; priority: CapabilityCoverage[] }
  /** The read itself failed. NOT the same as "no data" — never render zeros for this. */
  | { ok: false; reason: string };

export async function loadMarketplaceCoverage(
  organizationId: string,
  now: Date = new Date(),
): Promise<CoverageLoad> {
  try {
    const until = now;
    const since = new Date(until.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const observations = await crmRepos.marketplaceCalls.coverageObservations(
      organizationId,
      since,
      until,
    );

    const report = assessMarketplaceCoverage({
      windowLabel: WINDOW_LABEL,
      callsIngested: observations.callsIngested,
      populated: observations.populated,
    });

    return { ok: true, report, priority: rankUnblockingWork(report) };
  } catch (error) {
    // Surfaced to the operator as an explicit unavailable state, never as zero.
    return {
      ok: false,
      reason:
        error instanceof Error
          ? `The marketplace coverage read failed: ${error.message}`
          : 'The marketplace coverage read failed for an unknown reason.',
    };
  }
}

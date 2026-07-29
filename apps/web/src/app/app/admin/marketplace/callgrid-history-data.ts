import 'server-only';

// Loads the historical series the distribution rules need.
//
// It reads the SAME canonical aggregation (`marketplaceCalls.aggregateWindow`)
// that the selected and comparison windows use — one economics source, one set of
// metric definitions. It adds earlier periods; it redefines nothing.
//
// COST, STATED PLAINLY
// One query per historical period. `DEFAULT_HISTORY_PERIODS` is 8, so a page that
// asks for history issues 8 additional reads on top of the selected and comparison
// windows. That is why history is loaded ONLY where a distribution is actually
// used (the Overview), why it is capped, and why a failed read degrades that one
// point to absent rather than failing the page.
//
// WHY A FAILED PERIOD IS DROPPED RATHER THAN ZEROED
// A period Loop could not read is not a period in which nothing happened. Zeroing
// it would drag every mean down and manufacture an anomaly out of an outage. The
// point is omitted and the series simply reports fewer usable points, which every
// statistic in `callgrid-history.ts` already accounts for.

import { crmRepos } from '../../../../crm/crm-data';
import { loadOrFallback } from '../../../../demo/db-health';
import {
  DEFAULT_HISTORY_PERIODS,
  buildHistoryPeriods,
  historyEntityKey,
  profitCents,
  type CallGridWindow,
  type HistoryPoint,
  type HistorySeries,
} from '@emgloop/shared';
import type { Dimension } from './callgrid-report';

const DIMS: Dimension[] = ['buyers', 'vendors', 'sources', 'campaigns'];

/**
 * Load complete prior periods for a window.
 *
 * Returns an empty series (never a partial or fabricated one) when the window is
 * live or invalid — `buildHistoryPeriods` refuses those, because putting an
 * in-progress period into a distribution is the defect that made "Today" report
 * an -85% collapse every morning.
 */
export async function loadCallGridHistory(
  organizationId: string,
  window: CallGridWindow,
  periods: number = DEFAULT_HISTORY_PERIODS,
): Promise<HistorySeries> {
  const wanted = buildHistoryPeriods(window, periods);
  if (wanted.length === 0) {
    return {
      points: [],
      // Distinguish "this window shape forbids history" from "we looked and found none".
      suppressedForLiveWindow: window.includesLiveData || !window.isCompleted,
    };
  }

  const results = await Promise.all(
    wanted.map(async (period) => {
      const r = await loadOrFallback(async () =>
        crmRepos.marketplaceCalls.aggregateWindow(organizationId, period.start, period.end),
      );
      if (!r.ok || !r.data) return null;
      const agg = r.data;

      const entityRevenueCents: Record<string, number | null> = {};
      const entityCalls: Record<string, number> = {};
      const entityLabels: Record<string, string> = {};

      for (const dim of DIMS) {
        for (const row of agg[dim]) {
          const key = historyEntityKey(dim, row.key);
          // Coverage decides knowledge here exactly as it does in the canonical
          // report: an entity nobody priced has UNKNOWN revenue, not zero.
          entityRevenueCents[key] = row.callsWithRevenue > 0 ? row.revenueCents : null;
          entityCalls[key] = row.calls;
          entityLabels[key] = row.label;
        }
      }

      const noCalls = agg.calls === 0;
      const revKnown = agg.callsWithRevenue > 0;
      const revenueCents = noCalls ? 0 : revKnown ? agg.revenueCents : null;

      const point: HistoryPoint = {
        period,
        totalCalls: agg.calls,
        billableCalls: agg.monetized,
        revenueCents,
        profitCents: noCalls ? 0 : profitCents(revenueCents, agg.payoutCents, agg.costCents),
        entityRevenueCents,
        entityCalls,
        entityLabels,
      };
      return point;
    }),
  );

  return {
    points: results.filter((p): p is HistoryPoint => p !== null),
    suppressedForLiveWindow: false,
  };
}

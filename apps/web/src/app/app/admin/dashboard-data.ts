import 'server-only';

// Dashboard (command center) data — audited for honesty.
//
// The CRM is NOT wired here. The `Customer` table is shared by demo seeds AND
// CallGrid call ingestion, so any count off it would leak callers into a "CRM"
// number. The CRM tile is a static "Not Configured".
//
// CallGrid scorecard: real economics per day from the MarketplaceCall
// projection (aggregateWindow). A value is shown ONLY when it can be computed
// from real data; otherwise it is null and the tile prints "Unknown". Money is
// never estimated. Profit = revenue − payout − cost (derived, never stored).

import { prisma } from '@emgloop/database';
import { crmRepos } from '../../../crm/crm-data';
import { loadHome, type HomeData } from './home-data';

const DAY = 24 * 60 * 60 * 1000;

/** A single day's scorecard. Money is cents, or null when it cannot be known. */
export interface ScoreMetrics {
  totalCalls: number;
  billableCalls: number;
  revenueCents: number | null;
  profitCents: number | null;
}

export interface DashboardData {
  home: HomeData;
  callgrid: {
    total: number;
    recent: number;
    yesterday: ScoreMetrics;
    today: ScoreMetrics;
  };
}

// Map a window aggregate to scorecard metrics with honest unknowns.
//   - No calls at all in the window → revenue/profit are a real $0 (nothing
//     happened), not "unknown".
//   - Calls occurred but NONE carried revenue data → revenue/profit are UNKNOWN
//     (we will not invent $0 for missing economics).
function toMetrics(agg: {
  calls: number; monetized: number;
  revenueCents: number; payoutCents: number; costCents: number;
  callsWithRevenue: number;
}): ScoreMetrics {
  const noCalls = agg.calls === 0;
  const revKnown = agg.callsWithRevenue > 0;
  const revenueCents = noCalls ? 0 : revKnown ? agg.revenueCents : null;
  const profitCents = noCalls ? 0 : revKnown ? agg.revenueCents - agg.payoutCents - agg.costCents : null;
  return { totalCalls: agg.calls, billableCalls: agg.monetized, revenueCents, profitCents };
}

export async function loadDashboard(): Promise<DashboardData> {
  const home = await loadHome('assigned');
  const org = home.workspace.organizationId;

  const now = new Date();
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const startYesterday = new Date(startToday.getTime() - DAY);
  const since30 = new Date(now.getTime() - 30 * DAY);

  const [total, recent, aggYesterday, aggToday] = await Promise.all([
    prisma.marketplaceCall.count({ where: { organizationId: org } }),
    prisma.marketplaceCall.count({ where: { organizationId: org, sourceOccurredAt: { gte: since30 } } }),
    crmRepos.marketplaceCalls.aggregateWindow(org, startYesterday, startToday),
    crmRepos.marketplaceCalls.aggregateWindow(org, startToday, now),
  ]);

  return {
    home,
    callgrid: {
      total,
      recent,
      yesterday: toMetrics(aggYesterday),
      today: toMetrics(aggToday),
    },
  };
}

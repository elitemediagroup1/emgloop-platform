import 'server-only';

// Dashboard (command center) data — audited for honesty.
//
// The CRM is NOT wired here (the Customer table is shared with CallGrid call
// ingestion). The CRM tile is a static "Not Configured".
//
// CallGrid scorecard: real economics per BUSINESS DAY. Day boundaries come from
// the one authoritative business timezone (America/New_York) — never server-local
// or UTC calendar days. Yesterday is the previous COMPLETED Eastern day; Today is
// the LIVE, in-progress Eastern day up to now. A metric is a real number, or
// UNKNOWN (calls occurred but carried no economics), or UNAVAILABLE (the read
// failed). Money is never estimated; profit = revenue − payout − cost (derived).

import { prisma } from '@emgloop/database';
import { easternYesterdayWindow, easternTodayWindow } from '@emgloop/shared';
import { crmRepos } from '../../../crm/crm-data';
import { loadHome, type HomeData } from './home-data';

const DAY = 24 * 60 * 60 * 1000;

/** One day's scorecard. `available` is false when the source read failed. */
export interface DayScore {
  available: boolean;
  totalCalls: number | null;
  billableCalls: number | null;
  revenueCents: number | null;
  profitCents: number | null;
}

export interface DashboardData {
  home: HomeData;
  callgrid: {
    total: number;
    recent: number;
    yesterday: DayScore;
    today: DayScore;
  };
}

type Aggregate = {
  calls: number;
  monetized: number;
  revenueCents: number;
  payoutCents: number;
  costCents: number;
  callsWithRevenue: number;
};

export function toScore(agg: Aggregate | null): DayScore {
  if (agg === null) {
    return { available: false, totalCalls: null, billableCalls: null, revenueCents: null, profitCents: null };
  }
  const noCalls = agg.calls === 0;
  const revKnown = agg.callsWithRevenue > 0;
  return {
    available: true,
    totalCalls: agg.calls,
    billableCalls: agg.monetized,
    // No calls → a real $0 (nothing happened). Calls but no economics → UNKNOWN.
    revenueCents: noCalls ? 0 : revKnown ? agg.revenueCents : null,
    profitCents: noCalls ? 0 : revKnown ? agg.revenueCents - agg.payoutCents - agg.costCents : null,
  };
}

// A failed window read must degrade to UNAVAILABLE, never crash the page.
async function safeAgg(fn: () => Promise<Aggregate>): Promise<Aggregate | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export async function loadDashboard(): Promise<DashboardData> {
  const home = await loadHome('assigned');
  const org = home.workspace.organizationId;

  const now = new Date();
  const yWin = easternYesterdayWindow(now);
  const tWin = easternTodayWindow(now);
  const since30 = new Date(now.getTime() - 30 * DAY);

  const [total, recent, aggYesterday, aggToday] = await Promise.all([
    prisma.marketplaceCall.count({ where: { organizationId: org } }),
    prisma.marketplaceCall.count({ where: { organizationId: org, sourceOccurredAt: { gte: since30 } } }),
    safeAgg(() => crmRepos.marketplaceCalls.aggregateWindow(org, yWin.start, yWin.end)),
    safeAgg(() => crmRepos.marketplaceCalls.aggregateWindow(org, tWin.start, tWin.end)),
  ]);

  return {
    home,
    callgrid: {
      total,
      recent,
      yesterday: toScore(aggYesterday),
      today: toScore(aggToday),
    },
  };
}

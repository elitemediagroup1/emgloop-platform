import 'server-only';

// Dashboard (command center) data — audited for honesty.
//
// The CRM is NOT wired here on purpose. The `Customer` table is shared by demo
// seeds AND CallGrid call ingestion (a new caller becomes a nameless `Customer`
// tagged `lead` — ingestion.service.ts), so ANY count off that table would leak
// CallGrid callers into a "CRM" number. The CRM has not been built, so the CRM
// tile is a static "Not Configured" and reads nothing from this loader.
// CallGrid callers belong to CallGrid Intelligence, not the CRM.
//
// CallGrid "connected": the Executive Brain's instrumentedSensors is a constant
// (the marketplace sensor is always instrumented) and is NOT a connectivity
// signal. The honest signal is whether call rows actually exist — marketplaceCall
// counts, all-time and in the last 30 days.

import { prisma } from '@emgloop/database';
import { loadHome, type HomeData } from './home-data';

const DAY = 24 * 60 * 60 * 1000;

export interface DashboardData {
  home: HomeData;
  callgrid: { total: number; recent: number };
}

export async function loadDashboard(): Promise<DashboardData> {
  const home = await loadHome('assigned');
  const org = home.workspace.organizationId;
  const since30 = new Date(Date.now() - 30 * DAY);

  const [total, recent] = await Promise.all([
    // The truthful "is CallGrid sending data" signal: real call rows.
    prisma.marketplaceCall.count({ where: { organizationId: org } }),
    prisma.marketplaceCall.count({ where: { organizationId: org, sourceOccurredAt: { gte: since30 } } }),
  ]);

  return { home, callgrid: { total, recent } };
}

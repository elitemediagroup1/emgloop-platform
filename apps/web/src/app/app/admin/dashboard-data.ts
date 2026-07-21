import 'server-only';

// Dashboard (command center) data — audited for honesty.
//
// Every figure here is a real, organization-scoped fact, chosen so a tile can
// never misrepresent business reality:
//
//   - CRM "contacts" vs "call leads": inbound CallGrid callers are ingested as
//     nameless Customer rows tagged `lead` (ingestion.service.ts). Counting all
//     Customers and calling them "customers" would present caller IDs as CRM
//     contacts. So we count NAMED contacts (a human added them) separately from
//     call-captured leads, and the tile labels each truthfully.
//
//   - CallGrid "connected": the Executive Brain's instrumentedSensors is a
//     constant (the marketplace sensor is always instrumented) and is NOT a
//     connectivity signal. The honest signal is whether call rows actually
//     exist — marketplaceCall counts, all-time and in the last 30 days.

import { prisma } from '@emgloop/database';
import { loadHome, type HomeData } from './home-data';

const DAY = 24 * 60 * 60 * 1000;

export interface DashboardData {
  home: HomeData;
  crm: { namedContacts: number; callLeads: number };
  callgrid: { total: number; recent: number };
}

export async function loadDashboard(): Promise<DashboardData> {
  const home = await loadHome('assigned');
  const org = home.workspace.organizationId;
  const since30 = new Date(Date.now() - 30 * DAY);

  const [namedContacts, callLeads, total, recent] = await Promise.all([
    // A human-curated CRM contact has a name. Call-captured leads are nameless.
    prisma.customer.count({ where: { organizationId: org, firstName: { not: null } } }),
    // Inbound callers captured from CallGrid are tagged `lead` on creation.
    prisma.customer.count({ where: { organizationId: org, tags: { has: 'lead' } } }),
    // The truthful "is CallGrid sending data" signal: real call rows.
    prisma.marketplaceCall.count({ where: { organizationId: org } }),
    prisma.marketplaceCall.count({ where: { organizationId: org, sourceOccurredAt: { gte: since30 } } }),
  ]);

  return { home, crm: { namedContacts, callLeads }, callgrid: { total, recent } };
}

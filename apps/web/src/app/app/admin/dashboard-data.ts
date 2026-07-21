import 'server-only';

// Dashboard (command center) data.
//
// Gathers ONLY real, organization-scoped facts for the tiles. Nothing here is
// fabricated: a tile with no real data is given an honest "unavailable" state by
// the page, never placeholder content. Creator Hub and Accounting are not
// queried because no such data exists in this platform yet — the page states
// that plainly rather than inventing it.

import { prisma } from '@emgloop/database';
import { loadHome, type HomeData } from './home-data';

export interface DashboardData {
  home: HomeData;
  crm: { customers: number; openConversations: number };
}

export async function loadDashboard(): Promise<DashboardData> {
  // loadHome guards + scopes the session and returns the work + business reads.
  const home = await loadHome('assigned');
  const org = home.workspace.organizationId;

  // The only extra real facts a tile needs: the CRM's own counts.
  const [customers, openConversations] = await Promise.all([
    prisma.customer.count({ where: { organizationId: org } }),
    prisma.conversation.count({ where: { organizationId: org, status: 'OPEN' } }),
  ]);

  return { home, crm: { customers, openConversations } };
}

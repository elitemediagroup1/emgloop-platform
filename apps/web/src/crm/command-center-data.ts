import type { Repositories } from '@emgloop/database';

// Command Center reads.
//
// The caller resolves access from the signed session and passes it in; this
// function only honours it. A read the user is not permitted is never issued —
// not issued and then left unrendered — so audit data cannot reach a user
// without audit:view by any path through this page.

export type CommandCenterRepos = Pick<
  Repositories,
  'organizations' | 'customers' | 'crm' | 'conversationsInbox' | 'audit'
>;

export interface CommandCenterAccess {
  canViewAudit: boolean;
}

function weekStart(now: Date): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function loadCommandCenter(
  repos: CommandCenterRepos,
  organizationId: string,
  access: CommandCenterAccess,
  now: Date = new Date(),
) {
  const [org, customerCount, statusCounts, weekCounts, conversationCounts, recentActivity, recentAudit] =
    await Promise.all([
      repos.organizations.findById(organizationId),
      repos.customers.countByOrganization(organizationId),
      repos.crm.statusCounts(organizationId),
      repos.crm.windowCounts(organizationId, weekStart(now), now),
      repos.conversationsInbox.listConversations(organizationId, {}),
      repos.crm.inboxFeed(organizationId, 8),
      access.canViewAudit ? repos.audit.list(organizationId, { take: 10 }) : Promise.resolve(null),
    ]);
  return { org, customerCount, statusCounts, weekCounts, conversationCounts, recentActivity, recentAudit };
}

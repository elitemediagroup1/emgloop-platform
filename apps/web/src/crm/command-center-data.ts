import type { Repositories } from '@emgloop/database';
import { startOfZonedDay } from '@emgloop/shared';

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

/** The reader's clock: the canonical instant, and the zone their "this week" is counted in. */
export interface CommandCenterClock {
  now: Date;
  timeZone: string;
}

// "This week" is the last seven calendar days where the reader is: from the
// start of their day seven days ago, until now. (It used to be seven days back
// at the server's midnight, which in production is UTC midnight.)
function weekStart({ now, timeZone }: CommandCenterClock): Date {
  return startOfZonedDay(new Date(now.getTime() - 7 * 86_400_000), timeZone);
}

export async function loadCommandCenter(
  repos: CommandCenterRepos,
  organizationId: string,
  access: CommandCenterAccess,
  clock: CommandCenterClock,
) {
  const { now } = clock;
  const [org, customerCount, statusCounts, weekCounts, conversationCounts, recentActivity, recentAudit] =
    await Promise.all([
      repos.organizations.findById(organizationId),
      repos.customers.countByOrganization(organizationId),
      repos.crm.statusCounts(organizationId),
      repos.crm.windowCounts(organizationId, weekStart(clock), now),
      repos.conversationsInbox.listConversations(organizationId, {}),
      repos.crm.inboxFeed(organizationId, 8),
      access.canViewAudit ? repos.audit.list(organizationId, { take: 10 }) : Promise.resolve(null),
    ]);
  return { org, customerCount, statusCounts, weekCounts, conversationCounts, recentActivity, recentAudit };
}

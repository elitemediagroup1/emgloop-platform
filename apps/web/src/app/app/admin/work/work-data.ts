// PR #75 — Work OS Blueprint Runtime v1
// Server-only data helpers for the admin Work OS surface.
//
// Auth + scoping: every helper runs behind requireWorkspace('ADMIN') and is
// scoped to the acting user's organization. The Work OS admin surface serves
// the owner/admin workspace (Matt, Charlie, Jonathan, Mike). A dedicated
// employee-workspace queue (Francesca, Alex, Brian) is a follow-up PR; the
// backend queue methods already support it.

import 'server-only';

import { prisma, createRepositories } from '@emgloop/database';
import { requireWorkspace } from '../../../../workspaces/guard';

export interface WorkActor {
  userId: string;
  organizationId: string;
  name: string;
  email: string;
}

const repos = createRepositories(prisma);

export function workRepo() {
  return repos.work;
}

// Resolve the acting admin user + organization from the workspace session.
export async function requireWorkActor(): Promise<WorkActor> {
  const session = await requireWorkspace('ADMIN');
  return {
    userId: session.userId,
    organizationId: session.organizationId,
    name: session.name,
    email: session.email,
  };
}

// Everything the /app/admin/work dashboard needs, in one round-trip-ish call.
export async function loadWorkDashboard() {
  const actor = await requireWorkActor();
  const work = workRepo();
  const [nextAction, myQueue, unassigned, completedToday, notifications, blueprints] =
    await Promise.all([
      work.getMyNextAction(actor.userId, actor.organizationId),
      work.listMyWork(actor.userId, actor.organizationId),
      work.listUnassignedWork(actor.organizationId),
      work.listCompletedToday(actor.organizationId),
      work.listNotifications(actor.userId, actor.organizationId),
      work.listBlueprints(actor.organizationId),
    ]);
  return { actor, nextAction, myQueue, unassigned, completedToday, notifications, blueprints };
}

// Directory of people who can own a stage, for owner selectors.
export async function listAssignableUsers(organizationId: string) {
  return prisma.user.findMany({
    where: { organizationId, status: { in: ['ACTIVE', 'INVITED'] } },
    select: { id: true, name: true, email: true },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
  });
}

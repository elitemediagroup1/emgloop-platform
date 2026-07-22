// PR #76 — Employee Work Queue
// Server-only data helpers for the employee-facing Work OS surface.
//
// Auth + scoping: every route under /app/employee is already guarded by the
// EMPLOYEE workspace layout (requireWorkspace('EMPLOYEE')). These helpers
// additionally re-derive the acting user + organization from that same session
// and scope every read to the acting user's organization. They REUSE the
// WorkRepository runtime shipped in PR #75 — no new workflow engine, no Brain,
// no LLM, no schema changes. Employees only ever see real work assigned to
// them; nothing is fabricated.

import 'server-only';

import { prisma, createRepositories } from '@emgloop/database';
import type { WorkInstance, WorkStage } from '@emgloop/database';
import { startOfEasternDay } from '@emgloop/shared';

import { requireWorkspace } from '../../../../workspaces/guard';

export interface EmployeeActor {
  userId: string;
  organizationId: string;
  name: string;
  email: string;
}

const repos = createRepositories(prisma);

export function workRepo() {
  return repos.work;
}

// Resolve the acting employee user + organization from the workspace session.
export async function requireEmployeeActor(): Promise<EmployeeActor> {
  const session = await requireWorkspace('EMPLOYEE');
  return {
    userId: session.userId,
    organizationId: session.organizationId,
    name: session.name,
    email: session.email,
  };
}

// Instances the employee is involved in but is NOT currently able to act on:
// they own a later stage that is not yet ready, or the current stage belongs to
// someone else. Derived from their own queue — never shows other people's work.
function isWaiting(
  instance: WorkInstance & { stages: WorkStage[] },
  userId: string,
): boolean {
  const current = instance.stages.find((s) => s.id === instance.currentStageId);
  const ownsCurrent = current ? current.ownerUserId === userId : false;
  const ownsAnyStage = instance.stages.some((s) => s.ownerUserId === userId);
  return ownsAnyStage && !ownsCurrent;
}

// Everything the /app/employee/work homepage needs, scoped to the employee.
export async function loadEmployeeWork() {
  const actor = await requireEmployeeActor();
  const work = workRepo();

  const [nextAction, myQueueRaw, completedToday, notifications] = await Promise.all([
    work.getMyNextAction(actor.userId, actor.organizationId),
    work.listMyWork(actor.userId, actor.organizationId),
    listMyCompletedToday(actor.userId, actor.organizationId),
    work.listNotifications(actor.userId, actor.organizationId),
  ]);

  // Split the employee's active instances into "act now" vs "waiting on others".
  const waiting = myQueueRaw.filter((w) => isWaiting(w, actor.userId));
  const waitingIds = new Set(waiting.map((w) => w.id));
  const myQueue = myQueueRaw.filter((w) => !waitingIds.has(w.id));

  return { actor, nextAction, myQueue, waiting, completedToday, notifications };
}

// Work instances where THIS employee completed a stage today. Scoped to the
// acting user + organization; used for the "Completed today" panel so employees
// only see their own finished work, not the whole org's.
export async function listMyCompletedToday(
  userId: string,
  organizationId: string,
): Promise<(WorkInstance & { stages: WorkStage[] })[]> {
  const start = startOfEasternDay(new Date());
  const stages = await prisma.workStage.findMany({
    where: {
      completedByUserId: userId,
      completedAt: { gte: start },
      workInstance: { organizationId },
    },
    include: { workInstance: { include: { stages: { orderBy: { position: 'asc' } } } } },
    orderBy: { completedAt: 'desc' },
  });
  const seen = new Set<string>();
  const out: (WorkInstance & { stages: WorkStage[] })[] = [];
  for (const s of stages) {
    if (!seen.has(s.workInstanceId)) {
      seen.add(s.workInstanceId);
      out.push(s.workInstance as WorkInstance & { stages: WorkStage[] });
    }
  }
  return out;
}

// Load a single work instance for the detail page, enforcing organization
// isolation. Returns null when the instance is missing or belongs to another
// organization (the page renders notFound in that case).
export async function loadEmployeeInstance(id: string, organizationId: string) {
  const work = workRepo();
  const instance = await work.getWorkInstance(id);
  if (!instance || instance.organizationId !== organizationId) return null;
  return instance;
}

// Directory of people who can own a stage, for the next-owner selector.
export async function listAssignableUsers(organizationId: string) {
  return prisma.user.findMany({
    where: { organizationId, status: { in: ['ACTIVE', 'INVITED'] } },
    select: { id: true, name: true, email: true },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
  });
}


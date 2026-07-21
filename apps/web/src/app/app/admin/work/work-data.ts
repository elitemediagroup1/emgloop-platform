// Sprint 30 — Executive Workspace: My Work becomes the operational center.
//
// Server-only data helpers for the admin Work OS surface.
//
// Auth + scoping: every helper runs behind requireWorkspace('ADMIN') and is
// scoped to the acting user's organization. The Work OS admin surface serves
// the owner/admin workspace.
//
// Sprint 30 reshapes the dashboard into the order an owner triages in:
//
//   1. Needs an owner   — nobody is going to do it. The owner's call.
//   2. Blocked          — mine, but gated behind someone else's step.
//   3. Assigned to me   — ready first, then longest-waiting first.
//   4. Completed today  — the record of what moved.
//
// WHAT IS ABSENT AND WHY (see also workspace-home-data.ts):
//
//   There is no "Overdue" bucket because there is no due date: WorkInstance and
//   WorkStage carry no deadline field. Age ("waiting 6d", from
//   WorkStage.startedAt) is the honest substitute and is labelled as age, never
//   as lateness.
//
//   There is no "Awaiting approval" bucket because approval does not exist at
//   runtime. BlueprintStage.requiresApproval is a template flag that
//   createWorkFromBlueprint never copies onto the WorkStage, and the
//   'approval_needed' notification type is declared but never emitted. Showing
//   the bucket would be fabricated functionality.

import 'server-only';

import { prisma, createRepositories } from '@emgloop/database';
import { startOfEasternDay } from '@emgloop/shared';
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

/** Bare age ("6d", "3h") — the caller supplies the framing word. */
export function age(from: Date, now: Date): string {
  const m = Math.round((now.getTime() - from.getTime()) / 60000);
  if (m < 60) return Math.max(m, 1) + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  return Math.round(h / 24) + 'd';
}

export interface QueueRow {
  workInstanceId: string;
  workStageId: string;
  title: string;
  stageName: string;
  /** The real rule that put this row here, e.g. "ready 3d, no owner". */
  meta: string;
  href: string;
}

export interface WorkDashboard {
  actor: WorkActor;
  nextAction: { workInstanceId: string; title: string; stageName: string; href: string } | null;
  needsOwner: QueueRow[];
  blocked: QueueRow[];
  assigned: QueueRow[];
  completedToday: QueueRow[];
  notifications: {
    id: string; title: string; body: string; readAt: Date | null; createdAt: Date;
  }[];
  unreadCount: number;
  hasBlueprints: boolean;
}

// Everything the /app/admin/work dashboard needs, in one round-trip-ish call.
export async function loadWorkDashboard(): Promise<WorkDashboard> {
  const actor = await requireWorkActor();
  const work = workRepo();
  const now = new Date();
  // "Today" is the Eastern business day, not the server's local day.
  const startOfDay = startOfEasternDay(now);

  const [nextAction, myQueue, unassigned, notifications, blueprints, blockedStages, completedStages] =
    await Promise.all([
      work.getMyNextAction(actor.userId, actor.organizationId),
      work.listMyWork(actor.userId, actor.organizationId),
      work.listUnassignedWork(actor.organizationId),
      work.listNotifications(actor.userId, actor.organizationId),
      work.listBlueprints(actor.organizationId),
      // Mine, but gated behind an earlier step.
      prisma.workStage.findMany({
        where: {
          ownerUserId: actor.userId,
          status: 'pending',
          workInstance: { organizationId: actor.organizationId, status: 'active' },
        },
        select: {
          id: true, name: true, createdAt: true, workInstanceId: true,
          workInstance: { select: { title: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
      }),
      // Stages anyone finished today, org-wide: the owner wants the team's
      // output, not only their own.
      prisma.workStage.findMany({
        where: {
          status: 'completed',
          completedAt: { gte: startOfDay },
          workInstance: { organizationId: actor.organizationId },
        },
        select: {
          id: true, name: true, completedAt: true, workInstanceId: true,
          workInstance: { select: { title: true } },
        },
        orderBy: { completedAt: 'desc' },
        take: 20,
      }),
    ]);

  const needsOwner: QueueRow[] = unassigned.map((s) => {
    const since = new Date(s.startedAt ?? s.workInstance.createdAt);
    return {
      workInstanceId: s.workInstanceId,
      workStageId: s.id,
      title: s.workInstance.title,
      stageName: s.name,
      meta: 'Ready ' + age(since, now) + ', no owner',
      href: '/app/admin/work/' + s.workInstanceId,
    };
  });

  const blocked: QueueRow[] = blockedStages.map((s) => ({
    workInstanceId: s.workInstanceId,
    workStageId: s.id,
    title: s.workInstance.title,
    stageName: s.name,
    meta: 'Waiting on an earlier step',
    href: '/app/admin/work/' + s.workInstanceId,
  }));

  // Ready before in-progress, then longest-waiting first. Age is the only
  // ranking signal the schema supports — there are no priorities or due dates.
  const assignedRaw = myQueue
    .map((inst) => {
      const stage = inst.stages.find(
        (s) => s.ownerUserId === actor.userId && (s.status === 'ready' || s.status === 'in_progress'),
      );
      if (!stage) return null;
      const since = new Date(stage.startedAt ?? inst.createdAt);
      return {
        since: since.getTime(),
        ready: stage.status === 'ready',
        row: {
          workInstanceId: inst.id,
          workStageId: stage.id,
          title: inst.title,
          stageName: stage.name,
          meta: (stage.status === 'ready' ? 'Ready · waiting ' : 'In progress · started ') + age(since, now),
          href: '/app/admin/work/' + inst.id,
        } satisfies QueueRow,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  assignedRaw.sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    return a.since - b.since;
  });
  const assigned = assignedRaw.map((a) => a.row);

  const completedToday: QueueRow[] = completedStages.map((s) => ({
    workInstanceId: s.workInstanceId,
    workStageId: s.id,
    title: s.workInstance.title,
    stageName: s.name,
    meta: s.completedAt ? 'Completed ' + age(new Date(s.completedAt), now) + ' ago' : 'Completed today',
    href: '/app/admin/work/' + s.workInstanceId,
  }));

  return {
    actor,
    nextAction: nextAction
      ? {
          workInstanceId: nextAction.instance.id,
          title: nextAction.instance.title,
          stageName: nextAction.stage.name,
          href: '/app/admin/work/' + nextAction.instance.id,
        }
      : null,
    needsOwner,
    blocked,
    assigned,
    completedToday,
    notifications: notifications.map((n) => ({
      id: n.id, title: n.title, body: n.body, readAt: n.readAt, createdAt: n.createdAt,
    })),
    unreadCount: notifications.filter((n) => !n.readAt).length,
    hasBlueprints: blueprints.length > 0,
  };
}

// Directory of people who can own a stage, for owner selectors.
export async function listAssignableUsers(organizationId: string) {
  return prisma.user.findMany({
    where: { organizationId, status: { in: ['ACTIVE', 'INVITED'] } },
    select: { id: true, name: true, email: true },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
  });
}

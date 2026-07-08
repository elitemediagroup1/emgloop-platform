// PR #75 — Work OS Blueprint Runtime v1
// ---------------------------------------------------------------------------
// The concrete execution runtime for Loop Work OS.
//
//   Blueprint      = reusable process template
//   WorkInstance   = a real execution of a Blueprint
//   WorkStage      = one step of a real execution
//   WorkNotification = tells the next owner it is their turn (in-app only)
//   WorkComment    = discussion on a work instance
//
// This makes the execution loop real:
//   create work -> assign owner -> complete stage -> assign/notify next owner
//   -> next owner sees it in their queue.
//
// NOTE: authorization is enforced at the server-action / route layer
// (requireWorkspace('ADMIN') + requirePermission). This repository is the
// persistence + runtime-rules layer and assumes the caller is already
// authorized and organization-scoped.
// ---------------------------------------------------------------------------

import type {
  Prisma,
  PrismaClient,
  Blueprint,
  BlueprintStage,
  WorkInstance,
  WorkStage,
  WorkNotification,
  WorkComment,
} from '@prisma/client';

// --- Vocabulary (kept as string unions to match the spec's lowercase values) ---
export const BLUEPRINT_STATUSES = ['active', 'archived'] as const;
export type BlueprintStatus = (typeof BLUEPRINT_STATUSES)[number];

export const WORK_INSTANCE_STATUSES = ['active', 'completed', 'cancelled'] as const;
export type WorkInstanceStatus = (typeof WORK_INSTANCE_STATUSES)[number];

export const WORK_STAGE_STATUSES = [
  'pending',
  'ready',
  'in_progress',
  'completed',
  'skipped',
] as const;
export type WorkStageStatus = (typeof WORK_STAGE_STATUSES)[number];

export const WORK_NOTIFICATION_TYPES = [
  'next_action_ready',
  'assigned',
  'completed',
  'approval_needed',
] as const;
export type WorkNotificationType = (typeof WORK_NOTIFICATION_TYPES)[number];

// --- Input types ------------------------------------------------------------
export interface CreateBlueprintInput {
  organizationId: string;
  name: string;
  description?: string | null;
  createdByUserId: string;
  metadata?: Record<string, unknown>;
}

export interface CreateBlueprintStageInput {
  blueprintId: string;
  name: string;
  description?: string | null;
  position: number;
  defaultOwnerUserId?: string | null;
  requiresApproval?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CreateWorkFromBlueprintInput {
  organizationId: string;
  blueprintId: string;
  title: string;
  description?: string | null;
  createdByUserId: string;
  // Explicit owner for the first stage when the blueprint's first stage has no
  // default owner. Ignored when the first stage already has a default owner.
  firstOwnerUserId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CompleteCurrentStageInput {
  workInstanceId: string;
  completedByUserId: string;
  // Optional owner for the NEXT stage. If missing and the next stage has no
  // copied default owner, the next stage becomes ready but unassigned.
  nextOwnerUserId?: string | null;
}

export interface AssignStageInput {
  workStageId: string;
  userId: string | null;
  assignedByUserId?: string | null;
}

export interface AddWorkCommentInput {
  workInstanceId: string;
  workStageId?: string | null;
  userId: string;
  body: string;
}

// A work instance with its stages ordered by position.
export type WorkInstanceWithStages = WorkInstance & { stages: WorkStage[] };

export class WorkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ------------------------------------------------------------------
  // Blueprints
  // ------------------------------------------------------------------
  async createBlueprint(input: CreateBlueprintInput): Promise<Blueprint> {
    return this.prisma.blueprint.create({
      data: {
        organizationId: input.organizationId,
        name: input.name,
        description: input.description ?? null,
        status: 'active',
        createdByUserId: input.createdByUserId,
        ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async createBlueprintStage(input: CreateBlueprintStageInput): Promise<BlueprintStage> {
    return this.prisma.blueprintStage.create({
      data: {
        blueprintId: input.blueprintId,
        name: input.name,
        description: input.description ?? null,
        position: input.position,
        defaultOwnerUserId: input.defaultOwnerUserId ?? null,
        requiresApproval: input.requiresApproval ?? false,
        ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async listBlueprints(organizationId: string): Promise<(Blueprint & { stages: BlueprintStage[] })[]> {
    return this.prisma.blueprint.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
  }

  // ------------------------------------------------------------------
  // Runtime: create a real WorkInstance from a Blueprint
  // ------------------------------------------------------------------
  async createWorkFromBlueprint(
    input: CreateWorkFromBlueprintInput,
  ): Promise<WorkInstanceWithStages> {
    const blueprint = await this.prisma.blueprint.findUnique({
      where: { id: input.blueprintId },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
    if (!blueprint) {
      throw new Error(`Blueprint not found: ${input.blueprintId}`);
    }
    if (blueprint.organizationId !== input.organizationId) {
      throw new Error('Blueprint belongs to a different organization');
    }
    if (blueprint.stages.length === 0) {
      throw new Error('Blueprint has no stages; add at least one stage first');
    }

    return this.prisma.$transaction(async (tx) => {
      // (1) Create the work instance shell.
      const instance = await tx.workInstance.create({
        data: {
          organizationId: input.organizationId,
          blueprintId: blueprint.id,
          title: input.title,
          description: input.description ?? null,
          status: 'active',
          createdByUserId: input.createdByUserId,
          ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
        },
      });

      // (1) Copy BlueprintStages into WorkStages.
      // (2) First stage status = ready. (3) Others = pending.
      // (5) First owner = first stage default owner if set, else explicit owner.
      const createdStages: WorkStage[] = [];
      for (const [i, bs] of blueprint.stages.entries()) {
        const isFirst = i === 0;
        const owner = isFirst
          ? bs.defaultOwnerUserId ?? input.firstOwnerUserId ?? null
          : bs.defaultOwnerUserId ?? null;
        const stage = await tx.workStage.create({
          data: {
            workInstanceId: instance.id,
            blueprintStageId: bs.id,
            name: bs.name,
            description: bs.description,
            position: bs.position,
            status: isFirst ? 'ready' : 'pending',
            ownerUserId: owner,
            startedAt: isFirst ? new Date() : null,
          },
        });
        createdStages.push(stage);
        if (isFirst && owner) {
          await this.recordAssignment(tx, instance.id, stage.id, owner, input.createdByUserId);
        }
      }

      const firstStage = createdStages[0];
      if (!firstStage) {
        throw new Error('Failed to create the first work stage');
      }

      // (4) currentStageId = first WorkStage id.
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: { currentStageId: firstStage.id },
        include: { stages: { orderBy: { position: 'asc' } } },
      });

      // (6) Notify the first owner if one exists.
      if (firstStage.ownerUserId) {
        await tx.workNotification.create({
          data: {
            organizationId: input.organizationId,
            userId: firstStage.ownerUserId,
            workInstanceId: instance.id,
            workStageId: firstStage.id,
            type: 'next_action_ready',
            title: 'Your next action is ready',
            body: `${updated.title}: ${firstStage.name}`,
          },
        });
      }

      return updated;
    });
  }

  // ------------------------------------------------------------------
  // Runtime: complete the current stage and advance the instance
  // ------------------------------------------------------------------
  async completeCurrentStage(
    input: CompleteCurrentStageInput,
  ): Promise<WorkInstanceWithStages> {
    return this.prisma.$transaction(async (tx) => {
      const instance = await tx.workInstance.findUnique({
        where: { id: input.workInstanceId },
        include: { stages: { orderBy: { position: 'asc' } } },
      });
      if (!instance) {
        throw new Error(`Work instance not found: ${input.workInstanceId}`);
      }
      if (instance.status !== 'active') {
        throw new Error(`Work instance is not active (status: ${instance.status})`);
      }

      const current =
        instance.stages.find((s) => s.id === instance.currentStageId) ??
        instance.stages.find((s) => s.status === 'ready' || s.status === 'in_progress');
      if (!current) {
        throw new Error('No current stage to complete');
      }

      const now = new Date();

      // (1)(2) Mark current stage completed with completedAt + completedByUserId.
      await tx.workStage.update({
        where: { id: current.id },
        data: {
          status: 'completed',
          completedAt: now,
          completedByUserId: input.completedByUserId,
        },
      });

      // (3) Find next stage by position.
      const next = instance.stages
        .filter((s) => s.position > current.position && s.status !== 'skipped')
        .sort((a, b) => a.position - b.position)[0];

      // (4) No next stage -> instance completed.
      if (!next) {
        const done = await tx.workInstance.update({
          where: { id: instance.id },
          data: { status: 'completed', completedAt: now, currentStageId: null },
          include: { stages: { orderBy: { position: 'asc' } } },
        });
        return done;
      }

      // (5) Next stage exists -> becomes ready.
      const nextOwner = input.nextOwnerUserId ?? next.ownerUserId ?? null;

      await tx.workStage.update({
        where: { id: next.id },
        data: {
          status: 'ready',
          ownerUserId: nextOwner,
          startedAt: now,
        },
      });

      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: { currentStageId: next.id },
        include: { stages: { orderBy: { position: 'asc' } } },
      });

      // Notify the next owner (only if one exists).
      if (nextOwner) {
        await this.recordAssignment(
          tx,
          instance.id,
          next.id,
          nextOwner,
          input.completedByUserId,
        );
        const actorName = await this.displayName(tx, input.completedByUserId);
        await tx.workNotification.create({
          data: {
            organizationId: instance.organizationId,
            userId: nextOwner,
            workInstanceId: instance.id,
            workStageId: next.id,
            type: 'next_action_ready',
            title: 'Your next action is ready',
            body: `${actorName} completed ${current.name}. Your next step is ${next.name}.`,
          },
        });
      }
      // If nextOwner is null: stage is ready but unassigned. It will show in the
      // admin queue as "Needs owner" (see /app/admin/work).

      return updated;
    });
  }

  // ------------------------------------------------------------------
  // Assignment / reassignment
  // ------------------------------------------------------------------
  async assignStage(input: AssignStageInput): Promise<WorkStage> {
    const stage = await this.prisma.workStage.update({
      where: { id: input.workStageId },
      data: { ownerUserId: input.userId },
    });
    if (input.userId) {
      const instance = await this.prisma.workInstance.findUnique({
        where: { id: stage.workInstanceId },
        select: { organizationId: true, title: true, currentStageId: true },
      });
      if (instance) {
        await this.recordAssignment(
          this.prisma,
          stage.workInstanceId,
          stage.id,
          input.userId,
          input.assignedByUserId ?? null,
        );
        // Only ping the assignee if this is the active/ready stage.
        if (stage.status === 'ready' || stage.status === 'in_progress') {
          await this.prisma.workNotification.create({
            data: {
              organizationId: instance.organizationId,
              userId: input.userId,
              workInstanceId: stage.workInstanceId,
              workStageId: stage.id,
              type: 'assigned',
              title: 'You were assigned a step',
              body: `${instance.title}: ${stage.name}`,
            },
          });
        }
      }
    }
    return stage;
  }

  // ------------------------------------------------------------------
  // Reads for the queue UI
  // ------------------------------------------------------------------
  async getWorkInstance(id: string): Promise<
    | (WorkInstance & {
        stages: WorkStage[];
        comments: WorkComment[];
      })
    | null
  > {
    return this.prisma.workInstance.findUnique({
      where: { id },
      include: {
        stages: { orderBy: { position: 'asc' } },
        comments: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  // Work where the given user currently owns a ready / in-progress stage.
  async listMyWork(userId: string, organizationId: string): Promise<WorkInstanceWithStages[]> {
    const stages = await this.prisma.workStage.findMany({
      where: {
        ownerUserId: userId,
        status: { in: ['ready', 'in_progress'] },
        workInstance: { organizationId, status: 'active' },
      },
      include: { workInstance: { include: { stages: { orderBy: { position: 'asc' } } } } },
      orderBy: { startedAt: 'asc' },
    });
    // De-duplicate by instance.
    const seen = new Set<string>();
    const out: WorkInstanceWithStages[] = [];
    for (const s of stages) {
      if (!seen.has(s.workInstanceId)) {
        seen.add(s.workInstanceId);
        out.push(s.workInstance as WorkInstanceWithStages);
      }
    }
    return out;
  }

  // The single most relevant next action for a user (top of their queue).
  async getMyNextAction(
    userId: string,
    organizationId: string,
  ): Promise<{ stage: WorkStage; instance: WorkInstance } | null> {
    const stage = await this.prisma.workStage.findFirst({
      where: {
        ownerUserId: userId,
        status: 'ready',
        workInstance: { organizationId, status: 'active' },
      },
      include: { workInstance: true },
      orderBy: { startedAt: 'asc' },
    });
    if (!stage) return null;
    return { stage, instance: stage.workInstance };
  }

  // Stages that are ready but have no owner — the admin "Needs owner" queue.
  async listUnassignedWork(organizationId: string): Promise<
    (WorkStage & { workInstance: WorkInstance })[]
  > {
    return this.prisma.workStage.findMany({
      where: {
        ownerUserId: null,
        status: 'ready',
        workInstance: { organizationId, status: 'active' },
      },
      include: { workInstance: true },
      orderBy: { startedAt: 'asc' },
    });
  }

  async listCompletedToday(organizationId: string): Promise<WorkInstance[]> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return this.prisma.workInstance.findMany({
      where: { organizationId, status: 'completed', completedAt: { gte: start } },
      orderBy: { completedAt: 'desc' },
    });
  }

  // ------------------------------------------------------------------
  // Notifications (in-app only)
  // ------------------------------------------------------------------
  async listNotifications(userId: string, organizationId: string): Promise<WorkNotification[]> {
    return this.prisma.workNotification.findMany({
      where: { userId, organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async markNotificationRead(notificationId: string, userId: string): Promise<WorkNotification> {
    // Scope by userId so a user can only mark their own notifications read.
    const existing = await this.prisma.workNotification.findFirst({
      where: { id: notificationId, userId },
    });
    if (!existing) {
      throw new Error('Notification not found');
    }
    return this.prisma.workNotification.update({
      where: { id: notificationId },
      data: { readAt: existing.readAt ?? new Date() },
    });
  }

  // ------------------------------------------------------------------
  // Comments
  // ------------------------------------------------------------------
  async addWorkComment(input: AddWorkCommentInput): Promise<WorkComment> {
    return this.prisma.workComment.create({
      data: {
        workInstanceId: input.workInstanceId,
        workStageId: input.workStageId ?? null,
        userId: input.userId,
        body: input.body,
      },
    });
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  // tx is either the PrismaClient or a transaction client; both share this API.
  private async recordAssignment(
    tx: Prisma.TransactionClient | PrismaClient,
    workInstanceId: string,
    workStageId: string,
    userId: string,
    assignedByUserId: string | null,
  ): Promise<void> {
    await tx.workAssignment.create({
      data: {
        workInstanceId,
        workStageId,
        userId,
        assignedByUserId,
      },
    });
  }

  private async displayName(
    tx: Prisma.TransactionClient | PrismaClient,
    userId: string,
  ): Promise<string> {
    try {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });
      return user?.name ?? user?.email ?? 'Someone';
    } catch {
      return 'Someone';
    }
  }
}

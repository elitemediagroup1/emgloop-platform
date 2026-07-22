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
import { startOfEasternDay } from '@emgloop/shared';
import {
  dedupeActiveMembers,
  resolveStepOwner,
  participantsOf,
  readFieldDefs,
  type StepAssignment,
  type WorkflowStepDef,
  type WorkFieldDef,
} from '../work-os/workflow';

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
  organizationId: string;
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
  organizationId: string;
  workInstanceId: string;
  completedByUserId: string;
  // Optional owner for the NEXT stage. If missing and the next stage has no
  // copied default owner, the next stage becomes ready but unassigned.
  nextOwnerUserId?: string | null;
}

export interface AssignStageInput {
  organizationId: string;
  workStageId: string;
  userId: string | null;
  assignedByUserId?: string | null;
}

export interface AddWorkCommentInput {
  organizationId: string;
  workInstanceId: string;
  workStageId?: string | null;
  userId: string;
  body: string;
}

// A work instance with its stages ordered by position.
export type WorkInstanceWithStages = WorkInstance & { stages: WorkStage[] };

// --- Work Types (a business-facing projection of Blueprint) ------------------

export interface WorkTypeView {
  id: string;
  name: string;
  description: string | null;
  category: string;
  responsibility: string | null;
  defaultPriority: string;
  defaultAssigneeUserId: string | null;
  defaultRequirements: { name: string; required: boolean }[];
  /** Type-specific information fields an admin configured for this Work Type. */
  fields: WorkFieldDef[];
  sortOrder: number;
  active: boolean;
  catalogKey: string | null;
}

export interface CreateWorkTypeInput {
  organizationId: string;
  createdByUserId: string;
  name: string;
  description?: string | null;
  category?: string;
  responsibility?: string | null;
  defaultPriority?: string;
  defaultAssigneeUserId?: string | null;
  defaultRequirements?: { name: string; required: boolean }[];
  sortOrder?: number;
  catalogKey?: string;
}

export interface UpdateWorkTypePatch {
  name?: string;
  description?: string | null;
  category?: string;
  responsibility?: string | null;
  defaultPriority?: string;
  defaultAssigneeUserId?: string | null;
  sortOrder?: number;
  active?: boolean;
}

function metaObject(m: unknown): Record<string, unknown> {
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

function toWorkTypeView(b: {
  id: string;
  name: string;
  description: string | null;
  status: string;
  metadata: unknown;
}): WorkTypeView {
  const m = metaObject(b.metadata);
  const reqs = Array.isArray(m.defaultRequirements)
    ? (m.defaultRequirements as { name?: unknown; required?: unknown }[])
        .map((r) => ({ name: String(r?.name ?? ''), required: Boolean(r?.required) }))
        .filter((r) => r.name.length > 0)
    : [];
  return {
    id: b.id,
    name: b.name,
    description: b.description,
    category: typeof m.category === 'string' ? m.category : 'General',
    responsibility: typeof m.responsibility === 'string' ? m.responsibility : null,
    defaultPriority: typeof m.defaultPriority === 'string' ? m.defaultPriority : 'normal',
    defaultAssigneeUserId: typeof m.defaultAssigneeUserId === 'string' ? m.defaultAssigneeUserId : null,
    defaultRequirements: reqs,
    fields: readFieldDefs(m.customFields),
    sortOrder: typeof m.sortOrder === 'number' ? m.sortOrder : 0,
    active: b.status === 'active',
    catalogKey: typeof m.catalogKey === 'string' ? m.catalogKey : null,
  };
}

// --- Workflow Templates (Blueprint kind='workflow_template') -----------------
// A Workflow Template is a Blueprint whose stages are the ordered step
// definitions; per-step assignment/completion config lives in each stage's
// metadata. metadata.workTypeIds associates it with one or more Work Types.

export interface WorkflowTemplateStepView {
  name: string;
  instruction: string;
  assignment: StepAssignment;
  completionConfirmation: string | null;
  completionNote: 'none' | 'optional' | 'required';
  notifyActive: boolean;
  notifyComplete: boolean;
}

export interface WorkflowTemplateView {
  id: string;
  name: string;
  description: string | null;
  workTypeIds: string[];
  active: boolean;
  stepCount: number;
  updatedAt: string;
  steps: WorkflowTemplateStepView[];
}

export interface CreateWorkflowTemplateInput {
  organizationId: string;
  createdByUserId: string;
  name: string;
  description?: string | null;
  workTypeIds: string[];
  steps: WorkflowStepDef[];
}

export interface CreateWorkItemInput {
  organizationId: string;
  creatorUserId: string;
  workTypeId: string;
  workTypeName: string;
  title: string;
  outcome: string;
  details?: string | null;
  relatedRecord?: { type: string; id: string; label: string } | null;
  customFieldValues?: Record<string, unknown>;
  priority: string;
  targetAtUtc?: string | null;
  targetEastern?: string | null;
  templateId?: string | null;
  templateName?: string | null;
  steps: WorkflowStepDef[];
  responsibilityOwners?: Record<string, string> | null;
  activeMemberIds?: ReadonlySet<string> | null;
}

export interface CompleteWorkStepInput {
  organizationId: string;
  workInstanceId: string;
  stageId: string;
  completedByUserId: string;
  note?: string | null;
  // When set, the step is completed ONLY if it is currently owned by this user.
  // The security invariant lives here, at the data layer, so no caller can
  // complete a step that isn't theirs — a UI-only check is not access control
  // (PR #76). Omit for privileged/system completion.
  expectedOwnerUserId?: string | null;
  responsibilityOwners?: Record<string, string> | null;
  activeMemberIds?: ReadonlySet<string> | null;
}

// Serialize a builder step's assignment/completion config into a stage's metadata
// so the runtime can resolve owners (incl. 'previous'/'responsibility') at handoff.
function stepToStageMeta(s: WorkflowStepDef): Record<string, unknown> {
  return {
    kind: 'workflow_step',
    assignMode: s.assignment.mode,
    specificUserId: s.assignment.specificUserId ?? null,
    responsibilityKey: s.assignment.responsibilityKey ?? null,
    completionConfirmation: s.completionConfirmation ?? null,
    completionNote: s.completionNote,
    notifyActive: s.notifyActive,
    notifyComplete: s.notifyComplete,
  };
}

function stageMetaToStep(m: Record<string, unknown>): {
  assignment: StepAssignment;
  completionConfirmation: string | null;
  completionNote: 'none' | 'optional' | 'required';
  notifyActive: boolean;
  notifyComplete: boolean;
} {
  const mode = typeof m.assignMode === 'string' ? m.assignMode : 'unassigned';
  const note = m.completionNote === 'optional' || m.completionNote === 'required' ? m.completionNote : 'none';
  return {
    assignment: {
      mode: mode as StepAssignment['mode'],
      specificUserId: typeof m.specificUserId === 'string' ? m.specificUserId : null,
      responsibilityKey: typeof m.responsibilityKey === 'string' ? m.responsibilityKey : null,
    },
    completionConfirmation: typeof m.completionConfirmation === 'string' ? m.completionConfirmation : null,
    completionNote: note,
    notifyActive: m.notifyActive !== false,
    notifyComplete: m.notifyComplete === true,
  };
}

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
    // Verify the blueprint belongs to the acting organization before mutating.
    const blueprint = await this.prisma.blueprint.findUnique({
      where: { id: input.blueprintId },
      select: { organizationId: true },
    });
    if (!blueprint || blueprint.organizationId !== input.organizationId) {
      throw new Error(`Blueprint not found: ${input.blueprintId}`);
    }
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
  // Work Types (a business-facing view over Blueprint — no new model)
  //
  // Every Blueprint IS a Work Type. The display fields are Blueprint columns
  // (name/description/status); the extra configuration an admin manages
  // (category, default responsibility/priority/assignee/requirements, sort order,
  // catalog key) rides in Blueprint.metadata. This keeps ONE source of truth and
  // needs no schema change — safe given the deploy applies only `prisma generate`.
  // ------------------------------------------------------------------
  async listWorkTypes(
    organizationId: string,
    opts?: { includeInactive?: boolean },
  ): Promise<WorkTypeView[]> {
    const rows = await this.prisma.blueprint.findMany({
      where: opts?.includeInactive
        ? { organizationId }
        : { organizationId, status: 'active' },
      select: {
        id: true, name: true, description: true, status: true, metadata: true, createdAt: true,
      },
    });
    return rows
      .map((b) => toWorkTypeView(b))
      .sort((a, b) =>
        a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.name.localeCompare(b.name),
      );
  }

  async getWorkType(organizationId: string, id: string): Promise<WorkTypeView | null> {
    const b = await this.prisma.blueprint.findFirst({
      where: { id, organizationId },
      select: { id: true, name: true, description: true, status: true, metadata: true, createdAt: true },
    });
    return b ? toWorkTypeView(b) : null;
  }

  async createWorkType(input: CreateWorkTypeInput): Promise<Blueprint> {
    const meta: Record<string, unknown> = {
      kind: 'work_type',
      category: input.category ?? 'General',
      responsibility: input.responsibility ?? null,
      defaultPriority: input.defaultPriority ?? 'normal',
      defaultAssigneeUserId: input.defaultAssigneeUserId ?? null,
      defaultRequirements: input.defaultRequirements ?? [],
      sortOrder: input.sortOrder ?? 0,
      ...(input.catalogKey ? { catalogKey: input.catalogKey } : {}),
    };
    const blueprint = await this.prisma.blueprint.create({
      data: {
        organizationId: input.organizationId,
        name: input.name,
        description: input.description ?? null,
        status: 'active',
        createdByUserId: input.createdByUserId,
        metadata: meta as Prisma.InputJsonValue,
      },
    });
    // Every Work Type needs at least one stage so work can actually be started
    // from it (createWorkFromBlueprint copies stages). A single "Complete" stage
    // models a one-step task; its default owner is the work type's default assignee.
    await this.prisma.blueprintStage.create({
      data: {
        blueprintId: blueprint.id,
        name: 'Complete',
        position: 1,
        defaultOwnerUserId: input.defaultAssigneeUserId ?? null,
      },
    });
    return blueprint;
  }

  async updateWorkType(
    organizationId: string,
    id: string,
    patch: UpdateWorkTypePatch,
  ): Promise<void> {
    // Resolve within the org first (fail closed to a no-op on cross-org id).
    const existing = await this.prisma.blueprint.findFirst({
      where: { id, organizationId },
      select: { id: true, metadata: true },
    });
    if (!existing) return;
    const meta = metaObject(existing.metadata);
    const nextMeta: Record<string, unknown> = { ...meta };
    if (patch.category !== undefined) nextMeta.category = patch.category;
    if (patch.responsibility !== undefined) nextMeta.responsibility = patch.responsibility;
    if (patch.defaultPriority !== undefined) nextMeta.defaultPriority = patch.defaultPriority;
    if (patch.defaultAssigneeUserId !== undefined) nextMeta.defaultAssigneeUserId = patch.defaultAssigneeUserId;
    if (patch.sortOrder !== undefined) nextMeta.sortOrder = patch.sortOrder;
    await this.prisma.blueprint.update({
      where: { id: existing.id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.active !== undefined ? { status: patch.active ? 'active' : 'archived' } : {}),
        metadata: nextMeta as Prisma.InputJsonValue,
      },
    });
  }

  async setWorkTypeActive(organizationId: string, id: string, active: boolean): Promise<void> {
    await this.prisma.blueprint.updateMany({
      where: { id, organizationId },
      data: { status: active ? 'active' : 'archived' },
    });
  }

  /** Install the starter catalog once. Idempotent: a catalog entry whose key is
   *  already present (in metadata.catalogKey) is skipped, so re-running never
   *  duplicates and never resurrects one an admin deactivated by key match. */
  async installStarterWorkTypes(
    organizationId: string,
    createdByUserId: string,
    catalog: { key: string; name: string; category: string; responsibility: string; defaultPriority: string }[],
  ): Promise<{ created: number; skipped: number }> {
    const existing = await this.prisma.blueprint.findMany({
      where: { organizationId },
      select: { metadata: true },
    });
    const have = new Set(
      existing.map((b) => metaObject(b.metadata).catalogKey).filter((k): k is string => typeof k === 'string'),
    );
    let created = 0;
    let skipped = 0;
    let order = 0;
    for (const entry of catalog) {
      order += 1;
      if (have.has(entry.key)) { skipped += 1; continue; }
      await this.createWorkType({
        organizationId,
        createdByUserId,
        name: entry.name,
        category: entry.category,
        responsibility: entry.responsibility,
        defaultPriority: entry.defaultPriority,
        catalogKey: entry.key,
        sortOrder: order,
      });
      created += 1;
    }
    return { created, skipped };
  }

  /** Active organization members eligible to own work. ACTIVE only — a member who
   *  has not accepted (INVITED), or was disabled/removed (DISABLED), never appears. */
  async listActiveMembers(organizationId: string): Promise<{ id: string; name: string | null; email: string }[]> {
    const rows = await this.prisma.user.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: { id: true, name: true, email: true, status: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
    });
    // Canonical de-duplication (never a name-based filter): collapse by user id
    // and normalized email, and drop anything non-ACTIVE, so a person appears at
    // most once and removed/disabled members never surface. See dedupeActiveMembers.
    return dedupeActiveMembers(rows).map(({ id, name, email }) => ({ id, name, email }));
  }

  // ------------------------------------------------------------------
  // Workflow Templates — reusable ordered step sequences per Work Type
  // ------------------------------------------------------------------
  private toTemplateView(b: Blueprint & { stages: BlueprintStage[] }): WorkflowTemplateView {
    const m = metaObject(b.metadata);
    const workTypeIds = Array.isArray(m.workTypeIds) ? (m.workTypeIds as unknown[]).map(String) : [];
    const steps = [...b.stages]
      .sort((a, s) => a.position - s.position)
      .map((st) => {
        const cfg = stageMetaToStep(metaObject(st.metadata));
        return {
          name: st.name,
          instruction: st.description ?? '',
          assignment: cfg.assignment,
          completionConfirmation: cfg.completionConfirmation,
          completionNote: cfg.completionNote,
          notifyActive: cfg.notifyActive,
          notifyComplete: cfg.notifyComplete,
        };
      });
    return {
      id: b.id,
      name: b.name,
      description: b.description,
      workTypeIds,
      active: b.status === 'active',
      stepCount: steps.length,
      updatedAt: b.updatedAt.toISOString(),
      steps,
    };
  }

  async listWorkflowTemplates(
    organizationId: string,
    opts?: { workTypeId?: string; includeInactive?: boolean },
  ): Promise<WorkflowTemplateView[]> {
    const rows = await this.prisma.blueprint.findMany({
      where: {
        organizationId,
        ...(opts?.includeInactive ? {} : { status: 'active' }),
      },
      include: { stages: true },
    });
    return rows
      .filter((b) => metaObject(b.metadata).kind === 'workflow_template')
      .map((b) => this.toTemplateView(b))
      .filter((t) => !opts?.workTypeId || t.workTypeIds.includes(opts.workTypeId))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getWorkflowTemplate(organizationId: string, id: string): Promise<WorkflowTemplateView | null> {
    const b = await this.prisma.blueprint.findFirst({
      where: { id, organizationId },
      include: { stages: true },
    });
    if (!b || metaObject(b.metadata).kind !== 'workflow_template') return null;
    return this.toTemplateView(b);
  }

  async createWorkflowTemplate(input: CreateWorkflowTemplateInput): Promise<Blueprint> {
    // A template stores ONLY reusable step definitions + assignment modes — never
    // a one-time related record or Work Item notes.
    const blueprint = await this.prisma.blueprint.create({
      data: {
        organizationId: input.organizationId,
        name: input.name,
        description: input.description ?? null,
        status: 'active',
        createdByUserId: input.createdByUserId,
        metadata: { kind: 'workflow_template', workTypeIds: input.workTypeIds } as Prisma.InputJsonValue,
      },
    });
    let position = 1;
    for (const s of input.steps) {
      await this.prisma.blueprintStage.create({
        data: {
          blueprintId: blueprint.id,
          name: s.name,
          description: s.instruction,
          position,
          defaultOwnerUserId: s.assignment.mode === 'specific' ? s.assignment.specificUserId ?? null : null,
          metadata: stepToStageMeta(s) as Prisma.InputJsonValue,
        },
      });
      position += 1;
    }
    return blueprint;
  }

  async updateWorkflowTemplate(
    organizationId: string,
    id: string,
    patch: { name?: string; description?: string | null; workTypeIds?: string[]; active?: boolean; steps?: WorkflowStepDef[] },
  ): Promise<void> {
    const existing = await this.prisma.blueprint.findFirst({
      where: { id, organizationId },
      select: { id: true, metadata: true },
    });
    if (!existing || metaObject(existing.metadata).kind !== 'workflow_template') return;
    const m = metaObject(existing.metadata);
    await this.prisma.blueprint.update({
      where: { id: existing.id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.active !== undefined ? { status: patch.active ? 'active' : 'archived' } : {}),
        metadata: { ...m, ...(patch.workTypeIds ? { workTypeIds: patch.workTypeIds } : {}) } as Prisma.InputJsonValue,
      },
    });
    if (patch.steps) {
      // Replace the step set wholesale (reorder / edit instructions / assignment).
      await this.prisma.blueprintStage.deleteMany({ where: { blueprintId: existing.id } });
      let position = 1;
      for (const s of patch.steps) {
        await this.prisma.blueprintStage.create({
          data: {
            blueprintId: existing.id,
            name: s.name,
            description: s.instruction,
            position,
            defaultOwnerUserId: s.assignment.mode === 'specific' ? s.assignment.specificUserId ?? null : null,
            metadata: stepToStageMeta(s) as Prisma.InputJsonValue,
          },
        });
        position += 1;
      }
    }
  }

  async setWorkflowTemplateActive(organizationId: string, id: string, active: boolean): Promise<void> {
    await this.prisma.blueprint.updateMany({
      where: { id, organizationId },
      data: { status: active ? 'active' : 'archived' },
    });
  }

  async duplicateWorkflowTemplate(
    organizationId: string,
    createdByUserId: string,
    id: string,
  ): Promise<Blueprint | null> {
    const src = await this.getWorkflowTemplate(organizationId, id);
    if (!src) return null;
    return this.createWorkflowTemplate({
      organizationId,
      createdByUserId,
      name: `${src.name} (copy)`,
      description: src.description,
      workTypeIds: src.workTypeIds,
      steps: src.steps.map((s) => ({
        name: s.name,
        instruction: s.instruction,
        assignment: s.assignment,
        completionConfirmation: s.completionConfirmation,
        completionNote: s.completionNote,
        notifyActive: s.notifyActive,
        notifyComplete: s.notifyComplete,
      })),
    });
  }

  // ------------------------------------------------------------------
  // Runtime: create a Work Item from a step list (template / custom / single)
  // and drive the sequential handoff. Owners resolve by mode; only step 1 is
  // active at creation; each completion activates and resolves exactly the next.
  // ------------------------------------------------------------------
  async createWorkItem(input: CreateWorkItemInput): Promise<WorkInstanceWithStages> {
    if (input.steps.length === 0) throw new Error('A Work Item needs at least one step');
    const activeIds = input.activeMemberIds ?? null;
    const owners = input.responsibilityOwners ?? null;

    return this.prisma.$transaction(async (tx) => {
      const instance = await tx.workInstance.create({
        data: {
          organizationId: input.organizationId,
          blueprintId: input.workTypeId,
          title: input.title,
          description: input.outcome,
          status: 'active',
          createdByUserId: input.creatorUserId,
          metadata: {
            kind: 'work_item',
            workTypeId: input.workTypeId,
            workTypeName: input.workTypeName,
            details: input.details ?? null,
            relatedRecord: input.relatedRecord ?? null,
            customFieldValues: input.customFieldValues ?? {},
            priority: input.priority,
            targetAtUtc: input.targetAtUtc ?? null,
            targetEastern: input.targetEastern ?? null,
            templateId: input.templateId ?? null,
            templateName: input.templateName ?? null,
          } as Prisma.InputJsonValue,
        },
      });

      const created: WorkStage[] = [];
      for (const [i, s] of input.steps.entries()) {
        const isFirst = i === 0;
        // Only the first step resolves an owner at creation; later steps resolve
        // when they become active (esp. 'previous'/'responsibility').
        const owner = isFirst
          ? resolveStepOwner(s.assignment, { creatorUserId: input.creatorUserId, responsibilityOwners: owners, activeMemberIds: activeIds })
          : null;
        const stage = await tx.workStage.create({
          data: {
            workInstanceId: instance.id,
            name: s.name,
            description: s.instruction,
            position: i + 1,
            status: isFirst ? 'ready' : 'pending',
            ownerUserId: owner,
            startedAt: isFirst ? new Date() : null,
            metadata: stepToStageMeta(s) as Prisma.InputJsonValue,
          },
        });
        created.push(stage);
      }

      const first = created[0]!;
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: { currentStageId: first.id },
        include: { stages: { orderBy: { position: 'asc' } } },
      });

      if (first.ownerUserId) {
        await this.recordAssignment(tx, instance.id, first.id, first.ownerUserId, input.creatorUserId);
        if (input.steps[0]!.notifyActive) {
          await tx.workNotification.create({
            data: {
              organizationId: input.organizationId,
              userId: first.ownerUserId,
              workInstanceId: instance.id,
              workStageId: first.id,
              type: 'next_action_ready',
              title: 'Your step is ready',
              body: `${updated.title}: ${first.name}`,
            },
          });
        }
      }
      return updated;
    });
  }

  async completeWorkStep(input: CompleteWorkStepInput): Promise<WorkInstanceWithStages> {
    const activeIds = input.activeMemberIds ?? null;
    const owners = input.responsibilityOwners ?? null;

    return this.prisma.$transaction(async (tx) => {
      const instance = await tx.workInstance.findUnique({
        where: { id: input.workInstanceId },
        include: { stages: { orderBy: { position: 'asc' } } },
      });
      if (!instance || instance.organizationId !== input.organizationId) {
        throw new Error('Work item not found');
      }
      const current = instance.stages.find((s) => s.id === input.stageId);
      if (!current) throw new Error('Step not found');
      if (current.status === 'completed') throw new Error('That step is already complete');
      // Only the assigned owner may complete the step, enforced at the data layer.
      if (input.expectedOwnerUserId != null && current.ownerUserId !== input.expectedOwnerUserId) {
        throw new Error('Only the assigned owner can complete this step');
      }

      const now = new Date();
      await tx.workStage.update({
        where: { id: current.id },
        data: {
          status: 'completed',
          completedAt: now,
          completedByUserId: input.completedByUserId,
          metadata: { ...metaObject(current.metadata), completionNoteText: input.note ?? null } as Prisma.InputJsonValue,
        },
      });

      const next = instance.stages
        .filter((s) => s.position > current.position && s.status !== 'skipped' && s.status !== 'completed')
        .sort((a, b) => a.position - b.position)[0];

      if (!next) {
        const done = await tx.workInstance.update({
          where: { id: instance.id },
          data: { status: 'completed', completedAt: now, currentStageId: null },
          include: { stages: { orderBy: { position: 'asc' } } },
        });
        // Notify every unique participant that the work is complete.
        const owners2 = done.stages.map((s) => s.ownerUserId);
        for (const uid of participantsOf(instance.createdByUserId, owners2)) {
          await tx.workNotification.create({
            data: {
              organizationId: input.organizationId,
              userId: uid,
              workInstanceId: instance.id,
              type: 'completed',
              title: 'Work completed',
              body: `${done.title} is complete.`,
            },
          });
        }
        return done;
      }

      // Resolve the NEXT owner by its stored mode (dynamic for previous/responsibility).
      const cfg = stageMetaToStep(metaObject(next.metadata));
      const nextOwner = resolveStepOwner(cfg.assignment, {
        creatorUserId: instance.createdByUserId,
        previousCompleterUserId: input.completedByUserId,
        responsibilityOwners: owners,
        activeMemberIds: activeIds,
      });
      await tx.workStage.update({
        where: { id: next.id },
        data: { status: 'ready', startedAt: now, ownerUserId: nextOwner },
      });
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: { currentStageId: next.id },
        include: { stages: { orderBy: { position: 'asc' } } },
      });
      if (nextOwner) {
        await this.recordAssignment(tx, instance.id, next.id, nextOwner, input.completedByUserId);
        if (cfg.notifyActive) {
          await tx.workNotification.create({
            data: {
              organizationId: input.organizationId,
              userId: nextOwner,
              workInstanceId: instance.id,
              workStageId: next.id,
              type: 'next_action_ready',
              title: 'Your step is ready',
              body: `${updated.title}: ${next.name}`,
            },
          });
        }
      }
      return updated;
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
      if (instance.organizationId !== input.organizationId) {
        // Cross-organization access attempt: treat as not found.
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
    // Verify the stage belongs to the caller's organization before mutating.
    const existingStage = await this.prisma.workStage.findUnique({
      where: { id: input.workStageId },
      select: { id: true, workInstance: { select: { organizationId: true } } },
    });
    if (
      !existingStage ||
      existingStage.workInstance.organizationId !== input.organizationId
    ) {
      throw new Error(`Work stage not found: ${input.workStageId}`);
    }
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
    // "Today" is the Eastern business day (America/New_York), not server-local.
    const start = startOfEasternDay(new Date());
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
    const instance = await this.prisma.workInstance.findUnique({
      where: { id: input.workInstanceId },
      select: { organizationId: true },
    });
    if (!instance || instance.organizationId !== input.organizationId) {
      throw new Error(`Work instance not found: ${input.workInstanceId}`);
    }
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

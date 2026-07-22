'use server';

// PR #75 — Work OS Blueprint Runtime v1
// Server actions for the admin Work OS surface. Every action re-derives the
// acting user + organization from the workspace session (never trusts the
// client for identity/scope) and revalidates the affected routes.

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { buildWorkSubmission, responsibilityLabel, type WorkSubmissionErrors, type AssignMode } from '@emgloop/database';
import { requireWorkActor, workRepo } from './work-data';

const WORK_ROOT = '/app/admin/work';

export interface StartWorkState {
  errors?: WorkSubmissionErrors;
  formError?: string;
}

// Create a Blueprint (optionally with an initial set of stages described as
// newline-separated names in the "stages" textarea).
export async function createBlueprintAction(formData: FormData): Promise<void> {
  const actor = await requireWorkActor();
  const work = workRepo();

  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  const stagesRaw = String(formData.get('stages') ?? '');

  if (!name) {
    throw new Error('Blueprint name is required');
  }

  const blueprint = await work.createBlueprint({
    organizationId: actor.organizationId,
    name,
    description,
    createdByUserId: actor.userId,
  });

  const stageNames = stagesRaw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  let position = 1;
  for (const stageName of stageNames) {
    await work.createBlueprintStage({
      organizationId: actor.organizationId,
      blueprintId: blueprint.id,
      name: stageName,
      position,
    });
    position += 1;
  }

  revalidatePath(`${WORK_ROOT}/blueprints`);
  redirect(`${WORK_ROOT}/blueprints`);
}

// Create a real WorkInstance from a Blueprint.
export async function createWorkFromBlueprintAction(formData: FormData): Promise<void> {
  const actor = await requireWorkActor();
  const work = workRepo();

  const blueprintId = String(formData.get('blueprintId') ?? '').trim();
  const title = String(formData.get('title') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  const firstOwnerUserId = String(formData.get('firstOwnerUserId') ?? '').trim() || null;

  if (!blueprintId) throw new Error('Please choose a blueprint');
  if (!title) throw new Error('Please enter a title');

  const instance = await work.createWorkFromBlueprint({
    organizationId: actor.organizationId,
    blueprintId,
    title,
    description,
    createdByUserId: actor.userId,
    firstOwnerUserId,
  });

  revalidatePath(WORK_ROOT);
  redirect(`${WORK_ROOT}/${instance.id}`);
}

// Start Work — the rebuilt, multi-section form. Validates with the pure builder,
// resolves the owner, and persists priority / due date / requirements / relation
// on the WorkInstance metadata (no new table). Returns field errors for the form;
// on success it redirects to the new Work Detail page.
export async function createWorkAction(
  _prev: StartWorkState,
  formData: FormData,
): Promise<StartWorkState> {
  const actor = await requireWorkActor();
  const work = workRepo();
  const str = (k: string) => String(formData.get(k) ?? '').trim();

  const workTypeId = str('workTypeId');
  // Resolve the work type within the org (also gives us its default assignee for
  // 'auto' assignment). A missing/cross-org id is a field error, never a crash.
  const workType = workTypeId ? await work.getWorkType(actor.organizationId, workTypeId) : null;

  let requirements: { name: string; description?: string; required?: boolean }[] = [];
  try {
    const raw = String(formData.get('requirements') ?? '[]');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) requirements = parsed;
  } catch {
    requirements = [];
  }

  const built = buildWorkSubmission({
    workTypeId,
    title: str('title'),
    outcome: str('outcome'),
    notes: str('notes'),
    responsibility: str('responsibility') || null,
    assignMode: (str('assignMode') || 'unassigned') as AssignMode,
    assigneeUserId: str('assigneeUserId') || null,
    workTypeDefaultAssigneeUserId: workType?.defaultAssigneeUserId ?? null,
    priority: str('priority') || 'normal',
    dueDate: str('dueDate'),
    dueTime: str('dueTime'),
    relationType: (str('relationType') || 'none') as never,
    relationLabel: str('relationLabel'),
    requirements,
  });

  if (!built.ok) return { errors: built.errors };
  if (!workType) return { errors: { workTypeId: 'Choose a valid work type.' } };

  let instanceId: string | null = null;
  try {
    const instance = await work.createWorkFromBlueprint({
      organizationId: actor.organizationId,
      blueprintId: workTypeId,
      title: built.value.title,
      description: built.value.description,
      createdByUserId: actor.userId,
      firstOwnerUserId: built.value.firstOwnerUserId,
      metadata: {
        // A business-facing snapshot on the work itself — real, persisted context.
        workTypeName: workType.name,
        workTypeCategory: workType.category,
        responsibilityLabel: responsibilityLabel(built.value.metadata.responsibility),
        ...built.value.metadata,
      },
    });
    instanceId = instance.id;
  } catch (err) {
    console.error('[work.start] failed', {
      op: 'createWorkFromBlueprint',
      organizationId: actor.organizationId,
      code: (err as { code?: string } | null)?.code ?? 'unknown',
    });
    return { formError: 'Something went wrong starting this work. Please try again.' };
  }

  revalidatePath(WORK_ROOT);
  redirect(`${WORK_ROOT}/${instanceId}`); // outside try — NEXT_REDIRECT must not be caught
}

// Complete the current stage and advance the instance (assigning + notifying
// the next owner when one is chosen).
export async function completeCurrentStageAction(formData: FormData): Promise<void> {
  const actor = await requireWorkActor();
  const work = workRepo();

  const workInstanceId = String(formData.get('workInstanceId') ?? '').trim();
  const nextOwnerUserId = String(formData.get('nextOwnerUserId') ?? '').trim() || null;

  if (!workInstanceId) throw new Error('Missing work instance');

  await work.completeCurrentStage({
    organizationId: actor.organizationId,
    workInstanceId,
    completedByUserId: actor.userId,
    nextOwnerUserId,
  });

  revalidatePath(WORK_ROOT);
  revalidatePath(`${WORK_ROOT}/${workInstanceId}`);
}

// Reassign / assign a stage owner.
export async function assignStageAction(formData: FormData): Promise<void> {
  const actor = await requireWorkActor();
  const work = workRepo();

  const workStageId = String(formData.get('workStageId') ?? '').trim();
  const workInstanceId = String(formData.get('workInstanceId') ?? '').trim();
  const userId = String(formData.get('userId') ?? '').trim() || null;

  if (!workStageId) throw new Error('Missing stage');

  await work.assignStage({
    organizationId: actor.organizationId,
    workStageId,
    userId,
    assignedByUserId: actor.userId,
  });

  revalidatePath(WORK_ROOT);
  if (workInstanceId) revalidatePath(`${WORK_ROOT}/${workInstanceId}`);
}

// Add a comment to a work instance.
export async function addWorkCommentAction(formData: FormData): Promise<void> {
  const actor = await requireWorkActor();
  const work = workRepo();

  const workInstanceId = String(formData.get('workInstanceId') ?? '').trim();
  const workStageId = String(formData.get('workStageId') ?? '').trim() || null;
  const body = String(formData.get('body') ?? '').trim();

  if (!workInstanceId) throw new Error('Missing work instance');
  if (!body) return;

  await work.addWorkComment({
    organizationId: actor.organizationId,
    workInstanceId,
    workStageId,
    userId: actor.userId,
    body,
  });

  revalidatePath(`${WORK_ROOT}/${workInstanceId}`);
}

// Mark a notification read (scoped to the acting user).
export async function markNotificationReadAction(formData: FormData): Promise<void> {
  const actor = await requireWorkActor();
  const work = workRepo();

  const notificationId = String(formData.get('notificationId') ?? '').trim();
  if (!notificationId) return;

  await work.markNotificationRead(notificationId, actor.userId);
  revalidatePath(WORK_ROOT);
}

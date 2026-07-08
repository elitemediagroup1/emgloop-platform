'use server';

// PR #75 — Work OS Blueprint Runtime v1
// Server actions for the admin Work OS surface. Every action re-derives the
// acting user + organization from the workspace session (never trusts the
// client for identity/scope) and revalidates the affected routes.

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireWorkActor, workRepo } from './work-data';

const WORK_ROOT = '/app/admin/work';

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

  for (let i = 0; i < stageNames.length; i++) {
    await work.createBlueprintStage({
      blueprintId: blueprint.id,
      name: stageNames[i],
      position: i + 1,
    });
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

// Complete the current stage and advance the instance (assigning + notifying
// the next owner when one is chosen).
export async function completeCurrentStageAction(formData: FormData): Promise<void> {
  const actor = await requireWorkActor();
  const work = workRepo();

  const workInstanceId = String(formData.get('workInstanceId') ?? '').trim();
  const nextOwnerUserId = String(formData.get('nextOwnerUserId') ?? '').trim() || null;

  if (!workInstanceId) throw new Error('Missing work instance');

  await work.completeCurrentStage({
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

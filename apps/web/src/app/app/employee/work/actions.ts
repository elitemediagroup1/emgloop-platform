'use server';

// PR #76 — Employee Work Queue
// Server actions for the employee Work OS surface. Every action re-derives the
// acting employee + organization from the EMPLOYEE workspace session (never
// trusts the client for identity/scope) and revalidates the affected routes.
// These REUSE the PR #75 WorkRepository runtime, which enforces organization
// ownership on every mutation. No new engine, no Brain, no external
// notifications.

import { revalidatePath } from 'next/cache';

import { requireEmployeeActor, loadEmployeeInstance, workRepo } from './work-data';

const WORK_ROOT = '/app/employee/work';

// Complete the current stage of a work instance and advance to the next owner.
export async function completeCurrentStageAction(formData: FormData): Promise<void> {
  const actor = await requireEmployeeActor();
  const work = workRepo();

  const workInstanceId = String(formData.get('workInstanceId') ?? '').trim();
  const nextOwnerUserId = String(formData.get('nextOwnerUserId') ?? '').trim() || null;

  if (!workInstanceId) throw new Error('Missing work instance');

  // Server-side ownership check: the UI only shows the Complete control to the
  // current stage's owner, but never trust the client. Re-load the instance
  // (organization-scoped) and confirm the acting employee actually owns the
  // current stage before completing it. Employees can only complete their own
  // stages; anything else is rejected.
  const instance = await loadEmployeeInstance(workInstanceId, actor.organizationId);
  if (!instance) throw new Error('Work instance not found');
  const current = instance.stages.find((s) => s.id === instance.currentStageId) ?? null;
  if (!current || current.ownerUserId !== actor.userId) {
    throw new Error('You can only complete a stage assigned to you');
  }

  await work.completeCurrentStage({
    organizationId: actor.organizationId,
    workInstanceId,
    completedByUserId: actor.userId,
    nextOwnerUserId,
  });

  revalidatePath(WORK_ROOT);
  revalidatePath(`${WORK_ROOT}/${workInstanceId}`);
}

// Set / change the owner of a stage (used by the next-owner selector).
export async function assignStageAction(formData: FormData): Promise<void> {
  const actor = await requireEmployeeActor();
  const work = workRepo();

  const workStageId = String(formData.get('workStageId') ?? '').trim();
  const workInstanceId = String(formData.get('workInstanceId') ?? '').trim();
  const userId = String(formData.get('userId') ?? '').trim() || null;

  if (!workStageId) throw new Error('Missing work stage');

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
  const actor = await requireEmployeeActor();
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

// Mark a notification read (scoped to the acting user by the repository).
export async function markNotificationReadAction(formData: FormData): Promise<void> {
  const actor = await requireEmployeeActor();
  const work = workRepo();

  const notificationId = String(formData.get('notificationId') ?? '').trim();
  if (!notificationId) return;

  await work.markNotificationRead(notificationId, actor.userId);
  revalidatePath(WORK_ROOT);
}

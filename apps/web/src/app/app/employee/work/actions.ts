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

// Complete the current step. Routes through the configurable workflow engine
// (completeWorkStep) so the NEXT owner is resolved from the step's defined
// assignment mode (creator / specific / responsibility / previous-completer /
// unassigned) — the active owner never manually picks the next owner. Ownership
// is enforced at the data layer (expectedOwnerUserId); a required completion
// note is enforced here.
export async function completeCurrentStageAction(formData: FormData): Promise<void> {
  const actor = await requireEmployeeActor();
  const work = workRepo();

  const workInstanceId = String(formData.get('workInstanceId') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();

  if (!workInstanceId) throw new Error('Missing work instance');

  // Re-load the instance (organization-scoped) and confirm the acting employee
  // actually owns the current step before completing it.
  const instance = await loadEmployeeInstance(workInstanceId, actor.organizationId);
  if (!instance) throw new Error('Work instance not found');
  const current = instance.stages.find((s) => s.id === instance.currentStageId) ?? null;
  if (!current || current.ownerUserId !== actor.userId) {
    throw new Error('You can only complete a step assigned to you');
  }

  const cfg = current.metadata && typeof current.metadata === 'object' && !Array.isArray(current.metadata)
    ? (current.metadata as Record<string, unknown>)
    : {};
  if (cfg.completionNote === 'required' && !note) {
    throw new Error('A completion note is required for this step');
  }

  const members = await work.listActiveMembers(actor.organizationId);
  await work.completeWorkStep({
    organizationId: actor.organizationId,
    workInstanceId,
    stageId: current.id,
    completedByUserId: actor.userId,
    note: note || null,
    expectedOwnerUserId: actor.userId,
    responsibilityOwners: null,
    activeMemberIds: new Set(members.map((m) => m.id)),
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

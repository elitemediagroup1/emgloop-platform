'use server';

// PR #75 — Work OS Blueprint Runtime v1
// Server actions for the admin Work OS surface. Every action re-derives the
// acting user + organization from the workspace session (never trusts the
// client for identity/scope) and revalidates the affected routes.

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  buildWorkItemSubmission,
  STEP_ASSIGN_MODES,
  COMPLETION_NOTE_MODES,
  type WorkItemErrors,
  type WorkflowStepDef,
  type StepAssignMode,
  type CompletionNoteMode,
} from '@emgloop/database';
import { requireWorkActor, workRepo } from './work-data';

const WORK_ROOT = '/app/admin/work';

export interface StartWorkState {
  errors?: WorkItemErrors;
  formError?: string;
}

// Coerce one raw JSON step (from the client builder) into a validated shape the
// engine understands. Trusts nothing: unknown modes fall back to 'unassigned',
// unknown note modes to 'none'. Server-side validation (buildWorkItemSubmission)
// still runs afterwards.
function coerceStep(raw: unknown): WorkflowStepDef {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = (STEP_ASSIGN_MODES as readonly string[]).includes(String(r.mode))
    ? (r.mode as StepAssignMode)
    : 'unassigned';
  const note = (COMPLETION_NOTE_MODES as readonly string[]).includes(String(r.completionNote))
    ? (r.completionNote as CompletionNoteMode)
    : 'none';
  return {
    name: typeof r.name === 'string' ? r.name : '',
    instruction: typeof r.instruction === 'string' ? r.instruction : '',
    assignment: {
      mode,
      specificUserId: typeof r.specificUserId === 'string' ? r.specificUserId : null,
      responsibilityKey: typeof r.responsibilityKey === 'string' ? r.responsibilityKey : null,
    },
    completionConfirmation: typeof r.completionConfirmation === 'string' ? r.completionConfirmation : null,
    completionNote: note,
    notifyActive: r.notifyActive !== false,
    notifyComplete: r.notifyComplete === true,
  };
}

function parseJsonArray(raw: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Inline "Add New Type" — create an organization-scoped Work Type without any
// code change. Returns the new type so the client can select it immediately.
export interface AddWorkTypeState {
  ok?: boolean;
  id?: string;
  name?: string;
  error?: string;
}

export async function addWorkTypeAction(
  _prev: AddWorkTypeState,
  formData: FormData,
): Promise<AddWorkTypeState> {
  const actor = await requireWorkActor();
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  if (!name) return { error: 'Give the new type a name.' };

  try {
    const bp = await workRepo().createWorkType({
      organizationId: actor.organizationId,
      createdByUserId: actor.userId,
      name,
      description,
    });
    revalidatePath(`${WORK_ROOT}/new`);
    return { ok: true, id: bp.id, name };
  } catch (err) {
    console.error('[work.addType] failed', {
      organizationId: actor.organizationId,
      code: (err as { code?: string } | null)?.code ?? 'unknown',
    });
    return { error: 'Could not create that type. Please try again.' };
  }
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

// Start Work — the configurable sequential workflow builder. The Work Item is a
// Work Type + an ordered list of Work Steps, each step owning its own assignment
// (specific / responsibility / creator / previous-completer / unassigned). Only
// step 1 activates at creation; the engine drives the handoff. Optionally saves
// the step sequence as a reusable Workflow Template. Returns field errors for the
// form; on success it redirects to the new Work Detail page.
export async function startWorkItemAction(
  _prev: StartWorkState,
  formData: FormData,
): Promise<StartWorkState> {
  const actor = await requireWorkActor();
  const work = workRepo();
  const str = (k: string) => String(formData.get(k) ?? '').trim();

  const workTypeId = str('workTypeId');
  // Resolve the work type within the org (gives us its configured custom fields).
  // A missing/cross-org id is a field error, never a crash.
  const workType = workTypeId ? await work.getWorkType(actor.organizationId, workTypeId) : null;
  if (!workType) return { formError: 'Choose a valid work type to start.' };

  const steps: WorkflowStepDef[] = parseJsonArray(formData.get('steps')).map(coerceStep);
  const fieldValues = parseJsonObject(formData.get('fieldValues'));

  const built = buildWorkItemSubmission({
    title: str('title'),
    outcome: str('outcome'),
    details: str('details'),
    priority: str('priority') || 'normal',
    targetDate: str('targetDate'),
    targetTime: str('targetTime'),
    useTime: str('useTime') === 'on' || str('useTime') === 'true',
    fields: workType.fields,
    fieldValues,
    steps,
  });
  if (!built.ok) return { errors: built.errors };

  // The assignee universe: active, de-duplicated org members. A resolved owner
  // who is not in this set is dropped to "Needs an Owner" (engine, fail closed).
  const members = await work.listActiveMembers(actor.organizationId);
  const activeMemberIds = new Set(members.map((m) => m.id));

  let instanceId: string | null = null;
  try {
    const instance = await work.createWorkItem({
      organizationId: actor.organizationId,
      creatorUserId: actor.userId,
      workTypeId,
      workTypeName: workType.name,
      title: built.value.title,
      outcome: built.value.outcome,
      details: built.value.details,
      relatedRecord: null, // no first-class record source exists to link yet
      customFieldValues: built.value.customFieldValues,
      priority: built.value.priority,
      targetAtUtc: built.value.targetAtUtc,
      targetEastern: built.value.targetEastern,
      steps: built.value.steps,
      // No persisted responsibility→owner map yet: a responsibility step resolves
      // to "Needs an Owner" rather than being fabricated.
      responsibilityOwners: null,
      activeMemberIds,
    });
    instanceId = instance.id;

    // Optionally save the step sequence as a reusable template (never the
    // one-time related record or Work Item notes).
    if (str('saveTemplate') === 'on' || str('saveTemplate') === 'true') {
      const templateName = str('templateName');
      if (templateName) {
        await work.createWorkflowTemplate({
          organizationId: actor.organizationId,
          createdByUserId: actor.userId,
          name: templateName,
          description: str('templateDescription') || null,
          workTypeIds: [workTypeId],
          steps: built.value.steps,
        });
      }
    }
  } catch (err) {
    console.error('[work.start] failed', {
      op: 'createWorkItem',
      organizationId: actor.organizationId,
      code: (err as { code?: string } | null)?.code ?? 'unknown',
    });
    return { formError: 'Something went wrong starting this work. Please try again.' };
  }

  revalidatePath(WORK_ROOT);
  redirect(`${WORK_ROOT}/${instanceId}`); // outside try — NEXT_REDIRECT must not be caught
}

// Complete My Step — the active owner completes their own step; the engine
// resolves and activates exactly the next step by its defined assignment mode
// (no manual "hand off to" — the next owner comes from the sequence). Honors the
// step's configured confirmation + completion-note requirement. Returns a state
// for inline validation; the page stays put and re-renders the advanced work.
export interface CompleteStepState {
  ok?: boolean;
  error?: string;
}

function stageConfig(meta: unknown): { noteMode: CompletionNoteMode; confirmation: string | null } {
  const m = (meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}) as Record<string, unknown>;
  const noteMode = (COMPLETION_NOTE_MODES as readonly string[]).includes(String(m.completionNote))
    ? (m.completionNote as CompletionNoteMode)
    : 'none';
  return { noteMode, confirmation: typeof m.completionConfirmation === 'string' ? m.completionConfirmation : null };
}

export async function completeWorkStepAction(
  _prev: CompleteStepState,
  formData: FormData,
): Promise<CompleteStepState> {
  const actor = await requireWorkActor();
  const work = workRepo();
  const workInstanceId = String(formData.get('workInstanceId') ?? '').trim();
  const stageId = String(formData.get('stageId') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();
  const confirmed = String(formData.get('confirm') ?? '').trim() === 'on';
  if (!workInstanceId || !stageId) return { error: 'Missing step.' };

  const instance = await work.getWorkInstance(workInstanceId);
  if (!instance || instance.organizationId !== actor.organizationId) return { error: 'This work could not be found.' };
  const stage = instance.stages.find((s) => s.id === stageId);
  if (!stage) return { error: 'That step could not be found.' };
  if (stage.status === 'completed') return { error: 'That step is already complete.' };
  if (stage.ownerUserId !== actor.userId) return { error: 'Only the assigned owner can complete this step.' };

  const cfg = stageConfig(stage.metadata);
  if (cfg.confirmation && !confirmed) return { error: 'Please confirm before completing this step.' };
  if (cfg.noteMode === 'required' && !note) return { error: 'A completion note is required for this step.' };

  const members = await work.listActiveMembers(actor.organizationId);
  try {
    await work.completeWorkStep({
      organizationId: actor.organizationId,
      workInstanceId,
      stageId,
      completedByUserId: actor.userId,
      note: note || null,
      expectedOwnerUserId: actor.userId, // data-layer owner enforcement
      responsibilityOwners: null, // no persisted responsibility→owner map yet
      activeMemberIds: new Set(members.map((m) => m.id)),
    });
  } catch (err) {
    console.error('[work.completeStep] failed', {
      organizationId: actor.organizationId,
      code: (err as { code?: string } | null)?.code ?? 'unknown',
    });
    return { error: 'Something went wrong completing this step. Please try again.' };
  }

  revalidatePath(WORK_ROOT);
  revalidatePath(`${WORK_ROOT}/${workInstanceId}`);
  return { ok: true };
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

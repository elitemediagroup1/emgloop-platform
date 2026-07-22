'use server';

// Workflow Templates administration — view / create / edit / duplicate /
// activate / deactivate the org's reusable step sequences. A Workflow Template
// is a Blueprint (kind='workflow_template'); the page speaks only business
// language (no Process Engine / Registry / Runtime / schema terminology). Only
// authorized admins: every action guards on settings:update, and the org ALWAYS
// comes from the signed session, never the form.

import { redirect } from 'next/navigation';
import {
  repositories,
  validateWorkflowSteps,
  STEP_ASSIGN_MODES,
  COMPLETION_NOTE_MODES,
  type WorkflowStepDef,
  type StepAssignMode,
  type CompletionNoteMode,
  type StepDefErrors,
} from '@emgloop/database';
import { requirePermission } from '../../../../../auth/guard';

const PATH = '/app/admin/administration/workflow-templates';

function backTo(message: string, kind: 'notice' | 'error'): string {
  return PATH + '?' + kind + '=' + encodeURIComponent(message);
}

export interface SaveTemplateState {
  errors?: { name?: string; workTypes?: string; steps?: StepDefErrors };
  formError?: string;
}

function coerceStep(raw: unknown): WorkflowStepDef {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = (STEP_ASSIGN_MODES as readonly string[]).includes(String(r.mode)) ? (r.mode as StepAssignMode) : 'unassigned';
  const note = (COMPLETION_NOTE_MODES as readonly string[]).includes(String(r.completionNote)) ? (r.completionNote as CompletionNoteMode) : 'none';
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

function parseArray(raw: unknown): unknown[] {
  try {
    const p = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

// Create or update a template. Returns field errors; on success redirects to the
// list with a notice.
export async function saveTemplateAction(
  _prev: SaveTemplateState,
  formData: FormData,
): Promise<SaveTemplateState> {
  const session = await requirePermission('settings', 'update');
  const id = String(formData.get('id') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  const workTypeIds = parseArray(formData.get('workTypeIds')).map(String).filter(Boolean);
  const steps = parseArray(formData.get('steps')).map(coerceStep);

  const errors: SaveTemplateState['errors'] = {};
  if (!name) errors.name = 'Name this workflow.';
  if (workTypeIds.length === 0) errors.workTypes = 'Associate this workflow with at least one work type.';
  const stepErrors = validateWorkflowSteps(steps);
  if (stepErrors.length > 0) errors.steps = stepErrors;
  if (errors.name || errors.workTypes || errors.steps) return { errors };

  let ok = false;
  try {
    if (id) {
      await repositories.work.updateWorkflowTemplate(session.organizationId, id, {
        name,
        description,
        workTypeIds,
        steps,
      });
    } else {
      await repositories.work.createWorkflowTemplate({
        organizationId: session.organizationId,
        createdByUserId: session.userId,
        name,
        description,
        workTypeIds,
        steps,
      });
    }
    await repositories.audit.record({
      organizationId: session.organizationId,
      userId: session.userId,
      actorName: session.name,
      action: id ? 'workflow_template.updated' : 'workflow_template.created',
      entityType: 'workflow_template',
      entityId: id || name,
      metadata: { steps: steps.length, workTypes: workTypeIds.length },
    });
    ok = true;
  } catch (err) {
    console.error('[workflowTemplate.save] failed', {
      organizationId: session.organizationId,
      code: (err as { code?: string } | null)?.code ?? 'unknown',
    });
    return { formError: 'Could not save this workflow. Please try again.' };
  }

  if (ok) redirect(backTo(`Workflow “${name}” ${id ? 'updated' : 'created'}.`, 'notice'));
  return {};
}

export async function duplicateTemplateAction(formData: FormData): Promise<void> {
  const session = await requirePermission('settings', 'update');
  const id = String(formData.get('id') ?? '').trim();
  if (!id) redirect(backTo('No workflow selected.', 'error'));
  const copy = await repositories.work.duplicateWorkflowTemplate(session.organizationId, session.userId, id);
  if (!copy) redirect(backTo('That workflow could not be found.', 'error'));
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'workflow_template.duplicated',
    entityType: 'workflow_template',
    entityId: id,
  });
  redirect(backTo('Workflow duplicated.', 'notice'));
}

export async function setTemplateActiveAction(formData: FormData): Promise<void> {
  const session = await requirePermission('settings', 'update');
  const id = String(formData.get('id') ?? '').trim();
  const active = String(formData.get('active') ?? '') === 'true';
  if (!id) redirect(backTo('No workflow selected.', 'error'));
  await repositories.work.setWorkflowTemplateActive(session.organizationId, id, active);
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: active ? 'workflow_template.activated' : 'workflow_template.deactivated',
    entityType: 'workflow_template',
    entityId: id,
  });
  redirect(backTo(active ? 'Workflow activated.' : 'Workflow deactivated.', 'notice'));
}

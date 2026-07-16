'use server';

// Workflow server actions — Sprint 9 (Workflows & Automation, CRM Phase 4).
//
// Mutations for the workflow list + builder + manual run. Every action
// enforces a deny-by-default permission check via the guard against the new
// 'workflows' resource, persists through the @emgloop/database repository
// layer, and writes an immutable AuditLog entry. Running a workflow executes
// only internal steps (tags, pipeline status, assignment, notes, conversation
// status, domain events) — no external provider is ever contacted. No mocks,
// no fake data.

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { repositories, WORKFLOW_TRIGGERS, WORKFLOW_STEP_TYPES } from '@emgloop/database';
import type {
  WorkflowTrigger,
  WorkflowStep,
  WorkflowStepType,
  TriggerConfig,
} from '@emgloop/database';
import { requirePermission } from '../auth/guard';
import { workflowBelongsToOrg } from './crm-data';

function parseTrigger(v: unknown): WorkflowTrigger {
  const s = String(v ?? '').trim().toUpperCase();
  return (WORKFLOW_TRIGGERS as string[]).includes(s)
    ? (s as WorkflowTrigger)
    : 'MANUAL';
}

function parseStepType(v: unknown): WorkflowStepType | null {
  const s = String(v ?? '').trim();
  return (WORKFLOW_STEP_TYPES as readonly string[]).includes(s)
    ? (s as WorkflowStepType)
    : null;
}

function refresh(workflowId?: string) {
  revalidatePath('/crm/workflows');
  if (workflowId) revalidatePath('/crm/workflows/' + workflowId);
}

// --- Create / update metadata -----------------------------------------

export async function createWorkflowAction(formData: FormData): Promise<void> {
  const session = await requirePermission('workflows', 'create');
  const organizationId = session.organizationId;
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;
  const description = String(formData.get('description') ?? '').trim() || null;
  const trigger = parseTrigger(formData.get('trigger'));
  const eventName = String(formData.get('eventName') ?? '').trim() || null;
  const schedule = String(formData.get('schedule') ?? '').trim() || null;
  const triggerConfig: TriggerConfig = { eventName, schedule };

  const wf = await repositories.workflows.createWorkflow({
    organizationId,
    name,
    description,
    trigger,
    triggerConfig,
    definition: { steps: [] },
  });
  await repositories.audit.record({
    organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'workflow.created',
    entityType: 'workflow',
    entityId: wf.id,
    metadata: { name, trigger },
  });
  refresh(wf.id);
  redirect('/crm/workflows/' + wf.id);
}

export async function updateWorkflowMetaAction(formData: FormData): Promise<void> {
  const session = await requirePermission('workflows', 'update');
  const id = String(formData.get('workflowId') ?? '').trim();
  if (!id) return;
  // Fail closed: cross-org workflow ids cannot be mutated.
  if (!(await workflowBelongsToOrg(session.organizationId, id))) return;
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  const trigger = parseTrigger(formData.get('trigger'));
  const eventName = String(formData.get('eventName') ?? '').trim() || null;
  const schedule = String(formData.get('schedule') ?? '').trim() || null;
  await repositories.workflows.updateWorkflow(id, {
    name: name || undefined,
    description,
    trigger,
    triggerConfig: { eventName, schedule },
  });
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'workflow.updated',
    entityType: 'workflow',
    entityId: id,
    metadata: { trigger },
  });
  refresh(id);
}

// --- Step graph editing -----------------------------------------------

/** Append a step to the workflow's ordered definition. The config fields
    accepted depend on the step type; only the relevant key is stored. */
export async function addStepAction(formData: FormData): Promise<void> {
  const session = await requirePermission('workflows', 'update');
  const id = String(formData.get('workflowId') ?? '').trim();
  const type = parseStepType(formData.get('type'));
  if (!id || !type) return;
  // Fail closed: cross-org workflow ids cannot be mutated.
  if (!(await workflowBelongsToOrg(session.organizationId, id))) return;

  const config: Record<string, unknown> = {};
  switch (type) {
    case 'add_tag':
      config.tag = String(formData.get('tag') ?? '').trim();
      break;
    case 'set_pipeline_status':
      config.status = String(formData.get('status') ?? '').trim();
      break;
    case 'assign':
      config.humanName = String(formData.get('humanName') ?? '').trim();
      break;
    case 'create_note':
      config.text = String(formData.get('text') ?? '').trim();
      break;
    case 'set_conversation_status':
      config.status = String(formData.get('convStatus') ?? '').trim();
      break;
    case 'emit_event':
      config.eventName = String(formData.get('emitEventName') ?? '').trim();
      break;
    default:
      return;
  }

  const current = await repositories.workflows.getWorkflow(id);
  if (!current) return;
  const nextSteps: WorkflowStep[] = [...current.definition.steps, { type, config }];
  await repositories.workflows.updateWorkflow(id, { definition: { steps: nextSteps } });
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'workflow.step_added',
    entityType: 'workflow',
    entityId: id,
    metadata: { type, position: nextSteps.length },
  });
  refresh(id);
}

export async function removeStepAction(formData: FormData): Promise<void> {
  const session = await requirePermission('workflows', 'update');
  const id = String(formData.get('workflowId') ?? '').trim();
  const indexRaw = String(formData.get('index') ?? '').trim();
  const index = Number.parseInt(indexRaw, 10);
  if (!id || Number.isNaN(index)) return;
  // Fail closed: cross-org workflow ids cannot be mutated.
  if (!(await workflowBelongsToOrg(session.organizationId, id))) return;
  const current = await repositories.workflows.getWorkflow(id);
  if (!current) return;
  const nextSteps = current.definition.steps.filter((_, i) => i !== index);
  await repositories.workflows.updateWorkflow(id, { definition: { steps: nextSteps } });
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'workflow.step_removed',
    entityType: 'workflow',
    entityId: id,
    metadata: { index },
  });
  refresh(id);
}

// --- Activation -------------------------------------------------------

export async function toggleWorkflowActiveAction(formData: FormData): Promise<void> {
  const session = await requirePermission('workflows', 'update');
  const id = String(formData.get('workflowId') ?? '').trim();
  if (!id) return;
  // Fail closed: cross-org workflow ids cannot be mutated.
  if (!(await workflowBelongsToOrg(session.organizationId, id))) return;
  const active = String(formData.get('active') ?? '').trim() === 'true';
  await repositories.workflows.setActive(id, active);
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: active ? 'workflow.activated' : 'workflow.deactivated',
    entityType: 'workflow',
    entityId: id,
    metadata: { active },
  });
  refresh(id);
}

// --- Manual run -------------------------------------------------------

/** Run a workflow once against a chosen customer and/or conversation. The
    engine executes every step through the existing repositories and records
    a WorkflowRun; we audit the manual trigger and its result status. */
export async function runWorkflowAction(formData: FormData): Promise<void> {
  const session = await requirePermission('workflows', 'update');
  const id = String(formData.get('workflowId') ?? '').trim();
  if (!id) return;
  const customerId = String(formData.get('customerId') ?? '').trim() || null;
  const conversationId = String(formData.get('conversationId') ?? '').trim() || null;
  const outcome = await repositories.workflows.runWorkflow({
    organizationId: session.organizationId,
    workflowId: id,
    triggeredBy: 'user:' + session.userId,
    context: { customerId, conversationId },
  });
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'workflow.run',
    entityType: 'workflow',
    entityId: id,
    metadata: {
      runId: outcome.run.id,
      status: outcome.status,
      steps: outcome.stepResults.length,
    },
  });
  refresh(id);
}

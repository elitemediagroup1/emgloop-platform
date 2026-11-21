'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  INTAKE_STATES,
  intakeTemplate,
  readIntakeTemplate,
  type IntakeTemplate,
  type IntakeState,
  type IntakeContent,
} from '@emgloop/shared';
import { requirePermission } from '../auth/guard';
import { qualificationIntakes } from './intake-runtime';

export interface IntakeSaveState {
  errors: string[];
}
function readContent(data: FormData, template: IntakeTemplate): IntakeContent {
  const field = (key: string) => String(data.get(key) ?? '').trim();
  return {
    opportunityId: field('opportunityId') || null,
    title: field('title'),
    relationshipRoles: data.getAll('relationshipRoles').map(String),
    answers: Object.fromEntries(template.fields.map((f) => [f.id, field(`answer_${f.id}`)])),
    sourceNotes: field('sourceNotes'),
    decisionMakerPartyId: field('decisionMakerPartyId') || null,
    unresolvedIssues: field('unresolvedIssues'),
    nextActionOwnerUserId: field('nextActionOwnerUserId') || null,
    nextStep: field('nextStep'),
    dueDate: field('dueDate'),
    checkpoint: field('checkpoint'),
  };
}
function failure(result: { reason: string; errors?: string[] }): IntakeSaveState {
  return {
    errors: result.errors ?? [
      result.reason === 'CONFLICT'
        ? 'This intake changed while you were editing. Reload the saved record before continuing.'
        : 'This intake could not be saved. Check your access and selected CRM records.',
    ],
  };
}
export async function createQualificationIntake(
  _previous: IntakeSaveState,
  data: FormData,
): Promise<IntakeSaveState> {
  const session = await requirePermission('intakes', 'create');
  const template = intakeTemplate(
    String(data.get('templateKey') ?? ''),
    String(data.get('subtype') ?? ''),
  );
  if (!template) return { errors: ['Choose a valid intake template.'] };
  const result = await qualificationIntakes()
    .create(session.organizationId, session.userId, {
      partyId: String(data.get('partyId') ?? ''),
      opportunityId: String(data.get('opportunityId') ?? '') || null,
      templateKey: template.key,
      subtype: template.subtype,
      requestKey: String(data.get('requestKey') ?? ''),
      content: readContent(data, template),
    })
    .catch(() => ({
      ok: false as const,
      reason: 'UNAVAILABLE',
      errors: ['Intake saving is temporarily unavailable. Your entries are still here. Try again.'],
    }));
  if (!result.ok) return failure(result);
  revalidatePath('/app/crm/intakes');
  redirect(`/app/crm/intakes/${encodeURIComponent(result.id)}?saved=1`);
}
export async function reviseQualificationIntake(
  _previous: IntakeSaveState,
  data: FormData,
): Promise<IntakeSaveState> {
  const session = await requirePermission('intakes', 'update');
  const repo = qualificationIntakes(),
    id = String(data.get('intakeId') ?? '');
  const record = await repo.read(session.organizationId, session.userId, id);
  const template = record ? readIntakeTemplate(record.templateSnapshot) : null;
  if (!record || !template) return { errors: ['This intake is unavailable.'] };
  const state = String(data.get('state') ?? '');
  if (!(INTAKE_STATES as readonly string[]).includes(state))
    return { errors: ['Choose a valid review state.'] };
  const result = await repo
    .revise(
      session.organizationId,
      session.userId,
      id,
      Number(data.get('revision')),
      state as IntakeState,
      readContent(data, template),
    )
    .catch(() => ({
      ok: false as const,
      reason: 'UNAVAILABLE',
      errors: ['Intake saving is temporarily unavailable. Your entries are still here. Try again.'],
    }));
  if (!result.ok) return failure(result);
  revalidatePath('/app/crm/intakes');
  revalidatePath(`/app/crm/intakes/${id}`);
  redirect(`/app/crm/intakes/${encodeURIComponent(id)}?saved=1`);
}

'use server';

// CRM server actions — Sprint 5 (Internal CRM, Phase 1).
//
// Mutations triggered from the customer workspace: add an internal note,
// add/remove a tag, set the pipeline status, and set assignment (human or AI).
// Every write goes through the @emgloop/database repository layer; notes are
// persisted as Interaction rows of kind NOTE so they live on the same canonical
// timeline as every other touchpoint. No provider integrations are used.

import { revalidatePath } from 'next/cache';
import { crmRepos, resolveCrmOrganizationId } from './crm-data';
import { PIPELINE_STATUSES, type PipelineStatus } from '@emgloop/database';

/** Author of a note. Mirrors the schema ActorType so the UI can distinguish. */
export type NoteAuthor = 'HUMAN_AGENT' | 'AI_AGENT' | 'SYSTEM';

function refresh(customerId: string) {
  revalidatePath(`/crm/customers/${customerId}`);
  revalidatePath('/crm/customers');
}

/**
 * Add an internal note to a customer's timeline. Persisted as an Interaction
 * (channel OTHER, kind NOTE, direction INTERNAL). The author type is stored in
 * payload.actorType so Human / AI / System notes are visually distinguished.
 */
export async function addNoteAction(formData: FormData): Promise<void> {
  const customerId = String(formData.get('customerId') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();
  const authorRaw = String(formData.get('author') ?? 'HUMAN_AGENT');
  const author: NoteAuthor =
    authorRaw === 'AI_AGENT' || authorRaw === 'SYSTEM'
      ? (authorRaw as NoteAuthor)
      : 'HUMAN_AGENT';
  if (!customerId || !body) return;

  const organizationId = await resolveCrmOrganizationId();
  if (!organizationId) return;

  await crmRepos.interactions.create({
    organizationId,
    customerId,
    channel: 'OTHER',
    kind: 'NOTE',
    direction: 'INTERNAL',
    summary: 'Internal note',
    payload: { loopKind: 'human_note', actorType: author, body },
  });

  refresh(customerId);
}

/** Set the customer's pipeline status (stored in attributes.pipelineStatus). */
export async function setStatusAction(formData: FormData): Promise<void> {
  const customerId = String(formData.get('customerId') ?? '').trim();
  const status = String(formData.get('status') ?? '') as PipelineStatus;
  if (!customerId || !PIPELINE_STATUSES.includes(status)) return;
  await crmRepos.crm.setPipelineStatus(customerId, status);
  refresh(customerId);
}

/** Add a tag to the customer (deduplicated). */
export async function addTagAction(formData: FormData): Promise<void> {
  const customerId = String(formData.get('customerId') ?? '').trim();
  const tag = String(formData.get('tag') ?? '').trim();
  if (!customerId || !tag) return;
  await crmRepos.crm.addTag(customerId, tag);
  refresh(customerId);
}

/** Remove a tag from the customer. */
export async function removeTagAction(formData: FormData): Promise<void> {
  const customerId = String(formData.get('customerId') ?? '').trim();
  const tag = String(formData.get('tag') ?? '').trim();
  if (!customerId || !tag) return;
  await crmRepos.crm.removeTag(customerId, tag);
  refresh(customerId);
}

/** Assign the customer to a human and/or AI employee (by display name). */
export async function setAssignmentAction(formData: FormData): Promise<void> {
  const customerId = String(formData.get('customerId') ?? '').trim();
  if (!customerId) return;
  const humanName = formData.has('humanName')
    ? String(formData.get('humanName') ?? '').trim()
    : undefined;
  const aiName = formData.has('aiName')
    ? String(formData.get('aiName') ?? '').trim()
    : undefined;
  await crmRepos.crm.setAssignment(customerId, {
    ...(humanName !== undefined ? { humanName: humanName || null } : {}),
    ...(aiName !== undefined ? { aiName: aiName || null } : {}),
  });
  refresh(customerId);
}

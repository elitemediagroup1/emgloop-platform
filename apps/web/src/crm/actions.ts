'use server';

// CRM server actions.
//
// Mutations triggered from the CRM surfaces. Every write goes through the
// @emgloop/database repository layer; notes are persisted as Interaction rows
// of kind NOTE so they live on the same canonical timeline as every other
// touchpoint. No provider integrations are used.
//
// AUTHORITY IS CHECKED HERE, NOT ASSUMED FROM THE SESSION. Until CRM Phase Zero
// every action in this file established only that somebody was signed in and
// that the row belonged to their organization -- so a READ_ONLY member, whom the
// matrix grants `customers: view` and nothing else, could restage, retag,
// reassign and edit every customer in the tenant. The permission resource has
// existed the whole time (`customers`, `pipeline` in `iam.repository.ts`); it
// was simply never consulted on this path, while the sibling activity page
// enforced it.
//
// TENANCY IS NOW ENFORCED BY THE DATA LAYER TOO. The repository methods these
// actions call resolve the row within the organization and fail closed to null,
// so the `customerBelongsToOrg` checks below are defence in depth and a nicer
// early return -- no longer the only thing standing between a pasted id and a
// cross-tenant write.

import { revalidatePath } from 'next/cache';
import {
  crmRepos,
  requireCrmContext,
  customerBelongsToOrg,
} from './crm-data';
import { requirePermission } from '../auth/guard';
import { PIPELINE_STATUSES, type PipelineStatus } from '@emgloop/database';

/** Author of a note. Mirrors the schema ActorType so the UI can distinguish. */
export type NoteAuthor = 'HUMAN_AGENT' | 'AI_AGENT' | 'SYSTEM';

function refresh(customerId: string) {
  revalidatePath(`/crm/customers/${customerId}`);
  revalidatePath('/crm/customers');
}

function refreshLists() {
  revalidatePath('/crm/customers');
  revalidatePath('/crm/pipeline');
  revalidatePath('/crm/inbox');
}

/** Parse a repeated "ids" field (comma-joined) into a clean string array. */
function parseIds(formData: FormData): string[] {
  const raw = String(formData.get('ids') ?? '');
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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

  await requirePermission('customers', 'update');
  const { organizationId } = await requireCrmContext();
  if (!(await customerBelongsToOrg(organizationId, customerId))) return;

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
  await requirePermission('pipeline', 'update');
  const { organizationId } = await requireCrmContext();
  if (!(await customerBelongsToOrg(organizationId, customerId))) return;
  await crmRepos.crm.setPipelineStatus(organizationId, customerId, status);
  refresh(customerId);
  revalidatePath('/crm/pipeline');
}

/** Add a tag to the customer (deduplicated). */
export async function addTagAction(formData: FormData): Promise<void> {
  const customerId = String(formData.get('customerId') ?? '').trim();
  const tag = String(formData.get('tag') ?? '').trim();
  if (!customerId || !tag) return;
  await requirePermission('customers', 'update');
  const { organizationId } = await requireCrmContext();
  if (!(await customerBelongsToOrg(organizationId, customerId))) return;
  await crmRepos.crm.addTag(organizationId, customerId, tag);
  refresh(customerId);
}

/** Remove a tag from the customer. */
export async function removeTagAction(formData: FormData): Promise<void> {
  const customerId = String(formData.get('customerId') ?? '').trim();
  const tag = String(formData.get('tag') ?? '').trim();
  if (!customerId || !tag) return;
  await requirePermission('customers', 'update');
  const { organizationId } = await requireCrmContext();
  if (!(await customerBelongsToOrg(organizationId, customerId))) return;
  await crmRepos.crm.removeTag(organizationId, customerId, tag);
  refresh(customerId);
}

/**
 * Assign the customer to a human and/or AI employee. Sprint 6 sends the
 * selected employee's display name from the real picker (backed by the User /
 * AIEmployee tables); we persist the name into attributes for display, keeping
 * Phase-1 compatibility. An empty value clears the assignment.
 */
export async function setAssignmentAction(formData: FormData): Promise<void> {
  const customerId = String(formData.get('customerId') ?? '').trim();
  if (!customerId) return;
  const humanName = formData.has('humanName')
    ? String(formData.get('humanName') ?? '').trim()
    : undefined;
  const aiName = formData.has('aiName')
    ? String(formData.get('aiName') ?? '').trim()
    : undefined;
  await requirePermission('customers', 'update');
  const { organizationId } = await requireCrmContext();
  if (!(await customerBelongsToOrg(organizationId, customerId))) return;
  await crmRepos.crm.setAssignment(organizationId, customerId, {
    ...(humanName !== undefined ? { humanName: humanName || null } : {}),
    ...(aiName !== undefined ? { aiName: aiName || null } : {}),
  });
  refresh(customerId);
}

// ------------------------------------------------------------------------
// Sprint 6 (Phase 2)
// ------------------------------------------------------------------------

/**
 * Update the editable customer fields (name / email / phone) plus the
 * operational attributes (company / city / state / service / source). Only
 * fields present in the form are changed.
 */
export async function updateCustomerFieldsAction(
  formData: FormData,
): Promise<void> {
  const customerId = String(formData.get('customerId') ?? '').trim();
  if (!customerId) return;
  const str = (k: string) => {
    const v = formData.get(k);
    return v === null ? undefined : String(v).trim();
  };
  await requirePermission('customers', 'update');
  const { organizationId } = await requireCrmContext();
  if (!(await customerBelongsToOrg(organizationId, customerId))) return;
  await crmRepos.crm.updateCustomerFields(organizationId, customerId, {
    firstName: str('firstName') || null,
    lastName: str('lastName') || null,
    email: str('email') || null,
    phone: str('phone') || null,
    company: str('company') ?? undefined,
    city: str('city') ?? undefined,
    state: str('state') ?? undefined,
    serviceType: str('serviceType') ?? undefined,
    source: str('source') ?? undefined,
  });
  refresh(customerId);
}

/** Bulk: set pipeline status on the selected customers. */
export async function bulkSetStatusAction(formData: FormData): Promise<void> {
  const ids = parseIds(formData);
  const status = String(formData.get('status') ?? '') as PipelineStatus;
  if (ids.length === 0 || !PIPELINE_STATUSES.includes(status)) return;
  await requirePermission('pipeline', 'update');
  const { organizationId } = await requireCrmContext();
  await crmRepos.crm.bulkSetStatus(organizationId, ids, status);
  refreshLists();
}

/** Bulk: add a tag to the selected customers. */
export async function bulkAddTagAction(formData: FormData): Promise<void> {
  const ids = parseIds(formData);
  const tag = String(formData.get('tag') ?? '').trim();
  if (ids.length === 0 || !tag) return;
  await requirePermission('customers', 'update');
  const { organizationId } = await requireCrmContext();
  await crmRepos.crm.bulkAddTag(organizationId, ids, tag);
  refreshLists();
}

/** Bulk: assign the selected customers to a human and/or AI employee. */
export async function bulkAssignAction(formData: FormData): Promise<void> {
  const ids = parseIds(formData);
  if (ids.length === 0) return;
  const humanName = formData.has('humanName')
    ? String(formData.get('humanName') ?? '').trim()
    : undefined;
  const aiName = formData.has('aiName')
    ? String(formData.get('aiName') ?? '').trim()
    : undefined;
  await requirePermission('customers', 'update');
  const { organizationId } = await requireCrmContext();
  await crmRepos.crm.bulkAssign(organizationId, ids, {
    ...(humanName !== undefined ? { humanName: humanName || null } : {}),
    ...(aiName !== undefined ? { aiName: aiName || null } : {}),
  });
  refreshLists();
}

/**
 * Move a customer to a different pipeline column from the kanban board. Same
 * write as setStatus, but revalidates the board after.
 */
export async function movePipelineAction(formData: FormData): Promise<void> {
  const customerId = String(formData.get('customerId') ?? '').trim();
  const status = String(formData.get('status') ?? '') as PipelineStatus;
  if (!customerId || !PIPELINE_STATUSES.includes(status)) return;
  await requirePermission('pipeline', 'update');
  const { organizationId } = await requireCrmContext();
  if (!(await customerBelongsToOrg(organizationId, customerId))) return;
  await crmRepos.crm.setPipelineStatus(organizationId, customerId, status);
  revalidatePath('/crm/pipeline');
  revalidatePath('/crm/customers');
  refresh(customerId);
}

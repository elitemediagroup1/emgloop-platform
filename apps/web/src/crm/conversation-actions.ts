'use server';

// Conversation server actions — Sprint 8 (Conversations & the Unified Inbox).
//
// Mutations for the unified inbox + conversation workspace. Every action
// enforces a deny-by-default permission check via the guard (inbox for
// conversation operations, customers for merge), persists through the
// @emgloop/database repository layer, and writes an immutable AuditLog entry.
// Composing a message is a DB/timeline write only: it creates a Message row,
// it does NOT send through any real provider. No mocks, no fake data.

import { revalidatePath } from 'next/cache';
import { repositories, CONVERSATION_STATUSES } from '@emgloop/database';
import type { ConversationStatus } from '@emgloop/database';
import { requirePermission } from '../auth/guard';
import { conversationBelongsToOrg } from './crm-data';

function parseStatus(v: unknown): ConversationStatus | null {
  const s = String(v ?? '');
  return (CONVERSATION_STATUSES as string[]).includes(s)
    ? (s as ConversationStatus)
    : null;
}

function refreshInbox(conversationId?: string) {
  revalidatePath('/crm/conversations');
  if (conversationId) {
    revalidatePath('/crm/conversations/' + conversationId);
  }
}

// --- Conversation workspace -------------------------------------------

/** Compose and persist an agent message into the conversation timeline. */
export async function sendMessageAction(formData: FormData): Promise<void> {
  const session = await requirePermission('inbox', 'update');
  const conversationId = String(formData.get('conversationId') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();
  if (!conversationId || !body) return;
  // Fail closed: never write into a conversation from another organization.
  if (!(await conversationBelongsToOrg(session.organizationId, conversationId))) return;
  const message = await repositories.conversationsInbox.sendAgentMessage({
    organizationId: session.organizationId,
    conversationId,
    actorId: session.userId,
    body,
  });
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'conversation.message_sent',
    entityType: 'conversation',
    entityId: conversationId,
    metadata: { messageId: message.id },
  });
  refreshInbox(conversationId);
}

/** Change a conversation's status (Open / Pending / Snoozed / Closed). */
export async function setConversationStatusAction(formData: FormData): Promise<void> {
  const session = await requirePermission('inbox', 'update');
  const conversationId = String(formData.get('conversationId') ?? '').trim();
  const status = parseStatus(formData.get('status'));
  if (!conversationId || !status) return;
  // Fail closed: cross-org conversation ids cannot be mutated.
  if (!(await conversationBelongsToOrg(session.organizationId, conversationId))) return;
  await repositories.conversationsInbox.setStatus(conversationId, status);
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'conversation.status_changed',
    entityType: 'conversation',
    entityId: conversationId,
    metadata: { status },
  });
  refreshInbox(conversationId);
}

/** Assign (or unassign) a conversation to a human user. */
export async function setConversationAssigneeAction(formData: FormData): Promise<void> {
  const session = await requirePermission('inbox', 'update');
  const conversationId = String(formData.get('conversationId') ?? '').trim();
  const raw = String(formData.get('assigneeId') ?? '').trim();
  if (!conversationId) return;
  const assigneeId = raw === '' || raw === 'none' ? null : raw;
  // Fail closed: cross-org conversation ids cannot be mutated.
  if (!(await conversationBelongsToOrg(session.organizationId, conversationId))) return;
  await repositories.conversationsInbox.setAssignee(conversationId, assigneeId);
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'conversation.assigned',
    entityType: 'conversation',
    entityId: conversationId,
    metadata: { assigneeId: assigneeId ?? 'unassigned' },
  });
  refreshInbox(conversationId);
}

// --- Saved views (per user) -------------------------------------------

export async function createSavedViewAction(formData: FormData): Promise<void> {
  const session = await requirePermission('inbox', 'view');
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;
  const status = String(formData.get('status') ?? '').trim() || null;
  const assigneeId = String(formData.get('assigneeId') ?? '').trim() || null;
  const channel = String(formData.get('channel') ?? '').trim() || null;
  await repositories.conversationsInbox.addSavedView(session.userId, {
    name,
    status,
    assigneeId,
    channel,
  });
  revalidatePath('/crm/conversations');
}

export async function removeSavedViewAction(formData: FormData): Promise<void> {
  const session = await requirePermission('inbox', 'view');
  const viewId = String(formData.get('viewId') ?? '').trim();
  if (!viewId) return;
  await repositories.conversationsInbox.removeSavedView(session.userId, viewId);
  revalidatePath('/crm/conversations');
}

// --- Customer merge ----------------------------------------------------

/**
 * Merge a duplicate customer into a canonical one. Requires the elevated
 * customers:delete permission because it consolidates records. Writes an
 * audit entry describing what was moved.
 */
export async function mergeCustomersAction(formData: FormData): Promise<void> {
  const session = await requirePermission('customers', 'delete');
  const canonicalId = String(formData.get('canonicalId') ?? '').trim();
  const mergedId = String(formData.get('mergedId') ?? '').trim();
  if (!canonicalId || !mergedId || canonicalId === mergedId) return;
  const result = await repositories.conversationsInbox.mergeCustomers({
    organizationId: session.organizationId,
    canonicalId,
    mergedId,
  });
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'customer.merged',
    entityType: 'customer',
    entityId: canonicalId,
    metadata: { mergedId, moved: result.moved },
  });
  revalidatePath('/crm/customers');
  revalidatePath('/crm/conversations');
}

'use server';

// Chats v5: the person's own acts on an item their Telegram triage raised -- "handled", "not mine",
// "not now". The SAME WorkItem state machine Mail's items use (WorkItemRepository.record): the item is
// the person's own, scoped by the signed session inside the repository, so somebody else's id is
// not-found. Nothing here touches the conversation, the digest, or anyone else's state, and nothing
// here creates Work (that is Promote to Work, a separate, confirmed act).

import { revalidatePath } from 'next/cache';
import { WorkItemRepository, prisma } from '@emgloop/database';

import { requirePermission } from '../../../auth/guard';

const CHATS_PATH = '/app/chats';
const HOME_PATH = '/app';

async function actOnItem(
  form: FormData,
  act: (items: WorkItemRepository, principal: { organizationId: string; userId: string }, itemId: string, now: Date) => Promise<unknown>,
): Promise<void> {
  // The authority that governs a person's own work state (the same one Mail's item actions require).
  const session = await requirePermission('employeeIntelligence', 'update');
  const itemId = String(form.get('itemId') ?? '');
  if (itemId === '') return;
  await act(new WorkItemRepository(prisma), { organizationId: session.organizationId, userId: session.userId }, itemId, new Date());
  revalidatePath(CHATS_PATH);
  revalidatePath(HOME_PATH);
}

/** "I have dealt with this." Closes the item; the conversation is untouched. */
export async function chatsHandledAction(form: FormData): Promise<void> {
  await actOnItem(form, (items, principal, itemId, now) =>
    items.record(principal, itemId, { state: 'RESOLVED', observationType: 'RESOLVED', occurredAt: now, outcome: 'HANDLED' }),
  );
}

/** "This is not mine, or not worth surfacing." Closes it without claiming it was done. */
export async function chatsDismissAction(form: FormData): Promise<void> {
  await actOnItem(form, (items, principal, itemId, now) =>
    items.record(principal, itemId, { state: 'DISMISSED', observationType: 'DISMISSED', occurredAt: now, outcome: 'NOT_MINE' }),
  );
}

/** "Not now." Sleeps until the chosen time (1 hour to 30 days), and wakes by itself. */
export async function chatsSnoozeAction(form: FormData): Promise<void> {
  const hoursRaw = Number(form.get('hours') ?? 24);
  const hours = Number.isFinite(hoursRaw) ? Math.min(Math.max(Math.round(hoursRaw), 1), 24 * 30) : 24;
  await actOnItem(form, (items, principal, itemId, now) =>
    items.record(principal, itemId, { state: 'SNOOZED', observationType: 'SNOOZED', occurredAt: now, snoozedUntil: new Date(now.getTime() + hours * 3_600_000) }),
  );
}

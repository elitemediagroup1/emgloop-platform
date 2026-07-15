'use server';

// Sprint 24 — Canonical Workspace Home server actions (ADMIN).
//
// The only mutation the dashboard performs is marking a WorkNotification read.
// It REUSES the existing WorkRepository.markNotificationRead, which scopes the
// update to the acting user, so no second notification system is introduced.
// Identity + organization are re-derived from the ADMIN workspace session;
// client-supplied identity is never trusted.

import { revalidatePath } from 'next/cache';
import { prisma, createRepositories } from '@emgloop/database';

import { requireWorkspace } from '../../../workspaces/guard';

const repos = createRepositories(prisma);
const HOME = '/app/admin';

// Mark one notification read (repository enforces per-user ownership).
export async function markHomeNotificationReadAction(formData: FormData): Promise<void> {
  const session = await requireWorkspace('ADMIN');
  const notificationId = String(formData.get('notificationId') ?? '').trim();
  if (!notificationId) return;

  await repos.work.markNotificationRead(notificationId, session.userId);
  revalidatePath(HOME);
}

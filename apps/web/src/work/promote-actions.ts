'use server';

// Promote to Work -- the confirmed act. Loop Intelligence Phase C. The person saw exactly what becomes
// shared, may have edited it, ticked the confirmation, and submitted. The service re-resolves the origin
// in their own scope, refuses when it changed since they looked, checks the assignee's authority, and
// creates ONE work item with its origin link. Nothing else ever calls it: AI never creates work.

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { PromoteToWorkService, prisma } from '@emgloop/database';

import { requireSession } from '../auth/guard';
import { resolveWorkspaceRole } from '../workspaces/role-router';
import { promoteActorFor } from './promote';
import { promoteOriginFrom } from './promote-origin';

const RETURN_PATHS = ['/app/chats', '/app/mail', '/app/admin/cases', '/app/admin/headlines', '/app'] as const;

function returnPath(value: FormDataEntryValue | null): string {
  const v = typeof value === 'string' ? value : '';
  return RETURN_PATHS.some((p) => v === p || v.startsWith(`${p}/`)) && /^[A-Za-z0-9/_-]+$/.test(v) ? v : '/app';
}

export async function promoteToWorkAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const back = returnPath(form.get('returnTo'));
  const origin = promoteOriginFrom((k) => {
    const v = form.get(k);
    return typeof v === 'string' ? v : null;
  });
  if (!origin) redirect(`${back}?promoteResult=INVALID_INPUT`);
  const targetRaw = String(form.get('targetDate') ?? '').trim();
  const targetAt = targetRaw === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(targetRaw) ? new Date(`${targetRaw}T17:00:00Z`) : new Date(Number.NaN);
  const actor = await promoteActorFor(session);
  const result = await new PromoteToWorkService(prisma).promote(actor, origin!, {
    title: String(form.get('title') ?? ''),
    outcome: String(form.get('outcome') ?? ''),
    workTypeId: String(form.get('workTypeId') ?? ''),
    assigneeUserId: String(form.get('assigneeUserId') ?? ''),
    targetAt,
    fingerprint: String(form.get('fingerprint') ?? ''),
    confirmed: form.get('confirm') === 'yes',
    submissionNonce: String(form.get('submission') ?? ''),
  });
  revalidatePath(back);
  if (result.outcome !== 'PROMOTED') redirect(`${back}?promoteResult=${result.refusal}`);
  // The work is Work OS's now: open it where this person's work lives.
  const workBase = resolveWorkspaceRole(session) === 'ADMIN' ? '/app/admin/work' : '/app/employee/work';
  redirect(`${workBase}/${result.workInstanceId}`);
}

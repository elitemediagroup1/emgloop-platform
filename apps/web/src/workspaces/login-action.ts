'use server';

// Loop OS — Universal login action (Phase 2, PR #47).
//
// The homepage of Loop is the login page: one entrance. This server action
// reuses the EXISTING auth core (src/auth/auth.ts login/getSession) and audit
// trail — no new auth, no new session, no credential handling of its own. On
// success it hands off to the role router at /app, which resolves the correct
// Workspace home from the session (config-driven). The existing /crm login and
// loginAction remain untouched, so nothing breaks.

import { redirect } from 'next/navigation';
import { repositories } from '@emgloop/database';
import { login, getSession } from '../auth/auth';
import { ensureCrmIdentity } from '../auth/bootstrap';

export async function loopLoginAction(formData: FormData): Promise<void> {
  await ensureCrmIdentity();

  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const remember = formData.get('remember') === '1';
  const next = String(formData.get('next') ?? '').trim();

  const result = await login({ email, password, remember });
  if (!result.ok) {
    const msg = encodeURIComponent(result.error ?? 'Sign in failed.');
    redirect('/?error=' + msg);
  }

  const session = await getSession();
  if (session) {
    await repositories.audit.record({
      organizationId: session.organizationId,
      userId: session.userId,
      action: 'auth.login',
      actorName: session.name,
      entityType: 'user',
      entityId: session.userId,
    });
  }

  // Hand off to the role router. If a safe in-app 'next' was provided, honour it.
  if (next.startsWith('/app') || next.startsWith('/crm')) {
    redirect(next);
  }
  redirect('/app');
}

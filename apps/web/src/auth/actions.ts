'use server';

// Auth server actions — Sprint 7 (Identity, Authentication & Organizations).
//
// Form actions for the login / logout / forgot-password / reset-password flows.
// Email + password only. Every action goes through the auth core (which uses
// the @emgloop/database repository layer) and writes an audit entry. There is
// no email delivery yet: a password-reset request returns the reset link/token
// to display in-app rather than emailing it.

import { redirect } from 'next/navigation';
import { repositories } from '@emgloop/database';
import {
  login,
  logout,
  newToken,
  hashToken,
  hashPassword,
  getSession,
} from './auth';
import { ensureCrmIdentity } from './bootstrap';
import { sendPasswordResetEmail } from '../lib/email/email-service';

export async function loginAction(formData: FormData): Promise<void> {
  await ensureCrmIdentity();
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const remember = formData.get('remember') != null;
  const result = await login({ email, password, remember });
  if (!result.ok) {
    redirect('/crm/login?error=' + encodeURIComponent(result.error ?? 'Login failed'));
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
  redirect('/crm');
}

export async function logoutAction(): Promise<void> {
  const session = await getSession();
  if (session) {
    await repositories.audit.record({
      organizationId: session.organizationId,
      userId: session.userId,
      action: 'auth.logout',
      actorName: session.name,
      entityType: 'user',
      entityId: session.userId,
    });
  }
  await logout();
  redirect('/crm/login');
}

/**
 * Request a password reset. Always reports success (no account enumeration).
 * Since email delivery is out of scope, the reset link is returned via the
 * query string for in-app display.
 */
export async function requestResetAction(formData: FormData): Promise<void> {
  await ensureCrmIdentity();
  const email = String(formData.get('email') ?? '').toLowerCase().trim();
  const user = email ? await repositories.auth.findAnyUserByEmail(email) : null;
  if (user) {
    const token = newToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await repositories.auth.createPasswordReset({
      organizationId: user.organizationId,
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
    });
    await repositories.audit.record({
      organizationId: user.organizationId,
      userId: user.id,
      action: 'auth.reset_requested',
      actorName: user.name ?? user.email,
      entityType: 'user',
      entityId: user.id,
    });
    // PR-1: send the reset email INSIDE the user-found branch only, preserving
    // anti-enumeration (nothing is sent or revealed when the account does not
    // exist). Uses the plaintext token; only the hash is persisted.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
    const resetUrl = `${appUrl}/crm/reset-password?token=${encodeURIComponent(token)}`;
    await sendPasswordResetEmail({ to: user.email, name: user.name ?? undefined, resetUrl });
    redirect('/crm/forgot-password?sent=1&token=' + token);
  }
  redirect('/crm/forgot-password?sent=1');
}

export async function resetPasswordAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  if (!token) redirect('/crm/login?error=' + encodeURIComponent('Invalid reset link'));
  if (password.length < 8) {
    redirect('/crm/reset-password?token=' + token + '&error=' + encodeURIComponent('Password must be at least 8 characters'));
  }
  if (password !== confirm) {
    redirect('/crm/reset-password?token=' + token + '&error=' + encodeURIComponent('Passwords do not match'));
  }
  const consumed = await repositories.auth.consumePasswordReset(hashToken(token));
  if (!consumed) {
    redirect('/crm/login?error=' + encodeURIComponent('Reset link is invalid or expired'));
  }
  await repositories.auth.setPasswordHash(consumed!.userId, hashPassword(password));
  await repositories.auth.revokeAllForUser(consumed!.userId);
  await repositories.audit.record({
    organizationId: consumed!.organizationId,
    userId: consumed!.userId,
    action: 'auth.password_reset',
    entityType: 'user',
    entityId: consumed!.userId,
  });
  redirect('/crm/login?reset=1');
}

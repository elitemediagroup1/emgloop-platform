import 'server-only';

// Route + action guards — Sprint 7 (Identity, Authentication & Organizations).
//
// Server-side guards used by CRM pages and server actions. requireSession()
// enforces authentication (redirect to /crm/login); requirePermission() adds a
// deny-by-default authorization check via the IAM resolver (redirect to
// /crm/unauthorized). Protected routes call these at the top of the server
// component / action so access control is enforced on the server, not the UI.

import { redirect } from 'next/navigation';
import { getSession, type AuthSession } from './auth';
import { repositories } from '@emgloop/database';
import type { Resource, Action } from '@emgloop/database';

/** Require an authenticated session, or redirect to the login page. */
export async function requireSession(returnTo?: string): Promise<AuthSession> {
  const session = await getSession();
  if (!session) {
    const suffix = returnTo ? '?next=' + encodeURIComponent(returnTo) : '';
    redirect('/crm/login' + suffix);
  }
  return session!;
}

/** Require a permission, or redirect to the unauthorized page. */
export async function requirePermission(
  resource: Resource,
  action: Action,
): Promise<AuthSession> {
  const session = await requireSession();
  const allowed = await repositories.iam.can({
    organizationId: session.organizationId,
    userId: session.userId,
    resource,
    action,
  });
  if (!allowed) {
    redirect('/crm/unauthorized?resource=' + resource + '&action=' + action);
  }
  return session;
}

/** Non-redirecting permission probe for conditionally rendering UI. */
export async function hasPermission(
  resource: Resource,
  action: Action,
): Promise<boolean> {
  const session = await getSession();
  if (!session) return false;
  return repositories.iam.can({
    organizationId: session.organizationId,
    userId: session.userId,
    resource,
    action,
  });
}

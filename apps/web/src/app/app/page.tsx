import { redirect } from 'next/navigation';
import { getSession } from '../../auth/auth';
import { resolveHomeRoute } from '../../workspaces/role-router';

// Loop OS — Role Router entry (/app) (Phase 2, PR #47).
//
// Not a page a user lingers on: it resolves the caller's Workspace home from
// their session (config-driven) and redirects. Unauthenticated callers go to
// the universal login (/). This is the ONE place post-login routing happens, so
// adding a role never means touching a redirect anywhere else.

export default async function AppRouter() {
  const session = await getSession();
  if (!session) redirect('/');
  redirect(resolveHomeRoute(session));
}

import 'server-only';
import { redirect } from 'next/navigation';
import { getSession, type AuthSession } from '../auth/auth';
import { requirePermission } from '../auth/guard';
import type { Resource, Action } from '@emgloop/database';
import { resolveWorkspaceRole } from './role-router';
import { WORKSPACES, type WorkspaceRole } from './config';

// Loop OS — Workspace guards (Phase 2, PR #47).
//
// Thin, server-only wrappers over the EXISTING auth guards (src/auth/guard.ts)
// and IAM matrix. They add one thing: workspace isolation. A signed-in Creator
// must not render the Admin shell even if they hand-type the URL, so each
// workspace layout calls requireWorkspace(role) at the top. Authorization for
// individual capabilities still flows through requirePermission (unchanged),
// keeping backend authorization the single source of truth.

/** Require an authenticated session, or redirect to the universal login (/). */
export async function requireWorkspaceSession(returnTo?: string): Promise<AuthSession> {
  const session = await getSession();
  if (!session) {
    const suffix = returnTo ? '?next=' + encodeURIComponent(returnTo) : '';
    redirect('/' + suffix);
  }
  return session!;
}

/**
 * Require that the current session resolves to the given workspace. If the user
 * belongs to a DIFFERENT workspace, send them to THEIR own home rather than
 * showing an unauthorized page — the router, not the URL, decides where a role
 * lives. Fail-closed: unknown roles resolve to the most isolated workspace.
 */
export async function requireWorkspace(role: WorkspaceRole): Promise<AuthSession> {
  const session = await requireWorkspaceSession(WORKSPACES[role].home);
  const actual = resolveWorkspaceRole(session);
  if (actual !== role) {
    redirect(WORKSPACES[actual].home);
  }
  return session;
}

/**
 * Require a specific capability within a workspace, reusing the existing
 * deny-by-default IAM check. This is the same requirePermission the CRM uses;
 * exposed here so workspace pages read from one import surface.
 */
export async function requireWorkspacePermission(
  role: WorkspaceRole,
  resource: Resource,
  action: Action,
): Promise<AuthSession> {
  await requireWorkspace(role);
  return requirePermission(resource, action);
}

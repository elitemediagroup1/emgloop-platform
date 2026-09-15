import 'server-only';
import { redirect } from 'next/navigation';
import { getSession, type AuthSession } from '../auth/auth';
import { requirePermission } from '../auth/guard';
import type { Resource, Action } from '@emgloop/database';
import { resolveWorkspaceRole } from './role-router';
import { WORKSPACES, type WorkspaceRole } from './config';
import { loginPathFor } from '../auth/landing';
import { requestedPath } from '../auth/request-path';

// Loop OS — role authority guards.
//
// Thin, server-only wrappers over the EXISTING auth guards (src/auth/guard.ts)
// and IAM matrix. They add one thing: role authority over a route tree. Someone
// without ADMIN authority must not open /app/admin even if they hand-type the
// URL, so every page in a role-guarded tree calls requireWorkspace(role) itself
// (its layout calls it too, as defence in depth). Authorization for individual
// capabilities still flows through requirePermission, keeping backend
// authorization the single source of truth.

/**
 * Require an authenticated session, or redirect to login carrying the page that
 * was actually requested (so it survives sign-in). `returnTo` is only a fallback.
 */
export async function requireWorkspaceSession(returnTo?: string): Promise<AuthSession> {
  const session = await getSession();
  if (!session) {
    // Straight to login: going via / used to drop the requested destination, and
    // workspace layouts used to pass their home instead of the page asked for.
    redirect(loginPathFor(requestedPath() ?? returnTo));
  }
  return session!;
}

/**
 * Require that the current session holds the given role authority. Anyone else
 * is sent to Loop Home (/app), which renders for every role. Fail-closed: an
 * unknown role resolves to the least-privileged authority.
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

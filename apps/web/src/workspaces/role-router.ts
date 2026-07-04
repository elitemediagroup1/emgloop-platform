// Loop OS — Role Router (Phase 2, PR #47).
//
// The single place that decides "given who is signed in, which Workspace do
// they belong to and where should they land?" It is configuration-driven: the
// mapping from the EXISTING SystemRole (packages/database, unchanged) to a
// Phase 2 WorkspaceRole is a data table, not a chain of if/else, so a future
// role is one row.
//
// This module intentionally reuses the existing AuthSession (src/auth/auth.ts)
// and the existing SystemRole vocabulary. It creates NO new auth, NO new
// session, and NO schema change. It never grants access — it only chooses a
// destination; the workspace guards + IAM matrix remain the security boundary.

import type { AuthSession } from '../auth/auth';
import {
  WORKSPACES,
  type WorkspaceRole,
  type WorkspaceConfig,
} from './config';

// ---------------------------------------------------------------------------
// SystemRole -> WorkspaceRole. The DB enum (OWNER/ADMIN/MANAGER/EMPLOYEE/
// AI_EMPLOYEE/READ_ONLY) is a fixed, unchanged foundation; Phase 2 layers the
// product's workspace roles on top of it WITHOUT touching the schema:
//
//   - OWNER / ADMIN / MANAGER  -> ADMIN workspace (full operating system)
//   - EMPLOYEE / AI_EMPLOYEE    -> EMPLOYEE workspace (only assigned work)
//   - READ_ONLY                 -> CLIENT workspace (isolated, minimal)
//
// BUSINESS_OWNER and CREATOR are product roles that today's SystemRole enum has
// no dedicated value for. Rather than change the DB (out of scope, no schema
// redesign), they are opt-in via a per-user workspace hint carried in the
// existing user metadata bag (session.systemRole is unaffected). If no hint is
// present, the SystemRole mapping above applies. This keeps routing fully
// config-driven and forward-compatible: when a dedicated SystemRole is added
// later, it becomes one more row in SYSTEM_ROLE_TO_WORKSPACE.
// ---------------------------------------------------------------------------
export const SYSTEM_ROLE_TO_WORKSPACE: Record<string, WorkspaceRole> = {
  OWNER: 'ADMIN',
  ADMIN: 'ADMIN',
  MANAGER: 'ADMIN',
  EMPLOYEE: 'EMPLOYEE',
  AI_EMPLOYEE: 'EMPLOYEE',
  READ_ONLY: 'CLIENT',
};

/** Default workspace when a systemRole is unknown/missing — the most isolated,
 * least-privileged workspace, never the admin one. Fail closed. */
export const DEFAULT_WORKSPACE_ROLE: WorkspaceRole = 'CLIENT';

/**
 * A session may carry an explicit workspace hint (product roles that have no
 * dedicated SystemRole value yet, e.g. BUSINESS_OWNER, CREATOR). This reads it
 * from the optional 'workspaceRole' the app may attach to the session without
 * changing the AuthSession contract. Returns undefined when absent/invalid.
 */
export function workspaceHint(
  session: Pick<AuthSession, 'systemRole'> & { workspaceRole?: string },
): WorkspaceRole | undefined {
  const hint = session.workspaceRole;
  if (hint && (hint in WORKSPACES)) return hint as WorkspaceRole;
  return undefined;
}

/**
 * Resolve the WorkspaceRole for a session. Order: explicit hint (product
 * roles) -> SystemRole mapping -> fail-closed default. Pure and deterministic.
 */
export function resolveWorkspaceRole(
  session: Pick<AuthSession, 'systemRole'> & { workspaceRole?: string },
): WorkspaceRole {
  return (
    workspaceHint(session) ??
    SYSTEM_ROLE_TO_WORKSPACE[session.systemRole] ??
    DEFAULT_WORKSPACE_ROLE
  );
}

/** Resolve the full workspace config for a session. */
export function resolveWorkspace(
  session: Pick<AuthSession, 'systemRole'> & { workspaceRole?: string },
): WorkspaceConfig {
  return WORKSPACES[resolveWorkspaceRole(session)];
}

/** Resolve the post-login home route for a session (config-driven, never a
 * hard-coded '/crm'). */
export function resolveHomeRoute(
  session: Pick<AuthSession, 'systemRole'> & { workspaceRole?: string },
): string {
  return resolveWorkspace(session).home;
}

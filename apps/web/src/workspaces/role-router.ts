// Loop OS — Role Router.
//
// The single place that decides "given who is signed in, which role authority
// do they hold?" It is table-driven: the mapping from the EXISTING SystemRole
// (packages/database, unchanged) to a WorkspaceRole is data, not a chain of
// if/else, so a future role is one row. Every role uses the same application,
// shell and navigation; the authority only decides what they may open.
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
//   - OWNER / ADMIN / MANAGER  -> ADMIN (the organization's operating trees)
//   - EMPLOYEE / AI_EMPLOYEE    -> EMPLOYEE (their own assigned work)
//   - READ_ONLY                 -> CLIENT (no role-guarded tree; sees what its
//                                  permissions allow, like everyone else)
//
// BUSINESS_OWNER is a product role that today's SystemRole enum has no dedicated
// value for (CREATOR gained one on 2026-09-22 and is a row below). Rather than change the DB (out of scope, no schema
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
  // Creator Hub (2026-09-22): the dedicated SystemRole the comment above anticipated. A managed
  // creator's login opens the creator tree (/app/creator) and nothing else.
  CREATOR: 'CREATOR',
};

/** Default authority when a systemRole is unknown/missing — the least-privileged
 * one, never ADMIN. Fail closed. */
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

/** Resolve the home route for a session: Loop Home for every role. */
export function resolveHomeRoute(
  session: Pick<AuthSession, 'systemRole'> & { workspaceRole?: string },
): string {
  return resolveWorkspace(session).home;
}

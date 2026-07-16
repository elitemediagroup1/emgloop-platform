// CRM data access — Sprint 5 (Internal CRM, Phase 1).
//
// Thin server-only helpers shared by the CRM pages and server actions. The
// CRM reads and writes EXCLUSIVELY through the @emgloop/database repository
// layer (no direct Prisma for feature logic, no mock data, no in-memory
// state).
//
// Sprint 28 (PR 1) — Organization scoping. Production CRM requests are now
// scoped to the AUTHENTICATED session organization via requireCrmContext().
// The previous demo-only organization resolver (which was hardcoded to a seed
// organization slug) has been removed from the production request path.
// Development seeding still creates the demo organization in
// packages/database/prisma/seed.ts, but no production route resolves its
// organization from a hardcoded slug any longer.

import 'server-only';
import {
  prisma,
  createRepositories,
  type Repositories,
} from '@emgloop/database';
import { requireWorkspaceSession } from '../workspaces/guard';
import type { AuthSession } from '../auth/auth';

// One repository bundle bound to the shared singleton Prisma client.
const repos: Repositories = createRepositories(prisma);

/** The server-derived context every production CRM read/write must scope to. */
export interface CrmContext {
  userId: string;
  organizationId: string;
  systemRole: string;
  roleLabel: string;
  session: AuthSession;
}

/**
 * Canonical, server-only CRM context. Reuses the existing authenticated
 * session guard (fail-closed: requireWorkspaceSession redirects to login when
 * there is no valid session). The organizationId ALWAYS comes from the signed
 * session cookie — never from the browser, a slug, or a query parameter — and
 * is never the demo organization.
 */
export async function requireCrmContext(returnTo?: string): Promise<CrmContext> {
  const session = await requireWorkspaceSession(returnTo);
  return {
    userId: session.userId,
    organizationId: session.organizationId,
    systemRole: session.systemRole,
    roleLabel: session.roleLabel,
    session,
  };
}

/**
 * Fail-closed ownership guard for single-record CRM mutations/reads that
 * otherwise operate on a raw customerId. Returns true only when the customer
 * belongs to the caller's session organization; a cross-org id returns false
 * so callers can treat it as not-found / unauthorized.
 */
export async function customerBelongsToOrg(
  organizationId: string,
  customerId: string,
): Promise<boolean> {
  if (!organizationId || !customerId) return false;
  const row = await prisma.customer.findFirst({
    where: { id: customerId, organizationId },
    select: { id: true },
  });
  return row !== null;
}

export { repos as crmRepos };

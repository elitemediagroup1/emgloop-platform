// CRM data access — Sprint 5 (Internal CRM, Phase 1).
//
// Thin server-only helpers shared by the CRM pages and server actions. The
// CRM reads and writes EXCLUSIVELY through the @emgloop/database repository
// layer (no direct Prisma for feature logic, no mock data, no in-memory
// state).
//
// Sprint 28 — Organization scoping. New and migrated production CRM requests
// are scoped to the AUTHENTICATED session organization via requireCrmContext().
// The legacy demo-only organization resolver (resolveCrmOrganizationId, keyed
// by a fixed seed-organization slug) is retained TRANSITIONALLY and marked
// @deprecated below, only so CRM feature pages, owner Brain/Marketplace, and
// API routes not yet migrated (Sprint 28 PR 2 and PR 3) still compile. It will
// be deleted in the final Sprint 28 PR. Development seeding is unchanged.

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

/**
 * Fail-closed ownership guard for single-conversation reads/mutations that
 * otherwise operate on a raw conversationId. Returns true only when the
 * conversation belongs to the caller's session organization; a cross-org id
 * returns false so callers can treat it as not-found / unauthorized.
 */
export async function conversationBelongsToOrg(
  organizationId: string,
  conversationId: string,
): Promise<boolean> {
  if (!organizationId || !conversationId) return false;
  const row = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Fail-closed ownership guard for single-workflow reads/mutations that
 * otherwise operate on a raw workflowId. Returns true only when the workflow
 * belongs to the caller's session organization; a cross-org id returns false
 * so callers can treat it as not-found / unauthorized.
 */
export async function workflowBelongsToOrg(
  organizationId: string,
  workflowId: string,
): Promise<boolean> {
  if (!organizationId || !workflowId) return false;
  const row = await prisma.workflow.findFirst({
    where: { id: workflowId, organizationId },
    select: { id: true },
  });
  return row !== null;
}

/**
 * @deprecated TRANSITIONAL — Sprint 28. Resolves a fixed seed organization by
 * slug. This is the pre-Sprint-28 behavior and is NOT session-scoped. It is
 * retained ONLY so the not-yet-migrated CRM feature pages, owner Brain and
 * Marketplace pages, and API route handlers still compile during the staged
 * migration (Sprint 28 PR 2 and PR 3). Do NOT introduce new callers. Every new
 * or migrated production read/write must use requireCrmContext() instead. This
 * function and CRM_ORG_SLUG will be deleted in the final Sprint 28 PR once no
 * production module imports them.
 */
export const CRM_ORG_SLUG = 'servicesinmycity-demo';

export async function resolveCrmOrganizationId(): Promise<string | null> {
  const org = await prisma.organization.findUnique({
    where: { slug: CRM_ORG_SLUG },
    select: { id: true },
  });
  return org ? org.id : null;
}

export { repos as crmRepos };

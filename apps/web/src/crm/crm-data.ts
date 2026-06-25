// CRM data access — Sprint 5 (Internal CRM, Phase 1).
//
// Thin server-only helpers shared by the CRM pages and server actions. The
// CRM reads and writes EXCLUSIVELY through the @emgloop/database repository
// layer (no direct Prisma, no mock data, no in-memory state). It is scoped to
// the same demo organization the Sprint 4 intake loop persists into, so the
// customers created by /demo/intake appear here immediately.

import {
  prisma,
  createRepositories,
  type Repositories,
} from '@emgloop/database';

// One repository bundle bound to the shared singleton Prisma client.
const repos: Repositories = createRepositories(prisma);

export const CRM_ORG_SLUG = 'servicesinmycity-demo';

/**
 * Resolve the organization the CRM operates on. This MUST match the slug the
 * Sprint 4 demo loop uses (ensureDemoOrganization) so intake customers are
 * visible in the CRM. We only READ here — the org is created by the intake
 * flow — and return null if it does not exist yet (empty-state friendly).
 */
export async function resolveCrmOrganizationId(): Promise<string | null> {
  const org = await prisma.organization.findUnique({
    where: { slug: CRM_ORG_SLUG },
    select: { id: true },
  });
  return org ? org.id : null;
}

export { repos as crmRepos };

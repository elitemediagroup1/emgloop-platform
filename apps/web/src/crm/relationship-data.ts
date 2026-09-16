// Relationship read loaders -- slice R3-A3, for the operator surface.
//
// Server-only loaders a page calls. Each resolves the session first;
// `CrmRelationshipReadService` then checks `relationships:view` before reading
// anything, and returns the viewer's CAPABILITIES so a page offers only the acts
// the server would allow. The page never re-derives authorization, and every act is
// authorized again when it is performed.
//
// An empty list is the correct answer while no Relationship has been created.

import 'server-only';
import { CrmRelationshipReadService, prisma } from '@emgloop/database';
import { requireCrmContext } from './crm-data';

const reads = new CrmRelationshipReadService(prisma);

export async function loadRelationships(opts: { cursor?: string | null; limit?: number; includeVoided?: boolean } = {}) {
  const ctx = await requireCrmContext();
  return reads.list({ organizationId: ctx.organizationId, userId: ctx.userId }, opts);
}

export async function loadRelationship(relationshipId: string) {
  const ctx = await requireCrmContext();
  return reads.getRecord({ organizationId: ctx.organizationId, userId: ctx.userId }, relationshipId);
}

/** The Relationships one established Party takes part in. */
export async function loadRelationshipsForParty(partyId: string) {
  const ctx = await requireCrmContext();
  return reads.forParty({ organizationId: ctx.organizationId, userId: ctx.userId }, partyId);
}

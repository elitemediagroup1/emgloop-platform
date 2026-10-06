// The redesigned CRM slice's reads, bound to the signed session. Server only.
//
// The organization and the viewer always come from the session (requireCrmContext);
// the services check each permission again before reading. See crm-subject-reads.ts.

import 'server-only';
import { CrmContactPointService, CrmOpportunityReadService, CrmRelationshipReadService, PartyRecordService, absentUntilMigrated, prisma } from '@emgloop/database';
import type { CrmOpportunityListFiltersV1, CrmContactPointViewV1 } from '@emgloop/shared';
import { crmRepos, requireCrmContext } from './crm-data';
import type { CrmSubjectReadDeps } from './crm-subject-reads';

const records = new PartyRecordService(prisma);
const reads = new CrmRelationshipReadService(prisma);
const contactPoints = new CrmContactPointService(prisma);
const opportunities = new CrmOpportunityReadService(prisma);

export const PEOPLE_HREF = '/app/crm/people';
export const RELATIONSHIPS_HREF = '/app/crm/relationships';
export const personHref = (partyId: string) => `${PEOPLE_HREF}/${encodeURIComponent(partyId)}`;
export const relationshipHref = (relationshipId: string) => `${RELATIONSHIPS_HREF}/${encodeURIComponent(relationshipId)}`;

export async function crmSubjectReads(): Promise<CrmSubjectReadDeps> {
  const ctx = await requireCrmContext();
  const viewer = { organizationId: ctx.organizationId, userId: ctx.userId };
  return {
    listPeople: (opts) => records.listPeople(viewer.organizationId, viewer.userId, opts),
    establishmentQueue: (opts) => records.listEstablishmentQueue(viewer.organizationId, viewer.userId, opts),
    partyRecord: (partyId) => records.getRecord(viewer.organizationId, viewer.userId, partyId),
    relationships: (opts) => reads.list(viewer, opts),
    relationshipsForParty: (partyId) => reads.forParty(viewer, partyId),
    relationship: (relationshipId) => reads.getRecord(viewer, relationshipId),
    workspaceName: async () => (await crmRepos.organizations.findById(viewer.organizationId))?.name ?? null,
  };
}

/**
 * A Party's CRM Contact Points (PD-F-05) as the signed-in viewer may see them: values for
 * EMPLOYEE and above, kind/classification/state only for READ_ONLY, refused otherwise. The service
 * checks the grant; this only binds the session. `null` while the Contact Point migration has not
 * reached this database -- an honest "not available here yet", never a crash.
 */
export async function readContactPoints(partyId: string): Promise<{ outcome: 'OK'; value: CrmContactPointViewV1[] } | { outcome: 'NOT_AUTHORIZED' } | null> {
  const ctx = await requireCrmContext();
  return absentUntilMigrated(contactPoints.listForParty({ organizationId: ctx.organizationId, userId: ctx.userId }, partyId));
}

/**
 * Staff reads of the organization's Opportunities (CRM slice 4). The service checks PD-F-11 VIEW,
 * the Party gate for names and the notes grant; this only binds the session. `null` while the
 * Opportunity owner/participant migration has not reached this database.
 */
export async function readOpportunities(options: { cursor: string | null; filters: CrmOpportunityListFiltersV1 }) {
  const ctx = await requireCrmContext();
  return absentUntilMigrated(opportunities.list({ organizationId: ctx.organizationId, userId: ctx.userId }, { cursor: options.cursor, filters: options.filters, limit: OPPORTUNITIES_PAGE_SIZE }));
}

export async function readOpportunity(opportunityId: string) {
  const ctx = await requireCrmContext();
  return absentUntilMigrated(opportunities.getRecord({ organizationId: ctx.organizationId, userId: ctx.userId }, opportunityId));
}

export const OPPORTUNITIES_PAGE_SIZE = 25;

// Authorized staff reads of CRM Opportunities across an organization (CRM slice 4, 2026-10-06).
//
// Separate from the write authority (`CrmOpportunityService`) as Relationships separate theirs:
// different callers, different failure modes.
//
// AUTHORIZE BEFORE LOOKING. Three refusals run before any read, exactly as the write authority's:
//   1. an ACTIVE membership in this organization;
//   2. the coarse `opportunities:view` gate (AI_EMPLOYEE hard-denied; CREATOR's row is empty);
//   3. PD-F-11's VIEW act (`crmOpportunityActPermitted`), which no Permission row is consulted for.
// Somebody refused learns nothing -- not whether an Opportunity exists, nor how many there are.
// Owning an Opportunity changes none of this: ownership is accountability, not access.
//
// NAMES follow the Party gate, `identityResolution:view`, as People and Relationships do -- decided
// here, never in a UI. Without it every name is null and name search is off.
//
// NO NOTE TEXT, for anyone. `internalNotes` and transition notes have no governed Opportunity-note
// authority, and one domain's grant (e.g. Contact Point VIEW_VALUE) never governs another domain's
// fact because the content may look alike. The read model says only THAT a note was recorded.
//
// CAPABILITIES COME BACK WITH THE DATA, from the PD-F-11 act table. A UI renders them; every act is
// authorized again by `CrmOpportunityService` when it is performed.

import type { PrismaClient } from '@prisma/client';
import {
  crmOpportunityActPermitted,
  type CrmOpportunityCapabilitiesV1,
  type CrmOpportunityListPageV1,
  type CrmOpportunityRecordV1,
} from '@emgloop/shared';

import { IamRepository } from '../repositories/iam.repository';
import { membershipAuthority } from '../repositories/membership.repository';
import {
  CrmOpportunityCursorError,
  CrmOpportunityReadModelRepository,
  type CrmOpportunityListOptions,
  type CrmOpportunityReadScope,
} from '../repositories/crm-opportunity-read-model.repository';

export interface CrmOpportunityViewer {
  readonly organizationId: string;
  readonly userId: string;
}

export type CrmOpportunityReadResult<T> =
  | { readonly outcome: 'OK'; readonly value: T; readonly capabilities: CrmOpportunityCapabilitiesV1 }
  | { readonly outcome: 'NOT_AUTHORIZED' }
  | { readonly outcome: 'NOT_FOUND' }
  | { readonly outcome: 'INVALID_CURSOR' };

export interface CrmOpportunityReadServiceDeps {
  readModel?: CrmOpportunityReadModelRepository;
  iam?: Pick<IamRepository, 'canEach'>;
}

export class CrmOpportunityReadService {
  private readonly readModel: CrmOpportunityReadModelRepository;
  private readonly iam: Pick<IamRepository, 'canEach'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmOpportunityReadServiceDeps = {},
  ) {
    this.readModel = deps.readModel ?? new CrmOpportunityReadModelRepository(prisma);
    this.iam = deps.iam ?? new IamRepository(prisma);
  }

  async list(viewer: CrmOpportunityViewer, options: CrmOpportunityListOptions = {}): Promise<CrmOpportunityReadResult<CrmOpportunityListPageV1>> {
    const access = await this.access(viewer);
    if (!access) return { outcome: 'NOT_AUTHORIZED' };
    try {
      return { outcome: 'OK', value: await this.readModel.list(access.scope, options), capabilities: access.capabilities };
    } catch (err) {
      if (err instanceof CrmOpportunityCursorError) return { outcome: 'INVALID_CURSOR' };
      throw err;
    }
  }

  async getRecord(viewer: CrmOpportunityViewer, opportunityId: string): Promise<CrmOpportunityReadResult<CrmOpportunityRecordV1>> {
    const access = await this.access(viewer);
    if (!access) return { outcome: 'NOT_AUTHORIZED' };
    const record = await this.readModel.getRecord(access.scope, opportunityId);
    // Another tenant's id is NOT_FOUND, indistinguishable from one that never existed.
    if (!record) return { outcome: 'NOT_FOUND' };
    return { outcome: 'OK', value: record, capabilities: access.capabilities };
  }

  /** Null when this viewer may not read Opportunities; otherwise their scope and what they may do. */
  private async access(viewer: CrmOpportunityViewer): Promise<{ scope: CrmOpportunityReadScope; capabilities: CrmOpportunityCapabilitiesV1 } | null> {
    if (!viewer.organizationId?.trim() || !viewer.userId?.trim()) return null;
    const authority = await membershipAuthority(this.prisma, viewer.organizationId, viewer.userId);
    if (!authority.granted) return null;
    const [canView, canReadParties] = await this.iam.canEach(viewer.organizationId, viewer.userId, [
      { resource: 'opportunities', action: 'view' },
      { resource: 'identityResolution', action: 'view' },
    ]);
    if (canView !== true) return null;
    const role = authority.systemRole;
    const may = (act: string) => crmOpportunityActPermitted({ act, role, actorType: 'HUMAN' });
    if (!may('VIEW')) return null;

    return {
      scope: { organizationId: viewer.organizationId, viewerUserId: viewer.userId, namesReadable: canReadParties === true },
      capabilities: {
        changeOwner: may('CHANGE_OWNER'),
        addParticipant: may('ADD_PARTICIPANT'),
        endParticipant: may('END_PARTICIPANT'),
        voidParticipant: may('VOID_PARTICIPANT'),
        update: may('UPDATE'),
      },
    };
  }
}

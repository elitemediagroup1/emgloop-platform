// Authorized reads of Relationships. Slice R3-A3.
//
// Separate from the write service on purpose, following `PartyService` (writes) and
// `PartyRecordService` (reads): the two have different authorities, different
// failure modes and different callers, and one class doing both becomes the place
// every future Relationship concern is added to.
//
// AUTHORIZE BEFORE LOOKING. The view check runs before any read, so somebody without
// it learns nothing -- not whether a Relationship exists, not how many there are, not
// whether an id is real. AI_EMPLOYEE is denied by the same hard denial the act table
// uses, because PD-F-04 grants view to human workspace roles and it is not one.
//
// CAPABILITIES COME BACK WITH THE DATA. Every successful read carries what this
// viewer may do, decided by the approved act table on the server. A UI renders
// those; it never re-derives authorization, and every act is authorized again when
// it is performed. Hiding a button was never access control.

import type { PrismaClient } from '@prisma/client';
import {
  crmRelationshipActPermitted,
  type CrmRelationshipCapabilitiesV1,
  type CrmRelationshipListPageV1,
  type CrmRelationshipRecordV1,
} from '@emgloop/shared';

import { IamRepository } from '../repositories/iam.repository';
import { membershipAuthority } from '../repositories/membership.repository';
import {
  CrmRelationshipCursorError,
  CrmRelationshipReadModelRepository,
  type CrmRelationshipListOptions,
} from '../repositories/crm-relationship-read-model.repository';

export interface CrmRelationshipViewer {
  readonly organizationId: string;
  readonly userId: string;
}

export type CrmRelationshipReadResult<T> =
  | { readonly outcome: 'OK'; readonly value: T; readonly capabilities: CrmRelationshipCapabilitiesV1 }
  | { readonly outcome: 'NOT_AUTHORIZED' }
  | { readonly outcome: 'NOT_FOUND' }
  | { readonly outcome: 'INVALID_CURSOR' };

export interface CrmRelationshipReadServiceDeps {
  readModel?: CrmRelationshipReadModelRepository;
  iam?: Pick<IamRepository, 'canEach'>;
}

export class CrmRelationshipReadService {
  private readonly readModel: CrmRelationshipReadModelRepository;
  private readonly iam: Pick<IamRepository, 'canEach'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmRelationshipReadServiceDeps = {},
  ) {
    this.readModel = deps.readModel ?? new CrmRelationshipReadModelRepository(prisma);
    this.iam = deps.iam ?? new IamRepository(prisma);
  }

  list(viewer: CrmRelationshipViewer, options: CrmRelationshipListOptions = {}): Promise<CrmRelationshipReadResult<CrmRelationshipListPageV1>> {
    return this.read(viewer, () => this.readModel.list(viewer.organizationId, options));
  }

  /** The Relationships a Person or a Company takes part in. Same shape, one authority. */
  forParty(
    viewer: CrmRelationshipViewer,
    partyId: string,
    options: CrmRelationshipListOptions = {},
  ): Promise<CrmRelationshipReadResult<CrmRelationshipListPageV1>> {
    return this.read(viewer, () => this.readModel.forParty(viewer.organizationId, partyId, options));
  }

  async getRecord(viewer: CrmRelationshipViewer, relationshipId: string): Promise<CrmRelationshipReadResult<CrmRelationshipRecordV1>> {
    const capabilities = await this.capabilities(viewer);
    if (!capabilities) return { outcome: 'NOT_AUTHORIZED' };
    const record = await this.readModel.getRecord(viewer.organizationId, relationshipId);
    // Another tenant's id is NOT_FOUND, indistinguishable from one that never existed.
    if (!record) return { outcome: 'NOT_FOUND' };
    return { outcome: 'OK', value: record, capabilities };
  }

  private async read<T>(viewer: CrmRelationshipViewer, load: () => Promise<T>): Promise<CrmRelationshipReadResult<T>> {
    const capabilities = await this.capabilities(viewer);
    if (!capabilities) return { outcome: 'NOT_AUTHORIZED' };
    try {
      return { outcome: 'OK', value: await load(), capabilities };
    } catch (err) {
      if (err instanceof CrmRelationshipCursorError) return { outcome: 'INVALID_CURSOR' };
      throw err;
    }
  }

  /**
   * Null when this viewer may not read Relationships at all; otherwise exactly what
   * they may do, from the approved act table. Two independent refusals: an inactive
   * or absent membership, and the coarse `relationships:view` gate -- which AI_EMPLOYEE
   * is hard-denied, so it never reaches the act table at all.
   */
  private async capabilities(viewer: CrmRelationshipViewer): Promise<CrmRelationshipCapabilitiesV1 | null> {
    if (!viewer.organizationId?.trim() || !viewer.userId?.trim()) return null;
    const authority = await membershipAuthority(this.prisma, viewer.organizationId, viewer.userId);
    if (!authority.granted) return null;
    const [canView] = await this.iam.canEach(viewer.organizationId, viewer.userId, [
      { resource: 'relationships', action: 'view' },
    ]);
    if (canView !== true) return null;

    const may = (act: string) => crmRelationshipActPermitted({ act, role: authority.systemRole, actorType: 'HUMAN' });
    return {
      create: may('CREATE'),
      updateDetails: may('UPDATE_DETAILS'),
      addParticipant: may('ADD_PARTICIPANT'),
      changeParticipant: may('CHANGE_PARTICIPANT'),
      endRelationship: may('END_RELATIONSHIP'),
      reactivateRelationship: may('REACTIVATE_RELATIONSHIP'),
      endParticipant: may('END_PARTICIPANT'),
      voidRelationship: may('VOID_RELATIONSHIP'),
      voidParticipant: may('VOID_PARTICIPANT'),
    };
  }
}

// PartyRecordService -- authorized reads of People, Companies, the establishment queue and Party records.
//
// Identity slice P1. Reading canonical identity is `identityResolution:view`:
// OWNER, ADMIN, MANAGER, EMPLOYEE and READ_ONLY. AI_EMPLOYEE holds no
// identityResolution action and no Permission row can grant it one.
//
// AUTHORIZE BEFORE LOOKING. The view check runs before any read, so a person
// without it learns nothing -- not whether a Party exists, not how many there are.
//
// ACTIONS ARE SERVER-DECIDED. Every successful read returns the viewer's
// capabilities (create: identityResolution:create; establish:
// identityResolution:approve). They tell the UI what to offer; the acts
// themselves are authorized again by `PartyService`.
//
// The organization and viewer always come from the signed session, established
// by the caller.

import type { PrismaClient } from '@prisma/client';
import type { PartyListPageV1, PartyRecordV1, PartyType, PartyViewerCapabilitiesV1 } from '@emgloop/shared';

import { IamRepository } from '../repositories/iam.repository';
import {
  PartyListCursorError,
  PartyReadModelRepository,
  type PartyListOptions,
} from '../repositories/party-read-model.repository';

export type PartyReadResult<T> =
  | { outcome: 'OK'; value: T; capabilities: PartyViewerCapabilitiesV1 }
  | { outcome: 'NOT_AUTHORIZED' }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'INVALID_CURSOR' };

export interface PartyRecordServiceDeps {
  iam?: Pick<IamRepository, 'canEach'>;
  readModel?: PartyReadModelRepository;
}

export class PartyRecordService {
  private readonly iam: Pick<IamRepository, 'canEach'>;
  private readonly readModel: PartyReadModelRepository;

  constructor(prisma: PrismaClient, deps: PartyRecordServiceDeps = {}) {
    this.iam = deps.iam ?? new IamRepository(prisma);
    this.readModel = deps.readModel ?? new PartyReadModelRepository(prisma);
  }

  /** People: established, non-superseded, non-archived PERSON Parties. */
  listPeople(organizationId: string, viewerUserId: string, opts: PartyListOptions = {}): Promise<PartyReadResult<PartyListPageV1>> {
    return this.list(organizationId, viewerUserId, () => this.readModel.listEstablished(organizationId, 'PERSON', opts));
  }

  /** Companies: established, non-superseded, non-archived COMPANY Parties. Never the tenant. */
  listCompanies(organizationId: string, viewerUserId: string, opts: PartyListOptions = {}): Promise<PartyReadResult<PartyListPageV1>> {
    return this.list(organizationId, viewerUserId, () => this.readModel.listEstablished(organizationId, 'COMPANY', opts));
  }

  /** Governed Party records awaiting establishment. */
  listEstablishmentQueue(
    organizationId: string,
    viewerUserId: string,
    opts: PartyListOptions & { partyType?: PartyType | null } = {},
  ): Promise<PartyReadResult<PartyListPageV1>> {
    return this.list(organizationId, viewerUserId, () => this.readModel.listUnestablished(organizationId, opts));
  }

  async getRecord(organizationId: string, viewerUserId: string, partyId: string): Promise<PartyReadResult<PartyRecordV1>> {
    const access = await this.access(organizationId, viewerUserId);
    if (!access) return { outcome: 'NOT_AUTHORIZED' };
    const record = await this.readModel.getRecord(organizationId, partyId);
    if (!record) return { outcome: 'NOT_FOUND' };
    return { outcome: 'OK', value: record, capabilities: access };
  }

  private async list(
    organizationId: string,
    viewerUserId: string,
    read: () => Promise<PartyListPageV1>,
  ): Promise<PartyReadResult<PartyListPageV1>> {
    const access = await this.access(organizationId, viewerUserId);
    if (!access) return { outcome: 'NOT_AUTHORIZED' };
    try {
      return { outcome: 'OK', value: await read(), capabilities: access };
    } catch (err) {
      if (err instanceof PartyListCursorError) return { outcome: 'INVALID_CURSOR' };
      throw err;
    }
  }

  /** Null when the viewer may not read canonical identity; otherwise what they may do. */
  private async access(organizationId: string, viewerUserId: string): Promise<PartyViewerCapabilitiesV1 | null> {
    if (!organizationId || !viewerUserId) return null;
    const [view, create, approve] = await this.iam.canEach(organizationId, viewerUserId, [
      { resource: 'identityResolution', action: 'view' },
      { resource: 'identityResolution', action: 'create' },
      { resource: 'identityResolution', action: 'approve' },
    ]);
    if (!view) return null;
    return { createParty: create === true, establishParty: approve === true };
  }
}

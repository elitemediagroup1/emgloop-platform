// PartyService -- governed creation and establishment of canonical Parties.
// CRM Phase Zero P0.2d.
//
// TWO ACTS, TWO AUTHORITIES. Creating a Party record and establishing it as
// canonical identity are different claims, held by different people (Product
// decision, 2026-09-13):
//
//   create     identityResolution:create   -- OWNER, ADMIN, MANAGER, EMPLOYEE
//              A PERSON or COMPANY record now exists. It is NOT canonical identity.
//   establish  identityResolution:approve  -- OWNER, ADMIN
//              An authorized person asserts, on a governed basis, that this record
//              is canonical identity. `approve` is the only action that may.
//
// AI_EMPLOYEE holds neither, and no Permission row can grant it either.
//
// AUTHORIZE BEFORE LOOKING. Every write checks the actor's authority first, so a
// person without it gets NOT_AUTHORIZED whether or not the Party exists -- this
// service can never be used to probe for a record. A miss inside an organization
// the actor may act in is NOT_FOUND, and a record in another organization is
// indistinguishable from one that does not exist.
//
// THE KEY IS MINTED, NEVER DERIVED. A Party's canonicalKey is 'party:' plus a
// random UUID. It is never built from an email, phone, name or external id, so it
// cannot collide with a cognitive subject, cannot be guessed, and cannot turn a
// contact value into identity. There is no resolve-or-create for Parties.
//
// NO CONFIDENCE, NO INFERENCE. Nothing here accepts a score, matches on contact
// values, or reads the dormant resolver.
//
// The actor is always the session's user, established by the caller from the
// session and never from input.

import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { isPartyType } from '@emgloop/shared';

import { IamRepository } from '../repositories/iam.repository';
import { AuditRepository } from '../repositories/audit.repository';
import { CognitiveIdentityRepository } from '../repositories/cognitive/identity.repository';
import { PartyRepository, type PartyView } from '../repositories/cognitive/party.repository';

export const PARTY_WRITE_OUTCOMES = [
  'RECORDED',
  'ALREADY_ESTABLISHED',
  'NOT_AUTHORIZED',
  'NOT_FOUND',
  'INVALID',
] as const;
export type PartyWriteOutcome = (typeof PARTY_WRITE_OUTCOMES)[number];

/** The governed bases an authorized person may establish a Party on. */
export const PARTY_ESTABLISHMENT_BASES = ['MANUAL', 'EXPLICIT_LINK'] as const;
export type PartyEstablishmentBasis = (typeof PARTY_ESTABLISHMENT_BASES)[number];

export type PartyWriteResult =
  | { outcome: 'RECORDED' | 'ALREADY_ESTABLISHED'; party: PartyView }
  | { outcome: 'NOT_AUTHORIZED' | 'NOT_FOUND' }
  | { outcome: 'INVALID'; reason: 'NOT_A_PARTY_TYPE' | 'NOT_A_GOVERNED_BASIS' | 'ARCHIVED' };

export interface PartyServiceDeps {
  iam?: Pick<IamRepository, 'can'>;
  identities?: CognitiveIdentityRepository;
  parties?: PartyRepository;
  audit?: Pick<AuditRepository, 'record'>;
}

const DISPLAY_NAME_MAX = 200;

export class PartyService {
  private readonly iam: Pick<IamRepository, 'can'>;
  private readonly identities: CognitiveIdentityRepository;
  private readonly parties: PartyRepository;
  private readonly audit: Pick<AuditRepository, 'record'>;

  constructor(prisma: PrismaClient, deps: PartyServiceDeps = {}) {
    this.iam = deps.iam ?? new IamRepository(prisma);
    this.identities = deps.identities ?? new CognitiveIdentityRepository(prisma);
    this.parties = deps.parties ?? new PartyRepository(prisma);
    this.audit = deps.audit ?? new AuditRepository(prisma);
  }

  /** The same question `create` asks, for a surface deciding what to render. */
  canCreate(organizationId: string, actorUserId: string): Promise<boolean> {
    return this.iam.can({ organizationId, userId: actorUserId, resource: 'identityResolution', action: 'create' });
  }

  /** The same question `establish` asks. */
  canEstablish(organizationId: string, actorUserId: string): Promise<boolean> {
    return this.iam.can({ organizationId, userId: actorUserId, resource: 'identityResolution', action: 'approve' });
  }

  /** Create a PERSON or COMPANY record. It is not established. */
  async create(
    organizationId: string,
    actorUserId: string,
    input: { partyType: string; displayName?: string | null },
  ): Promise<PartyWriteResult> {
    if (!isPartyType(input.partyType)) return { outcome: 'INVALID', reason: 'NOT_A_PARTY_TYPE' };
    if (!(await this.canCreate(organizationId, actorUserId))) return { outcome: 'NOT_AUTHORIZED' };

    const name = typeof input.displayName === 'string' ? input.displayName.trim().slice(0, DISPLAY_NAME_MAX) : '';
    const row = await this.identities.create(organizationId, {
      entityType: input.partyType,
      canonicalKey: `party:${randomUUID()}`,
      displayName: name.length > 0 ? name : null,
      status: 'KNOWN',
    });
    const party = await this.parties.findParty(organizationId, row.id);
    if (!party) return { outcome: 'NOT_FOUND' };

    // No name in the audit entry: the trail records the act, not the person.
    await this.audit.record({
      organizationId,
      userId: actorUserId,
      action: 'party.created',
      entityType: 'party',
      entityId: row.id,
      metadata: { partyType: input.partyType },
    });
    return { outcome: 'RECORDED', party };
  }

  /** Establish a Party record as canonical identity, on a governed basis. */
  async establish(
    organizationId: string,
    actorUserId: string,
    partyId: string,
    basis: string,
  ): Promise<PartyWriteResult> {
    if (!(PARTY_ESTABLISHMENT_BASES as readonly string[]).includes(basis)) {
      return { outcome: 'INVALID', reason: 'NOT_A_GOVERNED_BASIS' };
    }
    if (!(await this.canEstablish(organizationId, actorUserId))) return { outcome: 'NOT_AUTHORIZED' };

    const existing = await this.parties.findParty(organizationId, partyId);
    if (!existing) return { outcome: 'NOT_FOUND' };
    if (existing.establishment.established) return { outcome: 'ALREADY_ESTABLISHED', party: existing };
    const row = await this.identities.findById(organizationId, partyId);
    if (!row) return { outcome: 'NOT_FOUND' };
    if (row.archivedAt || row.status === 'ARCHIVED') return { outcome: 'INVALID', reason: 'ARCHIVED' };

    const written = await this.identities.recordEstablishment(organizationId, partyId, {
      establishedByUserId: actorUserId,
      basis: basis as PartyEstablishmentBasis,
      at: new Date(),
    });
    const party = await this.parties.findParty(organizationId, partyId);
    if (!party) return { outcome: 'NOT_FOUND' };
    // Somebody else established it between the read and the write: their record
    // stands, and no audit entry is written for a write that did not happen.
    if (!written) return { outcome: 'ALREADY_ESTABLISHED', party };

    await this.audit.record({
      organizationId,
      userId: actorUserId,
      action: 'party.established',
      entityType: 'party',
      entityId: partyId,
      metadata: { basis },
    });
    return { outcome: 'RECORDED', party };
  }
}

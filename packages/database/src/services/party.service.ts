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
// ONE TRANSACTION PER ACT, OR THE CALLER'S. Each act writes its row and its audit row together. A
// caller composing several governed acts into one atomic unit (the CRM importer) passes its own
// transaction; the authorization, validation and audit are exactly the same either way.
//
// The actor is always the session's user, established by the caller from the
// session and never from input. Audit rows name that user: the caller passes the
// session's display name, and without one the member's name is read from the
// organization's own User row. A human act is not recorded as "System" when either
// is known.

import { randomUUID } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
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

/**
 * How the act is attributed on the audit trail. `actorName` is the display name of
 * the session the caller already resolved; it names the actor and never authorizes.
 */
export interface PartyActOptions {
  actorName?: string | null;
  /**
   * A caller's transaction, when this act is one step of a larger atomic unit (the CRM importer's
   * Company or Person unit). The SAME authorization, validation and audit run either way; only
   * the transaction boundary moves to the caller, so a later failure in the unit rolls this act
   * back too. Without it the act opens its own transaction (row and audit row together).
   */
  tx?: Prisma.TransactionClient;
}

export interface PartyServiceDeps {
  iam?: Pick<IamRepository, 'can' | 'getUser'>;
  identities?: CognitiveIdentityRepository;
  parties?: PartyRepository;
  audit?: Pick<AuditRepository, 'record'>;
}

const DISPLAY_NAME_MAX = 200;

export class PartyService {
  private readonly iam: Pick<IamRepository, 'can' | 'getUser'>;
  private readonly identities: CognitiveIdentityRepository;
  private readonly parties: PartyRepository;
  private readonly audit: Pick<AuditRepository, 'record'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: PartyServiceDeps = {},
  ) {
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
    options: PartyActOptions = {},
  ): Promise<PartyWriteResult> {
    if (!isPartyType(input.partyType)) return { outcome: 'INVALID', reason: 'NOT_A_PARTY_TYPE' };
    if (!(await this.canCreate(organizationId, actorUserId))) return { outcome: 'NOT_AUTHORIZED' };

    const partyType = input.partyType;
    const name = typeof input.displayName === 'string' ? input.displayName.trim().slice(0, DISPLAY_NAME_MAX) : '';
    // Resolved before any transaction: a lookup on the outer client from inside one needs a second
    // pooled connection (the Contact Point slice's pool-starvation finding).
    const actorName = await this.actorName(organizationId, actorUserId, options);
    return this.inTransaction(options.tx, async (db): Promise<PartyWriteResult> => {
      const row = await this.identities.create(
        organizationId,
        { entityType: partyType, canonicalKey: `party:${randomUUID()}`, displayName: name.length > 0 ? name : null, status: 'KNOWN' },
        db,
      );
      const party = await this.parties.findParty(organizationId, row.id, undefined, db);
      if (!party) return { outcome: 'NOT_FOUND' };
      // No Party name in the audit entry: the trail records the act, not the person.
      await this.audit.record(
        { organizationId, userId: actorUserId, actorName, action: 'party.created', entityType: 'party', entityId: row.id, metadata: { partyType } },
        db,
      );
      return { outcome: 'RECORDED', party };
    });
  }

  /** Establish a Party record as canonical identity, on a governed basis. */
  async establish(
    organizationId: string,
    actorUserId: string,
    partyId: string,
    basis: string,
    options: PartyActOptions = {},
  ): Promise<PartyWriteResult> {
    if (!(PARTY_ESTABLISHMENT_BASES as readonly string[]).includes(basis)) {
      return { outcome: 'INVALID', reason: 'NOT_A_GOVERNED_BASIS' };
    }
    if (!(await this.canEstablish(organizationId, actorUserId))) return { outcome: 'NOT_AUTHORIZED' };
    const actorName = await this.actorName(organizationId, actorUserId, options);

    return this.inTransaction(options.tx, async (db): Promise<PartyWriteResult> => {
      const existing = await this.parties.findParty(organizationId, partyId, undefined, db);
      if (!existing) return { outcome: 'NOT_FOUND' };
      if (existing.establishment.established) return { outcome: 'ALREADY_ESTABLISHED', party: existing };
      const row = await this.identities.findById(organizationId, partyId, db);
      if (!row) return { outcome: 'NOT_FOUND' };
      if (row.archivedAt || row.status === 'ARCHIVED') return { outcome: 'INVALID', reason: 'ARCHIVED' };

      const written = await this.identities.recordEstablishment(
        organizationId,
        partyId,
        { establishedByUserId: actorUserId, basis: basis as PartyEstablishmentBasis, at: new Date() },
        db,
      );
      const party = await this.parties.findParty(organizationId, partyId, undefined, db);
      if (!party) return { outcome: 'NOT_FOUND' };
      // Somebody else established it between the read and the write: their record
      // stands, and no audit entry is written for a write that did not happen.
      if (!written) return { outcome: 'ALREADY_ESTABLISHED', party };

      await this.audit.record(
        { organizationId, userId: actorUserId, actorName, action: 'party.established', entityType: 'party', entityId: partyId, metadata: { basis } },
        db,
      );
      return { outcome: 'RECORDED', party };
    });
  }

  /** The caller's transaction when given; otherwise one of this act's own. */
  private inTransaction<T>(tx: Prisma.TransactionClient | undefined, run: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  /** The session's display name when the caller has one; otherwise the member's recorded name. */
  private async actorName(organizationId: string, actorUserId: string, options: PartyActOptions): Promise<string | undefined> {
    const given = typeof options.actorName === 'string' ? options.actorName.trim() : '';
    if (given.length > 0) return given;
    const user = await this.iam.getUser(organizationId, actorUserId);
    const name = user && typeof user.name === 'string' ? user.name.trim() : '';
    return name.length > 0 ? name : undefined;
  }
}

// Party reads -- the canonical identity contract (`@emgloop/shared` party.ts)
// applied to CognitiveIdentity rows. CRM Phase Zero P0.2a.
//
// A READING, NOT A SECOND IDENTITY STORE. This repository owns no table. It reads
// `cognitive_identities` and its satellites and answers two questions the rows
// alone cannot: is this record a Party, and is it established as canonical
// identity. It never creates, merges or links anything.
//
// NO EXISTENCE PROBE. Every method takes `organizationId` first, from
// authenticated server context, and addresses a record by id inside that
// organization. There is deliberately no lookup by email, phone, name, canonical
// key or evidence value, and no cross-organization listing: a Party read must
// never tell a tenant that a person exists somewhere it cannot see. A miss --
// wrong organization, unknown id, or a non-Party type -- is `null`, and the three
// are indistinguishable to the caller.
//
// ONE GOVERNED BASIS IS PERSISTED (P0.2d): the identity row's own `established*`
// provenance, written only by `PartyService.establish` under
// `identityResolution:approve`. A MANUAL or EXPLICIT_LINK establishment with its
// actor still on record reads as governed. If that User row is ever deleted
// (SET NULL), the actor can no longer be shown and the Party reads as not
// established -- fail closed, never an invented actor.
//
// EVERYTHING ELSE RECORDED IS STILL UNGOVERNED, and this file says so rather than
// guessing. `IdentityEvidence` and `IdentityResolutionLink` carry no column that
// records an authorized actor, a recorded verification, or a Party's own
// authenticated act; a link's `establishedBy` is free text and `confirm()` records
// no actor. Those rows are read with `NO_GOVERNED_PROVENANCE`: an
// `AUTHENTICATED_ACCOUNT` evidence row does not establish a Party, and a
// `CONFIRMED` link reads as a possible match. Nothing is reclassified in storage.
//
// No confidence column is read here.

import type {
  Prisma,
  PrismaClient,
  CognitiveEntityType,
  CognitiveIdentityStatus,
  IdentityEvidenceType,
  IdentityResolutionMethod,
} from '@prisma/client';
import {
  PARTY_TYPES,
  PARTY_CONFIRMING_METHODS,
  NO_GOVERNED_PROVENANCE,
  isPartyType,
  partyEstablishment,
  partyLinkPosture,
  type PartyBasis,
  type PartyEstablishment,
  type PartyResolutionPosture,
  type PartyType,
} from '@emgloop/shared';

// The shared contract is Prisma-free; these bind it to the schema so a renamed or
// removed enum member fails the typecheck instead of silently matching nothing.
const PARTY_TYPES_ARE_ENTITY_TYPES: readonly CognitiveEntityType[] = PARTY_TYPES;
const CONFIRMING_METHODS_ARE_RESOLUTION_METHODS: readonly IdentityResolutionMethod[] =
  PARTY_CONFIRMING_METHODS;
void PARTY_TYPES_ARE_ENTITY_TYPES;
void CONFIRMING_METHODS_ARE_RESOLUTION_METHODS;

/**
 * Evidence types that could ever stand for an establishing basis. `EMAIL`,
 * `PHONE`, `CALLER_ID`, cookies, sessions and devices are absent on purpose: a
 * matching contact value is not identity, and nothing records that one was
 * verified.
 */
const EVIDENCE_BASIS: Partial<Record<IdentityEvidenceType, IdentityResolutionMethod>> = {
  AUTHENTICATED_ACCOUNT: 'AUTHENTICATED',
  EXPLICIT_LINK: 'EXPLICIT_LINK',
};

/** The client a Party read runs on: the repository's own, or a caller's transaction. */
export type PartyDb = PrismaClient | Prisma.TransactionClient;

export interface PartyView {
  id: string;
  organizationId: string;
  partyType: PartyType;
  status: CognitiveIdentityStatus;
  establishment: PartyEstablishment;
  /** The canonical record this one was superseded by, when it was. */
  supersededByIdentityId: string | null;
}

/** Bases whose persisted provenance is an authorized actor. */
const ACTOR_BASES: readonly string[] = ['MANUAL', 'EXPLICIT_LINK'];

export class PartyRepository {
  constructor(private readonly prisma: PrismaClient) {}


  /** A Party record inside the organization, or null. Non-Party types are null. */
  /**
   * `db` is a caller's transaction when the read must see that transaction's own writes (a Party
   * created earlier in the same import unit); otherwise the repository's client.
   */
  async findParty(organizationId: string, id: string, now: Date = new Date(), db: PartyDb = this.prisma): Promise<PartyView | null> {
    const row = await db.cognitiveIdentity.findFirst({ where: { id, organizationId } });
    if (!row || !isPartyType(row.entityType)) return null;
    return partyViewFrom(row, await this.recordedBases(organizationId, row.id, now, db));
  }

  /**
   * `findParty` for many ids in TWO queries, whatever the count: the records, then their
   * evidence. The same view `findParty` builds, row for row -- one definition of a Party, read
   * in bulk so a list page does not ask once per row. Ids that are not a Party of this
   * organization are absent from the map.
   */
  async findParties(organizationId: string, ids: readonly string[], now: Date = new Date()): Promise<Map<string, PartyView>> {
    const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim() !== ''))];
    const out = new Map<string, PartyView>();
    if (!organizationId?.trim() || unique.length === 0) return out;
    const rows = await this.prisma.cognitiveIdentity.findMany({ where: { organizationId, id: { in: unique } } });
    const parties = rows.filter((r) => isPartyType(r.entityType));
    if (parties.length === 0) return out;
    const evidence = await this.prisma.identityEvidence.findMany({
      where: {
        organizationId,
        identityId: { in: parties.map((r) => r.id) },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { identityId: true, evidenceType: true },
    });
    for (const row of parties) {
      out.set(row.id, partyViewFrom(row, basesFromEvidence(evidence.filter((e) => e.identityId === row.id))));
    }
    return out;
  }

  /**
   * Whether two Party records in the organization are the same Party, from the
   * links recorded between them. Null when either is not a Party record there.
   */
  async samePartyPosture(
    organizationId: string,
    partyId: string,
    otherPartyId: string,
  ): Promise<PartyResolutionPosture | null> {
    if (partyId === otherPartyId) return null;
    const [a, b] = await Promise.all([
      this.findParty(organizationId, partyId),
      this.findParty(organizationId, otherPartyId),
    ]);
    if (!a || !b) return null;
    const links = await this.prisma.identityResolutionLink.findMany({
      where: {
        organizationId,
        OR: [
          { sourceIdentityId: a.id, targetIdentityId: b.id },
          { sourceIdentityId: b.id, targetIdentityId: a.id },
        ],
      },
    });
    return partyLinkPosture(
      links.map((l) => ({ status: l.status, method: l.method, provenance: NO_GOVERNED_PROVENANCE })),
    );
  }

  private async recordedBases(organizationId: string, identityId: string, now: Date, db: PartyDb = this.prisma): Promise<PartyBasis[]> {
    const evidence = await db.identityEvidence.findMany({
      where: {
        organizationId,
        identityId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    return basesFromEvidence(evidence);
  }
}

function basesFromEvidence(evidence: readonly { evidenceType: IdentityEvidenceType }[]): PartyBasis[] {
  const bases: PartyBasis[] = [];
  for (const e of evidence) {
    const method = EVIDENCE_BASIS[e.evidenceType];
    if (method) bases.push({ method, provenance: NO_GOVERNED_PROVENANCE });
  }
  return bases;
}

/** The one construction of a PartyView from its record and its evidence bases. */
function partyViewFrom(
  row: {
    id: string;
    organizationId: string;
    entityType: CognitiveEntityType;
    status: CognitiveIdentityStatus;
    establishedAt: Date | null;
    establishmentBasis: IdentityResolutionMethod | null;
    establishedByUserId: string | null;
    supersededByIdentityId: string | null;
  },
  evidenceBases: PartyBasis[],
): PartyView {
  // Callers pass Party records only; checked again here rather than asserted.
  const entityType = row.entityType;
  if (!isPartyType(entityType)) throw new Error('partyViewFrom: not a Party record');
  const bases = [...evidenceBases];
  if (row.establishedAt && row.establishmentBasis && ACTOR_BASES.includes(row.establishmentBasis)) {
    bases.push({
      method: row.establishmentBasis,
      provenance: { ...NO_GOVERNED_PROVENANCE, authorizedActorUserId: row.establishedByUserId },
    });
  }
  return {
    id: row.id,
    organizationId: row.organizationId,
    partyType: entityType,
    status: row.status,
    establishment: partyEstablishment({ entityType, bases }),
    supersededByIdentityId: row.supersededByIdentityId ?? null,
  };
}

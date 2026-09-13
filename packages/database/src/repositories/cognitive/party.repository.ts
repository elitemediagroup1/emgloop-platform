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
// EVERY RECORDED BASIS IS UNGOVERNED TODAY, and this file says so rather than
// guessing. `IdentityEvidence` and `IdentityResolutionLink` carry no column that
// records an authorized actor acting under identity-resolution authority, a
// recorded verification, or a Party's own authenticated act; `establishedBy` is
// free text and `confirm()` records no actor. So recorded rows are read with
// `NO_GOVERNED_PROVENANCE`: an `AUTHENTICATED_ACCOUNT` evidence row does not
// establish a Party, and a `CONFIRMED` link reads as a possible match. Nothing is
// reclassified in storage -- the rows keep exactly what they say. When governed
// identity resolution records provenance, this mapping is the one place that
// changes.
//
// No confidence column is read here.

import type {
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

export interface PartyView {
  id: string;
  organizationId: string;
  partyType: PartyType;
  status: CognitiveIdentityStatus;
  establishment: PartyEstablishment;
}

export class PartyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** A Party record inside the organization, or null. Non-Party types are null. */
  async findParty(organizationId: string, id: string, now: Date = new Date()): Promise<PartyView | null> {
    const row = await this.prisma.cognitiveIdentity.findFirst({ where: { id, organizationId } });
    if (!row || !isPartyType(row.entityType)) return null;
    const bases = await this.recordedBases(organizationId, row.id, now);
    return {
      id: row.id,
      organizationId: row.organizationId,
      partyType: row.entityType,
      status: row.status,
      establishment: partyEstablishment({ entityType: row.entityType, bases }),
    };
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

  private async recordedBases(organizationId: string, identityId: string, now: Date): Promise<PartyBasis[]> {
    const evidence = await this.prisma.identityEvidence.findMany({
      where: {
        organizationId,
        identityId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    const bases: PartyBasis[] = [];
    for (const e of evidence) {
      const method = EVIDENCE_BASIS[e.evidenceType];
      if (method) bases.push({ method, provenance: NO_GOVERNED_PROVENANCE });
    }
    return bases;
  }
}

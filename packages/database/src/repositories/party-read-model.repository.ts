// Party read models -- People, Companies, the establishment review queue and one Party record.
//
// Identity slice P1. The contract is `@emgloop/shared` party-read-model.ts; the
// authorization is `PartyRecordService`, which checks identityResolution:view
// before this repository is ever asked anything.
//
// ONE DEFINITION OF "ESTABLISHED". A Party record is established exactly when
// `PartyRepository.findParty` says so: its own `established*` provenance names a
// MANUAL or EXPLICIT_LINK basis and an actor still on record. The list filters
// encode that rule in the query, and `party-read-model.test.ts` holds every listed
// row to `findParty`'s answer so the two can never drift.
//
// ORGANIZATION FIRST, ALWAYS. Every read is scoped to the organization passed in,
// which callers take from the signed session. A record from another organization,
// an unknown id and a non-Party row are all null, indistinguishably.
//
// NO LOOKUP BY ANYTHING BUT ID, AND NO CONTACT VALUES. Lists page by an opaque
// keyset cursor; there is no search by name, email, phone, canonical key or
// evidence (universal search is deferred, PD-F-10). No read model returns a
// contact value.
//
// THE REVIEW QUEUE SHOWS GOVERNED RECORDS ONLY. Unestablished Party records
// created by `PartyService.create` carry a minted `party:<uuid>` canonical key.
// Cognitive subjects the dormant resolver would create carry other keys and never
// appear here.
//
// READ-ONLY. Nothing here writes.

import type { PrismaClient, CognitiveIdentity, IdentityResolutionMethod } from '@prisma/client';
import {
  IDENTITY_ESTABLISHMENT_METHODS_AVAILABLE_NOW,
  NO_GOVERNED_PROVENANCE,
  PARTY_POSTURE_LIMITATIONS,
  PARTY_READ_MODEL_VERSION,
  isPartyType,
  partyEstablishment,
  partyLinkPosture,
  partyListLimit,
  type LinkedIntakeRecordRefV1,
  type PartyEstablishmentViewV1,
  type PartyListItemV1,
  type PartyListPageV1,
  type PartyRecordV1,
  type PartyType,
  type UserRefV1,
} from '@emgloop/shared';
import { PartyReferenceRepository } from './party-reference.repository';

/** A cursor that was not produced by this repository. Callers treat it as a bad request. */
export class PartyListCursorError extends Error {
  constructor() {
    super('Invalid party list cursor');
    this.name = 'PartyListCursorError';
  }
}

const GOVERNED_KEY_PREFIX = 'party:';
const ACTOR_BASES = [...IDENTITY_ESTABLISHMENT_METHODS_AVAILABLE_NOW] as IdentityResolutionMethod[];

interface Cursor {
  at: Date;
  id: string;
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ a: at.toISOString(), i: id }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { a?: unknown; i?: unknown };
    const at = typeof parsed.a === 'string' ? new Date(parsed.a) : null;
    if (!at || Number.isNaN(at.getTime()) || typeof parsed.i !== 'string' || parsed.i.length === 0) {
      throw new PartyListCursorError();
    }
    return { at, id: parsed.i };
  } catch {
    throw new PartyListCursorError();
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The query form of `PartyRepository.findParty`'s establishment rule. */
const ESTABLISHED = {
  establishedAt: { not: null },
  establishmentBasis: { in: ACTOR_BASES },
  establishedByUserId: { not: null },
} as const;

const NOT_ESTABLISHED = {
  OR: [
    { establishedAt: null },
    { establishedByUserId: null },
    { establishmentBasis: null },
    { establishmentBasis: { notIn: ACTOR_BASES } },
  ],
};

/** Current, not superseded, not archived. */
const CURRENT = {
  supersededByIdentityId: null,
  archivedAt: null,
  status: { not: 'ARCHIVED' as const },
};

export interface PartyListOptions {
  cursor?: string | null;
  limit?: number;
}

export interface PartyReadModelRepositoryDeps {
  references?: Pick<PartyReferenceRepository, 'resolve'>;
}

export class PartyReadModelRepository {
  private readonly references: Pick<PartyReferenceRepository, 'resolve'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: PartyReadModelRepositoryDeps = {},
  ) {
    this.references = deps.references ?? new PartyReferenceRepository(prisma);
  }

  /** People (PERSON) or Companies (COMPANY): established, non-superseded, non-archived. Newest establishment first. */
  async listEstablished(organizationId: string, partyType: PartyType, opts: PartyListOptions = {}): Promise<PartyListPageV1> {
    if (!nonEmpty(organizationId) || !isPartyType(partyType)) return { items: [], nextCursor: null };
    const limit = partyListLimit(opts.limit);
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    const rows = await this.prisma.cognitiveIdentity.findMany({
      where: {
        organizationId,
        entityType: partyType,
        ...ESTABLISHED,
        ...CURRENT,
        ...(cursor
          ? { OR: [{ establishedAt: { lt: cursor.at } }, { establishedAt: cursor.at, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ establishedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const users = await this.userRefs(organizationId, page.map((r) => r.establishedByUserId));
    return {
      items: page.map((r) => this.listItem(r, users)),
      nextCursor: rows.length > limit && last?.establishedAt ? encodeCursor(last.establishedAt, last.id) : null,
    };
  }

  /** Governed Party records that are not established, for establishment review. Newest first. */
  async listUnestablished(
    organizationId: string,
    opts: PartyListOptions & { partyType?: PartyType | null } = {},
  ): Promise<PartyListPageV1> {
    if (!nonEmpty(organizationId)) return { items: [], nextCursor: null };
    if (opts.partyType !== undefined && opts.partyType !== null && !isPartyType(opts.partyType)) {
      return { items: [], nextCursor: null };
    }
    const limit = partyListLimit(opts.limit);
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    const rows = await this.prisma.cognitiveIdentity.findMany({
      where: {
        organizationId,
        entityType: opts.partyType ? opts.partyType : { in: ['PERSON', 'COMPANY'] },
        canonicalKey: { startsWith: GOVERNED_KEY_PREFIX },
        ...CURRENT,
        AND: [
          NOT_ESTABLISHED,
          ...(cursor
            ? [{ OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] }]
            : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const users = await this.userRefs(organizationId, page.map((r) => r.establishedByUserId));
    return {
      items: page.map((r) => this.listItem(r, users)),
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /** One Party record, as asked for. A superseded record names its current record; nothing is substituted. */
  async getRecord(organizationId: string, partyId: string): Promise<PartyRecordV1 | null> {
    if (!nonEmpty(organizationId) || !nonEmpty(partyId)) return null;
    const resolution = await this.references.resolve(organizationId, partyId);
    if (resolution.state === 'NOT_FOUND') return null;
    const row = await this.prisma.cognitiveIdentity.findFirst({ where: { id: partyId, organizationId } });
    if (!row || !isPartyType(row.entityType)) return null;

    const [links, intake] = await Promise.all([
      this.prisma.identityResolutionLink.findMany({
        where: { organizationId, OR: [{ sourceIdentityId: row.id }, { targetIdentityId: row.id }] },
      }),
      this.prisma.customerPartyLink.findMany({
        where: { organizationId, partyId: row.id },
        orderBy: [{ linkedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const users = await this.userRefs(organizationId, [
      row.establishedByUserId,
      ...intake.flatMap((l) => [l.linkedByUserId, l.reversedByUserId]),
    ]);
    const establishment = this.establishmentView(row, users);
    const linkedIntakeRecords: LinkedIntakeRecordRefV1[] = intake
      .map((l) => ({
        linkId: l.id,
        customerId: l.customerId,
        state: l.reversedAt ? ('REVERSED' as const) : ('ACTIVE' as const),
        basis: l.basis,
        linkedAt: l.linkedAt.toISOString(),
        linkedBy: this.userRef(l.linkedByUserId, users),
        reversedAt: l.reversedAt ? l.reversedAt.toISOString() : null,
        reversedBy: this.userRef(l.reversedByUserId, users),
        reversalReason: l.reversalReason ?? null,
      }))
      .sort((a, b) => (a.state === b.state ? 0 : a.state === 'ACTIVE' ? -1 : 1));

    return {
      contractVersion: PARTY_READ_MODEL_VERSION,
      partyId: row.id,
      partyType: row.entityType,
      displayName: row.displayName ?? null,
      reference:
        resolution.state === 'SUPERSEDED'
          ? { state: 'SUPERSEDED', canonicalPartyId: resolution.canonicalPartyId }
          : { state: resolution.state, canonicalPartyId: null },
      archived: row.status === 'ARCHIVED' || Boolean(row.archivedAt),
      establishment,
      posture: {
        establishment: establishment.established ? 'ESTABLISHED' : 'NOT_ESTABLISHED',
        basis: establishment.basis,
        sameParty: partyLinkPosture(
          links.map((l) => ({ status: l.status, method: l.method, provenance: NO_GOVERNED_PROVENANCE })),
        ),
        evidenceTier: 'NOT_AVAILABLE',
        limitations: [...PARTY_POSTURE_LIMITATIONS],
      },
      linkedIntakeRecords,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private listItem(row: CognitiveIdentity, users: Map<string, UserRefV1>): PartyListItemV1 {
    return {
      contractVersion: PARTY_READ_MODEL_VERSION,
      partyId: row.id,
      partyType: row.entityType as PartyType,
      displayName: row.displayName ?? null,
      establishment: this.establishmentView(row, users),
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Mirrors `PartyRepository.findParty`: only the row's own actor-attributed basis can establish it. */
  private establishmentView(row: CognitiveIdentity, users: Map<string, UserRefV1>): PartyEstablishmentViewV1 {
    const actorBasis =
      row.establishedAt && row.establishmentBasis && (ACTOR_BASES as string[]).includes(row.establishmentBasis);
    const result = partyEstablishment({
      entityType: row.entityType,
      bases: actorBasis
        ? [{ method: row.establishmentBasis as string, provenance: { ...NO_GOVERNED_PROVENANCE, authorizedActorUserId: row.establishedByUserId } }]
        : [],
    });
    return {
      established: result.established,
      basis: result.basis,
      establishedAt: result.established && row.establishedAt ? row.establishedAt.toISOString() : null,
      establishedBy: result.established ? this.userRef(row.establishedByUserId, users) : null,
    };
  }

  private userRef(userId: string | null, users: Map<string, UserRefV1>): UserRefV1 | null {
    if (!userId) return null;
    return users.get(userId) ?? { userId, displayName: null };
  }

  private async userRefs(organizationId: string, ids: readonly (string | null)[]): Promise<Map<string, UserRefV1>> {
    const unique = [...new Set(ids.filter((id): id is string => nonEmpty(id)))];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { organizationId, id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(
      rows.map((u) => [u.id, { userId: u.id, displayName: u.name && u.name.trim().length > 0 ? u.name.trim() : null }]),
    );
  }
}

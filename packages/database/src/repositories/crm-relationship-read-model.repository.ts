// Reading Relationships. Slice R3-A3.
//
// Every Party a Relationship names is resolved through the ONE Party Reference
// authority -- the same `PartyReferenceRepository` the write path uses. A read
// follows supersession forward and reports it; a write refuses it. The difference is
// deliberate, and the shared contract holds both.
//
// A STORED ID IS NEVER REWRITTEN. Not here, not to shorten a chain, not to tidy a
// list. A superseded side shows the id the record was written with AND the canonical
// id, so a reader can see both facts rather than being handed a quiet correction.
//
// A CHAIN THAT CANNOT BE FOLLOWED IS UNAVAILABLE, NOT ABSENT. A cycle, more than
// eight hops, a change of Party type or another organization's record all resolve to
// UNAVAILABLE, and the Relationship stays readable with that side marked. Nothing is
// guessed, and the record does not disappear because one reference broke.
//
// DUPLICATES ARE REPORTED, NEVER MERGED. Two non-voided Relationships of one kind
// can resolve to the same canonical sides after a supersession; the database cannot
// see it because the stored ids differ. This finds them, bounded, for a person to
// resolve by ending or voiding one with a reason.
//
// READS ARE ORGANIZATION-SCOPED AND BOUNDED. Keyset pagination, an opaque cursor,
// and a hard page limit -- the same shape as the Party read model.

import type { PrismaClient, CrmParticipant, CrmRelationship, CrmRelationshipEvent } from '@prisma/client';
import {
  CRM_RELATIONSHIP_READ_MODEL_VERSION,
  crmRelationshipKind,
  crmRelationshipListLimit,
  crmRelationshipsResolveAlike,
  type CrmParticipantRole,
  type CrmParticipantRoleFamily,
  type CrmParticipantState,
  type CrmPartyReferenceViewV1,
  type CrmRelationshipDuplicateV1,
  type CrmRelationshipHistoryEntryV1,
  type CrmRelationshipListItemV1,
  type CrmRelationshipListPageV1,
  type CrmRelationshipParticipantViewV1,
  type CrmRelationshipRecordV1,
  type CrmRelationshipSide,
  type CrmRelationshipSideViewV1,
  type CrmRelationshipState,
  type CrmRelationshipStructure,
} from '@emgloop/shared';

import { PartyReferenceRepository } from './party-reference.repository';

/** A cursor this repository did not produce. Callers treat it as a bad request. */
export class CrmRelationshipCursorError extends Error {
  constructor() {
    super('Invalid relationship list cursor');
    this.name = 'CrmRelationshipCursorError';
  }
}

export interface CrmRelationshipListOptions {
  readonly cursor?: string | null;
  readonly limit?: number | null;
  /** Default excludes VOIDED: a record entered in error is not part of the working list. */
  readonly includeVoided?: boolean;
}

export interface CrmRelationshipReadModelDeps {
  references?: Pick<PartyReferenceRepository, 'resolve'>;
}

/** How many candidate duplicates one record's diagnostic will examine. */
const DUPLICATE_SCAN_LIMIT = 50;

export class CrmRelationshipReadModelRepository {
  private readonly references: Pick<PartyReferenceRepository, 'resolve'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmRelationshipReadModelDeps = {},
  ) {
    this.references = deps.references ?? new PartyReferenceRepository(prisma);
  }

  /** One page, newest first, keyset over (createdAt, id). */
  async list(organizationId: string, options: CrmRelationshipListOptions = {}): Promise<CrmRelationshipListPageV1> {
    if (!organizationId?.trim()) return { contractVersion: CRM_RELATIONSHIP_READ_MODEL_VERSION, items: [], nextCursor: null };
    const limit = crmRelationshipListLimit(options.limit);
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;

    const rows = await this.prisma.crmRelationship.findMany({
      where: {
        organizationId,
        ...(options.includeVoided === true ? {} : { state: { not: 'VOIDED' } }),
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    const items = await Promise.all(page.map((row) => this.listItem(organizationId, row)));
    const last = page[page.length - 1];
    return {
      contractVersion: CRM_RELATIONSHIP_READ_MODEL_VERSION,
      items,
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /** Relationships an established Party takes part in, through its ACTIVE participations. */
  async forParty(organizationId: string, partyId: string, options: CrmRelationshipListOptions = {}): Promise<CrmRelationshipListPageV1> {
    const empty = { contractVersion: CRM_RELATIONSHIP_READ_MODEL_VERSION, items: [], nextCursor: null } as const;
    if (!organizationId?.trim() || !partyId?.trim()) return empty;
    const limit = crmRelationshipListLimit(options.limit);

    // The id as stored. A Party that has since been superseded still appears under
    // the id its participations were written with -- because that is what happened.
    const participations = await this.prisma.crmParticipant.findMany({
      where: { organizationId, partyId, state: 'ACTIVE' },
      select: { relationshipId: true },
      take: DUPLICATE_SCAN_LIMIT * 2,
    });
    const ids = [...new Set(participations.map((p) => p.relationshipId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return empty;

    const rows = await this.prisma.crmRelationship.findMany({
      where: {
        organizationId,
        id: { in: ids },
        ...(options.includeVoided === true ? {} : { state: { not: 'VOIDED' } }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return {
      contractVersion: CRM_RELATIONSHIP_READ_MODEL_VERSION,
      items: await Promise.all(rows.map((row) => this.listItem(organizationId, row))),
      nextCursor: null,
    };
  }

  /** One Relationship, with its participants, its whole history, and its duplicate diagnostic. */
  async getRecord(organizationId: string, relationshipId: string): Promise<CrmRelationshipRecordV1 | null> {
    if (!organizationId?.trim() || !relationshipId?.trim()) return null;
    const row = await this.prisma.crmRelationship.findFirst({ where: { id: relationshipId, organizationId } });
    if (!row) return null;

    const [participantRows, eventRows] = await Promise.all([
      this.prisma.crmParticipant.findMany({
        where: { organizationId, relationshipId },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.crmRelationshipEvent.findMany({
        where: { organizationId, relationshipId },
        orderBy: { sequence: 'asc' },
      }),
    ]);

    const views = new Map<string, CrmPartyReferenceViewV1>();
    for (const partyId of new Set(participantRows.map((p) => p.partyId))) {
      views.set(partyId, await this.partyView(organizationId, partyId));
    }
    const base = this.itemFrom(row, participantRows, views);

    return {
      ...base,
      description: row.description,
      participants: participantRows.map((p) => this.participantView(p, views)),
      history: eventRows.map(historyEntry),
      duplicates: await this.duplicates(organizationId, row, base.sides),
    };
  }

  // --- Internals ----------------------------------------------------------------------

  private async listItem(organizationId: string, row: CrmRelationship): Promise<CrmRelationshipListItemV1> {
    const participants = await this.prisma.crmParticipant.findMany({
      where: { organizationId, relationshipId: row.id },
      select: { partyId: true, role: true, side: true, state: true },
    });
    const views = new Map<string, CrmPartyReferenceViewV1>();
    for (const partyId of new Set(participants.filter((p) => p.side !== null).map((p) => p.partyId))) {
      views.set(partyId, await this.partyView(organizationId, partyId));
    }
    return this.itemFrom(row, participants, views);
  }

  private itemFrom(
    row: CrmRelationship,
    participants: readonly { partyId: string; role: string; side: string | null; state: string }[],
    views: ReadonlyMap<string, CrmPartyReferenceViewV1>,
  ): CrmRelationshipListItemV1 {
    const definition = crmRelationshipKind(row.kind);
    const sides: CrmRelationshipSideViewV1[] = participants
      .filter((p) => p.side !== null)
      .map((p) => ({
        side: p.side as CrmRelationshipSide,
        label: definition?.sides.find((s) => s.side === p.side)?.label ?? p.side!,
        party: views.get(p.partyId) ?? { state: 'UNAVAILABLE', partyId: p.partyId },
        role: p.role as CrmParticipantRole,
      }))
      .sort((a, b) => (a.side < b.side ? -1 : 1));

    return {
      relationshipId: row.id,
      kind: row.kind,
      kindLabel: definition?.label ?? row.kind,
      structure: row.structure as CrmRelationshipStructure,
      state: row.state as CrmRelationshipState,
      sides,
      label: row.label,
      ownerUserId: row.ownerUserId,
      businessStartDate: dateOnly(row.businessStartDate),
      businessEndDate: dateOnly(row.businessEndDate),
      createdAt: row.createdAt.toISOString(),
      activeParticipantCount: participants.filter((p) => p.state === 'ACTIVE').length,
    };
  }

  private participantView(row: CrmParticipant, views: ReadonlyMap<string, CrmPartyReferenceViewV1>): CrmRelationshipParticipantViewV1 {
    return {
      participantId: row.id,
      party: views.get(row.partyId) ?? { state: 'UNAVAILABLE', partyId: row.partyId },
      role: row.role as CrmParticipantRole,
      roleFamily: row.roleFamily as CrmParticipantRoleFamily,
      side: row.side as CrmRelationshipSide | null,
      actsForSide: row.actsForSide as CrmRelationshipSide | null,
      state: row.state as CrmParticipantState,
      effectiveFrom: dateOnly(row.effectiveFrom),
      effectiveTo: dateOnly(row.effectiveTo),
      // That a reason exists, never the words: they can name a person.
      reasonRecorded: Boolean(row.endReason ?? row.voidReason),
    };
  }

  /** The one Party authority, asked the one way. Nothing here interprets its answer. */
  private async partyView(organizationId: string, partyId: string): Promise<CrmPartyReferenceViewV1> {
    const resolution = await this.references.resolve(organizationId, partyId);
    if (resolution.state === 'ESTABLISHED') {
      return { state: 'ESTABLISHED', partyId: resolution.partyId, partyType: resolution.partyType, archived: resolution.archived };
    }
    if (resolution.state === 'NOT_ESTABLISHED') {
      return { state: 'NOT_ESTABLISHED', partyId: resolution.partyId, partyType: resolution.partyType, archived: resolution.archived };
    }
    if (resolution.state === 'SUPERSEDED') {
      return {
        state: 'SUPERSEDED',
        // The id the record carries. It stays exactly as written.
        partyId: resolution.partyId,
        canonicalPartyId: resolution.canonicalPartyId,
        partyType: resolution.partyType,
        canonicalArchived: resolution.canonicalArchived,
      };
    }
    return { state: 'UNAVAILABLE', partyId };
  }

  /**
   * Other non-voided Relationships of the same kind that resolve to the same
   * canonical sides. Bounded: only Relationships sharing one of this record's own
   * canonical Parties are examined, and at most DUPLICATE_SCAN_LIMIT of them.
   */
  private async duplicates(
    organizationId: string,
    row: CrmRelationship,
    sides: readonly CrmRelationshipSideViewV1[],
  ): Promise<CrmRelationshipDuplicateV1[]> {
    if (row.state === 'VOIDED' || sides.length === 0) return [];
    const canonicalIds = sides
      .map((s) => (s.party.state === 'ESTABLISHED' ? s.party.partyId : s.party.state === 'SUPERSEDED' ? s.party.canonicalPartyId : null))
      .filter((id): id is string => id !== null);
    // A side nobody can resolve is not evidence of sameness.
    if (canonicalIds.length !== sides.length) return [];

    const storedIds = sides.map((s) => s.party.partyId);
    const candidates = await this.prisma.crmParticipant.findMany({
      where: {
        organizationId,
        state: 'ACTIVE',
        side: { not: null },
        partyId: { in: [...new Set([...canonicalIds, ...storedIds])] },
        relationshipId: { not: row.id },
      },
      select: { relationshipId: true },
      take: DUPLICATE_SCAN_LIMIT,
    });
    const ids = [...new Set(candidates.map((c) => c.relationshipId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return [];

    const others = await this.prisma.crmRelationship.findMany({
      where: { organizationId, id: { in: ids }, kind: row.kind, state: { not: 'VOIDED' } },
      take: DUPLICATE_SCAN_LIMIT,
    });

    const out: CrmRelationshipDuplicateV1[] = [];
    for (const other of others) {
      const item = await this.listItem(organizationId, other);
      if (crmRelationshipsResolveAlike({ kind: row.kind, sides }, { kind: item.kind, sides: item.sides })) {
        out.push({ relationshipId: other.id, state: other.state as CrmRelationshipState, reason: 'SAME_CANONICAL_SIDES' });
      }
    }
    return out;
  }
}

function historyEntry(e: CrmRelationshipEvent): CrmRelationshipHistoryEntryV1 {
  return {
    sequence: e.sequence,
    type: e.type,
    occurredAt: e.occurredAt.toISOString(),
    occurredAtBasis: e.occurredAtBasis,
    recordedAt: e.recordedAt.toISOString(),
    actorUserId: e.actorUserId,
    participantId: e.participantId,
    fromState: e.fromState,
    toState: e.toState,
    // The words stay on the event row, read under its own authority.
    reasonRecorded: Boolean(e.reason && e.reason.trim() !== ''),
  };
}

/** A calendar date, as the business stated it. Never a timestamp pretending to be one. */
function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ a: at.toISOString(), i: id }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { at: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { a?: unknown; i?: unknown };
    if (typeof parsed.a !== 'string' || typeof parsed.i !== 'string' || !Number.isFinite(Date.parse(parsed.a))) {
      throw new CrmRelationshipCursorError();
    }
    return { at: new Date(parsed.a), id: parsed.i };
  } catch {
    throw new CrmRelationshipCursorError();
  }
}

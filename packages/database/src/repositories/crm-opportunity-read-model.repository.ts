// Reading CRM Opportunities across an organization (CRM slice 4, 2026-10-06).
//
// Persistence only. `CrmOpportunityReadService` authorizes (PD-F-11 VIEW) before anything here
// runs and decides whether names and notes are readable; this file is not a security boundary.
//
// A PROJECTION, NEVER AN AUTHORITY. It reads the Opportunity, its transition log, its
// Participants (`crm_participants`, opportunity arc), its creator reference, its owner and its
// campaigns, and writes nothing. A stored Party id is never rewritten: every Party goes through
// the ONE Party Reference contract, which reports supersession instead of swapping the id.
//
// BOUNDED, NOT PER ROW. A page costs a fixed number of queries whatever its size: the page, its
// ACTIVE Participants, the Party records and their evidence (`resolveMany`), names, members and
// creator profiles -- one query each. Only a SUPERSEDED reference walks further, one query per
// hop, which is rare and capped by the contract's hop limit. The Relationship list asks once per
// row; this deliberately does not copy it.
//
// ORGANIZATION-SCOPED EVERYWHERE. Every query names `organizationId`. A member id, Party id or
// Opportunity id from another organization resolves to UNAVAILABLE or not-found, never to the
// other tenant's record.
//
// SEARCH IS DISCOVERY, NOT IDENTITY. Text matches an Opportunity's title or exact id, and -- only
// when the viewer may read names -- the recorded name of its creator, an ACTIVE BRAND or
// PRIMARY_CONTACT, or its owner. It never searches contact values, never matches across
// organizations, and nothing it finds is written anywhere.

import type { CrmOpportunity, CrmOpportunityTransition, CrmParticipant, Prisma, PrismaClient } from '@prisma/client';
import {
  CRM_OPPORTUNITY_READ_MODEL_VERSION,
  CRM_OPPORTUNITY_SEARCH_MAX,
  crmOpportunityGaps,
  crmOpportunityListLimit,
  type CrmOpportunityListFiltersV1,
  type CrmOpportunityListItemV1,
  type CrmOpportunityListPageV1,
  type CrmOpportunityParticipantViewV1,
  type CrmOpportunityPartyRefV1,
  type CrmOpportunityRecordV1,
  type CrmOpportunityTransitionViewV1,
  type CrmOpportunityUserRefV1,
  type PartyReferenceResolution,
} from '@emgloop/shared';

import { PartyReferenceRepository } from './party-reference.repository';

/** A cursor this repository did not produce. Callers treat it as a bad request. */
export class CrmOpportunityCursorError extends Error {
  constructor() {
    super('Invalid opportunity list cursor');
    this.name = 'CrmOpportunityCursorError';
  }
}

export interface CrmOpportunityListOptions {
  readonly cursor?: string | null;
  readonly limit?: number | null;
  readonly filters?: CrmOpportunityListFiltersV1;
}

/** What the read service decided about this viewer. Never inferred here. */
export interface CrmOpportunityReadScope {
  readonly organizationId: string;
  /** The viewer, from the signed session: what "owner = ME" means. */
  readonly viewerUserId: string;
  /** Party names may be shown and searched (`identityResolution:view`). */
  readonly namesReadable: boolean;
  /** Free-text notes may be shown (EMPLOYEE and above). */
  readonly notesReadable: boolean;
}

export interface CrmOpportunityReadModelDeps {
  references?: Pick<PartyReferenceRepository, 'resolveMany'>;
}

/** How many Parties or members one name search may match before it stops looking. */
export const CRM_OPPORTUNITY_NAME_MATCH_LIMIT = 200;
/** How many stage labels and owners the filter options carry. */
const OPTION_LIMIT = 100;

const PARTY_ROLES = { BRAND: 'BRAND', PRIMARY_CONTACT: 'PRIMARY_CONTACT' } as const;

export class CrmOpportunityReadModelRepository {
  private readonly references: Pick<PartyReferenceRepository, 'resolveMany'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmOpportunityReadModelDeps = {},
  ) {
    this.references = deps.references ?? new PartyReferenceRepository(prisma);
  }

  /** One page, newest first, keyset over (createdAt, id). Filters and search narrow it in the database. */
  async list(scope: CrmOpportunityReadScope, options: CrmOpportunityListOptions = {}): Promise<CrmOpportunityListPageV1> {
    const { organizationId } = scope;
    const empty: CrmOpportunityListPageV1 = {
      contractVersion: CRM_OPPORTUNITY_READ_MODEL_VERSION,
      items: [],
      nextCursor: null,
      namesReadable: scope.namesReadable,
      stageOptions: [],
      ownerOptions: [],
    };
    if (!organizationId?.trim()) return empty;
    const limit = crmOpportunityListLimit(options.limit);
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;

    const where: Prisma.CrmOpportunityWhereInput = {
      AND: [
        { organizationId },
        ...(await this.filterClauses(scope, options.filters ?? {})),
        ...(cursor ? [{ OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] }] : []),
      ],
    };

    const [rows, stageRows, ownerRows] = await Promise.all([
      this.prisma.crmOpportunity.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 }),
      this.prisma.crmOpportunity.findMany({
        where: { organizationId },
        distinct: ['stage'],
        select: { stage: true },
        orderBy: { stage: 'asc' },
        take: OPTION_LIMIT,
      }),
      this.prisma.crmOpportunity.findMany({
        where: { organizationId, ownerUserId: { not: null } },
        distinct: ['ownerUserId'],
        select: { ownerUserId: true },
        take: OPTION_LIMIT,
      }),
    ]);

    const page = rows.slice(0, limit);
    const participants = page.length
      ? await this.prisma.crmParticipant.findMany({
          where: { organizationId, opportunityId: { in: page.map((r) => r.id) }, state: 'ACTIVE' },
          orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    const ownerOptionIds = ownerRows.map((r) => r.ownerUserId).filter((id): id is string => id !== null);
    const lookups = await this.lookups(scope, {
      partyIds: [...page.map((r) => r.creatorPartyId), ...participants.map((p) => p.partyId)],
      userIds: [...page.map((r) => r.ownerUserId), ...ownerOptionIds],
      creatorPartyIds: page.map((r) => r.creatorPartyId),
    });

    const byOpportunity = groupBy(participants, (p) => p.opportunityId ?? '');
    const items = page.map((row) => this.listItem(row, byOpportunity.get(row.id) ?? [], lookups));
    const last = page[page.length - 1];
    return {
      ...empty,
      items,
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
      stageOptions: stageRows.map((r) => r.stage),
      ownerOptions: ownerOptionIds
        .map((id) => lookups.user(id))
        .filter((ref): ref is CrmOpportunityUserRefV1 => ref !== null && ref.state === 'MEMBER')
        .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? '') || a.userId.localeCompare(b.userId)),
    };
  }

  /** One Opportunity in this organization, or null -- another tenant's id is simply not found. */
  async getRecord(scope: CrmOpportunityReadScope, opportunityId: string): Promise<CrmOpportunityRecordV1 | null> {
    const { organizationId } = scope;
    if (!organizationId?.trim() || !opportunityId?.trim()) return null;
    const row = await this.prisma.crmOpportunity.findFirst({
      where: { id: opportunityId, organizationId },
      include: {
        transitions: { where: { organizationId }, orderBy: { sequence: 'asc' } },
        campaigns: { where: { organizationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, name: true, state: true } },
        participants: { where: { organizationId }, orderBy: [{ addedAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!row) return null;
    const relationship = row.relationshipId
      ? await this.prisma.crmRelationship.findFirst({ where: { id: row.relationshipId, organizationId }, select: { id: true, kind: true } })
      : null;

    const lookups = await this.lookups(scope, {
      partyIds: [row.creatorPartyId, ...row.participants.map((p) => p.partyId)],
      userIds: [
        row.ownerUserId,
        row.createdByUserId,
        row.forecastAuthoredByUserId,
        ...row.participants.map((p) => p.addedByUserId),
        ...row.transitions.map((t) => t.actorUserId),
      ],
      creatorPartyIds: [row.creatorPartyId],
    });
    const active = row.participants.filter((p) => p.state === 'ACTIVE');
    const notes = row.internalNotes?.trim();

    return {
      ...this.listItem(row, active, lookups),
      createdBy: lookups.user(row.createdByUserId),
      // Current first, then history; each oldest first. ENDED and VOIDED stay exactly as recorded.
      participants: [...active, ...row.participants.filter((p) => p.state !== 'ACTIVE')].map((p) => participantView(p, lookups)),
      transitions: row.transitions.map((t) => transitionView(t, lookups, scope.notesReadable)),
      forecast: {
        probability: row.forecastProbability,
        authoredBy: lookups.user(row.forecastAuthoredByUserId),
        authoredAt: row.forecastAuthoredAt ? row.forecastAuthoredAt.toISOString() : null,
        amountMinor: row.amountMinor,
        currency: row.currency,
        expectedCloseDate: dateOnly(row.expectedCloseDate),
      },
      outcome: row.outcome,
      lossReason: row.lossReason,
      relationship: relationship ? { relationshipId: relationship.id, kind: relationship.kind } : null,
      campaigns: row.campaigns.map((c) => ({ campaignId: c.id, name: c.name, state: c.state })),
      creatorDesignation: {
        creatorVisibleState: row.creatorVisibleState,
        brandVisibleToCreator: row.brandVisibleToCreator,
        summaryForCreator: row.summaryForCreator,
      },
      notes: !scope.notesReadable ? { state: 'WITHHELD' } : notes ? { state: 'SHOWN', text: row.internalNotes ?? '' } : { state: 'EMPTY' },
    };
  }

  // --- Internals -------------------------------------------------------------------------

  private listItem(row: CrmOpportunity, active: readonly CrmParticipant[], lookups: Lookups): CrmOpportunityListItemV1 {
    const brands = active.filter((p) => p.role === PARTY_ROLES.BRAND && p.state === 'ACTIVE').map((p) => lookups.party(p.partyId));
    const primaryContacts = active
      .filter((p) => p.role === PARTY_ROLES.PRIMARY_CONTACT && p.state === 'ACTIVE')
      .map((p) => lookups.party(p.partyId));
    const owner = lookups.user(row.ownerUserId);
    return {
      opportunityId: row.id,
      title: row.title,
      category: row.category,
      stage: row.stage,
      creator: lookups.party(row.creatorPartyId),
      creatorProfileId: lookups.creatorProfile(row.creatorPartyId),
      brands,
      primaryContacts,
      owner,
      gaps: crmOpportunityGaps({ owner, brands, primaryContacts }),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Every Party, member and creator profile a page names, in a fixed number of queries. */
  private async lookups(
    scope: CrmOpportunityReadScope,
    wanted: { partyIds: readonly string[]; userIds: readonly (string | null)[]; creatorPartyIds: readonly string[] },
  ): Promise<Lookups> {
    const { organizationId } = scope;
    const partyIds = unique(wanted.partyIds);
    const userIds = unique(wanted.userIds.filter((id): id is string => typeof id === 'string'));
    const creatorPartyIds = unique(wanted.creatorPartyIds);

    const [resolutions, users, profiles] = await Promise.all([
      partyIds.length ? this.references.resolveMany(organizationId, partyIds) : Promise.resolve(new Map<string, PartyReferenceResolution>()),
      userIds.length
        ? this.prisma.user.findMany({ where: { organizationId, id: { in: userIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      creatorPartyIds.length
        ? this.prisma.creatorProfile.findMany({ where: { organizationId, partyId: { in: creatorPartyIds } }, select: { id: true, partyId: true } })
        : Promise.resolve([]),
    ]);

    // Names only when the viewer may read Party records -- the same gate People uses.
    const nameIds = scope.namesReadable
      ? unique([
          ...partyIds,
          ...[...resolutions.values()].flatMap((r) => (r.state === 'SUPERSEDED' ? [r.canonicalPartyId] : [])),
        ])
      : [];
    const nameRows = nameIds.length
      ? await this.prisma.cognitiveIdentity.findMany({
          where: { organizationId, id: { in: nameIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const names = new Map(nameRows.map((r) => [r.id, nonBlank(r.displayName)]));
    const members = new Map(users.map((u) => [u.id, nonBlank(u.name)]));
    const creatorProfiles = new Map(profiles.map((p) => [p.partyId, p.id]));

    return {
      party: (partyId) => partyRef(partyId, resolutions.get(partyId), names),
      user: (userId) => {
        if (!userId) return null;
        return members.has(userId)
          ? { state: 'MEMBER', userId, displayName: members.get(userId) ?? null }
          : { state: 'UNAVAILABLE', userId, displayName: null };
      },
      creatorProfile: (partyId) => creatorProfiles.get(partyId) ?? null,
    };
  }

  private async filterClauses(scope: CrmOpportunityReadScope, filters: CrmOpportunityListFiltersV1): Promise<Prisma.CrmOpportunityWhereInput[]> {
    const { organizationId } = scope;
    const clauses: Prisma.CrmOpportunityWhereInput[] = [];

    const owner = nonBlank(filters.owner);
    if (owner === 'ME') clauses.push({ ownerUserId: scope.viewerUserId });
    else if (owner === 'NONE') clauses.push({ ownerUserId: null });
    else if (owner) clauses.push({ ownerUserId: owner });

    const category = nonBlank(filters.category);
    if (category) clauses.push({ category });
    const stage = nonBlank(filters.stage);
    if (stage) clauses.push({ stage });
    const creator = nonBlank(filters.creatorPartyId);
    if (creator) clauses.push({ creatorPartyId: creator });

    const hasRole = (role: string): Prisma.CrmOpportunityWhereInput => ({
      participants: { some: { organizationId, role, state: 'ACTIVE' } },
    });
    const lacksRole = (role: string): Prisma.CrmOpportunityWhereInput => ({
      participants: { none: { organizationId, role, state: 'ACTIVE' } },
    });
    if (filters.brand === 'PRESENT') clauses.push(hasRole(PARTY_ROLES.BRAND));
    if (filters.brand === 'MISSING') clauses.push(lacksRole(PARTY_ROLES.BRAND));
    if (filters.primaryContact === 'PRESENT') clauses.push(hasRole(PARTY_ROLES.PRIMARY_CONTACT));
    if (filters.primaryContact === 'MISSING') clauses.push(lacksRole(PARTY_ROLES.PRIMARY_CONTACT));

    const q = nonBlank(filters.q)?.slice(0, CRM_OPPORTUNITY_SEARCH_MAX);
    if (q) clauses.push({ OR: await this.searchClauses(scope, q) });
    return clauses;
  }

  private async searchClauses(scope: CrmOpportunityReadScope, q: string): Promise<Prisma.CrmOpportunityWhereInput[]> {
    const { organizationId } = scope;
    const out: Prisma.CrmOpportunityWhereInput[] = [
      { title: { contains: q, mode: 'insensitive' } },
      { stage: { contains: q, mode: 'insensitive' } },
      { category: { contains: q, mode: 'insensitive' } },
      { id: q },
    ];
    // A viewer who may not read names may not find records by them either.
    if (!scope.namesReadable) return out;
    const [parties, members] = await Promise.all([
      this.prisma.cognitiveIdentity.findMany({
        where: { organizationId, entityType: { in: ['PERSON', 'COMPANY'] }, displayName: { contains: q, mode: 'insensitive' } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: CRM_OPPORTUNITY_NAME_MATCH_LIMIT,
      }),
      this.prisma.user.findMany({
        where: { organizationId, name: { contains: q, mode: 'insensitive' } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: CRM_OPPORTUNITY_NAME_MATCH_LIMIT,
      }),
    ]);
    const partyIds = parties.map((p) => p.id);
    if (partyIds.length) {
      out.push({ creatorPartyId: { in: partyIds } });
      out.push({ participants: { some: { organizationId, state: 'ACTIVE', partyId: { in: partyIds } } } });
    }
    if (members.length) out.push({ ownerUserId: { in: members.map((m) => m.id) } });
    return out;
  }
}

interface Lookups {
  party(partyId: string): CrmOpportunityPartyRefV1;
  user(userId: string | null): CrmOpportunityUserRefV1 | null;
  creatorProfile(partyId: string): string | null;
}

/** The Party Reference contract's answer, as staff read it. Nothing here interprets it further. */
function partyRef(partyId: string, resolution: PartyReferenceResolution | undefined, names: Map<string, string | null>): CrmOpportunityPartyRefV1 {
  if (!resolution || resolution.state === 'NOT_FOUND') return { state: 'UNAVAILABLE', partyId, name: null };
  if (resolution.state === 'SUPERSEDED') {
    return {
      state: 'SUPERSEDED',
      // The id the record carries. It stays exactly as written.
      partyId: resolution.partyId,
      canonicalPartyId: resolution.canonicalPartyId,
      partyType: resolution.partyType,
      // Who the Party is now, by the record it was superseded into.
      name: names.get(resolution.canonicalPartyId) ?? names.get(resolution.partyId) ?? null,
    };
  }
  return {
    state: resolution.state,
    partyId: resolution.partyId,
    partyType: resolution.partyType,
    archived: resolution.archived,
    name: names.get(resolution.partyId) ?? null,
  };
}

function participantView(p: CrmParticipant, lookups: Lookups): CrmOpportunityParticipantViewV1 {
  return {
    participantId: p.id,
    role: p.role,
    party: lookups.party(p.partyId),
    state: p.state as CrmOpportunityParticipantViewV1['state'],
    addedAt: p.addedAt.toISOString(),
    addedBy: lookups.user(p.addedByUserId),
    endedAt: p.endedAt ? p.endedAt.toISOString() : null,
    voidedAt: p.voidedAt ? p.voidedAt.toISOString() : null,
    // That a reason exists, never the words: they can name a person.
    reasonRecorded: Boolean(nonBlank(p.endReason) ?? nonBlank(p.voidReason)),
  };
}

function transitionView(t: CrmOpportunityTransition, lookups: Lookups, notesReadable: boolean): CrmOpportunityTransitionViewV1 {
  const note = nonBlank(t.note);
  return {
    sequence: t.sequence,
    fromCategory: t.fromCategory,
    fromStage: t.fromStage,
    toCategory: t.toCategory,
    toStage: t.toStage,
    actor: lookups.user(t.actorUserId),
    occurredAt: t.occurredAt.toISOString(),
    note: notesReadable ? note : null,
    noteWithheld: !notesReadable && note !== null,
    creatorVisible: t.creatorVisible,
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
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
      throw new CrmOpportunityCursorError();
    }
    return { at: new Date(parsed.a), id: parsed.i };
  } catch {
    throw new CrmOpportunityCursorError();
  }
}

// CRM Relationships and Participants, persisted. Slice R2.
//
// The architecture is docs/architecture/relationship-participant.md and the
// vocabulary, lifecycle and invariants are `@emgloop/shared`. This file owns
// persistence only: R3 adds authorization, audit and the outbox on top. It is
// therefore not a security boundary, and it says so rather than implying otherwise.
//
// EVERY PARTY GOES THROUGH THE PARTY REFERENCE CONTRACT, HERE, NOT ONLY ABOVE.
// A caller cannot hand this repository a Party id and have it stored: each one is
// resolved through `PartyReferenceRepository`, and a reference that is missing,
// another organization's, unestablished, archived or superseded is REFUSED. A
// superseded id comes back with its canonical id and is never silently swapped --
// the writer decides, explicitly, as Product approved on 2026-09-15. The Party
// authority's own answer is also what supplies `partyType`: the caller never
// asserts one, so a role can never imply a Party type by the back door.
//
// A STORED REFERENCE IS NEVER REWRITTEN. Not to shorten a supersession chain, not
// to consolidate duplicates, not ever. Two Relationships that resolve to the same
// canonical sides are a governed diagnostic for a person to resolve, never an
// automatic merge.
//
// HISTORY IS APPEND-ONLY AND STATE IS ITS PROJECTION. Every write appends an event
// in the same transaction as the change it describes, and the row's `state` is what
// `projectCrmRelationshipState` folds from the log. Nothing is deleted: removal is
// END (it was true) or VOID (it never was).
//
// NO MACHINE WRITES. Every act records a HUMAN actor -- the database CHECK refuses
// anything else -- and no method here infers, matches or proposes a Relationship.

import type { Prisma, PrismaClient, CrmRelationship, CrmParticipant, CrmRelationshipEvent } from '@prisma/client';
import {
  CRM_RELATIONSHIP_REASON_REQUIRED,
  crmParticipantActiveKey,
  crmParticipantRole,
  crmRelationshipKind,
  crmRelationshipNaturalKey,
  crmRelationshipTransition,
  partyReferenceForWrite,
  projectCrmRelationshipState,
  validateCrmParticipant,
  validateCrmRelationshipSides,
  type CrmParticipantRole,
  type CrmParticipantState,
  type CrmRelationshipEventType,
  type CrmRelationshipSide,
  type CrmRelationshipSideAssignment,
  type CrmRelationshipState,
  type PartyType,
  type PartyWriteRefusal,
} from '@emgloop/shared';

import { PartyReferenceRepository } from './party-reference.repository';

/** The reducer version this build folds a log with. Stored, so a change is a rebuild. */
export const CRM_RELATIONSHIP_PROJECTION_VERSION = 1;

export interface CrmRelationshipSideInput {
  readonly side: CrmRelationshipSide;
  readonly partyId: string;
  /** The commercial capacity this side Party holds, e.g. AGENCY. */
  readonly role: CrmParticipantRole;
}

export interface CrmRelationshipCreateInput {
  readonly kind: string;
  readonly sides: readonly CrmRelationshipSideInput[];
  readonly actorUserId: string;
  readonly occurredAt: Date;
  readonly label?: string | null;
  readonly description?: string | null;
  readonly ownerUserId?: string | null;
  readonly businessStartDate?: Date | null;
}

export interface CrmParticipantAddInput {
  readonly relationshipId: string;
  readonly partyId: string;
  readonly role: CrmParticipantRole;
  readonly actsForSide: CrmRelationshipSide;
  readonly actorUserId: string;
  readonly occurredAt: Date;
  readonly effectiveFrom?: Date | null;
}

export type CrmPartyRefusal = { readonly partyId: string; readonly refusal: PartyWriteRefusal; readonly canonicalPartyId?: string };

export type CrmRelationshipWriteResult<T> =
  | { readonly outcome: 'RECORDED'; readonly value: T }
  | { readonly outcome: 'INVALID'; readonly violations: readonly string[] }
  | { readonly outcome: 'PARTY_REFUSED'; readonly refusals: readonly CrmPartyRefusal[] }
  | { readonly outcome: 'DUPLICATE' }
  | { readonly outcome: 'NOT_FOUND' }
  | { readonly outcome: 'ILLEGAL_TRANSITION'; readonly from: CrmRelationshipState }
  | { readonly outcome: 'REASON_REQUIRED' }
  | { readonly outcome: 'RETRY' };

export interface CrmRelationshipRepositoryDeps {
  references?: Pick<PartyReferenceRepository, 'requireReferenceable' | 'resolve'>;
}

/**
 * A caller's open transaction, when it has one. Passing it is what lets the
 * governed service put the Relationship write, its event, its audit row and its
 * outbox row inside ONE transaction -- so a reader can never find an audited act
 * that did not happen, or a published change nobody recorded.
 */
export type CrmRelationshipTx = Prisma.TransactionClient;

const P2002 = 'P2002';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === P2002;
}

export class CrmRelationshipRepository {
  private readonly references: Pick<PartyReferenceRepository, 'requireReferenceable' | 'resolve'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmRelationshipRepositoryDeps = {},
  ) {
    this.references = deps.references ?? new PartyReferenceRepository(prisma);
  }

  // --- Reads ------------------------------------------------------------------------

  /** Organization-scoped, fail-closed to null: another tenant's id is simply not found. */
  async findById(organizationId: string, id: string): Promise<CrmRelationship | null> {
    if (!organizationId?.trim() || !id?.trim()) return null;
    return this.prisma.crmRelationship.findFirst({ where: { id, organizationId } });
  }

  async participantsFor(organizationId: string, relationshipId: string): Promise<CrmParticipant[]> {
    if (!organizationId?.trim() || !relationshipId?.trim()) return [];
    return this.prisma.crmParticipant.findMany({
      where: { organizationId, relationshipId },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** The whole log, in sequence order. History is read, never summarised away. */
  async eventsFor(organizationId: string, relationshipId: string): Promise<CrmRelationshipEvent[]> {
    if (!organizationId?.trim() || !relationshipId?.trim()) return [];
    return this.prisma.crmRelationshipEvent.findMany({
      where: { organizationId, relationshipId },
      orderBy: { sequence: 'asc' },
    });
  }

  /** Relationships an established Party takes part in, through its ACTIVE participations. */
  async forParty(organizationId: string, partyId: string): Promise<CrmRelationship[]> {
    if (!organizationId?.trim() || !partyId?.trim()) return [];
    const rows = await this.prisma.crmParticipant.findMany({
      where: { organizationId, partyId, state: 'ACTIVE' },
      select: { relationshipId: true },
    });
    const ids = [...new Set(rows.map((r) => r.relationshipId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return [];
    return this.prisma.crmRelationship.findMany({
      where: { organizationId, id: { in: ids } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** The state the log says, recomputed rather than trusted. Null when there is no log. */
  async projectedState(organizationId: string, relationshipId: string): Promise<CrmRelationshipState | null> {
    const events = await this.eventsFor(organizationId, relationshipId);
    const projection = projectCrmRelationshipState(events.map((e) => ({ sequence: e.sequence, type: e.type })));
    return projection.ok ? projection.state : null;
  }

  // --- Writes -----------------------------------------------------------------------

  /**
   * A Relationship and its side Participants, created together in one act, with the
   * first event of its log. Either all of it exists or none of it does.
   */
  async create(
    organizationId: string,
    input: CrmRelationshipCreateInput,
    tx?: CrmRelationshipTx,
  ): Promise<CrmRelationshipWriteResult<{ relationship: CrmRelationship; participants: CrmParticipant[] }>> {
    const definition = crmRelationshipKind(input.kind);
    if (!organizationId?.trim() || !input.actorUserId?.trim()) return { outcome: 'INVALID', violations: ['MISSING_ACTOR'] };
    if (!definition) return { outcome: 'INVALID', violations: ['UNKNOWN_KIND'] };

    // The Party authority answers first, and its answer supplies the type.
    const resolved = await this.resolveAll(organizationId, input.sides.map((s) => s.partyId));
    if (resolved.refusals.length > 0) return { outcome: 'PARTY_REFUSED', refusals: resolved.refusals };

    const assignments: CrmRelationshipSideAssignment[] = input.sides.map((s) => ({
      side: s.side,
      partyId: s.partyId,
      partyType: resolved.types.get(s.partyId) as PartyType,
    }));
    const sideViolations = validateCrmRelationshipSides(input.kind, assignments);
    if (sideViolations.length > 0) return { outcome: 'INVALID', violations: sideViolations };

    const participantViolations = input.sides.flatMap((s) =>
      validateCrmParticipant({
        subjectKind: 'RELATIONSHIP',
        relationshipKind: input.kind,
        role: s.role,
        partyType: resolved.types.get(s.partyId) as PartyType,
        side: s.side,
        actsForSide: null,
      }),
    );
    if (participantViolations.length > 0) return { outcome: 'INVALID', violations: [...new Set(participantViolations)] };

    const naturalKey = crmRelationshipNaturalKey(input.kind, assignments);
    try {
      const value = await this.inTransaction(tx, async (tx) => {
        const relationship = await tx.crmRelationship.create({
          data: {
            organizationId,
            kind: input.kind,
            structure: definition.structure,
            nonVoidedNaturalKey: naturalKey,
            state: 'ACTIVE',
            projectionVersion: CRM_RELATIONSHIP_PROJECTION_VERSION,
            lastSequence: 1,
            label: input.label ?? null,
            description: input.description ?? null,
            ownerUserId: input.ownerUserId ?? null,
            businessStartDate: input.businessStartDate ?? null,
            createdByUserId: input.actorUserId,
          },
        });
        const participants: CrmParticipant[] = [];
        for (const side of input.sides) {
          participants.push(
            await tx.crmParticipant.create({
              data: this.participantData(organizationId, relationship.id, {
                partyId: side.partyId,
                partyType: resolved.types.get(side.partyId) as PartyType,
                role: side.role,
                side: side.side,
                actsForSide: null,
                actorUserId: input.actorUserId,
                effectiveFrom: input.businessStartDate ?? null,
              }),
            }),
          );
        }
        await tx.crmRelationshipEvent.create({
          data: {
            organizationId,
            relationshipId: relationship.id,
            sequence: 1,
            type: 'RELATIONSHIP_CREATED' satisfies CrmRelationshipEventType,
            occurredAt: input.occurredAt,
            occurredAtBasis: 'OPERATOR_STATED',
            actorType: 'HUMAN',
            actorUserId: input.actorUserId,
            toState: 'ACTIVE',
          },
        });
        return { relationship, participants };
      });
      return { outcome: 'RECORDED', value };
    } catch (err) {
      // The natural key is already held by a non-voided Relationship of this kind.
      if (isUniqueViolation(err)) return { outcome: 'DUPLICATE' };
      throw err;
    }
  }

  /** A Participant that ACTS FOR a side: a contact, a decision maker, a billing contact. */
  async addParticipant(
    organizationId: string,
    input: CrmParticipantAddInput,
    tx?: CrmRelationshipTx,
  ): Promise<CrmRelationshipWriteResult<CrmParticipant>> {
    const relationship = await this.findById(organizationId, input.relationshipId);
    if (!relationship) return { outcome: 'NOT_FOUND' };
    if (relationship.state !== 'ACTIVE') return { outcome: 'ILLEGAL_TRANSITION', from: relationship.state as CrmRelationshipState };

    const resolved = await this.resolveAll(organizationId, [input.partyId]);
    if (resolved.refusals.length > 0) return { outcome: 'PARTY_REFUSED', refusals: resolved.refusals };
    const partyType = resolved.types.get(input.partyId) as PartyType;

    const violations = validateCrmParticipant({
      subjectKind: 'RELATIONSHIP',
      relationshipKind: relationship.kind,
      role: input.role,
      partyType,
      side: null,
      actsForSide: input.actsForSide,
    });
    if (violations.length > 0) return { outcome: 'INVALID', violations };

    try {
      const value = await this.inTransaction(tx, async (tx) => {
        const participant = await tx.crmParticipant.create({
          data: this.participantData(organizationId, relationship.id, {
            partyId: input.partyId,
            partyType,
            role: input.role,
            side: null,
            actsForSide: input.actsForSide,
            actorUserId: input.actorUserId,
            effectiveFrom: input.effectiveFrom ?? null,
          }),
        });
        await this.appendEvent(tx, organizationId, relationship, {
          type: 'PARTICIPANT_ADDED',
          occurredAt: input.occurredAt,
          actorUserId: input.actorUserId,
          participantId: participant.id,
        });
        return participant;
      });
      return { outcome: 'RECORDED', value };
    } catch (err) {
      // Another ACTIVE row already holds this subject, Party and role.
      if (isUniqueViolation(err)) return { outcome: 'DUPLICATE' };
      throw err;
    }
  }

  /**
   * Correct a Participant, within the narrow band the contract allows: the side it
   * ACTS FOR, and its business dates.
   *
   * WHAT IT CANNOT CHANGE, AND WHY. Not the Party -- that is a different Participant,
   * and pretending otherwise would rewrite who took part. Not the role -- holding a
   * different role is a second fact, recorded by ending this row and adding another,
   * which is exactly how the architecture keeps "who held what, when" answerable.
   * Not a side Participant into an acts-for one, or back: a side is structural, fixed
   * at creation with the Relationship itself.
   */
  async changeParticipant(
    organizationId: string,
    participantId: string,
    input: {
      readonly actsForSide?: CrmRelationshipSide;
      readonly effectiveFrom?: Date | null;
      readonly actorUserId: string;
      readonly occurredAt: Date;
    },
    tx?: CrmRelationshipTx,
  ): Promise<CrmRelationshipWriteResult<CrmParticipant>> {
    const participant = await this.prisma.crmParticipant.findFirst({ where: { id: participantId, organizationId } });
    if (!participant || !participant.relationshipId) return { outcome: 'NOT_FOUND' };
    if (participant.state !== 'ACTIVE') return { outcome: 'ILLEGAL_TRANSITION', from: participant.state as CrmRelationshipState };
    if (participant.side !== null) return { outcome: 'INVALID', violations: ['SIDE_PARTICIPANT_IS_STRUCTURAL'] };
    const relationship = await this.findById(organizationId, participant.relationshipId);
    if (!relationship) return { outcome: 'NOT_FOUND' };

    const actsForSide = input.actsForSide ?? (participant.actsForSide as CrmRelationshipSide | null);
    if (actsForSide === null) return { outcome: 'INVALID', violations: ['MUST_BE_OR_ACT_FOR_A_SIDE'] };
    // Re-validated as a whole: a correction is a new assertion, not an exception.
    const violations = validateCrmParticipant({
      subjectKind: 'RELATIONSHIP',
      relationshipKind: relationship.kind,
      role: participant.role,
      partyType: participant.partyType as PartyType,
      side: null,
      actsForSide,
    });
    if (violations.length > 0) return { outcome: 'INVALID', violations };

    const value = await this.inTransaction(tx, async (client) => {
      const updated = await client.crmParticipant.update({
        where: { id: participant.id },
        data: {
          actsForSide,
          ...(input.effectiveFrom !== undefined ? { effectiveFrom: input.effectiveFrom } : {}),
        },
      });
      await this.appendEvent(client, organizationId, relationship, {
        type: 'PARTICIPANT_CHANGED',
        occurredAt: input.occurredAt,
        actorUserId: input.actorUserId,
        participantId: participant.id,
      });
      return updated;
    });
    return { outcome: 'RECORDED', value };
  }

  /**
   * End or void a Participant. A side Participant is refused: a Relationship without
   * its side is not a fact, so a wrong side is corrected by voiding the whole record.
   * The row is stamped and KEPT -- holding the role again later writes a new one.
   */
  async closeParticipant(
    organizationId: string,
    participantId: string,
    input: { readonly to: 'ENDED' | 'VOIDED'; readonly actorUserId: string; readonly occurredAt: Date; readonly reason: string; readonly effectiveTo?: Date | null },
    tx?: CrmRelationshipTx,
  ): Promise<CrmRelationshipWriteResult<CrmParticipant>> {
    if (!input.reason?.trim()) return { outcome: 'REASON_REQUIRED' };
    const participant = await this.prisma.crmParticipant.findFirst({ where: { id: participantId, organizationId } });
    if (!participant || !participant.relationshipId) return { outcome: 'NOT_FOUND' };
    if (participant.side !== null) return { outcome: 'INVALID', violations: ['SIDE_PARTICIPANT_CANNOT_BE_CLOSED_ALONE'] };
    if (participant.state !== 'ACTIVE') return { outcome: 'ILLEGAL_TRANSITION', from: participant.state as CrmRelationshipState };
    const relationship = await this.findById(organizationId, participant.relationshipId);
    if (!relationship) return { outcome: 'NOT_FOUND' };

    const value = await this.inTransaction(tx, async (tx) => {
      const updated = await tx.crmParticipant.update({
        where: { id: participant.id },
        data: {
          state: input.to,
          // Releasing the active key is what lets the same role be held again later.
          activeKey: null,
          effectiveTo: input.to === 'ENDED' ? (input.effectiveTo ?? null) : null,
          ...(input.to === 'ENDED'
            ? { endedAt: input.occurredAt, endedByUserId: input.actorUserId, endReason: input.reason }
            : { voidedAt: input.occurredAt, voidedByUserId: input.actorUserId, voidReason: input.reason }),
        },
      });
      await this.appendEvent(tx, organizationId, relationship, {
        type: input.to === 'ENDED' ? 'PARTICIPANT_ENDED' : 'PARTICIPANT_VOIDED',
        occurredAt: input.occurredAt,
        actorUserId: input.actorUserId,
        reason: input.reason,
        participantId: participant.id,
      });
      return updated;
    });
    return { outcome: 'RECORDED', value };
  }

  /**
   * A lifecycle transition: end, reactivate or void. The event the transition IS comes
   * from the shared contract, so the database and the reducer cannot disagree about
   * which moves are legal.
   */
  async transition(
    organizationId: string,
    relationshipId: string,
    input: { readonly to: CrmRelationshipState; readonly actorUserId: string; readonly occurredAt: Date; readonly reason?: string | null; readonly businessEndDate?: Date | null },
    tx?: CrmRelationshipTx,
  ): Promise<CrmRelationshipWriteResult<CrmRelationship>> {
    const relationship = await this.findById(organizationId, relationshipId);
    if (!relationship) return { outcome: 'NOT_FOUND' };
    const from = relationship.state as CrmRelationshipState;
    const type = crmRelationshipTransition(from, input.to);
    if (!type) return { outcome: 'ILLEGAL_TRANSITION', from };
    if ((CRM_RELATIONSHIP_REASON_REQUIRED as readonly string[]).includes(type) && !input.reason?.trim()) {
      return { outcome: 'REASON_REQUIRED' };
    }

    const value = await this.inTransaction(tx, async (tx) => {
      const updated = await tx.crmRelationship.update({
        where: { id: relationship.id },
        data: {
          state: input.to,
          lastSequence: relationship.lastSequence + 1,
          // VOID releases the natural key; ENDED keeps it, so renewing reactivates
          // this record rather than creating a competing one.
          ...(input.to === 'VOIDED' ? { nonVoidedNaturalKey: null, voidedAt: input.occurredAt } : {}),
          ...(input.to === 'ENDED' ? { endedAt: input.occurredAt, businessEndDate: input.businessEndDate ?? null } : {}),
          ...(input.to === 'ACTIVE' ? { endedAt: null, businessEndDate: null } : {}),
        },
      });
      await tx.crmRelationshipEvent.create({
        data: {
          organizationId,
          relationshipId: relationship.id,
          sequence: relationship.lastSequence + 1,
          type,
          occurredAt: input.occurredAt,
          occurredAtBasis: 'OPERATOR_STATED',
          actorType: 'HUMAN',
          actorUserId: input.actorUserId,
          reason: input.reason ?? null,
          fromState: from,
          toState: input.to,
        },
      });
      return updated;
    }).catch((err: unknown) => {
      // Somebody else appended first. The caller re-reads rather than overwriting.
      if (isUniqueViolation(err)) return null;
      throw err;
    });
    return value === null ? { outcome: 'RETRY' } : { outcome: 'RECORDED', value };
  }

  // --- Internals --------------------------------------------------------------------

  /**
   * Run the writes in the caller's transaction when there is one, otherwise in a
   * transaction of our own. Prisma has no nested transactions, so a repository that
   * always opened its own could never be composed into a larger governed act.
   */
  private inTransaction<T>(tx: CrmRelationshipTx | undefined, fn: (client: CrmRelationshipTx) => Promise<T>): Promise<T> {
    return tx ? fn(tx) : this.prisma.$transaction(fn);
  }

  /**
   * Resolve every Party through the Party Reference contract. Refusals are collected
   * rather than thrown so a caller learns about all of them at once, and a superseded
   * id carries its canonical id back for an explicit retry.
   */
  private async resolveAll(
    organizationId: string,
    partyIds: readonly string[],
  ): Promise<{ types: Map<string, PartyType>; refusals: CrmPartyRefusal[] }> {
    const types = new Map<string, PartyType>();
    const refusals: CrmPartyRefusal[] = [];
    for (const partyId of new Set(partyIds)) {
      const resolution = await this.references.resolve(organizationId, partyId);
      const decision = partyReferenceForWrite(resolution);
      if (decision.ok) types.set(partyId, decision.partyType);
      else refusals.push({ partyId, refusal: decision.refusal, ...(decision.canonicalPartyId ? { canonicalPartyId: decision.canonicalPartyId } : {}) });
    }
    return { types, refusals };
  }

  private participantData(
    organizationId: string,
    relationshipId: string,
    p: {
      partyId: string;
      partyType: PartyType;
      role: CrmParticipantRole;
      side: CrmRelationshipSide | null;
      actsForSide: CrmRelationshipSide | null;
      actorUserId: string;
      effectiveFrom: Date | null;
    },
  ): Prisma.CrmParticipantUncheckedCreateInput {
    const definition = crmParticipantRole(p.role);
    return {
      organizationId,
      relationshipId,
      partyId: p.partyId,
      partyType: p.partyType,
      role: p.role,
      roleFamily: definition?.family ?? 'CAPACITY',
      side: p.side,
      actsForSide: p.actsForSide,
      state: 'ACTIVE' satisfies CrmParticipantState,
      activeKey: crmParticipantActiveKey('RELATIONSHIP', relationshipId, p.partyId, p.role, 'ACTIVE'),
      effectiveFrom: p.effectiveFrom,
      addedByUserId: p.actorUserId,
    };
  }

  private async appendEvent(
    tx: Prisma.TransactionClient,
    organizationId: string,
    relationship: CrmRelationship,
    event: {
      type: CrmRelationshipEventType;
      occurredAt: Date;
      actorUserId: string;
      reason?: string;
      participantId?: string;
    },
  ): Promise<void> {
    const sequence = relationship.lastSequence + 1;
    await tx.crmRelationshipEvent.create({
      data: {
        organizationId,
        relationshipId: relationship.id,
        sequence,
        type: event.type,
        occurredAt: event.occurredAt,
        occurredAtBasis: 'OPERATOR_STATED',
        actorType: 'HUMAN',
        actorUserId: event.actorUserId,
        reason: event.reason ?? null,
        participantId: event.participantId ?? null,
      },
    });
    await tx.crmRelationship.update({ where: { id: relationship.id }, data: { lastSequence: sequence } });
  }
}

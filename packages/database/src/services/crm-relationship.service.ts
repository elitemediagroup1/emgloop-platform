// The governed Relationship authority. Slice R3-A1.
//
// R2 gave Relationships a place to live. This is the act: an authorized PERSON
// asserting that a commercial connection exists, ends, resumes or never existed.
// The architecture is docs/architecture/relationship-participant.md and the grants
// are PD-F-04, already expressed as `CRM_RELATIONSHIP_ACT_ROLES` in `@emgloop/shared`
// and bound here rather than restated -- one vocabulary, approved once.
//
// FOUR THINGS HAPPEN OR NONE DO. Every consequential write puts the Relationship
// row, its event, its AuditLog row and its StateChangeOutbox row in ONE transaction.
// A reader must never find an audited act that did not happen, a published change
// nobody recorded, or a state with no event behind it. `PartyService` writes its
// audit after the fact and gets away with it because a Party write is one row; this
// authority is four, so it cannot.
//
// THE AUDIT RECORDS THE ACT; THE LOG HOLDS THE WORDS. A reason is free text a person
// wrote, and it can name somebody. It lives on the event, where the authority for it
// is, and the audit row records THAT a reason was given and where to read it. Audit
// metadata and outbox payloads carry ids, kinds and states -- never a reason, never a
// name, never a contact value.
//
// NO MACHINE PERFORMS THESE ACTS. The actor type is HUMAN at every call site, the
// database CHECK refuses anything else, and AI_EMPLOYEE is denied before the grant
// table is even consulted. Nothing here infers, proposes or matches a Relationship.

import type { Prisma, PrismaClient, CrmParticipant, CrmRelationship } from '@prisma/client';
import {
  crmRelationshipActPermitted,
  type CrmRelationshipAct,
  type CrmRelationshipSide,
  type CrmRelationshipState,
} from '@emgloop/shared';

import { AuditRepository } from '../repositories/audit.repository';
import { IamRepository } from '../repositories/iam.repository';
import { membershipAuthority } from '../repositories/membership.repository';
import {
  CrmRelationshipRepository,
  type CrmParticipantAddInput,
  type CrmRelationshipCreateInput,
  type CrmRelationshipWriteResult,
} from '../repositories/crm-relationship.repository';

/** Who is acting, from the signed session and nowhere else. */
export interface CrmRelationshipActor {
  readonly organizationId: string;
  readonly userId: string;
  /** The session's display name, for the audit trail. Never an email. */
  readonly actorName?: string | null;
}

export type CrmRelationshipServiceResult<T> =
  | CrmRelationshipWriteResult<T>
  | { readonly outcome: 'NOT_AUTHORIZED' };

export interface CrmRelationshipServiceDeps {
  relationships?: CrmRelationshipRepository;
  audit?: Pick<AuditRepository, 'record'>;
  iam?: Pick<IamRepository, 'canEach'>;
}

/** The outbox event each transition publishes. Subscribers switch on this. */
const OUTBOX_EVENT: Readonly<Record<string, string>> = Object.freeze({
  CREATE: 'RelationshipCreated',
  END_RELATIONSHIP: 'RelationshipEnded',
  REACTIVATE_RELATIONSHIP: 'RelationshipReactivated',
  VOID_RELATIONSHIP: 'RelationshipVoided',
  ADD_PARTICIPANT: 'RelationshipParticipantAdded',
  CHANGE_PARTICIPANT: 'RelationshipParticipantChanged',
  END_PARTICIPANT: 'RelationshipParticipantEnded',
  VOID_PARTICIPANT: 'RelationshipParticipantVoided',
});

const AUDIT_ACTION: Readonly<Record<string, string>> = Object.freeze({
  CREATE: 'relationship.created',
  END_RELATIONSHIP: 'relationship.ended',
  REACTIVATE_RELATIONSHIP: 'relationship.reactivated',
  VOID_RELATIONSHIP: 'relationship.voided',
  ADD_PARTICIPANT: 'relationship.participant_added',
  CHANGE_PARTICIPANT: 'relationship.participant_changed',
  END_PARTICIPANT: 'relationship.participant_ended',
  VOID_PARTICIPANT: 'relationship.participant_voided',
});

export class CrmRelationshipService {
  private readonly relationships: CrmRelationshipRepository;
  private readonly audit: Pick<AuditRepository, 'record'>;
  private readonly iam: Pick<IamRepository, 'canEach'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmRelationshipServiceDeps = {},
  ) {
    this.relationships = deps.relationships ?? new CrmRelationshipRepository(prisma);
    this.audit = deps.audit ?? new AuditRepository(prisma);
    this.iam = deps.iam ?? new IamRepository(prisma);
  }

  /**
   * Assert that a commercial connection exists, together with its side Participants,
   * in one act. Every Party is resolved through the Party Reference contract by the
   * repository, so a superseded id comes back refused with its canonical id and an
   * archived or unestablished Party takes no new reference.
   */
  async create(
    actor: CrmRelationshipActor,
    input: Omit<CrmRelationshipCreateInput, 'actorUserId'>,
  ): Promise<CrmRelationshipServiceResult<{ relationship: CrmRelationship; participants: CrmParticipant[] }>> {
    if (!(await this.may(actor, 'CREATE'))) return { outcome: 'NOT_AUTHORIZED' };
    return this.act(actor, 'CREATE', async (tx) => {
      const result = await this.relationships.create(actor.organizationId, { ...input, actorUserId: actor.userId }, tx);
      if (result.outcome !== 'RECORDED') return { result, subject: null };
      return {
        result,
        subject: {
          relationship: result.value.relationship,
          fromState: null,
          toState: 'ACTIVE' as CrmRelationshipState,
          reasonGiven: false,
          metadata: {
            kind: result.value.relationship.kind,
            structure: result.value.relationship.structure,
            // Ids and roles only: who a Party IS belongs to the Party authority.
            sides: result.value.participants.map((p) => ({ side: p.side, partyId: p.partyId, role: p.role })),
          },
        },
      };
    });
  }

  /** It was true and has stopped. A reason is required and kept on the event. */
  end(
    actor: CrmRelationshipActor,
    relationshipId: string,
    input: { readonly reason: string; readonly occurredAt: Date; readonly businessEndDate?: Date | null },
  ): Promise<CrmRelationshipServiceResult<CrmRelationship>> {
    return this.transition(actor, 'END_RELATIONSHIP', relationshipId, 'ENDED', input);
  }

  /** It has resumed. The record that carries the history is the one that reactivates. */
  reactivate(
    actor: CrmRelationshipActor,
    relationshipId: string,
    input: { readonly occurredAt: Date },
  ): Promise<CrmRelationshipServiceResult<CrmRelationship>> {
    return this.transition(actor, 'REACTIVATE_RELATIONSHIP', relationshipId, 'ACTIVE', { ...input, reason: null });
  }

  /** It was never true. The record stays readable; only the natural key is released. */
  void(
    actor: CrmRelationshipActor,
    relationshipId: string,
    input: { readonly reason: string; readonly occurredAt: Date },
  ): Promise<CrmRelationshipServiceResult<CrmRelationship>> {
    return this.transition(actor, 'VOID_RELATIONSHIP', relationshipId, 'VOIDED', input);
  }

  // --- Participants (R3-A2) -------------------------------------------------------------

  /**
   * A Participant that ACTS FOR a side: a contact, a decision maker, a billing
   * contact. The Party is resolved through the Party Reference contract by the
   * repository, so an unestablished, archived, superseded or cross-organization id
   * is refused -- a superseded one with its canonical id, never swapped for it.
   *
   * The role is CONTEXTUAL. It records what this Party does in this Relationship; it
   * never decides, changes or implies what kind of Party it is.
   */
  async addParticipant(
    actor: CrmRelationshipActor,
    input: Omit<CrmParticipantAddInput, 'actorUserId'>,
  ): Promise<CrmRelationshipServiceResult<CrmParticipant>> {
    if (!(await this.may(actor, 'ADD_PARTICIPANT'))) return { outcome: 'NOT_AUTHORIZED' };
    return this.act(actor, 'ADD_PARTICIPANT', async (tx) => {
      const relationship = await this.relationships.findById(actor.organizationId, input.relationshipId);
      const result = await this.relationships.addParticipant(
        actor.organizationId,
        { ...input, actorUserId: actor.userId },
        tx,
      );
      if (result.outcome !== 'RECORDED' || !relationship) return { result, subject: null };
      return {
        result,
        subject: {
          // The Relationship's own state is untouched by a Participant act.
          relationship: { ...relationship, lastSequence: relationship.lastSequence + 1 },
          fromState: relationship.state as CrmRelationshipState,
          toState: relationship.state as CrmRelationshipState,
          reasonGiven: false,
          participantId: result.value.id,
          // Ids and the contextual role. Who the Party IS stays with the Party authority.
          metadata: { kind: relationship.kind, partyId: result.value.partyId, role: result.value.role, actsForSide: result.value.actsForSide },
        },
      };
    });
  }

  /**
   * Correct a Participant, within the band the contract allows: the side it acts for
   * and its business dates. Not the Party, not the role, not a side -- each of those
   * is a different fact, recorded as one.
   */
  async changeParticipant(
    actor: CrmRelationshipActor,
    participantId: string,
    input: { readonly actsForSide?: CrmRelationshipSide; readonly effectiveFrom?: Date | null; readonly occurredAt: Date },
  ): Promise<CrmRelationshipServiceResult<CrmParticipant>> {
    return this.participantAct(actor, 'CHANGE_PARTICIPANT', participantId, (tx) =>
      this.relationships.changeParticipant(actor.organizationId, participantId, { ...input, actorUserId: actor.userId }, tx),
    );
  }

  /** It was true and has stopped. The row is kept, its key released, the reason on the event. */
  async endParticipant(
    actor: CrmRelationshipActor,
    participantId: string,
    input: { readonly reason: string; readonly occurredAt: Date; readonly effectiveTo?: Date | null },
  ): Promise<CrmRelationshipServiceResult<CrmParticipant>> {
    return this.participantAct(actor, 'END_PARTICIPANT', participantId, (tx) =>
      this.relationships.closeParticipant(actor.organizationId, participantId, { ...input, to: 'ENDED', actorUserId: actor.userId }, tx),
    );
  }

  /** It was never true. Also kept: a record entered in error is still a record of the error. */
  async voidParticipant(
    actor: CrmRelationshipActor,
    participantId: string,
    input: { readonly reason: string; readonly occurredAt: Date },
  ): Promise<CrmRelationshipServiceResult<CrmParticipant>> {
    return this.participantAct(actor, 'VOID_PARTICIPANT', participantId, (tx) =>
      this.relationships.closeParticipant(actor.organizationId, participantId, { ...input, to: 'VOIDED', actorUserId: actor.userId }, tx),
    );
  }

  // --- Internals ----------------------------------------------------------------------

  /**
   * The three acts that operate on an existing Participant. The Relationship it
   * belongs to is read first so the audit row and the outbox event name the subject
   * a subscriber actually follows -- a Participant is never a subject on its own.
   */
  private async participantAct(
    actor: CrmRelationshipActor,
    act: CrmRelationshipAct,
    participantId: string,
    run: (tx: Prisma.TransactionClient) => Promise<CrmRelationshipWriteResult<CrmParticipant>>,
  ): Promise<CrmRelationshipServiceResult<CrmParticipant>> {
    if (!(await this.may(actor, act))) return { outcome: 'NOT_AUTHORIZED' };
    return this.act(actor, act, async (tx) => {
      const before = await this.prisma.crmParticipant.findFirst({
        where: { id: participantId, organizationId: actor.organizationId },
        select: { relationshipId: true, role: true, partyId: true, state: true },
      });
      const result = await run(tx);
      if (result.outcome !== 'RECORDED' || !before?.relationshipId) return { result, subject: null };
      const relationship = await this.relationships.findById(actor.organizationId, before.relationshipId);
      if (!relationship) return { result, subject: null };
      return {
        result,
        subject: {
          relationship: { ...relationship, lastSequence: relationship.lastSequence + 1 },
          fromState: relationship.state as CrmRelationshipState,
          toState: relationship.state as CrmRelationshipState,
          reasonGiven: act === 'END_PARTICIPANT' || act === 'VOID_PARTICIPANT',
          participantId,
          metadata: {
            kind: relationship.kind,
            partyId: before.partyId,
            role: before.role,
            participantFromState: before.state,
            participantToState: result.value.state,
          },
        },
      };
    });
  }

  private async transition(
    actor: CrmRelationshipActor,
    act: CrmRelationshipAct,
    relationshipId: string,
    to: CrmRelationshipState,
    input: { readonly reason?: string | null; readonly occurredAt: Date; readonly businessEndDate?: Date | null },
  ): Promise<CrmRelationshipServiceResult<CrmRelationship>> {
    if (!(await this.may(actor, act))) return { outcome: 'NOT_AUTHORIZED' };
    return this.act(actor, act, async (tx) => {
      const before = await this.relationships.findById(actor.organizationId, relationshipId);
      const result = await this.relationships.transition(
        actor.organizationId,
        relationshipId,
        { to, actorUserId: actor.userId, occurredAt: input.occurredAt, reason: input.reason ?? null, businessEndDate: input.businessEndDate ?? null },
        tx,
      );
      if (result.outcome !== 'RECORDED') return { result, subject: null };
      return {
        result,
        subject: {
          relationship: result.value,
          fromState: (before?.state ?? null) as CrmRelationshipState | null,
          toState: to,
          reasonGiven: Boolean(input.reason?.trim()),
          metadata: { kind: result.value.kind },
        },
      };
    });
  }

  /**
   * One transaction, four writes, and no audit or outbox row for a write that did not
   * happen. A refused act -- a duplicate, a refused Party, an illegal transition --
   * returns its outcome and leaves nothing behind.
   */
  private async act<T>(
    actor: CrmRelationshipActor,
    act: CrmRelationshipAct,
    run: (tx: Prisma.TransactionClient) => Promise<{
      result: CrmRelationshipWriteResult<T>;
      subject: {
        relationship: CrmRelationship;
        fromState: CrmRelationshipState | null;
        toState: CrmRelationshipState;
        reasonGiven: boolean;
        metadata: Record<string, unknown>;
        /** Set when the act was about a Participant rather than the Relationship itself. */
        participantId?: string;
      } | null;
    }>,
  ): Promise<CrmRelationshipServiceResult<T>> {
    return this.prisma.$transaction(async (tx) => {
      const { result, subject } = await run(tx);
      if (!subject || result.outcome !== 'RECORDED') return result;

      await this.audit.record(
        {
          organizationId: actor.organizationId,
          userId: actor.userId,
          actorName: await this.actorName(actor),
          action: AUDIT_ACTION[act] ?? `relationship.${act.toLowerCase()}`,
          entityType: 'crm_relationship',
          entityId: subject.relationship.id,
          metadata: {
            ...subject.metadata,
            fromState: subject.fromState,
            toState: subject.toState,
            sequence: subject.relationship.lastSequence,
            ...(subject.participantId ? { participantId: subject.participantId } : {}),
            // THAT a reason was given, never the words: they are on the event, where
            // the authority for them is, and they can name a person.
            reasonRecorded: subject.reasonGiven,
          },
        },
        tx,
      );

      await tx.stateChangeOutbox.create({
        data: {
          organizationId: actor.organizationId,
          subjectType: 'RELATIONSHIP',
          subjectId: subject.relationship.id,
          eventType: OUTBOX_EVENT[act] ?? 'RelationshipChanged',
          // NULLABLE and left null on purpose: a Relationship is between Parties and
          // is not itself an identity. Fabricating one to fill a column would put a
          // non-entity into the identity graph.
          identityId: null,
          domain: 'RELATIONSHIP',
          stateKey: `relationship.${subject.relationship.id}`,
          changeType: subject.fromState === null ? 'CREATED' : 'UPDATED',
          payload: {
            relationshipId: subject.relationship.id,
            kind: subject.relationship.kind,
            fromState: subject.fromState,
            toState: subject.toState,
            sequence: subject.relationship.lastSequence,
            ...(subject.participantId ? { participantId: subject.participantId } : {}),
          } as Prisma.InputJsonValue,
          status: 'PENDING',
        },
      });
      return result;
    });
  }

  /**
   * Whether this person may perform this act. THREE INDEPENDENT REFUSALS: an inactive
   * or absent membership, the coarse `relationships:view` gate, and the approved act
   * table -- which denies AI_EMPLOYEE before it consults anything, and which no
   * Permission row can widen because no Permission row is consulted for an act.
   */
  private async may(actor: CrmRelationshipActor, act: CrmRelationshipAct): Promise<boolean> {
    if (!actor.organizationId?.trim() || !actor.userId?.trim()) return false;
    const authority = await membershipAuthority(this.prisma, actor.organizationId, actor.userId);
    if (!authority.granted) return false;
    const [canView] = await this.iam.canEach(actor.organizationId, actor.userId, [
      { resource: 'relationships', action: 'view' },
    ]);
    if (canView !== true) return false;
    return crmRelationshipActPermitted({ act, role: authority.systemRole, actorType: 'HUMAN' });
  }

  /** The session's display name when the caller has one; otherwise the member's. Never an email. */
  private async actorName(actor: CrmRelationshipActor): Promise<string | undefined> {
    const given = typeof actor.actorName === 'string' ? actor.actorName.trim() : '';
    if (given) return given;
    const member = await this.prisma.user.findFirst({
      where: { id: actor.userId, organizationId: actor.organizationId },
      select: { name: true },
    });
    return member?.name ?? undefined;
  }
}

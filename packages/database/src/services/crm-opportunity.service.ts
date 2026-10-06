// The governed CRM Opportunity authority for ownership and Participants (CRM slice 3, 2026-10-06).
//
// PD-F-11 IS THE PERMISSION MODEL. Every act checks three independent refusals, as the
// Relationship and Contact Point authorities do:
//   1. an ACTIVE membership in this organization;
//   2. the coarse `opportunities:view` gate (AI_EMPLOYEE hard-denied, no Permission row can lift it);
//   3. the approved act table `CRM_OPPORTUNITY_ACT_ROLES` -- which no Permission row is consulted for.
//
// OWNERSHIP IS ACCOUNTABILITY, NOT ACCESS. An owner is an ACTIVE member of THIS organization who may
// work Opportunities (`crmOpportunityOwnerEligible`). Anyone else -- another tenant's user, an
// inactive or removed member, READ_ONLY, an AI employee, a creator login -- is refused, and the
// id is never repaired or substituted. Owning an Opportunity hides it from nobody and grants
// nothing: every check below is the same whoever the owner is.
//
// THE WRITE AND ITS AUDIT ROW ARE ONE TRANSACTION. A refused or failed act leaves nothing behind,
// and no audit row describes a write that did not happen. Audit metadata carries ids, roles and
// states -- never a name, never a reason's words (only THAT one was given). Opportunities have no
// outbox subject yet (commercial-opportunity-campaign.md: "Not yet built"), so none is invented.
//
// Everything the transaction needs is resolved BEFORE it opens (the actor's display name, the
// owner's eligibility): a lookup on the outer client from inside a transaction needs a second
// pooled connection and starves the pool under concurrency (found in the Contact Point slice).

import type { CrmParticipant, Prisma, PrismaClient } from '@prisma/client';
import { crmOpportunityActPermitted, crmOpportunityOwnerEligible, type CrmOpportunityAct } from '@emgloop/shared';

import { AuditRepository } from '../repositories/audit.repository';
import { IamRepository } from '../repositories/iam.repository';
import { membershipAuthority } from '../repositories/membership.repository';
import {
  CrmOpportunityRepository,
  type CrmOpportunityParticipantAddInput,
  type CrmOpportunityRef,
  type CrmOpportunityWriteResult,
} from '../repositories/crm-opportunity.repository';

/** Who is acting, from the signed session (or the operator a workflow names) and nowhere else. */
export interface CrmOpportunityActor {
  readonly organizationId: string;
  readonly userId: string;
  /** The display name for the audit trail. Never an email. */
  readonly actorName?: string | null;
}

export type CrmOpportunityServiceResult<T> = CrmOpportunityWriteResult<T> | { readonly outcome: 'NOT_AUTHORIZED' };

export interface CrmOpportunityServiceDeps {
  opportunities?: CrmOpportunityRepository;
  audit?: Pick<AuditRepository, 'record'>;
  iam?: Pick<IamRepository, 'canEach'>;
}

export class CrmOpportunityService {
  private readonly opportunities: CrmOpportunityRepository;
  private readonly audit: Pick<AuditRepository, 'record'>;
  private readonly iam: Pick<IamRepository, 'canEach'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmOpportunityServiceDeps = {},
  ) {
    this.opportunities = deps.opportunities ?? new CrmOpportunityRepository(prisma);
    this.audit = deps.audit ?? new AuditRepository(prisma);
    this.iam = deps.iam ?? new IamRepository(prisma);
  }

  /** Whether this person may perform this act on Opportunities in their organization (PD-F-11). */
  async permits(actor: CrmOpportunityActor, act: CrmOpportunityAct): Promise<boolean> {
    const role = await this.role(actor);
    return role !== null && crmOpportunityActPermitted({ act, role, actorType: 'HUMAN' });
  }

  // --- Reads -----------------------------------------------------------------------------

  /** The accountable owner and the Participants, for anyone holding VIEW. Not-found across tenants. */
  async read(
    actor: CrmOpportunityActor,
    opportunityId: string,
  ): Promise<{ outcome: 'OK'; value: { opportunity: CrmOpportunityRef; participants: CrmParticipant[] } } | { outcome: 'NOT_AUTHORIZED' } | { outcome: 'NOT_FOUND' }> {
    if (!(await this.permits(actor, 'VIEW'))) return { outcome: 'NOT_AUTHORIZED' };
    const opportunity = await this.opportunities.findOpportunity(actor.organizationId, opportunityId);
    if (!opportunity) return { outcome: 'NOT_FOUND' };
    return { outcome: 'OK', value: { opportunity, participants: await this.opportunities.participants(actor.organizationId, opportunity.id) } };
  }

  // --- Ownership -------------------------------------------------------------------------

  /**
   * Name (or clear, with null) the User accountable for an Opportunity. The new owner must be an
   * ACTIVE member of this organization who may work Opportunities; anything else is
   * OWNER_NOT_ELIGIBLE and nothing is written. `expectedOwnerUserId`, when given, makes the change
   * conditional on the owner the caller saw (RETRY otherwise).
   */
  async assignOwner(
    actor: CrmOpportunityActor,
    opportunityId: string,
    input: { readonly ownerUserId: string | null; readonly expectedOwnerUserId?: string | null },
  ): Promise<CrmOpportunityServiceResult<CrmOpportunityRef>> {
    if (!(await this.permits(actor, 'CHANGE_OWNER'))) return { outcome: 'NOT_AUTHORIZED' };
    if (input.ownerUserId !== null && !(await this.ownerEligible(actor.organizationId, input.ownerUserId))) {
      return { outcome: 'OWNER_NOT_ELIGIBLE' };
    }
    const actorName = await this.actorName(actor);
    return this.prisma.$transaction(async (tx) => {
      const current = await this.opportunities.findOpportunity(actor.organizationId, opportunityId, tx);
      if (!current) return { outcome: 'NOT_FOUND' as const };
      const expected = input.expectedOwnerUserId === undefined ? current.ownerUserId : input.expectedOwnerUserId;
      const result = await this.opportunities.setOwner(actor.organizationId, current.id, { expectedOwnerUserId: expected, ownerUserId: input.ownerUserId }, tx);
      if (result.outcome !== 'RECORDED') return result;
      await this.record(tx, actor, actorName, 'opportunity.owner_changed', current.id, {
        fromOwnerUserId: current.ownerUserId,
        toOwnerUserId: input.ownerUserId,
      });
      return result;
    });
  }

  // --- Participants ----------------------------------------------------------------------

  /** A BRAND (COMPANY) or PRIMARY_CONTACT (PERSON) on an Opportunity. Established Parties only. */
  async addParticipant(
    actor: CrmOpportunityActor,
    input: Omit<CrmOpportunityParticipantAddInput, 'actorUserId'>,
  ): Promise<CrmOpportunityServiceResult<CrmParticipant>> {
    if (!(await this.permits(actor, 'ADD_PARTICIPANT'))) return { outcome: 'NOT_AUTHORIZED' };
    const actorName = await this.actorName(actor);
    return this.prisma.$transaction(async (tx) => {
      const result = await this.opportunities.addParticipant(actor.organizationId, { ...input, actorUserId: actor.userId }, tx);
      if (result.outcome !== 'RECORDED') return result;
      await this.record(tx, actor, actorName, 'opportunity.participant_added', input.opportunityId, {
        participantId: result.value.id,
        partyId: result.value.partyId,
        partyType: result.value.partyType,
        role: result.value.role,
      });
      return result;
    });
  }

  /** It was true and has stopped. MANAGER and above (PD-F-04's end grant, mirrored by PD-F-11). */
  endParticipant(actor: CrmOpportunityActor, participantId: string, input: { readonly reason: string; readonly occurredAt?: Date; readonly effectiveTo?: Date | null }) {
    return this.close(actor, 'END_PARTICIPANT', participantId, 'ENDED', input);
  }

  /** It was never true. OWNER / ADMIN. */
  voidParticipant(actor: CrmOpportunityActor, participantId: string, input: { readonly reason: string; readonly occurredAt?: Date }) {
    return this.close(actor, 'VOID_PARTICIPANT', participantId, 'VOIDED', input);
  }

  // --- Internals -------------------------------------------------------------------------

  private async close(
    actor: CrmOpportunityActor,
    act: CrmOpportunityAct,
    participantId: string,
    to: 'ENDED' | 'VOIDED',
    input: { readonly reason: string; readonly occurredAt?: Date; readonly effectiveTo?: Date | null },
  ): Promise<CrmOpportunityServiceResult<CrmParticipant>> {
    if (!(await this.permits(actor, act))) return { outcome: 'NOT_AUTHORIZED' };
    const actorName = await this.actorName(actor);
    return this.prisma.$transaction(async (tx) => {
      const result = await this.opportunities.closeParticipant(
        actor.organizationId,
        participantId,
        { to, actorUserId: actor.userId, occurredAt: input.occurredAt ?? new Date(), reason: input.reason, effectiveTo: input.effectiveTo ?? null },
        tx,
      );
      if (result.outcome !== 'RECORDED') return result;
      const { before, after } = result.value;
      await this.record(tx, actor, actorName, to === 'ENDED' ? 'opportunity.participant_ended' : 'opportunity.participant_voided', after.opportunityId!, {
        participantId: after.id,
        partyId: after.partyId,
        role: after.role,
        fromState: before.state,
        toState: after.state,
        // THAT a reason was given, never the words: they stay on the Participant row.
        reasonRecorded: true,
      });
      return { outcome: 'RECORDED' as const, value: after };
    });
  }

  private async record(
    tx: Prisma.TransactionClient,
    actor: CrmOpportunityActor,
    actorName: string | undefined,
    action: string,
    opportunityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      { organizationId: actor.organizationId, userId: actor.userId, actorName, action, entityType: 'crm_opportunity', entityId: opportunityId, metadata },
      tx,
    );
  }

  /** An ACTIVE member of this organization whose role may work Opportunities. Nothing else. */
  private async ownerEligible(organizationId: string, userId: string): Promise<boolean> {
    if (!userId?.trim()) return false;
    const authority = await membershipAuthority(this.prisma, organizationId, userId);
    return authority.granted && crmOpportunityOwnerEligible(authority.systemRole);
  }

  /** The actor's role when membership is ACTIVE and the coarse gate holds; else null. */
  private async role(actor: CrmOpportunityActor): Promise<string | null> {
    if (!actor.organizationId?.trim() || !actor.userId?.trim()) return null;
    const authority = await membershipAuthority(this.prisma, actor.organizationId, actor.userId);
    if (!authority.granted) return null;
    const [canView] = await this.iam.canEach(actor.organizationId, actor.userId, [{ resource: 'opportunities', action: 'view' }]);
    if (canView !== true) return null;
    return authority.systemRole;
  }

  private async actorName(actor: CrmOpportunityActor): Promise<string | undefined> {
    const given = typeof actor.actorName === 'string' ? actor.actorName.trim() : '';
    if (given) return given;
    const member = await this.prisma.user.findFirst({ where: { id: actor.userId, organizationId: actor.organizationId }, select: { name: true } });
    return member?.name ?? undefined;
  }
}

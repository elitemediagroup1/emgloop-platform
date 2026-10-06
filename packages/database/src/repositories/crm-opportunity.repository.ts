// CRM Opportunity ownership and Opportunity Participants, persisted (CRM slice 3, 2026-10-06).
//
// Persistence only. `CrmOpportunityService` adds PD-F-11 authorization and the audit row in the
// same transaction; this file is therefore not a security boundary, and says so.
//
// ONE PARTICIPATION TABLE. An Opportunity Participant is a `crm_participants` row whose subject is
// `opportunityId` -- the exclusive arc the Participant authority reserved for it -- not a second
// join table. On an Opportunity there are no sides, and the only roles are BRAND (a COMPANY) and
// PRIMARY_CONTACT (a PERSON): the shared contract checks it here and the database CHECK holds it.
//
// EVERY PARTY GOES THROUGH THE PARTY REFERENCE CONTRACT. A Participant is an established,
// non-superseded, non-archived Party of this organization; a superseded id is refused with its
// canonical id, never swapped, and the Party authority -- not the caller -- supplies the type.
// Nothing here finds a Party by name, and nothing creates one.
//
// A STORED REFERENCE IS NEVER REWRITTEN. Removing a Participant is END (it was true) or VOID (it
// never was), from ACTIVE only and with a reason, as on a Relationship; the row stays.
//
// THE CREATOR IS NOT A PARTICIPANT HERE. The Opportunity already names its creator through
// `creatorPartyId`, the creator authority's reference; this file never touches it.

import type { CrmParticipant, Prisma, PrismaClient } from '@prisma/client';
import {
  crmParticipantActiveKey,
  crmParticipantRole,
  partyReferenceForWrite,
  validateCrmParticipant,
  type CrmParticipantRole,
  type PartyType,
  type PartyWriteRefusal,
} from '@emgloop/shared';

import { PartyReferenceRepository } from './party-reference.repository';

export type CrmOpportunityTx = Prisma.TransactionClient;

export interface CrmOpportunityRef {
  readonly id: string;
  readonly organizationId: string;
  readonly ownerUserId: string | null;
  readonly createdByUserId: string;
  readonly creatorPartyId: string;
  readonly category: string;
}

const OPPORTUNITY_REF_SELECT = {
  id: true,
  organizationId: true,
  ownerUserId: true,
  createdByUserId: true,
  creatorPartyId: true,
  category: true,
} as const satisfies Prisma.CrmOpportunitySelect;

export type CrmOpportunityWriteResult<T> =
  | { readonly outcome: 'RECORDED'; readonly value: T }
  | { readonly outcome: 'INVALID'; readonly violations: readonly string[] }
  | { readonly outcome: 'PARTY_REFUSED'; readonly refusal: PartyWriteRefusal; readonly canonicalPartyId?: string }
  | { readonly outcome: 'OWNER_NOT_ELIGIBLE' }
  | { readonly outcome: 'DUPLICATE' }
  | { readonly outcome: 'NOT_FOUND' }
  | { readonly outcome: 'ILLEGAL_TRANSITION'; readonly from: string }
  | { readonly outcome: 'REASON_REQUIRED' }
  | { readonly outcome: 'UNCHANGED' }
  | { readonly outcome: 'RETRY' };

export interface CrmOpportunityParticipantAddInput {
  readonly opportunityId: string;
  readonly partyId: string;
  readonly role: string;
  readonly actorUserId: string;
  readonly effectiveFrom?: Date | null;
}

export interface CrmOpportunityRepositoryDeps {
  references?: Pick<PartyReferenceRepository, 'requireReferenceable'>;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export class CrmOpportunityRepository {
  private readonly references: Pick<PartyReferenceRepository, 'requireReferenceable'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmOpportunityRepositoryDeps = {},
  ) {
    this.references = deps.references ?? new PartyReferenceRepository(prisma);
  }

  /** Organization-scoped, fail-closed to null: another tenant's Opportunity is simply not found. */
  async findOpportunity(organizationId: string, id: string, db: CrmOpportunityTx | PrismaClient = this.prisma): Promise<CrmOpportunityRef | null> {
    if (!organizationId?.trim() || !id?.trim()) return null;
    return db.crmOpportunity.findFirst({ where: { id, organizationId }, select: OPPORTUNITY_REF_SELECT });
  }

  /** An Opportunity's Participants, current first, then history, oldest first within each. */
  async participants(organizationId: string, opportunityId: string): Promise<CrmParticipant[]> {
    if (!organizationId?.trim() || !opportunityId?.trim()) return [];
    const rows = await this.prisma.crmParticipant.findMany({
      where: { organizationId, opportunityId },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    });
    return [...rows.filter((r) => r.state === 'ACTIVE'), ...rows.filter((r) => r.state !== 'ACTIVE')];
  }

  /**
   * Record the accountable owner, guarded on the owner read before: a concurrent change moves it,
   * this matches nothing, RETRY. The caller has already checked the new owner's eligibility; this
   * never repairs or substitutes an id.
   */
  async setOwner(
    organizationId: string,
    opportunityId: string,
    input: { readonly expectedOwnerUserId: string | null; readonly ownerUserId: string | null },
    tx: CrmOpportunityTx,
  ): Promise<CrmOpportunityWriteResult<CrmOpportunityRef>> {
    const before = await this.findOpportunity(organizationId, opportunityId, tx);
    if (!before) return { outcome: 'NOT_FOUND' };
    if (before.ownerUserId !== input.expectedOwnerUserId) return { outcome: 'RETRY' };
    if (before.ownerUserId === input.ownerUserId) return { outcome: 'UNCHANGED' };
    const updated = await tx.crmOpportunity.updateMany({
      where: { id: before.id, organizationId, ownerUserId: input.expectedOwnerUserId },
      data: { ownerUserId: input.ownerUserId },
    });
    if (updated.count !== 1) return { outcome: 'RETRY' };
    return { outcome: 'RECORDED', value: { ...before, ownerUserId: input.ownerUserId } };
  }

  /** Add a BRAND or PRIMARY_CONTACT Participant to an Opportunity in this organization. */
  async addParticipant(organizationId: string, input: CrmOpportunityParticipantAddInput, tx: CrmOpportunityTx): Promise<CrmOpportunityWriteResult<CrmParticipant>> {
    const opportunity = await this.findOpportunity(organizationId, input.opportunityId, tx);
    if (!opportunity) return { outcome: 'NOT_FOUND' };

    const required = await this.references.requireReferenceable(organizationId, input.partyId);
    if (!required.ok) {
      const refusal = partyReferenceForWrite(required.resolution);
      return refusal.ok
        ? { outcome: 'PARTY_REFUSED', refusal: 'NOT_FOUND' }
        : { outcome: 'PARTY_REFUSED', refusal: refusal.refusal, ...(refusal.canonicalPartyId ? { canonicalPartyId: refusal.canonicalPartyId } : {}) };
    }
    const partyType: PartyType = required.partyType;
    const violations = validateCrmParticipant({
      subjectKind: 'OPPORTUNITY',
      relationshipKind: null,
      role: input.role,
      partyType,
      side: null,
      actsForSide: null,
    });
    if (violations.length > 0) return { outcome: 'INVALID', violations };

    const role = input.role as CrmParticipantRole;
    try {
      const value = await tx.crmParticipant.create({
        data: {
          organizationId,
          opportunityId: opportunity.id,
          relationshipId: null,
          partyId: required.reference.partyId,
          partyType,
          role,
          roleFamily: crmParticipantRole(role)?.family ?? 'CAPACITY',
          side: null,
          actsForSide: null,
          state: 'ACTIVE',
          activeKey: crmParticipantActiveKey('OPPORTUNITY', opportunity.id, required.reference.partyId, role, 'ACTIVE'),
          effectiveFrom: input.effectiveFrom ?? null,
          addedByUserId: input.actorUserId,
        },
      });
      return { outcome: 'RECORDED', value };
    } catch (err) {
      // This Party already holds this role on this Opportunity.
      if (isUniqueViolation(err)) return { outcome: 'DUPLICATE' };
      throw err;
    }
  }

  /** END (it was true and has stopped) or VOID (it never was) an ACTIVE Opportunity Participant. */
  async closeParticipant(
    organizationId: string,
    participantId: string,
    input: { readonly to: 'ENDED' | 'VOIDED'; readonly actorUserId: string; readonly occurredAt: Date; readonly reason: string; readonly effectiveTo?: Date | null },
    tx: CrmOpportunityTx,
  ): Promise<CrmOpportunityWriteResult<{ before: CrmParticipant; after: CrmParticipant }>> {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) return { outcome: 'REASON_REQUIRED' };
    const before = await tx.crmParticipant.findFirst({ where: { id: participantId, organizationId, opportunityId: { not: null } } });
    if (!before) return { outcome: 'NOT_FOUND' };
    if (before.state !== 'ACTIVE') return { outcome: 'ILLEGAL_TRANSITION', from: before.state };
    // Guarded on ACTIVE: of two racing closes, exactly one applies.
    const updated = await tx.crmParticipant.updateMany({
      where: { id: before.id, organizationId, state: 'ACTIVE' },
      data: {
        state: input.to,
        // Releasing the active key is what lets the same role be held again later.
        activeKey: null,
        effectiveTo: input.to === 'ENDED' ? (input.effectiveTo ?? null) : null,
        ...(input.to === 'ENDED'
          ? { endedAt: input.occurredAt, endedByUserId: input.actorUserId, endReason: reason }
          : { voidedAt: input.occurredAt, voidedByUserId: input.actorUserId, voidReason: reason }),
      },
    });
    if (updated.count !== 1) return { outcome: 'RETRY' };
    const after = await tx.crmParticipant.findFirst({ where: { id: before.id, organizationId } });
    if (!after) return { outcome: 'NOT_FOUND' };
    return { outcome: 'RECORDED', value: { before, after } };
  }
}

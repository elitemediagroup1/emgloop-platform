// CRM: Opportunities, Campaigns and Deliverables at the minimum the creator seat
// needs (Creator Hub, 2026-09-22; commercial-opportunity-campaign.md §3.4/§4.4).
//
// CRM OWNS COMMERCIAL INTENT. What was pursued, agreed and owed lives here; the
// creator seat and EMG Creator Operations read it and never copy it. Stage and
// state changes are APPEND-ONLY transitions with an actor and a time; the
// current values on the row are a projection of that log.
//
// WHAT THE CREATOR SEES IS DESIGNATED, NEVER INHERITED. `creatorVisibleState`,
// `brandVisibleToCreator`, `summaryForCreator` and `creatorBrief` are the only
// fields a creator projection reads; forecast, amounts, terms, internal notes and
// the organization's stage names never leave EMG.

import type {
  Prisma,
  PrismaClient,
  CrmOpportunity,
  CrmOpportunityTransition,
  CrmCampaign,
  CrmCampaignTransition,
  CampaignDeliverable,
} from '@prisma/client';

export interface CreateOpportunityInput {
  organizationId: string;
  title: string;
  stage: string;
  creatorPartyId: string;
  createdByUserId: string;
  category?: string;
  creatorVisibleState?: string | null;
  brandLabel?: string | null;
  brandVisibleToCreator?: boolean;
  summaryForCreator?: string | null;
  internalNotes?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  expectedCloseDate?: Date | null;
  relationshipId?: string | null;
}

export interface OpportunityTransitionInput {
  organizationId: string;
  opportunityId: string;
  toCategory: string;
  toStage: string;
  actorUserId: string;
  note?: string | null;
  creatorVisible?: boolean;
  outcome?: string | null;
  lossReason?: string | null;
}

export interface CreateCampaignInput {
  organizationId: string;
  name: string;
  creatorPartyId: string;
  createdByUserId: string;
  state?: string;
  opportunityId?: string | null;
  brandLabel?: string | null;
  brandVisibleToCreator?: boolean;
  startDate?: Date | null;
  endDate?: Date | null;
  creatorBrief?: string | null;
  termsSummary?: string | null;
}

export interface CampaignTransitionInput {
  organizationId: string;
  campaignId: string;
  toState: string;
  actorUserId: string;
  note?: string | null;
  creatorVisible?: boolean;
}

export interface DeclareDeliverableInput {
  organizationId: string;
  campaignId: string;
  creatorPartyId: string;
  title: string;
  deliverableType: string;
  dueAt?: Date | null;
  requirements?: Prisma.InputJsonValue;
  acceptsUnedited?: boolean;
  createdByUserId: string;
}

export type CampaignWithDeliverables = CrmCampaign & { deliverables: CampaignDeliverable[]; transitions: CrmCampaignTransition[] };
export type OpportunityWithHistory = CrmOpportunity & { transitions: CrmOpportunityTransition[]; campaigns: CrmCampaign[] };

export class CrmCommercialRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ---- opportunities ----------------------------------------------------------------------

  async createOpportunity(input: CreateOpportunityInput): Promise<CrmOpportunity> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.crmOpportunity.create({
        data: {
          organizationId: input.organizationId,
          title: input.title,
          category: input.category ?? 'OPEN',
          stage: input.stage,
          creatorPartyId: input.creatorPartyId,
          creatorVisibleState: input.creatorVisibleState ?? null,
          brandLabel: input.brandLabel ?? null,
          brandVisibleToCreator: input.brandVisibleToCreator ?? false,
          summaryForCreator: input.summaryForCreator ?? null,
          internalNotes: input.internalNotes ?? null,
          amountMinor: input.amountMinor ?? null,
          currency: input.currency ?? null,
          expectedCloseDate: input.expectedCloseDate ?? null,
          relationshipId: input.relationshipId ?? null,
          createdByUserId: input.createdByUserId,
        },
      });
      await tx.crmOpportunityTransition.create({
        data: {
          organizationId: input.organizationId,
          opportunityId: row.id,
          sequence: 1,
          fromCategory: null,
          fromStage: null,
          toCategory: row.category,
          toStage: row.stage,
          actorUserId: input.createdByUserId,
          note: 'Opened',
          creatorVisible: input.creatorVisibleState !== null && input.creatorVisibleState !== undefined,
        },
      });
      return row;
    });
  }

  async listOpportunitiesForCreator(organizationId: string, creatorPartyId: string): Promise<OpportunityWithHistory[]> {
    return this.prisma.crmOpportunity.findMany({
      where: { organizationId, creatorPartyId },
      orderBy: { updatedAt: 'desc' },
      include: { transitions: { orderBy: { sequence: 'asc' } }, campaigns: true },
    });
  }

  async getOpportunity(organizationId: string, id: string): Promise<OpportunityWithHistory | null> {
    return this.prisma.crmOpportunity.findFirst({
      where: { organizationId, id },
      include: { transitions: { orderBy: { sequence: 'asc' } }, campaigns: true },
    });
  }

  /** An append-only stage/category transition. The row's current values are the projection. */
  async transitionOpportunity(input: OpportunityTransitionInput): Promise<CrmOpportunity | null> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.crmOpportunity.findFirst({ where: { organizationId: input.organizationId, id: input.opportunityId } });
      if (!existing) return null;
      const last = await tx.crmOpportunityTransition.findFirst({ where: { opportunityId: existing.id }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
      await tx.crmOpportunityTransition.create({
        data: {
          organizationId: input.organizationId,
          opportunityId: existing.id,
          sequence: (last?.sequence ?? 0) + 1,
          fromCategory: existing.category,
          fromStage: existing.stage,
          toCategory: input.toCategory,
          toStage: input.toStage,
          actorUserId: input.actorUserId,
          note: input.note ?? null,
          creatorVisible: input.creatorVisible ?? false,
        },
      });
      return tx.crmOpportunity.update({
        where: { id: existing.id },
        data: {
          category: input.toCategory,
          stage: input.toStage,
          outcome: input.outcome ?? existing.outcome,
          lossReason: input.lossReason ?? existing.lossReason,
        },
      });
    });
  }

  /** What the creator may see of this pursuit. EMG's designation, never a default. */
  async designateOpportunity(
    organizationId: string,
    id: string,
    designation: { creatorVisibleState?: string | null; brandVisibleToCreator?: boolean; summaryForCreator?: string | null },
  ): Promise<CrmOpportunity | null> {
    const existing = await this.prisma.crmOpportunity.findFirst({ where: { organizationId, id }, select: { id: true } });
    if (!existing) return null;
    return this.prisma.crmOpportunity.update({ where: { id: existing.id }, data: designation });
  }

  // ---- campaigns ----------------------------------------------------------------------------

  async createCampaign(input: CreateCampaignInput): Promise<CrmCampaign> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.crmCampaign.create({
        data: {
          organizationId: input.organizationId,
          name: input.name,
          state: input.state ?? 'DRAFT',
          opportunityId: input.opportunityId ?? null,
          creatorPartyId: input.creatorPartyId,
          brandLabel: input.brandLabel ?? null,
          brandVisibleToCreator: input.brandVisibleToCreator ?? false,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          creatorBrief: input.creatorBrief ?? null,
          termsSummary: input.termsSummary ?? null,
          createdByUserId: input.createdByUserId,
        },
      });
      await tx.crmCampaignTransition.create({
        data: { organizationId: input.organizationId, campaignId: row.id, sequence: 1, fromState: null, toState: row.state, actorUserId: input.createdByUserId, note: 'Declared', creatorVisible: true },
      });
      return row;
    });
  }

  async listCampaignsForCreator(organizationId: string, creatorPartyId: string): Promise<CampaignWithDeliverables[]> {
    return this.prisma.crmCampaign.findMany({
      where: { organizationId, creatorPartyId },
      orderBy: { updatedAt: 'desc' },
      include: { deliverables: { orderBy: { dueAt: 'asc' } }, transitions: { orderBy: { sequence: 'asc' } } },
    });
  }

  async getCampaign(organizationId: string, id: string): Promise<CampaignWithDeliverables | null> {
    return this.prisma.crmCampaign.findFirst({
      where: { organizationId, id },
      include: { deliverables: { orderBy: { dueAt: 'asc' } }, transitions: { orderBy: { sequence: 'asc' } } },
    });
  }

  async transitionCampaign(input: CampaignTransitionInput): Promise<CrmCampaign | null> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.crmCampaign.findFirst({ where: { organizationId: input.organizationId, id: input.campaignId } });
      if (!existing) return null;
      const last = await tx.crmCampaignTransition.findFirst({ where: { campaignId: existing.id }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
      await tx.crmCampaignTransition.create({
        data: {
          organizationId: input.organizationId,
          campaignId: existing.id,
          sequence: (last?.sequence ?? 0) + 1,
          fromState: existing.state,
          toState: input.toState,
          actorUserId: input.actorUserId,
          note: input.note ?? null,
          creatorVisible: input.creatorVisible ?? true,
        },
      });
      return tx.crmCampaign.update({ where: { id: existing.id }, data: { state: input.toState } });
    });
  }

  // ---- deliverables -------------------------------------------------------------------------

  async declareDeliverable(input: DeclareDeliverableInput): Promise<CampaignDeliverable> {
    const campaign = await this.prisma.crmCampaign.findFirst({ where: { organizationId: input.organizationId, id: input.campaignId }, select: { id: true } });
    if (!campaign) throw new Error('Campaign not found');
    return this.prisma.campaignDeliverable.create({
      data: {
        organizationId: input.organizationId,
        campaignId: campaign.id,
        creatorPartyId: input.creatorPartyId,
        title: input.title,
        deliverableType: input.deliverableType,
        dueAt: input.dueAt ?? null,
        requirements: input.requirements ?? [],
        acceptsUnedited: input.acceptsUnedited ?? false,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  async getDeliverable(organizationId: string, id: string): Promise<(CampaignDeliverable & { campaign: CrmCampaign }) | null> {
    return this.prisma.campaignDeliverable.findFirst({ where: { organizationId, id }, include: { campaign: true } });
  }

  async listDeliverablesForCreator(organizationId: string, creatorPartyId: string): Promise<(CampaignDeliverable & { campaign: CrmCampaign })[]> {
    return this.prisma.campaignDeliverable.findMany({ where: { organizationId, creatorPartyId }, orderBy: { dueAt: 'asc' }, include: { campaign: true } });
  }

  async attachDeliverableContent(organizationId: string, id: string, contentId: string | null): Promise<CampaignDeliverable | null> {
    const existing = await this.prisma.campaignDeliverable.findFirst({ where: { organizationId, id }, select: { id: true } });
    if (!existing) return null;
    return this.prisma.campaignDeliverable.update({ where: { id: existing.id }, data: { contentId } });
  }

  /** Stamped by the production service when every declared requirement is met; never by a page. */
  async setDeliverableStatus(organizationId: string, id: string, status: 'OPEN' | 'COMPLETE'): Promise<CampaignDeliverable | null> {
    const existing = await this.prisma.campaignDeliverable.findFirst({ where: { organizationId, id }, select: { id: true, status: true } });
    if (!existing) return null;
    if (existing.status === status) return this.prisma.campaignDeliverable.findUnique({ where: { id: existing.id } });
    return this.prisma.campaignDeliverable.update({
      where: { id: existing.id },
      data: { status, completedAt: status === 'COMPLETE' ? new Date() : null },
    });
  }
}

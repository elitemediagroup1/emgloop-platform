// Read models for both seats of the Creator Hub (2026-09-22).
//
// THE SAME ROWS, TWO PROJECTIONS. `forCreator` applies the creator's visibility
// -- their own content only; versions marked visible; comments and instruction
// sets written for them; EMG staff by first name; never an internal note, a
// forecast, a term or an organization stage name. `forEmg` returns everything,
// with people by name. Neither projection invents a value: what an authority
// cannot say is null, and the page says so.
//
// STATE IS DERIVED, NOT STORED, by the pure functions in @emgloop/shared over the
// rows the repositories return, so both seats compute the same answer from the
// same facts.

import type { PrismaClient, CreatorProfile, WorkInstance, WorkStage, WorkComment, WorkInstruction, CampaignDeliverable, CrmCampaign } from '@prisma/client';
import {
  deriveContentState,
  requirementStatuses,
  deliverableComplete,
  deliverableLine,
  creatorActionsFor,
  readRequirements,
  INDEPENDENT_REQUIREMENTS,
  CONTENT_STATE_LABELS,
  CREATOR_VISIBLE_OPPORTUNITY_LABELS,
  COMPENSATION_STATE_LABELS,
  PAYABLE_COMPENSATION_STATE,
  type ContentState,
  type CreatorActions,
  type RequirementStatus,
  type DeliverableRequirement,
  type InstructionNote,
  type AddressedNote,
  type CreatorVisibleOpportunityState,
  type CompensationState,
} from '@emgloop/shared';
import { creatorContentNotice, type ContentNotice, type NoticePerformanceRow } from '@emgloop/brain';
import type { WorkRepository } from '../repositories/work.repository';
import { CreatorRepository, type ContentWithLineage } from './creator.repository';
import { CrmCommercialRepository } from './crm-commercial.repository';
import { parseProductionStep, productionFacts, versionMarks, type CreatorActor } from './creator-production.service';

export type Seat = { kind: 'CREATOR'; actor: CreatorActor } | { kind: 'EMG'; organizationId: string };

export interface PersonRef {
  readonly userId: string;
  /** First name for the creator seat; full name for EMG. */
  readonly name: string;
}

export interface VersionView {
  readonly id: string;
  readonly number: number;
  readonly label: string;
  readonly kind: 'ORIGINAL' | 'EDIT';
  readonly contentType: string;
  readonly fileName: string | null;
  readonly uploadState: 'PENDING' | 'READY' | 'FAILED';
  readonly byteSize: number | null;
  readonly durationSeconds: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly storageKey: string;
  readonly uploadedBy: PersonRef | null;
  readonly uploadedByKind: 'CREATOR' | 'EMG';
  readonly createdAt: string;
  readonly readyAt: string | null;
  readonly producedByWorkInstanceId: string | null;
  readonly answersInstructionId: string | null;
  readonly noteToCreator: string | null;
  /** EMG only; null on the creator seat. */
  readonly internalNote: string | null;
  readonly visibleToCreator: boolean;
  readonly approvals: readonly { requirementKey: string; approverKind: string; by: PersonRef | null; originatorLabel: string | null; note: string | null; at: string }[];
  readonly publications: readonly { id: string; platform: string; url: string | null; at: string; by: PersonRef | null }[];
}

export interface InstructionView {
  readonly id: string;
  readonly sequence: number;
  readonly originatorKind: 'CREATOR' | 'EMG' | 'BRAND_RELAYED';
  readonly originatorLabel: string | null;
  readonly enteredBy: PersonRef | null;
  readonly refersToVersionId: string | null;
  readonly refersToVersionLabel: string | null;
  readonly summary: string | null;
  readonly notes: readonly InstructionNote[];
  readonly requestedReturnAt: string | null;
  readonly answeredByVersionId: string | null;
  readonly answeredByVersionLabel: string | null;
  readonly answeredAt: string | null;
  readonly addressed: readonly AddressedNote[];
  readonly createdAt: string;
}

export interface CommentView {
  readonly id: string;
  readonly by: PersonRef | null;
  readonly body: string;
  readonly visibility: 'internal' | 'creator_visible';
  readonly at: string;
}

export interface StepView {
  readonly id: string;
  readonly position: number;
  readonly name: string;
  readonly kind: 'EDIT' | 'REVIEW' | null;
  readonly round: number | null;
  readonly status: string;
  readonly owner: PersonRef | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly completedBy: PersonRef | null;
  readonly note: string | null;
}

export interface ProductionView {
  readonly id: string;
  readonly number: number;
  readonly kind: string;
  readonly workInstanceId: string;
  readonly workStatus: 'active' | 'completed' | 'cancelled';
  readonly sourceVersionId: string;
  readonly requestedBy: PersonRef | null;
  readonly requestedReturnAt: string | null;
  readonly expectedReturnAt: string | null;
  readonly expectedReturnSetBy: PersonRef | null;
  readonly expectedReturnSetAt: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly currentStep: StepView | null;
  readonly steps: readonly StepView[];
  readonly instructions: readonly InstructionView[];
  readonly comments: readonly CommentView[];
}

export interface ContextView {
  readonly campaign: { id: string; name: string; state: string; brandLabel: string | null } | null;
  readonly deliverable: { id: string; title: string; dueAt: string | null; status: string; line: string; complete: boolean; acceptsUnedited: boolean } | null;
  readonly opportunity: { id: string; title: string; creatorVisibleState: CreatorVisibleOpportunityState | null; label: string | null } | null;
}

export interface ContentRecordView {
  readonly seat: 'CREATOR' | 'EMG';
  readonly id: string;
  readonly title: string;
  readonly kind: 'VIDEO' | 'PHOTO';
  readonly creator: { profileId: string; partyId: string; displayName: string; userId: string | null };
  readonly state: ContentState;
  readonly stateLabel: string;
  readonly createdAt: string;
  readonly versions: readonly VersionView[];
  readonly latestVersion: VersionView | null;
  readonly productions: readonly ProductionView[];
  readonly activeProduction: ProductionView | null;
  readonly requirements: readonly DeliverableRequirement[];
  readonly requirementStatuses: readonly RequirementStatus[];
  readonly judgedVersion: VersionView | null;
  readonly context: ContextView;
  readonly actions: CreatorActions;
}

export interface LibraryItem {
  readonly id: string;
  readonly title: string;
  readonly kind: 'VIDEO' | 'PHOTO';
  readonly state: ContentState;
  readonly stateLabel: string;
  readonly latestVersion: VersionView | null;
  readonly campaignName: string | null;
  readonly deliverableTitle: string | null;
  readonly published: boolean;
  readonly updatedAt: string;
}

export interface CreatorTask {
  readonly key: string;
  readonly kind: 'REVIEW' | 'DELIVERABLE' | 'SETUP' | 'UPLOAD';
  readonly title: string;
  readonly detail: string | null;
  readonly dueAt: string | null;
  readonly href: string;
  readonly bucket: 'NEEDS_ATTENTION' | 'UPCOMING';
}

export interface OpportunityView {
  readonly id: string;
  readonly title: string;
  readonly creatorVisibleState: CreatorVisibleOpportunityState | null;
  readonly stateLabel: string | null;
  readonly brandLabel: string | null;
  readonly summary: string | null;
  readonly updates: readonly { at: string; note: string | null; toState: string }[];
  readonly campaigns: readonly CampaignView[];
  readonly updatedAt: string;
  /** EMG only. */
  readonly internal: { stage: string; category: string; brandVisibleToCreator: boolean; internalNotes: string | null; forecastProbability: number | null; amountMinor: number | null; currency: string | null; expectedCloseDate: string | null } | null;
}

export interface CampaignView {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly brandLabel: string | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly creatorBrief: string | null;
  readonly deliverables: readonly DeliverableView[];
  /** EMG only. */
  readonly termsSummary: string | null;
}

export interface DeliverableView {
  readonly id: string;
  readonly title: string;
  readonly deliverableType: string;
  readonly dueAt: string | null;
  readonly status: string;
  readonly requirements: readonly DeliverableRequirement[];
  readonly acceptsUnedited: boolean;
  readonly contentId: string | null;
  readonly contentTitle: string | null;
  readonly contentState: ContentState | null;
  readonly line: string;
}

export interface EarningsView {
  readonly currency: string;
  readonly totals: Record<CompensationState, number>;
  readonly availableMinor: number;
  readonly entries: readonly { id: string; description: string; amountMinor: number; currency: string; state: CompensationState; stateLabel: string; payable: boolean; occurredAt: string; source: string; campaignName: string | null; deliverableTitle: string | null }[];
  readonly seeded: boolean;
  readonly payoutState: string;
}

export interface AnalyticsView {
  readonly platforms: readonly string[];
  readonly audience: readonly { platform: string; observedAt: string; followers: number; growth30dPct: number | null; source: string }[];
  readonly latestAudience: readonly { platform: string; followers: number; growth30dPct: number | null; observedAt: string; source: string }[];
  readonly performance: readonly { id: string; contentId: string | null; contentTitle: string | null; versionId: string | null; platform: string; windowStart: string; windowEnd: string; metrics: Record<string, number>; source: string }[];
  readonly totals: { views: number; reach: number; engagements: number };
  readonly topContent: readonly { contentId: string; title: string; views: number; platform: string }[];
  readonly sources: readonly string[];
  readonly seeded: boolean;
  readonly connected: boolean;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function firstName(name: string | null, email: string): string {
  const n = (name ?? '').trim();
  if (n) return n.split(/\s+/)[0]!;
  return email.split('@')[0] ?? 'EMG';
}

export class CreatorRecordService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly creator: CreatorRepository,
    private readonly work: WorkRepository,
    private readonly commercial: CrmCommercialRepository,
  ) {}

  // ---- people ---------------------------------------------------------------------------------

  private async people(organizationId: string, ids: Iterable<string | null | undefined>, seat: 'CREATOR' | 'EMG'): Promise<(id: string | null | undefined) => PersonRef | null> {
    const wanted = [...new Set([...ids].filter((x): x is string => typeof x === 'string' && x !== ''))];
    const rows = wanted.length
      ? await this.prisma.user.findMany({ where: { id: { in: wanted }, organizationId }, select: { id: true, name: true, email: true } })
      : [];
    const map = new Map(rows.map((u) => [u.id, u]));
    return (id) => {
      if (!id) return null;
      const u = map.get(id);
      if (!u) return { userId: id, name: 'Someone' };
      return { userId: u.id, name: seat === 'CREATOR' ? firstName(u.name, u.email) : (u.name ?? u.email) };
    };
  }

  // ---- the content record ----------------------------------------------------------------------

  async contentRecord(seat: Seat, contentId: string): Promise<ContentRecordView | null> {
    const organizationId = seat.kind === 'CREATOR' ? seat.actor.organizationId : seat.organizationId;
    const content = await this.creator.getContent(organizationId, contentId);
    if (!content) return null;
    if (seat.kind === 'CREATOR' && content.creatorProfileId !== seat.actor.creatorProfileId) return null;
    return this.projectContent(seat, content);
  }

  private async projectContent(seat: Seat, content: ContentWithLineage): Promise<ContentRecordView> {
    const organizationId = content.organizationId;
    const isCreator = seat.kind === 'CREATOR';
    const instances = await this.work.getWorkInstances(organizationId, content.productions.map((p) => p.workInstanceId));
    const instructionsByWork = new Map<string, WorkInstruction[]>();
    for (const inst of instances) instructionsByWork.set(inst.id, await this.work.listInstructions(organizationId, inst.id));

    const ids: (string | null)[] = [content.creatorProfile.userId];
    for (const v of content.versions) {
      ids.push(v.uploadedByUserId);
      for (const a of v.approvals) ids.push(a.approvedByUserId);
      for (const p of v.publications) ids.push(p.markedByUserId);
    }
    for (const inst of instances) {
      ids.push(inst.createdByUserId, inst.expectedReturnSetByUserId);
      for (const s of inst.stages) ids.push(s.ownerUserId, s.completedByUserId);
      for (const c of inst.comments) ids.push(c.userId);
      for (const i of instructionsByWork.get(inst.id) ?? []) ids.push(i.enteredByUserId);
    }
    for (const p of content.productions) ids.push(p.requestedByUserId);
    const person = await this.people(organizationId, ids, seat.kind);

    const versionsAll = content.versions.map((v): VersionView => ({
      id: v.id,
      number: v.number,
      label: v.label,
      kind: v.kind === 'ORIGINAL' ? 'ORIGINAL' : 'EDIT',
      contentType: v.contentType,
      fileName: v.fileName,
      uploadState: v.uploadState === 'READY' ? 'READY' : v.uploadState === 'FAILED' ? 'FAILED' : 'PENDING',
      byteSize: v.byteSize,
      durationSeconds: v.durationSeconds,
      width: v.width,
      height: v.height,
      storageKey: v.storageKey,
      uploadedBy: person(v.uploadedByUserId),
      uploadedByKind: v.uploadedByKind === 'EMG' ? 'EMG' : 'CREATOR',
      createdAt: v.createdAt.toISOString(),
      readyAt: iso(v.readyAt),
      producedByWorkInstanceId: v.producedByWorkInstanceId,
      answersInstructionId: v.answersInstructionId,
      noteToCreator: v.noteToCreator,
      internalNote: isCreator ? null : v.internalNote,
      visibleToCreator: v.visibleToCreator,
      approvals: v.approvals.map((a) => ({ requirementKey: a.requirementKey, approverKind: a.approverKind, by: person(a.approvedByUserId), originatorLabel: a.originatorLabel, note: a.note, at: a.approvedAt.toISOString() })),
      publications: v.publications.map((p) => ({ id: p.id, platform: p.platform, url: p.url, at: p.publishedAt.toISOString(), by: person(p.markedByUserId) })),
    }));
    const versions = isCreator ? versionsAll.filter((v) => v.visibleToCreator) : versionsAll;
    const versionLabelOf = (id: string | null) => versionsAll.find((v) => v.id === id)?.label ?? null;

    const productions = content.productions.map((p): ProductionView => {
      const inst = instances.find((i) => i.id === p.workInstanceId) ?? null;
      const steps: StepView[] = (inst?.stages ?? []).map((s) => {
        const parsed = parseProductionStep(s.name);
        const meta = (s.metadata && typeof s.metadata === 'object' && !Array.isArray(s.metadata) ? (s.metadata as Record<string, unknown>) : {});
        return {
          id: s.id,
          position: s.position,
          name: s.name,
          kind: parsed?.kind ?? null,
          round: parsed?.round ?? null,
          status: s.status,
          owner: person(s.ownerUserId),
          startedAt: iso(s.startedAt),
          completedAt: iso(s.completedAt),
          completedBy: person(s.completedByUserId),
          note: typeof meta.completionNoteText === 'string' ? meta.completionNoteText : null,
        };
      });
      const current = inst && inst.status === 'active' ? steps.find((s) => s.id === inst.currentStageId) ?? null : null;
      const instructions = (instructionsByWork.get(p.workInstanceId) ?? [])
        .filter((i) => !isCreator || i.visibleToCreator)
        .map((i): InstructionView => ({
          id: i.id,
          sequence: i.sequence,
          originatorKind: i.originatorKind === 'EMG' ? 'EMG' : i.originatorKind === 'BRAND_RELAYED' ? 'BRAND_RELAYED' : 'CREATOR',
          originatorLabel: i.originatorLabel,
          enteredBy: person(i.enteredByUserId),
          refersToVersionId: i.refersToVersionId,
          refersToVersionLabel: versionLabelOf(i.refersToVersionId),
          summary: i.summary,
          notes: Array.isArray(i.notes) ? (i.notes as unknown as InstructionNote[]) : [],
          requestedReturnAt: iso(i.requestedReturnAt),
          answeredByVersionId: i.answeredByVersionId,
          answeredByVersionLabel: versionLabelOf(i.answeredByVersionId),
          answeredAt: iso(i.answeredAt),
          addressed: Array.isArray(i.addressed) ? (i.addressed as unknown as AddressedNote[]) : [],
          createdAt: i.createdAt.toISOString(),
        }));
      const comments = (inst?.comments ?? [])
        .filter((c: WorkComment) => !isCreator || c.visibility === 'creator_visible')
        .map((c): CommentView => ({ id: c.id, by: person(c.userId), body: c.body, visibility: c.visibility === 'creator_visible' ? 'creator_visible' : 'internal', at: c.createdAt.toISOString() }));
      return {
        id: p.id,
        number: p.number,
        kind: p.kind,
        workInstanceId: p.workInstanceId,
        workStatus: !inst ? 'cancelled' : inst.status === 'completed' ? 'completed' : inst.status === 'cancelled' ? 'cancelled' : 'active',
        sourceVersionId: p.sourceVersionId,
        requestedBy: person(p.requestedByUserId),
        requestedReturnAt: iso(inst?.requestedReturnAt ?? p.requestedReturnAt),
        expectedReturnAt: iso(inst?.expectedReturnAt),
        expectedReturnSetBy: person(inst?.expectedReturnSetByUserId),
        expectedReturnSetAt: iso(inst?.expectedReturnSetAt),
        createdAt: p.createdAt.toISOString(),
        completedAt: iso(p.completedAt ?? inst?.completedAt),
        currentStep: current,
        steps,
        instructions,
        comments,
      };
    });

    const { deliverable, requirements } = await this.requirementsFor(organizationId, content);
    const facts = content.productions.map((p) => productionFacts(p, instances.find((i) => i.id === p.workInstanceId) ?? null));
    const state = deriveContentState({ versions: content.versions.map(versionMarks), productions: facts, requirements });
    const marks = content.versions.filter((v) => v.visibleToCreator && v.uploadState === 'READY').map(versionMarks);
    const statusesByVersion = [...marks].sort((a, b) => b.number - a.number).map((m) => ({ m, s: requirementStatuses(requirements, m, (a) => person(a.by)?.name ?? 'Someone') }));
    const judged = statusesByVersion.find((x) => deliverableComplete(x.s)) ?? statusesByVersion[0] ?? null;
    const complete = judged ? deliverableComplete(judged.s) : false;
    const original = content.versions.find((v) => v.number === 0);
    const actions = creatorActionsFor({ state, hasDeliverable: deliverable !== null, acceptsUnedited: deliverable?.acceptsUnedited ?? false, hasReadyOriginal: original?.uploadState === 'READY' });

    const campaign = content.campaignId ? await this.commercial.getCampaign(organizationId, content.campaignId) : null;
    const opportunity = content.opportunityId ? await this.commercial.getOpportunity(organizationId, content.opportunityId) : null;
    const context: ContextView = {
      campaign: campaign ? { id: campaign.id, name: campaign.name, state: campaign.state, brandLabel: !isCreator || campaign.brandVisibleToCreator ? campaign.brandLabel : null } : null,
      deliverable: deliverable
        ? { id: deliverable.id, title: deliverable.title, dueAt: iso(deliverable.dueAt), status: deliverable.status, line: deliverableLine(state, complete || deliverable.status === 'COMPLETE'), complete: complete || deliverable.status === 'COMPLETE', acceptsUnedited: deliverable.acceptsUnedited }
        : null,
      opportunity: opportunity && (!isCreator || opportunity.creatorVisibleState)
        ? {
            id: opportunity.id,
            title: opportunity.title,
            creatorVisibleState: (opportunity.creatorVisibleState as CreatorVisibleOpportunityState | null) ?? null,
            label: opportunity.creatorVisibleState ? CREATOR_VISIBLE_OPPORTUNITY_LABELS[opportunity.creatorVisibleState as CreatorVisibleOpportunityState] ?? null : null,
          }
        : null,
    };

    const latestVersion = [...versions].filter((v) => v.uploadState === 'READY').sort((a, b) => b.number - a.number)[0] ?? [...versions].sort((a, b) => b.number - a.number)[0] ?? null;
    return {
      seat: seat.kind,
      id: content.id,
      title: content.title,
      kind: content.kind === 'PHOTO' ? 'PHOTO' : 'VIDEO',
      creator: { profileId: content.creatorProfile.id, partyId: content.creatorProfile.partyId, displayName: content.creatorProfile.displayName, userId: content.creatorProfile.userId },
      state,
      stateLabel: CONTENT_STATE_LABELS[state],
      createdAt: content.createdAt.toISOString(),
      versions,
      latestVersion,
      productions,
      activeProduction: productions.find((p) => p.workStatus === 'active') ?? null,
      requirements,
      requirementStatuses: judged?.s ?? requirementStatuses(requirements, null, () => ''),
      judgedVersion: judged ? versions.find((v) => v.id === judged.m.versionId) ?? null : null,
      context,
      actions,
    };
  }

  private async requirementsFor(organizationId: string, content: ContentWithLineage): Promise<{ deliverable: (CampaignDeliverable & { campaign: CrmCampaign }) | null; requirements: readonly DeliverableRequirement[] }> {
    if (!content.deliverableId) return { deliverable: null, requirements: INDEPENDENT_REQUIREMENTS };
    const deliverable = await this.commercial.getDeliverable(organizationId, content.deliverableId);
    if (!deliverable) return { deliverable: null, requirements: INDEPENDENT_REQUIREMENTS };
    const declared = readRequirements(deliverable.requirements);
    return { deliverable, requirements: declared.length > 0 ? declared : INDEPENDENT_REQUIREMENTS };
  }

  // ---- the library ------------------------------------------------------------------------------

  async library(seat: Seat, creatorProfileId: string): Promise<LibraryItem[]> {
    const organizationId = seat.kind === 'CREATOR' ? seat.actor.organizationId : seat.organizationId;
    if (seat.kind === 'CREATOR' && creatorProfileId !== seat.actor.creatorProfileId) return [];
    const contents = await this.creator.listContents(organizationId, creatorProfileId);
    const out: LibraryItem[] = [];
    for (const c of contents) {
      const record = await this.projectContent(seat, c);
      out.push({
        id: record.id,
        title: record.title,
        kind: record.kind,
        state: record.state,
        stateLabel: record.stateLabel,
        latestVersion: record.latestVersion,
        campaignName: record.context.campaign?.name ?? null,
        deliverableTitle: record.context.deliverable?.title ?? null,
        published: record.state === 'PUBLISHED',
        updatedAt: c.updatedAt.toISOString(),
      });
    }
    return out;
  }

  // ---- tasks ------------------------------------------------------------------------------------

  async tasks(actor: CreatorActor, hrefs: { content: (id: string) => string; profile: string }): Promise<CreatorTask[]> {
    const out: CreatorTask[] = [];
    const profile = await this.creator.profileById(actor.organizationId, actor.creatorProfileId);
    if (!profile) return out;
    const stages = await this.prisma.workStage.findMany({
      where: { ownerUserId: actor.userId, status: { in: ['ready', 'in_progress'] }, workInstance: { organizationId: actor.organizationId, status: 'active' } },
      include: { workInstance: true },
      orderBy: { startedAt: 'asc' },
    });
    for (const s of stages) {
      const parsed = parseProductionStep(s.name);
      if (parsed?.kind !== 'REVIEW') continue;
      const production = await this.creator.productionByWorkInstance(actor.organizationId, s.workInstanceId);
      if (!production || production.content.creatorProfileId !== actor.creatorProfileId) continue;
      const latest = [...production.content.versions].filter((v) => v.visibleToCreator && v.uploadState === 'READY').sort((a, b) => b.number - a.number)[0] ?? null;
      out.push({
        key: `review:${s.id}`,
        kind: 'REVIEW',
        title: `Review ${latest?.label ?? 'the returned version'} — ${production.content.title}`,
        detail: 'EMG returned an edit for your review.',
        dueAt: null,
        href: `${hrefs.content(production.content.id)}?review=${latest?.id ?? ''}`,
        bucket: 'NEEDS_ATTENTION',
      });
    }
    const deliverables = await this.commercial.listDeliverablesForCreator(actor.organizationId, profile.partyId);
    for (const d of deliverables) {
      if (d.status === 'COMPLETE') continue;
      if (!d.contentId) {
        out.push({ key: `deliverable:${d.id}`, kind: 'UPLOAD', title: `Upload ${d.title}`, detail: `${d.campaign.name}`, dueAt: iso(d.dueAt), href: `/app/creator/content?deliverable=${encodeURIComponent(d.id)}`, bucket: d.dueAt && d.dueAt.getTime() - Date.now() < 3 * 86400_000 ? 'NEEDS_ATTENTION' : 'UPCOMING' });
      } else {
        out.push({ key: `deliverable:${d.id}`, kind: 'DELIVERABLE', title: `${d.title} — due`, detail: `${d.campaign.name}`, dueAt: iso(d.dueAt), href: hrefs.content(d.contentId), bucket: 'UPCOMING' });
      }
    }
    const social = Array.isArray(profile.socialAccounts) ? (profile.socialAccounts as unknown as { state?: string }[]) : [];
    if (!social.some((s) => s.state && s.state !== 'NOT_CONNECTED')) {
      out.push({ key: 'setup:social', kind: 'SETUP', title: 'Connect a platform', detail: 'Analytics can only read what is connected.', dueAt: null, href: hrefs.profile, bucket: 'UPCOMING' });
    }
    if (profile.payoutState === 'NOT_SET_UP') {
      out.push({ key: 'setup:payout', kind: 'SETUP', title: 'Set up payouts', detail: 'Needed before anything can be transferred to you.', dueAt: null, href: hrefs.profile, bucket: 'UPCOMING' });
    }
    return out;
  }

  // ---- opportunities and campaigns ---------------------------------------------------------------

  async opportunities(seat: Seat, creatorPartyId: string): Promise<OpportunityView[]> {
    const organizationId = seat.kind === 'CREATOR' ? seat.actor.organizationId : seat.organizationId;
    const isCreator = seat.kind === 'CREATOR';
    const rows = await this.commercial.listOpportunitiesForCreator(organizationId, creatorPartyId);
    const campaigns = await this.campaigns(seat, creatorPartyId);
    const out: OpportunityView[] = [];
    for (const o of rows) {
      if (isCreator && !o.creatorVisibleState) continue;
      const state = (o.creatorVisibleState as CreatorVisibleOpportunityState | null) ?? null;
      out.push({
        id: o.id,
        title: o.title,
        creatorVisibleState: state,
        stateLabel: state ? CREATOR_VISIBLE_OPPORTUNITY_LABELS[state] ?? null : null,
        brandLabel: !isCreator || o.brandVisibleToCreator ? o.brandLabel : null,
        summary: o.summaryForCreator,
        updates: o.transitions.filter((t) => !isCreator || t.creatorVisible).map((t) => ({ at: t.occurredAt.toISOString(), note: t.note, toState: isCreator ? (state ? CREATOR_VISIBLE_OPPORTUNITY_LABELS[state] : '') : `${t.toCategory} · ${t.toStage}` })),
        campaigns: campaigns.filter((c) => o.campaigns.some((oc) => oc.id === c.id)),
        updatedAt: o.updatedAt.toISOString(),
        internal: isCreator ? null : { stage: o.stage, category: o.category, brandVisibleToCreator: o.brandVisibleToCreator, internalNotes: o.internalNotes, forecastProbability: o.forecastProbability, amountMinor: o.amountMinor, currency: o.currency, expectedCloseDate: iso(o.expectedCloseDate) },
      });
    }
    return out;
  }

  async campaigns(seat: Seat, creatorPartyId: string): Promise<CampaignView[]> {
    const organizationId = seat.kind === 'CREATOR' ? seat.actor.organizationId : seat.organizationId;
    const isCreator = seat.kind === 'CREATOR';
    const rows = await this.commercial.listCampaignsForCreator(organizationId, creatorPartyId);
    const out: CampaignView[] = [];
    for (const c of rows) {
      const deliverables: DeliverableView[] = [];
      for (const d of c.deliverables) {
        let contentTitle: string | null = null;
        let contentState: ContentState | null = null;
        let line = 'awaiting content';
        if (d.contentId) {
          const record = await this.contentRecord(seat, d.contentId);
          if (record) {
            contentTitle = record.title;
            contentState = record.state;
            line = record.context.deliverable?.line ?? deliverableLine(record.state, d.status === 'COMPLETE');
          }
        }
        deliverables.push({
          id: d.id,
          title: d.title,
          deliverableType: d.deliverableType,
          dueAt: iso(d.dueAt),
          status: d.status,
          requirements: readRequirements(d.requirements),
          acceptsUnedited: d.acceptsUnedited,
          contentId: d.contentId,
          contentTitle,
          contentState,
          line: d.status === 'COMPLETE' ? 'Complete' : line,
        });
      }
      out.push({
        id: c.id,
        name: c.name,
        state: c.state,
        brandLabel: !isCreator || c.brandVisibleToCreator ? c.brandLabel : null,
        startDate: iso(c.startDate),
        endDate: iso(c.endDate),
        creatorBrief: c.creatorBrief,
        deliverables,
        termsSummary: isCreator ? null : c.termsSummary,
      });
    }
    return out;
  }

  // ---- earnings ---------------------------------------------------------------------------------

  async earnings(organizationId: string, creatorProfileId: string): Promise<EarningsView> {
    const profile = await this.creator.profileById(organizationId, creatorProfileId);
    const entries = await this.creator.listCompensation(organizationId, creatorProfileId);
    const campaignIds = [...new Set(entries.map((e) => e.campaignId).filter((x): x is string => !!x))];
    const campaigns = campaignIds.length ? await this.prisma.crmCampaign.findMany({ where: { organizationId, id: { in: campaignIds } }, select: { id: true, name: true } }) : [];
    const deliverableIds = [...new Set(entries.map((e) => e.deliverableId).filter((x): x is string => !!x))];
    const deliverables = deliverableIds.length ? await this.prisma.campaignDeliverable.findMany({ where: { organizationId, id: { in: deliverableIds } }, select: { id: true, title: true } }) : [];
    const totals = { EXPECTED: 0, PENDING: 0, RECEIVED_BY_EMG: 0, AVAILABLE: 0, TRANSFER_PENDING: 0, PAID: 0 } as Record<CompensationState, number>;
    for (const e of entries) {
      const st = e.state as CompensationState;
      if (st in totals) totals[st] += e.amountMinor;
    }
    return {
      currency: entries[0]?.currency ?? 'USD',
      totals,
      availableMinor: totals[PAYABLE_COMPENSATION_STATE],
      entries: entries.map((e) => ({
        id: e.id,
        description: e.description,
        amountMinor: e.amountMinor,
        currency: e.currency,
        state: e.state as CompensationState,
        stateLabel: COMPENSATION_STATE_LABELS[e.state as CompensationState] ?? e.state,
        payable: e.state === PAYABLE_COMPENSATION_STATE,
        occurredAt: e.occurredAt.toISOString(),
        source: e.source,
        campaignName: campaigns.find((c) => c.id === e.campaignId)?.name ?? null,
        deliverableTitle: deliverables.find((d) => d.id === e.deliverableId)?.title ?? null,
      })),
      seeded: entries.some((e) => e.source === 'SEEDED_DEMO'),
      payoutState: profile?.payoutState ?? 'NOT_SET_UP',
    };
  }

  // ---- analytics --------------------------------------------------------------------------------

  async analytics(organizationId: string, creatorProfileId: string, filter: { platform?: string | null; days?: number | null } = {}): Promise<AnalyticsView> {
    const since = filter.days ? new Date(Date.now() - filter.days * 86400_000) : undefined;
    const [performance, audience, profile] = await Promise.all([
      this.creator.listPerformance(organizationId, creatorProfileId, { ...(filter.platform ? { platform: filter.platform } : {}), ...(since ? { since } : {}) }),
      this.creator.listAudience(organizationId, creatorProfileId),
      this.creator.profileById(organizationId, creatorProfileId),
    ]);
    const contentIds = [...new Set(performance.map((p) => p.contentId).filter((x): x is string => !!x))];
    const contents = contentIds.length ? await this.prisma.creatorContent.findMany({ where: { organizationId, id: { in: contentIds } }, select: { id: true, title: true } }) : [];
    const titleOf = (id: string | null) => contents.find((c) => c.id === id)?.title ?? null;
    const num = (m: unknown, k: string) => (m && typeof m === 'object' && typeof (m as Record<string, unknown>)[k] === 'number' ? ((m as Record<string, unknown>)[k] as number) : 0);
    const rows = performance.map((p) => ({
      id: p.id,
      contentId: p.contentId,
      contentTitle: titleOf(p.contentId),
      versionId: p.versionId,
      platform: p.platform,
      windowStart: p.windowStart.toISOString(),
      windowEnd: p.windowEnd.toISOString(),
      metrics: (p.metrics && typeof p.metrics === 'object' && !Array.isArray(p.metrics) ? (p.metrics as Record<string, number>) : {}),
      source: p.source,
    }));
    const totals = rows.reduce(
      (acc, r) => ({ views: acc.views + num(r.metrics, 'views'), reach: acc.reach + num(r.metrics, 'reach'), engagements: acc.engagements + num(r.metrics, 'likes') + num(r.metrics, 'comments') + num(r.metrics, 'saves') + num(r.metrics, 'shares') }),
      { views: 0, reach: 0, engagements: 0 },
    );
    const byContent = new Map<string, { title: string; views: number; platform: string }>();
    for (const r of rows) {
      if (!r.contentId) continue;
      const cur = byContent.get(r.contentId) ?? { title: r.contentTitle ?? 'Untitled', views: 0, platform: r.platform };
      cur.views += num(r.metrics, 'views');
      byContent.set(r.contentId, cur);
    }
    const latestByPlatform = new Map<string, (typeof audience)[number]>();
    for (const a of audience) latestByPlatform.set(a.platform, a);
    const social = profile && Array.isArray(profile.socialAccounts) ? (profile.socialAccounts as unknown as { platform?: string; state?: string }[]) : [];
    return {
      platforms: [...new Set([...rows.map((r) => r.platform), ...audience.map((a) => a.platform)])],
      audience: audience.map((a) => ({ platform: a.platform, observedAt: a.observedAt.toISOString(), followers: a.followers, growth30dPct: a.growth30dPct, source: a.source })),
      latestAudience: [...latestByPlatform.values()].map((a) => ({ platform: a.platform, followers: a.followers, growth30dPct: a.growth30dPct, observedAt: a.observedAt.toISOString(), source: a.source })),
      performance: rows,
      totals,
      topContent: [...byContent.entries()].map(([contentId, v]) => ({ contentId, ...v })).sort((a, b) => b.views - a.views).slice(0, 5),
      sources: [...new Set([...rows.map((r) => r.source), ...audience.map((a) => a.source)])],
      seeded: rows.some((r) => r.source === 'SEEDED_DEMO') || audience.some((a) => a.source === 'SEEDED_DEMO'),
      connected: social.some((s) => s.state === 'PLATFORM' || s.state === 'CONNECTED'),
    };
  }

  // ---- what Loop noticed ---------------------------------------------------------------------------

  /**
   * "What Loop noticed" for one piece of content: the pure Brain function over the facts the
   * rows hold (the versions' file facts, this content's performance rows, and the creator's
   * OTHER content's rows for a like-for-like comparison). Nothing is concluded here.
   */
  async contentNotice(seat: Seat, record: ContentRecordView, now: Date = new Date()): Promise<ContentNotice> {
    const organizationId = seat.kind === 'CREATOR' ? seat.actor.organizationId : seat.organizationId;
    const rows = await this.creator.listPerformance(organizationId, record.creator.profileId);
    const performance: NoticePerformanceRow[] = rows
      .filter((r) => r.contentId !== null)
      .map((r) => ({
        contentId: r.contentId,
        platform: r.platform,
        windowStart: r.windowStart.toISOString(),
        windowEnd: r.windowEnd.toISOString(),
        metrics: (r.metrics && typeof r.metrics === 'object' && !Array.isArray(r.metrics) ? (r.metrics as Record<string, number>) : {}),
        source: r.source,
        observedAt: r.observedAt.toISOString(),
      }));
    return creatorContentNotice({
      contentId: record.id,
      kind: record.kind,
      state: record.state,
      versions: record.versions.map((v) => ({
        versionId: v.id,
        label: v.label,
        number: v.number,
        kind: v.kind,
        durationSeconds: v.durationSeconds,
        width: v.width,
        height: v.height,
        byteSize: v.byteSize,
        readyAt: v.readyAt,
      })),
      published: record.versions.flatMap((v) => v.publications.map((p) => ({ platform: p.platform, at: p.at }))),
      performance,
      now: now.toISOString(),
    });
  }

  // ---- EMG: roster and requests ---------------------------------------------------------------------

  async roster(organizationId: string): Promise<{ profile: CreatorProfile; needsEmg: number; needsCreator: number; inProduction: number; dueSoon: number; contentCount: number }[]> {
    const profiles = await this.creator.listProfiles(organizationId);
    const productions = await this.creator.listProductionsForOrganization(organizationId);
    const instances = await this.work.getWorkInstances(organizationId, productions.filter((p) => p.completedAt === null).map((p) => p.workInstanceId));
    const out = [];
    for (const profile of profiles) {
      const mine = productions.filter((p) => p.content.creatorProfileId === profile.id);
      let needsEmg = 0;
      let needsCreator = 0;
      let inProduction = 0;
      for (const p of mine) {
        const inst = instances.find((i) => i.id === p.workInstanceId);
        if (!inst || inst.status !== 'active') continue;
        inProduction += 1;
        const current = inst.stages.find((s) => s.id === inst.currentStageId);
        const parsed = current ? parseProductionStep(current.name) : null;
        if (parsed?.kind === 'REVIEW') needsCreator += 1;
        else needsEmg += 1;
      }
      const deliverables = await this.commercial.listDeliverablesForCreator(organizationId, profile.partyId);
      const dueSoon = deliverables.filter((d) => d.status !== 'COMPLETE' && d.dueAt && d.dueAt.getTime() - Date.now() < 7 * 86400_000).length;
      const contentCount = (await this.creator.listContents(organizationId, profile.id)).length;
      out.push({ profile, needsEmg, needsCreator, inProduction, dueSoon, contentCount });
    }
    return out;
  }

  async requests(organizationId: string): Promise<{ production: ProductionView; contentId: string; contentTitle: string; creator: CreatorProfile; needs: 'EMG' | 'CREATOR' | 'DONE' }[]> {
    const productions = await this.creator.listProductionsForOrganization(organizationId);
    const out = [];
    for (const p of productions) {
      const record = await this.contentRecord({ kind: 'EMG', organizationId }, p.contentId);
      const view = record?.productions.find((x) => x.id === p.id);
      if (!record || !view) continue;
      const needs: 'EMG' | 'CREATOR' | 'DONE' = view.workStatus !== 'active' ? 'DONE' : view.currentStep?.kind === 'REVIEW' ? 'CREATOR' : 'EMG';
      out.push({ production: view, contentId: record.id, contentTitle: record.title, creator: p.content.creatorProfile, needs });
    }
    return out;
  }

  /** For the Work OS detail pages: the production behind a work instance, if it is one. */
  async productionForWork(organizationId: string, workInstanceId: string): Promise<{ record: ContentRecordView; production: ProductionView } | null> {
    const production = await this.creator.productionByWorkInstance(organizationId, workInstanceId);
    if (!production) return null;
    const record = await this.contentRecord({ kind: 'EMG', organizationId }, production.contentId);
    const view = record?.productions.find((p) => p.id === production.id);
    if (!record || !view) return null;
    return { record, production: view };
  }
}

export type { WorkInstance, WorkStage };

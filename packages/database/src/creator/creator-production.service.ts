// Creator productions: the orchestration between the creator domain and Work OS
// (Creator Hub, 2026-09-22).
//
// A PRODUCTION IS A WORK ITEM. "Request an edit" creates a real Work OS work item
// of the organization's "Creator production" type with two steps -- Edit (EMG)
// and Creator review (the creator's own login) -- and a ContentProduction row
// that joins it to the content. Everything after that is Work OS moving:
//
//   return a version   = the Edit step completes; the review step becomes the creator's
//   request changes    = the review step completes with a further round APPENDED to the
//                        same work item (nothing is reopened; the log stays append-only)
//   approve            = the review step completes with nothing after it; the work item
//                        completes; the production is stamped complete
//
// WHAT NOBODY MAY DO. The creator acts only on their own content and only on a step
// assigned to their login. EMG acts on Edit steps they own (an ADMIN may act on any).
// No act here decides that a deliverable is complete; `reconcileDeliverable` reads
// the deliverable's declared requirements against the version's marks and stamps
// the result, so "approved" never silently becomes "done".

import type { PrismaClient, ContentVersion, WorkInstance, WorkStage } from '@prisma/client';
import {
  PRODUCTION_STEP_EDIT,
  PRODUCTION_STEP_REVIEW,
  PRODUCTION_WORK_TYPE_KEY,
  PRODUCTION_WORK_TYPE_NAME,
  productionStepName,
  readRequirements,
  requirementStatuses,
  deliverableComplete,
  deriveContentState,
  creatorActionsFor,
  INDEPENDENT_REQUIREMENTS,
  type InstructionNote,
  type AddressedNote,
  type VersionMarks,
  type ProductionFacts,
} from '@emgloop/shared';
import type { WorkRepository } from '../repositories/work.repository';
import type { WorkflowStepDef } from '../work-os/workflow';
import { CreatorRepository, type ContentWithLineage } from './creator.repository';
import { CrmCommercialRepository } from './crm-commercial.repository';

export interface CreatorActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly creatorProfileId: string;
}

export interface EmgActor {
  readonly organizationId: string;
  readonly userId: string;
  /** True for the ADMIN workspace: may act on any Edit step, not only their own. */
  readonly canActOnAnyStep: boolean;
}

export type ProductionRefusal =
  | 'NOT_FOUND'
  | 'NOT_YOURS'
  | 'NOT_ALLOWED'
  | 'INVALID'
  | 'PRODUCTION_ACTIVE'
  | 'NO_ACTIVE_PRODUCTION'
  | 'NOT_YOUR_STEP'
  | 'VERSION_NOT_READY';

export type ProductionResult<T> = { ok: true; value: T } | { ok: false; reason: ProductionRefusal; detail?: string };

const refuse = <T>(reason: ProductionRefusal, detail?: string): ProductionResult<T> => ({ ok: false, reason, ...(detail ? { detail } : {}) });

/** Parse a production step's kind and round from its Work OS name. */
export function parseProductionStep(name: string): { kind: 'EDIT' | 'REVIEW'; round: number } | null {
  const m = /^(Edit|Creator review)(?: · round (\d+))?$/.exec(name);
  if (!m) return null;
  return { kind: m[1] === PRODUCTION_STEP_EDIT ? 'EDIT' : 'REVIEW', round: m[2] ? Number(m[2]) : 1 };
}

/** The projection of a work instance a production needs, for the state derivation. */
export function productionFacts(production: { number: number }, instance: (WorkInstance & { stages: WorkStage[] }) | null): ProductionFacts {
  if (!instance) return { number: production.number, workStatus: 'cancelled', currentStep: null };
  const current = instance.stages.find((s) => s.id === instance.currentStageId) ?? null;
  const parsed = current ? parseProductionStep(current.name) : null;
  return {
    number: production.number,
    workStatus: instance.status === 'completed' ? 'completed' : instance.status === 'cancelled' ? 'cancelled' : 'active',
    currentStep: instance.status === 'active' && current && parsed ? { kind: parsed.kind, round: parsed.round, status: current.status } : null,
  };
}

export function versionMarks(v: ContentWithLineage['versions'][number]): VersionMarks {
  return {
    versionId: v.id,
    label: v.label,
    number: v.number,
    uploadState: v.uploadState === 'READY' ? 'READY' : v.uploadState === 'FAILED' ? 'FAILED' : 'PENDING',
    kind: v.kind === 'ORIGINAL' ? 'ORIGINAL' : 'EDIT',
    visibleToCreator: v.visibleToCreator,
    createdAt: v.createdAt.toISOString(),
    approvals: v.approvals.map((a) => ({
      requirementKey: a.requirementKey as VersionMarks['approvals'][number]['requirementKey'],
      approverKind: a.approverKind as VersionMarks['approvals'][number]['approverKind'],
      by: a.approvedByUserId,
      at: a.approvedAt.toISOString(),
    })),
    published: v.publications.map((p) => ({ platform: p.platform, at: p.publishedAt.toISOString() })),
  };
}

export class CreatorProductionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly creator: CreatorRepository,
    private readonly work: WorkRepository,
    private readonly commercial: CrmCommercialRepository,
  ) {}

  // ---- the work type every production uses -------------------------------------------------

  async ensureProductionWorkType(organizationId: string, createdByUserId: string): Promise<string> {
    const types = await this.work.listWorkTypes(organizationId, { includeInactive: true });
    const existing = types.find((t) => t.catalogKey === PRODUCTION_WORK_TYPE_KEY);
    if (existing) {
      if (!existing.active) await this.work.setWorkTypeActive(organizationId, existing.id, true);
      return existing.id;
    }
    const created = await this.work.createWorkType({
      organizationId,
      createdByUserId,
      name: PRODUCTION_WORK_TYPE_NAME,
      description: 'Editing and other production a creator asks EMG for. Started from a creator’s Content record, never from Start Work.',
      category: 'Creator',
      catalogKey: PRODUCTION_WORK_TYPE_KEY,
      sortOrder: 900,
    });
    return created.id;
  }

  private editStep(round: number, ownerUserId: string | null, instruction: string): WorkflowStepDef {
    return {
      name: productionStepName(PRODUCTION_STEP_EDIT, round),
      instruction,
      assignment: ownerUserId ? { mode: 'specific', specificUserId: ownerUserId, responsibilityKey: null } : { mode: 'unassigned', specificUserId: null, responsibilityKey: null },
      completionConfirmation: null,
      completionNote: 'optional',
      notifyActive: true,
      notifyComplete: false,
    };
  }

  private reviewStep(round: number, creatorUserId: string): WorkflowStepDef {
    return {
      name: productionStepName(PRODUCTION_STEP_REVIEW, round),
      instruction: 'Review the returned version: approve it, or request changes.',
      assignment: { mode: 'specific', specificUserId: creatorUserId, responsibilityKey: null },
      completionConfirmation: null,
      completionNote: 'optional',
      notifyActive: true,
      notifyComplete: false,
    };
  }

  private async activeMembers(organizationId: string): Promise<Set<string>> {
    const members = await this.work.listActiveMembers(organizationId);
    return new Set(members.map((m) => m.id));
  }

  private async ownContent(actor: CreatorActor, contentId: string): Promise<ProductionResult<ContentWithLineage>> {
    const content = await this.creator.getContent(actor.organizationId, contentId);
    if (!content) return refuse('NOT_FOUND');
    if (content.creatorProfileId !== actor.creatorProfileId) return refuse('NOT_FOUND'); // another creator's content is not-found, never forbidden
    return { ok: true, value: content };
  }

  private async activeProduction(organizationId: string, content: ContentWithLineage): Promise<{ production: ContentWithLineage['productions'][number]; instance: WorkInstance & { stages: WorkStage[] } } | null> {
    const open = content.productions.filter((p) => p.completedAt === null);
    for (const p of open) {
      const instance = await this.work.getWorkInstance(organizationId, p.workInstanceId);
      if (instance && instance.status === 'active') return { production: p, instance };
    }
    return null;
  }

  // ---- creator acts --------------------------------------------------------------------------

  async requestEdit(
    actor: CreatorActor,
    input: { contentId: string; sourceVersionId: string; summary: string | null; notes: readonly InstructionNote[]; requestedReturnAt: Date | null },
  ): Promise<ProductionResult<{ productionId: string; workInstanceId: string; instructionId: string }>> {
    const own = await this.ownContent(actor, input.contentId);
    if (!own.ok) return own;
    const content = own.value;
    if (await this.activeProduction(actor.organizationId, content)) return refuse('PRODUCTION_ACTIVE', 'This content is already in production.');
    const source = content.versions.find((v) => v.id === input.sourceVersionId && v.visibleToCreator);
    if (!source) return refuse('NOT_FOUND', 'That version is not on this content.');
    if (source.uploadState !== 'READY') return refuse('VERSION_NOT_READY');
    const summary = (input.summary ?? '').trim();
    if (summary === '' && input.notes.length === 0) return refuse('INVALID', 'Say what you would like changed.');

    const workTypeId = await this.ensureProductionWorkType(actor.organizationId, actor.userId);
    const activeMemberIds = await this.activeMembers(actor.organizationId);
    const editor = content.creatorProfile.defaultEditorUserId && activeMemberIds.has(content.creatorProfile.defaultEditorUserId) ? content.creatorProfile.defaultEditorUserId : null;
    const round = content.productions.length + 1;

    const instance = await this.work.createWorkItem({
      organizationId: actor.organizationId,
      creatorUserId: actor.userId,
      workTypeId,
      workTypeName: PRODUCTION_WORK_TYPE_NAME,
      title: `Production ${round} · ${content.title}`,
      outcome: summary || 'Edit as the creator’s notes describe.',
      details: null,
      relatedRecord: { type: 'CONTENT', id: content.id, label: content.title },
      priority: 'normal',
      steps: [this.editStep(1, editor, summary || 'Edit as the creator’s notes describe.'), this.reviewStep(1, actor.userId)],
      responsibilityOwners: null,
      activeMemberIds,
      requestedReturnAt: input.requestedReturnAt,
    });
    const production = await this.creator.createProduction({
      organizationId: actor.organizationId,
      contentId: content.id,
      workInstanceId: instance.id,
      sourceVersionId: source.id,
      requestedByUserId: actor.userId,
      requestedReturnAt: input.requestedReturnAt,
    });
    const instruction = await this.work.addInstruction({
      organizationId: actor.organizationId,
      workInstanceId: instance.id,
      workStageId: instance.currentStageId ?? null,
      originatorKind: 'CREATOR',
      enteredByUserId: actor.userId,
      refersToVersionId: source.id,
      summary: summary || null,
      notes: input.notes as unknown as Record<string, unknown>[],
      requestedReturnAt: input.requestedReturnAt,
    });
    return { ok: true, value: { productionId: production.id, workInstanceId: instance.id, instructionId: instruction.id } };
  }

  /** The creator adds a note to the active production without changing its state. */
  async addCreatorNote(actor: CreatorActor, input: { contentId: string; body: string }): Promise<ProductionResult<{ commentId: string }>> {
    const own = await this.ownContent(actor, input.contentId);
    if (!own.ok) return own;
    const active = await this.activeProduction(actor.organizationId, own.value);
    if (!active) return refuse('NO_ACTIVE_PRODUCTION');
    const body = input.body.trim();
    if (!body) return refuse('INVALID');
    const comment = await this.work.addWorkComment({
      organizationId: actor.organizationId,
      workInstanceId: active.instance.id,
      workStageId: active.instance.currentStageId ?? null,
      userId: actor.userId,
      body,
      visibility: 'creator_visible',
    });
    return { ok: true, value: { commentId: comment.id } };
  }

  async requestChanges(
    actor: CreatorActor,
    input: { contentId: string; summary: string | null; notes: readonly InstructionNote[]; requestedReturnAt: Date | null },
  ): Promise<ProductionResult<{ workInstanceId: string; instructionId: string; round: number }>> {
    const own = await this.ownContent(actor, input.contentId);
    if (!own.ok) return own;
    const content = own.value;
    const active = await this.activeProduction(actor.organizationId, content);
    if (!active) return refuse('NO_ACTIVE_PRODUCTION');
    const current = active.instance.stages.find((s) => s.id === active.instance.currentStageId) ?? null;
    const parsed = current ? parseProductionStep(current.name) : null;
    if (!current || !parsed || parsed.kind !== 'REVIEW') return refuse('NOT_YOUR_STEP', 'Nothing is waiting for your review.');
    if (current.ownerUserId !== actor.userId) return refuse('NOT_YOUR_STEP');
    if ((input.summary ?? '').trim() === '' && input.notes.length === 0) return refuse('INVALID', 'Add at least one note.');

    const latest = [...content.versions].filter((v) => v.visibleToCreator && v.uploadState === 'READY').sort((a, b) => b.number - a.number)[0] ?? null;
    const instruction = await this.work.addInstruction({
      organizationId: actor.organizationId,
      workInstanceId: active.instance.id,
      workStageId: current.id,
      originatorKind: 'CREATOR',
      enteredByUserId: actor.userId,
      refersToVersionId: latest?.id ?? null,
      summary: (input.summary ?? '').trim() || null,
      notes: input.notes as unknown as Record<string, unknown>[],
      requestedReturnAt: input.requestedReturnAt,
    });
    const activeMemberIds = await this.activeMembers(actor.organizationId);
    // The next round goes back to whoever returned the last version, when they are still a member.
    const lastEdit = [...active.instance.stages].filter((s) => parseProductionStep(s.name)?.kind === 'EDIT' && s.status === 'completed').sort((a, b) => b.position - a.position)[0] ?? null;
    const editor = lastEdit?.completedByUserId && activeMemberIds.has(lastEdit.completedByUserId) ? lastEdit.completedByUserId : null;
    const round = parsed.round + 1;
    await this.work.completeWorkStep({
      organizationId: actor.organizationId,
      workInstanceId: active.instance.id,
      stageId: current.id,
      completedByUserId: actor.userId,
      note: 'Changes requested',
      activeMemberIds,
      appendSteps: [this.editStep(round, editor, (input.summary ?? '').trim() || 'Answer the creator’s notes.'), this.reviewStep(round, actor.userId)],
    });
    return { ok: true, value: { workInstanceId: active.instance.id, instructionId: instruction.id, round } };
  }

  async approveVersion(actor: CreatorActor, input: { contentId: string; versionId: string }): Promise<ProductionResult<{ productionCompleted: boolean }>> {
    const own = await this.ownContent(actor, input.contentId);
    if (!own.ok) return own;
    const content = own.value;
    const version = content.versions.find((v) => v.id === input.versionId && v.visibleToCreator);
    if (!version) return refuse('NOT_FOUND');
    if (version.uploadState !== 'READY') return refuse('VERSION_NOT_READY');
    await this.creator.recordApproval({
      organizationId: actor.organizationId,
      contentId: content.id,
      versionId: version.id,
      requirementKey: 'creator',
      approverKind: 'CREATOR',
      approvedByUserId: actor.userId,
    });
    let productionCompleted = false;
    const active = await this.activeProduction(actor.organizationId, content);
    if (active) {
      const current = active.instance.stages.find((s) => s.id === active.instance.currentStageId) ?? null;
      const parsed = current ? parseProductionStep(current.name) : null;
      if (current && parsed?.kind === 'REVIEW' && current.ownerUserId === actor.userId) {
        const activeMemberIds = await this.activeMembers(actor.organizationId);
        const done = await this.work.completeWorkStep({
          organizationId: actor.organizationId,
          workInstanceId: active.instance.id,
          stageId: current.id,
          completedByUserId: actor.userId,
          note: `Approved ${version.label}`,
          activeMemberIds,
        });
        if (done.status === 'completed') {
          await this.creator.completeProduction(actor.organizationId, active.production.id);
          productionCompleted = true;
        }
      }
    }
    await this.reconcileDeliverable(actor.organizationId, content.id);
    return { ok: true, value: { productionCompleted } };
  }

  /** Ruling 3: an unedited Original may enter the approval process when the deliverable permits. */
  async submitOriginalForApproval(actor: CreatorActor, input: { contentId: string }): Promise<ProductionResult<{ versionId: string }>> {
    const own = await this.ownContent(actor, input.contentId);
    if (!own.ok) return own;
    const content = own.value;
    const deliverable = content.deliverableId ? await this.commercial.getDeliverable(actor.organizationId, content.deliverableId) : null;
    if (!deliverable || !deliverable.acceptsUnedited) return refuse('NOT_ALLOWED', 'This deliverable needs a production first.');
    const original = content.versions.find((v) => v.number === 0);
    if (!original || original.uploadState !== 'READY') return refuse('VERSION_NOT_READY');
    await this.creator.recordApproval({ organizationId: actor.organizationId, contentId: content.id, versionId: original.id, requirementKey: 'creator', approverKind: 'CREATOR', approvedByUserId: actor.userId });
    await this.reconcileDeliverable(actor.organizationId, content.id);
    return { ok: true, value: { versionId: original.id } };
  }

  async markPublished(
    actor: CreatorActor,
    input: { contentId: string; versionId: string; platform: string; url: string | null; publishedAt: Date },
  ): Promise<ProductionResult<{ publicationId: string }>> {
    const own = await this.ownContent(actor, input.contentId);
    if (!own.ok) return own;
    const content = own.value;
    const version = content.versions.find((v) => v.id === input.versionId && v.visibleToCreator);
    if (!version) return refuse('NOT_FOUND');
    if (version.uploadState !== 'READY') return refuse('VERSION_NOT_READY');
    const allowed = await this.creatorActions(actor.organizationId, content);
    if (!allowed.markPublished && !allowed.publishAsIs) return refuse('NOT_ALLOWED', 'This content is not ready to publish.');
    const publication = await this.creator.recordPublication({
      organizationId: actor.organizationId,
      contentId: content.id,
      versionId: version.id,
      platform: input.platform,
      url: input.url,
      publishedAt: input.publishedAt,
      markedByUserId: actor.userId,
    });
    await this.reconcileDeliverable(actor.organizationId, content.id);
    return { ok: true, value: { publicationId: publication.id } };
  }

  // ---- EMG acts -------------------------------------------------------------------------------

  private async emgProduction(actor: EmgActor, workInstanceId: string) {
    const production = await this.creator.productionByWorkInstance(actor.organizationId, workInstanceId);
    if (!production) return null;
    const instance = await this.work.getWorkInstance(actor.organizationId, workInstanceId);
    if (!instance) return null;
    return { production, instance };
  }

  async setExpectedReturn(actor: EmgActor, input: { workInstanceId: string; expectedReturnAt: Date | null }): Promise<ProductionResult<{ workInstanceId: string }>> {
    const found = await this.emgProduction(actor, input.workInstanceId);
    if (!found) return refuse('NOT_FOUND');
    await this.work.setExpectedReturn({ organizationId: actor.organizationId, workInstanceId: input.workInstanceId, expectedReturnAt: input.expectedReturnAt, setByUserId: actor.userId });
    return { ok: true, value: { workInstanceId: input.workInstanceId } };
  }

  /**
   * An EMG editor returns an uploaded version for the creator's review: the version answers the
   * latest unanswered instruction set, becomes visible, and the Edit step completes.
   */
  async returnVersionForReview(
    actor: EmgActor,
    input: { workInstanceId: string; versionId: string; noteToCreator: string | null; addressed: readonly AddressedNote[] },
  ): Promise<ProductionResult<{ workInstanceId: string }>> {
    const found = await this.emgProduction(actor, input.workInstanceId);
    if (!found) return refuse('NOT_FOUND');
    const { production, instance } = found;
    if (instance.status !== 'active') return refuse('NO_ACTIVE_PRODUCTION');
    const current = instance.stages.find((s) => s.id === instance.currentStageId) ?? null;
    const parsed = current ? parseProductionStep(current.name) : null;
    if (!current || !parsed || parsed.kind !== 'EDIT') return refuse('NOT_YOUR_STEP', 'The work is not on an Edit step.');
    if (!actor.canActOnAnyStep && current.ownerUserId !== actor.userId) return refuse('NOT_YOUR_STEP');
    const version = await this.creator.getVersion(actor.organizationId, input.versionId);
    if (!version || version.contentId !== production.contentId) return refuse('NOT_FOUND');
    if (version.uploadState !== 'READY') return refuse('VERSION_NOT_READY');
    if (version.kind !== 'EDIT') return refuse('INVALID', 'Only an edit can be returned.');

    const instructions = await this.work.listInstructions(actor.organizationId, instance.id);
    const open = [...instructions].reverse().find((i) => i.answeredByVersionId === null) ?? null;
    if (open) {
      await this.work.answerInstruction({ organizationId: actor.organizationId, instructionId: open.id, answeredByVersionId: version.id, addressed: input.addressed as unknown as Record<string, unknown>[] });
    }
    await this.creator.setVersionProvenance(actor.organizationId, version.id, { producedByWorkInstanceId: instance.id, answersInstructionId: open?.id ?? null });
    await this.creator.setVersionVisibility(actor.organizationId, version.id, true, input.noteToCreator);
    const activeMemberIds = await this.activeMembers(actor.organizationId);
    await this.work.completeWorkStep({
      organizationId: actor.organizationId,
      workInstanceId: instance.id,
      stageId: current.id,
      completedByUserId: actor.userId,
      note: input.noteToCreator,
      activeMemberIds,
    });
    return { ok: true, value: { workInstanceId: instance.id } };
  }

  async recordEmgApproval(actor: EmgActor, input: { contentId: string; versionId: string; note: string | null }): Promise<ProductionResult<{ versionId: string }>> {
    const content = await this.creator.getContent(actor.organizationId, input.contentId);
    if (!content) return refuse('NOT_FOUND');
    const version = content.versions.find((v) => v.id === input.versionId);
    if (!version) return refuse('NOT_FOUND');
    if (version.uploadState !== 'READY') return refuse('VERSION_NOT_READY');
    await this.creator.recordApproval({ organizationId: actor.organizationId, contentId: content.id, versionId: version.id, requirementKey: 'emg', approverKind: 'EMG', approvedByUserId: actor.userId, note: input.note });
    await this.reconcileDeliverable(actor.organizationId, content.id);
    return { ok: true, value: { versionId: version.id } };
  }

  /** A brand's approval, relayed: originated by the brand, entered by this employee. Two facts. */
  async recordBrandApproval(actor: EmgActor, input: { contentId: string; versionId: string; originatorLabel: string; note: string | null }): Promise<ProductionResult<{ versionId: string }>> {
    const content = await this.creator.getContent(actor.organizationId, input.contentId);
    if (!content) return refuse('NOT_FOUND');
    const version = content.versions.find((v) => v.id === input.versionId);
    if (!version) return refuse('NOT_FOUND');
    if (version.uploadState !== 'READY') return refuse('VERSION_NOT_READY');
    const label = input.originatorLabel.trim();
    if (!label) return refuse('INVALID', 'Say who approved it.');
    await this.creator.recordApproval({ organizationId: actor.organizationId, contentId: content.id, versionId: version.id, requirementKey: 'brand', approverKind: 'BRAND_RELAYED', approvedByUserId: actor.userId, originatorLabel: label, note: input.note });
    await this.reconcileDeliverable(actor.organizationId, content.id);
    return { ok: true, value: { versionId: version.id } };
  }

  /**
   * Brand or agency feedback, relayed by EMG. If a production is active and waiting on the
   * creator's review, it continues that production with a further round; if none is active
   * (ruling 4), it starts the NEXT production on the same lineage.
   */
  async relayBrandFeedback(
    actor: EmgActor,
    input: { contentId: string; originatorLabel: string; summary: string | null; notes: readonly InstructionNote[]; requestedReturnAt: Date | null },
  ): Promise<ProductionResult<{ workInstanceId: string; productionNumber: number; instructionId: string }>> {
    const content = await this.creator.getContent(actor.organizationId, input.contentId);
    if (!content) return refuse('NOT_FOUND');
    const label = input.originatorLabel.trim();
    if (!label) return refuse('INVALID', 'Say who the feedback is from.');
    if ((input.summary ?? '').trim() === '' && input.notes.length === 0) return refuse('INVALID', 'Add the feedback.');
    const latest = [...content.versions].filter((v) => v.uploadState === 'READY').sort((a, b) => b.number - a.number)[0] ?? null;
    if (!latest) return refuse('VERSION_NOT_READY');
    const activeMemberIds = await this.activeMembers(actor.organizationId);
    const creatorUserId = content.creatorProfile.userId;
    if (!creatorUserId) return refuse('NOT_ALLOWED', 'This creator has no login yet.');

    const active = await this.activeProduction(actor.organizationId, content);
    if (active) {
      const current = active.instance.stages.find((s) => s.id === active.instance.currentStageId) ?? null;
      const parsed = current ? parseProductionStep(current.name) : null;
      if (!current || !parsed) return refuse('INVALID');
      const instruction = await this.work.addInstruction({
        organizationId: actor.organizationId,
        workInstanceId: active.instance.id,
        workStageId: current.id,
        originatorKind: 'BRAND_RELAYED',
        originatorLabel: label,
        enteredByUserId: actor.userId,
        refersToVersionId: latest.id,
        summary: (input.summary ?? '').trim() || null,
        notes: input.notes as unknown as Record<string, unknown>[],
        requestedReturnAt: input.requestedReturnAt,
      });
      if (parsed.kind === 'REVIEW') {
        const lastEdit = [...active.instance.stages].filter((s) => parseProductionStep(s.name)?.kind === 'EDIT' && s.status === 'completed').sort((a, b) => b.position - a.position)[0] ?? null;
        const editor = lastEdit?.completedByUserId && activeMemberIds.has(lastEdit.completedByUserId) ? lastEdit.completedByUserId : null;
        const round = parsed.round + 1;
        await this.work.completeWorkStep({
          organizationId: actor.organizationId,
          workInstanceId: active.instance.id,
          stageId: current.id,
          completedByUserId: actor.userId,
          note: `Changes requested by ${label} (relayed)`,
          activeMemberIds,
          appendSteps: [this.editStep(round, editor, (input.summary ?? '').trim() || `Answer ${label}’s notes.`), this.reviewStep(round, creatorUserId)],
        });
      }
      return { ok: true, value: { workInstanceId: active.instance.id, productionNumber: active.production.number, instructionId: instruction.id } };
    }

    const workTypeId = await this.ensureProductionWorkType(actor.organizationId, actor.userId);
    const editor = content.creatorProfile.defaultEditorUserId && activeMemberIds.has(content.creatorProfile.defaultEditorUserId) ? content.creatorProfile.defaultEditorUserId : null;
    const number = content.productions.length + 1;
    const instance = await this.work.createWorkItem({
      organizationId: actor.organizationId,
      creatorUserId: actor.userId,
      workTypeId,
      workTypeName: PRODUCTION_WORK_TYPE_NAME,
      title: `Production ${number} · ${content.title}`,
      outcome: (input.summary ?? '').trim() || `Answer ${label}’s notes.`,
      details: null,
      relatedRecord: { type: 'CONTENT', id: content.id, label: content.title },
      priority: 'normal',
      steps: [this.editStep(1, editor, (input.summary ?? '').trim() || `Answer ${label}’s notes.`), this.reviewStep(1, creatorUserId)],
      responsibilityOwners: null,
      activeMemberIds,
      requestedReturnAt: input.requestedReturnAt,
    });
    const production = await this.creator.createProduction({
      organizationId: actor.organizationId,
      contentId: content.id,
      workInstanceId: instance.id,
      sourceVersionId: latest.id,
      requestedByUserId: actor.userId,
      requestedReturnAt: input.requestedReturnAt,
    });
    const instruction = await this.work.addInstruction({
      organizationId: actor.organizationId,
      workInstanceId: instance.id,
      workStageId: instance.currentStageId ?? null,
      originatorKind: 'BRAND_RELAYED',
      originatorLabel: label,
      enteredByUserId: actor.userId,
      refersToVersionId: latest.id,
      summary: (input.summary ?? '').trim() || null,
      notes: input.notes as unknown as Record<string, unknown>[],
      requestedReturnAt: input.requestedReturnAt,
    });
    return { ok: true, value: { workInstanceId: instance.id, productionNumber: production.number, instructionId: instruction.id } };
  }

  async addEmgComment(actor: EmgActor, input: { workInstanceId: string; body: string; visibility: 'internal' | 'creator_visible' }): Promise<ProductionResult<{ commentId: string }>> {
    const found = await this.emgProduction(actor, input.workInstanceId);
    if (!found) return refuse('NOT_FOUND');
    const body = input.body.trim();
    if (!body) return refuse('INVALID');
    const comment = await this.work.addWorkComment({
      organizationId: actor.organizationId,
      workInstanceId: input.workInstanceId,
      workStageId: found.instance.currentStageId ?? null,
      userId: actor.userId,
      body,
      visibility: input.visibility,
    });
    return { ok: true, value: { commentId: comment.id } };
  }

  // ---- derived facts shared by both seats ------------------------------------------------------

  /** The requirements a piece of content is judged against: its deliverable's, or the independent set. */
  async requirementsFor(organizationId: string, content: ContentWithLineage) {
    if (!content.deliverableId) return { deliverable: null, requirements: INDEPENDENT_REQUIREMENTS };
    const deliverable = await this.commercial.getDeliverable(organizationId, content.deliverableId);
    if (!deliverable) return { deliverable: null, requirements: INDEPENDENT_REQUIREMENTS };
    const declared = readRequirements(deliverable.requirements);
    return { deliverable, requirements: declared.length > 0 ? declared : INDEPENDENT_REQUIREMENTS };
  }

  async productionFactsFor(organizationId: string, content: ContentWithLineage): Promise<ProductionFacts[]> {
    const instances = await this.work.getWorkInstances(organizationId, content.productions.map((p) => p.workInstanceId));
    return content.productions.map((p) => productionFacts(p, instances.find((i) => i.id === p.workInstanceId) ?? null));
  }

  async creatorActions(organizationId: string, content: ContentWithLineage) {
    const { deliverable, requirements } = await this.requirementsFor(organizationId, content);
    const productions = await this.productionFactsFor(organizationId, content);
    const state = deriveContentState({ versions: content.versions.map(versionMarks), productions, requirements });
    const original = content.versions.find((v) => v.number === 0);
    return creatorActionsFor({
      state,
      hasDeliverable: deliverable !== null,
      acceptsUnedited: deliverable?.acceptsUnedited ?? false,
      hasReadyOriginal: original?.uploadState === 'READY',
    });
  }

  /**
   * "Approved" never silently becomes "complete": the deliverable's own declared requirements are
   * read against the marks on ONE version, and the result is stamped -- both ways.
   */
  async reconcileDeliverable(organizationId: string, contentId: string): Promise<void> {
    const content = await this.creator.getContent(organizationId, contentId);
    if (!content || !content.deliverableId) return;
    const deliverable = await this.commercial.getDeliverable(organizationId, content.deliverableId);
    if (!deliverable) return;
    if (deliverable.contentId !== content.id) await this.commercial.attachDeliverableContent(organizationId, deliverable.id, content.id);
    const requirements = readRequirements(deliverable.requirements);
    const marks = content.versions.filter((v) => v.visibleToCreator && v.uploadState === 'READY').map(versionMarks);
    // The version the deliverable is judged on: the one carrying the most of its requirements, latest first.
    const judged = [...marks].sort((a, b) => b.number - a.number).map((m) => requirementStatuses(requirements, m, (a) => a.by)).find((s) => deliverableComplete(s)) ?? null;
    await this.commercial.setDeliverableStatus(organizationId, deliverable.id, judged ? 'COMPLETE' : 'OPEN');
  }
}

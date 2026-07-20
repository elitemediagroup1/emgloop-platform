// Sprint 27 — Work Intelligence Foundation (PR #121A)
// ---------------------------------------------------------------------------
// The Sprint 27 EXTENSION of the PR #75 Work OS runtime — not a second engine.
// It operates on the same WorkInstance tables plus the normalized satellite
// tables added in this PR (requirements, links, blockers, handoffs, assets,
// approvals, events). It coordinates instance-level work: manual creation, the
// lifecycle transitions, requirements & derived readiness, evidence links,
// auditable handoffs, version-specific approvals, and an append-only event
// trail. Blueprint stage-flow work continues to be driven by WorkRepository.
//
// Discipline (Multi-Tenant Rules):
//  - Every method takes organizationId first.
//  - Single-row resolves use findFirst({ where: { id, organizationId } }) and
//    fail closed: a cross-org id resolves to null and NO write happens.
//  - Every meaningful transition writes an append-only WorkEvent. WorkEvent is
//    audit history, never the source of current state.
//  - Readiness is DERIVED from requirements + approval facts (never stored).
// ---------------------------------------------------------------------------

import type {
  Prisma,
  PrismaClient,
  WorkInstance,
  WorkRequirement,
  WorkLink,
  WorkBlocker,
  WorkHandoff,
  WorkAsset,
  WorkAssetVersion,
  WorkAssetApproval,
  WorkEvent,
} from '@prisma/client';

import type { ResponsibilityRepository } from './responsibility.repository';
import {
  canTransition,
  isPrivilegedTransition,
  isWorkStatus,
  requiresIndependentVerifier,
  requiresWaitingInfo,
  deriveReadiness,
  isCurrentVersionApproved,
  type ReadinessResult,
  type WorkStatus,
  type WorkEventType,
  type ApprovalScope,
} from './work-intelligence.policy';

type Tx = Prisma.TransactionClient | PrismaClient;

// A cross-tenant access attempt is reported as not-found (never as forbidden).
class NotFoundError extends Error {}
function notFound(what: string, id: string): never {
  throw new NotFoundError(`${what} not found: ${id}`);
}

export interface CreateManualWorkInput {
  organizationId: string;
  createdByUserId: string;
  title: string;
  reason: string;
  workType?: string | null;
  priority?: string | null;
  // Provenance. Defaults to 'manual'. The Brain bridge (PR #121D) passes 'brain'.
  source?: 'manual' | 'brain' | 'rule';
  status?: 'draft' | 'open';
  ownerUserId?: string | null;
  currentResponsibilityId?: string | null;
  attributionType?: string | null;
  attributionLabel?: string | null;
  attributionExternalId?: string | null;
  businessContextTag?: string | null;
  dueAt?: Date | null;
  dedupeKey?: string | null;
}

export interface AddRequirementInput {
  organizationId: string;
  workInstanceId: string;
  key: string;
  label: string;
  category?: string | null;
  required?: boolean;
  status?: string;
  actorUserId?: string | null;
}

export interface ProposeHandoffInput {
  organizationId: string;
  workInstanceId: string;
  proposedByUserId: string;
  fromUserId?: string | null;
  fromResponsibilityId?: string | null;
  toUserId?: string | null;
  toResponsibilityId?: string | null;
  reason?: string | null;
  nextAction?: string | null;
  unresolvedWarnings?: string[];
}

export class WorkIntelligenceRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly responsibilities: ResponsibilityRepository,
  ) {}

  // ================================================================
  // Internals
  // ================================================================
  private async resolveInstance(
    tx: Tx,
    organizationId: string,
    workInstanceId: string,
  ): Promise<WorkInstance> {
    const instance = await tx.workInstance.findFirst({
      where: { id: workInstanceId, organizationId },
    });
    if (!instance) notFound('Work instance', workInstanceId);
    return instance;
  }

  private currentStatus(instance: WorkInstance): WorkStatus {
    if (!isWorkStatus(instance.status)) {
      // A legacy 'active' (blueprint-runtime) instance is not part of the
      // Sprint 27 lifecycle graph; refuse to drive it with these methods.
      throw new Error(
        `Work instance ${instance.id} uses legacy status '${instance.status}'; ` +
          `use the blueprint runtime (WorkRepository) for this item`,
      );
    }
    return instance.status;
  }

  private assertTransition(
    instance: WorkInstance,
    to: WorkStatus,
    opts: { privileged?: boolean } = {},
  ): WorkStatus {
    const from = this.currentStatus(instance);
    if (from === to) return from;
    if (!canTransition(from, to)) {
      throw new Error(`Illegal work transition: ${from} → ${to}`);
    }
    if (isPrivilegedTransition(from, to) && !opts.privileged) {
      throw new Error(`Transition ${from} → ${to} requires an explicit privileged action`);
    }
    return from;
  }

  private async appendEvent(
    tx: Tx,
    input: {
      organizationId: string;
      workInstanceId: string;
      eventType: WorkEventType;
      summary: string;
      actorUserId?: string | null;
      actorType?: 'user' | 'system';
      actorResponsibilityId?: string | null;
      source?: string;
      data?: Record<string, unknown>;
    },
  ): Promise<WorkEvent> {
    return tx.workEvent.create({
      data: {
        organizationId: input.organizationId,
        workInstanceId: input.workInstanceId,
        eventType: input.eventType,
        actorType: input.actorType ?? 'user',
        actorUserId: input.actorUserId ?? null,
        actorResponsibilityId: input.actorResponsibilityId ?? null,
        source: input.source ?? 'manual',
        summary: input.summary,
        ...(input.data ? { data: input.data as Prisma.InputJsonValue } : {}),
      },
    });
  }

  // ================================================================
  // Creation
  // ================================================================
  async createManualWork(input: CreateManualWorkInput): Promise<WorkInstance> {
    const source = input.source ?? 'manual';
    const status = input.status ?? 'open';

    // Route the owner: explicit → responsibility preference → Needs Owner.
    const routed = await this.responsibilities.resolveResponsibleActor(
      input.organizationId,
      input.currentResponsibilityId ?? null,
      input.ownerUserId ?? null,
    );

    return this.prisma.$transaction(async (tx) => {
      const instance = await tx.workInstance.create({
        data: {
          organizationId: input.organizationId,
          title: input.title,
          status,
          source,
          reason: input.reason,
          createdByUserId: input.createdByUserId,
          workType: input.workType ?? 'general',
          priority: input.priority ?? 'normal',
          ownerUserId: routed.userId,
          currentResponsibilityId: input.currentResponsibilityId ?? null,
          attributionType: input.attributionType ?? null,
          attributionLabel: input.attributionLabel ?? null,
          attributionExternalId: input.attributionExternalId ?? null,
          businessContextTag: input.businessContextTag ?? null,
          dueAt: input.dueAt ?? null,
          dedupeKey: input.dedupeKey ?? null,
        },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: instance.id,
        eventType: 'created',
        actorUserId: input.createdByUserId,
        source,
        summary: `Work created (${source})`,
        data: { workType: instance.workType, routedVia: routed.via },
      });
      if (routed.userId) {
        await this.appendEvent(tx, {
          organizationId: input.organizationId,
          workInstanceId: instance.id,
          eventType: 'assigned',
          actorUserId: input.createdByUserId,
          source,
          summary: `Owner assigned (${routed.via})`,
          data: { ownerUserId: routed.userId, via: routed.via },
        });
      }
      return instance;
    });
  }

  async getInstance(organizationId: string, workInstanceId: string): Promise<WorkInstance | null> {
    return this.prisma.workInstance.findFirst({
      where: { id: workInstanceId, organizationId },
    });
  }

  // ================================================================
  // Ownership (explicit)
  // ================================================================
  async assignOwner(input: {
    organizationId: string;
    workInstanceId: string;
    userId: string;
    assignedByUserId: string;
    responsibilityId?: string | null;
  }): Promise<WorkInstance> {
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, input.organizationId, input.workInstanceId);
      const hadOwner = instance.ownerUserId != null && instance.ownerUserId !== input.userId;
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: {
          ownerUserId: input.userId,
          ...(input.responsibilityId !== undefined
            ? { currentResponsibilityId: input.responsibilityId }
            : {}),
        },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: instance.id,
        eventType: hadOwner ? 'reassigned' : 'assigned',
        actorUserId: input.assignedByUserId,
        summary: hadOwner ? 'Owner reassigned' : 'Owner assigned',
        data: { ownerUserId: input.userId, previousOwnerUserId: instance.ownerUserId },
      });
      return updated;
    });
  }

  // ================================================================
  // Lifecycle transitions
  // ================================================================
  async startWork(
    organizationId: string,
    workInstanceId: string,
    actorUserId: string,
  ): Promise<WorkInstance> {
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, organizationId, workInstanceId);
      this.assertTransition(instance, 'in_progress');
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: { status: 'in_progress' },
      });
      await this.appendEvent(tx, {
        organizationId,
        workInstanceId,
        eventType: 'started',
        actorUserId,
        summary: 'Work started',
      });
      return updated;
    });
  }

  async blockWork(input: {
    organizationId: string;
    workInstanceId: string;
    actorUserId: string;
    blockerType: string;
    reason: string;
    waitingOnType?: string | null;
    waitingOnLabel?: string | null;
    linkedRequirementId?: string | null;
  }): Promise<{ instance: WorkInstance; blocker: WorkBlocker }> {
    if (!input.reason || input.reason.trim() === '') {
      throw new Error('A blocker requires a reason');
    }
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, input.organizationId, input.workInstanceId);
      this.assertTransition(instance, 'blocked');
      const blocker = await tx.workBlocker.create({
        data: {
          organizationId: input.organizationId,
          workInstanceId: instance.id,
          blockerType: input.blockerType,
          reason: input.reason,
          waitingOnType: input.waitingOnType ?? null,
          waitingOnLabel: input.waitingOnLabel ?? null,
          linkedRequirementId: input.linkedRequirementId ?? null,
          openedByUserId: input.actorUserId,
        },
      });
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: {
          status: 'blocked',
          waitingOnType: input.waitingOnType ?? null,
          waitingOnLabel: input.waitingOnLabel ?? null,
        },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: instance.id,
        eventType: 'blocked',
        actorUserId: input.actorUserId,
        summary: `Blocked: ${input.reason}`,
        data: { blockerId: blocker.id, blockerType: input.blockerType },
      });
      return { instance: updated, blocker };
    });
  }

  async unblockWork(input: {
    organizationId: string;
    workInstanceId: string;
    actorUserId: string;
    resolution?: string | null;
  }): Promise<WorkInstance> {
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, input.organizationId, input.workInstanceId);
      this.assertTransition(instance, 'in_progress');
      await tx.workBlocker.updateMany({
        where: { workInstanceId: instance.id, organizationId: input.organizationId, active: true },
        data: {
          active: false,
          resolvedAt: new Date(),
          resolvedByUserId: input.actorUserId,
          resolution: input.resolution ?? null,
        },
      });
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: { status: 'in_progress', waitingOnType: null, waitingOnLabel: null },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: instance.id,
        eventType: 'unblocked',
        actorUserId: input.actorUserId,
        summary: 'Unblocked',
      });
      return updated;
    });
  }

  async setWaiting(input: {
    organizationId: string;
    workInstanceId: string;
    actorUserId: string;
    waitingOnType: string;
    waitingOnLabel: string;
  }): Promise<WorkInstance> {
    if (requiresWaitingInfo('waiting') && (!input.waitingOnType || !input.waitingOnLabel)) {
      throw new Error('Waiting requires a waiting-on type and label');
    }
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, input.organizationId, input.workInstanceId);
      this.assertTransition(instance, 'waiting');
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: {
          status: 'waiting',
          waitingOnType: input.waitingOnType,
          waitingOnLabel: input.waitingOnLabel,
        },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: instance.id,
        eventType: 'waiting_started',
        actorUserId: input.actorUserId,
        summary: `Waiting on ${input.waitingOnType}: ${input.waitingOnLabel}`,
      });
      return updated;
    });
  }

  async resumeWork(
    organizationId: string,
    workInstanceId: string,
    actorUserId: string,
  ): Promise<WorkInstance> {
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, organizationId, workInstanceId);
      this.assertTransition(instance, 'in_progress');
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: { status: 'in_progress', waitingOnType: null, waitingOnLabel: null },
      });
      await this.appendEvent(tx, {
        organizationId,
        workInstanceId,
        eventType: 'waiting_ended',
        actorUserId,
        summary: 'Resumed',
      });
      return updated;
    });
  }

  async completeWork(input: {
    organizationId: string;
    workInstanceId: string;
    completedByUserId: string;
    note: string;
  }): Promise<WorkInstance> {
    if (!input.note || input.note.trim() === '') {
      throw new Error('Completion requires a completion note');
    }
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, input.organizationId, input.workInstanceId);
      this.assertTransition(instance, 'completed');
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          completedByUserId: input.completedByUserId,
        },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: instance.id,
        eventType: 'completed',
        actorUserId: input.completedByUserId,
        summary: `Completed: ${input.note}`,
      });
      return updated;
    });
  }

  async verifyWork(input: {
    organizationId: string;
    workInstanceId: string;
    verifiedByUserId: string;
  }): Promise<WorkInstance> {
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, input.organizationId, input.workInstanceId);
      this.assertTransition(instance, 'verified');
      // Completion is distinct from verification. Setup work requires an
      // INDEPENDENT verifier: the verifier cannot be the completer.
      if (
        requiresIndependentVerifier(instance.workType) &&
        instance.completedByUserId != null &&
        instance.completedByUserId === input.verifiedByUserId
      ) {
        throw new Error('Setup work must be verified by someone other than the completer');
      }
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: { status: 'verified', verifiedAt: new Date(), verifiedByUserId: input.verifiedByUserId },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: instance.id,
        eventType: 'verified',
        actorUserId: input.verifiedByUserId,
        summary: 'Verified',
      });
      return updated;
    });
  }

  async reopenWork(input: {
    organizationId: string;
    workInstanceId: string;
    actorUserId: string;
    reason: string;
    privileged?: boolean;
  }): Promise<WorkInstance> {
    if (!input.reason || input.reason.trim() === '') {
      throw new Error('Reopening requires a reason');
    }
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, input.organizationId, input.workInstanceId);
      this.assertTransition(instance, 'reopened', { privileged: input.privileged });
      // Preserve completion & verification history — do NOT clear completedAt /
      // verifiedAt. Reopening only records that the item was reopened.
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: { status: 'reopened', reopenedAt: new Date() },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: instance.id,
        eventType: 'reopened',
        actorUserId: input.actorUserId,
        summary: `Reopened: ${input.reason}`,
      });
      return updated;
    });
  }

  async cancelWork(input: {
    organizationId: string;
    workInstanceId: string;
    actorUserId: string;
    reason: string;
  }): Promise<WorkInstance> {
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, input.organizationId, input.workInstanceId);
      this.assertTransition(instance, 'cancelled');
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: { status: 'cancelled' },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: instance.id,
        eventType: 'cancelled',
        actorUserId: input.actorUserId,
        summary: `Cancelled: ${input.reason}`,
      });
      return updated;
    });
  }

  async archiveWork(
    organizationId: string,
    workInstanceId: string,
    actorUserId: string,
  ): Promise<WorkInstance> {
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, organizationId, workInstanceId);
      this.assertTransition(instance, 'archived');
      const updated = await tx.workInstance.update({
        where: { id: instance.id },
        data: { status: 'archived', archivedAt: new Date() },
      });
      await this.appendEvent(tx, {
        organizationId,
        workInstanceId,
        eventType: 'archived',
        actorUserId,
        summary: 'Archived',
      });
      return updated;
    });
  }

  // ================================================================
  // Requirements & derived readiness
  // ================================================================
  async addRequirement(input: AddRequirementInput): Promise<WorkRequirement> {
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, input.organizationId, input.workInstanceId);
      const req = await tx.workRequirement.create({
        data: {
          organizationId: input.organizationId,
          workInstanceId: instance.id,
          key: input.key,
          label: input.label,
          category: input.category ?? null,
          required: input.required ?? true,
          status: input.status ?? 'unknown',
        },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: instance.id,
        eventType: 'requirement_changed',
        actorUserId: input.actorUserId ?? null,
        summary: `Requirement added: ${input.key}`,
        data: { requirementId: req.id, required: req.required, status: req.status },
      });
      return req;
    });
  }

  async updateRequirementStatus(input: {
    organizationId: string;
    requirementId: string;
    status: string;
    actorUserId: string;
    attested?: boolean;
    evidenceLinkId?: string | null;
    expiresAt?: Date | null;
  }): Promise<WorkRequirement> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.workRequirement.findFirst({
        where: { id: input.requirementId, organizationId: input.organizationId },
      });
      if (!existing) notFound('Requirement', input.requirementId);

      const before = await this.computeReadinessTx(tx, input.organizationId, existing.workInstanceId);

      const satisfying = ['signed', 'approved', 'complete', 'received'].includes(input.status);
      const req = await tx.workRequirement.update({
        where: { id: existing.id },
        data: {
          status: input.status,
          ...(input.evidenceLinkId !== undefined ? { evidenceLinkId: input.evidenceLinkId } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          satisfiedAt: satisfying ? new Date() : null,
          satisfiedByUserId: satisfying ? input.actorUserId : null,
          ...(input.attested
            ? { attestedAt: new Date(), attestedByUserId: input.actorUserId }
            : {}),
        },
      });

      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: existing.workInstanceId,
        eventType: 'requirement_changed',
        actorUserId: input.actorUserId,
        summary: `Requirement ${existing.key} → ${input.status}`,
        data: { requirementId: existing.id, status: input.status, attested: input.attested === true },
      });

      const after = await this.computeReadinessTx(tx, input.organizationId, existing.workInstanceId);
      if (after.ready !== before.ready) {
        await this.appendEvent(tx, {
          organizationId: input.organizationId,
          workInstanceId: existing.workInstanceId,
          eventType: 'readiness_changed',
          actorUserId: input.actorUserId,
          summary: after.ready ? 'Readiness reached' : 'Readiness revoked',
          data: { ready: after.ready, unsatisfied: after.unsatisfied },
        });
      }
      return req;
    });
  }

  async listRequirements(
    organizationId: string,
    workInstanceId: string,
  ): Promise<WorkRequirement[]> {
    return this.prisma.workRequirement.findMany({
      where: { organizationId, workInstanceId },
      orderBy: { key: 'asc' },
    });
  }

  // Derive readiness for a work item from its requirements + current-version
  // approval facts. Pure policy does the deciding; this only loads the facts.
  async computeReadiness(
    organizationId: string,
    workInstanceId: string,
    now?: Date,
  ): Promise<ReadinessResult> {
    return this.computeReadinessTx(this.prisma, organizationId, workInstanceId, now);
  }

  private async computeReadinessTx(
    tx: Tx,
    organizationId: string,
    workInstanceId: string,
    now?: Date,
  ): Promise<ReadinessResult> {
    const [requirements, assets, versions, approvals] = await Promise.all([
      tx.workRequirement.findMany({ where: { organizationId, workInstanceId } }),
      tx.workAsset.findMany({ where: { organizationId, workInstanceId } }),
      tx.workAssetVersion.findMany({ where: { organizationId } }),
      tx.workAssetApproval.findMany({ where: { organizationId } }),
    ]);
    const assetIds = new Set(assets.map((a) => a.id));
    const scopedVersions = versions.filter((v) => assetIds.has(v.workAssetId));
    const scopedApprovals = approvals.filter((a) => assetIds.has(a.workAssetId));

    return deriveReadiness(requirements, {
      now,
      // An asset_approval requirement is satisfied when its linked asset's
      // current version is approved at BOTH internal and buyer scope. When the
      // requirement does not name an asset, it cannot be satisfied (unknown).
      approvalSatisfied: (req) => {
        // Convention: an asset_approval requirement's evidenceLinkId is unused for
        // this; the requirement key maps to at most one asset by label match here.
        const asset = assets.find((a) => a.label === req.key || a.kind === req.key);
        if (!asset) return false;
        const internalOk = isCurrentVersionApproved(asset, scopedVersions, scopedApprovals, 'internal');
        const buyerOk = isCurrentVersionApproved(asset, scopedVersions, scopedApprovals, 'buyer');
        return internalOk && buyerOk;
      },
    });
  }

  // ================================================================
  // Evidence / entity links
  // ================================================================
  async addWorkLink(input: {
    organizationId: string;
    workInstanceId: string;
    linkType: string;
    refId?: string | null;
    externalRef?: string | null;
    label?: string | null;
    provenance?: 'manual' | 'brain' | 'rule';
    createdByUserId?: string | null;
  }): Promise<WorkLink> {
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, input.organizationId, input.workInstanceId);
      // Reject a link to a Loop row that belongs to another organization, when
      // the target's organization is knowable.
      if (input.refId) {
        await this.assertTargetInOrg(tx, input.organizationId, input.linkType, input.refId);
      }
      const link = await tx.workLink.create({
        data: {
          organizationId: input.organizationId,
          workInstanceId: instance.id,
          linkType: input.linkType,
          refId: input.refId ?? null,
          externalRef: input.externalRef ?? null,
          label: input.label ?? null,
          provenance: input.provenance ?? 'manual',
          createdByUserId: input.createdByUserId ?? null,
        },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: instance.id,
        eventType: 'linked',
        actorUserId: input.createdByUserId ?? null,
        source: input.provenance ?? 'manual',
        summary: `Linked ${input.linkType}`,
        data: { linkId: link.id, linkType: input.linkType, refId: input.refId ?? null },
      });
      return link;
    });
  }

  // Best-effort cross-org guard for link targets whose org we can resolve.
  private async assertTargetInOrg(
    tx: Tx,
    organizationId: string,
    linkType: string,
    refId: string,
  ): Promise<void> {
    let targetOrg: string | null | undefined;
    if (linkType === 'customer') {
      targetOrg = (await tx.customer.findUnique({ where: { id: refId }, select: { organizationId: true } }))?.organizationId;
    } else if (linkType === 'conversation') {
      targetOrg = (await tx.conversation.findUnique({ where: { id: refId }, select: { organizationId: true } }))?.organizationId;
    } else if (linkType === 'marketplace_call') {
      targetOrg = (await tx.marketplaceCall.findUnique({ where: { id: refId }, select: { organizationId: true } }))?.organizationId;
    } else {
      return; // org not resolvable for this link type — accept (external/opaque ref)
    }
    if (targetOrg != null && targetOrg !== organizationId) {
      // Do not leak existence of another tenant's row.
      notFound('Link target', refId);
    }
  }

  async listLinks(organizationId: string, workInstanceId: string): Promise<WorkLink[]> {
    return this.prisma.workLink.findMany({
      where: { organizationId, workInstanceId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listBlockers(organizationId: string, workInstanceId: string): Promise<WorkBlocker[]> {
    return this.prisma.workBlocker.findMany({
      where: { organizationId, workInstanceId },
      orderBy: { openedAt: 'desc' },
    });
  }

  async listEvents(organizationId: string, workInstanceId: string): Promise<WorkEvent[]> {
    return this.prisma.workEvent.findMany({
      where: { organizationId, workInstanceId },
      orderBy: { occurredAt: 'asc' },
    });
  }

  // ================================================================
  // Handoffs
  // ================================================================
  async proposeHandoff(input: ProposeHandoffInput): Promise<WorkHandoff> {
    if (!input.toUserId && !input.toResponsibilityId) {
      throw new Error('A handoff must target a user or a responsibility');
    }
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, input.organizationId, input.workInstanceId);
      // At most one active proposed handoff per item: supersede any prior.
      await tx.workHandoff.updateMany({
        where: {
          organizationId: input.organizationId,
          workInstanceId: instance.id,
          status: 'proposed',
        },
        data: { status: 'superseded' },
      });
      const readiness = await this.computeReadinessTx(tx, input.organizationId, instance.id);
      const handoff = await tx.workHandoff.create({
        data: {
          organizationId: input.organizationId,
          workInstanceId: instance.id,
          fromUserId: input.fromUserId ?? instance.ownerUserId ?? null,
          fromResponsibilityId: input.fromResponsibilityId ?? instance.currentResponsibilityId ?? null,
          toUserId: input.toUserId ?? null,
          toResponsibilityId: input.toResponsibilityId ?? null,
          reason: input.reason ?? null,
          nextAction: input.nextAction ?? null,
          unresolvedWarnings: (input.unresolvedWarnings ?? []) as Prisma.InputJsonValue,
          readinessSnapshot: {
            ready: readiness.ready,
            requiredCount: readiness.requiredCount,
            satisfiedCount: readiness.satisfiedCount,
            unsatisfied: readiness.unsatisfied,
          } as Prisma.InputJsonValue,
          proposedByUserId: input.proposedByUserId,
        },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: instance.id,
        eventType: 'handoff_proposed',
        actorUserId: input.proposedByUserId,
        summary: 'Handoff proposed',
        data: {
          handoffId: handoff.id,
          toUserId: input.toUserId ?? null,
          toResponsibilityId: input.toResponsibilityId ?? null,
          ready: readiness.ready,
        },
      });
      return handoff;
    });
  }

  async acceptHandoff(input: {
    organizationId: string;
    handoffId: string;
    acceptedByUserId: string;
  }): Promise<WorkHandoff> {
    return this.prisma.$transaction(async (tx) => {
      const handoff = await tx.workHandoff.findFirst({
        where: { id: input.handoffId, organizationId: input.organizationId },
      });
      if (!handoff) notFound('Handoff', input.handoffId);
      if (handoff.status !== 'proposed') {
        throw new Error(`Handoff is not open (status: ${handoff.status})`);
      }
      await this.assertHandoffRecipient(tx, handoff, input.acceptedByUserId);

      const now = new Date();
      const updated = await tx.workHandoff.update({
        where: { id: handoff.id },
        data: { status: 'accepted', acceptedAt: now, acceptedByUserId: input.acceptedByUserId },
      });
      // Acceptance changes the active owner + responsibility.
      const newOwner = handoff.toUserId ?? input.acceptedByUserId;
      await tx.workInstance.update({
        where: { id: handoff.workInstanceId },
        data: {
          ownerUserId: newOwner,
          ...(handoff.toResponsibilityId
            ? { currentResponsibilityId: handoff.toResponsibilityId }
            : {}),
          // On acceptance the recipient takes the work into progress.
          status: 'in_progress',
        },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: handoff.workInstanceId,
        eventType: 'handoff_accepted',
        actorUserId: input.acceptedByUserId,
        summary: 'Handoff accepted',
        data: { handoffId: handoff.id, newOwnerUserId: newOwner },
      });
      return updated;
    });
  }

  async rejectHandoff(input: {
    organizationId: string;
    handoffId: string;
    rejectedByUserId: string;
    rejectionReason: string;
  }): Promise<WorkHandoff> {
    return this.prisma.$transaction(async (tx) => {
      const handoff = await tx.workHandoff.findFirst({
        where: { id: input.handoffId, organizationId: input.organizationId },
      });
      if (!handoff) notFound('Handoff', input.handoffId);
      if (handoff.status !== 'proposed') {
        throw new Error(`Handoff is not open (status: ${handoff.status})`);
      }
      await this.assertHandoffRecipient(tx, handoff, input.rejectedByUserId);
      // Rejection preserves existing ownership — the WorkInstance is untouched.
      const updated = await tx.workHandoff.update({
        where: { id: handoff.id },
        data: {
          status: 'rejected',
          rejectedAt: new Date(),
          rejectedByUserId: input.rejectedByUserId,
          rejectionReason: input.rejectionReason,
        },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: handoff.workInstanceId,
        eventType: 'handoff_rejected',
        actorUserId: input.rejectedByUserId,
        summary: `Handoff rejected: ${input.rejectionReason}`,
        data: { handoffId: handoff.id },
      });
      return updated;
    });
  }

  // Only the intended recipient may accept/reject. If the handoff targets a
  // specific user, the actor must be that user; if it targets a responsibility,
  // the actor must currently hold an active assignment for it.
  private async assertHandoffRecipient(
    tx: Tx,
    handoff: WorkHandoff,
    actorUserId: string,
  ): Promise<void> {
    if (handoff.toUserId) {
      if (handoff.toUserId !== actorUserId) {
        throw new Error('Only the intended recipient may act on this handoff');
      }
      return;
    }
    if (handoff.toResponsibilityId) {
      const holds = await tx.responsibilityAssignment.findFirst({
        where: {
          organizationId: handoff.organizationId,
          responsibilityId: handoff.toResponsibilityId,
          userId: actorUserId,
          active: true,
        },
        select: { id: true },
      });
      if (!holds) {
        throw new Error('Only an active holder of the target responsibility may act on this handoff');
      }
      return;
    }
    throw new Error('Handoff has no recipient');
  }

  // ================================================================
  // Assets & version-specific approvals
  // ================================================================
  async addAsset(input: {
    organizationId: string;
    workInstanceId: string;
    kind: string;
    label: string;
    createdByUserId?: string | null;
  }): Promise<WorkAsset> {
    return this.prisma.$transaction(async (tx) => {
      const instance = await this.resolveInstance(tx, input.organizationId, input.workInstanceId);
      const asset = await tx.workAsset.create({
        data: {
          organizationId: input.organizationId,
          workInstanceId: instance.id,
          kind: input.kind,
          label: input.label,
          createdByUserId: input.createdByUserId ?? null,
        },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: instance.id,
        eventType: 'asset_added',
        actorUserId: input.createdByUserId ?? null,
        summary: `Asset added: ${input.label}`,
        data: { assetId: asset.id, kind: input.kind },
      });
      return asset;
    });
  }

  async addAssetVersion(input: {
    organizationId: string;
    workAssetId: string;
    fileRef?: string | null;
    url?: string | null;
    checksum?: string | null;
    notes?: string | null;
    submittedByUserId?: string | null;
  }): Promise<WorkAssetVersion> {
    return this.prisma.$transaction(async (tx) => {
      const asset = await tx.workAsset.findFirst({
        where: { id: input.workAssetId, organizationId: input.organizationId },
      });
      if (!asset) notFound('Asset', input.workAssetId);

      const existingVersions = await tx.workAssetVersion.count({
        where: { workAssetId: asset.id },
      });
      const nextVersion = existingVersions === 0 ? 1 : asset.currentVersion + 1;

      // Supersede the prior current version.
      await tx.workAssetVersion.updateMany({
        where: { workAssetId: asset.id, supersededAt: null },
        data: { supersededAt: new Date() },
      });

      const version = await tx.workAssetVersion.create({
        data: {
          organizationId: input.organizationId,
          workAssetId: asset.id,
          version: nextVersion,
          fileRef: input.fileRef ?? null,
          url: input.url ?? null,
          checksum: input.checksum ?? null,
          notes: input.notes ?? null,
          submittedByUserId: input.submittedByUserId ?? null,
        },
      });
      // A new version resets the asset to in_review; prior approvals do not carry.
      await tx.workAsset.update({
        where: { id: asset.id },
        data: { currentVersion: nextVersion, status: 'in_review' },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: asset.workInstanceId,
        eventType: 'asset_version_added',
        actorUserId: input.submittedByUserId ?? null,
        summary: `Asset version v${nextVersion} added`,
        data: { assetId: asset.id, versionId: version.id, version: nextVersion },
      });
      return version;
    });
  }

  async recordApproval(input: {
    organizationId: string;
    workAssetVersionId: string;
    scope: ApprovalScope;
    decision: 'approved' | 'rejected' | 'revision_requested';
    approverUserId?: string | null;
    approverResponsibilityId?: string | null;
    comments?: string | null;
    evidenceLinkId?: string | null;
  }): Promise<WorkAssetApproval> {
    return this.prisma.$transaction(async (tx) => {
      const version = await tx.workAssetVersion.findFirst({
        where: { id: input.workAssetVersionId, organizationId: input.organizationId },
        include: { asset: { select: { id: true, workInstanceId: true } } },
      });
      if (!version) notFound('Asset version', input.workAssetVersionId);

      const approval = await tx.workAssetApproval.create({
        data: {
          organizationId: input.organizationId,
          workAssetId: version.asset.id,
          workAssetVersionId: version.id,
          scope: input.scope,
          decision: input.decision,
          approverUserId: input.approverUserId ?? null,
          approverResponsibilityId: input.approverResponsibilityId ?? null,
          comments: input.comments ?? null,
          evidenceLinkId: input.evidenceLinkId ?? null,
        },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: version.asset.workInstanceId,
        eventType: 'approval_recorded',
        actorUserId: input.approverUserId ?? null,
        summary: `Approval (${input.scope}): ${input.decision} on v${version.version}`,
        data: {
          approvalId: approval.id,
          versionId: version.id,
          scope: input.scope,
          decision: input.decision,
        },
      });
      return approval;
    });
  }

  async revokeApproval(input: {
    organizationId: string;
    approvalId: string;
    revokedByUserId: string;
    revokeReason: string;
  }): Promise<WorkAssetApproval> {
    return this.prisma.$transaction(async (tx) => {
      const approval = await tx.workAssetApproval.findFirst({
        where: { id: input.approvalId, organizationId: input.organizationId },
        include: { asset: { select: { workInstanceId: true } } },
      });
      if (!approval) notFound('Approval', input.approvalId);
      const updated = await tx.workAssetApproval.update({
        where: { id: approval.id },
        data: {
          revokedAt: new Date(),
          revokedByUserId: input.revokedByUserId,
          revokeReason: input.revokeReason,
        },
      });
      await this.appendEvent(tx, {
        organizationId: input.organizationId,
        workInstanceId: approval.asset.workInstanceId,
        eventType: 'approval_revoked',
        actorUserId: input.revokedByUserId,
        summary: `Approval revoked: ${input.revokeReason}`,
        data: { approvalId: approval.id },
      });
      return updated;
    });
  }
}

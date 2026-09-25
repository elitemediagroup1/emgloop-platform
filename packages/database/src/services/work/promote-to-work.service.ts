// Promote to Work: the ONE service that turns intelligence into Work OS work, and only when a person
// confirms. Loop Intelligence Phase C, 2026-09-26. Contract: @emgloop/shared promote-to-work.ts.
//
//   preview(actor, origin)    re-resolves the origin INSIDE the actor's own scope and proposes the work:
//                             title, outcome, the actor as suggested assignee, a target date only where
//                             the evidence carried a real date, exactly which fields become shared, and
//                             a fingerprint of what the actor is looking at. Reads only.
//   promote(actor, origin, c) re-resolves the origin AGAIN, refuses when it changed since the preview
//                             (STALE_CONFIRMATION), checks the confirmation, the work type, and the
//                             assignee's authority, then creates ONE single-step work item with its
//                             `work_origins` link in the same transaction (a second promotion of the
//                             same origin fails whole). Then it records WORK_LINKED on the origin's log.
//
// SCOPE IS RE-RESOLVED, NEVER TRUSTED. A private origin is found only through the actor's own principal
// read (their digest, their Daily Loop item): somebody else's is NOT_FOUND. An organization origin needs
// the read authority the caller proved from the signed session (the domain's, or Cases'). The caller
// passes those decisions in; this service never sees a form field that names an organization or a user.
//
// AI NEVER CALLS THIS. There is no path from a producer, a model or a sweep to `promote`; a source-scan
// test pins that nothing outside the web's confirmed action calls it.

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  PROMOTE_OUTCOME_MAX_CHARS,
  PROMOTE_TITLE_MAX_CHARS,
  promoteConfirmationRefusal,
  type IntelligenceDomain,
  type IntelligenceSubjectKind,
  type PromoteOrigin,
  type PromoteProposal,
  type PromoteRefusal,
  type PromoteSharedField,
} from '@emgloop/shared';

import { absentUntilMigrated } from '../../creator/until-migrated';
import { IntelligenceDigestRepository } from '../../repositories/intelligence/intelligence-digest.repository';
import { OperationalPriorityRepository } from '../../repositories/operational-priority.repository';
import { WorkRepository } from '../../repositories/work.repository';
import { WorkItemRepository } from '../../repositories/work-state/work-item.repository';

/** Who is promoting, and what the caller proved about them from the signed session. */
export interface PromoteActor {
  readonly organizationId: string;
  readonly userId: string;
  /** `work:manage`: may assign the work to someone else. Everyone may assign it to themselves. */
  readonly mayAssignOthers: boolean;
  /** May this person read the organization's intelligence in this domain (its registry read authority)? */
  readonly mayReadOrganizationDomain: (domain: string) => boolean;
  /** May this person read Cases (commercialIntelligence:view in the ADMIN workspace)? */
  readonly mayReadCases: boolean;
}

export interface PromoteConfirmation {
  readonly title: string;
  readonly outcome: string;
  readonly workTypeId: string;
  readonly assigneeUserId: string;
  readonly targetAt: Date | null;
  /** The proposal's fingerprint the person confirmed. */
  readonly fingerprint: string;
  readonly confirmed: boolean;
}

export type PromotePreview = { readonly outcome: 'READY'; readonly proposal: PromoteProposal } | { readonly outcome: 'REFUSED'; readonly refusal: PromoteRefusal; readonly workInstanceId?: string };
export type PromoteResult = { readonly outcome: 'PROMOTED'; readonly workInstanceId: string } | { readonly outcome: 'REFUSED'; readonly refusal: PromoteRefusal; readonly workInstanceId?: string };

interface Resolved {
  readonly originKind: 'DIGEST_SIGNAL' | 'WORK_ITEM' | 'CASE';
  readonly originScope: 'PRINCIPAL' | 'ORGANIZATION';
  readonly originRef: string;
  readonly originLabel: string;
  readonly title: string;
  readonly outcome: string;
  readonly targetAt: Date | null;
  readonly fingerprint: string;
  /** For the WORK_LINKED observation afterwards. */
  readonly link: { readonly kind: 'WORK_ITEM'; readonly itemId: string } | { readonly kind: 'CASE'; readonly caseId: string } | null;
}

const DOMAIN_LABEL: Readonly<Record<string, string>> = Object.freeze({
  CHATS: 'Your chats',
  MAIL: 'Your mail',
  CALENDAR: 'Your calendar',
  WORK: 'Work',
  CALLGRID: 'CallGrid',
  CAMPAIGNS: 'Campaigns',
  PIPELINE: 'Intake',
  CRM: 'People',
  CREATORS: 'Creators',
  WEBSITE: 'Website',
});

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const fingerprintOf = (...parts: readonly (string | number | null | undefined)[]) =>
  `promote:${createHash('sha256').update(parts.map((p) => String(p ?? '')).join('\n')).digest('hex').slice(0, 40)}`;
const clip = (s: string, max: number) => [...s.trim()].slice(0, max).join('');

/** A deadline the conversation wrote AS A DATE (YYYY-MM-DD) is a target; words ("by Thursday") are not. */
function dateFromEvidence(deadline: string | null | undefined): Date | null {
  if (!deadline || !ISO_DAY.test(deadline.trim())) return null;
  const d = new Date(`${deadline.trim()}T17:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown })?.code === 'P2002';
}

export class PromoteToWorkService {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    deps: { readonly now?: () => Date } = {},
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  async preview(actor: PromoteActor, origin: PromoteOrigin): Promise<PromotePreview> {
    const resolved = await this.resolve(actor, origin);
    if ('refusal' in resolved) return { outcome: 'REFUSED', refusal: resolved.refusal };
    const existing = await this.existing(actor.organizationId, resolved);
    if (existing === 'NOT_MIGRATED') return { outcome: 'REFUSED', refusal: 'NOT_MIGRATED' };
    if (existing) return { outcome: 'REFUSED', refusal: 'ALREADY_PROMOTED', workInstanceId: existing };
    const shared: PromoteSharedField[] = ['title', 'outcome', 'assignee', ...(resolved.targetAt ? (['targetDate'] as const) : [])];
    return {
      outcome: 'READY',
      proposal: {
        origin,
        originLabel: resolved.originLabel,
        originScope: resolved.originScope,
        title: resolved.title,
        outcome: resolved.outcome,
        suggestedAssigneeUserId: actor.userId,
        targetAt: resolved.targetAt,
        sharedFields: shared,
        fingerprint: resolved.fingerprint,
      },
    };
  }

  async promote(actor: PromoteActor, origin: PromoteOrigin, confirmation: PromoteConfirmation): Promise<PromoteResult> {
    const confirmRefusal = promoteConfirmationRefusal(confirmation);
    if (confirmRefusal) return { outcome: 'REFUSED', refusal: confirmRefusal };
    const resolved = await this.resolve(actor, origin);
    if ('refusal' in resolved) return { outcome: 'REFUSED', refusal: resolved.refusal };
    // What the person confirmed must still be what the origin says.
    if (resolved.fingerprint !== confirmation.fingerprint) return { outcome: 'REFUSED', refusal: 'STALE_CONFIRMATION' };
    const existing = await this.existing(actor.organizationId, resolved);
    if (existing === 'NOT_MIGRATED') return { outcome: 'REFUSED', refusal: 'NOT_MIGRATED' };
    if (existing) return { outcome: 'REFUSED', refusal: 'ALREADY_PROMOTED', workInstanceId: existing };

    const work = new WorkRepository(this.prisma);
    const workType = await work.getWorkType(actor.organizationId, confirmation.workTypeId);
    if (!workType || !workType.active) return { outcome: 'REFUSED', refusal: 'WORK_TYPE_NOT_FOUND' };
    // A SUGGESTION IS NOT AUTHORITY: anyone may take the work themselves; giving it to someone else needs
    // work:manage, and that someone must be an active member of this organization.
    const assignee = confirmation.assigneeUserId.trim();
    if (assignee !== actor.userId && !actor.mayAssignOthers) return { outcome: 'REFUSED', refusal: 'ASSIGNEE_NOT_PERMITTED' };
    const members = await work.listActiveMembers(actor.organizationId);
    const activeIds = new Set(members.map((m) => m.id));
    if (!activeIds.has(assignee) || !activeIds.has(actor.userId)) return { outcome: 'REFUSED', refusal: 'ASSIGNEE_NOT_A_MEMBER' };

    const now = this.now();
    const title = clip(confirmation.title, PROMOTE_TITLE_MAX_CHARS);
    const outcome = clip(confirmation.outcome, PROMOTE_OUTCOME_MAX_CHARS);
    const shared: PromoteSharedField[] = ['title', 'outcome', 'assignee', ...(confirmation.targetAt ? (['targetDate'] as const) : [])];
    let workInstanceId: string;
    try {
      const created = await work.createWorkItem({
        organizationId: actor.organizationId,
        creatorUserId: actor.userId,
        workTypeId: workType.id,
        workTypeName: workType.name,
        title,
        outcome,
        details: null,
        relatedRecord: null,
        priority: workType.defaultPriority,
        targetAtUtc: confirmation.targetAt ? confirmation.targetAt.toISOString() : null,
        targetEastern: null,
        steps: [
          {
            name: title,
            instruction: outcome,
            assignment: { mode: 'specific', specificUserId: assignee },
            completionNote: 'optional',
            notifyActive: assignee !== actor.userId,
            notifyComplete: false,
          },
        ],
        activeMemberIds: activeIds,
        origin: {
          originKind: resolved.originKind,
          originScope: resolved.originScope,
          originUserId: resolved.originScope === 'PRINCIPAL' ? actor.userId : null,
          originRef: resolved.originRef,
          originFingerprint: resolved.fingerprint,
          sharedFields: shared,
          promotedAt: now,
        },
      });
      workInstanceId = created.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const winner = await this.existing(actor.organizationId, resolved);
        return { outcome: 'REFUSED', refusal: 'ALREADY_PROMOTED', ...(typeof winner === 'string' ? { workInstanceId: winner } : {}) };
      }
      throw err;
    }

    // The origin's own log records the promotion. The link above is the authority; this is its history.
    if (resolved.link?.kind === 'WORK_ITEM') {
      await new WorkItemRepository(this.prisma).linkToWork({ organizationId: actor.organizationId, userId: actor.userId }, resolved.link.itemId, { workInstanceId, occurredAt: now });
    } else if (resolved.link?.kind === 'CASE') {
      await new OperationalPriorityRepository(this.prisma).recordObservation(actor.organizationId, resolved.link.caseId, {
        observationType: 'WORK_LINKED',
        occurredAt: now,
        actorType: 'HUMAN',
        actorUserId: actor.userId,
        source: 'promote-to-work',
        evidence: { destination: { system: 'work-os', type: 'work_instance', id: workInstanceId } },
      });
    }
    return { outcome: 'PROMOTED', workInstanceId };
  }

  /** The work an origin was already promoted to; NOT_MIGRATED before 20261007000000. */
  private async existing(organizationId: string, r: Resolved): Promise<string | null | 'NOT_MIGRATED'> {
    const row = await absentUntilMigrated(
      this.prisma.workOrigin.findFirst({ where: { organizationId, originKind: r.originKind, originRef: r.originRef }, select: { workInstanceId: true } }).then((x) => x ?? false),
    );
    if (row === null) return 'NOT_MIGRATED';
    return row === false ? null : row.workInstanceId;
  }

  private async resolve(actor: PromoteActor, origin: PromoteOrigin): Promise<Resolved | { refusal: PromoteRefusal }> {
    if (!actor.organizationId || !actor.userId) return { refusal: 'NOT_PERMITTED' };
    const principal = { organizationId: actor.organizationId, userId: actor.userId };
    const now = this.now();
    switch (origin.kind) {
      case 'DIGEST_SIGNAL': {
        if (!origin.signalKey || !origin.subjectRef) return { refusal: 'INVALID_INPUT' };
        const digests = new IntelligenceDigestRepository(this.prisma);
        const subject = { subjectKind: origin.subjectKind as IntelligenceSubjectKind, subjectRef: origin.subjectRef, now };
        let digest;
        if (origin.scope === 'PRINCIPAL') digest = await digests.current(principal, origin.domain as IntelligenceDomain, subject);
        else {
          if (!actor.mayReadOrganizationDomain(origin.domain)) return { refusal: 'NOT_PERMITTED' };
          digest = await digests.organizationCurrent(actor.organizationId, origin.domain as IntelligenceDomain, subject);
        }
        if (!digest) return { refusal: 'NOT_FOUND' };
        if (digest.status !== 'CURRENT') return { refusal: 'STALE' };
        const signal = (digest.content.signals ?? []).find((s) => s.key === origin.signalKey);
        if (!signal) return { refusal: 'NOT_FOUND' };
        const title = clip(signal.statement, PROMOTE_TITLE_MAX_CHARS);
        const outcome = clip(signal.party ? `${signal.statement} (as ${signal.party} appears to owe it)` : signal.statement, PROMOTE_OUTCOME_MAX_CHARS);
        return {
          originKind: 'DIGEST_SIGNAL',
          originScope: digest.scope,
          originRef: `${digest.id}#${signal.key}`.slice(0, 256),
          originLabel: DOMAIN_LABEL[origin.domain] ?? origin.domain,
          title,
          outcome,
          targetAt: signal.dueAt ? new Date(signal.dueAt) : null,
          fingerprint: fingerprintOf(digest.id, digest.fingerprint, signal.key, signal.statement),
          link: null,
        };
      }
      case 'WORK_ITEM': {
        if (!origin.itemId) return { refusal: 'INVALID_INPUT' };
        const item = await new WorkItemRepository(this.prisma).item(principal, origin.itemId);
        if (!item) return { refusal: 'NOT_FOUND' };
        if (item.state !== 'OPEN' && item.state !== 'SNOOZED') return { refusal: 'STALE' };
        const evidence = (item.evidence && typeof item.evidence === 'object' ? item.evidence : {}) as Record<string, unknown>;
        const nextStep = typeof evidence.nextStep === 'string' && evidence.nextStep.trim() ? evidence.nextStep.trim() : null;
        const provider = typeof evidence.provider === 'string' ? evidence.provider : null;
        return {
          originKind: 'WORK_ITEM',
          originScope: 'PRINCIPAL',
          originRef: item.id,
          originLabel: provider === 'TELEGRAM' ? 'Your chats' : 'Your mail',
          title: clip(item.title ?? '', PROMOTE_TITLE_MAX_CHARS),
          outcome: clip(nextStep ?? item.title ?? '', PROMOTE_OUTCOME_MAX_CHARS),
          targetAt: dateFromEvidence(typeof evidence.deadline === 'string' ? evidence.deadline : null),
          fingerprint: fingerprintOf(item.id, item.title, item.lastDetectedAt.toISOString(), item.state),
          link: { kind: 'WORK_ITEM', itemId: item.id },
        };
      }
      case 'CASE': {
        if (!actor.mayReadCases) return { refusal: 'NOT_PERMITTED' };
        if (!origin.caseId) return { refusal: 'INVALID_INPUT' };
        const kase = await new OperationalPriorityRepository(this.prisma).findById(actor.organizationId, origin.caseId);
        if (!kase) return { refusal: 'NOT_FOUND' };
        if (kase.state === 'RESOLVED' || kase.state === 'DISMISSED') return { refusal: 'STALE' };
        return {
          originKind: 'CASE',
          originScope: 'ORGANIZATION',
          originRef: kase.id,
          originLabel: 'Case',
          title: clip(kase.title, PROMOTE_TITLE_MAX_CHARS),
          outcome: clip(kase.summary ?? kase.title, PROMOTE_OUTCOME_MAX_CHARS),
          targetAt: null,
          fingerprint: fingerprintOf(kase.id, kase.title, kase.state, kase.lastDetectedAt.toISOString()),
          link: { kind: 'CASE', caseId: kase.id },
        };
      }
      default:
        return { refusal: 'INVALID_INPUT' };
    }
  }
}

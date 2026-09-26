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
//                             `work_origins` link in the same transaction. Then it records WORK_LINKED on
//                             the origin's log.
//
// MANY PROMOTIONS, ONE PER SUBMISSION. An origin (a Case especially) may become several pieces of work.
// What must not repeat is one confirmed SUBMISSION: its key -- the actor, the origin, the confirmed
// fingerprint and the nonce minted at preview, hashed -- is unique per organization, so a retried submit
// returns the work it already created instead of creating a second.
//
// A CASE IS RE-RESOLVED BY WHO MAY SEE IT. An organization Case needs the Cases authority (and, for a
// situation, the read authority of every domain it cites). A PRIVATE situation is found only through
// SituationRepository as the signed principal -- its owner -- and is NOT_FOUND to everyone else, whatever
// their role; its promotion is a PRINCIPAL origin that shares only what the person confirms, and its
// WORK_LINKED is written through the situation door, never an organization Case read.
//
// SCOPE IS RE-RESOLVED, NEVER TRUSTED. A private origin is found only through the actor's own principal
// read (their digest, their Daily Loop item): somebody else's is NOT_FOUND. An organization origin needs
// the read authority the caller proved from the signed session (the domain's, or Cases'). The caller
// passes those decisions in; this service never sees a form field that names an organization or a user.
//
// AI NEVER CALLS THIS. There is no path from a producer, a model or a sweep to `promote`; a source-scan
// test pins that nothing outside the web's confirmed action calls it.

import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  PROMOTE_OUTCOME_MAX_CHARS,
  PROMOTE_TITLE_MAX_CHARS,
  SITUATION_SOURCE,
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
import { SituationRepository } from '../../repositories/intelligence/situation.repository';
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
  /** The nonce the preview minted, carried by the form: one submission, one piece of work. */
  readonly submissionNonce: string;
}

/** One confirmed submission's key: who, what origin, what they confirmed, and which preview. */
function submissionKeyOf(actor: PromoteActor, r: { originKind: string; originRef: string; fingerprint: string }, c: PromoteConfirmation): string {
  return `sub:${createHash('sha256').update([actor.organizationId, actor.userId, r.originKind, r.originRef, c.fingerprint, c.submissionNonce].join('\n')).digest('hex').slice(0, 64)}`;
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
  readonly link: { readonly kind: 'WORK_ITEM'; readonly itemId: string } | { readonly kind: 'CASE' | 'PRIVATE_SITUATION'; readonly caseId: string } | null;
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
    const linked = await this.linkedCount(actor.organizationId, resolved);
    if (linked === 'NOT_MIGRATED') return { outcome: 'REFUSED', refusal: 'NOT_MIGRATED' };
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
        submissionNonce: randomBytes(18).toString('base64url'),
        alreadyLinkedCount: linked,
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
    const submissionKey = submissionKeyOf(actor, resolved, confirmation);
    // A retried submission returns the work it already created: idempotent, never a second piece of work.
    const already = await this.bySubmission(actor.organizationId, submissionKey);
    if (already === 'NOT_MIGRATED') return { outcome: 'REFUSED', refusal: 'NOT_MIGRATED' };
    if (already) return { outcome: 'PROMOTED', workInstanceId: already };

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
          submissionKey,
        },
      });
      workInstanceId = created.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // The same submission, concurrently: the one that won is this submission's work.
        const winner = await this.bySubmission(actor.organizationId, submissionKey);
        if (typeof winner === 'string') return { outcome: 'PROMOTED', workInstanceId: winner };
      }
      throw err;
    }

    // The origin's own log records the promotion. The link above is the authority; this is its history.
    if (resolved.link?.kind === 'WORK_ITEM') {
      await new WorkItemRepository(this.prisma).linkToWork({ organizationId: actor.organizationId, userId: actor.userId }, resolved.link.itemId, { workInstanceId, occurredAt: now });
    } else if (resolved.link?.kind === 'PRIVATE_SITUATION') {
      // Through the situation door, as its owner: never an organization-visible Case read.
      await new SituationRepository(this.prisma).linkWork({ scope: 'PRINCIPAL', organizationId: actor.organizationId, userId: actor.userId }, resolved.link.caseId, { workInstanceId, actorUserId: actor.userId, at: now });
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

  /** How many pieces of work this origin already links to; NOT_MIGRATED before 20261007000000. */
  private async linkedCount(organizationId: string, r: Resolved): Promise<number | 'NOT_MIGRATED'> {
    const n = await absentUntilMigrated(this.prisma.workOrigin.count({ where: { organizationId, originKind: r.originKind, originRef: r.originRef } }));
    return n === null ? 'NOT_MIGRATED' : n;
  }

  /** The work one confirmed submission created, if it already did. */
  private async bySubmission(organizationId: string, submissionKey: string): Promise<string | null | 'NOT_MIGRATED'> {
    const row = await absentUntilMigrated(this.prisma.workOrigin.findFirst({ where: { organizationId, submissionKey }, select: { workInstanceId: true } }).then((x) => x ?? false));
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
        if (!origin.caseId) return { refusal: 'INVALID_INPUT' };
        const situations = new SituationRepository(this.prisma);
        // 1. The actor's OWN private situation: through the private door, as the signed principal.
        const mine = await situations.get({ scope: 'PRINCIPAL', organizationId: actor.organizationId, userId: actor.userId }, origin.caseId);
        if (mine) {
          if (mine.state === 'RESOLVED' || mine.state === 'DISMISSED') return { refusal: 'STALE' };
          return {
            originKind: 'CASE',
            originScope: 'PRINCIPAL',
            originRef: mine.id,
            originLabel: 'Your situation',
            title: clip(mine.title, PROMOTE_TITLE_MAX_CHARS),
            outcome: clip(mine.summary ?? mine.title, PROMOTE_OUTCOME_MAX_CHARS),
            targetAt: null,
            fingerprint: fingerprintOf(mine.id, mine.title, mine.state, mine.lastDetectedAt.toISOString()),
            link: { kind: 'PRIVATE_SITUATION', caseId: mine.id },
          };
        }
        // 2. An organization Case, under organization authority. (A private situation is excluded here by value.)
        if (!actor.mayReadCases) return { refusal: 'NOT_FOUND' };
        const kase = await new OperationalPriorityRepository(this.prisma).findById(actor.organizationId, origin.caseId);
        if (!kase) return { refusal: 'NOT_FOUND' };
        if (kase.sourceSystem === SITUATION_SOURCE) {
          // An organization situation: only for someone who may read every domain it cites.
          const view = await situations.get({ scope: 'ORGANIZATION', organizationId: actor.organizationId }, kase.id);
          const domains = view?.record?.domains ?? [];
          if (domains.length === 0 || !domains.every((d) => actor.mayReadOrganizationDomain(d))) return { refusal: 'NOT_FOUND' };
        }
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

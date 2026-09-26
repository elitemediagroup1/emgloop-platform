// Situations: connected business situations, held as Cases. Loop Intelligence Phase F, 2026-09-26.
//
// THE ONE DOOR TO SITUATION CASES AND TO PRIVATE CASES. An ORGANIZATION situation is an ordinary Case
// (sourceSystem SITUATION_SOURCE) that every Case surface already shows. A PRIVATE situation (it cites one
// person's private intelligence) is a Case with sourceSystem PRIVATE_SITUATION_SOURCE and a
// case_private_scopes row naming its one owner; every organization Case read excludes it, and this
// repository reads it only for that owner -- resolved in the query, never by a caller's check.
//
// Every write goes through OperationalPriorityRepository.detect (the Case authority): a NEW situation
// opens a Case whose opening observation carries the situation record (claims, citations, verification);
// an UPDATE re-sights the SUPPLIED Case and appends its new record as EVIDENCE_ADDED. Nothing here moves a
// lane, assigns anyone, or closes anything.
//
// MERGE-SAFE: every method probes `privateSituationsPresent` (the Phase F migration) first and answers
// NOT_MIGRATED / empty before it has run.

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { PRIVATE_SITUATION_SOURCE, SITUATION_SOURCE, type SituationVerificationState } from '@emgloop/shared';

import { OperationalPriorityRepository } from '../operational-priority.repository';
import { privateSituationsPresent } from './intelligence-fabric-presence';

export type SituationOwner =
  | { readonly scope: 'ORGANIZATION'; readonly organizationId: string }
  | { readonly scope: 'PRINCIPAL'; readonly organizationId: string; readonly userId: string };

export const SITUATION_RECORD_SCHEMA = 'loop-situation.v1';

/** What a situation Case's evidence holds. Canonical references and paraphrase; no source text. */
export interface SituationRecord {
  readonly schema: typeof SITUATION_RECORD_SCHEMA;
  readonly clusterKey: string;
  readonly fingerprint: string;
  readonly narrative: string;
  /** Canonical entity references the cluster was built on. */
  readonly refs: readonly string[];
  /** Every evidence reference the claims cite (digest signals: `digest:<id>/<key>`). */
  readonly citations: readonly string[];
  readonly domains: readonly string[];
  readonly claims: readonly { readonly kind: string; readonly statement: string; readonly citations: readonly string[]; readonly verdict: 'SUPPORTED' | 'UNSUPPORTED' | 'UNCLEAR' | null }[];
  readonly limitations: readonly string[];
  readonly verification: { readonly state: SituationVerificationState; readonly providerId: string | null };
  readonly synthesis: { readonly invocationId: string; readonly providerId: string; readonly taskId: string; readonly taskVersion: string };
  readonly windowStart: string;
  readonly windowEnd: string;
}

export interface SituationView {
  readonly id: string;
  readonly visibility: 'ORGANIZATION' | 'PRINCIPAL';
  readonly title: string;
  readonly summary: string | null;
  readonly severity: string;
  readonly state: string;
  readonly firstDetectedAt: Date;
  readonly lastDetectedAt: Date;
  readonly record: SituationRecord | null;
}

const OPEN_STATES = ['NEEDS_REVIEW', 'ASSIGNED', 'WATCHING'] as const;
const SELECT = { id: true, title: true, summary: true, severity: true, state: true, firstDetectedAt: true, lastDetectedAt: true, sourceSystem: true } as const;

function isRecord(v: unknown): v is SituationRecord {
  return !!v && typeof v === 'object' && (v as { schema?: unknown }).schema === SITUATION_RECORD_SCHEMA;
}

/** A private situation's recurrence key carries its owner, so two people's identical clusters never meet. */
export function situationRecurrenceKey(owner: SituationOwner, clusterKey: string): string {
  if (owner.scope === 'ORGANIZATION') return clusterKey;
  return `${createHash('sha256').update(`${owner.organizationId}\n${owner.userId}`).digest('hex').slice(0, 16)}:${clusterKey}`;
}

export class SituationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  present(): Promise<boolean> {
    return privateSituationsPresent(this.prisma);
  }

  private where(owner: SituationOwner) {
    return owner.scope === 'ORGANIZATION'
      ? { organizationId: owner.organizationId, sourceSystem: SITUATION_SOURCE }
      : { organizationId: owner.organizationId, sourceSystem: PRIVATE_SITUATION_SOURCE, privateScope: { is: { userId: owner.userId, organizationId: owner.organizationId } } };
  }

  private async withRecords(owner: SituationOwner, rows: { id: string; title: string; summary: string | null; severity: string; state: string; firstDetectedAt: Date; lastDetectedAt: Date }[]): Promise<SituationView[]> {
    if (rows.length === 0) return [];
    const obs = await this.prisma.operationalObservation.findMany({
      where: { organizationId: owner.organizationId, priorityId: { in: rows.map((r) => r.id) }, observationType: { in: ['SITUATION_DETECTED', 'EVIDENCE_ADDED'] } },
      orderBy: [{ sequence: 'desc' }],
      select: { priorityId: true, evidence: true },
    });
    const latest = new Map<string, SituationRecord>();
    for (const o of obs) if (!latest.has(o.priorityId) && isRecord(o.evidence)) latest.set(o.priorityId, o.evidence);
    return rows.map((r) => ({ ...r, visibility: owner.scope, record: latest.get(r.id) ?? null }));
  }

  /** The owner's OPEN situations (for synthesis to UPDATE rather than duplicate, and for Home). */
  async open(owner: SituationOwner, take = 20): Promise<SituationView[]> {
    if (!(await this.present())) return [];
    const rows = await this.prisma.operationalPriority.findMany({
      where: { ...this.where(owner), state: { in: [...OPEN_STATES] } },
      orderBy: [{ lastDetectedAt: 'desc' }],
      take: Math.min(50, Math.max(1, take)),
      select: SELECT,
    });
    return this.withRecords(owner, rows);
  }

  /** One situation, for its owner (a private one) or the organization. Anyone else: null. */
  async get(owner: SituationOwner, caseId: string): Promise<SituationView | null> {
    if (!(await this.present())) return null;
    const row = await this.prisma.operationalPriority.findFirst({ where: { id: caseId, ...this.where(owner) }, select: SELECT });
    if (!row) return null;
    return (await this.withRecords(owner, [row]))[0] ?? null;
  }

  async candidate(owner: SituationOwner, clusterKey: string): Promise<{ fingerprint: string; decision: string; caseId: string | null } | null> {
    if (!(await this.present())) return null;
    return this.prisma.situationCandidate.findFirst({
      where: { organizationId: owner.organizationId, userId: owner.scope === 'PRINCIPAL' ? owner.userId : null, clusterKey },
      select: { fingerprint: true, decision: true, caseId: true },
    });
  }

  /** Remember the decision a cluster's fingerprint got, so an unchanged cluster is never asked again. */
  async recordCandidate(owner: SituationOwner, input: { clusterKey: string; fingerprint: string; decision: 'NEW' | 'UPDATE' | 'NONE'; caseId: string | null; verification: string | null; at: Date }): Promise<'RECORDED' | 'NOT_MIGRATED'> {
    if (!(await this.present())) return 'NOT_MIGRATED';
    const userId = owner.scope === 'PRINCIPAL' ? owner.userId : null;
    const data = { fingerprint: input.fingerprint, decision: input.decision, caseId: input.caseId, verification: input.verification, decidedAt: input.at };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.prisma.situationCandidate.findFirst({ where: { organizationId: owner.organizationId, userId, clusterKey: input.clusterKey }, select: { id: true } });
      if (existing) {
        await this.prisma.situationCandidate.update({ where: { id: existing.id }, data });
        return 'RECORDED';
      }
      try {
        await this.prisma.situationCandidate.create({ data: { organizationId: owner.organizationId, userId, clusterKey: input.clusterKey, ...data } });
        return 'RECORDED';
      } catch (e) {
        if ((e as { code?: string })?.code !== 'P2002') throw e;
      }
    }
    return 'RECORDED';
  }

  /**
   * Record a situation the model decided on. NEW opens a Case (private: plus its scope row); UPDATE
   * re-sights the SUPPLIED open situation -- which must be the owner's -- and appends the new record.
   */
  async record(
    owner: SituationOwner,
    input: { decision: 'NEW' | 'UPDATE'; caseId: string | null; title: string; narrative: string; severity: string; record: SituationRecord; at: Date },
  ): Promise<{ outcome: 'OPENED' | 'UPDATED'; caseId: string } | { outcome: 'REFUSED'; refusal: 'NOT_MIGRATED' | 'NOT_FOUND' }> {
    if (!(await this.present())) return { outcome: 'REFUSED', refusal: 'NOT_MIGRATED' };
    const cases = new OperationalPriorityRepository(this.prisma);
    const sourceSystem = owner.scope === 'ORGANIZATION' ? SITUATION_SOURCE : PRIVATE_SITUATION_SOURCE;
    const detectionKey = `situation:${input.record.fingerprint.slice(-32)}`;
    if (input.decision === 'UPDATE') {
      const existing = input.caseId ? await this.prisma.operationalPriority.findFirst({ where: { id: input.caseId, ...this.where(owner) }, select: { id: true, recurrenceKey: true } }) : null;
      if (!existing) return { outcome: 'REFUSED', refusal: 'NOT_FOUND' };
      await cases.detect(owner.organizationId, { sourceSystem, recurrenceKey: existing.recurrenceKey, detectionKey, detectedAt: input.at, title: input.title, summary: input.narrative, severity: input.severity });
      await cases.appendSituationEvidence(owner.organizationId, existing.id, sourceSystem, input.at, input.record as unknown as Record<string, unknown>);
      return { outcome: 'UPDATED', caseId: existing.id };
    }
    const opened = await cases.detect(owner.organizationId, {
      sourceSystem,
      recurrenceKey: situationRecurrenceKey(owner, input.record.clusterKey),
      detectionKey,
      detectedAt: input.at,
      title: input.title,
      summary: input.narrative,
      severity: input.severity,
      evidence: input.record as unknown as Record<string, unknown>,
    });
    if (owner.scope === 'PRINCIPAL') {
      // The owner is named in the same pass. If this fails, the Case is visible to nobody (fail closed).
      await this.prisma.casePrivateScope.upsert({ where: { caseId: opened.priority.id }, create: { organizationId: owner.organizationId, caseId: opened.priority.id, userId: owner.userId }, update: {} });
    }
    if (opened.effect !== 'OPENED') await cases.appendSituationEvidence(owner.organizationId, opened.priority.id, sourceSystem, input.at, input.record as unknown as Record<string, unknown>);
    return { outcome: opened.effect === 'OPENED' ? 'OPENED' : 'UPDATED', caseId: opened.priority.id };
  }

  /**
   * Who a scheduled pass should consider: organizations holding live ORGANIZATION readings in at least two
   * domains, and people holding live readings of their own in at least two. Ids only, bounded.
   */
  async owners(scope: 'ORGANIZATION' | 'PRINCIPAL', now: Date, take = 200): Promise<SituationOwner[]> {
    const rows = await this.prisma.intelligenceDigest.groupBy({
      by: ['organizationId', 'userId', 'domain'],
      where: { scope, status: { not: 'WITHDRAWN' }, expiresAt: { gt: now }, ...(scope === 'ORGANIZATION' ? { userId: null } : { userId: { not: null } }) },
      orderBy: [{ organizationId: 'asc' }, { userId: 'asc' }, { domain: 'asc' }],
      take: take * 8,
    });
    const domains = new Map<string, number>();
    for (const r of rows) domains.set(`${r.organizationId}\n${r.userId ?? ''}`, (domains.get(`${r.organizationId}\n${r.userId ?? ''}`) ?? 0) + 1);
    return [...domains.entries()]
      .filter(([, n]) => n >= 2)
      .slice(0, take)
      .map(([k]) => {
        const [organizationId, userId] = k.split('\n') as [string, string];
        return scope === 'ORGANIZATION' ? { scope: 'ORGANIZATION', organizationId } : { scope: 'PRINCIPAL', organizationId, userId };
      });
  }

  /**
   * Record on the owner's situation that a person promoted it to work (WORK_LINKED). Resolved WITHIN the
   * owner's scope first -- a private situation only for its owner -- then appended through the situation
   * door. False when it is not the owner's (nothing is written).
   */
  async linkWork(owner: SituationOwner, caseId: string, link: { readonly workInstanceId: string; readonly actorUserId: string; readonly at: Date }): Promise<boolean> {
    if (!(await this.present())) return false;
    const row = await this.prisma.operationalPriority.findFirst({ where: { id: caseId, ...this.where(owner) }, select: { id: true, sourceSystem: true } });
    if (!row) return false;
    return new OperationalPriorityRepository(this.prisma).appendToSituation(owner.organizationId, row.id, row.sourceSystem, {
      observationType: 'WORK_LINKED',
      occurredAt: link.at,
      actorType: 'HUMAN',
      actorUserId: link.actorUserId,
      source: 'promote-to-work',
      evidence: { destination: { system: 'work-os', type: 'work_instance', id: link.workInstanceId } },
    });
  }

  /** Organization candidates not decided for 90 days (a private one lives with its owner's membership). */
  async purgeStaleCandidates(now: Date): Promise<{ purged: number }> {
    if (!(await this.present())) return { purged: 0 };
    const { count } = await this.prisma.situationCandidate.deleteMany({ where: { userId: null, decidedAt: { lt: new Date(now.getTime() - 90 * 86_400_000) } } });
    return { purged: count };
  }
}

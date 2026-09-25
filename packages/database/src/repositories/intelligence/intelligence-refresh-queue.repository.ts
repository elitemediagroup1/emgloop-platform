// THE INTELLIGENCE REFRESH QUEUE: persistence. Loop Intelligence PR 2 (the fabric), 2026-09-26.
// Migration 20261006000002_intelligence_refresh_queue.
//
// A DURABLE, COALESCING, LEASED REQUEST that one intelligence target -- (scope, organization, person for
// PRINCIPAL, domain, subject kind, subject ref) -- be refreshed. The generic producer loop
// (services/intelligence/intelligence-producer-loop.ts) claims requests, runs the registered producer
// and completes, retries or holds them.
//
// METADATA ONLY. A request carries a reason, an optional source id and revision, an optional
// fingerprint -- never content, never a body, never a message. The database bounds every text column.
//
// COALESCING. At most one PENDING request per target (partial unique indexes, per scope). A second
// request for a pending target bumps its count and keeps the EARLIER notBefore. A principal request and
// an organization request are different targets and never collapse into each other. A target may have
// one CLAIMED request (running) and one PENDING (evidence that arrived meanwhile).
//
// CONCURRENCY. Enqueue is find-or-create with the unique index as the arbiter (a lost create race
// retries as a coalesce). Claim is compare-and-set (`updateMany where state = PENDING`), so two workers
// can never both own a request. An expired lease is recovered by the next claimer: back to PENDING, or,
// when a newer PENDING request already exists for the target, folded into it.
//
// ENQUEUE IS A PRODUCER'S ACT, NEVER A PAGE'S. Nothing in apps/web enqueues (a source-scan test pins it):
// rendering Home or a domain page must never cause a model call.
//
// MERGE-SAFE: every method probes `refreshQueuePresent` first and answers NOT_MIGRATED / empty before
// the migration has run.

import type { Prisma, PrismaClient } from '@prisma/client';
import { INTELLIGENCE_DOMAIN_SUBJECT_REF, INTELLIGENCE_SUBJECT_KINDS, PRIVATE_INTELLIGENCE_DOMAINS, intelligenceDomainAllowsScope, type IntelligenceDomain, type IntelligenceSubjectKind } from '@emgloop/shared';

import { refreshQueuePresent } from './intelligence-fabric-presence';

export type IntelligenceRefreshTarget =
  | {
      readonly scope: 'PRINCIPAL';
      readonly organizationId: string;
      readonly userId: string;
      readonly domain: IntelligenceDomain;
      readonly subjectKind: IntelligenceSubjectKind;
      readonly subjectRef: string;
    }
  | {
      readonly scope: 'ORGANIZATION';
      readonly organizationId: string;
      readonly domain: IntelligenceDomain;
      readonly subjectKind: IntelligenceSubjectKind;
      readonly subjectRef: string;
    };

export interface IntelligenceRefreshRequestInput {
  /** Why: an upper-snake reason code (EVIDENCE_CHANGED, SCHEDULED, CONSENT_GRANTED, ...). Never prose. */
  readonly reason: string;
  readonly sourceId?: string | null;
  readonly sourceRevision?: string | null;
  readonly fingerprint?: string | null;
  /** Not before this instant (debounce). Defaults to now. */
  readonly notBefore?: Date;
}

/** A claimed request, as the producer loop sees it. Metadata only. */
export interface IntelligenceRefreshClaim {
  readonly id: string;
  readonly target: IntelligenceRefreshTarget;
  readonly reason: string;
  readonly sourceId: string | null;
  readonly sourceRevision: string | null;
  readonly fingerprint: string | null;
  readonly requestCount: number;
  readonly attempts: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
}

export const INTELLIGENCE_REFRESH_STATES = ['PENDING', 'CLAIMED', 'HELD'] as const;
export type IntelligenceRefreshState = (typeof INTELLIGENCE_REFRESH_STATES)[number];

export type IntelligenceEnqueueOutcome =
  | { readonly outcome: 'ENQUEUED' | 'COALESCED'; readonly id: string }
  | { readonly outcome: 'REFUSED'; readonly refusal: 'INVALID_TARGET' | 'SCOPE_NOT_ALLOWED_FOR_DOMAIN' | 'INVALID_REQUEST' | 'NOT_MIGRATED' };

/** Counts per (scope, domain, state), and the oldest pending request's age. No target, no subject, no identity. */
export interface IntelligenceRefreshCount {
  readonly scope: 'PRINCIPAL' | 'ORGANIZATION';
  readonly domain: string;
  readonly state: IntelligenceRefreshState;
  readonly count: number;
  readonly oldestRequestedAt: Date | null;
}

const REASON = /^[A-Z][A-Z_]{1,47}$/;
const SOURCE_ID = /^[A-Z][A-Z0-9_]{0,63}$/;
const OUTCOME = /^[A-Z][A-Z_]{1,63}$/;
const SUBJECT_REF = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,255}$/;

const CLAIM_SELECT = Object.freeze({
  id: true,
  organizationId: true,
  scope: true,
  userId: true,
  domain: true,
  subjectKind: true,
  subjectRef: true,
  reason: true,
  sourceId: true,
  sourceRevision: true,
  fingerprint: true,
  requestCount: true,
  attempts: true,
  leaseOwner: true,
  leaseExpiresAt: true,
} as const);

function targetWhere(t: IntelligenceRefreshTarget) {
  return {
    organizationId: t.organizationId,
    scope: t.scope,
    userId: t.scope === 'PRINCIPAL' ? t.userId : null,
    domain: t.domain,
    subjectKind: t.subjectKind,
    subjectRef: t.subjectRef,
  };
}

/** Why a target is not one this queue accepts, or null. Fail closed on anything unexpected. */
export function refreshTargetRefusal(t: IntelligenceRefreshTarget): 'INVALID_TARGET' | 'SCOPE_NOT_ALLOWED_FOR_DOMAIN' | null {
  if (!t || (t.scope !== 'PRINCIPAL' && t.scope !== 'ORGANIZATION')) return 'INVALID_TARGET';
  if (!t.organizationId) return 'INVALID_TARGET';
  if (t.scope === 'PRINCIPAL' && !t.userId) return 'INVALID_TARGET';
  if (t.scope === 'ORGANIZATION' && ('userId' in t || PRIVATE_INTELLIGENCE_DOMAINS.includes(t.domain))) return 'SCOPE_NOT_ALLOWED_FOR_DOMAIN';
  if (!intelligenceDomainAllowsScope(t.domain, t.scope)) return 'SCOPE_NOT_ALLOWED_FOR_DOMAIN';
  if (!(INTELLIGENCE_SUBJECT_KINDS as readonly string[]).includes(t.subjectKind)) return 'INVALID_TARGET';
  if (typeof t.subjectRef !== 'string' || !SUBJECT_REF.test(t.subjectRef)) return 'INVALID_TARGET';
  if ((t.subjectKind === 'DOMAIN') !== (t.subjectRef === INTELLIGENCE_DOMAIN_SUBJECT_REF)) return 'INVALID_TARGET';
  return null;
}

function requestIsValid(r: IntelligenceRefreshRequestInput): boolean {
  if (typeof r.reason !== 'string' || !REASON.test(r.reason)) return false;
  if (r.sourceId != null && !(typeof r.sourceId === 'string' && SOURCE_ID.test(r.sourceId))) return false;
  for (const v of [r.sourceRevision, r.fingerprint]) if (v != null && !(typeof v === 'string' && v.length >= 1 && v.length <= 128)) return false;
  if (r.notBefore !== undefined && !(r.notBefore instanceof Date && !Number.isNaN(r.notBefore.getTime()))) return false;
  return true;
}

function claimOf(row: Prisma.IntelligenceRefreshRequestGetPayload<{ select: typeof CLAIM_SELECT }>): IntelligenceRefreshClaim {
  const base = { organizationId: row.organizationId, domain: row.domain as IntelligenceDomain, subjectKind: row.subjectKind as IntelligenceSubjectKind, subjectRef: row.subjectRef };
  return {
    id: row.id,
    target: row.scope === 'PRINCIPAL' && row.userId ? { scope: 'PRINCIPAL', userId: row.userId, ...base } : { scope: 'ORGANIZATION', ...base },
    reason: row.reason,
    sourceId: row.sourceId ?? null,
    sourceRevision: row.sourceRevision ?? null,
    fingerprint: row.fingerprint ?? null,
    requestCount: row.requestCount,
    attempts: row.attempts,
    leaseOwner: row.leaseOwner ?? '',
    leaseExpiresAt: row.leaseExpiresAt ?? new Date(0),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown })?.code === 'P2002';
}

export class IntelligenceRefreshQueueRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Ask for a target to be refreshed. Coalesces into the target's PENDING request when there is one
   * (count + 1, the latest reason and revision, the earlier notBefore), otherwise creates one.
   */
  async enqueue(target: IntelligenceRefreshTarget, request: IntelligenceRefreshRequestInput, now: Date): Promise<IntelligenceEnqueueOutcome> {
    const targetRefusal = refreshTargetRefusal(target);
    if (targetRefusal) return { outcome: 'REFUSED', refusal: targetRefusal };
    if (!requestIsValid(request)) return { outcome: 'REFUSED', refusal: 'INVALID_REQUEST' };
    if (!(await refreshQueuePresent(this.db))) return { outcome: 'REFUSED', refusal: 'NOT_MIGRATED' };
    const where = targetWhere(target);
    const notBefore = request.notBefore ?? now;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = await this.db.intelligenceRefreshRequest.findFirst({ where: { ...where, state: 'PENDING' }, select: { id: true, notBefore: true } });
      if (pending) {
        const { count } = await this.db.intelligenceRefreshRequest.updateMany({
          where: { id: pending.id, state: 'PENDING' },
          data: {
            requestCount: { increment: 1 },
            lastRequestedAt: now,
            reason: request.reason,
            sourceId: request.sourceId ?? null,
            sourceRevision: request.sourceRevision ?? null,
            fingerprint: request.fingerprint ?? null,
            notBefore: pending.notBefore.getTime() <= notBefore.getTime() ? pending.notBefore : notBefore,
          },
        });
        if (count === 1) return { outcome: 'COALESCED', id: pending.id };
        continue; // claimed between the read and the write: look again.
      }
      try {
        const created = await this.db.intelligenceRefreshRequest.create({
          data: {
            ...where,
            reason: request.reason,
            sourceId: request.sourceId ?? null,
            sourceRevision: request.sourceRevision ?? null,
            fingerprint: request.fingerprint ?? null,
            requestCount: 1,
            firstRequestedAt: now,
            lastRequestedAt: now,
            notBefore,
            state: 'PENDING',
          },
          select: { id: true },
        });
        return { outcome: 'ENQUEUED', id: created.id };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Another enqueuer created the pending request first; coalesce into it.
      }
    }
    // Three lost races in a row: the target is being requested and claimed continuously, which is
    // itself a pending refresh. Report the standing request rather than fail the caller.
    const standing = await this.db.intelligenceRefreshRequest.findFirst({ where: { ...where, state: { in: ['PENDING', 'CLAIMED'] } }, select: { id: true } });
    return standing ? { outcome: 'COALESCED', id: standing.id } : { outcome: 'REFUSED', refusal: 'INVALID_REQUEST' };
  }

  /**
   * Claim up to `limit` due requests for `leaseOwner`, first recovering expired leases. Each claim is a
   * compare-and-set, so a request is owned by exactly one claimer. Optionally restricted to domains
   * (the ones a commissioned producer exists for); with an empty list nothing is claimed.
   */
  async claim(opts: { readonly leaseOwner: string; readonly now: Date; readonly leaseMs: number; readonly limit: number; readonly domains?: readonly string[] }): Promise<IntelligenceRefreshClaim[]> {
    if (!opts.leaseOwner || opts.leaseOwner.length > 128 || opts.limit < 1) return [];
    if (opts.domains && opts.domains.length === 0) return [];
    if (!(await refreshQueuePresent(this.db))) return [];
    await this.recoverExpired(opts.now);
    const candidates = await this.db.intelligenceRefreshRequest.findMany({
      where: { state: 'PENDING', notBefore: { lte: opts.now }, ...(opts.domains ? { domain: { in: [...opts.domains] } } : {}) },
      orderBy: [{ notBefore: 'asc' }, { id: 'asc' }],
      take: Math.min(opts.limit * 2, 200),
      select: { id: true },
    });
    const leaseExpiresAt = new Date(opts.now.getTime() + opts.leaseMs);
    const claimed: IntelligenceRefreshClaim[] = [];
    for (const { id } of candidates) {
      if (claimed.length >= opts.limit) break;
      const { count } = await this.db.intelligenceRefreshRequest.updateMany({
        where: { id, state: 'PENDING' },
        data: { state: 'CLAIMED', leaseOwner: opts.leaseOwner, leaseExpiresAt, attempts: { increment: 1 } },
      });
      if (count !== 1) continue;
      const row = await this.db.intelligenceRefreshRequest.findFirst({ where: { id, leaseOwner: opts.leaseOwner, state: 'CLAIMED' }, select: CLAIM_SELECT });
      if (row) claimed.push(claimOf(row));
    }
    return claimed;
  }

  /** Expired leases go back to PENDING, or fold into the target's newer PENDING request. Returns how many. */
  async recoverExpired(now: Date): Promise<{ readonly recovered: number }> {
    if (!(await refreshQueuePresent(this.db))) return { recovered: 0 };
    const expired = await this.db.intelligenceRefreshRequest.findMany({
      where: { state: 'CLAIMED', leaseExpiresAt: { lt: now } },
      take: 100,
      select: { ...CLAIM_SELECT },
    });
    let recovered = 0;
    for (const row of expired) {
      if (await this.returnToPending(row.id, row.leaseOwner ?? '', row, { notBefore: now, outcome: 'LEASE_EXPIRED' })) recovered += 1;
    }
    return { recovered };
  }

  /** Done: the request is deleted. Only the lease holder can complete it. */
  async complete(claim: Pick<IntelligenceRefreshClaim, 'id' | 'leaseOwner'>): Promise<boolean> {
    const { count } = await this.db.intelligenceRefreshRequest.deleteMany({ where: { id: claim.id, state: 'CLAIMED', leaseOwner: claim.leaseOwner } });
    return count === 1;
  }

  /**
   * A transient failure: back to PENDING not before `retryAt`, or HELD once `attempts` reached
   * `maxAttempts`. Only the lease holder can do either.
   */
  async retry(claim: IntelligenceRefreshClaim, opts: { readonly outcome: string; readonly retryAt: Date; readonly maxAttempts: number }): Promise<'RETRYING' | 'HELD' | 'LOST'> {
    const outcome = OUTCOME.test(opts.outcome) ? opts.outcome : 'FAILED';
    if (claim.attempts >= opts.maxAttempts) return (await this.hold(claim, outcome)) ? 'HELD' : 'LOST';
    const row = await this.db.intelligenceRefreshRequest.findFirst({ where: { id: claim.id, state: 'CLAIMED', leaseOwner: claim.leaseOwner }, select: CLAIM_SELECT });
    if (!row) return 'LOST';
    return (await this.returnToPending(claim.id, claim.leaseOwner, row, { notBefore: opts.retryAt, outcome })) ? 'RETRYING' : 'LOST';
  }

  /** Not retryable (or out of attempts): HELD for an operator, with an outcome code. */
  async hold(claim: Pick<IntelligenceRefreshClaim, 'id' | 'leaseOwner'>, outcome: string): Promise<boolean> {
    const { count } = await this.db.intelligenceRefreshRequest.updateMany({
      where: { id: claim.id, state: 'CLAIMED', leaseOwner: claim.leaseOwner },
      data: { state: 'HELD', leaseOwner: null, leaseExpiresAt: null, lastOutcome: OUTCOME.test(outcome) ? outcome : 'HELD' },
    });
    return count === 1;
  }

  private async returnToPending(
    id: string,
    leaseOwner: string,
    row: Prisma.IntelligenceRefreshRequestGetPayload<{ select: typeof CLAIM_SELECT }>,
    opts: { readonly notBefore: Date; readonly outcome: string },
  ): Promise<boolean> {
    const target = claimOf(row).target;
    try {
      const { count } = await this.db.intelligenceRefreshRequest.updateMany({
        where: { id, state: 'CLAIMED', leaseOwner },
        data: { state: 'PENDING', leaseOwner: null, leaseExpiresAt: null, notBefore: opts.notBefore, lastOutcome: opts.outcome },
      });
      return count === 1;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A newer PENDING request exists for this target: fold this one into it and delete this one.
      return this.db.$transaction(async (tx) => {
        const gone = await tx.intelligenceRefreshRequest.deleteMany({ where: { id, state: 'CLAIMED', leaseOwner } });
        if (gone.count !== 1) return false;
        await tx.intelligenceRefreshRequest.updateMany({ where: { ...targetWhere(target), state: 'PENDING' }, data: { requestCount: { increment: row.requestCount } } });
        return true;
      });
    }
  }

  /**
   * The operator view: counts per (scope, domain, state) and the oldest request in each, for ONE
   * organization. No target, no subject reference, no user id is selected.
   */
  async organizationCounts(organizationId: string): Promise<IntelligenceRefreshCount[]> {
    if (!organizationId) return [];
    if (!(await refreshQueuePresent(this.db))) return [];
    const groups = await this.db.intelligenceRefreshRequest.groupBy({
      by: ['scope', 'domain', 'state'],
      where: { organizationId },
      _count: { _all: true },
      _min: { firstRequestedAt: true },
      orderBy: [{ scope: 'asc' }, { domain: 'asc' }, { state: 'asc' }],
    });
    return groups.map((g) => ({
      scope: g.scope === 'ORGANIZATION' ? 'ORGANIZATION' : 'PRINCIPAL',
      domain: g.domain,
      state: ((INTELLIGENCE_REFRESH_STATES as readonly string[]).includes(g.state) ? g.state : 'HELD') as IntelligenceRefreshState,
      count: g._count._all,
      oldestRequestedAt: g._min.firstRequestedAt ?? null,
    }));
  }

  /** Maintenance, across tenants: delete HELD requests last touched before `before`. A count only. */
  async purgeHeld(before: Date): Promise<{ readonly purged: number }> {
    if (!(await refreshQueuePresent(this.db))) return { purged: 0 };
    const { count } = await this.db.intelligenceRefreshRequest.deleteMany({ where: { state: 'HELD', updatedAt: { lte: before } } });
    return { purged: count };
  }
}

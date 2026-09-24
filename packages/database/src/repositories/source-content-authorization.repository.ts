// Employee content-processing consent (Telegram content-triage slice): persistence.
//
// This records the employee's EXPLICIT, revocable authorization for Loop to read message CONTENT
// transiently and have AI decide whether a new inbound message is meaningfully actionable. It is a
// deliberate SIBLING of SourceBaselineCheckpointRepository, following the same discipline -- and it
// NEVER writes source_connections or source_baseline_checkpoints, so the content sweep can never move
// the live observation cursor (SourceConnection.cursor) or the baseline checkpoint. That independence
// is the whole point of a separate table.
//
// ORGANIZATION FIRST, AND USER-PRIVATE. Every tenant-scoped method takes (organizationId, userId) from
// the signed session and resolves the row inside that scope; an authorization in another organization,
// or belonging to another person, is not found -- never forbidden. There is no org-only write path. The
// one cross-tenant read (dueForContent) is routing-only, mirroring dueForBaseline/dueForObservation.
//
// CONTENT-FREE. contentCursor is an opaque content-free message id; there is no column that can hold a
// message, a name or a raw id. Audit rows record ids, the provider and a class -- never a secret or text.
//
// CONSENT IS DERIVED, NOT A STATE COLUMN. Authorized means authorizedAt set and revokedAt null; revoked
// means revokedAt set. A revoke stops all further content processing immediately -- AND, in the same
// transaction, withdraws what that processing already derived: every MODEL-produced WorkItem for the
// provider is closed (REVOKED) and minimized to provenance (WorkWithdrawalRepository, §21.2). The
// content cursor is kept, so a later re-authorization does not re-triage what was already judged.
//
// THE WRITE RE-CHECKS IT (2026-09-24). `contentAuthorizedInTx` is the one read of that derived fact
// for a writer: WorkItemRepository.detect calls it inside its own transaction before writing a MODEL
// item on a derived subject, so a content sweep that was already in flight when the revoke committed
// cannot land a fresh paraphrase, or refresh a just-minimized row, afterwards.

import type { Prisma, PrismaClient } from '@prisma/client';
import { SOURCE_CONNECTION_AUDIT_ACTIONS, type ConnectionProvider } from '@emgloop/shared';

import { membershipAuthority } from './membership.repository';
import { writeAudit, type SourceConnectionActor } from './source-connection.repository';
import { WorkWithdrawalRepository } from './work-state/work-withdrawal.repository';

/** The words a withdrawal observation and the minimized evidence carry for an employee's own revoke. */
const CONTENT_REVOKED_REASON = 'content authorization revoked';

/**
 * Revoke every live content authorization this person holds INSIDE the caller's transaction, with
 * an audit row per provider. Used by offboarding: disabling or removing a member withdraws their
 * content consent in the same transaction as the membership change, so a consent never outlives
 * the membership it was given under. The derived items are not withdrawn here -- offboarding
 * erases every work row outright (WorkErasureRepository) in the same transaction. Returns how many
 * authorizations were revoked; nothing is written, and no audit row, for one already revoked.
 */
export async function revokeContentAuthorizationsInTx(
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
  request: { readonly actor: SourceConnectionActor; readonly now: Date; readonly reason: 'MEMBER_DISABLED' | 'MEMBER_REMOVED' },
): Promise<number> {
  const live = await tx.sourceContentAuthorization.findMany({ where: { organizationId, userId, revokedAt: null } });
  for (const row of live) {
    await tx.sourceContentAuthorization.update({ where: { id: row.id }, data: { revokedAt: request.now, backoffUntil: null, historicalBackoffUntil: null } });
    const connection = await tx.sourceConnection.findFirst({ where: { organizationId, userId, provider: row.provider } });
    await writeAudit(prisma, tx, {
      organizationId,
      connectionId: connection?.id ?? row.id,
      action: SOURCE_CONNECTION_AUDIT_ACTIONS.content_revoked,
      provider: row.provider as ConnectionProvider,
      actor: request.actor,
      metadata: { subjectUserId: userId, reason: request.reason },
    });
  }
  return live.length;
}

/**
 * Is this person's content authorization for `provider` in force, read INSIDE the caller's
 * transaction? True iff a row exists with `revokedAt` null -- consent is derived, not a state column
 * (see the header). Scoped by organization, user and provider and by nothing else: not the
 * connection, not the backoff, not the cursor. Those decide whether a sweep RUNS; this decides
 * whether what a sweep concluded may still be WRITTEN, which is why `WorkItemRepository.detect`
 * reads it in the transaction that would write a MODEL item on a derived subject, and refuses when
 * the authorization ended after the sweep began. Fails closed: an empty scope is never authorized.
 */
export async function contentAuthorizedInTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
  provider: string,
): Promise<boolean> {
  if (!organizationId || !userId || !provider) return false;
  const live = await tx.sourceContentAuthorization.findFirst({
    where: { organizationId, userId, provider, revokedAt: null },
    select: { id: true },
  });
  return live !== null;
}

/** The historical-backfill lifecycle. A revoke stops it via revokedAt; there is no REVOKED state column. */
export type HistoricalContentState = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE';

/** An authorization as read for a tile: content-free, no cursor meaning exposed. */
export interface ContentAuthorizationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly provider: ConnectionProvider;
  readonly authorized: boolean;
  readonly authorizedAt: Date;
  readonly revokedAt: Date | null;
  readonly contentCursor: string | null;
  readonly lastRunAt: Date | null;
  readonly lastFailureClass: string | null;
  readonly backoffUntil: Date | null;
  /** v2 historical backfill lifecycle. Enabled means historicalWindowFloorAt is set. */
  readonly historicalState: HistoricalContentState;
  readonly historicalWindowFloorAt: Date | null;
}

/** One authorization worth a content run now: routing fields only, never a credential or content. */
export interface DueContent {
  readonly organizationId: string;
  readonly userId: string;
  readonly provider: ConnectionProvider;
  readonly contentCursor: string | null;
}

/** One authorization worth a HISTORICAL content run now: routing fields only, never a credential or content. */
export interface DueHistoricalContent {
  readonly organizationId: string;
  readonly userId: string;
  readonly provider: ConnectionProvider;
  /** Opaque dialog-pagination frontier the historical sweep resumes from. Never the other cursors. */
  readonly historicalCursor: string | null;
  /** The instant the transient historical reads stop at (the baseline window floor). */
  readonly historicalWindowFloorAt: Date;
}

/** What one content run recorded. NEVER carries the live observation cursor or the baseline checkpoint. */
export interface ContentProgress {
  readonly contentCursor: string | null;
  readonly failureClass?: string | null;
  readonly backoffUntil?: Date | null;
  readonly now: Date;
}

/**
 * What one HISTORICAL content run recorded. Advances ONLY the historical* columns -- NEVER the live
 * observation cursor, the baseline checkpoint or the forward contentCursor.
 */
export interface HistoricalContentProgress {
  readonly historicalCursor: string | null;
  readonly state: HistoricalContentState;
  readonly oldestReachedAt?: Date | null;
  readonly failureClass?: string | null;
  readonly backoffUntil?: Date | null;
  /** Conversations advanced past on a PERMANENT triage failure this run. Incremented, never reset here. */
  readonly failedItemsDelta?: number;
  readonly now: Date;
}

export type ContentWriteOutcome =
  | { readonly outcome: 'AUTHORIZED'; readonly authorizationId: string }
  | { readonly outcome: 'REVOKED'; readonly authorizationId: string }
  | { readonly outcome: 'NOTHING_TO_DO' }
  | { readonly outcome: 'NO_CONNECTION' }
  | { readonly outcome: 'NOT_PERMITTED' };

function toRecord(row: Record<string, any>): ContentAuthorizationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    provider: row.provider,
    authorized: row.revokedAt == null,
    authorizedAt: row.authorizedAt,
    revokedAt: row.revokedAt ?? null,
    contentCursor: row.contentCursor ?? null,
    lastRunAt: row.lastRunAt ?? null,
    lastFailureClass: row.lastFailureClass ?? null,
    backoffUntil: row.backoffUntil ?? null,
    historicalState: (row.historicalState ?? 'NOT_STARTED') as HistoricalContentState,
    historicalWindowFloorAt: row.historicalWindowFloorAt ?? null,
  };
}

export class SourceContentAuthorizationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Authorize (or re-affirm) content processing. Refused, writing nothing, if the membership is not
   * active or there is no connection to authorize content for (content consent never precedes a
   * connection). A re-authorization clears any prior revoke and stamps a fresh authorizedAt, but keeps
   * the content cursor so a resumed sweep does not re-triage the same messages.
   */
  async authorize(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    request: { readonly now: Date; readonly actor: SourceConnectionActor },
  ): Promise<ContentWriteOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const standing = await membershipAuthority(tx, organizationId, userId, request.now);
      if (!standing.granted) return { outcome: 'NOT_PERMITTED' as const };
      const connection = await tx.sourceConnection.findFirst({ where: { organizationId, userId, provider } });
      if (!connection) return { outcome: 'NO_CONNECTION' as const };
      const existing = await tx.sourceContentAuthorization.findFirst({ where: { organizationId, userId, provider } });
      const reaffirm = {
        authorizedAt: request.now,
        revokedAt: null,
        lastFailureClass: null,
        backoffUntil: null,
      };
      const row = existing
        ? await tx.sourceContentAuthorization.update({ where: { id: existing.id }, data: reaffirm })
        : await tx.sourceContentAuthorization.create({
            data: { organizationId, userId, provider, authorizedAt: request.now, contentCursor: null },
          });
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId: connection.id,
        action: SOURCE_CONNECTION_AUDIT_ACTIONS.content_authorized,
        provider,
        actor: request.actor,
        metadata: { subjectUserId: userId },
      });
      return { outcome: 'AUTHORIZED' as const, authorizationId: row.id };
    });
  }

  /**
   * Revoke content processing: stop all further processing immediately (revokedAt stamped) AND, in the
   * same transaction, withdraw what it already derived -- every MODEL-produced WorkItem for this provider
   * is closed with outcome REVOKED (open or snoozed ones) and minimized to provenance (all of them), by
   * WorkWithdrawalRepository (§21.2). The withdrawal's counts go on the audit row. Content-free
   * observations are not touched: they were never under this consent and expire via the existing
   * retention policy. Returns NOTHING_TO_DO when there was nothing to revoke -- and then withdraws
   * nothing and writes no audit row.
   */
  async revoke(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    request: { readonly now: Date; readonly actor: SourceConnectionActor },
  ): Promise<ContentWriteOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.sourceContentAuthorization.findFirst({ where: { organizationId, userId, provider } });
      if (!existing || existing.revokedAt != null) return { outcome: 'NOTHING_TO_DO' as const };
      const connection = await tx.sourceConnection.findFirst({ where: { organizationId, userId, provider } });
      const row = await tx.sourceContentAuthorization.update({
        where: { id: existing.id },
        data: { revokedAt: request.now, backoffUntil: null },
      });
      const withdrawn = await new WorkWithdrawalRepository(tx).withdrawDerived(
        { organizationId, userId },
        { provider, occurredAt: request.now, reason: CONTENT_REVOKED_REASON },
      );
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId: connection?.id ?? existing.id,
        action: SOURCE_CONNECTION_AUDIT_ACTIONS.content_revoked,
        provider,
        actor: request.actor,
        metadata: { subjectUserId: userId, withdrawn: { closed: withdrawn.closed, minimized: withdrawn.minimized } },
      });
      return { outcome: 'REVOKED' as const, authorizationId: row.id };
    });
  }

  /** This person's content authorization for one provider. Null when none. Never exposes cursor meaning. */
  async get(organizationId: string, userId: string, provider: ConnectionProvider): Promise<ContentAuthorizationRecord | null> {
    const row = await this.prisma.sourceContentAuthorization.findFirst({ where: { organizationId, userId, provider } });
    return row ? toRecord(row) : null;
  }

  /**
   * PLATFORM-WORKER DISCOVERY, ACROSS ALL TENANTS. Mirrors dueForBaseline/dueForObservation exactly:
   * the durable worker is ONE process serving every organization, so this returns the authorizations
   * worth a content run now regardless of org -- routing fields only (org, user, provider, cursor),
   * never a credential and never content. Liveness (does a live connection still exist and open?) and
   * activation are enforced DOWNSTREAM (openCredential returning null, and the AI runtime's own gates).
   *
   * DUE = not revoked and past any backoff. Stalest-run first, so a sweep that runs out of time still
   * makes progress.
   */
  async dueForContent(limit = 500): Promise<DueContent[]> {
    const now = new Date();
    const rows = await this.prisma.sourceContentAuthorization.findMany({
      where: {
        revokedAt: null,
        OR: [{ backoffUntil: null }, { backoffUntil: { lt: now } }],
      },
      orderBy: [{ lastRunAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: Math.max(1, Math.min(limit, 2000)),
      select: { organizationId: true, userId: true, provider: true, contentCursor: true },
    });
    return rows.map((r) => ({
      organizationId: r.organizationId,
      userId: r.userId,
      provider: r.provider as ConnectionProvider,
      contentCursor: r.contentCursor ?? null,
    }));
  }

  /**
   * Record one content run's outcome. Scoped to (org, user, provider) and skips an authorization that
   * has been revoked in the meantime (revokedAt: null in the WHERE), so a revoke always wins over an
   * in-flight run. THIS METHOD NEVER TOUCHES source_connections OR source_baseline_checkpoints -- it
   * advances only the content cursor here, so the live observation cursor and the baseline checkpoint
   * can never move on a content path. Returns true when exactly one authorization advanced.
   */
  async recordContentProgress(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    progress: ContentProgress,
  ): Promise<boolean> {
    const { count } = await this.prisma.sourceContentAuthorization.updateMany({
      where: { organizationId, userId, provider, revokedAt: null },
      data: {
        contentCursor: progress.contentCursor,
        lastFailureClass: progress.failureClass ?? null,
        backoffUntil: progress.backoffUntil ?? null,
        lastRunAt: progress.now,
      },
    });
    return count === 1;
  }

  // --- v2 historical backfill --------------------------------------------------------------------
  //
  // A one-off, resumable, TRANSIENT re-read of the already-imported recent window (the baseline floor)
  // that surfaces obligations still unresolved WITHOUT waiting for a new message. It advances ONLY the
  // historical* columns -- never the live observation cursor, the baseline checkpoint or the forward
  // contentCursor -- so the historical sweep cannot move any of them.

  /**
   * Enable the historical backfill for an authorized connection whose baseline is COMPLETE. The CALLER
   * (the connections service) gates on baseline COMPLETE before calling; enabling here simply arms the
   * columns, ONCE. It is idempotent and never resets an in-progress or completed backfill: it writes only
   * when the authorization is live (revokedAt null) and was never enabled (historicalWindowFloorAt null).
   * Returns true when it enabled exactly one.
   */
  async enableHistoricalBackfill(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    request: { readonly floorAt: Date },
  ): Promise<boolean> {
    const { count } = await this.prisma.sourceContentAuthorization.updateMany({
      where: { organizationId, userId, provider, revokedAt: null, historicalWindowFloorAt: null },
      data: {
        historicalState: 'NOT_STARTED',
        historicalWindowFloorAt: request.floorAt,
        historicalCursor: null,
        historicalOldestReachedAt: null,
        historicalLastFailureClass: null,
        historicalBackoffUntil: null,
        historicalFailedItems: 0,
      },
    });
    return count === 1;
  }

  /**
   * PLATFORM-WORKER DISCOVERY, ACROSS ALL TENANTS. Mirrors dueForContent: the durable worker is ONE
   * process serving every organization, so this returns the authorizations worth a HISTORICAL content run
   * now regardless of org -- routing fields only (org, user, provider, the historical cursor and floor),
   * never a credential and never content. Liveness and activation are enforced DOWNSTREAM.
   *
   * DUE = enabled (historicalWindowFloorAt set, which the enable-time gate only does on a COMPLETE
   * baseline), NOT revoked, historicalState NOT_STARTED or IN_PROGRESS, and past any backoff. COMPLETE
   * and a not-yet-enabled (baseline-incomplete) authorization are excluded. Stalest-run first.
   */
  async dueForHistoricalContent(limit = 500): Promise<DueHistoricalContent[]> {
    const now = new Date();
    const rows = await this.prisma.sourceContentAuthorization.findMany({
      where: {
        revokedAt: null,
        historicalState: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
        historicalWindowFloorAt: { not: null },
        OR: [{ historicalBackoffUntil: null }, { historicalBackoffUntil: { lt: now } }],
      },
      orderBy: [{ historicalLastRunAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: Math.max(1, Math.min(limit, 2000)),
      select: { organizationId: true, userId: true, provider: true, historicalCursor: true, historicalWindowFloorAt: true },
    });
    return rows.map((r) => ({
      organizationId: r.organizationId,
      userId: r.userId,
      provider: r.provider as ConnectionProvider,
      historicalCursor: r.historicalCursor ?? null,
      // Non-null by the WHERE above; the fallback keeps the type honest without a non-null assertion.
      historicalWindowFloorAt: r.historicalWindowFloorAt ?? now,
    }));
  }

  /**
   * Record one HISTORICAL content run's outcome. Scoped to (org, user, provider) and skips an
   * authorization revoked in the meantime (revokedAt: null in the WHERE), so a revoke always wins. THIS
   * METHOD NEVER TOUCHES source_connections, source_baseline_checkpoints OR the forward contentCursor --
   * it advances only the historical* columns here. Returns true when exactly one authorization advanced.
   */
  async recordHistoricalProgress(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    progress: HistoricalContentProgress,
  ): Promise<boolean> {
    const data: Record<string, unknown> = {
      historicalCursor: progress.historicalCursor,
      historicalState: progress.state,
      historicalLastFailureClass: progress.failureClass ?? null,
      historicalBackoffUntil: progress.backoffUntil ?? null,
      historicalLastRunAt: progress.now,
    };
    // Only advance the oldest-reached marker when this run reached further; an empty page must not erase it.
    if (progress.oldestReachedAt) data.historicalOldestReachedAt = progress.oldestReachedAt;
    // A PERMANENT triage failure advances past the conversation and is COUNTED, never silently lost.
    if (progress.failedItemsDelta && progress.failedItemsDelta > 0) data.historicalFailedItems = { increment: progress.failedItemsDelta };
    const { count } = await this.prisma.sourceContentAuthorization.updateMany({
      where: { organizationId, userId, provider, revokedAt: null },
      data: data as never,
    });
    return count === 1;
  }
}

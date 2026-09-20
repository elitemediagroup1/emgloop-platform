// Governed historical baseline checkpoints (Telegram, Slice 1): persistence.
//
// The baseline walks a connection's history BACKWARD from the connect point to an employee-chosen
// floor, landing the SAME content-free SourceObservation rows the live sweep does (who/when only).
// This repository owns ONLY the checkpoint that tracks that walk. It is a deliberate sibling of
// SourceConnectionRepository, following the same discipline -- and it NEVER writes source_connections,
// so the baseline can never move the live observation cursor (SourceConnection.cursor). That
// independence is the whole point of a separate table.
//
// ORGANIZATION FIRST, AND USER-PRIVATE. Every tenant-scoped method takes (organizationId, userId)
// from the signed session and resolves the row inside that scope; a checkpoint in another
// organization, or belonging to another person, is not found -- never forbidden. There is no org-only
// write path. The one cross-tenant read (dueForBaseline) is routing-only, mirroring dueForObservation.
//
// CONTENT-FREE. checkpointCursor is an opaque backward offset; there is no column that can hold a
// message, a name or a raw id. Audit rows record ids, the provider and a class -- never a secret or text.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  SOURCE_CONNECTION_AUDIT_ACTIONS,
  isBaselineWindowDays,
  type BaselineState,
  type BaselineWindowDays,
  type ConnectionProvider,
} from '@emgloop/shared';

import { membershipAuthority } from './membership.repository';
import { writeAudit, type SourceConnectionActor } from './source-connection.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A checkpoint as read for a tile: content-free, no cursor secret meaning exposed. */
export interface BaselineCheckpointRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly provider: ConnectionProvider;
  readonly windowDays: number;
  readonly windowFloorAt: Date;
  readonly consentAt: Date;
  readonly state: BaselineState;
  readonly checkpointCursor: string | null;
  readonly oldestReachedAt: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly lastFailureClass: string | null;
  readonly backoffUntil: Date | null;
  readonly revokedAt: Date | null;
}

/** One baseline worth a run now: routing fields only, never a credential or content. */
export interface DueBaseline {
  readonly organizationId: string;
  readonly userId: string;
  readonly provider: ConnectionProvider;
  readonly windowFloorAt: Date;
  readonly checkpointCursor: string | null;
}

/** What one baseline run recorded. NEVER carries the live observation cursor. */
export interface BaselineProgress {
  readonly checkpointCursor: string | null;
  readonly oldestReachedAt: Date | null;
  readonly state: BaselineState;
  readonly failureClass?: string | null;
  readonly backoffUntil?: Date | null;
  readonly now: Date;
}

export type BaselineWriteOutcome =
  | { readonly outcome: 'AUTHORIZED'; readonly checkpointId: string }
  | { readonly outcome: 'SCOPE_CHANGED'; readonly checkpointId: string }
  | { readonly outcome: 'REVOKED'; readonly checkpointId: string }
  | { readonly outcome: 'NOTHING_TO_DO' }
  | { readonly outcome: 'INVALID_WINDOW' }
  | { readonly outcome: 'NO_CONNECTION' }
  | { readonly outcome: 'NOT_PERMITTED' };

function toRecord(row: Record<string, any>): BaselineCheckpointRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    provider: row.provider,
    windowDays: row.windowDays,
    windowFloorAt: row.windowFloorAt,
    consentAt: row.consentAt,
    state: row.state,
    checkpointCursor: row.checkpointCursor ?? null,
    oldestReachedAt: row.oldestReachedAt ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    lastRunAt: row.lastRunAt ?? null,
    lastFailureClass: row.lastFailureClass ?? null,
    backoffUntil: row.backoffUntil ?? null,
    revokedAt: row.revokedAt ?? null,
  };
}

export class SourceBaselineCheckpointRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Authorize (or re-authorize) a baseline at the employee's chosen depth. Refused, writing nothing,
   * if the window is off the allowlist, the membership is not active, or there is no connection to
   * baseline (a baseline never precedes a connection). A re-authorization RESETS the walk to
   * NOT_STARTED and clears the cursor -- the employee asked to start over at a (possibly new) depth.
   */
  async authorize(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    request: { readonly windowDays: number; readonly now: Date; readonly actor: SourceConnectionActor },
  ): Promise<BaselineWriteOutcome> {
    if (!isBaselineWindowDays(request.windowDays)) return { outcome: 'INVALID_WINDOW' };
    const windowDays: BaselineWindowDays = request.windowDays;
    return this.prisma.$transaction(async (tx) => {
      const standing = await membershipAuthority(tx, organizationId, userId, request.now);
      if (!standing.granted) return { outcome: 'NOT_PERMITTED' as const };
      const connection = await tx.sourceConnection.findFirst({ where: { organizationId, userId, provider } });
      if (!connection) return { outcome: 'NO_CONNECTION' as const };
      const anchor = connection.connectedAt ?? request.now;
      const windowFloorAt = new Date(anchor.getTime() - windowDays * DAY_MS);
      const existing = await tx.sourceBaselineCheckpoint.findFirst({ where: { organizationId, userId, provider } });
      const reset = {
        windowDays,
        windowFloorAt,
        consentAt: request.now,
        state: 'NOT_STARTED' as const,
        checkpointCursor: null,
        oldestReachedAt: null,
        startedAt: null,
        completedAt: null,
        lastRunAt: null,
        lastFailureClass: null,
        backoffUntil: null,
        revokedAt: null,
      };
      const checkpoint = existing
        ? await tx.sourceBaselineCheckpoint.update({ where: { id: existing.id }, data: reset })
        : await tx.sourceBaselineCheckpoint.create({ data: { organizationId, userId, provider, ...reset } });
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId: connection.id,
        action: SOURCE_CONNECTION_AUDIT_ACTIONS.baseline_authorized,
        provider,
        actor: request.actor,
        metadata: { subjectUserId: userId, windowDays },
      });
      return { outcome: 'AUTHORIZED' as const, checkpointId: checkpoint.id };
    });
  }

  /**
   * Change the depth of an EXISTING baseline, keeping the walk resumable: the cursor and the oldest
   * point reached are preserved, so a deeper window simply keeps walking from where it was. A window
   * that had COMPLETED or been REVOKED re-opens to NOT_STARTED (from the preserved cursor). Refused,
   * writing nothing, when the window is invalid, the membership is inactive, or nothing exists to scope.
   */
  async changeScope(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    request: { readonly windowDays: number; readonly now: Date; readonly actor: SourceConnectionActor },
  ): Promise<BaselineWriteOutcome> {
    if (!isBaselineWindowDays(request.windowDays)) return { outcome: 'INVALID_WINDOW' };
    const windowDays: BaselineWindowDays = request.windowDays;
    return this.prisma.$transaction(async (tx) => {
      const standing = await membershipAuthority(tx, organizationId, userId, request.now);
      if (!standing.granted) return { outcome: 'NOT_PERMITTED' as const };
      const existing = await tx.sourceBaselineCheckpoint.findFirst({ where: { organizationId, userId, provider } });
      if (!existing) return { outcome: 'NOTHING_TO_DO' as const };
      const connection = await tx.sourceConnection.findFirst({ where: { organizationId, userId, provider } });
      const anchor = connection?.connectedAt ?? existing.consentAt ?? request.now;
      const windowFloorAt = new Date(anchor.getTime() - windowDays * DAY_MS);
      const resumableState: BaselineState = existing.state === 'REVOKED' || existing.state === 'COMPLETE' ? 'NOT_STARTED' : (existing.state as BaselineState);
      const checkpoint = await tx.sourceBaselineCheckpoint.update({
        where: { id: existing.id },
        data: {
          windowDays,
          windowFloorAt,
          consentAt: request.now,
          state: resumableState,
          lastFailureClass: null,
          backoffUntil: null,
          revokedAt: null,
        },
      });
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId: connection?.id ?? existing.id,
        action: SOURCE_CONNECTION_AUDIT_ACTIONS.baseline_scope_changed,
        provider,
        actor: request.actor,
        metadata: { subjectUserId: userId, windowDays },
      });
      return { outcome: 'SCOPE_CHANGED' as const, checkpointId: checkpoint.id };
    });
  }

  /**
   * Revoke a baseline: stop all further processing immediately (REVOKED, revokedAt stamped).
   * Already-written content-free observations are NOT purged here -- they expire only via the
   * existing retention policy. Returns NOTHING_TO_DO when there was nothing to revoke, and writes
   * no audit row for a revoke that did not happen.
   */
  async revoke(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    request: { readonly now: Date; readonly actor: SourceConnectionActor },
  ): Promise<BaselineWriteOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.sourceBaselineCheckpoint.findFirst({ where: { organizationId, userId, provider } });
      if (!existing || existing.state === 'REVOKED') return { outcome: 'NOTHING_TO_DO' as const };
      const connection = await tx.sourceConnection.findFirst({ where: { organizationId, userId, provider } });
      const checkpoint = await tx.sourceBaselineCheckpoint.update({
        where: { id: existing.id },
        data: { state: 'REVOKED', revokedAt: request.now, backoffUntil: null },
      });
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId: connection?.id ?? existing.id,
        action: SOURCE_CONNECTION_AUDIT_ACTIONS.baseline_revoked,
        provider,
        actor: request.actor,
        metadata: { subjectUserId: userId },
      });
      return { outcome: 'REVOKED' as const, checkpointId: checkpoint.id };
    });
  }

  /** This person's baseline for one provider, without exposing any cursor meaning. Null when none. */
  async get(organizationId: string, userId: string, provider: ConnectionProvider): Promise<BaselineCheckpointRecord | null> {
    const row = await this.prisma.sourceBaselineCheckpoint.findFirst({ where: { organizationId, userId, provider } });
    return row ? toRecord(row) : null;
  }

  /**
   * PLATFORM-WORKER DISCOVERY, ACROSS ALL TENANTS. Mirrors dueForObservation exactly: the durable
   * worker is ONE process serving every organization, so this returns the baselines worth a run now
   * regardless of org -- routing fields only (org, user, provider, floor, cursor), never a credential
   * and never content. Liveness (does a live connection still exist and open?) is enforced DOWNSTREAM
   * by openCredential returning null, the same as the live sweep.
   *
   * DUE = state is NOT_STARTED or IN_PROGRESS, not revoked, and past any backoff. COMPLETE and
   * REVOKED are excluded. Stalest-run first, so a sweep that runs out of time still makes progress.
   */
  async dueForBaseline(limit = 500): Promise<DueBaseline[]> {
    const now = new Date();
    const rows = await this.prisma.sourceBaselineCheckpoint.findMany({
      where: {
        state: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
        revokedAt: null,
        OR: [{ backoffUntil: null }, { backoffUntil: { lt: now } }],
      },
      orderBy: [{ lastRunAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: Math.max(1, Math.min(limit, 2000)),
      select: { organizationId: true, userId: true, provider: true, windowFloorAt: true, checkpointCursor: true },
    });
    return rows.map((r) => ({
      organizationId: r.organizationId,
      userId: r.userId,
      provider: r.provider as ConnectionProvider,
      windowFloorAt: r.windowFloorAt,
      checkpointCursor: r.checkpointCursor ?? null,
    }));
  }

  /**
   * Record one baseline run's outcome. Scoped to (org, user, provider) and skips a checkpoint that has
   * been revoked in the meantime (revokedAt: null in the WHERE), so a revoke always wins over an
   * in-flight run. THIS METHOD NEVER TOUCHES source_connections -- it advances only the checkpoint, so
   * the live observation cursor can never move on a baseline path. Returns true when exactly one
   * checkpoint advanced.
   */
  async recordBaselineProgress(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    progress: BaselineProgress,
  ): Promise<boolean> {
    const data: Prisma.SourceBaselineCheckpointUpdateManyMutationInput = {
      checkpointCursor: progress.checkpointCursor,
      state: progress.state,
      lastFailureClass: progress.failureClass ?? null,
      backoffUntil: progress.backoffUntil ?? null,
      lastRunAt: progress.now,
    };
    // Only advance the oldest-reached marker when this run actually reached further back; an empty
    // page must not erase the progress already made.
    if (progress.oldestReachedAt) data.oldestReachedAt = progress.oldestReachedAt;
    if (progress.state === 'COMPLETE') data.completedAt = progress.now;

    // Stamp the first run's start time without disturbing an already-stamped one.
    await this.prisma.sourceBaselineCheckpoint.updateMany({
      where: { organizationId, userId, provider, startedAt: null, revokedAt: null },
      data: { startedAt: progress.now },
    });
    const { count } = await this.prisma.sourceBaselineCheckpoint.updateMany({
      where: { organizationId, userId, provider, revokedAt: null },
      data,
    });
    return count === 1;
  }
}

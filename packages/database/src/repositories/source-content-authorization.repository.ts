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
// means revokedAt set. A revoke stops all further content processing immediately.

import type { PrismaClient } from '@prisma/client';
import { SOURCE_CONNECTION_AUDIT_ACTIONS, type ConnectionProvider } from '@emgloop/shared';

import { membershipAuthority } from './membership.repository';
import { writeAudit, type SourceConnectionActor } from './source-connection.repository';

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
}

/** One authorization worth a content run now: routing fields only, never a credential or content. */
export interface DueContent {
  readonly organizationId: string;
  readonly userId: string;
  readonly provider: ConnectionProvider;
  readonly contentCursor: string | null;
}

/** What one content run recorded. NEVER carries the live observation cursor or the baseline checkpoint. */
export interface ContentProgress {
  readonly contentCursor: string | null;
  readonly failureClass?: string | null;
  readonly backoffUntil?: Date | null;
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
   * Revoke content processing: stop all further processing immediately (revokedAt stamped). No content
   * is selectively purged here -- already-derived WorkItems are the employee's own to resolve, and any
   * content-free observations expire via the existing retention policy. Returns NOTHING_TO_DO when there
   * was nothing to revoke, and writes no audit row for a revoke that did not happen.
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
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId: connection?.id ?? existing.id,
        action: SOURCE_CONNECTION_AUDIT_ACTIONS.content_revoked,
        provider,
        actor: request.actor,
        metadata: { subjectUserId: userId },
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
}

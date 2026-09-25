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
// provider is closed (REVOKED) and minimized to provenance (WorkWithdrawalRepository, §21.2), and
// every domain-intelligence digest drawn from that provider is DELETED (IntelligenceDigestRepository
// .withdrawForProvider; approved 2026-09-24: "removed immediately" -- a digest is a projection, so
// unlike an item there is no provenance-only remainder worth keeping). The content cursor is kept,
// so a later re-authorization does not re-triage what was already judged.
//
// CHATS INTELLIGENCE HYDRATION (2026-09-25). A fourth, independent lifecycle on this row
// (intelligenceHydration*): a digest-only, one-off initialization for authorizations whose historical
// backfill completed before conversation digests existed. dueForChatsHydration / recordChatsHydration
// Progress advance only those columns; a revoke leaves them (revokedAt gates everything) and a
// re-authorization after a revoke resets them to NOT_STARTED.
//
// THE WRITE RE-CHECKS IT (2026-09-24). `contentAuthorizedInTx` is the one read of that derived fact
// for a writer: WorkItemRepository.detect calls it inside its own transaction before writing a MODEL
// item on a derived subject, so a content sweep that was already in flight when the revoke committed
// cannot land a fresh paraphrase, or refresh a just-minimized row, afterwards.

import type { Prisma, PrismaClient } from '@prisma/client';
import { CONNECTION_PROVIDERS, SOURCE_CONNECTION_AUDIT_ACTIONS, mailContentGovernance, type ConnectionProvider, type ContentAuthorizationProvider } from '@emgloop/shared';

import { absentUntilMigrated } from '../creator/until-migrated';
import { membershipAuthority } from './membership.repository';
import { IntelligenceDigestRepository, intelligenceDigestsPresent } from './intelligence/intelligence-digest.repository';
import { writeAudit, type SourceConnectionActor } from './source-connection.repository';
import { WorkWithdrawalRepository } from './work-state/work-withdrawal.repository';

// The one consent read the work-item repository makes at every derived write. Defined in its own
// module (source-content-consent.ts) so that repository need not import this one, which imports
// the withdrawal repository, which imports it back.
export { contentAuthorizedInTx } from './source-content-consent';

/** The Gmail scope that lets Loop read a message body (the Mail page's read-through already requires it). */
const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/**
 * MERGE-SAFE COLUMNS. Every read of a content authorization, and every row a write returns, outside the
 * Chats Intelligence hydration methods names exactly these -- the columns that existed BEFORE
 * 20261004000000_chats_intelligence_hydration. Merging to `main` deploys the web tier at once, while the
 * migration reaches production only when a human dispatches it afterwards; in that window a full-row
 * read (Prisma selects every model column by default) would throw P2022 and take down the Connections
 * status, Chats, authorize/revoke and offboarding. Only `dueForChatsHydration`,
 * `recordChatsHydrationProgress` and the authorize-time reset (gated on `chatsHydrationColumnsPresent`)
 * touch an `intelligenceHydration*` column.
 */
export const CONTENT_AUTHORIZATION_COLUMNS = Object.freeze({
  id: true,
  organizationId: true,
  userId: true,
  provider: true,
  authorizedAt: true,
  revokedAt: true,
  contentCursor: true,
  lastRunAt: true,
  lastFailureClass: true,
  backoffUntil: true,
  historicalState: true,
  historicalCursor: true,
  historicalWindowFloorAt: true,
  historicalOldestReachedAt: true,
  historicalLastRunAt: true,
  historicalLastFailureClass: true,
  historicalBackoffUntil: true,
  historicalFailedItems: true,
  createdAt: true,
  updatedAt: true,
} as const) satisfies Prisma.SourceContentAuthorizationSelect;

/**
 * Whether the hydration columns exist in this database yet. Asked OUTSIDE any transaction (a failed
 * statement aborts the whole Postgres transaction, so it cannot be caught inside one), exactly like
 * `intelligenceDigestsPresent`. A missing column or table (P2022 / P2021) reads as absent; any other
 * error is thrown. Scoped to one principal's rows.
 */
export async function chatsHydrationColumnsPresent(prisma: PrismaClient, organizationId: string, userId: string): Promise<boolean> {
  const probed = await absentUntilMigrated(
    prisma.sourceContentAuthorization.findMany({ where: { organizationId, userId }, select: { id: true, intelligenceHydrationState: true }, take: 1 }),
  );
  return probed !== null;
}

/** The words a withdrawal observation and the minimized evidence carry for an employee's own revoke. */
const CONTENT_REVOKED_REASON = 'content authorization revoked';

/**
 * Revoke every live content authorization this person holds INSIDE the caller's transaction, with
 * an audit row per provider. Used by offboarding: disabling or removing a member withdraws their
 * content consent in the same transaction as the membership change, so a consent never outlives
 * the membership it was given under. The derived items are not withdrawn here -- offboarding
 * erases every work row outright (WorkErasureRepository) in the same transaction. Each provider's
 * domain-intelligence digests ARE deleted here, so a consent never ends with its digests standing. Returns how many
 * authorizations were revoked; nothing is written, and no audit row, for one already revoked.
 */
export async function revokeContentAuthorizationsInTx(
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
  request: {
    readonly actor: SourceConnectionActor;
    readonly now: Date;
    readonly reason: 'MEMBER_DISABLED' | 'MEMBER_REMOVED';
    /** False only when the caller probed (`intelligenceDigestsPresent`) and the table is not migrated yet. */
    readonly digests?: boolean;
  },
): Promise<number> {
  const live = await tx.sourceContentAuthorization.findMany({ where: { organizationId, userId, revokedAt: null }, select: CONTENT_AUTHORIZATION_COLUMNS });
  for (const row of live) {
    await tx.sourceContentAuthorization.update({
      where: { id: row.id },
      data: { revokedAt: request.now, backoffUntil: null, historicalBackoffUntil: null },
      select: { id: true },
    });
    // The digests drawn under this consent go with it, in the same transaction. (Offboarding also
    // erases every digest via WorkErasureRepository; this keeps the revoke self-sufficient.)
    const digests = request.digests === false ? { deleted: 0 } : await new IntelligenceDigestRepository(tx).withdrawForProvider({ organizationId, userId }, row.provider);
    const connection = await tx.sourceConnection.findFirst({ where: { organizationId, userId, provider: row.provider } });
    await writeAudit(prisma, tx, {
      organizationId,
      connectionId: connection?.id ?? row.id,
      action: SOURCE_CONNECTION_AUDIT_ACTIONS.content_revoked,
      provider: row.provider as ConnectionProvider,
      actor: request.actor,
      metadata: { subjectUserId: userId, reason: request.reason, digestsDeleted: digests.deleted },
    });
  }
  return live.length;
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

/** The Chats Intelligence hydration lifecycle (DB CHECK). A revoke stops it via revokedAt. */
export type ChatsHydrationState = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE';

/** One authorization worth a Chats Intelligence HYDRATION run now: routing fields only, never a credential or content. */
export interface DueChatsHydration {
  readonly organizationId: string;
  readonly userId: string;
  readonly provider: ConnectionProvider;
  /** Opaque dialog-pagination frontier the hydration sweep resumes from. Never any other cursor. */
  readonly hydrationCursor: string | null;
  /** The baseline window floor: hydration never reads below it. */
  readonly historicalWindowFloorAt: Date;
}

/**
 * What one HYDRATION run recorded. Advances ONLY the intelligenceHydration* columns -- NEVER the live
 * observation cursor, the baseline checkpoint, the forward contentCursor or the historical* columns.
 */
export interface ChatsHydrationProgress {
  readonly cursor: string | null;
  readonly state: ChatsHydrationState;
  readonly failureClass?: string | null;
  readonly backoffUntil?: Date | null;
  /** Conversations passed over on a PERMANENT triage failure this run. Incremented, never reset here. */
  readonly failedItemsDelta?: number;
  /** The triage output schema a COMPLETED hydration covered. Written only with state COMPLETE. */
  readonly schemaId?: string | null;
  readonly now: Date;
}

/** The hydration columns as a re-authorization after a revoke leaves them: armed from the start. */
const HYDRATION_RESET = Object.freeze({
  intelligenceHydrationState: 'NOT_STARTED',
  intelligenceHydrationCursor: null,
  intelligenceHydrationLastFailureClass: null,
  intelligenceHydrationBackoffUntil: null,
  intelligenceHydrationFailedItems: 0,
  intelligenceHydrationSchemaId: null,
});

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
   * the content cursor so a resumed sweep does not re-triage the same messages. A re-authorization
   * AFTER A REVOKE also resets the Chats Intelligence hydration to NOT_STARTED (fresh consent, fresh
   * initialization); re-affirming a live authorization does not touch it.
   */
  async authorize(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    request: { readonly now: Date; readonly actor: SourceConnectionActor },
  ): Promise<ContentWriteOutcome> {
    // Known before the transaction: a missing column cannot be caught inside one (see the helper).
    const hydrationPresent = await chatsHydrationColumnsPresent(this.prisma, organizationId, userId);
    return this.prisma.$transaction(async (tx) => {
      const standing = await membershipAuthority(tx, organizationId, userId, request.now);
      if (!standing.granted) return { outcome: 'NOT_PERMITTED' as const };
      const connection = await tx.sourceConnection.findFirst({ where: { organizationId, userId, provider } });
      if (!connection) return { outcome: 'NO_CONNECTION' as const };
      const existing = await tx.sourceContentAuthorization.findFirst({ where: { organizationId, userId, provider }, select: CONTENT_AUTHORIZATION_COLUMNS });
      const reaffirm = {
        authorizedAt: request.now,
        revokedAt: null,
        lastFailureClass: null,
        backoffUntil: null,
        // FRESH CONSENT, FRESH INITIALIZATION. A re-authorization AFTER a revoke re-arms the Chats
        // Intelligence hydration from the start: the revoke deleted every digest drawn under the old
        // consent, so there is nothing for the forward path to own until a new message arrives. A
        // re-affirmation of a LIVE authorization leaves hydration exactly where it is. Before the
        // hydration migration there is nothing to reset (the columns do not exist), so it is skipped.
        ...(hydrationPresent && existing && existing.revokedAt != null ? HYDRATION_RESET : {}),
      };
      const row = existing
        ? await tx.sourceContentAuthorization.update({ where: { id: existing.id }, data: reaffirm, select: { id: true } })
        : await tx.sourceContentAuthorization.create({
            data: { organizationId, userId, provider, authorizedAt: request.now, contentCursor: null },
            select: { id: true },
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
    // Known before the transaction: a missing table cannot be caught inside one (see the helper).
    const digestsPresent = await intelligenceDigestsPresent(this.prisma, { organizationId, userId });
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.sourceContentAuthorization.findFirst({ where: { organizationId, userId, provider }, select: CONTENT_AUTHORIZATION_COLUMNS });
      if (!existing || existing.revokedAt != null) return { outcome: 'NOTHING_TO_DO' as const };
      const connection = await tx.sourceConnection.findFirst({ where: { organizationId, userId, provider } });
      const row = await tx.sourceContentAuthorization.update({
        where: { id: existing.id },
        data: { revokedAt: request.now, backoffUntil: null },
        select: { id: true },
      });
      const withdrawn = await new WorkWithdrawalRepository(tx).withdrawDerived(
        { organizationId, userId },
        { provider, occurredAt: request.now, reason: CONTENT_REVOKED_REASON },
      );
      // Domain intelligence drawn under this consent is deleted outright, in this transaction.
      const digests = digestsPresent ? await new IntelligenceDigestRepository(tx).withdrawForProvider({ organizationId, userId }, provider) : { deleted: 0 };
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId: connection?.id ?? existing.id,
        action: SOURCE_CONNECTION_AUDIT_ACTIONS.content_revoked,
        provider,
        actor: request.actor,
        metadata: { subjectUserId: userId, withdrawn: { closed: withdrawn.closed, minimized: withdrawn.minimized }, digestsDeleted: digests.deleted },
      });
      return { outcome: 'REVOKED' as const, authorizationId: row.id };
    });
  }

  /**
   * MAIL CONTENT (Loop Intelligence Phase D). A person authorizes Loop to read their OWN mail content for
   * intelligence. Refused unless the deployment names the recorded counterparty-consent decision
   * (`governanceDecision`, from LOOP_MAIL_CONTENT_GOVERNANCE_DECISION -- UNRESOLVED today, so this refuses
   * GOVERNANCE_UNDECIDED everywhere), the person is an active member, and their Google connection is
   * CONNECTED with the Gmail read scope. The same table and the same revoke/offboarding as every other
   * content authorization; audited against the Google connection.
   */
  async authorizeMailContent(
    organizationId: string,
    userId: string,
    request: { readonly now: Date; readonly actor: SourceConnectionActor; readonly governanceDecision: string | null },
  ): Promise<ContentWriteOutcome | { readonly outcome: 'GOVERNANCE_UNDECIDED' }> {
    if (mailContentGovernance(request.governanceDecision).state !== 'DECIDED') return { outcome: 'GOVERNANCE_UNDECIDED' };
    return this.prisma.$transaction(async (tx) => {
      const standing = await membershipAuthority(tx, organizationId, userId, request.now);
      if (!standing.granted) return { outcome: 'NOT_PERMITTED' as const };
      const google = await tx.googleConnection.findFirst({ where: { organizationId, userId, status: 'CONNECTED' }, select: { id: true, grantedScopes: true } });
      if (!google || !google.grantedScopes.includes(GMAIL_READ_SCOPE)) return { outcome: 'NO_CONNECTION' as const };
      const existing = await tx.sourceContentAuthorization.findFirst({ where: { organizationId, userId, provider: 'GMAIL' }, select: { id: true } });
      const row = existing
        ? await tx.sourceContentAuthorization.update({ where: { id: existing.id }, data: { authorizedAt: request.now, revokedAt: null, lastFailureClass: null, backoffUntil: null }, select: { id: true } })
        : await tx.sourceContentAuthorization.create({ data: { organizationId, userId, provider: 'GMAIL', authorizedAt: request.now, contentCursor: null }, select: { id: true } });
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId: google.id,
        action: SOURCE_CONNECTION_AUDIT_ACTIONS.content_authorized,
        provider: 'GMAIL' as never,
        actor: request.actor,
        metadata: { subjectUserId: userId, governanceDecision: mailContentGovernance(request.governanceDecision).state === 'DECIDED' ? request.governanceDecision : null },
      });
      return { outcome: 'AUTHORIZED' as const, authorizationId: row.id };
    });
  }

  /**
   * Revoke MAIL content: stops every Mail content reading immediately and deletes the person's MAIL
   * digests drawn under it, in the same transaction. Mail content triage raises no WorkItems (the
   * deterministic lanes own those), so there is nothing else to withdraw. Allowed whatever the governance
   * state: stopping is always possible.
   */
  async revokeMailContent(organizationId: string, userId: string, request: { readonly now: Date; readonly actor: SourceConnectionActor }): Promise<ContentWriteOutcome> {
    const digestsPresent = await intelligenceDigestsPresent(this.prisma, { organizationId, userId });
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.sourceContentAuthorization.findFirst({ where: { organizationId, userId, provider: 'GMAIL' }, select: { id: true, revokedAt: true } });
      if (!existing || existing.revokedAt != null) return { outcome: 'NOTHING_TO_DO' as const };
      await tx.sourceContentAuthorization.update({ where: { id: existing.id }, data: { revokedAt: request.now, backoffUntil: null }, select: { id: true } });
      const digests = digestsPresent ? await new IntelligenceDigestRepository(tx).withdrawForProvider({ organizationId, userId }, 'GMAIL') : { deleted: 0 };
      const google = await tx.googleConnection.findFirst({ where: { organizationId, userId }, select: { id: true } });
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId: google?.id ?? existing.id,
        action: SOURCE_CONNECTION_AUDIT_ACTIONS.content_revoked,
        provider: 'GMAIL' as never,
        actor: request.actor,
        metadata: { subjectUserId: userId, digestsDeleted: digests.deleted },
      });
      return { outcome: 'REVOKED' as const, authorizationId: existing.id };
    });
  }

  /** This person's content authorization for one provider. Null when none. Never exposes cursor meaning. */
  async get(organizationId: string, userId: string, provider: ContentAuthorizationProvider): Promise<ContentAuthorizationRecord | null> {
    const row = await this.prisma.sourceContentAuthorization.findFirst({ where: { organizationId, userId, provider }, select: CONTENT_AUTHORIZATION_COLUMNS });
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
        // Background connections only: a GMAIL (mail content) authorization is not the worker's to sweep.
        provider: { in: [...CONNECTION_PROVIDERS] },
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
        // Background connections only: a GMAIL (mail content) authorization is not the worker's to sweep.
        provider: { in: [...CONNECTION_PROVIDERS] },
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

  // --- Chats Intelligence initialization ("hydration") -------------------------------------------
  //
  // A DIGEST-ONLY, one-off, resumable pass over the already-authorized recent window: for each recent
  // conversation that has no current CHATS digest, one governed triage call whose conversation reading is
  // stored as the digest. It writes NO WorkItem and runs NO reconciliation (the historical backfill owns
  // obligations; re-arming it would re-sight and could supersede open items). It advances ONLY the
  // intelligenceHydration* columns.

  /**
   * PLATFORM-WORKER DISCOVERY, ACROSS ALL TENANTS. Mirrors dueForHistoricalContent: the durable worker is
   * ONE process serving every organization, so this returns the authorizations worth a HYDRATION run now
   * regardless of org -- routing fields only (org, user, provider, the hydration cursor and the baseline
   * floor), never a credential and never content. Liveness and activation are enforced DOWNSTREAM.
   *
   * DUE = NOT revoked, hydration NOT_STARTED or IN_PROGRESS, baseline eligible (historicalWindowFloorAt
   * set, which is only ever done on a COMPLETE baseline) AND the historical backfill COMPLETE -- so
   * hydration never races an armed backfill, which already writes digests -- and past any backoff.
   * Stalest-run first.
   *
   * A MISSING COLUMN OR TABLE (P2021 / P2022: a worker deployed ahead of this migration) returns [] --
   * nothing is due, nothing is read, and the other sweeps are untouched.
   */
  async dueForChatsHydration(limit = 500): Promise<DueChatsHydration[]> {
    const now = new Date();
    const rows = await absentUntilMigrated(
      this.prisma.sourceContentAuthorization.findMany({
        where: {
          revokedAt: null,
        // Background connections only: a GMAIL (mail content) authorization is not the worker's to sweep.
        provider: { in: [...CONNECTION_PROVIDERS] },
          intelligenceHydrationState: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
          historicalState: 'COMPLETE',
          historicalWindowFloorAt: { not: null },
          OR: [{ intelligenceHydrationBackoffUntil: null }, { intelligenceHydrationBackoffUntil: { lt: now } }],
        },
        orderBy: [{ intelligenceHydrationLastRunAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
        take: Math.max(1, Math.min(limit, 2000)),
        select: { organizationId: true, userId: true, provider: true, intelligenceHydrationCursor: true, historicalWindowFloorAt: true },
      }),
    );
    if (rows === null) return [];
    return rows.map((r) => ({
      organizationId: r.organizationId,
      userId: r.userId,
      provider: r.provider as ConnectionProvider,
      hydrationCursor: r.intelligenceHydrationCursor ?? null,
      // Non-null by the WHERE above; the fallback keeps the type honest without a non-null assertion.
      historicalWindowFloorAt: r.historicalWindowFloorAt ?? now,
    }));
  }

  /**
   * Record one HYDRATION run's outcome. Scoped to (org, user, provider) and skips an authorization revoked
   * in the meantime (revokedAt: null in the WHERE), so a revoke always wins. THIS METHOD NEVER TOUCHES
   * source_connections, source_baseline_checkpoints, the forward contentCursor OR the historical* columns --
   * it advances only the intelligenceHydration* columns. The schema id is written only on COMPLETE.
   * Returns true when exactly one authorization advanced.
   */
  async recordChatsHydrationProgress(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    progress: ChatsHydrationProgress,
  ): Promise<boolean> {
    const data: Record<string, unknown> = {
      intelligenceHydrationCursor: progress.cursor,
      intelligenceHydrationState: progress.state,
      intelligenceHydrationLastFailureClass: progress.failureClass ?? null,
      intelligenceHydrationBackoffUntil: progress.backoffUntil ?? null,
      intelligenceHydrationLastRunAt: progress.now,
    };
    if (progress.state === 'COMPLETE' && progress.schemaId) data.intelligenceHydrationSchemaId = progress.schemaId;
    if (progress.failedItemsDelta && progress.failedItemsDelta > 0) data.intelligenceHydrationFailedItems = { increment: progress.failedItemsDelta };
    const { count } = await this.prisma.sourceContentAuthorization.updateMany({
      where: { organizationId, userId, provider, revokedAt: null },
      data: data as never,
    });
    return count === 1;
  }
}

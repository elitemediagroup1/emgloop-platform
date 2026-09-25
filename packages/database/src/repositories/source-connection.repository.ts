// Background conversation source connections (Microsoft Teams, Telegram): persistence.
//
// The Teams/Telegram sibling of GoogleConnectionRepository, following the same discipline. It
// does NOT fork a second connection framework -- it reuses the sealing, the org-first scoping and
// the audit idiom already established for Google.
//
// ORGANIZATION FIRST, AND USER-PRIVATE. Every method takes (organizationId, userId) from the
// signed session and resolves the row inside that scope; a connection in another organization, or
// belonging to another person, is not found -- never forbidden. There is no org-only read path.
//
// THIS FILE NEVER SEES A SECRET IN THE CLEAR. It stores and returns sealed bytes only; the key
// that opens them belongs to the web/worker tier (services/connections/connection-secret-sealer.ts).
//
// STATE IS DERIVED, NEVER ASSERTED. The worker maps capability facts to a ConnectionState via
// deriveConnectionState and hands the result here; this file records it, it does not decide it.
//
// AUDIT ROWS RECORD IDS, THE PROVIDER AND A CLASS. Never a secret, an account handle, a message,
// or a provider's own text. Worker observation cycles are not audited -- only the acts a person or
// offboarding takes, the moments a credential is created or destroyed, and (since 2026-09-24) the
// retention sweep deleting a disconnected person's derived work past the grace window, counts only.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  CONNECTION_PROVIDERS,
  CONNECTION_STATES,
  SOURCE_CONNECTION_AUDIT_ACTIONS,
  WORK_DISCONNECT_GRACE_DAYS,
  WORK_RETENTION_POLICY_VERSION,
  connectionIsLive,
  isConnectionProvider,
  type CapabilityStatus,
  type ConnectionCredentialKind,
  type ConnectionProvider,
  type ConnectionState,
  type TeamsAdapter,
} from '@emgloop/shared';

import type { SealedConnectionSecret } from '../services/connections/connection-secret-sealer';
import { AuditRepository } from './audit.repository';
import { membershipAuthority } from './membership.repository';
import { IntelligenceDigestRepository, intelligenceDigestsPresent } from './intelligence/intelligence-digest.repository';
import { WorkWithdrawalRepository } from './work-state/work-withdrawal.repository';

type Tx = Prisma.TransactionClient;

/** The states `connectionIsLive` accepts, as a list the database can be asked about. Derived, never restated. */
const LIVE_CONNECTION_STATES: readonly ConnectionState[] = CONNECTION_STATES.filter(connectionIsLive);

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant before which a disconnect is past its grace window (§21.2: `WORK_DISCONNECT_GRACE_DAYS`). */
function disconnectGraceCutoff(now: Date): Date {
  return new Date(now.getTime() - WORK_DISCONNECT_GRACE_DAYS * DAY_MS);
}

export interface SourceConnectionActor {
  readonly userId: string | null;
  readonly name?: string | null;
}

/** A person's connection, as read WITHOUT any credential. */
export interface SourceConnectionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly provider: ConnectionProvider;
  readonly adapter: TeamsAdapter | null;
  readonly state: ConnectionState;
  readonly credentialKind: ConnectionCredentialKind | null;
  readonly accountLabel: string | null;
  readonly backgroundObservation: CapabilityStatus;
  readonly lastFailureClass: string | null;
  readonly connectingStartedAt: Date | null;
  readonly connectedAt: Date | null;
  readonly lastObservedAt: Date | null;
  readonly reconnectRequiredAt: Date | null;
  readonly disconnectedAt: Date | null;
  readonly hasCredential: boolean;
}

/** What the worker stores once a person has authenticated out of band. */
export interface SourceConnectionCredentialToStore {
  readonly credentialKind: ConnectionCredentialKind;
  readonly adapter: TeamsAdapter | null;
  readonly accountLabel: string | null;
  readonly backgroundObservation: CapabilityStatus;
  readonly sealed: SealedConnectionSecret;
  readonly cursor: string | null;
  readonly now: Date;
}

export type SourceConnectionStoreOutcome =
  | { readonly outcome: 'STORED'; readonly connectionId: string }
  | { readonly outcome: 'NOT_PERMITTED' | 'NO_ATTEMPT' };

/** One connection worth a cycle now: routing fields only, never a credential or content. */
export interface DueConnection {
  readonly organizationId: string;
  readonly userId: string;
  readonly provider: ConnectionProvider;
  readonly cursor: string | null;
}

/** One connection disconnected past its grace window: routing fields only, never a credential or content. */
export interface DueDerivedExpiry {
  readonly organizationId: string;
  readonly userId: string;
  readonly provider: ConnectionProvider;
}

export type DerivedExpiryOutcome =
  | { readonly outcome: 'EXPIRED'; readonly items: number; readonly observations: number; readonly digests: number }
  | { readonly outcome: 'NOTHING_TO_DO' };

function sealedOf(row: Record<string, any>): SealedConnectionSecret | null {
  if (!row.secretSealed || !row.sealVersion || !row.keyRef) return null;
  return { sealVersion: row.sealVersion, keyRef: row.keyRef, sealed: new Uint8Array(row.secretSealed) };
}

function toRecord(row: Record<string, any>): SourceConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    provider: row.provider,
    adapter: row.adapter ?? null,
    state: row.state,
    credentialKind: row.credentialKind ?? null,
    accountLabel: row.accountLabel ?? null,
    backgroundObservation: row.backgroundObservation ?? 'UNAVAILABLE',
    lastFailureClass: row.lastFailureClass ?? null,
    connectingStartedAt: row.connectingStartedAt ?? null,
    connectedAt: row.connectedAt ?? null,
    lastObservedAt: row.lastObservedAt ?? null,
    reconnectRequiredAt: row.reconnectRequiredAt ?? null,
    disconnectedAt: row.disconnectedAt ?? null,
    hasCredential: sealedOf(row) !== null,
  };
}

export async function writeAudit(
  prisma: PrismaClient,
  tx: Tx,
  args: { organizationId: string; connectionId: string; action: string; provider: ConnectionProvider; actor: SourceConnectionActor; metadata?: Record<string, unknown> },
): Promise<void> {
  await new AuditRepository(prisma).record(
    {
      organizationId: args.organizationId,
      userId: args.actor.userId,
      actorType: args.actor.userId ? 'HUMAN_AGENT' : 'SYSTEM',
      actorName: args.actor.name ?? (args.actor.userId ? undefined : 'System'),
      action: args.action,
      entityType: 'source_connection',
      entityId: args.connectionId,
      metadata: { provider: args.provider, ...(args.metadata ?? {}) },
    },
    tx,
  );
}

/**
 * End a person's source connections INSIDE the caller's transaction: clear every sealed
 * credential and mark the row DISCONNECTED, with an audit row per provider. Used by
 * `IamRepository.disableMember` / `removeMember` (since 2026-09-24; it existed unused before
 * that, and a departed member's Telegram session stayed live for the worker's discovery), so
 * disabling or removing a member ends their Teams/Telegram connections in the same transaction
 * as the membership change -- the credential does not outlive the membership.
 *
 * A row is ended when it holds a credential OR is in a live state (a CONNECTING attempt with no
 * credential yet is ended too, so it cannot read as in progress for someone who is gone). Nothing
 * here reaches the provider: the Telegram-side session is NOT logged out by this path, and the
 * record says so plainly (§21.2).
 *
 * (The membership relation also cascades on delete; this exists so a DISABLE, which keeps the
 * membership row, still tears the credential down and leaves a trail.)
 */
export async function disconnectSourceConnectionsInTx(
  prisma: PrismaClient,
  tx: Tx,
  organizationId: string,
  userId: string,
  request: { readonly actor: SourceConnectionActor; readonly now: Date },
): Promise<number> {
  const live = await tx.sourceConnection.findMany({
    where: { organizationId, userId, OR: [{ secretSealed: { not: null } }, { state: { in: [...LIVE_CONNECTION_STATES] } }] },
  });
  for (const row of live) {
    const hadCredential = sealedOf(row) !== null;
    await tx.sourceConnection.update({
      where: { id: row.id },
      data: {
        state: 'DISCONNECTED',
        secretSealed: null,
        sealVersion: null,
        keyRef: null,
        cursor: null,
        backgroundObservation: 'UNAVAILABLE',
        disconnectedAt: request.now,
        disconnectedByUserId: request.actor.userId,
        lastFailureClass: null,
      },
    });
    await writeAudit(prisma, tx, {
      organizationId,
      connectionId: row.id,
      action: SOURCE_CONNECTION_AUDIT_ACTIONS.offboarded,
      provider: row.provider as ConnectionProvider,
      actor: request.actor,
      metadata: { subjectUserId: userId, credentialDeleted: hadCredential },
    });
  }
  return live.length;
}

export class SourceConnectionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** This person's connection for one provider in this organization, without any credential. */
  async find(organizationId: string, userId: string, provider: ConnectionProvider): Promise<SourceConnectionRecord | null> {
    const row = await this.prisma.sourceConnection.findFirst({ where: { organizationId, userId, provider } });
    return row ? toRecord(row) : null;
  }

  /** This person's connections across every provider, in a stable order, without credentials. */
  async findAll(organizationId: string, userId: string): Promise<SourceConnectionRecord[]> {
    const rows = await this.prisma.sourceConnection.findMany({ where: { organizationId, userId }, orderBy: { provider: 'asc' } });
    return rows.map(toRecord);
  }

  /**
   * Open a connect attempt: move this person's connection for the provider to CONNECTING and stamp
   * when it started, so a surface reflects an authentication in progress and the worker knows to
   * pick it up. Creates the row on first connect. Refused, writing nothing, if the person's
   * membership is not active. Never carries a credential.
   */
  async beginConnect(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    request: { readonly actor: SourceConnectionActor; readonly now: Date },
  ): Promise<{ readonly outcome: 'STARTED' | 'NOT_PERMITTED'; readonly connectionId?: string }> {
    return this.prisma.$transaction(async (tx) => {
      const standing = await membershipAuthority(tx, organizationId, userId, request.now);
      if (!standing.granted) return { outcome: 'NOT_PERMITTED' as const };
      const current = await tx.sourceConnection.findFirst({ where: { organizationId, userId, provider } });
      const data = { state: 'CONNECTING', connectingStartedAt: request.now, lastFailureClass: null, disconnectedAt: null, disconnectedByUserId: null };
      const row = current
        ? await tx.sourceConnection.update({ where: { id: current.id }, data })
        : await tx.sourceConnection.create({ data: { organizationId, userId, provider, ...data } });
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId: row.id,
        action: SOURCE_CONNECTION_AUDIT_ACTIONS.started,
        provider,
        actor: request.actor,
        metadata: { subjectUserId: userId },
      });
      return { outcome: 'STARTED' as const, connectionId: row.id };
    });
  }

  /**
   * Store a credential the person authenticated out of band, moving the connection live. Only a
   * connection that has an OPEN attempt (a CONNECTING/SETTING_UP row) is filled -- a credential is
   * never grafted onto a connection nobody asked to open. Refused if the membership is not active.
   */
  async storeCredential(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    grant: SourceConnectionCredentialToStore,
    actor: SourceConnectionActor,
  ): Promise<SourceConnectionStoreOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const standing = await membershipAuthority(tx, organizationId, userId, grant.now);
      if (!standing.granted) return { outcome: 'NOT_PERMITTED' };
      const current = await tx.sourceConnection.findFirst({ where: { organizationId, userId, provider } });
      if (!current || (current.state !== 'CONNECTING' && current.state !== 'SETTING_UP')) return { outcome: 'NO_ATTEMPT' };
      const state = deriveStoredState(grant.backgroundObservation);
      const row = await tx.sourceConnection.update({
        where: { id: current.id },
        data: {
          adapter: grant.adapter,
          state,
          credentialKind: grant.credentialKind,
          secretSealed: Buffer.from(grant.sealed.sealed),
          sealVersion: grant.sealed.sealVersion,
          keyRef: grant.sealed.keyRef,
          accountLabel: grant.accountLabel,
          backgroundObservation: grant.backgroundObservation,
          cursor: grant.cursor,
          connectedAt: grant.now,
          lastFailureClass: null,
          reconnectRequiredAt: null,
          disconnectedAt: null,
          disconnectedByUserId: null,
        },
      });
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId: row.id,
        action: SOURCE_CONNECTION_AUDIT_ACTIONS.connected,
        provider,
        actor,
        metadata: { subjectUserId: userId, adapter: grant.adapter ?? undefined, backgroundObservation: grant.backgroundObservation },
      });
      return { outcome: 'STORED', connectionId: row.id };
    });
  }

  /** The sealed credential of this person's provider connection, for the worker. Null when none is held. */
  async credential(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
  ): Promise<{ record: SourceConnectionRecord; sealed: SealedConnectionSecret } | null> {
    const row = await this.prisma.sourceConnection.findFirst({ where: { organizationId, userId, provider } });
    const sealed = row ? sealedOf(row) : null;
    return row && sealed ? { record: toRecord(row), sealed } : null;
  }

  /**
   * Record the outcome of one worker observation cycle: the truthful state the worker derived, the
   * background-capability status, the resume cursor and the last-observed time. NOT audited -- this
   * is expected, high-frequency churn. Only a connection that still holds a credential is touched,
   * so a cycle can never resurrect a disconnected one.
   */
  async recordCycle(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    cycle: {
      readonly state: ConnectionState;
      readonly backgroundObservation: CapabilityStatus;
      readonly cursor: string | null;
      readonly failureClass?: string | null;
      readonly now: Date;
    },
  ): Promise<boolean> {
    const { count } = await this.prisma.sourceConnection.updateMany({
      where: { organizationId, userId, provider, secretSealed: { not: null } },
      data: {
        state: cycle.state,
        backgroundObservation: cycle.backgroundObservation,
        cursor: cycle.cursor,
        lastObservedAt: cycle.now,
        lastFailureClass: cycle.failureClass ?? null,
        reconnectRequiredAt: cycle.state === 'RECONNECT_REQUIRED' ? cycle.now : null,
      },
    });
    return count === 1;
  }

  /**
   * PLATFORM-WORKER DISCOVERY, ACROSS ALL TENANTS. The durable worker is ONE process serving every
   * organization, so this returns the connections worth a cycle now regardless of org -- like the
   * brain sweeper, not like a tenant-scoped read, and it is the one method here that is not
   * org-scoped by argument, on purpose. It answers only "who is worth attempting": routing fields
   * (org, user, provider, cursor), never a credential and never content. Every action the worker
   * then takes -- opening the credential, recording the cycle -- is (org, user, provider)-scoped and
   * re-resolves the row, so a connection returned here in error is refused there.
   *
   * DUE = holds a credential AND is in a cyclable state (READY, CONNECTED_LIMITED, SETTING_UP,
   * FAILED). RECONNECT_REQUIRED and DISCONNECTED are excluded: the credential is stale or gone, and
   * re-attempting it every cycle would spend the provider's quota to re-learn what Loop recorded.
   * Stalest-observed first, so a sweep that runs out of time always makes progress rather than
   * re-attempting the same head of the queue.
   */
  async dueForObservation(limit = 500): Promise<DueConnection[]> {
    const rows = await this.prisma.sourceConnection.findMany({
      where: { secretSealed: { not: null }, state: { in: ['READY', 'CONNECTED_LIMITED', 'SETTING_UP', 'FAILED'] } },
      orderBy: [{ lastObservedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: Math.max(1, Math.min(limit, 2000)),
      select: { organizationId: true, userId: true, provider: true, cursor: true },
    });
    return rows.map((r) => ({ organizationId: r.organizationId, userId: r.userId, provider: r.provider as ConnectionProvider, cursor: r.cursor ?? null }));
  }

  /**
   * PLATFORM-WORKER DISCOVERY, ACROSS ALL TENANTS. Mirrors dueForObservation exactly: the durable
   * worker is ONE process serving every organization, so this returns the connections whose derived
   * work has outlived the disconnect grace window regardless of org -- routing fields only (org, user,
   * provider), never a credential and never content. The delete itself is per principal, re-resolves
   * the row in scope, and refuses a connection that is live again (`expireDerivedWork`).
   *
   * PAST GRACE = not in a live state AND `disconnectedAt` older than `WORK_DISCONNECT_GRACE_DAYS`
   * before `now` (§21.2: "voluntary disconnect: frozen, deleted at 30 days"). `disconnectedAt` is the
   * only honest anchor: it is stamped by a disconnect or an offboarding and cleared by a reconnect. A
   * row with no `disconnectedAt` -- FAILED, NOT_CONNECTED, or RECONNECT_REQUIRED (which is live and
   * still holds its credential) -- was never disconnected, so nothing here counts a window for it.
   */
  async dueForDerivedExpiry(now: Date, limit = 500): Promise<DueDerivedExpiry[]> {
    const rows = await this.prisma.sourceConnection.findMany({
      where: { state: { notIn: [...LIVE_CONNECTION_STATES] }, disconnectedAt: { lt: disconnectGraceCutoff(now) } },
      orderBy: [{ disconnectedAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, Math.min(limit, 2000)),
      select: { organizationId: true, userId: true, provider: true },
    });
    return rows.map((r) => ({ organizationId: r.organizationId, userId: r.userId, provider: r.provider as ConnectionProvider }));
  }

  /**
   * Delete this person's derived (MODEL-produced) items for a provider whose connection has been
   * disconnected past the grace window -- the §21.2 "deleted at 30 days" row -- together with their
   * domain-intelligence digests drawn from that provider (Loop Intelligence PR A, 2026-09-24), and
   * record the act with counts only. The row is re-resolved in scope inside the transaction: a connection that is
   * live again, or whose disconnect is still inside the window, is NOTHING_TO_DO (that is what makes
   * a reconnect inside the month restore the frozen queue). No audit row when nothing was deleted.
   * The grace window is applied HERE from the shared constant, so no caller can shorten it.
   */
  async expireDerivedWork(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    request: { readonly now: Date },
  ): Promise<DerivedExpiryOutcome> {
    const digestsPresent = await intelligenceDigestsPresent(this.prisma, { organizationId, userId });
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.sourceConnection.findFirst({ where: { organizationId, userId, provider } });
      if (!current || connectionIsLive(current.state as ConnectionState)) return { outcome: 'NOTHING_TO_DO' as const };
      if (!current.disconnectedAt || current.disconnectedAt >= disconnectGraceCutoff(request.now)) return { outcome: 'NOTHING_TO_DO' as const };
      const deleted = await new WorkWithdrawalRepository(tx).deleteDerived({ organizationId, userId }, { provider });
      const digests = digestsPresent ? await new IntelligenceDigestRepository(tx).deleteForPrincipal({ organizationId, userId }, { provider }) : { deleted: 0 };
      if (deleted.items === 0 && digests.deleted === 0) return { outcome: 'NOTHING_TO_DO' as const };
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId: current.id,
        action: SOURCE_CONNECTION_AUDIT_ACTIONS.derived_expired,
        provider,
        actor: { userId: null, name: 'System' },
        metadata: {
          subjectUserId: userId,
          deleted: { items: deleted.items, observations: deleted.observations },
          digestsDeleted: digests.deleted,
          graceDays: WORK_DISCONNECT_GRACE_DAYS,
          retentionPolicy: WORK_RETENTION_POLICY_VERSION,
        },
      });
      return { outcome: 'EXPIRED' as const, items: deleted.items, observations: deleted.observations, digests: digests.deleted };
    });
  }

  /**
   * Disconnect this person's provider connection at their request: delete the sealed credential,
   * mark it DISCONNECTED and record who and when. Returns NOTHING_TO_DO when there was no live
   * connection -- and no audit row is written for a disconnect that did not happen.
   *
   * The derived items are NOT touched here: a voluntary disconnect freezes the queue, and the
   * worker's retention sweep deletes the derived items once the disconnect is `WORK_DISCONNECT_GRACE_DAYS`
   * old (`dueForDerivedExpiry` / `expireDerivedWork`, §21.2). Reconnecting inside the window clears
   * `disconnectedAt` and the queue is simply still there.
   */
  async disconnect(
    organizationId: string,
    userId: string,
    provider: ConnectionProvider,
    request: { readonly actor: SourceConnectionActor; readonly now: Date },
  ): Promise<'DISCONNECTED' | 'NOTHING_TO_DO'> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.sourceConnection.findFirst({ where: { organizationId, userId, provider } });
      if (!current || !connectionIsLive(current.state as ConnectionState)) return 'NOTHING_TO_DO';
      const hadCredential = sealedOf(current) !== null;
      await tx.sourceConnection.update({
        where: { id: current.id },
        data: {
          state: 'DISCONNECTED',
          secretSealed: null,
          sealVersion: null,
          keyRef: null,
          cursor: null,
          backgroundObservation: 'UNAVAILABLE',
          disconnectedAt: request.now,
          disconnectedByUserId: request.actor.userId,
          lastFailureClass: null,
        },
      });
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId: current.id,
        action: SOURCE_CONNECTION_AUDIT_ACTIONS.disconnected,
        provider,
        actor: request.actor,
        metadata: { subjectUserId: userId, credentialDeleted: hadCredential },
      });
      return 'DISCONNECTED';
    });
  }
}

/**
 * The state a freshly stored credential reads. Authentication alone is never READY: the claimed
 * background capability must be operational. A gated or unavailable capability leaves the
 * connection CONNECTED_LIMITED, stated honestly.
 */
function deriveStoredState(backgroundObservation: CapabilityStatus): ConnectionState {
  return backgroundObservation === 'OPERATIONAL' ? 'READY' : 'CONNECTED_LIMITED';
}

/** The providers this repository knows, for a surface that lists every tile. */
export function knownConnectionProviders(): readonly ConnectionProvider[] {
  return CONNECTION_PROVIDERS.filter(isConnectionProvider);
}

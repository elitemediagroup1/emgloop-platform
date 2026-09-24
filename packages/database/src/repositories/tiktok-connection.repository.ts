// TikTok Login Kit connections: persistence. The TikTok sibling of google-connection.repository.ts.
//
// ORGANIZATION FIRST. Every method that reads or writes a person's connection or connect
// attempt takes (organizationId, userId) from the signed session and resolves the row inside
// that scope. A connection in another organization is not found, never forbidden. The one
// deliberate exception is `liveGrantElsewhere`, documented where it is defined.
//
// THIS FILE NEVER SEES A TOKEN IN THE CLEAR. It stores and returns sealed bytes only; the key
// that opens them belongs to the web tier (services/tiktok/tiktok-token-sealer.ts).
//
// REVOKE MEANS DELETE. Revoking removes both sealed tokens, the live link and every open
// connect attempt in one transaction, with its audit row; the TikTok call happens after
// commit, by the caller that holds the key. The revoked row keeps its lifecycle columns, so
// the trail survives and the credential does not.
//
// AUDIT ROWS RECORD IDS, SCOPES AND REASONS. Never a username, a token or TikTok's text.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  TIKTOK_CONNECTION_AUDIT_ACTIONS,
  TIKTOK_SCOPES,
  isTikTokScope,
  type TikTokConnectionFailureClass,
  type TikTokConnectionStatus,
  type TikTokRevocationReason,
  type TikTokScope,
} from '@emgloop/shared';

import type { SealedTikTokToken } from '../services/tiktok/tiktok-token-sealer';
import { AuditRepository } from './audit.repository';
import { membershipAuthority } from './membership.repository';
import { isSerializationFailure } from './transaction-conflict';

type Tx = Prisma.TransactionClient;

/** A connect attempt is honoured for ten minutes. */
export const TIKTOK_OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;
/** Open attempts one person may hold at once; more is refused, not queued. */
export const TIKTOK_OAUTH_MAX_OPEN_STATES = 10;
/** How many times storing a grant that lost a serialization race is re-attempted. */
const STORE_ATTEMPTS = 3;

export interface TikTokActor {
  readonly userId: string | null;
  readonly name?: string | null;
}

export interface TikTokConnectionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly tiktokOpenId: string;
  readonly handleAtLink: string | null;
  readonly status: TikTokConnectionStatus;
  readonly grantedScopes: readonly TikTokScope[];
  readonly requestedScopes: readonly TikTokScope[];
  readonly accessTokenExpiresAt: Date | null;
  readonly connectedAt: Date;
  readonly lastUsedAt: Date | null;
  readonly lastReadAt: Date | null;
  readonly expiredAt: Date | null;
  readonly lastFailureClass: string | null;
  readonly revokedAt: Date | null;
  readonly revocationReason: string | null;
  readonly revocationConfirmedAt: Date | null;
}

/** Both sealed tokens of a CONNECTED row, with the access token's expiry. */
export interface TikTokSealedCredential {
  readonly refresh: SealedTikTokToken;
  readonly access: SealedTikTokToken;
  readonly accessExpiresAt: Date;
}

export interface TikTokGrantToStore {
  readonly tiktokOpenId: string;
  readonly handleAtLink: string | null;
  /** The scopes TikTok granted. */
  readonly grantedScopes: readonly TikTokScope[];
  /** The scopes this attempt asked for. */
  readonly requestedScopes: readonly TikTokScope[];
  readonly credential: TikTokSealedCredential;
  readonly now: Date;
}

export type TikTokStoreOutcome =
  | { readonly outcome: 'STORED'; readonly connectionId: string }
  | { readonly outcome: 'DIFFERENT_ACCOUNT' | 'ACCOUNT_IN_USE' | 'NOT_PERMITTED' };

/** What a revocation took out of the database, for the caller to finish at TikTok after commit. */
export interface TikTokRevocation {
  readonly connectionId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly tiktokOpenId: string;
  /** Null when the connection had already expired: no credential was left to delete. */
  readonly credential: TikTokSealedCredential | null;
}

const LIVE: TikTokConnectionStatus[] = ['CONNECTED', 'EXPIRED'];

function scopes(raw: unknown): TikTokScope[] {
  const held = Array.isArray(raw) ? raw.filter(isTikTokScope) : [];
  return TIKTOK_SCOPES.filter((s) => held.includes(s));
}

function record(row: Record<string, any>): TikTokConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    tiktokOpenId: row.tiktokOpenId,
    handleAtLink: row.handleAtLink ?? null,
    status: row.status,
    grantedScopes: scopes(row.grantedScopes),
    requestedScopes: scopes(row.requestedScopes),
    accessTokenExpiresAt: row.accessTokenExpiresAt ?? null,
    connectedAt: row.connectedAt,
    lastUsedAt: row.lastUsedAt ?? null,
    lastReadAt: row.lastReadAt ?? null,
    expiredAt: row.expiredAt ?? null,
    lastFailureClass: row.lastFailureClass ?? null,
    revokedAt: row.revokedAt ?? null,
    revocationReason: row.revocationReason ?? null,
    revocationConfirmedAt: row.revocationConfirmedAt ?? null,
  };
}

function credentialOf(row: Record<string, any>): TikTokSealedCredential | null {
  if (!row.refreshTokenSealed || !row.accessTokenSealed || !row.accessTokenExpiresAt || !row.sealVersion || !row.keyRef) return null;
  return {
    refresh: { sealVersion: row.sealVersion, keyRef: row.keyRef, sealed: new Uint8Array(row.refreshTokenSealed) },
    access: { sealVersion: row.sealVersion, keyRef: row.keyRef, sealed: new Uint8Array(row.accessTokenSealed) },
    accessExpiresAt: row.accessTokenExpiresAt,
  };
}

function credentialColumns(credential: TikTokSealedCredential) {
  return {
    refreshTokenSealed: Buffer.from(credential.refresh.sealed),
    accessTokenSealed: Buffer.from(credential.access.sealed),
    accessTokenExpiresAt: credential.accessExpiresAt,
    sealVersion: credential.refresh.sealVersion,
    keyRef: credential.refresh.keyRef,
  };
}

const NO_CREDENTIAL = { refreshTokenSealed: null, accessTokenSealed: null, accessTokenExpiresAt: null, sealVersion: null, keyRef: null };

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function union(a: readonly TikTokScope[], b: readonly TikTokScope[]): TikTokScope[] {
  return TIKTOK_SCOPES.filter((s) => a.includes(s) || b.includes(s));
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

async function writeAudit(
  prisma: PrismaClient,
  tx: Tx,
  args: { organizationId: string; connectionId: string; action: string; actor: TikTokActor; metadata: Record<string, unknown> },
): Promise<void> {
  await new AuditRepository(prisma).record(
    {
      organizationId: args.organizationId,
      userId: args.actor.userId,
      actorType: args.actor.userId ? 'HUMAN_AGENT' : 'SYSTEM',
      actorName: args.actor.name ?? (args.actor.userId ? undefined : 'System'),
      action: args.action,
      entityType: 'tiktok_connection',
      entityId: args.connectionId,
      metadata: args.metadata,
    },
    tx,
  );
}

/**
 * Revoke a person's live connection INSIDE the caller's transaction: delete both sealed
 * tokens and the live link, drop every connect attempt, and write the audit row. Returns what
 * was taken out, so the caller can ask TikTok to revoke it after commit; null when nothing
 * was live.
 */
export async function revokeTikTokConnectionInTx(
  prisma: PrismaClient,
  tx: Tx,
  organizationId: string,
  userId: string,
  request: { readonly reason: TikTokRevocationReason; readonly actor: TikTokActor; readonly now: Date },
): Promise<TikTokRevocation | null> {
  await tx.tikTokOAuthState.deleteMany({ where: { organizationId, userId } });
  const current = await tx.tikTokConnection.findFirst({ where: { organizationId, userId, status: { in: LIVE } } });
  if (!current) return null;
  const credential = credentialOf(current);
  await tx.tikTokConnection.update({
    where: { id: current.id },
    data: {
      status: 'REVOKED',
      activeTiktokOpenId: null,
      ...NO_CREDENTIAL,
      expiredAt: null,
      revokedAt: request.now,
      revokedByUserId: request.actor.userId,
      revocationReason: request.reason,
      revocationConfirmedAt: null,
      lastFailureClass: null,
    },
  });
  await writeAudit(prisma, tx, {
    organizationId,
    connectionId: current.id,
    action: TIKTOK_CONNECTION_AUDIT_ACTIONS.revoked,
    actor: request.actor,
    metadata: {
      subjectUserId: userId,
      reason: request.reason,
      previousStatus: current.status,
      scopes: scopes(current.grantedScopes),
      credentialDeleted: credential !== null,
    },
  });
  return { connectionId: current.id, organizationId, userId, tiktokOpenId: current.tiktokOpenId, credential };
}

export class TikTokConnectionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // -- Connect attempts ----------------------------------------------------------------

  /**
   * Record a connect attempt. Consumed and expired attempts of this person are cleared
   * first; if they still hold the maximum number of open ones, the attempt is refused.
   */
  async openState(
    organizationId: string,
    userId: string,
    attempt: { readonly sessionId: string; readonly stateHash: string; readonly now: Date },
  ): Promise<'OPENED' | 'TOO_MANY_ATTEMPTS'> {
    return this.prisma.$transaction(async (tx) => {
      await tx.tikTokOAuthState.deleteMany({
        where: { organizationId, userId, OR: [{ consumedAt: { not: null } }, { expiresAt: { lte: attempt.now } }] },
      });
      const open = await tx.tikTokOAuthState.count({ where: { organizationId, userId } });
      if (open >= TIKTOK_OAUTH_MAX_OPEN_STATES) return 'TOO_MANY_ATTEMPTS';
      await tx.tikTokOAuthState.create({
        data: {
          organizationId,
          userId,
          sessionId: attempt.sessionId,
          stateHash: attempt.stateHash,
          expiresAt: new Date(attempt.now.getTime() + TIKTOK_OAUTH_STATE_LIFETIME_MS),
          createdAt: attempt.now,
        },
      });
      return 'OPENED' as const;
    });
  }

  /**
   * Consume an attempt exactly once: same organization, same person, SAME SESSION, not
   * expired, not already used. Anything else is false -- and which of those failed is not
   * reported.
   */
  async consumeState(organizationId: string, userId: string, sessionId: string, stateHash: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.tikTokOAuthState.updateMany({
      where: { organizationId, userId, sessionId, stateHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    return count === 1;
  }

  // -- Connections -----------------------------------------------------------------------

  /** This person's connection in this organization, without any credential. */
  async find(organizationId: string, userId: string): Promise<TikTokConnectionRecord | null> {
    const row = await this.prisma.tikTokConnection.findFirst({ where: { organizationId, userId } });
    return row ? record(row) : null;
  }

  /** The sealed credential of this person's CONNECTED connection, or null. */
  async credential(organizationId: string, userId: string): Promise<{ record: TikTokConnectionRecord; credential: TikTokSealedCredential } | null> {
    const row = await this.prisma.tikTokConnection.findFirst({ where: { organizationId, userId, status: 'CONNECTED' } });
    const credential = row ? credentialOf(row) : null;
    return row && credential ? { record: record(row), credential } : null;
  }

  /**
   * Store what TikTok granted, replacing the previous grant of the SAME TikTok account.
   *
   * Refused, storing nothing, when this person's live connection is a different TikTok
   * account (disconnect first), when another person in this organization holds a live link
   * to this TikTok account, or when the person no longer holds an active membership.
   *
   * SERIALIZABLE, AND RE-CHECKED INSIDE. The membership is read in the same transaction, so
   * a member disabled while their callback was in flight either conflicts (and the retry sees
   * the disable) or commits first -- a revoked member is never re-connected.
   */
  async storeGrant(organizationId: string, userId: string, grant: TikTokGrantToStore, actor: TikTokActor): Promise<TikTokStoreOutcome> {
    const write = async (tx: Tx): Promise<TikTokStoreOutcome> => {
      const standing = await membershipAuthority(tx, organizationId, userId, grant.now);
      if (!standing.granted) return { outcome: 'NOT_PERMITTED' };
      const current = await tx.tikTokConnection.findFirst({ where: { organizationId, userId } });
      const live = current !== null && LIVE.includes(current.status as TikTokConnectionStatus);
      if (current && live && current.tiktokOpenId !== grant.tiktokOpenId) return { outcome: 'DIFFERENT_ACCOUNT' };
      const holder = await tx.tikTokConnection.findFirst({
        where: { organizationId, activeTiktokOpenId: grant.tiktokOpenId, NOT: { userId } },
        select: { id: true },
      });
      if (holder) return { outcome: 'ACCOUNT_IN_USE' };

      const requestedScopes = current && live ? union(scopes(current.requestedScopes), grant.requestedScopes) : [...grant.requestedScopes];
      const data = {
        tiktokOpenId: grant.tiktokOpenId,
        activeTiktokOpenId: grant.tiktokOpenId,
        handleAtLink: grant.handleAtLink,
        status: 'CONNECTED',
        grantedScopes: [...grant.grantedScopes],
        requestedScopes,
        ...credentialColumns(grant.credential),
        connectedAt: grant.now,
        expiredAt: null,
        lastFailureClass: null,
        revokedAt: null,
        revokedByUserId: null,
        revocationReason: null,
        revocationConfirmedAt: null,
      };
      const row = current
        ? await tx.tikTokConnection.update({ where: { id: current.id }, data })
        : await tx.tikTokConnection.create({ data: { organizationId, userId, ...data } });

      const action = !current
        ? TIKTOK_CONNECTION_AUDIT_ACTIONS.granted
        : current.status !== 'CONNECTED'
          ? TIKTOK_CONNECTION_AUDIT_ACTIONS.reconnected
          : sameSet(scopes(current.grantedScopes), grant.grantedScopes)
            ? null
            : TIKTOK_CONNECTION_AUDIT_ACTIONS.scopeChanged;
      if (action) {
        await writeAudit(this.prisma, tx, {
          organizationId,
          connectionId: row.id,
          action,
          actor,
          metadata: {
            subjectUserId: userId,
            scopes: [...grant.grantedScopes],
            previousScopes: current ? scopes(current.grantedScopes) : [],
            requestedScopes,
          },
        });
      }
      return { outcome: 'STORED', connectionId: row.id };
    };
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(write, { isolationLevel: 'Serializable' });
      } catch (err) {
        // A concurrent attempt linked the same account first: the unique key decided.
        if (isUniqueViolation(err)) return { outcome: 'ACCOUNT_IN_USE' };
        // A concurrent write conflicted: re-read and decide again.
        if (isSerializationFailure(err) && attempt < STORE_ATTEMPTS) continue;
        throw err;
      }
    }
  }

  /**
   * A refresh succeeded: store the ROTATED refresh token and the new access token, and note
   * the use. When TikTok now reports different scopes (the person withdrew one at TikTok), the
   * stored set follows and the change is audited.
   */
  async recordRefresh(
    organizationId: string,
    userId: string,
    connectionId: string,
    refreshed: { readonly credential: TikTokSealedCredential; readonly grantedScopes: readonly TikTokScope[] | null },
    now: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.tikTokConnection.findFirst({ where: { id: connectionId, organizationId, userId, status: 'CONNECTED' } });
      if (!current) return false;
      const next = refreshed.grantedScopes;
      const changed = next !== null && !sameSet(scopes(current.grantedScopes), next);
      await tx.tikTokConnection.update({
        where: { id: current.id },
        data: { ...credentialColumns(refreshed.credential), lastUsedAt: now, ...(changed && next ? { grantedScopes: [...next] } : {}) },
      });
      if (changed && next) {
        await writeAudit(this.prisma, tx, {
          organizationId,
          connectionId,
          action: TIKTOK_CONNECTION_AUDIT_ACTIONS.scopeChanged,
          actor: { userId: null },
          metadata: { subjectUserId: userId, scopes: [...next], previousScopes: scopes(current.grantedScopes), observedAt: 'refresh' },
        });
      }
      return true;
    });
  }

  /**
   * A completed read of the account's facts. Only this person's CONNECTED connection is
   * touched. The username TikTok reported (when `user.info.profile` is granted) becomes the
   * display handle; an absent one leaves the last known handle in place.
   */
  async recordRead(organizationId: string, userId: string, connectionId: string, now: Date, handle?: string | null): Promise<boolean> {
    const { count } = await this.prisma.tikTokConnection.updateMany({
      where: { id: connectionId, organizationId, userId, status: 'CONNECTED' },
      data: { lastReadAt: now, lastUsedAt: now, lastFailureClass: null, ...(handle ? { handleAtLink: handle } : {}) },
    });
    return count === 1;
  }

  /** A read that did not complete. The class is recorded; the grant is untouched. */
  async recordReadFailure(
    organizationId: string,
    userId: string,
    connectionId: string,
    failureClass: Extract<TikTokConnectionFailureClass, 'READ_UNAVAILABLE' | 'READ_FORBIDDEN'>,
    now: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.tikTokConnection.updateMany({
      where: { id: connectionId, organizationId, userId, status: 'CONNECTED' },
      data: { lastUsedAt: now, lastFailureClass: failureClass },
    });
    return count === 1;
  }

  /**
   * TikTok refused the stored grant (or it can no longer be opened): stop using it. Both
   * tokens are deleted -- they are known to be dead -- and the connection reads EXPIRED until
   * the creator reconnects.
   */
  async markExpired(
    organizationId: string,
    userId: string,
    connectionId: string,
    failureClass: Extract<TikTokConnectionFailureClass, 'REFRESH_REFUSED' | 'TOKEN_UNOPENABLE'>,
    now: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.tikTokConnection.updateMany({
        where: { id: connectionId, organizationId, userId, status: 'CONNECTED' },
        data: { status: 'EXPIRED', expiredAt: now, ...NO_CREDENTIAL, lastFailureClass: failureClass },
      });
      if (count !== 1) return false;
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId,
        action: TIKTOK_CONNECTION_AUDIT_ACTIONS.expired,
        actor: { userId: null },
        metadata: { subjectUserId: userId, failureClass },
      });
      return true;
    });
  }

  /** Revoke this person's live connection (see `revokeTikTokConnectionInTx`). */
  async revoke(
    organizationId: string,
    userId: string,
    request: { readonly reason: TikTokRevocationReason; readonly actor: TikTokActor; readonly now: Date },
  ): Promise<TikTokRevocation | null> {
    return this.prisma.$transaction((tx) => revokeTikTokConnectionInTx(this.prisma, tx, organizationId, userId, request));
  }

  /** What TikTok said when asked to revoke. Only a REVOKED connection of this organization is touched. */
  async recordRevocationResult(
    organizationId: string,
    connectionId: string,
    result:
      | { readonly confirmed: true }
      | { readonly confirmed: false; readonly failureClass: Extract<TikTokConnectionFailureClass, 'REVOKE_UNCONFIRMED' | 'REVOKE_SKIPPED_SHARED_GRANT' | 'TOKEN_UNOPENABLE'> },
    now: Date,
    actor: TikTokActor,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.tikTokConnection.updateMany({
        where: { id: connectionId, organizationId, status: 'REVOKED' },
        data: result.confirmed ? { revocationConfirmedAt: now, lastFailureClass: null } : { revocationConfirmedAt: null, lastFailureClass: result.failureClass },
      });
      if (count !== 1 || result.confirmed) return;
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId,
        action: TIKTOK_CONNECTION_AUDIT_ACTIONS.revokeUnconfirmed,
        actor,
        metadata: { failureClass: result.failureClass },
      });
    });
  }

  /**
   * THE ONE CROSS-ORGANIZATION READ, AND WHY.
   *
   * Loop is one TikTok app. Revoking a token at TikTok ends that TikTok account's grant to
   * Loop, which would also end a live connection the same account holds in ANOTHER
   * organization -- one tenant's disconnect breaking another's. Before asking TikTok to
   * revoke, the caller asks only whether such a connection exists. The answer is a boolean
   * about the TikTok account the caller already holds; no row, id or organization is returned.
   */
  async liveGrantElsewhere(tiktokOpenId: string, exceptConnectionId: string): Promise<boolean> {
    const other = await this.prisma.tikTokConnection.findFirst({
      where: { activeTiktokOpenId: tiktokOpenId, NOT: { id: exceptConnectionId } },
      select: { id: true },
    });
    return other !== null;
  }
}

// Google Workspace connections: persistence. Private V1.
//
// Architecture: docs/architecture/google-workspace-connection.md §11.4 -- §11.6.
//
// ORGANIZATION FIRST. Every method that reads or writes a person's connection or connect
// attempt takes (organizationId, userId) from the signed session and resolves the row
// inside that scope. A connection in another organization is not found, never forbidden.
// The one deliberate exception is `liveGrantElsewhere`, documented where it is defined.
//
// THIS FILE NEVER SEES A TOKEN IN THE CLEAR. It stores and returns sealed bytes only; the
// key that opens them belongs to the web tier (services/google/google-token-sealer.ts).
//
// REVOKE MEANS DELETE. Revoking removes the sealed token, the live link and every open
// connect attempt in one transaction, with its audit row; the Google call happens after
// commit, by the caller that holds the key. The revoked row keeps its lifecycle columns,
// so the trail survives and the credential does not.
//
// AUDIT ROWS RECORD IDS, CAPABILITIES AND REASONS. Never an email address, a token, a
// subject line, a file name or Google's text.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  GOOGLE_CONNECTION_AUDIT_ACTIONS,
  GOOGLE_WORKSPACE_CAPABILITIES,
  googleCapabilitiesOf,
  type GoogleConnectReturnTarget,
  type GoogleConnectionFailureClass,
  type GoogleConnectionStatus,
  type GoogleRevocationReason,
  type GoogleWorkspaceCapability,
  isGoogleConnectReturnTarget,
  isGoogleWorkspaceCapability,
} from '@emgloop/shared';

import type { SealedGoogleToken } from '../services/google/google-token-sealer';
import { AuditRepository } from './audit.repository';
import { membershipAuthority } from './membership.repository';
import { isSerializationFailure } from './transaction-conflict';

type Tx = Prisma.TransactionClient;

/** A connect attempt is honoured for ten minutes. */
export const GOOGLE_OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;
/** Open attempts one person may hold at once; more is refused, not queued. */
export const GOOGLE_OAUTH_MAX_OPEN_STATES = 10;
/** How many times storing a grant that lost a serialization race is re-attempted. */
const STORE_ATTEMPTS = 3;

export interface GoogleActor {
  readonly userId: string | null;
  readonly name?: string | null;
}

export interface GoogleConnectionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly googleSubject: string;
  readonly emailAtLink: string;
  readonly hostedDomain: string | null;
  readonly status: GoogleConnectionStatus;
  readonly grantedScopes: readonly string[];
  readonly requestedScopes: readonly string[];
  readonly connectedAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiredAt: Date | null;
  readonly lastFailureClass: string | null;
  readonly revokedAt: Date | null;
  readonly revocationReason: string | null;
  readonly revocationConfirmedAt: Date | null;
}

export interface ConsumedGoogleOAuthState {
  readonly capabilities: readonly GoogleWorkspaceCapability[];
  readonly returnTo: GoogleConnectReturnTarget;
  readonly nonceHash: string;
}

export interface GoogleGrantToStore {
  readonly googleSubject: string;
  readonly emailAtLink: string;
  readonly hostedDomain: string | null;
  /** Capability scopes Google granted. */
  readonly grantedScopes: readonly string[];
  /** Capability scopes this attempt asked for. */
  readonly requestedScopes: readonly string[];
  readonly sealed: SealedGoogleToken;
  readonly now: Date;
}

export type GoogleStoreOutcome =
  | { readonly outcome: 'STORED'; readonly connectionId: string }
  | { readonly outcome: 'DIFFERENT_ACCOUNT' | 'ACCOUNT_IN_USE' | 'NOT_PERMITTED' };

/** What a revocation took out of the database, for the caller to finish at Google after commit. */
export interface GoogleRevocation {
  readonly connectionId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly googleSubject: string;
  /** Null when the connection had already expired: no credential was left to delete. */
  readonly sealed: SealedGoogleToken | null;
}

const LIVE: GoogleConnectionStatus[] = ['CONNECTED', 'EXPIRED'];
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function record(row: Record<string, any>): GoogleConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    googleSubject: row.googleSubject,
    emailAtLink: row.emailAtLink,
    hostedDomain: row.hostedDomain ?? null,
    status: row.status,
    grantedScopes: [...(row.grantedScopes ?? [])],
    requestedScopes: [...(row.requestedScopes ?? [])],
    connectedAt: row.connectedAt,
    lastUsedAt: row.lastUsedAt ?? null,
    expiredAt: row.expiredAt ?? null,
    lastFailureClass: row.lastFailureClass ?? null,
    revokedAt: row.revokedAt ?? null,
    revocationReason: row.revocationReason ?? null,
    revocationConfirmedAt: row.revocationConfirmedAt ?? null,
  };
}

function sealedOf(row: Record<string, any>): SealedGoogleToken | null {
  if (!row.refreshTokenSealed || !row.sealVersion || !row.keyRef) return null;
  return { sealVersion: row.sealVersion, keyRef: row.keyRef, sealed: new Uint8Array(row.refreshTokenSealed) };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

async function writeAudit(
  prisma: PrismaClient,
  tx: Tx,
  args: {
    organizationId: string;
    connectionId: string;
    action: string;
    actor: GoogleActor;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await new AuditRepository(prisma).record(
    {
      organizationId: args.organizationId,
      userId: args.actor.userId,
      actorType: args.actor.userId ? 'HUMAN_AGENT' : 'SYSTEM',
      actorName: args.actor.name ?? (args.actor.userId ? undefined : 'System'),
      action: args.action,
      entityType: 'google_connection',
      entityId: args.connectionId,
      metadata: args.metadata,
    },
    tx,
  );
}

/**
 * Revoke a person's live connection INSIDE the caller's transaction: delete the sealed
 * token and the live link, drop every connect attempt, and write the audit row.
 *
 * Used by `GoogleConnectionRepository.revoke` and by the IAM lifecycle writes, so that
 * disabling or removing a member ends their Google connection in the same transaction
 * as the membership change (architecture §6, §11.6). Returns what was taken out, so the
 * caller can ask Google to revoke it after commit; null when nothing was live.
 */
export async function revokeGoogleConnectionInTx(
  prisma: PrismaClient,
  tx: Tx,
  organizationId: string,
  userId: string,
  request: { readonly reason: GoogleRevocationReason; readonly actor: GoogleActor; readonly now: Date },
): Promise<GoogleRevocation | null> {
  await tx.googleOAuthState.deleteMany({ where: { organizationId, userId } });
  const current = await tx.googleConnection.findFirst({ where: { organizationId, userId, status: { in: LIVE } } });
  if (!current) return null;
  const sealed = sealedOf(current);
  await tx.googleConnection.update({
    where: { id: current.id },
    data: {
      status: 'REVOKED',
      activeGoogleSubject: null,
      refreshTokenSealed: null,
      sealVersion: null,
      keyRef: null,
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
    action: GOOGLE_CONNECTION_AUDIT_ACTIONS.revoked,
    actor: request.actor,
    metadata: {
      subjectUserId: userId,
      reason: request.reason,
      previousStatus: current.status,
      capabilities: googleCapabilitiesOf(current.grantedScopes ?? []),
      credentialDeleted: sealed !== null,
    },
  });
  return { connectionId: current.id, organizationId, userId, googleSubject: current.googleSubject, sealed };
}

export class GoogleConnectionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // -- Connect attempts ----------------------------------------------------------------

  /**
   * Record a connect attempt. Consumed and expired attempts of this person are cleared
   * first; if they still hold the maximum number of open ones, the attempt is refused.
   */
  async openState(
    organizationId: string,
    userId: string,
    attempt: {
      readonly sessionId: string;
      readonly stateHash: string;
      readonly nonceHash: string;
      readonly capabilities: readonly GoogleWorkspaceCapability[];
      readonly returnTo: GoogleConnectReturnTarget;
      readonly now: Date;
    },
  ): Promise<'OPENED' | 'TOO_MANY_ATTEMPTS'> {
    return this.prisma.$transaction(async (tx) => {
      await tx.googleOAuthState.deleteMany({
        where: { organizationId, userId, OR: [{ consumedAt: { not: null } }, { expiresAt: { lte: attempt.now } }] },
      });
      const open = await tx.googleOAuthState.count({ where: { organizationId, userId } });
      if (open >= GOOGLE_OAUTH_MAX_OPEN_STATES) return 'TOO_MANY_ATTEMPTS';
      await tx.googleOAuthState.create({
        data: {
          organizationId,
          userId,
          sessionId: attempt.sessionId,
          stateHash: attempt.stateHash,
          nonceHash: attempt.nonceHash,
          capabilities: [...attempt.capabilities],
          returnTo: attempt.returnTo,
          expiresAt: new Date(attempt.now.getTime() + GOOGLE_OAUTH_STATE_LIFETIME_MS),
          createdAt: attempt.now,
        },
      });
      return 'OPENED' as const;
    });
  }

  /**
   * Where an attempt of THIS person started, so a refusal returns them there. Answers
   * nothing about anyone else's attempt.
   */
  async returnTargetOf(organizationId: string, userId: string, stateHash: string): Promise<GoogleConnectReturnTarget | null> {
    const row = await this.prisma.googleOAuthState.findFirst({
      where: { organizationId, userId, stateHash },
      select: { returnTo: true },
    });
    return row && isGoogleConnectReturnTarget(row.returnTo) ? row.returnTo : null;
  }

  /**
   * Consume an attempt exactly once: same organization, same person, SAME SESSION, not
   * expired, not already used. Anything else is null -- and which of those failed is not
   * reported.
   */
  async consumeState(
    organizationId: string,
    userId: string,
    sessionId: string,
    stateHash: string,
    now: Date,
  ): Promise<ConsumedGoogleOAuthState | null> {
    const where = { organizationId, userId, sessionId, stateHash };
    const { count } = await this.prisma.googleOAuthState.updateMany({
      where: { ...where, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (count !== 1) return null;
    const row = await this.prisma.googleOAuthState.findFirst({ where });
    if (!row || !isGoogleConnectReturnTarget(row.returnTo)) return null;
    const asked = (row.capabilities ?? []).filter(isGoogleWorkspaceCapability);
    const capabilities = GOOGLE_WORKSPACE_CAPABILITIES.filter((c) => asked.includes(c));
    if (capabilities.length === 0) return null;
    return { capabilities, returnTo: row.returnTo, nonceHash: row.nonceHash };
  }

  // -- Connections -----------------------------------------------------------------------

  /** This person's connection in this organization, without any credential. */
  async find(organizationId: string, userId: string): Promise<GoogleConnectionRecord | null> {
    const row = await this.prisma.googleConnection.findFirst({ where: { organizationId, userId } });
    return row ? record(row) : null;
  }

  /** The sealed credential of this person's CONNECTED connection, or null. */
  async credential(organizationId: string, userId: string): Promise<{ record: GoogleConnectionRecord; sealed: SealedGoogleToken } | null> {
    const row = await this.prisma.googleConnection.findFirst({ where: { organizationId, userId, status: 'CONNECTED' } });
    const sealed = row ? sealedOf(row) : null;
    return row && sealed ? { record: record(row), sealed } : null;
  }

  /**
   * Store what Google granted, replacing the previous grant of the SAME Google account.
   *
   * Refused, storing nothing, when this person's live connection is a different Google
   * account (disconnect first), when another person in this organization holds a live
   * link to this Google account, or when the person no longer holds an active membership.
   *
   * SERIALIZABLE, AND RE-CHECKED INSIDE. The membership is read in the same transaction,
   * so a member disabled while their callback was in flight either conflicts (and the
   * retry sees the disable) or commits first -- a revoked member is never re-connected.
   */
  async storeGrant(organizationId: string, userId: string, grant: GoogleGrantToStore, actor: GoogleActor): Promise<GoogleStoreOutcome> {
    const write = async (tx: Tx): Promise<GoogleStoreOutcome> => {
      const standing = await membershipAuthority(tx, organizationId, userId, grant.now);
      if (!standing.granted) return { outcome: 'NOT_PERMITTED' };
      const current = await tx.googleConnection.findFirst({ where: { organizationId, userId } });
      const live = current !== null && LIVE.includes(current.status as GoogleConnectionStatus);
      if (current && live && current.googleSubject !== grant.googleSubject) return { outcome: 'DIFFERENT_ACCOUNT' };
      const holder = await tx.googleConnection.findFirst({
        where: { organizationId, activeGoogleSubject: grant.googleSubject, NOT: { userId } },
        select: { id: true },
      });
      if (holder) return { outcome: 'ACCOUNT_IN_USE' };

      const requestedScopes = current && live ? union(current.requestedScopes ?? [], grant.requestedScopes) : [...grant.requestedScopes];
      const data = {
        googleSubject: grant.googleSubject,
        activeGoogleSubject: grant.googleSubject,
        emailAtLink: grant.emailAtLink,
        hostedDomain: grant.hostedDomain,
        status: 'CONNECTED',
        grantedScopes: [...grant.grantedScopes],
        requestedScopes,
        refreshTokenSealed: Buffer.from(grant.sealed.sealed),
        sealVersion: grant.sealed.sealVersion,
        keyRef: grant.sealed.keyRef,
        connectedAt: grant.now,
        expiredAt: null,
        lastFailureClass: null,
        revokedAt: null,
        revokedByUserId: null,
        revocationReason: null,
        revocationConfirmedAt: null,
      };
      const row = current
        ? await tx.googleConnection.update({ where: { id: current.id }, data })
        : await tx.googleConnection.create({ data: { organizationId, userId, ...data } });

      const action = !current
        ? GOOGLE_CONNECTION_AUDIT_ACTIONS.granted
        : current.status !== 'CONNECTED'
          ? GOOGLE_CONNECTION_AUDIT_ACTIONS.reconnected
          : sameSet(current.grantedScopes ?? [], grant.grantedScopes)
            ? null
            : GOOGLE_CONNECTION_AUDIT_ACTIONS.scopeChanged;
      if (action) {
        await writeAudit(this.prisma, tx, {
          organizationId,
          connectionId: row.id,
          action,
          actor,
          metadata: {
            subjectUserId: userId,
            capabilities: googleCapabilitiesOf(grant.grantedScopes),
            previousCapabilities: current ? googleCapabilitiesOf(current.grantedScopes ?? []) : [],
            requestedCapabilities: googleCapabilitiesOf(requestedScopes),
            hostedDomainPresent: grant.hostedDomain !== null,
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

  /** Revoke this person's live connection (see `revokeGoogleConnectionInTx`). */
  async revoke(
    organizationId: string,
    userId: string,
    request: { readonly reason: GoogleRevocationReason; readonly actor: GoogleActor; readonly now: Date },
  ): Promise<GoogleRevocation | null> {
    return this.prisma.$transaction((tx) => revokeGoogleConnectionInTx(this.prisma, tx, organizationId, userId, request));
  }

  /** What Google said when asked to revoke. Only a REVOKED connection of this organization is touched. */
  async recordRevocationResult(
    organizationId: string,
    connectionId: string,
    result: { readonly confirmed: true } | { readonly confirmed: false; readonly failureClass: GoogleConnectionFailureClass },
    now: Date,
    actor: GoogleActor,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.googleConnection.updateMany({
        where: { id: connectionId, organizationId, status: 'REVOKED' },
        data: result.confirmed
          ? { revocationConfirmedAt: now, lastFailureClass: null }
          : { revocationConfirmedAt: null, lastFailureClass: result.failureClass },
      });
      if (count !== 1 || result.confirmed) return;
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId,
        action: GOOGLE_CONNECTION_AUDIT_ACTIONS.revokeUnconfirmed,
        actor,
        metadata: { failureClass: result.failureClass },
      });
    });
  }

  /**
   * Google refused the stored grant (or it can no longer be opened): stop using it. The
   * credential is deleted -- it is known to be dead -- and the capabilities it covered
   * read EXPIRED until the person reconnects.
   */
  async markExpired(
    organizationId: string,
    userId: string,
    connectionId: string,
    failureClass: Extract<GoogleConnectionFailureClass, 'REFRESH_REFUSED' | 'TOKEN_UNOPENABLE'>,
    now: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.googleConnection.updateMany({
        where: { id: connectionId, organizationId, userId, status: 'CONNECTED' },
        data: { status: 'EXPIRED', expiredAt: now, refreshTokenSealed: null, sealVersion: null, keyRef: null, lastFailureClass: failureClass },
      });
      if (count !== 1) return false;
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId,
        action: GOOGLE_CONNECTION_AUDIT_ACTIONS.expired,
        actor: { userId: null },
        metadata: { subjectUserId: userId, failureClass },
      });
      return true;
    });
  }

  /**
   * A successful use of the connection. When Google now reports different capability
   * scopes (the person withdrew one at Google), the stored set follows and the change is
   * audited.
   */
  async recordUse(
    organizationId: string,
    userId: string,
    connectionId: string,
    grantedScopes: readonly string[] | null,
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.googleConnection.findFirst({ where: { id: connectionId, organizationId, userId, status: 'CONNECTED' } });
      if (!current) return;
      const next = grantedScopes;
      const changed = next !== null && !sameSet(current.grantedScopes ?? [], next);
      await tx.googleConnection.update({
        where: { id: current.id },
        data: changed && next ? { lastUsedAt: now, grantedScopes: [...next] } : { lastUsedAt: now },
      });
      if (!changed || !next) return;
      await writeAudit(this.prisma, tx, {
        organizationId,
        connectionId,
        action: GOOGLE_CONNECTION_AUDIT_ACTIONS.scopeChanged,
        actor: { userId: null },
        metadata: {
          subjectUserId: userId,
          capabilities: googleCapabilitiesOf(next),
          previousCapabilities: googleCapabilitiesOf(current.grantedScopes ?? []),
          observedAt: 'refresh',
        },
      });
    });
  }

  /**
   * The Workspace domains this organization admits, from its settings
   * (`settings.googleWorkspace.allowedHostedDomains`). Empty -- the default -- means no
   * restriction: any Google account, including one outside any Workspace.
   */
  async allowedHostedDomains(organizationId: string): Promise<string[]> {
    const org = await this.prisma.organization.findFirst({ where: { id: organizationId }, select: { settings: true } });
    const settings = org?.settings && typeof org.settings === 'object' ? (org.settings as Record<string, unknown>) : {};
    const google =
      settings.googleWorkspace && typeof settings.googleWorkspace === 'object' ? (settings.googleWorkspace as Record<string, unknown>) : {};
    const raw = Array.isArray(google.allowedHostedDomains) ? google.allowedHostedDomains : [];
    const domains = raw
      .filter((d): d is string => typeof d === 'string')
      .map((d) => d.trim().toLowerCase())
      .filter((d) => DOMAIN.test(d));
    return [...new Set(domains)];
  }

  /**
   * THE ONE CROSS-ORGANIZATION READ, AND WHY.
   *
   * Loop is one OAuth client. Revoking a token at Google ends that Google account's grant
   * to Loop, which would also end a live connection the same Google account holds in
   * ANOTHER organization -- one tenant's disconnect breaking another's. Before asking
   * Google to revoke, the caller asks only whether such a connection exists. The answer
   * is a boolean about the Google account the caller already holds; no row, id or
   * organization is returned.
   */
  async liveGrantElsewhere(googleSubject: string, exceptConnectionId: string): Promise<boolean> {
    const other = await this.prisma.googleConnection.findFirst({
      where: { activeGoogleSubject: googleSubject, NOT: { id: exceptConnectionId } },
      select: { id: true },
    });
    return other !== null;
  }
}

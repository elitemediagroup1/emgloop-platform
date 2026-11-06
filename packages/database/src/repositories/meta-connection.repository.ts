import { randomUUID } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { MetaReport } from '@emgloop/providers';
import type { AiDomainReading } from '@emgloop/shared';
import { membershipAuthority } from './membership.repository';
import { AuditRepository } from './audit.repository';
import { absentUntilMigrated } from '../creator/until-migrated';

export interface MetaPrincipal { organizationId: string; userId: string; creatorProfileId: string }
type Db = PrismaClient | Prisma.TransactionClient;
export async function metaCreatorAuthorized(db: Db, p: MetaPrincipal): Promise<boolean> {
  const authority = await membershipAuthority(db, p.organizationId, p.userId);
  if (!authority.granted || authority.systemRole !== 'CREATOR') return false;
  return !!await db.creatorProfile.findFirst({ where: { id: p.creatorProfileId, organizationId: p.organizationId, userId: p.userId } });
}
const scope = (p: MetaPrincipal) => ({ organizationId: p.organizationId, creatorProfileId: p.creatorProfileId, userId: p.userId });
const safeColumns = { id: true, pageName: true, pageId: true, instagramId: true, status: true, connectedAt: true, tokenExpiresAt: true, lastSyncedAt: true, lastFailure: true } as const;

export async function metaTablesPresent(db: PrismaClient, organizationId: string, userId: string) {
  return (await absentUntilMigrated(db.metaConnection.count({ where: { organizationId, userId } }))) !== null;
}
export async function disconnectMetaInTx(tx: Prisma.TransactionClient, organizationId: string, userId: string) {
  await tx.metaOAuthState.deleteMany({ where: { organizationId, userId } });
  await tx.metaConnection.updateMany({ where: { organizationId, userId }, data: { tokenSealed: null, activePageId: null, status: 'DISCONNECTED', leaseId: null, leaseUntil: null, analysisLeaseId: null, analysisLeaseUntil: null } });
}

export class MetaConnectionRepository {
  constructor(private readonly db: PrismaClient) {}
  async openState(p: MetaPrincipal, sessionId: string, stateHash: string, now: Date) {
    return this.db.$transaction(async tx => {
      if (!await metaCreatorAuthorized(tx, p)) return false;
      await tx.metaOAuthState.deleteMany({ where: { ...scope(p), expiresAt: { lte: now } } });
      if (await tx.metaOAuthState.count({ where: scope(p) }) >= 5) return false;
      await tx.metaOAuthState.create({ data: { ...scope(p), sessionId, stateHash, expiresAt: new Date(+now + 600_000) } });
      return true;
    });
  }
  async consumeState(p: MetaPrincipal, sessionId: string, stateHash: string, now: Date) {
    if (!await metaCreatorAuthorized(this.db, p)) return false;
    const result = await this.db.metaOAuthState.updateMany({ where: { ...scope(p), sessionId, stateHash, expiresAt: { gt: now }, consumedAt: null }, data: { consumedAt: now } });
    return result.count === 1;
  }
  async stage(p: MetaPrincipal, sessionId: string, stateHash: string, data: { tokenSealed: Buffer; metaUserId: string; tokenExpiresAt: Date; scopes: string[] }) {
    if (!await metaCreatorAuthorized(this.db, p)) return false;
    const result = await this.db.metaOAuthState.updateMany({ where: { ...scope(p), sessionId, stateHash, consumedAt: { not: null }, expiresAt: { gt: new Date() }, tokenSealed: null }, data });
    return result.count === 1;
  }
  async pending(p: MetaPrincipal, sessionId: string) {
    if (!await metaCreatorAuthorized(this.db, p)) return null;
    return this.db.metaOAuthState.findFirst({ where: { ...scope(p), sessionId, consumedAt: { not: null }, tokenSealed: { not: null }, expiresAt: { gt: new Date() } }, orderBy: { consumedAt: 'desc' } });
  }
  async connect(p: MetaPrincipal, sessionId: string, pendingId: string, data: { metaUserId: string; pageId: string; pageName: string; instagramId: string | null; tokenSealed: Buffer; tokenExpiresAt: Date; scopes: string[] }) {
    return this.db.$transaction(async tx => {
      if (!await metaCreatorAuthorized(tx, p)) return false;
      const attempt = await tx.metaOAuthState.deleteMany({ where: { ...scope(p), id: pendingId, sessionId, metaUserId: data.metaUserId, tokenSealed: { not: null }, expiresAt: { gt: new Date() } } });
      if (attempt.count !== 1) return false;
      const current = await tx.metaConnection.findFirst({ where: scope(p) });
      // Changing account requires an explicit disconnect; no silent reassignment of history.
      if (current && current.status !== 'DISCONNECTED' && (current.pageId !== data.pageId || current.metaUserId !== data.metaUserId)) throw new Error('DISCONNECT_FIRST');
      if (current && (current.pageId !== data.pageId || current.metaUserId !== data.metaUserId)) {
        // A different external identity gets a fresh connection. Its deletion callback must
        // never acquire ownership of the previous identity's imported observations.
        await tx.metaAnalyticsObservation.deleteMany({ where: { organizationId: p.organizationId, connectionId: current.id } });
        await tx.creatorAudienceSnapshot.deleteMany({ where: { organizationId: p.organizationId, creatorProfileId: p.creatorProfileId, source: 'META_GRAPH' } });
        await tx.metaConnection.deleteMany({ where: { ...scope(p), id: current.id } });
      }
      const row = await tx.metaConnection.upsert({ where: { creatorProfileId: p.creatorProfileId }, create: { ...scope(p), ...data, activePageId: data.pageId }, update: { ...data, activePageId: data.pageId, status: 'CONNECTED', connectedAt: new Date(), lastFailure: null, lastSyncedAt: null, nextSyncAt: new Date(), leaseId: null, leaseUntil: null } });
      await new AuditRepository(this.db).record({ organizationId: p.organizationId, userId: p.userId, action: 'meta.connected', entityType: 'meta_connection', entityId: row.id, metadata: { scopes: data.scopes } }, tx);
      return true;
    }, { isolationLevel: 'Serializable' });
  }
  async status(p: MetaPrincipal) {
    if (!await metaCreatorAuthorized(this.db, p)) return null;
    return this.db.metaConnection.findFirst({ where: scope(p), select: safeColumns });
  }
  async claim(p: MetaPrincipal) {
    if (!await metaCreatorAuthorized(this.db, p)) {
      await this.db.$transaction(tx => disconnectMetaInTx(tx, p.organizationId, p.userId));
      return null;
    }
    const now = new Date();
    const leaseId = randomUUID();
    const claimed = await this.db.metaConnection.updateMany({ where: { ...scope(p), status: 'CONNECTED', tokenSealed: { not: null }, nextSyncAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { lastAttemptAt: now, leaseId, leaseUntil: new Date(+now + 120_000) } });
    return claimed.count === 1 ? this.db.metaConnection.findFirst({ where: { ...scope(p), leaseId } }) : null;
  }
  async publish(p: MetaPrincipal, connectionId: string, leaseId: string, reports: MetaReport[], now: Date) {
    return this.db.$transaction(async tx => {
      if (!await metaCreatorAuthorized(tx, p)) return false;
      const updated = await tx.metaConnection.updateMany({ where: { ...scope(p), id: connectionId, leaseId, status: 'CONNECTED', leaseUntil: { gt: now } }, data: { leaseId: null, leaseUntil: null, lastSyncedAt: now, lastFailure: null, nextSyncAt: new Date(+now + 900_000), analysisNextAt: now } });
      if (updated.count !== 1) return false;
      for (const report of reports) {
        await tx.metaAnalyticsObservation.create({ data: { organizationId: p.organizationId, creatorProfileId: p.creatorProfileId, connectionId, platform: report.platform, observedAt: now, report: report as unknown as Prisma.InputJsonValue } });
        if (report.followers !== null) await tx.creatorAudienceSnapshot.create({ data: { organizationId: p.organizationId, creatorProfileId: p.creatorProfileId, platform: report.platform, observedAt: now, followers: report.followers, source: 'META_GRAPH' } });
      }
      return true;
    }, { isolationLevel: 'Serializable' });
  }
  async failure(p: MetaPrincipal, connectionId: string, leaseId: string, failure: string) {
    await this.db.metaConnection.updateMany({ where: { ...scope(p), id: connectionId, leaseId, status: 'CONNECTED' }, data: { leaseId: null, leaseUntil: null, lastFailure: failure, nextSyncAt: new Date(Date.now() + (failure === 'RATE_LIMITED' ? 3600_000 : 900_000)), ...(['TOKEN_EXPIRED', 'TOKEN_UNOPENABLE'].includes(failure) ? { status: 'RECONNECT_REQUIRED', tokenSealed: null } : {}) } });
  }
  async disconnect(p: MetaPrincipal) {
    return this.db.$transaction(async tx => {
      if (!await metaCreatorAuthorized(tx, p)) return false;
      await tx.metaOAuthState.deleteMany({ where: scope(p) });
      const row = await tx.metaConnection.findFirst({ where: scope(p) });
      if (!row) return true;
      await disconnectMetaInTx(tx, p.organizationId, p.userId);
      await new AuditRepository(this.db).record({ organizationId: p.organizationId, userId: p.userId, action: 'meta.disconnected', entityType: 'meta_connection', entityId: row.id, metadata: { credentialDeleted: true } }, tx);
      return true;
    }, { isolationLevel: 'Serializable' });
  }
  async observations(p: MetaPrincipal) {
    if (!await metaCreatorAuthorized(this.db, p)) return [];
    const connection = await this.db.metaConnection.findFirst({ where: { ...scope(p), status: { not: 'DISCONNECTED' } } });
    if (!connection) return [];
    const rows = await Promise.all(['FACEBOOK', 'INSTAGRAM'].filter(platform => platform !== 'INSTAGRAM' || connection.instagramId).map(platform => this.db.metaAnalyticsObservation.findFirst({ where: { organizationId: p.organizationId, creatorProfileId: p.creatorProfileId, connectionId: connection.id, platform, observedAt: { gte: connection.connectedAt } }, orderBy: { observedAt: 'desc' } })));
    return rows.filter((r): r is NonNullable<typeof r> => r !== null);
  }
  // Scheduler sees only due connection identities; every subsequent operation is tenant-scoped
  // and re-derives active creator membership. Never returns credentials to a scheduler.
  async due(limit = 10) {
    return this.db.metaConnection.findMany({ where: { status: 'CONNECTED', nextSyncAt: { lte: new Date() } }, orderBy: { nextSyncAt: 'asc' }, take: limit, select: { organizationId: true, userId: true, creatorProfileId: true } });
  }
  async purgeExpiredAttempts() { await this.db.metaOAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } }); }

  async dueAnalysis() {
    return this.db.metaConnection.findFirst({ where: { status: 'CONNECTED', lastSyncedAt: { not: null }, analysisNextAt: { lte: new Date() } }, orderBy: { analysisNextAt: 'asc' }, select: { organizationId: true, userId: true, creatorProfileId: true } });
  }
  async claimAnalysis(p: MetaPrincipal) {
    if (!await metaCreatorAuthorized(this.db, p)) return null;
    const now = new Date(), leaseId = randomUUID();
    const claimed = await this.db.metaConnection.updateMany({ where: { ...scope(p), status: 'CONNECTED', lastSyncedAt: { not: null }, analysisNextAt: { lte: now }, OR: [{ analysisLeaseUntil: null }, { analysisLeaseUntil: { lt: now } }] }, data: { analysisLeaseId: leaseId, analysisLeaseUntil: new Date(+now + 60_000) } });
    if (!claimed.count) return null;
    const connection = await this.db.metaConnection.findFirst({ where: { ...scope(p), analysisLeaseId: leaseId } });
    const observations = await this.observations(p);
    return connection ? { connection, observations, leaseId } : null;
  }
  async reading(p: MetaPrincipal, fingerprint: string) {
    if (!await metaCreatorAuthorized(this.db, p)) return null;
    return this.db.metaAnalyticsReading.findFirst({ where: { organizationId: p.organizationId, creatorProfileId: p.creatorProfileId, sourceFingerprint: fingerprint }, orderBy: { observedAt: 'desc' } });
  }
  async finishAnalysis(p: MetaPrincipal, connectionId: string, leaseId: string, result: { fingerprint: string; observationIds: string[]; evidenceAt: Date; reading: AiDomainReading; invocationId: string; providerId: string } | { failure: string }) {
    return this.db.$transaction(async tx => {
      if (!await metaCreatorAuthorized(tx, p)) return false;
      const changed = await tx.metaConnection.updateMany({ where: { ...scope(p), id: connectionId, status: 'CONNECTED', analysisLeaseId: leaseId, analysisLeaseUntil: { gt: new Date() }, ...('reading' in result ? { lastSyncedAt: { lte: result.evidenceAt } } : {}) }, data: { analysisLeaseId: null, analysisLeaseUntil: null, analysisFailure: 'failure' in result ? result.failure : null, analysisNextAt: new Date(Date.now() + 900_000) } });
      if (!changed.count) return false;
      if ('reading' in result) await tx.metaAnalyticsReading.create({ data: { organizationId: p.organizationId, creatorProfileId: p.creatorProfileId, connectionId, sourceFingerprint: result.fingerprint, observationIds: result.observationIds, reading: result.reading as unknown as Prisma.InputJsonValue, invocationId: result.invocationId, providerId: result.providerId } });
      return true;
    }, { isolationLevel: 'Serializable' });
  }

  // External identity exception: only the signed-request boundary may call this with the
  // app-scoped user id authenticated by Meta's HMAC. No browser-supplied tenant identity.
  async eraseVerifiedMetaUser(metaUserId: string, erase: boolean) {
    await this.db.$transaction(async tx => {
      const rows = await tx.metaConnection.findMany({ where: { metaUserId } });
      await tx.metaOAuthState.deleteMany({ where: { metaUserId } });
      for (const row of rows) {
        await disconnectMetaInTx(tx, row.organizationId, row.userId);
        if (erase) {
          await tx.metaAnalyticsObservation.deleteMany({ where: { organizationId: row.organizationId, connectionId: row.id } });
          // Historical audience rows have no connection id. Only this adapter's source is deleted.
          await tx.creatorAudienceSnapshot.deleteMany({ where: { organizationId: row.organizationId, creatorProfileId: row.creatorProfileId, source: 'META_GRAPH' } });
          await tx.metaConnection.deleteMany({ where: { organizationId: row.organizationId, id: row.id } });
        }
      }
    }, { isolationLevel: 'Serializable' });
  }
}

import { ttoMediaPresent } from './tto-media.repository';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { TikTokBusinessKind } from '@emgloop/providers';
import { membershipAuthority } from './membership.repository';
import { AuditRepository } from './audit.repository';
import { absentUntilMigrated } from '../creator/until-migrated';
export interface BusinessPrincipal { organizationId: string; userId: string; sessionId: string }
type Db = PrismaClient | Prisma.TransactionClient;
export async function businessAuthorized(db: Db, p: BusinessPrincipal, kind: TikTokBusinessKind): Promise<string | null> {
  const a = await membershipAuthority(db, p.organizationId, p.userId);
  if (!a.granted) return null;
  const session = await db.userSession.findFirst({ where: { id: p.sessionId, organizationId: p.organizationId, userId: p.userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
  if (!session) return null;
  if (kind === 'CREATOR') {
    if (a.systemRole !== 'CREATOR') return null;
    const profile = await db.creatorProfile.findFirst({ where: { organizationId: p.organizationId, userId: p.userId }, select: { id: true } });
    return profile?.id ?? null;
  }
  // Agency tokens are restricted to administrators, and explicit IAM denies still win.
  if (!['OWNER', 'ADMIN'].includes(a.systemRole)) return null;
  const denied = await db.permission.count({ where: { organizationId: p.organizationId, resource: 'integrations', action: { in: ['view', 'update'] }, effect: 'DENY', OR: [{ userId: p.userId }, { systemRole: a.systemRole }] } });
  return denied ? null : 'TTO';
}
const scope = (p: BusinessPrincipal, kind: TikTokBusinessKind) => ({ organizationId: p.organizationId, userId: p.userId, kind });
export async function businessTablesPresent(db: PrismaClient, organizationId: string, userId: string) {
  if (!db.tikTokBusinessConnection) return false;
  return (await absentUntilMigrated(db.tikTokBusinessConnection.count({ where: { organizationId, userId } }))) !== null;
}
export async function disconnectBusinessInTx(tx: Prisma.TransactionClient, organizationId: string, userId: string) {
  await tx.tikTokBusinessOAuthState.deleteMany({ where: { organizationId, userId } });
  await tx.tikTokBusinessConnection.updateMany({ where: { organizationId, userId }, data: { tokenSealed: null, status: 'DISCONNECTED', revision: { increment: 1 } } });
}
export class TikTokBusinessRepository {
  constructor(private readonly db: PrismaClient) {}
  async status(p: BusinessPrincipal, kind: TikTokBusinessKind) {
    const identity = await businessAuthorized(this.db, p, kind);
    if (!identity) return null;
    const row = await this.db.tikTokBusinessConnection.findFirst({ where: scope(p, kind), select: { status: true, connectedAt: true, expiresAt: true, creatorProfileId: true } });
    if (kind === 'CREATOR' && row?.creatorProfileId !== identity) return { status: 'DISCONNECTED', connectedAt: null, expiresAt: null };
    return row ?? { status: 'DISCONNECTED', connectedAt: null, expiresAt: null };
  }
  async begin(p: BusinessPrincipal, kind: TikTokBusinessKind, stateHash: string, now: Date) {
    return this.db.$transaction(async tx => {
      const identity = await businessAuthorized(tx, p, kind);
      if (!identity) return false;
      await tx.tikTokBusinessOAuthState.deleteMany({ where: { ...scope(p, kind), OR: [{ expiresAt: { lte: now } }, { consumedAt: { not: null } }] } });
      if (await tx.tikTokBusinessOAuthState.count({ where: scope(p, kind) }) >= 5) return false;
      const row = await tx.tikTokBusinessConnection.upsert({ where: { organizationId_userId_kind: scope(p, kind) }, create: { ...scope(p, kind), creatorProfileId: kind === 'CREATOR' ? identity : null }, update: {} });
      await tx.tikTokBusinessOAuthState.create({ data: { ...scope(p, kind), sessionId: p.sessionId, creatorProfileId: kind === 'CREATOR' ? identity : null, connectionRevision: row.revision, stateHash, expiresAt: new Date(+now + 600000) } });
      return true;
    }, { isolationLevel: 'Serializable' });
  }
  async consume(p: BusinessPrincipal, kind: TikTokBusinessKind, stateHash: string, now: Date) {
    if (!await businessAuthorized(this.db, p, kind)) return false;
    return (await this.db.tikTokBusinessOAuthState.updateMany({ where: { ...scope(p, kind), sessionId: p.sessionId, stateHash, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } })).count === 1;
  }
  async store(p: BusinessPrincipal, kind: TikTokBusinessKind, stateHash: string, data: { tokenSealed: Buffer; externalId: string | null; expiresAt: Date | null }, now: Date) {
    return this.db.$transaction(async tx => {
      const identity = await businessAuthorized(tx, p, kind);
      if (!identity) return false;
      const attempt = await tx.tikTokBusinessOAuthState.findFirst({ where: { ...scope(p, kind), sessionId: p.sessionId, stateHash, consumedAt: { not: null }, expiresAt: { gt: now } } });
      if (!attempt || (kind === 'CREATOR' && attempt.creatorProfileId !== identity)) return false;
      const row = await tx.tikTokBusinessConnection.findFirst({ where: scope(p, kind) });
      if (!row || row.revision !== attempt.connectionRevision || (row.status === 'CONNECTED' && row.externalId !== data.externalId)) return false;
      // One creator identity must never silently attach to two creator seats in this organization.
      if (kind === 'CREATOR' && await tx.tikTokBusinessConnection.findFirst({ where: { organizationId: p.organizationId, kind, externalId: data.externalId, status: 'CONNECTED', userId: { not: p.userId } } })) return false;
      const changed = await tx.tikTokBusinessConnection.updateMany({ where: { ...scope(p, kind), revision: attempt.connectionRevision }, data: { ...data, ...(kind === 'TTO' ? { ttoAccountId: null, importEnabled: false } : {}), creatorProfileId: kind === 'CREATOR' ? identity : null, status: 'CONNECTED', connectedAt: now, revision: { increment: 1 } } });
      if (changed.count !== 1) return false;
      await tx.tikTokBusinessOAuthState.deleteMany({ where: scope(p, kind) });
      await new AuditRepository(this.db).record({ organizationId: p.organizationId, userId: p.userId, action: 'tiktok_business.connected', entityType: 'tiktok_business_connection', entityId: row.id, metadata: { kind } }, tx);
      return true;
    }, { isolationLevel: 'Serializable' });
  }
  async disconnect(p: BusinessPrincipal, kind: TikTokBusinessKind) {
    const mediaPresent = await ttoMediaPresent(this.db, p.organizationId);
    return this.db.$transaction(async tx => {
      if (!await businessAuthorized(tx, p, kind)) return false;
      await tx.tikTokBusinessOAuthState.deleteMany({ where: scope(p, kind) });
      const changed = await tx.tikTokBusinessConnection.updateMany({ where: scope(p, kind), data: { tokenSealed: null, status: 'DISCONNECTED', revision: { increment: 1 } } });
      if (mediaPresent && kind === 'TTO') await tx.ttoCreatorSnapshot.deleteMany({where:{organizationId:p.organizationId,connection:{userId:p.userId,kind:'TTO'}}});
      if (changed.count) await new AuditRepository(this.db).record({ organizationId: p.organizationId, userId: p.userId, action: 'tiktok_business.disconnected', entityType: 'tiktok_business_connection', entityId: p.userId, metadata: { kind, localCredentialDeleted: true, providerRevocationConfirmed: false } }, tx);
      return true;
    }, { isolationLevel: 'Serializable' });
  }
}

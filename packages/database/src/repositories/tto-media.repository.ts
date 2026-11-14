import { randomUUID } from 'crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { creatorDeclaredSocialHandles } from '@emgloop/shared';
import { readTtoReport, ttoHandle, type TtoReport } from '@emgloop/providers';
import { membershipAuthority } from './membership.repository';
import { absentUntilMigrated } from '../creator/until-migrated';
import { AuditRepository } from './audit.repository';
export interface TtoViewer {
    organizationId: string;
    userId: string;
}
type Db = PrismaClient | Prisma.TransactionClient;
export async function ttoOwnerAuthorized(db: Db, p: TtoViewer) {
    const a = await membershipAuthority(db, p.organizationId, p.userId);
    if (!a.granted || !['OWNER', 'ADMIN'].includes(a.systemRole))
        return false;
    return !await db.permission.count({ where: { organizationId: p.organizationId, resource: 'integrations', action: { in: ['view', 'update'] }, effect: 'DENY', OR: [{ userId: p.userId }, { systemRole: a.systemRole }] } });
}
export const profileTtoHandle = (preferences: unknown) => ttoHandle(creatorDeclaredSocialHandles(preferences).TIKTOK);
export async function ttoMediaPresent(db: PrismaClient, organizationId: string) {
    if (!db.ttoCreatorSnapshot)
        return false;
    return (await absentUntilMigrated(db.ttoCreatorSnapshot.count({ where: { organizationId } }))) !== null;
}
export async function withdrawTtoMediaInTx(tx: Prisma.TransactionClient, organizationId: string, userId: string) {
    await tx.ttoCreatorSnapshot.deleteMany({ where: { organizationId, OR: [{ connection: { userId } }, { creatorProfile: { userId } }] } });
}
export class TtoMediaRepository {
    constructor(private readonly db: PrismaClient) { }
    async authorizedProfile(p: TtoViewer, id: string) {
        const a = await membershipAuthority(this.db, p.organizationId, p.userId);
        if (!a.granted)
            return null;
        if (a.systemRole !== 'CREATOR' && !await ttoOwnerAuthorized(this.db, p))
            return null;
        return this.db.creatorProfile.findFirst({ where: { organizationId: p.organizationId, id, ...(a.systemRole === 'CREATOR' ? { userId: p.userId } : {}) } });
    }
    async source(organizationId: string) {
        const rows = await this.db.tikTokBusinessConnection.findMany({ where: { organizationId, kind: 'TTO', status: 'CONNECTED', tokenSealed: { not: null } }, take: 20, orderBy: { id: 'asc' } });
        const valid: typeof rows = [];
        for (const row of rows)
            if (await ttoOwnerAuthorized(this.db, { organizationId, userId: row.userId }))
                valid.push(row);
        const selected = valid.filter(r => r.importEnabled);
        return selected.length === 1 ? selected[0]! : selected.length === 0 && valid.length === 1 ? valid[0]! : null;
    }
    async ownGrant(p: TtoViewer) {
        if (!await ttoOwnerAuthorized(this.db, p))
            return null;
        return this.db.tikTokBusinessConnection.findFirst({ where: { organizationId:p.organizationId,userId:p.userId, kind: 'TTO', status: 'CONNECTED', tokenSealed: { not: null } } });
    }
    async selectSource(p: TtoViewer, id: string, revision: number, accountId: string, leaseId?: string) {
        return this.db.$transaction(async (tx) => {
            if (!await ttoOwnerAuthorized(tx, p))
                return null;
            const changed = await tx.tikTokBusinessConnection.updateMany({ where: { organizationId:p.organizationId,userId:p.userId, id, kind: 'TTO', status: 'CONNECTED', revision, tokenSealed: { not: null } }, data: { ttoAccountId: accountId, importEnabled: true, revision: { increment: 1 } } });
            if (changed.count !== 1)
                return null;
            await tx.tikTokBusinessConnection.updateMany({ where: { organizationId: p.organizationId, kind: 'TTO', id: { not: id } }, data: { importEnabled: false, revision: { increment: 1 } } });
            await tx.ttoCreatorSnapshot.deleteMany({ where: { organizationId: p.organizationId, ...(leaseId ? { OR: [{ leaseId: null }, { leaseId: { not: leaseId } }] } : {}) } });
            if (leaseId)
                await tx.ttoCreatorSnapshot.updateMany({ where: { organizationId: p.organizationId, leaseId }, data: { sourceRevision: revision + 1 } });
            await new AuditRepository(this.db).record({ organizationId: p.organizationId, userId: p.userId, action: 'tiktok_business.import_source_selected', entityType: 'tiktok_business_connection', entityId: id, metadata: { accountId } }, tx);
            return revision + 1;
        }, { isolationLevel: 'Serializable' });
    }
    async claim(organizationId: string, profileId: string, force: boolean, now: Date) {
        const source = await this.source(organizationId);
        return this.db.$transaction(async (tx) => {
            const profile = await tx.creatorProfile.findFirst({ where: { organizationId, id: profileId } });
            if (!profile)
                return null;
            const handle = profileTtoHandle(profile.preferences);
            if (!source?.tokenSealed) {
                await tx.ttoCreatorSnapshot.upsert({ where: { organizationId_creatorProfileId: { organizationId, creatorProfileId: profileId } }, create: { organizationId, creatorProfileId: profileId, lastFailure: 'SOURCE_SELECTION_REQUIRED', nextAttemptAt: new Date(+now + 3600000) }, update: { report: {}, lastReadAt: null, lastFailure: 'SOURCE_SELECTION_REQUIRED', nextAttemptAt: new Date(+now + 3600000) } });
                return null;
            }
            const key = { organizationId, creatorProfileId: profileId };
            await tx.ttoCreatorSnapshot.upsert({ where: { organizationId_creatorProfileId: key }, create: key, update: {} });
            const row = await tx.ttoCreatorSnapshot.findUnique({ where: { organizationId_creatorProfileId: key } });
            if (!row)
                return null;
            if (row.leaseUntil && +row.leaseUntil > +now)
                return null;
            // Force never bypasses the two-minute request fence or a provider backoff.
            if (row.lastAttemptAt && +now - +row.lastAttemptAt < 120000)
                return null;
            if (row.nextAttemptAt > now && (row.lastFailure && row.lastFailure !== 'HANDLE_REQUIRED' || (!force && row.handle === handle)))
                return null;
            if (!handle) {
                await tx.ttoCreatorSnapshot.updateMany({ where: key, data: { handle: null, report: {}, lastReadAt: null, lastFailure: 'HANDLE_REQUIRED', nextAttemptAt: new Date(+now + 86400000) } });
                return null;
            }
            const leaseId = randomUUID();
            const won = await tx.ttoCreatorSnapshot.updateMany({ where: { ...key, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }, data: { connectionId: source.id, sourceRevision: source.revision, handle, ...(row.handle !== handle || row.connectionId !== source.id || row.sourceRevision !== source.revision ? { report: {}, lastReadAt: null } : {}), leaseId, leaseUntil: new Date(+now + 90000), lastAttemptAt: now, nextAttemptAt: new Date(+now + 120000) } });
            return won.count === 1 ? { organizationId, profileId, handle, leaseId, source } : null;
        }, { isolationLevel: 'Serializable' });
    }
    async publish(claim: NonNullable<Awaited<ReturnType<TtoMediaRepository['claim']>>>, report: TtoReport, now: Date) {
        return this.db.$transaction(async (tx) => {
            const { organizationId, profileId, source, leaseId, handle } = claim;
            if (!await ttoOwnerAuthorized(tx, { organizationId, userId: source.userId }))
                return false;
            const grant = await tx.tikTokBusinessConnection.findFirst({ where: { organizationId, id: source.id, revision: source.revision, importEnabled: true, status: 'CONNECTED', tokenSealed: { not: null }, ttoAccountId: source.ttoAccountId } });
            if (!grant)
                return false;
            const profile = await tx.creatorProfile.findFirst({ where: { organizationId, id: profileId } });
            if (!profile || profileTtoHandle(profile.preferences) !== handle || report.handle !== handle)
                return false;
            const others = await tx.creatorProfile.findMany({ where: { organizationId, id: { not: profileId } }, select: { preferences: true } });
            const duplicate = others.some(p => profileTtoHandle(p.preferences) === handle);
            if (duplicate)
                return false;
            return (await tx.ttoCreatorSnapshot.updateMany({ where: { organizationId, creatorProfileId: profileId, leaseId, leaseUntil: { gt: now }, sourceRevision: source.revision }, data: { report: report as unknown as Prisma.InputJsonValue, lastReadAt: now, lastFailure: null, nextAttemptAt: new Date(+now + 6 * 3600000), leaseId: null, leaseUntil: null } })).count === 1;
        }, { isolationLevel: 'Serializable' });
    }
    async failure(claim: NonNullable<Awaited<ReturnType<TtoMediaRepository['claim']>>>, failure: string, now: Date) {
        const allowed = ['UNAVAILABLE', 'RATE_LIMITED', 'PERMISSION_REQUIRED', 'INVALID_RESPONSE', 'IDENTITY_MISMATCH', 'SOURCE_SELECTION_REQUIRED', 'TOKEN_UNOPENABLE', 'WITHDRAWN'];
        const code = allowed.includes(failure) ? failure : 'UNAVAILABLE';
        await this.db.ttoCreatorSnapshot.updateMany({ where: { organizationId: claim.organizationId, creatorProfileId: claim.profileId, leaseId: claim.leaseId }, data: { lastFailure: code, leaseId: null, leaseUntil: null, nextAttemptAt: new Date(+now + (code === 'UNAVAILABLE' ? 900000 : 3600000)), ...(code === 'IDENTITY_MISMATCH' || code === 'PERMISSION_REQUIRED' ? { report: {}, lastReadAt: null } : {}) } });
        if (code === 'PERMISSION_REQUIRED')
            await this.db.$transaction(async (tx) => {
                const changed = await tx.tikTokBusinessConnection.updateMany({ where: { organizationId: claim.organizationId, id: claim.source.id, revision: claim.source.revision }, data: { importEnabled: false, status: 'ERROR', tokenSealed: null, revision: { increment: 1 } } });
                if (changed.count)
                    await tx.ttoCreatorSnapshot.deleteMany({ where: { organizationId: claim.organizationId, connectionId: claim.source.id } });
            });
    }
    async read(p: TtoViewer, profileId: string, now: Date) {
        const profile = await this.authorizedProfile(p, profileId);
        if (!profile)
            return null;
        const row = await this.db.ttoCreatorSnapshot.findUnique({ where: { organizationId_creatorProfileId: { organizationId: p.organizationId, creatorProfileId: profileId } }, include: { connection: true } });
        if (!row || !row.connection || row.handle !== profileTtoHandle(profile.preferences))
            return null;
        const c = row.connection;
        if (!c.importEnabled || c.status !== 'CONNECTED' || !c.tokenSealed || c.revision !== row.sourceRevision || !await ttoOwnerAuthorized(this.db, { organizationId: p.organizationId, userId: c.userId }))
            return null;
        const report = row.lastReadAt && +now - +row.lastReadAt < 86400000 ? readTtoReport(row.report, now) : null;
        if (report && report.handle !== row.handle)
            return null;
        const others = await this.db.creatorProfile.findMany({ where: { organizationId: p.organizationId, id: { not: profileId } }, select: { preferences: true } });
        if (others.some(p => profileTtoHandle(p.preferences) === row.handle))
            return null;
        return { report, lastReadAt: row.lastReadAt, lastFailure: row.lastFailure, stale: !row.lastReadAt || +now - +row.lastReadAt > 6 * 3600000 };
    }
    async targets() {
        // A bounded sweep; missing handles get a durable deferred state, so they cannot block the queue.
        return this.db.creatorProfile.findMany({ where: { organization: { tiktokBusinessConnections: { some: { kind: 'TTO', status: 'CONNECTED', tokenSealed: { not: null } } } }, OR: [{ ttoSnapshot: null }, { ttoSnapshot: { nextAttemptAt: { lte: new Date() } } }] }, select: { organizationId: true, id: true }, orderBy: { id: 'asc' }, take: 10 });
    }
    async roster(p: TtoViewer) {
        if (!await ttoOwnerAuthorized(this.db, p))
            return [];
        return this.db.creatorProfile.findMany({ where: { organizationId: p.organizationId }, select: { id: true, displayName: true, preferences: true, ttoSnapshot: { select: { lastReadAt: true, lastFailure: true } } }, orderBy: { displayName: 'asc' }, take: 200 });
    }
}

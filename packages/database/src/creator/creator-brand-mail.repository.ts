// A narrow publication capability. Private Mail stays owner-scoped; only an explicitly authorized
// thread's minimized update is readable by its one snapshotted creator login. No raw mail is stored.
import { Prisma, type PrismaClient, type CreatorBrandMailShare } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AI_TASK_CREATOR_BRAND_UPDATE, CREATOR_BRAND_UPDATE_SCHEMA_ID, parseCreatorBrandUpdate, validateCreatorBrandUpdate, CREATOR_MAIL_SHARING_DECISION, CREATOR_BRAND_REFRESH_MS, CREATOR_BRAND_FRESH_MS, type CreatorBrandUpdate } from '@emgloop/shared';
import { membershipAuthority } from '../repositories/membership.repository';
import { IamRepository } from '../repositories/iam.repository';
import { PartyRepository } from '../repositories/cognitive/party.repository';
import { AuditRepository } from '../repositories/audit.repository';
import type { WorkPrincipal } from '../repositories/work-state/work-principal';
import { absentUntilMigrated } from './until-migrated';

type Db = Prisma.TransactionClient;
const MINUTE = 60_000;
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const blocked = (labels: readonly string[]) => labels.some(l => ['SPAM', 'TRASH', 'DRAFT'].includes(l));
export type CreatorMailShareOutcome = 'SHARED' | 'WITHDRAWN' | 'NOT_ALLOWED' | 'NOT_FOUND' | 'CONSENT_REQUIRED' | 'RECIPIENT_REQUIRED' | 'SCOPE_CONFLICT';
export interface PublishedCreatorBrandUpdate {
  readonly id: string;
  readonly brand: string;
  readonly brandId: string;
  readonly stage: string | null;
  readonly summary: string | null;
  readonly nextStep: string | null;
  readonly generatedAt: Date | null;
  readonly evidenceAt: Date | null;
  readonly checkedAt: Date | null;
  readonly current: boolean;
}

export class CreatorBrandMailRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async present(principal: WorkPrincipal): Promise<boolean> {
    return (await absentUntilMigrated(this.prisma.creatorBrandMailShare.findMany({ where: { organizationId: principal.organizationId, ownerUserId: principal.userId }, select: { id: true }, take: 1 }))) !== null;
  }

  private async operator(db: Db, principal: WorkPrincipal): Promise<boolean> {
    const authority = await membershipAuthority(db, principal.organizationId, principal.userId);
    if (!authority.granted || !['OWNER', 'ADMIN', 'MANAGER'].includes(authority.systemRole)) return false;
    const denied = await db.permission.findFirst({ where: { organizationId: principal.organizationId, resource: { in: ['employeeIntelligence', 'identityResolution'] }, action: 'view', effect: 'DENY', OR: [{ userId: principal.userId }, { systemRole: authority.systemRole }] }, select: { id: true } });
    return !denied;
  }

  private async company(db: Db, organizationId: string, id: string): Promise<string | null> {
    const row = await db.cognitiveIdentity.findFirst({ where: { organizationId, id, entityType: 'COMPANY', archivedAt: null, supersededByIdentityId: null, status: { not: 'ARCHIVED' } } });
    if (!row) return null;
    const party = await new PartyRepository(this.prisma).findParty(organizationId, id, undefined, db);
    return party?.establishment.established ? row.displayName?.trim() || 'Brand or agency' : null;
  }

  /** Consent and destination are re-derived at claim, completion AND every creator read. */
  async allowed(db: Db, row: CreatorBrandMailShare): Promise<boolean> {
    const principal = { organizationId: row.organizationId, userId: row.ownerUserId };
    if (row.revokedAt || row.decisionRef !== CREATOR_MAIL_SHARING_DECISION || !(await this.operator(db, principal))) return false;
    const recipient = await membershipAuthority(db, row.organizationId, row.recipientUserId);
    if (!recipient.granted || recipient.systemRole !== 'CREATOR') return false;
    const profile = await db.creatorProfile.findFirst({ where: { organizationId: row.organizationId, id: row.creatorProfileId, userId: row.recipientUserId } });
    if (!profile || !(await this.company(db, row.organizationId, row.brandPartyId))) return false;
    const consent = await db.sourceContentAuthorization.findFirst({ where: { id: row.contentAuthorizationId, organizationId: row.organizationId, userId: row.ownerUserId, provider: 'GMAIL', revokedAt: null, authorizedAt: row.contentAuthorizedAt }, select: { id: true } });
    const google = await db.googleConnection.findFirst({ where: { organizationId: row.organizationId, userId: row.ownerUserId, status: 'CONNECTED' }, select: { grantedScopes: true } });
    const thread = await db.workThread.findFirst({ where: { id: row.threadId, organizationId: row.organizationId, userId: row.ownerUserId, provider: 'GOOGLE' }, select: { labels: true } });
    return !!consent && !!google?.grantedScopes.includes(READ_SCOPE) && !!thread && !blocked(thread.labels);
  }

  async share(principal: WorkPrincipal, input: { threadProviderId: string; creatorProfileId: string; brandPartyId: string; confirmed: boolean; decisionRef: string }): Promise<CreatorMailShareOutcome> {
    if (!input.confirmed || input.decisionRef !== CREATOR_MAIL_SHARING_DECISION) return 'CONSENT_REQUIRED';
    const iam = new IamRepository(this.prisma);
    if (!(await iam.can({ ...principal, resource: 'employeeIntelligence', action: 'view' })) || !(await iam.can({ ...principal, resource: 'identityResolution', action: 'view' }))) return 'NOT_ALLOWED';
    return this.prisma.$transaction(async tx => {
      if (!(await this.operator(tx, principal))) return 'NOT_ALLOWED';
      const thread = await tx.workThread.findFirst({ where: { ...principal, provider: 'GOOGLE', threadId: input.threadProviderId } });
      const profile = await tx.creatorProfile.findFirst({ where: { organizationId: principal.organizationId, id: input.creatorProfileId } });
      if (!thread || blocked(thread.labels) || !profile || !(await this.company(tx, principal.organizationId, input.brandPartyId))) return 'NOT_FOUND';
      if (!profile.userId) return 'RECIPIENT_REQUIRED';
      const recipient = await membershipAuthority(tx, principal.organizationId, profile.userId);
      if (!recipient.granted || recipient.systemRole !== 'CREATOR') return 'RECIPIENT_REQUIRED';
      const consent = await tx.sourceContentAuthorization.findFirst({ where: { ...principal, provider: 'GMAIL', revokedAt: null }, select: { id: true, authorizedAt: true } });
      const google = await tx.googleConnection.findFirst({ where: { ...principal, status: 'CONNECTED' }, select: { grantedScopes: true } });
      if (!consent || !google?.grantedScopes.includes(READ_SCOPE)) return 'CONSENT_REQUIRED';
      const existing = await tx.creatorBrandMailShare.findFirst({ where: { organizationId: principal.organizationId, ownerUserId: principal.userId, threadId: thread.id } });
      if (existing && !existing.revokedAt) return existing.creatorProfileId === profile.id && existing.recipientUserId === profile.userId && existing.brandPartyId === input.brandPartyId && existing.contentAuthorizationId === consent.id && existing.contentAuthorizedAt.getTime() === consent.authorizedAt.getTime() ? 'SHARED' : 'SCOPE_CONFLICT';
      const data = { organizationId: principal.organizationId, ownerUserId: principal.userId, creatorProfileId: profile.id, recipientUserId: profile.userId, brandPartyId: input.brandPartyId, threadId: thread.id, contentAuthorizationId: consent.id, contentAuthorizedAt: consent.authorizedAt, decisionRef: input.decisionRef, authorizedAt: new Date(), revokedAt: null, summary: Prisma.DbNull, sourceFingerprint: null, evidenceAt: null, generatedAt: null, checkedAt: null, nextCheckAt: new Date(), leaseToken: null, leaseUntil: null, lastFailureClass: null, invocationId: null, providerId: null };
      const row = existing ? await tx.creatorBrandMailShare.update({ where: { id: existing.id }, data }) : await tx.creatorBrandMailShare.create({ data });
      await new AuditRepository(this.prisma).record({ ...principal, action: 'creator.mail.shared', entityType: 'creator_mail_share', entityId: row.id, metadata: { creatorProfileId: profile.id, brandPartyId: input.brandPartyId, decisionRef: input.decisionRef } }, tx);
      return 'SHARED';
    }, { isolationLevel: 'Serializable' });
  }

  async withdraw(principal: WorkPrincipal, id: string): Promise<CreatorMailShareOutcome> {
    return this.prisma.$transaction(async tx => {
      const row = await tx.creatorBrandMailShare.findFirst({ where: { id, organizationId: principal.organizationId, ownerUserId: principal.userId, revokedAt: null } });
      if (!row) return 'NOT_FOUND';
      await tx.creatorBrandMailShare.update({ where: { id: row.id }, data: { revokedAt: new Date(), summary: Prisma.DbNull, leaseToken: null, leaseUntil: null } });
      await new AuditRepository(this.prisma).record({ ...principal, action: 'creator.mail.withdrawn', entityType: 'creator_mail_share', entityId: id }, tx);
      return 'WITHDRAWN';
    });
  }

  /** Routing only, from the explicit sharing queue; never an organization-wide private Mail query. */
  async due(now: Date, limit = 8) {
    return this.prisma.creatorBrandMailShare.findMany({ where: { revokedAt: null, nextCheckAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }], take: Math.min(20, Math.max(1, limit)), select: { id: true, organizationId: true, ownerUserId: true } });
  }

  async claim(principal: WorkPrincipal, id: string, now: Date): Promise<CreatorBrandMailShare | null> {
    const token = randomUUID();
    const claimed = await this.prisma.creatorBrandMailShare.updateMany({ where: { id, organizationId: principal.organizationId, ownerUserId: principal.userId, revokedAt: null, nextCheckAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseToken: token, leaseUntil: new Date(now.getTime() + 2 * MINUTE) } });
    if (!claimed.count) return null;
    return this.prisma.creatorBrandMailShare.findFirst({ where: { id, organizationId: principal.organizationId, ownerUserId: principal.userId, leaseToken: token } });
  }

  async scope(row: CreatorBrandMailShare): Promise<{ creatorName: string; brandName: string } | null> {
    if (!(await this.allowed(this.prisma, row))) return null;
    const profile = await this.prisma.creatorProfile.findFirst({ where: { id: row.creatorProfileId, organizationId: row.organizationId }, select: { displayName: true } });
    return profile ? { creatorName: profile.displayName, brandName: (await this.company(this.prisma, row.organizationId, row.brandPartyId))! } : null;
  }

  async finish(row: CreatorBrandMailShare, result: { now: Date; fingerprint?: string; evidenceAt?: Date; update?: CreatorBrandUpdate | null; invocationId?: string; providerId?: string; failure?: string }): Promise<boolean> {
    if (result.update) {
      const parsed = parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, ...result.update });
      if (!parsed || validateCreatorBrandUpdate(parsed, AI_TASK_CREATOR_BRAND_UPDATE, new Set(result.update.citations), { figures: new Map(), dates: new Set() }).length > 0) result = { ...result, update: null, failure: 'OUTPUT_INVALID' };
    }
    return this.prisma.$transaction(async tx => {
      const live = await tx.creatorBrandMailShare.findFirst({ where: { id: row.id, organizationId: row.organizationId, ownerUserId: row.ownerUserId, revokedAt: null, leaseToken: row.leaseToken, leaseUntil: { gt: result.now } } });
      if (!live) return false;
      if (!(await this.allowed(tx, live))) {
        await tx.creatorBrandMailShare.deleteMany({ where: { id: live.id, organizationId: live.organizationId, ownerUserId: live.ownerUserId } });
        return false;
      }
      await tx.creatorBrandMailShare.update({ where: { id: live.id }, data: {
        leaseToken: null, leaseUntil: null, nextCheckAt: new Date(result.now.getTime() + CREATOR_BRAND_REFRESH_MS), lastFailureClass: result.failure ?? (result.update?.publishable === false || (result.update === undefined && live.lastFailureClass === 'WITHHELD') ? 'WITHHELD' : null),
        ...(!result.failure ? { checkedAt: result.now } : {}),
        ...(result.fingerprint ? { sourceFingerprint: result.fingerprint } : {}),
        ...(result.evidenceAt ? { evidenceAt: result.evidenceAt } : {}),
        ...(result.update !== undefined ? { summary: result.update?.publishable ? result.update as unknown as Prisma.InputJsonValue : Prisma.DbNull, generatedAt: result.update?.publishable ? result.now : null, invocationId: result.invocationId ?? null, providerId: result.providerId ?? null } : {}),
      } });
      return true;
    }, { isolationLevel: 'Serializable' });
  }

  /** Fixed-horizon maintenance; no mailbox content is read. Safe before the migration. */
  async purgeExpired(now: Date): Promise<number> {
    const result = await absentUntilMigrated(this.prisma.creatorBrandMailShare.updateMany({ where: { evidenceAt: { lt: new Date(now.getTime() - 30 * 86400_000) } }, data: { summary: Prisma.DbNull, generatedAt: null } }));
    return result?.count ?? 0;
  }

  async ownerThread(principal: WorkPrincipal, providerId: string) {
    const thread = await this.prisma.workThread.findFirst({ where: { ...principal, provider: 'GOOGLE', threadId: providerId }, select: { id: true } });
    return thread ? this.prisma.creatorBrandMailShare.findFirst({ where: { organizationId: principal.organizationId, ownerUserId: principal.userId, threadId: thread.id, revokedAt: null }, select: { id: true, creatorProfileId: true, brandPartyId: true, checkedAt: true, lastFailureClass: true } }) : null;
  }

  async forCreator(principal: WorkPrincipal, profileId: string, now: Date): Promise<PublishedCreatorBrandUpdate[]> {
    const authority = await membershipAuthority(this.prisma, principal.organizationId, principal.userId);
    if (!authority.granted || authority.systemRole !== 'CREATOR') return [];
    const profile = await this.prisma.creatorProfile.findFirst({ where: { organizationId: principal.organizationId, id: profileId, userId: principal.userId }, select: { id: true } });
    if (!profile) return [];
    const rows = await this.prisma.creatorBrandMailShare.findMany({ where: { organizationId: principal.organizationId, creatorProfileId: profile.id, recipientUserId: principal.userId, revokedAt: null }, orderBy: [{ generatedAt: 'desc' }, { id: 'asc' }], take: 100 });
    const out: PublishedCreatorBrandUpdate[] = [];
    for (const row of rows) {
      if (!(await this.allowed(this.prisma, row))) continue;
      const raw = row.summary as unknown as CreatorBrandUpdate | null;
      const valid = raw?.publishable === true && typeof raw.summary === 'string' && typeof raw.nextStep === 'string' && row.generatedAt && row.evidenceAt && now.getTime() - row.evidenceAt.getTime() <= 30 * 86400_000;
      out.push({ id: row.id, brandId: row.brandPartyId, brand: (await this.company(this.prisma, row.organizationId, row.brandPartyId))!, stage: valid ? raw.stage : null, summary: valid ? raw.summary : null, nextStep: valid ? raw.nextStep : null, generatedAt: valid ? row.generatedAt : null, evidenceAt: row.evidenceAt, checkedAt: row.checkedAt, current: !!valid && !row.lastFailureClass && !!row.checkedAt && now.getTime() - row.checkedAt.getTime() < CREATOR_BRAND_FRESH_MS });
    }
    return out;
  }
}

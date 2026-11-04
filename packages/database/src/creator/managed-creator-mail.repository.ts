import { randomUUID } from 'crypto';
import { Prisma, type PrismaClient, type ManagedCreatorMailCapture } from '@prisma/client';
import { AI_OUTPUT_REJECTIONS, AI_TASK_CREATOR_BRAND_UPDATE, CREATOR_BRAND_UPDATE_SCHEMA_ID, parseCreatorBrandUpdate, validateCreatorBrandUpdate } from '@emgloop/shared';
import type { WorkPrincipal } from '../repositories/work-state/work-principal';
import { membershipAuthority } from '../repositories/membership.repository';
import { PartyReadModelRepository } from '../repositories/party-read-model.repository';
import { AuditRepository } from '../repositories/audit.repository';
import { IamRepository } from '../repositories/iam.repository';
import { ManagedMailboxRepository } from './managed-mailbox.repository';
import { absentUntilMigrated } from './until-migrated';
import { creatorCaptureScopeHash, creatorMailAliases, parseCreatorMailKeywords, creatorMailQuery, mailEvidenceHash, type ManagedCaptureReading } from './creator-mail-matching';
import type { PublishedCreatorBrandUpdate } from './creator-brand-mail.repository';

type Db = Prisma.TransactionClient;
type CaptureScope = Pick<ManagedCreatorMailCapture, 'organizationId' | 'ownerUserId' | 'recipientUserId' | 'creatorProfileId' | 'mailboxId' | 'mailboxRevision' | 'scopeHash' | 'enabled'>;
const DAY = 86400_000;
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
export function captureReadings(value: unknown): ManagedCaptureReading[] {
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is ManagedCaptureReading => !!r && typeof r === 'object' && typeof r.threadId === 'string' && typeof r.evidenceKey === 'string' && typeof r.fingerprint === 'string' && typeof r.checkedAt === 'string' && typeof r.state === 'string').slice(-100);
}
function accepted(r: ManagedCaptureReading): boolean {
  if (!r.update?.publishable || !r.brandId || r.state !== 'CURRENT') return false;
  const output = parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, ...r.update });
  return !!output && !validateCreatorBrandUpdate(output, AI_TASK_CREATOR_BRAND_UPDATE, new Set(r.update.citations), { figures: new Map(), dates: new Set() }).length;
}
export class ManagedCreatorMailRepository {
  constructor(private readonly prisma: PrismaClient) {}
  private mailboxes() { return new ManagedMailboxRepository(this.prisma); }
  async present(organizationId: string): Promise<boolean> {
    return (await absentUntilMigrated(this.prisma.managedCreatorMailCapture.findMany({ where: { organizationId }, select: { id: true }, take: 1 }))) !== null;
  }
  async allowed(db: Db, row: CaptureScope) {
    const principal = { organizationId: row.organizationId, userId: row.ownerUserId };
    if (!row.enabled || !(await this.mailboxes().permitted(db, principal, 'update'))) return null;
    if (!(await new IamRepository(db as PrismaClient).can({ ...principal, resource: 'identityResolution', action: 'view' }))) return null;
    for (const requirement of AI_TASK_CREATOR_BRAND_UPDATE.requires) if (!(await new IamRepository(db as PrismaClient).can({ ...principal, resource: requirement.resource as 'employeeIntelligence', action: 'view' }))) return null;
    const recipient = await membershipAuthority(db, row.organizationId, row.recipientUserId);
    if (!recipient.granted || recipient.systemRole !== 'CREATOR') return null;
    const profile = await db.creatorProfile.findFirst({ where: { organizationId: row.organizationId, id: row.creatorProfileId, userId: row.recipientUserId } });
    if (!profile || creatorCaptureScopeHash(profile) !== row.scopeHash) return null;
    const source = await db.managedGoogleMailbox.findFirst({ where: { organizationId: row.organizationId, id: row.mailboxId, revision: row.mailboxRevision, status: 'CONNECTED' } });
    if (!source?.grantedScopes.includes(READ) || !(await this.mailboxes().permitted(db, { organizationId: row.organizationId, userId: source.authorizedByUserId }, 'update'))) return null;
    if (source.kind === 'CREATOR') {
      const preferences = profile.preferences as Record<string, unknown> | null;
      if (source.creatorProfileId !== profile.id || preferences?.managedMailboxEmail !== source.expectedEmail) return null;
    } else if (source.kind !== 'STAFF' || source.creatorProfileId !== null) return null;
    return { profile, source };
  }
  async staffKeywords(principal: WorkPrincipal, profileId: string): Promise<string[] | null> {
    if (!(await this.mailboxes().permittedFor(principal, 'view'))) return null;
    const profile = await this.prisma.creatorProfile.findFirst({ where: { organizationId: principal.organizationId, id: profileId } });
    return profile ? creatorMailAliases(profile) : null;
  }
  async configure(principal: WorkPrincipal, profileId: string, sourceIds: readonly string[], now: Date, staffKeywords?: readonly string[]): Promise<'STARTED' | 'NOT_ALLOWED' | 'INVALID'> {
    const keywords = staffKeywords === undefined ? undefined : parseCreatorMailKeywords(staffKeywords);
    if (keywords === null) return 'INVALID';
    const ids = [...new Set(sourceIds)];
    if (!ids.length || ids.length > 4 || ids.some(id => !id || id.length > 200)) return 'INVALID';
    return this.prisma.$transaction(async tx => {
      if (!(await this.mailboxes().permitted(tx, principal, 'update', now))) return 'NOT_ALLOWED';
      const profile = await tx.creatorProfile.findFirst({ where: { organizationId: principal.organizationId, id: profileId } });
      if (!profile?.userId) return 'NOT_ALLOWED';
      const preferences = profile.preferences && typeof profile.preferences === 'object' && !Array.isArray(profile.preferences) ? profile.preferences : {};
      const updatedProfile = keywords ? { ...profile, preferences: { ...preferences, staffMailKeywords: keywords } } : profile;
      const rows = [];
      for (const mailboxId of ids) {
        const source = await tx.managedGoogleMailbox.findFirst({ where: { organizationId: principal.organizationId, id: mailboxId, status: 'CONNECTED' } });
        if (!source) return 'NOT_ALLOWED';
        const query = creatorMailQuery(updatedProfile, source.kind === 'CREATOR', new Date(now.getTime() - 30 * DAY));
        if (!query) return 'INVALID';
        const data = { organizationId: principal.organizationId, creatorProfileId: profile.id, recipientUserId: profile.userId, ownerUserId: principal.userId, mailboxId, mailboxRevision: source.revision, scopeHash: creatorCaptureScopeHash(profile), generation: randomUUID(), enabled: true, windowStart: new Date(now.getTime() - 30 * DAY), cycleStartedAt: now, query, pendingThreadIds: [], nextPageToken: null, listedCount: 0, searchComplete: false, capped: false, readings: [] as Prisma.InputJsonValue, lastCheckedAt: null, lastFailureClass: null, nextCheckAt: now, leaseToken: null, leaseUntil: null };
        if (!(await this.allowed(tx, data))) return 'NOT_ALLOWED';
        rows.push({ ...data, scopeHash: creatorCaptureScopeHash(updatedProfile) });
      }
      // Validate every selected source before changing profile keywords or capture scopes.
      if (keywords) await tx.creatorProfile.update({ where: { id: profile.id, organizationId: principal.organizationId }, data: { preferences: updatedProfile.preferences as Prisma.InputJsonValue } });
      // Keyword changes receive a fresh generation: no old lease or reading can cross the new scope.
      // Deselect old sources immediately; selected sources start with the new scope.
      await tx.managedCreatorMailCapture.updateMany({ where: { organizationId: principal.organizationId, creatorProfileId: profile.id }, data: { enabled: false, readings: [], pendingThreadIds: [], leaseToken: null, leaseUntil: null, generation: randomUUID() } });
      for (const data of rows) {
        const existing = await tx.managedCreatorMailCapture.findFirst({ where: { organizationId: principal.organizationId, creatorProfileId: profile.id, mailboxId: data.mailboxId } });
        if (existing) await tx.managedCreatorMailCapture.update({ where: { id: existing.id }, data });
        else await tx.managedCreatorMailCapture.create({ data });
      }
      await new AuditRepository(this.prisma).record({ ...principal, action: 'creator.capture.started', entityType: 'creator_profile', entityId: profile.id, metadata: { sourceCount: ids.length, windowDays: 30, decisionRef: 'managed-creator-capture:2026-11-02:v1' } }, tx);
      return 'STARTED';
    }, { isolationLevel: 'Serializable' });
  }
  async pause(principal: WorkPrincipal, profileId: string): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      if (!(await this.mailboxes().permitted(tx, principal, 'update'))) return false;
      const result = await tx.managedCreatorMailCapture.updateMany({ where: { organizationId: principal.organizationId, creatorProfileId: profileId }, data: { enabled: false, readings: [], pendingThreadIds: [], leaseToken: null, leaseUntil: null, generation: randomUUID() } });
      if (result.count) await new AuditRepository(this.prisma).record({ ...principal, action: 'creator.capture.paused', entityType: 'creator_profile', entityId: profileId }, tx);
      return true;
    });
  }
  async due(now: Date, principal?: WorkPrincipal, profileId?: string) {
    if (principal && !(await this.mailboxes().permittedFor(principal, 'update'))) return [];
    return (await absentUntilMigrated(this.prisma.managedCreatorMailCapture.findMany({ where: { enabled: true, ...(principal ? { organizationId: principal.organizationId, ownerUserId: principal.userId } : {}), ...(profileId ? { creatorProfileId: profileId } : {}), nextCheckAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }], take: 1, select: { id: true, organizationId: true, ownerUserId: true } }))) ?? [];
  }
  async claim(principal: WorkPrincipal, id: string, now: Date) {
    const token = randomUUID();
    const done = await this.prisma.managedCreatorMailCapture.updateMany({ where: { id, organizationId: principal.organizationId, ownerUserId: principal.userId, enabled: true, nextCheckAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseToken: token, leaseUntil: new Date(now.getTime() + 120_000) } });
    return done.count ? this.prisma.managedCreatorMailCapture.findFirst({ where: { id, organizationId: principal.organizationId, ownerUserId: principal.userId, leaseToken: token } }) : null;
  }
  async scope(row: ManagedCreatorMailCapture) {
    const current = await this.prisma.managedCreatorMailCapture.findFirst({ where: { id: row.id, organizationId: row.organizationId, generation: row.generation, leaseToken: row.leaseToken, enabled: true } });
    if (!current) return null;
    const live = await this.allowed(this.prisma, current);
    if (!live) return null;
    const [roster, brands, addresses] = await Promise.all([
      this.prisma.creatorProfile.findMany({ where: { organizationId: row.organizationId }, take: 501 }),
      new PartyReadModelRepository(this.prisma).directory(row.organizationId, 'COMPANY', 1000),
      this.prisma.managedGoogleMailbox.findMany({ where: { organizationId: row.organizationId }, select: { expectedEmail: true }, take: 501 }),
    ]);
    if (roster.length > 500 || brands.truncated || addresses.length > 500) return null;
    return { ...live, roster, brands: brands.rows, internalAddresses: addresses.map(a => a.expectedEmail) };
  }
  async finish(row: ManagedCreatorMailCapture, now: Date, patch: { reading?: ManagedCaptureReading; pending?: readonly string[]; pageToken?: string | null; listed?: number; complete?: boolean; capped?: boolean; failure?: string | null; delayMs?: number; resetCycle?: boolean }): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      const live = await tx.managedCreatorMailCapture.findFirst({ where: { id: row.id, organizationId: row.organizationId, ownerUserId: row.ownerUserId, generation: row.generation, leaseToken: row.leaseToken, leaseUntil: { gt: now }, enabled: true } });
      if (!live) return false;
      if (!(await this.allowed(tx, live))) { await tx.managedCreatorMailCapture.update({ where: { id: live.id }, data: { enabled: false, readings: [], pendingThreadIds: [], leaseToken: null, leaseUntil: null, generation: randomUUID(), lastFailureClass: 'SCOPE_ENDED' } }); return false; }
      let readings = captureReadings(live.readings);
      if (patch.reading) {
        let reading = patch.reading;
        if (reading.state === 'CURRENT' && !accepted(reading)) reading = { ...reading, state: 'WITHHELD', update: undefined, generatedAt: null };
        // Store the contract, never an accidental extra field containing source mail or model prose.
        const update = reading.update ? parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, ...reading.update })?.creatorBrandUpdate : undefined;
        const codes = AI_OUTPUT_REJECTIONS.filter(code => Array.isArray(reading.rejections) && reading.rejections.includes(code));
        const retryAt = Date.parse(reading.retryAfter ?? '');
        const validationRetry = reading.state === 'MODEL_UNAVAILABLE' && codes.length && retryAt >= now.getTime() && retryAt <= now.getTime() + 3600_000
          ? { retryAfter: new Date(retryAt).toISOString(), rejections: codes } : {};
        reading = { ...validationRetry, threadId: reading.threadId, brandId: reading.brandId, evidenceKey: reading.evidenceKey, fingerprint: reading.fingerprint, evidenceAt: reading.evidenceAt, checkedAt: now.toISOString(), generatedAt: reading.generatedAt, messageCount: reading.messageCount, incomplete: reading.incomplete, state: reading.state, ...(update ? { update } : {}) };
        readings = [...readings.filter(r => r.threadId !== reading.threadId), reading];
      }
      readings = readings.filter(r => !r.evidenceAt || Number.isFinite(Date.parse(r.evidenceAt)) && now.getTime() - Date.parse(r.evidenceAt) <= 30 * DAY);
      // Retain active validation cooldowns inside the same 100-reading bound so queue churn
      // cannot erase a failed attempt's wait time and trigger another model call early.
      const cooling = readings.filter(r => r.state === 'MODEL_UNAVAILABLE' && Date.parse(r.retryAfter ?? '') > now.getTime() &&
        Date.parse(r.retryAfter ?? '') <= Date.parse(r.checkedAt) + 3600_000 &&
        AI_OUTPUT_REJECTIONS.some(code => Array.isArray(r.rejections) && r.rejections.includes(code))).slice(-100);
      const coolingIds = new Set(cooling.map(r => r.threadId));
      const room = 100 - cooling.length;
      readings = [...cooling, ...(room ? readings.filter(r => !coolingIds.has(r.threadId)).slice(-room) : [])];
      await tx.managedCreatorMailCapture.update({ where: { id: live.id }, data: { leaseToken: null, leaseUntil: null, nextCheckAt: new Date(now.getTime() + (patch.delayMs ?? 0)), lastCheckedAt: now, lastFailureClass: patch.failure ?? null,
        readings: JSON.parse(JSON.stringify(readings)) as Prisma.InputJsonValue,
        ...(patch.pending ? { pendingThreadIds: [...patch.pending].slice(0, 100) } : {}), ...(patch.pageToken !== undefined ? { nextPageToken: patch.pageToken } : {}), ...(patch.listed !== undefined ? { listedCount: patch.listed } : {}), ...(patch.complete !== undefined ? { searchComplete: patch.complete } : {}), ...(patch.capped !== undefined ? { capped: patch.capped } : {}),
        ...(patch.resetCycle ? { cycleStartedAt: now, listedCount: 0, searchComplete: false, nextPageToken: null, pendingThreadIds: [] } : {}),
      } }); return true;
    }, { isolationLevel: 'Serializable' });
  }
  async status(principal: WorkPrincipal, profileId: string) {
    if (!(await this.mailboxes().permittedFor(principal, 'view'))) return null;
    return absentUntilMigrated(this.prisma.managedCreatorMailCapture.findMany({ where: { organizationId: principal.organizationId, creatorProfileId: profileId }, orderBy: { id: 'asc' } }));
  }
  async updates(principal: WorkPrincipal, profileId: string, now: Date, manager = false): Promise<PublishedCreatorBrandUpdate[]> {
    if (manager) { if (!(await this.mailboxes().permittedFor(principal, 'view'))) return []; }
    else { const recipient = await membershipAuthority(this.prisma, principal.organizationId, principal.userId); if (!recipient.granted || recipient.systemRole !== 'CREATOR') return []; }
    const profile = await this.prisma.creatorProfile.findFirst({ where: { organizationId: principal.organizationId, id: profileId, ...(!manager ? { userId: principal.userId } : {}) }, select: { id: true } });
    if (!profile) return [];
    const rows = await absentUntilMigrated(this.prisma.managedCreatorMailCapture.findMany({ where: { organizationId: principal.organizationId, creatorProfileId: profile.id, enabled: true }, take: 4 }));
    const out = new Map<string, PublishedCreatorBrandUpdate & { messageCount: number }>();
    for (const row of rows ?? []) {
      if (!(await this.allowed(this.prisma, row))) continue;
      for (const r of captureReadings(row.readings)) {
        // A discovered brand is private candidate data until a shareable reading is accepted.
        // Never turn model refusal/withholding into a creator-visible brand association.
        if (!accepted(r)) continue;
        if (!r.brandId || !r.evidenceAt || !Number.isFinite(Date.parse(r.evidenceAt)) || Date.parse(r.evidenceAt) > now.getTime() || now.getTime() - Date.parse(r.evidenceAt) > 30 * DAY) continue;
        const brand = await new PartyReadModelRepository(this.prisma).establishedOne(row.organizationId, 'COMPANY', r.brandId);
        if (!brand) continue;
        const valid = accepted(r), checked = new Date(r.checkedAt), evidenceAt = new Date(r.evidenceAt);
        const item = { id: mailEvidenceHash(`${row.creatorProfileId}:${r.evidenceKey}:${r.brandId}`), brand: brand.displayName || 'Brand or agency', brandId: brand.id, stage: valid ? r.update!.stage : null, summary: valid ? r.update!.summary : null, nextStep: valid ? r.update!.nextStep : null, generatedAt: valid && r.generatedAt ? new Date(r.generatedAt) : null, checkedAt: checked, evidenceAt, current: valid && checked <= now && now.getTime() - checked.getTime() < 600_000, messageCount: r.messageCount };
        const key = `${r.brandId}:${r.evidenceKey}`, old = out.get(key);
        if (!old || item.messageCount > old.messageCount || item.messageCount === old.messageCount && checked.getTime() > (old.checkedAt?.getTime() ?? 0)) out.set(key, item);
      }
    }
    return [...out.values()].map(({ messageCount: _count, ...item }) => item);
  }
}

// The creator domain's persistence (Creator Hub, 2026-09-22).
//
// OWNS ONLY WHAT NOTHING ELSE DOES: the creator profile (the login that acts as a
// creator, and the attributes the creator maintains), Content and its immutable
// Versions (bytes live in object storage; only the key is here), approvals as
// marks on one version, publication marks, and the join from a Content to the
// Work OS instance that produces it. Performance, audience and compensation rows
// are evidence, each carrying its `source`.
//
// EVERY METHOD TAKES THE ORGANIZATION FIRST and resolves rows within it (CLAUDE.md,
// Multi-Tenant Rules). Cross-organization ids are not found, never forbidden.
//
// NOTHING HERE DECIDES A STATE. The state of a piece of content is derived by the
// pure functions in @emgloop/shared from the rows this repository returns.

import type {
  Prisma,
  PrismaClient,
  CreatorProfile,
  CreatorContent,
  ContentVersion,
  ContentVersionApproval,
  ContentPublication,
  ContentProduction,
  CreatorPerformanceSnapshot,
  CreatorAudienceSnapshot,
  CreatorCompensationEntry,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { MEDIA_KEY_PREFIX, mediaExtensionOf } from '@emgloop/providers';

export type CreatorDb = PrismaClient | Prisma.TransactionClient;

export interface CreateCreatorProfileInput {
  organizationId: string;
  partyId: string;
  userId?: string | null;
  displayName: string;
  handle?: string | null;
  bio?: string | null;
  categories?: string[];
  socialAccounts?: Prisma.InputJsonValue;
  payoutState?: string;
  rateInfo?: Prisma.InputJsonValue;
  documents?: Prisma.InputJsonValue;
  preferences?: Prisma.InputJsonValue;
  defaultEditorUserId?: string | null;
  createdByUserId?: string | null;
}

export interface CreateContentInput {
  organizationId: string;
  creatorProfileId: string;
  title: string;
  kind: string;
  campaignId?: string | null;
  deliverableId?: string | null;
  opportunityId?: string | null;
  createdByUserId: string;
}

export interface BeginVersionInput {
  organizationId: string;
  contentId: string;
  /** ORIGINAL | EDIT */
  kind: string;
  contentType: string;
  fileName?: string | null;
  uploadedByUserId: string;
  /** CREATOR | EMG */
  uploadedByKind: string;
  producedByWorkInstanceId?: string | null;
  answersInstructionId?: string | null;
  noteToCreator?: string | null;
  internalNote?: string | null;
  visibleToCreator?: boolean;
}

export interface VersionReadyInput {
  byteSize: number;
  contentType?: string | null;
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
  clientFacts?: Prisma.InputJsonValue;
}

export interface RecordApprovalInput {
  organizationId: string;
  contentId: string;
  versionId: string;
  /** creator | emg | brand */
  requirementKey: string;
  /** CREATOR | EMG | BRAND_RELAYED */
  approverKind: string;
  approvedByUserId: string;
  originatorLabel?: string | null;
  note?: string | null;
}

export interface RecordPublicationInput {
  organizationId: string;
  contentId: string;
  versionId: string;
  platform: string;
  url?: string | null;
  publishedAt: Date;
  markedByUserId: string;
}

export interface CreateProductionInput {
  organizationId: string;
  contentId: string;
  workInstanceId: string;
  sourceVersionId: string;
  requestedByUserId: string;
  requestedReturnAt?: Date | null;
  kind?: string;
}

export type ContentWithLineage = CreatorContent & {
  versions: (ContentVersion & { approvals: ContentVersionApproval[]; publications: ContentPublication[] })[];
  productions: ContentProduction[];
  creatorProfile: CreatorProfile;
};

/** The label a version carries. Number 0 is the Original; edits count from 1. */
export function versionLabel(number: number): string {
  return number === 0 ? 'Original' : `Edit v${number}`;
}

export class CreatorRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ---- profiles -------------------------------------------------------------------------

  async profileForUser(organizationId: string, userId: string): Promise<CreatorProfile | null> {
    return this.prisma.creatorProfile.findFirst({ where: { organizationId, userId } });
  }

  async profileById(organizationId: string, id: string): Promise<CreatorProfile | null> {
    return this.prisma.creatorProfile.findFirst({ where: { organizationId, id } });
  }

  async profileByParty(organizationId: string, partyId: string): Promise<CreatorProfile | null> {
    return this.prisma.creatorProfile.findFirst({ where: { organizationId, partyId } });
  }

  async listProfiles(organizationId: string): Promise<CreatorProfile[]> {
    return this.prisma.creatorProfile.findMany({ where: { organizationId }, orderBy: { displayName: 'asc' } });
  }

  async createProfile(input: CreateCreatorProfileInput): Promise<CreatorProfile> {
    return this.prisma.creatorProfile.create({
      data: {
        organizationId: input.organizationId,
        partyId: input.partyId,
        userId: input.userId ?? null,
        displayName: input.displayName,
        handle: input.handle ?? null,
        bio: input.bio ?? null,
        categories: input.categories ?? [],
        socialAccounts: input.socialAccounts ?? [],
        payoutState: input.payoutState ?? 'NOT_SET_UP',
        rateInfo: input.rateInfo ?? {},
        documents: input.documents ?? [],
        preferences: input.preferences ?? {},
        defaultEditorUserId: input.defaultEditorUserId ?? null,
        createdByUserId: input.createdByUserId ?? null,
      },
    });
  }

  /** Creator-editable fields only; identity and EMG-maintained fields are not here. */
  async updateProfile(
    organizationId: string,
    id: string,
    patch: { displayName?: string; handle?: string | null; bio?: string | null; categories?: string[]; preferences?: Prisma.InputJsonValue; socialAccounts?: Prisma.InputJsonValue; payoutState?: string },
  ): Promise<CreatorProfile | null> {
    const existing = await this.prisma.creatorProfile.findFirst({ where: { organizationId, id }, select: { id: true } });
    if (!existing) return null;
    return this.prisma.creatorProfile.update({ where: { id: existing.id }, data: patch });
  }

  /** Bind (or rebind) the login that acts as this creator. EMG-only act. */
  async bindUser(organizationId: string, id: string, userId: string | null): Promise<CreatorProfile | null> {
    const existing = await this.prisma.creatorProfile.findFirst({ where: { organizationId, id }, select: { id: true } });
    if (!existing) return null;
    return this.prisma.creatorProfile.update({ where: { id: existing.id }, data: { userId } });
  }

  // ---- content and versions --------------------------------------------------------------

  async createContent(input: CreateContentInput): Promise<CreatorContent> {
    return this.prisma.creatorContent.create({
      data: {
        organizationId: input.organizationId,
        creatorProfileId: input.creatorProfileId,
        title: input.title,
        kind: input.kind,
        campaignId: input.campaignId ?? null,
        deliverableId: input.deliverableId ?? null,
        opportunityId: input.opportunityId ?? null,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  async renameContent(organizationId: string, contentId: string, title: string): Promise<CreatorContent | null> {
    const existing = await this.prisma.creatorContent.findFirst({ where: { organizationId, id: contentId }, select: { id: true } });
    if (!existing) return null;
    return this.prisma.creatorContent.update({ where: { id: existing.id }, data: { title } });
  }

  async attachContext(
    organizationId: string,
    contentId: string,
    ctx: { campaignId?: string | null; deliverableId?: string | null; opportunityId?: string | null },
  ): Promise<CreatorContent | null> {
    const existing = await this.prisma.creatorContent.findFirst({ where: { organizationId, id: contentId }, select: { id: true } });
    if (!existing) return null;
    return this.prisma.creatorContent.update({ where: { id: existing.id }, data: ctx });
  }

  async listContents(organizationId: string, creatorProfileId: string): Promise<ContentWithLineage[]> {
    return this.prisma.creatorContent.findMany({
      where: { organizationId, creatorProfileId, archivedAt: null },
      orderBy: { createdAt: 'desc' },
      include: this.lineageInclude(),
    });
  }

  async listContentsForOrganization(organizationId: string, limit = 200): Promise<ContentWithLineage[]> {
    return this.prisma.creatorContent.findMany({
      where: { organizationId, archivedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: this.lineageInclude(),
    });
  }

  async getContent(organizationId: string, contentId: string): Promise<ContentWithLineage | null> {
    return this.prisma.creatorContent.findFirst({
      where: { organizationId, id: contentId },
      include: this.lineageInclude(),
    });
  }

  private lineageInclude() {
    return {
      versions: {
        orderBy: { number: 'asc' as const },
        include: { approvals: { orderBy: { approvedAt: 'asc' as const } }, publications: { orderBy: { publishedAt: 'asc' as const } } },
      },
      productions: { orderBy: { number: 'asc' as const } },
      creatorProfile: true,
    };
  }

  /**
   * Reserve the next version of a piece of content: a PENDING row whose storage key
   * is built from ids this repository owns, never from a caller. The bytes are
   * confirmed by `markVersionReady` after the upload is verified in storage.
   */
  async beginVersion(input: BeginVersionInput): Promise<ContentVersion> {
    return this.prisma.$transaction(async (tx) => {
      const content = await tx.creatorContent.findFirst({
        where: { organizationId: input.organizationId, id: input.contentId },
        select: { id: true, creatorProfileId: true },
      });
      if (!content) throw new Error('Content not found');
      const last = await tx.contentVersion.findFirst({ where: { contentId: content.id }, orderBy: { number: 'desc' }, select: { number: true } });
      const number = last ? last.number + 1 : 0;
      if (number === 0 && input.kind !== 'ORIGINAL') throw new Error('The first version of a piece of content is its Original');
      if (number > 0 && input.kind === 'ORIGINAL') throw new Error('A piece of content has one Original');
      const id = cuidLike();
      const storageKey = `${MEDIA_KEY_PREFIX}${input.organizationId.toLowerCase()}/${content.creatorProfileId.toLowerCase()}/${content.id.toLowerCase()}/${id.toLowerCase()}.${mediaExtensionOf(input.contentType)}`;
      return tx.contentVersion.create({
        data: {
          id,
          organizationId: input.organizationId,
          contentId: content.id,
          number,
          label: versionLabel(number),
          kind: input.kind,
          storageKey,
          contentType: input.contentType,
          fileName: input.fileName ?? null,
          uploadState: 'PENDING',
          uploadedByUserId: input.uploadedByUserId,
          uploadedByKind: input.uploadedByKind,
          producedByWorkInstanceId: input.producedByWorkInstanceId ?? null,
          answersInstructionId: input.answersInstructionId ?? null,
          noteToCreator: input.noteToCreator ?? null,
          internalNote: input.internalNote ?? null,
          visibleToCreator: input.visibleToCreator ?? true,
        },
      });
    });
  }

  async getVersion(organizationId: string, versionId: string): Promise<(ContentVersion & { content: CreatorContent }) | null> {
    return this.prisma.contentVersion.findFirst({ where: { organizationId, id: versionId }, include: { content: true } });
  }

  async markVersionReady(organizationId: string, versionId: string, facts: VersionReadyInput): Promise<ContentVersion | null> {
    const existing = await this.prisma.contentVersion.findFirst({ where: { organizationId, id: versionId }, select: { id: true, contentType: true } });
    if (!existing) return null;
    return this.prisma.contentVersion.update({
      where: { id: existing.id },
      data: {
        uploadState: 'READY',
        readyAt: new Date(),
        byteSize: facts.byteSize,
        contentType: facts.contentType ?? existing.contentType,
        durationSeconds: facts.durationSeconds ?? null,
        width: facts.width ?? null,
        height: facts.height ?? null,
        clientFacts: facts.clientFacts ?? {},
      },
    });
  }

  async markVersionFailed(organizationId: string, versionId: string): Promise<ContentVersion | null> {
    const existing = await this.prisma.contentVersion.findFirst({ where: { organizationId, id: versionId }, select: { id: true } });
    if (!existing) return null;
    return this.prisma.contentVersion.update({ where: { id: existing.id }, data: { uploadState: 'FAILED' } });
  }

  async setVersionVisibility(organizationId: string, versionId: string, visibleToCreator: boolean, noteToCreator?: string | null): Promise<ContentVersion | null> {
    const existing = await this.prisma.contentVersion.findFirst({ where: { organizationId, id: versionId }, select: { id: true } });
    if (!existing) return null;
    return this.prisma.contentVersion.update({
      where: { id: existing.id },
      data: { visibleToCreator, ...(noteToCreator !== undefined ? { noteToCreator } : {}) },
    });
  }

  async setVersionProvenance(
    organizationId: string,
    versionId: string,
    provenance: { producedByWorkInstanceId?: string | null; answersInstructionId?: string | null },
  ): Promise<ContentVersion | null> {
    const existing = await this.prisma.contentVersion.findFirst({ where: { organizationId, id: versionId }, select: { id: true } });
    if (!existing) return null;
    return this.prisma.contentVersion.update({ where: { id: existing.id }, data: provenance });
  }

  // ---- marks: approvals and publications ----------------------------------------------------

  /** One mark per (version, requirement). A repeat returns the existing mark unchanged. */
  async recordApproval(input: RecordApprovalInput): Promise<ContentVersionApproval> {
    const version = await this.prisma.contentVersion.findFirst({
      where: { organizationId: input.organizationId, id: input.versionId, contentId: input.contentId },
      select: { id: true },
    });
    if (!version) throw new Error('Version not found');
    const existing = await this.prisma.contentVersionApproval.findFirst({ where: { versionId: version.id, requirementKey: input.requirementKey } });
    if (existing) return existing;
    return this.prisma.contentVersionApproval.create({
      data: {
        organizationId: input.organizationId,
        contentId: input.contentId,
        versionId: version.id,
        requirementKey: input.requirementKey,
        approverKind: input.approverKind,
        approvedByUserId: input.approvedByUserId,
        originatorLabel: input.originatorLabel ?? null,
        note: input.note ?? null,
      },
    });
  }

  async recordPublication(input: RecordPublicationInput): Promise<ContentPublication> {
    const version = await this.prisma.contentVersion.findFirst({
      where: { organizationId: input.organizationId, id: input.versionId, contentId: input.contentId },
      select: { id: true },
    });
    if (!version) throw new Error('Version not found');
    return this.prisma.contentPublication.create({
      data: {
        organizationId: input.organizationId,
        contentId: input.contentId,
        versionId: version.id,
        platform: input.platform,
        url: input.url ?? null,
        publishedAt: input.publishedAt,
        markedByUserId: input.markedByUserId,
      },
    });
  }

  // ---- productions ----------------------------------------------------------------------------

  async createProduction(input: CreateProductionInput, db: CreatorDb = this.prisma): Promise<ContentProduction> {
    const last = await db.contentProduction.findFirst({ where: { contentId: input.contentId }, orderBy: { number: 'desc' }, select: { number: true } });
    return db.contentProduction.create({
      data: {
        organizationId: input.organizationId,
        contentId: input.contentId,
        number: (last?.number ?? 0) + 1,
        kind: input.kind ?? 'EDIT',
        workInstanceId: input.workInstanceId,
        sourceVersionId: input.sourceVersionId,
        requestedByUserId: input.requestedByUserId,
        requestedReturnAt: input.requestedReturnAt ?? null,
      },
    });
  }

  async productionByWorkInstance(organizationId: string, workInstanceId: string): Promise<(ContentProduction & { content: ContentWithLineage }) | null> {
    return this.prisma.contentProduction.findFirst({
      where: { organizationId, workInstanceId },
      include: { content: { include: this.lineageInclude() } },
    });
  }

  async completeProduction(organizationId: string, productionId: string): Promise<ContentProduction | null> {
    const existing = await this.prisma.contentProduction.findFirst({ where: { organizationId, id: productionId }, select: { id: true } });
    if (!existing) return null;
    return this.prisma.contentProduction.update({ where: { id: existing.id }, data: { completedAt: new Date() } });
  }

  async listProductionsForOrganization(organizationId: string): Promise<(ContentProduction & { content: CreatorContent & { creatorProfile: CreatorProfile } })[]> {
    return this.prisma.contentProduction.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: { content: { include: { creatorProfile: true } } },
    });
  }

  // ---- evidence -------------------------------------------------------------------------------

  async listPerformance(
    organizationId: string,
    creatorProfileId: string,
    filter: { contentId?: string; platform?: string; since?: Date } = {},
  ): Promise<CreatorPerformanceSnapshot[]> {
    return this.prisma.creatorPerformanceSnapshot.findMany({
      where: {
        organizationId,
        creatorProfileId,
        ...(filter.contentId ? { contentId: filter.contentId } : {}),
        ...(filter.platform ? { platform: filter.platform } : {}),
        ...(filter.since ? { windowEnd: { gte: filter.since } } : {}),
      },
      orderBy: { windowEnd: 'asc' },
    });
  }

  async listAudience(organizationId: string, creatorProfileId: string): Promise<CreatorAudienceSnapshot[]> {
    return this.prisma.creatorAudienceSnapshot.findMany({ where: { organizationId, creatorProfileId }, orderBy: { observedAt: 'asc' } });
  }

  async listCompensation(organizationId: string, creatorProfileId: string): Promise<CreatorCompensationEntry[]> {
    return this.prisma.creatorCompensationEntry.findMany({ where: { organizationId, creatorProfileId }, orderBy: { occurredAt: 'desc' } });
  }

  async addPerformance(data: Prisma.CreatorPerformanceSnapshotUncheckedCreateInput): Promise<CreatorPerformanceSnapshot> {
    return this.prisma.creatorPerformanceSnapshot.create({ data });
  }

  async addAudience(data: Prisma.CreatorAudienceSnapshotUncheckedCreateInput): Promise<CreatorAudienceSnapshot> {
    return this.prisma.creatorAudienceSnapshot.create({ data });
  }

  async addCompensation(data: Prisma.CreatorCompensationEntryUncheckedCreateInput): Promise<CreatorCompensationEntry> {
    return this.prisma.creatorCompensationEntry.create({ data });
  }

  async countPerformance(organizationId: string, creatorProfileId: string): Promise<number> {
    return this.prisma.creatorPerformanceSnapshot.count({ where: { organizationId, creatorProfileId } });
  }
}

/** A collision-resistant lowercase id in the shape Prisma's cuid() produces, minted here so the storage key can carry it. */
function cuidLike(): string {
  return 'c' + randomBytes(12).toString('hex');
}

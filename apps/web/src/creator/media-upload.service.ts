// Uploads for creator media (Creator Hub, 2026-09-22). SERVER ONLY.
//
// THE BYTES NEVER CROSS THIS TIER. `beginUpload` reserves a PENDING version row (the key is
// minted from row ids, never taken from the caller), asks storage for a short-lived PUT URL,
// and hands both back; the browser uploads straight to storage. `completeUpload` asks storage
// whether the object exists and how big it is, and only then marks the version READY. A
// version nobody confirmed stays PENDING and is never shown as content.
//
// WHO MAY UPLOAD WHAT. A creator uploads an Original for their own new content. EMG uploads an
// Edit against a production's work item: an ADMIN on any Edit step, an EMPLOYEE only on one
// assigned to them. Nothing here reads an organization or a person from the request.

import 'server-only';

import { MEDIA_SIZE_LIMITS, mediaKindOf, MediaStorageError, type MediaObjectStorage } from '@emgloop/providers';
import type { CreatorActor, CreatorDomain, EmgActor } from '@emgloop/database';

export type BeginUploadRequest =
  | { purpose: 'CREATOR_NEW_CONTENT'; title: string; kind: 'VIDEO' | 'PHOTO'; fileName: string; contentType: string; byteSize: number; deliverableId?: string | null }
  | { purpose: 'EMG_VERSION'; workInstanceId: string; fileName: string; contentType: string; byteSize: number; noteToCreator?: string | null; internalNote?: string | null; saveAsDraft?: boolean };

export type BeginUploadResult =
  | { ok: true; contentId: string; versionId: string; upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string } }
  | { ok: false; reason: 'NOT_CONFIGURED' | 'BAD_TYPE' | 'TOO_LARGE' | 'INVALID' | 'NOT_FOUND' | 'NOT_ALLOWED' | 'UNREACHABLE' | 'FAILED'; detail?: string };

export type CompleteUploadResult =
  | { ok: true; versionId: string; contentId: string; byteSize: number }
  | { ok: false; reason: 'NOT_CONFIGURED' | 'NOT_FOUND' | 'NOT_UPLOADED' | 'BAD_TYPE' | 'INVALID' | 'TOO_LARGE' | 'NOT_ALLOWED' | 'UNREACHABLE' | 'FAILED'; detail?: string };

function tooLarge(contentType: string, byteSize: number): boolean {
  const kind = mediaKindOf(contentType);
  if (!kind) return true;
  return byteSize > MEDIA_SIZE_LIMITS[kind];
}

function storageRefusal(e: unknown): BeginUploadResult & { ok: false } {
  if (e instanceof MediaStorageError) {
    if (e.reason === 'BAD_TYPE') return { ok: false, reason: 'BAD_TYPE' };
    if (e.reason === 'UNREACHABLE') return { ok: false, reason: 'UNREACHABLE' };
    if (e.reason === 'NOT_CONFIGURED') return { ok: false, reason: 'NOT_CONFIGURED' };
  }
  return { ok: false, reason: 'FAILED' };
}

/** Request-independent orchestration; the runtime supplies the same authorized domain. */
export function createMediaUploadService(domain: CreatorDomain) {
async function beginCreatorUpload(actor: CreatorActor, storage: MediaObjectStorage | null, input: Extract<BeginUploadRequest, { purpose: 'CREATOR_NEW_CONTENT' }>): Promise<BeginUploadResult> {
  if (!storage) return { ok: false, reason: 'NOT_CONFIGURED' };
  const title = input.title.trim().slice(0, 140);
  if (!title) return { ok: false, reason: 'INVALID', detail: 'Give it a name.' };
  const kind = mediaKindOf(input.contentType);
  if (!kind) return { ok: false, reason: 'BAD_TYPE' };
  if ((kind === 'video') !== (input.kind === 'VIDEO')) return { ok: false, reason: 'BAD_TYPE', detail: 'The file does not match the kind of content.' };
  if (!Number.isFinite(input.byteSize) || input.byteSize <= 0 || tooLarge(input.contentType, input.byteSize)) return { ok: false, reason: 'TOO_LARGE' };

  let context: { campaignId: string | null; deliverableId: string | null; opportunityId: string | null } = { campaignId: null, deliverableId: null, opportunityId: null };
  if (input.deliverableId) {
    const profile = await domain.creator.profileById(actor.organizationId, actor.creatorProfileId);
    const deliverable = await domain.commercial.getDeliverable(actor.organizationId, input.deliverableId);
    if (!profile || !deliverable || deliverable.creatorPartyId !== profile.partyId) return { ok: false, reason: 'NOT_FOUND', detail: 'That deliverable is not yours.' };
    if (deliverable.contentId) {
      // A reservation response may be lost after the server attached the content.
      // Only the same creator's same pending Original can be recovered this way.
      const existing = await domain.creator.getContent(actor.organizationId, deliverable.contentId);
      const original = existing?.versions.find(v => v.kind === 'ORIGINAL');
      if (existing?.creatorProfileId === actor.creatorProfileId && existing.title === title && original?.uploadState === 'PENDING' && original.uploadedByUserId === actor.userId && original.fileName === input.fileName.slice(0, 200) && original.contentType === input.contentType) {
        return resumeUpload({ ...actor, canActOnAny: false }, storage, original.id);
      }
      return { ok: false, reason: 'NOT_ALLOWED', detail: 'That deliverable already has content attached.' };
    }
    context = { campaignId: deliverable.campaignId, deliverableId: deliverable.id, opportunityId: deliverable.campaign.opportunityId };
  }

  const content = await domain.creator.createContent({
    organizationId: actor.organizationId,
    creatorProfileId: actor.creatorProfileId,
    title,
    kind: input.kind,
    ...context,
    createdByUserId: actor.userId,
  });
  const version = await domain.creator.beginVersion({
    organizationId: actor.organizationId,
    contentId: content.id,
    kind: 'ORIGINAL',
    contentType: input.contentType,
    fileName: input.fileName.slice(0, 200),
    uploadedByUserId: actor.userId,
    uploadedByKind: 'CREATOR',
  });
  try {
    const upload = await storage.createUploadUrl({ key: version.storageKey, contentType: input.contentType });
    if (context.deliverableId) await domain.commercial.attachDeliverableContent(actor.organizationId, context.deliverableId, content.id);
    return { ok: true, contentId: content.id, versionId: version.id, upload: { url: upload.url, method: 'PUT', headers: { ...upload.headers }, expiresAt: upload.expiresAt } };
  } catch (e) {
    await domain.creator.markVersionFailed(actor.organizationId, version.id);
    return storageRefusal(e);
  }
}

async function beginEmgUpload(actor: EmgActor, storage: MediaObjectStorage | null, input: Extract<BeginUploadRequest, { purpose: 'EMG_VERSION' }>): Promise<BeginUploadResult> {
  if (!storage) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!mediaKindOf(input.contentType)) return { ok: false, reason: 'BAD_TYPE' };
  if (!Number.isFinite(input.byteSize) || input.byteSize <= 0 || tooLarge(input.contentType, input.byteSize)) return { ok: false, reason: 'TOO_LARGE' };
  const production = await domain.creator.productionByWorkInstance(actor.organizationId, input.workInstanceId);
  if (!production) return { ok: false, reason: 'NOT_FOUND' };
  const instance = await domain.records.productionForWork(actor.organizationId, input.workInstanceId);
  if (!instance) return { ok: false, reason: 'NOT_FOUND' };
  const current = instance.production.currentStep;
  if (instance.production.workStatus !== 'active' || !current || current.kind !== 'EDIT') return { ok: false, reason: 'NOT_ALLOWED', detail: 'This production is not on an Edit step.' };
  if (!actor.canActOnAnyStep && current.owner?.userId !== actor.userId) return { ok: false, reason: 'NOT_ALLOWED', detail: 'This step is not assigned to you.' };
  const version = await domain.creator.beginVersion({
    organizationId: actor.organizationId,
    contentId: production.contentId,
    kind: 'EDIT',
    contentType: input.contentType,
    fileName: input.fileName.slice(0, 200),
    uploadedByUserId: actor.userId,
    uploadedByKind: 'EMG',
    producedByWorkInstanceId: input.workInstanceId,
    noteToCreator: input.noteToCreator?.trim() || null,
    internalNote: input.internalNote?.trim() || null,
    // A version is EMG-only until it is returned for review; a draft stays so.
    visibleToCreator: false,
  });
  try {
    const upload = await storage.createUploadUrl({ key: version.storageKey, contentType: input.contentType });
    return { ok: true, contentId: production.contentId, versionId: version.id, upload: { url: upload.url, method: 'PUT', headers: { ...upload.headers }, expiresAt: upload.expiresAt } };
  } catch (e) {
    await domain.creator.markVersionFailed(actor.organizationId, version.id);
    return storageRefusal(e);
  }
}

/** Confirm a version's bytes in storage and mark it READY. The facts the browser read travel as facts "read in the uploader's browser". */
async function completeUpload(
  who: { organizationId: string; userId: string; canActOnAny: boolean },
  storage: MediaObjectStorage | null,
  versionId: string,
  facts: { durationSeconds?: number | null; width?: number | null; height?: number | null },
): Promise<CompleteUploadResult> {
  if (!storage) return { ok: false, reason: 'NOT_CONFIGURED' };
  const version = await domain.creator.getVersion(who.organizationId, versionId);
  if (!version) return { ok: false, reason: 'NOT_FOUND' };
  if (!who.canActOnAny && version.uploadedByUserId !== who.userId) return { ok: false, reason: 'NOT_ALLOWED' };
  if (version.uploadState === 'READY') return { ok: true, versionId: version.id, contentId: version.contentId, byteSize: version.byteSize ?? 0 };
  if (version.uploadState !== 'PENDING') return { ok: false, reason: 'NOT_ALLOWED' };
  let head;
  try {
    head = await storage.head(version.storageKey);
  } catch (e) {
    return e instanceof MediaStorageError && e.reason === 'UNREACHABLE' ? { ok: false, reason: 'UNREACHABLE' } : { ok: false, reason: 'FAILED' };
  }
  if (!head.exists) return { ok: false, reason: 'NOT_UPLOADED' };
  const actualType = (head.contentType ?? version.contentType).toLowerCase().trim();
  const refusal = !Number.isSafeInteger(head.size) || head.size <= 0 ? 'INVALID'
    : !mediaKindOf(actualType) || actualType !== version.contentType.toLowerCase().trim() ? 'BAD_TYPE'
    : tooLarge(actualType, head.size) ? 'TOO_LARGE' : null;
  if (refusal) {
    await domain.creator.markVersionFailed(who.organizationId, version.id);
    try {
      await storage.delete(version.storageKey);
    } catch {
      // Best effort: a failed version's bytes are unreachable through Loop either way.
    }
    return { ok: false, reason: refusal };
  }
  const clean = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
  await domain.creator.markVersionReady(who.organizationId, version.id, {
    byteSize: head.size,
    contentType: actualType,
    durationSeconds: clean(facts.durationSeconds),
    width: clean(facts.width) === null ? null : Math.round(clean(facts.width)!),
    height: clean(facts.height) === null ? null : Math.round(clean(facts.height)!),
    clientFacts: { readIn: 'browser', durationSeconds: clean(facts.durationSeconds), width: clean(facts.width), height: clean(facts.height) },
  });
  return { ok: true, versionId: version.id, contentId: version.contentId, byteSize: head.size };
}

/** Whether this session may play a version: the creator who owns it (and may see it), or EMG. */
async function mayPlayVersion(
  who: { organizationId: string; creator: CreatorActor | null; emg: boolean },
  versionId: string,
): Promise<{ key: string } | null> {
  const version = await domain.creator.getVersion(who.organizationId, versionId);
  if (!version || version.uploadState !== 'READY') return null;
  if (who.emg) return { key: version.storageKey };
  if (who.creator && version.content.creatorProfileId === who.creator.creatorProfileId && version.visibleToCreator) return { key: version.storageKey };
  return null;
}

/** Renew only a pending upload. Recheck ownership and the editor's current assignment. */
async function resumeUpload(
  who: { organizationId: string; userId: string; creatorProfileId: string | null; canActOnAny: boolean },
  storage: MediaObjectStorage | null,
  versionId: string,
): Promise<BeginUploadResult> {
  if (!storage) return { ok: false, reason: 'NOT_CONFIGURED' };
  const version = await domain.creator.getVersion(who.organizationId, versionId);
  if (!version) return { ok: false, reason: 'NOT_FOUND' };
  if (version.uploadedByUserId !== who.userId) return { ok: false, reason: 'NOT_FOUND' };
  if (version.uploadState !== 'PENDING') return { ok: false, reason: 'NOT_ALLOWED' };
  if (version.uploadedByKind === 'CREATOR') {
    if (!who.creatorProfileId || version.content.creatorProfileId !== who.creatorProfileId) return { ok: false, reason: 'NOT_FOUND' };
  } else {
    if (who.creatorProfileId || !version.producedByWorkInstanceId) return { ok: false, reason: 'NOT_ALLOWED' };
    const work = await domain.records.productionForWork(who.organizationId, version.producedByWorkInstanceId);
    const step = work?.production.currentStep;
    if (!work || work.production.workStatus !== 'active' || step?.kind !== 'EDIT' || (!who.canActOnAny && step.owner?.userId !== who.userId)) return { ok: false, reason: 'NOT_ALLOWED' };
  }
  try {
    const upload = await storage.createUploadUrl({ key: version.storageKey, contentType: version.contentType });
    return { ok: true, contentId: version.contentId, versionId: version.id, upload: { ...upload, headers: { ...upload.headers } } };
  } catch (e) {
    return storageRefusal(e);
  }
}

return { beginCreatorUpload, beginEmgUpload, completeUpload, resumeUpload, mayPlayVersion };
}

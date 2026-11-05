import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CreatorDomain } from '@emgloop/database';
import { MediaStorageError, type MediaObjectStorage, type MediaHead } from '@emgloop/providers';
import { createMediaUploadService } from '../src/creator/media-upload.service';

function fixture() {
  const version = { id: 'version', organizationId: 'org', contentId: 'content', storageKey: 'media/org/creator/content/version.mp4', contentType: 'video/mp4', uploadedByUserId: 'u', uploadedByKind: 'CREATOR', kind: 'ORIGINAL', fileName: 'video.mp4', uploadState: 'PENDING', producedByWorkInstanceId: null as string | null, content: { creatorProfileId: 'creator' }, byteSize: null as number | null };
  const state = { signs: 0, created: 0, ready: 0, failed: 0, deleted: 0, attached: 0, signFails: false, headFails: false, head: { exists: true, size: 1024, contentType: 'video/mp4' } as MediaHead, step: { owner: { userId: 'u' }, kind: 'EDIT' }, workStatus: 'active' };
  const domain = {
    creator: {
      getVersion: async (org: string, id: string) => org === 'org' && id === version.id ? version : null,
      profileById: async () => ({ partyId: 'party' }),
      createContent: async () => { state.created++; return { id: version.contentId }; },
      getContent: async () => ({ id: version.contentId, creatorProfileId: 'creator', title: 'Video', versions: [version] }),
      beginVersion: async () => version,
      markVersionFailed: async () => { state.failed++; version.uploadState = 'FAILED'; },
      markVersionReady: async (_org: string, _id: string, facts: { byteSize: number }) => { state.ready++; version.uploadState = 'READY'; version.byteSize = facts.byteSize; return version; },
    },
    commercial: {
      getDeliverable: async () => ({ creatorPartyId: 'party', contentId: state.attached ? version.contentId : null, id: 'd', campaignId: 'campaign', campaign: { opportunityId: 'opp' } }),
      attachDeliverableContent: async () => { state.attached++; },
    },
    records: { productionForWork: async () => ({ production: { currentStep: state.step, workStatus: state.workStatus } }) },
  } as unknown as CreatorDomain;
  const storage: MediaObjectStorage = {
    kind: 'local',
    createUploadUrl: async () => { state.signs++; if (state.signFails) throw new MediaStorageError('UNREACHABLE'); return { url: 'https://storage.example.test/put', method: 'PUT', headers: { 'content-type': 'video/mp4' }, expiresAt: '2026-11-06T12:00:00Z' }; },
    createDownloadUrl: async () => ({ url: 'https://storage.example.test/get', expiresAt: '' }),
    head: async () => { if (state.headFails) throw new MediaStorageError('UNREACHABLE'); return state.head; },
    delete: async () => { state.deleted++; },
  };
  return { version, state, storage, service: createMediaUploadService(domain) };
}
const who = { organizationId: 'org', userId: 'u', creatorProfileId: 'creator', canActOnAny: false };

test('expired-link recovery signs the same pending version without creating another record', async () => {
  const f = fixture();
  const result = await f.service.resumeUpload(who, f.storage, 'version');
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.versionId, 'version'); assert.equal(result.contentId, 'content'); }
  assert.equal(f.state.signs, 1);
  assert.equal(f.state.attached, 0);
});

test('recovery refuses another organization, uploader, or reassigned creator profile before signing', async () => {
  for (const actor of [{ ...who, organizationId: 'other' }, { ...who, userId: 'other' }, { ...who, creatorProfileId: 'other' }]) {
    const f = fixture();
    assert.deepEqual(await f.service.resumeUpload(actor, f.storage, 'version'), { ok: false, reason: 'NOT_FOUND' });
    assert.equal(f.state.signs, 0);
  }
});

test('recovery cannot overwrite a ready or rejected file', async () => {
  for (const status of ['READY', 'FAILED']) {
    const f = fixture(); f.version.uploadState = status;
    assert.deepEqual(await f.service.resumeUpload(who, f.storage, 'version'), { ok: false, reason: 'NOT_ALLOWED' });
    assert.equal(f.state.signs, 0);
  }
});

test('editor recovery rechecks the current step and assignment', async () => {
  const f = fixture(); f.version.uploadedByKind = 'EMG'; f.version.producedByWorkInstanceId = 'work';
  const editor = { ...who, creatorProfileId: null };
  f.state.step.owner.userId = 'other';
  assert.deepEqual(await f.service.resumeUpload(editor, f.storage, 'version'), { ok: false, reason: 'NOT_ALLOWED' });
  f.state.step.owner.userId = 'u'; f.state.step.kind = 'CREATOR_REVIEW';
  assert.equal((await f.service.resumeUpload(editor, f.storage, 'version')).ok, false);
  f.state.step.kind = 'EDIT'; f.state.workStatus = 'complete';
  assert.equal((await f.service.resumeUpload(editor, f.storage, 'version')).ok, false);
  f.state.workStatus = 'active';
  assert.equal((await f.service.resumeUpload(editor, f.storage, 'version')).ok, true);
});

test('failed signing leaves the deliverable free for a fresh attempt', async () => {
  const f = fixture(); f.state.signFails = true;
  const result = await f.service.beginCreatorUpload({ organizationId: 'org', userId: 'u', creatorProfileId: 'creator' }, f.storage, { purpose: 'CREATOR_NEW_CONTENT', title: 'Video', kind: 'VIDEO', fileName: 'video.mp4', contentType: 'video/mp4', byteSize: 1024, deliverableId: 'd' });
  assert.deepEqual(result, { ok: false, reason: 'UNREACHABLE' });
  assert.equal(f.state.attached, 0);
  assert.equal(f.state.failed, 1);
});

test('empty, oversized and mismatched stored objects are withheld and discarded', async () => {
  for (const [size, contentType, reason] of [[0, 'video/mp4', 'INVALID'], [3 * 1024 ** 3, 'video/mp4', 'TOO_LARGE'], [1024, 'text/html', 'BAD_TYPE'], [1024, 'image/png', 'BAD_TYPE']] as const) {
    const f = fixture(); f.state.head = { exists: true, size, contentType };
    assert.deepEqual(await f.service.completeUpload(who, f.storage, 'version', {}), { ok: false, reason });
    assert.equal(f.state.ready, 0); assert.equal(f.state.failed, 1); assert.equal(f.state.deleted, 1);
  }
});

test('temporary storage failures preserve the pending upload; confirmed uploads are idempotent', async () => {
  const f = fixture(); f.state.headFails = true;
  assert.deepEqual(await f.service.completeUpload(who, f.storage, 'version', {}), { ok: false, reason: 'UNREACHABLE' });
  assert.equal(f.version.uploadState, 'PENDING');
  f.state.headFails = false;
  assert.equal((await f.service.completeUpload(who, f.storage, 'version', {})).ok, true);
  assert.equal((await f.service.completeUpload(who, f.storage, 'version', {})).ok, true);
  assert.equal(f.state.ready, 1);
});

test('a failed upload cannot be resurrected through completion, and another uploader cannot confirm it', async () => {
  const f = fixture(); f.version.uploadState = 'FAILED';
  assert.deepEqual(await f.service.completeUpload(who, f.storage, 'version', {}), { ok: false, reason: 'NOT_ALLOWED' });
  assert.deepEqual(await f.service.completeUpload({ ...who, userId: 'other' }, f.storage, 'version', {}), { ok: false, reason: 'NOT_ALLOWED' });
  assert.equal(f.state.ready, 0);
});


test('a lost reservation response for a deliverable recovers the existing pending Original', async () => {
  const f = fixture();
  const input = { purpose: 'CREATOR_NEW_CONTENT', title: 'Video', kind: 'VIDEO', fileName: 'video.mp4', contentType: 'video/mp4', byteSize: 1024, deliverableId: 'd' } as const;
  const actor = { organizationId: 'org', userId: 'u', creatorProfileId: 'creator' };
  assert.equal((await f.service.beginCreatorUpload(actor, f.storage, input)).ok, true);
  assert.equal((await f.service.beginCreatorUpload(actor, f.storage, input)).ok, true);
  assert.equal(f.state.created, 1);
  assert.equal(f.state.attached, 1);
  const other = await f.service.beginCreatorUpload(actor, f.storage, { ...input, fileName: 'different.mp4' });
  assert.equal(other.ok, false);
  assert.equal(f.state.created, 1);
});

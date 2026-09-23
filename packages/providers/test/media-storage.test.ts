// The media storage contract: keys are validated, types are refused before a URL exists, the
// signer adapter signs every call with the worker control scheme, and the local adapter's URLs
// carry a verifiable, expiring token.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared';
import {
  SignerMediaStorage,
  LocalMediaStorage,
  MediaStorageError,
  isValidMediaKey,
  mediaKindOf,
  mediaExtensionOf,
  verifyLocalMediaToken,
  localMediaPath,
} from '../src/storage/media-storage';

const NOW = new Date('2026-09-22T12:00:00Z');

test('keys: only the media prefix, lowercase ids, no traversal', () => {
  assert.equal(isValidMediaKey('media/org1/cp1/c1/v1.mp4'), true);
  assert.equal(isValidMediaKey('media/../etc/passwd'), false);
  assert.equal(isValidMediaKey('media//x'), false);
  assert.equal(isValidMediaKey('Media/x'), false);
  assert.equal(isValidMediaKey('other/x'), false);
  assert.equal(isValidMediaKey('media/'), false);
});

test('content types: images and videos the product accepts, nothing else', () => {
  assert.equal(mediaKindOf('image/jpeg'), 'image');
  assert.equal(mediaKindOf('VIDEO/MP4'), 'video');
  assert.equal(mediaKindOf('application/pdf'), null);
  assert.equal(mediaExtensionOf('video/quicktime'), 'mov');
});

test('signer adapter: signs the body with the worker scheme and maps each op', async () => {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    const headers = init?.headers as Record<string, string>;
    calls.push({ url: String(url), body, headers });
    const parsed = JSON.parse(body) as { op: string; key: string; contentType?: string };
    const answer =
      parsed.op === 'put'
        ? { ok: true, op: 'put', url: 'https://bucket/put', method: 'PUT', headers: { 'content-type': parsed.contentType }, expiresAt: '2026-09-22T12:15:00.000Z' }
        : parsed.op === 'get'
          ? { ok: true, op: 'get', url: 'https://bucket/get', expiresAt: '2026-09-22T12:15:00.000Z' }
          : parsed.op === 'head'
            ? { ok: true, op: 'head', exists: true, size: 1234, contentType: 'video/mp4' }
            : { ok: true, op: 'delete' };
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const storage = new SignerMediaStorage({ signerUrl: 'https://api.example/media/sign', secret: 's3cret', fetch: fetchFake, now: () => NOW });

  const put = await storage.createUploadUrl({ key: 'media/o/c/x/v0.mp4', contentType: 'video/mp4' });
  assert.equal(put.url, 'https://bucket/put');
  assert.equal(put.method, 'PUT');
  assert.equal(put.headers['content-type'], 'video/mp4');
  const first = calls[0]!;
  assert.equal(first.url, 'https://api.example/media/sign');
  assert.equal(
    verifyWorkerRequest('s3cret', { body: first.body, signature: first.headers[WORKER_SIGNATURE_HEADER], timestamp: first.headers[WORKER_TIMESTAMP_HEADER], now: NOW }),
    true,
    'signed with the worker control scheme',
  );
  assert.deepEqual(JSON.parse(first.body), { op: 'put', key: 'media/o/c/x/v0.mp4', contentType: 'video/mp4', expiresSeconds: 900 });

  const get = await storage.createDownloadUrl({ key: 'media/o/c/x/v0.mp4' });
  assert.equal(get.url, 'https://bucket/get');
  const head = await storage.head('media/o/c/x/v0.mp4');
  assert.deepEqual(head, { exists: true, size: 1234, contentType: 'video/mp4' });
  await storage.delete('media/o/c/x/v0.mp4');
  assert.equal(calls.length, 4);
});

test('signer adapter: refuses bad keys and types before any call, and maps refusals', async () => {
  let called = 0;
  const fetchFake = (async () => {
    called++;
    return new Response('{}', { status: 401 });
  }) as unknown as typeof fetch;
  const storage = new SignerMediaStorage({ signerUrl: 'https://api.example/media/sign', secret: 's', fetch: fetchFake, now: () => NOW });
  await assert.rejects(storage.createUploadUrl({ key: 'bad', contentType: 'video/mp4' }), (e: MediaStorageError) => e.reason === 'BAD_KEY');
  await assert.rejects(storage.createUploadUrl({ key: 'media/x', contentType: 'text/plain' }), (e: MediaStorageError) => e.reason === 'BAD_TYPE');
  assert.equal(called, 0, 'nothing was sent');
  await assert.rejects(storage.createDownloadUrl({ key: 'media/x' }), (e: MediaStorageError) => e.reason === 'REJECTED');
  const unreachable = new SignerMediaStorage({ signerUrl: 'https://api.example/media/sign', secret: 's', fetch: (async () => { throw new Error('boom'); }) as unknown as typeof fetch });
  await assert.rejects(unreachable.head('media/x'), (e: MediaStorageError) => e.reason === 'UNREACHABLE');
});

test('local adapter: mints route URLs with an expiring HMAC token the route can verify', async () => {
  const storage = new LocalMediaStorage({ directory: '/tmp/loop-media', routePath: '/api/creator/media/local', secret: 'dev', now: () => NOW });
  const put = await storage.createUploadUrl({ key: 'media/o/c/x/v0.jpg', contentType: 'image/jpeg' });
  const u = new URL(put.url, 'http://localhost');
  assert.equal(u.pathname, '/api/creator/media/local');
  const key = u.searchParams.get('key')!;
  const exp = Number(u.searchParams.get('exp'));
  const token = u.searchParams.get('token');
  assert.equal(key, 'media/o/c/x/v0.jpg');
  assert.equal(exp, NOW.getTime() + 900_000);
  assert.equal(verifyLocalMediaToken('dev', 'put', key, exp, token, NOW), true);
  assert.equal(verifyLocalMediaToken('dev', 'get', key, exp, token, NOW), false, 'op is part of the token');
  assert.equal(verifyLocalMediaToken('dev', 'put', key, exp, token, new Date(exp + 1)), false, 'expired');
  assert.equal(verifyLocalMediaToken('other', 'put', key, exp, token, NOW), false, 'wrong secret');
  assert.equal(localMediaPath('/tmp/loop-media/', key), '/tmp/loop-media/media/o/c/x/v0.jpg');
  assert.throws(() => localMediaPath('/tmp/loop-media', 'media/../x'), /BAD_KEY/);
  const missing = await storage.head('media/o/c/x/does-not-exist.jpg');
  assert.deepEqual(missing, { exists: false });
});

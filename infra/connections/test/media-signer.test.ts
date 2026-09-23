// The media signer handler, against fake seams: it honours only bodies signed with the worker
// control scheme, mints URLs only for valid keys and accepted types under the prefix, maps S3's
// not-found to `exists:false`, and never leaks a failure message. The contract it answers is the
// one packages/providers/src/storage/media-storage.ts (SignerMediaStorage) sends.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { signWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER, WORKER_SIGNATURE_TOLERANCE_MS } from '@emgloop/shared';

import { createHandler, isValidMediaKey, parseSignerRequest, MEDIA_SIGNER_CONTENT_TYPES, type MediaSignerDeps } from '../lambda/media-signer';

const NOW = new Date('2026-09-22T12:00:00Z');
const SECRET = 'worker-control-secret-for-tests';
const KEY = 'media/org1/cp1/c1/v1.mp4';

type Call = { fn: string; args: unknown[] };

function fakeDeps(overrides: Partial<MediaSignerDeps['s3']> = {}): { deps: MediaSignerDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: MediaSignerDeps = {
    keyPrefix: 'media/',
    now: () => NOW,
    secret: async () => SECRET,
    s3: {
      presignPut: async (key, contentType, expiresSeconds) => {
        calls.push({ fn: 'presignPut', args: [key, contentType, expiresSeconds] });
        return `https://bucket.s3.amazonaws.com/${key}?X-Amz-Expires=${expiresSeconds}&put`;
      },
      presignGet: async (key, expiresSeconds) => {
        calls.push({ fn: 'presignGet', args: [key, expiresSeconds] });
        return `https://bucket.s3.amazonaws.com/${key}?X-Amz-Expires=${expiresSeconds}&get`;
      },
      head: async (key) => {
        calls.push({ fn: 'head', args: [key] });
        if (key.endsWith('missing.mp4')) return { exists: false };
        return { exists: true, size: 1234, contentType: 'video/mp4', etag: '"abc"', lastModified: '2026-09-22T11:00:00.000Z' };
      },
      delete: async (key) => {
        calls.push({ fn: 'delete', args: [key] });
      },
      ...overrides,
    },
  };
  return { deps, calls };
}

interface EventOptions {
  readonly secret?: string;
  readonly signedAt?: Date;
  readonly method?: string;
  readonly base64?: boolean;
  /** Replace the signature headers entirely (e.g. {} for an unsigned call). */
  readonly headers?: Record<string, string>;
}

/** An HTTP API v2 event for `POST /media/sign`, signed the way SignerMediaStorage signs. */
function event(body: string, options: EventOptions = {}): APIGatewayProxyEventV2 {
  const { signature, timestamp } = signWorkerRequest(options.secret ?? SECRET, body, options.signedAt ?? NOW);
  const headers = options.headers ?? { [WORKER_SIGNATURE_HEADER]: signature, [WORKER_TIMESTAMP_HEADER]: timestamp };
  const method = options.method ?? 'POST';
  return {
    version: '2.0',
    routeKey: `${method} /media/sign`,
    rawPath: '/media/sign',
    rawQueryString: '',
    headers: { 'content-type': 'application/json', ...headers },
    requestContext: {
      accountId: '065148797865',
      apiId: 'abc123',
      domainName: 'abc123.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'abc123',
      http: { method, path: '/media/sign', protocol: 'HTTP/1.1', sourceIp: '203.0.113.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: `${method} /media/sign`,
      stage: '$default',
      time: NOW.toISOString(),
      timeEpoch: NOW.getTime(),
    },
    body: options.base64 ? Buffer.from(body, 'utf8').toString('base64') : body,
    isBase64Encoded: options.base64 === true,
  };
}

const parse = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

test('every response is JSON and uncacheable', async () => {
  const { deps } = fakeDeps();
  const handler = createHandler(deps);
  for (const res of [await handler(event('{}')), await handler(event('{}', { headers: {} })), await handler(event('{}', { method: 'GET' }))]) {
    assert.equal(res.headers?.['content-type'], 'application/json');
    assert.equal(res.headers?.['cache-control'], 'no-store');
    assert.doesNotThrow(() => parse(res));
  }
});

test('only POST is accepted', async () => {
  const handler = createHandler(fakeDeps().deps);
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
    const res = await handler(event(JSON.stringify({ op: 'get', key: KEY }), { method }));
    assert.equal(res.statusCode, 405, method);
    assert.deepEqual(parse(res), { ok: false, reason: 'METHOD_NOT_ALLOWED' });
  }
});

test('unsigned, wrongly signed, tampered and stale calls are refused with 401 before the body is read', async () => {
  const { deps, calls } = fakeDeps();
  const handler = createHandler(deps);
  const body = JSON.stringify({ op: 'get', key: KEY });
  const refused = async (e: APIGatewayProxyEventV2, label: string) => {
    const res = await handler(e);
    assert.equal(res.statusCode, 401, label);
    assert.deepEqual(parse(res), { ok: false, reason: 'UNAUTHORIZED' }, label);
  };
  await refused(event(body, { headers: {} }), 'unsigned');
  await refused(event(body, { secret: 'not-the-secret' }), 'wrong secret');
  const { signature } = signWorkerRequest(SECRET, body, NOW);
  await refused(event(body, { headers: { [WORKER_SIGNATURE_HEADER]: signature, [WORKER_TIMESTAMP_HEADER]: String(NOW.getTime() + 1) } }), 'timestamp not the signed one');
  await refused(event(body + ' ', { headers: { [WORKER_SIGNATURE_HEADER]: signature, [WORKER_TIMESTAMP_HEADER]: String(NOW.getTime()) } }), 'body altered after signing');
  await refused(event(body, { signedAt: new Date(NOW.getTime() - WORKER_SIGNATURE_TOLERANCE_MS - 1) }), 'stale');
  await refused(event(body, { signedAt: new Date(NOW.getTime() + WORKER_SIGNATURE_TOLERANCE_MS + 1) }), 'from the future');
  assert.equal(calls.length, 0, 'nothing reached S3');
  // At the edge of the window it is still honoured.
  const res = await handler(event(body, { signedAt: new Date(NOW.getTime() - WORKER_SIGNATURE_TOLERANCE_MS) }));
  assert.equal(res.statusCode, 200);
});

test('a base64-encoded body (API Gateway) is decoded before verification and parsing', async () => {
  const { deps, calls } = fakeDeps();
  const handler = createHandler(deps);
  const res = await handler(event(JSON.stringify({ op: 'get', key: KEY }), { base64: true }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).op, 'get');
  assert.deepEqual(calls, [{ fn: 'presignGet', args: [KEY, 900] }]);
});

test('signature header lookup is case-insensitive (v2 lowercases; a proxy may not)', async () => {
  const handler = createHandler(fakeDeps().deps);
  const body = JSON.stringify({ op: 'head', key: KEY });
  const { signature, timestamp } = signWorkerRequest(SECRET, body, NOW);
  const res = await handler(event(body, { headers: { 'X-Loop-Worker-Signature': signature, 'X-Loop-Worker-Timestamp': timestamp } }));
  assert.equal(res.statusCode, 200);
});

test('a signed but malformed request is 400: bad JSON, unknown op, bad key, wrong prefix, bad type, bad expiry', async () => {
  const { deps, calls } = fakeDeps();
  const handler = createHandler(deps);
  const bad = async (body: string, label: string) => {
    const res = await handler(event(body));
    assert.equal(res.statusCode, 400, label);
    assert.deepEqual(parse(res), { ok: false, reason: 'BAD_REQUEST' }, label);
  };
  await bad('not json', 'bad json');
  await bad('[]', 'array body');
  await bad('null', 'null body');
  await bad(JSON.stringify({ op: 'list', key: KEY }), 'unknown op');
  await bad(JSON.stringify({ op: 'get' }), 'missing key');
  await bad(JSON.stringify({ op: 'get', key: 'media/../etc/passwd' }), 'traversal');
  await bad(JSON.stringify({ op: 'get', key: 'media//x' }), 'empty segment');
  await bad(JSON.stringify({ op: 'get', key: 'other/x' }), 'wrong prefix');
  await bad(JSON.stringify({ op: 'get', key: 'Media/x' }), 'uppercase prefix');
  await bad(JSON.stringify({ op: 'get', key: 'media/Org1/x' }), 'uppercase id');
  await bad(JSON.stringify({ op: 'get', key: 'media/' }), 'prefix only');
  await bad(JSON.stringify({ op: 'get', key: 'media/x y' }), 'space');
  await bad(JSON.stringify({ op: 'get', key: `media/${'a'.repeat(502)}` }), 'too long');
  await bad(JSON.stringify({ op: 'put', key: KEY }), 'put without a type');
  await bad(JSON.stringify({ op: 'put', key: KEY, contentType: 'application/pdf' }), 'disallowed type');
  await bad(JSON.stringify({ op: 'put', key: KEY, contentType: 'text/html' }), 'html is never media');
  await bad(JSON.stringify({ op: 'put', key: KEY, contentType: 'video/mp4', expiresSeconds: 901 }), 'put over 900s');
  await bad(JSON.stringify({ op: 'put', key: KEY, contentType: 'video/mp4', expiresSeconds: 0 }), 'zero expiry');
  await bad(JSON.stringify({ op: 'put', key: KEY, contentType: 'video/mp4', expiresSeconds: 1.5 }), 'fractional expiry');
  await bad(JSON.stringify({ op: 'put', key: KEY, contentType: 'video/mp4', expiresSeconds: '900' }), 'string expiry');
  await bad(JSON.stringify({ op: 'get', key: KEY, expiresSeconds: 3601 }), 'get over 3600s');
  assert.equal(calls.length, 0, 'nothing reached S3');
});

test('put: a presigned PUT for the key, the exact content-type the browser must send, expiring in 900s by default', async () => {
  const { deps, calls } = fakeDeps();
  const handler = createHandler(deps);
  const res = await handler(event(JSON.stringify({ op: 'put', key: KEY, contentType: 'video/mp4' })));
  assert.equal(res.statusCode, 200);
  const out = parse(res);
  assert.equal(out.ok, true);
  assert.equal(out.op, 'put');
  assert.equal(out.method, 'PUT');
  assert.equal(out.url, `https://bucket.s3.amazonaws.com/${KEY}?X-Amz-Expires=900&put`);
  assert.deepEqual(out.headers, { 'content-type': 'video/mp4' });
  assert.ok(new Date(out.expiresAt).getTime() <= NOW.getTime() + 900_000, 'expires no later than now + 900s');
  assert.equal(out.expiresAt, new Date(NOW.getTime() + 900_000).toISOString());
  assert.deepEqual(calls, [{ fn: 'presignPut', args: [KEY, 'video/mp4', 900] }]);
});

test('put: the type is normalized, every accepted type works, and a shorter expiry is honoured', async () => {
  const { deps, calls } = fakeDeps();
  const handler = createHandler(deps);
  const res = await handler(event(JSON.stringify({ op: 'put', key: 'media/o/c/x/v0.jpg', contentType: ' IMAGE/JPEG ', expiresSeconds: 60 })));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res).headers, { 'content-type': 'image/jpeg' });
  assert.equal(parse(res).expiresAt, new Date(NOW.getTime() + 60_000).toISOString());
  assert.deepEqual(calls.at(-1), { fn: 'presignPut', args: ['media/o/c/x/v0.jpg', 'image/jpeg', 60] });
  for (const contentType of MEDIA_SIGNER_CONTENT_TYPES) {
    const r = await handler(event(JSON.stringify({ op: 'put', key: KEY, contentType })));
    assert.equal(r.statusCode, 200, contentType);
  }
  assert.deepEqual([...MEDIA_SIGNER_CONTENT_TYPES], ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'video/mp4', 'video/quicktime', 'video/webm']);
});

test('get: a presigned GET, 900s by default, up to 3600s when asked', async () => {
  const { deps, calls } = fakeDeps();
  const handler = createHandler(deps);
  const byDefault = parse(await handler(event(JSON.stringify({ op: 'get', key: KEY }))));
  assert.deepEqual(byDefault, { ok: true, op: 'get', url: `https://bucket.s3.amazonaws.com/${KEY}?X-Amz-Expires=900&get`, expiresAt: new Date(NOW.getTime() + 900_000).toISOString() });
  const hour = parse(await handler(event(JSON.stringify({ op: 'get', key: KEY, expiresSeconds: 3600 }))));
  assert.equal(hour.url, `https://bucket.s3.amazonaws.com/${KEY}?X-Amz-Expires=3600&get`);
  assert.equal(hour.expiresAt, new Date(NOW.getTime() + 3_600_000).toISOString());
  assert.deepEqual(calls, [
    { fn: 'presignGet', args: [KEY, 900] },
    { fn: 'presignGet', args: [KEY, 3600] },
  ]);
});

test('head: an existing object reports its size and metadata; a missing one is exists:false, not an error', async () => {
  const handler = createHandler(fakeDeps().deps);
  const found = await handler(event(JSON.stringify({ op: 'head', key: KEY })));
  assert.equal(found.statusCode, 200);
  assert.deepEqual(parse(found), { ok: true, op: 'head', exists: true, size: 1234, contentType: 'video/mp4', etag: '"abc"', lastModified: '2026-09-22T11:00:00.000Z' });
  const missing = await handler(event(JSON.stringify({ op: 'head', key: 'media/org1/missing.mp4' })));
  assert.equal(missing.statusCode, 200);
  assert.deepEqual(parse(missing), { ok: true, op: 'head', exists: false });
});

test('delete: acknowledged, and ignores any expiry given', async () => {
  const { deps, calls } = fakeDeps();
  const handler = createHandler(deps);
  const res = await handler(event(JSON.stringify({ op: 'delete', key: KEY, expiresSeconds: 999999 })));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res), { ok: true, op: 'delete' });
  assert.deepEqual(calls, [{ fn: 'delete', args: [KEY] }]);
});

test('an S3 or secret failure is 500 FAILED: no message, no body, no secret in the response or the log', async () => {
  const detail = 'AccessDenied: arn:aws:s3:::something-internal';
  const { deps } = fakeDeps({
    presignPut: async () => {
      throw new Error(detail);
    },
  });
  const logged: string[] = [];
  const err = mock.method(console, 'error', (line: string) => {
    logged.push(String(line));
  });
  try {
    const handler = createHandler(deps);
    const body = JSON.stringify({ op: 'put', key: KEY, contentType: 'video/mp4' });
    const res = await handler(event(body));
    assert.equal(res.statusCode, 500);
    assert.deepEqual(parse(res), { ok: false, reason: 'FAILED' });
    assert.ok(!res.body!.includes('something-internal'));
    assert.equal(logged.length, 1);
    assert.ok(!logged[0]!.includes(detail) && !logged[0]!.includes(SECRET) && !logged[0]!.includes(body), 'the log carries the class of failure only');
    assert.deepEqual(JSON.parse(logged[0]!), { component: 'media-signer', outcome: 'FAILED', op: 'put', error: 'Error' });

    // An unreadable secret is also a plain 500, and the request is not even verified.
    const noSecret = createHandler({ ...deps, secret: async () => { throw new Error(SECRET); } });
    const r2 = await noSecret(event(body));
    assert.equal(r2.statusCode, 500);
    assert.deepEqual(parse(r2), { ok: false, reason: 'FAILED' });
    assert.ok(!logged.some((l) => l.includes(SECRET)));
  } finally {
    err.mock.restore();
  }
});

test('key and request validation helpers, in isolation', () => {
  assert.equal(isValidMediaKey('media/org1/cp1/c1/v1.mp4', 'media/'), true);
  assert.equal(isValidMediaKey('media/a', 'media/'), true);
  assert.equal(isValidMediaKey('media/../x', 'media/'), false);
  assert.equal(isValidMediaKey('media//x', 'media/'), false);
  assert.equal(isValidMediaKey('Media/x', 'media/'), false);
  assert.equal(isValidMediaKey('other/x', 'media/'), false);
  assert.equal(isValidMediaKey('media/', 'media/'), false);
  assert.equal(isValidMediaKey(42, 'media/'), false);
  // The prefix is the one knob: a different prefix moves the fence, it never widens it.
  assert.equal(isValidMediaKey('media/x', 'other/'), false);
  assert.equal(isValidMediaKey('other/x', 'other/'), true);
  assert.deepEqual(parseSignerRequest(JSON.stringify({ op: 'put', key: 'media/x', contentType: 'image/png' }), 'media/'), { op: 'put', key: 'media/x', contentType: 'image/png', expiresSeconds: 900 });
  assert.deepEqual(parseSignerRequest(JSON.stringify({ op: 'get', key: 'media/x', expiresSeconds: 3600 }), 'media/'), { op: 'get', key: 'media/x', expiresSeconds: 3600 });
  assert.equal(parseSignerRequest(JSON.stringify({ op: 'get', key: 'media/x', expiresSeconds: 3601 }), 'media/'), null);
});

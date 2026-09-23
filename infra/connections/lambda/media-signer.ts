// The media signer: short-lived presigned S3 URLs for creator media, minted for the Loop web tier.
//
// WHY THIS EXISTS. The web tier (Netlify) holds no AWS credential and imports no AWS SDK, yet the
// browser must upload creator media straight to a PRIVATE bucket and play it back. This function
// sits on the existing connections HTTP API (`POST /media/sign`) and answers exactly four questions
// about ONE key: where may a browser PUT it, where may a browser GET it, does it exist (and how
// big is it), and delete it. It owns no meaning -- which Content a key belongs to is the creator
// domain's, in the web tier (packages/providers/src/storage/media-storage.ts is the caller).
//
// WHO IT HONOURS. The same HMAC control scheme the web tier already uses to drive the connections
// worker (`verifyWorkerRequest` over `<timestamp>.<body>`, headers x-loop-worker-signature and
// x-loop-worker-timestamp), with the same generated secret (loop/connections/staging/worker-control).
// That signature authenticates a CLASS ("this is the Loop web tier"), not a tenant: the web tier
// resolves the organization from its signed session and builds keys from row ids it owns. Nothing
// unsigned, stale, or outside the `media/` prefix gets a URL. The function's IAM role can touch only
// objects under that prefix, so even a bug here cannot reach the rest of the bucket.
//
// TESTABLE BY CONSTRUCTION. `createHandler(deps)` takes the S3, secret and clock seams; the real
// deps are bound once at module load in `handler`. Nothing here logs a body, a URL or the secret.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
// The deep path (not the package index) keeps the bundle to the one pure module it needs.
import { verifyWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared/src/connection-worker-auth';

/** The upload types the product accepts; the same list as the web tier's MEDIA_CONTENT_TYPES. */
export const MEDIA_SIGNER_CONTENT_TYPES: readonly string[] = Object.freeze([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'video/webm',
]);

/** A PUT URL lives at most 15 minutes; a GET URL at most an hour. Both default to 15 minutes. */
export const MEDIA_SIGNER_LIMITS = Object.freeze({
  put: { default: 900, max: 900 },
  get: { default: 900, max: 3600 },
} as const);

export type MediaSignerOp = 'put' | 'get' | 'head' | 'delete';

export type MediaSignerHead =
  | { readonly exists: false }
  | { readonly exists: true; readonly size: number; readonly contentType: string | null; readonly etag: string | null; readonly lastModified: string | null };

export interface MediaSignerDeps {
  readonly s3: {
    presignPut(key: string, contentType: string, expiresSeconds: number): Promise<string>;
    presignGet(key: string, expiresSeconds: number): Promise<string>;
    head(key: string): Promise<MediaSignerHead>;
    delete(key: string): Promise<void>;
  };
  /** The worker-control secret; the real implementation caches it for the container lifetime. */
  readonly secret: () => Promise<string>;
  readonly now: () => Date;
  /** The only key prefix a URL is ever minted for (the IAM grant is scoped to the same prefix). */
  readonly keyPrefix: string;
}

type SignerResponse =
  | { ok: true; op: 'put'; url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string }
  | { ok: true; op: 'get'; url: string; expiresAt: string }
  | { ok: true; op: 'head'; exists: boolean; size?: number; contentType?: string | null; etag?: string | null; lastModified?: string | null }
  | { ok: true; op: 'delete' }
  | { ok: false; reason: 'UNAUTHORIZED' | 'BAD_REQUEST' | 'METHOD_NOT_ALLOWED' | 'FAILED' };

type ValidRequest =
  | { op: 'put'; key: string; contentType: string; expiresSeconds: number }
  | { op: 'get'; key: string; expiresSeconds: number }
  | { op: 'head'; key: string }
  | { op: 'delete'; key: string };

function respond(statusCode: number, body: SignerResponse): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** A key: the prefix, then a lowercase id path -- no traversal, no empty segments, bounded length. */
export function isValidMediaKey(key: unknown, keyPrefix: string): key is string {
  if (typeof key !== 'string' || !key.startsWith(keyPrefix)) return false;
  const pattern = new RegExp(`^${escapeRegExp(keyPrefix)}[a-z0-9][a-z0-9._/-]{0,500}$`);
  return pattern.test(key) && !key.includes('..') && !key.includes('//');
}

function expiresOf(raw: unknown, limits: { default: number; max: number }): number | null {
  if (raw === undefined) return limits.default;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > limits.max) return null;
  return raw;
}

/** Parse and validate a request body; null means BAD_REQUEST. Exported for the unit tests. */
export function parseSignerRequest(body: string, keyPrefix: string): ValidRequest | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (!isValidMediaKey(p.key, keyPrefix)) return null;
  const key = p.key;
  switch (p.op) {
    case 'put': {
      const contentType = typeof p.contentType === 'string' ? p.contentType.toLowerCase().trim() : '';
      if (!MEDIA_SIGNER_CONTENT_TYPES.includes(contentType)) return null;
      const expiresSeconds = expiresOf(p.expiresSeconds, MEDIA_SIGNER_LIMITS.put);
      if (expiresSeconds === null) return null;
      return { op: 'put', key, contentType, expiresSeconds };
    }
    case 'get': {
      const expiresSeconds = expiresOf(p.expiresSeconds, MEDIA_SIGNER_LIMITS.get);
      if (expiresSeconds === null) return null;
      return { op: 'get', key, expiresSeconds };
    }
    case 'head':
      return { op: 'head', key };
    case 'delete':
      return { op: 'delete', key };
    default:
      return null;
  }
}

/** HTTP API v2 lowercases header names; tolerate any casing anyway, and take the first match. */
function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

function rawBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

export function createHandler(deps: MediaSignerDeps): (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2> {
  return async (event) => {
    const method = event.requestContext?.http?.method ?? '';
    if (method !== 'POST') return respond(405, { ok: false, reason: 'METHOD_NOT_ALLOWED' });

    // Verify BEFORE parsing: an unsigned body is never even read as JSON.
    const body = rawBody(event);
    let secret: string;
    try {
      secret = await deps.secret();
    } catch {
      console.error(JSON.stringify({ component: 'media-signer', outcome: 'FAILED', stage: 'secret' }));
      return respond(500, { ok: false, reason: 'FAILED' });
    }
    const now = deps.now();
    const verified = verifyWorkerRequest(secret, {
      body,
      signature: header(event, WORKER_SIGNATURE_HEADER),
      timestamp: header(event, WORKER_TIMESTAMP_HEADER),
      now,
    });
    if (!verified) return respond(401, { ok: false, reason: 'UNAUTHORIZED' });

    const request = parseSignerRequest(body, deps.keyPrefix);
    if (!request) return respond(400, { ok: false, reason: 'BAD_REQUEST' });

    try {
      switch (request.op) {
        case 'put': {
          const url = await deps.s3.presignPut(request.key, request.contentType, request.expiresSeconds);
          const expiresAt = new Date(now.getTime() + request.expiresSeconds * 1000).toISOString();
          return respond(200, { ok: true, op: 'put', url, method: 'PUT', headers: { 'content-type': request.contentType }, expiresAt });
        }
        case 'get': {
          const url = await deps.s3.presignGet(request.key, request.expiresSeconds);
          const expiresAt = new Date(now.getTime() + request.expiresSeconds * 1000).toISOString();
          return respond(200, { ok: true, op: 'get', url, expiresAt });
        }
        case 'head': {
          const head = await deps.s3.head(request.key);
          if (!head.exists) return respond(200, { ok: true, op: 'head', exists: false });
          return respond(200, { ok: true, op: 'head', exists: true, size: head.size, contentType: head.contentType, etag: head.etag, lastModified: head.lastModified });
        }
        case 'delete':
          await deps.s3.delete(request.key);
          return respond(200, { ok: true, op: 'delete' });
      }
    } catch (err) {
      // The class of failure only: never the message (it can carry a URL or a key), never the body.
      const name = err instanceof Error ? err.name : typeof err;
      console.error(JSON.stringify({ component: 'media-signer', outcome: 'FAILED', op: request.op, error: name }));
      return respond(500, { ok: false, reason: 'FAILED' });
    }
  };
}

// ---------------------------------------------------------------------------------------------
// The real seams. Clients are created on first use so importing this module (as the tests do)
// touches no environment and no AWS.
// ---------------------------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return !!e && (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404);
}

export function realDeps(): MediaSignerDeps {
  let s3: S3Client | undefined;
  let secrets: SecretsManagerClient | undefined;
  let cachedSecret: Promise<string> | undefined;
  // WHEN_REQUIRED on both: the default (WHEN_SUPPORTED) signs a CRC32 checksum header into a
  // presigned PUT, which a browser upload does not send and would then fail signature validation.
  const client = () => (s3 ??= new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }));
  const bucket = () => requiredEnv('LOOP_MEDIA_BUCKET');

  return {
    keyPrefix: process.env.LOOP_MEDIA_KEY_PREFIX || 'media/',
    now: () => new Date(),
    secret: () => {
      if (!cachedSecret) {
        cachedSecret = (async () => {
          secrets ??= new SecretsManagerClient({});
          const out = await secrets.send(new GetSecretValueCommand({ SecretId: requiredEnv('LOOP_MEDIA_SIGNER_SECRET_ARN') }));
          if (typeof out.SecretString !== 'string' || out.SecretString === '') throw new Error('worker-control secret has no string value');
          return out.SecretString;
        })();
        // A failed read must not poison the container: the next call tries again.
        cachedSecret.catch(() => { cachedSecret = undefined; });
      }
      return cachedSecret;
    },
    s3: {
      presignPut: (key, contentType, expiresIn) => getSignedUrl(client(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), { expiresIn }),
      presignGet: (key, expiresIn) => getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn }),
      head: async (key) => {
        try {
          const out = await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
          return {
            exists: true,
            size: out.ContentLength ?? 0,
            contentType: out.ContentType ?? null,
            etag: out.ETag ?? null,
            lastModified: out.LastModified ? out.LastModified.toISOString() : null,
          };
        } catch (err) {
          if (isNotFound(err)) return { exists: false };
          throw err;
        }
      },
      delete: async (key) => {
        await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
      },
    },
  };
}

export const handler = createHandler(realDeps());

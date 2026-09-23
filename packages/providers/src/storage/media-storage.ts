// Media object storage for creator content: the FILE BYTES only.
//
// Loop owns the meaning of a file (which Content it belongs to, which Version it is, who uploaded
// it, whether it was approved or published); this module owns none of that. It answers exactly
// four questions about a key: where may a browser PUT it, where may a browser GET it, does it exist
// (and how big is it), and delete it. Everything else is the creator domain's.
//
// TWO ADAPTERS, ONE CONTRACT. In staging the bytes live in a PRIVATE S3 bucket that the web tier
// cannot touch directly: it holds no AWS credential and imports no AWS SDK. Instead it asks the
// media signer -- a small function inside the staging connections stack -- for short-lived
// presigned URLs, over the same HMAC control channel the web tier already uses to drive the
// connections worker (`signWorkerRequest`). The browser then talks to S3 itself, so no media byte
// ever crosses the web tier and no Netlify body limit applies. Locally, the same contract is met by
// a disk adapter behind a dev-only route.
//
// NO CREDENTIAL IS EVER IN A URL A BROWSER SEES for longer than the presign window, and no key is
// ever accepted from a caller: the creator domain builds keys from row ids it owns.

import { createHmac, timingSafeEqual } from 'crypto';
import { signWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared';

/** The upload types the product accepts. Anything else is refused before a URL exists. */
export const MEDIA_CONTENT_TYPES = Object.freeze({
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
} as const);

export type MediaKind = keyof typeof MEDIA_CONTENT_TYPES;

/** Size ceilings the product enforces (the signer enforces type; size is verified after upload). */
export const MEDIA_SIZE_LIMITS = Object.freeze({
  image: 25 * 1024 * 1024,
  video: 2 * 1024 * 1024 * 1024,
} as const);

/** The kind a content type belongs to, or null when the type is not accepted. */
export function mediaKindOf(contentType: string): MediaKind | null {
  const ct = contentType.toLowerCase().trim();
  if ((MEDIA_CONTENT_TYPES.image as readonly string[]).includes(ct)) return 'image';
  if ((MEDIA_CONTENT_TYPES.video as readonly string[]).includes(ct)) return 'video';
  return null;
}

/** File extension for an accepted content type. */
export function mediaExtensionOf(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  };
  return map[contentType.toLowerCase().trim()] ?? 'bin';
}

/** Every key the platform mints: the prefix the signer is allowed to touch, then lowercase ids. */
export const MEDIA_KEY_PREFIX = 'media/';
const KEY_PATTERN = /^media\/[a-z0-9][a-z0-9._/-]{0,500}$/;

export function isValidMediaKey(key: string): boolean {
  return KEY_PATTERN.test(key) && !key.includes('..') && !key.includes('//');
}

export interface MediaUploadTarget {
  readonly url: string;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

export interface MediaDownloadTarget {
  readonly url: string;
  readonly expiresAt: string;
}

export type MediaHead = { readonly exists: false } | { readonly exists: true; readonly size: number; readonly contentType: string | null };

export interface MediaObjectStorage {
  readonly kind: 'aws-signer' | 'local';
  createUploadUrl(input: { key: string; contentType: string; expiresSeconds?: number }): Promise<MediaUploadTarget>;
  createDownloadUrl(input: { key: string; expiresSeconds?: number }): Promise<MediaDownloadTarget>;
  head(key: string): Promise<MediaHead>;
  delete(key: string): Promise<void>;
}

export class MediaStorageError extends Error {
  constructor(public readonly reason: 'NOT_CONFIGURED' | 'UNREACHABLE' | 'REJECTED' | 'BAD_KEY' | 'BAD_TYPE' | 'FAILED', message?: string) {
    super(message ?? reason);
    this.name = 'MediaStorageError';
  }
}

// ---------------------------------------------------------------------------------------------
// The staging adapter: presigned URLs from the media signer in the connections stack.
// ---------------------------------------------------------------------------------------------

export interface SignerMediaStorageDeps {
  /** `${LOOP_CONNECTIONS_WORKER_URL}/media/sign` -- the route the stack exposes. */
  readonly signerUrl: string;
  /** The worker control secret: the class credential the web tier already holds. */
  readonly secret: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

type SignerResponse =
  | { ok: true; op: 'put'; url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string }
  | { ok: true; op: 'get'; url: string; expiresAt: string }
  | { ok: true; op: 'head'; exists: boolean; size?: number; contentType?: string | null }
  | { ok: true; op: 'delete' }
  | { ok: false; reason: string };

export class SignerMediaStorage implements MediaObjectStorage {
  readonly kind = 'aws-signer' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly deps: SignerMediaStorageDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  private async call(payload: Record<string, unknown>): Promise<SignerResponse> {
    const body = JSON.stringify(payload);
    const { signature, timestamp } = signWorkerRequest(this.deps.secret, body, this.now());
    let res: Response;
    try {
      res = await this.fetchImpl(this.deps.signerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [WORKER_SIGNATURE_HEADER]: signature, [WORKER_TIMESTAMP_HEADER]: timestamp },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new MediaStorageError('UNREACHABLE');
    }
    if (res.status === 401 || res.status === 400) throw new MediaStorageError('REJECTED');
    if (!res.ok) throw new MediaStorageError('FAILED');
    const parsed = (await res.json().catch(() => null)) as SignerResponse | null;
    if (!parsed || typeof parsed !== 'object') throw new MediaStorageError('FAILED');
    return parsed;
  }

  async createUploadUrl(input: { key: string; contentType: string; expiresSeconds?: number }): Promise<MediaUploadTarget> {
    if (!isValidMediaKey(input.key)) throw new MediaStorageError('BAD_KEY');
    if (!mediaKindOf(input.contentType)) throw new MediaStorageError('BAD_TYPE');
    const r = await this.call({ op: 'put', key: input.key, contentType: input.contentType, expiresSeconds: input.expiresSeconds ?? 900 });
    if (!r.ok || r.op !== 'put') throw new MediaStorageError('FAILED');
    return { url: r.url, method: 'PUT', headers: r.headers ?? { 'content-type': input.contentType }, expiresAt: r.expiresAt };
  }

  async createDownloadUrl(input: { key: string; expiresSeconds?: number }): Promise<MediaDownloadTarget> {
    if (!isValidMediaKey(input.key)) throw new MediaStorageError('BAD_KEY');
    const r = await this.call({ op: 'get', key: input.key, expiresSeconds: input.expiresSeconds ?? 900 });
    if (!r.ok || r.op !== 'get') throw new MediaStorageError('FAILED');
    return { url: r.url, expiresAt: r.expiresAt };
  }

  async head(key: string): Promise<MediaHead> {
    if (!isValidMediaKey(key)) throw new MediaStorageError('BAD_KEY');
    const r = await this.call({ op: 'head', key });
    if (!r.ok || r.op !== 'head') throw new MediaStorageError('FAILED');
    if (!r.exists) return { exists: false };
    return { exists: true, size: typeof r.size === 'number' ? r.size : 0, contentType: r.contentType ?? null };
  }

  async delete(key: string): Promise<void> {
    if (!isValidMediaKey(key)) throw new MediaStorageError('BAD_KEY');
    const r = await this.call({ op: 'delete', key });
    if (!r.ok) throw new MediaStorageError('FAILED');
  }
}

// ---------------------------------------------------------------------------------------------
// The local adapter: a disk directory behind a dev-only route. NEVER a production path.
// The URLs it mints carry an HMAC over (key, op, expiry) so the route accepts only what this
// adapter issued, for as long as it said.
// ---------------------------------------------------------------------------------------------

export interface LocalMediaStorageDeps {
  /** Absolute directory the dev route reads and writes. */
  readonly directory: string;
  /** The route that serves it, e.g. `/api/creator/media/local`. */
  readonly routePath: string;
  /** Signs the dev URLs so the route honours only what this adapter minted. */
  readonly secret: string;
  readonly now?: () => Date;
  /** Filesystem seam; defaults to node:fs/promises. */
  readonly fs?: { stat(path: string): Promise<{ size: number }>; unlink(path: string): Promise<void> };
}

export function localMediaToken(secret: string, op: 'put' | 'get', key: string, expiresAtMs: number): string {
  return createHmac('sha256', secret).update(`${op}.${key}.${expiresAtMs}`).digest('hex');
}

export function verifyLocalMediaToken(secret: string, op: 'put' | 'get', key: string, expiresAtMs: number, token: unknown, now: Date = new Date()): boolean {
  if (typeof token !== 'string' || !Number.isFinite(expiresAtMs) || now.getTime() > expiresAtMs) return false;
  const expected = Buffer.from(localMediaToken(secret, op, key, expiresAtMs), 'utf8');
  const actual = Buffer.from(token, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The on-disk path for a key, confined to the directory (a key never escapes it). */
export function localMediaPath(directory: string, key: string): string {
  if (!isValidMediaKey(key)) throw new MediaStorageError('BAD_KEY');
  return `${directory.replace(/\/+$/, '')}/${key}`;
}

export class LocalMediaStorage implements MediaObjectStorage {
  readonly kind = 'local' as const;
  private readonly now: () => Date;

  constructor(private readonly deps: LocalMediaStorageDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private url(op: 'put' | 'get', key: string, expiresSeconds: number): { url: string; expiresAt: string } {
    const expiresAtMs = this.now().getTime() + expiresSeconds * 1000;
    const token = localMediaToken(this.deps.secret, op, key, expiresAtMs);
    const q = new URLSearchParams({ key, exp: String(expiresAtMs), token });
    return { url: `${this.deps.routePath}?${q.toString()}`, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  async createUploadUrl(input: { key: string; contentType: string; expiresSeconds?: number }): Promise<MediaUploadTarget> {
    if (!isValidMediaKey(input.key)) throw new MediaStorageError('BAD_KEY');
    if (!mediaKindOf(input.contentType)) throw new MediaStorageError('BAD_TYPE');
    const { url, expiresAt } = this.url('put', input.key, input.expiresSeconds ?? 900);
    return { url, method: 'PUT', headers: { 'content-type': input.contentType }, expiresAt };
  }

  async createDownloadUrl(input: { key: string; expiresSeconds?: number }): Promise<MediaDownloadTarget> {
    if (!isValidMediaKey(input.key)) throw new MediaStorageError('BAD_KEY');
    return this.url('get', input.key, input.expiresSeconds ?? 900);
  }

  async head(key: string): Promise<MediaHead> {
    const path = localMediaPath(this.deps.directory, key);
    const fs = this.deps.fs ?? (await import('node:fs/promises'));
    try {
      const s = await fs.stat(path);
      return { exists: true, size: s.size, contentType: null };
    } catch {
      return { exists: false };
    }
  }

  async delete(key: string): Promise<void> {
    const path = localMediaPath(this.deps.directory, key);
    const fs = this.deps.fs ?? (await import('node:fs/promises'));
    try {
      await fs.unlink(path);
    } catch {
      // Already gone is not a failure.
    }
  }
}

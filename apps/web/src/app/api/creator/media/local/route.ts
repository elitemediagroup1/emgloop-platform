// DEV ONLY: /api/creator/media/local -- the disk behind LocalMediaStorage. PUT writes the body
// to the key the adapter minted; GET serves it with Range support so video seeks. Every call
// carries the adapter's expiring HMAC token, and the whole route refuses to exist on a
// production runtime or when local storage is not the configured mode.

import { createReadStream, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { verifyLocalMediaToken, localMediaPath, isValidMediaKey } from '@emgloop/providers';
import { MEDIA_ENVIRONMENT, readMediaRuntime } from '../../../../../creator/media-runtime';
import { hostOf, isProductionRuntime } from '../../../../../crm/webhook-runtime';

export const dynamic = 'force-dynamic';

function local(request: Request): { directory: string; secret: string } | null {
  if (isProductionRuntime(hostOf(request))) return null;
  const runtime = readMediaRuntime(process.env, hostOf(request));
  if (runtime.state !== 'CONFIGURED' || runtime.storage.kind !== 'local') return null;
  return { directory: (process.env[MEDIA_ENVIRONMENT.localDir] ?? '').trim(), secret: (process.env[MEDIA_ENVIRONMENT.localSecret] ?? '').trim() };
}

function params(request: Request, op: 'put' | 'get', secret: string): string | null {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') ?? '';
  const exp = Number(url.searchParams.get('exp'));
  const token = url.searchParams.get('token');
  if (!isValidMediaKey(key)) return null;
  if (!verifyLocalMediaToken(secret, op, key, exp, token)) return null;
  return key;
}

export async function PUT(request: Request): Promise<Response> {
  const cfg = local(request);
  if (!cfg) return new Response('Not found', { status: 404 });
  const key = params(request, 'put', cfg.secret);
  if (!key) return new Response('Forbidden', { status: 403 });
  const path = localMediaPath(cfg.directory, key);
  await mkdir(dirname(path), { recursive: true });
  const bytes = Buffer.from(await request.arrayBuffer());
  await writeFile(path, bytes);
  return new Response(null, { status: 200, headers: { etag: `"${bytes.length}"` } });
}

export async function GET(request: Request): Promise<Response> {
  const cfg = local(request);
  if (!cfg) return new Response('Not found', { status: 404 });
  const key = params(request, 'get', cfg.secret);
  if (!key) return new Response('Forbidden', { status: 403 });
  const path = localMediaPath(cfg.directory, key);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const type = key.endsWith('.mp4') ? 'video/mp4' : key.endsWith('.mov') ? 'video/quicktime' : key.endsWith('.webm') ? 'video/webm' : key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : key.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
  const range = request.headers.get('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { 'content-type': type, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'cache-control': 'private, no-store' },
    });
  }
  const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
  return new Response(stream, { status: 200, headers: { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes', 'cache-control': 'private, no-store' } });
}

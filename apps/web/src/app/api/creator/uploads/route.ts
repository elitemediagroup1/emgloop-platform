// POST /api/creator/uploads -- reserve a version and get a short-lived direct-to-storage PUT URL.
// The bytes never pass through here (Netlify's body limit is irrelevant); see upload-service.ts.

import { apiCaller, json } from '../../../../creator/api-session';
import { mediaStorage } from '../../../../creator/media-runtime';
import { beginCreatorUpload, beginEmgUpload, type BeginUploadRequest } from '../../../../creator/upload-service';
import { hostOf } from '../../../../crm/webhook-runtime';

export const dynamic = 'force-dynamic';

function parse(raw: unknown): BeginUploadRequest | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : Number.NaN);
  if (r.purpose === 'CREATOR_NEW_CONTENT') {
    const kind = s('kind') === 'PHOTO' ? 'PHOTO' : s('kind') === 'VIDEO' ? 'VIDEO' : null;
    if (!kind) return null;
    return { purpose: 'CREATOR_NEW_CONTENT', title: s('title'), kind, fileName: s('fileName'), contentType: s('contentType'), byteSize: n('byteSize'), deliverableId: s('deliverableId') || null };
  }
  if (r.purpose === 'EMG_VERSION') {
    return { purpose: 'EMG_VERSION', workInstanceId: s('workInstanceId'), fileName: s('fileName'), contentType: s('contentType'), byteSize: n('byteSize'), noteToCreator: s('noteToCreator') || null, internalNote: s('internalNote') || null, saveAsDraft: r.saveAsDraft === true };
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const caller = await apiCaller();
  if (caller.kind === 'NONE') return json({ ok: false, reason: caller.reason }, caller.status);
  const body = parse(await request.json().catch(() => null));
  if (!body) return json({ ok: false, reason: 'INVALID' }, 400);
  const storage = mediaStorage(hostOf(request));
  const result =
    body.purpose === 'CREATOR_NEW_CONTENT'
      ? caller.kind === 'CREATOR'
        ? await beginCreatorUpload(caller.actor, storage, body)
        : ({ ok: false, reason: 'NOT_ALLOWED' } as const)
      : caller.kind === 'EMG'
        ? await beginEmgUpload(caller.actor, storage, body)
        : ({ ok: false, reason: 'NOT_ALLOWED' } as const);
  if (result.ok) return json(result, 200);
  const status = result.reason === 'NOT_FOUND' ? 404 : result.reason === 'NOT_ALLOWED' ? 403 : result.reason === 'NOT_CONFIGURED' || result.reason === 'UNREACHABLE' ? 503 : result.reason === 'FAILED' ? 500 : 400;
  return json(result, status);
}

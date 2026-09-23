// GET /api/creator/media/:versionId -- play or download a version: a short-lived redirect to
// storage for a caller allowed to see it. The stable address is this one; the storage URL is
// minted per request and expires, so nothing in a page carries a long-lived object URL.

import { apiCaller, json } from '../../../../../creator/api-session';
import { mediaStorage } from '../../../../../creator/media-runtime';
import { mayPlayVersion } from '../../../../../creator/upload-service';
import { hostOf } from '../../../../../crm/webhook-runtime';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { versionId: string } }): Promise<Response> {
  const caller = await apiCaller();
  if (caller.kind === 'NONE') return json({ ok: false, reason: caller.reason }, caller.status);
  const allowed = await mayPlayVersion(
    { organizationId: caller.actor.organizationId, creator: caller.kind === 'CREATOR' ? caller.actor : null, emg: caller.kind === 'EMG' },
    params.versionId,
  );
  if (!allowed) return json({ ok: false, reason: 'NOT_FOUND' }, 404);
  const storage = mediaStorage(hostOf(request));
  if (!storage) return json({ ok: false, reason: 'NOT_CONFIGURED' }, 503);
  try {
    const target = await storage.createDownloadUrl({ key: allowed.key, expiresSeconds: 600 });
    return new Response(null, { status: 302, headers: { location: target.url, 'cache-control': 'private, no-store' } });
  } catch {
    return json({ ok: false, reason: 'UNREACHABLE' }, 503);
  }
}

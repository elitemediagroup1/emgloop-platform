// POST /api/creator/uploads/:versionId/complete -- confirm the bytes are in storage; mark READY.

import { apiCaller, json } from '../../../../../../creator/api-session';
import { mediaStorage } from '../../../../../../creator/media-runtime';
import { completeUpload } from '../../../../../../creator/upload-service';
import { hostOf } from '../../../../../../crm/webhook-runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { versionId: string } }): Promise<Response> {
  const caller = await apiCaller();
  if (caller.kind === 'NONE') return json({ ok: false, reason: caller.reason }, caller.status);
  const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const num = (k: string) => (typeof raw[k] === 'number' ? (raw[k] as number) : null);
  const result = await completeUpload(
    { organizationId: caller.actor.organizationId, userId: caller.actor.userId, canActOnAny: caller.kind === 'EMG' && caller.actor.canActOnAnyStep },
    mediaStorage(hostOf(request)),
    params.versionId,
    { durationSeconds: num('durationSeconds'), width: num('width'), height: num('height') },
  );
  if (result.ok) return json(result, 200);
  const status = result.reason === 'NOT_FOUND' ? 404 : result.reason === 'NOT_ALLOWED' ? 403 : result.reason === 'NOT_UPLOADED' ? 409 : result.reason === 'NOT_CONFIGURED' || result.reason === 'UNREACHABLE' ? 503 : result.reason === 'FAILED' ? 500 : 400;
  return json(result, status);
}

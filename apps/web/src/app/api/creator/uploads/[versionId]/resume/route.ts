// Renew a pending upload using session-derived ownership and current production permissions.
import { apiCaller, json } from '../../../../../../creator/api-session';
import { mediaStorage } from '../../../../../../creator/media-runtime';
import { resumeUpload } from '../../../../../../creator/upload-service';
import { hostOf } from '../../../../../../crm/webhook-runtime';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: { versionId: string } }): Promise<Response> {
  const caller = await apiCaller();
  if (caller.kind === 'NONE') return json({ ok: false, reason: caller.reason }, caller.status);
  const result = await resumeUpload({
    organizationId: caller.actor.organizationId,
    userId: caller.actor.userId,
    creatorProfileId: caller.kind === 'CREATOR' ? caller.actor.creatorProfileId : null,
    canActOnAny: caller.kind === 'EMG' && caller.actor.canActOnAnyStep,
  }, mediaStorage(hostOf(request)), params.versionId);
  if (result.ok) return json(result, 200);
  return json(result, result.reason === 'NOT_FOUND' ? 404 : result.reason === 'NOT_ALLOWED' ? 403 : result.reason === 'FAILED' ? 500 : 503);
}

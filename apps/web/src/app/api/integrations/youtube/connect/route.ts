import { getSessionBinding } from '../../../../../auth/auth';
import { loginPathFor } from '../../../../../auth/landing';
import { CREATOR_HREFS } from '../../../../../creator/creator-runtime';
import { resolveWorkspaceRole } from '../../../../../workspaces/role-router';
import { beginYouTubeConnect } from '../../../../../youtube/youtube-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const noStore = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;
const back = (value: string) => new Response(null, { status: 303, headers: { ...noStore, location: `${CREATOR_HREFS.profile}?youtube=${encodeURIComponent(value)}` } });

export async function GET(request: Request): Promise<Response> {
  const bound = await getSessionBinding();
  if (!bound) return new Response(null, { status: 303, headers: { ...noStore, location: loginPathFor(CREATOR_HREFS.profile) } });
  if (request.headers.get('sec-fetch-site') === 'cross-site') return back('INVALID_REQUEST');
  if (resolveWorkspaceRole(bound.session) !== 'CREATOR') return back('NOT_PERMITTED');
  try {
    const result = await beginYouTubeConnect({
      organizationId: bound.session.organizationId,
      userId: bound.session.userId,
      sessionId: bound.sessionId,
    });
    if (result === 'NOT_CONFIGURED' || result === 'NOT_PERMITTED' || result === 'TOO_MANY_ATTEMPTS') return back(result);
    return new Response(null, { status: 303, headers: { ...noStore, location: result } });
  } catch {
    return back('FAILED');
  }
}

import { getSessionBinding } from '../../../../../auth/auth';
import { CREATOR_HREFS } from '../../../../../creator/creator-runtime';
import { resolveWorkspaceRole } from '../../../../../workspaces/role-router';
import { syncYouTubeAnalytics } from '../../../../../youtube/youtube-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const noStore = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;

export async function POST(request: Request): Promise<Response> {
  const bound = await getSessionBinding();
  if (!bound) return new Response(null, { status: 303, headers: { ...noStore, location: '/login' } });
  const site = request.headers.get('sec-fetch-site');
  if (site === 'cross-site' || resolveWorkspaceRole(bound.session) !== 'CREATOR') {
    return new Response(null, { status: 303, headers: { ...noStore, location: `${CREATOR_HREFS.profile}?youtube=NOT_PERMITTED` } });
  }
  let result = 'FAILED';
  try {
    result = await syncYouTubeAnalytics({ organizationId: bound.session.organizationId, userId: bound.session.userId, sessionId: bound.sessionId }, true);
  } catch {}
  return new Response(null, { status: 303, headers: { ...noStore, location: `${CREATOR_HREFS.profile}?youtube_sync=${encodeURIComponent(result)}` } });
}

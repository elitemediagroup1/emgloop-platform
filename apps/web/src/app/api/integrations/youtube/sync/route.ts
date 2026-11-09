import { getSessionBinding } from '../../../../../auth/auth';
import { loginPathFor } from '../../../../../auth/landing';
import { CREATOR_HREFS } from '../../../../../creator/creator-runtime';
import { resolveWorkspaceRole } from '../../../../../workspaces/role-router';
import { syncYouTubeAnalytics } from '../../../../../youtube/youtube-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const noStore = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;

export async function POST(request: Request): Promise<Response> {
  const bound = await getSessionBinding();
  if (!bound) return new Response(null, { status: 303, headers: { ...noStore, location: loginPathFor(CREATOR_HREFS.profile) } });
  const site = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  const expectedOrigin = new URL(process.env.APP_URL ?? 'https://app.emgloop.com').origin;
  if (site === 'cross-site' || !origin || origin !== expectedOrigin || resolveWorkspaceRole(bound.session) !== 'CREATOR') {
    return new Response(null, { status: 303, headers: { ...noStore, location: `${CREATOR_HREFS.profile}?youtube=NOT_PERMITTED` } });
  }
  let result = 'FAILED';
  try {
    result = await syncYouTubeAnalytics({ organizationId: bound.session.organizationId, userId: bound.session.userId, sessionId: bound.sessionId });
  } catch {}
  return new Response(null, { status: 303, headers: { ...noStore, location: `${CREATOR_HREFS.profile}?youtube_sync=${encodeURIComponent(result)}` } });
}

import { getSessionBinding } from '../../../../../auth/auth';
import { loginPathFor } from '../../../../../auth/landing';
import { CREATOR_HREFS } from '../../../../../creator/creator-runtime';
import { completeYouTubeConnect } from '../../../../../youtube/youtube-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const noStore = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;
const back = (value: string) => new Response(null, { status: 303, headers: { ...noStore, location: `${CREATOR_HREFS.profile}?youtube=${encodeURIComponent(value)}` } });

export async function GET(request: Request): Promise<Response> {
  const bound = await getSessionBinding();
  if (!bound) return new Response(null, { status: 303, headers: { ...noStore, location: loginPathFor(`${CREATOR_HREFS.profile}?youtube=STATE_INVALID`) } });
  const url = new URL(request.url);
  try {
    const outcome = await completeYouTubeConnect({
      organizationId: bound.session.organizationId,
      userId: bound.session.userId,
      sessionId: bound.sessionId,
    }, {
      state: url.searchParams.get('state'),
      code: url.searchParams.get('code'),
      error: url.searchParams.get('error'),
    });
    return back(outcome);
  } catch {
    return back('FAILED');
  }
}

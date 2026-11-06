import { getSessionBinding } from '../../../../../auth/auth';
import { creatorSeatOf } from '../../../../../creator/creator-runtime';
import { metaReturnPath, metaService } from '../../../../../meta/meta-runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const go = (location: string) => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
export async function GET(request: Request) {
  const bound = await getSessionBinding();
  if (!bound) return go('/crm/login');
  if (request.headers.get('sec-fetch-site') === 'cross-site') return go(metaReturnPath('INVALID_REQUEST'));
  const seat = await creatorSeatOf(bound.session);
  if (!seat) return go('/app');
  try {
    const url = await metaService().begin({ organizationId: seat.actor.organizationId, userId: seat.actor.userId, creatorProfileId: seat.profileId }, bound.sessionId);
    return go(url ?? metaReturnPath('NOT_CONFIGURED'));
  } catch { return go(metaReturnPath('FAILED')); }
}

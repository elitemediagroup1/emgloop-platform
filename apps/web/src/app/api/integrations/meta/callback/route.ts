import { randomUUID } from 'node:crypto';
import { getSessionBinding } from '../../../../../auth/auth';
import { creatorSeatOf } from '../../../../../creator/creator-runtime';
import { metaReturnPath, metaService } from '../../../../../meta/meta-runtime';
import { metaCallbackFailure } from '../../../../../meta/meta-errors';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const go = (location: string) => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
export async function GET(request: Request) {
  const bound = await getSessionBinding();
  if (!bound) return go('/crm/login');
  const seat = await creatorSeatOf(bound.session);
  if (!seat) return go('/app');
  const params = new URL(request.url).searchParams;
  try {
    const result = await metaService().callback({ organizationId: seat.actor.organizationId, userId: seat.actor.userId, creatorProfileId: seat.profileId }, bound.sessionId, { state: params.get('state'), code: params.get('code'), error: params.get('error') });
    return go(metaReturnPath(result));
  } catch (error) {
    const reference = randomUUID();
    const failure = metaCallbackFailure(error);
    console.error('meta.oauth.callback_failed', { reference, ...failure.diagnostic });
    const query = new URLSearchParams({ meta_ref: reference });
    for (const key of ['stage', 'failure', 'invalidResponse', 'httpStatus', 'graphCode', 'graphSubcode'] as const) {
      const value = failure.diagnostic[key];
      if (value !== undefined) query.set(`meta_${key}`, String(value));
    }
    return go(`${metaReturnPath(failure.outcome)}&${query}`);
  }
}

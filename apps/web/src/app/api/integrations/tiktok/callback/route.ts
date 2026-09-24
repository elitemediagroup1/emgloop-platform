// GET /api/integrations/tiktok/callback -- the ONE redirect URI.
//
// Register exactly `<APP_URL>/api/integrations/tiktok/callback` on the TikTok app
// (production: https://app.emgloop.com/api/integrations/tiktok/callback). Absolute, https, no
// query, no fragment: TikTok matches it byte for byte.
//
// Finishes a connect attempt: the state is consumed once, in the SAME session that started
// it, before anything else happens; the code is exchanged server-side with the client secret;
// the GRANTED scopes are read from TikTok's answer; and only then is the creator's connection
// stored, with both tokens sealed. Nothing from this request -- not the organization, not the
// person, not the return page -- is taken from the query string.
//
// The response never contains a token, a code, TikTok's text or an account id.

import { getSessionBinding } from '../../../../../auth/auth';
import { loginPathFor } from '../../../../../auth/landing';
import { CREATOR_HREFS } from '../../../../../creator/creator-runtime';
import { tiktok, tiktokReturnPath } from '../../../../../tiktok/tiktok-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;

function redirectTo(location: string): Response {
  return new Response(null, { status: 303, headers: { ...NO_STORE, location } });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const bound = await getSessionBinding();
  // No session: the attempt cannot be honoured (it belongs to a session). Sign in first; the
  // creator starts again from their Profile.
  if (!bound) return redirectTo(loginPathFor(`${CREATOR_HREFS.profile}?tiktok=STATE_INVALID`));

  try {
    const outcome = await tiktok().completeConnect(
      {
        organizationId: bound.session.organizationId,
        userId: bound.session.userId,
        name: bound.session.name,
        sessionId: bound.sessionId,
      },
      {
        state: url.searchParams.get('state'),
        code: url.searchParams.get('code'),
        error: url.searchParams.get('error'),
      },
    );
    return redirectTo(tiktokReturnPath(outcome));
  } catch {
    // Never echo an internal error, and never the code that came with the request.
    return redirectTo(tiktokReturnPath('FAILED'));
  }
}

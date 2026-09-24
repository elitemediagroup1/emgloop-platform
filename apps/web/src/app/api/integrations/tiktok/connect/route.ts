// GET /api/integrations/tiktok/connect
//
// Starts connecting the signed-in creator's OWN TikTok account (Login Kit for Web). The
// organization, the person and the browser session come from the session cookie; the query
// names nothing, because there is one thing to ask for -- the four registered scopes -- and one
// page to return to, the creator's Profile.
//
// A single-use state (hashed, bound to organization, person and session, ten minutes) is
// recorded, then the person is sent to TikTok's consent screen. Every refusal returns them to
// their Profile with a plain reason, having stored nothing.
//
// Started from Loop only: a request another site initiated (Sec-Fetch-Site: cross-site) is
// refused, so no other site can start a consent flow in a Loop session. The creator seat is the
// authority: a session that is not a creator's is refused here, and the service re-derives the
// seat from the CreatorProfile bound to the login before anything is stored.

import { getSessionBinding } from '../../../../../auth/auth';
import { loginPathFor } from '../../../../../auth/landing';
import { CREATOR_HREFS } from '../../../../../creator/creator-runtime';
import { tiktok, tiktokReturnPath } from '../../../../../tiktok/tiktok-runtime';
import { resolveWorkspaceRole } from '../../../../../workspaces/role-router';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;

function redirectTo(location: string): Response {
  return new Response(null, { status: 303, headers: { ...NO_STORE, location } });
}

export async function GET(request: Request): Promise<Response> {
  const bound = await getSessionBinding();
  if (!bound) return redirectTo(loginPathFor(CREATOR_HREFS.profile));
  if (request.headers.get('sec-fetch-site') === 'cross-site') return redirectTo(tiktokReturnPath('INVALID_REQUEST'));
  if (resolveWorkspaceRole(bound.session) !== 'CREATOR') return redirectTo(tiktokReturnPath('NOT_PERMITTED'));

  try {
    const result = await tiktok().beginConnect({
      organizationId: bound.session.organizationId,
      userId: bound.session.userId,
      name: bound.session.name,
      sessionId: bound.sessionId,
    });
    return result.kind === 'redirect' ? redirectTo(result.url) : redirectTo(tiktokReturnPath(result.outcome));
  } catch {
    // Never echo an internal error; nothing was sent to TikTok.
    return redirectTo(tiktokReturnPath('FAILED'));
  }
}

// GET /api/integrations/google/connect?capability=gmail|calendar|drive[&return=onboarding]
//
// Starts connecting the signed-in person's OWN Google account for one capability
// (google-workspace-connection.md §11.4, step 1). The organization, the person and the
// browser session come from the session cookie; the query names only the capability and
// which page to return to.
//
// A single-use state (hashed, bound to organization, person and session, ten minutes) is
// recorded, then the person is sent to Google's consent screen. Every refusal returns
// them to the page they came from with a plain reason, having stored nothing.
//
// Started from Loop only: a request another site initiated (Sec-Fetch-Site: cross-site)
// is refused, so no other site can start a consent flow in a Loop session.

import { getSessionBinding } from '../../../../../auth/auth';
import { CONNECTIONS_PATH, ONBOARDING_GOOGLE_PATH, loginPathFor } from '../../../../../auth/landing';
import { googleReturnPath, googleWorkspace } from '../../../../../google/google-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;

function redirectTo(location: string): Response {
  return new Response(null, { status: 303, headers: { ...NO_STORE, location } });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get('return') === 'onboarding' ? 'ONBOARDING' : 'CONNECTIONS';

  const bound = await getSessionBinding();
  if (!bound) return redirectTo(loginPathFor(returnTo === 'ONBOARDING' ? ONBOARDING_GOOGLE_PATH : CONNECTIONS_PATH));
  if (request.headers.get('sec-fetch-site') === 'cross-site') return redirectTo(googleReturnPath(returnTo, 'INVALID_REQUEST'));

  try {
    const result = await googleWorkspace().beginConnect(
      {
        organizationId: bound.session.organizationId,
        userId: bound.session.userId,
        name: bound.session.name,
        sessionId: bound.sessionId,
      },
      { capabilities: url.searchParams.getAll('capability'), returnTo },
    );
    return result.kind === 'redirect' ? redirectTo(result.url) : redirectTo(googleReturnPath(result.returnTo, result.outcome));
  } catch {
    // Never echo an internal error; nothing was sent to Google.
    return redirectTo(googleReturnPath(returnTo, 'FAILED'));
  }
}

// GET /api/integrations/google/callback -- the ONE redirect URI for every capability.
//
// Register exactly `<APP_URL>/api/integrations/google/callback` on the Google client
// (production: https://app.emgloop.com/api/integrations/google/callback).
//
// Finishes a connect attempt (google-workspace-connection.md §11.4, step 2): the state is
// consumed once, in the SAME session that started it, before anything else happens; the
// code is exchanged server-side with the client secret; the ID token is verified (signature
// against Google's published keys, then its claims);
// the GRANTED scopes are read from Google's answer; and only then is the person's
// connection stored, with the refresh token sealed. Nothing from this request -- not the
// organization, not the person, not the return page -- is taken from the query string.
//
// The response never contains a token, a code, Google's text or an address.

import { getSessionBinding } from '../../../../../auth/auth';
import { CONNECTIONS_PATH, loginPathFor } from '../../../../../auth/landing';
import { googleReturnPath, googleWorkspace, managedMailboxes } from '../../../../../google/google-runtime';
import { MANAGED_MAILBOX_STATE_PREFIX } from '@emgloop/database';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;

function redirectTo(location: string): Response {
  return new Response(null, { status: 303, headers: { ...NO_STORE, location } });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const bound = await getSessionBinding();
  // No session: the attempt cannot be honoured (it belongs to a session). Sign in first;
  // the person starts again from Connections.
  if (!bound) return redirectTo(loginPathFor(`${CONNECTIONS_PATH}?google=STATE_INVALID`));

  try {
    // The prefix selects a lifecycle, never a tenant/recipient. Its state still must be consumed
    // in this manager's signed session. The ordinary private connection callback is unchanged.
    if (url.searchParams.get('state')?.startsWith(MANAGED_MAILBOX_STATE_PREFIX)) {
      const result = await managedMailboxes().service.complete({ organizationId: bound.session.organizationId, userId: bound.session.userId, sessionId: bound.sessionId }, {
        state: url.searchParams.get('state'), code: url.searchParams.get('code'), error: url.searchParams.get('error'),
      });
      const base = result.creatorProfileId ? `/app/admin/creator-hub/${encodeURIComponent(result.creatorProfileId)}` : '/app/admin/creator-hub';
      return redirectTo(`${base}?mailbox=${encodeURIComponent(result.outcome)}#mailboxes`);
    }
    const result = await googleWorkspace().completeConnect(
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
    return redirectTo(googleReturnPath(result.returnTo, result.outcome));
  } catch {
    if (url.searchParams.get('state')?.startsWith(MANAGED_MAILBOX_STATE_PREFIX)) return redirectTo('/app/admin/creator-hub?mailbox=FAILED#mailboxes');
    // Never echo an internal error, and never the code that came with the request.
    return redirectTo(googleReturnPath('CONNECTIONS', 'FAILED'));
  }
}

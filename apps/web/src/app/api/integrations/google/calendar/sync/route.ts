// POST /api/integrations/google/calendar/sync
//
// Synchronizes the SIGNED-IN PERSON'S OWN calendar into their own Daily Loop work state
// (DL-3). The manual trigger the architecture assigns to this slice: you connect your
// calendar, you ask once, and your events are ingested -- for your user only.
//
// WHOSE CALENDAR IS NOT A PARAMETER. The organization and the person come from the session
// cookie and from nowhere else. This route reads no body, no query and no header that could
// name somebody else, so there is no request an OWNER or an ADMIN could send that would
// synchronize a colleague's calendar. `employeeIntelligence:update` is about one's own work
// state, and the data scope does the rest (daily-loop-employee-intelligence.md §20.1).
//
// Started from Loop only: a request another site initiated (Sec-Fetch-Site: cross-site) is
// refused, so no other page can spend a person's Google quota in their session.
//
// The response is a class and four counts. It never carries an event title, an address,
// Google's text or a token.

import { getSession } from '../../../../../../auth/auth';
import { repositories } from '@emgloop/database';

import { syncEmployeeCalendar } from '../../../../../../daily-loop/calendar-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;

const json = (status: number, body: Record<string, unknown>): Response => new Response(JSON.stringify(body), { status, headers: NO_STORE });

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return json(401, { error: 'UNAUTHENTICATED' });
  if (request.headers.get('sec-fetch-site') === 'cross-site') return json(403, { error: 'INVALID_REQUEST' });

  // The principal IS the authorization: this pair, and no other, for the token and the rows.
  const principal = { organizationId: session.organizationId, userId: session.userId };

  const permitted = await repositories.iam.can({ ...principal, resource: 'employeeIntelligence', action: 'update' });
  if (!permitted) return json(403, { error: 'NOT_PERMITTED' });

  try {
    const result = await syncEmployeeCalendar(principal);
    return json(result.outcome === 'FAILED' ? 502 : 200, {
      outcome: result.outcome,
      mode: result.mode,
      examined: result.examined,
      written: result.written,
      failure: result.failure,
      cursorAdvanced: result.cursorAdvanced,
    });
  } catch {
    // A class, never a cause: nothing about the calendar, the account or Google leaves here.
    return json(502, { outcome: 'FAILED', failure: 'UNAVAILABLE' });
  }
}

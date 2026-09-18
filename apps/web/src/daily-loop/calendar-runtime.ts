// Calendar ingestion, assembled for a web request. SERVER ONLY.
//
// Architecture: daily-loop-employee-intelligence.md §13 (DL-3), §26 (DL-5).
//
// THIS FILE IS NOW A BINDING, NOT AN ASSEMBLY. The assembly -- the token path, the DL-2 sensor
// and the DL-1 store -- lives in `@emgloop/database` (`createEmployeeCalendarSync`), because the
// scheduled cycle performs the same sync outside Next.js and two assemblies would be two
// definitions of "read my calendar". What stays here is what is genuinely this runtime's: its
// environment, and the signing keys it shares across requests.
//
// THE PRINCIPAL IS STILL THE WHOLE AUTHORIZATION. The caller resolves it from the signed session
// and hands it to the sync, which fetches the token for that principal and writes rows for that
// principal. No role can point either at somebody else.

import 'server-only';

import { createEmployeeCalendarSync, prisma, type CalendarSyncOutcome, type WorkPrincipal } from '@emgloop/database';

import { googleSigningKeys } from '../google/google-runtime';
import { readGoogleEnvironment } from '../google/google-environment';

/** Synchronize the calendar of the person the caller resolved from the session. Nobody else's. */
export function syncEmployeeCalendar(principal: WorkPrincipal): Promise<CalendarSyncOutcome> {
  const env = readGoogleEnvironment();
  // A deployment with no Google client passes null and is refused as NOT_CONFIGURED by the same
  // token path as always -- the refusal class and the recorded run do not change shape here.
  const google = env.state === 'CONFIGURED' ? env : null;
  return createEmployeeCalendarSync({ prisma, google, signingKeys: googleSigningKeys() }).syncCalendar(principal);
}

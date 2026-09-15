import 'server-only';
import { cookies } from 'next/headers';
import { createTimeView, resolveDisplayTimeZone, type TimeView } from '@emgloop/shared';
import { TIME_ZONE_COOKIE, decodeTimeZoneCookie } from './time-zone-cookie';

// The reader's view of time for a server-rendered page: the canonical instant
// from the server clock, and the zone the signed-in person is in right now.
//
// Zone resolution (loop-time.ts): a user preference (none exists yet), then the
// device zone TimeZoneSync recorded, then UTC -- labelled on every absolute
// time. Presentation only: never pass this to an authorization, tenant or
// persistence decision, and never use it to timestamp a record; records are
// stamped by the server or database clock.

export function viewerTime(): TimeView {
  let device: string | null = null;
  try {
    device = decodeTimeZoneCookie(cookies().get(TIME_ZONE_COOKIE)?.value);
  } catch {
    // No request in scope (a unit test, a build step): there is no reader, so
    // there is no reader's zone. Fall back to UTC, labelled.
    device = null;
  }
  return createTimeView(resolveDisplayTimeZone({ device }), new Date());
}

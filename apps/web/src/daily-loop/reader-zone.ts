// The reader's own time zone, as this runtime knows it. SERVER ONLY.
//
// The device zone the browser reported, from the cookie DL-4 already sets. It is a presentation
// input and nothing else: no stored fact is ever written in a reader's zone (Loop Time Authority).

import 'server-only';

import { cookies } from 'next/headers';

import { TIME_ZONE_COOKIE, decodeTimeZoneCookie } from '../time/time-zone-cookie';

export function readerTimeZone(): string | null {
  try {
    return decodeTimeZoneCookie(cookies().get(TIME_ZONE_COOKIE)?.value);
  } catch {
    return null;
  }
}

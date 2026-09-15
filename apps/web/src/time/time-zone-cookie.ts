// The browser's timezone, carried to the server for presentation only.
//
// Server components render dates, and the server cannot see the browser's
// timezone. TimeZoneSync reads the device's IANA zone and stores it in this
// cookie; viewerTime() reads it back. It is presentation context, never
// authority: nothing that authorizes, scopes a tenant, or stamps a record reads
// it, and an invalid value is ignored (the reader falls back to UTC, labelled).
//
// Client-safe and pure: no Next imports, no document access.

import { parseTimeZone, type DisplayTimeZone } from '@emgloop/shared';

export const TIME_ZONE_COOKIE = 'loop_tz';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** The Set-Cookie string for a validated zone, or null for anything else. */
export function timeZoneCookie(timeZone: unknown, secure: boolean): string | null {
  const zone = parseTimeZone(timeZone);
  if (!zone) return null;
  return `${TIME_ZONE_COOKIE}=${encodeURIComponent(zone)}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** The validated zone stored in a raw cookie value, or null. */
export function decodeTimeZoneCookie(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    return parseTimeZone(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

/** The zone in a `document.cookie` string, or null. */
export function readTimeZoneCookie(cookieHeader: string): string | null {
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name === TIME_ZONE_COOKIE) return decodeTimeZoneCookie(rest.join('='));
  }
  return null;
}

/**
 * Whether the browser should record its zone and re-render: when it has a valid
 * zone and the server rendered with the fallback, or with a different device
 * zone (the person has travelled). A preference, once one exists, is never
 * overridden by the device.
 */
export function shouldSyncTimeZone(detected: unknown, rendered: DisplayTimeZone): boolean {
  const zone = parseTimeZone(detected);
  if (!zone || rendered.source === 'preference') return false;
  return rendered.source === 'fallback' || zone !== rendered.timeZone;
}

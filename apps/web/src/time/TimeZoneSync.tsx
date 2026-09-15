'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { TimeZoneSource } from '@emgloop/shared';
import { readTimeZoneCookie, shouldSyncTimeZone, timeZoneCookie } from './time-zone-cookie';

// Reports the device's IANA timezone so server-rendered dates are shown where
// the person is. No location permission: this is the zone the browser already
// knows, not geolocation.
//
// On first visit, or after travel, the page was rendered in another zone; the
// cookie is written and the server components re-render once. It re-checks when
// the window regains focus. It never writes or refreshes when the zone is
// already right, never refreshes twice for the same zone, and never refreshes if
// the cookie did not persist (blocked cookies must not loop). It renders nothing
// and has no bearing on authorization.

export function TimeZoneSync({
  timeZone,
  source,
  refresh = true,
}: {
  timeZone: string;
  source: TimeZoneSource;
  refresh?: boolean;
}) {
  const router = useRouter();
  const refreshedFor = useRef<string | null>(null);

  useEffect(() => {
    const check = () => {
      let detected: string | undefined;
      try {
        detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return;
      }
      if (!shouldSyncTimeZone(detected, { timeZone, source })) return;
      const cookie = timeZoneCookie(detected, window.location.protocol === 'https:');
      if (!cookie) return;
      document.cookie = cookie;
      const stored = readTimeZoneCookie(document.cookie);
      if (refresh && stored && refreshedFor.current !== stored) {
        refreshedFor.current = stored;
        router.refresh();
      }
    };
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [timeZone, source, refresh, router]);

  return null;
}

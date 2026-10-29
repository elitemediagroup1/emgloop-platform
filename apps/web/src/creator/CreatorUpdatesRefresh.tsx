'use client';
// Refresh stored updates while the creator is looking. No raw mail or model call in the browser.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
export function CreatorUpdatesRefresh() {
  const router = useRouter();
  useEffect(() => {
    const tick = setInterval(() => { if (document.visibilityState === 'visible') router.refresh(); }, 60_000);
    return () => clearInterval(tick);
  }, [router]);
  return null;
}

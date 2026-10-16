'use client';

import { useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/** Re-read the server's stored view; no provider fetch or model invocation here. */
export function StoredDataRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const refresh = () => {
      if (pending || document.visibilityState !== 'visible' || document.querySelector('#loop-assistant-panel')) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && (focused.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName))) return;
      startTransition(() => router.refresh());
    };
    const timer = setInterval(refresh, 15_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [pending, router]);
  return null;
}

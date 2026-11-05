'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { refreshCreatorUpdates } from './creator-refresh-action';
export function CreatorRefreshButton() {
  const [pending, start] = useTransition(), [message, setMessage] = useState('');
  const router = useRouter();
  return <div><button className="loop-btn" disabled={pending} onClick={() => start(async () => {
    try { const result = await refreshCreatorUpdates(); setMessage(result.ok ? 'Refresh requested. Updates will appear as the review finishes.' : 'Refresh is unavailable right now.'); router.refresh(); }
    catch { setMessage('Refresh could not be requested. Please try again.'); }
  })}>{pending ? 'Requesting refresh…' : 'Refresh updates'}</button><p role="status" className="loop-note">{message}</p></div>;
}

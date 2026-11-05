'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { refreshCreatorUpdates } from './creator-refresh-action';
export function CreatorRefreshButton() {
  const [pending, start] = useTransition(), [message, setMessage] = useState('');
  const router = useRouter();
  return <div className="ch-brand-refresh"><button className="loop-btn ch-brand-refresh__button" aria-busy={pending} disabled={pending} onClick={() => start(async () => {
    try { const result = await refreshCreatorUpdates(); setMessage(result.ok ? 'Refresh requested. Updates will appear as the review finishes.' : 'Refresh is unavailable right now.'); router.refresh(); }
    catch { setMessage('Refresh could not be requested. Please try again.'); }
  })}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 11.5-1L20 9M4 15l2.5 3A7 7 0 0 0 18 17"/></svg>{pending ? 'Requesting refresh…' : 'Refresh updates'}</button><p role="status" className="loop-note">{message}</p></div>;
}

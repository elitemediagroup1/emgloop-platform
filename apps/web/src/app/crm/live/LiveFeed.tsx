'use client';

import { useEffect, useRef, useState } from 'react';

// LiveFeed — Sprint 15 (Live Operations).
//
// A thin client component that polls a read-only Live Operations API endpoint
// every \`intervalMs\` (default 8s) and renders the newest-first results. There
// are NO websockets — polling only, per the Sprint 15 contract. The component is
// presentation-only: all data is produced server-side by LiveOperationsRepository
// and exposed through the permission-gated /api/live/* routes.

type Json = Record<string, unknown>;

export interface LiveFeedProps {
  endpoint: string; // e.g. '/api/live/activity'
  intervalMs?: number; // poll cadence (5-10s window)
  emptyText: string;
  render: (items: Json[]) => React.ReactNode;
}

function fmtTime(at: unknown): string {
  if (typeof at !== 'string') return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function relativeTime(at: unknown): string {
  if (typeof at !== 'string') return '';
  const d = new Date(at).getTime();
  if (Number.isNaN(d)) return '';
  const secs = Math.max(0, Math.round((Date.now() - d) / 1000));
  if (secs < 60) return secs + 's ago';
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return fmtTime(at);
}

export default function LiveFeed({ endpoint, intervalMs = 8000, emptyText, render }: LiveFeedProps) {
  const [items, setItems] = useState<Json[]>([]);
  const [status, setStatus] = useState<'loading' | 'live' | 'error' | 'unconfigured'>('loading');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);

  async function poll() {
    try {
      const res = await fetch(endpoint, { cache: 'no-store' });
      if (!res.ok) {
        if (mounted.current) setStatus('error');
        return;
      }
      const data = (await res.json()) as Json;
      if (!mounted.current) return;
      if (data.orgReady === false) {
        setStatus('unconfigured');
        setItems([]);
        return;
      }
      const next = Array.isArray(data.items) ? (data.items as Json[]) : [];
      setItems(next);
      setStatus('live');
      setLastSync(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }));
    } catch {
      if (mounted.current) setStatus('error');
    }
  }

  useEffect(() => {
    mounted.current = true;
    poll();
    timer.current = setInterval(poll, intervalMs);
    return () => {
      mounted.current = false;
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, intervalMs]);

  return (
    <div>
      <div className="crm-live-statusbar" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.85rem', fontSize: '0.75rem', color: 'var(--crm-faint)' }}>
        <span
          className={status === 'live' ? 'crm-dot-live' : 'ds-status-dot'}
          style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: status === 'live' ? '#22c55e' : status === 'error' ? '#f87171' : '#9ca3af' }}
        />
        <span>
          {status === 'loading' && 'Connecting to the Brain…'}
          {status === 'live' && ('Live · polling every ' + Math.round(intervalMs / 1000) + 's' + (lastSync ? ' · synced ' + lastSync : ''))}
          {status === 'error' && 'Reconnecting…'}
          {status === 'unconfigured' && 'Organization not configured yet.'}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="crm-empty" style={{ margin: 0 }}>{status === 'loading' ? 'Loading…' : emptyText}</p>
      ) : (
        render(items)
      )}
    </div>
  );
}

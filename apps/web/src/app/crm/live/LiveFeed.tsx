'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

// LiveFeed — Sprint 15 (Live Operations).
//
// A thin client component that polls a read-only Live Operations API endpoint
// every `intervalMs` (default 8s) and renders the newest-first results. There
// are NO websockets — polling only, per the Sprint 15 contract.
//
// Rendering for each surface lives HERE (a Client Component). Server pages must
// NOT pass a render function across the server/client boundary (Next.js forbids
// passing functions to Client Components) — they pass a serializable `variant`
// string instead. All data is produced server-side by LiveOperationsRepository
// and exposed through the permission-gated /api/live/* routes.

type Json = Record<string, unknown>;

export type LiveFeedVariant = 'activity' | 'calls' | 'websites';

export interface LiveFeedProps {
  endpoint: string; // e.g. '/api/live/activity'
  variant: LiveFeedVariant;
  intervalMs?: number; // poll cadence (5-10s window)
  emptyText: string;
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

function dur(seconds: unknown): string {
  const s = typeof seconds === 'number' ? seconds : Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '—';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m > 0 ? m + 'm ' + r + 's' : r + 's';
}

const KIND_LABEL: Record<string, string> = {
  website: 'Website',
  call: 'Call',
  workflow: 'Workflow',
  customer: 'Customer',
  booking: 'Booking',
  integration: 'Integration',
};

const KIND_COLOR: Record<string, string> = {
  website: 'var(--crm-blue, #3b82f6)',
  call: 'var(--crm-amber, #f59e0b)',
  workflow: 'var(--crm-purple, #8b5cf6)',
  customer: 'var(--crm-accent, #14b8a6)',
  booking: 'var(--crm-accent, #14b8a6)',
  integration: 'var(--crm-faint, #9ca3af)',
};

interface WebEvent {
  id?: unknown;
  eventType?: unknown;
  label?: unknown;
  journeyStage?: unknown;
  at?: unknown;
}

function renderActivity(items: Json[]) {
  return (
    <ul className="crm-timeline">
      {items.map((it) => {
        const kind = String(it.kind ?? 'integration');
        return (
          <li key={String(it.id)}>
            <span className="crm-tl-dot" style={{ background: KIND_COLOR[kind] ?? 'var(--crm-faint)' }} />
            <div>
              <div className="crm-tl-title">{String(it.label ?? 'Event')}</div>
              {it.detail ? <div className="crm-tl-body">{String(it.detail)}</div> : null}
              <div className="crm-tl-meta">
                <span className="crm-tag">{KIND_LABEL[kind] ?? kind}</span>
                {it.provider ? ' · ' + String(it.provider) : ''}
                {it.status ? ' · ' + String(it.status) : ''}
                {' · '}
                {relativeTime(it.at)}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function renderCalls(items: Json[]) {
  return (
    <div className="crm-table-wrap" style={{ overflowX: 'auto' }}>
      <table className="crm-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Caller</th>
            <th>Customer</th>
            <th>Vendor</th>
            <th>Source</th>
            <th>Campaign</th>
            <th>Qualified</th>
            <th>Duration</th>
            <th>Status</th>
            <th>Assigned</th>
            <th>Next best action</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const qualified = it.qualified;
            const assigned = [it.assignedAi, it.assignedHuman].filter(Boolean).join(' / ') || '—';
            return (
              <tr key={String(it.id)}>
                <td title={String(it.at ?? '')}>{relativeTime(it.at)}</td>
                <td>{it.caller ? String(it.caller) : '—'}</td>
                <td>
                  {it.customerId ? (
                    <Link href={'/crm/customers/' + String(it.customerId)} className="crm-link">
                      {String(it.customerName ?? 'View')}
                    </Link>
                  ) : (
                    String(it.customerName ?? '—')
                  )}
                </td>
                <td>{it.vendor ? String(it.vendor) : '—'}</td>
                <td>{it.source ? String(it.source) : '—'}</td>
                <td>{it.campaign ? String(it.campaign) : '—'}</td>
                <td>
                  {qualified === true ? (
                    <span className="crm-tag" style={{ background: 'var(--crm-accent, #14b8a6)', color: '#fff' }}>Qualified</span>
                  ) : qualified === false ? (
                    <span className="crm-tag">Unqualified</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{dur(it.durationSeconds)}</td>
                <td>{it.status ? String(it.status) : '—'}</td>
                <td>{assigned}</td>
                <td>{it.nextBestAction ? String(it.nextBestAction) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function renderWebsites(items: Json[]) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
      {items.map((s) => {
        const events = Array.isArray(s.events) ? (s.events as WebEvent[]) : [];
        return (
          <div key={String(s.sessionKey)} className="crm-card" style={{ margin: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div className="crm-tl-title">
                {s.website ? String(s.website) : 'Website session'}
                {s.customerId ? (
                  <>
                    {' · '}
                    <Link href={'/crm/customers/' + String(s.customerId)} className="crm-link">
                      {String(s.customerName ?? 'View customer')}
                    </Link>
                  </>
                ) : s.customerName ? ' · ' + String(s.customerName) : ''}
              </div>
              <span className="crm-tl-meta">{events.length} event{events.length === 1 ? '' : 's'} · {relativeTime(s.lastAt)}</span>
            </div>
            <ul className="crm-timeline" style={{ marginTop: '0.6rem' }}>
              {events.map((e) => (
                <li key={String(e.id)}>
                  <span className="crm-tl-dot" style={{ background: 'var(--crm-blue, #3b82f6)' }} />
                  <div>
                    <div className="crm-tl-title">{String(e.label ?? e.eventType ?? 'Website activity')}</div>
                    <div className="crm-tl-meta">
                      {e.eventType ? String(e.eventType).replace(/^web\./, '') : 'event'}
                      {e.journeyStage ? ' · ' + String(e.journeyStage) : ''}
                      {' · '}
                      {relativeTime(e.at)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function renderVariant(variant: LiveFeedVariant, items: Json[]) {
  switch (variant) {
    case 'calls':
      return renderCalls(items);
    case 'websites':
      return renderWebsites(items);
    case 'activity':
    default:
      return renderActivity(items);
  }
}

export default function LiveFeed({ endpoint, variant, intervalMs = 8000, emptyText }: LiveFeedProps) {
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
        renderVariant(variant, items)
      )}
    </div>
  );
}

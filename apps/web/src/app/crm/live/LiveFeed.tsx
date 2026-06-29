'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';

// LiveFeed — Sprint 15 (Live Operations), real-data hotfix.
//
// Polls a read-only /api/live/* endpoint every intervalMs (default 8s) and
// renders newest-first results. NO websockets. All rendering for each surface
// lives HERE (a Client Component) — server pages pass a serializable `variant`
// string, never a render function.
//
// Honest data: rows show provider + external id (traceability), missing
// attribution is labelled 'Unknown vendor/source/campaign' (never a fake
// partner), and the websites variant has an EMG property selector.

type Json = Record<string, unknown>;

export type LiveFeedVariant = 'activity' | 'calls' | 'websites';

export interface PropertyOption {
  key: string;
  name: string;
}

export interface LiveFeedProps {
  endpoint: string;
  variant: LiveFeedVariant;
  intervalMs?: number;
  emptyText: string;
  windowLabel?: string;
  properties?: PropertyOption[];
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

function shortId(v: unknown): string {
  const s = v ? String(v) : '';
  if (!s) return '—';
  return s.length > 18 ? s.slice(0, 8) + '…' + s.slice(-6) : s;
}

function attr(value: unknown, unknownLabel: string) {
  if (value === null || value === undefined || value === '') {
    return <span className="crm-faint" style={{ fontStyle: 'italic' }}>{unknownLabel}</span>;
  }
  return <span>{String(value)}</span>;
}

const KIND_LABEL: Record<string, string> = {
  website: 'Website', call: 'Call', workflow: 'Workflow', customer: 'Customer', booking: 'Booking', integration: 'Integration',
};
const KIND_COLOR: Record<string, string> = {
  website: 'var(--crm-blue, #3b82f6)', call: 'var(--crm-amber, #f59e0b)', workflow: 'var(--crm-purple, #8b5cf6)',
  customer: 'var(--crm-accent, #14b8a6)', booking: 'var(--crm-accent, #14b8a6)', integration: 'var(--crm-faint, #9ca3af)',
};

interface WebEvent { id?: unknown; eventType?: unknown; label?: unknown; journeyStage?: unknown; provider?: unknown; externalId?: unknown; at?: unknown; }

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
                {it.externalId ? ' · id ' + shortId(it.externalId) : ''}
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
            <th>When</th><th>Caller</th><th>Customer</th><th>Vendor</th><th>Source</th><th>Campaign</th>
            <th>Qualified</th><th>Duration</th><th>Status</th><th>Provider</th><th>Event ID</th><th>Next best action</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const qualified = it.qualified;
            return (
              <tr key={String(it.id)}>
                <td title={String(it.at ?? '')}>{relativeTime(it.at)}</td>
                <td>{it.caller ? String(it.caller) : '—'}</td>
                <td>
                  {it.customerId ? (
                    <Link href={'/crm/customers/' + String(it.customerId)} className="crm-link">{String(it.customerName ?? 'View')}</Link>
                  ) : (String(it.customerName ?? '—'))}
                </td>
                <td>{attr(it.vendor, 'Unknown vendor')}</td>
                <td>{attr(it.source, 'Unknown source')}</td>
                <td>{attr(it.campaign, 'Unknown campaign')}</td>
                <td>
                  {qualified === true ? (
                    <span className="crm-tag" style={{ background: 'var(--crm-accent, #14b8a6)', color: '#fff' }}>Qualified</span>
                  ) : qualified === false ? (<span className="crm-tag">Unqualified</span>) : ('—')}
                </td>
                <td>{dur(it.durationSeconds)}</td>
                <td>{it.status ? String(it.status) : '—'}</td>
                <td>{it.provider ? String(it.provider) : '—'}</td>
                <td title={String(it.externalId ?? '')}>{shortId(it.externalId)}</td>
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
                  <>{' · '}<Link href={'/crm/customers/' + String(s.customerId)} className="crm-link">{String(s.customerName ?? 'View customer')}</Link></>
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
                      {e.externalId ? ' · id ' + shortId(e.externalId) : ''}
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
    case 'calls': return renderCalls(items);
    case 'websites': return renderWebsites(items);
    case 'activity':
    default: return renderActivity(items);
  }
}

export default function LiveFeed({ endpoint, variant, intervalMs = 8000, emptyText, windowLabel, properties }: LiveFeedProps) {
  const [items, setItems] = useState<Json[]>([]);
  const [status, setStatus] = useState<'loading' | 'live' | 'error' | 'unconfigured'>('loading');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [property, setProperty] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);

  const poll = useCallback(async () => {
    try {
      const url = property ? endpoint + (endpoint.includes('?') ? '&' : '?') + 'property=' + encodeURIComponent(property) : endpoint;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) { if (mounted.current) setStatus('error'); return; }
      const data = (await res.json()) as Json;
      if (!mounted.current) return;
      if (data.orgReady === false) { setStatus('unconfigured'); setItems([]); return; }
      const raw = data.items ?? data.calls ?? data.sessions;
      const next = Array.isArray(raw) ? (raw as Json[]) : [];
      setItems(next);
      setStatus('live');
      setLastSync(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }));
    } catch { if (mounted.current) setStatus('error'); }
  }, [endpoint, property]);

  useEffect(() => {
    mounted.current = true;
    poll();
    timer.current = setInterval(poll, intervalMs);
    return () => { mounted.current = false; if (timer.current) clearInterval(timer.current); };
  }, [poll, intervalMs]);

  const selectedName = property && properties ? properties.find((pp) => pp.key === property)?.name : null;
  const emptyForProperty = selectedName ? 'Awaiting live website events for ' + selectedName + '.' : emptyText;

  return (
    <div>
      {properties && properties.length > 0 ? (
        <div className="crm-prop-selector" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.85rem' }}>
          <button type="button" onClick={() => setProperty(null)}
            style={{ padding: '0.3rem 0.7rem', borderRadius: 999, border: '1px solid var(--crm-border, #e5e7eb)', background: property === null ? 'var(--crm-accent, #14b8a6)' : 'transparent', color: property === null ? '#fff' : 'inherit', cursor: 'pointer', fontSize: '0.8rem' }}>
            All properties
          </button>
          {properties.map((pp) => (
            <button key={pp.key} type="button" onClick={() => setProperty(pp.key)}
              style={{ padding: '0.3rem 0.7rem', borderRadius: 999, border: '1px solid var(--crm-border, #e5e7eb)', background: property === pp.key ? 'var(--crm-accent, #14b8a6)' : 'transparent', color: property === pp.key ? '#fff' : 'inherit', cursor: 'pointer', fontSize: '0.8rem' }}>
              {pp.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="crm-live-statusbar" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.85rem', fontSize: '0.75rem', color: 'var(--crm-faint)' }}>
        <span className={status === 'live' ? 'crm-dot-live' : 'ds-status-dot'}
          style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: status === 'live' ? '#22c55e' : status === 'error' ? '#f87171' : '#9ca3af' }} />
        <span>
          {status === 'loading' && 'Connecting to the Brain…'}
          {status === 'live' && ('Live · polling every ' + Math.round(intervalMs / 1000) + 's' + (windowLabel ? ' · ' + windowLabel : '') + (lastSync ? ' · synced ' + lastSync : ''))}
          {status === 'error' && 'Reconnecting…'}
          {status === 'unconfigured' && 'Organization not configured yet.'}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="crm-empty" style={{ margin: 0 }}>{status === 'loading' ? 'Loading…' : emptyForProperty}</p>
      ) : (
        renderVariant(variant, items)
      )}
    </div>
  );
}

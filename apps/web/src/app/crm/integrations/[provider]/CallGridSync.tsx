'use client';

import { useState } from 'react';

// CallGridSync - Sprint 17 (admin-only reconciliation control).
//
// Calls POST /api/integrations/callgrid/sync to pull recent calls from the
// CallGrid REST API (source of truth) and backfill/enrich the Loop. Shows the
// fetched / imported / enriched / skipped-duplicate / failed breakdown. No data
// is fabricated; the route is admin-gated server-side (integrations:manage).

type SyncRange = 'today' | '24h' | '7d';

interface SyncResult {
  range: string;
  fetched: number;
  imported: number;
  enriched: number;
  skippedDuplicate: number;
  failed: number;
  callers: string[];
  errors: string[];
  at: string;
}

const RANGES: { key: SyncRange; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '24h', label: 'Last 24 hours' },
  { key: '7d', label: 'Last 7 days' },
];

export function CallGridSync() {
  const [range, setRange] = useState<SyncRange>('today');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runSync() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/integrations/callgrid/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ range }),
      });

      // Read the body as text first so a non-JSON response (e.g. a gateway
      // timeout HTML page on the heavier ranges) never blows up JSON.parse.
      const raw = await res.text();
      let data: { ok?: boolean; error?: string; result?: SyncResult } | null = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = null;
      }

      if (data === null) {
        // Server returned something that isn't JSON. The usual cause is a 504
        // gateway timeout on a large range — surface a clean, actionable note.
        if (res.status === 504 || res.status === 502 || res.status === 408) {
          setError(
            'Sync took too long for this range and timed out. Try "Today" — the ' +
              'real-time webhook keeps everything else current.',
          );
        } else {
          setError('Sync failed (' + res.status + '). Please try again.');
        }
      } else if (!res.ok || !data.ok) {
        setError(data.error || ('Sync failed (' + res.status + ')'));
      } else {
        setResult(data.result as SyncResult);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="cg-sync" style={{ marginTop: 16, padding: 16, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Sync recent CallGrid calls</h3>
      <p style={{ margin: '4px 0 12px', fontSize: 12, opacity: 0.7 }}>
        Pull recent calls from the CallGrid REST API (source of truth) to backfill
        missing calls and enrich attribution. Webhooks remain the real-time layer.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => setRange(r.key)}
            disabled={loading}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.15)',
              background: range === r.key ? 'rgba(99,102,241,0.3)' : 'transparent',
              cursor: loading ? 'default' : 'pointer',
              fontSize: 12,
            }}
          >
            {r.label}
          </button>
        ))}
        <button
          type="button"
          onClick={runSync}
          disabled={loading}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: 'none',
            background: 'rgb(79,70,229)',
            color: '#fff',
            cursor: loading ? 'default' : 'pointer',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {loading ? 'Syncing...' : 'Sync now'}
        </button>
      </div>

      {error ? (
        <p style={{ marginTop: 12, fontSize: 12, color: 'rgb(248,113,113)' }}>{error}</p>
      ) : null}

      {result ? (
        <div style={{ marginTop: 12, fontSize: 12 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>Fetched: <b>{result.fetched}</b></span>
            <span>Imported: <b>{result.imported}</b></span>
            <span>Enriched: <b>{result.enriched}</b></span>
            <span>Skipped duplicate: <b>{result.skippedDuplicate}</b></span>
            <span>Failed: <b>{result.failed}</b></span>
          </div>
          {result.callers.length > 0 ? (
            <p style={{ marginTop: 8, opacity: 0.8 }}>
              Callers seen: {result.callers.slice(0, 12).join(', ')}
            </p>
          ) : null}
          {result.errors.length > 0 ? (
            <ul style={{ marginTop: 8, color: 'rgb(248,113,113)' }}>
              {result.errors.slice(0, 5).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

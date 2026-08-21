'use client';

import { useState } from 'react';

// CallGridSync - Sprint 17 (admin-only), rebuilt on the canonical poll in PR 9.
//
// Calls POST /api/integrations/callgrid/sync to pull calls from the CallGrid REST
// API and bring the Loop in sync. Admin-gated server-side (integrations:manage).
//
// WHAT THE NUMBERS MEAN NOW. `Enriched` is gone, and it is not a rename. It
// counted calls whose Interaction.metadata had been merged by a short-cut that
// never reached IngestionService -- no observation, no provenance, no fact
// convergence. That path was deleted. `Re-observed` counts calls Loop already
// held that the provider answered for again, and `Strengthened` counts the ones
// where a canonical fact actually moved. `Conflicts` counts facts the provider
// stated that DISAGREE with what Loop holds; nothing was overwritten for any of
// them, and each is recorded as a revision for a person to judge.
//
// AN INCOMPLETE READ NOW WRITES NOTHING, so a run can legitimately report zero of
// everything with an outcome explaining why. That is the honest answer, not a
// failure to display.
//
// Caller phone numbers are no longer listed here. They were decoration on an
// admin panel and there is no reason for a sync report to carry them.

type SyncRange = 'today' | '24h' | '7d';

interface SyncResult {
  range: string;
  outcome: string;
  dryRun: boolean;
  reason: string | null;
  fetchOutcome: string | null;
  fetched: number;
  accepted: number;
  refused: number;
  imported: number;
  reObserved: number;
  strengthened: number;
  conflicts: number;
  failed: number;
  notAttempted: number;
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
      let data: { ok?: boolean; error?: string; outcome?: string; result?: SyncResult } | null = null;
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
        // A 200 with ok:false is the normal shape for "the read did not complete,
        // so nothing was written". Show the outcome and its reason rather than a
        // bare error code, and still show the counts underneath.
        const detail = data.result?.reason;
        setError(
          [data.outcome ?? data.error ?? 'Sync failed (' + res.status + ')', detail]
            .filter(Boolean)
            .join(' — '),
        );
        if (data.result) setResult(data.result);
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
        Pull calls from the CallGrid REST API to backfill what the webhook missed
        and let the provider strengthen what Loop already holds. Webhooks remain
        the real-time layer. If the provider read does not complete, nothing is
        written at all.
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
          <p style={{ margin: '0 0 8px', opacity: 0.8 }}>
            Outcome: <b>{result.outcome}</b>
            {result.fetchOutcome ? ' · provider read ' + result.fetchOutcome : ''}
          </p>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>Fetched: <b>{result.fetched}</b></span>
            <span>Imported: <b>{result.imported}</b></span>
            <span>Re-observed: <b>{result.reObserved}</b></span>
            <span>Strengthened: <b>{result.strengthened}</b></span>
            <span>Conflicts: <b>{result.conflicts}</b></span>
            <span>Failed: <b>{result.failed}</b></span>
          </div>
          {result.notAttempted > 0 ? (
            <p style={{ marginTop: 8, opacity: 0.8 }}>
              {result.notAttempted} record(s) were fetched but not written.
            </p>
          ) : null}
          {result.reason ? (
            <p style={{ marginTop: 8, opacity: 0.8 }}>{result.reason}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

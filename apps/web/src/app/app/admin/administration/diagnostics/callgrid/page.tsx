// Administration › Diagnostics › CallGrid — the technical bid/provider diagnostics.
//
// Moved out of CallGrid Intelligence (which is an operator workspace, not an
// engineering console). This page preserves the endpoint sync status, provider
// grain/denominator verification, funnel contract, withheld capabilities and
// reconciliation diagnostics verbatim. It is NOT in the CallGrid tab bar and is
// restricted to authorized administrators.

import Link from 'next/link';
import { requirePermission } from '../../../../../../auth/guard';
import { loadAuctionPageData } from './diagnostics-data';

export const dynamic = 'force-dynamic';

export default async function CallGridDiagnosticsPage() {
  const session = await requirePermission('settings', 'view');
  const data = await loadAuctionPageData(session.organizationId);

  return (
    <main className="adm">
      <div className="loop-pagehead">
        <div className="loop-eyebrow">Administration · Diagnostics</div>
        <h1 className="loop-title">CallGrid</h1>
        <p className="loop-subtitle">Technical bid/provider diagnostics — endpoint sync, denominators, funnel, and reconciliation. Not part of the operator-facing CallGrid Intelligence.</p>
      </div>

      {!data.window ? (
        <section className="adm-card">
          <h2 className="adm-card__title">No bid data yet</h2>
          <p className="adm-empty">
            No auction report sync has run for this organization. This is an honest absence, not a zero.
            Run a sync with <code>POST /api/integrations/callgrid/auction-sync?date=YYYY-MM-DD</code> (one UTC day, admin only), then reload.
          </p>
        </section>
      ) : (
        <>
          <section className="adm-card">
            <h2 className="adm-card__title">Bid data status</h2>
            <p className="adm-faint">
              Window <strong>{data.window.label}</strong>. The three GET report endpoints accept no timezone parameter, so this is the window Loop <em>requested</em> in UTC — the timezone CallGrid buckets in is unverified.
            </p>
            <div className="adm-tablewrap">
              <table className="adm-table">
                <thead>
                  <tr><th>Endpoint</th><th>Status</th><th>Rows</th><th>Inserted</th><th>Updated</th><th>Skipped</th><th>Failed</th><th>Last sync</th></tr>
                </thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.endpoint}>
                      <td>{r.endpoint}</td>
                      <td>{r.status}{r.errorClassification ? ` (${r.errorClassification})` : ''}{r.truncated ? ' — TRUNCATED' : ''}</td>
                      <td>{r.rowCount === null ? 'not read' : r.rowCount}</td>
                      <td>{r.inserted}</td><td>{r.updated}</td><td>{r.skipped}</td><td>{r.failed}</td>
                      <td className="adm-faint">{r.fetchedAt.toISOString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="adm-card">
            <h2 className="adm-card__title">Verified report coverage</h2>
            <ul className="adm-list">
              <li><strong>Source grain</strong> (bidStats + rejections): {data.sourceRows} source row(s)</li>
              <li><strong>Destination grain</strong> (pingStats): {data.destinationRows} destination row(s)</li>
              <li><strong>Money unit</strong>: {data.moneyUnitProven ? 'PROVEN dollars — a money field carried a fractional part.' : 'NOT proven. Money-denominated metrics are withheld.'}</li>
            </ul>
            <p className="adm-faint">Source and destination counts are never added together — opposite sides of the marketplace, no cross-grain contract.</p>
          </section>

          <section className="adm-card">
            <h2 className="adm-card__title">Funnel contract</h2>
            <div className="adm-tablewrap">
              <table className="adm-table">
                <thead><tr><th>Transition</th><th>Numerator</th><th>Denominator</th><th>Status</th></tr></thead>
                <tbody>
                  {data.funnel.map((t) => (
                    <tr key={t.id}><td>{t.from} → {t.to}</td><td>{t.numerator}</td><td>{t.denominator}</td><td>{t.publishable ? 'publishable' : `withheld — ${t.reason}`}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className="adm-subhead">Denominator hypotheses tested against live rows</h3>
            <ul className="adm-list">
              {data.denominators.map((d) => (
                <li key={d.rate}><strong>{d.rate}</strong> = {d.numerator} / {d.denominator}: {d.verdict} — {d.note}</li>
              ))}
            </ul>
          </section>

          <section className="adm-card">
            <h2 className="adm-card__title">Reconciliation</h2>
            <p className="adm-faint">
              Compare CallGrid against Loop&rsquo;s stored snapshots for this window:{' '}
              <Link className="loop-card__link" href={`/api/integrations/callgrid/auction-reconcile?date=${data.window.windowStart.toISOString().slice(0, 10)}`}>run reconciliation</Link>.
              Read the <code>clean</code> flag, not the diff count.
            </p>
          </section>
        </>
      )}
    </main>
  );
}

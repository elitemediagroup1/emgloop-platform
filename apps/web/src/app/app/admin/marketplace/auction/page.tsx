// Auction Intelligence — the minimal operator surface.
//
// DELIBERATELY NOT a rebuild of CallGrid's report. CallGrid already renders its
// own report better than Loop can, and duplicating it would make Loop a second
// place to read the same table — with an extra sync in between to go stale.
//
// What Loop adds is the part CallGrid does not show: whether the data is
// trustworthy, what it is measured against, and which conclusions are being
// WITHHELD and why. That last section is the product. A dashboard that shows
// only what it can compute teaches an operator nothing about its own blind
// spots.
//
// Nothing unavailable renders as zero. A metric with no provider value renders
// as the reason it has no value.

import Link from 'next/link';
import { requireCrmContext } from '../../../../../crm/crm-data';
import { loadAuctionPageData } from './auction-data';
import { CallGridNav } from '../_CallGridNav';

export const dynamic = 'force-dynamic';

export default async function AuctionIntelligencePage() {
  const { organizationId } = await requireCrmContext();
  if (!organizationId) {
    return (
      <main className="loop-page">
        <h1>Bids</h1>
        <CallGridNav active="bids" />
        <p>No organization is resolved for this session.</p>
      </main>
    );
  }

  const data = await loadAuctionPageData(organizationId);

  if (!data.window) {
    return (
      <main className="loop-page">
        <h1>Bids</h1>
        <CallGridNav active="bids" />
        <section>
          <h2>No bid data yet</h2>
          <p>
            No auction report sync has run for this organization. This is an honest
            absence, not a zero: Loop has not measured CallGrid&rsquo;s bid or ping
            reports for any window.
          </p>
          <p>
            Run a sync with <code>POST /api/integrations/callgrid/auction-sync?date=YYYY-MM-DD</code>{' '}
            (one UTC day, admin only), then reload.
          </p>
        </section>
      </main>
    );
  }

  const { intelligence } = data;
  // Separate because they came from separate evidence reports — not filtered
  // apart by an id convention after the fact.
  const sourceFindings = intelligence?.source.findings ?? [];
  const destinationFindings = intelligence?.destination.findings ?? [];
  const withheldRules = [
    ...(intelligence?.source.withheld ?? []),
    ...(intelligence?.destination.withheld ?? []),
  ];

  return (
    <main className="loop-page">
      <h1>Bids</h1>
      <CallGridNav active="bids" />

      {/* 1 + 2. Status and last sync, per endpoint. */}
      <section>
        <h2>Bid data status</h2>
        <p>
          Window <strong>{data.window.label}</strong>. The three GET report endpoints
          accept no timezone parameter, so this is the window Loop <em>requested</em> in
          UTC — the timezone CallGrid buckets in is unverified.
        </p>
        <table className="loop-table">
          <thead>
            <tr>
              <th>Endpoint</th><th>Status</th><th>Rows</th>
              <th>Inserted</th><th>Updated</th><th>Skipped</th><th>Failed</th>
              <th>Last sync</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => (
              <tr key={r.endpoint}>
                <td>{r.endpoint}</td>
                <td>
                  {r.status}
                  {r.errorClassification ? ` (${r.errorClassification})` : ''}
                  {r.truncated ? ' — TRUNCATED, not complete' : ''}
                </td>
                <td>{r.rowCount === null ? 'not read' : r.rowCount}</td>
                <td>{r.inserted}</td>
                <td>{r.updated}</td>
                <td>{r.skipped}</td>
                <td>{r.failed}</td>
                <td>{r.fetchedAt.toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* 3. Coverage, kept split by grain. */}
      <section>
        <h2>Verified report coverage</h2>
        <ul>
          <li><strong>Source grain</strong> (bidStats + rejections): {data.sourceRows} source row(s)</li>
          <li><strong>Destination grain</strong> (pingStats): {data.destinationRows} destination row(s)</li>
          <li>
            <strong>Money unit</strong>:{' '}
            {data.moneyUnitProven
              ? 'PROVEN dollars — a money field carried a fractional part, which cents cannot.'
              : 'NOT proven. Every money value came back a whole number, which is consistent with dollars and equally consistent with cents. Money-denominated metrics are withheld.'}
          </li>
        </ul>
        <p>
          Source and destination counts are never added together. They are opposite
          sides of the marketplace and no cross-grain contract exists.
        </p>
      </section>

      {/* 4. Funnel — declared, with each transition's own verdict. */}
      <section>
        <h2>Funnel contract</h2>
        <p>
          Every transition declares its own numerator and denominator. A transition
          that cannot be published shows the reason instead of a number.
        </p>
        <table className="loop-table">
          <thead>
            <tr><th>Transition</th><th>Numerator</th><th>Denominator</th><th>Status</th></tr>
          </thead>
          <tbody>
            {data.funnel.map((t) => (
              <tr key={t.id}>
                <td>{t.from} → {t.to}</td>
                <td>{t.numerator}</td>
                <td>{t.denominator}</td>
                <td>{t.publishable ? 'publishable' : `withheld — ${t.reason}`}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Stages with no provider source</h3>
        <ul>
          {data.stages
            .filter((s) => s.status === 'no-provider-source' || s.status === 'unproven-equivalence')
            .map((s) => (
              <li key={s.id}><strong>{s.label}</strong> — {s.status}: {s.note}</li>
            ))}
        </ul>

        <h3>Denominator hypotheses tested against live rows</h3>
        <ul>
          {data.denominators.map((d) => (
            <li key={d.rate}>
              <strong>{d.rate}</strong> = {d.numerator} / {d.denominator}: {d.verdict} — {d.note}
            </li>
          ))}
        </ul>
      </section>

      {/* 5. Verified findings, split by grain and never ranked together. */}
      <section>
        <h2>Top verified source-level risks</h2>
        {sourceFindings.length === 0 ? (
          <p>No source-level finding cleared its evidence gate for this window.</p>
        ) : (
          <ul>
            {sourceFindings.map((f) => (
              <li key={f.id}>
                <strong>{f.whatHappened}</strong>
                <div>{f.why}</div>
                <div>
                  Evidence: {f.evidence.map((e) => e.statement).join('; ')}. Confidence{' '}
                  {f.confidence.value.toFixed(2)} over {f.confidence.sampleSize} row(s).
                </div>
                {f.recommendedAction ? <div>Recommended: {f.recommendedAction}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Top verified destination-level risks</h2>
        {destinationFindings.length === 0 ? (
          <p>No destination-level finding cleared its evidence gate for this window.</p>
        ) : (
          <ul>
            {destinationFindings.map((f) => (
              <li key={f.id}>
                <strong>{f.whatHappened}</strong>
                <div>{f.why}</div>
                <div>
                  Evidence: {f.evidence.map((e) => e.statement).join('; ')}. Confidence{' '}
                  {f.confidence.value.toFixed(2)} over {f.confidence.sampleSize} row(s).
                </div>
                {f.recommendedAction ? <div>Recommended: {f.recommendedAction}</div> : null}
              </li>
            ))}
          </ul>
        )}
        <p>
          Source and destination risks are listed separately and never ranked against
          each other.
        </p>
      </section>

      {/* 6. The section that matters most. */}
      <section>
        <h2>Withheld capabilities and the exact evidence each one needs</h2>
        {withheldRules.length > 0 ? (
          <>
            <h3>Rules suppressed on this window</h3>
            <ul>
              {withheldRules.map((w) => (
                <li key={`${w.ruleId}-${w.suppressedBy}`}>
                  <strong>{w.ruleId}</strong> — {w.reason} <em>Needs: {w.needs}</em>{' '}
                  (stopped by the {w.suppressedBy})
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <h3>Not built, and why</h3>
        <ul>
          {(intelligence?.source.unbuilt ?? []).map((u) => (
            <li key={u.id}><strong>{u.purpose}</strong> Needs: {u.needs}</li>
          ))}
        </ul>
      </section>

      {/* 7. Diagnostics. */}
      <section>
        <h2>Reconciliation diagnostics</h2>
        <p>
          Compare CallGrid against Loop&rsquo;s stored snapshots for this window:{' '}
          <Link href={`/api/integrations/callgrid/auction-reconcile?date=${data.window.windowStart.toISOString().slice(0, 10)}`}>
            run reconciliation
          </Link>
          . Read the <code>clean</code> flag, not the diff count — every money field
          appears as an explained <code>money-conversion</code> difference even on a
          perfect run.
        </p>
      </section>
    </main>
  );
}

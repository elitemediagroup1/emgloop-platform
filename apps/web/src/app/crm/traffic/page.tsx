import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos, resolveCrmOrganizationId } from '../../../crm/crm-data';
import { requirePermission } from '../../../auth/guard';

// Traffic Intelligence — Sprint 15.
//
// Vendors, traffic partners, sources, campaigns and buyers with Calls,
// Qualified %, Bookings, Revenue, Conversion and deterministic Brain insights.
// Attribution derives from Interaction.metadata written by the
// NormalizationEngine — no external ad/analytics APIs. Permission-gated by the
// 'analytics' resource. Real Neon data only; no fabricated metrics.

export const dynamic = 'force-dynamic';

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export default async function TrafficIntelligencePage() {
  await requirePermission('analytics', 'view');

  const orgId = await resolveCrmOrganizationId();

  const result = await loadOrFallback(async () => {
    if (!orgId) return null;
    return crmRepos.revenueIntelligence.trafficIntelligence(orgId);
  });

  if (!result.ok || !result.data) {
    return (
      <>
        <h1 className="crm-h1">Traffic Intelligence</h1>
        <DbNotConfigured />
      </>
    );
  }

  const traffic = result.data;
  const hasData = traffic.vendors.length > 0;

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Traffic Intelligence</h1>
          <p className="crm-sub">Vendors, sources, campaigns and buyers — calls, qualified %, conversion and revenue. Deterministic attribution, real Neon data.</p>
        </div>
      </div>

      {!hasData ? (
        <div className="crm-panel">
          <p className="crm-empty" style={{ margin: 0 }}>
            No call traffic attributed yet. As CallGrid routes inbound calls with vendor / source / campaign context,
            the Brain will rank your traffic partners here.
          </p>
        </div>
      ) : (
        <>
          <div className="crm-panel">
            <div className="crm-analytics-panel-title" style={{ marginBottom: '0.75rem' }}>Vendors &amp; Traffic Partners</div>
            <div className="crm-table-wrap" style={{ overflowX: 'auto' }}>
              <table className="crm-table">
                <thead>
                  <tr><th>Vendor</th><th>Calls</th><th>Qualified %</th><th>Bookings</th><th>Conversion %</th><th>Revenue</th><th>Brain insight</th></tr>
                </thead>
                <tbody>
                  {traffic.vendors.map((v) => (
                    <tr key={v.vendor}>
                      <td>{v.vendor}</td>
                      <td>{v.calls}</td>
                      <td>{v.qualifiedPct}%</td>
                      <td>{v.bookings}</td>
                      <td>{v.conversionPct}%</td>
                      <td>{money(v.revenueCents)}</td>
                      <td><span className="crm-faint">{v.insight}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="crm-panel">
            <div className="crm-analytics-panel-title" style={{ marginBottom: '0.75rem' }}>Sources — Vendor → Source → Campaign</div>
            <div className="crm-table-wrap" style={{ overflowX: 'auto' }}>
              <table className="crm-table">
                <thead>
                  <tr><th>Vendor</th><th>Source</th><th>Campaign</th><th>Calls</th><th>Bookings</th><th>Revenue</th></tr>
                </thead>
                <tbody>
                  {traffic.sources.map((s, idx) => (
                    <tr key={s.vendor + s.source + s.campaign + idx}>
                      <td>{s.vendor}</td>
                      <td>{s.source}</td>
                      <td>{s.campaign}</td>
                      <td>{s.calls}</td>
                      <td>{s.bookings}</td>
                      <td>{money(s.revenueCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="crm-analytics-grid">
            <div className="crm-analytics-panel">
              <div className="crm-analytics-panel-title">Campaigns</div>
              <div className="crm-table-wrap" style={{ overflowX: 'auto' }}>
                <table className="crm-table">
                  <thead><tr><th>Campaign</th><th>Vendor</th><th>Calls</th><th>Conv %</th><th>Revenue</th></tr></thead>
                  <tbody>
                    {traffic.campaigns.map((c, idx) => (
                      <tr key={c.campaign + idx}>
                        <td>{c.campaign}</td>
                        <td>{c.vendor}</td>
                        <td>{c.calls}</td>
                        <td>{c.conversionPct}%</td>
                        <td>{money(c.revenueCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="crm-analytics-panel">
              <div className="crm-analytics-panel-title">Buyers</div>
              <div className="crm-table-wrap" style={{ overflowX: 'auto' }}>
                <table className="crm-table">
                  <thead><tr><th>Buyer</th><th>Calls</th><th>Quality %</th><th>Conv %</th><th>Revenue</th></tr></thead>
                  <tbody>
                    {traffic.buyers.map((b, idx) => (
                      <tr key={b.buyer + idx}>
                        <td>{b.buyer}</td>
                        <td>{b.callsDelivered}</td>
                        <td>{b.qualityPct}%</td>
                        <td>{b.conversionPct}%</td>
                        <td>{money(b.revenueCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

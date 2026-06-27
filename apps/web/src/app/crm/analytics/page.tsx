import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos, resolveCrmOrganizationId } from '../../../crm/crm-data';
import { requirePermission } from '../../../auth/guard';

// Analytics — Sprint 10 (Loop Intelligence Foundation, Phase 4)
//          + Sprint 14 (Website Intelligence — website widgets).
//
// Foundational analytics dashboard using only real Neon data — no fake metrics.
// Sprint 14 adds website widgets (top pages, searches, CTAs, sources, cities,
// categories, journeys, website signals) — ALL derived from Brain events, not
// embedded GA reports.

export const dynamic = 'force-dynamic';

function pct(value: number, max: number): string {
  if (max === 0) return '0%';
  return Math.min(100, Math.round((value / max) * 100)) + '%';
}

export default async function AnalyticsPage() {
  await requirePermission('analytics', 'view');

  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000); // last 30 days

  const orgId = await resolveCrmOrganizationId();

  const result = await loadOrFallback(async () => {
    if (!orgId) return null;
    const [summary, velocity, website] = await Promise.all([
      crmRepos.analytics.getSummary(orgId, start, end),
      crmRepos.analytics.getVelocityMetrics(orgId, start, end),
      crmRepos.websiteAnalytics.getWebsiteAnalytics(orgId, start, end),
    ]);
    return { summary, velocity, website };
  });

  if (!result.ok || !result.data) {
    return (
      <>
        <h1 className="crm-h1">Analytics</h1>
        <DbNotConfigured />
      </>
    );
  }

  const { summary, velocity, website } = result.data;
  const totalSignals = summary.signals.total;

  const kpis = [
    { label: 'Lead Volume', value: summary.signals.intentCount, unit: 'leads' },
    { label: 'Interactions', value: summary.interactions.total, unit: 'touchpoints' },
    { label: 'Bookings', value: summary.bookings.completed, unit: 'completed' },
    { label: 'Booking Rate', value: summary.bookings.bookingRate, unit: '%' },
    {
      label: 'Avg Response',
      value: velocity.avgResponseTimeSeconds !== null
        ? Math.round(velocity.avgResponseTimeSeconds / 60)
        : 0,
      unit: 'min',
    },
    { label: 'Churn Risk', value: summary.signals.churnRiskCount, unit: 'signals' },
    { label: 'Workflow Runs', value: summary.workflows.runs, unit: 'executions' },
    { label: 'AI Conversations', value: summary.aiActivity.conversationsStarted, unit: 'started' },
  ];

  const channelEntries = Object.entries(summary.interactions.byChannel)
    .sort((a, b) => b[1] - a[1]);
  const maxChannel = Math.max(1, ...channelEntries.map(([, v]) => v));

  const signalEntries = Object.entries(summary.signals.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const maxSignal = Math.max(1, ...signalEntries.map(([, v]) => v));

  // Website widget helper: render a ranked horizontal bar list.
  const maxOf = (items: { count: number }[]) => Math.max(1, ...items.map((i) => i.count));
  function WebsitePanel({ title, items, empty }: { title: string; items: { label: string; count: number }[]; empty: string }) {
    const max = maxOf(items);
    return (
      <div className="crm-analytics-panel">
        <div className="crm-analytics-panel-title">{title}</div>
        {items.length === 0 ? (
          <p className="crm-empty" style={{ margin: 0 }}>{empty}</p>
        ) : items.map((it) => (
          <div key={it.label} className="crm-analytics-bar-row">
            <span className="crm-analytics-bar-label" title={it.label}>{it.label}</span>
            <div className="crm-analytics-bar-track">
              <div className="crm-analytics-bar-fill" style={{ width: pct(it.count, max) }} />
            </div>
            <span className="crm-analytics-bar-value">{it.count}</span>
          </div>
        ))}
      </div>
    );
  }

  const hasWebsite = website.totals.events > 0;

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Analytics</h1>
          <p className="crm-sub">Last 30 days — real Neon data only. No fabricated metrics.</p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="crm-analytics-hero">
        {kpis.map((k) => (
          <div key={k.label} className="crm-analytics-kpi">
            <div className="crm-analytics-kpi-label">{k.label}</div>
            <div className="crm-analytics-kpi-value">{k.value}</div>
            <div className="crm-analytics-kpi-unit">{k.unit}</div>
          </div>
        ))}
      </div>

      {/* Channel + Signal breakdown */}
      <div className="crm-analytics-grid">
        <div className="crm-analytics-panel">
          <div className="crm-analytics-panel-title">Interactions by Channel</div>
          {channelEntries.length === 0 ? (
            <p className="crm-empty" style={{ margin: 0 }}>No interactions yet.</p>
          ) : channelEntries.map(([ch, count]) => (
            <div key={ch} className="crm-analytics-bar-row">
              <span className="crm-analytics-bar-label">{ch}</span>
              <div className="crm-analytics-bar-track">
                <div className="crm-analytics-bar-fill" style={{ width: pct(count, maxChannel) }} />
              </div>
              <span className="crm-analytics-bar-value">{count}</span>
            </div>
          ))}
        </div>

        <div className="crm-analytics-panel">
          <div className="crm-analytics-panel-title">Signals by Type</div>
          {signalEntries.length === 0 ? (
            <p className="crm-empty" style={{ margin: 0 }}>No signals yet.</p>
          ) : signalEntries.map(([type, count]) => (
            <div key={type} className="crm-analytics-bar-row">
              <span className="crm-analytics-bar-label">{type.replace(/_/g, ' ')}</span>
              <div className="crm-analytics-bar-track">
                <div className="crm-analytics-bar-fill" style={{ width: pct(count, maxSignal) }} />
              </div>
              <span className="crm-analytics-bar-value">{count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Website Intelligence (Sprint 14) — all powered by Brain events */}
      <div className="crm-wf-head" style={{ marginTop: '1.5rem' }}>
        <div>
          <h2 className="crm-h2">Website Intelligence</h2>
          <p className="crm-sub">EMG-owned websites as a Brain sense — derived from Brain events, not embedded analytics.</p>
        </div>
      </div>

      {!hasWebsite ? (
        <div className="crm-panel">
          <p className="crm-empty" style={{ margin: 0 }}>
            The Brain is waiting for its first website signal. As visitors browse, search, and click across
            ServicesInMyCity, CareInMyCity, PetsInMyCity, and ConsumerSupportHelp, Loop Intelligence will surface
            landing pages, searches, journeys, and intent here.
          </p>
        </div>
      ) : (
        <>
          <div className="crm-analytics-hero">
            <div className="crm-analytics-kpi"><div className="crm-analytics-kpi-label">Website Events</div><div className="crm-analytics-kpi-value">{website.totals.events}</div><div className="crm-analytics-kpi-unit">tracked</div></div>
            <div className="crm-analytics-kpi"><div className="crm-analytics-kpi-label">Sessions</div><div className="crm-analytics-kpi-value">{website.totals.sessions}</div><div className="crm-analytics-kpi-unit">started</div></div>
            <div className="crm-analytics-kpi"><div className="crm-analytics-kpi-label">Searches</div><div className="crm-analytics-kpi-value">{website.totals.searches}</div><div className="crm-analytics-kpi-unit">performed</div></div>
            <div className="crm-analytics-kpi"><div className="crm-analytics-kpi-label">CTA Clicks</div><div className="crm-analytics-kpi-value">{website.totals.ctaClicks}</div><div className="crm-analytics-kpi-unit">clicks</div></div>
            <div className="crm-analytics-kpi"><div className="crm-analytics-kpi-label">Form Submits</div><div className="crm-analytics-kpi-value">{website.totals.formSubmits}</div><div className="crm-analytics-kpi-unit">forms</div></div>
            <div className="crm-analytics-kpi"><div className="crm-analytics-kpi-label">Appointments</div><div className="crm-analytics-kpi-value">{website.totals.appointmentRequests}</div><div className="crm-analytics-kpi-unit">requested</div></div>
          </div>

          <div className="crm-analytics-grid">
            <WebsitePanel title="Top Landing Pages" items={website.topLandingPages} empty="No page views yet." />
            <WebsitePanel title="Top Searches" items={website.topSearches} empty="No searches yet." />
          </div>
          <div className="crm-analytics-grid">
            <WebsitePanel title="Top CTAs" items={website.topCtas} empty="No CTA clicks yet." />
            <WebsitePanel title="Session Sources" items={website.sessionSources} empty="No sources yet." />
          </div>
          <div className="crm-analytics-grid">
            <WebsitePanel title="Top Performing Cities" items={website.topCities} empty="No city data yet." />
            <WebsitePanel title="Top Performing Categories" items={website.topCategories} empty="No category data yet." />
          </div>
          <div className="crm-analytics-grid">
            <WebsitePanel title="Most Common Journeys" items={website.commonJourneys} empty="No journeys yet." />
            <WebsitePanel title="Website Signal Breakdown" items={website.signalBreakdown} empty="No website signals yet." />
          </div>
        </>
      )}

      {/* Workflow + AI breakdown */}
      <div className="crm-analytics-grid">
        <div className="crm-analytics-panel">
          <div className="crm-analytics-panel-title">Workflow Activity</div>
          <div className="crm-analytics-bar-row">
            <span className="crm-analytics-bar-label">Succeeded</span>
            <div className="crm-analytics-bar-track">
              <div className="crm-analytics-bar-fill"
                style={{ width: pct(summary.workflows.succeeded, Math.max(1, summary.workflows.runs)) }} />
            </div>
            <span className="crm-analytics-bar-value">{summary.workflows.succeeded}</span>
          </div>
          <div className="crm-analytics-bar-row">
            <span className="crm-analytics-bar-label">Failed</span>
            <div className="crm-analytics-bar-track">
              <div className="crm-analytics-bar-fill"
                style={{ width: pct(summary.workflows.failed, Math.max(1, summary.workflows.runs)), background: 'var(--crm-red, #f87171)' }} />
            </div>
            <span className="crm-analytics-bar-value">{summary.workflows.failed}</span>
          </div>
          <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--crm-faint)' }}>
            Automation rate: {summary.workflows.automationRate}%
          </div>
        </div>

        <div className="crm-analytics-panel">
          <div className="crm-analytics-panel-title">AI Activity</div>
          <div className="crm-analytics-bar-row">
            <span className="crm-analytics-bar-label">Escalations</span>
            <div className="crm-analytics-bar-track">
              <div className="crm-analytics-bar-fill"
                style={{ width: pct(summary.aiActivity.escalations, Math.max(1, summary.aiActivity.conversationsStarted)), background: 'var(--crm-amber, #fbbf24)' }} />
            </div>
            <span className="crm-analytics-bar-value">{summary.aiActivity.escalations}</span>
          </div>
          <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--crm-faint)' }}>
            AI resolution rate: {summary.aiActivity.resolutionRate}%
          </div>
        </div>
      </div>

      {/* Pipeline summary */}
      <div className="crm-panel">
        <div className="crm-analytics-panel-title" style={{ marginBottom: '0.75rem' }}>Pipeline Summary</div>
        <div style={{ display: 'flex', gap: '2rem', fontSize: '0.85rem' }}>
          <div>
            <span style={{ color: 'var(--crm-faint)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: '0.3rem' }}>New Leads (INTENT)</span>
            <span style={{ fontSize: '1.5rem', fontWeight: 700 }}>{summary.pipeline.newLeads}</span>
          </div>
          <div>
            <span style={{ color: 'var(--crm-faint)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: '0.3rem' }}>New Customers</span>
            <span style={{ fontSize: '1.5rem', fontWeight: 700 }}>{summary.pipeline.activeCustomers}</span>
          </div>
          <div>
            <span style={{ color: 'var(--crm-faint)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: '0.3rem' }}>Total Signals</span>
            <span style={{ fontSize: '1.5rem', fontWeight: 700 }}>{totalSignals}</span>
          </div>
          <div>
            <span style={{ color: 'var(--crm-faint)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: '0.3rem' }}>Bookings (Total)</span>
            <span style={{ fontSize: '1.5rem', fontWeight: 700 }}>{summary.bookings.total}</span>
          </div>
        </div>
      </div>
    </>
  );
}

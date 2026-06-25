import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos, resolveCrmOrganizationId } from '../../../crm/crm-data';
import { requirePermission } from '../../../auth/guard';


// Analytics — Sprint 10 (Loop Intelligence Foundation, Phase 4).
//
// Foundational analytics dashboard using only real Neon data — no fake metrics.
// Shows interaction volume, signals, bookings, pipeline, and workflow/AI
// activity. All data is org-scoped and fetched through the AnalyticsRepository.


export const dynamic = 'force-dynamic';


function pct(value: number, max: number): string {
  if (max === 0) return '0%';
  return Math.min(100, Math.round((value / max) * 100)) + '%';
}

function relChange(n: number | null): { label: string; cls: string } {
  if (n === null) return { label: '', cls: '' };
  if (n > 0) return { label: '+' + n + '%', cls: 'up' };
  if (n < 0) return { label: n + '%', cls: 'down' };
  return { label: '0%', cls: 'stable' };
}


export default async function AnalyticsPage() {
  await requirePermission('analytics', 'view');

  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000); // last 30 days

  const orgId = await resolveCrmOrganizationId();

  const result = await loadOrFallback(
    async () => {
      if (!orgId) return null;
      const [summary, velocity] = await Promise.all([
        crmRepos.analytics.getSummary(orgId, start, end),
        crmRepos.analytics.getVelocityMetrics(orgId, start, end),
      ]);
      return { summary, velocity };
    },
    null,
  );

  if (!result || !result.data) {
    return (
      <>
        <h1 className="crm-h1">Analytics</h1>
        <DbNotConfigured />
      </>
    );
  }

  const { summary, velocity } = result.data;
  const totalSignals = summary.signals.total;

  const kpis = [
    {
      label: 'Lead Volume',
      value: summary.signals.intentCount,
      unit: 'leads',
      delta: null,
    },
    {
      label: 'Interactions',
      value: summary.interactions.total,
      unit: 'touchpoints',
      delta: null,
    },
    {
      label: 'Bookings',
      value: summary.bookings.completed,
      unit: 'completed',
      delta: null,
    },
    {
      label: 'Booking Rate',
      value: summary.bookings.bookingRate,
      unit: '%',
      delta: null,
    },
    {
      label: 'Avg Response',
      value: velocity.avgResponseTimeSeconds !== null
        ? Math.round(velocity.avgResponseTimeSeconds / 60)
        : 0,
      unit: 'min',
      delta: null,
    },
    {
      label: 'Churn Risk',
      value: summary.signals.churnRiskCount,
      unit: 'signals',
      delta: null,
    },
    {
      label: 'Workflow Runs',
      value: summary.workflows.runs,
      unit: 'executions',
      delta: null,
    },
    {
      label: 'AI Conversations',
      value: summary.aiActivity.conversationsStarted,
      unit: 'started',
      delta: null,
    },
  ];

  const channelEntries = Object.entries(summary.interactions.byChannel)
    .sort((a, b) => b[1] - a[1]);
  const maxChannel = Math.max(1, ...channelEntries.map(([, v]) => v));

  const signalEntries = Object.entries(summary.signals.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const maxSignal = Math.max(1, ...signalEntries.map(([, v]) => v));

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
        {kpis.map((k) => {
          const ch = relChange(k.delta);
          return (
            <div key={k.label} className="crm-analytics-kpi">
              <div className="crm-analytics-kpi-label">{k.label}</div>
              <div className="crm-analytics-kpi-value">{k.value}</div>
              <div className="crm-analytics-kpi-unit">{k.unit}</div>
              {ch.label ? (
                <div className={'crm-analytics-kpi-delta ' + ch.cls}>{ch.label} vs prior period</div>
              ) : null}
            </div>
          );
        })}
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
              <span className="crm-analytics-bar-label">{type.replace('_', ' ')}</span>
              <div className="crm-analytics-bar-track">
                <div className="crm-analytics-bar-fill" style={{ width: pct(count, maxSignal) }} />
              </div>
              <span className="crm-analytics-bar-value">{count}</span>
            </div>
          ))}
        </div>
      </div>

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
            <span className="crm-analytics-bar-label">Started</span>
            <div className="crm-analytics-bar-track">
              <div className="crm-analytics-bar-fill"
                style={{ width: pct(summary.aiActivity.conversationsStarted, Math.max(1, summary.aiActivity.conversationsStarted)) }} />
            </div>
            <span className="crm-analytics-bar-value">{summary.aiActivity.conversationsStarted}</span>
          </div>
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

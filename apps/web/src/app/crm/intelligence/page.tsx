import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos, resolveCrmOrganizationId } from '../../../crm/crm-data';
import { requirePermission } from '../../../auth/guard';


// Loop Intelligence — Sprint 10 (Loop Intelligence Foundation, Phase 5).
//
// The 3-layer intelligence engine: what happened, why, what should happen next.
// All reasoning is computed from real Neon Signal/Interaction/Booking data.
// No LLM calls. No ML models. Pure signal aggregation and rule-based insight.


export const dynamic = 'force-dynamic';


export default async function IntelligencePage() {
  await requirePermission('intelligence', 'view');

  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  const orgId = await resolveCrmOrganizationId();

  const result = await loadOrFallback(async () => {
    if (!orgId) return null;
    return crmRepos.intelligence.generateReport(orgId, start, end);
  });

  if (!result.ok || !result.data) {
    return (
      <>
        <h1 className="crm-h1">Loop Intelligence</h1>
        <DbNotConfigured />
      </>
    );
  }

  const report = result.data;

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Loop Intelligence</h1>
          <p className="crm-sub">
            3-layer intelligence — computed from real Neon data.
            No LLM calls. No fabricated insight.
          </p>
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--crm-faint)', textAlign: 'right' }}>
          Generated {new Date(report.generatedAt).toLocaleString()}<br />
          Period: last 30 days
        </div>
      </div>

      <div className="crm-intel-layers">
        {/* Layer 1: What happened? */}
        <div className="crm-intel-layer">
          <div className="crm-intel-layer-title">Layer 1 — What happened?</div>
          {report.layer1_what.length === 0 ? (
            <p className="crm-empty" style={{ margin: 0 }}>No data yet. Start capturing interactions.</p>
          ) : report.layer1_what.map((ins, i) => (
            <div key={i} className="crm-intel-insight">
              <div className="crm-intel-insight-metric">{ins.metric.replace(/_/g, ' ')}</div>
              <div className="crm-intel-insight-value">
                {ins.value}{ins.unit !== 'count' ? ' ' + ins.unit : ''}
              </div>
              <div className="crm-intel-insight-summary">{ins.summary}</div>
            </div>
          ))}
        </div>

        {/* Layer 2: Why? */}
        <div className="crm-intel-layer">
          <div className="crm-intel-layer-title">Layer 2 — Why did it happen?</div>
          {report.layer2_why.length === 0 ? (
            <p className="crm-empty" style={{ margin: 0 }}>
              No patterns detected yet. Intelligence improves as more signals accumulate.
            </p>
          ) : report.layer2_why.map((d, i) => (
            <div key={i} className="crm-intel-insight">
              <div className="crm-intel-insight-metric">
                {d.type} · confidence {Math.round(d.confidence * 100)}%
              </div>
              <div className="crm-intel-insight-summary">{d.description}</div>
            </div>
          ))}
        </div>

        {/* Layer 3: What should happen next? */}
        <div className="crm-intel-layer">
          <div className="crm-intel-layer-title">Layer 3 — What should happen next?</div>
          {report.layer3_next.length === 0 ? (
            <p className="crm-empty" style={{ margin: 0 }}>
              No recommendations yet. Recommendations appear once KPI baselines are established.
            </p>
          ) : report.layer3_next.map((rec, i) => (
            <div key={i} className={'crm-intel-rec ' + rec.priority}>
              <div className="crm-intel-rec-title">{rec.title}</div>
              <div className="crm-intel-rec-desc">{rec.description}</div>
              <div className="crm-intel-rec-kpi">KPI: {rec.kpiImpacted}</div>
              {rec.workflowSuggestion ? (
                <div className="crm-intel-rec-workflow">
                  Workflow suggestion: {rec.workflowSuggestion}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="crm-panel" style={{ fontSize: '0.8rem', color: 'var(--crm-muted)' }}>
        <strong style={{ color: 'var(--crm-fg)' }}>How intelligence works</strong>
        <p style={{ margin: '0.5rem 0 0' }}>
          Layer 1 (descriptive) reads Signal + Interaction counts from Neon.
          Layer 2 (diagnostic) detects correlations between signal types.
          Layer 3 (prescriptive) generates ranked recommendations from KPI gaps — no autonomous actions.
          Future sprints will layer LLM reasoning on top without reworking this foundation.
        </p>
      </div>
    </>
  );
}

import * as React from 'react';
import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos, requireCrmContext } from '../../../crm/crm-data';
import { requirePermission } from '../../../auth/guard';

// Loop Intelligence — Sprint 10 engine, re-skinned as the signature Brain
// page in Sprint 13. The 3-layer intelligence report logic below is UNCHANGED
// (same real-Neon data, same rules, no LLM). Sprint 13 adds a premium page
// header and the visual Brain Pipeline flow on top. Presentation only.

export const dynamic = 'force-dynamic';

const PIPELINE: { name: string; desc: string }[] = [
  { name: 'Events', desc: 'Provider → Adapter → Integration Event' },
  { name: 'Signals', desc: 'Deterministic detection from the Signal Registry' },
  { name: 'Memory', desc: 'Structured customer & organization memory' },
  { name: 'Identity', desc: 'Resolve people & businesses across channels' },
  { name: 'Intent', desc: 'What the customer is trying to do' },
  { name: 'Reasoning', desc: 'Customer Intelligence Graph' },
  { name: 'Recommendations', desc: 'Next Best Action with confidence' },
  { name: 'Actions', desc: 'Workflows · CRM · AI Employees' },
  { name: 'Revenue', desc: 'Attribution → Revenue Intelligence' },
];

export default async function IntelligencePage() {
  await requirePermission('intelligence', 'view');

  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  const { organizationId: orgId } = await requireCrmContext();

  const result = await loadOrFallback(async () => {
    if (!orgId) return null;
    return crmRepos.intelligence.generateReport(orgId, start, end);
  });

  const header = (
    <div className="ds-pagehead">
      <div>
        <div className="ds-eyebrow">The EMG Brain</div>
        <h1 className="ds-title">Intelligence Flow</h1>
        <p className="ds-subtitle">
          Every event flows through one architecture — computed from real Neon data, no LLM.
        </p>
      </div>
    </div>
  );

  const flow = (
    <section className="ds-card" style={{ marginBottom: '1.4rem' }}>
      <div className="ds-card-head">
        <span className="crm-dot-live" />
        <h3>Brain Pipeline</h3>
        <span className="more">Provider → Brain → Revenue</span>
      </div>
      <div className="ds-card-body">
        <div className="ds-flow">
          {PIPELINE.map((node, i) => (
            <React.Fragment key={node.name}>
              <div className="ds-flow-node">
                <div className="fn-name">{node.name}</div>
                <div className="fn-desc">{node.desc}</div>
              </div>
              {i < PIPELINE.length - 1 ? <div className="ds-flow-arrow" /> : null}
            </React.Fragment>
          ))}
        </div>
      </div>
    </section>
  );

  if (!result.ok || !result.data) {
    return (
      <>
        {header}
        {flow}
        <DbNotConfigured />
      </>
    );
  }

  const report = result.data;

  return (
    <>
      {header}
      {flow}

      <div className="crm-wf-head">
        <div>
          <h2 className="crm-h1" style={{ fontSize: '1.1rem' }}>3-Layer Intelligence Report</h2>
          <p className="crm-sub">
            Computed from real Neon data. No LLM calls. No fabricated insight.
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

      <div className="crm-panel" style={{ fontSize: '0.8rem', color: 'var(--crm-muted)', padding: '1rem' }}>
        <strong style={{ color: 'var(--crm-text)' }}>How intelligence works</strong>
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

// Executive Brain — the executive-facing view (Sprint 26).
//
// Renders what the Brain concluded, narrative-first: System Health, Cross-Sensor
// Insights, Executive Summary, What Changed, Top Risks, Top Opportunities,
// Recommended Actions, and a first-class Evidence Coverage board that shows which
// systems are connected / healthy / stale / missing.
//
// It is NOT a dashboard — no raw percentages or tables on the surface. Every raw
// number lives behind an "Evidence" toggle, expanded only on demand (the
// NO-RAW-REPORTS rule), where each observation's Details show the observed facts,
// the evidence with coverage and provenance, its confidence, its recommended
// action, and the affected business area. It computes nothing and fabricates
// nothing: every card is an ExecutiveObservation that already traces to a metric
// which cleared the Evidence Engine. A Server Component with zero client JS —
// expansion uses native <details>.

import Link from 'next/link';
import { SidebarIcon } from '../../../crm/_brand/SidebarIcon';
import type {
  ExecutiveBrainReport,
  ExecutiveObservation,
  ObservationEvidence,
  ObservationSeverity,
  SensorCoverage,
  SensorStatus,
} from '@emgloop/intelligence';

function confPct(c: number): string {
  return `${Math.round(c * 100)}%`;
}

/** Map our four severities onto the severity styles already in loop-os.css. */
const SEV_CLASS: Record<ObservationSeverity, string> = {
  critical: 'critical',
  high: 'high',
  notable: 'moderate',
  informational: 'informational',
};

function changeArrow(dir: 'up' | 'down' | 'flat'): string {
  return dir === 'up' ? '▲' : dir === 'down' ? '▼' : '→';
}

function EvidenceDetail({ evidence }: { evidence: readonly ObservationEvidence[] }) {
  return (
    <details className="mkt-intel__evidence">
      <summary className="mkt-cov__key">Details — observed facts, evidence &amp; confidence</summary>
      <ul className="mkt-intel__ev-list">
        {evidence.map((e, i) => (
          <li key={e.metricId + i}>
            <strong>{e.label}</strong> · {confPct(e.confidence)} confidence
            {e.coverage ? (
              <span className="mkt-cov__ratio">
                {' '}
                {e.coverage.observed.toLocaleString()} /{' '}
                {e.coverage.total === null ? 'unknown' : e.coverage.total.toLocaleString()}
              </span>
            ) : null}
            <ul className="mkt-intel__ev-list">
              {e.facts.map((f, j) => (
                <li key={f.statement + j}>
                  {f.statement}: <strong>{f.observed.toLocaleString()}</strong>
                  {f.denominator !== null ? ` of ${f.denominator.toLocaleString()}` : ''}
                  <span className="mkt-cov__cite"> {f.source}</span>
                </li>
              ))}
              {e.provenance.map((p) => (
                <li key={p.sourceId} className="mkt-cov__cite">
                  {p.sourceLabel} — {p.derivation}
                  {p.citation ? ` (${p.citation})` : ''}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ObservationCard({ o }: { o: ExecutiveObservation }) {
  return (
    <li className={'mkt-intel__item mkt-intel__item--' + SEV_CLASS[o.severity]}>
      <div className="mkt-intel__head">
        <span className={'mkt-intel__sev mkt-intel__sev--' + SEV_CLASS[o.severity]}>{o.severity}</span>
        <span className="mkt-intel__what">
          {o.change ? <span className={'loop-change__arrow'}>{changeArrow(o.change.direction)} </span> : null}
          {o.observation}
        </span>
      </div>

      {o.businessImpact ? (
        <p className="mkt-cov__reason">
          <span className="mkt-cov__key">Why it matters</span> {o.businessImpact}
        </p>
      ) : null}

      <p className="mkt-cov__reason">
        <span className="mkt-cov__key">Confidence</span> {confPct(o.confidence)} — derived from the Evidence Engine
        {' · '}
        <span className="mkt-cov__key">Affected area</span> {o.affectedArea}
        {o.owner ? (
          <>
            {' · '}
            <span className="mkt-cov__key">Owner</span> {o.owner}
          </>
        ) : null}
      </p>

      {o.recommendation ? (
        <p className="mkt-intel__action">
          <span className="mkt-cov__key">Do next</span> {o.recommendation.action}
          {o.recommendation.expectedImpact ? ` — ${o.recommendation.expectedImpact}` : ''}
        </p>
      ) : null}

      <EvidenceDetail evidence={o.evidence} />
    </li>
  );
}

function Section({
  title,
  subtitle,
  observations,
  emptyTitle,
  emptyBody,
  badgeTone,
}: {
  title: string;
  subtitle?: string;
  observations: readonly ExecutiveObservation[];
  emptyTitle: string;
  emptyBody: string;
  badgeTone?: 'good' | 'warn';
}) {
  return (
    <section className="loop-card mkt-intel" aria-label={title}>
      <div className="loop-card__head">
        <h2 className="loop-card__title">{title}</h2>
        {observations.length > 0 && badgeTone ? (
          <span className={'loop-badge loop-badge--' + badgeTone}>{observations.length}</span>
        ) : null}
      </div>
      {subtitle ? <p className="mkt-cov__lead">{subtitle}</p> : null}
      {observations.length > 0 ? (
        <ol className="mkt-intel__list">
          {observations.map((o) => (
            <ObservationCard key={o.id} o={o} />
          ))}
        </ol>
      ) : (
        <div className="loop-empty">
          <p className="loop-empty__title">{emptyTitle}</p>
          <p className="loop-empty__body">{emptyBody}</p>
        </div>
      )}
    </section>
  );
}

const STATUS_LABEL: Record<SensorStatus, string> = {
  healthy: 'Healthy',
  stale: 'Stale',
  connected: 'Connected',
  missing: 'Missing',
};
const STATUS_COV: Record<SensorStatus, string> = {
  healthy: 'available',
  stale: 'partial',
  connected: 'undetermined',
  missing: 'unavailable',
};

function SensorCoverageRow({ s }: { s: SensorCoverage }) {
  return (
    <li className={'mkt-cov__row mkt-cov__row--' + STATUS_COV[s.status]}>
      <div className="mkt-cov__head">
        <span className="mkt-cov__label">{s.label}</span>
        <span className={'mkt-cov__status mkt-cov__status--' + STATUS_COV[s.status]}>{STATUS_LABEL[s.status]}</span>
        {s.instrumented ? (
          <span className="mkt-cov__ratio">
            {s.metricsAvailable} available · {s.metricsWithheld} withheld
          </span>
        ) : null}
      </div>

      {s.instrumented ? (
        <>
          <p className="mkt-cov__evidence">
            {s.scopeLabel ? `Scope: ${s.scopeLabel}. ` : ''}
            {(s.populationSize ?? 0).toLocaleString()} record(s) examined.
          </p>
          {s.withheld.length > 0 ? (
            <ul className="mkt-intel__ev-list">
              {s.withheld.map((w) => (
                <li key={w.label}>
                  <strong>{w.label}</strong> — {w.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <>
          <p className="mkt-cov__reason">
            <span className="mkt-cov__key">Why</span> {s.uninstrumentedReason}
          </p>
          {s.unblockedBy ? (
            <p className="mkt-cov__reason">
              <span className="mkt-cov__key">To connect it</span> {s.unblockedBy}
            </p>
          ) : null}
        </>
      )}
    </li>
  );
}

export function ExecutiveBrainView({ report }: { report: ExecutiveBrainReport }) {
  const { systemHealth, evidenceCoverage, suppressed } = report;
  const sc = evidenceCoverage.statusCounts;

  // Read the board most-trustworthy first, then the gaps.
  const order: SensorStatus[] = ['healthy', 'stale', 'connected', 'missing'];
  const sensorRows = [...evidenceCoverage.sensors].sort(
    (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
  );

  return (
    <>
      {/* System Health — derived, auditable, never authored. */}
      <section className="loop-card mkt-intel" aria-label="System Health">
        <div className="loop-card__head">
          <h2 className="loop-card__title">System Health</h2>
          <span className={'mkt-intel__health mkt-intel__health--' + healthBand(systemHealth.band)}>
            {healthLabel(systemHealth.band)}
          </span>
        </div>
        <div className="mkt-intel__summary">
          {systemHealth.components.map((c) => (
            <p key={c.name} className="mkt-intel__summary-line">
              <strong>{c.name}:</strong> {c.detail}
            </p>
          ))}
        </div>
        {systemHealth.caveat ? <p className="mkt-intel__caveat">{systemHealth.caveat}</p> : null}
      </section>

      {/* Cross-Sensor Insights — the join no single dashboard can show. */}
      <Section
        title="Cross-Sensor Insights"
        subtitle="Conclusions the Brain drew by correlating signals across systems. Each fires only when every signal it joins was independently evidenced, and cites them below."
        observations={report.correlations}
        emptyTitle="No cross-sensor pattern surfaced."
        emptyBody="When two systems move in a way that means more together than apart — traffic up while conversion falls, say — it appears here with both signals as evidence."
        badgeTone="warn"
      />

      {/* Executive Summary — narrative-first. */}
      <Section
        title="Executive Summary"
        observations={report.summary}
        emptyTitle="Nothing to brief yet."
        emptyBody="Once a sensor observes real activity, the Brain summarizes what happened, why it matters, and what to do — each statement backed by evidence."
      />

      {/* What Changed — real two-window movements. */}
      <Section
        title="What Changed"
        subtitle="Movements between this window and the one before it. A change is shown only when the metric behind it cleared the Evidence Engine in both windows."
        observations={report.whatChanged}
        emptyTitle="Not enough data to state what changed."
        emptyBody="A change needs a comparable prior window with measured evidence. It appears once two periods of real data exist."
      />

      {/* Top Risks */}
      <Section
        title="Top Risks"
        observations={report.risks}
        emptyTitle="No material risk surfaced."
        emptyBody="No instrumented sensor produced a risk that cleared the Evidence Engine. Risks appear here severity-first, with the evidence behind them."
        badgeTone="warn"
      />

      {/* Top Opportunities */}
      <Section
        title="Top Opportunities"
        observations={report.opportunities}
        emptyTitle="No scalable upside identified yet."
        emptyBody="When a sensor shows evidence-backed upside worth pursuing, it appears here with the numbers behind it."
        badgeTone="good"
      />

      {/* Recommended Actions */}
      <Section
        title="Recommended Actions"
        observations={report.recommendations}
        emptyTitle="No action recommended."
        emptyBody="The Brain only recommends an action when evidence supports one. Until then, recommending work would be guesswork."
      />

      {/* Evidence Coverage — the first-class connected/healthy/stale/missing board. */}
      <section className="loop-card mkt-cov" aria-label="Evidence Coverage">
        <div className="loop-card__head">
          <h2 className="loop-card__title">Evidence Coverage</h2>
          <span className="mkt-cov__window">
            {evidenceCoverage.instrumentedSensors} of {evidenceCoverage.totalSensors} sensors instrumented
          </span>
        </div>
        <p className="mkt-cov__lead">
          Which systems feed the Brain, and how well.{' '}
          {evidenceCoverage.overallConfidence === null
            ? 'No metric is currently measured, so there is no overall confidence to state — this is unknown, not zero.'
            : `Overall evidence confidence is ${confPct(evidenceCoverage.overallConfidence)} across every available metric.`}
        </p>
        <div className="mkt-cov__totals">
          <span className="mkt-cov__total mkt-cov__total--available">{sc.healthy} healthy</span>
          <span className="mkt-cov__total mkt-cov__total--undetermined">{sc.connected} connected</span>
          <span className="mkt-cov__total mkt-cov__total--partial">{sc.stale} stale</span>
          <span className="mkt-cov__total mkt-cov__total--unavailable">{sc.missing} missing</span>
        </div>
        <ul className="mkt-cov__list">
          {sensorRows.map((s) => (
            <SensorCoverageRow key={s.sensorId} s={s} />
          ))}
        </ul>
      </section>

      {/* The honest edges: what the Brain refused to conclude. Never hidden. */}
      {suppressed.length > 0 ? (
        <section className="loop-card mkt-intel" aria-label="What the Brain could not conclude">
          <div className="loop-card__head">
            <h2 className="loop-card__title">What the Brain could not conclude</h2>
            <span className="loop-badge loop-badge--idle">Honest</span>
          </div>
          <ul className="mkt-intel__ev-list">
            {suppressed.map((s) => (
              <li key={s.sensorId + ':' + s.findingId}>
                <strong>{s.observation}</strong> — {s.reason} Needs: {s.needs}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="mkt-cov__lead">
        <Link className="loop-card__link" href="/app/admin/marketplace/activity">
          Drill into marketplace evidence →
        </Link>
      </p>
    </>
  );
}

function healthBand(band: ExecutiveBrainReport['systemHealth']['band']): string {
  return band === 'healthy'
    ? 'healthy'
    : band === 'watch'
      ? 'degraded'
      : band === 'at_risk'
        ? 'impaired'
        : 'unmeasured';
}

function healthLabel(band: ExecutiveBrainReport['systemHealth']['band']): string {
  return band === 'healthy'
    ? 'Healthy'
    : band === 'watch'
      ? 'Watch'
      : band === 'at_risk'
        ? 'At risk'
        : 'Unmeasured';
}

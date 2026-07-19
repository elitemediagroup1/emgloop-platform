// Executive Brain — the executive-facing view.
//
// It renders what the Brain concluded, narrative-first: Executive Summary, Top
// Risks, Top Opportunities, Recommended Actions, System Health, Evidence
// Coverage. It is NOT a dashboard — there are no raw bid/won/rejected percentages
// or tables on the surface. Every such number lives behind an "Evidence" toggle,
// expanded only on demand (the mission's NO-RAW-REPORTS rule), where it is shown
// with its coverage and provenance so a reader can audit the conclusion.
//
// It computes nothing and fabricates nothing: every card is an
// `ExecutiveObservation`, and each one already traces to a metric that cleared
// the Evidence Engine. An empty section renders an honest empty state, never a
// zero. This is a Server Component with zero client JS — evidence expansion uses
// native <details>.

import Link from 'next/link';
import { SidebarIcon } from '../../../crm/_brand/SidebarIcon';
import type {
  ExecutiveBrainReport,
  ExecutiveObservation,
  ObservationEvidence,
  ObservationSeverity,
  SensorCoverage,
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

function EvidenceDetail({ evidence }: { evidence: readonly ObservationEvidence[] }) {
  return (
    <details className="mkt-intel__evidence">
      <summary className="mkt-cov__key">Evidence ({evidence.length}) — expand for the numbers</summary>
      <ul className="mkt-intel__ev-list">
        {evidence.map((e) => (
          <li key={e.metricId}>
            <strong>{e.label}</strong> · {confPct(e.confidence)} confidence
            {e.coverage ? (
              <span className="mkt-cov__ratio">
                {' '}
                {e.coverage.observed.toLocaleString()} /{' '}
                {e.coverage.total === null ? 'unknown' : e.coverage.total.toLocaleString()}
              </span>
            ) : null}
            <ul className="mkt-intel__ev-list">
              {e.facts.map((f) => (
                <li key={f.statement}>
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
        <span className="mkt-intel__what">{o.observation}</span>
      </div>

      {o.businessImpact ? (
        <p className="mkt-cov__reason">
          <span className="mkt-cov__key">Why it matters</span> {o.businessImpact}
        </p>
      ) : null}

      <p className="mkt-cov__reason">
        <span className="mkt-cov__key">Confidence</span> {confPct(o.confidence)} — derived from the Evidence Engine
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
  count,
  observations,
  emptyTitle,
  emptyBody,
  badgeTone,
}: {
  title: string;
  count: number;
  observations: readonly ExecutiveObservation[];
  emptyTitle: string;
  emptyBody: string;
  badgeTone?: 'good' | 'warn';
}) {
  return (
    <section className="loop-card mkt-intel" aria-label={title}>
      <div className="loop-card__head">
        <h2 className="loop-card__title">{title}</h2>
        {count > 0 && badgeTone ? (
          <span className={'loop-badge loop-badge--' + badgeTone}>{count}</span>
        ) : null}
      </div>
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

function SensorCoverageRow({ s }: { s: SensorCoverage }) {
  return (
    <li className={'mkt-cov__row mkt-cov__row--' + (s.instrumented ? 'available' : 'undetermined')}>
      <div className="mkt-cov__head">
        <span className="mkt-cov__label">{s.label}</span>
        <span
          className={
            'mkt-cov__status mkt-cov__status--' + (s.instrumented ? 'available' : 'undetermined')
          }
        >
          {s.instrumented ? 'Instrumented' : 'Not yet instrumented'}
        </span>
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
            {s.populationSize ?? 0} record(s) examined.
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
              <span className="mkt-cov__key">To wire it</span> {s.unblockedBy}
            </p>
          ) : null}
        </>
      )}
    </li>
  );
}

export function ExecutiveBrainView({ report }: { report: ExecutiveBrainReport }) {
  const { systemHealth, evidenceCoverage, suppressed } = report;

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

      {/* Executive Summary — narrative-first. */}
      <Section
        title="Executive Summary"
        count={report.summary.length}
        observations={report.summary}
        emptyTitle="Nothing to brief yet."
        emptyBody="Once a sensor observes real activity, the Brain summarizes what happened, why it matters, and what to do — each statement backed by evidence."
      />

      {/* Top Risks */}
      <Section
        title="Top Risks"
        count={report.risks.length}
        observations={report.risks}
        emptyTitle="No material risk surfaced."
        emptyBody="No instrumented sensor produced a risk that cleared the Evidence Engine. Risks appear here severity-first, with the evidence behind them."
        badgeTone="warn"
      />

      {/* Top Opportunities */}
      <Section
        title="Top Opportunities"
        count={report.opportunities.length}
        observations={report.opportunities}
        emptyTitle="No scalable upside identified yet."
        emptyBody="When a sensor shows evidence-backed upside worth pursuing, it appears here with the numbers behind it."
        badgeTone="good"
      />

      {/* Recommended Actions */}
      <Section
        title="Recommended Actions"
        count={report.recommendations.length}
        observations={report.recommendations}
        emptyTitle="No action recommended."
        emptyBody="The Brain only recommends an action when evidence supports one. Until then, recommending work would be guesswork."
      />

      {/* Evidence Coverage — the reach of the Brain, stated honestly. */}
      <section className="loop-card mkt-cov" aria-label="Evidence Coverage">
        <div className="loop-card__head">
          <h2 className="loop-card__title">Evidence Coverage</h2>
          <span className="mkt-cov__window">
            {evidenceCoverage.instrumentedSensors} of {evidenceCoverage.totalSensors} sensors instrumented
          </span>
        </div>
        <p className="mkt-cov__lead">
          Which sensors feed the Brain, and how far each one can see.{' '}
          {evidenceCoverage.overallConfidence === null
            ? 'No metric is currently measured, so there is no overall confidence to state — this is unknown, not zero.'
            : `Overall evidence confidence is ${confPct(evidenceCoverage.overallConfidence)} across every available metric.`}
        </p>
        <ul className="mkt-cov__list">
          {evidenceCoverage.sensors.map((s) => (
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

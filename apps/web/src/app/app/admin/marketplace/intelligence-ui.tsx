// The CallGrid Intelligence design language — one set of components for every
// surface that renders a finding, its evidence, or what Loop cannot determine.
//
// Presentational server components only. The evidence drawer is a native
// <details>, so inspecting a conclusion costs no client JavaScript — this app has
// five 'use client' files and none of them are layouts, which is worth keeping.
//
// A finding arrives complete (evidence, limitations, unknowns, rule version).
// These components render what it carries; they never compute, re-word, or
// soften it, and there is no code path here that can display a conclusion
// without the means to check it.

import type { ReactNode } from 'react';
import type {
  CallGridFinding, CallGridEvidenceReference, IntelligenceUnknown,
  MetricClassification, Severity, AffectedEntity,
  ExecutiveBrief, IntelligenceScore, ScoredFinding,
  MarketplaceRisk, RiskBand,
} from '@emgloop/shared';

const SEV_LABEL: Record<Severity, string> = {
  CRITICAL: 'Critical', HIGH: 'High', NOTABLE: 'Notable', INFORMATIONAL: 'Informational',
};
const SEV_CLASS: Record<Severity, string> = {
  CRITICAL: 'critical', HIGH: 'high', NOTABLE: 'notable', INFORMATIONAL: 'informational',
};

/** How a value was arrived at. Shown so a reader can weigh it without guessing. */
const CLASS_LABEL: Record<MetricClassification, string> = {
  VERIFIED: 'Verified',
  DERIVED: 'Derived',
  INFERRED: 'Inferred',
  UNKNOWN: 'Unknown',
  UNAVAILABLE: 'Unavailable',
};
const CLASS_TITLE: Record<MetricClassification, string> = {
  VERIFIED: 'Reported directly by CallGrid.',
  DERIVED: 'Calculated from reported values using a versioned formula.',
  INFERRED: 'A conclusion drawn from verified and derived evidence, not stated by CallGrid.',
  UNKNOWN: 'Not enough evidence to determine this.',
  UNAVAILABLE: 'CallGrid does not expose the data this needs.',
};

export function ClassificationTag({ value }: { value: MetricClassification }) {
  return (
    <span className={'cg-class cg-class--' + value.toLowerCase()} title={CLASS_TITLE[value]}>
      {CLASS_LABEL[value]}
    </span>
  );
}

export function SeverityTag({ value }: { value: Severity }) {
  return <span className={'cg-sev cg-sev--' + SEV_CLASS[value]}>{SEV_LABEL[value]}</span>;
}

// --- Evidence ------------------------------------------------------------------

function evValue(e: CallGridEvidenceReference): string {
  const v = e.derivedValue ?? e.normalizedValue ?? e.rawValue;
  if (v === null) return 'Unknown';
  // Fractions (shares, rates, changes) read as percentages; counts and cents do not.
  if (Math.abs(v) <= 1 && !Number.isInteger(v)) return (v * 100).toFixed(1) + '%';
  return v.toLocaleString('en-US');
}

/**
 * The inspectable basis for one finding: which report, which period, which
 * entity, the raw value, the formula and its version, and what limits it.
 */
export function EvidenceDrawer({ finding }: { finding: CallGridFinding }) {
  return (
    <details className="cg-eviddrawer">
      <summary className="cg-evidsummary">
        Evidence · {finding.supportingEvidence.length} value{finding.supportingEvidence.length === 1 ? '' : 's'}
      </summary>
      <div className="cg-evidbody">
        <dl className="cg-evidmeta">
          <div><dt>Selected period</dt><dd>{finding.currentWindow}</dd></div>
          <div><dt>Comparison period</dt><dd>{finding.comparisonWindow ?? 'None'}</dd></div>
          <div><dt>Rule</dt><dd>{finding.ruleId} · {finding.ruleVersion}</dd></div>
          <div><dt>Confidence</dt><dd>{Math.round(finding.confidence * 100)}%</dd></div>
        </dl>

        <div className="adm-tablewrap">
          <table className="adm-table cg-evidtable">
            <thead>
              <tr>
                <th>Value</th>
                <th>Period</th>
                <th>Entity</th>
                <th className="dim-num">Amount</th>
                <th>Source</th>
                <th>How</th>
              </tr>
            </thead>
            <tbody>
              {finding.supportingEvidence.map((e) => (
                <tr key={e.id}>
                  <td>{e.metricKey}</td>
                  <td>{e.window}</td>
                  <td>{e.entityName ?? '—'}</td>
                  <td className="dim-num">{evValue(e)}</td>
                  <td>
                    {e.providerReport}
                    {e.providerField ? <span className="cg-evidfield"> · {e.providerField}</span> : null}
                  </td>
                  <td>
                    <ClassificationTag value={e.classification} />
                    {e.formula ? <div className="cg-evidformula">{e.formula} ({e.formulaVersion})</div> : null}
                    {e.completeness !== null && e.completeness < 1 ? (
                      <div className="cg-evidnote">{Math.round(e.completeness * 100)}% reported</div>
                    ) : null}
                    {e.notes ? <div className="cg-evidnote">{e.notes}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {finding.limitations.length > 0 ? (
          <div className="cg-evidsec">
            <p className="cg-evidsec__title">What limits this</p>
            <ul className="cg-evidlist">
              {finding.limitations.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          </div>
        ) : null}

        {finding.unknowns.length > 0 ? (
          <div className="cg-evidsec">
            <p className="cg-evidsec__title">What Loop cannot determine</p>
            <ul className="cg-evidlist">
              {finding.unknowns.map((u, i) => <li key={i}>{u}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

// --- Findings --------------------------------------------------------------------

function ContributorList({ entities }: { entities: AffectedEntity[] }) {
  if (entities.length === 0) return null;
  return (
    <ul className="cg-contriblist">
      {entities.map((e) => (
        <li key={e.entityId}>
          <span className="cg-contribname">{e.entityName}</span>
          {e.contributionToChange !== null ? (
            <span className="cg-contribshare">{Math.round(Math.abs(e.contributionToChange) * 100)}% of the change</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** One finding: what it is, why it matters, what to review, and its evidence. */
export function FindingCard({ finding, compact = false }: { finding: CallGridFinding; compact?: boolean }) {
  return (
    <article className="cg-finding" aria-label={finding.title}>
      <header className="cg-finding__head">
        <SeverityTag value={finding.severity} />
        <h3 className="cg-finding__title">{finding.title}</h3>
        <ClassificationTag value={finding.classification} />
      </header>
      <p className="cg-finding__summary">{finding.plainLanguageSummary}</p>

      {!compact && finding.drivers.length > 0 ? (
        <ContributorList entities={finding.drivers} />
      ) : null}

      {finding.recommendedReview ? (
        <p className="cg-finding__review">
          <span className="cg-finding__reviewlabel">Recommended review</span>
          {finding.recommendedReview}
        </p>
      ) : null}

      <EvidenceDrawer finding={finding} />
    </article>
  );
}

/** A list of findings, or an honest statement that there were none. */
export function FindingList({
  findings, emptyLine, sectionLabel, link, compact,
}: {
  findings: CallGridFinding[];
  emptyLine: string;
  sectionLabel: string;
  link?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="cg-sec">
      <div className="cg-sechead">
        <p className="cg-seclabel">{sectionLabel}</p>
        {link ?? null}
      </div>
      {findings.length === 0 ? (
        <section className="tile tile--wide"><p className="tile__line cg-muted">{emptyLine}</p></section>
      ) : (
        <div className="cg-findings">
          {findings.map((f) => <FindingCard key={f.id} finding={f} compact={compact} />)}
        </div>
      )}
    </div>
  );
}

// --- Unknowns ------------------------------------------------------------------------

/**
 * What Loop cannot determine, shown wherever it constrains interpretation.
 *
 * This section is not an apology — it is the difference between a tool that can
 * be trusted with a decision and one that quietly fills its gaps.
 */
export function UnknownsSection({
  unknowns,
  sectionLabel = 'What Loop Cannot Determine',
}: {
  unknowns: IntelligenceUnknown[];
  sectionLabel?: string;
}) {
  if (unknowns.length === 0) return null;
  return (
    <div className="cg-sec">
      <p className="cg-seclabel">{sectionLabel}</p>
      <section className="tile tile--wide" aria-label={sectionLabel}>
        <ul className="cg-unknowns">
          {unknowns.map((u) => (
            <li className="cg-unknown" key={u.id}>
              <span className="cg-unknown__statement">{u.statement}</span>
              <span className="cg-unknown__reason">{u.reason}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// --- Executive intelligence ------------------------------------------------------------

/**
 * The Overview's answer to "what happened, why, and what should I look at".
 *
 * Deliberately bounded: one primary statement, up to three drivers, one concern,
 * one opportunity, up to three reviews. Everything else lives on the subpages.
 * A wall of findings is not intelligence; it is a second report to read.
 */
export function ExecutiveIntelligence({
  headline, primaryChange, drivers, topConcern, topOpportunity, recommendedReviews,
}: {
  headline: string;
  primaryChange: CallGridFinding | null;
  drivers: CallGridFinding[];
  topConcern: CallGridFinding | null;
  topOpportunity: CallGridFinding | null;
  recommendedReviews: string[];
}) {
  return (
    <div className="cg-sec">
      <p className="cg-seclabel">Executive Intelligence</p>
      <section className="tile tile--wide cg-exec" aria-label="Executive Intelligence">
        <p className="cg-exec__headline">{headline}</p>

        {primaryChange ? (
          <div className="cg-exec__block">
            <p className="cg-exec__blocktitle">What changed</p>
            <FindingCard finding={primaryChange} compact />
          </div>
        ) : null}

        {drivers.length > 0 ? (
          <div className="cg-exec__block">
            <p className="cg-exec__blocktitle">Why it changed</p>
            <div className="cg-findings">
              {drivers.map((f) => <FindingCard key={f.id} finding={f} compact />)}
            </div>
          </div>
        ) : null}

        {topConcern ? (
          <div className="cg-exec__block">
            <p className="cg-exec__blocktitle">Top concern</p>
            <FindingCard finding={topConcern} compact />
          </div>
        ) : null}

        {topOpportunity && topOpportunity.id !== topConcern?.id ? (
          <div className="cg-exec__block">
            <p className="cg-exec__blocktitle">Top opportunity</p>
            <FindingCard finding={topOpportunity} compact />
          </div>
        ) : null}

        {recommendedReviews.length > 0 ? (
          <div className="cg-exec__block">
            <p className="cg-exec__blocktitle">What to review, in order</p>
            <ol className="cg-exec__reviews">
              {recommendedReviews.map((r, i) => <li key={i}>{r}</li>)}
            </ol>
          </div>
        ) : null}
      </section>
    </div>
  );
}

// --- Contribution table --------------------------------------------------------------

/** Ranked contribution for a dimension page: who moved, by how much, and what
 *  share of the period's total move that represents. */
export function ContributionTable({
  contributions, entityLabel, money,
}: {
  contributions: AffectedEntity[];
  entityLabel: string;
  money: (cents: number | null) => string;
}) {
  const rows = contributions.filter((c) => c.absoluteChange !== null).slice(0, 10);
  return (
    <div className="cg-sec">
      <p className="cg-seclabel">Contribution Analysis</p>
      {rows.length === 0 ? (
        <section className="tile tile--wide">
          <p className="tile__line cg-muted">
            No comparable prior period, so no contribution to a change can be calculated.
          </p>
        </section>
      ) : (
        <div className="adm-tablewrap">
          <table className="adm-table dim-table">
            <thead>
              <tr>
                <th>{entityLabel}</th>
                <th className="dim-num">Selected period</th>
                <th className="dim-num">Comparison</th>
                <th className="dim-num">Change</th>
                <th className="dim-num">Share of total change</th>
                <th className="dim-num">Rank</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.entityId} className="dim-row">
                  <td>{c.entityName}</td>
                  <td className="dim-num">{money(c.currentValue)}</td>
                  <td className="dim-num">{money(c.comparisonValue)}</td>
                  <td className={'dim-num ' + ((c.absoluteChange ?? 0) < 0 ? 'dim-trend--down' : 'dim-trend--up')}>
                    {money(c.absoluteChange)}
                  </td>
                  <td className="dim-num">
                    {c.contributionToChange === null ? '—' : Math.round(Math.abs(c.contributionToChange) * 100) + '%'}
                  </td>
                  <td className="dim-num">
                    {c.currentRank === null ? 'Not in period' : '#' + c.currentRank}
                    {c.comparisonRank !== null && c.currentRank !== null && c.comparisonRank !== c.currentRank
                      ? <span className="cg-rankwas"> (was #{c.comparisonRank})</span>
                      : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="cg-tablenote">
        Contribution is arithmetic: it shows which {entityLabel.toLowerCase()}s account for the period&rsquo;s
        change. It does not establish what caused it.
      </p>
    </div>
  );
}

// --- Executive Intelligence Brief ------------------------------------------------------

/**
 * The Intelligence Score, with the components behind it.
 *
 * The number is meaningless on its own, so it never appears on its own: the
 * drawer names every component, what it scored, and — for a component that could
 * not be measured — says so instead of showing a zero. A score built from four of
 * five components is a different claim from one built from five, and the reader
 * gets to see which they are looking at.
 */
export function ScoreBadge({ score }: { score: IntelligenceScore }) {
  return (
    <details className="cg-scorebadge">
      <summary className="cg-scorebadge__summary" title="Attention ordering — not a value or a forecast">
        <span className="cg-scorebadge__num">{score.score}</span>
        <span className="cg-scorebadge__label">priority</span>
        {score.determinacy < 1 ? (
          <span className="cg-scorebadge__partial" title="Some components could not be measured">
            partial
          </span>
        ) : null}
      </summary>
      <div className="cg-scorebadge__body">
        <p className="cg-scorebadge__note">
          Orders attention only. It is not a value, a cost, or a probability.
        </p>
        <dl className="cg-scorelist">
          {score.components.map((c) => (
            <div className="cg-scorerow" key={c.id}>
              <dt className="cg-scorerow__name">{SCORE_LABEL[c.id]}</dt>
              <dd className="cg-scorerow__val">
                {c.available ? `${c.points ?? 0} / ${c.max}` : 'Not measurable'}
                <span className="cg-scorerow__why">{c.explanation}</span>
              </dd>
            </div>
          ))}
        </dl>
        <p className="cg-scorebadge__ver">Formula {score.formulaVersion}</p>
      </div>
    </details>
  );
}

const SCORE_LABEL: Record<string, string> = {
  impact: 'Impact',
  confidence: 'Confidence',
  novelty: 'Novelty',
  urgency: 'Urgency',
  reviewPriority: 'Review priority',
};

/** One brief entry: severity, what it is, the evidence, the impact, what to review. */
function BriefItem({ item, rank }: { item: ScoredFinding; rank: number }) {
  const f = item.finding;
  return (
    <article className="cg-brief__item" aria-label={f.title}>
      <div className="cg-brief__rank" aria-hidden="true">{rank}</div>
      <div className="cg-brief__body">
        <header className="cg-brief__head">
          <SeverityTag value={f.severity} />
          <h3 className="cg-brief__title">{f.title}</h3>
          <ScoreBadge score={item.score} />
        </header>

        <p className="cg-brief__summary">{f.plainLanguageSummary}</p>

        {f.drivers.length > 0 ? <ContributorList entities={f.drivers} /> : null}

        <dl className="cg-brief__meta">
          <div>
            <dt>Confidence</dt>
            <dd>{Math.round(f.confidence * 100)}%</dd>
          </div>
          <div>
            <dt>Basis</dt>
            <dd><ClassificationTag value={f.classification} /></dd>
          </div>
          {f.comparisonWindow ? (
            <div>
              <dt>Compared with</dt>
              <dd>{f.comparisonWindow}</dd>
            </div>
          ) : null}
        </dl>

        {f.unknowns.length > 0 ? (
          <p className="cg-brief__unknown">
            <span className="cg-brief__unknownlabel">Unknown</span>
            {f.unknowns[0]}
          </p>
        ) : null}

        {f.recommendedReview ? (
          <p className="cg-finding__review">
            <span className="cg-finding__reviewlabel">Recommended review</span>
            {f.recommendedReview}
          </p>
        ) : null}

        <EvidenceDrawer finding={f} />
      </div>
    </article>
  );
}

/**
 * The Executive Intelligence Brief — at most five, ordered by attention.
 *
 * Five is a CEILING. An empty brief renders its reason rather than a blank space,
 * because "nothing crossed the bar" and "the page failed" look identical
 * otherwise, and only one of them is fine.
 */
export function ExecutiveBriefSection({
  brief,
  sectionLabel = 'Executive Intelligence Brief',
}: {
  brief: ExecutiveBrief;
  sectionLabel?: string;
}) {
  return (
    <div className="cg-sec">
      <div className="cg-sechead">
        <p className="cg-seclabel">{sectionLabel}</p>
        {brief.items.length > 0 ? (
          <p className="cg-brief__count">
            {brief.items.length} of {brief.items.length + brief.omittedCount} findings
          </p>
        ) : null}
      </div>

      {brief.items.length === 0 ? (
        <section className="tile tile--wide">
          <p className="tile__line cg-muted">{brief.emptyReason ?? 'No evidence-backed finding for this period.'}</p>
        </section>
      ) : (
        <div className="cg-brief">
          {brief.items.map((item, i) => (
            <BriefItem key={item.finding.id} item={item} rank={i + 1} />
          ))}
        </div>
      )}

      {brief.scoredWithoutHistory ? (
        <p className="cg-covnote">
          Ordered without a historical series, so novelty could not be measured. Select a
          completed period to establish one.
        </p>
      ) : null}
    </div>
  );
}

// --- Marketplace Risk -------------------------------------------------------------------

const RISK_CLASS: Record<RiskBand, string> = {
  CRITICAL: 'critical', HIGH: 'high', MODERATE: 'notable', LOW: 'informational',
};
const RISK_LABEL: Record<RiskBand, string> = {
  CRITICAL: 'Critical', HIGH: 'High', MODERATE: 'Moderate', LOW: 'Low',
};

/**
 * Structural fragility, with every factor's measurability on show.
 *
 * The determinacy line is the point of this panel. A "LOW" computed from three of
 * nine factors is not a clean bill of health, and a reader who cannot see that
 * will treat it as one.
 */
export function MarketplaceRiskPanel({ risk }: { risk: MarketplaceRisk }) {
  return (
    <div className="cg-sec">
      <div className="cg-sechead">
        <p className="cg-seclabel">Marketplace Risk</p>
        <span className={'cg-sev cg-sev--' + RISK_CLASS[risk.band]}>{RISK_LABEL[risk.band]}</span>
      </div>

      <section className="tile tile--wide cg-risk">
        <p className="cg-risk__headline">{risk.headline}</p>

        <p className="cg-risk__determinacy">
          {Math.round(risk.determinacy * 100)}% of the model could be measured
          {risk.unmeasured.length > 0
            ? ` — ${risk.unmeasured.length} factor${risk.unmeasured.length === 1 ? '' : 's'} had no data and ${risk.unmeasured.length === 1 ? 'was' : 'were'} excluded rather than scored as safe.`
            : '.'}
        </p>

        <details className="cg-eviddrawer">
          <summary className="cg-evidsummary">All nine factors</summary>
          <div className="cg-evidbody">
            <ul className="cg-riskfactors">
              {risk.factors.map((f) => (
                <li className={'cg-riskfactor' + (f.available ? '' : ' cg-riskfactor--absent')} key={f.id}>
                  <div className="cg-riskfactor__head">
                    <span className="cg-riskfactor__name">{f.label}</span>
                    <span className="cg-riskfactor__level">
                      {f.available && f.level !== null ? `${Math.round(f.level * 100)}%` : 'Not measurable'}
                    </span>
                  </div>
                  <p className="cg-riskfactor__measure">{f.measurement}</p>
                  <p className="cg-riskfactor__why">{f.explanation}</p>
                </li>
              ))}
            </ul>
            <p className="cg-scorebadge__ver">Risk model {risk.modelVersion}</p>
          </div>
        </details>

        <p className="cg-risk__caveat">
          Risk describes the shape of the business, not anyone&rsquo;s intentions. Loop cannot see
          contracts, caps or commercial arrangements, so it never predicts that a counterparty
          will reduce or leave.
        </p>
      </section>
    </div>
  );
}

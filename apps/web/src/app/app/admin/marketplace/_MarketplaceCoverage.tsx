// Marketplace Coverage — the truth center of the Marketplace workspace.
//
// This section replaces the Campaign / Buyer / Source / Vendor "performance"
// cards and the Brain Insights placeholder. Those rendered an empty shell
// whether the marketplace was empty, unattributed, or unreachable, which taught
// the operator nothing and quietly implied the platform was working.
//
// Every row here is a derived status with the counts behind it. Nothing on this
// surface is authored: `status`, `evidence` and `reason` all come from
// assessMarketplaceCoverage() in @emgloop/intelligence, which computes them from
// COUNTs against the canonical call record.
//
// The four postures are deliberate. `undetermined` exists because collapsing
// "we have not looked" into "unavailable" would itself be a false claim — the
// distinction between absent and unknown is the whole point of the surface.

import type { CapabilityCoverage, CoverageStatus, MarketplaceCoverageReport } from '@emgloop/intelligence';
import { SidebarIcon } from '../../../crm/_brand/SidebarIcon';
import type { ScoredFinding, MarketplaceHealth } from '@emgloop/intelligence';

const STATUS_LABEL: Record<CoverageStatus, string> = {
  available: 'Available',
  partial: 'Partially available',
  unavailable: 'Unavailable',
  undetermined: 'Not yet determined',
};

/**
 * What each blocked tier actually means for the reader, in the terms that
 * decide who can fix it. This is the difference between this surface and a
 * "coming soon" badge: it names the owner of the next step.
 */
const TIER_LABEL: Record<string, string> = {
  'not-populated': 'Sensor did not send it',
  'not-ingested': 'Documented, not mapped into Loop',
  'not-fetched': 'Shape defined, nothing fetches it',
  'not-specified': 'Unconfirmed with the provider',
};

function CoverageRow({ c }: { c: CapabilityCoverage }) {
  return (
    <li className={'mkt-cov__row mkt-cov__row--' + c.status}>
      <div className="mkt-cov__head">
        <span className="mkt-cov__label">{c.label}</span>
        <span className={'mkt-cov__status mkt-cov__status--' + c.status}>{STATUS_LABEL[c.status]}</span>
        {c.ratio ? (
          <span className="mkt-cov__ratio">
            {c.ratio.observed.toLocaleString()} / {c.ratio.total.toLocaleString()} calls
          </span>
        ) : null}
      </div>

      {/* Always present: what was actually observed, with counts. */}
      <p className="mkt-cov__evidence">{c.evidence}</p>

      {c.reason ? (
        <p className="mkt-cov__reason">
          <span className="mkt-cov__key">Why</span> {c.reason}
        </p>
      ) : null}

      {c.unblockedBy ? (
        <p className="mkt-cov__reason">
          <span className="mkt-cov__key">To unlock</span> {c.unblockedBy}
        </p>
      ) : null}

      <div className="mkt-cov__meta">
        <span className="mkt-cov__chip">Source: {c.provider}</span>
        {c.tier ? <span className="mkt-cov__chip">{TIER_LABEL[c.tier] ?? c.tier}</span> : null}
        {c.citation ? <span className="mkt-cov__cite">{c.citation}</span> : null}
      </div>
    </li>
  );
}

export function MarketplaceCoverage(props: { report: MarketplaceCoverageReport }) {
  const { report } = props;
  const { totals } = report;

  // Ordered so the operator reads what is trustworthy before what is missing.
  const order: CoverageStatus[] = ['available', 'partial', 'undetermined', 'unavailable'];
  const rows = [...report.capabilities].sort(
    (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
  );

  return (
    <section className="loop-card mkt-cov" aria-labelledby="mkt-cov-title">
      <div className="loop-card__head">
        <h2 className="loop-card__title" id="mkt-cov-title">
          Marketplace Coverage
        </h2>
        <span className="mkt-cov__window">{report.windowLabel}</span>
      </div>

      <p className="mkt-cov__lead">
        What the Brain can and cannot currently see, measured against the{' '}
        {report.callsIngested.toLocaleString()} call{report.callsIngested === 1 ? '' : 's'} ingested in
        this window. Every status below is counted, not asserted.
      </p>

      <div className="mkt-cov__totals">
        <span className="mkt-cov__total mkt-cov__total--available">{totals.available} available</span>
        <span className="mkt-cov__total mkt-cov__total--partial">{totals.partial} partial</span>
        <span className="mkt-cov__total mkt-cov__total--unavailable">{totals.unavailable} unavailable</span>
        {totals.undetermined > 0 ? (
          <span className="mkt-cov__total mkt-cov__total--undetermined">
            {totals.undetermined} not yet determined
          </span>
        ) : null}
      </div>

      <ul className="mkt-cov__list">
        {rows.map((c) => (
          <CoverageRow key={c.id} c={c} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The read failed. This is NOT an empty state — it is an error state, and it
 * must never be drawn as zeros. The previous Marketplace rendered a database
 * outage as "0 calls tracked · $0 revenue", which is the most expensive lie the
 * workspace could tell.
 */
export function CoverageUnavailable(props: { reason: string }) {
  return (
    <section className="loop-banner loop-banner--crit" role="alert">
      <span className="loop-banner__glyph">
        <SidebarIcon name="plug" />
      </span>
      <div className="loop-banner__text">
        <div className="loop-banner__title">Marketplace coverage is unavailable</div>
        <div className="loop-banner__body">
          {props.reason} Until this read succeeds, Loop cannot tell you what it knows about your
          marketplace — so it is showing you nothing rather than zeros.
        </div>
      </div>
    </section>
  );
}

/**
 * Marketplace Intelligence.
 *
 * Replaces "Highest Priority", which ranked by how cheap a fix was. This ranks
 * by BUSINESS IMPACT — a costed finding outranks a cheap one worth nothing.
 *
 * Investigation Mode is inline rather than behind a click: every finding shows
 * its evidence, coverage, owner, confidence, why the engine concluded it, and
 * what it could not see. Nothing is hidden, because a conclusion an executive
 * cannot audit is one they cannot safely act on.
 */
export function MarketplaceIntelligence(props: {
  scored: ScoredFinding[];
  withheld: Array<{ ruleId: string; reason: string; needs: string }>;
  unbuilt: ReadonlyArray<{ id: string; purpose: string; needs: string }>;
  health: MarketplaceHealth;
  summary: string[];
}) {
  const { scored, withheld, unbuilt, health, summary } = props;

  const risks = scored.filter((s) => s.severity !== 'informational');
  const coverageIssues = scored.filter((s) => s.finding.category === 'provider');
  const recommendations = scored.filter((s) => s.actionable);

  return (
    <section className="loop-card mkt-intel" aria-labelledby="mkt-intel-title">
      <div className="loop-card__head">
        <h2 className="loop-card__title" id="mkt-intel-title">
          Marketplace Intelligence
        </h2>
        <span className={"mkt-intel__health mkt-intel__health--" + health.band}>
          {health.band === "unmeasured" ? "Unmeasured" : health.score + "/100 " + health.band}
        </span>
      </div>

      {/* Executive summary — generated from the same figures the findings use. */}
      <div className="mkt-intel__summary">
        {summary.map((line) => (
          <p key={line} className="mkt-intel__summary-line">{line}</p>
        ))}
      </div>

      {health.caveat ? <p className="mkt-intel__caveat">{health.caveat}</p> : null}

      {scored.length === 0 ? (
        <p className="mkt-cov__evidence">
          No risks were found in this window. Every rule that ran either found complete coverage or
          withheld for the reasons listed below — none were silently skipped.
        </p>
      ) : (
        <ol className="mkt-intel__list">
          {scored.map((s) => (
            <li key={s.finding.id} className={"mkt-intel__item mkt-intel__item--" + s.severity}>
              <div className="mkt-intel__head">
                <span className={"mkt-intel__sev mkt-intel__sev--" + s.severity}>{s.severity}</span>
                <span className="mkt-intel__what">{s.finding.whatHappened}</span>
              </div>

              {/* 2. Why */}
              <p className="mkt-cov__reason">
                <span className="mkt-cov__key">Why</span> {s.finding.why}
              </p>

              {/* 3. Owner + 4. Impact */}
              <p className="mkt-cov__reason">
                <span className="mkt-cov__key">Owner</span> {s.finding.owner}
                {" · "}
                <span className="mkt-cov__key">Impact</span>{" "}
                {s.finding.impact.kind === "measured"
                  ? s.finding.impact.lostOpportunities.toLocaleString() + " opportunities"
                  : s.finding.impact.kind === "volume-only"
                    ? s.finding.impact.lostOpportunities.toLocaleString() + " call(s) affected — value unknown"
                    : "not quantifiable"}
              </p>

              {/* 6. Evidence — Investigation Mode, inline. */}
              <div className="mkt-intel__evidence">
                <span className="mkt-cov__key">Evidence</span>
                <ul className="mkt-intel__ev-list">
                  {s.finding.evidence.map((e) => (
                    <li key={e.statement}>
                      {e.statement}: <strong>{e.observed.toLocaleString()}</strong>
                      {e.denominator !== null ? " of " + e.denominator.toLocaleString() : ""}
                      <span className="mkt-cov__cite"> {e.source}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* 5. Confidence, with its basis. */}
              <p className="mkt-cov__reason">
                <span className="mkt-cov__key">Confidence</span>
                {Math.round(s.finding.confidence.value * 100)}% — {s.finding.confidence.basis}
              </p>

              {/* 7. Recommendation, or an honest absence. */}
              {s.finding.recommendedAction ? (
                <p className="mkt-intel__action">
                  <span className="mkt-cov__key">Do next</span> {s.finding.recommendedAction}
                </p>
              ) : (
                <p className="mkt-cov__reason">
                  <span className="mkt-cov__key">No action offered</span> the impact cannot be sized,
                  so recommending work would be guesswork.
                </p>
              )}

              {s.finding.missingEvidence.length > 0 ? (
                <p className="mkt-cov__reason">
                  <span className="mkt-cov__key">Could not see</span>{" "}
                  {s.finding.missingEvidence.join("; ")}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {/* What the engine considered but could not say. Never hidden. */}
      {withheld.length > 0 || unbuilt.length > 0 ? (
        <div className="mkt-intel__gaps">
          <div className="mkt-cov__key">What the engine could not conclude</div>
          <ul className="mkt-intel__ev-list">
            {withheld.map((w) => (
              <li key={w.ruleId}>
                <strong>{w.ruleId}</strong> — {w.reason} Needs: {w.needs}
              </li>
            ))}
            {unbuilt.map((u) => (
              <li key={u.id}>
                <strong>{u.id}</strong> — not built. {u.purpose} Needs: {u.needs}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

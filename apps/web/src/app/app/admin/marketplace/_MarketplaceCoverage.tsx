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
 * Highest-priority unblocking work, ranked by evidence tier.
 *
 * Replaces the old decision queue entry "9 providers need setup", which was a
 * count of unconfigured integrations dressed as a decision. Each item states
 * what it unlocks as a countable capability — never an invented percentage
 * improvement, which would be the exact fabrication this workspace exists to end.
 */
export function HighestPriority(props: { items: CapabilityCoverage[] }) {
  if (props.items.length === 0) return null;

  return (
    <section className="loop-card mkt-pri" aria-labelledby="mkt-pri-title">
      <div className="loop-card__head">
        <h2 className="loop-card__title" id="mkt-pri-title">
          Highest priority
        </h2>
        <span className="mkt-cov__window">Ranked by what Loop can act on first</span>
      </div>

      <ol className="mkt-pri__list">
        {props.items.slice(0, 5).map((c) => (
          <li key={c.id} className="mkt-pri__item">
            <div className="mkt-pri__title">{c.unblockedBy}</div>
            <p className="mkt-pri__line">
              <span className="mkt-cov__key">Blocked by</span> {TIER_LABEL[c.tier ?? ''] ?? 'Unknown'} —{' '}
              {c.reason}
            </p>
            <p className="mkt-pri__line">
              <span className="mkt-cov__key">Unlocks</span>
              <span className="mkt-pri__unlocks">
                {c.unlocks.map((u) => (
                  <span key={u} className="mkt-cov__chip">
                    {u}
                  </span>
                ))}
              </span>
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

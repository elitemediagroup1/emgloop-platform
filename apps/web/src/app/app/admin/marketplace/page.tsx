// Marketplace — Executive Operating System surface.
//
// This page answers one question: what does the Brain know about this
// marketplace, what does it not know, and why. Everything that existed only to
// make the page look complete is gone.
//
// Removed, and why:
//   • Campaign / Buyer / Source / Vendor "performance" cards — four cards that
//     rendered an identical empty shell whether the marketplace was empty,
//     unattributed, or unreachable. An executive learned nothing from any of them.
//   • "Brain Insights" — a Standby badge over prose. It performed no Brain read
//     at all. That is the "Brain Status: Online" anti-pattern CLAUDE.md names.
//   • Integration Status — "9 providers need setup" is a count of unconfigured
//     rows dressed as a decision. Its one real signal (which sensor is missing)
//     is now stated per-capability, with what it blocks, in Coverage.
//   • Live activity / live calls rails — real data, but duplicated verbatim on
//     the Activity tab. Duplication on the executive surface costs attention.
//   • The "Coming soon" string that shipped in the Marketplace Health hint.
//
// The zero-vs-unknown rule this page now enforces: `loadOrFallback` fails for a
// missing DATABASE_URL, an unreachable host, a missing migration OR any thrown
// exception. The previous page collapsed all of that to `null` and rendered
// `0` / `$0`, so a database outage was pixel-identical to a healthy empty
// marketplace. Every figure below is either backed by a completed read or
// rendered as "—" beside the reason it is missing.

import Link from "next/link";
import { MarketplaceNav } from "./_MarketplaceNav";
import { MarketplaceCoverage, CoverageUnavailable, HighestPriority } from "./_MarketplaceCoverage";
import { loadMarketplaceCoverage } from "./marketplace-coverage-data";
import type { MarketplaceCoverageReport } from "@emgloop/intelligence";
import { SidebarIcon } from "../../../crm/_brand/SidebarIcon";
import { crmRepos, requireCrmContext } from "../../../../crm/crm-data";
import { money, num, todayLabel, PartialDataNotice } from "../../_loop-os";
import {
  renderTruth,
  failed,
  hasValue,
  foldTruth,
  mapTruth,
  type Truth,
  type TruthMeta,
} from "@emgloop/shared";
import type { RevenueByDimension, TrafficIntelligence } from "@emgloop/database";

export const dynamic = "force-dynamic";

/**
 * One executive figure, rendered entirely from its Truth state.
 *
 * There is no `value` prop and no null check here — `renderTruth` is total over
 * the six states, and the formatter it calls only ever sees a measured number.
 * A state without a value cannot reach this component's output as a digit.
 */
function Metric(props: {
  label: string;
  /**
   * The period this figure covers. REQUIRED, because these tiles do not share
   * one: realized revenue is all-time while calls/qualified/bookings are a
   * 7-day window. Rendering them unlabelled invited exactly the wrong division
   * (all-time revenue ÷ 7-day calls), so the window is now impossible to omit.
   */
  window: string;
  truth: Truth<number>;
  format: (n: number) => string;
}) {
  const d = renderTruth(props.truth, props.format);
  return (
    <div className={"loop-mod loop-mod--" + d.tone}>
      <div className="loop-mod__label">
        {props.label} <span className="loop-mod__window">{props.window}</span>
      </div>
      <div className="loop-mod__metric">{d.text}</div>
      <div className="loop-mod__detail">
        {d.qualifier ? <span className="loop-mod__qual">{d.qualifier}</span> : null}
        {d.note ?? "Measured and complete."}
      </div>
    </div>
  );
}

export default async function MarketplaceCommandCenter() {
  const { organizationId: org } = await requireCrmContext();
  const now = new Date();
  const meta: TruthMeta = { measuredAt: now.toISOString() };

  const noOrgError = {
    code: "repository-exception" as const,
    summary: "No organization is resolved for this session.",
    retryable: false,
  };

  // The repository produces Truth directly, so loadOrFallback is no longer used
  // here: measure() already converts a thrown read into ERROR, and wrapping it
  // again would only re-flatten the state this migration exists to preserve.
  const revenueT = org
    ? await crmRepos.revenueIntelligence.revenueByDimension(org, now)
    : failed<RevenueByDimension>(noOrgError, meta);
  const trafficT = org
    ? await crmRepos.revenueIntelligence.trafficIntelligence(org, now)
    : failed<TrafficIntelligence>(noOrgError, meta);

  const coverage = org
    ? await loadMarketplaceCoverage(org, now)
    : {
        report: failed<MarketplaceCoverageReport>(noOrgError, meta),
        priority: [],
        callsIngested: failed<number>(noOrgError, meta),
      };

  const rev = hasValue(revenueT) ? revenueT.value : null;
  const traffic = hasValue(trafficT) ? trafficT.value : null;

  // Each figure inherits the posture of the read it came from: mapTruth carries
  // SUCCESS/PARTIAL through to the value and leaves ERROR/UNKNOWN untouched, so
  // a failed read cannot become a zero on the way to the tile.
  const revenue: Truth<number> = mapTruth(revenueT, (d) => d.realizedRevenueCents);
  const calls: Truth<number> = mapTruth(trafficT, (d) => d.totalCalls);
  const qualified: Truth<number> = mapTruth(trafficT, (d) => d.qualifiedCalls);
  const bookings: Truth<number> = mapTruth(trafficT, (d) => d.bookings);

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <div className="loop-os__main">
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">Marketplace</p>
            <h1 className="loop-os__brief-title">Command Center</h1>
            <p className="loop-os__brief-body">
              {foldTruth(coverage.report, {
                success: (r) =>
                  `${r.totals.available} of ${r.capabilities.length} marketplace capabilities are fully available to the Brain.`,
                empty: () => "No marketplace capabilities have been assessed yet.",
                partial: (r) =>
                  `${r.totals.available} of ${r.capabilities.length} capabilities available, measured over part of the window.`,
                unknown: (reason) => reason.summary,
                unavailable: (reason) => reason.summary,
                error: (error) => `Loop cannot currently determine what it knows about this marketplace. ${error.summary}`,
              })}
            </p>
            <Link href="/app/admin" className="loop-os__brief-cta">
              Back to Overview <span aria-hidden="true">{"\u2192"}</span>
            </Link>
          </div>
          <div className="loop-os__brief-chip">
            <SidebarIcon name="calendar" />
            <span className="loop-os__brief-chiptoday">Today</span>
            <span className="loop-os__brief-chipdate">{todayLabel()}</span>
          </div>
        </header>

        <MarketplaceNav active="overview" />

        <PartialDataNotice coverage={[rev?.coverage, traffic?.coverage]} />

        {/* Every figure switches on its Truth state. No null checks, no zeros. */}
        <section className="loop-modgrid" aria-label="Marketplace metrics">
          <Metric label="Realized revenue" window="All time" truth={revenue} format={money} />
          <Metric label="Calls" window="Last 7 days" truth={calls} format={num} />
          <Metric label="Qualified" window="Last 7 days" truth={qualified} format={num} />
          <Metric label="Bookings" window="Last 7 days" truth={bookings} format={num} />
        </section>

        {/* The truth center. */}
        {hasValue(coverage.report) ? (
          <MarketplaceCoverage report={coverage.report.value} />
        ) : (
          <CoverageUnavailable
            reason={foldTruth(coverage.report, {
              success: () => "",
              empty: () => "",
              partial: () => "",
              unknown: (r) => r.summary,
              unavailable: (r) => r.summary,
              error: (e) => `${e.summary}${e.detail ? ` ${e.detail}` : ""}`,
            })}
          />
        )}

        {coverage.priority.length > 0 ? <HighestPriority items={coverage.priority} /> : null}
      </div>
    </div>
  );
}

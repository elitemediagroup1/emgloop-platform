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
import { SidebarIcon } from "../../../crm/_brand/SidebarIcon";
import { loadOrFallback } from "../../../../demo/db-health";
import { crmRepos, requireCrmContext } from "../../../../crm/crm-data";
import { moneyOrUnknown, numOrUnknown, todayLabel, PartialDataNotice } from "../../_loop-os";

export const dynamic = "force-dynamic";

/**
 * One executive figure. `value` is null when the read did not complete, and
 * renders as an em dash beside a detail line that says so — never as 0.
 */
function Metric(props: { label: string; value: string; detail: string; known: boolean }) {
  return (
    <div className={"loop-mod" + (props.known ? "" : " loop-mod--unknown")}>
      <div className="loop-mod__label">{props.label}</div>
      <div className="loop-mod__metric">{props.value}</div>
      <div className="loop-mod__detail">{props.detail}</div>
    </div>
  );
}

export default async function MarketplaceCommandCenter() {
  const { organizationId: org } = await requireCrmContext();

  const revenueR = org
    ? await loadOrFallback(async () => crmRepos.revenueIntelligence.revenueByDimension(org))
    : ({ ok: false, cause: "read-failed", message: "No organization is resolved for this session." } as const);
  const trafficR = org
    ? await loadOrFallback(async () => crmRepos.revenueIntelligence.trafficIntelligence(org))
    : ({ ok: false, cause: "read-failed", message: "No organization is resolved for this session." } as const);

  const coverage = org
    ? await loadMarketplaceCoverage(org)
    : ({ ok: false, reason: "No organization is resolved for this session." } as const);

  const rev = revenueR.ok ? revenueR.data : null;
  const traffic = trafficR.ok ? trafficR.data : null;

  // Name the failure rather than absorbing it into an empty render.
  const failure = !revenueR.ok ? revenueR : !trafficR.ok ? trafficR : null;

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <div className="loop-os__main">
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">Marketplace</p>
            <h1 className="loop-os__brief-title">Command Center</h1>
            <p className="loop-os__brief-body">
              {coverage.ok
                ? `${coverage.report.totals.available} of ${coverage.report.capabilities.length} marketplace capabilities are fully available to the Brain, measured over ${coverage.report.callsIngested.toLocaleString()} ingested call${coverage.report.callsIngested === 1 ? "" : "s"}.`
                : "Loop cannot currently determine what it knows about this marketplace."}
            </p>
            <Link href="/app/admin" className="loop-os__brief-cta">
              Back to Overview <span aria-hidden="true">{"→"}</span>
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

        {failure ? (
          <section className="loop-banner loop-banner--crit" role="alert">
            <span className="loop-banner__glyph">
              <SidebarIcon name="plug" />
            </span>
            <div className="loop-banner__text">
              <div className="loop-banner__title">
                {failure.cause === "not-configured"
                  ? "This environment has no database configured"
                  : "Marketplace figures are unavailable"}
              </div>
              <div className="loop-banner__body">
                {failure.message} The figures below are shown as {"“—”"} rather than
                zero, because an unmeasured marketplace is not an empty one.
              </div>
            </div>
          </section>
        ) : null}

        <section className="loop-modgrid" aria-label="Marketplace metrics">
          <Metric
            label="Realized revenue"
            value={moneyOrUnknown(rev?.realizedRevenueCents)}
            detail={rev ? `${numOrUnknown(rev.realizedOrders)} realized orders` : "Read did not complete"}
            known={!!rev}
          />
          <Metric
            label="Calls"
            value={numOrUnknown(traffic?.totalCalls)}
            detail={traffic ? `${numOrUnknown(traffic.attributedCalls)} attributed` : "Read did not complete"}
            known={!!traffic}
          />
          <Metric
            label="Qualified"
            value={numOrUnknown(traffic?.qualifiedCalls)}
            detail={traffic ? "Marked qualified by the buyer" : "Read did not complete"}
            known={!!traffic}
          />
          <Metric
            label="Bookings"
            value={numOrUnknown(traffic?.bookings)}
            detail={traffic ? "Booked from marketplace calls" : "Read did not complete"}
            known={!!traffic}
          />
        </section>

        {/* The truth center. */}
        {coverage.ok ? (
          <MarketplaceCoverage report={coverage.report} />
        ) : (
          <CoverageUnavailable reason={coverage.reason} />
        )}

        {coverage.ok ? <HighestPriority items={coverage.priority} /> : null}
      </div>
    </div>
  );
}

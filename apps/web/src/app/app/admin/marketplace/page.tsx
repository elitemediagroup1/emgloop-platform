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
import { money, num, todayLabel } from "../../_loop-os";
import {
  renderTruth,
  failed,
  hasValue,
  foldTruth,
  type Truth,
  type TruthMeta,
} from "@emgloop/shared";

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
  const WINDOW_LABEL = "Last 7 days";

  const noOrgError = {
    code: "repository-exception" as const,
    summary: "No organization is resolved for this session.",
    retryable: false,
  };

  // PHASE 7 — the authoritative operational read model is MarketplaceCall.
  // This page reads it and nothing else. It previously showed CRM Order revenue
  // and CRM Booking counts beside CallGrid call volume, which meant an executive
  // could divide one source by another and get a number describing nothing.
  // No CRM Order, no CRM Booking, no Interaction.metadata string-probing.
  const WINDOW_DAYS = 7;
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const metrics = org
    ? await crmRepos.marketplaceCalls.windowMetrics(org, since, now, now)
    : {
        calls: failed<number>(noOrgError, meta),
        revenueCents: failed<number>(noOrgError, meta),
        payoutCents: failed<number>(noOrgError, meta),
        costCents: failed<number>(noOrgError, meta),
        monetized: failed<number>(noOrgError, meta),
        converted: failed<number>(noOrgError, meta),
      };

  const coverage = org
    ? await loadMarketplaceCoverage(org, now)
    : {
        report: failed<MarketplaceCoverageReport>(noOrgError, meta),
        priority: [],
        callsIngested: failed<number>(noOrgError, meta),
      };

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

        {/* Every figure below is CallGrid, from MarketplaceCall, over one window. */}
        <section className="loop-modgrid" aria-label="Marketplace metrics">
          <Metric label="Calls" window={WINDOW_LABEL} truth={metrics.calls} format={num} />
          <Metric label="Revenue" window={WINDOW_LABEL} truth={metrics.revenueCents} format={money} />
          <Metric label="Payout" window={WINDOW_LABEL} truth={metrics.payoutCents} format={money} />
          <Metric label="Monetized" window={WINDOW_LABEL} truth={metrics.monetized} format={num} />
          <Metric label="Converted" window={WINDOW_LABEL} truth={metrics.converted} format={num} />
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

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
import { money, num, todayLabel, PartialDataNotice } from "../../_loop-os";
import {
  renderTruth,
  measuredBounded,
  failed,
  hasValue,
  foldTruth,
  type Truth,
  type TruthMeta,
} from "@emgloop/shared";
import type { QueryCoverage } from "@emgloop/database";

export const dynamic = "force-dynamic";

/**
 * One executive figure, rendered entirely from its Truth state.
 *
 * There is no `value` prop and no null check here — `renderTruth` is total over
 * the six states, and the formatter it calls only ever sees a measured number.
 * A state without a value cannot reach this component's output as a digit.
 */
function Metric(props: { label: string; truth: Truth<number>; format: (n: number) => string }) {
  const d = renderTruth(props.truth, props.format);
  return (
    <div className={"loop-mod loop-mod--" + d.tone}>
      <div className="loop-mod__label">{props.label}</div>
      <div className="loop-mod__metric">{d.text}</div>
      <div className="loop-mod__detail">
        {d.qualifier ? <span className="loop-mod__qual">{d.qualifier}</span> : null}
        {d.note ?? "Measured and complete."}
      </div>
    </div>
  );
}

/**
 * Bridge a bounded repository read onto Truth.
 *
 * `QueryCoverage` already encodes exactly what PARTIAL means — a completed read
 * over a capped slice — so this is a projection, not a reinterpretation. A
 * failed read becomes ERROR rather than a zero, which is the whole point.
 *
 * `total` is null on purpose: the bounded reads know how many rows they scanned
 * but not how many exist. Inventing a denominator would fake completeness.
 */
function readToTruth<D>(
  result: { ok: true; data: D } | { ok: false; cause: string; message: string },
  select: (d: D) => { value: number; coverage: QueryCoverage },
  meta: TruthMeta,
): Truth<number> {
  if (!result.ok) {
    return failed<number>(
      {
        code: result.cause === "not-configured" ? "db-not-configured" : "db-unavailable",
        summary: result.message,
        retryable: result.cause !== "not-configured",
      },
      meta,
    );
  }
  const { value, coverage } = select(result.data);
  return measuredBounded(
    value,
    {
      capBound: coverage.capReached,
      coverage: {
        observed: coverage.rowsScanned,
        total: null,
        reason: {
          code: "bounded-read-capped",
          summary: coverage.reasons.join(" ") || "The scan was capped to stay within its memory budget.",
          unblockedBy: "Ship SQL aggregation so this read no longer needs a cap.",
        },
      },
      isZero: value === 0,
    },
    meta,
  );
}

export default async function MarketplaceCommandCenter() {
  const { organizationId: org } = await requireCrmContext();
  const now = new Date();
  const meta: TruthMeta = { measuredAt: now.toISOString() };

  const noOrg = { ok: false as const, cause: "read-failed", message: "No organization is resolved for this session." };

  const revenueR = org
    ? await loadOrFallback(async () => crmRepos.revenueIntelligence.revenueByDimension(org))
    : noOrg;
  const trafficR = org
    ? await loadOrFallback(async () => crmRepos.revenueIntelligence.trafficIntelligence(org))
    : noOrg;

  const coverage = org
    ? await loadMarketplaceCoverage(org, now)
    : {
        report: failed<never>({ code: "repository-exception", summary: noOrg.message, retryable: false }, meta),
        priority: [],
        callsIngested: failed<number>({ code: "repository-exception", summary: noOrg.message, retryable: false }, meta),
      };

  // Each figure is its own measurement with its own posture.
  const revenue = readToTruth(revenueR, (d) => ({ value: d.realizedRevenueCents, coverage: d.coverage }), {
    ...meta,
    subject: "marketplace.realizedRevenue",
  });
  const calls = readToTruth(trafficR, (d) => ({ value: d.totalCalls, coverage: d.coverage }), {
    ...meta,
    subject: "marketplace.calls",
  });
  const qualified = readToTruth(trafficR, (d) => ({ value: d.qualifiedCalls, coverage: d.coverage }), {
    ...meta,
    subject: "marketplace.qualified",
  });
  const bookings = readToTruth(trafficR, (d) => ({ value: d.bookings, coverage: d.coverage }), {
    ...meta,
    subject: "marketplace.bookings",
  });

  const rev = revenueR.ok ? revenueR.data : null;
  const traffic = trafficR.ok ? trafficR.data : null;

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
          <Metric label="Realized revenue" truth={revenue} format={money} />
          <Metric label="Calls" truth={calls} format={num} />
          <Metric label="Qualified" truth={qualified} format={num} />
          <Metric label="Bookings" truth={bookings} format={num} />
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

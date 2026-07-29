import Link from "next/link";
import { requireCrmContext } from "../../../../crm/crm-data";
import {
  parseCallGridRange, resolveCallGridWindow, callGridRangeQuery,
  describeCallGridWindow, callGridDayNav, sumReported, sourceWinRate,
} from "@emgloop/shared";
import { num } from "../../_loop-os";
import { loadCallGridReport, type CallGridDimRow, type CallGridMetrics } from "./callgrid-report";
import { loadBidReport, bidSnapshotMatches, overallRejectRate, destinationRateLimitedShare } from "./bid-report";
import { callGridIntelligence, bidIntelligence } from "./intelligence-data";
import CallGridDateRange from "./CallGridDateRange";
import { SnapshotNotice, easternClock } from "./dimension-ui";
import { ExecutiveBriefSection, MarketplaceRiskPanel, FindingList, UnknownsSection } from "./intelligence-ui";
import { loadCallGridHistory } from "./callgrid-history-data";

export const dynamic = "force-dynamic";

// CallGrid Intelligence — Overview.
//
// CallGrid reports the marketplace; this page explains it. Sections, in order:
// Header · Date · Selected metrics · Comparison · Executive Intelligence · Top
// Performers · Performance Drivers · Bids Overview · Risks & Opportunities ·
// What Loop Cannot Determine · Quick Access.
//
// Every number comes from the canonical report service for the selected window,
// and every conclusion from the deterministic intelligence engine — which reads
// only those same reports. Nothing on this page is computed locally, so Overview
// and a subpage cannot disagree: Top Buyer IS `dimensions.buyers[0]`, the first
// row of the Buyers table.

function money(cents: number | null, available: boolean): string {
  if (!available) return "Unavailable";
  if (cents === null) return "Unknown";
  return "$" + Math.round(cents / 100).toLocaleString("en-US");
}
function count(n: number | null, available: boolean): string {
  if (!available) return "Unavailable";
  if (n === null) return "Unknown";
  return num(n);
}
function utcDate(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
}

const QUICK: { label: string; href: string }[] = [
  { label: "Buyers", href: "/app/admin/marketplace/buyers" },
  { label: "Vendors", href: "/app/admin/marketplace/vendors" },
  { label: "Sources", href: "/app/admin/marketplace/sources" },
  { label: "Campaigns", href: "/app/admin/marketplace/campaigns" },
  { label: "Bids", href: "/app/admin/marketplace/bids" },
  { label: "Activity", href: "/app/admin/marketplace/activity" },
];

// A per-tile comparison indicator. Null (→ "No valid comparison") whenever the
// prior value is unavailable, unknown or zero — never a percentage off nothing.
function deltaOf(cur: number | null, prior: number | null, curAvail: boolean, priorAvail: boolean) {
  if (!curAvail || !priorAvail || cur === null || prior === null || prior === 0) return null;
  const change = Math.round(((cur - prior) / prior) * 100);
  const dir = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const arrow = change > 0 ? "↑" : change < 0 ? "↓" : "→";
  return { text: `${arrow} ${Math.abs(change)}%`, dir };
}

function MetricTiles({
  score, compare, compareLabel, coverageNote,
}: {
  score: CallGridMetrics;
  compare?: CallGridMetrics | null;
  compareLabel?: string;
  coverageNote?: string | null;
}) {
  const fields = [
    { key: "Revenue", val: money(score.revenueCents, score.available), cur: score.revenueCents, prior: compare?.revenueCents ?? null },
    { key: "Profit", val: money(score.profitCents, score.available), cur: score.profitCents, prior: compare?.profitCents ?? null },
    { key: "Billable Calls", val: count(score.billableCalls, score.available), cur: score.billableCalls, prior: compare?.billableCalls ?? null },
    { key: "Total Calls", val: count(score.totalCalls, score.available), cur: score.totalCalls, prior: compare?.totalCalls ?? null },
  ];
  return (
    <>
      <div className="cg-tiles">
        {fields.map((f) => {
          const d = compare ? deltaOf(f.cur, f.prior, score.available, compare.available) : undefined;
          return (
            <section className="tile tile--metric" aria-label={f.key} key={f.key}>
              <div className="tile__head"><span className="tile__title">{f.key}</span></div>
              <div className="tile__num">{f.val}</div>
              {compare ? (
                d ? (
                  <p className={"cg-delta cg-delta--" + d.dir}>{d.text}{compareLabel ? ` vs ${compareLabel}` : ""}</p>
                ) : (
                  <p className="cg-delta cg-delta--na">No valid comparison</p>
                )
              ) : null}
            </section>
          );
        })}
      </div>
      {coverageNote ? <p className="cg-covnote">{coverageNote}</p> : null}
    </>
  );
}

function PerformerTile({ label, row, href }: { label: string; row: CallGridDimRow | null; href: string }) {
  return (
    <Link className="tile tile--metric cg-perftile" aria-label={label} href={href}>
      <div className="tile__head"><span className="tile__title">{label}</span></div>
      {row ? (
        <>
          <div className="tile__num cg-name">{row.label}</div>
          <p className="tile__line">
            {row.revenueCents === null ? "Revenue unknown" : money(row.revenueCents, true)} · {num(row.calls)} calls
          </p>
        </>
      ) : (
        <>
          <div className="tile__num cg-name cg-muted">—</div>
          <p className="tile__line">No data for this period</p>
        </>
      )}
    </Link>
  );
}

function BidTile({ label, value }: { label: string; value: string }) {
  return (
    <section className="tile tile--metric" aria-label={label}>
      <div className="tile__head"><span className="tile__title">{label}</span></div>
      <div className="tile__num tile__num--sm">{value}</div>
    </section>
  );
}

/** Disclose partial economic coverage where it changes how a total should be read. */
function coverageNote(metrics: CallGridMetrics): string | null {
  const cov = metrics.revenueCoverage;
  if (cov === null || cov >= 1 || cov <= 0) return null;
  return `${Math.round(cov * 100)}% of calls in this period carried a revenue value, so Revenue and Profit are lower bounds for the period.`;
}

export default async function CallGridIntelligencePage({
  searchParams,
}: {
  searchParams?: { range?: string; s?: string; e?: string };
}) {
  const { organizationId: org } = await requireCrmContext();

  const now = new Date();
  const range = parseCallGridRange({ range: searchParams?.range, s: searchParams?.s, e: searchParams?.e });
  const window = resolveCallGridWindow(range, now);
  const rangeQuery = callGridRangeQuery(window.preset, { start: range.start, end: range.end });
  const desc = describeCallGridWindow(window, now);
  const dayNav = callGridDayNav(window, now);

  // History is loaded ONLY here. It costs one read per prior period, and only the
  // Overview runs the distribution rules (anomalies, volatility, novelty) that
  // need it. A live window returns an empty series by construction, so this is
  // free on Today.
  const [report, bid, history] = await Promise.all([
    loadCallGridReport(org, window),
    loadBidReport(org),
    loadCallGridHistory(org, window),
  ]);

  const bidMatches = bidSnapshotMatches(bid.meta, window);

  // Bid-derived risk inputs. Both are null when the provider did not report them,
  // which makes the risk model WITHHOLD those factors rather than score them safe.
  const bidRejectRate = overallRejectRate(bid.sources);
  const rateLimitedShare = destinationRateLimitedShare(bid.destinations);

  const intel = callGridIntelligence(report, now, { history, bidRejectRate, rateLimitedShare });
  const bidIntel = bidIntelligence(bid, now, desc.periodTitle, bidMatches);
  const compareShort = desc.comparisonTitle.split(" · ")[0];

  // Bids Overview — snapshot grain. Sums count only sources that reported the
  // field, so an unreported metric shows as "—" rather than a manufactured 0.
  const opportunities = sumReported(bid.sources, (r) => r.total);
  const submitted = sumReported(bid.sources, (r) => r.bids);
  const won = sumReported(bid.sources, (r) => r.won);
  const rejected = sumReported(bid.sources, (r) => r.rejected);
  const winRate = sourceWinRate(won.total, submitted.total);
  const bidNum = (v: number | null) => (v === null ? "—" : num(v));

  const topBidConcern = bidIntel.priorityQueue[0] ?? null;

  return (
    <div className="loop-os">
      <div className="cmd cg-page">
        {/* 1 — Header */}
        <div className="cmd-head">
          <div className="cmd-head__main">
            <p className="cmd-head__greeting">CallGrid Intelligence</p>
            <p className="cmd-head__meta">{desc.headerLine}</p>
          </div>
        </div>

        {/* 2 — Date control */}
        <CallGridDateRange
          preset={window.preset}
          customStart={range.start}
          customEnd={range.end}
          label={window.label}
          dayNav={dayNav}
          live={desc.live}
          updatedLabel={easternClock(now)}
        />
        {!window.isValid ? (
          <p className="cg-covnote">The requested date range was not valid, so Today is shown.</p>
        ) : null}

        {/* 3 — Selected period */}
        <div className="cg-sec">
          <p className="cg-seclabel">{desc.periodTitle}</p>
          <MetricTiles
            score={report.metrics}
            compare={report.comparison}
            compareLabel={compareShort}
            coverageNote={coverageNote(report.metrics)}
          />
        </div>

        {/* 4 — Comparison period */}
        {report.comparison ? (
          <div className="cg-sec">
            <p className="cg-seclabel">{desc.comparisonTitle}</p>
            <MetricTiles score={report.comparison} />
            {desc.comparisonNote ? <p className="cg-covnote">{desc.comparisonNote}</p> : null}
          </div>
        ) : null}

        {/* 5 — Executive Intelligence Brief: at most five, attention-ordered.
             Replaces the passive summary; the headline survives as its one-line lede. */}
        <p className="cg-exec__headline cg-exec__headline--lede">{intel.executiveSummary.headline}</p>
        <ExecutiveBriefSection brief={intel.brief} />

        {/* 5b — Marketplace Risk: structural fragility, with determinacy on show. */}
        <MarketplaceRiskPanel risk={intel.risk} />

        {/* 6 — Top Performers (the ranked rows the subpages show) */}
        <div className="cg-sec">
          <p className="cg-seclabel">Top Performers</p>
          <div className="cg-tiles">
            <PerformerTile label="Top Buyer" row={report.dimensions.buyers[0] ?? null} href={`/app/admin/marketplace/buyers?${rangeQuery}`} />
            <PerformerTile label="Top Vendor" row={report.dimensions.vendors[0] ?? null} href={`/app/admin/marketplace/vendors?${rangeQuery}`} />
            <PerformerTile label="Top Source" row={report.dimensions.sources[0] ?? null} href={`/app/admin/marketplace/sources?${rangeQuery}`} />
            <PerformerTile label="Top Campaign" row={report.dimensions.campaigns[0] ?? null} href={`/app/admin/marketplace/campaigns?${rangeQuery}`} />
          </div>
        </div>

        {/* 7 — Performance Drivers */}
        <FindingList
          sectionLabel="Performance Drivers"
          findings={intel.drivers}
          emptyLine={
            report.comparison
              ? "No single buyer, vendor, source or campaign accounts for enough of this period's change to name."
              : "No comparison period is defined for this selection, so contribution cannot be calculated."
          }
        />

        {/* 8 — Bids Overview (snapshot grain; links to the Bids workspace) */}
        <div className="cg-sec">
          <div className="cg-sechead">
            <p className="cg-seclabel">Bids Overview</p>
            <Link className="cg-seclink" href={`/app/admin/marketplace/bids?${rangeQuery}`}>Open Bids →</Link>
          </div>
          {!bid.ok ? (
            <section className="tile tile--wide"><p className="tile__line cg-muted">Bid reporting could not be loaded.</p></section>
          ) : !bid.hasData || !bid.meta ? (
            <section className="tile tile--wide"><p className="tile__line">No bid report data has been synchronized yet.</p></section>
          ) : (
            <>
              <SnapshotNotice
                windowStart={bid.meta.windowStart}
                windowEnd={bid.meta.windowEnd}
                fetchedAt={bid.meta.fetchedAt}
                reportTimezone={bid.meta.reportTimezone}
                selectedPeriodLabel={desc.periodTitle}
                matchesSelectedPeriod={bidMatches}
              />
              <div className="cg-bidtiles">
                <BidTile label="Bid Opportunities" value={bidNum(opportunities.total)} />
                <BidTile label="Bids Submitted" value={bidNum(submitted.total)} />
                <BidTile label="Bids Won" value={bidNum(won.total)} />
                <BidTile label="Source Win Rate" value={winRate === null ? "—" : Math.round(winRate * 100) + "%"} />
                <BidTile label="Rejected Opportunities" value={bidNum(rejected.total)} />
                <BidTile label="Latest Bid Snapshot" value={utcDate(bid.meta.windowStart)} />
              </div>
              <div className="cg-bidcallout">
                <p className="cg-bidcallout__lead">{bidIntel.headline}</p>
                {topBidConcern ? (
                  <p className="cg-bidcallout__review">
                    <span className="cg-finding__reviewlabel">Recommended review</span>
                    {topBidConcern.recommendedReview}
                  </p>
                ) : null}
                <p className="cg-bidcallout__limit">
                  Bid metrics come from the latest synchronized snapshot and do not honor the selected calendar period.
                  {bidIntel.snapshotChanges.length === 0 ? " No earlier snapshot is stored, so no bid trend is shown." : ""}
                </p>
              </div>
            </>
          )}
        </div>

        {/* 9 — Risks and Opportunities */}
        <FindingList
          sectionLabel="Risks"
          findings={intel.risks.slice(0, 4)}
          emptyLine="No evidence-backed risks for this period."
          compact
        />
        <FindingList
          sectionLabel="Opportunities"
          findings={intel.opportunities.slice(0, 3)}
          emptyLine="No evidence-backed opportunities for this period."
          compact
        />

        {/* 10 — What Loop Cannot Determine */}
        <UnknownsSection unknowns={[...intel.unknowns, ...bidIntel.unknowns]} />

        {/* 11 — Quick Access (navigate only; carries the selected range) */}
        <div className="cg-sec">
          <p className="cg-seclabel">Quick Access</p>
          <div className="cg-qa">
            {QUICK.map((q) => (
              <Link className="tile cg-qatile" href={rangeQuery ? `${q.href}?${rangeQuery}` : q.href} key={q.href}>
                <span className="tile__title">{q.label}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

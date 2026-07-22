import Link from "next/link";
import { requireCrmContext } from "../../../../crm/crm-data";
import {
  parseCallGridRange, resolveCallGridWindow, callGridRangeQuery,
  describeCallGridWindow, callGridDayNav,
} from "@emgloop/shared";
import { num } from "../../_loop-os";
import type { DayScore } from "../dashboard-data";
import { loadCallGridReport, type CallGridDimRow, type CallGridMetrics } from "./callgrid-report";
import { loadBidReport, sumBid, bidSnapshotMatches } from "./bid-report";
import { deriveCallGridWatch } from "./callgrid-watch";
import CallGridDateRange from "./CallGridDateRange";
import { SnapshotNotice, easternClock } from "./dimension-ui";

export const dynamic = "force-dynamic";

// CallGrid Intelligence — the operational command center (Overview).
//
// Sections, in order: Selected-period metrics, Comparison, Top Performers, Bids
// Overview, Watch List, Quick Access. Every number is real MarketplaceCall data
// for the selected reporting window, run through the canonical report service
// (loadCallGridReport) and honest truth-states — nothing fabricated, nothing
// coerced to zero. The date range is chosen with the shared control and persists
// across tabs via the URL. The Watch List is derived from CallGrid's own data
// only (see callgrid-watch) — never from Brain/platform/sensor health.

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

const SEV_LABEL: Record<string, string> = { critical: "Critical", high: "High", notable: "Notable" };

// A per-tile comparison indicator vs the prior period. Null (→ "No valid
// comparison") whenever the prior value is unavailable, unknown or zero.
function deltaOf(cur: number | null, prior: number | null, curAvail: boolean, priorAvail: boolean) {
  if (!curAvail || !priorAvail || cur === null || prior === null || prior === 0) return null;
  const change = Math.round(((cur - prior) / prior) * 100);
  const dir = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const arrow = change > 0 ? "↑" : change < 0 ? "↓" : "→";
  return { text: `${arrow} ${Math.abs(change)}%`, dir };
}

function MetricTiles({
  score, compare, compareLabel,
}: {
  score: CallGridMetrics | DayScore;
  compare?: CallGridMetrics | null;
  compareLabel?: string;
}) {
  const fields = [
    { key: "Revenue", val: money(score.revenueCents, score.available), cur: score.revenueCents, prior: compare?.revenueCents ?? null },
    { key: "Profit", val: money(score.profitCents, score.available), cur: score.profitCents, prior: compare?.profitCents ?? null },
    { key: "Billable Calls", val: count(score.billableCalls, score.available), cur: score.billableCalls, prior: compare?.billableCalls ?? null },
    { key: "Total Calls", val: count(score.totalCalls, score.available), cur: score.totalCalls, prior: compare?.totalCalls ?? null },
  ];
  return (
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
  );
}

function PerformerTile({ label, row }: { label: string; row: CallGridDimRow | null }) {
  return (
    <section className="tile tile--metric" aria-label={label}>
      <div className="tile__head"><span className="tile__title">{label}</span></div>
      {row ? (
        <>
          <div className="tile__num cg-name">{row.label}</div>
          <p className="tile__line">{money(row.revenueCents, true)} · {num(row.calls)} calls</p>
        </>
      ) : (
        <>
          <div className="tile__num cg-name cg-muted">—</div>
          <p className="tile__line">No data for this period</p>
        </>
      )}
    </section>
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

  const [report, bid] = await Promise.all([loadCallGridReport(org, window), loadBidReport(org)]);

  const watch = deriveCallGridWatch(report, bid);
  const compareShort = desc.comparisonTitle.split(" · ")[0];

  // Bids Overview (latest synchronized snapshot — never fabricated for history).
  const bidSources = bid.sources;
  const bidsSubmitted = sumBid(bidSources, (r) => r.bids);
  const bidsWon = sumBid(bidSources, (r) => r.won);
  const bidWinRate = bidsSubmitted && bidsSubmitted > 0 && bidsWon !== null ? Math.round((bidsWon / bidsSubmitted) * 100) : null;
  const bidNum = (v: number | null) => (v === null ? "—" : num(v));
  const bidMatches = bidSnapshotMatches(bid.meta, window);

  return (
    <div className="loop-os">
      <div className="cmd cg-page">
        <div className="cmd-head">
          <div className="cmd-head__main">
            <p className="cmd-head__greeting">CallGrid Intelligence</p>
            <p className="cmd-head__meta">{desc.headerLine}</p>
          </div>
        </div>

        <CallGridDateRange
          preset={window.preset}
          customStart={range.start}
          customEnd={range.end}
          label={window.label}
          dayNav={dayNav}
          live={desc.live}
          updatedLabel={easternClock(now)}
        />

        {/* 1 — Selected period */}
        <div className="cg-sec">
          <p className="cg-seclabel">{desc.periodTitle}</p>
          <MetricTiles score={report.metrics} compare={report.comparison} compareLabel={compareShort} />
        </div>

        {/* 2 — Comparison period */}
        {report.comparison ? (
          <div className="cg-sec">
            <p className="cg-seclabel">{desc.comparisonTitle}</p>
            <MetricTiles score={report.comparison} />
          </div>
        ) : null}

        {/* 3 — Top Performers */}
        <div className="cg-sec">
          <p className="cg-seclabel">Top Performers</p>
          <div className="cg-tiles">
            <PerformerTile label="Top Buyer" row={report.dimensions.buyers[0] ?? null} />
            <PerformerTile label="Top Vendor" row={report.dimensions.vendors[0] ?? null} />
            <PerformerTile label="Top Source" row={report.dimensions.sources[0] ?? null} />
            <PerformerTile label="Top Campaign" row={report.dimensions.campaigns[0] ?? null} />
          </div>
        </div>

        {/* 4 — Bids Overview (snapshot grain; links to the Bids workspace) */}
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
                <BidTile label="Bid Opportunities" value={bidNum(sumBid(bidSources, (r) => r.total))} />
                <BidTile label="Bids Submitted" value={bidNum(bidsSubmitted)} />
                <BidTile label="Bids Won" value={bidNum(bidsWon)} />
                <BidTile label="Source Win Rate" value={bidWinRate === null ? "—" : bidWinRate + "%"} />
                <BidTile label="Rejected Opportunities" value={bidNum(sumBid(bidSources, (r) => r.rejected))} />
                <BidTile label="Latest Bid Snapshot" value={utcDate(bid.meta.windowStart)} />
              </div>
            </>
          )}
        </div>

        {/* 5 — Watch List (CallGrid operational findings only) */}
        <div className="cg-sec">
          <p className="cg-seclabel">Watch List</p>
          <section className="tile tile--wide cg-watch" aria-label="Watch List">
            {!report.ok ? (
              <p className="tile__line cg-muted">Watch list unavailable — CallGrid data could not be loaded.</p>
            ) : watch.length === 0 ? (
              <p className="tile__line">No CallGrid operational issues detected for this period.</p>
            ) : (
              <ul className="cg-watch__list">
                {watch.map((w) => (
                  <li className="cg-watch__item cg-watch__item--stack" key={w.id}>
                    <span className="cg-watch__row">
                      <span className={"cg-sev cg-sev--" + w.severity}>{SEV_LABEL[w.severity] ?? w.severity}</span>
                      <span className="cg-watch__title">{w.category}</span>
                      {w.snapshot ? <span className="cg-tag">latest snapshot</span> : null}
                    </span>
                    <span className="cg-watch__text">{w.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* 6 — Quick Access (navigate only; carries the selected range) */}
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

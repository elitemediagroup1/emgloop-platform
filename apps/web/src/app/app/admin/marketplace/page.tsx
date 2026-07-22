import Link from "next/link";
import { requireCrmContext } from "../../../../crm/crm-data";
import { parseCallGridRange, resolveCallGridWindow, callGridRangeQuery } from "@emgloop/shared";
import { num } from "../../_loop-os";
import type { DayScore } from "../dashboard-data";
import { loadCallGridReport, type CallGridDimRow, type CallGridMetrics } from "./callgrid-report";
import CallGridDateRange from "./CallGridDateRange";
import { loadExecutiveBrain } from "../_executive/executive-brain-data";

export const dynamic = "force-dynamic";

// CallGrid Intelligence — the operational command center (Overview).
//
// Five operator sections only: Selected-period metrics, Comparison, Top
// Performers, Watch List, Quick Access. Every number is real MarketplaceCall data
// for the selected reporting window, run through the canonical report service
// (loadCallGridReport) and honest truth-states — nothing fabricated, nothing
// coerced to zero. The date range is chosen with the shared control and persists
// across tabs via the URL.

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

const QUICK: { label: string; href: string }[] = [
  { label: "Buyers", href: "/app/admin/marketplace/buyers" },
  { label: "Vendors", href: "/app/admin/marketplace/vendors" },
  { label: "Sources", href: "/app/admin/marketplace/sources" },
  { label: "Campaigns", href: "/app/admin/marketplace/campaigns" },
  { label: "Bids", href: "/app/admin/marketplace/bids" },
  { label: "Activity", href: "/app/admin/marketplace/activity" },
];

const SEV_LABEL: Record<string, string> = {
  critical: "Critical", high: "High", notable: "Notable", informational: "Info",
};

function MetricTiles({ score }: { score: CallGridMetrics | DayScore }) {
  return (
    <div className="cg-tiles">
      <section className="tile" aria-label="Revenue">
        <div className="tile__head"><span className="tile__title">Revenue</span></div>
        <div className="tile__num">{money(score.revenueCents, score.available)}</div>
      </section>
      <section className="tile" aria-label="Profit">
        <div className="tile__head"><span className="tile__title">Profit</span></div>
        <div className="tile__num">{money(score.profitCents, score.available)}</div>
      </section>
      <section className="tile" aria-label="Billable Calls">
        <div className="tile__head"><span className="tile__title">Billable Calls</span></div>
        <div className="tile__num">{count(score.billableCalls, score.available)}</div>
      </section>
      <section className="tile" aria-label="Total Calls">
        <div className="tile__head"><span className="tile__title">Total Calls</span></div>
        <div className="tile__num">{count(score.totalCalls, score.available)}</div>
      </section>
    </div>
  );
}

function PerformerTile({ label, row }: { label: string; row: CallGridDimRow | null }) {
  return (
    <section className="tile" aria-label={label}>
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

export default async function CallGridIntelligencePage({
  searchParams,
}: {
  searchParams?: { range?: string; s?: string; e?: string };
}) {
  const { organizationId: org } = await requireCrmContext();

  const range = parseCallGridRange({ range: searchParams?.range, s: searchParams?.s, e: searchParams?.e });
  const window = resolveCallGridWindow(range, new Date());
  const rangeQuery = callGridRangeQuery(window.preset, { start: range.start, end: range.end });

  const [report, brainR] = await Promise.all([
    loadCallGridReport(org, window),
    loadExecutiveBrain(org).catch(() => null),
  ]);

  const primaryTitle = window.preset === "today" ? "Today" : window.label;
  const comparisonTitle =
    window.preset === "today" ? "Yesterday" : window.preset === "yesterday" ? "Day Before" : "Prior Period";

  const brainReport = brainR && brainR.report.state === "success" ? brainR.report.value : null;
  const watch = brainReport ? brainReport.risks.slice(0, 5) : [];

  return (
    <div className="loop-os">
      <div className="cmd cg-page">
        <div className="cmd-head">
          <div className="cmd-head__main">
            <p className="cmd-head__greeting">CallGrid Intelligence</p>
            <p className="cmd-head__meta">{window.label} · Eastern Time</p>
          </div>
        </div>

        <CallGridDateRange preset={window.preset} customStart={range.start} customEnd={range.end} label={window.label} />

        {/* Section 1 — Selected period */}
        <div className="cg-sec">
          <p className="cg-seclabel">{primaryTitle}</p>
          <MetricTiles score={report.metrics} />
        </div>

        {/* Section 2 — Comparison */}
        {report.comparison ? (
          <div className="cg-sec">
            <p className="cg-seclabel">{comparisonTitle}</p>
            <MetricTiles score={report.comparison} />
          </div>
        ) : null}

        {/* Section 3 — Top Performers */}
        <div className="cg-sec">
          <p className="cg-seclabel">Top Performers</p>
          <div className="cg-tiles">
            <PerformerTile label="Top Buyer" row={report.dimensions.buyers[0] ?? null} />
            <PerformerTile label="Top Vendor" row={report.dimensions.vendors[0] ?? null} />
            <PerformerTile label="Top Source" row={report.dimensions.sources[0] ?? null} />
            <PerformerTile label="Top Campaign" row={report.dimensions.campaigns[0] ?? null} />
          </div>
        </div>

        {/* Section 4 — Watch List (Brain-evaluated risks; operational filtering lands next increment) */}
        <div className="cg-sec">
          <p className="cg-seclabel">Watch List</p>
          <section className="tile tile--wide cg-watch" aria-label="Watch List">
            {!brainReport ? (
              <p className="tile__line cg-muted">Watch list unavailable — the Brain could not evaluate risks right now.</p>
            ) : watch.length === 0 ? (
              <p className="tile__line">No CallGrid operational issues detected for this period.</p>
            ) : (
              <ul className="cg-watch__list">
                {watch.map((w) => (
                  <li className="cg-watch__item" key={w.id}>
                    <span className={"cg-sev cg-sev--" + w.severity}>{SEV_LABEL[w.severity] ?? w.severity}</span>
                    <span className="cg-watch__text">{w.observation}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Section 5 — Quick Access (navigate only; carries the selected range) */}
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

import Link from "next/link";
import { requireCrmContext, crmRepos } from "../../../../crm/crm-data";
import { easternYesterdayWindow, easternTodayWindow } from "@emgloop/shared";
import { num, todayLabel } from "../../_loop-os";
import { toScore, type DayScore } from "../dashboard-data";
import { loadDimensionWindows, type DimRow } from "./callgrid-dimensions";
import { loadExecutiveBrain } from "../_executive/executive-brain-data";

export const dynamic = "force-dynamic";

// CallGrid Intelligence — the operational command center.
//
// Ownership split: everything the Brain reasons over (Executive Summary, System
// Health, Cross-Sensor Insights, Top Risks/Opportunities, Recommended Actions,
// Evidence Coverage/Sources, Confidence, What Changed, Narrative, Missing
// Sensors/Integrations, Sensor Coverage) now lives on the Brain page. This page
// keeps ONLY the operator's five sections — Today, Yesterday, Top Performers, a
// Watch List, and Quick Access. Tiles only, everything above the fold; scrolling
// belongs to the drill-downs. Every number is real MarketplaceCall data run
// through the same honest truth-states the Dashboard uses; nothing is fabricated.

// Money/number cells that respect truth-states: a failed read is Unavailable, a
// window with calls but no economics is Unknown, and a genuine no-activity window
// is a real $0. Identical rules to the Dashboard scorecard (shared toScore).
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

async function scoreFor(org: string, win: { start: Date; end: Date }): Promise<DayScore> {
  try {
    return toScore(await crmRepos.marketplaceCalls.aggregateWindow(org, win.start, win.end));
  } catch {
    return toScore(null); // → Unavailable
  }
}

async function topRow(org: string, dim: "buyers" | "vendors" | "sources" | "campaigns"): Promise<DimRow | null> {
  try {
    const w = await loadDimensionWindows(org, dim);
    return w.current.rows[0] ?? null;
  } catch {
    return null;
  }
}

const SEV_LABEL: Record<string, string> = {
  critical: "Critical",
  high: "High",
  notable: "Notable",
  informational: "Info",
};

// Section 5 — Quick Access. These tiles ONLY navigate (the six drill-downs).
const QUICK: { label: string; href: string }[] = [
  { label: "Buyers", href: "/app/admin/marketplace/buyers" },
  { label: "Vendors", href: "/app/admin/marketplace/vendors" },
  { label: "Sources", href: "/app/admin/marketplace/sources" },
  { label: "Campaigns", href: "/app/admin/marketplace/campaigns" },
  { label: "Bids", href: "/app/admin/marketplace/auction" },
  { label: "Activity", href: "/app/admin/marketplace/activity" },
];

function MetricTiles({ score }: { score: DayScore }) {
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

function PerformerTile({ label, row }: { label: string; row: DimRow | null }) {
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
          <p className="tile__line">No data yet</p>
        </>
      )}
    </section>
  );
}

export default async function CallGridIntelligencePage() {
  const { organizationId: org } = await requireCrmContext();

  const now = new Date();
  const yWin = easternYesterdayWindow(now);
  const tWin = easternTodayWindow(now);

  // org is resolved by requireCrmContext; if it is unresolved every loader below
  // returns an honest empty/unavailable rather than crashing.
  const [today, yesterday, topBuyer, topVendor, topSource, topCampaign, brainR] = await Promise.all([
    scoreFor(org, tWin),
    scoreFor(org, yWin),
    topRow(org, "buyers"),
    topRow(org, "vendors"),
    topRow(org, "sources"),
    topRow(org, "campaigns"),
    loadExecutiveBrain(org).catch(() => null),
  ]);

  // Watch List — the ONLY evidence-backed risk data is the Brain's own risks,
  // already gated by the Evidence Engine. We present a thin operational list of
  // them here (not the Brain's Risk component). If the Brain evaluated and found
  // none → "No operational issues detected"; if it could not evaluate, say so
  // rather than imply all-clear.
  const report = brainR && brainR.report.state === "success" ? brainR.report.value : null;
  const watch = report ? report.risks.slice(0, 5) : [];

  return (
    <div className="loop-os">
      <div className="cmd cg-page">
        <div className="cmd-head">
          <div className="cmd-head__main">
            <p className="cmd-head__greeting">CallGrid Intelligence</p>
            <p className="cmd-head__meta">{todayLabel()} · Eastern Time</p>
          </div>
        </div>

        {/* Section 1 — Today */}
        <div className="cg-sec">
          <p className="cg-seclabel">Today</p>
          <MetricTiles score={today} />
        </div>

        {/* Section 2 — Yesterday */}
        <div className="cg-sec">
          <p className="cg-seclabel">Yesterday</p>
          <MetricTiles score={yesterday} />
        </div>

        {/* Section 3 — Top Performers */}
        <div className="cg-sec">
          <p className="cg-seclabel">Top Performers</p>
          <div className="cg-tiles">
            <PerformerTile label="Top Buyer" row={topBuyer} />
            <PerformerTile label="Top Vendor" row={topVendor} />
            <PerformerTile label="Top Source" row={topSource} />
            <PerformerTile label="Top Campaign" row={topCampaign} />
          </div>
        </div>

        {/* Section 4 — Watch List */}
        <div className="cg-sec">
          <p className="cg-seclabel">Watch List</p>
          <section className="tile tile--wide cg-watch" aria-label="Watch List">
            {!report ? (
              <p className="tile__line cg-muted">Watch list unavailable — the Brain could not evaluate risks right now.</p>
            ) : watch.length === 0 ? (
              <p className="tile__line">No operational issues detected.</p>
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

        {/* Section 5 — Quick Access (navigate only) */}
        <div className="cg-sec">
          <p className="cg-seclabel">Quick Access</p>
          <div className="cg-qa">
            {QUICK.map((q) => (
              <Link className="tile cg-qatile" href={q.href} key={q.href}>
                <span className="tile__title">{q.label}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

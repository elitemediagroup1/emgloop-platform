// CallGrid Intelligence — Buyers.
//
// Demand-side performance for the selected period. This page reads the SAME
// canonical CallGrid source as the Overview's Top Buyer tile — the MarketplaceCall
// projection via loadDimensionWindows('buyers') — so the two never disagree. It
// does NOT read CRM revenue models (the previous defect: it read
// revenueIntelligence.revenueByDimension, which returned UNKNOWN → a false "0
// buyers" while the Overview showed a real Top Buyer from the call projection).
//
// Only CallGrid business information lives here: no Integration Status, no Live
// Calls rail, no Brain briefing, no provider pills — those belong to other
// products (removed per the finalization spec).

import Link from "next/link";
import { requireCrmContext } from "../../../../../crm/crm-data";
import { money, num, todayLabel } from "../../../_loop-os";
import { CallGridNav } from "../_CallGridNav";
import { loadDimensionWindows, type DimRow, type DimWindow } from "../callgrid-dimensions";

export const dynamic = "force-dynamic";

// Revenue per billable call, only when both are real and billable > 0.
function revPerBillable(revenueCents: number, billable: number): number | null {
  return billable > 0 ? Math.round(revenueCents / billable) : null;
}

// A row's trend vs its prior-window self. Never a percentage when the prior
// denominator is zero/absent — that reads as "No comparable prior data".
function trend(current: number, prior: number | undefined): { text: string; dir: "up" | "down" | "flat" | "na" } {
  if (prior === undefined || prior <= 0) return { text: "No comparable prior data", dir: "na" };
  const change = Math.round(((current - prior) / prior) * 100);
  if (change === 0) return { text: "0%", dir: "flat" };
  return { text: (change > 0 ? "+" : "") + change + "%", dir: change > 0 ? "up" : "down" };
}

interface Summary {
  totalBuyers: number;
  activeBuyers: number;
  revenueCents: number;
  billableCalls: number;
  totalCalls: number;
  avgRevPerBillable: number | null;
}

function summarize(w: DimWindow): Summary {
  const rows = w.rows;
  const revenueCents = rows.reduce((s, r) => s + r.revenueCents, 0);
  const billableCalls = rows.reduce((s, r) => s + r.monetized, 0);
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  return {
    totalBuyers: rows.length,
    activeBuyers: rows.filter((r) => r.calls > 0 || r.monetized > 0 || r.revenueCents > 0).length,
    revenueCents,
    billableCalls,
    totalCalls,
    avgRevPerBillable: revPerBillable(revenueCents, billableCalls),
  };
}

function Tile({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <section className="tile" aria-label={title}>
      <div className="tile__head"><span className="tile__title">{title}</span></div>
      <div className="tile__num">{value}</div>
      {sub ? <p className="tile__line">{sub}</p> : null}
    </section>
  );
}

export default async function BuyersPage({ searchParams }: { searchParams?: { buyer?: string } }) {
  const { organizationId: org } = await requireCrmContext();

  const windows = await loadDimensionWindows(org, "buyers");
  const cur = windows.current;
  const prior = windows.prior;
  const ok = cur.ok;
  const rows = [...cur.rows].sort((a, b) => b.revenueCents - a.revenueCents);
  const priorByKey = new Map(prior.rows.map((r) => [r.key, r] as const));
  const totalRevenue = rows.reduce((s, r) => s + r.revenueCents, 0);

  const s = summarize(cur);
  const dateLabel = todayLabel();

  const selectedKey = typeof searchParams?.buyer === "string" ? searchParams.buyer : null;
  const selected: DimRow | null = selectedKey ? rows.find((r) => r.key === selectedKey) ?? null : null;
  const selectedPrior = selected ? priorByKey.get(selected.key) : undefined;

  return (
    <div className="loop-os">
      <div className="cmd cg-page dim-page">
        {/* Header */}
        <div className="cmd-head">
          <div className="cmd-head__main">
            <p className="cmd-head__greeting">CallGrid Intelligence</p>
            <p className="cmd-head__meta">{dateLabel} · Eastern Time</p>
          </div>
        </div>
        <h1 className="dim-title">Buyers</h1>
        <p className="dim-sub">Demand-side performance for the selected period.</p>

        <CallGridNav active="buyers" />

        {!ok ? (
          <div className="cg-sec">
            <section className="tile tile--wide" aria-label="Buyers">
              <p className="tile__line cg-muted">CallGrid data could not be loaded. Reload to try again.</p>
            </section>
          </div>
        ) : rows.length === 0 ? (
          <div className="cg-sec">
            <section className="tile tile--wide" aria-label="Buyers">
              <p className="tile__line">No buyer activity for this period.</p>
            </section>
          </div>
        ) : (
          <>
            {/* Summary metrics — six tiles */}
            <div className="cg-sec">
              <p className="cg-seclabel">Summary</p>
              <div className="dim-tiles">
                <Tile title="Total Buyers" value={num(s.totalBuyers)} />
                <Tile title="Active Buyers" value={num(s.activeBuyers)} sub="With activity this period" />
                <Tile title="Revenue" value={money(s.revenueCents)} />
                <Tile title="Billable Calls" value={num(s.billableCalls)} />
                <Tile title="Total Calls" value={num(s.totalCalls)} />
                <Tile title="Avg Revenue / Billable Call" value={s.avgRevPerBillable === null ? "Not available" : money(s.avgRevPerBillable)} />
              </div>
            </div>

            {/* Buyer Performance directory */}
            <div className="cg-sec">
              <p className="cg-seclabel">Buyer Performance</p>
              <div className="adm-tablewrap">
                <table className="adm-table dim-table">
                  <thead>
                    <tr>
                      <th>Buyer</th>
                      <th className="dim-num">Revenue</th>
                      <th className="dim-num">Billable</th>
                      <th className="dim-num">Total Calls</th>
                      <th className="dim-num">Rev / Billable</th>
                      <th className="dim-num">Share of Revenue</th>
                      <th className="dim-num">Trend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const rpb = revPerBillable(r.revenueCents, r.monetized);
                      const share = totalRevenue > 0 ? Math.round((r.revenueCents / totalRevenue) * 100) : 0;
                      const t = trend(r.revenueCents, priorByKey.get(r.key)?.revenueCents);
                      const isSel = selectedKey === r.key;
                      return (
                        <tr key={r.key} className={isSel ? "dim-row dim-row--sel" : "dim-row"}>
                          <td>
                            <Link href={`?buyer=${encodeURIComponent(r.key)}`} className="dim-rowlink">
                              {r.label}
                            </Link>
                          </td>
                          <td className="dim-num">{money(r.revenueCents)}</td>
                          <td className="dim-num">{num(r.monetized)}</td>
                          <td className="dim-num">{num(r.calls)}</td>
                          <td className="dim-num">{rpb === null ? "—" : money(rpb)}</td>
                          <td className="dim-num">{share}%</td>
                          <td className={"dim-num dim-trend dim-trend--" + t.dir}>{t.text}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Selected buyer detail */}
            <div className="cg-sec">
              <p className="cg-seclabel">Buyer Detail</p>
              <section className="tile tile--wide dim-detail" aria-label="Buyer detail">
                {!selected ? (
                  <p className="tile__line cg-muted">Select a buyer to view performance details.</p>
                ) : (
                  <>
                    <div className="dim-detail__head">
                      <span className="dim-detail__name">{selected.label}</span>
                      <span className="dim-detail__period">{dateLabel} · Eastern Time</span>
                    </div>
                    <dl className="dim-detail__grid">
                      <div><dt>Revenue</dt><dd>{money(selected.revenueCents)}</dd></div>
                      <div><dt>Billable Calls</dt><dd>{num(selected.monetized)}</dd></div>
                      <div><dt>Total Calls</dt><dd>{num(selected.calls)}</dd></div>
                      <div><dt>Rev / Billable</dt><dd>{revPerBillable(selected.revenueCents, selected.monetized) === null ? "—" : money(revPerBillable(selected.revenueCents, selected.monetized)!)}</dd></div>
                      <div><dt>Revenue trend</dt><dd>{trend(selected.revenueCents, selectedPrior?.revenueCents).text}</dd></div>
                      <div><dt>Call trend</dt><dd>{trend(selected.calls, selectedPrior?.calls).text}</dd></div>
                    </dl>
                    <p className="dim-detail__note cg-muted">
                      Per-buyer campaign, source and vendor attribution is not exposed at the buyer grain by the current CallGrid data.
                    </p>
                  </>
                )}
              </section>
            </div>

            {/* Recent activity — honest: no buyer-level CallGrid event stream yet */}
            <div className="cg-sec">
              <p className="cg-seclabel">Recent Activity</p>
              <section className="tile tile--wide" aria-label="Recent buyer activity">
                <p className="tile__line cg-muted">No durable buyer-level CallGrid events for this period.</p>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import Link from "next/link";

import { profitCents, revenuePerBillableCall } from "@emgloop/shared";

import { loadCommandContext, withQuery, type SearchParams } from "../command-data";
import { CommandShell, Card, TrendChart, money, count, pct } from "../command-ui";
import type { CallGridDimRow, CallGridMetrics, Dimension } from "../callgrid-report";
import { topShare } from "../call-dimension-page";
import { requireWorkspacePermission } from "../../../../../workspaces/guard";

export const dynamic = "force-dynamic";

// CallGrid Intelligence — Money.
//
// THE ECONOMICS OF THE MARKETPLACE, ONE DEFINITION EACH. Revenue is what buyers
// paid; payout what vendors were paid; telco cost what the calls cost to carry; Net
// Profit is revenue − payout − telco cost (`profitCents`), and Margin is Net Profit ÷
// Revenue. Every figure is the canonical report's, for the period and for its
// comparison. By-entity economics are sums over each entity's own calls -- a call
// carries its own revenue, payout and cost, so nothing is apportioned.
//
// Partial coverage is said where it applies: a period where some calls carried no
// revenue has incomplete revenue, and profit can only be as complete as its weakest
// input.

const BASE = "/app/admin/marketplace";
const DIMS: { dim: Dimension; title: string }[] = [
  { dim: "buyers", title: "By buyer" },
  { dim: "campaigns", title: "By campaign" },
  { dim: "sources", title: "By source" },
  { dim: "vendors", title: "By vendor" },
];

function marginPct(profit: number | null, revenue: number | null): number | null {
  return profit === null || revenue === null || revenue <= 0 ? null : (profit / revenue) * 100;
}
function delta(cur: number | null, prior: number | null): string {
  if (cur === null || prior === null || prior === 0) return "—";
  const p = Math.round(((cur - prior) / Math.abs(prior)) * 100);
  return `${p > 0 ? "↑" : p < 0 ? "↓" : "→"} ${Math.abs(p)}%`;
}

function EconomicsTable({ m, c, compareTitle }: { m: CallGridMetrics; c: CallGridMetrics | null; compareTitle: string | null }) {
  const rows: { id: string; label: string; cur: number | null; prior: number | null; kind: "money" | "count" | "pct"; note?: string }[] = [
    { id: "revenue", label: "Revenue", cur: m.revenueCents, prior: c?.revenueCents ?? null, kind: "money" },
    { id: "payout", label: "Payout", cur: m.payoutCents, prior: c?.payoutCents ?? null, kind: "money", note: "Paid to vendors" },
    { id: "telcoCost", label: "Telco cost", cur: m.costCents, prior: c?.costCents ?? null, kind: "money", note: "Carrying the calls" },
    { id: "netProfit", label: "Net profit", cur: m.profitCents, prior: c?.profitCents ?? null, kind: "money", note: "Revenue − payout − telco cost" },
    { id: "margin", label: "Margin", cur: marginPct(m.profitCents, m.revenueCents), prior: c ? marginPct(c.profitCents, c.revenueCents) : null, kind: "pct", note: "Net profit ÷ revenue" },
    { id: "billableCalls", label: "Billable calls", cur: m.billableCalls, prior: c?.billableCalls ?? null, kind: "count" },
    { id: "calls", label: "Total calls", cur: m.totalCalls, prior: c?.totalCalls ?? null, kind: "count" },
    { id: "revPerBillable", label: "Revenue per billable call", cur: m.billableCalls !== null ? revenuePerBillableCall(m.revenueCents, m.billableCalls) : null, prior: c && c.billableCalls !== null ? revenuePerBillableCall(c.revenueCents, c.billableCalls) : null, kind: "money" },
  ];
  const fmt = (v: number | null, k: "money" | "count" | "pct") => (k === "money" ? money(v) : k === "pct" ? pct(v, 1) : count(v));
  return (
    <div className="adm-tablewrap">
      <table className="adm-table dim-table cgx-table">
        <thead>
          <tr><th>Measure</th><th className="dim-num">This period</th>{c ? <th className="dim-num">{compareTitle}</th> : null}{c ? <th className="dim-num">Change</th> : null}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} id={`kpi-${r.id}`} className="dim-row">
              <td>{r.label}{r.note ? <span className="cgx-muted"> · {r.note}</span> : null}</td>
              <td className="dim-num">{m.available ? fmt(r.cur, r.kind) : "Unavailable"}</td>
              {c ? <td className="dim-num">{c.available ? fmt(r.prior, r.kind) : "Unavailable"}</td> : null}
              {c ? <td className="dim-num">{r.kind === "pct" ? (r.cur !== null && r.prior !== null ? `${r.cur - r.prior >= 0 ? "+" : "−"}${Math.abs(r.cur - r.prior).toFixed(1)} pts` : "—") : delta(r.cur, r.prior)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ByEntity({ rows, prior, dim, query, total }: { rows: readonly CallGridDimRow[]; prior: Map<string, CallGridDimRow>; dim: Dimension; query: string; total: number | null }) {
  if (rows.length === 0) return <p className="cgx-empty">No activity in this period.</p>;
  return (
    <div className="adm-tablewrap">
      <table className="adm-table dim-table cgx-table">
        <thead>
          <tr><th>Name</th><th className="dim-num">Revenue</th><th className="dim-num">Payout</th><th className="dim-num">Telco</th><th className="dim-num">Net profit</th><th className="dim-num">Margin</th><th className="dim-num">Share</th><th className="dim-num">vs prior</th></tr>
        </thead>
        <tbody>
          {rows.slice(0, 10).map((r) => (
            <tr key={r.key} className="dim-row">
              <td><Link href={withQuery(`${BASE}/${dim}/${encodeURIComponent(r.key)}`, query)} className="dim-rowlink">{r.label}</Link></td>
              <td className="dim-num">{money(r.revenueCents)}</td>
              <td className="dim-num">{money(r.payoutCents)}</td>
              <td className="dim-num">{money(r.costCents)}</td>
              <td className="dim-num">{money(r.marginCents)}</td>
              <td className="dim-num">{pct(marginPct(r.marginCents, r.revenueCents), 1)}</td>
              <td className="dim-num">{r.revenueCents !== null && total ? `${Math.round((r.revenueCents / total) * 100)}%` : "—"}</td>
              <td className="dim-num">{delta(r.revenueCents, prior.get(r.key)?.revenueCents ?? null)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 10 ? <p className="cgx-foot"><Link href={withQuery(`${BASE}/${dim}`, query)}>All {rows.length} →</Link></p> : null}
    </div>
  );
}

export default async function MoneyPage({ searchParams }: { searchParams?: SearchParams }) {
  const session = await requireWorkspacePermission("ADMIN", "intelligence", "view");
  const ctx = await loadCommandContext(session, searchParams);
  const { report, facts, comparisonFacts, buckets, query } = ctx;
  const m = report.metrics;
  const c = report.comparison;
  const total = m.revenueCents;
  const chartBuckets = buckets.current.length >= buckets.comparison.length ? buckets.current : buckets.comparison;
  const revenueSeries = (f: typeof facts) => f?.series.map((p) => (p.calls === 0 ? 0 : p.callsWithRevenue === 0 ? null : p.revenueCents)) ?? [];
  const profitSeries = (f: typeof facts) =>
    f?.series.map((p) => (p.calls === 0 ? 0 : p.callsWithRevenue === 0 ? null : profitCents(p.revenueCents, p.payoutCents, p.costCents))) ?? [];

  return (
    <CommandShell ctx={ctx} active="money" path={`${BASE}/money`}>
      {!report.ok ? <p className="cgx-note">CallGrid data could not be loaded. Reload to try again.</p> : null}
      {m.revenueCoverage !== null && m.revenueCoverage < 1 && m.revenueCoverage > 0 ? (
        <p className="cgx-note">{Math.round(m.revenueCoverage * 100)}% of calls carried a revenue value, so revenue is incomplete for the period{m.profitCoverage !== null && m.profitCoverage < 1 ? `, and net profit — only ${Math.round(m.profitCoverage * 100)}% complete in its weakest input — may be overstated` : ""}.</p>
      ) : null}

      <div className="cgx-grid cgx-grid--2">
        <Card title="Economics" id="economics">
          <EconomicsTable m={m} c={c} compareTitle={c ? ctx.desc.comparisonTitle : null} />
        </Card>
        <Card title="Revenue over the period">
          <TrendChart
            buckets={chartBuckets}
            current={revenueSeries(facts)}
            comparison={comparisonFacts ? revenueSeries(comparisonFacts) : null}
            currentLabel={ctx.selection.label}
            comparisonLabel={c ? ctx.desc.comparisonTitle : null}
            format={(v) => money(v)}
            cumulative
            title="Revenue so far against the comparison period"
          />
        </Card>
      </div>

      <div className="cgx-grid cgx-grid--2">
        <Card title="Net profit over the period">
          <TrendChart
            buckets={chartBuckets}
            current={profitSeries(facts)}
            comparison={comparisonFacts ? profitSeries(comparisonFacts) : null}
            currentLabel={ctx.selection.label}
            comparisonLabel={c ? ctx.desc.comparisonTitle : null}
            format={(v) => money(v)}
            cumulative
            title="Net profit so far against the comparison period"
          />
        </Card>
        <Card title="Concentration">
          <table className="adm-table dim-table cgx-table">
            <thead><tr><th>Dimension</th><th className="dim-num">Top one</th><th className="dim-num">Top three</th><th className="dim-num">With revenue</th></tr></thead>
            <tbody>
              {DIMS.map(({ dim, title }) => {
                const rows = report.dimensions[dim];
                const one = topShare(rows, total, 1);
                const three = topShare(rows, total, 3);
                return (
                  <tr key={dim} className="dim-row">
                    <td>{title.replace("By ", "").replace(/^./, (s) => s.toUpperCase())}s{rows[0] ? <span className="cgx-muted"> · top: {rows[0].label}</span> : null}</td>
                    <td className="dim-num">{one === null ? "—" : `${Math.round(one * 100)}%`}</td>
                    <td className="dim-num">{three === null ? "—" : `${Math.round(three * 100)}%`}</td>
                    <td className="dim-num">{count(rows.filter((r) => r.revenueCents !== null && r.revenueCents > 0).length)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="cgx-foot">Shares of the period’s revenue. Arithmetic on measured values; Loop does not grade them here — concentration findings are in Intelligence.</p>
        </Card>
      </div>

      {DIMS.map(({ dim, title }) => (
        <Card key={dim} title={title} wide action={{ label: title.replace("By ", "All "), href: withQuery(`${BASE}/${dim}`, query) }}>
          <ByEntity rows={report.dimensions[dim]} prior={report.comparisonByKey[dim]} dim={dim} query={query} total={total} />
        </Card>
      ))}
      <p className="cgx-foot">By-entity economics are the sums over each entity’s own calls. Calls that named no {`buyer, campaign, source or vendor`} count in the totals above and in none of these tables.</p>
    </CommandShell>
  );
}

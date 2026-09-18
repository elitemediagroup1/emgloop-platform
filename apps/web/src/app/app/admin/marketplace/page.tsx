import Link from "next/link";

import { repositories } from "@emgloop/database";
import { findingsByRank } from "./overview-parts";
import { viewerTime } from "../../../../time/viewer-time";
import { loadCommandContext, withQuery, type SearchParams } from "./command-data";
import { CommandShell, Card, TrendChart, BarList, money, count } from "./command-ui";
import { loadExecutiveAnalysis, topPriorities, executiveBrief } from "./executive-data";
import { TodaysBrief, TopPriorities } from "./executive-ui";
import { loadOrFallback } from "../../../../demo/db-health";
import { requireWorkspacePermission } from "../../../../workspaces/guard";

export const dynamic = "force-dynamic";

// CallGrid Intelligence — the Overview: an executive command center.
//
// IT ANSWERS ONE QUESTION: how is the CallGrid business doing right now, what
// changed, and what deserves attention? In that order: the five KPIs, Today's
// Brief, at most three priorities, then a compact workspace (volume against the
// comparison period, revenue by buyer, top sources, notable changes, live
// activity, quick actions).
//
// IT DOES NOT SHOW EVERYTHING LOOP FOUND. Loop may hold dozens of findings; the
// executive surface names the few that are undecided and points to Intelligence,
// where every finding, its evidence and its limits live -- moved, not removed.
//
// Every number is the canonical report's (see `command-data.ts`), every priority
// the engine's own ranking, and every sentence in the brief carries its basis.
// "Live" is earned by a recent CallGrid delivery, never by the render clock.

const BASE = "/app/admin/marketplace";

export default async function CallGridOverviewPage({ searchParams }: { searchParams?: SearchParams }) {
  const session = await requireWorkspacePermission("ADMIN", "intelligence", "view");
  const ctx = await loadCommandContext(session, searchParams);
  const analysis = await loadExecutiveAnalysis(ctx);
  const { report, buckets, facts, comparisonFacts, query } = ctx;
  const intelHref = withQuery(`${BASE}/intelligence`, query);

  const recentR = await loadOrFallback(() => repositories.marketplaceCalls.recentCalls(ctx.organizationId, 6));
  const time = viewerTime();

  // Revenue by buyer: the top four, then everything else as one row that says how many.
  const buyers = report.dimensions.buyers;
  const total = report.metrics.revenueCents;
  const share = (v: number | null) => (v === null || total === null || total <= 0 ? null : v / total);
  const topBuyers = buyers.slice(0, 4).map((b) => ({ key: b.key, label: b.label, value: b.revenueCents, share: share(b.revenueCents) }));
  const rest = buyers.slice(4);
  // The rest's revenue is the sum of what was reported; none reported is unknown.
  const restKnown = rest.flatMap((b) => (b.revenueCents === null ? [] : [b.revenueCents]));
  const restRevenue = restKnown.length > 0 ? restKnown.reduce((s, v) => s + v, 0) : null;
  const buyerRows = rest.length > 0 ? [...topBuyers, { key: "__other", label: `Other (${rest.length})`, value: restRevenue, share: share(restRevenue) }] : topBuyers;

  // Top sources, with how each moved against the comparison period.
  const priorSources = report.comparisonByKey.sources;
  const priorRank = new Map(report.comparisonDimensions.sources.map((r, i) => [r.key, i + 1] as const));
  const sources = report.dimensions.sources.slice(0, 5).map((s, i) => {
    const prior = priorSources.get(s.key)?.revenueCents ?? null;
    const change = s.revenueCents !== null && prior !== null && prior > 0 ? Math.round(((s.revenueCents - prior) / prior) * 100) : null;
    return { row: s, rank: i + 1, priorRank: priorRank.get(s.key) ?? null, change };
  });

  const priorities = topPriorities(ctx, analysis);
  const brief = executiveBrief(ctx, analysis);
  const notable = findingsByRank(analysis.intel).slice(0, 4);
  const current = ctx.window.includesLiveData && ctx.window.isSingleDay;

  const executive = (
    <div className="cgx-exec">
      <TodaysBrief
        brief={brief}
        title={current ? "Today’s brief" : `Brief · ${ctx.selection.label}`}
        analyzedAt={ctx.now}
        detailsHref={intelHref}
        healthNote={analysis.intel.health.overall.determinacy < 1 ? `Measured on ${Math.round(analysis.intel.health.overall.determinacy * 100)}% of the health model’s weight.` : null}
      />
      <TopPriorities
        priorities={priorities}
        allHref={intelHref}
        emptyLine={analysis.intel.queue.emptyReason ?? "Nothing undecided needs you for this period."}
        unavailable={analysis.ops.persistenceError}
      />
    </div>
  );

  return (
    <CommandShell ctx={ctx} active="overview" path={BASE} executive={executive}>
      <div className="cgx-grid">
        <Card title="Call volume" action={{ label: "Money", href: withQuery(`${BASE}/money`, query) }}>
          {facts ? (
            <TrendChart
              buckets={buckets.current.length >= buckets.comparison.length ? buckets.current : buckets.comparison}
              current={facts.series.map((p) => p.calls)}
              comparison={comparisonFacts ? comparisonFacts.series.map((p) => p.calls) : null}
              currentLabel={ctx.selection.label}
              comparisonLabel={report.comparison ? ctx.desc.comparisonTitle : null}
              format={(v) => Math.round(v).toLocaleString("en-US")}
              cumulative
              title="Calls so far, against the comparison period at the same point"
            />
          ) : (
            <p className="cgx-empty">Loop could not read the calls for this period.</p>
          )}
          <p className="cgx-foot">Running total of calls. {report.comparison ? "The comparison stops at the same elapsed point." : ""}</p>
        </Card>

        <Card title="Revenue by buyer" action={{ label: "Buyers", href: withQuery(`${BASE}/buyers`, query) }}>
          <BarList
            rows={buyerRows}
            format={money}
            empty={report.ok ? "No buyer revenue in this period." : "Loop could not read CallGrid data."}
            hrefFor={(key) => (key === "__other" ? withQuery(`${BASE}/buyers`, query) : withQuery(`${BASE}/buyers/${encodeURIComponent(key)}`, query))}
          />
        </Card>

        <Card title="Top sources by revenue" action={{ label: "Sources", href: withQuery(`${BASE}/sources`, query) }}>
          {sources.length === 0 ? (
            <p className="cgx-empty">No source activity in this period.</p>
          ) : (
            <ol className="cgx-rank">
              {sources.map(({ row, rank, priorRank: was, change }) => (
                <li key={row.key}>
                  <Link href={withQuery(`${BASE}/sources/${encodeURIComponent(row.key)}`, query)} className="cgx-rank__row">
                    <span className="cgx-rank__n">{rank}</span>
                    <span className="cgx-rank__name">{row.label}</span>
                    <span className="cgx-rank__value">{money(row.revenueCents)}</span>
                    <span className={"cgx-rank__move cgx-rank__move--" + (change === null ? "none" : change > 0 ? "up" : change < 0 ? "down" : "flat")}>
                      {change === null ? (was === null ? "New" : "—") : `${change > 0 ? "↑" : change < 0 ? "↓" : "→"} ${Math.abs(change)}%`}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card title="Recent notable changes" action={{ label: "All findings", href: intelHref }}>
          {notable.length === 0 ? (
            <p className="cgx-empty">{report.comparison ? "No change in this period clears Loop’s significance thresholds." : "No comparison period, so no change can be measured."}</p>
          ) : (
            <ul className="cgx-changes">
              {notable.map((f) => {
                const dir = f.percentageChange === null ? "flat" : f.percentageChange > 0 ? "up" : f.percentageChange < 0 ? "down" : "flat";
                return (
                  <li key={f.id} className="cgx-changes__item">
                    <span className={"cgx-changes__dir cgx-changes__dir--" + dir} aria-hidden="true">{dir === "up" ? "↑" : dir === "down" ? "↓" : "•"}</span>
                    <span className="cgx-changes__text">{f.title}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Live activity" action={{ label: "Live calls", href: "/crm/live/calls" }}>
          {!recentR.ok ? (
            <p className="cgx-empty">Loop could not read recent calls.</p>
          ) : recentR.data.length === 0 ? (
            <p className="cgx-empty">No calls have been received from CallGrid yet.</p>
          ) : (
            <ul className="cgx-live">
              {recentR.data.map((c) => {
                const word = c.noRoute ? "No route" : c.monetized ? "Billable" : c.completed ? "Completed" : c.completed === false ? "Not completed" : "Call received";
                const tone = c.noRoute ? "crit" : c.monetized ? "good" : "neutral";
                return (
                  <li key={c.id} className="cgx-live__item">
                    <span className={`cgx-live__dot cgx-live__dot--${tone}`} aria-hidden="true" />
                    <span className="cgx-live__text">
                      {word} — {c.campaignLabel ?? c.sourceLabel ?? "Unattributed"}
                      {c.buyerLabel ? <span className="cgx-live__to"> → {c.buyerLabel}</span> : null}
                    </span>
                    <time className="cgx-live__when" dateTime={c.sourceOccurredAt.toISOString()}>{time.relative(c.sourceOccurredAt)}</time>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="cgx-foot">Calls as CallGrid last reported them. Bids and postbacks are not stored per event.</p>
        </Card>

        <Card title="Quick actions">
          <div className="cgx-actions">
            <Link className="cgx-action" href={intelHref}>Review intelligence</Link>
            <Link className="cgx-action" href={withQuery(`${BASE}/buyers`, query)}>View buyers</Link>
            <Link className="cgx-action" href={withQuery(`${BASE}/bids`, query)}>Review bids</Link>
            <Link className="cgx-action" href={withQuery(`${BASE}/money`, query)}>Open money</Link>
            <Link className="cgx-action" href="/crm/live/calls">Open live calls</Link>
            <Link className="cgx-action" href={withQuery(`${BASE}/activity`, query)}>Findings stream</Link>
          </div>
          <p className="cgx-foot">{count(report.metrics.totalCalls)} calls and {count(report.metrics.billableCalls)} billable in {ctx.selection.label}.</p>
        </Card>
      </div>
    </CommandShell>
  );
}

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
import {
  MarketplaceRiskPanel, OpportunitiesSection, FindingList, UnknownsSection,
  BusinessStorySection,
} from "./intelligence-ui";
import { BriefingBlock, LaneBar, QueueSection } from "./queue-ui";
import { CallGridNav } from "./_CallGridNav";
import { loadCallGridHistory } from "./callgrid-history-data";
import type { Situation } from "@emgloop/shared";

export const dynamic = "force-dynamic";

// CallGrid Intelligence — the Executive Queue.
//
// THIS PAGE IS A QUEUE, NOT A DOCUMENT. It is cleared, not read. The first screen
// answers "is there a fire", names at most three things that need a decision, and
// says which to start with and why. Everything else is below it or one expansion
// behind it.
//
// Order: Nav · Period · Briefing · Lanes · The queue (≤3) · Money · Story ·
// The numbers · What Loop could not determine · Provenance.
//
// The ordering rule that produced this: a section earns its place by changing a
// decision. Metrics answer "what happened", which CallGrid already answers, so
// they sit last and are framed as the audit trail for the conclusions above them
// rather than as information in their own right.
//
// The queue's rows are SITUATIONS, not findings — related observations merged
// before anything was ranked, so one business event is one row rather than four.
// See `callgrid-situation.ts` for the three constraints on that merge.
//
// Every number comes from the canonical report service for the selected window,
// and every conclusion from the deterministic intelligence engine — which reads
// only those same reports. Nothing on this page is computed locally, so Overview
// and a subpage cannot disagree.
//
// NOTE ON THE MISSING BUTTONS: assign / watch / dismiss / resolve are the point
// of a queue, and each is a state that must survive a refresh. Loop does not yet
// remember operator decisions, so they are absent and the page says why. Six
// inert buttons is the fabricated-functionality failure this repo forbids.

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

  // Where a Situation's numbers live. The queue names a business event; this is
  // how an operator reaches the rows behind it. Derived from the entity the
  // Situation is about — nothing is invented when there is no entity.
  const DIM_ROUTE: Record<string, string> = {
    buyer: "buyers", vendor: "vendors", source: "sources", campaign: "campaigns",
    bid_source: "bids", bid_destination: "bids",
  };
  const hrefFor = (s: Situation): string | null => {
    const entity = s.observations[0]?.affectedEntities[0];
    const route = entity ? DIM_ROUTE[entity.entityType] : undefined;
    if (!route) return null;
    const q = rangeQuery ? `?${rangeQuery}` : "";
    return `/app/admin/marketplace/${route}${q}`;
  };

  return (
    <div className="loop-os">
      <div className="cmd cg-page">
        {/* Header. The product's own nav renders here too — it already exists and
            already carries the range, so the Overview no longer keeps a second
            navigation of its own. */}
        <div className="cmd-head">
          <div className="cmd-head__main">
            <p className="cmd-head__greeting">CallGrid Intelligence</p>
            <p className="cmd-head__meta">{desc.headerLine}</p>
          </div>
        </div>
        <CallGridNav active="overview" rangeQuery={rangeQuery} />

        {/* Period control */}
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

        {/* ------------------------------------------------------------------
            THE FIRST SCREEN. Briefing, then the lanes, then at most three rows.

            Nothing else may go above this. A section wanting to be here has to
            displace one of the three, and the answer is almost always no — if the
            operator has to scroll before they understand their business, the page
            has failed.
           ------------------------------------------------------------------ */}

        <BriefingBlock
          briefing={intel.briefing}
          queue={intel.queue}
          periodLabel={desc.periodTitle}
          live={desc.live}
        />

        <LaneBar queue={intel.queue} />

        <QueueSection queue={intel.queue} limit={3} hrefFor={hrefFor} />

        {/* ------------------------------------------------------------------
            BELOW THE FOLD. Reached by choosing to, never on the way to the queue.
           ------------------------------------------------------------------ */}

        {/* Money. Losses and available amounts are the same question — where is
            the money — so they are one section ranked by magnitude rather than two
            ranked by sign. Opportunities keep their impact-basis label: the amount
            is measured exposure or an arithmetic gap, never predicted upside. */}
        <OpportunitiesSection opportunities={intel.opportunityFindings} sectionLabel="Money Available" />

        <FindingList
          sectionLabel="Risks Worth Attention"
          findings={intel.risks.slice(0, 4)}
          emptyLine="No evidence-backed risk for this period."
          compact
        />

        {/* Structural fragility. The band is a business statement; its determinacy
            is the reason a LOW built from three of nine factors is not a clean
            bill of health. */}
        <MarketplaceRiskPanel risk={intel.risk} />

        {/* The narrative, promoted out of the page footer where nobody reached it. */}
        <BusinessStorySection reasoning={intel.reasoning} />

        {/* The numbers. Last, and framed as the audit trail for everything above
             rather than as information in its own right. */}
        <div className="cg-sec">
          <p className="cg-seclabel">{desc.periodTitle}</p>
          <MetricTiles
            score={report.metrics}
            compare={report.comparison}
            compareLabel={compareShort}
            coverageNote={coverageNote(report.metrics)}
          />
        </div>

        {/* The comparison period, and the biggest names, both folded into the
             numbers rather than given sections of their own. A second identical
             four-tile grid restated what the per-tile delta already carries, and
             "Top Buyer" is a leaderboard restatement of what CallGrid shows — it
             survives here because it is also how an operator navigates. */}
        <details className="cg-sec cg-numdetail">
          <summary className="cg-seclabel cg-numdetail__summary">
            Prior period, coverage and the biggest names
          </summary>
          <div className="cg-numdetail__body">
            {report.comparison ? (
              <>
                <p className="cg-seclabel">{desc.comparisonTitle}</p>
                <MetricTiles score={report.comparison} />
                {desc.comparisonNote ? <p className="cg-covnote">{desc.comparisonNote}</p> : null}
              </>
            ) : (
              <p className="cg-covnote">No comparison period is defined for this selection.</p>
            )}
            <div className="cg-tiles">
              <PerformerTile label="Top Buyer" row={report.dimensions.buyers[0] ?? null} href={`/app/admin/marketplace/buyers?${rangeQuery}`} />
              <PerformerTile label="Top Vendor" row={report.dimensions.vendors[0] ?? null} href={`/app/admin/marketplace/vendors?${rangeQuery}`} />
              <PerformerTile label="Top Source" row={report.dimensions.sources[0] ?? null} href={`/app/admin/marketplace/sources?${rangeQuery}`} />
              <PerformerTile label="Top Campaign" row={report.dimensions.campaigns[0] ?? null} href={`/app/admin/marketplace/campaigns?${rangeQuery}`} />
            </div>
          </div>
        </details>

        {/* Bids. Snapshot grain, fenced with its own window label because it does
             not honour the selected period — a provenance fact, not a caveat. */}
        <div className="cg-sec">
          <div className="cg-sechead">
            <p className="cg-seclabel">Bids · latest snapshot</p>
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
              <div className="cg-bidtiles">
                <BidTile label="Bid Opportunities" value={bidNum(opportunities.total)} />
                <BidTile label="Bids Submitted" value={bidNum(submitted.total)} />
                <BidTile label="Bids Won" value={bidNum(won.total)} />
                <BidTile label="Source Win Rate" value={winRate === null ? "—" : Math.round(winRate * 100) + "%"} />
                <BidTile label="Rejected Opportunities" value={bidNum(rejected.total)} />
                <BidTile label="Latest Bid Snapshot" value={utcDate(bid.meta.windowStart)} />
              </div>
            </>
          )}
        </div>

        {/* What Loop could not determine. One line at the foot, expandable —
             demoted from a section, but never deleted. A product that shows
             conclusions while hiding their limits is not one you can delegate to,
             and this is what makes the rest believable. */}
        <UnknownsSection
          unknowns={[...intel.unknowns, ...bidIntel.unknowns]}
          sectionLabel="What Loop could not determine about this period"
        />

        {/* Provenance. The last line on the page. */}
        <p className="q-prov">
          {desc.headerLine}
          {desc.comparisonNote ? ` · ${desc.comparisonNote}` : ""}
          {` · read ${easternClock(now)}`}
        </p>
      </div>
    </div>
  );
}

// CallGrid Intelligence — Bids: the operational intelligence workspace.
//
// NOT an engineering diagnostics page (endpoint status, sync logs, denominator
// hypotheses and rule dumps live under Administration → Diagnostics → CallGrid).
// This page answers, for an operator: where are opportunities failing, which of
// those failures are configuration behaving as configured, which might be
// preventable, what should be reviewed first, and what cannot be determined.
//
// Two invariants it exists to protect:
//   - Source grain and destination grain are separate populations. Their counts
//     are never added, and neither is the other's denominator.
//   - Bid reports carry no revenue, so no monetary impact is ever stated.
//
// Bid data is snapshot-only — the provider's endpoints accept no date range — so
// this reflects the latest synchronized snapshot and says so throughout.

import { requireCrmContext } from '../../../../../crm/crm-data';
import {
  parseCallGridRange, resolveCallGridWindow, callGridRangeQuery, describeCallGridWindow,
  sumReported, sourceWinRate,
} from '@emgloop/shared';
import { num } from '../../../_loop-os';
import { loadBidReport, bidSnapshotMatches, type BidSourceRow, type PingDestinationRow } from '../bid-report';
import { bidIntelligence } from '../intelligence-data';
import {
  DimensionShell, SummaryTiles, PerformanceTable, SnapshotNotice, ActivitySection,
  type PerfColumn, type SummaryTile,
} from '../dimension-ui';
import { FindingList, UnknownsSection } from '../intelligence-ui';

export const dynamic = 'force-dynamic';

const n = (v: number | null) => (v === null ? '—' : num(v));
const pct = (v: number | null) => (v === null ? '—' : v + '%');

const PRIORITY_CLASS: Record<string, string> = {
  CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'notable', LOW: 'informational',
};

const CATEGORY_LABEL: Record<string, string> = {
  EXPECTED_CONFIGURATION: 'Expected configuration',
  POTENTIALLY_PREVENTABLE: 'Possibly preventable',
  TRAFFIC_OR_IDENTITY: 'Traffic or identity',
  COMMERCIAL_OR_ACCEPTANCE: 'Commercial terms',
  UNKNOWN: 'Undocumented by provider',
};

export default async function BidsPage({ searchParams }: { searchParams?: Record<string, string | undefined> }) {
  const { organizationId: org } = await requireCrmContext();

  const now = new Date();
  const range = parseCallGridRange({ range: searchParams?.range, s: searchParams?.s, e: searchParams?.e });
  const window = resolveCallGridWindow(range, now);
  const rangeQuery = callGridRangeQuery(window.preset, { start: range.start, end: range.end });
  const desc = describeCallGridWindow(window, now);

  const bid = await loadBidReport(org);
  const matches = bidSnapshotMatches(bid.meta, window);
  const intel = bidIntelligence(bid, now, desc.periodTitle, matches);

  const sources = [...bid.sources].sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
  const destinations = bid.destinations;

  // Every total counts only the rows that reported the field, and discloses how
  // many did — an unreported metric is "—", never a manufactured zero.
  const opportunities = sumReported(sources, (r) => r.total);
  const submitted = sumReported(sources, (r) => r.bids);
  const won = sumReported(sources, (r) => r.won);
  const rejected = sumReported(sources, (r) => r.rejected);
  const winRate = sourceWinRate(won.total, submitted.total);

  const summary: SummaryTile[] = [
    { title: 'Bid Opportunities', value: n(opportunities.total), sub: `${opportunities.reported} of ${opportunities.of} sources reported` },
    { title: 'Bids Submitted', value: n(submitted.total), sub: `${submitted.reported} of ${submitted.of} sources reported` },
    { title: 'Bids Won', value: n(won.total) },
    { title: 'Source Win Rate', value: winRate === null ? '—' : Math.round(winRate * 100) + '%', sub: 'Won ÷ bids submitted' },
    { title: 'Rejected Opportunities', value: n(rejected.total) },
    {
      title: 'Snapshot Age',
      value: intel.snapshotAgeDays === null ? '—' : intel.snapshotAgeDays === 0 ? 'Today' : `${intel.snapshotAgeDays}d`,
      sub: `${sources.length} sources · ${destinations.length} destinations`,
    },
  ];

  const sourceCols: PerfColumn<BidSourceRow>[] = [
    { label: 'Source', render: (r) => r.name },
    { label: 'Bid Opportunities', align: 'right', render: (r) => n(r.total) },
    { label: 'Bids Submitted', align: 'right', render: (r) => n(r.bids) },
    { label: 'Bids Won', align: 'right', render: (r) => n(r.won) },
    { label: 'Win Rate', align: 'right', render: (r) => pct(r.winRatePct) },
    { label: 'Rejected', align: 'right', render: (r) => n(r.rejected) },
    { label: 'Reject Rate', align: 'right', render: (r) => (r.rejectRatePct === null ? '—' : Math.round(r.rejectRatePct) + '%') },
  ];

  const destCols: PerfColumn<PingDestinationRow>[] = [
    { label: 'Destination', render: (r) => r.name },
    { label: 'Accepted', align: 'right', render: (r) => n(r.accepted) },
    { label: 'Rate Limited', align: 'right', render: (r) => n(r.rateLimited) },
    { label: 'Timed Out', align: 'right', render: (r) => n(r.pingTimeout) },
    { label: 'API Failed', align: 'right', render: (r) => n(r.apiFailed) },
    { label: 'Below Min Revenue', align: 'right', render: (r) => n(r.minRevenue) },
    { label: 'Failed Tag Rules', align: 'right', render: (r) => n(r.failedTagRules) },
    { label: 'Invalid Number', align: 'right', render: (r) => n(r.invalidNumber) },
    { label: 'Missing Amount', align: 'right', render: (r) => n(r.missingAmount) },
    { label: 'Suppressed', align: 'right', render: (r) => n(r.suppressed) },
  ];

  return (
    <DimensionShell
      active="bids"
      title="Bids"
      subtitle="Where bid opportunities fail, which failures are expected, and what to review first."
      window={window}
      now={now}
      customStart={range.start}
      customEnd={range.end}
      rangeQuery={rangeQuery}
    >
      {!bid.ok ? (
        <div className="cg-sec"><section className="tile tile--wide"><p className="tile__line cg-muted">Bid reporting could not be loaded.</p></section></div>
      ) : !bid.hasData || !bid.meta ? (
        <div className="cg-sec"><section className="tile tile--wide"><p className="tile__line">No bid report data has been synchronized yet.</p></section></div>
      ) : (
        <>
          {/* Snapshot window, freshness and completeness */}
          <div className="cg-sec">
            <p className="cg-seclabel">Bid Reporting Window</p>
            <SnapshotNotice
              windowStart={bid.meta.windowStart}
              windowEnd={bid.meta.windowEnd}
              fetchedAt={bid.meta.fetchedAt}
              reportTimezone={bid.meta.reportTimezone}
              selectedPeriodLabel={desc.periodTitle}
              matchesSelectedPeriod={matches}
            />
          </div>

          {/* Bid Executive Intelligence */}
          <div className="cg-sec">
            <p className="cg-seclabel">Bid Executive Intelligence</p>
            <section className="tile tile--wide cg-exec" aria-label="Bid Executive Intelligence">
              <p className="cg-exec__headline">{intel.headline}</p>
            </section>
          </div>

          <SummaryTiles tiles={summary} label="Bid Summary" />

          {/* Source and destination grains, kept strictly apart */}
          <PerformanceTable
            sectionLabel="Source Bid Performance"
            columns={sourceCols}
            rows={sources}
            getKey={(r) => r.key}
            emptyLine="No source bid data in this snapshot."
          />
          <p className="cg-tablenote">
            Source-grain counts describe opportunities a traffic source presented. Win rate is wins divided by bids
            <em> submitted</em>, not by opportunities presented.
          </p>

          <PerformanceTable
            sectionLabel="Destination Outcomes"
            columns={destCols}
            rows={destinations}
            getKey={(r) => r.key}
            emptyLine="No destination ping data in this snapshot."
          />
          <p className="cg-tablenote">
            Destination-grain counts describe what happened to pings at each endpoint. These are a different population
            from the source table above and are never added to it. Accepted pings are not a total-pings denominator —
            CallGrid does not report pings attempted per destination, so no acceptance rate is shown.
          </p>

          {/* Rejection intelligence, classified */}
          <FindingList
            sectionLabel="Rejection Intelligence"
            findings={intel.findings}
            emptyLine="No rejections or destination failures were reported in this snapshot."
          />

          {/* Review Priority Queue */}
          <div className="cg-sec">
            <p className="cg-seclabel">Review Priority Queue</p>
            {intel.priorityQueue.length === 0 ? (
              <section className="tile tile--wide"><p className="tile__line">Nothing in this snapshot needs review.</p></section>
            ) : (
              <div className="adm-tablewrap">
                <table className="adm-table dim-table">
                  <thead>
                    <tr>
                      <th>Priority</th>
                      <th>Issue</th>
                      <th>Source or Destination</th>
                      <th>Category</th>
                      <th className="dim-num">Count</th>
                      <th className="dim-num">Share of grain</th>
                      <th>Why it matters</th>
                      <th>Recommended review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {intel.priorityQueue.map((q) => (
                      <tr className="dim-row" key={q.id}>
                        <td><span className={'cg-sev cg-sev--' + (PRIORITY_CLASS[q.priority] ?? 'informational')}>{q.priority}</span></td>
                        <td>{q.issue}</td>
                        <td>{q.entityLabel}</td>
                        <td>{CATEGORY_LABEL[q.category] ?? q.category}</td>
                        <td className="dim-num">{num(q.count)}</td>
                        <td className="dim-num">{q.ratePct === null ? '—' : q.ratePct + '%'}</td>
                        <td className="cg-qcell">{q.whyItMatters}</td>
                        <td className="cg-qcell">{q.recommendedReview}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="cg-tablenote">
              Priority sets review ORDER only. It is not a value, a cost, or an amount — the bid reports carry no
              revenue, so no monetary impact can be calculated from them. Share is measured within each outcome&rsquo;s
              own grain.
            </p>
          </div>

          {/* What Loop cannot determine */}
          <UnknownsSection unknowns={intel.unknowns} />

          {/* Change vs a prior snapshot — only when one genuinely exists */}
          {intel.snapshotChanges.length > 0 ? (
            <FindingList
              sectionLabel="Recent Bid Changes"
              findings={intel.snapshotChanges}
              emptyLine=""
            />
          ) : (
            <ActivitySection
              sectionLabel="Recent Bid Changes"
              items={[]}
              emptyLine="Only one bid snapshot is stored. A change over time needs two, so no bid trend is shown."
            />
          )}
        </>
      )}
    </DimensionShell>
  );
}

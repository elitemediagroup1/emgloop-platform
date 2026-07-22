// CallGrid Intelligence — Sources.
//
// HYBRID by provenance (verified per metric, never blended silently):
//   • Source counts (Total / Active Sources) come from the canonical call
//     projection and HONOR the selected calendar range.
//   • Bid performance (opportunities / submitted / won / win rate / rejections)
//     is snapshot-only — the provider's report endpoints accept no arbitrary
//     range — so it reflects the LATEST synchronized snapshot and says so. It is
//     never filtered by the calendar range and never fabricated for history.

import { requireCrmContext } from '../../../../../crm/crm-data';
import { parseCallGridRange, resolveCallGridWindow, callGridRangeQuery } from '@emgloop/shared';
import { num } from '../../../_loop-os';
import { loadCallGridReport } from '../callgrid-report';
import { loadBidReport, sumBid, type BidSourceRow } from '../bid-report';
import {
  DimensionShell, SummaryTiles, PerformanceTable, SnapshotNotice, ActivitySection,
  type PerfColumn, type SummaryTile,
} from '../dimension-ui';

export const dynamic = 'force-dynamic';

const bidNum = (n: number | null) => (n === null ? '—' : num(n));
const pct = (n: number | null) => (n === null ? '—' : n + '%');

// Source-side rejection categories (verified provider fields), with plain-language
// operational explanations. Closed/paused may be intentional configuration.
const REJECTIONS: { key: keyof BidSourceRow['rejections']; label: string; note: string }[] = [
  { key: 'failedAcceptance', label: 'Failed Acceptance', note: 'The bid did not meet a target’s acceptance criteria.' },
  { key: 'duplicateBids', label: 'Duplicate Bids', note: 'A duplicate bid was detected for the same opportunity.' },
  { key: 'closed', label: 'Closed Target', note: 'The target was closed — often intentional configuration.' },
  { key: 'paused', label: 'Paused Target', note: 'The target was paused — often intentional configuration.' },
  { key: 'failedTagRules', label: 'Failed Tag Rules', note: 'The bid did not satisfy a configured tag rule.' },
  { key: 'duplicateCaller', label: 'Duplicate Caller', note: 'The caller was seen already within the provider’s window.' },
  { key: 'callerIdRejected', label: 'Caller ID Rejected', note: 'The caller ID was rejected by a target rule.' },
];

export default async function SourcesPage({ searchParams }: { searchParams?: Record<string, string | undefined> }) {
  const { organizationId: org } = await requireCrmContext();

  const range = parseCallGridRange({ range: searchParams?.range, s: searchParams?.s, e: searchParams?.e });
  const window = resolveCallGridWindow(range, new Date());
  const rangeQuery = callGridRangeQuery(window.preset, { start: range.start, end: range.end });

  const [callReport, bidReport] = await Promise.all([loadCallGridReport(org, window), loadBidReport(org)]);

  // Range-honoring source counts (call projection).
  const callSources = callReport.dimensions.sources;
  const totalSources = callSources.length;
  const activeSources = callSources.filter((r) => r.calls > 0 || r.monetized > 0 || r.revenueCents > 0).length;
  const periodTiles: SummaryTile[] = [
    { title: 'Total Sources', value: callReport.ok ? num(totalSources) : 'Unavailable' },
    { title: 'Active Sources', value: callReport.ok ? num(activeSources) : 'Unavailable', sub: 'With call activity this period' },
  ];

  // Snapshot-only bid metrics (latest synchronized window).
  const bidSources = [...bidReport.sources].sort((a, b) => (b.won ?? -1) - (a.won ?? -1));
  const totalOpportunities = sumBid(bidSources, (r) => r.total);
  const bidsSubmitted = sumBid(bidSources, (r) => r.bids);
  const bidsWon = sumBid(bidSources, (r) => r.won);
  const winRate = bidsSubmitted && bidsSubmitted > 0 && bidsWon !== null ? Math.round((bidsWon / bidsSubmitted) * 100) : null;
  const bidTiles: SummaryTile[] = [
    { title: 'Total Bid Opportunities', value: bidNum(totalOpportunities) },
    { title: 'Bids Submitted', value: bidNum(bidsSubmitted) },
    { title: 'Bids Won', value: bidNum(bidsWon) },
    { title: 'Source Win Rate', value: pct(winRate) },
  ];

  const columns: PerfColumn<BidSourceRow>[] = [
    { label: 'Source', render: (r) => r.name },
    { label: 'Bid Opportunities', align: 'right', render: (r) => bidNum(r.total) },
    { label: 'Bids Submitted', align: 'right', render: (r) => bidNum(r.bids) },
    { label: 'Bids Won', align: 'right', render: (r) => bidNum(r.won) },
    { label: 'Win Rate', align: 'right', render: (r) => pct(r.winRatePct) },
    { label: 'Rejected', align: 'right', render: (r) => bidNum(r.rejected) },
    { label: 'Reject Rate', align: 'right', render: (r) => (r.rejectRatePct === null ? '—' : Math.round(r.rejectRatePct) + '%') },
  ];

  const rejectionTotals = REJECTIONS
    .map((rj) => ({ ...rj, count: sumBid(bidSources, (r) => r.rejections[rj.key]) }))
    .filter((rj) => rj.count !== null);

  return (
    <DimensionShell
      active="sources"
      title="Sources"
      subtitle="Traffic-source performance for the selected period."
      window={window}
      customStart={range.start}
      customEnd={range.end}
      rangeQuery={rangeQuery}
    >
      <SummaryTiles tiles={periodTiles} />

      {!bidReport.ok ? (
        <div className="cg-sec">
          <section className="tile tile--wide"><p className="tile__line cg-muted">Bid reporting could not be loaded.</p></section>
        </div>
      ) : !bidReport.hasData || !bidReport.meta ? (
        <div className="cg-sec">
          <section className="tile tile--wide"><p className="tile__line">No source bid data has been synchronized yet.</p></section>
        </div>
      ) : (
        <>
          <SnapshotNotice
            windowStart={bidReport.meta.windowStart}
            windowEnd={bidReport.meta.windowEnd}
            fetchedAt={bidReport.meta.fetchedAt}
            reportTimezone={bidReport.meta.reportTimezone}
          />
          <div className="cg-sec">
            <p className="cg-seclabel">Bid Performance · latest snapshot</p>
            <div className="dim-tiles">
              {bidTiles.map((t) => (
                <section className="tile" aria-label={t.title} key={t.title}>
                  <div className="tile__head"><span className="tile__title">{t.title}</span></div>
                  <div className="tile__num">{t.value}</div>
                </section>
              ))}
            </div>
          </div>

          <PerformanceTable
            sectionLabel="Source Bid Performance"
            columns={columns}
            rows={bidSources}
            getKey={(r) => r.key}
            emptyLine="No source bid data for this snapshot."
          />

          {rejectionTotals.length > 0 ? (
            <div className="cg-sec">
              <p className="cg-seclabel">Rejection Reasons</p>
              <div className="cg-reasons">
                {rejectionTotals.map((rj) => (
                  <div className="cg-reason" key={rj.key}>
                    <div className="cg-reason__head">
                      <span className="cg-reason__label">{rj.label}</span>
                      <span className="cg-reason__count">{num(rj.count!)}</span>
                    </div>
                    <p className="cg-reason__note">{rj.note}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}

      <ActivitySection items={[]} emptyLine="No durable source-level CallGrid events for this period." />
    </DimensionShell>
  );
}

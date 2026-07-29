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
import {
  parseCallGridRange, resolveCallGridWindow, callGridRangeQuery, describeCallGridWindow,
  sumReported, sourceWinRate, rejectionClassification,
} from '@emgloop/shared';
import { num } from '../../../_loop-os';
import { loadCallGridReport } from '../callgrid-report';
import { loadBidReport, bidSnapshotMatches, type BidSourceRow } from '../bid-report';
import { summarizeRows, revPerBillable } from '../dimension-metrics';
import { dimensionIntelligence, bidIntelligence } from '../intelligence-data';
import {
  DimensionShell, SummaryTiles, PerformanceTable, SnapshotNotice, ActivitySection,
  type PerfColumn, type SummaryTile,
} from '../dimension-ui';
import { FindingList, UnknownsSection, ContributionTable } from '../intelligence-ui';

export const dynamic = 'force-dynamic';

const bidNum = (n: number | null) => (n === null ? '—' : num(n));
const pct = (n: number | null) => (n === null ? '—' : n + '%');
/** Money that never dresses an unknown as $0. */
function money(cents: number | null): string {
  if (cents === null) return 'Unknown';
  const sign = cents < 0 ? '-' : '';
  return sign + '$' + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
}

// Source-side rejection categories. The operational meaning of each comes from
// the shared classification registry — this page does not author its own copy,
// so "closed target is expected configuration" means the same thing everywhere.
const REJECTION_KEYS: { key: keyof BidSourceRow['rejections']; classification: string }[] = [
  { key: 'failedAcceptance', classification: 'failedAcceptance' },
  { key: 'duplicateBids', classification: 'duplicateBids' },
  { key: 'closed', classification: 'closed' },
  { key: 'paused', classification: 'paused' },
  { key: 'failedTagRules', classification: 'failedTagRules' },
  { key: 'duplicateCaller', classification: 'duplicateCaller' },
  { key: 'callerIdRejected', classification: 'callerIdRejected' },
];

export default async function SourcesPage({ searchParams }: { searchParams?: Record<string, string | undefined> }) {
  const { organizationId: org } = await requireCrmContext();

  const now = new Date();
  const range = parseCallGridRange({ range: searchParams?.range, s: searchParams?.s, e: searchParams?.e });
  const window = resolveCallGridWindow(range, now);
  const rangeQuery = callGridRangeQuery(window.preset, { start: range.start, end: range.end });
  const desc = describeCallGridWindow(window, now);

  const [callReport, bidReport] = await Promise.all([loadCallGridReport(org, window), loadBidReport(org)]);

  const matches = bidSnapshotMatches(bidReport.meta, window);
  const callIntel = dimensionIntelligence(callReport, 'sources', now);
  const bidIntel = bidIntelligence(bidReport, now, desc.periodTitle, matches);

  // Range-honoring source CALL performance (call projection).
  const callSources = callReport.dimensions.sources;
  const s = summarizeRows(callSources);
  const periodTiles: SummaryTile[] = [
    { title: 'Sources Observed', value: callReport.ok ? num(s.observed) : 'Unavailable', sub: 'With calls this period' },
    { title: 'Active Sources', value: callReport.ok ? num(s.active) : 'Unavailable', sub: 'Produced revenue or a billable call' },
    { title: 'Revenue', value: callReport.ok ? money(s.revenueCents) : 'Unavailable' },
    { title: 'Billable Calls', value: callReport.ok ? num(s.billableCalls) : 'Unavailable' },
    { title: 'Total Calls', value: callReport.ok ? num(s.totalCalls) : 'Unavailable' },
    { title: 'Avg Revenue / Billable Call', value: callReport.ok ? money(s.avgRevPerBillableCents) : 'Unavailable' },
  ];

  // Snapshot-only bid metrics (latest synchronized window). Sums count only the
  // sources that reported each field — absence is never totalled as zero.
  const bidSources = [...bidReport.sources].sort((a, b) => (b.won ?? -1) - (a.won ?? -1));
  const totalOpportunities = sumReported(bidSources, (r) => r.total);
  const bidsSubmitted = sumReported(bidSources, (r) => r.bids);
  const bidsWon = sumReported(bidSources, (r) => r.won);
  const winRate = sourceWinRate(bidsWon.total, bidsSubmitted.total);
  const bidTiles: SummaryTile[] = [
    { title: 'Total Bid Opportunities', value: bidNum(totalOpportunities.total) },
    { title: 'Bids Submitted', value: bidNum(bidsSubmitted.total) },
    { title: 'Bids Won', value: bidNum(bidsWon.total) },
    { title: 'Source Win Rate', value: winRate === null ? '—' : Math.round(winRate * 100) + '%', sub: 'Won ÷ bids submitted' },
  ];

  // Source CALL performance table (honors the selected range).
  const callColumns: PerfColumn<(typeof callSources)[number]>[] = [
    { label: 'Source', render: (r) => r.label },
    { label: 'Revenue', align: 'right', render: (r) => money(r.revenueCents) },
    { label: 'Billable', align: 'right', render: (r) => num(r.monetized) },
    { label: 'Total Calls', align: 'right', render: (r) => num(r.calls) },
    { label: 'Rev / Billable', align: 'right', render: (r) => money(revPerBillable(r.revenueCents, r.monetized)) },
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

  const rejectionTotals = REJECTION_KEYS
    .map((rj) => {
      const cls = rejectionClassification(rj.classification);
      const sum = sumReported(bidSources, (r) => r.rejections[rj.key]);
      return { key: rj.key, cls, count: sum.total, reported: sum.reported, of: sum.of };
    })
    .filter((rj) => rj.count !== null && rj.cls !== null);

  return (
    <DimensionShell
      active="sources"
      title="Sources"
      subtitle="Traffic-source performance for the selected period."
      window={window}
      now={now}
      customStart={range.start}
      customEnd={range.end}
      rangeQuery={rangeQuery}
    >
      <SummaryTiles tiles={periodTiles} label={`Source Call Performance · ${desc.periodTitle}`} />

      <FindingList
        sectionLabel="Source Call Intelligence"
        findings={callIntel.findings}
        emptyLine={
          callReport.comparison
            ? 'No source movement in this period clears the significance thresholds.'
            : 'No comparison period is defined for this selection, so no change can be analysed.'
        }
      />

      <PerformanceTable
        sectionLabel={`Source Call Performance · ${desc.periodTitle}`}
        columns={callColumns}
        rows={callSources}
        getKey={(r) => r.key}
        emptyLine="No source call activity for this period."
      />

      <ContributionTable contributions={callIntel.contributions} entityLabel="Source" money={money} />

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
            selectedPeriodLabel={desc.periodTitle}
            matchesSelectedPeriod={bidSnapshotMatches(bidReport.meta, window)}
          />
          <div className="cg-sec">
            <p className="cg-seclabel">Source Bid Summary · latest snapshot (does not honor the selected period)</p>
            <div className="dim-tiles">
              {bidTiles.map((t) => (
                <section className="tile" aria-label={t.title} key={t.title}>
                  <div className="tile__head"><span className="tile__title">{t.title}</span></div>
                  <div className="tile__num">{t.value}</div>
                </section>
              ))}
            </div>
          </div>

          <FindingList
            sectionLabel="Source Bid Intelligence"
            findings={bidIntel.findings.filter((f) => f.findingType !== 'BID_DESTINATION')}
            emptyLine="No source-side bid rejections were reported in this snapshot."
          />

          <PerformanceTable
            sectionLabel="Source Bid Performance"
            columns={columns}
            rows={bidSources}
            getKey={(r) => r.key}
            emptyLine="No source bid data for this snapshot."
          />
          <p className="cg-tablenote">
            Win rate is wins divided by bids <em>submitted</em>, not by opportunities presented. These are source-grain
            counts and are never combined with destination-grain ping outcomes.
          </p>

          {rejectionTotals.length > 0 ? (
            <div className="cg-sec">
              <p className="cg-seclabel">Rejection Analysis</p>
              <div className="cg-reasons">
                {rejectionTotals.map((rj) => (
                  <div className="cg-reason" key={rj.key}>
                    <div className="cg-reason__head">
                      <span className="cg-reason__label">{rj.cls!.displayName}</span>
                      <span className="cg-reason__count">{num(rj.count!)}</span>
                    </div>
                    <p className="cg-reason__note">{rj.cls!.operationalMeaning}</p>
                    <p className="cg-reason__meta">
                      {rj.cls!.preventability === 'EXPECTED'
                        ? 'Expected configuration'
                        : rj.cls!.preventability === 'POSSIBLY_PREVENTABLE'
                          ? 'Possibly preventable'
                          : 'Not determinable from the report'}
                      {' · '}Reported by {rj.reported} of {rj.of} sources
                    </p>
                  </div>
                ))}
              </div>
              <p className="cg-tablenote">
                These are observed COUNTS. A source with the highest count is not necessarily the worst performer —
                without a proven denominator per category, a count is not a rate.
              </p>
            </div>
          ) : null}
        </>
      )}

      <UnknownsSection unknowns={[...callIntel.unknowns, ...bidIntel.unknowns]} />

      <ActivitySection items={[]} emptyLine="No durable source-level CallGrid events for this period." />
    </DimensionShell>
  );
}

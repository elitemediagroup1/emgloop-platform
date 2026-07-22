// CallGrid Intelligence — Bids (the operational workspace).
//
// NOT an engineering diagnostics page (that moved to Administration → Diagnostics
// → CallGrid). This is the operator's view of bid opportunities, wins and
// rejection patterns. Bid/ping data is snapshot-based (the provider's report
// endpoints accept no arbitrary range), so this reflects the LATEST synchronized
// snapshot and says so — it never fabricates historical bid reporting and never
// pretends to honor the calendar range. Source and destination grains are kept
// strictly separate; their counts are never added together.

import { requireCrmContext } from '../../../../../crm/crm-data';
import { parseCallGridRange, resolveCallGridWindow, callGridRangeQuery } from '@emgloop/shared';
import { num } from '../../../_loop-os';
import { loadBidReport, sumBid, type BidSourceRow, type PingDestinationRow } from '../bid-report';
import {
  DimensionShell, SummaryTiles, PerformanceTable, SnapshotNotice, ActivitySection,
  type PerfColumn, type SummaryTile,
} from '../dimension-ui';

export const dynamic = 'force-dynamic';

const n = (v: number | null) => (v === null ? '—' : num(v));
const pct = (v: number | null) => (v === null ? '—' : v + '%');

const SRC_REASONS: { key: keyof BidSourceRow['rejections']; label: string; note: string }[] = [
  { key: 'failedAcceptance', label: 'Failed Acceptance', note: 'The bid did not meet a target’s acceptance criteria.' },
  { key: 'duplicateBids', label: 'Duplicate Bids', note: 'A duplicate bid was detected for the same opportunity.' },
  { key: 'closed', label: 'Closed Target', note: 'The target was closed — often intentional configuration.' },
  { key: 'paused', label: 'Paused Target', note: 'The target was paused — often intentional configuration.' },
  { key: 'failedTagRules', label: 'Failed Tag Rules', note: 'The bid did not satisfy a configured tag rule.' },
  { key: 'duplicateCaller', label: 'Duplicate Caller', note: 'The caller was already seen within the provider’s window.' },
  { key: 'callerIdRejected', label: 'Caller ID Rejected', note: 'The caller ID was rejected by a target rule.' },
];

const DEST_REASONS: { key: keyof PingDestinationRow; label: string; note: string }[] = [
  { key: 'rateLimited', label: 'Rate Limited', note: 'The destination’s configured throughput limit was reached.' },
  { key: 'pingTimeout', label: 'Timed Out', note: 'The destination did not respond in time.' },
  { key: 'minRevenue', label: 'Below Minimum Revenue', note: 'The opportunity was below the destination’s minimum-revenue floor.' },
  { key: 'failedTagRules', label: 'Failed Tag Rules', note: 'The ping did not satisfy a configured tag rule.' },
];

function otherDestFailures(d: PingDestinationRow): number | null {
  return sumBid([d], (r) => r.apiFailed) === null && sumBid([d], (r) => r.suppressed) === null && sumBid([d], (r) => r.failedAcceptance) === null
    ? null
    : (d.apiFailed ?? 0) + (d.suppressed ?? 0) + (d.failedAcceptance ?? 0);
}

export default async function BidsPage({ searchParams }: { searchParams?: Record<string, string | undefined> }) {
  const { organizationId: org } = await requireCrmContext();

  const range = parseCallGridRange({ range: searchParams?.range, s: searchParams?.s, e: searchParams?.e });
  const window = resolveCallGridWindow(range, new Date());
  const rangeQuery = callGridRangeQuery(window.preset, { start: range.start, end: range.end });

  const bid = await loadBidReport(org);
  const sources = [...bid.sources].sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
  const destinations = bid.destinations;

  const opportunities = sumBid(sources, (r) => r.total);
  const submitted = sumBid(sources, (r) => r.bids);
  const won = sumBid(sources, (r) => r.won);
  const rejected = sumBid(sources, (r) => r.rejected);
  const winRate = submitted && submitted > 0 && won !== null ? Math.round((won / submitted) * 100) : null;

  const summary: SummaryTile[] = [
    { title: 'Bid Opportunities', value: n(opportunities) },
    { title: 'Bids Submitted', value: n(submitted) },
    { title: 'Bids Won', value: n(won) },
    { title: 'Source Win Rate', value: pct(winRate) },
    { title: 'Rejected Opportunities', value: n(rejected) },
    { title: 'Reporting Coverage', value: `${sources.length} sources · ${destinations.length} destinations` },
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
    { label: 'Below Min Revenue', align: 'right', render: (r) => n(r.minRevenue) },
    { label: 'Failed Tag Rules', align: 'right', render: (r) => n(r.failedTagRules) },
    { label: 'Other Verified Failures', align: 'right', render: (r) => n(otherDestFailures(r)) },
  ];

  const srcReasonTotals = SRC_REASONS.map((r) => ({ ...r, count: sumBid(sources, (s) => s.rejections[r.key]) })).filter((r) => r.count !== null);
  const destReasonTotals = DEST_REASONS.map((r) => ({ ...r, count: sumBid(destinations, (d) => d[r.key] as number | null) })).filter((r) => r.count !== null);

  // Operational watch list — evidence-backed only; no invented prices/revenue.
  // Sentinel -1 sorts nulls last (never displayed); thresholds check null explicitly
  // — a measurement is never coerced to a real-looking zero.
  const watch: { title: string; entity: string; value: string; note: string }[] = [];
  for (const d of [...destinations].sort((a, b) => (b.rateLimited ?? -1) - (a.rateLimited ?? -1)).slice(0, 2)) {
    if (d.rateLimited !== null && d.rateLimited > 0) watch.push({ title: 'High rate-limited volume', entity: d.name, value: `${num(d.rateLimited)} rate-limited`, note: 'The destination’s throughput limit is being hit. Review its rate limit or routing weight.' });
  }
  for (const d of [...destinations].sort((a, b) => (b.pingTimeout ?? -1) - (a.pingTimeout ?? -1)).slice(0, 1)) {
    if (d.pingTimeout !== null && d.pingTimeout > 0) watch.push({ title: 'Unusual timeout volume', entity: d.name, value: `${num(d.pingTimeout)} timed out`, note: 'The destination is timing out. Review its endpoint responsiveness.' });
  }
  for (const s of [...sources].sort((a, b) => (b.rejections.duplicateBids ?? -1) - (a.rejections.duplicateBids ?? -1)).slice(0, 1)) {
    const dup = s.rejections.duplicateBids;
    if (dup !== null && dup > 0) watch.push({ title: 'Duplicate-bid volume', entity: s.name, value: `${num(dup)} duplicate bids`, note: 'Duplicate bids are being submitted for this source. Review its bidding configuration.' });
  }
  for (const s of sources) {
    if (s.winRatePct !== null && s.bids !== null && s.bids >= 10 && s.winRatePct < 10) watch.push({ title: 'Low source win rate', entity: s.name, value: `${s.winRatePct}% of ${num(s.bids)} bids`, note: 'This source wins few of the bids it submits. Review targeting and floor prices.' });
  }

  return (
    <DimensionShell
      active="bids"
      title="Bids"
      subtitle="Bid opportunities, wins, and rejection patterns for the selected period."
      window={window}
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
          <SnapshotNotice windowStart={bid.meta.windowStart} windowEnd={bid.meta.windowEnd} fetchedAt={bid.meta.fetchedAt} reportTimezone={bid.meta.reportTimezone} />
          <SummaryTiles tiles={summary} />

          <PerformanceTable sectionLabel="Source Bid Performance" columns={sourceCols} rows={sources} getKey={(r) => r.key} emptyLine="No source bid data for this snapshot." />
          <PerformanceTable sectionLabel="Destination Outcomes" columns={destCols} rows={destinations} getKey={(r) => r.key} emptyLine="No destination ping data for this snapshot." />

          <div className="cg-sec">
            <p className="cg-seclabel">Why Opportunities Did Not Progress</p>
            <div className="cg-reasongroups">
              <div>
                <p className="cg-reasongroup__title">Source-Side Rejections</p>
                <div className="cg-reasons">
                  {srcReasonTotals.length === 0 ? <p className="tile__line cg-muted">None reported.</p> : srcReasonTotals.map((r) => (
                    <div className="cg-reason" key={r.key}><div className="cg-reason__head"><span className="cg-reason__label">{r.label}</span><span className="cg-reason__count">{num(r.count!)}</span></div><p className="cg-reason__note">{r.note}</p></div>
                  ))}
                </div>
              </div>
              <div>
                <p className="cg-reasongroup__title">Destination-Side Outcomes</p>
                <div className="cg-reasons">
                  {destReasonTotals.length === 0 ? <p className="tile__line cg-muted">None reported.</p> : destReasonTotals.map((r) => (
                    <div className="cg-reason" key={String(r.key)}><div className="cg-reason__head"><span className="cg-reason__label">{r.label}</span><span className="cg-reason__count">{num(r.count!)}</span></div><p className="cg-reason__note">{r.note}</p></div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="cg-sec">
            <p className="cg-seclabel">Operational Watch List</p>
            {watch.length === 0 ? (
              <section className="tile tile--wide"><p className="tile__line">No bid operational issues detected for this snapshot.</p></section>
            ) : (
              <ul className="cg-watch__list">
                {watch.map((w, i) => (
                  <li className="cg-watch__item cg-watch__item--stack" key={i}>
                    <span className="cg-watch__title">{w.title} — {w.entity}</span>
                    <span className="cg-watch__val">{w.value}</span>
                    <span className="cg-watch__text">{w.note}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <ActivitySection
            sectionLabel="Recent Bid Activity"
            items={[]}
            emptyLine="Bid changes require two synchronized snapshots to derive; only the latest snapshot is available."
          />
        </>
      )}
    </DimensionShell>
  );
}

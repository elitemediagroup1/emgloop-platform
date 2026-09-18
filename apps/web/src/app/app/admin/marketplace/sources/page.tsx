// CallGrid Intelligence — Sources.
//
// SUPPLY, AS FAR AS CALLGRID LETS US FOLLOW IT: bid opportunities → bids → won from
// the provider's bid snapshot, beside calls → billable → revenue → net profit from
// the calls, per source. The two are DIFFERENT GRAINS and stay fenced: the bid
// snapshot is one provider day in UTC and does not follow the selected period; the
// calls do. They are shown side by side, joined on CallGrid's own source id, and
// never added together. A source with bids and no calls in the period is listed --
// that is exactly the row an operator needs to see.
//
// The source intelligence the page carried before (call intelligence, bid
// intelligence, contribution, rejection analysis, unknowns) is kept, behind one
// disclosure.

import Link from 'next/link';
import {
  sumReported, sourceWinRate, rejectionClassification,
} from '@emgloop/shared';
import { loadCommandContext, withQuery, type SearchParams } from '../command-data';
import { CommandShell, Card, money, count, pct } from '../command-ui';
import { loadBidReport, bidSnapshotMatches, type BidSourceRow } from '../bid-report';
import { trend } from '../dimension-metrics';
import { dimensionIntelligence, bidIntelligence } from '../intelligence-data';
import { SnapshotNotice, TrendCell } from '../dimension-ui';
import { FindingList, UnknownsSection, ContributionTable } from '../intelligence-ui';
import type { CallGridDimRow } from '../callgrid-report';
import { requireWorkspacePermission } from '../../../../../workspaces/guard';

export const dynamic = 'force-dynamic';

const BASE = '/app/admin/marketplace';
const REJECTION_KEYS: (keyof BidSourceRow['rejections'])[] = [
  'failedAcceptance', 'duplicateBids', 'closed', 'paused', 'failedTagRules', 'duplicateCaller', 'callerIdRejected',
];

interface SourceLine {
  key: string;
  label: string;
  call: CallGridDimRow | null;
  bid: BidSourceRow | null;
}

export default async function SourcesPage({ searchParams }: { searchParams?: SearchParams }) {
  const session = await requireWorkspacePermission('ADMIN', 'intelligence', 'view');
  const ctx = await loadCommandContext(session, searchParams);
  const { report, now, window, query } = ctx;
  const bid = await loadBidReport(ctx.organizationId);
  const matches = bidSnapshotMatches(bid.meta, window);
  const callIntel = dimensionIntelligence(report, 'sources', now);
  const bidIntel = bidIntelligence(bid, now, ctx.desc.periodTitle, matches);

  // One line per source: joined on CallGrid's source id (the call row's key), and on
  // name only when the snapshot carried no id match.
  const lines = new Map<string, SourceLine>();
  for (const r of report.dimensions.sources) lines.set(r.key, { key: r.key, label: r.label, call: r, bid: null });
  for (const b of bid.sources) {
    const byId = lines.get(b.key.toLowerCase());
    const byName = byId ? null : [...lines.values()].find((l) => l.label.toLowerCase() === b.name.toLowerCase() && l.bid === null);
    const target = byId ?? byName;
    if (target) target.bid = b;
    else lines.set(b.key.toLowerCase(), { key: b.key.toLowerCase(), label: b.name, call: null, bid: b });
  }
  const rows = [...lines.values()].sort((a, b) =>
    (b.call?.revenueCents ?? -1) - (a.call?.revenueCents ?? -1) || (b.bid?.total ?? -1) - (a.bid?.total ?? -1),
  );
  const prior = report.comparisonByKey.sources;

  const bidOnly = rows.filter((r) => r.bid && (r.bid.bids ?? 0) > 0 && !r.call).length;
  const opportunities = sumReported(bid.sources, (r) => r.total);
  const submitted = sumReported(bid.sources, (r) => r.bids);
  const won = sumReported(bid.sources, (r) => r.won);
  const winRate = sourceWinRate(won.total, submitted.total);
  const rejectionTotals = REJECTION_KEYS
    .map((key) => ({ key, cls: rejectionClassification(key), sum: sumReported(bid.sources, (r) => r.rejections[key]) }))
    .filter((x) => x.cls && x.sum.total !== null && x.sum.total > 0)
    .sort((a, b) => b.sum.total! - a.sum.total!);

  return (
    <CommandShell ctx={ctx} active="sources" path={`${BASE}/sources`}>
      <div className="cgx-strip">
        <div className="cgx-strip__item"><span className="cgx-strip__n">{count(report.dimensions.sources.length)}</span><span className="cgx-strip__l">sources with calls in {ctx.selection.label}</span></div>
        <div className="cgx-strip__item"><span className="cgx-strip__n">{opportunities.total === null ? '—' : count(opportunities.total)}</span><span className="cgx-strip__l">bid opportunities in the snapshot</span></div>
        <div className="cgx-strip__item"><span className="cgx-strip__n">{winRate === null ? '—' : `${Math.round(winRate * 100)}%`}</span><span className="cgx-strip__l">won of bids submitted</span></div>
        <div className="cgx-strip__item"><span className="cgx-strip__n">{count(bidOnly)}</span><span className="cgx-strip__l">sources bidding with no calls this period</span></div>
      </div>

      {bid.meta ? (
        <SnapshotNotice
          windowStart={bid.meta.windowStart}
          windowEnd={bid.meta.windowEnd}
          fetchedAt={bid.meta.fetchedAt}
          reportTimezone={bid.meta.reportTimezone}
          selectedPeriodLabel={ctx.desc.periodTitle}
          matchesSelectedPeriod={matches}
        />
      ) : (
        <p className="cgx-note">{bid.ok ? 'No bid snapshot has been synchronized yet, so only call figures are shown.' : 'Bid reporting could not be loaded, so only call figures are shown.'}</p>
      )}

      <Card title={`Sources · ${ctx.selection.label}`} wide>
        {rows.length === 0 ? (
          <p className="cgx-empty">No source activity in this period or the bid snapshot.</p>
        ) : (
          <div className="adm-tablewrap">
            <table className="adm-table dim-table cgx-table">
              <thead>
                <tr>
                  <th rowSpan={2}>Source</th>
                  <th colSpan={4} className="cgx-th-group">Bid snapshot · provider day, UTC</th>
                  <th colSpan={6} className="cgx-th-group">Calls · {ctx.selection.label}</th>
                </tr>
                <tr>
                  <th className="dim-num">Opportunities</th><th className="dim-num">Bids</th><th className="dim-num">Won</th><th className="dim-num">Win rate</th>
                  <th className="dim-num">Calls</th><th className="dim-num">Billable</th><th className="dim-num">Rate</th><th className="dim-num">Revenue</th><th className="dim-num">Net profit</th><th className="dim-num">vs prior</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="dim-row">
                    <td><Link href={withQuery(`${BASE}/sources/${encodeURIComponent(r.key)}`, query)} className="dim-rowlink">{r.label}</Link></td>
                    <td className="dim-num">{r.bid ? (r.bid.total === null ? '—' : count(r.bid.total)) : '—'}</td>
                    <td className="dim-num">{r.bid ? (r.bid.bids === null ? '—' : count(r.bid.bids)) : '—'}</td>
                    <td className="dim-num">{r.bid ? (r.bid.won === null ? '—' : count(r.bid.won)) : '—'}</td>
                    <td className="dim-num">{r.bid ? pct(r.bid.winRatePct) : '—'}</td>
                    {/* No call rows for a source in a period Loop read: a real zero. */}
                    <td className="dim-num">{!report.ok ? '—' : r.call ? count(r.call.calls) : '0'}</td>
                    <td className="dim-num">{r.call ? count(r.call.monetized) : report.ok ? '0' : '—'}</td>
                    <td className="dim-num">{r.call && r.call.calls > 0 ? pct((r.call.monetized / r.call.calls) * 100) : '—'}</td>
                    <td className="dim-num">{r.call ? money(r.call.revenueCents) : '—'}</td>
                    <td className="dim-num">{r.call ? money(r.call.marginCents) : '—'}</td>
                    <td className="dim-num">{r.call ? <TrendCell t={trend(r.call.revenueCents, prior.get(r.key)?.revenueCents ?? null)} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="cgx-foot">
          “—” means not reported, never zero. Win rate is won ÷ bids submitted. The two halves of each row are different grains and are never added; open a source to see what CallGrid reports about why its bids did not become calls.
        </p>
      </Card>

      {rejectionTotals.length > 0 ? (
        <Card title="Why bids were rejected — as CallGrid reported it" wide>
          <div className="cg-reasons">
            {rejectionTotals.map((rj) => (
              <div className="cg-reason" key={rj.key}>
                <div className="cg-reason__head">
                  <span className="cg-reason__label">{rj.cls!.displayName}</span>
                  <span className="cg-reason__count">{count(rj.sum.total)}</span>
                </div>
                <p className="cg-reason__note">{rj.cls!.operationalMeaning}</p>
                <p className="cg-reason__meta">Reported by {rj.sum.reported} of {rj.sum.of} sources</p>
              </div>
            ))}
          </div>
          <p className="cgx-foot">Counts, not rates: without a proven denominator per category, the source with the highest count is not necessarily the worst.</p>
        </Card>
      ) : null}

      <details className="cgx-more-section">
        <summary className="cgx-more-section__summary">Source intelligence — the full analysis</summary>
        <FindingList
          sectionLabel="Source Call Intelligence"
          findings={callIntel.findings}
          emptyLine={report.comparison ? 'No source movement in this period clears the significance thresholds.' : 'No comparison period is defined for this selection.'}
        />
        <ContributionTable contributions={callIntel.contributions} entityLabel="Source" money={money} />
        <FindingList
          sectionLabel="Source Bid Intelligence"
          findings={bidIntel.findings.filter((f) => f.findingType !== 'BID_DESTINATION')}
          emptyLine="No source-side bid rejections were reported in this snapshot."
        />
        <UnknownsSection unknowns={[...callIntel.unknowns, ...bidIntel.unknowns]} />
      </details>
    </CommandShell>
  );
}

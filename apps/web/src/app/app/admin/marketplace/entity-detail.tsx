// One buyer, vendor, source or campaign -- Level 3 of CallGrid Intelligence.
//
// WHAT IT CAN SAY, AND WHY IT CAN SAY IT. Every projected call names its source,
// campaign, buyer and vendor together, so "which campaigns fed this buyer" and "which
// sources supplied it" are sums over call rows -- measured, not inferred. The funnel
// shows a stage only when calls reported it. Bid figures (sources only) come from the
// provider's bid snapshot, a different grain, and are fenced as such.
//
// SCOPED TO THE SESSION'S ORGANIZATION. The key in the URL selects within the org's
// own calls; another tenant's key matches nothing and renders as no activity.

import Link from 'next/link';

import {
  bidFunnel,
  callFunnel,
  easternSpanLabel,
  historyEntityKey,
  profitCents,
  rejectionClassification,
  type IntelligenceDimension,
} from '@emgloop/shared';
import { decisionEngine, type CallDimensionAggregate, type CallDimensionName } from '@emgloop/database';

import type { AuthSession } from '../../../../auth/auth';
import { loadCommandContext, loadEntityFacts, withQuery, type SearchParams } from './command-data';
import { CommandShell, Card, TrendChart, money, count, pct } from './command-ui';
import { loadCallGridHistory } from './callgrid-history-data';
import { loadBidReport, type BidSourceRow } from './bid-report';
import { dimensionIntelligence } from './intelligence-data';
import { FindingList } from './intelligence-ui';
import { CALLGRID_SOURCE } from './operational-queue-data';
import { STATE_LABEL } from '../_decisions/decision-ui';
import type { PriorityState } from '@emgloop/shared';

const BASE = '/app/admin/marketplace';

export interface EntityDetailConfig {
  readonly dim: CallDimensionName;
  readonly singular: 'buyer' | 'vendor' | 'source' | 'campaign';
  readonly label: string; // "Buyer"
  /** The other dimensions, in the order this entity's story reads, with their headings. */
  readonly composition: readonly { dim: CallDimensionName; title: string }[];
}

export const ENTITY_CONFIG: Readonly<Record<CallDimensionName, EntityDetailConfig>> = {
  buyers: {
    dim: 'buyers', singular: 'buyer', label: 'Buyer',
    composition: [
      { dim: 'campaigns', title: 'Campaigns feeding this buyer' },
      { dim: 'sources', title: 'Sources supplying this traffic' },
      { dim: 'vendors', title: 'Vendors behind it' },
    ],
  },
  vendors: {
    dim: 'vendors', singular: 'vendor', label: 'Vendor',
    composition: [
      { dim: 'sources', title: 'Sources under this vendor' },
      { dim: 'campaigns', title: 'Campaigns it supplies' },
      { dim: 'buyers', title: 'Buyers its calls reached' },
    ],
  },
  sources: {
    dim: 'sources', singular: 'source', label: 'Source',
    composition: [
      { dim: 'campaigns', title: 'Campaigns it feeds' },
      { dim: 'buyers', title: 'Buyers its calls reached' },
      { dim: 'vendors', title: 'Vendor' },
    ],
  },
  campaigns: {
    dim: 'campaigns', singular: 'campaign', label: 'Campaign',
    composition: [
      { dim: 'sources', title: 'Who supplies this campaign' },
      { dim: 'buyers', title: 'Buyers receiving it' },
      { dim: 'vendors', title: 'Vendors' },
    ],
  },
};

function change(cur: number | null, prior: number | null): string | null {
  if (cur === null || prior === null || prior === 0) return null;
  const p = Math.round(((cur - prior) / Math.abs(prior)) * 100);
  return `${p > 0 ? '↑' : p < 0 ? '↓' : '→'} ${Math.abs(p)}%`;
}

function CompositionTable({ rows, dim, query, total }: { rows: readonly CallDimensionAggregate[]; dim: CallDimensionName; query: string; total: number }) {
  if (rows.length === 0) return <p className="cgx-empty">None of these calls named one.</p>;
  return (
    <div className="adm-tablewrap">
      <table className="adm-table dim-table cgx-table">
        <thead>
          <tr><th>Name</th><th className="dim-num">Calls</th><th className="dim-num">Share</th><th className="dim-num">Billable</th><th className="dim-num">Revenue</th><th className="dim-num">Net profit</th></tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((r) => {
            const revenue = r.callsWithRevenue > 0 ? r.revenueCents : null;
            return (
              <tr key={r.key} className="dim-row">
                <td><Link href={withQuery(`${BASE}/${dim}/${encodeURIComponent(r.key)}`, query)} className="dim-rowlink">{r.label}</Link></td>
                <td className="dim-num">{count(r.calls)}</td>
                <td className="dim-num">{total > 0 ? `${Math.round((r.calls / total) * 100)}%` : '—'}</td>
                <td className="dim-num">{count(r.monetized)}</td>
                <td className="dim-num">{money(revenue)}</td>
                <td className="dim-num">{money(profitCents(revenue, r.payoutCents, r.costCents))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > 8 ? <p className="cgx-foot">and {rows.length - 8} more.</p> : null}
    </div>
  );
}

function SourceBids({ row, meta }: { row: BidSourceRow | null; meta: { windowStart: Date; fetchedAt: Date } | null }) {
  const stages = bidFunnel(row);
  const reasons = row
    ? (Object.entries(row.rejections) as [string, number | null][])
        .filter(([, n]) => n !== null && n > 0)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    : [];
  return (
    <div className="cgx-bidq">
      <p className="cgx-fence">
        Bid figures are CallGrid’s bid report for one provider day{meta ? ` (${meta.windowStart.toISOString().slice(0, 10)}, UTC)` : ''}, not the selected period. They are shown beside the calls, never added to them.
      </p>
      <ol className="cgx-funnel cgx-funnel--bids">
        {stages.map((s) => (
          <li key={s.key} className="cgx-funnel__stage">
            <span className="cgx-funnel__label">{s.label}</span>
            <span className="cgx-funnel__value">{s.value === null ? '—' : s.value.toLocaleString('en-US')}</span>
          </li>
        ))}
      </ol>
      <div className="cgx-known">
        <div>
          <h3 className="cgx-known__h">What CallGrid reported about the rejections</h3>
          {reasons.length === 0 ? (
            <p className="cgx-muted">{row ? 'No rejection reasons were reported for this source.' : 'This source is not in the latest bid snapshot.'}</p>
          ) : (
            <ul className="cgx-known__list">
              {reasons.map(([key, n]) => {
                const c = rejectionClassification(key);
                return (
                  <li key={key}>
                    <strong>{c?.displayName ?? key}</strong> · {count(n)}
                    {c ? <span className="cgx-muted"> — {c.operationalMeaning}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div>
          <h3 className="cgx-known__h">What Loop cannot determine</h3>
          <ul className="cgx-known__list cgx-muted">
            <li>Which buyer or destination declined a particular bid — CallGrid reports bids per source per day, not per bid.</li>
            <li>Whether a won bid became a connected call — bids and calls are not linked in the data.</li>
            <li>Buyer caps, concurrency or capacity — CallGrid does not report them to Loop.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export async function EntityDetailPage({ dim, entityKey, session, searchParams }: { dim: CallDimensionName; entityKey: string; session: AuthSession; searchParams?: SearchParams }) {
  const config = ENTITY_CONFIG[dim];
  const ctx = await loadCommandContext(session, searchParams);
  const key = entityKey.toLowerCase();
  const [{ current, comparison }, history, records, bid] = await Promise.all([
    loadEntityFacts(ctx, { dimension: dim, key }),
    loadCallGridHistory(ctx.organizationId, ctx.window, ctx.coverage),
    decisionEngine.list(ctx.organizationId, { producer: CALLGRID_SOURCE, take: 300 }).catch(() => null),
    dim === 'sources' ? loadBidReport(ctx.organizationId) : Promise.resolve(null),
  ]);

  const agg = current?.aggregate ?? null;
  const prior = comparison?.aggregate ?? null;
  const bidRow = bid?.sources.find((s) => s.key.toLowerCase() === key) ?? null;
  // The name the calls carried; for a source with bids and no calls, the bid report's name.
  const label = current?.entityLabel ?? comparison?.entityLabel ?? bidRow?.name ?? entityKey;
  const revenue = agg && agg.callsWithRevenue > 0 ? agg.revenueCents : agg && agg.calls === 0 ? 0 : null;
  const priorRevenue = prior && prior.callsWithRevenue > 0 ? prior.revenueCents : prior && prior.calls === 0 ? 0 : null;
  const profit = agg ? (agg.calls === 0 ? 0 : profitCents(revenue, agg.payoutCents, agg.costCents)) : null;
  const priorProfit = prior ? (prior.calls === 0 ? 0 : profitCents(priorRevenue, prior.payoutCents, prior.costCents)) : null;
  const total = ctx.report.metrics.revenueCents;
  const share = revenue !== null && total !== null && total > 0 ? (revenue / total) * 100 : null;
  const rate = agg && agg.calls > 0 ? (agg.monetized / agg.calls) * 100 : null;
  const priorRate = prior && prior.calls > 0 ? (prior.monetized / prior.calls) * 100 : null;

  // Findings the engine produced about THIS entity -- the same rules, scoped.
  const intel = dimensionIntelligence(ctx.report, dim as IntelligenceDimension, ctx.now);
  const findings = intel.ranked
    .map((r) => r.finding)
    .filter((f) => f.affectedEntities.some((e) => e.entityType === config.singular && (e.entityId || e.entityName).toLowerCase() === key));
  const related = (records ?? []).filter((p) => (p.sourceReference ?? '').toLowerCase() === key);
  const hk = historyEntityKey(dim, key);
  const past = history.points
    .slice()
    .sort((a, b) => a.period.index - b.period.index)
        // A period Loop read in which this entity had no calls is a real zero; one where
    // its calls carried no revenue keeps its revenue unknown.
    .map((p) => {
      const present = hk in p.entityCalls;
      return {
        label: easternSpanLabel(p.period.start, p.period.end),
        calls: present ? p.entityCalls[hk]! : 0,
        revenue: present ? (hk in p.entityRevenueCents ? p.entityRevenueCents[hk]! : null) : 0,
      };
    });

  const tiles = [
    { label: 'Revenue', value: money(revenue), delta: change(revenue, priorRevenue) },
    { label: 'Net profit', value: money(profit), delta: change(profit, priorProfit) },
    { label: 'Calls', value: count(agg?.calls ?? null), delta: change(agg?.calls ?? null, prior?.calls ?? null) },
    { label: 'Billable calls', value: count(agg?.monetized ?? null), delta: change(agg?.monetized ?? null, prior?.monetized ?? null) },
    { label: 'Billable rate', value: pct(rate), delta: rate !== null && priorRate !== null ? `${rate - priorRate >= 0 ? '+' : '−'}${Math.abs(rate - priorRate).toFixed(0)} pts` : null },
    { label: 'Share of revenue', value: pct(share), delta: null },
  ];

  return (
    <CommandShell
      ctx={ctx}
      active={dim}
      path={`${BASE}/${dim}/${encodeURIComponent(entityKey)}`}
      crumbs={[{ label: `${config.label}s`, href: withQuery(`${BASE}/${dim}`, ctx.query) }, { label }]}
    >
      <header className="cgx-entity">
        <p className="cgx-eyebrow">{config.label}</p>
        <h2 className="cgx-entity__name">{label}</h2>
        <p className="cgx-muted">{ctx.selection.label}{ctx.report.comparison ? ` · compared with ${ctx.desc.comparisonTitle}` : ''}</p>
      </header>

      {!current ? (
        <p className="cgx-note">Loop could not read this {config.singular}’s calls for the period.</p>
      ) : agg!.calls === 0 ? (
        <p className="cgx-note">No calls from this {config.singular} in {ctx.selection.label}{prior && prior.calls > 0 ? `; ${count(prior.calls)} in the comparison period` : ''}.</p>
      ) : null}

      <div className="cgx-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="cgx-tile">
            <span className="cgx-tile__label">{t.label}</span>
            <span className="cgx-tile__value">{t.value}</span>
            <span className="cgx-tile__delta">{t.delta ?? (ctx.report.comparison ? 'No valid comparison' : '')}</span>
          </div>
        ))}
      </div>

      <div className="cgx-grid cgx-grid--2">
        <Card title="Calls over the period">
          <TrendChart
            buckets={ctx.buckets.current.length >= ctx.buckets.comparison.length ? ctx.buckets.current : ctx.buckets.comparison}
            current={current?.series.map((p) => p.calls) ?? []}
            comparison={comparison ? comparison.series.map((p) => p.calls) : null}
            currentLabel={ctx.selection.label}
            comparisonLabel={ctx.report.comparison ? ctx.desc.comparisonTitle : null}
            format={(v) => Math.round(v).toLocaleString('en-US')}
            cumulative
            title={`${label}: calls so far against the comparison period`}
          />
        </Card>
        <Card title="Funnel">
          {agg ? (
            <ol className="cgx-funnel">
              {callFunnel(current!.outcomes, { revenueCents: revenue, profitCents: profit }).map((s) => (
                <li key={s.key} className="cgx-funnel__stage">
                  <span className="cgx-funnel__label">{s.label}</span>
                  <span className="cgx-funnel__value">{s.value === null ? '—' : s.grain === 'money' ? money(s.value) : s.value.toLocaleString('en-US')}</span>
                  {s.note ? <span className="cgx-funnel__note">{s.note}</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="cgx-empty">No calls to show.</p>
          )}
          {current && current.outcomes.noRouteReported > 0 ? (
            <p className="cgx-foot">{count(current.outcomes.noRoute)} of these calls found no route.</p>
          ) : null}
        </Card>
      </div>

      {dim === 'sources' ? (
        <Card title="Bids and calls — why supply does or does not become calls" wide>
          <SourceBids row={bidRow} meta={bid?.meta ?? null} />
        </Card>
      ) : null}

      <Card title={`Where this ${config.singular}’s calls came from and went`} wide>
        {!agg ? (
          <p className="cgx-empty">Unavailable.</p>
        ) : agg.calls === 0 ? (
          <p className="cgx-empty">No calls in this period, so there is nothing to break down.</p>
        ) : (
          config.composition.map((c) => (
            <section key={c.dim} className="cgx-compose">
              <h3 className="cgx-compose__h">{c.title}</h3>
              <CompositionTable rows={agg[c.dim]} dim={c.dim} query={ctx.query} total={agg.calls} />
            </section>
          ))
        )}
        <p className="cgx-foot">Summed from the call rows: every call names its source, campaign, buyer and vendor. A call that named none is counted in the totals and left out of these tables.</p>
      </Card>

      <div className="cgx-grid cgx-grid--2">
        <Card title="Related situations" action={{ label: 'Intelligence', href: withQuery(`${BASE}/intelligence`, ctx.query, { entity: config.singular }) }}>
          {related.length === 0 ? (
            <p className="cgx-empty">{records === null ? 'Loop could not read the decision record.' : `Loop has not opened a decision about this ${config.singular}.`}</p>
          ) : (
            <ul className="q-lines">
              {related.slice(0, 6).map((p) => (
                <li key={p.id} className="q-line">
                  <span className={'q-line__state q-line__state--' + p.state.toLowerCase()}>{STATE_LABEL[p.state as PriorityState]}</span>
                  <Link href={withQuery(`${BASE}/intelligence/${encodeURIComponent(p.id)}`, ctx.query)} className="q-line__title">{p.title}</Link>
                </li>
              ))}
            </ul>
          )}
          {findings.length > 0 ? (
            <details className="cgx-more-section">
              <summary className="cgx-more-section__summary">What Loop found about it this period ({findings.length})</summary>
              <FindingList sectionLabel={`${config.label} findings`} findings={findings} emptyLine="" compact />
            </details>
          ) : null}
        </Card>
        <Card title="Earlier periods">
          {past.length === 0 ? (
            <p className="cgx-empty">{history.suppressedForLiveWindow ? 'Earlier periods are compared once the selected period is complete — a period still in progress is never put in a history.' : 'No earlier periods could be read.'}</p>
          ) : (
            <table className="adm-table dim-table cgx-table">
              <thead><tr><th>Period</th><th className="dim-num">Calls</th><th className="dim-num">Revenue</th></tr></thead>
              <tbody>
                {past.map((p) => (
                  <tr key={p.label} className="dim-row"><td>{p.label}</td><td className="dim-num">{count(p.calls)}</td><td className="dim-num">{money(p.revenue)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </CommandShell>
  );
}

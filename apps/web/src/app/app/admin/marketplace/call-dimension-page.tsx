// The shared call-projection dimension page. Buyers, Vendors and Campaigns are the
// SAME page with different data + labels — one implementation, configured. Each
// route file is a thin wrapper that passes its config. Sources is bid-grain and
// does not use this (it composes the same shell + primitives with its own data).

import { requireCrmContext } from '../../../../crm/crm-data';
import { parseCallGridRange, resolveCallGridWindow, callGridRangeQuery } from '@emgloop/shared';
import { money, num } from '../../_loop-os';
import type { CallGridNavKey } from './_CallGridNav';
import { loadCallGridReport, type CallGridDimRow, type Dimension } from './callgrid-report';
import {
  summarizeRows, revPerBillable, trend, shareOfRevenue, shareOfVolume,
  parseDimSort, sortRows, buildDimQuery,
} from './dimension-metrics';
import {
  DimensionShell, SummaryTiles, PerformanceTable, TrendCell, DetailPanel, ActivitySection,
  type PerfColumn, type SummaryTile,
} from './dimension-ui';

export interface CallDimensionConfig {
  dim: Dimension;
  navKey: CallGridNavKey;
  title: string;
  subtitle: string;
  entityLabel: string;      // "Buyer"
  entityLabelLower: string; // "buyer"
  selectionParam: string;   // "buyer"
  share: 'revenue' | 'volume' | 'none';
}

type SP = Record<string, string | undefined>;

export async function CallDimensionPage({ config, searchParams }: { config: CallDimensionConfig; searchParams?: SP }) {
  const { organizationId: org } = await requireCrmContext();

  const range = parseCallGridRange({ range: searchParams?.range, s: searchParams?.s, e: searchParams?.e });
  const window = resolveCallGridWindow(range, new Date());
  const rangeQuery = callGridRangeQuery(window.preset, { start: range.start, end: range.end });
  const sort = parseDimSort(searchParams?.sort, searchParams?.dir);

  const report = await loadCallGridReport(org, window);
  const allRows = report.dimensions[config.dim];
  const rows = sortRows(allRows, sort.key, sort.dir);
  const priorByKey = report.comparisonByKey[config.dim];
  const totalRevenue = allRows.reduce((s, r) => s + r.revenueCents, 0);
  const totalCalls = allRows.reduce((s, r) => s + r.calls, 0);
  const s = summarizeRows(allRows);

  const selectedKey = searchParams?.[config.selectionParam] ?? null;
  const selected: CallGridDimRow | null = selectedKey ? allRows.find((r) => r.key === selectedKey) ?? null : null;
  const selectedPrior = selected ? priorByKey.get(selected.key) : undefined;

  // URL builders — every link preserves range + selection + sort.
  const rangeBits = {
    range: window.preset === 'today' ? undefined : window.preset,
    s: window.preset === 'custom' ? range.start : undefined,
    e: window.preset === 'custom' ? range.end : undefined,
  };
  const rowHref = (key: string) =>
    '?' + buildDimQuery({ ...rangeBits, sort: sort.key, dir: sort.dir, [config.selectionParam]: key });
  const sortHref = (key: string) =>
    '?' + buildDimQuery({
      ...rangeBits,
      [config.selectionParam]: selectedKey ?? undefined,
      sort: key,
      dir: key === sort.key && sort.dir === 'desc' ? 'asc' : 'desc',
    });

  // Six summary tiles — identical shape across Buyers / Vendors / Campaigns.
  const tiles: SummaryTile[] = [
    { title: `Total ${config.entityLabel}s`, value: num(s.total) },
    { title: `Active ${config.entityLabel}s`, value: num(s.active), sub: 'With activity this period' },
    { title: 'Revenue', value: report.metrics.available ? money(s.revenueCents) : 'Unavailable' },
    { title: 'Billable Calls', value: num(s.billableCalls) },
    { title: 'Total Calls', value: num(s.totalCalls) },
    { title: 'Avg Revenue / Billable Call', value: s.avgRevPerBillableCents === null ? 'Not available' : money(s.avgRevPerBillableCents) },
  ];

  // Performance-table columns.
  const columns: PerfColumn<CallGridDimRow>[] = [
    { label: config.entityLabel, render: (r) => <a href={rowHref(r.key)} className="dim-rowlink">{r.label}</a> },
    { label: 'Revenue', align: 'right', sortKey: 'revenue', render: (r) => money(r.revenueCents) },
    { label: 'Billable', align: 'right', sortKey: 'billable', render: (r) => num(r.monetized) },
    { label: 'Total Calls', align: 'right', sortKey: 'calls', render: (r) => num(r.calls) },
    { label: 'Rev / Billable', align: 'right', sortKey: 'revPerBillable', render: (r) => { const v = revPerBillable(r.revenueCents, r.monetized); return v === null ? '—' : money(v); } },
  ];
  if (config.share === 'revenue') {
    columns.push({ label: 'Share of Revenue', align: 'right', render: (r) => shareOfRevenue(r, totalRevenue) + '%' });
  } else if (config.share === 'volume') {
    columns.push({ label: 'Share of Call Volume', align: 'right', render: (r) => shareOfVolume(r, totalCalls) + '%' });
  }
  columns.push({ label: 'Trend', align: 'right', render: (r) => <TrendCell t={trend(r.revenueCents, priorByKey.get(r.key)?.revenueCents)} /> });

  return (
    <DimensionShell
      active={config.navKey}
      title={config.title}
      subtitle={config.subtitle}
      window={window}
      customStart={range.start}
      customEnd={range.end}
      rangeQuery={rangeQuery}
    >
      {!report.ok ? (
        <div className="cg-sec">
          <section className="tile tile--wide"><p className="tile__line cg-muted">CallGrid data could not be loaded. Reload to try again.</p></section>
        </div>
      ) : (
        <>
          <SummaryTiles tiles={tiles} />
          <PerformanceTable
            sectionLabel={`${config.entityLabel} Performance`}
            columns={columns}
            rows={rows}
            getKey={(r) => r.key}
            selectedKey={selectedKey}
            sort={sort}
            sortHref={sortHref}
            emptyLine={`No ${config.entityLabelLower} activity for this period.`}
          />
          <DetailPanel
            sectionLabel={`${config.entityLabel} Detail`}
            name={selected ? selected.label : null}
            period={window.label}
            facts={selected ? [
              { label: 'Revenue', value: money(selected.revenueCents) },
              { label: 'Billable Calls', value: num(selected.monetized) },
              { label: 'Total Calls', value: num(selected.calls) },
              { label: 'Rev / Billable', value: (() => { const v = revPerBillable(selected.revenueCents, selected.monetized); return v === null ? '—' : money(v); })() },
              { label: 'Revenue trend', value: trend(selected.revenueCents, selectedPrior?.revenueCents).text },
              { label: 'Call trend', value: trend(selected.calls, selectedPrior?.calls).text },
            ] : []}
            note={`Per-${config.entityLabelLower} cross-dimension attribution is not exposed at the ${config.entityLabelLower} grain by the current CallGrid data.`}
            emptyPrompt={`Select a ${config.entityLabelLower} to view performance details.`}
          />
          <ActivitySection
            items={[]}
            emptyLine={`No durable ${config.entityLabelLower}-level CallGrid events for this period.`}
          />
        </>
      )}
    </DimensionShell>
  );
}

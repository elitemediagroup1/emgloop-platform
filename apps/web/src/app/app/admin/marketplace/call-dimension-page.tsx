// The shared call-projection dimension page. Buyers, Vendors and Campaigns are
// the SAME page with different data + labels — one implementation, configured.
// Each route file is a thin wrapper that passes its config. Sources is bid-grain
// and does not use this (it composes the same shell + primitives with its own data).
//
// Sections: Header · Date · Summary · Intelligence · Performance table · Selected
// detail · Contribution analysis · Unknowns · Activity.
//
// The intelligence comes from the same engine the Overview uses, scoped to this
// dimension — so a driver named on the Overview is the same finding, with the
// same evidence and the same rule version, when the operator clicks through.

import { requireCrmContext } from '../../../../crm/crm-data';
import {
  parseCallGridRange, resolveCallGridWindow, callGridRangeQuery, describeCallGridWindow,
  type IntelligenceDimension,
} from '@emgloop/shared';
import { num } from '../../_loop-os';
import type { CallGridNavKey } from './_CallGridNav';
import { loadCallGridReport, type CallGridDimRow, type Dimension } from './callgrid-report';
import {
  summarizeRows, revPerBillable, trend, shareOfRevenue, shareOfVolume,
  parseDimSort, sortRows, buildDimQuery,
} from './dimension-metrics';
import { dimensionIntelligence } from './intelligence-data';
import { loadCallGridHistory } from './callgrid-history-data';
import {
  DimensionShell, SummaryTiles, PerformanceTable, TrendCell, DetailPanel, ActivitySection,
  type PerfColumn, type SummaryTile,
} from './dimension-ui';
import {
  FindingList, UnknownsSection, ContributionTable,
  BusinessHealthSection, OpportunitiesSection,
} from './intelligence-ui';

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

/** Money that never dresses an unknown as $0. */
function money(cents: number | null): string {
  if (cents === null) return 'Unknown';
  const sign = cents < 0 ? '-' : '';
  return sign + '$' + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
}
function pctOrDash(v: number | null): string {
  return v === null ? '—' : v + '%';
}

export async function CallDimensionPage({ config, searchParams }: { config: CallDimensionConfig; searchParams?: SP }) {
  const { organizationId: org } = await requireCrmContext();

  const now = new Date();
  const range = parseCallGridRange({ range: searchParams?.range, s: searchParams?.s, e: searchParams?.e });
  const window = resolveCallGridWindow(range, now);
  const rangeQuery = callGridRangeQuery(window.preset, { start: range.start, end: range.end });
  const desc = describeCallGridWindow(window, now);
  const sort = parseDimSort(searchParams?.sort, searchParams?.dir);

  // History powers the per-entity series findings (record periods, sustained
  // fades, rising dominance, emergence, consistency) — the ones a delta against a
  // single prior period cannot support. A live window yields an empty series by
  // construction, so this costs nothing on Today.
  const [report, history] = await Promise.all([
    loadCallGridReport(org, window),
    loadCallGridHistory(org, window),
  ]);
  const allRows = report.dimensions[config.dim];
  const rows = sortRows(allRows, sort.key, sort.dir);
  const priorByKey = report.comparisonByKey[config.dim];
  const s = summarizeRows(allRows);
  const totalCalls = s.totalCalls;

  const intel = dimensionIntelligence(report, config.dim as IntelligenceDimension, now, { history });

  // Attention-ordered: the top five lead the page, the rest fall below the
  // metrics as "also worth reviewing". Ordering by score rather than severity is
  // what stops an INFORMATIONAL record-high from outranking a live problem.
  const topFindings = intel.ranked.slice(0, 5).map((r) => r.finding);
  const topIds = new Set(topFindings.map((f) => f.id));
  const remainingFindings = intel.ranked
    .slice(5)
    .map((r) => r.finding)
    .filter((f) => !topIds.has(f.id));

  const selectedKey = searchParams?.[config.selectionParam] ?? null;
  const selected: CallGridDimRow | null = selectedKey ? allRows.find((r) => r.key === selectedKey) ?? null : null;
  const selectedPrior = selected ? priorByKey.get(selected.key) : undefined;

  // URL builders — every link preserves range + selection + sort. The preset is
  // always explicit (Today included) so navigation never drops the selection.
  const rangeBits = {
    range: window.preset,
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

  // Summary tiles. "Observed" and "Active" are genuinely different measures:
  // CallGrid exposes no roster, so observed = appeared this period, and active
  // narrows that to entities that actually produced revenue or a billable call.
  const tiles: SummaryTile[] = [
    { title: `${config.entityLabel}s Observed`, value: num(s.observed), sub: 'With calls this period' },
    { title: `Active ${config.entityLabel}s`, value: num(s.active), sub: 'Produced revenue or a billable call' },
    { title: 'Revenue', value: report.metrics.available ? money(s.revenueCents) : 'Unavailable' },
    { title: 'Billable Calls', value: num(s.billableCalls) },
    { title: 'Total Calls', value: num(s.totalCalls) },
    { title: 'Avg Revenue / Billable Call', value: money(s.avgRevPerBillableCents) },
  ];

  // Performance-table columns.
  const columns: PerfColumn<CallGridDimRow>[] = [
    { label: config.entityLabel, render: (r) => <a href={rowHref(r.key)} className="dim-rowlink">{r.label}</a> },
    { label: 'Revenue', align: 'right', sortKey: 'revenue', render: (r) => money(r.revenueCents) },
    { label: 'Billable', align: 'right', sortKey: 'billable', render: (r) => num(r.monetized) },
    { label: 'Total Calls', align: 'right', sortKey: 'calls', render: (r) => num(r.calls) },
    { label: 'Rev / Billable', align: 'right', sortKey: 'revPerBillable', render: (r) => money(revPerBillable(r.revenueCents, r.monetized)) },
  ];
  if (config.share === 'revenue') {
    columns.push({ label: 'Share of Revenue', align: 'right', render: (r) => pctOrDash(shareOfRevenue(r, s.revenueCents)) });
  } else if (config.share === 'volume') {
    columns.push({ label: 'Share of Call Volume', align: 'right', render: (r) => pctOrDash(shareOfVolume(r, totalCalls)) });
  }
  columns.push({ label: 'Trend', align: 'right', render: (r) => <TrendCell t={trend(r.revenueCents, priorByKey.get(r.key)?.revenueCents ?? null)} /> });

  return (
    <DimensionShell
      active={config.navKey}
      title={config.title}
      subtitle={config.subtitle}
      window={window}
      now={now}
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
          {/* ORDER: intelligence, then health, then opportunities, then risks,
              then metrics, then tables. The summary tiles used to sit first; they
              answer "what happened", which CallGrid already answers. They are now
              evidence beneath the conclusions that read them. */}

          <FindingList
            sectionLabel={`Executive ${config.entityLabel} Intelligence`}
            findings={topFindings}
            emptyLine={
              report.comparison
                ? `No ${config.entityLabelLower} movement in this period clears the significance thresholds.`
                : 'No comparison period is defined for this selection, so no change can be analysed.'
            }
          />

          <BusinessHealthSection
            health={{ overall: intel.health, dimensions: [intel.health], modelVersion: 'v1' }}
            sectionLabel={`${config.entityLabel} Health`}
          />

          <OpportunitiesSection
            opportunities={intel.opportunities}
            sectionLabel={`${config.entityLabel} Opportunities`}
          />

          <FindingList
            sectionLabel={`${config.entityLabel} Risks`}
            findings={intel.risks.slice(0, 4)}
            emptyLine={`No evidence-backed ${config.entityLabelLower} risk for this period.`}
            compact
          />

          {remainingFindings.length > 0 ? (
            <FindingList
              sectionLabel="Also Worth Reviewing"
              findings={remainingFindings}
              emptyLine=""
              compact
            />
          ) : null}

          <UnknownsSection unknowns={intel.unknowns} />

          <SummaryTiles tiles={tiles} label={`${config.title} · ${desc.periodTitle}`} />
          {s.revenueCoverage !== null && s.revenueCoverage < 1 && s.revenueCoverage > 0 ? (
            <p className="cg-covnote">
              {Math.round(s.revenueCoverage * 100)}% of {config.entityLabelLower}s reported a revenue value, so revenue
              totals here are lower bounds.
            </p>
          ) : null}

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
              { label: 'Rev / Billable', value: money(revPerBillable(selected.revenueCents, selected.monetized)) },
              { label: 'Revenue trend', value: trend(selected.revenueCents, selectedPrior?.revenueCents ?? null).text },
              { label: 'Call trend', value: trend(selected.calls, selectedPrior?.calls ?? null).text },
            ] : []}
            note={`Per-${config.entityLabelLower} cross-dimension attribution is not exposed at the ${config.entityLabelLower} grain by the current CallGrid data.`}
            emptyPrompt={`Select a ${config.entityLabelLower} to view performance details.`}
          />

          <ContributionTable
            contributions={intel.contributions}
            entityLabel={config.entityLabel}
            money={money}
          />

          {/* Unknowns moved ABOVE the metrics with the rest of the intelligence.
              Rendering them here as well would repeat the section on one page. */}

          <ActivitySection
            items={[]}
            emptyLine={`No durable ${config.entityLabelLower}-level CallGrid events for this period.`}
          />
        </>
      )}
    </DimensionShell>
  );
}

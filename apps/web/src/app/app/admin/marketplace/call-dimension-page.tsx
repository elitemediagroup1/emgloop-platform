// The shared dimension workspace. Buyers, Vendors and Campaigns are the SAME
// workspace with different data and labels -- one implementation, configured; each
// route file is a thin wrapper. (Sources composes the same pieces with its bid
// snapshot beside it.)
//
// THE WORKSPACE IS A TABLE THAT OPENS ENTITIES: calls, billable calls and rate,
// revenue, net profit, margin, share and movement per entity, each row opening that
// entity's own page. Concentration is stated as arithmetic (top one and top three
// shares), not as a verdict.
//
// THE DIMENSION'S INTELLIGENCE IS KEPT, ONE CLICK AWAY. Decision support, health,
// stability, opportunities, risks, the timeline, contribution and the business story
// -- the same engine, scoped to this dimension, exactly as before -- sit behind one
// disclosure beneath the table instead of above it.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { IntelligenceDimension } from '@emgloop/shared';

import type { AuthSession } from '../../../../auth/auth';
import { loadCommandContext, withQuery, type SearchParams } from './command-data';
import { CommandShell, money, count, pct } from './command-ui';
import type { CallGridNavKey } from './_CallGridNav';
import type { CallGridDimRow, Dimension } from './callgrid-report';
import { summarizeRows, trend, parseDimSort, sortRows } from './dimension-metrics';
import { dimensionIntelligence } from './intelligence-data';
import { loadCallGridHistory } from './callgrid-history-data';
import { PerformanceTable, TrendCell, type PerfColumn } from './dimension-ui';
import {
  FindingList, UnknownsSection, ContributionTable,
  BusinessHealthSection, OpportunitiesSection, DecisionSupportSection,
  ReasoningSection, IntelligenceTimeline, StabilitySection, BusinessStorySection,
} from './intelligence-ui';
import { OrganizationReadingSection } from '../../../../intelligence/domain-reading-section';

export interface CallDimensionConfig {
  dim: Dimension;
  navKey: CallGridNavKey;
  title: string;
  subtitle: string;
  entityLabel: string;      // "Buyer"
  entityLabelLower: string; // "buyer"
  /** Kept for old links (?buyer=<key>): a selection now opens the entity's own page. */
  selectionParam: string;
  share: 'revenue' | 'volume' | 'none';
}

const BASE = '/app/admin/marketplace';

/** Revenue share of the top N rows with known revenue -- arithmetic, not a verdict. */
export function topShare(rows: readonly CallGridDimRow[], total: number | null, n: number): number | null {
  if (total === null || total <= 0) return null;
  // Only entities that reported revenue take part: an unpriced entity is not a zero.
  const known = rows.flatMap((r) => (r.revenueCents === null ? [] : [r.revenueCents])).slice(0, n);
  if (known.length === 0) return null;
  return known.reduce((s, v) => s + v, 0) / total;
}

export async function CallDimensionPage({ config, session, searchParams }: { config: CallDimensionConfig; session: AuthSession; searchParams?: SearchParams }) {
  const ctx = await loadCommandContext(session, searchParams);
  const { report, window, now, query } = ctx;
  const path = `${BASE}/${config.dim}`;
  const sp = (k: string) => {
    const v = searchParams?.[k];
    return typeof v === 'string' ? v : undefined;
  };

  // An old link that selected a row (?buyer=<key>) now opens that entity's page.
  const selected = sp(config.selectionParam);
  if (selected) redirect(withQuery(`${path}/${encodeURIComponent(selected)}`, query));

  const history = await loadCallGridHistory(ctx.organizationId, window, ctx.coverage);
  const sort = parseDimSort(sp('sort'), sp('dir'));
  const allRows = report.dimensions[config.dim];
  const rows = sortRows(allRows, sort.key, sort.dir);
  const priorByKey = report.comparisonByKey[config.dim];
  const priorRank = new Map(report.comparisonDimensions[config.dim].map((r, i) => [r.key, i + 1] as const));
  const s = summarizeRows(allRows);
  const total = report.metrics.revenueCents;
  const intel = dimensionIntelligence(report, config.dim as IntelligenceDimension, now, { history });
  const topIds = new Set(intel.decisionSupport.slice(0, 5).map((c) => c.findingId));
  const remainingFindings = intel.ranked.map((r) => r.finding).filter((f) => !topIds.has(f.id));

  const sortHref = (key: string) =>
    withQuery(path, query, { sort: key, dir: key === sort.key && sort.dir === 'desc' ? 'asc' : 'desc' });
  const detailHref = (key: string) => withQuery(`${path}/${encodeURIComponent(key)}`, query);
  const rate = (r: CallGridDimRow) => (r.calls > 0 ? (r.monetized / r.calls) * 100 : null);
  const margin = (r: CallGridDimRow) => (r.marginCents !== null && r.revenueCents !== null && r.revenueCents > 0 ? (r.marginCents / r.revenueCents) * 100 : null);

  const columns: PerfColumn<CallGridDimRow>[] = [
    { label: config.entityLabel, render: (r) => <Link href={detailHref(r.key)} className="dim-rowlink">{r.label}</Link> },
    { label: 'Calls', align: 'right', sortKey: 'calls', render: (r) => count(r.calls) },
    { label: 'Billable', align: 'right', sortKey: 'billable', render: (r) => count(r.monetized) },
    { label: 'Billable rate', align: 'right', render: (r) => pct(rate(r)) },
    { label: 'Revenue', align: 'right', sortKey: 'revenue', render: (r) => money(r.revenueCents) },
    { label: 'Net profit', align: 'right', sortKey: 'profit', render: (r) => money(r.marginCents) },
    { label: 'Margin', align: 'right', render: (r) => pct(margin(r), 1) },
  ];
  if (config.share === 'revenue') {
    columns.push({ label: 'Share of revenue', align: 'right', render: (r) => pct(r.revenueCents !== null && total ? (r.revenueCents / total) * 100 : null) });
  } else if (config.share === 'volume') {
    columns.push({ label: 'Share of calls', align: 'right', render: (r) => pct(s.totalCalls > 0 ? (r.calls / s.totalCalls) * 100 : null) });
  }
  columns.push({ label: 'Revenue vs prior', align: 'right', render: (r) => <TrendCell t={trend(r.revenueCents, priorByKey.get(r.key)?.revenueCents ?? null)} /> });
  columns.push({
    label: 'Rank',
    align: 'right',
    render: (r) => {
      const now = allRows.indexOf(r) + 1;
      const was = priorRank.get(r.key) ?? null;
      return was === null ? 'New' : was === now ? `#${now}` : `#${now} (was #${was})`;
    },
  });

  const top1 = topShare(allRows, total, 1);
  const top3 = topShare(allRows, total, 3);

  return (
    <CommandShell ctx={ctx} active={config.navKey} path={path}>
      {config.navKey === 'campaigns' ? <OrganizationReadingSection domain="CAMPAIGNS" title="Campaigns reading" /> : null}
      {!report.ok ? (
        <p className="cgx-note">CallGrid data could not be loaded. Reload to try again.</p>
      ) : (
        <>
          <div className="cgx-strip" aria-label={`${config.title} summary`}>
            <div className="cgx-strip__item"><span className="cgx-strip__n">{count(s.observed)}</span><span className="cgx-strip__l">{config.entityLabel}s with calls</span></div>
            <div className="cgx-strip__item"><span className="cgx-strip__n">{count(s.active)}</span><span className="cgx-strip__l">produced revenue or a billable call</span></div>
            <div className="cgx-strip__item"><span className="cgx-strip__n">{top1 === null ? '—' : `${Math.round(top1 * 100)}%`}</span><span className="cgx-strip__l">of revenue from the top {config.entityLabelLower}</span></div>
            <div className="cgx-strip__item"><span className="cgx-strip__n">{top3 === null ? '—' : `${Math.round(top3 * 100)}%`}</span><span className="cgx-strip__l">from the top three</span></div>
          </div>
          {s.revenueCoverage !== null && s.revenueCoverage < 1 && s.revenueCoverage > 0 ? (
            <p className="cgx-note">{Math.round(s.revenueCoverage * 100)}% of {config.entityLabelLower}s reported a revenue value, so revenue here is incomplete.</p>
          ) : null}

          <PerformanceTable
            sectionLabel={`${config.title} · ${ctx.selection.label}`}
            columns={columns}
            rows={rows}
            getKey={(r) => r.key}
            selectedKey={null}
            sort={sort}
            sortHref={sortHref}
            emptyLine={`No ${config.entityLabelLower} activity for this period.`}
          />
          <p className="cgx-foot">Net profit is revenue minus payout minus telco cost on this {config.entityLabelLower}’s own calls. Open a {config.entityLabelLower} for its trend, funnel and composition.</p>

          <details className="cgx-more-section">
            <summary className="cgx-more-section__summary">{config.entityLabel} intelligence — the full analysis ({intel.ranked.length} finding{intel.ranked.length === 1 ? '' : 's'})</summary>
            <DecisionSupportSection
              cards={intel.decisionSupport}
              limit={5}
              sectionLabel={`Executive ${config.entityLabel} Intelligence`}
              emptyLine={report.comparison ? `No ${config.entityLabelLower} movement in this period clears the significance thresholds.` : 'No comparison period is defined for this selection, so no change can be analysed.'}
            />
            <ReasoningSection reasoning={intel.reasoning} />
            <BusinessHealthSection health={{ overall: intel.health, dimensions: [intel.health], modelVersion: 'v1' }} sectionLabel={`${config.entityLabel} Health`} />
            <StabilitySection assessments={intel.reasoning.stability} sectionLabel={`${config.entityLabel} Stability`} />
            <OpportunitiesSection opportunities={intel.opportunities} sectionLabel={`${config.entityLabel} Opportunities`} />
            <FindingList sectionLabel={`${config.entityLabel} Risks`} findings={intel.risks.slice(0, 4)} emptyLine={`No evidence-backed ${config.entityLabelLower} risk for this period.`} compact />
            {remainingFindings.length > 0 ? <FindingList sectionLabel="Also Worth Reviewing" findings={remainingFindings} emptyLine="" compact /> : null}
            <IntelligenceTimeline events={intel.reasoning.timeline} />
            <ContributionTable contributions={intel.contributions} entityLabel={config.entityLabel} money={money} />
            <UnknownsSection unknowns={intel.unknowns} />
            <BusinessStorySection reasoning={intel.reasoning} />
          </details>
        </>
      )}
    </CommandShell>
  );
}

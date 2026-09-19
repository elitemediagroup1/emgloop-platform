// CALLGRID INTELLIGENCE AS A LAYERED OPERATING SYSTEM: executive overview → functional
// workspaces → entity drilldown → situation → evidence.
//
// Renders the real shell parts with a prepared context (renderToStaticMarkup + markup
// assertions), and asserts the properties of the code that one render cannot show:
// every page states its own authority first, the executive surface names at most
// three priorities, and nothing that used to be on the Overview was deleted.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  analyzeCallGrid,
  assessCallGridFreshness,
  callGridBuckets,
  callGridKpis,
  describeCallGridWindow,
  readCallGridSelection,
  type CallGridBrief,
  type IntelligenceInput,
} from '@emgloop/shared';

import { CallGridNav, CALLGRID_SECTIONS } from '../src/app/app/admin/marketplace/_CallGridNav';
import { CommandShell, FreshnessBadge, KpiRow, PeriodBar, TrendChart, BarList } from '../src/app/app/admin/marketplace/command-ui';
import { TodaysBrief, TopPriorities } from '../src/app/app/admin/marketplace/executive-ui';
import { withQuery, type CommandContext } from '../src/app/app/admin/marketplace/command-data';
import { priorityOf } from '../src/app/app/admin/marketplace/executive-data';
import { EvidenceDrawer } from '../src/app/app/admin/marketplace/intelligence-ui';
import { readIntelFilter, intelQuery, matchesIntelFilter } from '../src/app/app/admin/marketplace/intelligence-filter';

const walkSrc = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walkSrc(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });

const NOW = new Date('2026-09-18T18:30:00.000Z'); // Fri 2:30 PM EDT
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const MKT = '../src/app/app/admin/marketplace';

function context(params?: Record<string, string>, over: Partial<CommandContext> = {}): CommandContext {
  const selection = readCallGridSelection(params, NOW);
  const metrics = {
    available: true, totalCalls: 400, billableCalls: 132, revenueCents: 37_241_800, profitCents: 6_452_800,
    payoutCents: 22_397_800, costCents: 8_391_200, revenueCoverage: 1, profitCoverage: 1,
  };
  const comparison = { ...metrics, totalCalls: 470, revenueCents: 34_000_000, profitCents: 6_000_000, costCents: 8_000_000 };
  return {
    session: { userId: 'u1', organizationId: 'org_a' } as never,
    organizationId: 'org_a',
    now: NOW,
    selection,
    window: selection.window,
    desc: describeCallGridWindow(selection.window, NOW),
    coverage: { recordStartsAt: new Date('2026-08-14T13:00:00Z'), comparison: 'VALID', currentPartial: false, note: null },
    report: { ok: true, window: selection.window, metrics, comparison } as never,
    buckets: callGridBuckets(selection.window),
    facts: null,
    comparisonFacts: null,
    kpis: callGridKpis({ metrics, comparison, series: [] }),
    freshness: assessCallGridFreshness({
      now: NOW, readOk: true, periodLive: selection.window.includesLiveData,
      lastDeliveryAt: new Date(NOW.getTime() - 3 * 60_000), pollCompletedThrough: null, recentDeliveries: [], factsOk: true,
    }),
    query: selection.query,
    canAct: true,
    ...over,
  };
}

describe('the executive layer', () => {
  it('shows the five KPIs, Net Profit first, each opening Money with the period carried', () => {
    const html = renderToStaticMarkup(<KpiRow ctx={context({ period: 'weekly', date: '2026-09-02' })} />);
    const labels = [...html.matchAll(/class="cgx-kpi__label">([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(labels, ['Net Profit', 'Revenue', 'Billable Calls', 'Margin', 'Telco Cost']);
    assert.match(html, /href="\/app\/admin\/marketplace\/money\?period=weekly&amp;date=2026-08-31#kpi-netProfit"/);
    assert.match(html, /\$64,528/);
    assert.match(html, /17\.3%/);
    // Telco cost rising is marked unfavourable, not good news.
    assert.match(html, /cgx-kpi__change--bad[^>]*><span aria-hidden="true">↑<\/span> 5%/);
  });

  it('names at most three priorities, links each to its situation, and never announces a backlog count', () => {
    const p = (n: number) => ({
      key: `k${n}`, title: `Situation ${n}`, kind: 'RISK' as const, kindLabel: 'Risk',
      explanation: 'High concentration risk if volume stops.', action: 'Confirm backup buyer capacity.', href: `/app/admin/marketplace/intelligence/p${n}`,
      metric: null, direction: null,
    });
    const html = renderToStaticMarkup(
      <TopPriorities priorities={[p(1), p(2), p(3)]} allHref="/app/admin/marketplace/intelligence?period=daily" emptyLine="Nothing undecided." unavailable={null} />,
    );
    assert.equal((html.match(/class="cgx-prio__item"/g) ?? []).length, 3);
    assert.match(html, /href="\/app\/admin\/marketplace\/intelligence\/p1"/);
    assert.match(html, /View all intelligence →/);
    assert.equal(/\b\d+ (decisions|more)\b/.test(html), false, 'no "54 decisions" on the executive surface');
    const empty = renderToStaticMarkup(<TopPriorities priorities={[]} allHref="/x" emptyLine="Nothing undecided needs you." unavailable={null} />);
    assert.match(empty, /Nothing undecided needs you\./);

    // The Overview asks the helper for its priorities, and that helper cuts at three.
    const overview = code(read(`${MKT}/page.tsx`));
    assert.match(overview, /const priorities = topPriorities\(ctx, analysis\);/);
    assert.equal(/QueueSection|SituationRow/.test(overview), false, 'the full queue is not on the Overview');
    assert.match(code(read(`${MKT}/executive-data.ts`)), /selectTopPriorities\(analysis\.ops\.items, \(i\) => i\.state === 'NEEDS_REVIEW'\)/);
  });

  it('REGRESSION (PR #300 review): a priority’s headline, explanation and action come from one finding', () => {
    // The case that shipped: "Total calls decreased 17%" rendered with the merged
    // billable-rate finding's explanation and its "Confirm which sources improved…" advice.
    const dims = (calls: number, billable: number, rev: number) => ({
      buyers: [
        { key: 'markytek', label: 'Markytek', calls: Math.round(calls * 0.4), monetized: Math.round(billable * 0.4), revenueCents: Math.round(rev * 0.35), marginCents: null },
        { key: 'harbor', label: 'Harbor Insurance', calls: Math.round(calls * 0.6), monetized: Math.round(billable * 0.6), revenueCents: Math.round(rev * 0.65), marginCents: null },
      ],
      vendors: [], sources: [], campaigns: [],
    });
    const intel = analyzeCallGrid({
      now: NOW, reportOk: true, windowLabel: 'Today · Live', comparisonLabel: 'Yesterday · through 2:30 PM',
      comparisonBasis: 'elapsed_matched', includesLiveData: true, periodsPerYear: null,
      metrics: { available: true, totalCalls: 289, billableCalls: 96, revenueCents: 413_200, profitCents: 158_100, payoutCents: 247_200, costCents: 7_900, revenueCoverage: 0.89, profitCoverage: 0.89 },
      comparison: { available: true, totalCalls: 349, billableCalls: 89, revenueCents: 378_300, profitCents: 141_400, payoutCents: 227_700, costCents: 9_200, revenueCoverage: 0.9, profitCoverage: 0.9 },
      dimensions: dims(289, 96, 413_200),
      comparisonDimensions: dims(349, 89, 378_300),
    } as unknown as IntelligenceInput);
    const calls = intel.queue.situations.find((s) => s.title.startsWith('Total calls decreased'));
    assert.ok(calls, 'the call-decline situation exists');
    assert.ok(calls!.observations.some((o) => o.primaryMetric === 'billableRate'), 'the billable-rate finding is still merged in');

    const p = priorityOf(calls!, '/app/admin/marketplace/intelligence/x');
    assert.match(p.title, /^Total calls decreased/);
    assert.match(p.action ?? '', /^Compare total calls by source and campaign/);
    for (const line of [p.explanation, p.action ?? '']) {
      assert.doesNotMatch(line, /improved|billable rate/i, `"${line}" belongs to another finding`);
    }
    const html = renderToStaticMarkup(<TopPriorities priorities={[p]} allHref="/i" emptyLine="-" unavailable={null} />);
    assert.doesNotMatch(html, /Confirm which sources improved/);
  });

  it('the brief is the band with its reason and two short sentences; the rest is behind View details', () => {
    const brief: CallGridBrief = {
      band: 'HEALTHY',
      reason: 'profit and revenue improved despite lower call volume',
      sentences: [
        { text: 'Total calls are down 17% versus yesterday to the same time, while the billable rate rose from 26% to 33%.', basis: 'ARITHMETIC', detail: '289 total calls against 349' },
        { text: 'Review the call decline first.', basis: 'READING', detail: null },
      ],
      details: [
        { text: 'Markytek accounts for 35% of buyer revenue.', basis: 'ARITHMETIC', detail: null },
        { text: 'Only 89% of calls carried a revenue value, so revenue and profit are incomplete.', basis: 'UNKNOWN', detail: null },
      ],
    };
    const html = renderToStaticMarkup(<TodaysBrief brief={brief} title="Today’s brief" analyzedAt={NOW} detailsHref="/i" />);
    assert.match(html, /Business health: <strong class="cgx-health__band">Healthy<\/strong><span class="cgx-health__reason"> — profit and revenue improved despite lower call volume\.<\/span>/);
    // Shown: the two sentences only. Concentration and coverage are details, with their basis.
    const shown = /<p class="cgx-brief__text">([^<]*)<\/p>/.exec(html)![1]!;
    assert.equal(shown, 'Total calls are down 17% versus yesterday to the same time, while the billable rate rose from 26% to 33%. Review the call decline first.');
    assert.doesNotMatch(shown, /Markytek|89%/);
    assert.match(html, /<summary class="cgx-brief__more">View details<\/summary>/);
    assert.match(html, /Arithmetic on measured values/);
    assert.match(html, /Not known<\/span><span class="cgx-basis__text">Only 89% of calls/);
    assert.match(html, /Nothing here is a model’s summary/);
  });

  it('the Billable Calls tile names the total calls it is part of — no sixth KPI', () => {
    const html = renderToStaticMarkup(<KpiRow ctx={context()} />);
    assert.equal((html.match(/class="cgx-kpi"/g) ?? []).length, 5);
    assert.match(html, /Billable Calls<\/span><span class="cgx-kpi__value">132<\/span><span class="cgx-kpi__sub">of 400 total calls<\/span>/);
  });

  it('a withheld comparison is said once, in the header, where there is no brief to say it', () => {
    const note = 'Not compared: Loop’s call record starts Aug 14, after the comparison period began.';
    const ctx = context({ period: 'monthly', date: '2026-09-18' }, {
      coverage: { recordStartsAt: new Date('2026-08-14T13:00:00Z'), comparison: 'BEFORE_RECORD', currentPartial: false, note },
    });
    const section = renderToStaticMarkup(<CommandShell ctx={ctx} active="money" path="/m"><p>w</p></CommandShell>);
    assert.match(section, /class="cgx-period-line cgx-period-line--cov"/);
    assert.ok(section.includes(`<span class="cgx-period-line__cov">${note}</span>`));
    const overview = renderToStaticMarkup(<CommandShell ctx={ctx} active="overview" path="/m" executive={<p>brief</p>}><p>w</p></CommandShell>);
    assert.equal(overview.includes(note), false, 'on the Overview the brief says it');
  });

  it('on a phone the header and KPIs compress, and all five KPIs stay', () => {
    const css = read('../src/app/loop-os.css');
    const phone = /@media \(max-width: 480px\) \{([\s\S]*?)\n\}/.exec(css.slice(css.indexOf('/* A phone: the health line')))![1]!;
    assert.match(phone, /\.cgx-kpis \{ grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
    assert.match(phone, /\.cgx-eyebrow, \.cgx-sub, \.cgx-period-line__when \{ display: none; \}/);
    for (const kept of ['.cgx-kpis', '.cgx-kpi__value', '.cgx-kpi__change', '.cgx-health', '.cgx-prio', '.cgx-prio__open']) {
      assert.equal(new RegExp(`\\${kept}[^{]*\\{[^}]*display: none`).test(phone), false, `${kept} is never hidden on a phone`);
    }
  });
});

describe('a situation reads in words and units', () => {
  it('REGRESSION (PR #300 review): no internal metric key or raw fraction on the situation page', () => {
    const ev = (over: Record<string, unknown>) => ({
      id: 'e', findingId: 'f', sourceType: 'call_projection', providerReport: 'CallGrid', metricKey: 'billableRate',
      entityType: 'window', entityId: null, entityName: null, window: 'Today · Live', providerField: null,
      rawValue: null, normalizedValue: null, derivedValue: null, formula: null, formulaVersion: null,
      classification: 'DERIVED', completeness: 1, notes: null, ...over,
    });
    const finding = {
      id: 'efficiency:billable-rate', findingType: 'OPERATIONAL', title: 'Billable rate increased 34%', plainLanguageSummary: 'x',
      classification: 'DERIVED', severity: 'NOTABLE', confidence: 0.9, currentWindow: 'Today · Live', comparisonWindow: 'Yesterday · through 7:51 PM',
      primaryMetric: 'billableRate', currentValue: 0.332, comparisonValue: 0.249, absoluteChange: null, percentageChange: 0.336,
      affectedEntities: [], drivers: [], limitations: [], unknowns: [], recommendedReview: null, recommendedActionType: null,
      actionTarget: null, actionSafety: 'SAFE_TO_REVIEW', createdAt: NOW.toISOString(), ruleId: 'billable-efficiency', ruleVersion: 'v1',
      supportingEvidence: [
        ev({ id: 'e1', metricKey: 'billableCalls', normalizedValue: 112, providerField: 'monetized' }),
        ev({ id: 'e2', metricKey: 'revenue', normalizedValue: 413_200, providerField: 'revenueCents' }),
        ev({ id: 'e3', metricKey: 'billableRate', derivedValue: 0.332, formula: 'billableCalls / totalCalls', formulaVersion: 'v1' }),
      ],
    } as never;
    const html = renderToStaticMarkup(<EvidenceDrawer finding={finding} />);
    const cells = [...html.matchAll(/<td[^>]*>([^<]*)</g)].map((m) => m[1]);
    assert.ok(cells.includes('Billable rate') && cells.includes('Billable calls') && cells.includes('Revenue'), cells.join(' | '));
    assert.ok(cells.includes('33.2%') && cells.includes('$4,132') && cells.includes('112'), cells.join(' | '));
    assert.match(html, /billable calls \/ total calls \(v1\)/);
    assert.equal(cells.some((c) => /^(billableRate|billableCalls|0\.332|413,200)$/.test(c ?? '')), false);

    // The situation page takes its measured values and recorded evidence from the same words.
    const queue = code(read(`${MKT}/queue-ui.tsx`));
    assert.doesNotMatch(queue, /lead\.primaryMetric/);
    assert.match(queue, /measuredValuesOf\(lead\)/);
    const page = code(read(`${MKT}/intelligence/[id]/page.tsx`));
    assert.doesNotMatch(page, /\{v\.metricKey\}/);
    assert.match(page, /metricLabel\(v\.metricKey\)/);
  });
});

describe('freshness is truthful', () => {
  it('Live carries the time CallGrid delivered, never the time the page rendered', () => {
    const ctx = context();
    const html = renderToStaticMarkup(<FreshnessBadge freshness={ctx.freshness} />);
    assert.match(html, /cgx-fresh--live/);
    assert.match(html, /Live · Updated 6:27 PM UTC/, 'three minutes before now, in the reader’s zone');
    const stale = assessCallGridFreshness({
      now: NOW, readOk: true, periodLive: true, lastDeliveryAt: new Date(NOW.getTime() - 6 * 3_600_000),
      pollCompletedThrough: null, recentDeliveries: [], factsOk: true,
    });
    const staleHtml = renderToStaticMarkup(<FreshnessBadge freshness={stale} />);
    assert.match(staleHtml, /Stale/);
    assert.equal(staleHtml.includes('Live'), false);
    // The render clock is not a freshness source anywhere in the shell.
    const ui = code(read(`${MKT}/command-ui.tsx`));
    assert.equal(/Updated \$\{clock\(ctx\.now\)|updatedClock\(now\)/.test(ui), false);
  });
});

describe('the period survives every move', () => {
  it('Daily / Weekly / Monthly switch on the current page, keeping the reader’s place', () => {
    const html = renderToStaticMarkup(<PeriodBar ctx={context({ period: 'daily', date: '2026-09-10' })} path="/app/admin/marketplace/buyers" />);
    assert.match(html, /href="\/app\/admin\/marketplace\/buyers\?period=weekly&amp;date=2026-09-07"/);
    assert.match(html, /href="\/app\/admin\/marketplace\/buyers\?period=monthly"/);
    assert.match(html, /aria-label="Previous period" href="\/app\/admin\/marketplace\/buyers\?period=daily&amp;date=2026-09-09"/);
    assert.match(html, /aria-current="page"[^>]*>Daily</);
    assert.match(html, />Thu, Sep 10, 2026</);
    // Today: nothing to go forward to.
    const today = renderToStaticMarkup(<PeriodBar ctx={context()} path="/app/admin/marketplace" />);
    assert.equal(/aria-label="Next period"/.test(today), false);
    // Legacy ranges are still reachable, as links and a GET form -- no client script.
    assert.match(html, /href="\/app\/admin\/marketplace\/buyers\?range=last_7_days"/);
    assert.match(html, /<form method="get" action="\/app\/admin\/marketplace\/buyers"/);
  });

  it('the section selector carries the period to every section, and Intelligence is one of them', () => {
    const html = renderToStaticMarkup(<CallGridNav active="money" rangeQuery="period=monthly&date=2026-07-01" />);
    for (const s of CALLGRID_SECTIONS) assert.ok(html.includes(`href="${s.href}?period=monthly&amp;date=2026-07-01"`), s.key);
    assert.deepEqual(CALLGRID_SECTIONS.map((s) => s.label), ['Overview', 'Money', 'Buyers', 'Vendors', 'Sources', 'Campaigns', 'Bids', 'Intelligence']);
    assert.equal(withQuery('/app/admin/marketplace/buyers/b1', 'period=weekly&date=2026-08-31'), '/app/admin/marketplace/buyers/b1?period=weekly&date=2026-08-31');
  });

  it('drilldowns and situation links keep the selection', () => {
    const detail = code(read(`${MKT}/entity-detail.tsx`));
    assert.match(detail, /withQuery\(`\$\{BASE\}\/\$\{dim\}\/\$\{encodeURIComponent\(r\.key\)\}`, query\)/);
    const exec = code(read(`${MKT}/executive-data.ts`));
    assert.match(exec, /withQuery\(`\/app\/admin\/marketplace\/intelligence\/\$\{encodeURIComponent\(item\.record\.id\)\}`, ctx\.query\)/);
  });
});

describe('every CallGrid page states its own authority, and reads only its own organization', () => {
  const PAGES = [
    'page.tsx', 'money/page.tsx', 'intelligence/page.tsx', 'intelligence/[id]/page.tsx',
    'buyers/page.tsx', 'vendors/page.tsx', 'campaigns/page.tsx', 'sources/page.tsx', 'bids/page.tsx', 'activity/page.tsx',
    'buyers/[key]/page.tsx', 'vendors/[key]/page.tsx', 'sources/[key]/page.tsx', 'campaigns/[key]/page.tsx',
  ];
  it('the first await is the ADMIN workspace AND intelligence:view — the nav item’s own authority', () => {
    for (const p of PAGES) {
      const src = code(read(`${MKT}/${p}`));
      const body = src.slice(src.indexOf('export default async function'));
      const first = body.match(/await ([^;]+);/)?.[1] ?? '';
      assert.match(first, /^requireWorkspacePermission\(["']ADMIN["'], ["']intelligence["'], ["']view["']\)/, p);
    }
  });

  it('the organization is the session’s; no URL key is authority', () => {
    const loader = code(read(`${MKT}/command-data.ts`));
    // A page's context is the session's organization, always.
    assert.match(loader, /return loadCommandContextFor\(session\.organizationId, searchParams, \{ session, canAct: \(\) => hasPermission\('intelligence', 'update'\) \}\);/);
    // The one other caller is the scheduled detection route, which takes organizations from the
    // database and nothing from its request (intelligence-triggers.test.tsx).
    const callers = walkSrc(fileURLToPath(new URL('../src', import.meta.url))).filter((f) => /loadCommandContextFor\(/.test(code(readFileSync(f, 'utf8'))));
    assert.deepEqual(
      callers.map((f) => f.slice(f.indexOf('/src/'))).sort(),
      ['/src/app/api/internal/intelligence/callgrid/route.ts', '/src/app/app/admin/marketplace/command-data.ts'],
    );
    for (const p of [...PAGES, 'entity-detail.tsx', 'command-data.ts', 'executive-data.ts', 'call-dimension-page.tsx']) {
      const src = code(read(`${MKT}/${p}`));
      for (const forbidden of ["searchParams?.organizationId", "params.organizationId", "get('organizationId')", 'get("organizationId")']) {
        assert.equal(src.includes(forbidden), false, `${p}: ${forbidden}`);
      }
    }
    // Entity pages narrow the session organization's calls by key; the repository is tested to be org-scoped.
    assert.match(code(read(`${MKT}/command-data.ts`)), /windowFacts\(organizationId, window\.start, window\.end, \{ buckets: buckets\.current, entity \}\)/);
    // A situation is found within the organization: another tenant's id is not-found.
    const situation = code(read(`${MKT}/intelligence/[id]/page.tsx`));
    assert.match(situation, /loadPriorityDetail\(ctx\.organizationId, params\.id\)/);
    assert.match(situation, /if \(!detail\) notFound\(\);/);
  });
});

describe('nothing moved off the Overview was deleted', () => {
  it('Intelligence holds the queue with every decision control, the story, the risk model, Loop’s record and the limits', () => {
    const intel = code(read(`${MKT}/intelligence/page.tsx`));
    for (const piece of ['<SituationRow', '<DecisionActivitySection', '<OpenWorkSection', '<TodaysStorySection', '<MarketplaceRiskPanel', '<OpportunitiesSection', '<FindingList', '<UnknownGroups']) {
      assert.ok(intel.includes(piece), piece);
    }
    assert.match(intel, /shown\.slice\(0, CARD_LIMIT\)\.map\(\(item, i\) => \(/, 'the first few as full cards');
    assert.match(intel, /shown\.slice\(CARD_LIMIT\)\.map\(\(item, i\) => \{/, 'and every other matching situation as a row — none dropped');
    // The decision actions are the same server actions as before.
    const queue = code(read(`${MKT}/queue-ui.tsx`));
    assert.match(queue, /resolve: resolveAction,\s*dismiss: dismissAction,/);
    const detail = code(read(`${MKT}/intelligence/[id]/page.tsx`));
    for (const a of ['assignAction', 'watchAction', 'resolveAction', 'dismissAction', 'markReviewedAction']) assert.ok(detail.includes(a), a);
    const actions = code(read(`${MKT}/operational-actions.ts`));
    assert.match(actions, /if \(!raw\.startsWith\(MARKETPLACE_ROOT\)\) return MARKETPLACE_ROOT;/, 'a situation page is a valid place to return to');
  });

  it('a situation page lays out the evidence and the limits, and the dimension intelligence is one click away', () => {
    const queue = code(read(`${MKT}/queue-ui.tsx`));
    const detail = queue.slice(queue.indexOf('export function SituationDetail'));
    for (const piece of ['What happened', 'Why it matters', 'Suggested action', '<ReadBlock', '<ChainView', '<EvidenceDrawer', 'Limits — what Loop cannot determine', '<DecisionTimeline', '<DecisionActions']) {
      assert.ok(detail.includes(piece), piece);
    }
    const dims = code(read(`${MKT}/call-dimension-page.tsx`));
    for (const piece of ['<DecisionSupportSection', '<ReasoningSection', '<BusinessHealthSection', '<StabilitySection', '<ContributionTable', '<UnknownsSection', '<BusinessStorySection']) {
      assert.ok(dims.includes(piece), piece);
    }
    // Old routes still resolve; the old client date picker is gone.
    assert.ok(existsSync(fileURLToPath(new URL(`${MKT}/activity/page.tsx`, import.meta.url))));
    assert.equal(existsSync(fileURLToPath(new URL(`${MKT}/CallGridDateRange.tsx`, import.meta.url))), false);
  });
});

describe('workspaces say what the data cannot', () => {
  it('the Bids funnel fences the snapshot from the period and infers no stage', () => {
    const bids = code(read(`${MKT}/bids/page.tsx`));
    assert.match(bids, /Bid snapshot · one provider day, UTC/);
    assert.match(bids, /Bids by campaign or by buyer/);
    assert.match(bids, /Buyer caps, concurrency or capacity/);
    assert.equal(/capacityCents|capacity:\s*\d|supply\s*>\s*demand/i.test(bids), false, 'no invented capacity figure');
  });

  it('a chart leaves an unknown bucket as a gap and a list with nothing says so', () => {
    const chart = renderToStaticMarkup(
      <TrendChart buckets={[]} current={[]} comparison={null} currentLabel="Today" comparisonLabel={null} format={String} title="t" />,
    );
    assert.match(chart, /No calls in this period to chart\./);
    const bars = renderToStaticMarkup(<BarList rows={[]} format={() => ''} empty="No buyer revenue in this period." />);
    assert.match(bars, /No buyer revenue in this period\./);
  });

  it('Intelligence filters narrow by state, entity, kind, evidence and metric — and name no person or organization', () => {
    const f = readIntelFilter({ lane: 'watching', entity: 'buyer', kind: 'risk', confidence: 'high', metric: 'revenue', organizationId: 'org_b' });
    assert.deepEqual(f, { lane: 'watching', entity: 'buyer', kind: 'risk', confidence: 'high', metric: 'revenue' });
    assert.equal(readIntelFilter({ lane: 'everything' }).lane, 'needs-review');
    assert.equal(intelQuery('period=daily', f), 'period=daily&lane=watching&entity=buyer&kind=risk&confidence=high&metric=revenue');
    const s = {
      opportunity: null, cards: [{ evidenceStrength: 'HIGH' }], unknowns: [], observationCount: 1,
      escalation: { withheld: false }, score: { determinacy: 1 },
      observations: [{ findingType: 'CONCENTRATION', primaryMetric: 'revenue', affectedEntities: [{ entityType: 'buyer', entityId: 'b1' }], supportingEvidence: [], limitations: [] }],
    } as never;
    assert.equal(matchesIntelFilter({ situation: s, state: 'WATCHING' }, f), true);
    assert.equal(matchesIntelFilter({ situation: s, state: 'RESOLVED' }, f), false);
    assert.equal(matchesIntelFilter({ situation: s, state: 'WATCHING' }, { ...f, entity: 'source' }), false);
  });
});

// CALLGRID INTELLIGENCE AS A LAYERED OPERATING SYSTEM: executive overview → functional
// workspaces → entity drilldown → situation → evidence.
//
// Renders the real shell parts with a prepared context (renderToStaticMarkup + markup
// assertions), and asserts the properties of the code that one render cannot show:
// every page states its own authority first, the executive surface names at most
// three priorities, and nothing that used to be on the Overview was deleted.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  assessCallGridFreshness,
  callGridBuckets,
  callGridKpis,
  describeCallGridWindow,
  readCallGridSelection,
  type CallGridBrief,
} from '@emgloop/shared';

import { CallGridNav, CALLGRID_SECTIONS } from '../src/app/app/admin/marketplace/_CallGridNav';
import { FreshnessBadge, KpiRow, PeriodBar, TrendChart, BarList } from '../src/app/app/admin/marketplace/command-ui';
import { TodaysBrief, TopPriorities } from '../src/app/app/admin/marketplace/executive-ui';
import { withQuery, type CommandContext } from '../src/app/app/admin/marketplace/command-data';
import { readIntelFilter, intelQuery, matchesIntelFilter } from '../src/app/app/admin/marketplace/intelligence-filter';

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

  it('the brief shows each sentence’s basis behind View details, and claims to be nothing but arithmetic', () => {
    const brief: CallGridBrief = {
      band: 'WATCH',
      sentences: [
        { text: 'Calls are down 15% versus yesterday to the same time.', basis: 'ARITHMETIC', detail: '400 calls against 470' },
        { text: 'Buyer concentration is the weakest measured signal.', basis: 'READING', detail: null },
        { text: 'Only 90% of calls carried a revenue value.', basis: 'UNKNOWN', detail: null },
      ],
    };
    const html = renderToStaticMarkup(<TodaysBrief brief={brief} title="Today’s brief" analyzedAt={NOW} detailsHref="/i" healthNote={null} />);
    assert.match(html, /Business health: <strong class="cgx-health__band">Watch<\/strong>/);
    assert.match(html, /<summary class="cgx-brief__more">View details<\/summary>/);
    assert.match(html, /Arithmetic on measured values/);
    assert.match(html, /Loop’s reading/);
    assert.match(html, /Not known/);
    assert.match(html, /Nothing here is a model’s summary/);
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
    assert.match(loader, /const organizationId = session\.organizationId;/);
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

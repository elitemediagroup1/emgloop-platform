// Loop Home as the front door (Matt, 2026-09-24): Executive KPIs → Your briefing → Headlines →
// (Your day | Needs you | Recent activity) → Your tools & spaces.
//
// Home COMPOSES existing authorities and never becomes one. These tests hand the pure projections
// (kpis.ts, tiles.ts) the authorities' outputs and read the plan back; render the front-door views
// to markup; and pin, at source level, the gates the server-only reads stand behind. They prove:
// nothing on Home is a hardcoded identity; a figure Loop does not have is a word, never 0; the
// comparison is the window's own; the today-so-far-vs-yesterday-complete path is gone; Headlines
// come from the Headline authority with their own fields and links; the tiles exist only where the
// rail leads and say honestly when a domain is not connected or could not be read.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { callGridKpis, createTimeView, productLabel, type AttentionAssessment, type HeadlineView } from '@emgloop/shared';
import { matrixAllows } from '@emgloop/database';
import { LOOP_NAV, visibleNav, type NavGroup } from '../src/workspaces/config';
import { resolveWorkspaceRole } from '../src/workspaces/role-router';
import { composeBriefing, type BriefingInput, type BriefingToday, type QueueInstance } from '../src/app/app/_home/briefing';
import { NeedsAttention } from '../src/app/app/_home/briefing-view';
import { kpiWords, HOME_KPI_KEYS, projectHomeKpis, type HomeKpiInput, type HomeKpiStrip } from '../src/app/app/_home/kpis';
import { projectTiles, type NeedsYouTileItem, type TelegramTileInput, TILE_PATHS, type TilesInput } from '../src/app/app/_home/tiles';
import { HeadlinesPanel, KpiStrip, RecentActivityPanel, ToolsGrid, HEADLINES_ON_HOME } from '../src/app/app/_home/front-door-view';
import type { HeadlineCaseState } from '../src/app/app/_home/front-door-data';
import type { ActivityItem } from '../src/app/app/admin/workspace-home-data';

const NY = 'America/New_York';
const NOW = new Date('2026-09-24T15:30:00Z');
const time = createTimeView({ timeZone: NY, source: 'device' }, NOW);
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const HOME = join(SRC, 'app/app/_home');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const homeFiles = () => readdirSync(HOME).filter((f) => /\.tsx?$/.test(f)).map((f) => join('app/app/_home', f));

const navForRole = (systemRole: string): NavGroup[] =>
  visibleNav(LOOP_NAV.nav, {
    workspace: resolveWorkspaceRole({ systemRole }),
    permitted: (item) => matrixAllows(systemRole, item.requires!.resource, item.requires!.action),
  });
const OWNER_NAV = navForRole('OWNER');
const EMPLOYEE_NAV = navForRole('EMPLOYEE');

// --- fixtures ----------------------------------------------------------------------------------------

type Metrics = Parameters<typeof callGridKpis>[0]['metrics'];
const metrics = (over: Partial<Metrics> = {}): Metrics => ({ available: true, totalCalls: 20, billableCalls: 14, revenueCents: 112_000, profitCents: 61_000, costCents: 400, revenueCoverage: 1, profitCoverage: 1, ...over });

function kpiInput(over: { current?: Partial<Metrics>; comparison?: Partial<Metrics> | null; withheld?: boolean; ok?: boolean; freshness?: HomeKpiInput['freshness']; campaigns?: HomeKpiInput['report']['dimensions']['campaigns'] } = {}): HomeKpiInput {
  const m = over.ok === false ? metrics({ ...over.current, available: false, totalCalls: null, billableCalls: null, revenueCents: null, profitCents: null, costCents: null }) : metrics(over.current);
  const c = over.comparison === null ? null : metrics({ totalCalls: 20, billableCalls: 9, revenueCents: 85_000, profitCents: 40_000, ...(over.comparison ?? {}) });
  return {
    kpis: callGridKpis({ keys: HOME_KPI_KEYS, metrics: m, comparison: c, series: [], comparisonWithheld: over.withheld }),
    window: { label: 'Sep 24, 2026', includesLiveData: true, comparisonLabel: c ? 'Yesterday to the same time' : null },
    coverage: { note: over.withheld ? 'Not compared: Loop’s call record starts Sep 24, after the comparison period began.' : null },
    freshness: over.freshness ?? { state: 'LIVE', word: 'Live', detail: 'CallGrid delivered data 3 min ago.' },
    report: { ok: over.ok ?? true, metrics: m, dimensions: { campaigns: over.campaigns ?? [{ label: 'Campaign 1', monetized: 3, revenueCents: 50_000 }, { label: 'Campaign 2', monetized: 0, revenueCents: null }, { label: 'Campaign 3', monetized: 0, revenueCents: 1_000 }, { label: 'Campaign 4', monetized: 0, revenueCents: 0 }] } },
    query: 'period=day',
  };
}
const strip = (over: Parameters<typeof kpiInput>[0] = {}): HomeKpiStrip => projectHomeKpis(kpiInput(over));

function headline(over: Partial<HeadlineView> = {}): HeadlineView {
  return {
    id: 'h1',
    performanceObjectiveId: 'obj1',
    objectiveTitle: 'Grow roofing lead revenue in Texas',
    measureBindingId: 'b1',
    measureBindingVersion: 1,
    measurement: {
      metric: 'REVENUE' as HeadlineView['measurement']['metric'],
      metricLabel: 'Revenue',
      unit: 'USD' as HeadlineView['measurement']['unit'],
      movement: 'DECREASE',
      againstObjective: true,
      currentValue: 4180,
      priorValue: 6940,
      absoluteChange: -2760,
      percentageChange: -0.398,
      currentDenominator: 14,
      priorDenominator: 14,
      currentCoverage: 0.86,
      priorCoverage: 0.93,
      comparisonBasis: 'week over week',
      currentWindowStart: '2026-09-15',
      currentWindowEnd: '2026-09-22',
      priorWindowStart: '2026-09-08',
      priorWindowEnd: '2026-09-15',
    },
    statement: 'Roofing lead revenue in Texas: $4,180 this week vs $6,940 last week (−40%)',
    limitations: [],
    unknowns: [],
    ruleId: 'ci.week-over-week',
    ruleVersion: '1',
    producerVersion: '1',
    ruleDescription: 'movement against an objective you set',
    firstDetectedAt: '2026-09-23T06:10:00Z',
    lastDetectedAt: '2026-09-24T06:10:00Z',
    detectionCount: 2,
    dismissedAt: null,
    dismissedByUserId: null,
    dismissedByName: null,
    dismissalBasis: null,
    createdAt: '2026-09-23T06:10:00Z',
    ...over,
  };
}
function attention(state: AttentionAssessment['state'], over: Partial<AttentionAssessment> = {}): AttentionAssessment {
  const statements: Record<AttentionAssessment['state'], string> = {
    NEEDS_ATTENTION: 'One thing needs your attention.',
    ALL_CLEAR: 'No material changes require your attention. Loop checked 3 active objectives and every eligible measurement window is current.',
    INSUFFICIENT_COVERAGE: "Loop can't determine whether anything requires attention. 1 of 3 objectives has incomplete measurement coverage.",
    NOTHING_TO_CHECK: 'Loop has nothing to check: no active objective says what this organization is trying to accomplish.',
  };
  return { ruleVersion: 'attention-state.v1', state, objectivesConsidered: 3, objectivesMeasurable: state === 'INSUFFICIENT_COVERAGE' ? 2 : 3, unmeasurable: [], headlineCount: state === 'NEEDS_ATTENTION' ? 1 : 0, statement: statements[state], notKnown: state === 'INSUFFICIENT_COVERAGE' ? ['1 of 3 objectives could not be measured: Grow roofing lead revenue in Texas.'] : [], ...over };
}
const cases = (entries: [string, HeadlineCaseState][]): ReadonlyMap<string, HeadlineCaseState> => new Map(entries);

function activity(over: Partial<ActivityItem> = {}): ActivityItem {
  return { id: 'a1', label: 'Completed Edit on “Kona unboxing — cut A”', actorName: 'Dana Rivera', category: 'work', createdAtIso: '2026-09-24T14:02:00Z', ...over };
}

const READ_DAY: BriefingToday['calendar'] = { state: 'READ', current: true, readAt: new Date(NOW.getTime() - 4 * 60_000), failed: false };
function today(over: Partial<BriefingToday> = {}): BriefingToday {
  return {
    calendar: READ_DAY,
    events: [],
    allDayCount: 0,
    inProgress: null,
    next: null,
    minutesUntilNext: null,
    afternoonClear: null,
    lastSyncedAt: READ_DAY.state === 'READ' ? READ_DAY.readAt : null,
    due: [],
    mail: { state: 'READ', current: true, readAt: new Date(NOW.getTime() - 4 * 60_000), failed: false },
    mailCounts: { needsReply: 3, followUps: 1, waiting: 2, current: true },
    ...over,
  };
}
/** The viewer's OWN Telegram obligations, as Needs you lists them: minimized topics, the source's labels, never a message. */
const NEEDS_YOU: NeedsYouTileItem[] = [
  { provider: 'TELEGRAM', category: 'REQUEST', counterparty: 'Ana R.', topic: 'creative assets for the new landing page', title: 'Ana asked for the creative assets', deadline: null, at: new Date(NOW.getTime() - 3 * 3600_000) },
  { provider: 'TELEGRAM', category: 'DECISION_NEEDED', counterparty: 'Ana R.', topic: 'budget for October', title: 'Ana needs a decision on the October budget', deadline: 'by Friday', at: new Date(NOW.getTime() - 2 * 3600_000) },
  { provider: 'TELEGRAM', category: 'BUSINESS_CHANGE', counterparty: 'Ops group', topic: 'adding another pest-control traffic source', title: 'The ops group discussed adding another pest-control traffic source', deadline: null, at: new Date(NOW.getTime() - 3600_000) },
  { provider: 'TELEGRAM', category: 'FOLLOW_UP', counterparty: null, topic: null, title: 'Someone is waiting on the contract', deadline: null, at: new Date(NOW.getTime() - 6 * 3600_000) },
];
const TELEGRAM: TelegramTileInput = {
  permitted: true,
  configured: true,
  state: 'READY',
  words: { label: 'Ready', tone: 'good', detail: 'Observing. Last checked 5 minutes ago.' },
  lastObservedAt: new Date(NOW.getTime() - 5 * 60_000),
  contentAuthorized: true,
  activity: { since: new Date(NOW.getTime() - 24 * 3600_000), messages: 14, conversations: 5 },
};
function tilesInput(over: Partial<TilesInput> = {}): TilesInput {
  return {
    groups: OWNER_NAV,
    today: today(),
    needsYou: NEEDS_YOU,
    mailInflow: { needsReply: 2, followUps: 1, waiting: 0 },
    telegram: { ok: true, value: TELEGRAM },
    work: { kind: 'ADMIN', summary: { ok: true, value: { assignedToMe: 4, readyNow: 2, waitingBlocked: 1, completedToday: 2 } } },
    intake: { ok: true, value: { New: 12, Contacted: 5, Quoted: 2, Booked: 1, Completed: 40, Archived: 9 } },
    creators: { ok: true, value: [{ needsEmg: 2, needsCreator: 1, inProduction: 3, dueSoon: 1 }, { needsEmg: 0, needsCreator: 0, inProduction: 0, dueSoon: 0 }] },
    callgrid: { ok: true, value: strip() },
    time,
    ...over,
  };
}
const tileByKey = (input: TilesInput, key: string) => projectTiles(input).find((t) => t.key === key) ?? null;

// --- nothing is hardcoded --------------------------------------------------------------------------

describe('Home is personalized from the session and the authorities, never from a mock-up', () => {
  it('no name, place, organization, weather, count or figure is a literal anywhere under _home', () => {
    for (const file of homeFiles()) {
      const src = code(read(file));
      for (const literal of ['Matt', 'Charlie', 'EMG', 'Elite Media', 'Staten Island', 'weather', '°F', 'sunny']) {
        assert.equal(new RegExp(`\\b${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(src), false, `${file} hardcodes "${literal}"`);
      }
      assert.equal(/\$\d/.test(src), false, `${file} carries a dollar figure`);
    }
    // The greeting comes from the operational home's header (its own read of the signed-in user) or the reader's clock.
    const admin = code(read('app/app/_home/admin-home.tsx'));
    assert.match(admin, /title=\{`\$\{header\?\.greeting \?\? time\.greeting\(\)\}, \$\{header\?\.displayName \?\? session\.name\}`\}/);
    assert.match(code(read('app/app/_home/module-home.tsx')), /title=\{`\$\{time\.greeting\(\)\}, \$\{name\}`\}/);
  });

  it('the today-so-far against yesterday-complete scorecard is gone from Home', () => {
    assert.equal(existsSync(join(SRC, 'app/app/admin/dashboard-data.ts')), false);
    for (const file of homeFiles()) {
      const src = code(read(file));
      for (const forbidden of ['dashboard-data', 'DashboardData', 'easternYesterdayWindow', 'easternTodayWindow', 'yesterday complete', 'PulsePanel', 'BriefingPulse']) {
        assert.equal(src.includes(forbidden), false, `${file}: ${forbidden}`);
      }
    }
  });
});

// --- executive KPIs --------------------------------------------------------------------------------

describe('the executive KPI row is the Command Center’s own context, in words', () => {
  it('shows the contract’s KPIs with the contract’s values and the window’s own comparison label', () => {
    const s = strip();
    assert.equal(s.state, 'OK');
    // The spec's executive row, in its order: Revenue, Net profit, Billable calls, Total calls, Active campaigns.
    assert.deepEqual(s.kpis.map((k) => k.key), ['revenue', 'netProfit', 'billableCalls', 'totalCalls', 'activeCampaigns']);
    assert.deepEqual(s.kpis.map((k) => k.value), ['$1,120', '$610', '14', '20', '2']);
    // Total calls is built by the contract's rule with the same elapsed-matched comparison, and no direction is favorable.
    const total = s.kpis.find((k) => k.key === 'totalCalls')!;
    assert.equal(total.label, 'Total Calls');
    assert.ok(total.change !== null && total.change.favorable === null, 'more calls is neither good nor bad on its own');
    assert.equal(s.comparisonLabel, 'Yesterday to the same time');
    assert.equal(s.periodLabel, 'Today so far');
    assert.deepEqual(s.kpis.find((k) => k.key === 'billableCalls')!.change, { direction: 'up', text: '56%', favorable: true });
    assert.equal(s.kpis.find((k) => k.key === 'billableCalls')!.subline, 'of 20 total calls');
    // Active campaigns is OBSERVED (a billable call or revenue in the window), never a roster, and its tile says so.
    const campaigns = s.kpis.find((k) => k.key === 'activeCampaigns')!;
    assert.equal(s.activeCampaigns, 2, 'monetized or revenue > 0; a null or zero revenue with no billable call is not active');
    assert.match(campaigns.subline!, /produced revenue or billable calls in the selected period/);
    assert.match(campaigns.note!, /CallGrid exposes no roster/);
    assert.equal(campaigns.change, null);
    assert.match(campaigns.noChangeReason!, /not compared/i);
    assert.equal(campaigns.href, '/app/admin/marketplace/campaigns?period=day');
    assert.equal(s.kpis[0]!.href, '/app/admin/marketplace/money?period=day#kpi-revenue');
  });

  it('a figure Loop does not have is a word, never 0; a comparison the record does not cover is withheld with its reason', () => {
    const unknown = strip({ current: { revenueCents: null, profitCents: null, revenueCoverage: 0, profitCoverage: 0 } });
    assert.deepEqual(unknown.kpis.slice(0, 2).map((k) => [k.state, k.value]), [['UNKNOWN', 'Unknown'], ['UNKNOWN', 'Unknown']]);
    const unavailable = strip({ ok: false });
    assert.equal(unavailable.state, 'UNAVAILABLE');
    for (const k of unavailable.kpis) assert.equal(k.value, 'Unavailable', k.key);
    assert.equal(unavailable.activeCampaigns, null);
    assert.equal(kpiWords({ state: 'VALUE', value: -124_000, kind: 'money' }), '−$1,240', 'a negative net profit keeps its sign in front');
    assert.equal(kpiWords({ state: 'VALUE', value: 0, kind: 'count' }), '0', 'a real zero the report stated is a zero');
    const withheld = strip({ comparison: null, withheld: true });
    assert.equal(withheld.comparisonLabel, null);
    assert.equal(withheld.kpis[0]!.change, null);
    assert.equal(withheld.kpis[0]!.noChangeReason, 'No valid comparison.');
    assert.match(withheld.coverageNote!, /Not compared: Loop’s call record starts/);
    const noData = strip({ freshness: { state: 'UNAVAILABLE', word: 'No data', detail: 'Loop has not received any data from CallGrid yet.' } });
    assert.equal(noData.state, 'NO_DATA');
    // The projection is pure and deterministic.
    const src = code(read('app/app/_home/kpis.ts'));
    for (const forbidden of ["from '@emgloop/database'", 'prisma', 'fetch(', 'new Date()', 'Date.now(', "'server-only'", '?? 0', '|| 0']) assert.equal(src.includes(forbidden), false, forbidden);
    assert.deepEqual(strip(), strip());
  });

  it('drawn: five tiles, the period and comparison words once, each change against the window’s label; never "yesterday" alone', () => {
    const out = html(<KpiStrip strip={{ ok: true, value: strip() }} />);
    assert.match(out, /id="executive-kpis"[^>]*data-home-kpis="OK"/);
    assert.equal((out.match(/data-home-kpi="/g) ?? []).length, 5);
    assert.match(out, /data-home-kpi-period[^>]*>Today so far<span data-home-kpi-comparison[^>]*> · vs yesterday to the same time<\/span>/);
    assert.match(out, /data-home-kpi="netProfit" data-home-kpi-state="VALUE"[^>]*href="\/app\/admin\/marketplace\/money\?period=day#kpi-netProfit"/);
    assert.match(out, /data-home-kpi-change="up"[^>]*><span aria-hidden="true">↑<\/span> 53%<span class="loop-sr-only"> against Yesterday to the same time<\/span>/);
    assert.match(out, /data-home-kpi-freshness="LIVE"[^>]*>Live</);
    assert.equal(/\byesterday\b(?! to the same time)/i.test(out.replace(/Yesterday to the same time/g, '')), false, 'no bare "yesterday" against a partial day');
    // Unknown and unavailable figures are words; a "0" is never dressed as data for them.
    const unknown = html(<KpiStrip strip={{ ok: true, value: strip({ current: { revenueCents: null, profitCents: null, revenueCoverage: 0, profitCoverage: 0 } }) }} />);
    assert.match(unknown, /data-home-kpi="netProfit" data-home-kpi-state="UNKNOWN"[\s\S]*?is-word">Unknown</);
    assert.equal(/is-word">0</.test(unknown) || />\$0</.test(unknown), false);
    assert.match(unknown, /data-home-kpi-nochange[^>]*>Not known for both periods\./);
    const withheld = html(<KpiStrip strip={{ ok: true, value: strip({ comparison: null, withheld: true }) }} />);
    assert.equal(withheld.includes('data-home-kpi-comparison'), false);
    assert.match(withheld, /data-home-kpi-nochange[^>]*>No valid comparison\./);
    assert.match(withheld, /Not compared: Loop’s call record starts/);
    // Could not be read, never delivered, not offered: three different things, drawn differently.
    assert.match(html(<KpiStrip strip={{ ok: false }} />), /data-home-kpis="UNAVAILABLE"[\s\S]*Loop could not read CallGrid just now/);
    const noData = html(<KpiStrip strip={{ ok: true, value: strip({ freshness: { state: 'UNAVAILABLE', word: 'No data', detail: 'Loop has not received any data from CallGrid yet.' } }) }} />);
    assert.match(noData, /data-home-kpis="NO_DATA"[\s\S]*No data[\s\S]*has not received any data/);
    assert.equal(noData.includes('data-home-kpi="'), false);
    assert.equal(html(<KpiStrip strip={null} />), '', 'not offered: nothing, not an empty row');
  });
});

// --- Headlines ---------------------------------------------------------------------------------------

describe('Headlines on Home are the Headline authority’s own rows', () => {
  it('the read is the governed one, non-dismissed, and the assessment travels with it', () => {
    const review = code(read('app/app/_home/review-data.ts'));
    assert.match(review, /loadAttention\(organizationId, new Date\(\), \{ dismissed: false \}\)/);
    assert.match(review, /sink\.attention = result\.value\.attention;/);
    assert.match(review, /headlinesOffered: sink\.offered,/);
    const data = code(read('app/app/_home/front-door-data.ts'));
    assert.match(data, /loadCasesForHeadlines\(organizationId, headlineIds\)/, 'the investigation state is the Case keyed to the Headline, read once for the list');
    assert.match(data, /if \(!result\.ok\) return \[id, \{ state: 'UNKNOWN' \}\];/, 'a failed read is unknown, never "not investigated"');
  });

  it('renders the authority’s fields -- statement, objective, rule, first and last seen, investigation state -- with the Headline’s own link, capped at four', () => {
    const rows = [headline(), headline({ id: 'h2', statement: 'Solar leads in Arizona: 40 this week vs 22 last week (+82%)', measurement: { ...headline().measurement, againstObjective: false }, detectionCount: 1 })];
    const out = html(<HeadlinesPanel headlines={rows} attention={attention('NEEDS_ATTENTION')} cases={cases([['h1', { state: 'UNDER_INVESTIGATION', caseId: 'c1' }], ['h2', { state: 'NEW' }]])} time={time} href="/app/admin/headlines" />);
    assert.match(out, /id="headlines"/);
    assert.match(out, /href="\/app\/admin\/headlines"[^>]*>View all headlines →/);
    assert.match(out, /data-home-headline="h1" data-home-headline-case="UNDER_INVESTIGATION"/);
    assert.match(out, /href="\/app\/admin\/headlines\/h1"[^>]*>Roofing lead revenue in Texas: \$4,180 this week vs \$6,940 last week \(−40%\)</);
    assert.match(out, /Under investigation/);
    assert.match(out, /Grow roofing lead revenue in Texas/);
    assert.match(out, /data-home-headline-why[^>]*>Why: movement against an objective you set/);
    assert.match(out, /first seen <time datetime="2026-09-23T06:10:00Z">[^<]*<\/time> · last seen <time datetime="2026-09-24T06:10:00Z">/i);
    assert.match(out, /href="\/app\/admin\/headlines\/h1"[^>]*>Open investigation/);
    assert.match(out, /data-home-headline="h2" data-home-headline-case="NEW"[\s\S]*?Not yet investigated[\s\S]*?href="\/app\/admin\/headlines\/h2"[^>]*>Look into it/);
    assert.match(out, /2 open Headlines/);
    const many = html(<HeadlinesPanel headlines={Array.from({ length: 7 }, (_, i) => headline({ id: `h${i}` }))} attention={attention('NEEDS_ATTENTION')} cases={cases([])} time={time} href="/app/admin/headlines" />);
    assert.equal((many.match(/data-home-headline="/g) ?? []).length, HEADLINES_ON_HOME);
    assert.match(many, /3 more open Headlines →/);
    assert.match(many, /data-home-headline-case="UNKNOWN"[\s\S]*?Investigation not read/, 'a case read that failed is said, not defaulted to New');
    assert.equal(/\bnull\b|\bundefined\b/.test(out), false);
  });

  it('a review update or a mail row never becomes a Headline row; the aggregate Headlines row leaves Needs you when the panel is drawn', () => {
    const out = html(<HeadlinesPanel headlines={[headline()]} attention={attention('NEEDS_ATTENTION')} cases={cases([])} time={time} href="/app/admin/headlines" />);
    assert.equal((out.match(/data-home-headline="/g) ?? []).length, 1);
    const panel = code(read('app/app/_home/front-door-view.tsx'));
    assert.equal(/review\.updates|mail|ReviewUpdate|NeedsYouItem/.test(panel.slice(panel.indexOf('export function HeadlinesPanel'), panel.indexOf('// --- Recent activity'))), false, 'the panel takes HeadlineView rows and nothing else');
    const input: BriefingInput = { now: NOW, review: null, period: null, headlines: [headline()], needsYou: [], day: null, dayFailed: false, mail: null, mailFailed: false, callgrid: null, workDue: [], connectionsHref: '/app/connections', headlinesHref: '/app/admin/headlines', headlinesPanel: true };
    assert.equal(html(<NeedsAttention briefing={composeBriefing(input)} time={time} />).includes('data-briefing-attention="HEADLINES"'), false);
  });

  it('empty is the governed attention state: all clear names what it checked, a coverage gap says so, an unreadable read is a failure', () => {
    const clear = html(<HeadlinesPanel headlines={[]} attention={attention('ALL_CLEAR')} cases={cases([])} time={time} href="/app/admin/headlines" />);
    assert.match(clear, /data-home-headlines-empty="ALL_CLEAR"/);
    assert.match(clear, new RegExp(productLabel('ALL_CLEAR')!.label));
    assert.match(clear, /No qualifying Headlines right now\. No material changes require your attention\. Loop checked 3 active objectives/);
    const gap = html(<HeadlinesPanel headlines={[]} attention={attention('INSUFFICIENT_COVERAGE')} cases={cases([])} time={time} href="/app/admin/headlines" />);
    assert.match(gap, /data-home-headlines-empty="INSUFFICIENT_COVERAGE"/);
    assert.match(gap, new RegExp(productLabel('INSUFFICIENT_COVERAGE')!.label.replace("'", '&#x27;')));
    assert.match(gap, /1 of 3 objectives could not be measured: Grow roofing lead revenue in Texas\./);
    assert.equal(gap.includes('No qualifying Headlines'), false, 'a coverage gap is never all clear');
    const nothing = html(<HeadlinesPanel headlines={[]} attention={attention('NOTHING_TO_CHECK')} cases={cases([])} time={time} href="/app/admin/headlines" />);
    assert.match(nothing, /Loop has nothing to check/);
    const failed = html(<HeadlinesPanel headlines={null} attention={null} cases={cases([])} time={time} href="/app/admin/headlines" />);
    assert.match(failed, /Loop could not read Headlines just now/);
    assert.equal(failed.includes('No qualifying'), false);
  });
});

// --- Recent activity -------------------------------------------------------------------------------

describe('Recent activity is the audit log’s business events', () => {
  it('each row is an audit truth carrying its audit category, never a Headline; View all only where the rail leads', () => {
    const rows = [activity(), activity({ id: 'a2', label: 'Added intake record', actorName: 'Sun & Soil', category: 'customer', createdAtIso: '2026-09-24T13:00:00Z' })];
    const out = html(<RecentActivityPanel rows={rows} time={time} auditHref="/crm/audit" />);
    assert.match(out, /id="recent-activity"/);
    assert.equal((out.match(/data-truth="AUDIT"/g) ?? []).length, 2);
    assert.match(out, /data-home-activity-categories="work,customer"/);
    assert.match(out, /Completed Edit on “Kona unboxing — cut A” · Dana Rivera/);
    assert.match(out, /<dt>Area<\/dt><dd>Work<\/dd>/);
    assert.match(out, /<dt>Area<\/dt><dd>CRM<\/dd>/);
    assert.match(out, /<dt>Recorded by<\/dt><dd>the audit log<\/dd>/);
    assert.match(out, /datetime="2026-09-24T14:02:00Z"/i);
    assert.match(out, /href="\/crm\/audit"[^>]*>View all →/);
    for (const absent of ['data-home-headline', 'headline:', 'Roofing']) assert.equal(out.includes(absent), false, absent);
    assert.equal(html(<RecentActivityPanel rows={rows} time={time} auditHref={null} />).includes('View all'), false, 'no link the rail would not offer');
    assert.match(html(<RecentActivityPanel rows={[]} time={time} auditHref={null} />), /No business activity recorded yet\./);
    assert.match(html(<RecentActivityPanel rows={null} time={time} auditHref={null} />), /Loop could not read recent activity just now/);
    // The rows are the operational home's own: audit-derived, business events only, capped at six.
    const workspace = code(read('app/app/admin/workspace-home-data.ts'));
    assert.match(workspace, /\.filter\(\(a\) => a\.category !== 'auth' && a\.category !== 'system'\)\s*\.slice\(0, 6\)/);
  });
});

// --- tools & spaces ----------------------------------------------------------------------------------

describe('Your tools & spaces: a tile only where the rail leads and the domain was read', () => {
  it('for an owner every offered domain has a tile, each at its LOOP_NAV href with the registry’s label', () => {
    const tiles = projectTiles(tilesInput());
    assert.deepEqual(tiles.map((t) => [t.key, t.href, t.label]), [
      ['mail', '/app/mail', 'Mail'],
      ['chats', '/app/connections', 'Chats'],
      ['calendar', '/app/connections', 'Calendar'],
      ['work', '/app/admin/work', 'My Work'],
      ['intake', '/crm/pipeline', 'Intake Board'],
      ['callgrid', '/app/admin/marketplace', 'CallGrid Intelligence'],
      ['campaigns', '/app/admin/marketplace/campaigns', 'Campaigns'],
      ['creators', '/app/admin/creator-hub', 'Creator Hub'],
    ]);
    const navHrefs = new Set(LOOP_NAV.nav.flatMap((g) => g.items.map((i) => i.href)));
    for (const t of tiles) assert.ok(navHrefs.has(t.href) || t.href.startsWith(TILE_PATHS.marketplace + '/'), `${t.key} → ${t.href}`);
    assert.equal(tiles.some((t) => /pipeline|opportunit/i.test(t.label)), false, 'the intake board is never Pipeline or Opportunities');
    // Domain-local summaries, from each domain's own read.
    assert.deepEqual(tileByKey(tilesInput(), 'mail')!.metric, { value: '3', label: 'need a reply' });
    assert.deepEqual(tileByKey(tilesInput(), 'mail')!.lines, [
      'Since yesterday: 2 new messages that need a reply, 1 follow-up came due',
      '1 follow-up due',
    ]);
    // Chats: what is happening in the viewer's OWN conversations -- covered in depth below.
    assert.deepEqual(tileByKey(tilesInput(), 'chats')!.metric, { value: '3', label: 'conversations need you' });
    assert.deepEqual(tileByKey(tilesInput(), 'work')!.metric, { value: '4', label: 'assigned to you' });
    assert.deepEqual(tileByKey(tilesInput(), 'work')!.lines, ['2 ready now', '1 waiting or blocked', '2 completed today']);
    assert.deepEqual(tileByKey(tilesInput(), 'intake')!.metric, { value: '69', label: 'intake records' });
    assert.deepEqual(tileByKey(tilesInput(), 'intake')!.lines, ['New 12 · Contacted 5 · Quoted 2 · Booked 1']);
    assert.deepEqual(tileByKey(tilesInput(), 'callgrid')!.metric, { value: '14', label: 'billable calls today so far' });
    // CallGrid says what MOVED, in the contract's words, against the window's own comparison -- then freshness.
    assert.deepEqual(tileByKey(tilesInput(), 'callgrid')!.lines, [
      'Revenue ▲ 32% · Net Profit ▲ 53% · Billable Calls ▲ 56% against Yesterday to the same time',
      'Live · CallGrid delivered data 3 min ago.',
    ]);
    assert.deepEqual(tileByKey(tilesInput(), 'campaigns')!.metric, { value: '2', label: 'active today so far' });
    // Campaigns names the report's own leader (its rows are ordered by revenue); the roster caveat is status.
    assert.equal(tileByKey(tilesInput(), 'campaigns')!.lines[0], 'Most revenue today so far: Campaign 1');
    assert.equal(tileByKey(tilesInput(), 'campaigns')!.status, 'Observed in calls, not a roster');
    assert.deepEqual(tileByKey(tilesInput(), 'creators')!.metric, { value: '2', label: 'managed creators' });
    assert.deepEqual(tileByKey(tilesInput(), 'creators')!.lines, ['2 need your team', '3 in production', '1 due soon']);
  });

  it('a destination outside the rail yields no tile, whatever was read; the employee gets their own queue and nothing executive', () => {
    const noMail = projectTiles(tilesInput({ groups: OWNER_NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.href !== '/app/mail') })) }));
    assert.equal(noMail.some((t) => t.key === 'mail'), false);
    const employee = projectTiles(tilesInput({ groups: EMPLOYEE_NAV, work: { kind: 'EMPLOYEE', userId: 'me', queue: [] }, callgrid: null, creators: null }));
    assert.deepEqual(employee.map((t) => t.key), ['mail', 'chats', 'calendar', 'work', 'intake']);
    assert.equal(employee.find((t) => t.key === 'work')!.href, '/app/employee/work');
    // Even with executive reads handed in, the employee's rail has no CallGrid or Creators: no tile.
    const handed = projectTiles(tilesInput({ groups: EMPLOYEE_NAV, work: { kind: 'EMPLOYEE', userId: 'me', queue: [] } }));
    assert.equal(handed.some((t) => t.key === 'callgrid' || t.key === 'campaigns' || t.key === 'creators'), false);
    // The queue tile counts what is the person's to act on, by the same rule as "due today".
    const stage = (over: Partial<QueueInstance['stages'][number]> = {}) => ({ id: 's1', name: 'Edit', ownerUserId: 'me', status: 'ready', dueAt: null, ...over });
    const queue: QueueInstance[] = [
      { id: 'w1', title: 'Mine', currentStageId: 's1', expectedReturnAt: null, stages: [stage()] },
      { id: 'w2', title: 'Theirs', currentStageId: 's1', expectedReturnAt: null, stages: [stage({ ownerUserId: 'other' })] },
    ];
    const work = tileByKey(tilesInput({ groups: EMPLOYEE_NAV, work: { kind: 'EMPLOYEE', userId: 'me', queue } }), 'work')!;
    assert.deepEqual([work.metric, work.lines, work.state], [{ value: '2', label: 'items in your queue' }, ['1 ready for you', '1 waiting on someone else'], 'OK']);
  });

  it('a domain that is not connected, not read, could not be read or is not on this deployment says so -- never a zero', () => {
    const notConnected = tileByKey(tilesInput({ today: today({ mail: { state: 'NOT_CONNECTED', line: 'Mail isn’t connected.', href: '/app/connections', action: 'Connect Google' }, mailCounts: null }) }), 'mail')!;
    assert.deepEqual([notConnected.state, notConnected.stateLine, notConnected.href, notConnected.metric], ['NOT_CONNECTED', 'Not connected', '/app/connections', null]);
    const unreadMail = tileByKey(tilesInput({ today: today({ mail: { state: 'NOT_READ', line: 'Loop has not read your mail yet.' }, mailCounts: null }) }), 'mail')!;
    assert.deepEqual([unreadMail.state, unreadMail.stateLine], ['NOT_READ', 'Loop has not read your mail yet.']);
    const telegramOff = tileByKey(tilesInput({ telegram: { ok: true, value: { permitted: true, configured: true, state: 'NOT_CONNECTED', words: { label: 'Not connected', tone: 'neutral', detail: null }, lastObservedAt: null , contentAuthorized: false, activity: null} } }), 'chats')!;
    assert.deepEqual([telegramOff.state, telegramOff.stateLine, telegramOff.metric, telegramOff.linkLabel], ['NOT_CONNECTED', 'Not connected', null, 'Connect in Connections']);
    assert.equal(tileByKey(tilesInput({ telegram: { ok: true, value: null } }), 'chats'), null, 'no tile for a person who may not view connections');
    assert.deepEqual([tileByKey(tilesInput({ telegram: { ok: false } }), 'chats')!.state, tileByKey(tilesInput({ telegram: { ok: false } }), 'chats')!.stateLine], ['UNAVAILABLE', 'Could not be read']);
    assert.equal(tileByKey(tilesInput({ telegram: { ok: true, value: { permitted: true, configured: false, state: 'NOT_CONNECTED', words: { label: 'Not connected', tone: 'neutral', detail: null }, lastObservedAt: null , contentAuthorized: false, activity: null} } }), 'chats')!.state, 'NOT_AVAILABLE');
    const calendarOff = tileByKey(tilesInput({ today: today({ calendar: { state: 'NOT_CONNECTED', line: 'Calendar isn’t connected.', href: '/app/connections', action: 'Connect Calendar' } }) }), 'calendar')!;
    assert.deepEqual([calendarOff.state, calendarOff.stateLine, calendarOff.metric], ['NOT_CONNECTED', 'Not connected', null]);
    assert.equal(tileByKey(tilesInput({ today: today({ calendar: { state: 'NOT_CONFIGURED' } }) }), 'calendar'), null, 'not set up at all: nothing is said');
    assert.deepEqual([tileByKey(tilesInput({ intake: { ok: false } }), 'intake')!.state, tileByKey(tilesInput({ intake: { ok: false } }), 'intake')!.metric], ['UNAVAILABLE', null]);
    assert.deepEqual([tileByKey(tilesInput({ creators: { ok: true, value: null } }), 'creators')!.state, tileByKey(tilesInput({ creators: { ok: true, value: null } }), 'creators')!.stateLine], ['NOT_AVAILABLE', 'Not available on this deployment yet.']);
    assert.deepEqual([tileByKey(tilesInput({ creators: { ok: true, value: [] } }), 'creators')!.state, tileByKey(tilesInput({ creators: { ok: true, value: [] } }), 'creators')!.stateLine], ['EMPTY', 'No creators yet.']);
    assert.deepEqual([tileByKey(tilesInput({ work: { kind: 'ADMIN', summary: { ok: false } } }), 'work')!.state, tileByKey(tilesInput({ work: { kind: 'ADMIN', summary: { ok: false } } }), 'work')!.metric], ['UNAVAILABLE', null]);
    const noData = strip({ freshness: { state: 'UNAVAILABLE', word: 'No data', detail: 'Loop has not received any data from CallGrid yet.' } });
    assert.deepEqual([tileByKey(tilesInput({ callgrid: { ok: true, value: noData } }), 'callgrid')!.state, tileByKey(tilesInput({ callgrid: { ok: true, value: noData } }), 'callgrid')!.metric], ['NOT_CONNECTED', null]);
    assert.equal(tileByKey(tilesInput({ callgrid: { ok: true, value: noData } }), 'campaigns')!.metric, null);
    assert.equal(tileByKey(tilesInput({ callgrid: { ok: false } }), 'callgrid')!.state, 'UNAVAILABLE');
    const src = code(read('app/app/_home/tiles.ts'));
    for (const forbidden of ["from '@emgloop/database'", 'prisma', 'fetch(', 'new Date()', 'Date.now(', "'server-only'", 'composeBriefing', 'briefingWords', 'HeadlineView', '?? 0', '|| 0']) assert.equal(src.includes(forbidden), false, forbidden);
  });

  it('drawn: the whole tile is the link, with icon, title, one metric, its lines and an honest state; nothing a tile says is the briefing’s or a Headline’s', () => {
    const tiles = projectTiles(tilesInput({ telegram: { ok: false }, creators: { ok: true, value: null } }));
    const out = html(<ToolsGrid tiles={tiles} />);
    assert.match(out, /<section class="loop-front__tools" aria-label="Your tools &amp; spaces" id="tools">/);
    assert.match(out, /<a class="loop-front__tile" data-home-tile="mail" data-home-tile-state="OK" href="\/app\/mail">/, 'the whole tile is the link');
    assert.match(out, /data-home-tile="mail"[\s\S]*?<svg[\s\S]*?loop-front__tile-title">Mail<\/span>[\s\S]*?<b>3<\/b> <span>need a reply<\/span>[\s\S]*?1 follow-up due[\s\S]*?Open Mail →/);
    assert.match(out, /data-home-tile="chats" data-home-tile-state="UNAVAILABLE"[\s\S]*?data-home-tile-stateline[^>]*>Could not be read</);
    assert.match(out, /data-home-tile="creators" data-home-tile-state="NOT_AVAILABLE"[\s\S]*?Not available on this deployment yet\./);
    assert.match(out, /data-home-tile="intake"[\s\S]*?loop-front__tile-title">Intake Board</);
    assert.match(out, /data-home-tile="campaigns"[^>]*title="Counts entities OBSERVED/);
    const chats = out.slice(out.indexOf('data-home-tile="chats"'), out.indexOf('</a>', out.indexOf('data-home-tile="chats"')));
    assert.equal(/<b>0<\/b>/.test(chats), false, 'an unreadable domain shows no figure');
    // Distinct information products: the briefing's sentence and a Headline never appear on a tile.
    const lead = 'Since Sep 24: 4 things changed';
    for (const t of tiles) {
      assert.equal([...t.lines, t.stateLine ?? '', t.metric?.label ?? ''].join(' ').includes(lead), false, t.key);
      assert.equal([...t.lines, t.stateLine ?? ''].join(' ').includes('Roofing lead revenue'), false, t.key);
    }
    assert.equal(html(<ToolsGrid tiles={[]} />), '', 'nothing offered, nothing drawn');
    for (const forbidden of ['<button', '<form', 'null', 'undefined', 'Join']) assert.equal(out.includes(forbidden), false, forbidden);
  });
});

// --- the server-only reads, at source level -----------------------------------------------------------

describe('the front door’s reads are gated by the rail and scoped by the session', () => {
  it('each additive read stands behind its destination’s presence in the nav, and the executive ones behind the executive Home', () => {
    const data = code(read('app/app/_home/front-door-data.ts'));
    assert.match(data, /'server-only'/);
    assert.match(data, /input\.executive && navOffers\(groups, TILE_PATHS\.marketplace\)\s*\? settle\(async \(\) => \{\s*const ctx = await loadCommandContextFor\(organizationId, undefined, \{ session, canAct: async \(\) => false \}\);/, 'the CallGrid context is read only for the executive seat with the marketplace offered, with the session principal and no authority to act');
    // The executive row is the contract's own rule over that context -- Home chooses the figures, never the arithmetic.
    assert.match(data, /const kpis = callGridKpis\(\{\s*metrics: ctx\.report\.metrics,\s*comparison: ctx\.report\.comparison,\s*series: ctx\.facts\?\.series \?\? \[\],\s*comparisonWithheld: ctx\.window !== ctx\.selection\.window,\s*keys: HOME_KPI_KEYS,\s*\}\);\s*return projectHomeKpis\(\{ \.\.\.ctx, kpis \}\);/);
    assert.match(data, /navOffers\(groups, TILE_PATHS\.connections\)[\s\S]*?sourceConnections\(\)\.status\(\{ organizationId, userId: principal\.userId, name: session\.name \}\)/);
    assert.match(data, /navOffers\(groups, TILE_PATHS\.intake\) \? settle\(\(\) => crmRepos\.crm\.statusCounts\(organizationId\)\)/);
    assert.match(data, /input\.executive && navOffers\(groups, TILE_PATHS\.creators\)\s*\? settle\(\(\) => absentUntilMigrated\(creatorDomain\(\)\.records\.roster\(organizationId\)\)\)/);
    assert.match(data, /const organizationId = principal\.organizationId;/);
    for (const forbidden of ['searchParams', 'formData', 'params.', 'headers.get(', 'request.', 'prisma.', 'LIVE_ORG_SLUG']) assert.equal(data.includes(forbidden), false, forbidden);
    // A fold's `soon` item is never a destination.
    assert.match(data, /!i\.soon && i\.href === href/);
    // The page makes the module seat's reads with executive false; the executive Home makes its own with true.
    const page = code(read('app/app/page.tsx'));
    assert.match(page, /const front = !creatorSeat && role !== 'ADMIN' \? await loadFrontDoor\(\{ session, principal, groups, time, executive: false \}\) : null;/);
    assert.match(page, /<ModuleHome[^>]*front=\{front\}/);
    assert.match(code(read('app/app/_home/admin-home.tsx')), /loadFrontDoor\(\{ session, principal, groups, time, executive: true \}\)/);
  });

  it('the views are server components drawn with the design system, and the front door lays out in two columns that fold', () => {
    const view = read('app/app/_home/front-door-view.tsx');
    assert.equal(view.includes("'use client'"), false);
    for (const forbidden of ["from '@emgloop/database'", 'prisma', 'fetch(', 'dangerouslySetInnerHTML', 'style=']) assert.equal(code(view).includes(forbidden), false, forbidden);
    const css = read('app/loop-os.css');
    const classes = [...view.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].flatMap((m) => (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, '').split(/\s+/)).filter((c) => /^[a-z][a-z0-9_-]*$/.test(c));
    for (const c of new Set(classes)) assert.ok(css.includes(`.${c}`), `${c} is a Loop class`);
    // KPIs 5 → 3 → 2 → 1; the columns fold at 1100px; tiles 4 → 3 → 2 → 1.
    assert.match(css, /\.loop-front__kpigrid \{ display: grid; grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/);
    assert.match(css, /\.loop-front__tilegrid \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
    assert.match(css, /\.loop-front__cols \{ display: grid; grid-template-columns: minmax\(0, 1fr\) 360px;/);
    assert.match(css, /@media \(max-width: 1240px\) \{ \.loop-front__kpigrid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \} \.loop-front__tilegrid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \} \}/);
    assert.match(css, /@media \(max-width: 1100px\) \{ \.loop-front__cols \{ grid-template-columns: 1fr; \} \}/);
    assert.match(css, /@media \(max-width: 820px\) \{ \.loop-front__kpigrid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \} \.loop-front__tilegrid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    assert.match(css, /@media \(max-width: 520px\) \{ \.loop-front__kpigrid \{ grid-template-columns: 1fr; \} \.loop-front__tilegrid \{ grid-template-columns: 1fr; \}/);
    // Everything is minmax(0, ...) and min-width: 0, so nothing overflows a 360px canvas.
    assert.match(css, /\.loop-front \{ display: flex; flex-direction: column; gap: 22px; min-width: 0; \}/);
    assert.match(css, /\.loop-front__tile \{[^}]*min-width: 0;/);
    assert.match(css, /\.loop-front__kpi \{[^}]*min-width: 0;/);
    // Tokens only; the pulse rules and the old launcher grid went with their panels.
    const front = css.slice(css.indexOf('LOOP HOME FRONT DOOR'));
    assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(front), false, 'no colour outside the :root palette');
    for (const retired of ['.loop-brief__pulse', '.loop-brief__kpis', '.loop-brief__kpi ', '.loop-home {', '.loop-home .loop-launchers', '.loop-day__sections']) assert.equal(css.includes(retired), false, retired);
  });
});

// --- the Chats tile says what is happening, from the viewer's own governed data ------------------

describe('the Chats tile answers "what is happening in my chats?", from the viewer’s own governed data', () => {
  const chats = (over: Partial<TilesInput> = {}) => tileByKey(tilesInput(over), 'chats')!;

  it('surfaces the viewer’s authorized needs-you obligations: conversations, the latest change, the tally, deadlines -- and content-free activity', () => {
    const t = chats();
    assert.equal(t.state, 'OK');
    // Three conversations: Ana (two items), the Ops group, and one item the source gave no label for.
    assert.deepEqual(t.metric, { value: '3', label: 'conversations need you' });
    assert.deepEqual(t.lines, [
      'New discussion: adding another pest-control traffic source (with Ops group) · 1 decision needed, 1 request and 1 follow-up unresolved · 1 with a deadline',
      '14 messages observed across 5 conversations since yesterday.',
    ]);
    // The connector's state is supporting status, never the summary.
    assert.equal(t.status, 'Telegram · Ready · Triage on');
    assert.equal(t.lines.some((l) => /Ready|Observing/.test(l)), false);
    assert.equal(t.href, '/app/connections');
  });

  it('distinguishes "connected" from domain activity: connected with nothing owed and nothing observed is a quiet state, not a status readout', () => {
    const t = chats({ needsYou: [], telegram: { ok: true, value: { ...TELEGRAM, activity: { since: TELEGRAM.activity!.since, messages: 0, conversations: 0 } } } });
    assert.equal(t.state, 'EMPTY');
    assert.equal(t.stateLine, 'No conversations currently need your attention.');
    assert.deepEqual(t.lines, ['No new messages observed since yesterday.']);
    assert.equal(t.metric, null, 'no figure is drawn for nothing');
    assert.equal(t.status, 'Telegram · Ready · Triage on');
  });

  it('quiet with activity: the messages observed become the figure; with triage off the reason nothing is flagged is said', () => {
    const on = chats({ needsYou: [] });
    assert.deepEqual([on.state, on.stateLine, on.metric], ['EMPTY', 'No conversations currently need your attention.', { value: '14', label: 'messages since yesterday' }]);
    const off = chats({ needsYou: [], telegram: { ok: true, value: { ...TELEGRAM, contentAuthorized: false } } });
    assert.equal(off.stateLine, 'Triage is off, so Loop observes activity but flags nothing.');
    assert.equal(off.status, 'Telegram · Ready · Triage off');
    assert.deepEqual(off.metric, { value: '14', label: 'messages since yesterday' });
  });

  it('never reads or widens: the tile projects only the items the page loaded for the session principal, and the activity count is the viewer’s own', () => {
    // Another person's item cannot reach the tile except through `needsYou`, which the page loads once with the
    // session principal (home-needs-you-owner pins that). The projection itself imports no loader or repository.
    const tiles = code(read('app/app/_home/tiles.ts'));
    assert.doesNotMatch(tiles, /@emgloop\/database|prisma|loadNeedsYou|Repository/);
    const data = code(read('app/app/_home/front-door-data.ts'));
    assert.match(data, /activitySince\(organizationId, principal\.userId, 'TELEGRAM', since\)/, 'the observation count is scoped to the viewer');
    assert.match(data, /sourceConnections\(\)\.status\(\{ organizationId, userId: principal\.userId, name: session\.name \}\)/);
    // Items from another provider are not Telegram's.
    const t = chats({ needsYou: [{ ...NEEDS_YOU[0]!, provider: 'TEAMS' }] });
    assert.equal(t.state, 'EMPTY');
  });

  it('a Telegram obligation is Chats intelligence, never a Headline: the tile links to Connections, and nothing here reaches the Headline authority', () => {
    const t = chats();
    assert.equal(t.href, '/app/connections');
    assert.equal(projectTiles(tilesInput()).some((x) => x.href.startsWith('/app/admin/headlines')), false);
    assert.doesNotMatch(code(read('app/app/_home/tiles.ts')), /[Hh]eadline/);
  });

  it('unavailable, disconnected and unreadable activity are said honestly, never as zero', () => {
    const noActivity = chats({ telegram: { ok: true, value: { ...TELEGRAM, activity: null } } });
    assert.equal(noActivity.lines[1], 'Activity could not be read.');
    assert.equal(noActivity.state, 'OK', 'the obligations still stand');
    const quietNoActivity = chats({ needsYou: [], telegram: { ok: true, value: { ...TELEGRAM, activity: null } } });
    assert.deepEqual([quietNoActivity.metric, quietNoActivity.lines], [null, ['Activity could not be read.']]);
    const off = chats({ telegram: { ok: true, value: { ...TELEGRAM, state: 'DISCONNECTED', contentAuthorized: false } } });
    assert.deepEqual([off.state, off.metric, off.lines, off.status], ['NOT_CONNECTED', null, [], null]);
    const failed = chats({ telegram: { ok: false } });
    assert.deepEqual([failed.state, failed.stateLine, failed.metric], ['UNAVAILABLE', 'Could not be read', null]);
  });
});

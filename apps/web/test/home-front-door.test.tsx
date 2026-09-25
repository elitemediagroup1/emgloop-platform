// Loop Home as the front door (Matt, 2026-09-24; the composition correction, the same day):
// Header → Executive KPIs → Your briefing → Headlines → (Your day | Recent activity) → Your tools &
// spaces, in sequential full-width sections with no side rail.
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
import { projectTiles, TILE_PATHS, type TilesInput } from '../src/app/app/_home/tiles';
import { HeadlinesPanel, KpiStrip, ToolsGrid, HEADLINES_ON_HOME } from '../src/app/app/_home/front-door-view';
import type { HeadlineStanding } from '../src/app/app/_home/front-door-data';
import { chatsIntelligence, type ChatsIntelligenceInput, type ChatsItem } from '../src/daily-loop/chats-intelligence';
import { HEALTH_BAND_LABEL, type CallGridBrief } from '@emgloop/shared';

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
const standings = (entries: [string, HeadlineStanding][]): ReadonlyMap<string, HeadlineStanding> => new Map(entries);


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
/** The viewer's OWN Telegram obligations, as Chats reads them: minimized topics, the source's labels, never a message. */
const CHAT_ITEMS: ChatsItem[] = [
  { provider: 'TELEGRAM', category: 'REQUEST', counterparty: 'Ana R.', topic: 'creative assets for the new landing page', title: 'Ana asked for the creative assets', nextStep: null, deadline: null, at: new Date(NOW.getTime() - 3 * 3600_000) },
  { provider: 'TELEGRAM', category: 'DECISION_NEEDED', counterparty: 'Ana R.', topic: 'budget for October', title: 'Ana needs a decision on the October budget', nextStep: null, deadline: 'by Friday', at: new Date(NOW.getTime() - 2 * 3600_000) },
  { provider: 'TELEGRAM', category: 'BUSINESS_CHANGE', counterparty: 'Ops group', topic: 'adding another pest-control traffic source', title: 'The ops group discussed adding another pest-control traffic source', nextStep: null, deadline: null, at: new Date(NOW.getTime() - 3600_000) },
  { provider: 'TELEGRAM', category: 'FOLLOW_UP', counterparty: null, topic: null, title: 'Someone is waiting on the contract', nextStep: null, deadline: null, at: new Date(NOW.getTime() - 6 * 3600_000) },
];
const CHATS: ChatsIntelligenceInput = {
  connection: { configured: true, state: 'READY', label: 'Ready', contentAuthorized: true },
  items: CHAT_ITEMS,
  activity24h: { since: new Date(NOW.getTime() - 24 * 3600_000), messages: 14, conversations: 5 },
  activity7d: null,
};
const chats = (over: Partial<ChatsIntelligenceInput> = {}) => ({ ok: true as const, value: chatsIntelligence({ ...CHATS, ...over }) });
/** The Overview's own brief, as `executiveBrief` returns it: a band, its reason, what changed. */
const BRIEF: CallGridBrief = {
  band: 'HEALTHY',
  reason: 'profit and revenue improved despite lower call volume',
  sentences: [{ text: 'Revenue rose against yesterday to the same time, led by Campaign 1.', basis: 'MEASURED', detail: 'Revenue $1,120 vs $850.' }],
  details: [],
};
const MAIL_READING = { needsReply: 3, waiting: 2, followUps: 1, lines: ['3 conversations need your reply, including 1 opportunity; the oldest has waited 2 days on you.', '1 follow-up is due and 2 conversations are waiting on others.'] };
function tilesInput(over: Partial<TilesInput> = {}): TilesInput {
  return {
    groups: OWNER_NAV,
    today: today(),
    mail: MAIL_READING,
    chats: chats(),
    work: { kind: 'ADMIN', posture: { ok: true, value: { assigned: 4, readyNow: 2, blocked: 1, overdue: 1, dueToday: 2, datesPartial: false } } },
    intake: { ok: true, value: { New: 12, Contacted: 5, Quoted: 2, Booked: 1, Completed: 40, Archived: 9 } },
    creators: { ok: true, value: [{ needsEmg: 2, needsCreator: 1, inProduction: 3, dueSoon: 1 }, { needsEmg: 0, needsCreator: 0, inProduction: 0, dueSoon: 0 }] },
    callgrid: { ok: true, value: strip() },
    callgridBrief: { ok: true, value: BRIEF },
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

describe('Headlines on Home are the Headline authority’s own rows, drawn as cards', () => {
  it('the read is the governed one, non-dismissed, and the standing is headlineSituation over the Case', () => {
    const review = code(read('app/app/_home/review-data.ts'));
    assert.match(review, /loadAttention\(organizationId, new Date\(\), \{ dismissed: false \}\)/);
    assert.match(review, /sink\.attention = result\.value\.attention;/);
    assert.match(review, /headlinesOffered: sink\.offered,/);
    const data = code(read('app/app/_home/front-door-data.ts'));
    assert.match(data, /loadCasesForHeadlines\(organizationId, headlineIds\)/, 'the investigation is the Case keyed to the Headline, read once for the list');
    assert.match(data, /if \(!result\.ok\) return \[h\.id, \{ situation: null, caseId: null \}\];/, 'a failed read is unknown, never "not investigated"');
    assert.match(data, /situation: headlineSituation\(h, kase\)/, 'the Headlines workspace’s own projection, not a Home rule');
  });

  it('each card: what Loop identified, why it matters, the evidence, where it stands, and the Headline’s own link; capped at four', () => {
    const rows = [headline(), headline({ id: 'h2', statement: 'Solar leads in Arizona: 40 this week vs 22 last week (+82%)', measurement: { ...headline().measurement, againstObjective: false, currentCoverage: null }, detectionCount: 1 })];
    const out = html(<HeadlinesPanel headlines={rows} attention={attention('NEEDS_ATTENTION')} standings={standings([['h1', { situation: 'UNDER_INVESTIGATION', caseId: 'c1' }], ['h2', { situation: 'NEW', caseId: null }]])} time={time} href="/app/admin/headlines" />);
    assert.match(out, /<section class="loop-front__headlines" aria-label="Headlines" id="headlines">/);
    assert.match(out, /href="\/app\/admin\/headlines"[^>]*>View all Headlines →/);
    assert.match(out, /<ul class="loop-front__hlgrid"><li class="loop-front__hl" data-home-headline="h1" data-home-headline-situation="UNDER_INVESTIGATION">/);
    assert.match(out, /href="\/app\/admin\/headlines\/h1">Roofing lead revenue in Texas: \$4,180 this week vs \$6,940 last week \(−40%\)</);
    assert.match(out, /Under investigation/);
    assert.match(out, /data-home-headline-why[^>]*>Why it matters: movement against an objective you set<span class="loop-brief__where"> · Grow roofing lead revenue in Texas/);
    assert.match(out, /data-home-headline-evidence[^>]*><span>coverage 86%<\/span><span>2 sightings<\/span>/);
    assert.match(out, /first seen <time datetime="2026-09-23T06:10:00Z">[^<]*<\/time> · last seen <time datetime="2026-09-24T06:10:00Z">/i);
    assert.match(out, /href="\/app\/admin\/headlines\/h1"[^>]*>Open investigation →/);
    assert.match(out, /data-home-headline="h2" data-home-headline-situation="NEW"[\s\S]*?>New<[\s\S]*?1 sighting[\s\S]*?href="\/app\/admin\/headlines\/h2"[^>]*>Look into it →/);
    assert.equal(out.slice(out.indexOf('data-home-headline="h2"')).includes('coverage'), false, 'no coverage is claimed where none was measured');
    assert.match(out, /2 open Headlines/);
    const many = html(<HeadlinesPanel headlines={Array.from({ length: 7 }, (_, i) => headline({ id: `h${i}` }))} attention={attention('NEEDS_ATTENTION')} standings={standings([])} time={time} href="/app/admin/headlines" />);
    assert.equal((many.match(/data-home-headline="/g) ?? []).length, HEADLINES_ON_HOME);
    assert.match(many, /3 more open Headlines →/);
    assert.match(many, /data-home-headline-situation="UNKNOWN"[\s\S]*?Standing not read/, 'a case read that failed is said, not defaulted to New');
    // A closed Case is its own word: resolved, not "under investigation".
    const closed = html(<HeadlinesPanel headlines={[headline()]} attention={attention('NEEDS_ATTENTION')} standings={standings([['h1', { situation: 'RESOLVED', caseId: 'c1' }]])} time={time} href="/app/admin/headlines" />);
    assert.match(closed, /data-home-headline-situation="RESOLVED"[\s\S]*?Resolved[\s\S]*?Look into it →/);
    assert.equal(/\bnull\b|\bundefined\b/.test(out), false);
  });

  it('a review update or a mail row never becomes a Headline; the aggregate Headlines row leaves Needs you when the section is drawn', () => {
    const out = html(<HeadlinesPanel headlines={[headline()]} attention={attention('NEEDS_ATTENTION')} standings={standings([])} time={time} href="/app/admin/headlines" />);
    assert.equal((out.match(/data-home-headline="/g) ?? []).length, 1);
    const panel = code(read('app/app/_home/front-door-view.tsx'));
    assert.equal(/review\.updates|mail|ReviewUpdate|NeedsYouItem|Chats/.test(panel.slice(panel.indexOf('export function HeadlinesPanel'), panel.indexOf('// --- Recent activity'))), false, 'the section takes HeadlineView rows and nothing else');
    const input: BriefingInput = { now: NOW, review: null, period: null, headlines: [headline()], needsYou: [], day: null, dayFailed: false, mail: null, mailFailed: false, callgrid: null, workDue: [], connectionsHref: '/app/connections', headlinesHref: '/app/admin/headlines', headlinesPanel: true };
    assert.equal(html(<NeedsAttention briefing={composeBriefing(input)} time={time} />).includes('data-briefing-attention="HEADLINES"'), false);
  });

  it('empty is a quiet knowledge-state card: all clear names what it checked, a coverage gap says so, an unreadable read is a failure -- never a fake Headline', () => {
    const clear = html(<HeadlinesPanel headlines={[]} attention={attention('ALL_CLEAR')} standings={standings([])} time={time} href="/app/admin/headlines" />);
    assert.match(clear, /<div class="loop-front__knowledge" data-home-headlines-empty="ALL_CLEAR">/);
    assert.match(clear, new RegExp(productLabel('ALL_CLEAR')!.label));
    assert.match(clear, /No qualifying Headlines right now\. No material changes require your attention\. Loop checked 3 active objectives/);
    assert.equal(clear.includes('data-home-headline="'), false, 'no card dressed as a Headline');
    const gap = html(<HeadlinesPanel headlines={[]} attention={attention('INSUFFICIENT_COVERAGE')} standings={standings([])} time={time} href="/app/admin/headlines" />);
    assert.match(gap, /data-home-headlines-empty="INSUFFICIENT_COVERAGE"/);
    assert.match(gap, new RegExp(productLabel('INSUFFICIENT_COVERAGE')!.label.replace("'", '&#x27;')));
    assert.match(gap, /1 of 3 objectives could not be measured: Grow roofing lead revenue in Texas\./);
    assert.equal(gap.includes('No qualifying Headlines'), false, 'a coverage gap is never all clear');
    const nothing = html(<HeadlinesPanel headlines={[]} attention={attention('NOTHING_TO_CHECK')} standings={standings([])} time={time} href="/app/admin/headlines" />);
    assert.match(nothing, /Loop has nothing to check/);
    const failed = html(<HeadlinesPanel headlines={null} attention={null} standings={standings([])} time={time} href="/app/admin/headlines" />);
    assert.match(failed, /Loop could not read Headlines just now/);
    assert.equal(failed.includes('No qualifying'), false);
  });
});

// --- Recent activity -------------------------------------------------------------------------------
// Recent activity now reads the organization's Universal Activity feed; its tests live in
// home-org-activity.test.tsx (adapters, gates, the false "none", a failed read).

// --- tools & spaces ----------------------------------------------------------------------------------

describe('Your tools & spaces: a tile only where the rail leads, each its domain’s own interpretation', () => {
  it('for an owner every offered domain has a tile at its LOOP_NAV href with the registry’s label', () => {
    const tiles = projectTiles(tilesInput());
    assert.deepEqual(tiles.map((t) => [t.key, t.href, t.label]), [
      ['mail', '/app/mail', 'Mail'],
      ['chats', '/app/chats', 'Chats'],
      ['calendar', '/app/calendar', 'Calendar'],
      ['work', '/app/admin/work', 'My Work'],
      ['intake', '/crm/pipeline', 'Intake Board'],
      ['callgrid', '/app/admin/marketplace', 'CallGrid Intelligence'],
      ['campaigns', '/app/admin/marketplace/campaigns', 'Campaigns'],
      ['creators', '/app/admin/creator-hub', 'Creator Hub'],
    ]);
    const navHrefs = new Set(LOOP_NAV.nav.flatMap((g) => g.items.map((i) => i.href)));
    for (const t of tiles) assert.ok(navHrefs.has(t.href) || t.href.startsWith(TILE_PATHS.marketplace + '/'), `${t.key} → ${t.href}`);
    // Connected sources never send a person to Connections: Connections is configuration, not a domain.
    assert.equal(tiles.some((t) => t.href === '/app/connections' || /Connections/.test(t.linkLabel)), false);
    assert.equal(tiles.some((t) => /pipeline|opportunit/i.test(t.label)), false, 'the intake board is never Pipeline or Opportunities');
  });

  it('Mail carries the Mail domain’s own interpretation, not only counts, and routes to Mail', () => {
    const mail = tileByKey(tilesInput(), 'mail')!;
    assert.deepEqual(mail.metric, { value: '3', label: 'need your reply' });
    assert.deepEqual(mail.lines, MAIL_READING.lines, 'the mailDomainIntelligence lines, verbatim');
    assert.equal(mail.href, '/app/mail');
    assert.equal(mail.status, 'Read 4m ago');
    // Home computes the reading with the Mail domain's own function, once, and hands it to the tile and the briefing.
    for (const f of ['app/app/_home/admin-home.tsx', 'app/app/_home/module-home.tsx']) {
      assert.match(code(read(f)), /mailDomainIntelligence\(mail\.rows\.map\(\(r\) => r\.insight\), mail\.summary, mail\.now\)/, f);
    }
    const quiet = tileByKey(tilesInput({ mail: { needsReply: 0, waiting: 0, followUps: 0, lines: [] } }), 'mail')!;
    assert.deepEqual([quiet.state, quiet.stateLine], ['EMPTY', 'Nothing in your mail needs you right now.']);
  });

  it('Chats is the Chats domain’s reading and routes to Chats; Calendar says the day and routes to Calendar', () => {
    const c = tileByKey(tilesInput(), 'chats')!;
    const reading = chatsIntelligence(CHATS);
    assert.deepEqual([c.state, c.href, c.metric, c.lines, c.status], ['OK', '/app/chats', reading.metric, reading.summary.slice(0, 2), reading.status]);
    assert.equal(c.linkLabel, 'Open Chats');
    const cal = tileByKey(tilesInput({ today: today({ events: [], inProgress: null, next: null }) }), 'calendar')!;
    assert.deepEqual([cal.href, cal.state, cal.stateLine, cal.metric], ['/app/calendar', 'EMPTY', 'No meetings on your calendar today.', { value: '0', label: 'meetings today' }]);
    assert.equal(cal.status, 'Read 4m ago');
  });

  it('a disconnected Mail, Chats or Calendar routes to Connections; a source outside the rail yields no tile', () => {
    const mail = tileByKey(tilesInput({ today: today({ mail: { state: 'NOT_CONNECTED', line: 'Mail isn’t connected.', href: '/app/connections', action: 'Connect Google' }, mailCounts: null }), mail: null }), 'mail')!;
    assert.deepEqual([mail.state, mail.stateLine, mail.href, mail.linkLabel, mail.metric], ['NOT_CONNECTED', 'Not connected', '/app/connections', 'Connect in Connections', null]);
    const chat = tileByKey(tilesInput({ chats: chats({ connection: { ...CHATS.connection!, state: 'NOT_CONNECTED', label: 'Not connected' } }) }), 'chats')!;
    assert.deepEqual([chat.state, chat.href, chat.linkLabel, chat.metric], ['NOT_CONNECTED', '/app/connections', 'Connect in Connections', null]);
    const cal = tileByKey(tilesInput({ today: today({ calendar: { state: 'NOT_CONNECTED', line: 'Calendar isn’t connected.', href: '/app/connections', action: 'Connect Calendar' } }) }), 'calendar')!;
    assert.deepEqual([cal.state, cal.href, cal.linkLabel, cal.metric], ['NOT_CONNECTED', '/app/connections', 'Connect in Connections', null]);
    for (const href of ['/app/mail', '/app/chats', '/app/calendar']) {
      const without = projectTiles(tilesInput({ groups: OWNER_NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.href !== href) })) }));
      assert.equal(without.some((t) => t.href === href), false, href);
    }
  });

  it('CallGrid says what is happening in the numbers with the Overview’s own brief -- band and reason, not the KPI figures', () => {
    const t = tileByKey(tilesInput(), 'callgrid')!;
    assert.deepEqual(t.metric, { value: HEALTH_BAND_LABEL.HEALTHY, label: 'business health' });
    assert.deepEqual(t.lines, ['Profit and revenue improved despite lower call volume.', 'Revenue rose against yesterday to the same time, led by Campaign 1.']);
    assert.equal(t.status, 'Live');
    for (const figure of strip().kpis.map((k) => k.value)) assert.equal([t.metric!.value, ...t.lines].join(' ').includes(figure), false, `the KPI row owns ${figure}`);
    // An engine that could not run is the tile's honest state; the KPI row is untouched by it.
    const failed = tileByKey(tilesInput({ callgridBrief: { ok: false } }), 'callgrid')!;
    assert.deepEqual([failed.state, failed.stateLine, failed.metric], ['UNAVAILABLE', 'Loop could not read the analysis just now.', null]);
    // The brief comes from the SAME context as the row: read once, the analysis settled on its own.
    const data = code(read('app/app/_home/front-door-data.ts'));
    assert.equal((data.match(/loadCommandContextFor\(/g) ?? []).length, 1);
    assert.match(data, /const reading = await loadExecutiveReading\(ctx\);\s*return executiveBrief\(ctx, reading, null\);/, 'the CallGrid tile reads the engine without recording');
    assert.doesNotMatch(data, /loadExecutiveAnalysis|loadOperationalQueue/, 'rendering Home never records a detection');
    assert.match(data, /const callgridBrief = context\?\.ok\s*\? await settle\(/);
  });

  it('My Work, Intake, Campaigns and Creators interpret their own reads; the employee gets their own queue and nothing executive', () => {
    const work = tileByKey(tilesInput(), 'work')!;
    assert.deepEqual([work.metric, work.lines], [{ value: '4', label: 'assigned to you' }, ['1 overdue · 2 due today', '2 ready now · 1 waiting or blocked']]);
    const none = tileByKey(tilesInput({ work: { kind: 'ADMIN', posture: { ok: true, value: { assigned: 0, readyNow: 0, blocked: 0, overdue: 0, dueToday: 0, datesPartial: false } } } }), 'work')!;
    assert.deepEqual([none.state, none.stateLine], ['EMPTY', 'No work is assigned to you.']);
    assert.match(tileByKey(tilesInput({ work: { kind: 'ADMIN', posture: { ok: true, value: { assigned: 9, readyNow: 0, blocked: 0, overdue: 2, dueToday: 0, datesPartial: true } } } }), 'work')!.lines[0]!, /^at least 2 overdue$/);
    const intake = tileByKey(tilesInput(), 'intake')!;
    assert.deepEqual([intake.metric, intake.lines], [{ value: '12', label: 'new records await first contact' }, ['Further along: 5 contacted · 2 quoted · 1 booked', '69 records on the board']]);
    const campaigns = tileByKey(tilesInput(), 'campaigns')!;
    assert.deepEqual(campaigns.metric, { value: '2', label: 'active today so far' });
    assert.equal(campaigns.lines[0], 'Campaign 1 is earning the most today so far');
    assert.equal(campaigns.status, 'Observed in calls, not a roster');
    const creators = tileByKey(tilesInput(), 'creators')!;
    assert.deepEqual([creators.metric, creators.lines], [{ value: '2', label: 'managed creators' }, ['2 need your team · 3 in production', '1 due soon']]);
    const employee = projectTiles(tilesInput({ groups: EMPLOYEE_NAV, work: { kind: 'EMPLOYEE', posture: { ok: true, value: { assigned: 0, readyNow: 0, blocked: 0, overdue: 0, dueToday: 0, datesPartial: false } } }, callgrid: null, callgridBrief: null, creators: null }));
    assert.deepEqual(employee.map((t) => t.key), ['mail', 'chats', 'calendar', 'work', 'intake']);
    assert.equal(employee.find((t) => t.key === 'work')!.href, '/app/employee/work');
    const handed = projectTiles(tilesInput({ groups: EMPLOYEE_NAV, work: { kind: 'EMPLOYEE', posture: { ok: true, value: { assigned: 1, readyNow: 1, blocked: 0, overdue: 0, dueToday: 0, datesPartial: false } } } }));
    assert.equal(handed.some((t) => t.key === 'callgrid' || t.key === 'campaigns' || t.key === 'creators'), false);
  });

  it('a domain that is not read, could not be read or is not on this deployment says so -- never a zero', () => {
    const unreadMail = tileByKey(tilesInput({ today: today({ mail: { state: 'NOT_READ', line: 'Loop has not read your mail yet.' }, mailCounts: null }), mail: null }), 'mail')!;
    assert.deepEqual([unreadMail.state, unreadMail.stateLine, unreadMail.metric], ['NOT_READ', 'Loop has not read your mail yet.', null]);
    assert.equal(tileByKey(tilesInput({ chats: chats({ connection: null }) }), 'chats'), null, 'no tile for a person who may not view connections');
    assert.deepEqual([tileByKey(tilesInput({ chats: { ok: false } }), 'chats')!.state, tileByKey(tilesInput({ chats: { ok: false } }), 'chats')!.metric], ['UNAVAILABLE', null]);
    assert.equal(tileByKey(tilesInput({ chats: chats({ connection: { ...CHATS.connection!, configured: false } }) }), 'chats')!.state, 'NOT_AVAILABLE');
    assert.equal(tileByKey(tilesInput({ chats: null }), 'chats'), null, 'not offered, not read: no tile');
    assert.equal(tileByKey(tilesInput({ today: today({ calendar: { state: 'NOT_CONFIGURED' } }) }), 'calendar'), null, 'not set up at all: nothing is said');
    assert.deepEqual([tileByKey(tilesInput({ intake: { ok: false } }), 'intake')!.state, tileByKey(tilesInput({ intake: { ok: false } }), 'intake')!.metric], ['UNAVAILABLE', null]);
    assert.deepEqual([tileByKey(tilesInput({ intake: { ok: true, value: {} } }), 'intake')!.state, tileByKey(tilesInput({ intake: { ok: true, value: {} } }), 'intake')!.metric], ['EMPTY', null]);
    assert.deepEqual([tileByKey(tilesInput({ creators: { ok: true, value: null } }), 'creators')!.state, tileByKey(tilesInput({ creators: { ok: true, value: null } }), 'creators')!.stateLine], ['NOT_AVAILABLE', 'Not available on this deployment yet.']);
    assert.deepEqual([tileByKey(tilesInput({ creators: { ok: true, value: [] } }), 'creators')!.state, tileByKey(tilesInput({ creators: { ok: true, value: [] } }), 'creators')!.stateLine], ['EMPTY', 'No creators yet.']);
    assert.deepEqual([tileByKey(tilesInput({ work: { kind: 'ADMIN', posture: { ok: false } } }), 'work')!.state, tileByKey(tilesInput({ work: { kind: 'ADMIN', posture: { ok: false } } }), 'work')!.metric], ['UNAVAILABLE', null]);
    const noData = strip({ freshness: { state: 'UNAVAILABLE', word: 'No data', detail: 'Loop has not received any data from CallGrid yet.' } });
    assert.deepEqual([tileByKey(tilesInput({ callgrid: { ok: true, value: noData } }), 'callgrid')!.state, tileByKey(tilesInput({ callgrid: { ok: true, value: noData } }), 'callgrid')!.metric], ['NOT_CONNECTED', null]);
    assert.equal(tileByKey(tilesInput({ callgrid: { ok: true, value: noData } }), 'campaigns')!.metric, null);
    assert.equal(tileByKey(tilesInput({ callgrid: { ok: false } }), 'callgrid')!.state, 'UNAVAILABLE');
    const src = code(read('app/app/_home/tiles.ts'));
    for (const forbidden of ["from '@emgloop/database'", 'prisma', 'fetch(', 'new Date()', 'Date.now(', "'server-only'", 'composeBriefing', 'briefingNarrative', 'HeadlineView', 'loadNeedsYou', 'Repository', '?? 0', '|| 0']) assert.equal(src.includes(forbidden), false, forbidden);
    assert.doesNotMatch(src, /[Hh]eadline/, 'a tile never reaches the Headline authority');
  });

  it('drawn: the whole tile is the link, with icon, title, one signal, its lines and a status; nothing a tile says is the briefing’s or a Headline’s', () => {
    const tiles = projectTiles(tilesInput({ chats: { ok: false }, creators: { ok: true, value: null } }));
    const out = html(<ToolsGrid tiles={tiles} />);
    assert.match(out, /<section class="loop-front__tools" aria-label="Your tools &amp; spaces" id="tools">/);
    assert.match(out, /<a class="loop-front__tile" data-home-tile="mail" data-home-tile-state="OK" href="\/app\/mail">/, 'the whole tile is the link');
    assert.match(out, /data-home-tile="mail"[\s\S]*?<svg[\s\S]*?loop-front__tile-title">Mail<\/span>[\s\S]*?<b>3<\/b> <span>need your reply<\/span>[\s\S]*?including 1 opportunity[\s\S]*?loop-front__tile-status">Read 4m ago[\s\S]*?Open Mail →/);
    assert.match(out, /data-home-tile="chats" data-home-tile-state="UNAVAILABLE"[\s\S]*?data-home-tile-stateline[^>]*>Could not be read</);
    assert.match(out, /data-home-tile="creators" data-home-tile-state="NOT_AVAILABLE"[\s\S]*?Not available on this deployment yet\./);
    assert.match(out, /data-home-tile="campaigns"[^>]*title="Counts entities OBSERVED/);
    const chatsTile = out.slice(out.indexOf('data-home-tile="chats"'), out.indexOf('</a>', out.indexOf('data-home-tile="chats"')));
    assert.equal(/<b>0<\/b>/.test(chatsTile), false, 'an unreadable domain shows no figure');
    for (const t of tiles) assert.equal([...t.lines, t.stateLine ?? ''].join(' ').includes('Roofing lead revenue'), false, t.key);
    assert.equal(html(<ToolsGrid tiles={[]} />), '', 'nothing offered, nothing drawn');
    for (const forbidden of ['<button', '<form', 'null', 'undefined', 'Join']) assert.equal(out.includes(forbidden), false, forbidden);
  });
});

// --- the server-only reads, at source level -----------------------------------------------------------

describe('the front door’s reads are gated by the rail and scoped by the session', () => {
  it('each additive read stands behind its destination’s presence in the nav, and the executive ones behind the executive Home', () => {
    const data = code(read('app/app/_home/front-door-data.ts'));
    assert.match(data, /'server-only'/);
    assert.match(data, /input\.executive && navOffers\(groups, TILE_PATHS\.marketplace\)\s*\? settle\(\(\) => loadCommandContextFor\(organizationId, undefined, \{ session, canAct: async \(\) => false \}\)\)/, 'the CallGrid context is read only for the executive seat with the marketplace offered, with the session principal and no authority to act');
    // The executive row is the contract's own rule over that context -- Home chooses the figures, never the arithmetic.
    assert.match(data, /const kpis = callGridKpis\(\{\s*metrics: ctx\.report\.metrics,\s*comparison: ctx\.report\.comparison,\s*series: ctx\.facts\?\.series \?\? \[\],\s*comparisonWithheld: ctx\.window !== ctx\.selection\.window,\s*keys: HOME_KPI_KEYS,\s*\}\);\s*return \{ ok: true, value: projectHomeKpis\(\{ \.\.\.ctx, kpis \}\) \};/);
    assert.match(data, /navOffers\(groups, TILE_PATHS\.chats\) \? settle\(\(\) => loadChatsInput\(\{ session, principal, now: time\.now, needsYou \}\)\)/);
    assert.match(data, /navOffers\(groups, TILE_PATHS\.intake\) \? settle\(\(\) => crmRepos\.crm\.statusCounts\(organizationId\)\)/);
    assert.match(data, /input\.executive && navOffers\(groups, TILE_PATHS\.creators\)\s*\? settle\(\(\) => absentUntilMigrated\(creatorDomain\(\)\.records\.roster\(organizationId\)\)\)/);
    assert.match(data, /const organizationId = principal\.organizationId;/);
    for (const forbidden of ['searchParams', 'formData', 'params.', 'headers.get(', 'request.', 'prisma.', 'LIVE_ORG_SLUG', 'SourceObservationRepository', 'sourceConnections(']) assert.equal(data.includes(forbidden), false, forbidden);
    // A fold's `soon` item is never a destination.
    assert.match(data, /!i\.soon && i\.href === href/);
    // The page makes the module seat's reads with executive false; the executive Home makes its own with true.
    const page = code(read('app/app/page.tsx'));
    assert.match(page, /const front = !creatorSeat && role !== 'ADMIN' \? await loadFrontDoor\(\{ session, principal, groups, time, needsYou, executive: false \}\) : null;/);
    assert.match(page, /<ModuleHome[^>]*front=\{front\}/);
    assert.match(code(read('app/app/_home/admin-home.tsx')), /loadFrontDoor\(\{ session, principal, groups, time, needsYou, executive: true \}\)/);
  });

  it('Home owns no table and no lifecycle: every write path is another authority’s, and nothing under _home persists', () => {
    for (const file of homeFiles()) {
      const src = code(read(file));
      for (const forbidden of ['prisma.', '.create(', '.update(', '.upsert(', '.delete(', 'localStorage', 'sessionStorage', 'cookies().set']) assert.equal(src.includes(forbidden), false, `${file}: ${forbidden}`);
    }
  });

  it('the views are server components; the front door is sequential sections with Day | Activity as compact peers, and it folds', () => {
    const view = read('app/app/_home/front-door-view.tsx');
    assert.equal(view.includes("'use client'"), false);
    for (const forbidden of ["from '@emgloop/database'", 'prisma', 'fetch(', 'dangerouslySetInnerHTML', 'style=']) assert.equal(code(view).includes(forbidden), false, forbidden);
    const css = read('app/loop-os.css');
    for (const f of ['app/app/_home/front-door-view.tsx', 'app/app/_home/admin-home.tsx', 'app/app/_home/module-home.tsx']) {
      const src = read(f);
      const classes = [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].flatMap((m) => (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, '').split(/\s+/)).filter((c) => /^[a-z][a-z0-9_-]*$/.test(c));
      for (const c of new Set(classes)) assert.ok(css.includes(`.${c}`), `${f}: ${c} is a Loop class`);
    }
    // No side rail: the two-column shell that let an uncapped column set the row height is gone.
    for (const retired of ['.loop-front__cols', '.loop-front__main', '.loop-front__side', '.loop-brief__lead', '.loop-brief__mailline']) assert.equal(css.includes(retired), false, retired);
    for (const f of homeFiles()) assert.equal(/loop-front__(cols|main|side)\b/.test(read(f)), false, f);
    // Day | Activity: two peers, each as tall as its own content; one column at 900px.
    assert.match(css, /\.loop-front__pair \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: 22px; align-items: start; \}/);
    assert.match(css, /@media \(max-width: 900px\) \{ \.loop-front__pair \{ grid-template-columns: 1fr; \}/);
    // KPIs 5 → 3 → 2 → 1; tiles 4 → 3 → 2 → 1.
    assert.match(css, /\.loop-front__kpigrid \{ display: grid; grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/);
    assert.match(css, /\.loop-front__tilegrid \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
    assert.match(css, /@media \(max-width: 1240px\) \{ \.loop-front__kpigrid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \} \.loop-front__tilegrid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \} \}/);
    assert.match(css, /@media \(max-width: 820px\) \{ \.loop-front__kpigrid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \} \.loop-front__tilegrid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    assert.match(css, /@media \(max-width: 520px\) \{ \.loop-front__kpigrid \{ grid-template-columns: 1fr; \} \.loop-front__tilegrid \{ grid-template-columns: 1fr; \}/);
    // Everything is minmax(0, ...) and min-width: 0, so nothing overflows a 360px canvas; no layout hacks.
    assert.match(css, /\.loop-front \{ display: flex; flex-direction: column; gap: 22px; min-width: 0; \}/);
    for (const cls of ['.loop-front__tile', '.loop-front__kpi', '.loop-front__hl', '.loop-front__day']) assert.match(css, new RegExp(`\\${cls} \\{[^}]*min-width: 0;`), cls);
    const front = css.slice(css.indexOf('LOOP HOME FRONT DOOR'));
    const block = front.slice(0, front.indexOf('/* =====', 10) === -1 ? undefined : front.indexOf('/* =====', 10));
    assert.equal(/margin[^;:]*:\s*-|position:\s*absolute/.test(block), false, 'no negative margins or absolute positioning');
    assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(block), false, 'no colour outside the :root palette');
    for (const retired of ['.loop-brief__pulse', '.loop-brief__kpis', '.loop-brief__kpi ', '.loop-home {', '.loop-home .loop-launchers', '.loop-day__sections']) assert.equal(css.includes(retired), false, retired);
  });
});

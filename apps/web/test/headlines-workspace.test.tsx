// The Headlines workspace, tested on what it must never do.
//
// WHAT THESE PROVE
//
// SECTIONS DERIVE FROM THE TWO AUTHORITIES. Where a Headline sits is a pure
// function of the Headline record and its Case; nothing in the UI decides it
// and nothing stores it.
//
// A SET-ASIDE HEADLINE IS HISTORY WITH ITS RECORD AND NO DECISION. It shows the
// basis and when, and renders NO Investigate or Set aside form even when the
// page hands it one -- because the card, not the page, is the last line.
//
// RESOLVED DOES NOT MEAN DELETED. A resolved investigation's Headline sits in
// History with its outcome word and close date, and every section is always on
// the page: a filter expands, it never removes.
//
// THE FILTERS ARE THE REPOSITORY'S OWN OPTIONS, the organization is never read
// from the URL, and rendering creates nothing.
//
// NO NEW LIFECYCLE. No Prisma model, column or migration was added for any of
// this; the projection lives in `@emgloop/shared` and reads the Headline contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  CASE_OUTCOME_LANGUAGE,
  HEADLINE_DISMISSAL_BASIS_LABELS,
  createTimeView,
  headlineSituationLabel,
  productLabel,
  resolveDisplayTimeZone,
  type HeadlineView,
} from '@emgloop/shared';

import {
  HeadlineCard,
  HeadlineSectionBlock,
  HeadlineShowNav,
  HeadlineStanding,
  expandedSections,
  parseShow,
  sectionHeadlines,
  workspaceHref,
  type HeadlineCaseRef,
} from '../src/app/app/admin/headlines/headline-ui';

const render = (el: unknown) => renderToStaticMarkup(el as never);
const strip = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

// The reader's clock, pinned. The card formats a set-aside or close time
// through it rather than through the server clock.
const TIME = createTimeView(resolveDisplayTimeZone({}), new Date('2026-08-25T12:00:00.000Z'));

function headline(over: Partial<HeadlineView> = {}): HeadlineView {
  return {
    id: 'hl_cem',
    performanceObjectiveId: 'obj_medicare',
    objectiveTitle: 'Grow Medicare answer rate',
    measureBindingId: 'bind_1',
    measureBindingVersion: 3,
    measurement: {
      metric: 'MONETIZED_RATE',
      metricLabel: 'Monetized rate',
      unit: 'RATIO',
      movement: 'DECREASE',
      againstObjective: true,
      currentValue: 0.412,
      priorValue: 0.597,
      absoluteChange: -0.185,
      percentageChange: -0.31,
      currentDenominator: 3184,
      priorDenominator: 2996,
      currentCoverage: 0.98,
      priorCoverage: 0.99,
      comparisonBasis: 'Trailing 7 complete Eastern business days against the 7 before them.',
      currentWindowStart: '2026-08-15T04:00:00.000Z',
      currentWindowEnd: '2026-08-22T04:00:00.000Z',
      priorWindowStart: '2026-08-08T04:00:00.000Z',
      priorWindowEnd: '2026-08-15T04:00:00.000Z',
    },
    statement: "Buyer CEM's monetized rate fell from 59.7% to 41.2%.",
    limitations: ['Postback destinations settle after the call.'],
    unknowns: [],
    ruleId: 'ci.objective-measure-change',
    ruleVersion: 'v1',
    producerVersion: 'ci-headline.v1',
    ruleDescription: 'A move of at least 15% over at least 200 calls.',
    firstDetectedAt: '2026-08-20T11:02:00.000Z',
    lastDetectedAt: '2026-08-22T06:15:00.000Z',
    detectionCount: 3,
    dismissedAt: null,
    dismissedByUserId: null,
    dismissedByName: null,
    dismissalBasis: null,
    createdAt: '2026-08-20T11:02:00.000Z',
    ...over,
  };
}

const setAside = (over: Partial<HeadlineView> = {}) =>
  headline({
    id: 'hl_set',
    dismissedAt: '2026-08-23T09:00:00.000Z',
    dismissedByUserId: 'usr_matt',
    dismissedByName: 'Matt',
    dismissalBasis: 'IMMATERIAL',
    ...over,
  });

const kase = (over: Partial<HeadlineCaseRef> = {}): HeadlineCaseRef => ({
  caseId: 'case_1',
  state: 'ASSIGNED',
  outcome: null,
  resolvedAt: null,
  ...over,
});

const RESOLVED = kase({ caseId: 'case_res', state: 'RESOLVED', outcome: 'RECOVERED', resolvedAt: '2026-08-24T10:00:00.000Z' });
const CLOSED_WITHOUT_ACTING = kase({ caseId: 'case_dis', state: 'DISMISSED', outcome: 'NO_ACTION_NEEDED', resolvedAt: '2026-08-24T11:00:00.000Z' });

/** The controls a page would pass for a current Headline. Both forms, both words. */
const CONTROLS = (
  <div>
    <form><button>Investigate</button></form>
    <details><summary>Set aside</summary><form><button>Record</button></form></details>
    <span>Not this</span>
  </div>
);

// --- 1. Sections derive from the two authorities -----------------------------------------------

test('1. where a Headline sits is a function of the Headline record and its Case, and nothing is lost', () => {
  const list = [
    headline({ id: 'hl_new' }),
    headline({ id: 'hl_inv' }),
    headline({ id: 'hl_res' }),
    headline({ id: 'hl_dis' }),
    setAside({ id: 'hl_set' }),
    setAside({ id: 'hl_set_with_case', dismissalBasis: 'WRONG' }),
  ];
  const cases = new Map<string, HeadlineCaseRef>([
    ['hl_inv', kase({ caseId: 'case_inv', state: 'WATCHING' })],
    ['hl_res', RESOLVED],
    ['hl_dis', CLOSED_WITHOUT_ACTING],
    // A Case exists, and the person set the Headline aside anyway. The person's
    // judgement about THIS Headline wins the section.
    ['hl_set_with_case', kase({ caseId: 'case_set', state: 'ASSIGNED' })],
  ]);

  const sections = sectionHeadlines(list, cases);
  assert.deepEqual(sections.current.map((e) => e.headline.id), ['hl_new']);
  assert.deepEqual(sections.investigating.map((e) => e.headline.id), ['hl_inv']);
  assert.deepEqual(sections.history.map((e) => e.headline.id), ['hl_res', 'hl_dis', 'hl_set', 'hl_set_with_case']);
  assert.equal(
    sections.current.length + sections.investigating.length + sections.history.length,
    list.length,
    'RESOLVED DOES NOT MEAN DELETED: every Headline is in exactly one section',
  );
  // The situation each entry carries is the shared projection's, not a UI guess.
  assert.deepEqual(sections.history.map((e) => e.situation), ['RESOLVED', 'DISMISSED_BY_INVESTIGATION', 'SET_ASIDE', 'SET_ASIDE']);
  assert.equal(sections.history[3]!.kase?.caseId, 'case_set', 'the Case is still carried and still linked');
});

// --- 2. A set-aside Headline: its record, and no decision ------------------------------------

test('2. a set-aside Headline renders "Set aside · basis · when" and NO Investigate or Set aside forms, whatever the page passed', () => {
  const raw = render(<HeadlineCard headline={setAside()} kase={null} investigate={CONTROLS} time={TIME} />);
  const text = strip(raw);

  assert.ok(text.includes(headlineSituationLabel('SET_ASIDE').label), 'the governed word');
  assert.ok(text.includes(HEADLINE_DISMISSAL_BASIS_LABELS.IMMATERIAL), 'the basis, in its governed words');
  assert.ok(text.includes(strip(TIME.date('2026-08-23T09:00:00.000Z'))), 'when, on the reader\'s clock');
  assert.ok(text.includes('by Matt'), 'and who');

  // THE DEFECT THIS FIXES: the page used to render Investigate and the dismissal
  // form on a dismissed Headline. The card now refuses them structurally.
  assert.equal(raw.includes('<form'), false, 'no form at all');
  assert.equal(text.includes('Investigate'), false);
  assert.equal(text.includes('Not this'), false);
  assert.equal(text.includes('Record'), false);
  assert.ok(text.includes('Look into it'), 'reading is always available');
  assert.ok(raw.includes('data-situation="SET_ASIDE"'));
  assert.ok(raw.includes('hl-card--history'), 'and it is history');
});

test('2b. set aside beats a Case on the card too: the record shows, and the Case stays reachable', () => {
  const raw = render(<HeadlineCard headline={setAside()} kase={kase({ caseId: 'case_9', state: 'ASSIGNED' })} investigate={CONTROLS} time={TIME} />);
  const text = strip(raw);
  assert.ok(text.includes(headlineSituationLabel('SET_ASIDE').label));
  assert.equal(text.includes('Already under investigation'), false, 'the person\'s judgement is what is said');
  assert.ok(raw.includes('/app/admin/cases/case_9'), 'but the investigation is still linked');
  assert.equal(raw.includes('<form'), false);
});

test('2c. a set-aside Headline with no basis or name on record says so rather than inventing them', () => {
  const text = strip(render(
    <HeadlineStanding headline={setAside({ dismissalBasis: null, dismissedByName: null })} kase={null} time={TIME} />,
  ));
  assert.ok(text.includes('No basis recorded'));
  assert.equal(text.includes('by '), false);
});

// --- 3. Resolved and closed: history with the outcome word -------------------------------------

test('3. a resolved investigation\'s Headline sits in History with its outcome word and close date', () => {
  const raw = render(<HeadlineCard headline={headline({ id: 'hl_res' })} kase={RESOLVED} investigate={CONTROLS} time={TIME} />);
  const text = strip(raw);
  assert.ok(raw.includes('hl-card--history'));
  assert.ok(text.includes(headlineSituationLabel('RESOLVED').label));
  assert.ok(text.includes(CASE_OUTCOME_LANGUAGE.RECOVERED.label), 'the outcome word, from the one dictionary');
  assert.ok(text.includes(strip(TIME.date('2026-08-24T10:00:00.000Z'))), 'when it closed');
  assert.ok(raw.includes('/app/admin/cases/case_res'), 'the Case is where the outcome is recorded');
  assert.ok(text.includes('Open investigation'));
  assert.equal(raw.includes('<form'), false, 'no decision is offered on history');
  assert.equal(text.includes('Investigate'), false);
});

test('3b. closed without acting is its own word, with its own outcome', () => {
  const text = strip(render(<HeadlineCard headline={headline({ id: 'hl_dis' })} kase={CLOSED_WITHOUT_ACTING} investigate={null} time={TIME} />));
  assert.ok(text.includes(headlineSituationLabel('DISMISSED_BY_INVESTIGATION').label));
  assert.ok(text.includes(CASE_OUTCOME_LANGUAGE.NO_ACTION_NEEDED.label));
  assert.equal(text.includes(headlineSituationLabel('RESOLVED').label), false, 'not dressed as resolved');
});

test('3c. a closed Case with nothing recorded says so, never a blank', () => {
  const text = strip(render(
    <HeadlineStanding headline={headline()} kase={kase({ state: 'RESOLVED', outcome: null, resolvedAt: null })} time={TIME} />,
  ));
  assert.ok(text.includes('No outcome recorded'));
  assert.ok(text.includes('Close time not recorded'));
});

test('3d. under investigation shows the Case\'s own lane word and a way in, and drops the decision controls', () => {
  const raw = render(<HeadlineCard headline={headline()} kase={kase({ state: 'WATCHING' })} investigate={CONTROLS} time={TIME} />);
  const text = strip(raw);
  assert.ok(text.includes(productLabel('WATCHING')!.label), 'the Case lane, in product language');
  assert.ok(text.includes('Already under investigation'));
  assert.ok(text.includes('Open investigation'));
  assert.equal(raw.includes('<form'), false);
  assert.equal(text.includes('Investigate'), false);
  assert.ok(raw.includes('data-situation="UNDER_INVESTIGATION"'));
});

test('3e. a current Headline is the ONLY one that renders the controls the page passed', () => {
  const raw = render(<HeadlineCard headline={headline()} kase={null} investigate={CONTROLS} time={TIME} />);
  assert.ok(raw.includes('<form'));
  assert.ok(strip(raw).includes('Investigate'));
  assert.ok(raw.includes('data-situation="NEW"'));
  assert.ok(raw.includes('hl-card--current'));
});

// --- 4. Filters map to the repository's options -------------------------------------------------

test('4. `show` parses against a closed set and an unknown value is the default, never an error', () => {
  assert.equal(parseShow('current'), 'current');
  assert.equal(parseShow('investigating'), 'investigating');
  assert.equal(parseShow('history'), 'history');
  assert.equal(parseShow('all'), 'all');
  assert.equal(parseShow(['history']), 'history');
  assert.equal(parseShow('archive'), null, 'there is no archive');
  assert.equal(parseShow(undefined), null);
  assert.equal(parseShow(''), null);
});

test('4b. every filter keeps every section on the page; it only decides what starts open', () => {
  const modes = [null, 'current', 'investigating', 'history', 'all'] as const;
  for (const mode of modes) {
    const open = expandedSections(mode);
    assert.deepEqual(Object.keys(open).sort(), ['CURRENT', 'HISTORY', 'INVESTIGATING'], `${mode}: all three sections are present`);
  }
  assert.deepEqual(expandedSections(null), { CURRENT: true, INVESTIGATING: true, HISTORY: false }, 'default: current + investigating open, history collapsed');
  assert.deepEqual(expandedSections('history'), { CURRENT: false, INVESTIGATING: false, HISTORY: true });
  assert.deepEqual(expandedSections('all'), { CURRENT: true, INVESTIGATING: true, HISTORY: true });
  assert.deepEqual(expandedSections('current'), { CURRENT: true, INVESTIGATING: false, HISTORY: false });
});

test('4c. the links carry the filter and the objective, and nothing else', () => {
  assert.equal(workspaceHref(null, null), '/app/admin/headlines');
  assert.equal(workspaceHref('history', null), '/app/admin/headlines?show=history');
  assert.equal(workspaceHref('all', 'obj_1'), '/app/admin/headlines?show=all&objective=obj_1');
  assert.equal(workspaceHref(null, 'obj 1'), '/app/admin/headlines?objective=obj+1', 'encoded');
});

test('4d. the objective scope is the repository\'s own filter, read with history included', () => {
  const data = code(read('../src/app/app/admin/headlines/headlines-data.ts'));
  const loader = data.slice(data.indexOf('export function loadHeadlinesForWorkspace'), data.indexOf('export function loadCasesForHeadlines'));
  assert.match(loader, /repositories\.headlines\.list\(organizationId, \{/, 'the existing list read');
  assert.match(loader, /performanceObjectiveId: options\.performanceObjectiveId/, 'the existing objective option');
  assert.equal(/dismissed/.test(loader), false, '`dismissed` is NOT passed, so set-aside Headlines are read with the rest');

  const page = code(read('../src/app/app/admin/headlines/page.tsx'));
  assert.match(page, /parseShow\(searchParams\?\.show\)/);
  assert.match(page, /searchParams\?\.objective/);
  assert.match(page, /loadHeadlinesForWorkspace\(session\.organizationId, \{ performanceObjectiveId: objectiveId \}\)/);
  // THE ORGANIZATION IS NEVER READ FROM THE URL.
  assert.equal(/searchParams[^\n]*organizationId|params\.organizationId/.test(page), false);
  assert.ok(page.includes('session.organizationId'));
});

// --- 5. The list page: guards, sections, failure branches ---------------------------------------

test('5. the list page keeps its guards, its banner first, and three sections from the projection', () => {
  const page = code(read('../src/app/app/admin/headlines/page.tsx'));
  assert.match(page, /requireWorkspace\('ADMIN'\)/);
  assert.match(page, /requirePermission\('commercialIntelligence', 'view'\)/);
  assert.match(page, /hasPermission\('commercialIntelligence', 'update'\)/);
  assert.ok(page.includes('canAuthor ?'), 'controls are conditional on the authoring grant');

  const banner = page.indexOf('<AttentionBanner');
  const nav = page.indexOf('<HeadlineShowNav');
  assert.ok(banner > -1 && nav > banner, 'the governed state comes before the list');

  for (const id of ['"CURRENT"', '"INVESTIGATING"', '"HISTORY"']) {
    assert.ok(page.includes('id=' + id), `section ${id} is rendered`);
  }
  assert.match(page, /sectionHeadlines\(feed\.value, cases\.value\)/, 'sections come from the two authorities, together');
  assert.match(page, /loadCasesForHeadlines\(session\.organizationId, feed\.value\.map/, 'one batch read for the Cases');
  assert.equal(/headlines\.length === 0/.test(page), false, 'no branch on list length');
});

test('5b. a list whose Cases could not be read is not sectioned: a failure is a failure, not a calm morning', () => {
  const page = code(read('../src/app/app/admin/headlines/page.tsx'));
  assert.ok(page.includes('!result.ok ?'), 'the attention failure branch');
  assert.ok(page.includes('!cases || !cases.ok ?'), 'the Cases failure branch');
  assert.ok(page.includes('!feed || !feed.ok ?'), 'the feed failure branch');
  assert.equal((page.match(/<ReadError/g) ?? []).length >= 3, true, 'each renders as an error');
  assert.equal(/cases\s*\?\?\s*new Map|cases\.value\s*\?\?|\?\? \[\]/.test(page), false, 'nothing coalesces a failed read into an empty one');
});

test('5c. every section is always rendered; a filter only expands, and an empty section defers to the banner', () => {
  const entries = sectionHeadlines([headline({ id: 'hl_res' })], new Map([['hl_res', RESOLVED]])).history;
  const collapsed = render(
    <HeadlineSectionBlock id="HISTORY" title="History" lead="Kept." entries={entries} expanded={false} empty="Nothing yet." time={TIME} />,
  );
  const expanded = render(
    <HeadlineSectionBlock id="HISTORY" title="History" lead="Kept." entries={entries} expanded={true} empty="Nothing yet." time={TIME} />,
  );
  assert.ok(collapsed.includes('<details'), 'a native disclosure');
  assert.equal(/<details[^>]*\sopen/.test(collapsed), false, 'collapsed by default');
  assert.match(expanded, /<details[^>]*\sopen/, 'expanded when asked');
  assert.ok(strip(collapsed).includes("Buyer CEM's monetized rate fell"), 'the history is IN the page even when collapsed');
  assert.ok(strip(collapsed).includes('History 1'), 'with its count in the summary');

  const empty = strip(render(
    <HeadlineSectionBlock id="CURRENT" title="Current" lead="Now." entries={[]} expanded={true} empty="Nothing is waiting for a decision. Whether that is good news is what the state above says." time={TIME} />,
  ));
  assert.ok(empty.includes('Nothing is waiting for a decision'));
  for (const soothing of ['All clear', 'No headlines', 'Verified']) {
    assert.equal(empty.includes(soothing), false, `an empty section must not say "${soothing}"`);
  }
});

test('5d. the filter nav names every section with its count and marks the chosen one', () => {
  const raw = render(<HeadlineShowNav show="history" counts={{ current: 2, investigating: 1, history: 4 }} objectiveId="obj_1" />);
  const text = strip(raw);
  for (const word of ['Open', 'Current', 'Under investigation', 'History', 'All']) assert.ok(text.includes(word), word);
  assert.ok(text.includes('History 4'));
  assert.ok(text.includes('Open 3'), 'open = current + investigating');
  // Attribute order is React's, not ours: find the one current link and read its href.
  const current = raw.match(/<a[^>]*aria-current="page"[^>]*>/g) ?? [];
  assert.equal(current.length, 1, 'exactly one link is current');
  assert.match(current[0]!, /href="\/app\/admin\/headlines\?show=history&(?:amp;)?objective=obj_1"/);
  assert.ok(raw.includes('href="/app/admin/headlines?objective=obj_1"'), 'the scope survives a filter change');
});

// --- 6. Nothing writes ------------------------------------------------------------------------------

test('6. rendering the workspace creates nothing: the UI module and the loaders are reads', () => {
  const ui = read('../src/app/app/admin/headlines/headline-ui.tsx');
  for (const forbidden of ['prisma', 'Service(', 'promote(', '.create(', '.update(', 'action={']) {
    assert.equal(ui.includes(forbidden), false, `the UI must not contain ${forbidden}`);
  }
  const data = code(read('../src/app/app/admin/headlines/headlines-data.ts'));
  for (const forbidden of ['.create(', '.update(', '.dismiss(', '.promote(', 'recordObservation', '.resolve(', '.ignore(', '$transaction']) {
    assert.equal(data.includes(forbidden), false, `the loaders must not contain ${forbidden}`);
  }
  // The Home contract these loaders keep.
  for (const kept of ['export function loadAttention(', 'export function loadExistingCase(', 'export function loadHeadline(']) {
    assert.ok(data.includes(kept), kept);
  }
});

// --- 7. The detail page -------------------------------------------------------------------------------

test('7. the detail page offers Set aside only with the authoring grant, and only while nobody has decided', () => {
  const page = code(read('../src/app/app/admin/headlines/[id]/page.tsx'));
  assert.match(page, /requireWorkspace\('ADMIN'\)/);
  assert.match(page, /requirePermission\('commercialIntelligence', 'view'\)/);
  assert.match(page, /hasPermission\('commercialIntelligence', 'update'\)/);
  assert.ok(page.includes('headlineAcceptsDecision(situation) && canAuthor ?'), 'both conditions, in that order');
  assert.ok(page.includes('dismissHeadlineAction'), 'reuses the existing dismissal action');
  assert.ok(page.includes('name="surface" value="headline"'), 'and returns to this page through the allow-listed surface');
  assert.equal(/searchParams[^\n]*organizationId|params\.organizationId/.test(page), false);
  assert.ok(page.includes('session.organizationId'));
  // CROSS-ORG IS NOT-FOUND. The repository resolves within the organization
  // and the page 404s on null, indistinguishable from a Headline that never was.
  assert.ok(page.includes('if (!headline) notFound();'));
  // And the situation is the shared projection, read from both authorities.
  assert.match(page, /headlineSituation\(headline, kase\)/);
  assert.match(page, /loadCasesForHeadlines\(session\.organizationId, \[headline\.id\]\)/);
  assert.ok(page.includes('Since it was identified'));
  assert.ok(page.includes('loadCoordination('), 'work is read through the Case\'s coordination read');
  // NO CREATE-WORK PATH IS PRETENDED. Nothing here starts work.
  assert.equal(/startWork|createWork|work\.create|WorkRepository/.test(page), false);
});

test('7b. the set-aside return surface appends only the repository-resolved id, never a form value', () => {
  const src = read('../src/app/app/admin/administration/objectives/actions.ts');
  const actions = code(src);
  assert.match(actions, /headline: '\/app\/admin\/headlines'/, 'an allow-listed key');
  assert.match(actions, /surface === 'headline' && subjectId/, 'the id is appended only for that surface');
  assert.match(actions, /dismissed\.id,?\s*\)/, 'and only the id the repository resolved and wrote');
  assert.equal(/formData\.get\(['"](returnTo|url|path|next)['"]\)/.test(actions), false);
});

// --- 8. No new lifecycle ---------------------------------------------------------------------------------

test('8. no Prisma model, column or migration was added: the situation is a projection in @emgloop/shared', () => {
  const schema = readFileSync(new URL('../../../packages/database/prisma/schema.prisma', import.meta.url), 'utf8');
  assert.equal(/model Headline(Situation|Archive|Task|State|History|Lifecycle)\b/.test(schema), false);
  const start = schema.indexOf('model Headline {');
  // DECLARATIONS ONLY. The model's own doc comments explain what a Headline is
  // NOT ("attention feedback, not an outcome"), and forbidding the words would
  // forbid the explanation. A column is a line that starts with the name.
  const columns = schema
    .slice(start, schema.indexOf('\n}', start))
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.trim().split(/\s+/)[0] ?? '');
  for (const column of ['situation', 'archived', 'resolvedAt', 'outcome', 'state', 'ownerUserId', 'assigneeUserId', 'lane']) {
    assert.equal(columns.includes(column), false, `the Headline model has no ${column} column`);
  }
  assert.ok(columns.includes('dismissedAt') && columns.includes('dismissalBasis'), 'the two dismissal columns are the whole of its feedback');
  const migrations = readdirSync(new URL('../../../packages/database/prisma/migrations/', import.meta.url));
  assert.equal(migrations.some((d) => /situation|headline_(state|archive|lifecycle)/i.test(d)), false);

  const shared = readFileSync(new URL('../../../packages/shared/src/headline-situation.ts', import.meta.url), 'utf8');
  assert.match(shared, /from '\.\/headline'/, 'it reads the Headline contract, not a Home-only type');
  assert.match(shared, /from '\.\/operational-lifecycle'/, 'and the Case contract');
  const ui = code(read('../src/app/app/admin/headlines/headline-ui.tsx'));
  assert.match(ui, /interface HeadlineCaseRef extends CaseStandingInput/, 'the UI\'s Case shape IS the projection\'s input');
});

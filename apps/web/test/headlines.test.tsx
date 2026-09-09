// The morning surface, tested on the distinctions it exists to preserve.
//
// WHAT THESE PROVE
//
// AN EMPTY LIST IS NOT AN ALL-CLEAR. Three of the four mornings render zero
// Headlines and only one of them is good news. The page has no branch on list
// length, and this asserts that by rendering all four and comparing what a
// person actually reads.
//
// EVIDENCE IS PART OF THE HEADLINE. Coverage, the comparison basis and what the
// measurement does not establish are in the card, not behind a link — because a
// person deciding whether to open an investigation needs the caveats at the
// moment they decide.
//
// RENDERING CREATES NOTHING. The card is a pure function of a view; the only
// write on the screen is a form posting to the guarded promotion action.
//
// NO INVENTED RELEVANCE, NO INVENTED CAUSE, NO CONFIDENCE. The surface says only
// what the contract supports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  MORNING_ALL_CLEAR,
  MORNING_CANT_TELL,
  MORNING_NEEDS_ATTENTION,
  MORNING_NOTHING_TO_CHECK,
  type HeadlineView,
} from '@emgloop/shared';

import { AttentionBanner, HeadlineCard } from '../src/app/app/admin/headlines/headline-ui';

const render = (el: unknown) => renderToStaticMarkup(el as never);
const strip = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

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
    limitations: ['Postback destinations settle after the call, so the most recent day may still move.'],
    unknowns: ['Loop cannot tell whether the change is CEM-wide or specific to one source.'],
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

// --- 1. Four mornings, four different sentences ---------------------------------------

test('1. an all-clear says what it checked, and carries no caveats', () => {
  const out = strip(render(<AttentionBanner attention={MORNING_ALL_CLEAR} />));
  assert.ok(out.includes('All clear'));
  assert.ok(out.includes('No material changes require your attention'));
  assert.ok(out.includes('3 active objectives'), 'it names what it looked at');
  assert.equal(out.includes("What Loop could not check"), false, 'nothing was left unchecked');
});

test('1b. zero Headlines with a coverage gap is NOT an all-clear', () => {
  // THE CENTRAL PROPERTY OF THE SURFACE. Both mornings render zero cards.
  assert.equal(MORNING_CANT_TELL.headlineCount, 0);
  assert.equal(MORNING_ALL_CLEAR.headlineCount, 0);

  const cant = strip(render(<AttentionBanner attention={MORNING_CANT_TELL} />));
  assert.ok(cant.includes("can't determine"));
  assert.equal(cant.includes('All clear'), false);
  assert.equal(cant.includes('No material changes'), false);
  assert.ok(cant.includes('What Loop could not check'));
});

test('1c. nothing to check is never rendered as healthy', () => {
  const out = strip(render(<AttentionBanner attention={MORNING_NOTHING_TO_CHECK} />));
  assert.ok(out.includes('Nothing to check'));
  for (const healthy of ['All clear', 'No material changes', 'Verified']) {
    assert.equal(out.includes(healthy), false, `must not say "${healthy}"`);
  }
  // And it offers the thing that would actually fix it.
  assert.ok(out.includes('Set an objective'));
});

test('1d. the four mornings are readably different from one another', () => {
  const texts = [MORNING_ALL_CLEAR, MORNING_CANT_TELL, MORNING_NEEDS_ATTENTION, MORNING_NOTHING_TO_CHECK]
    .map((a) => strip(render(<AttentionBanner attention={a} />)));
  assert.equal(new Set(texts).size, 4, 'no two mornings read the same');
});

test('1e. a morning with Headlines still reports what went unmeasured', () => {
  // Acting on one Headline must not hide that two objectives were not looked at.
  const out = strip(render(<AttentionBanner attention={MORNING_NEEDS_ATTENTION} />));
  assert.ok(out.includes('3 things need your attention'));
  assert.ok(out.includes('What Loop could not check'));
  assert.ok(out.includes('2 of 4'));
});

test('1f. the coverage gap names the objectives and their governed reasons', () => {
  const out = render(<AttentionBanner attention={MORNING_CANT_TELL} />);
  const text = strip(out);
  assert.ok(text.includes('Grow SSDI revenue per call'), 'named, so the gap is actionable');
  assert.ok(text.includes('Waiting for data'), 'in product language');
  assert.ok(out.includes('AUTHORITATIVE_DATA_PENDING'), 'with the governed name kept for whoever fixes it');
  // Three DIFFERENT reasons, because they lead to three different next moves.
  assert.ok(text.includes('Source not configured'));
  assert.ok(text.includes('Conflicting'));
});

// --- 2. The Headline itself ------------------------------------------------------------

test('2. a Headline answers the claim, why it matters, and the receipts', () => {
  const out = strip(render(<HeadlineCard headline={headline()} caseId={null} investigate={null} />));
  assert.ok(out.includes("Buyer CEM's monetized rate fell"), 'the claim');
  assert.ok(out.includes("Why you're seeing it"));
  assert.ok(out.includes('Grow Medicare answer rate'), 'the objective it was measured against');
  assert.ok(out.includes('against the direction'), 'and its relationship to that intent');
  assert.ok(out.includes('The receipts'));
  assert.ok(out.includes('98.0%'), 'coverage is in the card');
  assert.ok(out.includes('3,184'), 'and how many calls it measured');
  assert.ok(out.includes('Trailing 7 complete Eastern business days'), 'and the comparison basis');
});

test('2b. what the measurement does not establish is IN the card', () => {
  // Not behind a link and not on a second screen. A person deciding whether to
  // open an investigation needs the caveats at the moment they decide.
  const out = strip(render(<HeadlineCard headline={headline()} caseId={null} investigate={null} />));
  assert.ok(out.includes("What this measurement doesn't establish"));
  assert.ok(out.includes('may still move'), 'the limitation');
  assert.ok(out.includes('CEM-wide or specific to one source'), 'the unknown');
});

test('2c. no confidence percentage, no cause, no invented relevance', () => {
  const out = strip(render(<HeadlineCard headline={headline()} caseId={null} investigate={null} />));
  for (const forbidden of ['confidence', 'certainty', 'likelihood', '% sure', 'caused', 'because of']) {
    assert.equal(out.toLowerCase().includes(forbidden), false, `must not say "${forbidden}"`);
  }
  // And no claim about whose account it is — Loop has no governed answer.
  for (const invented of ['your account', 'you own', 'assigned to you', 'your buyer']) {
    assert.equal(out.toLowerCase().includes(invented), false, `must not say "${invented}"`);
  }
});

test('2d. an unknown number renders as an em dash, never as zero', () => {
  const out = strip(render(
    <HeadlineCard
      headline={headline({
        measurement: { ...headline().measurement, priorValue: null, percentageChange: null, currentCoverage: null },
      })}
      caseId={null}
      investigate={null}
    />,
  ));
  assert.ok(out.includes('—'), 'unknown renders honestly');
  assert.equal(out.includes('0.0%'), false, 'and never as a confident zero');
});

test('2e. the technical detail is present and not on the first read', () => {
  const out = render(<HeadlineCard headline={headline()} caseId={null} investigate={null} />);
  // Behind a disclosure the reader opens, not dumped on the morning screen.
  assert.ok(out.includes('<details'), 'progressive disclosure');
  assert.ok(out.includes('How Loop measured this'));
  assert.ok(out.includes('ci.objective-measure-change'), 'the rule id is reachable');
  assert.ok(out.includes('bind_1'), 'and the exact binding version');
  const summaryOnly = out.slice(0, out.indexOf('<details'));
  assert.equal(summaryOnly.includes('ci.objective-measure-change'), false, 'but not above it');
});

// --- 3. The human gate ----------------------------------------------------------------------

test('3. rendering a Headline creates nothing', () => {
  // The card is a pure function of a view. It reaches no service, no prisma, no
  // action — the only write on the screen is a form the person submits.
  const src = readFileSync(
    new URL('../src/app/app/admin/headlines/headline-ui.tsx', import.meta.url),
    'utf8',
  );
  for (const forbidden of ['prisma', 'Service(', 'promote(', '.create(', '.update(', 'action={']) {
    assert.equal(src.includes(forbidden), false, `the card must not contain ${forbidden}`);
  }
});

test('3b. when an investigation exists the card offers a way in, not a second button', () => {
  const withCase = strip(render(
    <HeadlineCard headline={headline()} caseId="case_1" investigate={<button>Investigate</button>} />,
  ));
  assert.ok(withCase.includes('Already under investigation'));
  assert.ok(withCase.includes('Open investigation'));
  // The Investigate control is not rendered at all, so a repeated press is not
  // something the surface even offers.
  assert.equal(withCase.includes('Investigate'), false);
});

test('3c. the Investigate control is supplied by the page, never built by the card', () => {
  // The card cannot invent an authorization control: it renders whatever the
  // guarded page passes, and a page that passes nothing shows nothing.
  const none = strip(render(<HeadlineCard headline={headline()} caseId={null} investigate={null} />));
  assert.equal(none.includes('Investigate'), false);
  assert.ok(none.includes('Look into it'), 'reading is always available');

  const given = strip(render(
    <HeadlineCard headline={headline()} caseId={null} investigate={<button>Investigate</button>} />,
  ));
  assert.ok(given.includes('Investigate'));
});

test('3d. the page requires the authoring permission before offering any control', () => {
  const src = readFileSync(new URL('../src/app/app/admin/headlines/page.tsx', import.meta.url), 'utf8');
  // READ to see the intelligence; the narrower UPDATE before anything is
  // pressable. The UI hiding a button is not access control — the action guards
  // itself too — but a viewer should not be shown authority they do not have.
  assert.ok(src.includes("requirePermission('commercialIntelligence', 'view')"));
  assert.ok(src.includes("hasPermission('commercialIntelligence', 'update')"));
  assert.ok(src.includes('canAuthor ?'), 'controls are conditional on it');
  // The organization is never read from a param.
  assert.equal(/searchParams.*organizationId|params\.organizationId/.test(src), false);
  assert.ok(src.includes('session.organizationId'), 'it comes from the signed session');
});

test('3e. the surface key is an allow-listed constant, never a URL from the form', () => {
  const src = readFileSync(
    new URL('../src/app/app/admin/administration/objectives/investigate-actions.ts', import.meta.url),
    'utf8',
  );
  assert.ok(src.includes('const SURFACES: Record<string, string>'), 'a fixed map');
  assert.ok(src.includes("SURFACES[surface]) || PATH"), 'unknown keys fall back');
  // An open redirect on an authenticated page is a vulnerability with a very old
  // name, and reading a returnTo URL out of a form is how you get one.
  //
  // SCANNED AS CODE, NOT AS PROSE. The header above the constant explains why a
  // `returnTo` URL is refused; forbidding the word would forbid the explanation,
  // which is the assertion eating the thing it protects.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.equal(/returnTo|redirectTo|nextUrl/.test(code), false);
  assert.equal(/formData\.get\(['"](returnTo|url|path|next)['"]\)/.test(code), false);
});

// --- 4. The page never renders a failure as an empty morning -------------------------------

test('4. a failed read cannot reach the success branch', () => {
  const page = readFileSync(new URL('../src/app/app/admin/headlines/page.tsx', import.meta.url), 'utf8');
  const data = readFileSync(new URL('../src/app/app/admin/headlines/headlines-data.ts', import.meta.url), 'utf8');
  // The result is discriminated, so `?? []` cannot turn an outage into a calm
  // morning — there is no nullable success to coalesce.
  assert.ok(data.includes("{ ok: true; value: T } | { ok: false; what: string }"));
  assert.ok(page.includes('!result.ok ?'), 'the failure branch is explicit');
  assert.ok(page.includes('<ReadError'), 'and renders as an error, not as emptiness');
  assert.equal(/attention\s*\?\?/.test(page), false, 'nothing coalesces the read away');
});

test('4b. the error copy warns against reading health into it', () => {
  const src = readFileSync(new URL('../src/app/app/_loop-os/product-state.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes('failure to read, not a finding'));
  assert.ok(src.includes('should be taken as evidence'));
});

// --- 5. Responsive and accessible --------------------------------------------------------------

test('5. nothing critical is hidden at narrow widths', () => {
  const css = readFileSync(new URL('../src/app/loop-os.css', import.meta.url), 'utf8');
  const mobile = css.slice(css.indexOf('@media (max-width: 720px) {', css.indexOf('STAGE 4 · HEADLINES')));
  const block = mobile.slice(0, mobile.indexOf('\n}\n'));
  // REFLOW, NEVER HIDE. A phone gets the claim, the evidence and the action.
  assert.equal(/display:\s*none/.test(block), false, 'the Stage 4 mobile block hides nothing');
  assert.ok(block.includes('flex-direction: column'), 'wide rows become stacks');
});

test('5b. the surfaces use real landmarks, headings and controls', () => {
  const banner = render(<AttentionBanner attention={MORNING_CANT_TELL} />);
  assert.ok(banner.includes('<section'), 'a landmark');
  assert.ok(banner.includes('aria-labelledby'), 'labelled');
  assert.ok(banner.includes('<h2'), 'a real heading');

  const card = render(<HeadlineCard headline={headline()} caseId={null} investigate={null} />);
  assert.ok(card.includes('<article'), 'each Headline is an article');
  assert.ok(card.includes('aria-labelledby="hl-hl_cem"'), 'labelled by its own claim');
  assert.ok(card.includes('<h3'), 'with a real heading');
  // Links are links; buttons are buttons.
  assert.ok(card.includes('<a '), 'a link to read more');
  assert.equal(/<div[^>]*onClick/.test(card), false, 'no div pretending to be a control');
});

test('5c. state is announced, not only coloured', () => {
  const out = render(<AttentionBanner attention={MORNING_CANT_TELL} />);
  assert.ok(out.includes('role="status"') === false, 'the banner is a section, not a live region');
  // The state word is present as text.
  assert.ok(strip(out).includes("Can't tell"));
  // And the direction glyph is decorative, with the meaning carried in words.
  const card = render(<HeadlineCard headline={headline()} caseId={null} investigate={null} />);
  assert.ok(card.includes('aria-hidden="true"'), 'glyphs are decorative');
  assert.ok(strip(card).includes('against the direction'), 'the meaning is in the text');
});

// The presentation layer, tested on what it actually renders.
//
// WHY THESE ARE RENDER TESTS AND NOT SNAPSHOTS. A snapshot proves the markup did
// not change; it proves nothing about whether "Not measured" and "On track" are
// still different words. Every assertion below is about a SEMANTIC distinction
// the product would be worse for losing, and each one is phrased so that a
// redesign is free and a collapse of meaning is not.
//
// NO NEW DEPENDENCY. `react-dom/server` ships with Next, and this uses the same
// `tsx --test` runner the other three workspaces already use. The only addition
// is a test-only tsconfig that compiles JSX with the automatic runtime, because
// Next's bundler — which normally owns that transform — is not present here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ATTENTION_STATES,
  MONITORING_VERDICTS,
  PRODUCT_TONES,
  READINESS_WITHHOLDINGS,
  SLA_STATES,
  WORK_EXECUTION_STATES,
  productLabel,
} from '@emgloop/shared';

import {
  NotKnown,
  ReadError,
  StateBadge,
  StateList,
  StateNote,
  toneFor,
} from '../src/app/app/_loop-os/product-state';

const html = (el: unknown) => renderToStaticMarkup(el as never);
/**
 * Markup to readable text.
 *
 * ENTITIES ARE DECODED, because React escapes an apostrophe to `&#x27;` and a
 * test asserting on "Can't tell" would otherwise fail against markup that is
 * perfectly correct. A helper that cannot read its own subject produces false
 * failures, which are worse than no test — people start ignoring it.
 */
const strip = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

// --- 1. Every governed state gets a human word ------------------------------------------

test('1. no governed state renders its raw enum as the primary label', () => {
  // The rule the whole layer exists for: an executive should never meet
  // RECONCILIATION_INCONCLUSIVE on a screen.
  const states = [
    ...READINESS_WITHHOLDINGS, ...SLA_STATES, ...WORK_EXECUTION_STATES,
    ...MONITORING_VERDICTS, ...ATTENTION_STATES,
  ];
  for (const s of states) {
    const out = strip(html(<StateBadge state={s} />));
    const label = productLabel(s)!.label;
    assert.ok(out.includes(label), `${s} renders "${label}"`);
    assert.equal(out.includes(s), false, `${s} must not render its own enum name by default`);
  }
});

test('1b. the technical name IS available when a reader needs it', () => {
  // Progressive disclosure in one prop: off for executives, on for operators.
  const out = strip(html(<StateBadge state="SOURCE_AUTHORITY_MISSING" technical />));
  assert.ok(out.includes('Source not configured'), 'the human word leads');
  assert.ok(out.includes('SOURCE_AUTHORITY_MISSING'), 'and the governed name is there');
});

test('1c. an unmapped state renders its real name, not a reassuring guess', () => {
  // A state nobody has named is one nobody has thought about, and the UI must
  // not paper over that with a plausible default.
  const out = strip(html(<StateBadge state="SOMETHING_A_LATER_BUILD_ADDED" />));
  assert.ok(out.includes('SOMETHING_A_LATER_BUILD_ADDED'));
  for (const soothing of ['Verified', 'On track', 'All clear', 'Healthy', 'OK']) {
    assert.equal(out.includes(soothing), false, `must not render "${soothing}"`);
  }
});

// --- 2. Distinctions that must survive rendering -------------------------------------------

test('2. unmeasured work never renders as on track', () => {
  const unknown = strip(html(<StateBadge state="UNKNOWN" />));
  const within = strip(html(<StateBadge state="WITHIN_POLICY" />));
  assert.ok(unknown.includes('Not measured'));
  assert.ok(within.includes('On track'));
  assert.notEqual(unknown, within);
  assert.equal(unknown.includes('On track'), false);
});

test('2b. an inconclusive monitor never renders as a successful one', () => {
  const inconclusive = strip(html(<StateBadge state="INCONCLUSIVE" />));
  const held = strip(html(<StateBadge state="HELD" />));
  const neither = strip(html(<StateBadge state="NEITHER" />));
  assert.notEqual(inconclusive, held);
  assert.notEqual(inconclusive, neither, '"could not tell" is not "did neither"');
  assert.equal(inconclusive.toLowerCase().includes('held'), false);
});

test('2c. insufficient coverage never renders as all clear', () => {
  const cant = strip(html(<StateBadge state="INSUFFICIENT_COVERAGE" />));
  const clear = strip(html(<StateBadge state="ALL_CLEAR" />));
  assert.ok(clear.includes('All clear'));
  assert.equal(cant.includes('All clear'), false);
  assert.notEqual(toneFor(productLabel('INSUFFICIENT_COVERAGE')!.tone), toneFor(productLabel('ALL_CLEAR')!.tone));
});

test('2d. nothing to check is never rendered as healthy', () => {
  const out = strip(html(<StateBadge state="NOTHING_TO_CHECK" />));
  assert.ok(out.includes('Nothing to check'));
  for (const healthy of ['All clear', 'Verified', 'Healthy']) {
    assert.equal(out.includes(healthy), false);
  }
});

test('2e. waiting on us and waiting on them stay different words', () => {
  const internal = strip(html(<StateBadge state="waiting_internal" />));
  const external = strip(html(<StateBadge state="waiting_external" />));
  assert.notEqual(internal, external);
});

// --- 3. State is never colour alone ----------------------------------------------------------

test('3. every badge carries a word as well as a colour', () => {
  for (const s of [...SLA_STATES, ...ATTENTION_STATES, ...MONITORING_VERDICTS]) {
    const out = strip(html(<StateBadge state={s} />));
    assert.ok(out.length > 2, `${s} renders readable text, not just a swatch`);
  }
});

test('3b. every tone has a glyph, and the glyphs differ in shape', () => {
  // Not just in hue: a monochrome screen, a printout and any form of colour
  // blindness all get the same information.
  const glyphs = new Set<string>();
  for (const s of ['READY', 'AUTHORITATIVE_DATA_INCOMPLETE', 'AUTHORITATIVE_DATA_PENDING', 'SOURCE_AUTHORITY_MISSING', 'RECONCILIATION_INCONCLUSIVE']) {
    const out = html(<StateBadge state={s} />);
    const m = out.match(/ps-badge__glyph"[^>]*>([^<]+)</);
    assert.ok(m, `${s} has a glyph`);
    glyphs.add(m![1]!);
  }
  assert.equal(glyphs.size, PRODUCT_TONES.length, 'one distinct glyph per product tone');
});

test('3c. the tone class is never the only difference between two states', () => {
  // Two states sharing a visual tone must still read differently.
  const setup = strip(html(<StateBadge state="SOURCE_AUTHORITY_MISSING" />));
  const incomplete = strip(html(<StateBadge state="POPULATION_INCOMPLETE" />));
  assert.equal(toneFor('NEEDS_SETUP'), 'warn');
  assert.equal(toneFor('INCOMPLETE'), 'warn');
  assert.notEqual(setup, incomplete, 'same colour, different words');
});

// --- 4. Unknown is a block, and error is not unknown --------------------------------------------

test('4. what Loop does not know renders as a section, not a footnote', () => {
  const out = html(<NotKnown lines={['Loop cannot find the work this Case pointed at.']} />);
  assert.ok(out.includes('<section'), 'a real landmark');
  assert.ok(out.includes('aria-labelledby'), 'and it is labelled for assistive technology');
  assert.ok(strip(out).includes("What Loop doesn't know"));
  assert.ok(strip(out).includes('cannot find the work'));
});

test('4b. it renders nothing only when there is nothing', () => {
  assert.equal(html(<NotKnown lines={[]} />), '');
  assert.notEqual(html(<NotKnown lines={['one thing']} />), '');
});

test('4c. a failed read is visibly not a governed state', () => {
  // ERROR means Loop could not look. UNKNOWN means Loop looked and could not
  // establish something. Rendering the first as an empty successful state is the
  // single most damaging thing this UI could do.
  const err = html(<ReadError what="today's headlines" />);
  assert.ok(err.includes('role="alert"'), 'announced, not silent');
  const text = strip(err);
  assert.ok(text.includes('could not load'));
  assert.ok(text.includes('failure to read, not a finding'));
  assert.ok(text.includes('should be taken as evidence'), 'it warns against reading health into it');

  // And it shares no class with any governed badge, so it cannot be mistaken.
  const badge = html(<StateBadge state="ALL_CLEAR" />);
  assert.equal(err.includes('ps-badge'), false);
  assert.equal(badge.includes('ps-error'), false);
});

test('4d. a read error offers a way back without pretending to know the answer', () => {
  const out = strip(html(<ReadError what="this investigation" retryHref="/app/admin/headlines" />));
  assert.ok(out.includes('Try again'));
  assert.equal(out.includes('No headlines'), false);
  assert.equal(out.includes('nothing'), false);
});

// --- 5. Lists and notes ------------------------------------------------------------------------

test('5. repeated meanings collapse to one word, and the states survive underneath', () => {
  // Three withholdings that all mean "waiting for data" are one thing a person
  // needs to know. Showing the word three times teaches nobody anything.
  const out = strip(html(
    <StateList states={['WINDOW_NOT_OBSERVED', 'RECONCILIATION_MISSING', 'AUTHORITATIVE_DATA_PENDING']} />,
  ));
  assert.equal(out.split('Waiting for data').length - 1, 1, 'said once');

  const technical = strip(html(
    <StateList technical states={['WINDOW_NOT_OBSERVED', 'RECONCILIATION_MISSING']} />,
  ));
  assert.ok(technical.includes('WINDOW_NOT_OBSERVED'), 'the governed name is still reachable');
});

test('5b. a note carries the badge and the explanation together', () => {
  const out = strip(html(<StateNote state="MEASURE_NOT_SUPPORTED_BY_SOURCE" />));
  assert.ok(out.includes('Source not configured'));
  assert.ok(out.includes('does not report the figure'), 'the sentence, not just the chip');
});

// --- 6. One dictionary --------------------------------------------------------------------------

test('6. no component declares its own translation of a governed state', () => {
  // The third translation layer is how a repository ends up with "Verified" on
  // one screen and "Confirmed" on another. There is one, it is imported, and
  // this walks the tree to keep it that way.
  const labels = [...SLA_STATES, ...ATTENTION_STATES, ...MONITORING_VERDICTS]
    .map((s) => productLabel(s)!.label);

  const walk = (dir: URL): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const child = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
      if (e.isDirectory()) out.push(...walk(child));
      else if (/\.tsx?$/.test(e.name)) out.push(child.pathname);
    }
    return out;
  };

  // COMMENTS ARE STRIPPED FIRST. `entity-page.tsx` documents its own health
  // field as `"Healthy" | "At risk" | "On track" | "Unmeasured"` — that is a
  // JSDoc example of an unrelated vocabulary, not a translation of a governed
  // state. An assertion that forbade the words would forbid the documentation,
  // which is the assertion eating the thing it protects.
  const codeOnly = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  for (const file of walk(new URL('../src/app/app/', import.meta.url))) {
    if (file.endsWith('product-state.tsx')) continue;
    // KNOWN, NAMED, AND TRACKED BY THE TEST BELOW rather than silently skipped.
    if (file.includes('admin/work/')) continue;
    const src = codeOnly(readFileSync(file, 'utf8'));
    for (const label of labels) {
      // A hard-coded product word in a component means somebody re-derived the
      // mapping instead of importing it.
      assert.equal(
        src.includes(`'${label}'`) || src.includes(`"${label}"`),
        false,
        `${file.split('/app/app/')[1]} hard-codes the product label "${label}"`,
      );
    }
  }
});

test('6b. the presentation layer decides appearance and never meaning', () => {
  const src = readFileSync(new URL('../src/app/app/_loop-os/product-state.tsx', import.meta.url), 'utf8');
  // It imports the mapping; it does not restate it.
  assert.ok(src.includes("from '@emgloop/shared'"));
  assert.ok(src.includes('productLabel'));
  // And it holds no product words of its own beyond the two structural headings.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const words = [...SLA_STATES, ...MONITORING_VERDICTS].map((s) => productLabel(s)!.label);
  for (const w of words) {
    assert.equal(code.includes(`'${w}'`), false, `must not hard-code "${w}"`);
  }
});

test('6c. the one pre-existing surface that names a health state itself is on record', () => {
  // WORK OS\'S DETAIL PAGE PREDATES THE SLA VOCABULARY and derives its own
  // health from `work_stages.status`, calling a stage with no execution history
  // "On track". That is the exact defect the SLA UNKNOWN state exists to
  // prevent: absence of overdue evidence is not compliance.
  //
  // It is EXEMPTED FROM THE WALK ABOVE AND ASSERTED HERE INSTEAD, so the
  // exemption is visible and the finding cannot be forgotten. Fixing it means
  // that page reading WorkExecutionService, which is a behavioural change to a
  // shipped surface and belongs in its own change — not smuggled into the
  // foundation of a different feature.
  //
  // WHEN IT IS FIXED, this test fails and should be deleted along with the
  // exemption. That is the intended lifecycle.
  const src = readFileSync(
    new URL('../src/app/app/admin/work/[id]/page.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(
    src.includes("label: 'On track'"),
    'if this no longer holds, delete this test and the exemption in test 6',
  );
  // And it must not have grown a SECOND self-derived vocabulary in the meantime.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const label of ['Not measured', "Can't tell", 'All clear', 'Badly overdue']) {
    assert.equal(code.includes(`'${label}'`), false, `must not hard-code "${label}" either`);
  }
});

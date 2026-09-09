// The personal queue, patterns, and the review harness.
//
// WHAT THESE PROVE
//
// NO MYSTERIOUS SCORE. The order arrives decided and its explanation arrives
// with it; the surface renders both and sorts nothing. A "Priority: 87.4" would
// be a claim nobody could reconstruct.
//
// AN EMPTY QUEUE IS NOT AN ALL-CLEAR. "Nothing is waiting on me" and "nothing
// needs the organization's attention" are different questions, and the empty
// state says so rather than letting the first read as the second.
//
// A PATTERN IS NEVER DOCTRINE, at any count, and preference is never averaged
// with outcome.
//
// THE REVIEW HARNESS IS FAIL-CLOSED AND IS NOT AN INTELLIGENCE SOURCE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  PATTERN_EMERGING,
  PATTERN_OBSERVATION,
  PATTERN_MATURITIES,
  isDemoSeedEnabled,
} from '@emgloop/shared';
import type { PersonalPriorityView } from '@emgloop/shared';

import { PersonalQueue } from '../src/app/app/admin/queue/queue-ui';
import { PatternCard } from '../src/app/app/admin/review/pattern-ui';

const render = (el: unknown) => renderToStaticMarkup(el as never);
const strip = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const NOT_CONSIDERED = [
  'Revenue exposure is not recorded anywhere in this platform, so it was not weighed.',
  'What a client is worth is not recorded, so it was not weighed.',
];

function item(over: Partial<PersonalPriorityView> = {}): PersonalPriorityView {
  return {
    caseId: 'case_cem',
    userId: 'usr_charlie',
    ruleVersion: 'personal-priority.v1',
    significance: {
      severity: 'HIGH',
      againstObjective: true,
      measuredImpactCents: 41_200_00,
      percentageChange: -0.31,
    },
    tier: 'AWAITED_DECISION',
    reasons: [
      {
        tier: 'AWAITED_DECISION',
        statement: 'You were asked to decide whether to move volume, and have not been released.',
        source: 'PARTICIPANT',
        sourceId: 'p1',
      },
    ],
    notConsidered: NOT_CONSIDERED,
    ...over,
  } as PersonalPriorityView;
}

const queue = (over: Record<string, unknown> = {}) =>
  ({
    userId: 'usr_charlie',
    items: [
      item(),
      item({
        caseId: 'case_apex',
        tier: 'ORGANIZATION_WIDE',
        significance: { severity: 'NOTABLE', againstObjective: false, measuredImpactCents: null, percentageChange: null },
        reasons: [
          { tier: 'ORGANIZATION_WIDE', statement: 'Nothing connects you to this investigation personally.', source: 'NONE', sourceId: null },
        ],
      }),
    ],
    orderings: [
      {
        aboveCaseId: 'case_cem',
        belowCaseId: 'case_apex',
        reason: 'TIER',
        statement: 'You were asked to decide on this one, and nothing connects you to the next.',
      },
    ],
    notConsidered: NOT_CONSIDERED,
    ...over,
  }) as never;

// --- 1. The order is explained, never scored --------------------------------------------

test('1. every adjacent pair carries the sentence that produced the order', () => {
  const out = strip(render(<PersonalQueue queue={queue()} />));
  assert.ok(out.includes('Why this is above the next'));
  assert.ok(out.includes('You were asked to decide on this one'));
});

test('1b. there is no score anywhere', () => {
  const out = strip(render(<PersonalQueue queue={queue()} />));
  for (const forbidden of ['priority:', 'score', 'rank:', 'weight', 'points']) {
    assert.equal(out.toLowerCase().includes(forbidden), false, `must not say "${forbidden}"`);
  }
  // The positions are ordinals, not values — and they are decorative.
  const raw = render(<PersonalQueue queue={queue()} />);
  assert.ok(raw.includes('aria-hidden="true"'), 'the number is decorative');
});

test('1c. why an item is yours names the row it came from', () => {
  const out = strip(render(<PersonalQueue queue={queue()} />));
  assert.ok(out.includes('Why this is yours'));
  assert.ok(out.includes('You were asked to decide whether to move volume'));
  assert.ok(out.includes('from participant'), 'the source');
  assert.ok(out.includes('p1'), 'and the exact row');
});

test('1d. what the ranking could not weigh is shown, not hidden', () => {
  const out = strip(render(<PersonalQueue queue={queue()} />));
  assert.ok(out.includes('What this order could not take into account'));
  assert.ok(out.includes('Revenue exposure is not recorded'));
  // Unavailable factors are stated, never treated as zero.
  assert.equal(out.includes('Revenue exposure: $0'), false);
});

test('1e. an unmeasured effect is an em dash, never zero', () => {
  const out = strip(render(<PersonalQueue queue={queue()} />));
  assert.ok(out.includes('—'));
  assert.equal(out.includes('$0'), false);
});

test('1f. an item nothing connects you to still appears, and says so', () => {
  // A queue that hid them would let the most important thing in the business be
  // invisible to everybody not personally named on it.
  const out = strip(render(<PersonalQueue queue={queue()} />));
  assert.ok(out.includes('Not assigned to you'));
  assert.ok(out.includes('Nothing connects you to this investigation personally'));
});

// --- 2. An empty queue is not an all-clear ---------------------------------------------------

test('2. an empty queue refuses to imply the business is fine', () => {
  const out = strip(render(<PersonalQueue queue={queue({ items: [], orderings: [] })} />));
  assert.ok(out.includes('Nothing is currently waiting on you'));
  assert.ok(out.includes('not the same as everything being fine'));
  assert.ok(out.includes("today's Headlines"), 'and it points at the surface that answers that');
  for (const wrong of ['all clear', 'nothing needs attention', "you're all caught up"]) {
    assert.equal(out.toLowerCase().includes(wrong), false, `must not say "${wrong}"`);
  }
});

test('2b. the queue page takes the user from the session, never a param', () => {
  const src = readFileSync(new URL('../src/app/app/admin/queue/page.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes('session.userId'));
  assert.ok(src.includes('session.organizationId'));
  // A queue askable on somebody else's behalf would be a cross-user read
  // wearing a URL.
  assert.equal(/searchParams|params\.userId|formData/.test(src), false);
  assert.ok(src.includes("requirePermission('commercialIntelligence', 'view')"));
});

test('2c. a failed queue read is an error, not an empty queue', () => {
  const src = readFileSync(new URL('../src/app/app/admin/queue/page.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes('<ReadError'));
  assert.ok(src.includes('failed || !queue'));
});

// --- 3. Patterns are never doctrine -------------------------------------------------------------

test('3. a single observation says it is one, and carries every refusal', () => {
  const out = strip(render(<PatternCard pattern={PATTERN_OBSERVATION} />));
  assert.ok(out.includes('Seen'), 'the maturity label');
  assert.ok(out.includes('1 comparable investigation'));
  assert.ok(out.includes('What this does not establish'));
  assert.ok(out.includes('does not say what caused what'));
  assert.ok(out.includes('decision a person takes'));
});

test('3b. an emerging pattern is still not how EMG operates', () => {
  const out = strip(render(<PatternCard pattern={PATTERN_EMERGING} />));
  assert.ok(out.includes('Worth a look'));
  assert.ok(out.includes('4 comparable investigations'));
  assert.ok(out.includes('not yet how EMG operates'));
  // The promotion refusal never drops off, at any count.
  assert.ok(out.includes('decision a person takes'));
  assert.equal(PATTERN_MATURITIES.includes('ESTABLISHED_OPERATING_PATTERN'), true);
  assert.notEqual(PATTERN_EMERGING.maturity, 'ESTABLISHED_OPERATING_PATTERN');
});

test('3c. preference and outcome are two columns, never one number', () => {
  const out = strip(render(<PatternCard pattern={PATTERN_EMERGING} />));
  assert.ok(out.includes('What people chose'));
  assert.ok(out.includes('Followed by a monitored recovery'));
  assert.ok(out.includes('A statement about preference, not about what works'));
  assert.ok(out.includes('A statement about correlation, not about cause'));
  // The denominator is monitored Cases, not all Cases.
  assert.ok(out.includes('of 2 monitored') || out.includes('of 1 monitored'));
  for (const forbidden of ['effectiveness', 'success rate', 'win rate', '%']) {
    assert.equal(out.toLowerCase().includes(forbidden), false, `must not say "${forbidden}"`);
  }
});

test('3d. unmonitored Cases are reported, not folded in as failures', () => {
  const out = strip(render(<PatternCard pattern={PATTERN_EMERGING} />));
  assert.ok(out.includes('1 of 4 comparable Cases were never monitored'));
});

// --- 4. The review harness ------------------------------------------------------------------------

test('4. the harness is fail-closed on the environment gate that already exists', () => {
  const src = readFileSync(new URL('../src/app/app/admin/review/page.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes('isDemoSeedEnabled(process.env)'));
  assert.ok(src.includes('notFound()'), 'production returns not-found, not a forbidden page');
  // And it is still guarded like every other surface.
  assert.ok(src.includes("requirePermission('commercialIntelligence', 'view')"));

  // The gate itself fails closed: no opt-in means no harness, anywhere.
  assert.equal(isDemoSeedEnabled({}), false);
  assert.equal(isDemoSeedEnabled({ EMG_SEED_DEMO: 'true', NODE_ENV: 'production' }), false);
  assert.equal(isDemoSeedEnabled({ EMG_SEED_DEMO: 'true', NODE_ENV: 'development' }), true);
});

test('4b. the harness reads nothing and writes nothing', () => {
  const src = readFileSync(new URL('../src/app/app/admin/review/page.tsx', import.meta.url), 'utf8');
  for (const forbidden of ['prisma', 'Service(', 'repositories.', 'action={', '.create(']) {
    assert.equal(src.includes(forbidden), false, `the harness must not contain ${forbidden}`);
  }
});

test('4c. no production surface imports the fixtures', () => {
  // The review page is the ONE place fixtures may appear, and it is gated.
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
  for (const file of walk(new URL('../src/app/', import.meta.url))) {
    if (file.includes('/admin/review/')) continue;
    const src = readFileSync(file, 'utf8');
    for (const fixture of ['MORNING_ALL_CLEAR', 'WORK_BLOCKED', 'PATTERN_EMERGING', 'stage4-ui.fixture', 'product-states.fixture']) {
      assert.equal(
        src.includes(fixture),
        false,
        `${file.split('/src/app/')[1]} must not import ${fixture}`,
      );
    }
  }
});

test('4d. the harness covers the states that are hardest to reach in production', () => {
  const src = readFileSync(new URL('../src/app/app/admin/review/page.tsx', import.meta.url), 'utf8');
  for (const state of [
    'MORNING_ALL_CLEAR', 'MORNING_CANT_TELL', 'MORNING_NEEDS_ATTENTION', 'MORNING_NOTHING_TO_CHECK',
    'WORK_BLOCKED', 'WORK_ESCALATION_ELIGIBLE', 'WORK_NOT_MEASURED', 'WORK_REFERENCE_DANGLING',
    'MONITORING_INCONCLUSIVE', 'OUTCOME_RECOVERED_NO_CAUSE', 'PATTERN_OBSERVATION', 'PATTERN_EMERGING',
  ]) {
    assert.ok(src.includes(state), `the harness must show ${state}`);
  }
  // And the failed-read state, which is not a governed state at all.
  assert.ok(src.includes('<ReadError'));
});

// --- 5. No LLM, no external action, anywhere in this package ----------------------------------------

test('5. no Stage 4 surface calls a model or performs an external action', () => {
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
  const surfaces = walk(new URL('../src/app/app/admin/', import.meta.url)).filter((f) =>
    /\/(headlines|cases|queue|review)\//.test(f) || f.endsWith('product-state.tsx'),
  );
  assert.ok(surfaces.length >= 8, 'the walk found the Stage 4 surfaces');

  for (const file of surfaces) {
    const src = readFileSync(file, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    for (const forbidden of [
      /\banthropic\b/i, /\bopenai\b/i, /\bclaude-/i, /\bgpt-/i,
      /\bfetch\s*\(/, /nodemailer/, /\bresend\b/i, /sendMail/,
    ]) {
      assert.equal(forbidden.test(code), false, `${file.split('/admin/')[1]} must not contain ${forbidden}`);
    }
  }
});

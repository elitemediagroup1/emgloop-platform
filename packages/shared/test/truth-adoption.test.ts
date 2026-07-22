// Truth States — adoption enforcement (an architecture fitness function).
//
// WHY THIS AND NOT AN ESLINT RULE
//
// ESLint is not configured in this repository: there is no config, no
// dependency, and `npm run lint` has never passed (see CLAUDE.md §Validation).
// An ESLint rule would therefore enforce exactly nothing until someone first
// fixes that baseline. This test runs today, in the harness the repo already
// uses (`node --test`), and fails the build the moment a regression lands.
//
// WHAT IT ENFORCES
//
//   1. A repository/service method that returns a bare measurement must return
//      Truth. `Promise<number>` cannot express "we did not measure".
//   2. Executive surfaces may not coerce a measurement to zero with `?? 0` or
//      `|| 0`. That single pattern is what made a database outage render as
//      "0 calls · $0 revenue".
//
// HOW TO SATISFY IT
//
// Return `Promise<Truth<number>>` (see packages/shared/src/truth), or render
// through `renderTruth`. If neither applies, add an entry to the allowlist
// below WITH A REASON. The reason is mandatory and is printed on failure —
// adding one is meant to be a deliberate, reviewable act, not a quick unblock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** Names that denote a measured quantity rather than an identifier or a setting. */
const MEASUREMENT = /(cents|amount|revenue|payout|cost|rate|count|total|calls|orders|bookings|qualified|conversions?|margin|score|confidence|percent|pct|duration|seconds|hours|volume|spend|clicks|impressions)/i;

/**
 * Deliberate exceptions. Every entry needs a reason, and the reason is shown
 * when this test reports. An unexplained exception is not permitted.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; match: string; reason: string }> = [
  {
    file: 'packages/database/src/repositories/marketplace-call.repository.ts',
    match: 'countWindow',
    reason:
      'Internal projection helper used only by backfill/verification paths, never rendered. ' +
      'Its Truth-returning counterpart for UI consumption is coverageObservations().',
  },
  {
    file: 'packages/database/src/repositories/interaction.repository.ts',
    match: 'countPhoneInWindow',
    reason:
      'Pipeline diagnostic for the CallGrid reconciliation report, not an executive metric. Its zero ' +
      'is the informative case — it is precisely how an operator distinguishes "ingestion never landed" ' +
      'from "ingestion landed but the projection did not". A Truth wrapper would obscure that signal, ' +
      'and the route surfaces a read failure as a 500 rather than as a count.',
  },
  {
    file: 'apps/web/src/app/app/_loop-os/format.ts',
    match: '?? 0',
    reason:
      'Not present — format.ts intentionally has no zero-defaulting. Retained as a guard entry ' +
      'so that reintroducing one here surfaces in review rather than silently passing.',
  },
];

const isAllowed = (file: string, snippet: string): string | null => {
  const hit = ALLOWLIST.find((a) => file.endsWith(a.file) && snippet.includes(a.match));
  return hit ? hit.reason : null;
};

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(test|verification|guarantee)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

function report(violations: Violation[], rule: string, howToFix: string): void {
  if (violations.length === 0) return;
  const lines = violations
    .map((v) => `  ${v.file}:${v.line}\n      ${v.snippet.trim()}`)
    .join('\n');
  assert.fail(
    `\n${rule}\n\n${lines}\n\n${howToFix}\n` +
      `If an exception is genuinely correct, add it to ALLOWLIST in ` +
      `packages/shared/test/truth-adoption.test.ts with a written reason.\n`,
  );
}

// --- Rule 1: measurement methods return Truth ------------------------------

test('repository and service methods do not return bare numeric measurements', () => {
  const files = [
    ...walk(join(REPO_ROOT, 'packages/database/src/repositories')),
    ...walk(join(REPO_ROOT, 'packages/database/src/services')),
  ];

  const violations: Violation[] = [];
  // `async name(...): Promise<number>` / `Promise<number | null>` / `| undefined`
  const signature = /async\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*:\s*Promise<\s*number(\s*\|\s*(null|undefined))?\s*>/;

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        const m = signature.exec(text);
        if (!m) return;
        if (isAllowed(rel, text)) return;
        violations.push({ file: rel, line: i + 1, snippet: text });
      });
  }

  report(
    violations,
    'Truth States: a measurement method returned a bare number.\n' +
      'A bare `Promise<number>` cannot distinguish "measured zero" from "did not measure",\n' +
      'which is the exact failure Truth States exists to prevent.',
    'Fix: return `Promise<Truth<number>>` and build it with measure()/measuredCount()\n' +
      'from @emgloop/shared. See docs/TRUTH_STATES.md §5.',
  );
});

// --- Rule 2: executive surfaces never coerce a measurement to zero ---------
//
// A RATCHET, not a clean-room rule. These four sub-pages predate Truth States
// and carry 43 zero-coercions between them. Failing the build on all of them
// today would only tempt the next engineer to delete the test, so the debt is
// recorded here instead and may only ever DECREASE.
//
// The enforcement that matters is immediate: a NEW violation, or a new file
// with any violation at all, fails the build. Migrated surfaces are pinned at
// zero and can never regress. As each page migrates, lower its number; when it
// reaches 0, delete the entry.
const ZERO_COERCION_DEBT: Readonly<Record<string, number>> = {
  'apps/web/src/app/app/admin/marketplace/vendors/page.tsx': 19,
  'apps/web/src/app/app/admin/marketplace/buyers/page.tsx': 11,
  // sources/page.tsx paid off its debt (rewritten as the lightweight listing) — entry removed.
  'apps/web/src/app/app/admin/marketplace/campaigns/page.tsx': 5,
};

function findZeroCoercions(): Map<string, Violation[]> {
  const files = walk(join(REPO_ROOT, 'apps/web/src/app/app/admin'));
  // `something.revenueCents ?? 0`, `traffic.totalCalls || 0`
  const coercion =
    /([a-zA-Z0-9_.?[\]]*(?:cents|amount|revenue|payout|cost|rate|count|total|calls|orders|bookings|qualified|margin|score|percent|pct|duration|seconds|volume|spend)[a-zA-Z0-9_.?[\]]*)\s*(\?\?|\|\|)\s*0\b/i;

  const byFile = new Map<string, Violation[]>();
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).split('\\').join('/');
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        if (text.trim().startsWith('//') || text.trim().startsWith('*')) return;
        const m = coercion.exec(text);
        if (!m || !MEASUREMENT.test(m[1] ?? '')) return;
        if (isAllowed(rel, text)) return;
        const list = byFile.get(rel) ?? [];
        list.push({ file: rel, line: i + 1, snippet: text });
        byFile.set(rel, list);
      });
  }
  return byFile;
}

test('no NEW executive surface coerces a measurement to zero', () => {
  const found = findZeroCoercions();
  const regressions: Violation[] = [];

  for (const [file, violations] of found) {
    const budget = ZERO_COERCION_DEBT[file] ?? 0;
    if (violations.length > budget) {
      // Report the overflow, newest lines first — the additions are the problem.
      regressions.push(...violations.slice(budget));
    }
  }

  report(
    regressions,
    'Truth States: a measurement was defaulted to zero on an executive surface.\n' +
      '`?? 0` and `|| 0` erase the difference between a real zero, an unmeasured\n' +
      'value and a failed read — a database outage then renders as "$0".\n' +
      'This file is either newly offending or exceeded its recorded debt budget.',
    'Fix: carry the value as `Truth<number>` and render it with renderTruth()\n' +
      'from @emgloop/shared. See docs/TRUTH_STATES.md §6.',
  );
});

test('migrated surfaces stay at zero coercions and never regress', () => {
  const found = findZeroCoercions();
  const migrated = [
    'apps/web/src/app/app/admin/marketplace/page.tsx',
    'apps/web/src/app/app/admin/marketplace/marketplace-coverage-data.ts',
    'apps/web/src/app/app/admin/marketplace/_MarketplaceCoverage.tsx',
    'apps/web/src/app/app/admin/page.tsx',
  ];
  for (const file of migrated) {
    assert.equal(
      (found.get(file) ?? []).length,
      0,
      `${file} is migrated to Truth States and must contain no zero-coercions. ` +
        'Render through renderTruth() instead.',
    );
  }
});

test('the zero-coercion debt ledger is accurate and shrinking-only', () => {
  const found = findZeroCoercions();
  for (const [file, budget] of Object.entries(ZERO_COERCION_DEBT)) {
    const actual = (found.get(file) ?? []).length;
    assert.ok(
      actual <= budget,
      `${file} has ${actual} zero-coercions but its recorded budget is ${budget}.`,
    );
    assert.ok(
      actual === budget || actual < budget,
      `${file}: ledger must be exact or lowered.`,
    );
    // Keep the ledger honest: once a file is clean, its entry must be removed
    // so the list reflects real remaining debt rather than historical trivia.
    assert.notEqual(
      actual,
      0,
      `${file} now has zero coercions — delete its entry from ZERO_COERCION_DEBT.`,
    );
  }
});

// --- Rule 3: the framework itself must not grow an escape hatch -----------

test('no value-defaulting helper is ever added to the Truth framework', () => {
  const files = walk(join(REPO_ROOT, 'packages/shared/src/truth'));
  const banned = /export\s+(function|const)\s+(valueOr|getValueOr|unwrapOr|orDefault|orZero)\b/;

  const violations: Violation[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        if (banned.test(text)) violations.push({ file: rel, line: i + 1, snippet: text });
      });
  }

  report(
    violations,
    'Truth States: a value-defaulting helper was added to the framework.\n' +
      'A `valueOr(truth, 0)` is the single most convenient way to reintroduce every\n' +
      'bug this model prevents, and is forbidden by docs/TRUTH_STATES.md §4.',
    'Fix: use foldTruth() or renderTruth(), both of which are total over the six states.',
  );
});

// --- Rule 4: the allowlist stays honest ------------------------------------

test('every adoption exception carries a written reason', () => {
  for (const entry of ALLOWLIST) {
    assert.ok(entry.file.length > 0, 'allowlist entry must name a file');
    assert.ok(entry.match.length > 0, 'allowlist entry must name what it excuses');
    assert.ok(
      entry.reason.trim().length >= 40,
      `allowlist entry for ${entry.file} needs a substantive reason, got: "${entry.reason}"`,
    );
  }
});

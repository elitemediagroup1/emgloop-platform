// PartialDataNotice — self-verification (pure render, deterministic).
//
// Follows the repo convention of a co-located verification harness (run via tsx):
//   npx tsx apps/web/src/app/app/_loop-os/panels.verification.tsx
//
// The bounded-read mitigation is only honest if this banner actually appears
// when a cap binds and actually disappears when it does not. Types cannot prove
// that; this renders every branch and asserts on the markup:
//   • complete coverage renders NOTHING (a healthy page is unchanged)
//   • null / undefined / all-complete arrays render nothing
//   • a capped coverage renders the banner, carrying its reason
//   • several coverages merge into ONE banner, deduping repeated reasons
//   • merged row counts are summed, not taken from the first entry

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// panels.tsx is compiled here with the classic JSX runtime, while Next builds it
// with the automatic one. Providing the global is a harness detail only — the
// component itself needs no React import in the app.
(globalThis as unknown as { React: typeof React }).React = React;

import { PartialDataNotice } from './panels';
import type { QueryCoverage } from '@emgloop/database';

const complete: QueryCoverage = { complete: true, capReached: false, reasons: [], rowsScanned: 42, durationMs: 3 };
const cappedCustomers: QueryCoverage = {
  complete: false,
  capReached: true,
  reasons: ['Customer scan capped at 2000; older customers by last-seen are excluded from these totals.'],
  rowsScanned: 2000,
  durationMs: 180,
};
const cappedCalls: QueryCoverage = {
  complete: false,
  capReached: true,
  reasons: [
    'Customer scan capped at 2000; older customers by last-seen are excluded from these totals.',
    'Call scan capped at 10000 for this window; older calls in the window are excluded from these totals.',
  ],
  rowsScanned: 10_000,
  durationMs: 240,
};

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`VERIFICATION FAILED: ${message}`);
}

function render(coverage: React.ComponentProps<typeof PartialDataNotice>['coverage']): string {
  return renderToStaticMarkup(React.createElement(PartialDataNotice, { coverage }));
}

export function verifyPartialDataNotice(): { passed: true; checks: string[] } {
  const checks: string[] = [];

  // --- 1. Silence when there is nothing to warn about ----------------------
  assert(render(complete) === '', 'complete coverage must render nothing');
  assert(render(null) === '', 'null coverage must render nothing');
  assert(render(undefined) === '', 'undefined coverage must render nothing');
  assert(render([complete, complete]) === '', 'an all-complete array must render nothing');
  assert(render([null, undefined]) === '', 'an array of nulls must render nothing');
  assert(render([]) === '', 'an empty array must render nothing');
  checks.push('complete / null / undefined / empty coverage renders nothing — healthy pages are unchanged');

  // --- 2. The banner appears when a cap binds ------------------------------
  const one = render(cappedCustomers);
  assert(one !== '', 'capped coverage must render a banner');
  assert(one.includes('loop-banner--warn'), 'the banner uses the warn tone');
  assert(one.includes('role="status"'), 'the banner is announced to assistive tech');
  assert(one.includes('these totals are incomplete'), 'the banner states the totals are incomplete');
  assert(one.includes('Customer scan capped at 2000'), 'the banner carries the reason the cap bound');
  assert(one.includes('lower bound'), 'the banner states the figures are a lower bound');
  checks.push('a bound cap renders one warn-toned banner carrying its reason and the lower-bound caveat');

  // --- 3. Mixed arrays still warn ------------------------------------------
  const mixed = render([complete, cappedCustomers]);
  assert(mixed !== '', 'one incomplete coverage among complete ones must still warn');
  assert(mixed.includes('2,000'), 'only the incomplete coverage contributes its row count');
  checks.push('a single incomplete coverage among complete ones still raises the banner');

  // --- 4. Several coverages merge into ONE banner --------------------------
  const merged = render([cappedCustomers, cappedCalls]);
  const bannerCount = merged.split('loop-banner ').length - 1;
  assert(bannerCount === 1, `several coverages merge into one banner (got ${bannerCount})`);
  const customerReasonCount = merged.split('Customer scan capped at 2000').length - 1;
  assert(customerReasonCount === 1, `a repeated reason appears once, not ${customerReasonCount} times`);
  assert(merged.includes('Call scan capped at 10000'), 'the distinct reason is still shown');
  assert(merged.includes('12,000'), 'merged row counts are summed (2,000 + 10,000), not taken from the first');
  checks.push('several coverages merge into one banner: reasons deduped, row counts summed');

  return { passed: true, checks };
}

if (process.argv[1] && process.argv[1].includes('panels.verification')) {
  try {
    const r = verifyPartialDataNotice();
    for (const c of r.checks) console.log(`  ✓ ${c}`);
    console.log(`\n${r.checks.length} checks passed.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

// Marketplace Coverage — self-verification (pure, deterministic).
//
// Co-located harness, run via tsx:
//   npx tsx packages/intelligence/src/coverage.verification.ts
//
// This surface exists to stop the platform overstating itself, so the harness
// is written adversarially: it tries to catch the coverage engine claiming
// knowledge it has not earned.
//
//   • zero calls → undetermined, NEVER unavailable (unknown is not zero)
//   • a structural gap stays unavailable no matter how many calls arrive
//   • partial coverage states the real ratio, never rounds it to available
//   • full coverage is only claimed when every examined call carries the field
//   • no status is ever authored — corrupting the counts changes the status
//   • unblocking work ranks by evidence tier, cheapest-controllable first

import {
  assessMarketplaceCoverage,
  rankUnblockingWork,
  MARKETPLACE_CAPABILITIES,
  type MarketplaceCoverageInput,
} from './coverage';

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`VERIFICATION FAILED: ${message}`);
}

const byId = (report: ReturnType<typeof assessMarketplaceCoverage>, id: string) => {
  const c = report.capabilities.find((x) => x.id === id);
  if (!c) throw new Error(`VERIFICATION FAILED: capability '${id}' missing from report`);
  return c;
};

export function verifyMarketplaceCoverage(): { passed: true; checks: string[] } {
  const checks: string[] = [];

  // --- 1. Nothing observed: undetermined, not unavailable -------------------
  const empty = assessMarketplaceCoverage({
    windowLabel: 'Last 7 days',
    callsIngested: 0,
    populated: {},
  });
  assert(byId(empty, 'revenue').status === 'undetermined', 'zero calls must leave revenue undetermined');
  assert(byId(empty, 'buyers').status === 'undetermined', 'zero calls must leave buyers undetermined');
  assert(
    byId(empty, 'buyers').ratio === null,
    'an undetermined capability must not report a ratio — 0/0 is not a measurement',
  );
  assert(
    !byId(empty, 'buyers').evidence.includes('0 of'),
    'an undetermined capability must not phrase itself as a zero count',
  );
  checks.push('zero calls ingested → undetermined, with no ratio and no zero-count phrasing');

  // --- 2. A structural gap is unavailable regardless of volume -------------
  for (const calls of [0, 1, 10_000]) {
    const r = assessMarketplaceCoverage({ windowLabel: 'Last 7 days', callsIngested: calls, populated: {} });
    assert(
      byId(r, 'auctions').status === 'unavailable',
      `auction data has no field in Loop — must stay unavailable at ${calls} calls`,
    );
    assert(byId(r, 'transcripts').status === 'unavailable', `transcripts must stay unavailable at ${calls} calls`);
  }
  checks.push('structural gaps (auctions, transcripts) stay unavailable at 0, 1 and 10,000 calls');

  // --- 3. A structural gap explains itself and cites its source ------------
  const auctions = byId(empty, 'auctions');
  assert(auctions.tier === 'not-specified', 'auction data is unconfirmed with the provider, not merely unmapped');
  assert(!!auctions.citation, 'a structural claim must carry the citation it was derived from');
  assert(!!auctions.unblockedBy, 'a blocked capability must state what would unblock it');
  assert(auctions.unlocks.length > 0, 'a blocked capability must state what it would unlock');
  const transcripts = byId(empty, 'transcripts');
  assert(
    transcripts.tier === 'not-ingested',
    'transcripts are documented but unmapped — a cheaper fix than an unconfirmed endpoint',
  );
  checks.push('blocked capabilities carry an evidence tier, a citation, an unblocker and what they unlock');

  // --- 4. Real ratios: partial is never rounded up -------------------------
  const partial = assessMarketplaceCoverage({
    windowLabel: 'Last 7 days',
    callsIngested: 100,
    populated: { calls: 100, revenue: 100, buyers: 3, sources: 99, vendors: 0 },
  });
  assert(byId(partial, 'revenue').status === 'available', '100/100 is available');
  assert(byId(partial, 'buyers').status === 'partial', '3/100 is partial, not available');
  assert(byId(partial, 'sources').status === 'partial', '99/100 is partial — one missing call still means partial');
  assert(byId(partial, 'vendors').status === 'unavailable', '0/100 is unavailable');
  assert(byId(partial, 'buyers').evidence.includes('3 of 100'), 'the real ratio is stated, not a rounded percentage');
  assert(
    byId(partial, 'sources').evidence.includes('99 of 100'),
    '99/100 must state its true ratio rather than presenting as complete',
  );
  checks.push('ratios are stated exactly: 100/100 available, 99/100 partial, 3/100 partial, 0/100 unavailable');

  // --- 5. Status is derived, not authored ----------------------------------
  // The same capability must change status purely because the counts changed.
  const seen: string[] = [];
  for (const observed of [0, 50, 100]) {
    const r = assessMarketplaceCoverage({
      windowLabel: 'Last 7 days',
      callsIngested: 100,
      populated: { buyers: observed },
    });
    seen.push(byId(r, 'buyers').status);
  }
  assert(
    seen.join(',') === 'unavailable,partial,available',
    `status must track the observations (got ${seen.join(',')})`,
  );
  checks.push('status is computed from counts alone — the same capability moves through all three postures');

  // --- 6. A count above the denominator cannot manufacture confidence ------
  const overflow = assessMarketplaceCoverage({
    windowLabel: 'Last 7 days',
    callsIngested: 10,
    populated: { buyers: 999 },
  });
  assert(byId(overflow, 'buyers').ratio!.observed === 10, 'observed is clamped to the number of calls examined');
  assert(
    byId(overflow, 'buyers').evidence.includes('All 10'),
    'a clamped count must read as all-of-10, never as 999',
  );
  checks.push('a corrupt over-count is clamped to the denominator rather than reported as-is');

  // --- 7. Totals reconcile ------------------------------------------------
  const sum = Object.values(partial.totals).reduce((a, b) => a + b, 0);
  assert(sum === MARKETPLACE_CAPABILITIES.length, 'every capability is counted exactly once in the totals');
  checks.push('status totals reconcile against the capability catalog');

  // --- 8. Unblocking work ranks by what Loop can actually control ----------
  const ranked = rankUnblockingWork(partial);
  const tiers = ranked.map((r) => r.tier);
  const firstSpecified = tiers.indexOf('not-specified');
  const lastIngested = tiers.lastIndexOf('not-ingested');
  assert(ranked.length > 0, 'a partially-covered marketplace has unblocking work to rank');
  assert(
    firstSpecified === -1 || lastIngested === -1 || lastIngested < firstSpecified,
    'adapter work Loop controls must rank above work blocked on provider confirmation',
  );
  assert(
    ranked.every((r) => r.unblockedBy !== null),
    'every ranked item states the action that would unblock it',
  );
  assert(
    !ranked.some((r) => /\d+\s*%/.test(r.unlocks.join(' '))),
    'unlocks must be countable statements, never a fabricated percentage improvement',
  );
  checks.push('unblocking work ranks cheapest-controllable first and never fabricates a percentage');

  // --- 9. Available capabilities stay silent -------------------------------
  const full = assessMarketplaceCoverage({
    windowLabel: 'Last 7 days',
    callsIngested: 5,
    populated: { calls: 5, revenue: 5 },
  });
  const rev = byId(full, 'revenue');
  assert(rev.reason === null && rev.unblockedBy === null && rev.tier === null, 'an available capability raises nothing');
  assert(!rankUnblockingWork(full).some((r) => r.id === 'revenue'), 'an available capability is not unblocking work');
  checks.push('an available capability carries no reason, no unblocker and no queue entry');

  return { passed: true, checks };
}

if (process.argv[1] && process.argv[1].includes('coverage.verification')) {
  try {
    const r = verifyMarketplaceCoverage();
    for (const c of r.checks) console.log(`  ✓ ${c}`);
    console.log(`\n${r.checks.length} checks passed.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

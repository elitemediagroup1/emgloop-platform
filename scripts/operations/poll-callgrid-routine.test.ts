// Tests for the scheduled routine CallGrid poll.
//
// WHAT THESE PROVE
//
// One sentence carries the weight: A RUN REPORTS SUCCESS ONLY IF COVERAGE WAS
// PROVEN. Not "the process did not throw", not "the workflow was green" — the
// poll outcome must be advancement-eligible AND the durable boundary must
// actually reach the interval's exclusive upper bound. Every other combination
// is asserted to be non-success and to exit non-zero.
//
// The second is that this runner cannot become a recovery. There is no since, no
// until and no date reachable from it — not by argument, not by workflow input,
// not by accident — and there are source-level assertions saying so, because
// "nobody would pass a historical range to the scheduler" is a memory rather
// than a property.
//
// WHAT THESE DELIBERATELY DO NOT PROVE
//
// Which interval to read is proved in packages/shared/test/poll-interval-planning.test.ts.
// Whether an outcome may advance coverage is proved in
// packages/database/test/callgrid-poll-checkpoint.test.ts, against the real
// checkpoint repository and its monotonic guard. What a poll does with an
// interval is proved in callgrid-poll-execution.test.ts. Restating any of them
// here against a stand-in would prove the stand-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CallGridPollExecution, RoutinePollResult } from '@emgloop/database';

import {
  ROUTINE_RESULTS,
  REFUSED_ORGANIZATION_STATUSES,
  parseArgs,
  parseOrganizations,
  readEnvironment,
  routineSucceeded,
  runRoutine,
  worstResult,
  type RoutineDeps,
  type RoutineResult,
} from './poll-callgrid-routine';

const HERE = dirname(fileURLToPath(import.meta.url));
const codeOf = (source: string): string =>
  source
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('#');
    })
    .join('\n');

const RUNNER_SOURCE = readFileSync(join(HERE, 'poll-callgrid-routine.ts'), 'utf8');
const RUNNER_CODE = codeOf(RUNNER_SOURCE);
const WORKFLOW_SOURCE = readFileSync(
  join(HERE, '..', '..', '.github', 'workflows', 'poll-callgrid-routine.yml'),
  'utf8',
);
const WORKFLOW_STEPS = codeOf(WORKFLOW_SOURCE);

/** Only the SHELL BODIES of `run: |` blocks, by indentation. */
const WORKFLOW_RUN_BODIES = (() => {
  const out: string[] = [];
  const lines = WORKFLOW_STEPS.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const opener = lines[i]?.match(/^(\s*)run: \|/);
    if (!opener) continue;
    const indent = (opener[1] ?? '').length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const body = lines[j] ?? '';
      if (body.trim() !== '' && body.search(/\S/) <= indent) break;
      out.push(body);
    }
  }
  return out.join('\n');
})();

const ORG = { id: 'org_1', slug: 'fixture-org', name: 'Fixture Org', status: 'ACTIVE' };
const KEY = 'cg_live_fixture';
const NOW = new Date('2026-08-21T12:00:00.000Z');
const SINCE = new Date('2026-08-19T06:00:00.000Z');
const UNTIL = new Date('2026-08-21T11:58:00.000Z');
const CALL_ID = 'cmsns65v8be2d07k368ox69s1';

function execution(over: Partial<CallGridPollExecution> = {}): CallGridPollExecution {
  return {
    outcome: 'APPLIED',
    since: SINCE.toISOString(),
    until: UNTIL.toISOString(),
    dryRun: false,
    reason: null,
    fetchOutcome: 'COMPLETE',
    providerRecordsFetched: 12,
    acceptedRecords: 12,
    refusedRecords: 0,
    refusals: [],
    newEvents: 4,
    duplicateObservations: 8,
    strengthenedCalls: 1,
    conflicts: 0,
    failedProcessing: 0,
    notAttempted: 0,
    pages: 1,
    pageCap: 500,
    rateLimitRetries: 0,
    providerTotal: null,
    failedAtIndex: null,
    failedIdentityDigest: null,
    ...over,
  };
}

function routine(over: Partial<RoutinePollResult> = {}): RoutinePollResult {
  return {
    checkpointBefore: new Date('2026-08-21T06:00:00.000Z'),
    checkpointAfter: UNTIL,
    plan: { plan: 'POLL', basis: 'CHECKPOINT', since: SINCE, until: UNTIL, cappedBySpan: false },
    execution: execution(),
    advancement: 'ADVANCED',
    reason: 'Coverage is proven through 2026-08-21T11:58:00.000Z.',
    ...over,
  };
}

interface Harness {
  deps: RoutineDeps;
  lines: string[];
  runs: Array<{ organizationId: string; apiKey: string; now: Date }>;
}

function harness(options: {
  result?: RoutinePollResult | ((slug: string) => RoutinePollResult);
  orgs?: Record<string, { id: string; slug: string; name: string; status: string }>;
} = {}): Harness {
  const lines: string[] = [];
  const runs: Array<{ organizationId: string; apiKey: string; now: Date }> = [];
  const table = options.orgs ?? { [ORG.slug]: ORG };
  let tick = 0;
  const deps: RoutineDeps = {
    poller: {
      async run(input) {
        runs.push(input);
        const slug = Object.values(table).find((o) => o.id === input.organizationId)?.slug ?? '';
        const r = options.result;
        return typeof r === 'function' ? r(slug) : (r ?? routine());
      },
    },
    organizations: {
      async findBySlug(slug: string) {
        return table[slug] ?? null;
      },
    },
    log: (l) => lines.push(l),
    now: () => new Date(NOW.getTime() + (tick += 1000)),
  };
  return { deps, lines, runs };
}

const run = (h: Harness, slugs: readonly string[] = [ORG.slug]) =>
  runRoutine({ organizationSlugs: slugs, apiKey: KEY }, h.deps);

const summary = (lines: string[]): string => lines.find((l) => l.startsWith('event=SUMMARY'))!;
const coverage = (lines: string[]): string => lines.find((l) => l.startsWith('event=COVERAGE'))!;

// --- 1/2/3/4. It coordinates, and coordinates nothing else -----------------------

test('1/2. the runner invokes the routine coordinator with a resolved organization and a clock', async () => {
  const h = harness();
  const out = await run(h);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0]!.organizationId, ORG.id, 'resolved from the slug, never supplied');
  assert.equal(h.runs[0]!.apiKey, KEY);
  assert.ok(h.runs[0]!.now instanceof Date, 'the clock is passed in, not taken inside');
  // An organization, a credential and a clock. No interval, in either direction.
  assert.deepEqual(Object.keys(h.runs[0]!).sort(), ['apiKey', 'now', 'organizationId']);
  assert.equal(out.overall, 'COVERAGE_ADVANCED');
});

test('2b. the runner reaches no planner, no checkpoint, no ingestion and no provider', () => {
  for (const symbol of [
    'planPollInterval',
    'ProviderPollCheckpointRepository',
    'providerPollCheckpoint',
    'completedThrough',
    'CallGridPollService',
    'IngestionService',
    '.ingest(',
    'readCallGridInterval',
    'nextCursor',
    'marketplaceCall',
    'MarketplaceCall',
    'convergeFact',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not reference ${symbol}`);
  }
  assert.ok(RUNNER_CODE.includes('deps.poller.run('), 'it delegates one call and reports');
  assert.equal(/prisma\.[a-z]/.test(RUNNER_CODE), false, 'no Prisma model delegate');
});

test('3. the runner computes no overlap, no bootstrap, no lag and no bound', () => {
  // It PRINTS the policy so a reader can see what is in force, and it derives
  // nothing from it. Any arithmetic on these would be a second copy of the rules.
  for (const expression of [
    'overlapMs -',
    '- CALLGRID_POLL_POLICY',
    'getTime() - CALLGRID_POLL_POLICY',
    'overlapMs)',
    'bootstrapLookbackMs -',
  ]) {
    assert.ok(!RUNNER_CODE.includes(expression), `the runner must not compute ${expression}`);
  }
  for (const symbol of ['sinceForRange', 'easternBusinessDayWindow', 'maxSpan', 'INTERVAL_MAX_SPAN']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not construct ${symbol}`);
  }
  // It PRINTS `since=` and `until=` — the planner's answer, reported. What it must
  // not do is SUPPLY them, and the only way to check that is to look at what
  // actually reaches the coordinator.
  assert.ok(
    !/poller\.run\(\{[^}]*\b(?:since|until)\b/s.test(RUNNER_CODE),
    'no interval is handed to the coordinator',
  );
  // Exactly one argumentless clock, and it is in main().
  assert.equal(RUNNER_CODE.split('new Date()').length - 1, 1);
});

test('4/15. the routine path is API_POLL and no recovery label is reachable', () => {
  assert.ok(!RUNNER_CODE.includes('API_RECOVERY'), 'the runner cannot label a row as a recovery');
  assert.ok(!WORKFLOW_STEPS.includes('API_RECOVERY'));
  assert.ok(!RUNNER_CODE.includes('observationSource'), 'provenance is not this layer\'s to choose');
  // The provenance constant itself lives with the poll primitive and is fixed
  // there; the routine coordinator passes no source at all.
  const routineService = codeOf(
    readFileSync(
      join(HERE, '..', '..', 'packages', 'database', 'src', 'services', 'callgrid-routine-poll.service.ts'),
      'utf8',
    ),
  );
  assert.ok(!routineService.includes('API_RECOVERY'));
});

// --- 5/6/7. What advances --------------------------------------------------------

test('5. an APPLIED pass whose checkpoint reached the boundary is the success case', async () => {
  const h = harness();
  const out = await run(h);
  assert.equal(out.overall, 'COVERAGE_ADVANCED');
  assert.equal(routineSucceeded(out.overall), true);
  assert.ok(summary(h.lines).includes('OVERALL_RESULT=COVERAGE_ADVANCED'));
});

test('6. a COMPLETE interval holding ZERO records still advances coverage', async () => {
  // The reason the checkpoint is an interval boundary rather than a max() over
  // observed occurrences. A quiet hour is covered.
  const h = harness({
    result: routine({
      execution: execution({ providerRecordsFetched: 0, acceptedRecords: 0, newEvents: 0, duplicateObservations: 0 }),
    }),
  });
  const out = await run(h);
  assert.equal(out.overall, 'COVERAGE_ADVANCED');
  assert.ok(h.lines.some((l) => l.includes('providerRecordsFetched=0')));
});

test('7. APPLIED_WITH_CONFLICTS advances, and the conflict count is surfaced', async () => {
  const h = harness({
    result: routine({ execution: execution({ outcome: 'APPLIED_WITH_CONFLICTS', conflicts: 3 }) }),
  });
  const out = await run(h);
  assert.equal(out.overall, 'COVERAGE_ADVANCED', 'the policy is PR #187\'s, unchanged');
  assert.ok(h.lines.some((l) => l.includes('conflicts=3')), 'and it is visible, not hidden');
});

test('13. ALREADY_AHEAD is a success and reports the real boundary', async () => {
  const ahead = new Date(UNTIL.getTime() + 60_000);
  const h = harness({
    result: routine({ advancement: 'ALREADY_AHEAD', checkpointAfter: ahead }),
  });
  const out = await run(h);
  assert.equal(out.overall, 'COVERAGE_ALREADY_PROVEN');
  assert.equal(routineSucceeded(out.overall), true);
  assert.ok(coverage(h.lines).includes(ahead.toISOString()), 'nothing regressed');
});

// --- 8/9/10/11/12/14. What does not ------------------------------------------------

test('8/9/10/11. no unproven poll outcome reports success', async () => {
  for (const outcome of [
    'FETCH_INCOMPLETE',
    'REFUSED',
    'PARTIALLY_APPLIED',
    'PROCESSING_FAILED',
    'DRY_RUN_READY',
  ] as const) {
    const h = harness({
      result: routine({
        execution: execution({ outcome }),
        advancement: 'NOT_PROVEN',
        checkpointAfter: new Date('2026-08-21T06:00:00.000Z'),
        reason: `The poll ended ${outcome}, which does not prove the interval was covered.`,
      }),
    });
    const out = await run(h);
    assert.equal(out.overall, 'COVERAGE_NOT_ADVANCED', `${outcome} must not succeed`);
    assert.equal(routineSucceeded(out.overall), false);
    assert.ok(h.lines.some((l) => l.includes(`pollOutcome=${outcome}`)), 'the outcome is named');
  }
});

test('10b. a PARTIALLY_APPLIED pass leaves the checkpoint where it was, for a safe rerun', async () => {
  const before = new Date('2026-08-21T06:00:00.000Z');
  const h = harness({
    result: routine({
      execution: execution({ outcome: 'PARTIALLY_APPLIED', newEvents: 40, failedProcessing: 1, notAttempted: 9 }),
      advancement: 'NOT_PROVEN',
      checkpointAfter: before,
    }),
  });
  const out = await run(h);
  assert.equal(out.overall, 'COVERAGE_NOT_ADVANCED');
  assert.ok(coverage(h.lines).includes(before.toISOString()), 'coverage did not move');
  // No compensating delete and no rewind: the 40 rows that landed stay, and the
  // next pass re-reads the same interval and converges on them.
  for (const symbol of ['delete', 'rewind', 'rollback', 'compensat']) {
    assert.ok(!RUNNER_CODE.toLowerCase().includes(symbol), `the runner must not ${symbol}`);
  }
});

test('12. a poll that proved the interval while the checkpoint stayed behind is NOT success', async () => {
  // "We asked it to move" and "it moved" are different facts. This should not
  // happen; if it does, the run must not be green.
  const h = harness({
    result: routine({ advancement: 'ADVANCED', checkpointAfter: new Date(UNTIL.getTime() - 1000) }),
  });
  const out = await run(h);
  assert.equal(out.overall, 'CHECKPOINT_BEHIND_POLL');
  assert.equal(routineSucceeded(out.overall), false);
});

test('12b. a proven poll with NO stored boundary at all is not success either', async () => {
  const h = harness({ result: routine({ checkpointAfter: null }) });
  assert.equal((await run(h)).overall, 'CHECKPOINT_BEHIND_POLL');
});

test('14. a planner that proposes nothing is surfaced, not quietly passed', async () => {
  const h = harness({
    result: routine({
      plan: { plan: 'NOTHING_DUE', basis: 'CHECKPOINT', reason: 'Coverage already reaches the safe boundary.' },
      execution: null,
      advancement: 'NOT_ATTEMPTED',
      reason: 'Coverage already reaches the safe boundary.',
    }),
  });
  const out = await run(h);
  // With a positive overlap this is unreachable in normal operation, so reaching
  // it means the stored boundary is ahead of the clock — clock skew, not quiet.
  assert.equal(out.overall, 'NOTHING_PLANNED');
  assert.equal(routineSucceeded(out.overall), false);
});

test('an unknown or suspended organization is a precondition failure, not a poll', async () => {
  const missing = harness({ orgs: {} });
  assert.equal((await run(missing)).overall, 'PRECONDITION_FAILED');
  assert.equal(missing.runs.length, 0, 'nothing was polled');

  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const h = harness({ orgs: { [ORG.slug]: { ...ORG, status } } });
    const out = await run(h);
    assert.equal(out.overall, 'PRECONDITION_FAILED');
    assert.equal(h.runs.length, 0);
  }
});

test('an empty organization list refuses rather than reporting a clean run', async () => {
  const h = harness();
  const out = await run(h, []);
  assert.equal(out.overall, 'PRECONDITION_FAILED');
  assert.equal(h.runs.length, 0);
});

// --- Multiple organizations ---------------------------------------------------------

test('one failing organization fails the whole run, and the healthy one still ran', async () => {
  const second = { id: 'org_2', slug: 'other-org', name: 'Other', status: 'ACTIVE' };
  const h = harness({
    orgs: { [ORG.slug]: ORG, [second.slug]: second },
    result: (slug) =>
      slug === second.slug
        ? routine({
            execution: execution({ outcome: 'FETCH_INCOMPLETE' }),
            advancement: 'NOT_PROVEN',
            checkpointAfter: new Date('2026-08-20T00:00:00.000Z'),
          })
        : routine(),
  });
  const out = await run(h, [ORG.slug, second.slug]);
  assert.equal(h.runs.length, 2, 'both were attempted');
  assert.equal(out.passes[0]!.result, 'COVERAGE_ADVANCED');
  assert.equal(out.passes[1]!.result, 'COVERAGE_NOT_ADVANCED');
  assert.equal(out.overall, 'COVERAGE_NOT_ADVANCED', 'the worst pass is the run');
  // The healthy tenant's lag must not hide the stalled one's.
  assert.ok(summary(h.lines).includes('MAX_COVERAGE_LAG_MS='));
  const maxLag = Number(summary(h.lines).match(/MAX_COVERAGE_LAG_MS=(\d+)/)![1]);
  assert.ok(maxLag > 24 * 60 * 60 * 1000, 'the stalled tenant sets the number');
});

test('worstResult orders the vocabulary from success to precondition failure', () => {
  assert.equal(worstResult(['COVERAGE_ADVANCED', 'COVERAGE_ALREADY_PROVEN']), 'COVERAGE_ALREADY_PROVEN');
  assert.equal(worstResult(['COVERAGE_ADVANCED', 'PRECONDITION_FAILED']), 'PRECONDITION_FAILED');
  assert.equal(worstResult([]), 'COVERAGE_ADVANCED');
  for (const result of ROUTINE_RESULTS) {
    assert.equal(
      routineSucceeded(result),
      result === 'COVERAGE_ADVANCED' || result === 'COVERAGE_ALREADY_PROVEN',
    );
  }
});

// --- 12/Observability -----------------------------------------------------------------

test('every pass answers the questions an operator asks, in one line', async () => {
  const h = harness();
  await run(h);
  const pass = h.lines.find((l) => l.startsWith('event=PASS_RESULT'))!;
  for (const field of [
    'organization=',
    'checkpointBefore=',
    'since=',
    'until=',
    'pollOutcome=',
    'providerRecordsFetched=',
    'newEvents=',
    'duplicateObservations=',
    'strengthenedCalls=',
    'conflicts=',
    'failedProcessing=',
    'advancement=',
    'checkpointAfter=',
  ]) {
    assert.ok(pass.includes(field), `the pass line must state ${field}`);
  }
  assert.ok(summary(h.lines).includes('ELAPSED_MS='));
});

test('every pass prints the coverage lag, because a red run is not an alert here', async () => {
  // drain-outbox.yml has failed on its last hundred scheduled runs and nobody
  // noticed. The exit code is necessary and not sufficient; this number comes
  // from a durable row and stays true when nobody is watching.
  const h = harness();
  await run(h);
  const line = coverage(h.lines);
  assert.ok(line.includes('COVERAGE_LAG_MS='));
  const lag = Number(line.match(/COVERAGE_LAG_MS=(\d+)/)![1]);
  assert.ok(lag > 0 && lag < 60 * 60 * 1000, 'a healthy pass reports a small lag');
});

test('a stalled checkpoint is visible in the lag even while the pass itself failed', async () => {
  const stale = new Date('2026-08-18T00:00:00.000Z');
  const h = harness({
    result: routine({
      execution: execution({ outcome: 'FETCH_INCOMPLETE' }),
      advancement: 'NOT_PROVEN',
      checkpointAfter: stale,
    }),
  });
  await run(h);
  const lag = Number(coverage(h.lines).match(/COVERAGE_LAG_MS=(\d+)/)![1]);
  assert.ok(lag > 3 * 24 * 60 * 60 * 1000, 'three days behind is three days behind');
});

test('19/20. no line carries a credential, an identity, a payload or a phone number', async () => {
  const h = harness({
    result: routine({
      execution: execution({ failedIdentityDigest: 'abc123abc123', failedAtIndex: 7 }),
    }),
  });
  await run(h);
  for (const l of h.lines) {
    assert.ok(!l.includes(KEY), 'a credential leaked');
    assert.ok(!l.includes(CALL_ID), 'a provider identity leaked');
    assert.ok(!l.includes('5125550000'), 'a caller number leaked');
  }
  // The runner never reaches for a payload or an identity in the first place.
  for (const symbol of ['payload', 'externalId', 'customerPhone', 'customerEmail', 'refusals']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not read ${symbol}`);
  }
});

// --- 16/21/22/23/24/25. Structural ------------------------------------------------------

test('16. no historical incident date appears anywhere in the scheduler', () => {
  for (const source of [RUNNER_SOURCE, WORKFLOW_SOURCE]) {
    for (const incident of ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']) {
      assert.ok(!source.includes(incident), `an incident date appears: ${incident}`);
    }
  }
});

test('25. no interval can be selected from outside — not by flag, not by input', () => {
  // The ONLY argument is a list of organization slugs.
  assert.deepEqual(parseArgs(['--organizations', 'a,b']), { organizations: 'a,b' });
  assert.deepEqual(parseArgs(['--since', '2026-08-10T00:00:00Z']), { organizations: '' });
  for (const symbol of ['--since', '--until', '--date', '--apply', 'parseInstant', 'dryRun']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not accept ${symbol}`);
  }
  // And the workflow offers no input at all.
  assert.ok(WORKFLOW_STEPS.includes('workflow_dispatch:'));
  assert.ok(!/workflow_dispatch:\s*\n\s*inputs:/.test(WORKFLOW_STEPS), 'manual retry takes no inputs');
});

test('21/22/23/24. no reconciliation, readiness, measurement, webhook or second engine', () => {
  for (const symbol of [
    'ProviderReconciliationService',
    'reconcileDay',
    'assessReconciliation',
    'ProviderObservationService',
    'certifyDay',
    'assessReadiness',
    'MeasurementSource',
    'MeasureSourceAuthority',
    'ObjectiveMeasureBinding',
    'HeadlineDetectionService',
    'MemberExpectation',
    'webhook',
    'WEBHOOK',
    'CALLGRID_WEBHOOK_SECRET',
    'LIVE_ORG_SLUG',
    'ensureLiveOrganization',
    'fetchCallGridCallsPage',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not reference ${symbol}`);
  }
  for (const verb of ['$executeRaw', '$queryRaw', '$transaction']) {
    assert.ok(!RUNNER_CODE.includes(verb), `the runner must not call ${verb}`);
  }
  assert.equal(
    /\.(?:create|update|upsert|delete|createMany|updateMany|deleteMany)\(\s*\{/.test(RUNNER_CODE),
    false,
    'no direct persistence call',
  );
});

test('18. credentials are read by name, and the two CallGrid secrets are not interchangeable', () => {
  const out = readEnvironment({ DATABASE_URL: '', CALLGRID_API_KEY: '' } as NodeJS.ProcessEnv);
  assert.equal(out.ok, false);
  assert.deepEqual(out.ok === false ? out.missing : [], ['DATABASE_URL', 'CALLGRID_API_KEY']);
  assert.equal(
    readEnvironment({ DATABASE_URL: 'postgres://x', CALLGRID_API_KEY: 'k' } as NodeJS.ProcessEnv).ok,
    true,
  );
  // A webhook secret must never stand in for an API key.
  assert.equal(
    readEnvironment({ DATABASE_URL: 'postgres://x', CALLGRID_WEBHOOK_SECRET: 'w' } as NodeJS.ProcessEnv).ok,
    false,
  );
  assert.ok(!RUNNER_CODE.includes('CALLGRID_WEBHOOK_SECRET'));
});

test('organization parsing is explicit, deduplicated and never inferred', () => {
  assert.deepEqual(parseOrganizations('a, b ,a'), ['a', 'b']);
  assert.deepEqual(parseOrganizations('  '), []);
  assert.deepEqual(parseOrganizations(''), []);
  // No default, no fallback slug baked into the runner.
  assert.ok(!RUNNER_CODE.includes('servicesinmycity'));
});

test('importing the module does not start a pass or set an exit code', () => {
  assert.notEqual(process.exitCode, 2, 'main() must not have run on import');
  assert.ok(!process.exitCode, 'importing the runner is inert');
});

// --- The workflow ------------------------------------------------------------------------

test('17. the workflow schedules hourly and serialises against itself', () => {
  assert.ok(WORKFLOW_STEPS.includes("- cron: '0 * * * *'"), 'hourly, on the hour');
  assert.equal((WORKFLOW_STEPS.match(/cron:/g) ?? []).length, 1, 'exactly one schedule');
  assert.ok(/concurrency:\s*\n\s*group: poll-callgrid-routine/.test(WORKFLOW_STEPS));
  assert.ok(WORKFLOW_STEPS.includes('cancel-in-progress: false'), 'a late run waits, it does not kill');
  // The timeout is under the cadence, so a hung pass cannot still be running when
  // the next one fires.
  const timeout = Number(WORKFLOW_STEPS.match(/timeout-minutes:\s*(\d+)/)![1]);
  assert.ok(timeout > 0 && timeout < 60, `timeout ${timeout} must be under the hourly cadence`);
});

test('the workflow is off until somebody switches it on', () => {
  // Merging must not start writing to production. The gate is a repository
  // variable, so enabling is one configuration action and no code change.
  assert.ok(WORKFLOW_STEPS.includes('vars.ROUTINE_POLL_ORGANIZATIONS'));
  assert.ok(WORKFLOW_STEPS.includes("steps.gate.outputs.enabled == 'true'"), 'every real step is gated');
  const gated = (WORKFLOW_STEPS.match(/steps\.gate\.outputs\.enabled == 'true'/g) ?? []).length;
  assert.ok(gated >= 6, `expected every working step to be gated, found ${gated}`);
});

test('the workflow declares no push or pull_request trigger and takes a read-only token', () => {
  for (const trigger of ['push:', 'pull_request:', 'workflow_call:']) {
    assert.ok(!WORKFLOW_STEPS.includes(trigger), `the workflow must not declare ${trigger}`);
  }
  assert.ok(/permissions:\s*\n\s*contents:\s*read/.test(WORKFLOW_STEPS), 'read-only token');
});

test('the safety suite runs BEFORE the production credential is used', () => {
  const safety = WORKFLOW_STEPS.indexOf('npm run test:operations');
  const poll = WORKFLOW_STEPS.indexOf('npm run poll:callgrid-routine');
  assert.ok(safety > 0, 'the safety suite runs');
  assert.ok(poll > safety, 'and it runs before the poll step');
});

test('19b. workflow values reach the shell through the environment, never by interpolation', () => {
  assert.ok(WORKFLOW_RUN_BODIES.length > 0, 'there are run bodies to inspect');
  assert.ok(!WORKFLOW_RUN_BODIES.includes('${{ vars.'), 'no variable is interpolated into a run body');
  assert.ok(!WORKFLOW_RUN_BODIES.includes('${{ secrets.'), 'no secret is interpolated into a run body');
  assert.ok(!WORKFLOW_RUN_BODIES.includes('${{ inputs.'));
  assert.ok(WORKFLOW_STEPS.includes('CALLGRID_API_KEY: ${{ secrets.CALLGRID_API_KEY }}'));
  assert.ok(!/echo[^\n]*CALLGRID_API_KEY[^\n]*\}/.test(WORKFLOW_STEPS), 'the key is never echoed');
  assert.ok(!/echo[^\n]*DATABASE_URL[^\n]*\}/.test(WORKFLOW_STEPS));
});

test('the workflow passes no interval and holds no recovery affordance', () => {
  const pollStep = WORKFLOW_STEPS.slice(WORKFLOW_STEPS.indexOf('npm run poll:callgrid-routine'));
  for (const flag of ['--since', '--until', '--apply', '--date']) {
    assert.ok(!pollStep.includes(flag), `the workflow must not pass ${flag}`);
  }
});

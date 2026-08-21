// Tests for the historical CallGrid recovery operation.
//
// WHAT THESE PROVE
//
// Recovery is the SAME operation as routine polling with a different label and a
// different way of choosing its interval. So the properties that matter are the
// ones that keep those two things from drifting apart or bleeding into each other:
//
//   1. it labels API_RECOVERY, and cannot label anything else;
//   2. it cannot reach a checkpoint, so routine coverage cannot move;
//   3. it selects nothing on its own — both bounds are typed every time;
//   4. it stops at the first chunk it cannot recover, and says where;
//   5. a stopped run can never report success.
//
// WHAT THESE DELIBERATELY DO NOT PROVE
//
// The completeness gate, the refusal policy and the apply loop are proved against
// the real service in packages/database/test/callgrid-poll-execution.test.ts,
// including through the recovery entry point. Chunk boundaries are proved in
// packages/shared/test/recovery-chunking.test.ts. Restating either here against a
// stand-in would prove the stand-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { easternBusinessDayWindow } from '@emgloop/shared';
import type { CallGridPollExecution, CallGridPollInput } from '@emgloop/database';

import {
  RECOVERY_RESULTS,
  REFUSED_ORGANIZATION_STATUSES,
  identityDigest,
  parseArgs,
  parseInstant,
  readEnvironment,
  runRecovery,
  type RecoveryDeps,
} from './recover-callgrid-interval';

const HERE = dirname(fileURLToPath(import.meta.url));
const codeOf = (source: string): string =>
  source
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('#');
    })
    .join('\n');

const RUNNER_SOURCE = readFileSync(join(HERE, 'recover-callgrid-interval.ts'), 'utf8');
const RUNNER_CODE = codeOf(RUNNER_SOURCE);
const WORKFLOW_SOURCE = readFileSync(
  join(HERE, '..', '..', '.github', 'workflows', 'recover-callgrid-interval.yml'),
  'utf8',
);
const WORKFLOW_STEPS = codeOf(WORKFLOW_SOURCE);

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
const CALL_ID = 'cmsns65v8be2d07k368ox69s1';

/** The incident window, used ONLY as a fixture. Nothing here recovers it. */
const SINCE = new Date('2026-08-10T22:06:14.000Z');
const UNTIL = new Date('2026-08-14T13:10:23.000Z');

function execution(over: Partial<CallGridPollExecution> = {}): CallGridPollExecution {
  return {
    outcome: 'APPLIED',
    since: '',
    until: '',
    dryRun: false,
    reason: null,
    fetchOutcome: 'COMPLETE',
    providerRecordsFetched: 100,
    acceptedRecords: 100,
    refusedRecords: 0,
    refusals: [],
    newEvents: 90,
    duplicateObservations: 10,
    strengthenedCalls: 2,
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

interface Harness {
  deps: RecoveryDeps;
  lines: string[];
  calls: CallGridPollInput[];
}

function harness(options: {
  /** Keyed by the 1-based chunk index. Anything absent applies cleanly. */
  results?: Record<number, Partial<CallGridPollExecution>>;
  org?: { id: string; slug: string; name: string; status: string } | null;
  emit?: (observer: NonNullable<Parameters<RecoveryDeps['executor']['executeRecovery']>[1]>) => void;
} = {}): Harness {
  const lines: string[] = [];
  const calls: CallGridPollInput[] = [];
  let tick = 0;
  const deps: RecoveryDeps = {
    executor: {
      async executeRecovery(input, observer) {
        calls.push(input);
        if (observer && options.emit) options.emit(observer);
        const over = options.results?.[calls.length] ?? {};
        return {
          ...execution(over),
          since: input.since.toISOString(),
          until: input.until.toISOString(),
          dryRun: input.dryRun === true,
        };
      },
    },
    organizations: {
      async findBySlug(slug: string) {
        if (options.org === null) return null;
        const org = options.org ?? ORG;
        return org.slug === slug ? org : null;
      },
    },
    log: (l) => lines.push(l),
    now: () => new Date(1_700_000_000_000 + (tick += 1000)),
  };
  return { deps, lines, calls };
}

const request = (over: Partial<Parameters<typeof runRecovery>[0]> = {}) => ({
  organizationSlug: ORG.slug,
  since: SINCE,
  until: UNTIL,
  apiKey: KEY,
  dryRun: false,
  ...over,
});

const summary = (lines: string[]): string => lines.find((l) => l.startsWith('event=SUMMARY'))!;

// --- 1. The interval is chunked by business day, and tiles ------------------------

test('1. the interval is split into Eastern business-day chunks that tile it exactly', async () => {
  const h = harness();
  const out = await runRecovery(request(), h.deps);
  assert.equal(out.overall, 'RECOVERED');
  assert.deepEqual(
    out.chunks.map((c) => c.businessDate),
    ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'],
  );
  // No gap, no overlap, and the ends are exactly what was asked for.
  assert.equal(h.calls[0]!.since.getTime(), SINCE.getTime());
  assert.equal(h.calls[h.calls.length - 1]!.until.getTime(), UNTIL.getTime());
  for (let i = 1; i < h.calls.length; i += 1) {
    assert.equal(h.calls[i]!.since.getTime(), h.calls[i - 1]!.until.getTime(), `gap before chunk ${i}`);
  }
  assert.equal(out.chunks[0]!.partialDay, true, 'the first day starts part-way through');
  assert.equal(out.chunks[2]!.partialDay, false, 'the middle days are whole');
});

test('1b. a whole business day is passed to the executor as that day, exactly', async () => {
  const h = harness();
  await runRecovery(request(), h.deps);
  const day = easternBusinessDayWindow('2026-08-12');
  const middle = h.calls.find((c) => c.since.getTime() === day.start.getTime());
  assert.ok(middle, 'the whole day was asked for by its own boundary');
  assert.equal(middle!.until.getTime(), day.end.getTime());
});

// --- 2. Provenance ------------------------------------------------------------------

test('2. every chunk goes through the RECOVERY entry point, never the poll one', async () => {
  const h = harness();
  await runRecovery(request(), h.deps);
  assert.equal(h.calls.length, 5);
  // The seam exposes exactly one method, and it is the recovery one. The runner
  // cannot label a row API_POLL because it cannot reach the entry point that does.
  assert.ok(RUNNER_CODE.includes('executeRecovery('), 'the recovery entry point is used');
  assert.ok(!RUNNER_CODE.includes('.execute('), 'the routine entry point is not reachable');
  assert.ok(!RUNNER_CODE.includes('POLL_OBSERVATION_SOURCE'));
  assert.ok(!RUNNER_CODE.includes("'API_POLL'"));
  assert.ok(RUNNER_CODE.includes('RECOVERY_OBSERVATION_SOURCE'), 'and the label is reported');
  // Provenance is not an argument in either direction. The runner PRINTS the
  // label — a run should say on the record what it wrote — and it never passes
  // one, because the entry point it calls owns it.
  assert.ok(
    !/executeRecovery\(\s*\{[^}]*observationSource/s.test(RUNNER_CODE),
    'the runner cannot choose a label',
  );
  assert.ok(!RUNNER_CODE.includes('ObservationSource>'), 'and takes none from its caller');
});

test('2b. the recovery label is stated in the run summary, so it is on the record', async () => {
  const h = harness();
  await runRecovery(request(), h.deps);
  assert.ok(summary(h.lines).includes('OBSERVATION_SOURCE=API_RECOVERY'));
});

// --- 3. It cannot move routine coverage ----------------------------------------------

test('3. the runner cannot reach a checkpoint, a planner or the routine service', () => {
  for (const symbol of [
    'ProviderPollCheckpointRepository',
    'providerPollCheckpoint',
    'completedThrough',
    'lastIntervalSince',
    'planPollInterval',
    'CallGridRoutinePollService',
    'CALLGRID_POLL_POLICY',
    'checkpointMayAdvance',
    'pollCheckpoints',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not reference ${symbol}`);
  }
  assert.ok(!WORKFLOW_STEPS.includes('poll:callgrid-routine'), 'and the workflow runs no routine pass');
});

// --- 4. Bounds are typed, never chosen -------------------------------------------------

test('4. no interval is selectable from inside the operation', () => {
  // No default window, no remembered interval, no date at all.
  // No default window, no remembered interval, and no August date at all — not
  // even as the placeholder in an error message, where it would read as the
  // interval to paste.
  for (const symbol of ['2026-08', 'INCIDENT', 'lastRecovery', 'defaultSince', 'new Date(2']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not contain ${symbol}`);
  }
  for (const source of [RUNNER_SOURCE, WORKFLOW_SOURCE]) {
    for (const incident of ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']) {
      assert.ok(!source.includes(incident), `an incident date is baked in: ${incident}`);
    }
  }
  // Exactly one argumentless clock, in main(), for elapsed time.
  assert.equal(RUNNER_CODE.split('new Date()').length - 1, 1);
  for (const symbol of ['Date.now(', 'sinceForRange', 'easternTodayWindow']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not derive a bound from ${symbol}`);
  }
});

test('4b. an instant must carry an explicit offset', () => {
  assert.ok(parseInstant('2026-08-10T22:06:14Z'));
  assert.ok(parseInstant('2026-08-10T18:06:14-04:00'));
  for (const bad of ['2026-08-10', '2026-08-10T18:06', 'yesterday', '']) {
    assert.equal(parseInstant(bad), null, `${bad} must be refused`);
  }
});

test('4c. writing requires --apply; omitting it is a dry run', () => {
  assert.equal(parseArgs(['--organization', 'x']).dryRun, true);
  assert.equal(parseArgs(['--organization', 'x', '--apply']).dryRun, false);
  assert.equal(parseArgs(['--apply', '--dry-run']).contradiction, true);
});

// --- 5. Stopping ------------------------------------------------------------------------

test('5. the run stops at the first chunk it cannot recover, and names it', async () => {
  const h = harness({ results: { 3: { outcome: 'FETCH_INCOMPLETE', newEvents: 0, notAttempted: 400 } } });
  const out = await runRecovery(request(), h.deps);
  assert.equal(out.overall, 'PARTIALLY_RECOVERED');
  assert.equal(h.calls.length, 3, 'chunks 4 and 5 were never attempted');
  assert.equal(out.chunksNotAttempted, 2);
  assert.equal(out.chunks.length, 3);
  assert.equal(out.chunks[2]!.recovered, false);
  const stopped = h.lines.find((l) => l.startsWith('event=RECOVERY_STOPPED'))!;
  assert.ok(stopped.includes('businessDate=2026-08-12'));
  assert.ok(stopped.includes('chunksNotAttempted=2'));
});

test('5b. a failure on the FIRST chunk is NOT_RECOVERED, with nothing live', async () => {
  const h = harness({ results: { 1: { outcome: 'REFUSED', newEvents: 0 } } });
  const out = await runRecovery(request(), h.deps);
  assert.equal(out.overall, 'NOT_RECOVERED');
  assert.equal(h.calls.length, 1);
  assert.equal(out.chunksNotAttempted, 4);
});

test('5c. no stopped run can report a success outcome', async () => {
  for (const outcome of ['FETCH_INCOMPLETE', 'REFUSED', 'PARTIALLY_APPLIED', 'PROCESSING_FAILED'] as const) {
    const h = harness({ results: { 2: { outcome } } });
    const out = await runRecovery(request(), h.deps);
    assert.ok(
      out.overall === 'PARTIALLY_RECOVERED' || out.overall === 'NOT_RECOVERED',
      `${outcome} produced ${out.overall}`,
    );
    assert.ok(!['RECOVERED', 'RECOVERED_WITH_CONFLICTS', 'DRY_RUN_READY'].includes(out.overall));
  }
});

test('5d. a refused record inside a chunk is named, not folded into a count', async () => {
  const h = harness({
    results: {
      2: {
        outcome: 'REFUSED',
        refusedRecords: 1,
        refusals: [{ page: 3, reason: 'no usable identity field', kind: 'no-identity' }],
      },
    },
  });
  await runRecovery(request(), h.deps);
  const refused = h.lines.find((l) => l.startsWith('event=RECORD_REFUSED'))!;
  assert.ok(refused.includes('page=3'));
  assert.ok(refused.includes('kind=no-identity'));
  assert.ok(refused.includes('businessDate=2026-08-11'));
});

// --- Dry run and conflicts ----------------------------------------------------------------

test('a dry run reaches every chunk, writes nothing, and says so', async () => {
  const h = harness({ results: Object.fromEntries([1, 2, 3, 4, 5].map((i) => [i, { outcome: 'DRY_RUN_READY' as const }])) });
  const out = await runRecovery(request({ dryRun: true }), h.deps);
  assert.equal(out.overall, 'DRY_RUN_READY');
  assert.equal(h.calls.length, 5, 'the whole interval was planned and read');
  for (const call of h.calls) assert.equal(call.dryRun, true);
  assert.match(String(out.reason), /--apply/);
});

test('a conflict does not stop the run and is reported separately from success', async () => {
  const h = harness({ results: { 2: { outcome: 'APPLIED_WITH_CONFLICTS', conflicts: 4 } } });
  const out = await runRecovery(request(), h.deps);
  assert.equal(out.overall, 'RECOVERED_WITH_CONFLICTS');
  assert.equal(h.calls.length, 5, 'the run continued past the conflict');
  assert.ok(summary(h.lines).includes('CONFLICTS=4'));
  assert.match(String(out.reason), /disagreed/);
});

test('the observer streams per-chunk detail without leaking an identity', async () => {
  const h = harness({
    emit: (observer) => {
      observer.onConflict?.({ index: 2, identityDigest: identityDigest(CALL_ID), facts: ['revenue'] });
      observer.onProgress?.({ done: 250, of: 900, created: 200, reObserved: 50 });
    },
  });
  await runRecovery(request(), h.deps);
  assert.ok(h.lines.some((l) => l.startsWith('event=FACT_CONFLICT') && l.includes('businessDate=')));
  assert.ok(h.lines.some((l) => l.startsWith('event=PROGRESS') && l.includes('done=250')));
  for (const l of h.lines) {
    assert.ok(!l.includes(CALL_ID), 'a provider identity leaked');
    assert.ok(!l.includes(KEY), 'a credential leaked');
  }
});

// --- Preconditions -------------------------------------------------------------------------

test('bad bounds, an unknown organization and a missing credential all refuse before reading', async () => {
  for (const over of [
    { since: UNTIL, until: SINCE },
    { since: SINCE, until: SINCE },
    { apiKey: '' },
    { organizationSlug: '' },
  ]) {
    const h = harness();
    const out = await runRecovery(request(over), h.deps);
    assert.equal(out.overall, 'REFUSED');
    assert.equal(h.calls.length, 0, 'nothing was read');
  }

  const missing = harness({ org: null });
  assert.equal((await runRecovery(request(), missing.deps)).overall, 'REFUSED');
  assert.equal(missing.calls.length, 0);

  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const h = harness({ org: { ...ORG, status } });
    assert.equal((await runRecovery(request(), h.deps)).overall, 'REFUSED');
    assert.equal(h.calls.length, 0);
  }
});

test('an interval wide enough to be a backfill is refused, not worked through', async () => {
  const h = harness();
  const out = await runRecovery(
    request({ since: new Date('2026-01-01T05:00:00.000Z'), until: new Date('2026-06-01T04:00:00.000Z') }),
    h.deps,
  );
  assert.equal(out.overall, 'REFUSED');
  assert.equal(h.calls.length, 0);
  assert.match(String(out.reason), /backfill/);
});

test('missing credentials are reported by NAME and never by value', () => {
  const out = readEnvironment({ DATABASE_URL: '', CALLGRID_API_KEY: '' } as NodeJS.ProcessEnv);
  assert.equal(out.ok, false);
  assert.deepEqual(out.ok === false ? out.missing : [], ['DATABASE_URL', 'CALLGRID_API_KEY']);
  assert.ok(!RUNNER_CODE.includes('CALLGRID_WEBHOOK_SECRET'));
});

// --- Structural ------------------------------------------------------------------------------

test('the runner writes no row of its own and implements no engine', () => {
  assert.equal(/prisma\.[a-z]/.test(RUNNER_CODE), false, 'no Prisma model delegate');
  assert.equal(
    /\.(?:create|update|upsert|delete|createMany|updateMany|deleteMany)\(\s*\{/.test(RUNNER_CODE),
    false,
    'no direct persistence call',
  );
  for (const symbol of [
    'IngestionService',
    '.ingest(',
    'readCallGridInterval',
    'fetchCallGridCallsPage',
    'nextCursor',
    'marketplaceCall',
    'convergeFact',
    'resolveCallGridIdentity',
    'ProviderReconciliationService',
    'assessReadiness',
    'MeasurementSource',
    'HeadlineDetectionService',
    'LIVE_ORG_SLUG',
    '$executeRaw',
    '$queryRaw',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not reference ${symbol}`);
  }
  assert.ok(RUNNER_CODE.includes('deps.executor.executeRecovery('), 'the primitive is invoked');
});

test('the outcome vocabulary is closed', () => {
  assert.deepEqual([...RECOVERY_RESULTS].sort(), [
    'DRY_RUN_READY',
    'NOT_RECOVERED',
    'PARTIALLY_RECOVERED',
    'RECOVERED',
    'RECOVERED_WITH_CONFLICTS',
    'REFUSED',
  ]);
});

test('importing the module does not start a recovery', () => {
  assert.notEqual(process.exitCode, 2);
  assert.ok(!process.exitCode);
});

// --- The workflow ------------------------------------------------------------------------------

test('the workflow is manual only and can never be scheduled', () => {
  assert.ok(WORKFLOW_STEPS.includes('workflow_dispatch:'));
  for (const trigger of ['schedule:', 'cron:', 'push:', 'pull_request:', 'workflow_call:']) {
    assert.ok(!WORKFLOW_STEPS.includes(trigger), `the workflow must not declare ${trigger}`);
  }
  assert.ok(/permissions:\s*\n\s*contents:\s*read/.test(WORKFLOW_STEPS));
  assert.ok(/concurrency:\s*\n\s*group: recover-callgrid-interval/.test(WORKFLOW_STEPS));
});

test('the workflow dry-runs by default and takes both bounds explicitly', () => {
  assert.ok(/dry_run:[\s\S]*default:\s*true/.test(WORKFLOW_STEPS));
  for (const input of ['organization_slug:', 'since:', 'until:']) {
    assert.ok(WORKFLOW_STEPS.includes(input), `the workflow must take ${input}`);
  }
});

test('the safety suite runs BEFORE the production credential is used', () => {
  const safety = WORKFLOW_STEPS.indexOf('npm run test:operations');
  const apply = WORKFLOW_STEPS.indexOf('npm run recover:callgrid');
  assert.ok(safety > 0 && apply > safety);
});

test('workflow inputs reach the shell through the environment, never by interpolation', () => {
  assert.ok(WORKFLOW_RUN_BODIES.length > 0);
  assert.ok(!WORKFLOW_RUN_BODIES.includes('${{ inputs.'));
  assert.ok(!WORKFLOW_RUN_BODIES.includes('${{ secrets.'));
  assert.ok(WORKFLOW_STEPS.includes('CALLGRID_API_KEY: ${{ secrets.CALLGRID_API_KEY }}'));
  assert.ok(!/echo[^\n]*CALLGRID_API_KEY[^\n]*\}/.test(WORKFLOW_STEPS));
});

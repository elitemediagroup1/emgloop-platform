// Tests for the manual bounded CallGrid poll runner.
//
// WHAT THESE PROVE, AFTER PR 9
//
// This runner is a command-line front end and these tests hold it to that. It
// parses, resolves a slug, invokes ONE primitive, and prints. The properties that
// matter — an incomplete read writes nothing, a refused record aborts the
// interval, a partial apply can never report success — moved into
// `CallGridPollService` when the admin sync route was migrated onto it, and they
// are proved there, once, in packages/database/test/callgrid-poll-execution.test.ts.
// Asserting them again here against a stand-in executor would prove the stand-in
// and would quietly permit a runner that judged completeness for itself.
//
// So what is proved here is the boundary: that the runner refuses before invoking,
// that it invokes with exactly what it was given, that it reports what it was
// told without softening it, and that it can reach nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { identityDigest, type CallGridPollExecution, type CallGridPollInput } from '@emgloop/database';

import {
  POLL_RESULTS,
  REFUSED_ORGANIZATION_STATUSES,
  parseArgs,
  parseInstant,
  readEnvironment,
  runPoll,
  type PollDeps,
  type PollResult,
} from './poll-callgrid-interval';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_SOURCE = readFileSync(join(HERE, 'poll-callgrid-interval.ts'), 'utf8');
const WORKFLOW_SOURCE = readFileSync(
  join(HERE, '..', '..', '.github', 'workflows', 'poll-callgrid-interval.yml'),
  'utf8',
);

// Prose removed — line comments AND block-comment bodies. The "must not name"
// checks are about CODE: a header sentence saying this runner holds no checkpoint
// must not read as the code holding one.
const codeOf = (source: string): string =>
  source
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const RUNNER_CODE = codeOf(RUNNER_SOURCE);

/** The workflow with its `#` prose removed, for the same reason. */
const WORKFLOW_STEPS = WORKFLOW_SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n');

/**
 * Only the SHELL BODIES of `run: |` blocks, by indentation.
 *
 * Splitting the file on `run: |` and keeping the tail was the first version, and
 * it swept up every later step's `env:` block — which is exactly where an input
 * is SUPPOSED to appear. A run body is the indented region under the key.
 */
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
const SINCE = new Date('2026-08-19T04:00:00.000Z');
const UNTIL = new Date('2026-08-20T04:00:00.000Z');
const CALL_ID = 'cmsns65v8be2d07k368ox69s1';

function execution(over: Partial<CallGridPollExecution> = {}): CallGridPollExecution {
  return {
    outcome: 'APPLIED',
    since: SINCE.toISOString(),
    until: UNTIL.toISOString(),
    dryRun: false,
    reason: null,
    fetchOutcome: 'COMPLETE',
    providerRecordsFetched: 2,
    acceptedRecords: 2,
    refusedRecords: 0,
    refusals: [],
    newEvents: 2,
    duplicateObservations: 0,
    strengthenedCalls: 0,
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
  deps: PollDeps;
  lines: string[];
  calls: CallGridPollInput[];
}

function harness(options: {
  result?: CallGridPollExecution;
  org?: { id: string; slug: string; name: string; status: string } | null;
  /** Fired inside execute, so observer-driven lines can be asserted. */
  emit?: (observer: NonNullable<Parameters<PollDeps['executor']['execute']>[1]>) => void;
} = {}): Harness {
  const lines: string[] = [];
  const calls: CallGridPollInput[] = [];
  let tick = 0;
  const deps: PollDeps = {
    executor: {
      async execute(input, observer) {
        calls.push(input);
        if (observer && options.emit) options.emit(observer);
        return options.result ?? execution();
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

const request = (over: Partial<Parameters<typeof runPoll>[0]> = {}) => ({
  organizationSlug: ORG.slug,
  since: SINCE,
  until: UNTIL,
  apiKey: KEY,
  dryRun: false,
  ...over,
});

const summary = (lines: string[]): string => lines.find((l) => l.startsWith('event=SUMMARY'))!;

// --- 22. One primitive, invoked with exactly what it was given -------------------

test('22. the runner delegates to the poll primitive with the resolved organization and both bounds', async () => {
  const h = harness();
  const out = await runPoll(request(), h.deps);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], {
    organizationId: ORG.id,
    apiKey: KEY,
    since: SINCE,
    until: UNTIL,
    dryRun: false,
  });
  assert.equal(out.outcome, 'APPLIED');
  assert.equal(out.organizationSlug, ORG.slug);
  assert.ok(out.elapsedMs >= 0);
});

test('22b. the runner and the admin sync route construct the SAME service', () => {
  assert.ok(RUNNER_CODE.includes('new CallGridPollService(prisma)'), 'the runner constructs it');
  // Comment-stripped, for the same reason RUNNER_CODE is: the route's header
  // explains at length what it no longer reaches, and a sentence saying so must
  // not read as the code doing it.
  const routeSource = codeOf(
    readFileSync(
      join(HERE, '..', '..', 'apps', 'web', 'src', 'app', 'api', 'integrations', 'callgrid', 'sync', 'route.ts'),
      'utf8',
    ),
  );
  assert.ok(routeSource.includes('new CallGridPollService(prisma)'), 'and so does the route');
  // Neither may hold its own read, gate or apply loop.
  for (const symbol of ['readCallGridInterval', 'intervalWasComplete', 'IngestionService']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not reach ${symbol} itself`);
    assert.ok(!routeSource.includes(symbol), `the route must not reach ${symbol} itself`);
  }
  // And neither may shell out to the other.
  assert.ok(!routeSource.includes('poll:callgrid'), 'the route does not invoke a CLI');
  assert.ok(!routeSource.includes('child_process'));
});

test('20/8. the admin route resolves its convenience range BEFORE the primitive, and cannot recover', () => {
  const routeSource = codeOf(
    readFileSync(
      join(HERE, '..', '..', 'apps', 'web', 'src', 'app', 'api', 'integrations', 'callgrid', 'sync', 'route.ts'),
      'utf8',
    ),
  );
  // `today` / `24h` / `7d` still exist for the person looking at the button, and
  // they become two instants at this edge. The primitive is handed since/until.
  assert.ok(routeSource.includes('sinceForRange(range, now)'), 'the preset resolves here');
  assert.ok(/since:\s*window\.since/.test(routeSource), 'and an explicit bound goes in');
  assert.ok(/until:\s*window\.until/.test(routeSource));
  // Provenance is not the caller's to choose, and this route is not a recovery.
  assert.ok(!routeSource.includes('observationSource'), 'the route cannot label its own rows');
  assert.ok(!routeSource.includes('API_RECOVERY'));
  for (const incident of ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']) {
    assert.ok(!routeSource.includes(incident), 'no incident-specific date is baked in');
  }
  // Success is the vocabulary's judgement, not a list of names retyped in a route.
  assert.ok(routeSource.includes('pollSucceeded(result.outcome)'));
  assert.ok(!/ok:\s*!result\.truncated/.test(routeSource), 'the old truncation contract is gone');
});

test('22c. the outcome vocabulary is the primitive\'s, not a copy', () => {
  assert.deepEqual([...POLL_RESULTS].sort(), [
    'APPLIED',
    'APPLIED_WITH_CONFLICTS',
    'DRY_RUN_READY',
    'FETCH_INCOMPLETE',
    'PARTIALLY_APPLIED',
    'PROCESSING_FAILED',
    'REFUSED',
  ]);
  assert.ok(RUNNER_CODE.includes('POLL_RESULTS = CALLGRID_POLL_OUTCOMES'), 're-exported, not restated');
});

// --- Refusals happen before the primitive is invoked at all ----------------------

test('reversed, equal and over-wide bounds are refused without invoking the primitive', async () => {
  for (const [since, until] of [
    [UNTIL, SINCE],
    [SINCE, SINCE],
    [SINCE, new Date(SINCE.getTime() + 60 * 24 * 3600_000)],
  ] as const) {
    const h = harness();
    const out = await runPoll(request({ since, until }), h.deps);
    assert.equal(out.outcome, 'REFUSED');
    assert.equal(h.calls.length, 0, 'nothing was invoked');
  }
});

test('an unknown or suspended organization refuses without invoking the primitive', async () => {
  const missing = harness({ org: null });
  assert.equal((await runPoll(request(), missing.deps)).outcome, 'REFUSED');
  assert.equal(missing.calls.length, 0);

  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const h = harness({ org: { ...ORG, status } });
    const out = await runPoll(request(), h.deps);
    assert.equal(out.outcome, 'REFUSED');
    assert.equal(h.calls.length, 0);
  }
});

test('a missing slug or credential refuses without invoking the primitive', async () => {
  for (const over of [{ organizationSlug: '' }, { apiKey: '' }]) {
    const h = harness();
    const out = await runPoll(request(over), h.deps);
    assert.equal(out.outcome, 'REFUSED');
    assert.equal(h.calls.length, 0);
  }
});

// --- Reporting: what the primitive said is what gets printed ---------------------

test('an incomplete fetch is reported as such, and never softened', async () => {
  const h = harness({
    result: execution({
      outcome: 'FETCH_INCOMPLETE',
      fetchOutcome: 'TRUNCATED',
      reason: 'the page budget ran out',
      newEvents: 0,
      acceptedRecords: 3,
      notAttempted: 3,
    }),
  });
  const out = await runPoll(request(), h.deps);
  assert.equal(out.outcome, 'FETCH_INCOMPLETE');
  assert.ok(h.lines.some((l) => l.startsWith('event=FETCH_RESULT') && l.includes('complete=NO')));
  assert.ok(h.lines.some((l) => l.startsWith('event=WRITES_SKIPPED') && l.includes('notAttempted=3')));
  assert.ok(summary(h.lines).includes('OVERALL_RESULT=FETCH_INCOMPLETE'));
  assert.ok(h.lines.some((l) => l.includes('the page budget ran out')));
});

test('every refused record is named, so it cannot vanish into a count', async () => {
  const h = harness({
    result: execution({
      outcome: 'REFUSED',
      reason: '1 provider record(s) could not be mapped',
      refusedRecords: 1,
      refusals: [{ page: 4, reason: 'no usable identity field', kind: 'no-identity' }],
      newEvents: 0,
      notAttempted: 2,
    }),
  });
  await runPoll(request(), h.deps);
  const refused = h.lines.filter((l) => l.startsWith('event=RECORD_REFUSED'));
  assert.equal(refused.length, 1);
  assert.ok(refused[0]!.includes('page=4'));
  assert.ok(refused[0]!.includes('kind=no-identity'));
  assert.ok(h.lines.some((l) => l.startsWith('event=WRITES_SKIPPED') && l.includes('refused records')));
});

test('a partial apply reports where it stopped and is never a success line', async () => {
  const h = harness({
    result: execution({
      outcome: 'PARTIALLY_APPLIED',
      newEvents: 1,
      failedProcessing: 1,
      failedAtIndex: 1,
      failedIdentityDigest: identityDigest(CALL_ID),
      notAttempted: 1,
      reason: 'database is unreachable',
    }),
  });
  const out = await runPoll(request(), h.deps);
  const s = summary(h.lines);
  assert.ok(s.includes('OVERALL_RESULT=PARTIALLY_APPLIED'));
  assert.ok(s.includes('FAILED_AT_INDEX=1'));
  assert.ok(s.includes(`FAILED_IDENTITY=${identityDigest(CALL_ID)}`));
  assert.equal(out.failedIdentityDigest, identityDigest(CALL_ID));
});

test('a conflict outcome is reported as a conflict, not flattened into APPLIED', async () => {
  const h = harness({
    result: execution({
      outcome: 'APPLIED_WITH_CONFLICTS',
      conflicts: 2,
      strengthenedCalls: 1,
      duplicateObservations: 2,
      reason: '2 provider fact(s) disagreed',
    }),
  });
  const out = await runPoll(request(), h.deps);
  assert.equal(out.outcome, 'APPLIED_WITH_CONFLICTS');
  assert.ok(summary(h.lines).includes('CONFLICTS=2'));
  assert.ok(h.lines.some((l) => l.startsWith('event=RUN_NOTE') && l.includes('disagreed')));
});

test('the observer\'s progress reaches the log as it happens', async () => {
  const h = harness({
    emit: (observer) => {
      observer.onStrengthened?.({ index: 0, identityDigest: 'abc123abc123', facts: ['revenue', 'paid'] });
      observer.onConflict?.({ index: 1, identityDigest: 'def456def456', facts: ['payout'] });
      observer.onProgress?.({ done: 250, of: 4000, created: 200, reObserved: 50 });
      observer.onFailure?.({ index: 9, identityDigest: 'aaa111aaa111', applied: 9, notAttempted: 3, detail: 'boom' });
    },
  });
  await runPoll(request(), h.deps);
  assert.ok(h.lines.some((l) => l.startsWith('event=CALL_STRENGTHENED') && l.includes('facts=revenue,paid')));
  assert.ok(h.lines.some((l) => l.startsWith('event=FACT_CONFLICT') && l.includes('facts=payout')));
  assert.ok(h.lines.some((l) => l.startsWith('event=PROGRESS') && l.includes('done=250')));
  assert.ok(h.lines.some((l) => l.startsWith('event=RECORD_FAILED') && l.includes('detail=boom')));
});

test('a dry run says what it would do and states what it cannot know', async () => {
  const h = harness({
    result: execution({
      outcome: 'DRY_RUN_READY',
      dryRun: true,
      newEvents: 1,
      duplicateObservations: 1,
      notAttempted: 2,
      reason: 'Nothing was written. Fact convergence is NOT predicted.',
    }),
  });
  const out = await runPoll(request({ dryRun: true }), h.deps);
  assert.equal(out.outcome, 'DRY_RUN_READY');
  assert.equal(h.calls[0]!.dryRun, true, 'the intent reached the primitive');
  assert.ok(h.lines.some((l) => l.startsWith('event=DRY_RUN_PLAN') && l.includes('wouldCreate=1')));
  const caveat = h.lines.find((l) => l.startsWith('event=DRY_RUN_CAVEAT'));
  assert.ok(caveat?.includes('convergencePredicted=NO'));
});

test('the summary states every count a reader needs to judge the run', async () => {
  const h = harness();
  const out: PollResult = await runPoll(request(), h.deps);
  const s = summary(h.lines);
  for (const field of [
    'PROVIDER_RECORDS_FETCHED=',
    'ACCEPTED_RECORDS=',
    'REFUSED_RECORDS=',
    'NEW_EVENTS=',
    'DUPLICATE_OBSERVATIONS=',
    'STRENGTHENED_CALLS=',
    'CONFLICTS=',
    'FAILED_PROCESSING=',
    'NOT_ATTEMPTED=',
    'OVERALL_RESULT=',
  ]) {
    assert.ok(s.includes(field), `the summary must state ${field}`);
  }
  assert.equal(out.dryRun, false);
});

// --- 12/23. Repository-wide: no second CallGrid REST WRITE path ------------------

/** Every .ts file under the given roots, with its prose stripped. */
function repositoryCode(): Array<{ path: string; code: string }> {
  const ROOT = join(HERE, '..', '..');
  const roots = [
    join(ROOT, 'apps', 'web', 'src'),
    join(ROOT, 'packages'),
    join(ROOT, 'scripts'),
  ];
  const out: Array<{ path: string; code: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        out.push({ path: full.slice(ROOT.length + 1), code: codeOf(readFileSync(full, 'utf8')) });
      }
    }
  };
  for (const root of roots) walk(root);
  return out;
}

test('23. every CallGrid multi-page loop outside the canonical reader is READ-ONLY', () => {
  // PR #184 asserted "exactly one multi-page loop" across three adapter files and
  // was right about those three. Repository-wide there is a SECOND cursor loop:
  // apps/web/.../integrations/callgrid/reconcile/route.ts, the forensic audit
  // route that settled the money unit. It is GET-only and writes nothing, so it
  // is not a parallel convergence path — but "nobody has made it one yet" is a
  // memory, and this is the assertion that replaces it.
  const loops = repositoryCode().filter(
    (f) => !f.path.includes('test') && /cursor = page\.nextCursor/.test(f.code),
  );
  assert.ok(loops.length >= 1, 'the canonical reader is one of them');
  for (const file of loops) {
    if (file.path.endsWith('callgrid-interval.ts')) continue;
    assert.ok(!file.code.includes('.ingest('), `${file.path} paginates AND ingests`);
    assert.ok(!file.code.includes('IngestionService'), `${file.path} paginates AND ingests`);
    assert.equal(
      /\.(?:create|update|upsert|delete|createMany|updateMany|deleteMany)\(\s*\{/.test(file.code),
      false,
      `${file.path} paginates AND writes`,
    );
  }
});

test('12/23. exactly one place ingests CallGrid REST records, and the old one is deleted', () => {
  const files = repositoryCode().filter((f) => !f.path.includes('test'));
  const ingestors = files.filter(
    (f) => f.code.includes('.ingest(') && f.code.toLowerCase().includes('callgrid'),
  );
  // TWO CallGrid ingestion entry points, and that is the intended architecture:
  // the webhook is the low-latency delivery path, and the poll is the
  // completeness path. What must never exist is a THIRD, or a second one that
  // RETRIEVES — the webhook is handed its record and does not go looking.
  assert.deepEqual(
    ingestors.map((f) => f.path).sort(),
    [
      'apps/web/src/app/api/webhooks/callgrid/route.ts',
      'packages/database/src/services/callgrid-poll.service.ts',
    ],
    'exactly two CallGrid ingestion entry points: one delivered, one retrieved',
  );
  const retrievingIngestors = ingestors.filter(
    (f) => f.code.includes('readCallGridInterval') || /cursor = page\.nextCursor/.test(f.code),
  );
  assert.deepEqual(
    retrievingIngestors.map((f) => f.path),
    ['packages/database/src/services/callgrid-poll.service.ts'],
    'one CallGrid REST write execution primitive',
  );
  // The parallel path is gone from the repository, not deprecated inside it.
  for (const file of files) {
    assert.ok(!file.code.includes('enrichExisting'), `${file.path} still references enrichExisting`);
    assert.ok(
      !file.code.includes('CallGridReconciliationService'),
      `${file.path} still references CallGridReconciliationService`,
    );
    assert.ok(!file.code.includes('mapReconEventType'), `${file.path} still names the old mapper`);
  }
});

// --- Instants, arguments, environment, leakage -----------------------------------

test('an interval bound must be an explicit instant — no bare date, no implicit zone', () => {
  assert.ok(parseInstant('2026-08-19T04:00:00Z'));
  assert.ok(parseInstant('2026-08-19T00:00:00-04:00'));
  for (const bad of ['2026-08-19', '2026-08-19T00:00', 'yesterday', 'now', '', '2026-13-01T00:00:00Z']) {
    assert.equal(parseInstant(bad), null, `${bad} must be refused`);
  }
});

test('writing requires --apply; omitting it is a dry run', () => {
  assert.equal(parseArgs(['--organization', 'x', '--since', 'a', '--until', 'b']).dryRun, true);
  assert.equal(parseArgs(['--organization', 'x', '--apply']).dryRun, false);
  assert.equal(parseArgs(['--organization', 'x', '--dry-run']).dryRun, true);
  // Contradictory instructions about whether to write production are refused.
  assert.equal(parseArgs(['--apply', '--dry-run']).contradiction, true);
  assert.equal(parseArgs(['--apply']).contradiction, false);
});

test('missing credentials are reported by NAME and never by value', () => {
  const out = readEnvironment({ DATABASE_URL: '', CALLGRID_API_KEY: '' } as NodeJS.ProcessEnv);
  assert.equal(out.ok, false);
  assert.deepEqual(out.ok === false ? out.missing : [], ['DATABASE_URL', 'CALLGRID_API_KEY']);
  assert.equal(readEnvironment({ DATABASE_URL: 'postgres://x', CALLGRID_API_KEY: 'k' } as NodeJS.ProcessEnv).ok, true);
});

test('no log line ever carries the credential, a provider identity or a caller number', async () => {
  const h = harness({
    result: execution({ failedIdentityDigest: identityDigest(CALL_ID), failedAtIndex: 3 }),
    emit: (observer) => observer.onConflict?.({ index: 0, identityDigest: identityDigest(CALL_ID), facts: ['revenue'] }),
  });
  await runPoll(request(), h.deps);
  for (const l of h.lines) {
    assert.ok(!l.includes(KEY), 'a credential leaked');
    assert.ok(!l.includes('5125550000'), 'a caller number leaked');
    assert.ok(!l.includes(CALL_ID), 'a provider identity leaked');
  }
});

// --- 27/28/29. No checkpoint, no schedule, no recovery ---------------------------

test('27/28. the runner holds no checkpoint, no watermark and no schedule', () => {
  for (const symbol of [
    'checkpoint',
    'Checkpoint',
    'watermark',
    'Watermark',
    'highWater',
    'lastPolled',
    'cursor',
    'cron',
    'schedule',
    'setInterval',
    'setTimeout',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('both interval bounds are supplied, never derived from the clock', () => {
  // An ARGUMENTLESS `new Date()` appears exactly once: in main(), as the injected
  // elapsed-time clock. A second one would be a bound this operation invented.
  assert.equal(RUNNER_CODE.split('new Date()').length - 1, 1, 'exactly one clock, and it is not a bound');
  for (const symbol of ['Date.now(', 'sinceForRange', 'easternBusinessDayWindow', "'7d'", "'24h'"]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not derive a bound from ${symbol}`);
  }
});

test('29. the runner cannot recover, certify, reconcile, measure or declare', () => {
  for (const symbol of [
    'API_RECOVERY',
    'ProviderObservationService',
    'certifyDay',
    'ProviderReconciliationService',
    'reconcileDay',
    'CallGridReconciliationService',
    'enrichExisting',
    'assessReadiness',
    'MeasurementService',
    'measureObjective',
    'HeadlineDetectionService',
    'ObjectiveMeasureBinding',
    'MeasurementSource',
    'MeasureSourceAuthority',
    'MemberExpectation',
    'declareExpectation',
    'registerSource',
    'OperationalPriority',
    'ensureLiveOrganization',
    'createUser',
    'LIVE_ORG_SLUG',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('the runner touches no row of its own, by any route', () => {
  assert.equal(/prisma\.[a-z]/.test(RUNNER_CODE), false, 'no Prisma model delegate');
  assert.equal(
    /\.(?:create|update|upsert|delete|createMany|updateMany|deleteMany)\(\s*\{/.test(RUNNER_CODE),
    false,
    'no direct persistence call',
  );
  for (const verb of ['$executeRaw', '$queryRaw', '$transaction', 'marketplaceCall', 'interaction.']) {
    assert.ok(!RUNNER_CODE.includes(verb), `the runner must not call ${verb} directly`);
  }
  assert.ok(RUNNER_CODE.includes('.execute('), 'the primitive is invoked, not reimplemented');
});

test('the runner fabricates no identity and rewrites no receipt', () => {
  for (const symbol of ['receivedAt', 'firstIngestionSource', 'observedSources', 'occurredAt:']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not touch ${symbol}`);
  }
  // The fabrication PR #178 deleted was `'callgrid-' + Date.now()`. The shape is
  // what matters; the bare prefix appears in this script's own entry-point guard.
  assert.equal(/['"]callgrid-['"]\s*\+/.test(RUNNER_CODE), false, 'no fabricated identity');
  const assignments = RUNNER_CODE.match(/externalId:(?!\s*(?:string|unknown)\b)/g) ?? [];
  assert.deepEqual(assignments, [], 'the runner never constructs an identity');
});

test('importing the module does not start a poll or set an exit code', () => {
  assert.notEqual(process.exitCode, 2, 'main() must not have run on import');
  assert.ok(!process.exitCode, 'importing the runner is inert');
});

// --- The workflow ---------------------------------------------------------------

test('the workflow is manual only: no schedule, no push, no pull_request', () => {
  assert.ok(WORKFLOW_STEPS.includes('workflow_dispatch:'));
  for (const trigger of ['schedule:', 'push:', 'pull_request:', 'workflow_call:', 'cron:']) {
    assert.ok(!WORKFLOW_STEPS.includes(trigger), `the workflow must not declare ${trigger}`);
  }
  assert.ok(/permissions:\s*\n\s*contents:\s*read/.test(WORKFLOW_STEPS), 'read-only token');
});

test('the workflow dry-runs by default and takes both bounds explicitly', () => {
  assert.ok(/dry_run:[\s\S]*default:\s*true/.test(WORKFLOW_STEPS), 'dry_run defaults to true');
  for (const input of ['organization_slug:', 'since:', 'until:']) {
    assert.ok(WORKFLOW_STEPS.includes(input), `the workflow must take ${input}`);
  }
});

test('the safety suite runs BEFORE the production credential is used', () => {
  const safety = WORKFLOW_STEPS.indexOf('npm run test:operations');
  const apply = WORKFLOW_STEPS.indexOf('npm run poll:callgrid');
  assert.ok(safety > 0, 'the safety suite runs');
  assert.ok(apply > safety, 'and it runs before the poll step');
});

test('workflow inputs reach the shell through the environment, never by interpolation', () => {
  assert.ok(WORKFLOW_RUN_BODIES.length > 0, 'there are run bodies to inspect');
  assert.ok(!WORKFLOW_RUN_BODIES.includes('${{ inputs.'), 'no input is interpolated into a run body');
  assert.ok(!WORKFLOW_RUN_BODIES.includes('${{ secrets.'), 'no secret is interpolated into a run body');
  assert.ok(WORKFLOW_STEPS.includes('CALLGRID_API_KEY: ${{ secrets.CALLGRID_API_KEY }}'));
  assert.ok(!/echo[^\n]*CALLGRID_API_KEY[^\n]*\}/.test(WORKFLOW_STEPS), 'the key is never echoed');
});

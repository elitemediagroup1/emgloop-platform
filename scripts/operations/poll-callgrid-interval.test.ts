// Tests for the manual bounded CallGrid poll.
//
// WHAT THESE PROVE
//
// One property carries the weight: NOTHING IS WRITTEN UNLESS THE PROVIDER READ
// FOR THE INTERVAL COMPLETED. Every way a read can end short — truncation, an
// exhausted 429 budget, a pagination fault, a provider error, a refused request,
// a record the mapper would not map — is asserted to reach ingestion zero times.
// A poll that wrote most of a day and called it a day is the failure this
// operation exists to make impossible.
//
// The second property is that a run which stops part-way SAYS SO. There is no
// path from a mid-batch failure to a success outcome, and a rerun of the same
// interval converges rather than duplicating.
//
// WHAT THESE DELIBERATELY DO NOT PROVE
//
// The canonical ingestion semantics — receivedAt, occurredAt,
// firstIngestionSource, observedSources, lastObservedAt, strengthening,
// ambiguity, conflict — are proved where they live, against the real
// IngestionService, in packages/database/test/{ingestion-time-semantics,
// observation-provenance,provider-fact-convergence-wiring}.test.ts. Restating
// them here against a stand-in ingestor would prove the stand-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InboundEvent } from '@emgloop/providers';
import type { IngestInput, IngestResult } from '@emgloop/database';

import {
  POLL_OBSERVATION_SOURCE,
  POLL_PROVIDER,
  POLL_RESULTS,
  REFUSED_ORGANIZATION_STATUSES,
  identityDigest,
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
// checks are about CODE: a header sentence saying this runner holds no
// checkpoint must not read as the code holding one.
const RUNNER_CODE = RUNNER_SOURCE.split('\n')
  .filter((l) => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

/** The workflow with its `#` prose removed, for the same reason. */
const WORKFLOW_STEPS = WORKFLOW_SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n');

/**
 * Only the SHELL BODIES of `run: |` blocks, by indentation.
 *
 * Splitting the file on `run: |` and keeping the tail was the first version, and
 * it swept up every later step's `env:` block -- which is exactly where an input
 * is SUPPOSED to appear. The assertion then failed on the safe pattern it exists
 * to require. A run body is the indented region under the key, and nothing else.
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

/** A real-shaped CallGrid identity, so a leak test has something to catch. */
function callId(n: number): string {
  return `cmsns65v8be2d07k368ox69s${n}`;
}

function event(n: number): InboundEvent {
  return {
    externalId: callId(n),
    rawEventType: 'COMPLETED',
    occurredAt: new Date(SINCE.getTime() + n * 60_000),
    payload: { id: callId(n), revenue: 17.5 },
    customerPhone: '+15125550000',
  };
}

type ReadResult = Parameters<PollDeps['reader']['read']> extends never ? never : Awaited<ReturnType<PollDeps['reader']['read']>>;

function readResult(over: Partial<ReadResult> = {}): ReadResult {
  const events = over.events ?? [event(1), event(2)];
  return {
    outcome: 'COMPLETE',
    since: SINCE,
    until: UNTIL,
    events,
    refused: [],
    pages: 1,
    records: events.length,
    pageCap: 500,
    rateLimitRetries: 0,
    ...over,
  } as ReadResult;
}

interface Harness {
  deps: PollDeps;
  lines: string[];
  ingested: string[];
  inputs: IngestInput[];
  readCalls: number;
}

function ingestResult(over: Partial<IngestResult> & { externalId: string }): IngestResult {
  return {
    status: 'processed',
    integrationEventId: 'evt_1',
    customerId: null,
    interactionId: null,
    signalIds: [],
    domainEventId: null,
    nextBestActions: [],
    strengthenedFacts: [],
    conflictedFacts: [],
    ...over,
  };
}

function harness(options: {
  read?: ReadResult;
  /** Per-externalId ingestion answer. Anything absent processes cleanly. */
  answers?: Record<string, Partial<IngestResult> | 'throw'>;
  /** Statuses the organization already holds, for the dry run's classification. */
  stored?: Record<string, string>;
  org?: { id: string; slug: string; name: string; status: string } | null;
} = {}): Harness {
  const lines: string[] = [];
  const ingested: string[] = [];
  const inputs: IngestInput[] = [];
  const state = { readCalls: 0 };
  let tick = 0;
  const deps: PollDeps = {
    reader: {
      async read() {
        state.readCalls += 1;
        return options.read ?? readResult();
      },
    },
    ingestor: {
      async ingest(input: IngestInput): Promise<IngestResult[]> {
        inputs.push(input);
        const ev = input.events[0];
        if (!ev) return [];
        const answer = options.answers?.[ev.externalId];
        if (answer === 'throw') throw new Error('database is unreachable');
        ingested.push(ev.externalId);
        return [ingestResult({ externalId: ev.externalId, ...(answer ?? {}) })];
      },
    },
    events: {
      async statusOfEvent(_org: string, _provider: string, externalId: string) {
        return options.stored?.[externalId] ?? null;
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
  return {
    deps,
    lines,
    ingested,
    inputs,
    get readCalls() {
      return state.readCalls;
    },
  };
}

function request(over: Partial<Parameters<typeof runPoll>[0]> = {}) {
  return {
    organizationSlug: ORG.slug,
    since: SINCE,
    until: UNTIL,
    apiKey: KEY,
    dryRun: false,
    mapEventType: (raw: string) => (raw === 'COMPLETED' ? 'call.completed' : 'call.inbound'),
    ...over,
  };
}

function summary(lines: string[]): string {
  return lines.find((l) => l.startsWith('event=SUMMARY'))!;
}

// --- 1. A complete interval can be planned and applied ------------------------

test('1. a valid bounded COMPLETE interval applies every accepted record', async () => {
  const h = harness();
  const out = await runPoll(request(), h.deps);
  assert.equal(out.overall, 'APPLIED');
  assert.deepEqual(h.ingested, [callId(1), callId(2)]);
  assert.equal(out.newEvents, 2);
  assert.equal(out.acceptedRecords, 2);
  assert.equal(out.notAttempted, 0);
  assert.ok(summary(h.lines).includes('OVERALL_RESULT=APPLIED'));
});

test('1b. every record is labelled API_POLL, and the label is not an input', async () => {
  const h = harness();
  await runPoll(request(), h.deps);
  for (const input of h.inputs) {
    assert.equal(input.observationSource, 'API_POLL');
    assert.equal(input.provider, POLL_PROVIDER);
    assert.equal(input.organizationId, ORG.id);
  }
  assert.equal(POLL_OBSERVATION_SOURCE, 'API_POLL');
  // A recovery labels its rows differently on purpose, and this operation cannot
  // claim that label however it is invoked.
  assert.ok(!RUNNER_CODE.includes('API_RECOVERY'), 'the runner cannot label a row as a recovery');
});

test('1c. the organization comes from the slug lookup, never from a caller-supplied id', () => {
  assert.ok(!RUNNER_CODE.includes('organizationId:') || RUNNER_CODE.includes('organization.id'));
  assert.ok(!/organizationId\s*:\s*request\./.test(RUNNER_CODE), 'no caller-supplied organization id');
});

// --- 2. Invalid bounds write nothing ------------------------------------------

test('2. reversed and equal bounds are refused before a provider request', async () => {
  for (const [since, until] of [
    [UNTIL, SINCE],
    [SINCE, SINCE],
  ] as const) {
    const h = harness();
    const out = await runPoll(request({ since, until }), h.deps);
    assert.equal(out.overall, 'REFUSED');
    assert.equal(h.readCalls, 0, 'no provider request was made');
    assert.equal(h.ingested.length, 0, 'nothing was written');
  }
});

test('2b. an interval wider than the reader accepts is refused, not truncated', async () => {
  const h = harness();
  const out = await runPoll(
    request({ since: SINCE, until: new Date(SINCE.getTime() + 60 * 24 * 3600_000) }),
    h.deps,
  );
  assert.equal(out.overall, 'REFUSED');
  assert.equal(h.readCalls, 0);
  assert.equal(h.ingested.length, 0);
});

test('2c. an unknown or suspended organization writes nothing', async () => {
  const missing = harness({ org: null });
  assert.equal((await runPoll(request(), missing.deps)).overall, 'REFUSED');
  assert.equal(missing.readCalls, 0);

  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const h = harness({ org: { ...ORG, status } });
    const out = await runPoll(request(), h.deps);
    assert.equal(out.overall, 'REFUSED');
    assert.equal(h.readCalls, 0);
    assert.equal(h.ingested.length, 0);
  }
});

// --- 3/4/5. Every incomplete retrieval writes nothing -------------------------

test('3/4/5. TRUNCATED, RATE_LIMIT_EXHAUSTED, INVALID_PAGINATION and PROVIDER_ERROR write nothing', async () => {
  for (const outcome of ['TRUNCATED', 'RATE_LIMIT_EXHAUSTED', 'INVALID_PAGINATION', 'PROVIDER_ERROR', 'REFUSED'] as const) {
    const h = harness({
      read: readResult({ outcome, reason: `ended ${outcome}`, events: [event(1), event(2), event(3)] }),
    });
    const out = await runPoll(request(), h.deps);
    assert.equal(out.overall, 'FETCH_INCOMPLETE', `${outcome} must not apply`);
    assert.equal(out.fetchOutcome, outcome);
    assert.equal(h.ingested.length, 0, `${outcome} wrote something`);
    assert.equal(out.newEvents, 0);
    assert.equal(out.notAttempted, 3, 'the records that DID come back are reported, not written');
    assert.ok(h.lines.some((l) => l.startsWith('event=WRITES_SKIPPED')));
    assert.ok(summary(h.lines).includes('OVERALL_RESULT=FETCH_INCOMPLETE'));
  }
});

test('3b. a partial read is never reported as a success, whatever came back', async () => {
  const h = harness({ read: readResult({ outcome: 'TRUNCATED', events: [event(1)] }) });
  const out = await runPoll(request(), h.deps);
  assert.ok(!['APPLIED', 'APPLIED_WITH_CONFLICTS', 'DRY_RUN_READY'].includes(out.overall));
});

test('3c. a reader that throws is an incomplete fetch, not a failed write', async () => {
  const h = harness();
  h.deps.reader.read = async () => {
    throw new Error('socket hang up');
  };
  const out = await runPoll(request(), h.deps);
  assert.equal(out.overall, 'FETCH_INCOMPLETE');
  assert.equal(h.ingested.length, 0);
});

test('3d. completeness is judged by the shared predicate, not a local list of outcomes', () => {
  assert.ok(RUNNER_CODE.includes('intervalWasComplete('), 'the shared rule decides');
  assert.ok(
    !/outcome\s*===\s*'COMPLETE'/.test(RUNNER_CODE),
    'the runner must not re-spell the completeness rule',
  );
});

// --- 6. A refused record cannot silently disappear ----------------------------

test('6. one unmappable record in a COMPLETE read aborts every write', async () => {
  const h = harness({
    read: readResult({
      events: [event(1), event(2)],
      records: 3,
      refused: [{ page: 1, reason: 'no usable identity field', kind: 'no-identity' }],
    }),
  });
  const out = await runPoll(request(), h.deps);
  assert.equal(out.overall, 'REFUSED');
  assert.equal(h.ingested.length, 0, 'accepted records were NOT written alongside a refusal');
  assert.equal(out.refusedRecords, 1);
  assert.equal(out.acceptedRecords, 2);
  assert.equal(out.notAttempted, 2);
  assert.equal(out.providerRecordsFetched, 3);
  // Each refusal is named, so it cannot vanish into a count.
  assert.equal(h.lines.filter((l) => l.startsWith('event=RECORD_REFUSED')).length, 1);
  assert.ok(h.lines.some((l) => l.includes('kind=no-identity')));
});

test('6b. accepted and refused are reported separately from the raw record count', async () => {
  const h = harness({
    read: readResult({ events: [event(1)], records: 2, refused: [{ page: 2, reason: 'no occurrence' }] }),
  });
  const out = await runPoll(request(), h.deps);
  assert.equal(out.providerRecordsFetched, 2);
  assert.equal(out.acceptedRecords, 1);
  assert.equal(out.refusedRecords, 1);
  assert.ok(summary(h.lines).includes('REFUSED_RECORDS=1'));
});

// --- Conflicts are a business outcome, not a failure --------------------------

test('a provider fact conflict is surfaced and does not stop the run', async () => {
  const h = harness({
    answers: {
      [callId(1)]: { status: 'duplicate', conflictedFacts: ['revenue'] },
      [callId(2)]: { status: 'duplicate', strengthenedFacts: ['paid'] },
    },
  });
  const out = await runPoll(request(), h.deps);
  assert.equal(out.overall, 'APPLIED_WITH_CONFLICTS');
  assert.equal(out.conflicts, 1);
  assert.equal(out.strengthenedCalls, 1);
  assert.equal(out.duplicateObservations, 2, 'the run continued past the conflict');
  assert.ok(h.lines.some((l) => l.startsWith('event=FACT_CONFLICT') && l.includes('facts=revenue')));
  assert.ok(h.lines.some((l) => l.startsWith('event=CALL_STRENGTHENED')));
});

test('a run with conflicts is never reported as a plain APPLIED', async () => {
  const h = harness({ answers: { [callId(2)]: { status: 'duplicate', conflictedFacts: ['payout'] } } });
  const out = await runPoll(request(), h.deps);
  assert.notEqual(out.overall, 'APPLIED');
  assert.ok(summary(h.lines).includes('CONFLICTS=1'));
});

// --- 18. A mid-batch failure is never a success -------------------------------

test('18. an unexpected failure part-way through reports PARTIALLY_APPLIED', async () => {
  const h = harness({
    read: readResult({ events: [event(1), event(2), event(3)] }),
    answers: { [callId(2)]: 'throw' },
  });
  const out = await runPoll(request(), h.deps);
  assert.equal(out.overall, 'PARTIALLY_APPLIED');
  assert.equal(out.newEvents, 1, 'the first record is live');
  assert.equal(out.failedProcessing, 1);
  assert.equal(out.failedAtIndex, 1);
  assert.equal(out.notAttempted, 1, 'the third record was never attempted');
  assert.deepEqual(h.ingested, [callId(1)], 'processing STOPPED rather than continuing');
  assert.ok(summary(h.lines).includes('OVERALL_RESULT=PARTIALLY_APPLIED'));
});

test('18b. a failure on the FIRST record is PROCESSING_FAILED, with nothing live', async () => {
  const h = harness({ answers: { [callId(1)]: 'throw' } });
  const out = await runPoll(request(), h.deps);
  assert.equal(out.overall, 'PROCESSING_FAILED');
  assert.equal(out.newEvents + out.duplicateObservations, 0);
  assert.equal(out.notAttempted, 1);
});

test('18c. an ingestion result of `failed` stops the run exactly as a throw does', async () => {
  const h = harness({
    read: readResult({ events: [event(1), event(2), event(3)] }),
    answers: { [callId(2)]: { status: 'failed', error: 'normalization blew up' } },
  });
  const out = await runPoll(request(), h.deps);
  assert.equal(out.overall, 'PARTIALLY_APPLIED');
  assert.equal(out.failedAtIndex, 1);
  assert.ok(h.lines.some((l) => l.includes('detail=normalization blew up')));
});

test('18d. the failing record is identified without printing a provider identity', async () => {
  const h = harness({ answers: { [callId(1)]: 'throw' } });
  const out = await runPoll(request(), h.deps);
  assert.equal(out.failedIdentityDigest, identityDigest(callId(1)));
  for (const l of h.lines) assert.ok(!l.includes(callId(1)), `a raw identity leaked: ${l}`);
});

// --- 19/20. Rerun ---------------------------------------------------------------

test('19. rerunning after a partial apply converges: the applied rows come back as duplicates', async () => {
  const first = harness({
    read: readResult({ events: [event(1), event(2), event(3)] }),
    answers: { [callId(2)]: 'throw' },
  });
  const before = await runPoll(request(), first.deps);
  assert.equal(before.overall, 'PARTIALLY_APPLIED');

  // The identical interval, asked again. Nothing about the request changes: this
  // runner holds no memory of the first attempt, deliberately.
  const second = harness({
    read: readResult({ events: [event(1), event(2), event(3)] }),
    answers: { [callId(1)]: { status: 'duplicate' } },
  });
  const after = await runPoll(request(), second.deps);
  assert.equal(after.overall, 'APPLIED');
  assert.equal(after.duplicateObservations, 1, 'the already-written row was re-observed, not duplicated');
  assert.equal(after.newEvents, 2);
  assert.deepEqual(second.ingested, [callId(1), callId(2), callId(3)]);
});

test('20. an identical full rerun creates nothing new and produces no revision noise', async () => {
  const answers = {
    [callId(1)]: { status: 'duplicate' as const },
    [callId(2)]: { status: 'duplicate' as const },
  };
  const h = harness({ answers });
  const out = await runPoll(request(), h.deps);
  assert.equal(out.overall, 'APPLIED');
  assert.equal(out.newEvents, 0);
  assert.equal(out.duplicateObservations, 2);
  // CANONICAL DATA IDEMPOTENCY vs OBSERVATION TIME ADVANCEMENT: an unchanged
  // rerun moves no fact and records no revision, while lastObservedAt advancing
  // is expected and is IngestionService's business, not this runner's.
  assert.equal(out.strengthenedCalls, 0);
  assert.equal(out.conflicts, 0);
  assert.ok(!h.lines.some((l) => l.startsWith('event=CALL_STRENGTHENED')));
  assert.ok(!h.lines.some((l) => l.startsWith('event=FACT_CONFLICT')));
  assert.ok(!RUNNER_CODE.includes('lastObservedAt'), 'observation time is not this runner"s to write');
});

test('20b. the runner asks ingestion once per record and never batches identities together', async () => {
  const h = harness({ read: readResult({ events: [event(1), event(2), event(3)] }) });
  await runPoll(request(), h.deps);
  assert.equal(h.inputs.length, 3);
  for (const input of h.inputs) assert.equal(input.events.length, 1);
});

// --- 21. Dry run ----------------------------------------------------------------

test('21. a dry run reads the provider, classifies, and writes nothing', async () => {
  const h = harness({ stored: { [callId(1)]: 'PROCESSED' } });
  const out = await runPoll(request({ dryRun: true }), h.deps);
  assert.equal(out.overall, 'DRY_RUN_READY');
  assert.equal(h.readCalls, 1, 'the provider WAS read');
  assert.equal(h.ingested.length, 0, 'ingestion was never called');
  assert.equal(h.inputs.length, 0);
  assert.equal(out.duplicateObservations, 1, 'an existing PROCESSED delivery would be re-observed');
  assert.equal(out.newEvents, 1);
  assert.equal(out.notAttempted, 2);
  assert.ok(h.lines.some((l) => l.startsWith('event=DRY_RUN_PLAN')));
});

test('21b. a dry run refuses to predict what it cannot know, out loud', async () => {
  const h = harness();
  await runPoll(request({ dryRun: true }), h.deps);
  const caveat = h.lines.find((l) => l.startsWith('event=DRY_RUN_CAVEAT'));
  assert.ok(caveat, 'the dry run states its own limits');
  assert.ok(caveat.includes('convergencePredicted=NO'));
});

test('21c. a dry run classifies with the SAME predicate ingestion branches on', async () => {
  // RECEIVED and FAILED rows are retryable and are NOT duplicates. A dry run that
  // spelled `status !== null` would call them duplicates and describe a run that
  // does not exist.
  const h = harness({ stored: { [callId(1)]: 'FAILED', [callId(2)]: 'RECEIVED' } });
  const out = await runPoll(request({ dryRun: true }), h.deps);
  assert.equal(out.newEvents, 2);
  assert.equal(out.duplicateObservations, 0);
  assert.ok(RUNNER_CODE.includes('isDuplicateObservation('), 'the shared predicate is used');
  assert.ok(!/===\s*'PROCESSED'/.test(RUNNER_CODE), 'the status literal is not re-spelled here');
});

test('21d. a dry run over an incomplete read still writes nothing and still says so', async () => {
  const h = harness({ read: readResult({ outcome: 'TRUNCATED' }) });
  const out = await runPoll(request({ dryRun: true }), h.deps);
  assert.equal(out.overall, 'FETCH_INCOMPLETE');
  assert.equal(h.ingested.length, 0);
});

// --- Instants, arguments, environment -----------------------------------------

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
  const ok = readEnvironment({ DATABASE_URL: 'postgres://x', CALLGRID_API_KEY: 'k' } as NodeJS.ProcessEnv);
  assert.equal(ok.ok, true);
});

test('no log line ever carries the credential or a caller phone number', async () => {
  const h = harness();
  await runPoll(request(), h.deps);
  for (const l of h.lines) {
    assert.ok(!l.includes(KEY), 'a credential leaked');
    assert.ok(!l.includes('5125550000'), 'a caller number leaked');
    assert.ok(!l.includes(callId(1)), 'a provider identity leaked');
  }
});

test('the outcome vocabulary is closed and every member is reachable', () => {
  assert.deepEqual([...POLL_RESULTS].sort(), [
    'APPLIED',
    'APPLIED_WITH_CONFLICTS',
    'DRY_RUN_READY',
    'FETCH_INCOMPLETE',
    'PARTIALLY_APPLIED',
    'PROCESSING_FAILED',
    'REFUSED',
  ]);
});

// --- 22/23/24. No checkpoint, no schedule, no recovery ------------------------

test('22/23/24. the runner holds no checkpoint, no watermark and no schedule', () => {
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

test('22b. both interval bounds are supplied, never derived from the clock', () => {
  // An ARGUMENTLESS `new Date()` appears exactly once: in main(), as the injected
  // elapsed-time clock. A second one would be a bound this operation invented.
  // `new Date(ms)` is deliberately not counted -- parsing an instant the operator
  // typed is the opposite of inventing one.
  const occurrences = RUNNER_CODE.split('new Date()').length - 1;
  assert.equal(occurrences, 1, 'exactly one clock, and it is not a bound');
  for (const symbol of ['Date.now(', 'sinceForRange', 'easternBusinessDayWindow', "'7d'", "'24h'"]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not derive a bound from ${symbol}`);
  }
});

test('24. the runner cannot recover, certify, reconcile, measure or declare', () => {
  for (const symbol of [
    'API_RECOVERY',
    'ProviderObservationService',
    'certifyDay',
    'ProviderReconciliationService',
    'reconcileDay',
    'CallGridReconciliationService',
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

test('25. the runner has exactly one write path, and it is IngestionService', () => {
  // No model delegate is reachable from here: everything that touches a row goes
  // through an injected seam. `prisma.$disconnect()` is deliberately allowed —
  // closing the connection this script opened is hygiene, not data access.
  assert.equal(/prisma\.[a-z]/.test(RUNNER_CODE), false, 'no Prisma model delegate');
  // Persistence-SHAPED calls: a Prisma write takes an object literal, which is
  // what separates `update({ where })` from `createHash(...).update(externalId)`.
  // The first version of this assertion matched the bare verb and failed on the
  // hash, which is the same class of mistake as a query matching more rows than
  // it names.
  assert.equal(
    /\.(?:create|update|upsert|delete|createMany|updateMany|deleteMany|upsertMany)\(\s*\{/.test(RUNNER_CODE),
    false,
    'the runner must not call a persistence method directly',
  );
  for (const verb of ['$executeRaw', '$queryRaw', '$transaction', '$queryRawUnsafe']) {
    assert.ok(!RUNNER_CODE.includes(verb), `the runner must not call ${verb} directly`);
  }
  assert.ok(RUNNER_CODE.includes('.ingest('), 'ingestion is invoked, not reimplemented');
  // Retrieval is invoked, not reimplemented either.
  assert.ok(RUNNER_CODE.includes('readCallGridInterval('), 'the canonical reader is used');
  for (const symbol of ['fetchCallGridCallsPage', 'fetchAllCallGridCalls', 'nextCursor', 'maxPages']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `pagination belongs to the reader, not ${symbol} here`);
  }
});

test('25b. the runner fabricates no identity and rewrites no receipt', () => {
  for (const symbol of ['receivedAt', 'firstIngestionSource', 'observedSources', 'occurredAt:']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not touch ${symbol}`);
  }
  // The fabrication PR #178 deleted was `'callgrid-' + Date.now()`. Matching the
  // bare prefix caught this file's own entry-point guard, which names the script;
  // the shape is what matters, and `Date.now(` is separately forbidden above.
  assert.equal(/['"]callgrid-['"]\s*\+/.test(RUNNER_CODE), false, 'no fabricated identity');
  // Every `externalId:` in this file is a TYPE POSITION -- a parameter the runner
  // is handed. An identity it assigned would be an identity it invented, and the
  // adapter is the only place allowed to decide what a call is called.
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
  // A ${{ }} expansion inside `run:` is pasted as literal shell text, which is how
  // an input becomes a command.
  assert.ok(WORKFLOW_RUN_BODIES.length > 0, 'there are run bodies to inspect');
  assert.ok(!WORKFLOW_RUN_BODIES.includes('${{ inputs.'), 'no input is interpolated into a run body');
  assert.ok(!WORKFLOW_RUN_BODIES.includes('${{ secrets.'), 'no secret is interpolated into a run body');
  assert.ok(WORKFLOW_STEPS.includes('CALLGRID_API_KEY: ${{ secrets.CALLGRID_API_KEY }}'));
  assert.ok(!/echo[^\n]*CALLGRID_API_KEY[^\n]*\}/.test(WORKFLOW_STEPS), 'the key is never echoed');
});

test('the run result vocabulary is what the summary prints', async () => {
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

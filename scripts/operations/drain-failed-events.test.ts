// Tests for the FAILED integration-event drain.
//
// WHAT WAS ACTUALLY BROKEN
//
// The CallGrid settings panel has rendered a "Retry Queue" since Sprint 17 and
// nothing has ever drained it — there is no retry action, endpoint or operation
// behind that panel anywhere in the repository. The pipeline was always ready:
// `ingestOne` short-circuits only on PROCESSED, so a FAILED row is reused and
// re-run. What was missing was something to hand it the row again.
//
// WHAT THESE PROVE
//
//   1. a stored row is rebuilt from stored evidence, never from the clock;
//   2. a row that cannot be rebuilt is REFUSED and named, never patched up;
//   3. every row goes back through the canonical IngestionService;
//   4. the reprocess is labelled LOCAL_REPROCESS, because no provider was asked;
//   5. one attempt per row per run — a row that fails again stays failed and is
//      named, rather than being tried harder until it looks fine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OBSERVATION_SOURCES, isObservationSource } from '@emgloop/shared';
import { mapCallGridApiRecord, resolveCallOccurrence } from '@emgloop/providers';
import type { IngestInput, IngestResult } from '@emgloop/database';

import {
  DEFAULT_DRAIN_LIMIT,
  DRAIN_RESULTS,
  MAX_DRAIN_LIMIT,
  REFUSAL_REASONS,
  REPROCESS_OBSERVATION_SOURCE,
  REPROCESS_SOURCE_IS_KNOWN,
  STORED_PHONE_KEYS,
  parseArgs,
  readEnvironment,
  reconstruct,
  runDrain,
  type DrainDeps,
  type FailedEventRow,
} from './drain-failed-events';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_CODE = readFileSync(join(HERE, 'drain-failed-events.ts'), 'utf8')
  .split('\n')
  .filter((l) => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

const ORG = { id: 'org_1', slug: 'fixture-org', name: 'Fixture Org', status: 'ACTIVE' };
const CALL_ID = 'cmsns65v8be2d07k368ox69s1';
const OCCURRED = new Date('2026-08-11T18:30:00.000Z');
const RECEIVED = new Date('2026-08-11T18:30:05.000Z');

const row = (over: Partial<FailedEventRow> = {}): FailedEventRow => ({
  id: 'evt_1',
  externalId: CALL_ID,
  provider: 'callgrid',
  eventType: 'call.completed',
  receivedAt: RECEIVED,
  occurredAt: OCCURRED,
  error: 'normalization blew up',
  payload: { id: CALL_ID, caller: '+15125550000', revenue: 17.5 },
  ...over,
});

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

interface Harness {
  deps: DrainDeps;
  lines: string[];
  inputs: IngestInput[];
}

function harness(options: {
  rows?: FailedEventRow[];
  answers?: Record<string, Partial<IngestResult> | 'throw'>;
  org?: { id: string; slug: string; name: string; status: string } | null;
  onRead?: (options: { provider?: string; limit: number }) => void;
} = {}): Harness {
  const lines: string[] = [];
  const inputs: IngestInput[] = [];
  let tick = 0;
  const deps: DrainDeps = {
    events: {
      async listFailedEvents(_org, opts) {
        options.onRead?.(opts);
        return options.rows ?? [row()];
      },
    },
    ingestor: {
      async ingest(input) {
        inputs.push(input);
        const ev = input.events[0];
        if (!ev) return [];
        const answer = options.answers?.[ev.externalId];
        if (answer === 'throw') throw new Error('database is unreachable');
        return [ingestResult({ externalId: ev.externalId, ...(answer ?? {}) })];
      },
    },
    resolveOccurrence: (payload) => resolveCallOccurrence(payload),
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
  return { deps, lines, inputs };
}

const run = (h: Harness, over: Record<string, unknown> = {}) =>
  runDrain(
    { organizationSlug: ORG.slug, limit: DEFAULT_DRAIN_LIMIT, dryRun: false, ...over },
    h.deps,
  );

const summary = (lines: string[]): string => lines.find((l) => l.startsWith('event=SUMMARY'))!;

// --- 3/4. The canonical path, and an honest label ---------------------------------

test('3. every row goes back through the canonical ingestion path, one row at a time', async () => {
  const h = harness({ rows: [row({ id: 'a' }), row({ id: 'b', externalId: 'other-call' })] });
  const out = await run(h);
  assert.equal(out.overall, 'DRAINED');
  assert.equal(h.inputs.length, 2);
  for (const input of h.inputs) assert.equal(input.events.length, 1);
  // Not a second engine: there is one ingest call site and no pipeline here.
  assert.ok(RUNNER_CODE.includes('deps.ingestor.ingest('));
  for (const symbol of ['NormalizationEngine', 'projectInteraction', 'marketplaceCall', 'convergeFact']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the drain must not reference ${symbol}`);
  }
});

test('4. the reprocess is labelled LOCAL_REPROCESS, and that label is a real one', async () => {
  const h = harness();
  await run(h);
  assert.equal(h.inputs[0]!.observationSource, 'LOCAL_REPROCESS');
  // No provider request happens here. WEBHOOK or API_POLL would say CallGrid was
  // asked when it was not; API_RECOVERY would say somebody went and got it when
  // the evidence never left.
  assert.equal(REPROCESS_OBSERVATION_SOURCE, 'LOCAL_REPROCESS');
  assert.equal(REPROCESS_SOURCE_IS_KNOWN, true, 'the vocabulary knows it');
  assert.equal(isObservationSource('LOCAL_REPROCESS'), true);
  assert.ok(OBSERVATION_SOURCES.includes('LOCAL_REPROCESS'));
  assert.ok(summary(h.lines).includes('OBSERVATION_SOURCE=LOCAL_REPROCESS'));
  // And the operator cannot pick a different one.
  assert.ok(!/observationSource:\s*request\./.test(RUNNER_CODE));
  assert.ok(!RUNNER_CODE.includes("'API_RECOVERY'") && !RUNNER_CODE.includes("'WEBHOOK'"));
});

test('the row is re-offered as its OWN provider, not as whatever was filtered on', async () => {
  const h = harness({
    rows: [row({ id: 'a', provider: 'callgrid' }), row({ id: 'b', externalId: 'w1', provider: 'website' })],
  });
  await run(h);
  assert.deepEqual(h.inputs.map((i) => i.provider), ['callgrid', 'website']);
});

// --- 1/2. Rebuilt from evidence, or refused ----------------------------------------

test('1. the stored occurrence is used, and the clock is never substituted for it', () => {
  const rebuilt = reconstruct(row(), (p) => resolveCallOccurrence(p));
  assert.equal(rebuilt.ok, true);
  if (!rebuilt.ok) return;
  assert.equal(rebuilt.occurredAt.toISOString(), OCCURRED.toISOString());
  // receivedAt is never touched: Loop received this delivery when it received it,
  // and re-running the pipeline does not change that.
  // Every `receivedAt:` here is a TYPE POSITION — a field the stored row has. An
  // ASSIGNED one would be a receipt the drain rewrote, and re-running a pipeline
  // does not change when Loop received the delivery.
  const receipts = RUNNER_CODE.match(/receivedAt:(?!\s*Date\b)/g) ?? [];
  assert.deepEqual(receipts, [], 'the drain never writes a receipt');
  assert.ok(!RUNNER_CODE.includes('firstIngestionSource'), 'nor a first-observation label');
  assert.equal(RUNNER_CODE.split('new Date()').length - 1, 1, 'one clock, in main(), for elapsed time');
});

test('1b. a legacy row with no occurrence COLUMN falls back to the canonical resolver', () => {
  const legacy = row({ occurredAt: null, payload: { id: CALL_ID, UTCUnixTimeMs: OCCURRED.getTime() } });
  const rebuilt = reconstruct(legacy, (p) => resolveCallOccurrence(p));
  assert.equal(rebuilt.ok, true);
  if (rebuilt.ok) assert.equal(rebuilt.occurredAt.getTime(), OCCURRED.getTime());
});

test('2. A ROW THAT CANNOT BE REBUILT IS REFUSED AND NAMED, never patched up', () => {
  const cases: Array<[Partial<FailedEventRow>, string]> = [
    [{ externalId: null }, 'NO_IDENTITY'],
    [{ externalId: '  ' }, 'NO_IDENTITY'],
    [{ provider: null }, 'NO_PROVIDER'],
    [{ payload: null }, 'NO_PAYLOAD'],
    [{ payload: {} }, 'NO_PAYLOAD'],
    [{ payload: [1, 2] }, 'NO_PAYLOAD'],
    [{ occurredAt: null, payload: { id: CALL_ID } }, 'NO_OCCURRENCE'],
  ];
  for (const [over, reason] of cases) {
    const out = reconstruct(row(over), (p) => resolveCallOccurrence(p));
    assert.equal(out.ok, false, `${reason} should refuse`);
    if (!out.ok) assert.equal(out.reason, reason);
  }
  assert.deepEqual([...REFUSAL_REASONS].sort(), ['NO_IDENTITY', 'NO_OCCURRENCE', 'NO_PAYLOAD', 'NO_PROVIDER']);
});

test('2b. a refused row is reported with its prior error and never offered', async () => {
  const h = harness({ rows: [row({ id: 'bad', externalId: null, error: 'no identity on the way in' })] });
  const out = await run(h);
  assert.equal(h.inputs.length, 0, 'nothing was offered');
  assert.equal(out.refused, 1);
  assert.equal(out.attempted, 0);
  assert.equal(out.overall, 'NOT_DRAINED');
  const refused = h.lines.find((l) => l.startsWith('event=ROW_REFUSED'))!;
  assert.ok(refused.includes('reason=NO_IDENTITY'));
  assert.ok(refused.includes('priorError=no identity on the way in'));
});

test('the stored eventType is passed through, never mapped a second time', async () => {
  const h = harness({ rows: [row({ eventType: 'call.completed' })] });
  await run(h);
  const input = h.inputs[0]!;
  assert.equal(input.events[0]!.rawEventType, 'call.completed');
  // A second mapping of an already-mapped value is where a call.completed
  // quietly becomes a call.inbound.
  assert.equal(input.mapEventType('call.completed'), 'call.completed');
  assert.equal(input.mapEventType('anything'), 'anything');
  assert.ok(!RUNNER_CODE.includes('mapCallGridEventType'), 'no re-mapping here');
});

// --- Contact recovery, guarded behaviourally ------------------------------------------

test('the contact keys recovered are the ones the shipped adapter actually writes', () => {
  // A BEHAVIOURAL GUARD, not a promise. If the adapter renames the key it writes,
  // this fails rather than the drain silently degrading every reprocess by
  // resolving no customer.
  const mapped = mapCallGridApiRecord({
    id: CALL_ID,
    CallerId: '+15125559999',
    UTCUnixTimeMs: OCCURRED.getTime(),
    callStatus: 'COMPLETED',
  });
  assert.ok(mapped && !('error' in mapped && mapped.error), 'the fixture maps');
  const payload = (mapped as { payload: Record<string, unknown> }).payload;
  const recovered = reconstruct(row({ payload }), (p) => resolveCallOccurrence(p));
  assert.equal(recovered.ok, true);
  if (!recovered.ok) return;
  assert.equal(
    recovered.customerPhone,
    (mapped as { customerPhone?: string }).customerPhone,
    'the drain recovers the same phone the adapter produced',
  );
  assert.ok(STORED_PHONE_KEYS.some((k) => k in payload), 'and it reads a key the adapter wrote');
});

test('a payload with no contact still reconstructs, without inventing one', () => {
  const rebuilt = reconstruct(row({ payload: { id: CALL_ID } }), (p) => resolveCallOccurrence(p));
  assert.equal(rebuilt.ok, true);
  if (rebuilt.ok) {
    assert.equal(rebuilt.customerPhone, undefined);
    assert.equal(rebuilt.customerEmail, undefined);
  }
});

// --- 5. One attempt per row per run ------------------------------------------------------

test('5. A ROW THAT FAILS AGAIN STAYS FAILED AND IS NAMED — it is not tried harder', async () => {
  const h = harness({
    rows: [row({ id: 'a' }), row({ id: 'b', externalId: 'call-b' })],
    answers: { 'call-b': { status: 'failed', error: 'still broken' } },
  });
  const out = await run(h);
  assert.equal(h.inputs.length, 2, 'each row offered exactly once');
  assert.equal(out.processed, 1);
  assert.equal(out.failedAgain, 1);
  assert.equal(out.overall, 'PARTIALLY_DRAINED', 'never a clean DRAINED');
  const failed = h.lines.find((l) => l.startsWith('event=ROW_RESULT') && l.includes('status=failed'))!;
  assert.ok(failed.includes('detail=still broken'));
  assert.ok(failed.includes('priorError=normalization blew up'), 'and what it failed with before');
  // No loop, no backoff, no re-attempt inside a run.
  for (const symbol of ['while (', 'setTimeout', 'retryCount', 'attempt++', 'backoff']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the drain must not contain ${symbol}`);
  }
});

test('5b. one broken row does not block the rows behind it', async () => {
  // The opposite of the bounded poll, deliberately: these are independent
  // deliveries that already failed once, and stopping at the first would mean one
  // permanently broken row blocks every other row forever — which is what a queue
  // with no drain already did to this platform.
  const h = harness({
    rows: [row({ id: 'a', externalId: 'call-a' }), row({ id: 'b', externalId: 'call-b' }), row({ id: 'c', externalId: 'call-c' })],
    answers: { 'call-a': 'throw' },
  });
  const out = await run(h);
  assert.equal(h.inputs.length, 3, 'it kept going');
  assert.equal(out.failedAgain, 1);
  assert.equal(out.processed, 2);
});

test('a row that comes back as a duplicate is counted as one, not as processed', async () => {
  const h = harness({ answers: { [CALL_ID]: { status: 'duplicate' } } });
  const out = await run(h);
  assert.equal(out.duplicates, 1);
  assert.equal(out.processed, 0);
  assert.equal(out.overall, 'DRAINED');
});

test('a run where every attempted row fails again is NOT_DRAINED', async () => {
  const h = harness({ answers: { [CALL_ID]: { status: 'failed', error: 'still broken' } } });
  const out = await run(h);
  assert.equal(out.overall, 'NOT_DRAINED');
  assert.match(String(out.reason), /failed again/);
});

// --- Bounding and dry run ------------------------------------------------------------------

test('the run is bounded, and the bound is passed to the read rather than applied after', async () => {
  let seen: { provider?: string; limit: number } | null = null;
  const h = harness({ onRead: (o) => (seen = o) });
  await run(h, { limit: 7, provider: 'callgrid' });
  const opts = seen as unknown as { provider?: string; limit: number };
  assert.equal(opts.limit, 7);
  assert.equal(opts.provider, 'callgrid');
});

test('an oversized limit is clamped rather than honoured', async () => {
  let seen: { limit: number } | null = null;
  const h = harness({ onRead: (o) => (seen = o) });
  await run(h, { limit: 100_000 });
  assert.equal((seen as unknown as { limit: number }).limit, MAX_DRAIN_LIMIT);
  assert.equal(parseArgs(['--limit', '100000']).limit, MAX_DRAIN_LIMIT);
  // An unparseable limit keeps the default rather than becoming NaN and silently
  // meaning "no bound at all".
  assert.equal(parseArgs(['--limit', 'lots']).limit, DEFAULT_DRAIN_LIMIT);
  assert.equal(parseArgs(['--limit', '-5']).limit, DEFAULT_DRAIN_LIMIT);
});

test('a dry run reads and classifies and writes nothing', async () => {
  const h = harness({ rows: [row({ id: 'a' }), row({ id: 'b', externalId: null })] });
  const out = await run(h, { dryRun: true });
  assert.equal(out.overall, 'DRY_RUN_READY');
  assert.equal(h.inputs.length, 0, 'ingestion was never called');
  assert.equal(out.refused, 1, 'and a row that could not be rebuilt still says so');
  assert.ok(h.lines.some((l) => l.startsWith('event=ROW_PLANNED')));
  assert.equal(parseArgs(['--organization', 'x']).dryRun, true, 'and it is the default');
  assert.equal(parseArgs(['--apply']).dryRun, false);
  assert.equal(parseArgs(['--apply', '--dry-run']).contradiction, true);
});

test('an empty queue is NOTHING_TO_DRAIN rather than a failure', async () => {
  const h = harness({ rows: [] });
  const out = await run(h);
  assert.equal(out.overall, 'NOTHING_TO_DRAIN');
  assert.equal(out.found, 0);
});

test('preconditions refuse before any row is read', async () => {
  assert.equal((await run(harness({ org: null }))).overall, 'REFUSED');
  for (const status of ['SUSPENDED', 'CANCELED']) {
    const h = harness({ org: { ...ORG, status } });
    assert.equal((await run(h)).overall, 'REFUSED');
    assert.equal(h.inputs.length, 0);
  }
  assert.equal((await run(harness(), { organizationSlug: '' })).overall, 'REFUSED');
  assert.equal((await run(harness(), { limit: 0 })).overall, 'REFUSED');
});

// --- Structure and leakage ------------------------------------------------------------------

test('it writes no row of its own and reaches nothing beyond ingestion', () => {
  assert.equal(/prisma\.[a-z]/.test(RUNNER_CODE), false, 'no Prisma model delegate');
  assert.equal(
    /\.(?:create|update|upsert|delete|createMany|updateMany|deleteMany)\(\s*\{/.test(RUNNER_CODE),
    false,
    'no direct persistence call',
  );
  for (const symbol of [
    'CallGridPollService',
    'executeRecovery',
    'readCallGridInterval',
    'ProviderReconciliationService',
    'ProviderObservationService',
    'assessReadiness',
    'MeasurementSource',
    'HeadlineDetectionService',
    'ProviderPollCheckpointRepository',
    'completedThrough',
    'LIVE_ORG_SLUG',
    '$executeRaw',
    '$queryRaw',
    'CALLGRID_API_KEY',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the drain must not reference ${symbol}`);
  }
});

test('no line carries a provider identity, a phone number or a payload', async () => {
  const h = harness({ rows: [row()] });
  await run(h);
  for (const l of h.lines) {
    assert.ok(!l.includes(CALL_ID), 'a provider identity leaked');
    assert.ok(!l.includes('5125550000'), 'a caller number leaked');
    assert.ok(!l.includes('revenue'), 'a payload value leaked');
  }
  // Loop's own row id IS printed, deliberately: it is how an operator finds the
  // row again, and it is not a provider identity or a person.
  assert.ok(h.lines.some((l) => l.includes('eventId=evt_1')));
});

test('the drain needs no provider credential, because it asks no provider', () => {
  assert.equal(readEnvironment({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv).ok, true);
  const missing = readEnvironment({} as NodeJS.ProcessEnv);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.ok === false ? missing.missing : [], ['DATABASE_URL']);
});

test('the outcome vocabulary is closed', () => {
  assert.deepEqual([...DRAIN_RESULTS].sort(), [
    'DRAINED',
    'DRY_RUN_READY',
    'NOTHING_TO_DRAIN',
    'NOT_DRAINED',
    'PARTIALLY_DRAINED',
    'REFUSED',
  ]);
});

test('importing the module does not start a drain', () => {
  assert.notEqual(process.exitCode, 2);
  assert.ok(!process.exitCode);
});

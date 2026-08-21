// The canonical CallGrid REST write path — Stage 3 PR 9.
//
// WHAT THESE PROVE
//
// One property carries the weight and it is a COUNT: an incomplete provider read
// reaches ingestion ZERO times. Truncation, an exhausted 429 budget, a pagination
// fault, a provider error, a refused request and an unmappable record are each
// asserted to write nothing at all — not the pages that did come back, not "most
// of the day".
//
// The second property is that this is now the ONLY way a CallGrid REST record can
// change Loop's data. `CallGridReconciliationService` stood beside it until PR 9
// with its own duplicate lookup and its own `enrichExisting` metadata merge that
// never reached IngestionService — so a re-observation through the admin sync
// recorded no observation, wrote no provenance and converged no provider fact.
// That file is deleted, and there are source-level assertions here that neither
// it nor a replacement has grown back.
//
// WHAT THESE DELIBERATELY DO NOT PROVE
//
// What ingestion DOES with a record — receivedAt, occurredAt, firstIngestionSource,
// observedSources, lastObservedAt, strengthening, ambiguity, conflict — is proved
// against the real IngestionService in ingestion-time-semantics.test.ts,
// observation-provenance.test.ts and provider-fact-convergence-wiring.test.ts.
// Restating it here against a stand-in would prove the stand-in. What IS proved
// here is that this service reaches that path and no other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InboundEvent, IntervalReadResult } from '@emgloop/providers';

import {
  CALLGRID_POLL_OUTCOMES,
  CALLGRID_POLL_PROVIDER,
  CallGridPollService,
  POLL_OBSERVATION_SOURCE,
  identityDigest,
  mapCallGridEventType,
  pollSucceeded,
  sinceForRange,
  type CallGridIngestor,
  type CallGridIntervalReader,
} from '../src/services/callgrid-poll.service';
import type { IngestInput, IngestResult } from '../src/services/ingestion.service';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const SERVICE_FILE = readFileSync(join(SRC, 'services', 'callgrid-poll.service.ts'), 'utf8');

/** Prose removed. The "must not name" checks are about CODE, not headers. */
const codeOf = (source: string): string =>
  source
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('#');
    })
    .join('\n');

const SERVICE_CODE = codeOf(SERVICE_FILE);

const ORG = 'org-alpha';
const SINCE = new Date('2026-08-19T04:00:00.000Z');
const UNTIL = new Date('2026-08-20T04:00:00.000Z');
const KEY = 'cg_live_fixture';

const callId = (n: number) => `cmsns65v8be2d07k368ox69s${n}`;

const event = (n: number): InboundEvent => ({
  externalId: callId(n),
  rawEventType: 'COMPLETED',
  occurredAt: new Date(SINCE.getTime() + n * 60_000),
  payload: { id: callId(n), revenue: 17.5 },
  customerPhone: '+15125550000',
});

function readResult(over: Partial<IntervalReadResult> = {}): IntervalReadResult {
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
  };
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

/**
 * A Prisma double that is ALLOWED to be read and forbidden to be written.
 *
 * `statusOfEvent` is the only read this service makes of its own accord, and it
 * exists solely so a dry run can classify. Any create/update reaching this double
 * would mean the service had begun writing rows itself instead of going through
 * ingestion, so those throw rather than record.
 */
function prismaDouble(stored: Record<string, string> = {}) {
  const state = { statusReads: 0 };
  const forbid = (verb: string) => () => {
    throw new Error(`the poll service must not call prisma.integrationEvent.${verb} itself`);
  };
  const prisma = {
    integrationEvent: {
      async findFirst({ where }: { where: { externalId?: string } }) {
        state.statusReads += 1;
        const status = where.externalId ? stored[where.externalId] : undefined;
        return status ? { status } : null;
      },
      create: forbid('create'),
      update: forbid('update'),
    },
  };
  return { prisma, state };
}

interface Harness {
  service: CallGridPollService;
  ingested: string[];
  inputs: IngestInput[];
  readCalls: number;
  statusReads: number;
}

function harness(options: {
  read?: IntervalReadResult;
  answers?: Record<string, Partial<IngestResult> | 'throw'>;
  stored?: Record<string, string>;
  readThrows?: boolean;
} = {}): Harness {
  const ingested: string[] = [];
  const inputs: IngestInput[] = [];
  const counters = { readCalls: 0 };
  const { prisma, state } = prismaDouble(options.stored ?? {});

  const reader: CallGridIntervalReader = {
    async read() {
      counters.readCalls += 1;
      if (options.readThrows) throw new Error('socket hang up');
      return options.read ?? readResult();
    },
  };
  const ingestion: CallGridIngestor = {
    async ingest(input: IngestInput): Promise<IngestResult[]> {
      inputs.push(input);
      const ev = input.events[0];
      if (!ev) return [];
      const answer = options.answers?.[ev.externalId];
      if (answer === 'throw') throw new Error('database is unreachable');
      ingested.push(ev.externalId);
      return [ingestResult({ externalId: ev.externalId, ...(answer ?? {}) })];
    },
  };

  return {
    service: new CallGridPollService(prisma as never, { reader, ingestion }),
    ingested,
    inputs,
    get readCalls() {
      return counters.readCalls;
    },
    get statusReads() {
      return state.statusReads;
    },
  };
}

const run = (h: Harness, over: Record<string, unknown> = {}) =>
  h.service.execute({ organizationId: ORG, apiKey: KEY, since: SINCE, until: UNTIL, ...over });

// --- 1/7. A complete interval applies through canonical ingestion --------------

test('1/7. a COMPLETE interval applies every accepted record through IngestionService', async () => {
  const h = harness();
  const out = await run(h);
  assert.equal(out.outcome, 'APPLIED');
  assert.deepEqual(h.ingested, [callId(1), callId(2)]);
  assert.equal(out.newEvents, 2);
  assert.equal(out.notAttempted, 0);
  assert.ok(pollSucceeded(out.outcome));
});

test('10. every record is labelled API_POLL, and the label is not an input', async () => {
  const h = harness();
  await run(h);
  for (const input of h.inputs) {
    assert.equal(input.observationSource, 'API_POLL');
    assert.equal(input.provider, CALLGRID_POLL_PROVIDER);
    assert.equal(input.organizationId, ORG);
    assert.equal(input.mapEventType, mapCallGridEventType, 'the canonical REST mapper');
  }
  assert.equal(POLL_OBSERVATION_SOURCE, 'API_POLL');
  // A recovery labels its rows differently on purpose. This service cannot claim
  // that label however it is called: the constant is not reachable from the input.
  assert.ok(!SERVICE_CODE.includes('API_RECOVERY'));
  assert.ok(
    !/observationSource\s*:\s*input\./.test(SERVICE_CODE),
    'provenance is never taken from the caller',
  );
});

// --- 2. Invalid bounds write nothing -------------------------------------------

test('2. reversed, equal and over-wide bounds are refused before a provider request', async () => {
  for (const [since, until] of [
    [UNTIL, SINCE],
    [SINCE, SINCE],
    [SINCE, new Date(SINCE.getTime() + 60 * 24 * 3600_000)],
  ] as const) {
    const h = harness();
    const out = await run(h, { since, until });
    assert.equal(out.outcome, 'REFUSED');
    assert.equal(h.readCalls, 0, 'no provider request was made');
    assert.equal(h.ingested.length, 0, 'nothing was written');
    assert.ok(out.reason);
  }
});

test('2b. a missing credential is refused before a provider request', async () => {
  const h = harness();
  const out = await run(h, { apiKey: '' });
  assert.equal(out.outcome, 'REFUSED');
  assert.equal(h.readCalls, 0);
});

// --- 3/4/5. Every incomplete retrieval writes nothing ---------------------------

test('3/4/5. TRUNCATED, RATE_LIMIT_EXHAUSTED, INVALID_PAGINATION, PROVIDER_ERROR and REFUSED write nothing', async () => {
  for (const outcome of [
    'TRUNCATED',
    'RATE_LIMIT_EXHAUSTED',
    'INVALID_PAGINATION',
    'PROVIDER_ERROR',
    'REFUSED',
  ] as const) {
    const h = harness({
      read: readResult({ outcome, reason: `ended ${outcome}`, events: [event(1), event(2), event(3)], records: 3 }),
    });
    const out = await run(h);
    assert.equal(out.outcome, 'FETCH_INCOMPLETE', `${outcome} must not apply`);
    assert.equal(out.fetchOutcome, outcome);
    assert.equal(h.ingested.length, 0, `${outcome} wrote something`);
    assert.equal(h.inputs.length, 0, 'ingestion was not even called');
    assert.equal(out.newEvents, 0);
    assert.equal(out.notAttempted, 3, 'what DID come back is reported, not written');
    assert.ok(!pollSucceeded(out.outcome));
  }
});

test('3b. a reader that throws is an incomplete fetch, not a partial write', async () => {
  const h = harness({ readThrows: true });
  const out = await run(h);
  assert.equal(out.outcome, 'FETCH_INCOMPLETE');
  assert.equal(out.fetchOutcome, 'THREW');
  assert.equal(h.ingested.length, 0);
});

test('3c. completeness is judged by the shared predicate, not a local list of outcomes', () => {
  assert.ok(SERVICE_CODE.includes('intervalWasComplete('), 'the shared rule decides');
  assert.ok(
    !/outcome\s*===\s*'COMPLETE'/.test(SERVICE_CODE),
    'the service must not re-spell the completeness rule',
  );
});

// --- 6. A refused record cannot silently disappear ------------------------------

test('6. one unmappable record in a COMPLETE read aborts every write', async () => {
  const h = harness({
    read: readResult({
      events: [event(1), event(2)],
      records: 3,
      refused: [{ page: 1, reason: 'no usable identity field', kind: 'no-identity' }],
    }),
  });
  const out = await run(h);
  assert.equal(out.outcome, 'REFUSED');
  assert.equal(h.ingested.length, 0, 'accepted records were NOT written alongside a refusal');
  assert.equal(out.refusedRecords, 1);
  assert.equal(out.acceptedRecords, 2);
  assert.equal(out.notAttempted, 2);
  assert.equal(out.providerRecordsFetched, 3);
  // Named, so it cannot vanish into a count — and carrying no provider identity.
  assert.deepEqual(out.refusals, [{ page: 1, reason: 'no usable identity field', kind: 'no-identity' }]);
});

// --- 18/19. Partial apply ---------------------------------------------------------

test('18. an unexpected failure part-way through reports PARTIALLY_APPLIED', async () => {
  const h = harness({
    read: readResult({ events: [event(1), event(2), event(3)], records: 3 }),
    answers: { [callId(2)]: 'throw' },
  });
  const out = await run(h);
  assert.equal(out.outcome, 'PARTIALLY_APPLIED');
  assert.ok(!pollSucceeded(out.outcome), 'a partial apply can never report success');
  assert.equal(out.newEvents, 1, 'the first record is live');
  assert.equal(out.failedProcessing, 1);
  assert.equal(out.failedAtIndex, 1);
  assert.equal(out.notAttempted, 1, 'the third record was never attempted');
  assert.deepEqual(h.ingested, [callId(1)], 'processing STOPPED rather than continuing');
  assert.equal(out.failedIdentityDigest, identityDigest(callId(2)));
});

test('18b. a failure on the FIRST record is PROCESSING_FAILED, with nothing live', async () => {
  const h = harness({ answers: { [callId(1)]: 'throw' } });
  const out = await run(h);
  assert.equal(out.outcome, 'PROCESSING_FAILED');
  assert.equal(out.newEvents + out.duplicateObservations, 0);
});

test('18c. an ingestion result of `failed` stops the run exactly as a throw does', async () => {
  const h = harness({
    read: readResult({ events: [event(1), event(2), event(3)], records: 3 }),
    answers: { [callId(2)]: { status: 'failed', error: 'normalization blew up' } },
  });
  const out = await run(h);
  assert.equal(out.outcome, 'PARTIALLY_APPLIED');
  assert.equal(out.reason, 'normalization blew up');
});

test('19. rerunning after a partial apply converges without duplicating', async () => {
  const first = harness({
    read: readResult({ events: [event(1), event(2), event(3)], records: 3 }),
    answers: { [callId(2)]: 'throw' },
  });
  assert.equal((await run(first)).outcome, 'PARTIALLY_APPLIED');

  // The identical interval, asked again. This service holds no memory of the
  // first attempt, deliberately.
  const second = harness({
    read: readResult({ events: [event(1), event(2), event(3)], records: 3 }),
    answers: { [callId(1)]: { status: 'duplicate' } },
  });
  const after = await run(second);
  assert.equal(after.outcome, 'APPLIED');
  assert.equal(after.duplicateObservations, 1, 're-observed, not duplicated');
  assert.equal(after.newEvents, 2);
});

test('20. an identical full rerun creates nothing new and produces no revision noise', async () => {
  const h = harness({
    answers: { [callId(1)]: { status: 'duplicate' }, [callId(2)]: { status: 'duplicate' } },
  });
  const out = await run(h);
  assert.equal(out.outcome, 'APPLIED');
  assert.equal(out.newEvents, 0);
  assert.equal(out.duplicateObservations, 2);
  assert.equal(out.strengthenedCalls, 0);
  assert.equal(out.conflicts, 0);
});

test('one record per ingestion call: identities are never batched together', async () => {
  const h = harness({ read: readResult({ events: [event(1), event(2), event(3)], records: 3 }) });
  await run(h);
  assert.equal(h.inputs.length, 3);
  for (const input of h.inputs) assert.equal(input.events.length, 1);
});

// --- 15/16/17. Convergence outcomes are surfaced, not swallowed -------------------

test('15/17. a conflict is surfaced, does not stop the run, and is never a plain APPLIED', async () => {
  const h = harness({
    answers: {
      [callId(1)]: { status: 'duplicate', conflictedFacts: ['revenue'] },
      [callId(2)]: { status: 'duplicate', strengthenedFacts: ['paid'] },
    },
  });
  const out = await run(h);
  assert.equal(out.outcome, 'APPLIED_WITH_CONFLICTS');
  assert.equal(out.conflicts, 1);
  assert.equal(out.strengthenedCalls, 1);
  assert.equal(out.duplicateObservations, 2, 'the run continued past the conflict');
  assert.match(String(out.reason), /disagreed/);
  // A conflict is a business outcome. The interval WAS polled.
  assert.ok(pollSucceeded(out.outcome));
});

test('the observer streams progress without being able to change the run', async () => {
  const events = Array.from({ length: 3 }, (_, i) => event(i + 1));
  const h = harness({
    read: readResult({ events, records: 3 }),
    answers: {
      [callId(1)]: { status: 'duplicate', strengthenedFacts: ['revenue'] },
      [callId(2)]: { status: 'duplicate', conflictedFacts: ['payout'] },
    },
  });
  const strengthened: string[] = [];
  const conflicts: string[] = [];
  const out = await h.service.execute(
    { organizationId: ORG, apiKey: KEY, since: SINCE, until: UNTIL },
    {
      onStrengthened: (i) => strengthened.push(i.identityDigest),
      onConflict: (i) => conflicts.push(i.identityDigest),
    },
  );
  assert.deepEqual(strengthened, [identityDigest(callId(1))]);
  assert.deepEqual(conflicts, [identityDigest(callId(2))]);
  assert.equal(out.outcome, 'APPLIED_WITH_CONFLICTS');
  // The digest is not the identity.
  assert.ok(!strengthened[0]!.includes(callId(1)));
});

// --- Dry run ------------------------------------------------------------------------

test('a dry run reads the provider, classifies, and writes nothing', async () => {
  const h = harness({ stored: { [callId(1)]: 'PROCESSED' } });
  const out = await run(h, { dryRun: true });
  assert.equal(out.outcome, 'DRY_RUN_READY');
  assert.equal(h.readCalls, 1, 'the provider WAS read');
  assert.equal(h.ingested.length, 0, 'ingestion was never called');
  assert.equal(h.inputs.length, 0);
  assert.equal(out.duplicateObservations, 1);
  assert.equal(out.newEvents, 1);
  assert.equal(out.notAttempted, 2);
  assert.equal(h.statusReads, 2, 'one classification read per accepted record');
});

test('a dry run refuses to predict what it cannot know, out loud', async () => {
  const h = harness();
  const out = await run(h, { dryRun: true });
  assert.match(String(out.reason), /NOT predicted/);
  assert.match(String(out.reason), /organization-scoped/);
});

test('a dry run classifies with the SAME predicate ingestion branches on', async () => {
  // RECEIVED and FAILED rows are retryable and are NOT duplicates. A dry run that
  // spelled `status !== null` would call them duplicates and describe a run that
  // does not exist.
  const h = harness({ stored: { [callId(1)]: 'FAILED', [callId(2)]: 'RECEIVED' } });
  const out = await run(h, { dryRun: true });
  assert.equal(out.newEvents, 2);
  assert.equal(out.duplicateObservations, 0);
  assert.ok(SERVICE_CODE.includes('isDuplicateObservation('));
  assert.ok(!/===\s*'PROCESSED'/.test(SERVICE_CODE), 'the status literal is not re-spelled here');
});

test('a dry run over an incomplete read still writes nothing and still says so', async () => {
  const h = harness({ read: readResult({ outcome: 'TRUNCATED' }) });
  const out = await run(h, { dryRun: true });
  assert.equal(out.outcome, 'FETCH_INCOMPLETE');
  assert.equal(h.ingested.length, 0);
});

// --- 21. No implicit now inside the primitive ----------------------------------------

test('21. the primitive contains no clock, and resolves no convenience range', () => {
  // `sinceForRange` lives in this file for the route to call, and `execute` must
  // never call it: a primitive that can resolve its own upper bound is one a
  // scheduler can ask for "the last seven days" without saying what that means.
  const execute = SERVICE_CODE.slice(SERVICE_CODE.indexOf('  async execute('));
  for (const symbol of ['new Date(', 'Date.now(', 'sinceForRange', 'easternBusinessDayWindow']) {
    assert.ok(!execute.includes(symbol), `execute() must not use ${symbol}`);
  }
});

test('the convenience ranges still resolve, at the edge, from a supplied clock', () => {
  const now = new Date('2026-08-19T18:00:00.000Z');
  assert.equal(sinceForRange('24h', now).toISOString(), '2026-08-18T18:00:00.000Z');
  assert.equal(sinceForRange('7d', now).toISOString(), '2026-08-12T18:00:00.000Z');
  assert.ok(sinceForRange('today', now).getTime() <= now.getTime());
});

// --- 8/9/22/23. The parallel path is gone -----------------------------------------------

test('9/23. enrichExisting and the service that owned it no longer exist anywhere', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(SRC);
  for (const file of files) {
    const code = codeOf(readFileSync(file, 'utf8'));
    assert.ok(!code.includes('enrichExisting'), `${file} still references enrichExisting`);
    assert.ok(
      !code.includes('CallGridReconciliationService'),
      `${file} still references CallGridReconciliationService`,
    );
  }
  assert.ok(
    !files.some((f) => f.endsWith('callgrid-reconciliation.service.ts')),
    'the old service file is deleted, not deprecated',
  );
});

test('8/23. this service writes rows only through ingestion, never itself', () => {
  // Everything that touches a row goes through the ingestion seam. The only Prisma
  // access is the dry run's classification read, which is behind a repository.
  assert.equal(/prisma\.[a-z]/.test(SERVICE_CODE), false, 'no Prisma model delegate');
  assert.equal(
    /\.(?:create|update|upsert|delete|createMany|updateMany|deleteMany)\(\s*\{/.test(SERVICE_CODE),
    false,
    'no direct persistence call',
  );
  for (const verb of ['$executeRaw', '$queryRaw', '$transaction', 'marketplaceCall', 'interaction.']) {
    assert.ok(!SERVICE_CODE.includes(verb), `the service must not reference ${verb}`);
  }
  assert.ok(SERVICE_CODE.includes('this.ingestion.ingest('), 'ingestion is invoked, not reimplemented');
});

test('the default dependencies are the canonical ones, so production injects nothing', () => {
  assert.ok(SERVICE_CODE.includes('deps.ingestion ?? new IngestionService(prisma)'));
  assert.ok(SERVICE_CODE.includes('deps.reader ?? callGridIntervalReader()'));
  assert.ok(SERVICE_CODE.includes('readCallGridInterval('), 'the canonical reader backs the default');
});

test('12. exactly one CallGrid REST write execution primitive exists in the package', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(SRC);
  const readers = files.filter((f) => codeOf(readFileSync(f, 'utf8')).includes('readCallGridInterval('));
  assert.deepEqual(
    readers.map((f) => f.slice(SRC.length + 1)),
    ['services/callgrid-poll.service.ts'],
    'only the canonical primitive reads a CallGrid interval',
  );
  // `poll()` still exists on the adapter and is used by CERTIFICATION and
  // RECONCILIATION, which read and never write. Those are not write paths and are
  // deliberately untouched by this PR.
  const ingestors = files.filter((f) => {
    const code = codeOf(readFileSync(f, 'utf8'));
    return code.includes('.ingest(') && code.includes('callgrid');
  });
  assert.deepEqual(
    ingestors.map((f) => f.slice(SRC.length + 1)),
    ['services/callgrid-poll.service.ts'],
    'only the canonical primitive ingests CallGrid REST records',
  );
});

// --- 24/25/26/27/28/29. Nothing else moved ---------------------------------------------

test('24-29. no verdict, readiness, measurement, checkpoint, schedule or recovery here', () => {
  for (const symbol of [
    'ProviderReconciliationService',
    'reconcileDay',
    'assessReconciliation',
    'assessReadiness',
    'MeasurementSource',
    'MeasureSourceAuthority',
    'ObjectiveMeasureBinding',
    'HeadlineDetectionService',
    'MemberExpectation',
    'ProviderObservationService',
    'certifyDay',
    'checkpoint',
    'watermark',
    'highWater',
    'lastPolled',
    'cron',
    'schedule',
    'setInterval',
    'API_RECOVERY',
    'LIVE_ORG_SLUG',
  ]) {
    assert.ok(!SERVICE_CODE.includes(symbol), `the service must not reference ${symbol}`);
  }
});

test('the outcome vocabulary is closed and lives in one place', () => {
  assert.deepEqual([...CALLGRID_POLL_OUTCOMES].sort(), [
    'APPLIED',
    'APPLIED_WITH_CONFLICTS',
    'DRY_RUN_READY',
    'FETCH_INCOMPLETE',
    'PARTIALLY_APPLIED',
    'PROCESSING_FAILED',
    'REFUSED',
  ]);
  for (const outcome of CALLGRID_POLL_OUTCOMES) {
    assert.equal(
      pollSucceeded(outcome),
      outcome === 'APPLIED' || outcome === 'APPLIED_WITH_CONFLICTS' || outcome === 'DRY_RUN_READY',
    );
  }
});

test('the REST event-type mapper survived the deletion unchanged', () => {
  // It was called mapReconEventType and was never specific to reconciliation.
  assert.equal(mapCallGridEventType('COMPLETED'), 'call.completed');
  assert.equal(mapCallGridEventType('BUSY'), 'call.missed');
  assert.equal(mapCallGridEventType('CONNECTED'), 'call.answered');
  assert.equal(mapCallGridEventType('voicemail'), 'call.voicemail');
  // An unrecognised or empty status is NEVER promoted to completed.
  assert.equal(mapCallGridEventType('unknown'), 'call.inbound');
  assert.equal(mapCallGridEventType(''), 'call.inbound');
  assert.equal(mapCallGridEventType('something-new'), 'call.inbound');
});

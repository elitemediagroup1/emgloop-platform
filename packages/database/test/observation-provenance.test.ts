// Observation provenance — Stage 3 CallGrid PR 4.
//
// ONE CANONICAL CALL, MANY OBSERVATIONS.
//
// A CallGrid call has one identity and one row. It may be observed several
// times: the webhook delivers it live, a poller re-reads the window it falls in,
// and a recovery operation may fetch it deliberately weeks later. Those are
// three observations of one fact — not three calls, not three rows, and not one
// fact overwritten twice.
//
// The property that made this PR necessary is the one at the bottom of this
// file: before it, observing an already-PROCESSED event wrote NOTHING. Asking
// the provider again and being answered left no trace anywhere — which is
// precisely the fact a poller exists to produce.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OBSERVATION_SOURCES, isObservationSource, withObservation } from '@emgloop/shared';
import { IngestionService } from '../src/services/ingestion.service';

const SERVICE_FILE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'ingestion.service.ts'),
  'utf8',
);
const SERVICE_SOURCE = SERVICE_FILE.split('\n')
  .filter((l) => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

const ORG = 'org-alpha';
const CALL_ID = 'cmsns65v8be2d07k368ox69s9';
const OCCURRED = new Date('2026-08-11T18:30:00.000Z');
const FIRST_RECEIPT = new Date('2026-08-11T18:30:05.000Z');

type Row = Record<string, unknown>;

/**
 * A Prisma double over integration_events, holding one row.
 *
 * The pipeline past the first write throws (no customer delegate), so a fresh
 * ingest ends FAILED. That is the production shape observed on 2026-08-10, and
 * it is also what makes the re-observation cases below reachable: a FAILED row
 * is re-ingested, a PROCESSED row is not.
 */
function prismaDouble(existing?: Row) {
  const state: { row: Row | null; writes: Array<{ kind: 'create' | 'update'; data: Row }> } = {
    row: existing ?? null,
    writes: [],
  };
  const prisma = {
    integrationEvent: {
      async findFirst() {
        return state.row;
      },
      async create({ data }: { data: Row }) {
        state.writes.push({ kind: 'create', data });
        state.row = { id: 'evt_1', receivedAt: new Date('2026-08-25T14:00:00.000Z'), ...data };
        return state.row;
      },
      async update({ data }: { data: Row }) {
        state.writes.push({ kind: 'update', data });
        state.row = { ...(state.row ?? {}), ...data };
        return state.row;
      },
    },
  };
  return { prisma, state };
}

const event = () => ({
  externalId: CALL_ID,
  rawEventType: 'completed',
  occurredAt: OCCURRED,
  payload: { id: CALL_ID, occurredAtUnix: '1786386600' },
});

async function observe(prisma: unknown, observationSource: string) {
  return new IngestionService(prisma as never).ingest({
    organizationId: ORG,
    provider: 'callgrid',
    providerConnectionId: null,
    mapEventType: (raw: string) => `call.${raw}`,
    events: [event()],
    observationSource,
  } as never);
}

/** A row already processed from a live webhook, as production holds it. */
const processedFromWebhook = (over: Row = {}): Row => ({
  id: 'evt_existing',
  status: 'PROCESSED',
  externalId: CALL_ID,
  provider: 'callgrid',
  payload: { id: CALL_ID, original: true },
  receivedAt: FIRST_RECEIPT,
  occurredAt: OCCURRED,
  firstIngestionSource: 'WEBHOOK',
  observedSources: ['WEBHOOK'],
  lastObservedAt: FIRST_RECEIPT,
  ...over,
});

// --- The vocabulary ------------------------------------------------------------------

test('the observation vocabulary is closed, and fails closed', () => {
  assert.deepEqual([...OBSERVATION_SOURCES], ['WEBHOOK', 'API_POLL', 'API_RECOVERY']);
  assert.equal(isObservationSource('API_RECOVERY'), true);
  assert.equal(isObservationSource('api_recovery'), false, 'no case coercion');
  assert.equal(isObservationSource('SYNC'), false);
  assert.equal(isObservationSource(undefined), false);
});

test('the observation SET is a set, keeps first-seen order, and drops nothing', () => {
  assert.deepEqual(withObservation([], 'WEBHOOK'), ['WEBHOOK']);
  assert.deepEqual(withObservation(['WEBHOOK'], 'API_POLL'), ['WEBHOOK', 'API_POLL']);
  assert.deepEqual(withObservation(['WEBHOOK', 'API_POLL'], 'WEBHOOK'), ['WEBHOOK', 'API_POLL']);
  // A value written by a build with a wider vocabulary is KEPT — discarding it
  // would make a real observation look like one that never happened.
  assert.deepEqual(withObservation(['SOMETHING_NEW'], 'API_POLL'), ['SOMETHING_NEW', 'API_POLL']);
});

// --- 1, 7: first observation ----------------------------------------------------------

test('1/7. WEBHOOK first creates ONE canonical event and records how it arrived', async () => {
  const { prisma, state } = prismaDouble();
  await observe(prisma, 'WEBHOOK');
  const creates = state.writes.filter((w) => w.kind === 'create');
  assert.equal(creates.length, 1, 'exactly one canonical event');
  assert.equal(creates[0]!.data.firstIngestionSource, 'WEBHOOK');
  assert.deepEqual(creates[0]!.data.observedSources, ['WEBHOOK']);
  assert.ok(creates[0]!.data.lastObservedAt instanceof Date);
  assert.ok(!('receivedAt' in creates[0]!.data), 'first receipt still comes from the database');
});

// --- 2, 3, 4, 5, 6, 8, 10, 11: re-observation ------------------------------------------

test('2/4/5/8. API_POLL after WEBHOOK creates no second event and keeps both facts', async () => {
  const { prisma, state } = prismaDouble(processedFromWebhook());
  const [result] = await observe(prisma, 'API_POLL');

  assert.equal(result?.status, 'duplicate', 'the same call, not a new one');
  assert.equal(state.writes.filter((w) => w.kind === 'create').length, 0);

  const row = state.row!;
  assert.equal(row.firstIngestionSource, 'WEBHOOK', 'how it FIRST arrived is not rewritten');
  assert.deepEqual(row.observedSources, ['WEBHOOK', 'API_POLL'], 'and the later visit is kept');
  assert.equal((row.receivedAt as Date).toISOString(), FIRST_RECEIPT.toISOString(), 'first receipt');
  assert.equal((row.occurredAt as Date).toISOString(), OCCURRED.toISOString(), 'provider occurrence');
});

test('3. API_POLL first then WEBHOOK also creates no second event', async () => {
  const { prisma, state } = prismaDouble(
    processedFromWebhook({ firstIngestionSource: 'API_POLL', observedSources: ['API_POLL'] }),
  );
  const [result] = await observe(prisma, 'WEBHOOK');
  assert.equal(result?.status, 'duplicate');
  assert.equal(state.writes.filter((w) => w.kind === 'create').length, 0);
  assert.equal(state.row!.firstIngestionSource, 'API_POLL', 'the poller got there first, and it says so');
  assert.deepEqual(state.row!.observedSources, ['API_POLL', 'WEBHOOK']);
});

test('6. lastObservedAt ADVANCES while receivedAt does not', async () => {
  const { prisma, state } = prismaDouble(processedFromWebhook());
  await observe(prisma, 'API_POLL');
  const advanced = state.row!.lastObservedAt as Date;
  assert.ok(advanced.getTime() > FIRST_RECEIPT.getTime(), 'the later look is recorded');
  assert.equal((state.row!.receivedAt as Date).toISOString(), FIRST_RECEIPT.toISOString());
  // And it is not a modification time: nothing here claims the provider's answer
  // changed, only that it was asked again.
  assert.ok(!SERVICE_SOURCE.includes('modifiedAt'));
  assert.ok(!SERVICE_SOURCE.includes('updatedAt'));
});

test('10. repeated observation on the SAME path is idempotent in identity and in the set', async () => {
  const { prisma, state } = prismaDouble(processedFromWebhook());
  await observe(prisma, 'WEBHOOK');
  await observe(prisma, 'WEBHOOK');
  await observe(prisma, 'WEBHOOK');
  assert.equal(state.writes.filter((w) => w.kind === 'create').length, 0);
  assert.deepEqual(state.row!.observedSources, ['WEBHOOK'], 'the set does not grow');
  assert.equal(state.row!.firstIngestionSource, 'WEBHOOK');
});

test('9. API_RECOVERY is representable and distinct — without any recovery happening', async () => {
  const { prisma, state } = prismaDouble(processedFromWebhook());
  await observe(prisma, 'API_RECOVERY');
  assert.deepEqual(state.row!.observedSources, ['WEBHOOK', 'API_RECOVERY']);
  assert.notEqual(state.row!.observedSources, ['WEBHOOK', 'API_POLL']);
  // A row that only ever existed because somebody went looking says so from
  // the moment it is written.
  const fresh = prismaDouble();
  await observe(fresh.prisma, 'API_RECOVERY');
  assert.equal(fresh.state.row!.firstIngestionSource, 'API_RECOVERY');
});

// --- 11, 12: what re-observation must NOT do -------------------------------------------

test('11/12. THE PAYLOAD IS NOT REPLACED, so no projection is orphaned and no fact is flipped', async () => {
  // The payload on a PROCESSED row is the evidence that produced its Interaction
  // and MarketplaceCall. Overwriting it on a later look would separate a
  // projection from its source — and would silently import whatever the provider
  // says today, including a postback-pending zero, as though it were the fact
  // that call was projected from. Deciding whether a later answer REPLACES an
  // earlier one is a merge policy, and it is not this PR.
  const { prisma, state } = prismaDouble(processedFromWebhook());
  await observe(prisma, 'API_POLL');

  assert.deepEqual(state.row!.payload, { id: CALL_ID, original: true }, 'the original evidence stands');
  assert.equal(state.row!.status, 'PROCESSED', 'and the row is not reopened');
  const update = state.writes.find((w) => w.kind === 'update')!.data;
  assert.deepEqual(
    Object.keys(update).sort(),
    ['lastObservedAt', 'observedSources'],
    'ONLY the observation is written',
  );
});

test('12b. an unknown provider fact is never converted to false by an observation', async () => {
  const { prisma, state } = prismaDouble(
    processedFromWebhook({ payload: { id: CALL_ID, converted: null, billable: null } }),
  );
  await observe(prisma, 'API_POLL');
  const payload = state.row!.payload as Record<string, unknown>;
  assert.equal(payload.converted, null, 'unknown stays unknown');
  assert.equal(payload.billable, null);
});

// --- FAILED rows -----------------------------------------------------------------------

test('a FAILED row is still re-ingested, and the observation is recorded with it', async () => {
  // FAILED is the one status where a later observation legitimately reprocesses:
  // the row exists, nothing was projected from it, and the provider is offering
  // the payload again. This is the repair path the 2026-08-10 status=failed
  // events need — and it already worked; what is new is that it now says who
  // asked.
  const { prisma, state } = prismaDouble(
    processedFromWebhook({ status: 'FAILED', observedSources: ['WEBHOOK'] }),
  );
  await observe(prisma, 'API_POLL');
  const update = state.writes.find((w) => w.kind === 'update')!.data;
  assert.equal(update.status, 'RECEIVED', 'reopened for reprocessing');
  assert.ok('payload' in update, 'the fresh payload IS taken on a row nothing was built from');
  assert.deepEqual(update.observedSources, ['WEBHOOK', 'API_POLL']);
  assert.ok(!('receivedAt' in update), 'first receipt untouched');
  assert.ok(!('firstIngestionSource' in update), 'first transport untouched');
});

// --- 13, 14: nothing else moved ---------------------------------------------------------

test('13/14. no poller, scheduler, checkpoint, reconciliation or measurement is introduced', () => {
  for (const symbol of [
    'watermark',
    'checkpoint',
    'setInterval',
    'cron',
    'fetchAllCallGridCalls',
    'getCallGridProvider',
    'reconcileDay',
    'ProviderReconciliationService',
    'certifyDay',
    'assessReadiness',
    'measureChange',
    'Headline',
    'SourceOutcomeDay',
    'declareAuthority',
    'since',
    'until',
  ]) {
    assert.ok(!SERVICE_SOURCE.includes(symbol), `ingestion must not reference ${symbol}`);
  }
});

test('the observation source is REQUIRED, so no caller can silently mislabel a row', () => {
  // An optional field would default to something, and every default is wrong for
  // somebody: WEBHOOK would relabel a recovery as live traffic, API_POLL would
  // relabel the live webhook.
  assert.ok(SERVICE_SOURCE.includes('observationSource: ObservationSource'));
  assert.ok(!/observationSource\?:/.test(SERVICE_SOURCE), 'not optional on the ingest input');
  assert.ok(!/observationSource[^:]*=\s*'/.test(SERVICE_SOURCE), 'and never defaulted');
});

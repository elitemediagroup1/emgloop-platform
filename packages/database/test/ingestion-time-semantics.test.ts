// Time semantics at the ingestion boundary — Stage 3 CallGrid PR 3.
//
// TWO CLOCKS, TWO MEANINGS, AND THEY MUST NOT BE INTERCHANGEABLE.
//
//   receivedAt   when LOOP first durably received this delivery. Loop time.
//   occurredAt   when the PROVIDER says the call happened. Provider time.
//
// A call that occurred on 2026-08-11 and was first recovered on 2026-08-25 has
// to be able to state BOTH facts at once. Before this PR the row could hold
// only one of them, and the two ways of forcing it were both lies: rewriting
// receivedAt to the historical instant makes the August outage retroactively
// invisible, and leaving occurrence in the payload alone makes a recovered call
// invisible to reconciliation forever.
//
// THESE TESTS DRIVE THE REAL `IngestionService` against a Prisma double that
// implements only the delegate the time contract touches. Everything past the
// first write throws, so each run ends as a FAILED event — which is not a
// limitation of the harness but the exact production shape observed on
// 2026-08-10 at 22:06:14Z, where Loop returned HTTP 200 with status "failed"
// and no interaction. The raw event was durably written first, and that is the
// property being pinned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IngestionService } from '../src/services/ingestion.service';

const SERVICE_FILE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'ingestion.service.ts'),
  'utf8',
);

/**
 * The service with its prose removed.
 *
 * The structural checks below are about CODE. The write sites carry comments
 * that NAME `receivedAt` precisely to explain that it is never set, and a scan
 * over the prose would fail the very test that proves the code is clean.
 */
const SERVICE_SOURCE = SERVICE_FILE.split('\n')
  .filter((l) => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

const ORG = 'org-alpha';
const OCCURRED = new Date('2026-08-11T18:30:00.000Z');
const CALL_ID = 'cmsns65v8be2d07k368ox69s9';

interface Recorded {
  creates: Array<Record<string, unknown>>;
  updates: Array<{ where: unknown; data: Record<string, unknown> }>;
  rows: Array<Record<string, unknown>>;
}

/**
 * A Prisma double covering integration_events and nothing else.
 *
 * Everything downstream is absent on purpose: this file is about what reaches
 * the row, not about the pipeline that runs afterwards.
 */
function prismaDouble(existing?: Record<string, unknown>): { prisma: unknown; recorded: Recorded } {
  const recorded: Recorded = { creates: [], updates: [], rows: existing ? [existing] : [] };
  let seq = 0;
  const prisma = {
    integrationEvent: {
      async findFirst() {
        return recorded.rows[0] ?? null;
      },
      async create({ data }: { data: Record<string, unknown> }) {
        recorded.creates.push(data);
        seq += 1;
        // The database supplies receivedAt from its own default. The row the
        // caller gets back therefore carries a Loop-time receipt the caller
        // never named — which is the whole point of not setting it.
        const row = { id: `evt_${seq}`, receivedAt: new Date('2026-08-25T14:00:00.000Z'), ...data };
        recorded.rows[0] = row;
        return row;
      },
      async update({ where, data }: { where: unknown; data: Record<string, unknown> }) {
        recorded.updates.push({ where, data });
        recorded.rows[0] = { ...(recorded.rows[0] ?? {}), ...data };
        return recorded.rows[0];
      },
    },
  };
  return { prisma, recorded };
}

const callEvent = (over: Record<string, unknown> = {}) => ({
  externalId: CALL_ID,
  rawEventType: 'completed',
  occurredAt: OCCURRED,
  payload: { id: CALL_ID, occurredAtUnix: '1786386600', campaignId: 'cmp-1' },
  ...over,
});

async function ingestOnce(
  prisma: unknown,
  provider = 'callgrid',
  event: ReturnType<typeof callEvent> = callEvent(),
) {
  const service = new IngestionService(prisma as never);
  return service.ingest({
    organizationId: ORG,
    provider,
    providerConnectionId: null,
    mapEventType: (raw: string) => `call.${raw}`,
    events: [event],
    observationSource: 'WEBHOOK',
  } as never);
}

// --- 1, 2, 3, 7: the occurrence that is written is the provider's ------------------

test('1/2. the provider occurrence the ADAPTER resolved is what persists', async () => {
  const { prisma, recorded } = prismaDouble();
  await ingestOnce(prisma);
  assert.equal(recorded.creates.length, 1);
  assert.equal(recorded.creates[0]!.occurredAt, OCCURRED, 'the adapter\'s Date, unchanged');
});

test('2b. a REST event and a webhook event carrying the same instant persist the same instant', async () => {
  // The two paths resolve occurrence through one canonical resolver and hand
  // the answer to one ingestion service. Convergence is structural, not a
  // coincidence of two mappers agreeing.
  const webhook = prismaDouble();
  await ingestOnce(webhook.prisma, 'callgrid', callEvent({ payload: { id: CALL_ID, occurredAtUnix: '1786386600' } }));
  const rest = prismaDouble();
  await ingestOnce(rest.prisma, 'callgrid', callEvent({ payload: { id: CALL_ID, UTCUnixTimeMs: 1786386600000 } }));
  assert.deepEqual(webhook.recorded.creates[0]!.occurredAt, rest.recorded.creates[0]!.occurredAt);
});

test('3/7. receivedAt is NEVER written, so it can never be substituted for occurredAt', async () => {
  const { prisma, recorded } = prismaDouble();
  await ingestOnce(prisma);
  assert.ok(!('receivedAt' in recorded.creates[0]!), 'the create must not name receivedAt');
  // Structural, not just this run: the service names the column nowhere.
  assert.ok(!SERVICE_SOURCE.includes('receivedAt'), 'ingestion must never write receivedAt');
  // And no occurrence is fabricated from a clock.
  assert.ok(!/occurredAt:\s*new Date\(\)/.test(SERVICE_SOURCE));
  assert.ok(!/occurredAt:\s*now/.test(SERVICE_SOURCE));
});

test('7b. persistence does not RE-RESOLVE occurrence — it carries the adapter\'s answer', async () => {
  // A second resolution in the persistence layer would eventually disagree with
  // the first about the same row.
  assert.ok(!SERVICE_SOURCE.includes('resolveCallOccurrence'));
  assert.ok(SERVICE_SOURCE.includes('occurredAt: ev.occurredAt'));
});

// --- 4: the two facts at once, which is the point of the column --------------------

test('4. A HISTORICAL CALL HOLDS BOTH TRUTHS: occurred Aug 11, received Aug 25', async () => {
  const { prisma, recorded } = prismaDouble();
  await ingestOnce(prisma);
  const row = recorded.rows[0]!;
  assert.equal((row.occurredAt as Date).toISOString(), '2026-08-11T18:30:00.000Z', 'provider time');
  assert.equal((row.receivedAt as Date).toISOString(), '2026-08-25T14:00:00.000Z', 'Loop time');
  assert.notEqual(
    (row.occurredAt as Date).getTime(),
    (row.receivedAt as Date).getTime(),
    'a recovery fourteen days later must not collapse the two',
  );
});

// --- 5: re-observation never rewrites first receipt --------------------------------

test('5. re-observing an existing identity does not rewrite first receivedAt', async () => {
  const alreadyHeld = {
    id: 'evt_existing',
    status: 'FAILED',
    externalId: CALL_ID,
    receivedAt: new Date('2026-08-11T18:30:05.000Z'),
    occurredAt: null,
  };
  const { prisma, recorded } = prismaDouble(alreadyHeld);
  await ingestOnce(prisma);

  assert.equal(recorded.creates.length, 0, 'the existing row is reused, never duplicated');
  assert.ok(recorded.updates.length > 0);
  const firstUpdate = recorded.updates[0]!.data;
  assert.ok(!('receivedAt' in firstUpdate), 'first receipt is not touched');
  assert.equal(
    (recorded.rows[0]!.receivedAt as Date).toISOString(),
    '2026-08-11T18:30:05.000Z',
    'the original receipt survives the re-observation',
  );
  // The payload is rewritten in that same statement, so the occurrence derived
  // from it is written with it — a row whose payload says August 11 while its
  // occurredAt says nothing would be internally inconsistent.
  assert.equal(firstUpdate.occurredAt, OCCURRED);
});

// --- 6, 9: fail-closed and non-CallGrid compatibility ------------------------------

test('6. an unresolvable provider occurrence still fails closed in the adapter, not here', async () => {
  // The parser and the mapper each refuse a record with no usable occurrence
  // before an InboundEvent exists, so persistence never sees one. This asserts
  // the division of labour rather than duplicating the refusal.
  const { CallGridProvider } = await import('@emgloop/providers');
  await assert.rejects(
    () => new CallGridProvider().parseWebhook({ organizationId: ORG }, { id: CALL_ID }),
    /occurrence timestamp/,
  );
  assert.ok(!SERVICE_SOURCE.includes('no usable occurrence'), 'the refusal lives in the adapter');
});

test('9. a non-CallGrid provider ingests unchanged, and its occurrence persists too', async () => {
  const { prisma, recorded } = prismaDouble();
  const websiteEvent = callEvent({
    externalId: 'web-session-1',
    rawEventType: 'session',
    payload: { sessionId: 'web-session-1' },
  });
  await ingestOnce(prisma, 'website', websiteEvent);
  assert.equal(recorded.creates.length, 1);
  assert.equal(recorded.creates[0]!.provider, 'website');
  assert.equal(recorded.creates[0]!.occurredAt, OCCURRED, 'the column is provider-neutral');
  assert.ok(!('receivedAt' in recorded.creates[0]!));
});

// --- 10-14: nothing else moved -------------------------------------------------------

test('10-14. no measurement, recovery, poller, schedule or provider write is introduced', () => {
  // `lastObservedAt` and the observation-source vocabulary WERE forbidden here
  // when this file shipped and are now expected: PR 4 introduced them
  // deliberately, as the deferral this test recorded said it would. `recoveredAt`
  // is still deferred and still forbidden — provenance answers "was this
  // recovered" and receivedAt already answers "when".
  for (const symbol of [
    'measureChange',
    'assessReadiness',
    'Headline',
    'SourceOutcomeDay',
    'declareAuthority',
    'declare(',
    'certifyDay',
    'reconcileDay',
    'watermark',
    'checkpoint',
    'setInterval',
    'cron',
    'recoveredAt',
    'fetchAllCallGridCalls',
    'getCallGridProvider',
  ]) {
    assert.ok(!SERVICE_SOURCE.includes(symbol), `ingestion must not reference ${symbol}`);
  }
});

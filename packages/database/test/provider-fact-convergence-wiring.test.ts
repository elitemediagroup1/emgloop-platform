// Mutable provider fact convergence, wired — Stage 3 CallGrid PR 5.
//
// The RULE is proved purely in `packages/shared/test/provider-fact-convergence.test.ts`,
// case by case, against every way of losing money. These prove the WIRING: that
// a re-observed PROCESSED call reaches that rule, that only what the rule
// approved is written, that a conflict writes nothing to the call, and that
// everything PRs #178-#181 established is still standing afterwards.
//
// The property worth stating twice: a later observation may be MORE CURRENT
// without being MORE AUTHORITATIVE. A postback-pending zero is newer than a
// settled $17 and must not replace it.

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

type Facts = {
  revenueCents: number | null;
  payoutCents: number | null;
  billable: boolean | null;
  paid: boolean | null;
  converted: boolean | null;
};

const UNKNOWN_FACTS: Facts = {
  revenueCents: null,
  payoutCents: null,
  billable: null,
  paid: null,
  converted: null,
};

/** The event row as production holds it after a successful webhook ingestion. */
const processedRow = () => ({
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
});

function harness(storedFacts: Facts | null) {
  const state = {
    event: processedRow() as Record<string, unknown>,
    call: storedFacts ? { id: 'call_1', ...storedFacts } : null,
    callUpdates: [] as Array<Record<string, unknown>>,
    revisions: [] as Array<Record<string, unknown>>,
    eventUpdates: [] as Array<Record<string, unknown>>,
  };
  const prisma = {
    integrationEvent: {
      async findFirst() {
        return state.event;
      },
      async update({ data }: { data: Record<string, unknown> }) {
        state.eventUpdates.push(data);
        state.event = { ...state.event, ...data };
        return state.event;
      },
    },
    marketplaceCall: {
      async findFirst({ select }: { select?: Record<string, boolean> }) {
        if (!state.call) return null;
        if (select && 'id' in select && Object.keys(select).length === 1) return { id: state.call.id };
        return state.call;
      },
      async update({ data }: { data: Record<string, unknown> }) {
        state.callUpdates.push(data);
        state.call = { ...(state.call as Record<string, unknown>), ...data } as never;
        return state.call;
      },
    },
    providerFactRevision: {
      async create({ data }: { data: Record<string, unknown> }) {
        state.revisions.push(data);
        return { id: `rev_${state.revisions.length}` };
      },
    },
  };
  return { prisma, state };
}

async function observe(prisma: unknown, payload: Record<string, unknown>, source = 'API_POLL') {
  return new IngestionService(prisma as never).ingest({
    organizationId: ORG,
    provider: 'callgrid',
    providerConnectionId: null,
    mapEventType: (raw: string) => `call.${raw}`,
    events: [{ externalId: CALL_ID, rawEventType: 'completed', occurredAt: OCCURRED, payload }],
    observationSource: source,
  } as never);
}

const revisionFor = (state: { revisions: Array<Record<string, unknown>> }, fact: string) =>
  state.revisions.find((r) => r.fact === fact);

// --- 1: strengthening ---------------------------------------------------------------

test('1. webhook UNKNOWN strengthened by a REST positive, and recorded', async () => {
  const { prisma, state } = harness({ ...UNKNOWN_FACTS });
  await observe(prisma, { id: CALL_ID, revenue: 17, billable: true });

  assert.equal(state.callUpdates.length, 1, 'one narrow write');
  assert.deepEqual(state.callUpdates[0], { revenueCents: 1700, billable: true });

  const revenue = revisionFor(state, 'revenue')!;
  assert.equal(revenue.decision, 'UPDATE');
  assert.equal(revenue.fromValue, null, 'it was unknown');
  assert.equal(revenue.toValue, '1700');
  assert.equal(revenue.observationSource, 'API_POLL', 'which path supplied it');
  assert.ok(revenue.appliedAt, 'the canonical value moved');
  assert.ok(revenue.integrationEventId, 'and the raw delivery behind it is reachable');
});

// --- 2, 3: known truth survives ambiguity ---------------------------------------------

test('2. A SETTLED $17 SURVIVES A LATER POSTBACK-PENDING ZERO', async () => {
  const { prisma, state } = harness({ ...UNKNOWN_FACTS, revenueCents: 1700, billable: true });
  await observe(prisma, { id: CALL_ID, revenue: 0, billable: false });

  assert.equal(state.callUpdates.length, 0, 'nothing is written to the call');
  assert.equal((state.call as Record<string, unknown>).revenueCents, 1700);
  assert.equal((state.call as Record<string, unknown>).billable, true);
  assert.equal(state.revisions.length, 0, 'and nothing happened, so nothing is recorded');
});

test('3/4. an unknown fact does not become a decided NO from postback ambiguity', async () => {
  const { prisma, state } = harness({ ...UNKNOWN_FACTS });
  await observe(prisma, { id: CALL_ID, revenue: 0, billable: false, converted: false });
  assert.equal(state.callUpdates.length, 0);
  assert.equal((state.call as Record<string, unknown>).revenueCents, null, 'still unknown, not zero');
  assert.equal((state.call as Record<string, unknown>).billable, null, 'still unknown, not false');
});

// --- 5, 6: a real final zero stays representable ----------------------------------------

test('5/6. a genuine final zero and false are untouched, and still strengthenable', async () => {
  const settledZero = harness({ ...UNKNOWN_FACTS, revenueCents: 0, billable: false });
  await observe(settledZero.prisma, { id: CALL_ID, revenue: 0, billable: false });
  assert.equal(settledZero.state.callUpdates.length, 0, 'left exactly as stored');
  assert.equal((settledZero.state.call as Record<string, unknown>).revenueCents, 0);

  const settles = harness({ ...UNKNOWN_FACTS, revenueCents: 0 });
  await observe(settles.prisma, { id: CALL_ID, revenue: 25 });
  assert.deepEqual(settles.state.callUpdates[0], { revenueCents: 2500 }, 'the postback lands');
  assert.match(String(revisionFor(settles.state, 'revenue')!.reason), /settled a pending zero/);
});

// --- 7, 8: silence -----------------------------------------------------------------------

test('7. a fact the observation OMITS never clears the stored one', async () => {
  const { prisma, state } = harness({ ...UNKNOWN_FACTS, revenueCents: 1700, converted: true });
  await observe(prisma, { id: CALL_ID });
  assert.equal(state.callUpdates.length, 0);
  assert.equal((state.call as Record<string, unknown>).revenueCents, 1700);
  assert.equal((state.call as Record<string, unknown>).converted, true);
});

test('8. an identical observation produces no fact write and no revision', async () => {
  const { prisma, state } = harness({ ...UNKNOWN_FACTS, revenueCents: 1700, billable: true });
  await observe(prisma, { id: CALL_ID, revenue: 17, billable: true });
  assert.equal(state.callUpdates.length, 0);
  assert.equal(state.revisions.length, 0);
});

// --- 9: THE CONFLICT ----------------------------------------------------------------------

test('9. TWO SETTLED AMOUNTS THAT DISAGREE ARE A CONFLICT — neither silently wins', async () => {
  const { prisma, state } = harness({ ...UNKNOWN_FACTS, revenueCents: 1700 });
  await observe(prisma, { id: CALL_ID, revenue: 15 });

  assert.equal(state.callUpdates.length, 0, 'money is never rewritten by a race');
  assert.equal((state.call as Record<string, unknown>).revenueCents, 1700, 'the stored value stands');

  const conflict = revisionFor(state, 'revenue')!;
  assert.equal(conflict.decision, 'CONFLICT');
  assert.equal(conflict.fromValue, '1700');
  assert.equal(conflict.toValue, '15', 'what the provider said, so a person can judge');
  assert.equal(conflict.appliedAt, null, 'NULL means the canonical value did not move');
});

// --- What the CALLER learns, added by PR 8 ------------------------------------------------
//
// A convergence that only writes rows is invisible to whoever asked for the
// observation. A batch runner processing thousands of records cannot find a
// disagreement in a log line, and a run that reports plain success while two
// revenue figures disagree is the silence PR #182 existed to end.

test('a strengthened fact is NAMED in the result, not just written', async () => {
  const { prisma } = harness({ ...UNKNOWN_FACTS });
  const [result] = await observe(prisma, { id: CALL_ID, revenue: 17, billable: true });
  assert.equal(result!.status, 'duplicate', 'a re-observation, not a second ingestion');
  assert.deepEqual(result!.strengthenedFacts, ['revenue', 'billable']);
  assert.deepEqual(result!.conflictedFacts, []);
});

test('a CONFLICT is named in the result, so a caller can refuse to report success', async () => {
  const { prisma } = harness({ ...UNKNOWN_FACTS, revenueCents: 1700 });
  const [result] = await observe(prisma, { id: CALL_ID, revenue: 15 });
  assert.deepEqual(result!.conflictedFacts, ['revenue']);
  assert.deepEqual(result!.strengthenedFacts, [], 'nothing moved');
});

test('silence is reported as silence: an identical observation names no fact at all', async () => {
  const { prisma } = harness({ ...UNKNOWN_FACTS, revenueCents: 1700, billable: true });
  const [result] = await observe(prisma, { id: CALL_ID, revenue: 17, billable: true });
  assert.deepEqual(result!.strengthenedFacts, []);
  assert.deepEqual(result!.conflictedFacts, []);
});

test('a first ingestion names no strengthened fact, because there was nothing to strengthen', async () => {
  const { prisma, state } = harness({ ...UNKNOWN_FACTS });
  state.event = { ...state.event, status: 'RECEIVED' };
  const [result] = await observe(prisma, { id: CALL_ID, revenue: 17 });
  assert.notEqual(result!.status, 'duplicate');
  assert.deepEqual(result!.strengthenedFacts, []);
  assert.deepEqual(result!.conflictedFacts, []);
});

test('the duplicate branch is chosen by ONE shared predicate, not a status literal', () => {
  // The dry run of the manual poll asks the same question of the same column. Two
  // spellings of "PROCESSED" is how a dry run starts describing a run that no
  // longer exists.
  assert.ok(SERVICE_SOURCE.includes('isDuplicateObservation(existing.status)'));
  assert.equal(
    (SERVICE_SOURCE.match(/===\s*'PROCESSED'/g) ?? []).length,
    1,
    'the status literal appears exactly once, and it is the predicate itself',
  );
  assert.match(
    SERVICE_SOURCE,
    /export function isDuplicateObservation\(status: string\): boolean \{\s*\n\s*return status === 'PROCESSED';/,
    'and that one occurrence is inside isDuplicateObservation',
  );
});

// --- 10-15: everything PRs #178-#181 established still holds --------------------------------

test('10-15. identity, receipt, occurrence and provenance all survive convergence', async () => {
  const { prisma, state } = harness({ ...UNKNOWN_FACTS });
  await observe(prisma, { id: CALL_ID, revenue: 17 }, 'API_RECOVERY');

  const e = state.event;
  assert.equal(e.externalId, CALL_ID, 'one canonical identity');
  assert.equal((e.receivedAt as Date).toISOString(), FIRST_RECEIPT.toISOString(), 'first receipt');
  assert.equal((e.occurredAt as Date).toISOString(), OCCURRED.toISOString(), 'occurrence');
  assert.equal(e.firstIngestionSource, 'WEBHOOK', 'first transport');
  assert.deepEqual(e.observedSources, ['WEBHOOK', 'API_RECOVERY'], 'observation retained');
  assert.ok((e.lastObservedAt as Date).getTime() > FIRST_RECEIPT.getTime(), 'and advanced');
  // The event update still carries ONLY the observation — convergence writes to
  // the call, never back onto the raw delivery.
  assert.deepEqual(Object.keys(state.eventUpdates[0]!).sort(), ['lastObservedAt', 'observedSources']);
});

test('16/17. no duplicate call is created, and the raw payload is not destroyed', async () => {
  const { prisma, state } = harness({ ...UNKNOWN_FACTS });
  await observe(prisma, { id: CALL_ID, revenue: 17, replaced: true });
  // marketplaceCall.update is a targeted update by id; there is no upsert and no
  // create on this path.
  assert.ok(!SERVICE_SOURCE.includes('upsertProjection'), 'the re-observation path never upserts');
  assert.deepEqual(state.event.payload, { id: CALL_ID, original: true }, 'original evidence stands');
});

test('a call with no projection yet is left alone rather than built from a re-observation', async () => {
  const { prisma, state } = harness(null);
  await observe(prisma, { id: CALL_ID, revenue: 17 });
  assert.equal(state.callUpdates.length, 0);
  assert.equal(state.revisions.length, 0, 'nothing changed, so nothing is recorded');
});

// --- 18-21: boundaries --------------------------------------------------------------------

test('18. the field-specific decisions live in ONE pure rule, not in this service', () => {
  // The moment "revenue is special" is written in two places, the two disagree
  // about a postback.
  assert.ok(SERVICE_SOURCE.includes('convergeFact'));
  assert.ok(SERVICE_SOURCE.includes('CALLGRID_FACT_KINDS'));
  for (const smell of ['> 0 ?', 'revenue === 0', 'billable === false', 'lastWriteWins']) {
    assert.ok(!SERVICE_SOURCE.includes(smell), `no field-specific branching: ${smell}`);
  }
  // And descriptive facts are not converged at all. Scoped to the convergence
  // method's own body: `durationSeconds` legitimately appears elsewhere in this
  // file, in the FIRST-ingest normalization that this PR does not change.
  const start = SERVICE_SOURCE.indexOf('private async convergeProviderFacts');
  const end = SERVICE_SOURCE.indexOf('private async ingestOne');
  assert.ok(start > 0 && end > start, 'the convergence method must be locatable');
  const convergence = SERVICE_SOURCE.slice(start, end);
  for (const absent of ['callerZip', 'callerState', 'campaignLabel', 'durationSeconds', 'status']) {
    assert.ok(!convergence.includes(absent), `${absent} must not be converged`);
  }
});

test('19/20/21. no poller, schedule, checkpoint, recovery, readiness or measurement', () => {
  for (const symbol of [
    'watermark',
    'checkpoint',
    'setInterval',
    'cron',
    'fetchAllCallGridCalls',
    'since',
    'until',
    'reconcileDay',
    'certifyDay',
    'assessReadiness',
    'measureChange',
    'Headline',
    'declareAuthority',
    'SourceOutcomeDay',
  ]) {
    assert.ok(!SERVICE_SOURCE.includes(symbol), `ingestion must not reference ${symbol}`);
  }
});

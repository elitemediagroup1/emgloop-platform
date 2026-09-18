// CallGrid's real delivery pattern, against a REAL Postgres: one call, three webhooks,
// every order, sequential and concurrent.
//
// OPT-IN AND LOCAL ONLY. Runs only when LOOP_TEST_POSTGRES_URL is set, and refuses any
// host but localhost / 127.0.0.1.
//
//   LOOP_TEST_POSTGRES_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres \
//     npx tsx --test test/callgrid-webhook-convergence.postgres.test.ts
//
// WHAT CALLGRID DOES (Taylor Murray, CallGrid, confirmed to Matt): a call can hit the
// webhook several times; Ended, Billable and Payable fire at essentially the same
// moment -- about three hits per call -- and CallGrid holds the economics when the call
// completes. So for ONE CallId, three requests race, in any order.
//
// WHAT THIS PROVES, THROUGH THE REAL PIPELINE (the route's own two steps:
// `parseWebhook`, then `IngestionService.ingest`):
//   * exactly ONE canonical call, ONE Interaction and ONE delivery row per CallId,
//     however many requests and in whatever order -- and no request fails;
//   * the stored call converges to the strongest facts any delivery stated;
//   * a weaker delivery (a pending zero, an omitted field) never erases a settled one;
//   * a backfill over the older Interaction never erases what live ingestion learned;
//   * another organization can neither move nor merge this organization's call.
//
// Before the fix, the concurrent half of this file failed 104 of 216 trials in the
// investigation harness: revenue and payout lost behind an HTTP 200, unique-key 500s,
// and up to three Interactions for one call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { getCallGridProvider, mapCallgridEventType } from '@emgloop/providers';

import { IngestionService } from '../src/services/ingestion.service';
import { MarketplaceCallRepository } from '../src/repositories/marketplace-call.repository';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

type Label = 'ENDED' | 'BILLABLE' | 'PAYABLE';
type Payload = Record<string, string>;

const OCCURRED_UNIX = '1758196800'; // 2025-09-18T12:00:00Z
const WINDOW = { since: new Date('2025-09-18T00:00:00Z'), until: new Date('2025-09-19T00:00:00Z') };

/** The confirmed webhook template (docs/CALLGRID_WEBHOOK_CONTRACT.md): every value a quoted string. */
function template(id: string, over: Payload): Payload {
  return {
    id,
    callStatus: 'COMPLETED',
    endedBy: 'caller',
    occurredAtUnix: OCCURRED_UNIX,
    callerId: '+13057712408',
    vendorId: 'v1', vendorName: 'Vendor One',
    sourceId: 's1', sourceName: 'Source One',
    campaignId: 'c1', campaignName: 'Campaign One',
    buyerId: 'b1', buyerName: 'Buyer One',
    destinationId: 'd1', destinationName: 'Destination One',
    inboundState: 'FL', inboundZip: '33101',
    durationSeconds: '185',
    completed: 'true', noRoute: 'false', converted: 'false',
    cost: '0.04',
    ...over,
  };
}

/** Each webhook carries only what ITS event established -- the hardest case to converge. */
const independent = (id: string): Record<Label, Payload> => ({
  ENDED: template(id, { revenue: '0', payout: '0', profit: '0', billable: 'false', paid: 'false' }),
  BILLABLE: template(id, { revenue: '25.00', payout: '0', profit: '25.00', billable: 'true', paid: 'false' }),
  PAYABLE: template(id, { revenue: '0', payout: '10.00', profit: '-10.00', billable: 'false', paid: 'true' }),
});

/** Each webhook carries the call's state at that moment. */
const cumulative = (id: string): Record<Label, Payload> => ({
  ENDED: template(id, { revenue: '0', payout: '0', profit: '0', billable: 'false', paid: 'false' }),
  BILLABLE: template(id, { revenue: '25.00', payout: '0', profit: '25.00', billable: 'true', paid: 'false' }),
  PAYABLE: template(id, { revenue: '25.00', payout: '10.00', profit: '15.00', billable: 'true', paid: 'true' }),
});

const STRONGEST = { revenueCents: 2500, payoutCents: 1000, costCents: 4, billable: true, paid: true, monetized: true };

const ORDERS: Label[][] = [
  ['ENDED', 'BILLABLE', 'PAYABLE'],
  ['ENDED', 'PAYABLE', 'BILLABLE'],
  ['BILLABLE', 'ENDED', 'PAYABLE'],
  ['BILLABLE', 'PAYABLE', 'ENDED'],
  ['PAYABLE', 'ENDED', 'BILLABLE'],
  ['PAYABLE', 'BILLABLE', 'ENDED'],
];

const provider = getCallGridProvider();

/** Exactly what the webhook route does with a verified body. A throw is an HTTP 500. */
async function deliver(prisma: PrismaClient, organizationId: string, payload: Payload) {
  const events = await provider.parseWebhook({ organizationId, credentials: {}, config: {} } as never, payload);
  const [result] = await new IngestionService(prisma).ingest({
    observationSource: 'WEBHOOK',
    organizationId,
    provider: 'callgrid',
    providerConnectionId: null,
    mapEventType: mapCallgridEventType,
    events,
  });
  return result!;
}

async function stored(prisma: PrismaClient, organizationId: string, externalId: string) {
  const calls = await prisma.marketplaceCall.findMany({ where: { provider: 'callgrid', externalId } });
  const interactions = await prisma.interaction.findMany({ where: { provider: 'callgrid', externalId } });
  const events = await prisma.integrationEvent.findMany({ where: { provider: 'callgrid', externalId } });
  const signals = await prisma.signal.count({ where: { organizationId, metadata: { path: ['externalId'], equals: externalId } } });
  return { calls, interactions, events, signals, call: calls[0] ?? null };
}

function assertStrongest(call: Record<string, unknown> | null, label: string) {
  assert.ok(call, `${label}: a call exists`);
  for (const [k, v] of Object.entries(STRONGEST)) assert.equal(call![k], v, `${label}: ${k}`);
}

async function org(prisma: PrismaClient, label: string) {
  const id = `org_cgconv_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id, name: `CG ${label}`, slug: id } });
  return id;
}

async function cleanup(prisma: PrismaClient, ids: string[]) {
  for (const id of ids) {
    await prisma.marketplaceCall.deleteMany({ where: { organizationId: id } });
    await prisma.providerFactRevision.deleteMany({ where: { organizationId: id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id } });
  }
}

test('1 and 3. the same CallId delivered three times is one call, one Interaction, one delivery -- idempotently', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const orgs: string[] = [];
  try {
    const organizationId = await org(prisma, 'thrice');
    orgs.push(organizationId);
    const id = `cg_${randomUUID()}`;
    const payload = template(id, { revenue: '25.00', payout: '10.00', profit: '15.00', billable: 'true', paid: 'true' });

    const first = await deliver(prisma, organizationId, payload);
    const afterOne = await stored(prisma, organizationId, id);
    const second = await deliver(prisma, organizationId, payload);
    const third = await deliver(prisma, organizationId, payload);
    const s = await stored(prisma, organizationId, id);

    assert.deepEqual([first.status, second.status, third.status], ['processed', 'duplicate', 'duplicate']);
    assert.equal(s.calls.length, 1, 'one canonical call');
    assert.equal(s.interactions.length, 1, 'one Interaction');
    assert.equal(s.events.length, 1, 'one delivery row');
    assert.equal(s.events[0]!.status, 'PROCESSED');
    assert.equal(s.signals, afterOne.signals, 'no signal is written twice');
    assertStrongest(s.call as never, 'thrice');
    assert.equal(s.call!.interactionId, s.interactions[0]!.id, 'linked to its Interaction');
    // A duplicate names no strengthened fact: it had nothing to add.
    assert.deepEqual([second.strengthenedFacts, third.strengthenedFacts], [[], []]);
  } finally {
    await cleanup(prisma, orgs);
    await prisma.$disconnect();
  }
});

test('2. every Ended/Billable/Payable ordering converges to the strongest facts, delivered one after another', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const orgs: string[] = [];
  try {
    const organizationId = await org(prisma, 'sequential');
    orgs.push(organizationId);
    for (const [name, make] of [['independent', independent], ['cumulative', cumulative]] as const) {
      for (const order of ORDERS) {
        const id = `cg_${randomUUID()}`;
        const payloads = make(id);
        const results = [];
        for (const label of order) results.push(await deliver(prisma, organizationId, payloads[label]));
        const label = `${name} ${order.join('>')}`;
        const s = await stored(prisma, organizationId, id);
        assertStrongest(s.call as never, label);
        assert.equal(s.calls.length, 1, label);
        assert.equal(s.interactions.length, 1, label);
        assert.deepEqual(results.map((r) => r.status), ['processed', 'duplicate', 'duplicate'], label);
      }
    }
  } finally {
    await cleanup(prisma, orgs);
    await prisma.$disconnect();
  }
});

test('2 and 13. every ordering converges when the three arrive concurrently -- one call, one Interaction, no failed request', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const orgs: string[] = [];
  try {
    const organizationId = await org(prisma, 'concurrent');
    orgs.push(organizationId);
    // One delivery alone, for the signal count a call should produce.
    const lone = `cg_${randomUUID()}`;
    await deliver(prisma, organizationId, independent(lone).BILLABLE);
    const baselineSignals = (await stored(prisma, organizationId, lone)).signals;

    for (const [name, make] of [['independent', independent], ['cumulative', cumulative]] as const) {
      for (const order of ORDERS) {
        // 0 ms is CallGrid's "essentially the same time"; the others sweep the window in
        // which the first delivery is still being ingested.
        for (const stagger of [0, 0, 1, 3, 8, 20]) {
          const id = `cg_${randomUUID()}`;
          const payloads = make(id);
          const results = await Promise.all(
            order.map((label, i) => new Promise((r) => setTimeout(r, i * stagger)).then(() => deliver(prisma, organizationId, payloads[label]))),
          );
          const label = `${name} ${order.join('>')} +${stagger}ms`;
          const s = await stored(prisma, organizationId, id);
          assertStrongest(s.call as never, label);
          assert.equal(s.calls.length, 1, `${label}: one canonical call`);
          assert.equal(s.interactions.length, 1, `${label}: one Interaction`);
          assert.equal(s.events.length, 1, `${label}: one delivery row`);
          assert.equal(s.events[0]!.status, 'PROCESSED', label);
          assert.equal(s.signals, baselineSignals, `${label}: signals written once`);
          assert.equal(results.filter((r) => r.status === 'processed').length, 1, `${label}: exactly one request ingests`);
          assert.equal(results.filter((r) => r.status === 'failed').length, 0, `${label}: no request fails`);
          assert.equal(s.call!.interactionId, s.interactions[0]!.id, `${label}: linked`);
        }
      }
    }
  } finally {
    await cleanup(prisma, orgs);
    await prisma.$disconnect();
  }
});

test('3. a duplicate of every event, all at once, is still one call with the strongest facts', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const orgs: string[] = [];
  try {
    const organizationId = await org(prisma, 'dupes');
    orgs.push(organizationId);
    for (let trial = 0; trial < 6; trial += 1) {
      const id = `cg_${randomUUID()}`;
      const p = independent(id);
      const burst = [p.PAYABLE, p.ENDED, p.BILLABLE, p.ENDED, p.PAYABLE, p.BILLABLE];
      if (trial % 2) burst.reverse();
      const results = await Promise.all(burst.map((payload) => deliver(prisma, organizationId, payload)));
      const s = await stored(prisma, organizationId, id);
      assertStrongest(s.call as never, `trial ${trial}`);
      assert.equal(s.calls.length, 1);
      assert.equal(s.interactions.length, 1);
      assert.equal(results.filter((r) => r.status === 'processed').length, 1);
      assert.equal(results.filter((r) => r.status === 'duplicate').length, 5);
    }
  } finally {
    await cleanup(prisma, orgs);
    await prisma.$disconnect();
  }
});

test('4, 5 and 6. a weaker delivery never erases settled revenue, payout or cost', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const orgs: string[] = [];
  try {
    const organizationId = await org(prisma, 'weaker');
    orgs.push(organizationId);
    const id = `cg_${randomUUID()}`;
    await deliver(prisma, organizationId, template(id, { revenue: '100.00', payout: '40.00', cost: '0.07', profit: '60.00', billable: 'true', paid: 'true' }));

    // A pending zero for every amount and flag.
    await deliver(prisma, organizationId, template(id, { revenue: '0', payout: '0', cost: '0', profit: '0', billable: 'false', paid: 'false' }));
    // Every economic field OMITTED.
    const omitted = template(id, {});
    for (const k of ['revenue', 'payout', 'cost', 'profit', 'billable', 'paid']) delete omitted[k];
    await deliver(prisma, organizationId, omitted);
    // Present but unreadable.
    await deliver(prisma, organizationId, template(id, { revenue: '', payout: 'N/A', cost: '', billable: '', paid: '' }));

    const { call } = await stored(prisma, organizationId, id);
    assert.equal(call!.revenueCents, 10000, '$100 revenue is never erased by a zero, an omission or junk');
    assert.equal(call!.payoutCents, 4000, 'a known payout never becomes unknown or zero');
    assert.equal(call!.costCents, 7, 'cost is the first statement, and nothing later erases it');
    assert.equal(call!.billable, true);
    assert.equal(call!.paid, true);
    assert.equal(call!.monetized, true);
  } finally {
    await cleanup(prisma, orgs);
    await prisma.$disconnect();
  }
});

test('an authoritative-looking DOWNWARD figure is a recorded conflict, not a silent rewrite', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const orgs: string[] = [];
  try {
    const organizationId = await org(prisma, 'conflict');
    orgs.push(organizationId);
    const id = `cg_${randomUUID()}`;
    await deliver(prisma, organizationId, template(id, { revenue: '100.00', payout: '40.00', billable: 'true', paid: 'true' }));
    const result = await deliver(prisma, organizationId, template(id, { revenue: '80.00', payout: '40.00', billable: 'true', paid: 'true' }));
    const { call } = await stored(prisma, organizationId, id);
    assert.equal(call!.revenueCents, 10000, 'neither figure silently wins');
    assert.deepEqual(result.conflictedFacts, ['revenue'], 'and the caller is told');
    const revision = await prisma.providerFactRevision.findFirst({ where: { externalId: id, fact: 'revenue' } });
    assert.equal(revision!.decision, 'CONFLICT');
    assert.equal(revision!.appliedAt, null);
  } finally {
    await cleanup(prisma, orgs);
    await prisma.$disconnect();
  }
});

test('8. a backfill over the older Interaction cannot erase what live ingestion learned since', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const orgs: string[] = [];
  try {
    const organizationId = await org(prisma, 'backfill');
    orgs.push(organizationId);
    const repo = new MarketplaceCallRepository(prisma);
    const id = `cg_${randomUUID()}`;
    const p = independent(id);
    // Ended first: its Interaction holds zeros. Billable and Payable then settle the call.
    for (const label of ['ENDED', 'BILLABLE', 'PAYABLE'] as const) await deliver(prisma, organizationId, p[label]);
    const interaction = (await stored(prisma, organizationId, id)).interactions[0]!;
    assert.equal((interaction.metadata as Record<string, unknown>).revenue, 0, 'the Interaction is the first, weakest copy');
    assertStrongest((await stored(prisma, organizationId, id)).call as never, 'before backfill');

    const result = await repo.projectWindow(organizationId, WINDOW.since, WINDOW.until);
    assert.ok(result.projected >= 1);
    assertStrongest((await stored(prisma, organizationId, id)).call as never, 'after backfill');

    // And a call missing from the table is still rebuilt by the backfill.
    await prisma.marketplaceCall.deleteMany({ where: { provider: 'callgrid', externalId: id } });
    await repo.projectWindow(organizationId, WINDOW.since, WINDOW.until);
    const rebuilt = (await stored(prisma, organizationId, id)).call!;
    assert.equal(rebuilt.revenueCents, 0, 'rebuilt from the only copy there is');
    assert.equal(rebuilt.interactionId, interaction.id);
  } finally {
    await cleanup(prisma, orgs);
    await prisma.$disconnect();
  }
});

test('12. another organization can neither move nor merge this organization’s call', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const orgs: string[] = [];
  try {
    const mine = await org(prisma, 'mine');
    const theirs = await org(prisma, 'theirs');
    orgs.push(mine, theirs);
    const id = `cg_${randomUUID()}`;
    await deliver(prisma, mine, template(id, { revenue: '25.00', payout: '10.00', billable: 'true', paid: 'true' }));
    // The SAME CallId arriving for another organization (the unique key is global --
    // known tenancy debt), claiming more money.
    await deliver(prisma, theirs, template(id, { revenue: '999.00', payout: '1.00', billable: 'true', paid: 'true' }));

    const calls = await prisma.marketplaceCall.findMany({ where: { provider: 'callgrid', externalId: id } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.organizationId, mine, 'never moved to the other organization');
    assert.equal(calls[0]!.revenueCents, 2500, 'and never merged with its figures');
    const repo = new MarketplaceCallRepository(prisma);
    assert.equal((await repo.aggregateWindow(theirs, WINDOW.since, WINDOW.until)).calls, 0, 'the other organization sees nothing of it');

    // Their own call is theirs, untouched by mine.
    const own = `cg_${randomUUID()}`;
    await deliver(prisma, theirs, template(own, { revenue: '5.00', payout: '1.00', billable: 'true', paid: 'true' }));
    assert.equal((await repo.aggregateWindow(theirs, WINDOW.since, WINDOW.until)).revenueCents, 500);
    assert.equal((await repo.aggregateWindow(mine, WINDOW.since, WINDOW.until)).revenueCents, 2500);
  } finally {
    await cleanup(prisma, orgs);
    await prisma.$disconnect();
  }
});

test('a FAILED delivery retried by several requests at once is processed exactly once', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const orgs: string[] = [];
  try {
    const organizationId = await org(prisma, 'failed');
    orgs.push(organizationId);
    const id = `cg_${randomUUID()}`;
    const payload = template(id, { revenue: '25.00', payout: '10.00', billable: 'true', paid: 'true' });
    await prisma.integrationEvent.create({
      data: { organizationId, provider: 'callgrid', eventType: 'call.completed', externalId: id, status: 'FAILED', error: 'earlier failure', payload: {}, lastObservedAt: new Date() },
    });
    const results = await Promise.all([0, 1, 2].map(() => deliver(prisma, organizationId, payload)));
    const s = await stored(prisma, organizationId, id);
    assert.equal(results.filter((r) => r.status === 'processed').length, 1, 'one request takes it over');
    assert.equal(s.interactions.length, 1);
    assert.equal(s.events[0]!.status, 'PROCESSED');
    assertStrongest(s.call as never, 'failed-retry');
  } finally {
    await cleanup(prisma, orgs);
    await prisma.$disconnect();
  }
});

test('a delivery orphaned mid-flight by a crash is taken over after the lease -- and not before', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const orgs: string[] = [];
  try {
    const organizationId = await org(prisma, 'orphan');
    orgs.push(organizationId);
    const payloadFor = (id: string) => template(id, { revenue: '25.00', payout: '10.00', billable: 'true', paid: 'true' });

    // Fresh: another request is ingesting it right now. Observed, not processed a second time.
    const fresh = `cg_${randomUUID()}`;
    await prisma.integrationEvent.create({
      data: { organizationId, provider: 'callgrid', eventType: 'call.completed', externalId: fresh, status: 'PROCESSING', payload: {}, lastObservedAt: new Date() },
    });
    assert.equal((await deliver(prisma, organizationId, payloadFor(fresh))).status, 'duplicate');
    const inFlight = await stored(prisma, organizationId, fresh);
    assert.equal(inFlight.interactions.length, 0, 'the pipeline is not run beside the request that owns it');
    assertStrongest(inFlight.call as never, 'in-flight observation still lands the economics');

    // Stale: the request that owned it is long gone. Taken over and processed.
    const stale = `cg_${randomUUID()}`;
    await prisma.integrationEvent.create({
      data: { organizationId, provider: 'callgrid', eventType: 'call.completed', externalId: stale, status: 'PROCESSING', payload: {}, lastObservedAt: new Date(Date.now() - 10 * 60_000) },
    });
    assert.equal((await deliver(prisma, organizationId, payloadFor(stale))).status, 'processed');
    const recovered = await stored(prisma, organizationId, stale);
    assert.equal(recovered.interactions.length, 1);
    assert.equal(recovered.events[0]!.status, 'PROCESSED');
  } finally {
    await cleanup(prisma, orgs);
    await prisma.$disconnect();
  }
});

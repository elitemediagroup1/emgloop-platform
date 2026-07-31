// The drain: reclaiming abandoned deliveries, and running a bounded pass across
// every organization with work.
//
// These are the behaviours the Decision Event Contract now GUARANTEES, so they
// are asserted rather than assumed. `at-least-once` moved from PARTIAL to
// GUARANTEED on the strength of the reclaim; if any of these fail, the contract
// is overclaiming and `decision-events.test.ts` is no longer enough to catch it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import {
  StateChangeDeliveryRepository,
  StateChangeOutboxRepository,
} from '../src/repositories/cognitive';
import { OutboxDrainRunner } from '../src/services/cognitive';
import type { StateChangePublisher, PublishResult } from '../src/services/cognitive';

const ORG = 'org_a';
const OTHER_ORG = 'org_b';
const LEASE_MS = 5 * 60_000;

function prisma(): PrismaClient {
  return makeCognitivePrisma() as unknown as PrismaClient;
}

function result(over: Partial<PublishResult> = {}): PublishResult {
  return {
    outboxSeen: 0,
    outboxPublished: 0,
    outboxDeadLettered: 0,
    outboxInFlight: 0,
    outboxContended: 0,
    deliveriesDispatched: 0,
    deliveriesSucceeded: 0,
    deliveriesFailed: 0,
    deliveriesDeadLettered: 0,
    deliveriesReclaimed: 0,
    ...over,
  };
}

/** A delivery claimed at `claimedAt` and never completed — an abandoned worker. */
async function abandonedDelivery(
  p: PrismaClient,
  org: string,
  claimedAt: Date,
  opts: { attempts?: number } = {},
) {
  const deliveries = new StateChangeDeliveryRepository(p);
  const row = await deliveries.ensure(org, {
    outboxId: 'ob_' + Math.random().toString(36).slice(2),
    subscriptionId: 'sub_1',
    subscriberKey: 'work-os',
    idempotencyKey: 'k_' + Math.random().toString(36).slice(2),
    required: false,
    // The row must be DUE at the moment it is claimed: `ensure` stamps
    // availableAt from this clock, and `claim` requires availableAt <= now.
    now: claimedAt,
  });
  // Claim it, which stamps startedAt and increments attemptCount — then simply
  // never finish, which is exactly what a timed-out worker leaves behind.
  await deliveries.claim(org, row.id, { now: claimedAt });
  if (opts.attempts && opts.attempts > 1) {
    await p.stateChangeDelivery.update({
      where: { id: row.id },
      data: { attemptCount: opts.attempts },
    });
  }
  return row;
}

async function statusOf(p: PrismaClient, id: string): Promise<string> {
  const row = await p.stateChangeDelivery.findFirst({ where: { id } });
  return String(row?.status);
}

// --- The reclaim --------------------------------------------------------------

test('a delivery abandoned past the lease is reclaimed and retried', async () => {
  const p = prisma();
  const deliveries = new StateChangeDeliveryRepository(p);
  const claimedAt = new Date(Date.now() - 10 * 60_000);
  const row = await abandonedDelivery(p, ORG, claimedAt);

  assert.equal(await statusOf(p, row.id), 'PROCESSING');

  const out = await deliveries.reclaimStale(ORG, { leaseMs: LEASE_MS, now: new Date() });

  assert.equal(out.reclaimed, 1);
  assert.equal(out.deadLettered, 0);
  // Back to PENDING and immediately due, so the SAME pass can pick it up.
  assert.equal(await statusOf(p, row.id), 'PENDING');
  const after = await p.stateChangeDelivery.findFirst({ where: { id: row.id } });
  assert.match(String(after?.lastError), /Reclaimed after being abandoned/);
});

test('a delivery still inside its lease is left alone', async () => {
  // The boundary. Reclaiming a merely-slow handler re-runs a side effect that may
  // already have happened, so the lease must be respected rather than approximated.
  const p = prisma();
  const deliveries = new StateChangeDeliveryRepository(p);
  const row = await abandonedDelivery(p, ORG, new Date(Date.now() - 30_000));

  const out = await deliveries.reclaimStale(ORG, { leaseMs: LEASE_MS, now: new Date() });

  assert.equal(out.reclaimed, 0);
  assert.equal(await statusOf(p, row.id), 'PROCESSING');
});

test('a stale delivery that has spent its attempts dead-letters instead of recycling', async () => {
  // A handler that reliably kills its worker would otherwise be reclaimed every
  // pass forever, burning the drain and never surfacing as a failure.
  const p = prisma();
  const deliveries = new StateChangeDeliveryRepository(p);
  const row = await abandonedDelivery(p, ORG, new Date(Date.now() - 10 * 60_000), { attempts: 5 });

  const out = await deliveries.reclaimStale(ORG, {
    leaseMs: LEASE_MS,
    maxAttempts: 5,
    now: new Date(),
  });

  assert.equal(out.deadLettered, 1);
  assert.equal(out.reclaimed, 0);
  assert.equal(await statusOf(p, row.id), 'DEAD_LETTERED');
  const after = await p.stateChangeDelivery.findFirst({ where: { id: row.id } });
  assert.match(String(after?.lastError), /presumed dead/);
});

test('a claimed row with no startedAt is never reclaimed on a guess', async () => {
  const p = prisma();
  const deliveries = new StateChangeDeliveryRepository(p);
  const row = await abandonedDelivery(p, ORG, new Date(Date.now() - 10 * 60_000));
  await p.stateChangeDelivery.update({ where: { id: row.id }, data: { startedAt: null } });

  const out = await deliveries.reclaimStale(ORG, { leaseMs: LEASE_MS, now: new Date() });

  assert.equal(out.reclaimed, 0);
  assert.equal(await statusOf(p, row.id), 'PROCESSING');
});

test('the reclaim is organization-scoped', async () => {
  const p = prisma();
  const deliveries = new StateChangeDeliveryRepository(p);
  const mine = await abandonedDelivery(p, ORG, new Date(Date.now() - 10 * 60_000));
  const theirs = await abandonedDelivery(p, OTHER_ORG, new Date(Date.now() - 10 * 60_000));

  const out = await deliveries.reclaimStale(ORG, { leaseMs: LEASE_MS, now: new Date() });

  assert.equal(out.reclaimed, 1);
  assert.equal(await statusOf(p, mine.id), 'PENDING');
  assert.equal(await statusOf(p, theirs.id), 'PROCESSING');
});

// --- The runner ---------------------------------------------------------------

async function enqueue(p: PrismaClient, org: string) {
  return new StateChangeOutboxRepository(p).enqueue(org, {
    subjectType: 'DECISION',
    subjectId: 'dec_1',
    eventType: 'DecisionCreated',
    domain: 'OPERATIONAL',
    stateKey: 'decision.CALLGRID.rule:entity',
    changeType: 'SITUATION_DETECTED',
    payload: {},
  });
}

/** A publisher double, so runner behaviour is tested without the dispatch path. */
function fakePublisher(
  onRun: (org: string) => PublishResult | Promise<PublishResult>,
): StateChangePublisher {
  return {
    async run(organizationId: string) {
      return onRun(organizationId);
    },
  } as unknown as StateChangePublisher;
}

test('the drain resolves its organizations from the database, never from input', async () => {
  const p = prisma();
  await enqueue(p, ORG);
  await enqueue(p, OTHER_ORG);

  const seen: string[] = [];
  const runner = new OutboxDrainRunner(p, {}, {
    publisher: fakePublisher((org) => {
      seen.push(org);
      return result({ outboxSeen: 1, outboxPublished: 1 });
    }),
  });

  const out = await runner.run();

  // Both tenants drained, with no organization named anywhere by the caller.
  assert.deepEqual(seen.sort(), [ORG, OTHER_ORG].sort());
  assert.equal(out.organizationsWithWork, 2);
  assert.equal(out.organizationsDrained, 2);
  assert.equal(out.totals.outboxPublished, 2);
  assert.equal(out.truncated, false);
});

test('an organization with no work is not drained', async () => {
  const p = prisma();
  await enqueue(p, ORG);

  const runner = new OutboxDrainRunner(p, {}, {
    publisher: fakePublisher(() => result({ outboxSeen: 1 })),
  });
  const out = await runner.run();

  assert.equal(out.organizationsWithWork, 1);
  assert.equal(out.organizations[0]?.organizationId, ORG);
});

test('one organization failing never stops the others', async () => {
  // A single tenant's bad row must not become a platform-wide delivery outage.
  const p = prisma();
  await enqueue(p, ORG);
  await enqueue(p, OTHER_ORG);

  const runner = new OutboxDrainRunner(p, {}, {
    publisher: fakePublisher((org) => {
      if (org === ORG) throw new Error('boom');
      return result({ outboxPublished: 1 });
    }),
  });

  const out = await runner.run();

  assert.equal(out.organizationsDrained, 2);
  const failed = out.organizations.find((o) => o.organizationId === ORG);
  const ok = out.organizations.find((o) => o.organizationId === OTHER_ORG);
  assert.equal(failed?.error, 'boom');
  assert.equal(failed?.result, null);
  assert.equal(ok?.error, null);
  // The healthy tenant's work still counted.
  assert.equal(out.totals.outboxPublished, 1);
});

test('a pass is bounded, and says so rather than silently covering less', async () => {
  const p = prisma();
  await enqueue(p, 'org_1');
  await enqueue(p, 'org_2');
  await enqueue(p, 'org_3');

  const runner = new OutboxDrainRunner(p, { maxOrganizations: 2 }, {
    publisher: fakePublisher(() => result({ outboxPublished: 1 })),
  });
  const out = await runner.run();

  assert.equal(out.organizationsWithWork, 3);
  assert.equal(out.organizationsDrained, 2);
  // Truncation is disclosed. A drain that quietly covered two of three would read
  // as "everything is delivered" while a tenant's queue grew.
  assert.equal(out.truncated, true);
});

test('the runner reports totals a human can act on', async () => {
  const p = prisma();
  await enqueue(p, ORG);

  const runner = new OutboxDrainRunner(p, {}, {
    publisher: fakePublisher(() =>
      result({ outboxSeen: 4, outboxPublished: 3, deliveriesReclaimed: 1, deliveriesDeadLettered: 2 }),
    ),
  });
  const out = await runner.run();

  assert.equal(out.totals.outboxSeen, 4);
  assert.equal(out.totals.deliveriesReclaimed, 1);
  assert.equal(out.totals.deliveriesDeadLettered, 2);
  assert.ok(out.durationMs >= 0);
  assert.ok(Date.parse(out.startedAt) > 0);
});

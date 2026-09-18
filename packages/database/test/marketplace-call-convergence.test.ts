// Merging one observation of a call into the call already stored -- the rule, and the
// write that applies it under contention.
//
// The end-to-end proof, every CallGrid delivery order against real Postgres, is
// callgrid-webhook-convergence.postgres.test.ts. These pin the parts that suite cannot
// isolate: the pure planner, fact by fact, and the repository's two races (a lost
// create, a lost compare-and-set) resolved deterministically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import {
  convergeCallObservation,
  projectCallObservation,
  type MarketplaceCallProjection,
  type StoredCallFacts,
} from '../src/repositories/marketplace-call-projection';
import { MarketplaceCallRepository } from '../src/repositories/marketplace-call.repository';

const OCCURRED = new Date('2025-09-18T12:00:00Z');

function observation(metadata: Record<string, unknown>, over: { organizationId?: string; interactionId?: string | null } = {}): MarketplaceCallProjection {
  const p = projectCallObservation({
    organizationId: over.organizationId ?? 'org_a',
    provider: 'callgrid',
    externalId: 'cg-1',
    channel: 'PHONE',
    occurredAt: OCCURRED,
    metadata: { eventType: 'call.completed', callerId: '+13057712408', buyer: 'Buyer One', buyerId: 'b1', cost: 0.04, ...metadata },
    interactionId: over.interactionId ?? null,
  });
  assert.ok(p, 'a well-formed call projects');
  return p!;
}

const STORED: StoredCallFacts = {
  interactionId: null,
  revenueCents: null,
  payoutCents: null,
  billable: null,
  paid: null,
  converted: null,
  monetized: null,
};

// --- The planner ------------------------------------------------------------------

test('Billable after Ended: revenue settles upward, billable is asserted, and monetized follows it', () => {
  const ended = { ...STORED, revenueCents: 0, payoutCents: 0, billable: false, paid: false, converted: false, monetized: false };
  const plan = convergeCallObservation(ended, observation({ revenue: 25, payout: 0, billable: true, paid: false, qualified: true }));
  assert.deepEqual(plan.update, { revenueCents: 2500, billable: true, monetized: true });
});

test('Ended after Billable: a pending zero and a false erase nothing', () => {
  const billable = { ...STORED, revenueCents: 2500, payoutCents: 0, billable: true, paid: false, converted: false, monetized: true };
  const plan = convergeCallObservation(billable, observation({ revenue: 0, payout: 0, billable: false, paid: false, qualified: false }));
  assert.deepEqual(plan.update, {}, 'nothing moves');
});

test('an observation that OMITS a fact leaves it exactly as stored', () => {
  const settled = { ...STORED, revenueCents: 2500, payoutCents: 1000, billable: true, paid: true, monetized: true };
  assert.deepEqual(convergeCallObservation(settled, observation({})).update, {});
});

test('two different settled amounts are a CONFLICT that writes nothing -- a correction is not guessed at', () => {
  const settled = { ...STORED, revenueCents: 10000, billable: true, monetized: true };
  const plan = convergeCallObservation(settled, observation({ revenue: 80, billable: true }));
  assert.deepEqual(plan.update, {});
  assert.equal(plan.decisions.find((d) => d.fact === 'revenue')!.converged.decision, 'CONFLICT');
});

test('monetized is never made false, and an existing row that missed it is healed by the next observation', () => {
  // A row the old projection left behind: billable true, monetized false (Ended first).
  const legacy = { ...STORED, revenueCents: 2500, billable: true, monetized: false };
  assert.deepEqual(convergeCallObservation(legacy, observation({ revenue: 25, billable: true })).update, { monetized: true });
  const known = { ...STORED, monetized: true };
  assert.equal('monetized' in convergeCallObservation(known, observation({ billable: false, paid: false, qualified: false })).update, false);
});

test('the Interaction link is filled once, and never replaced', () => {
  assert.deepEqual(convergeCallObservation(STORED, observation({}, { interactionId: 'int_1' })).update, { interactionId: 'int_1' });
  assert.deepEqual(convergeCallObservation({ ...STORED, interactionId: 'int_1' }, observation({}, { interactionId: 'int_2' })).update, {});
});

test('cost, attribution, geography, status and duration are never in a merge -- the first statement stands', () => {
  const plan = convergeCallObservation(STORED, observation({ cost: 9.99, buyer: 'Someone Else', callerState: 'TX', durationSeconds: 999, eventType: 'call.answered' }));
  for (const column of ['costCents', 'buyerLabel', 'buyerExternalId', 'callerState', 'connectedDurationSeconds', 'status', 'rawStatus']) {
    assert.equal(column in plan.update, false, column);
  }
});

// --- The write, under contention -------------------------------------------------

function repository() {
  const fake: any = makeCognitivePrisma({ also: ['marketplaceCall'] });
  return { fake, repo: new MarketplaceCallRepository(fake as PrismaClient) };
}

test('the first observation creates the call exactly as stated; the next merges into it', async () => {
  const { fake, repo } = repository();
  assert.equal((await repo.observe(observation({ revenue: 0, payout: 0, billable: false, paid: false, qualified: false }))).outcome, 'CREATED');
  assert.equal((await repo.observe(observation({ revenue: 25, billable: true, qualified: true }))).outcome, 'MERGED');
  assert.equal((await repo.observe(observation({ revenue: 0 }))).outcome, 'UNCHANGED');
  const rows = fake.marketplaceCall.__rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].revenueCents, 2500);
  assert.equal(rows[0].monetized, true);
  assert.equal(rows[0].costCents, 4);
});

test('a create that loses the race to another observation merges into the winner instead of failing', async () => {
  const { fake, repo } = repository();
  const findUnique = fake.marketplaceCall.findUnique.bind(fake.marketplaceCall);
  let raced = false;
  fake.marketplaceCall.findUnique = async (args: unknown) => {
    const found = await findUnique(args);
    if (!found && !raced) {
      raced = true;
      // Billable lands between this request's read and its create.
      await fake.marketplaceCall.create({ data: { ...observation({ revenue: 25, billable: true, qualified: true }) } });
    }
    return found;
  };
  const outcome = await repo.observe(observation({ revenue: 0, payout: 10, paid: true, billable: false, qualified: true }));
  assert.equal(outcome.outcome, 'MERGED', 'the unique key refused the second row, and the loser merged');
  const rows = fake.marketplaceCall.__rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].revenueCents, 2500);
  assert.equal(rows[0].payoutCents, 1000);
  assert.equal(rows[0].paid, true);
});

test('a merge whose compare-and-set loses re-reads and decides again -- it never writes over the winner', async () => {
  const { fake, repo } = repository();
  await repo.observe(observation({ revenue: 0, payout: 0, billable: false, paid: false, qualified: false }));
  const updateMany = fake.marketplaceCall.updateMany.bind(fake.marketplaceCall);
  let raced = false;
  fake.marketplaceCall.updateMany = async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    if (!raced) {
      raced = true;
      // Another observation settles revenue first, at a different figure.
      await updateMany({ where: { provider: 'callgrid', externalId: 'cg-1' }, data: { revenueCents: 3000, billable: true, monetized: true } });
    }
    return updateMany(args);
  };
  const outcome = await repo.observe(observation({ revenue: 25, billable: true, qualified: true }));
  // Decided again against 3000: two settled amounts disagree, so nothing is written.
  assert.equal(outcome.outcome, 'UNCHANGED');
  assert.equal(outcome.decisions.find((d) => d.fact === 'revenue')!.converged.decision, 'CONFLICT');
  assert.equal(fake.marketplaceCall.__rows[0].revenueCents, 3000);
});

test('a key held by another organization is refused -- never moved, never merged', async () => {
  const { fake, repo } = repository();
  await repo.observe(observation({ revenue: 25, billable: true }, { organizationId: 'org_a' }));
  const outcome = await repo.observe(observation({ revenue: 999, billable: true }, { organizationId: 'org_b' }));
  assert.equal(outcome.outcome, 'FOREIGN');
  assert.equal(fake.marketplaceCall.__rows.length, 1);
  assert.equal(fake.marketplaceCall.__rows[0].organizationId, 'org_a');
  assert.equal(fake.marketplaceCall.__rows[0].revenueCents, 2500);
});

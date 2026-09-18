// The command center's call reads: one window, bucketed and narrowed, must agree with
// the canonical aggregate to the cent -- and stay inside the organization that asked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { MarketplaceCallRepository, aggregateRows, windowFactsOf, callDimensionKey } from '../src/repositories/marketplace-call.repository';

const at = (iso: string) => new Date(iso);

function row(over: Record<string, unknown> = {}) {
  return {
    sourceOccurredAt: at('2026-09-18T14:10:00Z'),
    buyerExternalId: 'b1', buyerLabel: 'Markytek',
    vendorExternalId: 'v1', vendorLabel: 'Vendor One',
    sourceExternalId: 's1', sourceLabel: 'Turtle Leads',
    campaignExternalId: 'c1', campaignLabel: 'Pest Control RTB',
    revenueCents: 2500, payoutCents: 1000, costCents: 4,
    monetized: true, converted: false, billable: true, completed: true, noRoute: false,
    ...over,
  } as any;
}

const ROWS = [
  row(),
  row({ sourceOccurredAt: at('2026-09-18T14:40:00Z'), revenueCents: null, payoutCents: null, monetized: false, billable: false }),
  row({ sourceOccurredAt: at('2026-09-18T15:05:00Z'), buyerExternalId: 'b2', buyerLabel: 'Buyer Two', campaignExternalId: 'c2', campaignLabel: 'HVAC', revenueCents: 1500 }),
  row({ sourceOccurredAt: at('2026-09-18T15:50:00Z'), completed: null, billable: null, noRoute: null, sourceExternalId: null, sourceLabel: 'Home Ins Direct' }),
  // Outside every bucket: still in the totals, never in a bucket.
  row({ sourceOccurredAt: at('2026-09-18T18:00:00Z'), revenueCents: 700 }),
];
const BUCKETS = [
  { start: at('2026-09-18T14:00:00Z'), end: at('2026-09-18T15:00:00Z') },
  { start: at('2026-09-18T15:00:00Z'), end: at('2026-09-18T16:00:00Z') },
];

test('the series and totals agree with the canonical aggregate, cent for cent', () => {
  const facts = windowFactsOf(ROWS, { buckets: BUCKETS });
  assert.deepEqual(facts.aggregate, aggregateRows(ROWS));
  assert.deepEqual(facts.series.map((p) => p.calls), [2, 2]);
  assert.deepEqual(facts.series.map((p) => p.revenueCents), [2500, 4000]);
  assert.deepEqual(facts.series.map((p) => p.callsWithRevenue), [1, 2], 'an unpriced call adds nothing and counts nothing');
  assert.equal(facts.aggregate.calls, 5, 'a call outside the buckets still counts in the window');
});

test('an unreported flag is unknown, not false: each outcome carries how many calls reported it', () => {
  const { outcomes } = windowFactsOf(ROWS);
  assert.equal(outcomes.calls, 5);
  assert.equal(outcomes.completed, 4);
  assert.equal(outcomes.completedReported, 4);
  assert.equal(outcomes.billable, 3);
  assert.equal(outcomes.billableReported, 4);
  assert.equal(outcomes.monetized, 4);
});

test('one entity, by the same key the list page gives it, with the other dimensions it touched', () => {
  const key = callDimensionKey('b1', 'Markytek')!;
  const facts = windowFactsOf(ROWS, { entity: { dimension: 'buyers', key }, buckets: BUCKETS });
  assert.equal(facts.entityLabel, 'Markytek');
  assert.equal(facts.aggregate.calls, 4);
  assert.deepEqual(facts.aggregate.campaigns.map((c) => c.label), ['Pest Control RTB'], 'only campaigns that fed this buyer');
  assert.deepEqual(facts.aggregate.sources.map((c) => c.label).sort(), ['Home Ins Direct', 'Turtle Leads']);
  // The key matches the list row's key for the same buyer.
  assert.ok(aggregateRows(ROWS).buyers.some((b) => b.key === key));
  // A label-only entity keys by its label.
  assert.equal(windowFactsOf(ROWS, { entity: { dimension: 'sources', key: 'home ins direct' } }).aggregate.calls, 1);
  // Nothing matched: no label, and zero calls rather than an error.
  const none = windowFactsOf(ROWS, { entity: { dimension: 'buyers', key: 'nobody' } });
  assert.equal(none.entityLabel, null);
  assert.equal(none.aggregate.calls, 0);
});

test('both reads are scoped to the organization that asked', async () => {
  const fake: any = makeCognitivePrisma({ also: ['marketplaceCall'] });
  const repo = new MarketplaceCallRepository(fake as PrismaClient);
  const base = { provider: 'callgrid', status: 'COMPLETED', updatedAt: at('2026-09-18T15:00:00Z') };
  await fake.marketplaceCall.create({ data: { ...base, ...row(), id: 'm1', externalId: 'x1', organizationId: 'org_a' } });
  await fake.marketplaceCall.create({ data: { ...base, ...row({ revenueCents: 99_999 }), id: 'm2', externalId: 'x2', organizationId: 'org_b' } });

  const facts = await repo.windowFacts('org_a', at('2026-09-18T00:00:00Z'), at('2026-09-19T00:00:00Z'));
  assert.equal(facts.aggregate.calls, 1);
  assert.equal(facts.aggregate.revenueCents, 2500, 'the other tenant’s call is invisible');
  const recent = await repo.recentCalls('org_a', 5);
  assert.deepEqual(recent.map((r) => r.id), ['m1']);
});

// Demo / QA traffic is recognised from an interaction's own identifiers.
//
// Ingestion links no call and no website event to a Customer. Exclusion used to
// look only at the linked Customer, so without one every new test call (a
// 555-01xx number, an example.com form) would have reached Live Calls, Traffic
// and MarketplaceCall. The event's external id and the phone and email its source
// reported are now held to the same rules; a Customer an older interaction is
// already linked to still counts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExcludedInteraction } from '../src/repositories/operational-filters';
import { projectInteractionToMarketplaceCall } from '../src/repositories/marketplace-call-projection';
import { LiveOperationsRepository } from '../src/repositories/live-operations.repository';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';

const ORG = 'org_live';
type Row = Record<string, any>;

// --- Exclusion from the event's own identifiers ----------------------------------------

test('test traffic is recognised from the interaction itself, with no Customer', () => {
  assert.equal(isExcludedInteraction({ externalId: 'cg-1', metadata: { fromNumber: '+13125550142' } }), true, 'reserved 555-01xx caller');
  assert.equal(isExcludedInteraction({ externalId: 'cg-1', metadata: { caller: '(312) 555-7788' } }), true, '555 placeholder exchange');
  assert.equal(isExcludedInteraction({ externalId: 'web-1', metadata: { email: 'qa@example.com' } }), true, 'fixture email domain');
  assert.equal(isExcludedInteraction({ externalId: 'e2e-call-7', metadata: {} }), true, 'test external id');
  assert.equal(isExcludedInteraction({ externalId: 'cg-1', metadata: { fromNumber: '+13128675309' } }), false, 'a real caller');
  assert.equal(isExcludedInteraction({ externalId: 'web-1', metadata: { email: 'pat@northsideplumbing.co' } }), false);
  assert.equal(isExcludedInteraction({ externalId: 'cg-1', metadata: null }), false, 'missing metadata is not test data');
});

test('an older interaction linked to a demo-tagged Customer is still excluded', () => {
  assert.equal(
    isExcludedInteraction({ externalId: 'cg-1', metadata: { fromNumber: '+13128675309' }, customer: { tags: ['demo'] } }),
    true,
  );
});

test('MarketplaceCall skips a test call with no Customer, and projects a real one', () => {
  const base = {
    id: 'int_1',
    organizationId: ORG,
    provider: 'callgrid',
    externalId: 'cg_1',
    channel: 'PHONE',
    occurredAt: new Date('2026-09-15T14:05:00.000Z'),
  };
  assert.equal(projectInteractionToMarketplaceCall({ ...base, metadata: { caller: '+13125550142' } }), null);
  assert.ok(projectInteractionToMarketplaceCall({ ...base, metadata: { caller: '+13128675309' } }));
});

// --- Live Calls ------------------------------------------------------------------------

async function withInteractions(rows: Row[]) {
  const prisma: Row = makeCognitivePrisma({ also: ['interaction'] });
  for (const r of rows) await prisma.interaction.create({ data: { organizationId: ORG, ...r } });
  return prisma;
}

test('Live Calls lists an unidentified real call and leaves out a test call', async () => {
  const now = new Date();
  const prisma = await withInteractions([
    { id: 'int_real', channel: 'PHONE', kind: 'PHONE_CALL', direction: 'INBOUND', provider: 'callgrid', externalId: 'cg-real', occurredAt: now, metadata: { fromNumber: '+13128675309', eventType: 'call.inbound' } },
    { id: 'int_test', channel: 'PHONE', kind: 'PHONE_CALL', direction: 'INBOUND', provider: 'callgrid', externalId: 'cg-test', occurredAt: now, metadata: { fromNumber: '+13125550142', eventType: 'call.inbound' } },
  ]);
  const calls = await new LiveOperationsRepository(prisma as never).listLiveCalls(ORG);
  assert.deepEqual(calls.map((c) => c.id), ['int_real']);
  assert.equal(calls[0]!.caller, '+13128675309');
  assert.equal(calls[0]!.customerId, null);
});


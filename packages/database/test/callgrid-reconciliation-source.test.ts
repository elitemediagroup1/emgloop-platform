// The reconcile route's view of a raw CallGrid API record -- against the REAL list
// endpoint shape.
//
// The route read money under the webhook template's spellings (revenue, payout, profit)
// while the list endpoint it actually calls returns CallRevenue, CallPayout and
// CallProfit. Every money figure it compared was therefore blank, and its money-unit
// verdict could only ever say "indeterminate". These pin the fix, and the neighbours
// that sit beside revenue, so fixing one does not leave the others wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickField } from '@emgloop/providers';

import { CALLGRID_SOURCE_FIELDS, callGridSourceCallFromRecord } from '../src/services/callgrid-reconciliation-source';

/**
 * A production REST record in the VERIFIED list-endpoint shape (the same fixture as
 * providers/test/callgrid-rest-contract.test.ts: keys observed in a 19-record get-calls
 * sample, 2026-08-20), here with a settled call's money.
 */
function listRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cmsns65v8be2d07k368ox69s9',
    createdAt: '2026-08-10T21:58:57.245Z',
    UTCUnixTimeMs: 1786399137000,
    callStatus: 'COMPLETED',
    callDuration: 185,
    CallerId: '+15551234567',
    VendorName: '1039 - Ifficient',
    BuyerName: 'CEM',
    CampaignName: 'FE Inbounds RTB',
    campaignId: 'cmng68vp2001d06inikyf6zqh',
    buyerId: 'buy-1',
    sourceId: 'src-1',
    destinationId: 'dst-1',
    SourceName: 'Ifficient Direct',
    DestinationName: 'CEM Main',
    DestinationNumber: '+15559876543',
    Duplicate: false,
    CallRevenue: '32.50',
    CallPayout: '20.00',
    CallProfit: '12.50',
    converted: 0,
    outcome: null,
    ...over,
  };
}

test('the old spellings found none of the list endpoint’s money -- the defect, proven', () => {
  const r = listRecord();
  assert.equal(pickField(r, ['revenue', 'Revenue']), undefined);
  assert.equal(pickField(r, ['payout', 'Payout']), undefined);
  assert.equal(pickField(r, ['profit', 'Profit', 'net_profit']), undefined);
});

test('9. CallRevenue is read, as CallGrid stated it', () => {
  const s = callGridSourceCallFromRecord(listRecord());
  assert.equal(s.revenue, 32.5);
});

test('10. CallPayout, CallProfit and CallCost are read beside it, and the rest of the record still maps', () => {
  const s = callGridSourceCallFromRecord(listRecord({ CallCost: '0.04' }));
  assert.equal(s.payout, 20);
  assert.equal(s.profit, 12.5, 'CallGrid Profit = Revenue - Payout');
  assert.equal(s.cost, 0.04);
  assert.equal(s.call_id, 'cmsns65v8be2d07k368ox69s9');
  assert.equal(s.started_at, new Date(1786399137000).toISOString());
  assert.equal(s.duration_seconds, 185);
  assert.equal(s.buyer, 'CEM');
  assert.equal(s.campaign, 'FE Inbounds RTB');
  assert.equal(s.source, 'Ifficient Direct');
});

test('absence stays absent: no CallCost on the list endpoint is unknown, not zero', () => {
  const s = callGridSourceCallFromRecord(listRecord());
  assert.equal(s.cost, null);
  assert.equal(callGridSourceCallFromRecord(listRecord({ CallRevenue: 'N/A' })).revenue, null);
  assert.equal(callGridSourceCallFromRecord(listRecord({ CallRevenue: '0' })).revenue, 0, 'a stated zero is a zero');
});

test('Net Profit is never compared as Profit: net_profit is not read into the Profit field', () => {
  const s = callGridSourceCallFromRecord(listRecord({ CallProfit: undefined, net_profit: '12.46' }));
  assert.equal(s.profit, null);
  assert.equal(s.netProfit, undefined, 'no Net Profit key has been observed on the list endpoint, so none is guessed');
  assert.equal((CALLGRID_SOURCE_FIELDS.profit as readonly string[]).includes('net_profit'), false);
});

test('the webhook template’s spellings are still read, so either record shape reconciles', () => {
  const s = callGridSourceCallFromRecord({ id: 'cg-1', occurredAtUnix: '1758196800', revenue: '25.00', payout: '10.00', cost: '0.04', profit: '15.00', buyerName: 'Buyer One' });
  assert.deepEqual([s.revenue, s.payout, s.cost, s.profit, s.buyer], [25, 10, 0.04, 15, 'Buyer One']);
});

test('the verified list-endpoint spelling is tried first for every money field', () => {
  assert.equal(CALLGRID_SOURCE_FIELDS.revenue[0], 'CallRevenue');
  assert.equal(CALLGRID_SOURCE_FIELDS.payout[0], 'CallPayout');
  assert.equal(CALLGRID_SOURCE_FIELDS.profit[0], 'CallProfit');
  assert.equal(CALLGRID_SOURCE_FIELDS.cost[0], 'CallCost');
});

test('the reconcile route uses this mapping, and spells no money field of its own', () => {
  const route = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', '..', 'apps', 'web', 'src', 'app', 'api', 'integrations', 'callgrid', 'reconcile', 'route.ts'),
    'utf8',
  ) as string;
  assert.match(route, /\.map\(callGridSourceCallFromRecord\)/);
  for (const spelling of ["['revenue', 'Revenue']", "['payout', 'Payout']", "'net_profit'"]) {
    assert.equal(route.includes(spelling), false, spelling);
  }
});

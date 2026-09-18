// CallGrid's three near-simultaneous webhooks for one call -- Ended, Billable and
// Payable -- as the adapter reads them, field by field.
//
// WHAT CALLGRID CALLS THEM. The webhook `event` vocabulary in CallGrid's own API
// reference (https://api.callgrid.com/openapi, Webhook.event) is CALL_INBOUND,
// CALL_INITIATED, CALL_ENDED, CALL_ERROR, CALL_ANSWERED, CALL_BILLABLE, CALL_PAID,
// CALL_CONVERTED, INSIGHTS_COMPLETED, TRANSCRIPTION_COMPLETED, RECORDING_COMPLETED,
// BID_RECEIVED and POSTBACK_RECEIVED. "Payable" in CallGrid's UI is CALL_PAID; there
// is no CALL_PAYABLE.
//
// WHAT LOOP CLASSIFIES BY. Not the event name: the confirmed webhook template
// (docs/CALLGRID_WEBHOOK_CONTRACT.md) carries NO event-name field at all. Each
// delivery carries the CALL's status (`callStatus`, tag CallStatus), and that is what
// is classified -- so the Ended, Billable and Payable deliveries of one completed call
// are all `call.completed`, one call observed three times. These pin that, and exactly
// how each economic field is read, including what zero and absence mean.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CallGridProvider, mapCallgridEventType } from '../src/adapters/callgrid.provider';
import type { ProviderContext } from '../src/types';

const CTX: ProviderContext = { organizationId: 'org_1' };
const provider = new CallGridProvider();
const CALL_ID = 'cmsns65v8be2d07k368ox69s9';

/** The confirmed template: every value a quoted string. */
function delivery(over: Record<string, string>): Record<string, string> {
  return {
    id: CALL_ID,
    callStatus: 'COMPLETED',
    occurredAtUnix: '1758196800',
    callerId: '+13057712408',
    vendorId: 'v1', vendorName: 'Vendor One',
    buyerId: 'b1', buyerName: 'Buyer One',
    campaignId: 'c1', campaignName: 'Campaign One',
    sourceId: 's1', sourceName: 'Source One',
    durationSeconds: '185',
    completed: 'true', noRoute: 'false', converted: 'false',
    cost: '0.04',
    ...over,
  };
}

const ENDED = delivery({ revenue: '0', payout: '0', profit: '0', billable: 'false', paid: 'false' });
const BILLABLE = delivery({ revenue: '25.00', payout: '0', profit: '25.00', billable: 'true', paid: 'false' });
const PAYABLE = delivery({ revenue: '25.00', payout: '10.00', profit: '15.00', billable: 'true', paid: 'true' });

async function parse(payload: Record<string, unknown>) {
  const events = await provider.parseWebhook(CTX, payload);
  assert.equal(events.length, 1, 'one webhook, one event');
  return events[0]!;
}

test('7. Ended, Billable and Payable are the SAME call, each classified by the call’s status', async () => {
  const parsed = await Promise.all([ENDED, BILLABLE, PAYABLE].map(parse));
  for (const ev of parsed) {
    assert.equal(ev.externalId, CALL_ID, 'one CallId, so one call');
    assert.equal(ev.rawEventType, 'COMPLETED');
    assert.equal(mapCallgridEventType(ev.rawEventType), 'call.completed');
    assert.equal(ev.occurredAt.toISOString(), '2025-09-18T12:00:00.000Z', 'the same occurrence');
  }
});

test('7. an event name beside the call status never overrides it', async () => {
  for (const event of ['CALL_ENDED', 'CALL_BILLABLE', 'CALL_PAID', 'CALL_CONVERTED', 'POSTBACK_RECEIVED']) {
    const ev = await parse({ ...BILLABLE, event });
    assert.equal(mapCallgridEventType(ev.rawEventType), 'call.completed', event);
  }
});

test('7. the call statuses CallGrid reports classify to lifecycle events, case-insensitively', () => {
  assert.equal(mapCallgridEventType('COMPLETED'), 'call.completed');
  assert.equal(mapCallgridEventType('completed'), 'call.completed');
  assert.equal(mapCallgridEventType('ENDED'), 'call.completed');
  assert.equal(mapCallgridEventType('NO_ANSWER'), 'call.missed');
});

test('5. every economic field is read as a number, and a stated zero stays a zero', async () => {
  const p = (await parse(PAYABLE)).payload;
  assert.deepEqual([p.revenue, p.payout, p.cost, p.telco, p.profit], [25, 10, 0.04, 0.04, 15]);
  assert.deepEqual([p.billable, p.paid, p.converted, p.qualified], [true, true, false, true]);
  const ended = (await parse(ENDED)).payload;
  assert.deepEqual([ended.revenue, ended.payout, ended.profit], [0, 0, 0], 'zero is what CallGrid said');
  assert.equal(ended.qualified, false, 'billable, paid and converted all stated false');
});

test('5. an omitted or unreadable field is ABSENT from the canonical payload -- never a fabricated zero', async () => {
  const omitted: Record<string, string> = { ...BILLABLE };
  for (const k of ['revenue', 'payout', 'cost', 'profit', 'billable', 'paid']) delete omitted[k];
  const p = (await parse(omitted)).payload;
  for (const k of ['revenue', 'payout', 'cost', 'telco', 'profit', 'billable', 'paid']) assert.equal(p[k], undefined, k);

  const junk = (await parse({ ...BILLABLE, revenue: '', payout: 'N/A' })).payload;
  assert.equal(typeof junk.revenue === 'number', false, 'an empty revenue is not a number');
  assert.equal(typeof junk.payout === 'number', false, '"N/A" is not a number');
});

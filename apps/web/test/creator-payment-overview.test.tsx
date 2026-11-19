import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EarningsView } from '@emgloop/database';
import { creatorPaymentEarnings } from '../src/creator/creator-earnings';
const totals = {
  EXPECTED: 0,
  PENDING: 100,
  RECEIVED_BY_EMG: 0,
  AVAILABLE: 0,
  TRANSFER_PENDING: 0,
  PAID: 0,
};
const view: EarningsView = {
  currency: 'USD',
  totals,
  availableMinor: 0,
  seeded: false,
  payoutState: '',
  entries: [
    {
      id: 'entry',
      description: 'test',
      amountMinor: 100,
      currency: 'USD',
      state: 'PENDING',
      stateLabel: 'Pending',
      payable: false,
      occurredAt: '2026-11-19T01:00:00Z',
      source: 'EMG_APPROVED',
      campaignName: null,
      deliverableTitle: null,
    },
  ],
};
const row = {
  id: 'payout',
  compensationEntryId: 'entry',
  description: 'test',
  amountMinor: 100,
  state: 'AVAILABLE',
  approvedAt: new Date('2026-11-19T01:00:00Z'),
  requestedAt: null,
};
test('payout states replace original compensation, without double counting, in live totals', () => {
  const available = creatorPaymentEarnings(view, { environment: 'production', earnings: [row] });
  assert.equal(available.entries.length, 1);
  assert.equal(available.totals.PENDING, 0);
  assert.equal(available.availableMinor, 100);
  for (const state of ['REQUESTED', 'PROCESSING', 'PAID', 'RETURNED', 'CANCELLED']) {
    const result = creatorPaymentEarnings(view, {
      environment: 'production',
      earnings: [{ ...row, state }],
    });
    assert.equal(result.availableMinor, 0);
    assert.equal(
      result.totals.TRANSFER_PENDING,
      ['REQUESTED', 'PROCESSING'].includes(state) ? 100 : 0,
    );
    assert.equal(result.totals.PAID, state === 'PAID' ? 100 : 0);
    assert.equal(result.entries.length, state === 'CANCELLED' ? 0 : 1);
  }
});
test('sandbox shows only scoped test payouts and never includes unrelated demo or real earnings', () => {
  const sandbox = creatorPaymentEarnings(
    {
      ...view,
      entries: [
        ...view.entries,
        { ...view.entries[0]!, id: 'unrelated-demo', source: 'SEEDED_DEMO', amountMinor: 99999 },
      ],
    },
    { environment: 'sandbox', earnings: [{ ...row, compensationEntryId: 'sandbox-entry' }] },
  );
  assert.equal(sandbox.entries.length, 1);
  assert.equal(sandbox.entries[0]?.source, 'SANDBOX_PAYOUT');
  assert.equal(sandbox.availableMinor, 100);
  const live = creatorPaymentEarnings(
    { ...view, entries: [{ ...view.entries[0]!, source: 'SEEDED_DEMO' }] },
    null,
  );
  assert.equal(live.entries.length, 0);
});

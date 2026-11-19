import type { EarningsView } from '@emgloop/database';
/** Production balances exclude demonstration entries and never add unlike currencies. */
export function realCreatorEarnings(view: EarningsView, requestedCurrency?: string): EarningsView {
  const real = view.entries.filter((entry) => entry.source !== 'SEEDED_DEMO');
  const currencies = [...new Set(real.map((entry) => entry.currency))];
  const currency =
    requestedCurrency && currencies.includes(requestedCurrency)
      ? requestedCurrency
      : currencies.includes('USD')
        ? 'USD'
        : (currencies[0] ?? view.currency);
  const entries = real.filter((entry) => entry.currency === currency);
  const totals: EarningsView['totals'] = {
    EXPECTED: 0,
    PENDING: 0,
    RECEIVED_BY_EMG: 0,
    AVAILABLE: 0,
    TRANSFER_PENDING: 0,
    PAID: 0,
  };
  for (const entry of entries) totals[entry.state] += entry.amountMinor;
  return { ...view, currency, entries, totals, availableMinor: totals.AVAILABLE, seeded: false };
}

/** Replace linked compensation rows with the current payout projection; never sum them twice. */
export function creatorPaymentEarnings(
  view: EarningsView,
  payout: {
    environment: string;
    earnings: readonly {
      id: string;
      compensationEntryId: string;
      description: string;
      amountMinor: number;
      state: string;
      approvedAt: Date;
      requestedAt: Date | null;
    }[];
  } | null,
  requestedCurrency?: string,
): EarningsView {
  if (!payout) return realCreatorEarnings(view, requestedCurrency);
  const linked = new Set(payout.earnings.map((row) => row.compensationEntryId));
  const entries: EarningsView['entries'][number][] =
    payout.environment === 'sandbox'
      ? []
      : view.entries.filter((row) => row.source !== 'SEEDED_DEMO' && !linked.has(row.id));
  for (const row of payout.earnings) {
    if (row.state === 'CANCELLED') continue;
    const state =
      row.state === 'AVAILABLE'
        ? 'AVAILABLE'
        : row.state === 'PAID'
          ? 'PAID'
          : ['REQUESTED', 'PROCESSING'].includes(row.state)
            ? 'TRANSFER_PENDING'
            : 'PENDING';
    const stateLabel =
      (
        {
          AVAILABLE: 'Approved · ready to request',
          PAID: 'Sent to your bank',
          REQUESTED: 'Transfer requested',
          PROCESSING: 'Transfer in progress',
          REVIEW: 'EMG review required',
          RETURNED: 'Returned · EMG review required',
          PENDING: 'Awaiting manager release',
        } as Record<string, string>
      )[row.state] ?? 'EMG review required';
    entries.push({
      id: row.compensationEntryId,
      description: row.description,
      amountMinor: row.amountMinor,
      currency: 'USD',
      state,
      stateLabel,
      payable: row.state === 'AVAILABLE',
      occurredAt: (row.requestedAt ?? row.approvedAt).toISOString(),
      source: payout.environment === 'sandbox' ? 'SANDBOX_PAYOUT' : 'EMG_APPROVED',
      campaignName: null,
      deliverableTitle: null,
    });
  }
  return realCreatorEarnings({ ...view, entries }, requestedCurrency);
}

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

// A raw CallGrid API call record, as the reconciliation harness compares it. PURE.
//
// WHY THIS IS ITS OWN FUNCTION. The reconcile route used to spell these field names
// inline, "from the confirmed webhook template" -- but the route reads the REST LIST
// endpoint, which spells money differently. The list endpoint returns CallRevenue,
// CallPayout and CallProfit (verified on a 19-record get-calls sample, #179); the
// route looked for revenue/Revenue, payout/Payout and profit/Profit, so every
// money figure it compared was blank and every revenue check read "indeterminate".
// A mapping nobody could test drifted; this one is tested against a realistic record.
//
// RAW, ON PURPOSE. Reconciliation compares Loop against what CallGrid SENT, before
// Loop's own interpretation, so this does not reuse the ingestion mapper. It only
// reads the provider's own spellings -- the verified list-endpoint key first, then
// the webhook-template and legacy spellings, which cost nothing when absent.
//
// PROFIT MEANS CALLGRID'S PROFIT. CallProfit is Revenue - Payout; telco cost is not
// subtracted (the harness's business definitions). The old alias list also accepted
// `net_profit`, which is a DIFFERENT quantity -- Revenue - Payout - Cost -- and
// would have been compared as if it were Profit. It is gone. No Net Profit key has
// been observed on the list endpoint, so `netProfit` is left unset rather than
// guessed.

import { pickField, resolveCallOccurrence, toNumber } from '@emgloop/providers';

import type { CallGridSourceCall } from './callgrid-reconciliation.harness';

/** The provider spellings read for each compared field, verified list-endpoint key first. */
export const CALLGRID_SOURCE_FIELDS = Object.freeze({
  callId: ['id', 'CallId', 'Id', 'call_id', 'callId'],
  // CallDuration = CONNECTED duration. BillableDuration is a different quantity and
  // is deliberately not accepted as a fallback.
  duration: ['callDuration', 'CallDuration', 'Duration', 'duration'],
  revenue: ['CallRevenue', 'revenue', 'Revenue'],
  payout: ['CallPayout', 'payout', 'Payout'],
  // CallCost was not observed on the list endpoint (the REST mapper keeps it as a
  // defensive spelling for the single-call detail contract); read it the same way.
  cost: ['CallCost', 'cost', 'Cost'],
  profit: ['CallProfit', 'profit', 'Profit'],
  buyer: ['BuyerName', 'buyerName', 'buyer'],
  campaign: ['CampaignName', 'campaignName', 'campaign'],
  source: ['SourceName', 'sourceName', 'source'],
} as const);

const numberFrom = (record: Record<string, unknown>, keys: readonly string[]): number | null =>
  toNumber(pickField(record, [...keys])) ?? null;

/** One raw CallGrid API call record, in the harness's source shape. */
export function callGridSourceCallFromRecord(record: Record<string, unknown>): CallGridSourceCall {
  const f = CALLGRID_SOURCE_FIELDS;
  return {
    call_id: pickField(record, [...f.callId]) ?? '',
    // Canonical precedence: UTCUnixTimeMs > UTCISODate > UTCUnixTime > legacy.
    // `createdAt` is record-creation time and is never consulted.
    started_at: resolveCallOccurrence(record).at?.toISOString() ?? '',
    duration_seconds: numberFrom(record, f.duration),
    revenue: numberFrom(record, f.revenue),
    payout: numberFrom(record, f.payout),
    cost: numberFrom(record, f.cost),
    profit: numberFrom(record, f.profit),
    buyer: pickField(record, [...f.buyer]) ?? null,
    campaign: pickField(record, [...f.campaign]) ?? null,
    source: pickField(record, [...f.source]) ?? null,
    qualified: null,
    converted: null,
    duplicate: null,
  };
}

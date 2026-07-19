// MarketplaceCall — pure projection mapper (no I/O, no Prisma, fully testable).
//
// Projects ONE raw Interaction (the audit record) into the normalized,
// sensor-neutral MarketplaceCall shape the Intelligence layer reads. Pure by
// construction: given the same Interaction it returns the same projection, so
// re-projecting is idempotent at the value level and the repository's upsert is
// idempotent at the row level.
//
// Honesty invariants enforced HERE, in one place:
//   • Money is integer CENTS (source values are decimal dollars → ×100).
//   • A value the sensor never supplied stays `null` — NEVER defaulted to 0/false.
//     (This is why every numeric/boolean reader has an *OrNull variant.)
//   • Attribution is nullable external-reference ids + best-known labels; no
//     Buyer/Vendor/Source/Campaign entity is assumed.
//   • CallGrid is not special: the mapper gates on "is a phone call with an
//     external id", carrying whatever `provider` (sensor) produced it.

import { realAttr } from './operational-filters';
import type { CustomerLike } from './operational-filters';
import { isExcludedCustomer } from './operational-filters';

/** The minimal Interaction view the mapper needs (keeps it Prisma-free/testable). */
export interface InteractionForProjection {
  id: string;
  organizationId: string;
  provider: string | null;
  externalId: string | null;
  channel: string;
  occurredAt: Date;
  metadata: unknown;
  customer?: CustomerLike | null;
}

/** The normalized projection — exactly the writable MarketplaceCall columns. */
export interface MarketplaceCallProjection {
  organizationId: string;
  provider: string;
  externalId: string;
  interactionId: string;
  sourceOccurredAt: Date;
  status: string | null;
  rawStatus: string | null;
  endedBy: string | null;
  connectedDurationSeconds: number | null;
  buyerExternalId: string | null;
  buyerLabel: string | null;
  vendorExternalId: string | null;
  vendorLabel: string | null;
  sourceExternalId: string | null;
  sourceLabel: string | null;
  campaignExternalId: string | null;
  campaignLabel: string | null;
  destinationExternalId: string | null;
  callerState: string | null;
  callerZip: string | null;
  revenueCents: number | null;
  payoutCents: number | null;
  costCents: number | null;
  rateCents: number | null;
  monetized: boolean | null;
  billable: boolean | null;
  converted: boolean | null;
  paid: boolean | null;
  completed: boolean | null;
  noRoute: boolean | null;
  duplicate: boolean | null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
/** String value or null (never ''). */
function strOrNull(v: unknown): string | null {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}
/** Finite number or null — absence is null, NOT 0. */
function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}
/** Boolean or null — absence is null, NOT false. */
function boolOrNull(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return null;
}
/** Decimal-dollar value → integer cents, or null when absent. */
function centsOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n === null ? null : Math.round(n * 100);
}

/**
 * Project an Interaction into a MarketplaceCall. Returns null when the row is
 * not a projectable call: not a phone interaction, no provider/externalId to be
 * idempotent on, or an excluded demo/QA record. Null is a skip, never an error.
 */
export function projectInteractionToMarketplaceCall(
  it: InteractionForProjection,
): MarketplaceCallProjection | null {
  if (it.channel !== 'PHONE') return null;
  const provider = strOrNull(it.provider);
  const externalId = strOrNull(it.externalId);
  if (!provider || !externalId) return null;
  if (isExcludedCustomer(it.customer)) return null;

  const m = obj(it.metadata);

  return {
    organizationId: it.organizationId,
    provider,
    externalId,
    interactionId: it.id,
    sourceOccurredAt: it.occurredAt,
    status: strOrNull(m.eventType),
    rawStatus: strOrNull(m.callStatus) ?? strOrNull(m.status),
    endedBy: strOrNull(m.endedBy),
    connectedDurationSeconds: numOrNull(m.durationSeconds),
    buyerExternalId: strOrNull(m.buyerId),
    buyerLabel: realAttr(strOrNull(m.buyer)),
    vendorExternalId: strOrNull(m.vendorId),
    vendorLabel: realAttr(strOrNull(m.vendor)),
    sourceExternalId: strOrNull(m.sourceId),
    sourceLabel: realAttr(strOrNull(m.source)),
    campaignExternalId: strOrNull(m.campaignId),
    campaignLabel: realAttr(strOrNull(m.campaign)),
    destinationExternalId: strOrNull(m.destinationId),
    callerState: strOrNull(m.callerState),
    callerZip: strOrNull(m.callerZip),
    revenueCents: centsOrNull(m.revenue),
    payoutCents: centsOrNull(m.payout),
    // 'cost' is telco cost; 'telco' is its mirror — prefer 'cost'.
    costCents: centsOrNull(m.cost ?? m.telco),
    rateCents: centsOrNull(m.rate),
    // The metadata KEY stays `qualified` — it is stored historical payload and
    // cannot be rewritten. The canonical field is honestly named.
    monetized: boolOrNull(m.qualified),
    billable: boolOrNull(m.billable),
    converted: boolOrNull(m.converted),
    paid: boolOrNull(m.paid),
    completed: boolOrNull(m.completed),
    noRoute: boolOrNull(m.noRoute),
    duplicate: boolOrNull(m.duplicate),
  };
}

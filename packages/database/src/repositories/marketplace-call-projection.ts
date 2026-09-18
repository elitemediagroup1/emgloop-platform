// MarketplaceCall — pure projection mapper (no I/O, no Prisma, fully testable).
//
// Projects ONE observation of a call -- an Interaction (the audit record), or a
// provider delivery before its Interaction exists -- into the normalized,
// sensor-neutral MarketplaceCall shape the Intelligence layer reads. Pure by
// construction: the same observation always yields the same projection.
//
// AND MERGES AN OBSERVATION INTO THE CALL ALREADY STORED, never over it
// (`convergeCallObservation`). CallGrid delivers one call several times at once
// -- Ended, Billable and Payable fire together -- and in any order. The first
// observation to reach the table creates the row as the provider stated it; every
// later one may only strengthen it, one fact at a time, by the shared rule in
// @emgloop/shared (`convergeFact`). A weaker, earlier or duplicate observation
// can never erase a settled fact, and no observation overwrites the row.
//
// Honesty invariants enforced HERE, in one place:
//   • Money is integer CENTS (source values are decimal dollars → ×100).
//   • A value the sensor never supplied stays `null` — NEVER defaulted to 0/false.
//     (This is why every numeric/boolean reader has an *OrNull variant.)
//   • Attribution is nullable external-reference ids + best-known labels; no
//     Buyer/Vendor/Source/Campaign entity is assumed.
//   • CallGrid is not special: the mapper gates on "is a phone call with an
//     external id", carrying whatever `provider` (sensor) produced it.

import { CALLGRID_FACT_KINDS, convergeFact, type FactConvergence } from '@emgloop/shared';

import { realAttr } from './operational-filters';
import type { CustomerLike } from './operational-filters';
import { isExcludedInteraction } from './operational-filters';

/** The minimal Interaction view the mapper needs (keeps it Prisma-free/testable). */
export interface InteractionForProjection {
  id: string;
  organizationId: string;
  provider: string | null;
  externalId: string | null;
  channel: string;
  occurredAt: Date;
  metadata: unknown;
  /** Set only by a rebuild over older Interactions that are linked to a Customer. */
  customer?: CustomerLike | null;
}

/**
 * One provider delivery, before (or without) the Interaction it will produce. Its
 * `metadata` is exactly what that Interaction would carry: the delivery's canonical
 * payload plus the canonical event type.
 */
export interface CallObservation {
  organizationId: string;
  provider: string | null;
  externalId: string | null;
  channel: string;
  occurredAt: Date;
  metadata: unknown;
  /** Null until normalization has produced the Interaction. */
  interactionId: string | null;
}

/** The normalized projection — exactly the writable MarketplaceCall columns. */
export interface MarketplaceCallProjection {
  organizationId: string;
  provider: string;
  externalId: string;
  /** Null when the call was first observed before its Interaction existed. */
  interactionId: string | null;
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
 * idempotent on, or demo/QA traffic, judged from the call's own identifiers.
 * Null is a skip, never an error.
 */
export function projectInteractionToMarketplaceCall(
  it: InteractionForProjection,
): MarketplaceCallProjection | null {
  return project({ ...it, interactionId: it.id });
}

/**
 * Project one provider delivery directly, before its Interaction exists. The SAME
 * mapper and the SAME exclusion rules as an Interaction: a delivery is judged by
 * its own facts, whichever path reaches the table first.
 */
export function projectCallObservation(observation: CallObservation): MarketplaceCallProjection | null {
  return project(observation);
}

function project(
  it: Omit<InteractionForProjection, 'id'> & { interactionId: string | null },
): MarketplaceCallProjection | null {
  if (it.channel !== 'PHONE') return null;
  const provider = strOrNull(it.provider);
  const externalId = strOrNull(it.externalId);
  if (!provider || !externalId) return null;
  if (isExcludedInteraction(it)) return null;

  const m = obj(it.metadata);

  return {
    organizationId: it.organizationId,
    provider,
    externalId,
    interactionId: it.interactionId,
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

// --- Merging an observation into the stored call --------------------------------

/** The stored columns a later observation may move. Nothing else is ever rewritten. */
export interface StoredCallFacts {
  interactionId: string | null;
  revenueCents: number | null;
  payoutCents: number | null;
  billable: boolean | null;
  paid: boolean | null;
  converted: boolean | null;
  monetized: boolean | null;
}

/**
 * The provider facts a later observation may strengthen, and the column each lives
 * in. How each one behaves is NOT decided here: the kind comes from
 * `CALLGRID_FACT_KINDS`, and the decision from `convergeFact`. Money is compared in
 * cents, the unit the column stores.
 *
 * DELIBERATELY SHORT, and the same list the rule classifies. Cost, labels,
 * geography, status and duration are not here: they keep what the first
 * observation stated, because no provider evidence says how they settle -- and
 * because nothing rewrites the row, a later observation cannot erase them either.
 */
const CONVERGED_FACTS = [
  ['revenue', 'revenueCents'],
  ['payout', 'payoutCents'],
  ['billable', 'billable'],
  ['paid', 'paid'],
  ['converted', 'converted'],
] as const;

export type ConvergedFact = (typeof CONVERGED_FACTS)[number][0];

export interface CallFactDecision {
  readonly fact: ConvergedFact;
  readonly existing: number | boolean | null;
  readonly converged: FactConvergence<number | boolean>;
}

export interface CallConvergencePlan {
  /** Only the columns this observation moves. Empty means nothing changes. */
  readonly update: Partial<StoredCallFacts>;
  /** Every provider fact's decision, for the revision record. */
  readonly decisions: readonly CallFactDecision[];
}

/**
 * What one observation may change about a call already stored. PURE.
 *
 *   * each provider fact goes through `convergeFact` with its classified kind: an
 *     amount settles upward from an ambiguous zero, a flag is asserted only when
 *     true, and two different settled amounts are a CONFLICT that writes nothing;
 *   * `monetized` is DERIVED (billable OR converted OR paid, as the adapter derives
 *     it), so it follows the flags: it becomes true when a flag does, and nothing
 *     ever makes it false;
 *   * the Interaction link is filled once, when normalization has produced it.
 */
export function convergeCallObservation(existing: StoredCallFacts, incoming: MarketplaceCallProjection): CallConvergencePlan {
  const update: Partial<StoredCallFacts> = {};
  const decisions: CallFactDecision[] = [];
  const after: Record<string, unknown> = { ...existing };

  for (const [fact, column] of CONVERGED_FACTS) {
    const converged = convergeFact<number | boolean>({
      kind: CALLGRID_FACT_KINDS[fact],
      existing: existing[column],
      incoming: incoming[column],
    });
    decisions.push({ fact, existing: existing[column], converged });
    if (converged.decision === 'UPDATE' && converged.value !== undefined) {
      (update as Record<string, unknown>)[column] = converged.value;
      after[column] = converged.value;
    }
  }

  const asserted = after.billable === true || after.paid === true || after.converted === true || incoming.monetized === true;
  if (asserted && existing.monetized !== true) update.monetized = true;

  if (existing.interactionId === null && incoming.interactionId !== null) update.interactionId = incoming.interactionId;

  return { update, decisions };
}

import 'server-only';

// Executive Briefing — CallGrid fact loader.
//
// Reads REAL, already-ingested CallGrid call data and aggregates it into the
// sensor-neutral `CallGridWindow` the intelligence module consumes. It invents
// nothing: every economic value is summed from `Interaction.metadata`, where the
// CallGrid adapter persists per-call revenue/payout/cost and buyer/vendor/
// source/campaign attribution (verified in the Phase-1 ingestion audit — there
// are no first-class economic columns; the data lives in JSON). Demo/QA records
// and fabricated attribution labels are excluded via the same honesty filters
// Revenue and Traffic Intelligence already use, so the briefing reads production
// truth only.
//
// UNIT ASSUMPTION: CallGrid reports revenue/payout/cost as decimal DOLLARS
// (e.g. 12.50). We convert to integer cents (×100) so the module's cents-based
// math is exact. Coverage counts record how many calls actually carried each
// value, so the module stays honest where a value was never sent.

import { prisma, realAttr, isExcludedCustomer } from '@emgloop/database';
import type { CallGridDimensionWindow, CallGridWindow } from '@emgloop/intelligence';

// --- metadata JSON readers (metadata is an untyped JSON blob) ---------------
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
/** A numeric value if present as a number or numeric string; else undefined. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
/** A boolean flag from a real boolean or the strings 'true'/'false'. */
function bool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return false;
}
function dollarsToCents(v: number | undefined): number | undefined {
  return v === undefined ? undefined : Math.round(v * 100);
}

interface DimAccum {
  key: string;
  label: string;
  calls: number;
  qualified: number;
  converted: number;
  revenueCents: number;
  payoutCents: number;
  costCents: number;
}

function bump(
  map: Map<string, DimAccum>,
  label: string | null,
  calls: number,
  qualified: number,
  converted: number,
  revenueCents: number,
  payoutCents: number,
  costCents: number,
): void {
  // Only REAL attribution forms a named dimension; unknown-attributed calls
  // still count in window totals but never become "optimize Unknown source".
  if (!label) return;
  const key = label.toLowerCase();
  const cur =
    map.get(key) ??
    { key, label, calls: 0, qualified: 0, converted: 0, revenueCents: 0, payoutCents: 0, costCents: 0 };
  cur.calls += calls;
  cur.qualified += qualified;
  cur.converted += converted;
  cur.revenueCents += revenueCents;
  cur.payoutCents += payoutCents;
  cur.costCents += costCents;
  map.set(key, cur);
}

function toDimensions(map: Map<string, DimAccum>): CallGridDimensionWindow[] {
  return [...map.values()]
    .map((d) => ({
      key: d.key,
      label: d.label,
      calls: d.calls,
      qualified: d.qualified,
      converted: d.converted,
      revenueCents: d.revenueCents,
      payoutCents: d.payoutCents,
      costCents: d.costCents,
    }))
    .sort((a, b) => b.revenueCents - a.revenueCents);
}

/**
 * Aggregate one window of CallGrid calls for an organization into a
 * `CallGridWindow`. Read-only; org-scoped; excludes demo/QA records. Returns a
 * zeroed window (calls: 0) when nothing matched — the module reads that as an
 * honest "Not enough data", never a fabricated $0 business.
 */
export async function loadCallGridWindow(
  organizationId: string,
  since: Date,
  until: Date,
): Promise<CallGridWindow> {
  const rows = await prisma.interaction.findMany({
    where: {
      organizationId,
      channel: 'PHONE',
      provider: 'callgrid',
      occurredAt: { gte: since, lt: until },
    },
    select: {
      metadata: true,
      customer: {
        select: { tags: true, email: true, phone: true, externalId: true, firstName: true, lastName: true },
      },
    },
  });

  let calls = 0;
  let qualified = 0;
  let converted = 0;
  let revenueCents = 0;
  let payoutCents = 0;
  let costCents = 0;
  let callsWithRevenue = 0;
  let callsWithPayout = 0;
  let callsWithCost = 0;

  const buyers = new Map<string, DimAccum>();
  const vendors = new Map<string, DimAccum>();
  const sources = new Map<string, DimAccum>();
  const campaigns = new Map<string, DimAccum>();

  for (const row of rows) {
    if (isExcludedCustomer(row.customer)) continue;
    const m = obj(row.metadata);

    const rev = dollarsToCents(num(m.revenue));
    const pay = dollarsToCents(num(m.payout));
    // 'cost' and its mirror 'telco' both represent telco cost; prefer 'cost'.
    const cost = dollarsToCents(num(m.cost) ?? num(m.telco));

    const isQualified = bool(m.qualified);
    const isConverted = bool(m.converted);

    calls += 1;
    if (isQualified) qualified += 1;
    if (isConverted) converted += 1;
    if (rev !== undefined) {
      revenueCents += rev;
      callsWithRevenue += 1;
    }
    if (pay !== undefined) {
      payoutCents += pay;
      callsWithPayout += 1;
    }
    if (cost !== undefined) {
      costCents += cost;
      callsWithCost += 1;
    }

    const rc = rev ?? 0;
    const pc = pay ?? 0;
    const cc = cost ?? 0;
    const q = isQualified ? 1 : 0;
    const cv = isConverted ? 1 : 0;

    bump(buyers, realAttr(typeof m.buyer === 'string' ? m.buyer : null), 1, q, cv, rc, pc, cc);
    bump(vendors, realAttr(typeof m.vendor === 'string' ? m.vendor : null), 1, q, cv, rc, pc, cc);
    bump(sources, realAttr(typeof m.source === 'string' ? m.source : null), 1, q, cv, rc, pc, cc);
    bump(campaigns, realAttr(typeof m.campaign === 'string' ? m.campaign : null), 1, q, cv, rc, pc, cc);
  }

  return {
    calls,
    qualified,
    converted,
    bookings: 0, // Downstream bookings are not attributed on this path; left 0 (unused by the module).
    revenueCents,
    payoutCents,
    costCents,
    callsWithRevenue,
    callsWithPayout,
    callsWithCost,
    buyers: toDimensions(buyers),
    vendors: toDimensions(vendors),
    sources: toDimensions(sources),
    campaigns: toDimensions(campaigns),
  };
}

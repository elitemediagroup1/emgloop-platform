import 'server-only';

// CallGrid dimension data — the ONE economics source for both the listings
// (discovery) and the per-entity pages (understanding).
//
// Buyers / Vendors / Sources / Campaigns all read from the same MarketplaceCall
// projection via aggregateWindow, so a row's `key` on a listing is exactly the
// key its detail page looks up — the listing and the entity page never disagree.
// Margin is derived here (revenue − payout − cost); it is never stored.
//
// Honest by construction: a failed read yields ok:false (the page shows "we
// could not reach the data", never a healthy-looking empty), and an absent
// economic value stays absent — callers format with money/*OrUnknown.

import { crmRepos } from '../../../../crm/crm-data';
import { loadOrFallback } from '../../../../demo/db-health';
import type { EntityTone } from '../../_loop-os';

const WINDOW_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

export type Dimension = 'buyers' | 'vendors' | 'sources' | 'campaigns';

export interface DimRow {
  key: string;
  label: string;
  calls: number;
  monetized: number;
  converted: number;
  revenueCents: number;
  payoutCents: number;
  costCents: number;
  marginCents: number;
}

export interface DimWindow {
  ok: boolean;
  windowLabel: string;
  rows: DimRow[];
  totalCalls: number;
  totalRevenueCents: number;
}

export interface DimWindows {
  current: DimWindow;
  prior: DimWindow;
}

/**
 * Load the current and prior `WINDOW_DAYS` windows for one dimension, rows
 * sorted by revenue. `now` is injected for reproducibility.
 */
export async function loadDimensionWindows(
  organizationId: string,
  dim: Dimension,
  now: Date = new Date(),
): Promise<DimWindows> {
  const until = now;
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY);
  const priorUntil = since;
  const priorSince = new Date(since.getTime() - WINDOW_DAYS * DAY);

  const [curR, priR] = await Promise.all([
    loadOrFallback(async () => crmRepos.marketplaceCalls.aggregateWindow(organizationId, since, until)),
    loadOrFallback(async () => crmRepos.marketplaceCalls.aggregateWindow(organizationId, priorSince, priorUntil)),
  ]);

  const mk = (r: typeof curR, label: string): DimWindow => {
    if (!r.ok) return { ok: false, windowLabel: label, rows: [], totalCalls: 0, totalRevenueCents: 0 };
    const agg = r.data;
    const rows: DimRow[] = agg[dim]
      .map((d) => ({
        key: d.key,
        label: d.label,
        calls: d.calls,
        monetized: d.monetized,
        converted: d.converted,
        revenueCents: d.revenueCents,
        payoutCents: d.payoutCents,
        costCents: d.costCents,
        marginCents: d.revenueCents - d.payoutCents - d.costCents,
      }))
      .sort((a, b) => b.revenueCents - a.revenueCents);
    return { ok: true, windowLabel: label, rows, totalCalls: agg.calls, totalRevenueCents: agg.revenueCents };
  };

  return { current: mk(curR, 'Last 7 days'), prior: mk(priR, 'Prior 7 days') };
}

export interface DimHealth {
  label: string;
  tone: EntityTone;
  line: string;
}

/** One entity's health, derived from its own economics. `subject` is the noun
 *  used in the sentence ("This source", "This buyer"). */
export function rowHealth(row: DimRow | null, subject: string): DimHealth {
  if (!row || row.calls === 0) {
    return { label: 'No recent data', tone: 'idle', line: `${subject} has no calls attributed in the last 7 days.` };
  }
  if (row.marginCents < 0) {
    return { label: 'At risk', tone: 'crit', line: `${subject} is returning less than it costs right now — margin is negative.` };
  }
  const rate = row.calls > 0 ? row.monetized / row.calls : 0;
  if (rate < 0.15) {
    return { label: 'Watch', tone: 'warn', line: `Few of ${subject.toLowerCase()}'s calls are monetizing (${Math.round(rate * 100)}% of ${row.calls}).` };
  }
  return { label: 'Healthy', tone: 'good', line: `${subject} has positive margin and steady monetization (${Math.round(rate * 100)}% of ${row.calls} calls).` };
}

/** Quick health for a listing row — just the tone, for a status dot. */
export function rowTone(row: DimRow): EntityTone {
  if (row.calls === 0) return 'idle';
  if (row.marginCents < 0) return 'crit';
  if (row.monetized / row.calls < 0.15) return 'warn';
  return 'good';
}

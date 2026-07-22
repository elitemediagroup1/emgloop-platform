// The CallGrid operational watch list — derived from CallGrid's own reporting, and
// nothing else. The Overview Watch List must surface ONLY CallGrid operational
// findings (revenue/volume decline, inactivity, and bid rejection/rate-limit/
// timeout patterns). It never carries active-user, team, integration, sensor or
// platform-health items — those belong to the Brain page, not here.
//
// Pure and evidence-backed: a finding is emitted only when its inputs are real
// numbers. Call-based findings respect the selected period (they compare the
// window to its comparison window); bid-based findings come from the latest
// synchronized snapshot and are flagged `snapshot: true` so the surface can say so.

import type { CallGridReport } from './callgrid-report';
import type { BidReport } from './bid-report';
import { money, num } from '../../_loop-os';

export interface WatchFinding {
  id: string;
  severity: 'critical' | 'high' | 'notable';
  category: string;
  text: string;
  /** True when the finding is from the latest bid snapshot, not the selected period. */
  snapshot?: boolean;
}

const SEV_RANK: Record<WatchFinding['severity'], number> = { critical: 0, high: 1, notable: 2 };

interface DimSpec { dim: 'buyers' | 'vendors' | 'campaigns'; noun: string; }
const REVENUE_DIMS: DimSpec[] = [
  { dim: 'buyers', noun: 'Buyer' },
  { dim: 'campaigns', noun: 'Campaign' },
];

/** Derive the operational watch list for the selected period. */
export function deriveCallGridWatch(report: CallGridReport, bid: BidReport): WatchFinding[] {
  const out: WatchFinding[] = [];

  // --- Call-based findings (respect the selected period) ---------------------
  if (report.ok) {
    for (const { dim, noun } of REVENUE_DIMS) {
      const rows = report.dimensions[dim];
      const prior = report.comparisonByKey[dim];
      const current = new Set(rows.map((r) => r.key));

      // Revenue decline vs the comparison window.
      const declines = rows
        .map((r) => {
          const p = prior.get(r.key);
          if (!p || p.revenueCents <= 0) return null;
          const change = Math.round(((r.revenueCents - p.revenueCents) / p.revenueCents) * 100);
          return change <= -25 ? { r, change } : null;
        })
        .filter((x): x is { r: (typeof rows)[number]; change: number } => x !== null)
        .sort((a, b) => a.change - b.change)
        .slice(0, 2);
      for (const { r, change } of declines) {
        out.push({
          id: `${dim}:decline:${r.key}`,
          severity: change <= -50 ? 'high' : 'notable',
          category: `${noun} revenue decline`,
          text: `${r.label} — revenue ${change}% to ${money(r.revenueCents)} vs the comparison period.`,
        });
      }

      // Inactivity: had revenue last window, nothing now.
      const inactive: { label: string; was: number }[] = [];
      for (const [key, p] of prior) {
        if (!current.has(key) && p.revenueCents > 0) inactive.push({ label: p.label, was: p.revenueCents });
      }
      for (const it of inactive.sort((a, b) => b.was - a.was).slice(0, 2)) {
        out.push({
          id: `${dim}:inactive:${it.label}`,
          severity: 'high',
          category: `${noun} inactivity`,
          text: `${it.label} — no activity this period (was ${money(it.was)} in the comparison period).`,
        });
      }
    }

    // Vendor volume decline (call volume, not revenue).
    const vRows = report.dimensions.vendors;
    const vPrior = report.comparisonByKey.vendors;
    const vDeclines = vRows
      .map((r) => {
        const p = vPrior.get(r.key);
        if (!p || p.calls <= 0) return null;
        const change = Math.round(((r.calls - p.calls) / p.calls) * 100);
        return change <= -25 ? { r, change } : null;
      })
      .filter((x): x is { r: (typeof vRows)[number]; change: number } => x !== null)
      .sort((a, b) => a.change - b.change)
      .slice(0, 2);
    for (const { r, change } of vDeclines) {
      out.push({
        id: `vendors:volume:${r.key}`,
        severity: change <= -50 ? 'high' : 'notable',
        category: 'Vendor volume decline',
        text: `${r.label} — call volume ${change}% to ${num(r.calls)} calls vs the comparison period.`,
      });
    }
  }

  // --- Bid-snapshot findings (latest synchronized snapshot) ------------------
  if (bid.ok && bid.hasData) {
    const dests = bid.destinations;
    for (const d of [...dests].sort((a, b) => (b.rateLimited ?? -1) - (a.rateLimited ?? -1)).slice(0, 1)) {
      if (d.rateLimited !== null && d.rateLimited > 0) {
        out.push({ id: `bid:ratelimit:${d.key}`, severity: 'high', category: 'Rate limiting', text: `${d.name} — ${num(d.rateLimited)} opportunities rate-limited. Review its throughput limit or routing weight.`, snapshot: true });
      }
    }
    for (const d of [...dests].sort((a, b) => (b.pingTimeout ?? -1) - (a.pingTimeout ?? -1)).slice(0, 1)) {
      if (d.pingTimeout !== null && d.pingTimeout > 0) {
        out.push({ id: `bid:timeout:${d.key}`, severity: 'notable', category: 'Bid timeouts', text: `${d.name} — ${num(d.pingTimeout)} pings timed out. Review its endpoint responsiveness.`, snapshot: true });
      }
    }
    for (const s of [...bid.sources].sort((a, b) => (b.rejections.duplicateBids ?? -1) - (a.rejections.duplicateBids ?? -1)).slice(0, 1)) {
      const dup = s.rejections.duplicateBids;
      if (dup !== null && dup > 0) {
        out.push({ id: `bid:dup:${s.key}`, severity: 'notable', category: 'Source duplicate-bid increase', text: `${s.name} — ${num(dup)} duplicate bids. Review its bidding configuration.`, snapshot: true });
      }
    }
    for (const s of bid.sources) {
      if (s.winRatePct !== null && s.bids !== null && s.bids >= 10 && s.winRatePct < 10) {
        out.push({ id: `bid:winrate:${s.key}`, severity: 'notable', category: 'Source rejection increase', text: `${s.name} — wins only ${s.winRatePct}% of ${num(s.bids)} bids. Review targeting and floor prices.`, snapshot: true });
      }
    }
  }

  return out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]).slice(0, 8);
}

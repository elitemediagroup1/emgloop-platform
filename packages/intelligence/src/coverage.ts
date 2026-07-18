// Marketplace Coverage — what the Brain knows, what it does not, and why.
//
// This is the truth center of the Executive Workspace. Its entire purpose is to
// make Loop's own limits legible, so an operator is never guessing whether a
// number is real.
//
// THE RULE THAT MAKES THIS HONEST: a capability's STATUS is always DERIVED from
// counted observations — never authored. A hardcoded "Bid Statistics:
// Unavailable" is the `crm/layout.tsx` "Brain Status: Online" anti-pattern
// wearing a new coat: a status string that cannot be wrong because nothing
// computes it. Every status below is a function of (observed, total).
//
// What IS authored is the *capability catalog*: which sensor supplies a thing,
// what evidence tier its absence sits in, and what it would unlock. That is
// documentation of the capability, not a claim about live state, and each entry
// carries the citation it was derived from so a reader can check it.
//
// Four statuses, because three would force a lie:
//   available     — every call examined carries it
//   partial       — some do (the ratio is stated, never rounded away)
//   unavailable   — none do, or Loop has no field for it at all
//   undetermined  — nothing was observed, so coverage CANNOT be judged
//
// `undetermined` is not a nicety. With zero calls ingested, "Bid Statistics:
// Unavailable" asserts a fact about a marketplace we have not looked at.
// Absent is absent; unknown is unknown. Never zero.

/** Derived posture of one capability. Never authored — always computed. */
export type CoverageStatus = 'available' | 'partial' | 'unavailable' | 'undetermined';

/**
 * WHY a capability is blocked. Each tier implies a genuinely different fix and a
 * different owner, which is the difference between this and a "coming soon" label.
 */
export type BlockedTier =
  /** Loop has the field; the sensor simply has not populated it on these calls. */
  | 'not-populated'
  /** Shape is documented and known; nothing in Loop maps it in. An adapter change. */
  | 'not-ingested'
  /** Shape is defined in code; no client or route fetches it; endpoint unconfirmed. */
  | 'not-fetched'
  /** No shape exists anywhere in Loop. Needs provider discovery before code. */
  | 'not-specified';

export interface CoverageRatio {
  /** Calls examined that carry this capability's data. */
  observed: number;
  /** Calls examined. */
  total: number;
}

/**
 * A capability Loop could know about a marketplace. Authored documentation —
 * NOT live state. `absent` describes a structural gap (no field exists in Loop),
 * which no amount of ingestion can fill, so such a capability can never be
 * reported as available however many calls arrive.
 */
export interface CapabilitySpec {
  id: string;
  label: string;
  /** The sensor that would supply this. Named so the operator knows who to ask. */
  provider: string;
  /** Present when Loop has no field for this at all. */
  absent?: {
    tier: Exclude<BlockedTier, 'not-populated'>;
    /** Stated as an observation about the codebase, not a claim about the vendor. */
    because: string;
    /** Where that observation can be checked. */
    citation: string;
    unblockedBy: string;
  };
  /**
   * Brain capabilities gated on this, as countable statements.
   * Deliberately NOT a percentage: "+15% Brain accuracy" would be the exact
   * fabrication this whole surface exists to eliminate.
   */
  unlocks: string[];
}

export interface CapabilityCoverage {
  id: string;
  label: string;
  provider: string;
  status: CoverageStatus;
  ratio: CoverageRatio | null;
  /** A factual statement of what was observed, with counts. Never a mood. */
  evidence: string;
  /** Why it is not fully available. Null when it is. */
  reason: string | null;
  unblockedBy: string | null;
  tier: BlockedTier | null;
  citation: string | null;
  unlocks: string[];
}

export interface MarketplaceCoverageInput {
  /** Human label for the window examined, e.g. 'Last 7 days'. */
  windowLabel: string;
  /** Calls examined in the window. Zero means coverage is undeterminable. */
  callsIngested: number;
  /** capabilityId → count of examined calls carrying that capability's data. */
  populated: Readonly<Record<string, number>>;
}

export interface MarketplaceCoverageReport {
  windowLabel: string;
  callsIngested: number;
  capabilities: CapabilityCoverage[];
  /** Counts by status, so a headline can be stated without recomputing. */
  totals: Record<CoverageStatus, number>;
}

/**
 * The capability catalog.
 *
 * Every `absent` entry below is grounded in docs/CALLGRID_MISSING_CAPABILITY_BLUEPRINT.md,
 * which classifies each missing capability by evidence tier. The distinction it
 * draws is the useful one: a documented-but-unmapped field is an afternoon's
 * adapter work, while an assumed-but-unconfirmed event needs a conversation with
 * the vendor before a line of code can be written honestly.
 */
export const MARKETPLACE_CAPABILITIES: readonly CapabilitySpec[] = [
  {
    id: 'calls',
    label: 'Calls',
    provider: 'CallGrid',
    unlocks: ['Every marketplace read — call volume is the denominator for all of them'],
  },
  {
    id: 'revenue',
    label: 'Revenue',
    provider: 'CallGrid',
    unlocks: ['Revenue headline', 'Margin and break-even risk rules'],
  },
  {
    id: 'payout',
    label: 'Payout',
    provider: 'CallGrid',
    unlocks: ['Margin per call (revenue − payout − cost)', 'Break-even window detection'],
  },
  {
    id: 'buyers',
    label: 'Buyers',
    provider: 'CallGrid',
    unlocks: ['Per-buyer performance', 'Buyer deterioration risk', 'Buyer-ready-to-scale opportunity'],
  },
  {
    id: 'vendors',
    label: 'Vendors',
    provider: 'CallGrid',
    unlocks: ['Per-vendor quality ranking'],
  },
  {
    id: 'sources',
    label: 'Sources',
    provider: 'CallGrid',
    unlocks: ['Per-source margin ranking', 'Scale-candidate detection', 'Pause recommendations'],
  },
  {
    id: 'campaigns',
    label: 'Campaigns',
    provider: 'CallGrid',
    unlocks: ['Per-campaign conversion and yield'],
  },
  {
    id: 'connectivity',
    label: 'Connectivity',
    provider: 'CallGrid',
    unlocks: ['Connect-failure risk rule', 'Routing-health evidence'],
  },
  {
    id: 'duplicates',
    label: 'Duplicate detection',
    provider: 'CallGrid',
    unlocks: ['Duplicate-rate risk rule', 'Honest de-duplicated volume'],
  },
  {
    id: 'recordings',
    label: 'Recordings',
    provider: 'CallGrid',
    absent: {
      tier: 'not-ingested',
      because:
        "CallGrid's webhook payload documents a recording URL, but Loop's adapter maps it to no field — the canonical call record has nowhere to put it.",
      citation: 'docs/CALLGRID_MISSING_CAPABILITY_BLUEPRINT.md §2.7; docs/integrations/CALLGRID.md',
      unblockedBy: 'Map the documented recording URL through the CallGrid adapter into a canonical field.',
    },
    unlocks: ['Call-quality review', 'Evidence links from a recommendation to the call itself'],
  },
  {
    id: 'transcripts',
    label: 'Transcripts',
    provider: 'CallGrid',
    absent: {
      tier: 'not-ingested',
      because:
        "CallGrid's webhook payload documents a transcript field, but Loop's adapter maps it to no field — nothing in Loop receives it.",
      citation: 'docs/CALLGRID_MISSING_CAPABILITY_BLUEPRINT.md §2.8; docs/integrations/CALLGRID.md',
      unblockedBy: 'Map the documented transcript field through the CallGrid adapter into a canonical field.',
    },
    unlocks: [
      'Call-content intelligence (objections, missed asks, script adherence)',
      'Qualification accuracy independent of the buyer’s own flag',
    ],
  },
  {
    id: 'bidStats',
    label: 'Bid statistics',
    provider: 'CallGrid',
    absent: {
      tier: 'not-fetched',
      because:
        'The report shape is defined in Loop code, but no client, route or scheduler fetches it, and the reporting endpoint is unconfirmed with CallGrid.',
      citation: 'docs/CALLGRID_MISSING_CAPABILITY_BLUEPRINT.md §2.3',
      unblockedBy:
        'Confirm the bid-report endpoint with CallGrid, then build the client and a scheduled sync.',
    },
    unlocks: [
      'Source win-rate and reject-rate scoring',
      'Separating "bid too low" from "blocked by tag rules" — different fixes',
    ],
  },
  {
    id: 'auctions',
    label: 'Auction data',
    provider: 'CallGrid',
    absent: {
      tier: 'not-specified',
      because:
        'No auction shape exists anywhere in Loop. The auction/ping event is assumed, not confirmed with CallGrid.',
      citation: 'docs/CALLGRID_MISSING_CAPABILITY_BLUEPRINT.md §2.1 [ASSUMED]',
      unblockedBy:
        'Confirm with CallGrid whether an auction event is available at all, and in what shape, before any schema is written.',
    },
    unlocks: [
      'Why a buyer won and at what price — the root of the optimization lifecycle',
      'Competition-depth and unwinnable-auction detection',
    ],
  },
] as const;

/** Classify one capability from counted observations. Pure and total. */
function classify(spec: CapabilitySpec, input: MarketplaceCoverageInput): CapabilityCoverage {
  const base = {
    id: spec.id,
    label: spec.label,
    provider: spec.provider,
    unlocks: [...spec.unlocks],
  };

  // A structural gap is true regardless of ingestion volume: no quantity of
  // calls can populate a field that does not exist. Reported before the
  // zero-calls check so it never masquerades as merely undetermined.
  if (spec.absent) {
    return {
      ...base,
      status: 'unavailable',
      ratio: null,
      evidence: `Loop has no field for ${spec.label.toLowerCase()} on its canonical call record.`,
      reason: spec.absent.because,
      unblockedBy: spec.absent.unblockedBy,
      tier: spec.absent.tier,
      citation: spec.absent.citation,
    };
  }

  // Nothing observed — we cannot judge coverage without lying about it.
  if (input.callsIngested <= 0) {
    return {
      ...base,
      status: 'undetermined',
      ratio: null,
      evidence: `No calls ingested in ${input.windowLabel.toLowerCase()}, so coverage cannot be determined.`,
      reason: 'Coverage is measured against ingested calls. With none, this is unknown — not zero.',
      unblockedBy: 'Ingest at least one marketplace call in this window.',
      tier: null,
      citation: null,
    };
  }

  const total = input.callsIngested;
  const observed = Math.max(0, Math.min(input.populated[spec.id] ?? 0, total));
  const ratio: CoverageRatio = { observed, total };

  if (observed === 0) {
    return {
      ...base,
      status: 'unavailable',
      ratio,
      evidence: `0 of ${total} calls examined carry ${spec.label.toLowerCase()}.`,
      reason: `Loop has a field for this, but the sensor populated it on none of the ${total} calls examined.`,
      unblockedBy: `Confirm with ${spec.provider} whether this field is being sent for this account.`,
      tier: 'not-populated',
      citation: null,
    };
  }

  if (observed === total) {
    return {
      ...base,
      status: 'available',
      ratio,
      evidence: `All ${total} calls examined carry ${spec.label.toLowerCase()}.`,
      reason: null,
      unblockedBy: null,
      tier: null,
      citation: null,
    };
  }

  return {
    ...base,
    status: 'partial',
    ratio,
    evidence: `${observed} of ${total} calls examined carry ${spec.label.toLowerCase()}.`,
    reason: `The sensor populated this on ${observed} of ${total} calls, so any figure derived from it covers part of the window only.`,
    unblockedBy: `Confirm with ${spec.provider} why this field is absent on ${total - observed} call(s).`,
    tier: 'not-populated',
    citation: null,
  };
}

/**
 * Build the coverage report. Pure, deterministic, no I/O and no clock — the
 * caller supplies the window and the counts.
 */
export function assessMarketplaceCoverage(
  input: MarketplaceCoverageInput,
  catalog: readonly CapabilitySpec[] = MARKETPLACE_CAPABILITIES,
): MarketplaceCoverageReport {
  const capabilities = catalog.map((spec) => classify(spec, input));
  const totals: Record<CoverageStatus, number> = {
    available: 0,
    partial: 0,
    unavailable: 0,
    undetermined: 0,
  };
  for (const c of capabilities) totals[c.status] += 1;
  return {
    windowLabel: input.windowLabel,
    callsIngested: input.callsIngested,
    capabilities,
    totals,
  };
}

/**
 * The highest-priority unblocking work, ranked.
 *
 * Ranked by how cheap the fix is, because that is the only ordering the
 * evidence actually supports: an unmapped-but-documented field is adapter work
 * Loop controls, while an unconfirmed event needs the vendor first. Deliberately
 * NOT ranked by "Brain improvement" — there is no measurement behind such a
 * number, and inventing one would be the fabrication this surface exists to end.
 */
const TIER_RANK: Record<BlockedTier, number> = {
  'not-populated': 0,
  'not-ingested': 1,
  'not-fetched': 2,
  'not-specified': 3,
};

export function rankUnblockingWork(report: MarketplaceCoverageReport): CapabilityCoverage[] {
  return report.capabilities
    .filter((c) => c.status === 'unavailable' || c.status === 'partial')
    .filter((c) => c.tier !== null)
    .sort((a, b) => {
      const byTier = TIER_RANK[a.tier!] - TIER_RANK[b.tier!];
      if (byTier !== 0) return byTier;
      // Within a tier, prefer the capability that unlocks more Brain behavior.
      return b.unlocks.length - a.unlocks.length;
    });
}

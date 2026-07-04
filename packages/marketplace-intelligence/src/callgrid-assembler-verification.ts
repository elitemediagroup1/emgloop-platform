// @emgloop/marketplace-intelligence — CallGrid Assembler verification harness (pure).
//
// PR #45 (Assembler verification). PR #44 introduced the CallGrid Assembler that
// projects already-reconciled CallGrid report rows (bidStats, bidStats/rejections,
// stats) into the canonical, provider-neutral Marketplace Intelligence model from
// PR #43. This module extends the exact PROOF pattern already established by
// packages/brain/src/call-handling-assembler-verification.ts to that assembler:
// it builds FIXED sample CallGrid rows, runs the REAL assembler functions over
// them, and checks invariants with a tiny internal assert helper, returning a
// structured report.
//
// Consistent with the repo's tooling (only 'typecheck'/'build' via turbo, no test
// runner — and none may be added), this is a set of PURE functions. It performs
// NO I/O, NO persistence, NO DB reads/writes, touches NO CallGrid path, uses NO
// LLM, adds NO UI/API, and is NOT wired into any runtime. It compiles as part of
// the normal typecheck/build; a caller or a future test runner may additionally
// invoke runCallGridAssemblerVerification() to execute the checks at runtime.

import {
  BRAIN_NOT_WIRED,
  toSourceIntelligence,
  toCampaignIntelligence,
  toBuyerIntelligence,
  toVendorIntelligence,
  toFunnel,
  toProfitability,
  assembleMarketplaceIntelligence,
} from './callgrid-assembler';
import type {
  CallGridReportInput,
  CallGridBidStatsRow,
  CallGridRejectionRow,
  CallGridStatsRow,
} from './callgrid-input';

// ---------------------------------------------------------------------------
// Tiny, framework-free assertion helper (mirrors the Brain harness style).
// ---------------------------------------------------------------------------

/** One recorded check. */
export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

/** The result of one named scenario (a group of checks). */
export interface ScenarioResult {
  scenario: string;
  checks: CheckResult[];
  passed: boolean;
}

/** The whole harness run. */
export interface VerificationReport {
  passed: boolean;
  total: number;
  failures: number;
  scenarios: ScenarioResult[];
}

/** A minimal check recorder — the entire "framework". Pure: it only accumulates
 * results into its own array. */
class Checker {
  readonly checks: CheckResult[] = [];
  ok(name: string, condition: boolean, detail?: string): void {
    this.checks.push({
      name,
      passed: condition,
      detail: condition ? undefined : detail ?? 'expected true',
    });
  }
  eq<T>(name: string, actual: T, expected: T): void {
    const passed = actual === expected;
    this.ok(name, passed, passed ? undefined : 'expected ' + String(expected) + ', got ' + String(actual));
  }
  /** Assert a value is strictly undefined (proves "missing stays missing"). */
  undef(name: string, actual: unknown): void {
    this.ok(name, actual === undefined, 'expected undefined, got ' + String(actual));
  }
  /** Assert two finite numbers are equal within a small epsilon (ratios/sums). */
  close(name: string, actual: number | undefined, expected: number): void {
    const passed = actual !== undefined && Math.abs(actual - expected) < 1e-9;
    this.ok(name, passed, 'expected ~' + expected + ', got ' + String(actual));
  }
}

function finalize(scenario: string, c: Checker): ScenarioResult {
  const passed = c.checks.every((x) => x.passed);
  return { scenario, checks: c.checks, passed };
}

// ---------------------------------------------------------------------------
// Deterministic fixtures — fixed CallGrid rows. No clock, no RNG.
// ---------------------------------------------------------------------------

const SCOPE = { organizationId: 'org_mi_verify', locationId: 'loc_mi_verify' };

/** A fixed report window (plain Dates, pinned). */
const WINDOW = {
  startAt: new Date('2025-01-01T00:00:00.000Z'),
  endAt: new Date('2025-01-07T23:59:59.000Z'),
  label: 'fixed_week',
};

/** Two bidStats rows with fully-specified metrics. */
export const BID_STATS_ROWS: CallGridBidStatsRow[] = [
  {
    sourceId: 'src-1',
    sourceName: 'Acme Traffic',
    bids: 1000,
    won: 250,
    total: 4000,
    rated: 900,
    rejected: 100,
    totalBidAmount: 1234.56,
    totalWonAmount: 456.78,
    avgBid: 1.03,
    avgWinningBid: 1.52,
    winRate: 25,
    bidRate: 30,
    rejectRate: 2.5,
  },
  {
    // sourceName omitted on purpose so we can prove name falls back to sourceId.
    sourceId: 'src-2',
    bids: 500,
    won: 100,
    total: 2000,
    rated: 480,
    rejected: 20,
  },
];

/** One rejection row for src-1 with a mix of present and zero reason counts. */
export const REJECTION_ROWS: CallGridRejectionRow[] = [
  {
    sourceId: 'src-1',
    source: { id: 'src-1', name: 'Acme Traffic' },
    rejected: 100,
    callerId: 40,
    closed: 0, // zero → must be dropped, not emitted as a reason
    paused: 3,
    duplicate: 55,
    duplicateBids: 0, // zero → dropped
    failedAcceptance: 2,
    // failedTagRules omitted (undefined) → dropped
  },
];

/** Stats rows across all three pivots, with fixed metric maps. */
export const STATS_ROWS: CallGridStatsRow[] = [
  {
    pivot: 'CampaignName',
    key: 'Spring Promo',
    keyId: 'camp-1',
    metrics: {
      total_revenue: 1000,
      total_payout: 400,
      total_cost: 100,
      telco: 25,
      gross_profit: 500,
      net_profit: 475,
      margin: 47.5,
      calls: 200,
      completed: 180,
      billable: 150,
      converted: 120,
    },
  },
  {
    pivot: 'BuyerName',
    key: 'Acme Insurance',
    keyId: 'buyer-1',
    metrics: {
      total_revenue: 600,
      total_payout: 250,
      // no total_cost on this row
      telco: 15,
      // no gross/net profit here → profit must be undefined for this buyer
      calls: 100,
      billable: 40,
      converted: 25,
    },
  },
  {
    pivot: 'VendorName',
    key: 'Vendor X',
    keyId: 'vendor-1',
    metrics: {
      total_revenue: 300,
      total_payout: 120,
      total_cost: 30,
      telco: 10,
      gross_profit: 150,
      // no net_profit → profit falls back to gross_profit (150)
    },
  },
];

/** The complete, fully-populated fixture input. */
export const FULL_INPUT: CallGridReportInput = {
  organizationId: SCOPE.organizationId,
  locationId: SCOPE.locationId,
  window: WINDOW,
  bidStats: BID_STATS_ROWS,
  rejections: REJECTION_ROWS,
  stats: STATS_ROWS,
};

/** A sparse input: a single bidStats row with only ids/bids, no rejections, no
 * stats — used to prove that absent evidence stays undefined and that unknown
 * funnel stages are omitted rather than zero-filled. */
export const SPARSE_INPUT: CallGridReportInput = {
  organizationId: SCOPE.organizationId,
  locationId: SCOPE.locationId,
  window: WINDOW,
  bidStats: [{ sourceId: 'src-sparse', bids: 10 }],
};

// ---------------------------------------------------------------------------
// Scenario 1: source bid metrics map correctly (and extras go to metadata).
// ---------------------------------------------------------------------------

function verifySourceBidMetrics(): ScenarioResult {
  const c = new Checker();
  const sources = toSourceIntelligence(FULL_INPUT);
  c.eq('one source per bidStats row', sources.length, 2);

  const s1 = sources[0];
  c.eq('sourceId mapped', s1.sourceId, 'src-1');
  c.eq('sourceName mapped', s1.sourceName, 'Acme Traffic');
  // Core bid mapping: bids→bidsSent, rated→bidsAccepted, won→bidsWon.
  c.eq('bids → bidsSent', s1.bidsSent, 1000);
  c.eq('rated → bidsAccepted', s1.bidsAccepted, 900);
  c.eq('won → bidsWon', s1.bidsWon, 250);
  // Sensor-neutral entity envelope.
  c.eq('sensor stamped as callgrid', s1.sensor, 'callgrid');
  c.eq('callQuality honest unknown', s1.callQuality, 'unknown');
  c.undef('fulfillment undefined (not in bidStats)', s1.fulfillment);
  c.undef('revenueGenerated undefined (not in bidStats)', s1.revenueGenerated);
  c.undef('profit undefined (not in bidStats)', s1.profit);

  // Non-canonical CallGrid metrics preserved in metadata, NOT on the entity.
  const meta = (s1.metadata?.callgrid ?? {}) as Record<string, unknown>;
  c.eq('metadata carries winRate', meta.winRate, 25);
  c.eq('metadata carries totalBidAmount', meta.totalBidAmount, 1234.56);
  c.eq('metadata carries avgBid', meta.avgBid, 1.03);
  c.eq('metadata carries rejectRate', meta.rejectRate, 2.5);
  c.ok('winRate is NOT a first-class entity field', !('winRate' in (s1 as object)));

  // Second row: name falls back to sourceId when sourceName is absent.
  const s2 = sources[1];
  c.eq('name falls back to sourceId', s2.sourceName, 'src-2');
  c.eq('src-2 bidsWon', s2.bidsWon, 100);

  return finalize('source bid metrics map correctly', c);
}

// ---------------------------------------------------------------------------
// Scenario 2: rejection reasons map correctly (neutral names, zeros dropped).
// ---------------------------------------------------------------------------

function verifyRejectionReasons(): ScenarioResult {
  const c = new Checker();
  const sources = toSourceIntelligence(FULL_INPUT);
  const s1 = sources[0];
  const reasons = s1.rejectReasons ?? [];
  const byReason = new Map(reasons.map((r) => [r.reason, r.count]));

  // Present, non-zero reasons are emitted with neutral, provider-agnostic names.
  c.eq('callerId → caller_id_blocked count', byReason.get('caller_id_blocked'), 40);
  c.eq('paused count', byReason.get('paused'), 3);
  c.eq('duplicate → duplicate_caller count', byReason.get('duplicate_caller'), 55);
  c.eq('failedAcceptance → failed_acceptance count', byReason.get('failed_acceptance'), 2);
  // Zero / absent reasons must be dropped (never emitted as 0).
  c.ok('zero closed dropped', !byReason.has('destination_closed'));
  c.ok('zero duplicateBids dropped', !byReason.has('duplicate_bid'));
  c.ok('absent failedTagRules dropped', !byReason.has('failed_tag_rules'));
  c.eq('exactly 4 reasons emitted', reasons.length, 4);
  // Reason strings carry no CallGrid-specific field names.
  c.ok('no raw CallGrid key leaks into reasons', !reasons.some((r) => /callerId|duplicateBids|failedTagRules/.test(r.reason)));

  // Source with no rejection row gets an empty (not undefined-crashing) list.
  const s2 = sources[1];
  c.eq('source without rejections has empty reasons', (s2.rejectReasons ?? []).length, 0);

  return finalize('rejection reasons map correctly', c);
}

// ---------------------------------------------------------------------------
// Scenario 3: campaign / buyer / vendor stats map correctly.
// ---------------------------------------------------------------------------

function verifyEntityStats(): ScenarioResult {
  const c = new Checker();
  const campaigns = toCampaignIntelligence(FULL_INPUT);
  const buyers = toBuyerIntelligence(FULL_INPUT);
  const vendors = toVendorIntelligence(FULL_INPUT);

  // Rows are routed to the matching entity strictly by pivot.
  c.eq('one campaign from CampaignName row', campaigns.length, 1);
  c.eq('one buyer from BuyerName row', buyers.length, 1);
  c.eq('one vendor from VendorName row', vendors.length, 1);

  // Campaign mapping.
  const camp = campaigns[0];
  c.eq('campaignId from keyId', camp.campaignId, 'camp-1');
  c.eq('campaignName from key', camp.campaignName, 'Spring Promo');
  c.eq('campaign revenue', camp.revenue, 1000);
  c.eq('campaign payout', camp.payout, 400);
  c.eq('campaign cost', camp.cost, 100);
  c.eq('campaign profit prefers net_profit', camp.profit, 475);
  c.eq('campaign margin', camp.margin, 47.5);
  c.eq('campaign completedCalls', camp.completedCalls, 180);
  c.eq('campaign billableCalls', camp.billableCalls, 150);
  c.eq('campaign convertedCalls', camp.convertedCalls, 120);

  // Buyer mapping (with row-local ratios).
  const buyer = buyers[0];
  c.eq('buyerId from keyId', buyer.buyerId, 'buyer-1');
  c.eq('buyer revenue', buyer.revenue, 600);
  c.eq('buyer payout', buyer.payout, 250);
  c.eq('buyer health honest unknown', buyer.health, 'unknown');
  c.close('buyer billableRate = billable/calls = 40/100', buyer.billableRate, 40 / 100);
  c.close('buyer conversionRate = converted/calls = 25/100', buyer.conversionRate, 25 / 100);
  c.undef('buyer profit undefined (no net/gross on row)', buyer.profit);
  c.undef('buyer diagnostics undefined (Brain not wired)', buyer.diagnostics);

  // Vendor mapping (profit falls back to gross_profit).
  const vendor = vendors[0];
  c.eq('vendorId from keyId', vendor.vendorId, 'vendor-1');
  c.eq('vendor revenue', vendor.revenue, 300);
  c.eq('vendor profit falls back to gross_profit', vendor.profit, 150);
  c.eq('vendor quality honest unknown', vendor.quality, 'unknown');

  // Cross-routing: a campaign row must NOT surface as a buyer/vendor, etc.
  c.ok('campaign not misrouted to buyers', !buyers.some((b) => b.buyerId === 'camp-1'));
  c.ok('vendor not misrouted to campaigns', !campaigns.some((x) => x.campaignId === 'vendor-1'));

  return finalize('campaign/buyer/vendor stats map correctly', c);
}

// ---------------------------------------------------------------------------
// Scenario 4: profitability totals map correctly (summed passthrough).
// ---------------------------------------------------------------------------

function verifyProfitability(): ScenarioResult {
  const c = new Checker();
  const p = toProfitability(FULL_INPUT);

  // Each field is the SUM of that metric across ALL stats rows (any pivot).
  c.eq('revenue = 1000 + 600 + 300', p.revenue, 1900);
  c.eq('payout = 400 + 250 + 120', p.payout, 770);
  c.eq('cost = 100 + 30 (buyer row absent)', p.cost, 130);
  c.eq('telco = 25 + 15 + 10', p.telco, 50);
  c.eq('grossProfit = 500 + 150', p.grossProfit, 650);
  c.eq('netProfit = 475 (only campaign row states it)', p.netProfit, 475);
  c.eq('margin = 47.5 (only campaign row states it)', p.margin, 47.5);

  return finalize('profitability totals map correctly', c);
}

// ---------------------------------------------------------------------------
// Scenario 5: funnel stages are ordered correctly (and dense).
// ---------------------------------------------------------------------------

function verifyFunnelOrdering(): ScenarioResult {
  const c = new Checker();
  const funnel = toFunnel(FULL_INPUT);
  const stages = funnel.stages;

  // Expected keys, in the canonical pay-per-call order, for the FULL fixture.
  // bids_received = 1000 + 500 = 1500; accepted = 900 + 480 = 1380;
  // won = 250 + 100 = 350; calls = 200 + 100 = 300; completed = 180;
  // billable = 150 + 40 = 190; revenue = 1900; profit = net(475) [only campaign].
  const expectedKeys = [
    'bids_received', 'accepted', 'won', 'calls', 'completed', 'billable', 'revenue', 'profit',
  ];
  c.eq('all eight default stages present', stages.length, expectedKeys.length);
  expectedKeys.forEach((k, i) => {
    c.eq('stage ' + i + ' key is ' + k, stages[i]?.key, k);
    c.eq('stage ' + i + ' order is ' + i, stages[i]?.order, i);
  });
  // 'order' is strictly ascending and dense from 0.
  const ascendingDense = stages.every((s, i) => s.order === i);
  c.ok('orders are dense and ascending from 0', ascendingDense);

  // A couple of representative counts.
  c.eq('bids_received summed across sources', stages[0]?.count, 1500);
  c.eq('accepted summed across sources', stages[1]?.count, 1380);
  c.eq('revenue stage total', stages[6]?.count, 1900);

  return finalize('funnel stages ordered correctly', c);
}

// ---------------------------------------------------------------------------
// Scenario 6: missing values stay undefined; unknown funnel stages are omitted.
// ---------------------------------------------------------------------------

function verifyMissingStaysUndefined(): ScenarioResult {
  const c = new Checker();

  // Sparse input: only a bidStats row with bids; no rated/won, no stats.
  const sources = toSourceIntelligence(SPARSE_INPUT);
  const s = sources[0];
  c.eq('sparse source bidsSent present', s.bidsSent, 10);
  c.undef('sparse bidsAccepted undefined (no rated)', s.bidsAccepted);
  c.undef('sparse bidsWon undefined (no won)', s.bidsWon);

  const p = toProfitability(SPARSE_INPUT);
  c.undef('sparse profitability revenue undefined', p.revenue);
  c.undef('sparse profitability payout undefined', p.payout);
  c.undef('sparse profitability telco undefined', p.telco);
  c.ok('undefined is not a fabricated 0 (revenue)', p.revenue !== 0);

  // Funnel: only stages with a known count appear; the rest are omitted, and
  // the surviving stages remain densely ordered from 0.
  const funnel = toFunnel(SPARSE_INPUT);
  c.eq('only known funnel stages appear', funnel.stages.length, 1);
  c.eq('surviving stage is bids_received', funnel.stages[0]?.key, 'bids_received');
  c.eq('surviving stage re-indexed to order 0', funnel.stages[0]?.order, 0);
  c.ok('no zero-filled stages', funnel.stages.every((st) => st.count !== undefined));

  // Buyer ratios stay undefined when denominators are absent.
  const buyerInput: CallGridReportInput = {
    organizationId: SCOPE.organizationId,
    window: WINDOW,
    stats: [{ pivot: 'BuyerName', key: 'No Calls Buyer', metrics: { billable: 5 } }],
  };
  const buyer = toBuyerIntelligence(buyerInput)[0];
  c.undef('billableRate undefined without calls denominator', buyer.billableRate);
  c.undef('conversionRate undefined without calls denominator', buyer.conversionRate);

  return finalize('missing values stay undefined', c);
}

// ---------------------------------------------------------------------------
// Scenario 7: BRAIN_NOT_WIRED appears exactly where expected.
// ---------------------------------------------------------------------------

function verifyBrainNotWired(): ScenarioResult {
  const c = new Checker();
  const mi = assembleMarketplaceIntelligence(FULL_INPUT, new Date('2025-01-08T00:00:00.000Z'));

  // Top-level snapshot honesty.
  c.eq('top-level missingEvidence carries the marker', mi.missingEvidence[0], BRAIN_NOT_WIRED);
  c.eq('top-level recommendations empty', mi.recommendations.length, 0);
  c.eq('top-level insights empty', mi.insights.length, 0);
  c.eq('top-level health unknown', mi.health, 'unknown');
  c.eq('top-level confidence 0', mi.confidence, 0);
  c.eq('metadata.note is the marker', (mi.metadata as Record<string, unknown>)?.note, BRAIN_NOT_WIRED);

  // Every entity carries the marker in missingEvidence and empty recommendations.
  const entities = [...mi.campaigns, ...mi.buyers, ...mi.sources, ...mi.vendors];
  c.ok('every entity carries BRAIN_NOT_WIRED', entities.every((e) => e.missingEvidence.includes(BRAIN_NOT_WIRED)));
  c.ok('every entity has empty recommendations', entities.every((e) => e.recommendations.length === 0));
  c.ok('every entity confidence is 0', entities.every((e) => e.confidence === 0));

  // Profitability carries the marker too.
  c.ok('profitability carries BRAIN_NOT_WIRED', mi.profitability.missingEvidence.includes(BRAIN_NOT_WIRED));

  return finalize('BRAIN_NOT_WIRED appears where expected', c);
}

// ---------------------------------------------------------------------------
// Scenario 8: output remains provider-neutral.
// ---------------------------------------------------------------------------

/** Recursively collect the object KEYS used in a value, excluding any subtree
 * under a 'metadata' key (metadata is the sanctioned home for sensor specifics).
 * Pure: walks a plain object graph, no I/O. */
function structuralKeys(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((v) => structuralKeys(v, out));
    return;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(k);
      if (k === 'metadata') continue; // sensor specifics are allowed here
      structuralKeys(v, out);
    }
  }
}

function verifyProviderNeutral(): ScenarioResult {
  const c = new Checker();
  const mi = assembleMarketplaceIntelligence(FULL_INPUT, new Date('2025-01-08T00:00:00.000Z'));

  const keys = new Set<string>();
  structuralKeys(mi, keys);

  // CallGrid-specific field names must never leak into canonical structural
  // fields (they are permitted only inside 'metadata', which we skip above).
  const callgridSpecific = [
    'winRate', 'bidRate', 'rejectRate', 'totalBidAmount', 'totalWonAmount',
    'avgBid', 'avgWinningBid', 'callerId', 'duplicateBids', 'failedTagRules',
    'total_revenue', 'total_payout', 'net_profit', 'gross_profit',
  ];
  callgridSpecific.forEach((leak) => {
    c.ok('canonical structure free of "' + leak + '"', !keys.has(leak));
  });

  // Note: 'sourceId'/'campaignId'/'buyerId'/'vendorId' ON the entities are
  // canonical, sensor-neutral identifiers (defined in PR #43), distinct from a
  // raw CallGrid column; we assert the canonical id fields DO exist so the
  // neutrality check is meaningful and not just an absence.
  c.ok('canonical sourceId present', keys.has('sourceId'));
  c.ok('canonical campaignId present', keys.has('campaignId'));
  c.ok('canonical buyerId present', keys.has('buyerId'));
  c.ok('canonical vendorId present', keys.has('vendorId'));

  // Reject-reason strings are neutral (already checked in Scenario 2) — confirm
  // no metric map keys escaped into a canonical reason position here as well.
  const reasons = mi.sources.flatMap((s) => s.rejectReasons ?? []).map((r) => r.reason);
  c.ok('reason strings are neutral', reasons.every((r) => /^[a-z_]+$/.test(r)));

  // The snapshot's sensor tag is the only place the sensor is named at the top,
  // and it lives under metadata — proving neutrality of the model body.
  c.eq('sensor recorded only under metadata', (mi.metadata as Record<string, unknown>)?.sensor, 'callgrid');

  return finalize('output remains provider-neutral', c);
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/** Run every CallGrid assembler verification scenario and return a structured
 * report. Pure and deterministic: no I/O, no clock (fixtures pin the dates), no
 * RNG, no persistence, no LLM. */
export function runCallGridAssemblerVerification(): VerificationReport {
  const scenarios: ScenarioResult[] = [
    verifySourceBidMetrics(),
    verifyRejectionReasons(),
    verifyEntityStats(),
    verifyProfitability(),
    verifyFunnelOrdering(),
    verifyMissingStaysUndefined(),
    verifyBrainNotWired(),
    verifyProviderNeutral(),
  ];
  const all = scenarios.flatMap((s) => s.checks);
  const failures = all.filter((x) => !x.passed).length;
  return {
    passed: failures === 0,
    total: all.length,
    failures,
    scenarios,
  };
}

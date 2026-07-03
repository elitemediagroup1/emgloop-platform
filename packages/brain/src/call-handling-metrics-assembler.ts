// @emgloop/brain — Call-Handling Metrics Assembler (read-only, real-data intake).
//
// Phase 1 (Closing the loop on real data). Prior PRs gave the Brain the ability
// to Observe → Diagnose → Recommend → Publish from a plain CallHandlingMetrics
// object (buyer-call-handling-diagnoser.ts, diagnostics-recommendation.ts,
// brain-activity.ts). What was still missing is the step BEFORE the metrics: a
// way to turn the platform's ALREADY-INGESTED, reconciled CallGrid interaction
// records into that CallHandlingMetrics shape, so the exact same pipeline can
// run on real data instead of hand-written fixtures.
//
//   Reconciled CallGrid interactions (already ingested)
//        │  (this file: pure, read-only aggregation)
//        ▼
//   CallHandlingMetrics  ──►  buyerCallHandlingDiagnoser  ──►  DiagnosticAssessment
//        ▼
//   diagnostics→recommendation adapter (spine)  ──►  RecommendationEnvelope
//        ▼
//   BrainActivity  (the Brain's canonical output)
//
// STRICTLY READ-ONLY AND NON-INVASIVE. This assembler:
//   • reads a caller-supplied window of reconciled call records — it NEVER reads
//     the DB, calls CallGrid, or touches ingestion; the caller passes in records
//     it already has.
//   • performs pure aggregation (counts + ratios) with no I/O, no clock, no RNG,
//     no persistence, and no mutation of its inputs.
//   • changes NO runtime behavior and is wired into NO live path. It is a helper
//     a test or a future, separately-decided caller may use.
//
// It introduces NO new decision logic: it only COUNTS what the records already
// state and hands the result to the existing (unchanged) diagnose→recommend→
// publish flow. Deciding what to do with the resulting BrainActivity, and
// whether to run this on live data, remain later decisions made outside here.

import type { TenantScope } from './types';
import type { CallHandlingMetrics } from './buyer-call-handling-diagnoser';
import {
  demonstrateBrainActivityFlow,
} from './brain-activity';
import type {
  BrainActivityDemoResult,
} from './brain-activity';

// ---------------------------------------------------------------------------
// Input model: a reconciled CallGrid interaction record.
//
// This mirrors the reconciled interaction fields the platform already produces
// today and that the diagnoser documents it reads: a call status
// (answer/miss/no_answer/voicemail/transfer/complete/hangup), a handled
// duration, who ended the call, whether it was billable/qualified, and the
// vendor/buyer/source/campaign attribution. We define the shape locally (rather
// than import a provider type) to keep this helper decoupled and additive; it is
// a read-only VIEW of records the caller already holds.
// ---------------------------------------------------------------------------

/** Canonical reconciled call status vocabulary already used across the platform. */
export type CallStatus =
  | 'answer'
  | 'complete'
  | 'transfer'
  | 'voicemail'
  | 'miss'
  | 'no_answer'
  | 'hangup'
  | 'no_route';

/** Who ended a connected call, when known. */
export type CallEndedBy = 'buyer' | 'caller' | 'system' | 'unknown';

/** Attribution carried on a reconciled call, preserved through aggregation so a
 * consumer can see which vendor/buyer/source/campaign the window concerned. */
export interface CallAttribution {
  vendorId?: string;
  buyerId?: string;
  source?: string;
  campaign?: string;
}

/**
 * One reconciled CallGrid interaction, as the platform already stores it. This
 * is the read-only input to the assembler. Only the fields the diagnoser cares
 * about are modelled; unknown/optional fields are simply absent and are handled
 * honestly (they lower the metrics that depend on them rather than being faked).
 */
export interface ReconciledCallRecord extends CallAttribution {
  /** Stable reconciled interaction id (used only for evidence/attribution). */
  id?: string;
  /** Reconciled call status. */
  status: CallStatus;
  /** Handled duration in seconds, when the call connected. */
  durationSeconds?: number;
  /** Who ended the connected call, when known. */
  endedBy?: CallEndedBy;
  /** Whether the reconciled call qualified as billable, when known. */
  billable?: boolean;
  /** Whether the reconciled call qualified (lead quality), when known. */
  qualified?: boolean;
}

/** The window of reconciled records to aggregate, plus its tenant scope and an
 * optional human/evidence reference for the window itself. */
export interface CallWindow extends TenantScope {
  /** The reconciled records in this analysis window (read-only view). */
  records: ReadonlyArray<ReconciledCallRecord>;
  /** Optional reference id for the window (e.g. a report id or time range key). */
  windowRef?: string;
}

// ---------------------------------------------------------------------------
// Aggregation constants.
// ---------------------------------------------------------------------------

/** Answered calls at or below this handled duration count as "short" (too short
 * to qualify). Explicit and documented so a reviewer sees exactly what "short"
 * means; tuning it is a config decision, not a behavior change. */
export const SHORT_CALL_MAX_SECONDS = 30;

/** Statuses that represent a call which connected to the buyer (was answered). */
const ANSWERED_STATUSES: ReadonlyArray<CallStatus> = ['answer', 'complete', 'transfer'];
/** Statuses that represent a call the buyer did not answer. */
const MISSED_STATUSES: ReadonlyArray<CallStatus> = ['miss', 'no_answer', 'voicemail'];
/** Statuses that represent a call that never routed to a buyer at all. */
const NO_ROUTE_STATUSES: ReadonlyArray<CallStatus> = ['no_route'];
/** Statuses that represent a completed (fully handled) call. */
const COMPLETED_STATUSES: ReadonlyArray<CallStatus> = ['complete'];

// ---------------------------------------------------------------------------
// Result model.
// ---------------------------------------------------------------------------

/** The counts the assembler derived, kept alongside the ratios so a consumer can
 * audit exactly how each rate was computed. All counts are over the same window. */
export interface CallHandlingCounts {
  total: number;
  answered: number;
  missed: number;
  noRoute: number;
  completed: number;
  /** Answered calls whose duration was at/below SHORT_CALL_MAX_SECONDS. */
  short: number;
  /** Connected calls the buyer ended, when endedBy was known. */
  buyerEnded: number;
  /** Connected calls the caller ended, when endedBy was known. */
  callerEnded: number;
  /** Connected calls with a known endedBy (denominator for ended-rates). */
  endedKnown: number;
  /** Answered calls with a known duration (denominator for short-call ratio). */
  durationKnown: number;
  /** Records with a known billable flag (denominator for billable ratio). */
  billableKnown: number;
  /** Records flagged billable. */
  billable: number;
  /** Records with a known qualified flag (denominator for qualified ratio). */
  qualifiedKnown: number;
  /** Records flagged qualified. */
  qualified: number;
}

/** The attribution the assembler preserved across the window. A single value is
 * carried when every attributed record agrees; otherwise it is left undefined
 * (mixed windows are reported honestly, never collapsed to a guess). */
export interface PreservedAttribution {
  vendorId?: string;
  buyerId?: string;
  source?: string;
  campaign?: string;
  /** True when records carried more than one distinct value for a field. */
  mixed: boolean;
}

/** Everything the assembler produced from a window: the CallHandlingMetrics the
 * diagnoser consumes, the raw counts behind them, optional billable/qualified
 * ratios, and the preserved attribution. Pure function of the input window. */
export interface AssembledCallHandlingMetrics {
  /** The metrics object the buyer/call-handling diagnoser reads directly. */
  metrics: CallHandlingMetrics;
  /** The counts each metric was derived from (for audit/evidence). */
  counts: CallHandlingCounts;
  /** Billable ratio over records with a known billable flag, when any. */
  billableRate?: number;
  /** Qualified ratio over records with a known qualified flag, when any. */
  qualifiedRate?: number;
  /** Vendor/buyer/source/campaign attribution preserved from the records. */
  attribution: PreservedAttribution;
}

// ---------------------------------------------------------------------------
// The assembler (pure, read-only).
// ---------------------------------------------------------------------------

/** Safe ratio: returns undefined when the denominator is 0 so an absent metric
 * stays honestly absent rather than becoming a fabricated 0. */
function ratio(numerator: number, denominator: number): number | undefined {
  if (denominator <= 0) return undefined;
  return numerator / denominator;
}

/** Collapse a set of attributed values into a single value + a mixed flag. */
function collapse(values: Array<string | undefined>): { value?: string; mixed: boolean } {
  const distinct = new Set<string>();
  values.forEach((v) => {
    if (v !== undefined && v !== null && v !== '') distinct.add(v);
  });
  if (distinct.size === 0) return { mixed: false };
  if (distinct.size === 1) return { value: [...distinct][0], mixed: false };
  return { mixed: true };
}

/**
 * Aggregate a window of reconciled CallGrid records into CallHandlingMetrics.
 * PURE and READ-ONLY: it reads the records, counts them, and computes ratios; it
 * mutates nothing, performs no I/O, and invents no data. Metrics whose evidence
 * is absent (e.g. no known who-ended data) are left undefined so the diagnoser
 * can treat them as honestly missing rather than as a confident zero.
 */
export function assembleCallHandlingMetrics(window: CallWindow): AssembledCallHandlingMetrics {
  const records = window.records;
  const counts: CallHandlingCounts = {
    total: records.length,
    answered: 0,
    missed: 0,
    noRoute: 0,
    completed: 0,
    short: 0,
    buyerEnded: 0,
    callerEnded: 0,
    endedKnown: 0,
    durationKnown: 0,
    billableKnown: 0,
    billable: 0,
    qualifiedKnown: 0,
    qualified: 0,
  };

  records.forEach((r) => {
    const isAnswered = ANSWERED_STATUSES.includes(r.status);
    if (isAnswered) counts.answered += 1;
    if (MISSED_STATUSES.includes(r.status)) counts.missed += 1;
    if (NO_ROUTE_STATUSES.includes(r.status)) counts.noRoute += 1;
    if (COMPLETED_STATUSES.includes(r.status)) counts.completed += 1;

    // Short-call ratio is measured over ANSWERED calls with a known duration.
    if (isAnswered && typeof r.durationSeconds === 'number' && !Number.isNaN(r.durationSeconds)) {
      counts.durationKnown += 1;
      if (r.durationSeconds <= SHORT_CALL_MAX_SECONDS) counts.short += 1;
    }

    // Who-ended is measured over connected calls with a known endedBy.
    if (isAnswered && r.endedBy !== undefined && r.endedBy !== 'unknown') {
      counts.endedKnown += 1;
      if (r.endedBy === 'buyer') counts.buyerEnded += 1;
      if (r.endedBy === 'caller') counts.callerEnded += 1;
    }

    if (typeof r.billable === 'boolean') {
      counts.billableKnown += 1;
      if (r.billable) counts.billable += 1;
    }
    if (typeof r.qualified === 'boolean') {
      counts.qualifiedKnown += 1;
      if (r.qualified) counts.qualified += 1;
    }
  });

  // Answer rate is measured over calls that at least reached routing: total
  // minus no-route (a no-route call was never the buyer's to answer).
  const routable = counts.total - counts.noRoute;

  const metrics: CallHandlingMetrics = {
    sampleSize: counts.total,
    answerRate: ratio(counts.answered, routable),
    buyerEndedRate: ratio(counts.buyerEnded, counts.endedKnown),
    callerEndedRate: ratio(counts.callerEnded, counts.endedKnown),
    noRouteRate: ratio(counts.noRoute, counts.total),
    shortCallRate: ratio(counts.short, counts.durationKnown),
    avgDurationSeconds: undefined,
  };

  // Average duration over answered calls with a known duration.
  let durationSum = 0;
  let durationN = 0;
  records.forEach((r) => {
    if (
      ANSWERED_STATUSES.includes(r.status) &&
      typeof r.durationSeconds === 'number' &&
      !Number.isNaN(r.durationSeconds)
    ) {
      durationSum += r.durationSeconds;
      durationN += 1;
    }
  });
  if (durationN > 0) metrics.avgDurationSeconds = durationSum / durationN;

  const vendor = collapse(records.map((r) => r.vendorId));
  const buyer = collapse(records.map((r) => r.buyerId));
  const source = collapse(records.map((r) => r.source));
  const campaign = collapse(records.map((r) => r.campaign));

  const attribution: PreservedAttribution = {
    vendorId: vendor.value,
    buyerId: buyer.value,
    source: source.value,
    campaign: campaign.value,
    mixed: vendor.mixed || buyer.mixed || source.mixed || campaign.mixed,
  };

  return {
    metrics,
    counts,
    billableRate: ratio(counts.billable, counts.billableKnown),
    qualifiedRate: ratio(counts.qualified, counts.qualifiedKnown),
    attribution,
  };
}

// ---------------------------------------------------------------------------
// End-to-end: assemble real records, then run the existing Brain flow.
// ---------------------------------------------------------------------------

/** Deterministic identity/time inputs the caller supplies so the whole flow
 * stays a PURE function (no clock, no RNG anywhere in the assembler path). */
export interface CallHandlingFlowInputs {
  window: CallWindow;
  subject: string;
  activityId: string;
  timestamp: Date;
}

/** Everything the end-to-end run produced: the assembly result (metrics +
 * counts + attribution) and the full Brain flow result (assessment, context,
 * envelope, and the published, immutable BrainActivity). */
export interface CallHandlingFlowResult {
  assembled: AssembledCallHandlingMetrics;
  flow: BrainActivityDemoResult;
}

/**
 * Aggregate a window of reconciled call records into CallHandlingMetrics, then
 * run the EXISTING Observe → Diagnose → Recommend → Publish flow on them via
 * demonstrateBrainActivityFlow. Pure and deterministic: given the same window
 * and identity/time it always yields the same BrainActivity. Read-only; wired
 * into no runtime path.
 */
export function assembleAndRunCallHandlingFlow(
  inputs: CallHandlingFlowInputs,
): CallHandlingFlowResult {
  const assembled = assembleCallHandlingMetrics(inputs.window);
  const flow = demonstrateBrainActivityFlow({
    scope: {
      organizationId: inputs.window.organizationId,
      locationId: inputs.window.locationId,
    },
    metrics: assembled.metrics,
    subject: inputs.subject,
    activityId: inputs.activityId,
    timestamp: inputs.timestamp,
    windowRef: inputs.window.windowRef,
  });
  return { assembled, flow };
}

// ---------------------------------------------------------------------------
// Deterministic example usage.
//
// A small, fixed window of reconciled records that exhibits a buyer-owned
// call-handling problem (low answer rate, buyer hangs up often, short calls),
// so the flow deterministically attributes the buyer as the root cause and
// publishes a 'recommendation' BrainActivity. No clock/RNG: identity and time
// are fixed here so the example is fully reproducible.
// ---------------------------------------------------------------------------

/** A fixed set of reconciled records for the example (60 calls). */
export function exampleReconciledWindow(): CallWindow {
  const records: ReconciledCallRecord[] = [];
  const push = (n: number, rec: ReconciledCallRecord): void => {
    for (let i = 0; i < n; i += 1) records.push({ ...rec, id: rec.status + '-' + i });
  };
  // 24 answered-but-short calls the buyer ended (buyer-owned problem).
  push(24, {
    status: 'answer',
    durationSeconds: 12,
    endedBy: 'buyer',
    billable: false,
    qualified: false,
    vendorId: 'vendor-A',
    buyerId: 'buyer-42',
    source: 'ppc',
    campaign: 'spring',
  });
  // 6 healthy completed calls.
  push(6, {
    status: 'complete',
    durationSeconds: 180,
    endedBy: 'caller',
    billable: true,
    qualified: true,
    vendorId: 'vendor-A',
    buyerId: 'buyer-42',
    source: 'ppc',
    campaign: 'spring',
  });
  // 24 missed calls (buyer did not answer).
  push(24, {
    status: 'miss',
    endedBy: 'unknown',
    billable: false,
    qualified: false,
    vendorId: 'vendor-A',
    buyerId: 'buyer-42',
    source: 'ppc',
    campaign: 'spring',
  });
  // 6 no-route calls (never reached the buyer).
  push(6, {
    status: 'no_route',
    billable: false,
    qualified: false,
    vendorId: 'vendor-A',
    buyerId: 'buyer-42',
    source: 'ppc',
    campaign: 'spring',
  });
  return {
    organizationId: 'org-demo',
    locationId: 'loc-1',
    records,
    windowRef: 'demo-window-2025-01',
  };
}

/** Run the full assemble → diagnose → recommend → publish flow on the fixed
 * example window. Deterministic; identity/time are fixed for reproducibility. */
export function demonstrateCallHandlingAssemblyFlow(): CallHandlingFlowResult {
  return assembleAndRunCallHandlingFlow({
    window: exampleReconciledWindow(),
    subject: 'call_handling_root_cause',
    activityId: 'demo-activity-assembler-1',
    timestamp: new Date('2025-01-15T00:00:00.000Z'),
  });
}

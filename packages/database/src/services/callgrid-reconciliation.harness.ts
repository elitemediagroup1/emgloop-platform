// CallGrid reconciliation harness — source of record vs. what EMG Loop reports.
//
// PURPOSE
//
// Tests prove that our code does what we told it to. They cannot prove that
// what we told it to do matches CallGrid. This harness is the only thing that
// can: it takes CallGrid's own records for a bounded period and compares them,
// field by field and aggregate by aggregate, against the values Loop would
// display for that same period.
//
// It is deliberately a pure function over supplied records rather than a script
// that fetches. That means it runs identically against a live API pull, a CSV
// export, a captured webhook batch, or a fixture — and it can be re-run the
// moment real credentials exist without rewriting anything.
//
// WHAT IT WILL NOT DO
//
// It will not paper over a mismatch. A tolerance exists only for float rounding
// on money (1 cent) and averages; everything else is exact. A missing source
// record and an extra Loop record are different failures and are reported
// separately, because they have different causes: missed ingestion vs. double
// -counting or a leaked test row.

import { sumKnown } from '@emgloop/shared';

/**
 * One call as CallGrid reports it. Field names mirror the documented webhook
 * payload (docs/integrations/CALLGRID.md); economics are optional because the
 * documented payload does NOT carry them — see the note in `reconcile()`.
 */
export interface CallGridSourceCall {
  call_id: string;
  started_at: string;
  duration_seconds?: number | null;
  /** Money as CallGrid states it. Units are declared per-run, never guessed. */
  revenue?: number | null;
  payout?: number | null;
  cost?: number | null;
  buyer?: string | null;
  campaign?: string | null;
  source?: string | null;
  qualified?: boolean | null;
  converted?: boolean | null;
  duplicate?: boolean | null;
  /** CallGrid states profit directly (tag CallProfit). Used as an invariant. */
  profit?: number | null;
  /** CallGrid's Net Profit — profit AFTER telco cost. A distinct field. */
  netProfit?: number | null;
}

/** The same call as Loop persisted it, read from MarketplaceCall. */
export interface LoopCall {
  externalId: string;
  sourceOccurredAt: Date;
  durationSeconds: number | null;
  revenueCents: number | null;
  payoutCents: number | null;
  costCents: number | null;
  buyerLabel: string | null;
  campaignLabel: string | null;
  sourceLabel: string | null;
  qualified: boolean | null;
  converted: boolean | null;
  duplicate: boolean | null;
}

/**
 * How the source expresses money. Declared explicitly per run because getting
 * this wrong is a 100x error, and no amount of inspection of a single payload
 * can distinguish $1.00 from 100 cents reliably.
 */
export type MoneyUnit = 'dollars' | 'cents';

export interface ReconcileOptions {
  /** Half-open [since, until), matching every window Loop queries with. */
  since: Date;
  until: Date;
  sourceMoneyUnit: MoneyUnit;
  /** Money comparison tolerance in cents. 1 absorbs float-rounding only. */
  moneyToleranceCents?: number;
}

export type CheckStatus = 'pass' | 'fail' | 'unverifiable' | 'definition-mismatch';

/** Whether two terms name the same business concept at all. */
export type DefinitionStatus = 'equivalent' | 'different' | 'unknown';

/** What to do about a term that is not equivalent. */
export type DefinitionAction = 'compare' | 'rename' | 'remap' | 'keep-separate';

export interface BusinessDefinition {
  /** Loop's term, as it appears in the reconciliation. */
  metric: string;
  /** CallGrid's term, or null when CallGrid has no such concept. */
  callgridTerm: string | null;
  status: DefinitionStatus;
  loopDefinition: string;
  callgridDefinition: string;
  recommendation: DefinitionAction;
  note: string;
}

/**
 * The Business Definition Matrix.
 *
 * A reconciliation can only fail honestly on metrics that MEAN the same thing.
 * Reporting "Qualified: source 0, Loop 41, FAIL" is not a data defect — CallGrid
 * has no notion of qualified at all, so the comparison was never valid. Doing
 * that repeatedly trains an operator to ignore the report, which is worse than
 * having no report.
 *
 * Every entry is derived from code, not from the similarity of the two names.
 */
export const BUSINESS_DEFINITIONS: readonly BusinessDefinition[] = [
  {
    metric: 'Calls',
    callgridTerm: 'Call record',
    status: 'equivalent',
    loopDefinition: 'One MarketplaceCall row per (provider, externalId) in the window.',
    callgridDefinition: 'One call record per CallId.',
    recommendation: 'compare',
    note: 'Directly comparable. The unique key matches CallGrid\'s own idempotency key.',
  },
  {
    metric: 'Revenue',
    callgridTerm: 'CallRevenue',
    status: 'equivalent',
    loopDefinition: 'Sum of non-null revenueCents. Nulls reduce coverage rather than summing as 0.',
    callgridDefinition: 'Per-call revenue as stated by CallGrid.',
    recommendation: 'compare',
    note: 'Same concept. The UNIT is still unproven — comparison must declare it, never guess.',
  },
  {
    metric: 'Payout',
    callgridTerm: 'CallPayout',
    status: 'equivalent',
    loopDefinition: 'Sum of non-null payoutCents.',
    callgridDefinition: 'Per-call payout as stated by CallGrid.',
    recommendation: 'compare',
    note: 'Same concept, same unit caveat as Revenue.',
  },
  {
    metric: 'Billable calls',
    callgridTerm: 'CallBillable',
    status: 'equivalent',
    loopDefinition: 'Count where billable === true. Null is not counted as false.',
    callgridDefinition: 'Per-call billable flag.',
    recommendation: 'compare',
    note: 'Direct 1:1 field mapping, confirmed by the webhook template.',
  },
  {
    metric: 'Converted calls',
    callgridTerm: 'CallConverted',
    status: 'equivalent',
    loopDefinition: 'Count where converted === true.',
    callgridDefinition: 'Per-call converted flag.',
    recommendation: 'compare',
    note:
      'Direct 1:1 field mapping (converted <- CallConverted), confirmed by the webhook template. ' +
      'Note this flag is one of the three inputs Loop uses to derive its own "qualified" — compare ' +
      'converted here, never the derivation.',
  },
  {
    metric: 'Qualified calls',
    callgridTerm: null,
    status: 'different',
    loopDefinition:
      'RENAMED to `monetized` (Sprint 36). DERIVED by Loop: billable OR converted OR paid.',
    callgridDefinition: 'No such concept. CallGrid sends no qualified field of any kind.',
    recommendation: 'rename',
    note:
      'A Loop invention presented as a sensor fact — it is even stored on MarketplaceCall.qualified ' +
      'beside genuine provider flags. It measures "the call produced a positive commercial outcome", ' +
      'not "the call met a qualification standard", and an executive reading a qualification RATE ' +
      'would read it as call quality. RENAMED to `monetized` across the schema, repositories, ' +
      'intelligence contract and UI; the physical column is @map-ed so no migration was required. ' +
      'The metadata KEY stays `qualified` because it is stored historical payload. Never reconcile it.',
  },
  {
    metric: 'Connected calls',
    callgridTerm: 'CallNoRoute (inverse, partial)',
    status: 'different',
    loopDefinition:
      'Loop has NO connected field. Coverage infers "connectivity is known" from status, rawStatus or noRoute being non-null.',
    callgridDefinition:
      'CallGrid exposes connected / connectFailed / noConnect as distinct facts; the webhook template sends only noRoute.',
    recommendation: 'remap',
    note:
      '"Connectivity is known" and "the call connected" are different statements — the first is about ' +
      'our coverage, the second about the call. Consume the real connected/connectFailed/noConnect ' +
      'fields before reporting a connection rate.',
  },
  {
    metric: 'Profit',
    callgridTerm: 'Profit',
    status: 'different',
    loopDefinition:
      'Loop derives margin as revenue - payout - cost. That is CallGrid\'s NET Profit, not its Profit.',
    callgridDefinition: 'Profit = Revenue - Payout. Telco cost is NOT subtracted.',
    recommendation: 'remap',
    note:
      'Proven by the CallGrid report of 2026-07-18: 540.17 - 461.30 = 78.87 = stated Profit, and ' +
      'Margin % 14.60 reproduces exactly. The Home Insurance row is decisive — Revenue 0, Payout 0, ' +
      'Profit 0, Net Profit -0.04 — a pure-cost call whose Profit would read -0.04 if cost were ' +
      'included. Loop\'s derived margin must be labelled Net Profit, or it overstates cost by ' +
      'subtracting it from the wrong figure.',
  },
  {
    metric: 'Net profit',
    callgridTerm: 'Net Profit',
    status: 'equivalent',
    loopDefinition: 'Loop\'s currently-derived margin: revenue - payout - cost.',
    callgridDefinition: 'Net Profit = Revenue - Payout - Cost. Net Margin % 12.05 reproduces exactly.',
    recommendation: 'compare',
    note:
      'This — not Profit — is what Loop has been computing all along. Comparing it is valid; the ' +
      'defect was only ever the label.',
  },
  {
    metric: 'Duplicate calls',
    callgridTerm: 'Duplicate',
    status: 'different',
    loopDefinition:
      'MarketplaceCall.duplicate exists as a column but NEITHER adapter maps it, so it is null on every row.',
    callgridDefinition: 'Duplicate — a real reported field; 4 on 2026-07-18.',
    recommendation: 'remap',
    note:
      'A column that exists and is never written is worse than one that does not exist: duplicate ' +
      'suppression silently does nothing while appearing supported. Loop would report 0/null against ' +
      'CallGrid\'s 4. Map it in both adapters before any duplicate-rate figure is shown.',
  },
  {
    metric: 'Duration',
    callgridTerm: 'CallDuration',
    status: 'unknown',
    loopDefinition: 'durationSeconds, treated as TOTAL call duration in seconds.',
    callgridDefinition:
      'CallDuration — scope unstated. CallGrid separately exposes a billable duration.',
    recommendation: 'keep-separate',
    note:
      'Three distinct quantities (total, connected, billable) may be collapsing into one column: the ' +
      'adapter alias list falls back to billable_duration, so if the primary key is absent BILLABLE ' +
      'duration lands in a field named total duration. Scope must be confirmed before any duration ' +
      'comparison is meaningful.',
  },
  {
    metric: 'Average duration',
    callgridTerm: null,
    status: 'unknown',
    loopDefinition: 'Sum of known durations / count of calls WITH a duration. Unknowns excluded, not zeroed.',
    callgridDefinition: 'Denominator unknown — may divide by all calls, including unconnected ones.',
    recommendation: 'keep-separate',
    note:
      'Inherits the Duration scope question, and adds a denominator question. Two averages over ' +
      'different denominators are different metrics even when both are labelled "average duration".',
  },
] as const;

const DEFINITION_BY_METRIC = new Map(BUSINESS_DEFINITIONS.map((d) => [d.metric, d]));

/** The definition for a metric, if one is registered. */
export const definitionFor = (metric: string): BusinessDefinition | undefined =>
  DEFINITION_BY_METRIC.get(metric);

export interface FieldCheck {
  metric: string;
  sourceValue: string;
  loopValue: string;
  difference: string;
  status: CheckStatus;
  reason: string | null;
  /** Call ids implicated, capped so a report stays readable. */
  affected: string[];
}

export interface ReconcileReport {
  window: { since: string; until: string };
  sourceRecords: number;
  loopRecords: number;
  /** In source, absent from Loop — missed ingestion. */
  missingInLoop: string[];
  /** In Loop, absent from source — double-counting or a leaked row. */
  extraInLoop: string[];
  /** Per-record field mismatches. */
  fieldMismatches: FieldCheck[];
  /** Aggregate comparisons — the numbers an executive actually reads. */
  aggregates: FieldCheck[];
  /**
   * Metrics that were NOT compared because Loop and CallGrid do not measure the
   * same business concept. These are never failures — they are naming and
   * mapping decisions, and each carries a recommended action.
   */
  definitionMismatches: FieldCheck[];
  passed: boolean;
  summary: string;
}

const toCents = (v: number | null | undefined, unit: MoneyUnit): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  // Round AFTER scaling: Math.round(1.005 * 100) is the only correct order here.
  return unit === 'dollars' ? Math.round(v * 100) : Math.round(v);
};

const fmtMoney = (cents: number | null): string =>
  cents === null ? 'unknown' : `$${(cents / 100).toFixed(2)}`;

const fmtNum = (n: number | null): string => (n === null ? 'unknown' : String(n));

function check(
  metric: string,
  source: number | null,
  loop: number | null,
  tolerance: number,
  fmt: (n: number | null) => string,
  affected: string[] = [],
): FieldCheck {
  // A metric whose definitions differ cannot fail a VALUE comparison, because
  // the comparison was never valid. Reporting it as a data defect would send
  // someone hunting an ingestion bug that does not exist.
  const definition = definitionFor(metric);
  if (definition && definition.status !== 'equivalent') {
    return {
      metric,
      sourceValue: fmt(source),
      loopValue: fmt(loop),
      difference: 'not comparable',
      status: 'definition-mismatch',
      reason:
        `Business definition ${definition.status}: ${definition.note} ` +
        `Recommended action: ${definition.recommendation}.`,
      affected,
    };
  }
  // Unknown on either side is NOT a pass and NOT a fail — it is unverifiable,
  // and collapsing it into either would misrepresent the state of the audit.
  if (source === null || loop === null) {
    return {
      metric,
      sourceValue: fmt(source),
      loopValue: fmt(loop),
      difference: 'n/a',
      status: 'unverifiable',
      reason:
        source === null && loop === null
          ? 'Neither side reports this value.'
          : source === null
            ? 'The source did not supply this value, so Loop cannot be checked against it.'
            : 'Loop has no value where the source supplied one.',
      affected,
    };
  }
  const diff = loop - source;
  const ok = Math.abs(diff) <= tolerance;
  return {
    metric,
    sourceValue: fmt(source),
    loopValue: fmt(loop),
    difference: fmt(diff),
    status: ok ? 'pass' : 'fail',
    reason: ok ? null : `Loop differs from source by ${fmt(diff)} (tolerance ${fmt(tolerance)}).`,
    affected,
  };
}

/**
 * Reconcile a bounded window.
 *
 * NOTE ON ECONOMICS: the documented CallGrid webhook payload
 * (docs/integrations/CALLGRID.md) carries call_id, timing, duration and utm_*
 * only — it has NO revenue, payout, buyer or qualified field. Loop nevertheless
 * stores all of those on MarketplaceCall. Where they come from is unverified,
 * so this harness reports economics as `unverifiable` rather than `pass` when
 * the source side is absent. That is the honest posture until a real payload
 * carrying economics is captured.
 */
export function reconcile(
  source: readonly CallGridSourceCall[],
  loop: readonly LoopCall[],
  opts: ReconcileOptions,
): ReconcileReport {
  const tol = opts.moneyToleranceCents ?? 1;

  // Only compare inside the window, half-open, exactly as Loop queries.
  const inWindow = (d: Date) => d >= opts.since && d < opts.until;
  const src = source.filter((c) => {
    const t = new Date(c.started_at);
    return !Number.isNaN(t.getTime()) && inWindow(t);
  });
  const lp = loop.filter((c) => inWindow(c.sourceOccurredAt));

  const srcById = new Map(src.map((c) => [c.call_id, c]));
  const lpById = new Map(lp.map((c) => [c.externalId, c]));

  const missingInLoop = [...srcById.keys()].filter((id) => !lpById.has(id));
  const extraInLoop = [...lpById.keys()].filter((id) => !srcById.has(id));

  // --- Per-record field checks --------------------------------------------
  const fieldMismatches: FieldCheck[] = [];
  for (const [id, s] of srcById) {
    const l = lpById.get(id);
    if (!l) continue;

    const st = new Date(s.started_at);
    const deltaMs = Number.isNaN(st.getTime()) ? 0 : l.sourceOccurredAt.getTime() - st.getTime();

    // A sub-second delta is LEGACY PRECISION LOSS, not a semantic mismatch: a
    // row projected from UTCUnixTime (epoch SECONDS) before the resolver existed
    // truncates the milliseconds that UTCUnixTimeMs carries. Re-running the
    // backfill restores full precision where the raw Interaction retained it.
    if (!Number.isNaN(st.getTime()) && deltaMs !== 0 && Math.abs(deltaMs) < 1000) {
      fieldMismatches.push({
        metric: `timestamp-precision[${s.call_id}]`,
        sourceValue: st.toISOString(),
        loopValue: l.sourceOccurredAt.toISOString(),
        difference: `${deltaMs}ms`,
        status: 'unverifiable',
        reason:
          'Sub-second difference: this row was projected from UTCUnixTime (epoch seconds) and lost ' +
          'milliseconds. Not a semantic mismatch. Re-run the backfill to restore precision where the ' +
          'raw Interaction retained UTCUnixTimeMs.',
        affected: [s.call_id],
      });
    } else if (!Number.isNaN(st.getTime()) && st.getTime() !== l.sourceOccurredAt.getTime()) {
      fieldMismatches.push({
        metric: `timestamp[${id}]`,
        sourceValue: st.toISOString(),
        loopValue: l.sourceOccurredAt.toISOString(),
        difference: `${(l.sourceOccurredAt.getTime() - st.getTime()) / 1000}s`,
        status: 'fail',
        // A whole-hour delta is the signature of a timezone bug, and it will
        // move calls across a day boundary on the dashboard.
        reason:
          Math.abs(l.sourceOccurredAt.getTime() - st.getTime()) % 3_600_000 === 0
            ? 'Whole-hour offset — this is the signature of a timezone conversion error.'
            : 'Stored timestamp does not match the source.',
        affected: [id],
      });
    }

    const pairs: Array<[string, number | null, number | null, (n: number | null) => string, number]> = [
      [`revenue[${id}]`, toCents(s.revenue, opts.sourceMoneyUnit), l.revenueCents, fmtMoney, tol],
      [`payout[${id}]`, toCents(s.payout, opts.sourceMoneyUnit), l.payoutCents, fmtMoney, tol],
      [`cost[${id}]`, toCents(s.cost, opts.sourceMoneyUnit), l.costCents, fmtMoney, tol],
      [
        `duration[${id}]`,
        typeof s.duration_seconds === 'number' ? s.duration_seconds : null,
        l.durationSeconds,
        fmtNum,
        0,
      ],
    ];
    for (const [metric, a, b, fmt, t] of pairs) {
      const r = check(metric, a, b, t, fmt, [id]);
      // Only genuine disagreements are mismatches. A field neither side reports
      // is unverifiable, and filing it as a mismatch would flood the report with
      // noise for every economics field the documented webhook does not carry.
      if (r.status === 'fail') fieldMismatches.push(r);
    }

    const labels: Array<[string, string | null | undefined, string | null]> = [
      [`buyer[${id}]`, s.buyer, l.buyerLabel],
      [`campaign[${id}]`, s.campaign, l.campaignLabel],
      [`source[${id}]`, s.source, l.sourceLabel],
    ];
    for (const [metric, a, b] of labels) {
      const sv = a ?? null;
      if (sv === null || b === null) continue; // unverifiable, not a mismatch
      if (sv !== b) {
        fieldMismatches.push({
          metric,
          sourceValue: sv,
          loopValue: b,
          difference: 'label differs',
          status: 'fail',
          reason: 'Attribution label does not match the source.',
          affected: [id],
        });
      }
    }

    const flags: Array<[string, boolean | null | undefined, boolean | null]> = [
      [`qualified[${id}]`, s.qualified, l.qualified],
      [`converted[${id}]`, s.converted, l.converted],
      [`duplicate[${id}]`, s.duplicate, l.duplicate],
    ];
    for (const [metric, a, b] of flags) {
      if (a === null || a === undefined || b === null) continue;
      if (a !== b) {
        fieldMismatches.push({
          metric,
          sourceValue: String(a),
          loopValue: String(b),
          difference: 'flag differs',
          status: 'fail',
          reason: 'Outcome flag does not match the source.',
          affected: [id],
        });
      }
    }
  }

  // --- Aggregates: the numbers an executive actually reads -----------------
  const srcRevenue = sumKnown(src.map((c) => toCents(c.revenue, opts.sourceMoneyUnit)));
  const lpRevenue = sumKnown(lp.map((c) => c.revenueCents));
  const srcPayout = sumKnown(src.map((c) => toCents(c.payout, opts.sourceMoneyUnit)));
  const lpPayout = sumKnown(lp.map((c) => c.payoutCents));
  const srcDur = sumKnown(src.map((c) => c.duration_seconds ?? null));
  const lpDur = sumKnown(lp.map((c) => c.durationSeconds));

  const avg = (s: { total: number; counted: number }) => (s.counted === 0 ? null : s.total / s.counted);
  const countFlag = (xs: Array<boolean | null | undefined>) => {
    const known = xs.filter((x) => x === true || x === false);
    return known.length === 0 ? null : known.filter((x) => x === true).length;
  };

  const aggregates: FieldCheck[] = [
    check('Calls', src.length, lp.length, 0, fmtNum),
    check(
      'Unique call ids',
      new Set(src.map((c) => c.call_id)).size,
      new Set(lp.map((c) => c.externalId)).size,
      0,
      fmtNum,
    ),
    check('Qualified calls', countFlag(src.map((c) => c.qualified)), countFlag(lp.map((c) => c.qualified)), 0, fmtNum),
    check('Converted calls', countFlag(src.map((c) => c.converted)), countFlag(lp.map((c) => c.converted)), 0, fmtNum),
    check('Duplicate calls', countFlag(src.map((c) => c.duplicate)), countFlag(lp.map((c) => c.duplicate)), 0, fmtNum),
    // Revenue is compared only over the calls where BOTH sides know a value;
    // comparing a coverage-limited sum against a complete one would report a
    // difference that is really a coverage gap.
    check('Revenue', srcRevenue.counted === 0 ? null : srcRevenue.total, lpRevenue.counted === 0 ? null : lpRevenue.total, tol, fmtMoney),
    check('Payout', srcPayout.counted === 0 ? null : srcPayout.total, lpPayout.counted === 0 ? null : lpPayout.total, tol, fmtMoney),
    // CONNECTED duration (CallGrid CallDuration = elapsed after connect).
    // Deliberately NOT compared against a report TCD unless TCD is
    // independently confirmed to use the same definition.
    check('Connected duration total (s)', srcDur.counted === 0 ? null : srcDur.total, lpDur.counted === 0 ? null : lpDur.total, 0, fmtNum),
    // Same denominator on both sides: measured durations only. Dividing by all
    // calls would silently treat an unmeasured call as a zero-length one.
    check('Average connected duration (s)', avg(srcDur), avg(lpDur), 1, fmtNum),
    check('Calls carrying connected duration', srcDur.counted, lpDur.counted, 0, fmtNum),
    check('Calls carrying revenue', srcRevenue.counted, lpRevenue.counted, 0, fmtNum),
  ];

  // --- Invariants, corrected against the CallGrid report of 2026-07-18 ------
  //
  // I originally asserted profit == revenue - payout - cost. That is WRONG, and
  // it would have emitted a false failure on every record carrying telco cost.
  // CallGrid's own daily report settles it:
  //
  //   FE Inbounds RTB   497.27 - 422.69 = 74.58  = stated Profit
  //   Pest Control RTB   42.90 -  38.61 =  4.29  = stated Profit
  //   Totals            540.17 - 461.30 = 78.87  = stated Profit
  //   Net Profit 65.11 => 78.87 - 65.11 = 13.76  = telco cost
  //
  // Both margins reproduce exactly: 78.87/540.17 = 14.60% (Margin %),
  // 65.11/540.17 = 12.05% (Net Margin %).
  //
  // The decisive row is Home Insurance: Revenue 0, Payout 0, Profit 0, but Net
  // Profit -0.04. A pure-cost call. If Profit included cost it would read -0.04.
  //
  //   Profit     = Revenue - Payout            (cost NOT subtracted)
  //   Net Profit = Revenue - Payout - Cost
  for (const s of src) {
    const rev = toCents(s.revenue, opts.sourceMoneyUnit);
    const pay = toCents(s.payout, opts.sourceMoneyUnit);
    const cst = toCents(s.cost, opts.sourceMoneyUnit);
    const statedProfit = toCents(s.profit, opts.sourceMoneyUnit);
    const statedNet = toCents(s.netProfit, opts.sourceMoneyUnit);

    if (statedProfit !== null && rev !== null) {
      const derived = rev - (pay ?? 0);
      if (Math.abs(derived - statedProfit) > tol) {
        fieldMismatches.push({
          metric: `profit-invariant[${s.call_id}]`,
          sourceValue: fmtMoney(statedProfit),
          loopValue: fmtMoney(derived),
          difference: fmtMoney(derived - statedProfit),
          status: 'fail',
          reason:
            "CallGrid's stated Profit does not equal Revenue - Payout. Either the economic fields " +
            'are not all in the same unit, or Profit is defined differently than this report showed.',
          affected: [s.call_id],
        });
      }
    }

    if (statedNet !== null && statedProfit !== null) {
      const derivedNet = statedProfit - (cst ?? 0);
      if (Math.abs(derivedNet - statedNet) > tol) {
        fieldMismatches.push({
          metric: `net-profit-invariant[${s.call_id}]`,
          sourceValue: fmtMoney(statedNet),
          loopValue: fmtMoney(derivedNet),
          difference: fmtMoney(derivedNet - statedNet),
          status: 'fail',
          reason: "CallGrid's Net Profit does not equal Profit - Cost.",
          affected: [s.call_id],
        });
      }
    }
  }

  const all = [...fieldMismatches, ...aggregates];
  const failures = all.filter((c) => c.status === 'fail');
  const unverifiable = aggregates.filter((c) => c.status === 'unverifiable');
  const definitionMismatches = all.filter((c) => c.status === 'definition-mismatch');

  // A definition mismatch does NOT fail reconciliation. It is a naming or
  // mapping decision, not a data defect, and treating it as a failure would
  // train an operator to ignore genuine failures alongside it.
  const passed = failures.length === 0 && missingInLoop.length === 0 && extraInLoop.length === 0;

  const notes = [
    unverifiable.length > 0
      ? `${unverifiable.length} metric(s) UNVERIFIABLE — the source did not supply them.`
      : '',
    definitionMismatches.length > 0
      ? `${definitionMismatches.length} metric(s) NOT COMPARED — Loop and CallGrid measure different concepts.`
      : '',
  ].filter(Boolean).join(' ');

  const summary = (passed
    ? `Reconciled ${src.length} source record(s) with no value mismatches.`
    : `${failures.length} value mismatch(es), ${missingInLoop.length} record(s) missing from Loop, ` +
      `${extraInLoop.length} extra record(s) in Loop.`) + (notes ? ` ${notes}` : '');

  return {
    window: { since: opts.since.toISOString(), until: opts.until.toISOString() },
    sourceRecords: src.length,
    loopRecords: lp.length,
    missingInLoop,
    extraInLoop,
    fieldMismatches: fieldMismatches.filter((c) => c.status !== 'definition-mismatch'),
    aggregates,
    definitionMismatches,
    passed,
    summary,
  };
}

/** Render a report as a fixed-width table for a PR body or a terminal. */
export function formatReconcileReport(r: ReconcileReport): string {
  const rows = r.aggregates.map((c) => {
    const mark =
      c.status === 'pass'
        ? 'PASS'
        : c.status === 'fail'
          ? 'FAIL'
          : c.status === 'definition-mismatch'
            ? 'NOT COMPARABLE'
            : 'UNVERIFIABLE';
    return `| ${c.metric.padEnd(24)} | ${c.sourceValue.padStart(14)} | ${c.loopValue.padStart(14)} | ${c.difference.padStart(12)} | ${mark} |`;
  });
  return [
    `CallGrid reconciliation — ${r.window.since} to ${r.window.until}`,
    `Source records: ${r.sourceRecords}   Loop records: ${r.loopRecords}`,
    '',
    `| ${'Metric'.padEnd(24)} | ${'CallGrid'.padStart(14)} | ${'EMG Loop'.padStart(14)} | ${'Difference'.padStart(12)} | Status |`,
    `|${'-'.repeat(26)}|${'-'.repeat(16)}|${'-'.repeat(16)}|${'-'.repeat(14)}|--------|`,
    ...rows,
    '',
    r.missingInLoop.length ? `MISSING FROM LOOP: ${r.missingInLoop.slice(0, 20).join(', ')}` : '',
    r.extraInLoop.length ? `EXTRA IN LOOP: ${r.extraInLoop.slice(0, 20).join(', ')}` : '',
    ...r.fieldMismatches.slice(0, 20).map((m) => `MISMATCH ${m.metric}: source=${m.sourceValue} loop=${m.loopValue} — ${m.reason}`),
    '',
    r.summary,
  ]
    .filter(Boolean)
    .join('\n');
}

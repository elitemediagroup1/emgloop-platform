// @emgloop/intelligence — CallGrid analysis engine (pure, deterministic).
//
// Turns two windows of real, aggregated CallGrid facts into explanation: what
// changed, the opportunities and risks worth a decision, the concrete lever
// tuning, and honest market/predictive reads. Every conclusion is grounded in a
// summed observed value; nothing is modelled, estimated, or fabricated. Where
// the evidence needed for a conclusion is absent (bid facts, a prior window, a
// second period of pricing), the engine does not guess — it records the gap in
// `missingEvidence` and stays silent on that conclusion.
//
// Thresholds are named constants, not magic numbers, so the product rules are
// auditable and tunable in one place. Root-cause attribution follows the Brain's
// vocabulary ('vendor' | 'buyer' | 'emg' | 'unknown'); 'unknown' is used
// wherever the data cannot support a confident attribution.

import type {
  BrainActivityType,
  Priority,
  RecommendationEnvelope,
  RootCause,
} from '@emgloop/brain';
import {
  changePercent,
  directionOf,
  priorityFromMagnitude,
  ratio,
  significanceOf,
  type IntelligenceChange,
  type MarketIntelligence,
  type MarketObservation,
  type OptimizationAction,
  type PredictiveIntelligence,
  type PredictiveProjection,
} from '../module';
import { buildEnvelope, evidenceRow } from '../build';
import {
  marginCentsOf,
  type CallGridDimensionWindow,
  type CallGridIntelligenceInput,
  type CallGridWindow,
} from './input';

// ---------------------------------------------------------------------------
// Product thresholds (deterministic rules).
// ---------------------------------------------------------------------------
export const THRESHOLDS = {
  /** Below this many calls in the window, module confidence is capped low. */
  minWindowCalls: 10,
  /** A dimension needs at least this many calls before it drives a conclusion. */
  minDimensionCalls: 5,
  /** Margin fall of at least this % (period over period) is a compression risk. */
  marginCompressionPct: 15,
  /** A qualified/conversion-rate fall of at least this % is deterioration. */
  rateDeteriorationPct: 20,
  /** Qualified rate at or above this marks a scale candidate. */
  highQualifiedRate: 0.5,
  /** Qualified rate at or below this marks a waste candidate. */
  lowQualifiedRate: 0.15,
  /** Win rate at or below this (with healthy margin) suggests bidding higher. */
  lowWinRate: 0.25,
  /** Win rate at or above this (with thin margin) suggests bidding lower. */
  highWinRate: 0.7,
  /** Reject rate at or above this is a declining-acceptance risk. */
  highRejectRate: 0.4,
} as const;

// ---------------------------------------------------------------------------
// Formatting helpers (deterministic).
// ---------------------------------------------------------------------------
export function usd(cents: number): string {
  const negative = cents < 0;
  const dollars = Math.round(Math.abs(cents) / 100);
  return `${negative ? '-' : ''}$${dollars.toLocaleString('en-US')}`;
}
function fmtPct(x: number): string {
  const rounded = Math.round(x);
  return `${rounded >= 0 ? '+' : ''}${rounded}%`;
}
function fmtRate(r: number): string {
  return `${Math.round(r * 100)}%`;
}

// ---------------------------------------------------------------------------
// A recommendation tagged for briefing projection. The module orchestrator
// assigns ids and turns each into a BrainActivity.
// ---------------------------------------------------------------------------
export interface TaggedRecommendation {
  envelope: RecommendationEnvelope;
  subject: string;
  severity: Priority;
  activityType: BrainActivityType;
  kind: 'opportunity' | 'risk';
}

export interface CallGridAnalysis {
  whatChanged: IntelligenceChange[];
  recommendations: TaggedRecommendation[];
  optimizations: OptimizationAction[];
  market: MarketIntelligence;
  predictive: PredictiveIntelligence;
  missingEvidence: string[];
  unknowns: string[];
}

// Rates over a window, each undefined when its denominator is 0.
function qualifiedRate(w: CallGridWindow): number | undefined {
  return ratio(w.qualified, w.calls);
}
function conversionRate(w: CallGridWindow): number | undefined {
  return ratio(w.converted, w.calls);
}

function dimQualifiedRate(d: CallGridDimensionWindow): number | undefined {
  return ratio(d.qualified, d.calls);
}

// ---------------------------------------------------------------------------
// WHAT CHANGED — requires a prior window. Changes, not metrics.
// ---------------------------------------------------------------------------
function pushChange(
  out: IntelligenceChange[],
  metric: string,
  label: string,
  current: number,
  prior: number,
  unit: IntelligenceChange['unit'],
  subject?: string,
): void {
  const pct = changePercent(current, prior);
  out.push({
    metric,
    ...(subject ? { subject } : {}),
    label,
    direction: directionOf(current, prior),
    current,
    prior,
    ...(pct === undefined ? {} : { changePercent: pct }),
    unit,
    significance: significanceOf(pct),
  });
}

export function computeWhatChanged(input: CallGridIntelligenceInput): IntelligenceChange[] {
  const { current, prior } = input;
  if (!prior) return [];
  const changes: IntelligenceChange[] = [];

  pushChange(changes, 'revenue', 'Revenue', current.revenueCents, prior.revenueCents, 'usd_cents');
  pushChange(changes, 'calls', 'Call volume', current.calls, prior.calls, 'count');

  const curMargin = marginCentsOf(current);
  const priMargin = marginCentsOf(prior);
  pushChange(changes, 'margin', 'Gross margin', curMargin, priMargin, 'usd_cents');

  const curQ = qualifiedRate(current);
  const priQ = qualifiedRate(prior);
  if (curQ !== undefined && priQ !== undefined) {
    pushChange(changes, 'qualified_rate', 'Qualified-call rate', curQ, priQ, 'ratio');
  }
  const curC = conversionRate(current);
  const priC = conversionRate(prior);
  if (curC !== undefined && priC !== undefined) {
    pushChange(changes, 'conversion_rate', 'Conversion rate', curC, priC, 'ratio');
  }

  // Top per-buyer and per-source revenue movers (biggest absolute swing first).
  const priorBuyerRev = new Map(prior.buyers.map((b) => [b.key, b.revenueCents]));
  const buyerMovers = current.buyers
    .map((b) => ({ b, prior: priorBuyerRev.get(b.key) ?? 0 }))
    .filter((x) => x.b.calls >= THRESHOLDS.minDimensionCalls)
    .map((x) => ({ ...x, swing: Math.abs(x.b.revenueCents - x.prior) }))
    .sort((a, b) => b.swing - a.swing)
    .slice(0, 2);
  for (const m of buyerMovers) {
    pushChange(changes, 'buyer_revenue', `Buyer revenue — ${m.b.label}`, m.b.revenueCents, m.prior, 'usd_cents', `buyer:${m.b.label}`);
  }

  const priorSourceRev = new Map(prior.sources.map((s) => [s.key, s.revenueCents]));
  const sourceMovers = current.sources
    .map((s) => ({ s, prior: priorSourceRev.get(s.key) ?? 0 }))
    .filter((x) => x.s.calls >= THRESHOLDS.minDimensionCalls)
    .map((x) => ({ ...x, swing: Math.abs(x.s.revenueCents - x.prior) }))
    .sort((a, b) => b.swing - a.swing)
    .slice(0, 2);
  for (const m of sourceMovers) {
    pushChange(changes, 'source_revenue', `Source revenue — ${m.s.label}`, m.s.revenueCents, m.prior, 'usd_cents', `source:${m.s.label}`);
  }

  // Rank: major/notable first, then by absolute percentage magnitude.
  const sigRank: Record<IntelligenceChange['significance'], number> = { major: 0, notable: 1, minor: 2 };
  return changes.sort((a, b) => {
    if (sigRank[a.significance] !== sigRank[b.significance]) return sigRank[a.significance] - sigRank[b.significance];
    return Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0);
  });
}

// ---------------------------------------------------------------------------
// RISKS — downside worth heading off.
// ---------------------------------------------------------------------------
function riskEnvelope(
  input: CallGridIntelligenceInput,
  subjectLabel: string,
  rootCause: RootCause,
  confidence: number,
  reason: string,
  recommendation: string,
  suggestedAction: string,
  expectedStatement: string,
  riskLevel: 'low' | 'medium' | 'high',
  costOfInaction: string,
  businessImpact: string,
  evidence: string[],
  missingEvidence: string[],
  unknowns: string[],
): RecommendationEnvelope {
  return buildEnvelope({
    organizationId: input.organizationId,
    ...(input.locationId ? { locationId: input.locationId } : {}),
    recommendation,
    action: 'operational_recommendation',
    reason,
    rootCause,
    confidence,
    evidence: evidence.map((e) => evidenceRow(e)),
    missingEvidence,
    unknowns,
    suggestedAction,
    expectedOutcome: { statement: expectedStatement },
    risk: { level: riskLevel, description: reason, costOfInaction },
    businessImpact,
  });
}

export function computeRisks(input: CallGridIntelligenceInput): TaggedRecommendation[] {
  const { current, prior } = input;
  const risks: TaggedRecommendation[] = [];

  // Margin compression (needs a prior window).
  if (prior) {
    const curMargin = marginCentsOf(current);
    const priMargin = marginCentsOf(prior);
    const pct = changePercent(curMargin, priMargin);
    if (pct !== undefined && pct <= -THRESHOLDS.marginCompressionPct && priMargin > 0) {
      const severity = priorityFromMagnitude(pct);
      risks.push({
        kind: 'risk',
        subject: 'callgrid:margin',
        severity,
        activityType: 'diagnosis',
        envelope: riskEnvelope(
          input,
          'margin',
          'unknown',
          0.6,
          `Gross margin fell ${fmtPct(pct)} versus the prior window (${usd(priMargin)} → ${usd(curMargin)}), while revenue ${current.revenueCents >= prior.revenueCents ? 'held or rose' : 'also fell'} — payout and telco cost are taking a larger share of each dollar.`,
          'Margin is compressing. Protect it before it reaches the bottom line.',
          'Review buyer payouts and low-margin sources this week; renegotiate or reallocate the worst offenders.',
          'Arresting the compression preserves gross profit at current call volume.',
          'high',
          'Left unaddressed, margin compression compounds: the same calls earn progressively less profit.',
          `Protects gross profit on ~${current.calls} calls/window.`,
          [`Prior margin ${usd(priMargin)}`, `Current margin ${usd(curMargin)}`, `Change ${fmtPct(pct)}`],
          current.callsWithCost < current.calls ? ['Per-call telco cost is present on only some calls; true margin may be lower.'] : [],
          [],
        ),
      });
    }
  }

  // Zero/negative overall margin despite real revenue.
  const overallMargin = marginCentsOf(current);
  if (current.revenueCents > 0 && overallMargin <= 0) {
    risks.push({
      kind: 'risk',
      subject: 'callgrid:margin',
      severity: 'critical',
      activityType: 'diagnosis',
      envelope: riskEnvelope(
        input,
        'margin',
        'unknown',
        0.55,
        `The window is running at or below break-even: ${usd(current.revenueCents)} revenue against ${usd(current.payoutCents + current.costCents)} in payout + cost (margin ${usd(overallMargin)}).`,
        'The marketplace is not profitable this window. Find the losing legs.',
        'Identify the negative-margin buyers and sources below and pause or renegotiate them.',
        'Cutting the losing legs returns the window to positive margin.',
        'high',
        'Every additional call at negative margin deepens the loss.',
        'Directly protects the bottom line.',
        [`Revenue ${usd(current.revenueCents)}`, `Payout+cost ${usd(current.payoutCents + current.costCents)}`, `Margin ${usd(overallMargin)}`],
        [],
        [],
      ),
    });
  }

  // Buyer deterioration (needs prior, per-buyer).
  if (prior) {
    const priorBuyers = new Map(prior.buyers.map((b) => [b.key, b]));
    for (const b of current.buyers) {
      if (b.calls < THRESHOLDS.minDimensionCalls) continue;
      const p = priorBuyers.get(b.key);
      if (!p || p.calls < THRESHOLDS.minDimensionCalls) continue;
      const curR = dimQualifiedRate(b);
      const priR = dimQualifiedRate(p);
      if (curR === undefined || priR === undefined) continue;
      const pct = changePercent(curR, priR);
      if (pct !== undefined && pct <= -THRESHOLDS.rateDeteriorationPct) {
        risks.push({
          kind: 'risk',
          subject: `buyer:${b.label}`,
          severity: priorityFromMagnitude(pct),
          activityType: 'diagnosis',
          envelope: riskEnvelope(
            input,
            b.label,
            'buyer',
            0.55,
            `Buyer ${b.label}'s qualified-call rate fell ${fmtPct(pct)} (${fmtRate(priR)} → ${fmtRate(curR)}) across ${b.calls} calls — the calls sent are converting to qualified leads less often.`,
            `Buyer ${b.label} is deteriorating. Confirm routing and criteria before revenue follows.`,
            `Review the calls routed to ${b.label} for a criteria or routing change; open a conversation with the buyer.`,
            'Restoring the qualified rate protects revenue attributable to this buyer.',
            'medium',
            'A sustained qualified-rate decline typically precedes a revenue decline for the buyer.',
            `Revenue at risk on ${b.label}: ${usd(b.revenueCents)}/window.`,
            [`${b.label} qualified rate ${fmtRate(priR)} → ${fmtRate(curR)}`, `${b.calls} calls this window`],
            ['Transcript-level rejection causes would confirm whether the decline is criteria, routing, or lead quality.'],
            ['Whether the cause is buyer criteria, source quality, or routing.'],
          ),
        });
      }
    }
  }

  // Declining acceptance / unwinnable auctions — bid facts only.
  if (input.bids) {
    const { rejectRate, winRate } = input.bids;
    if (rejectRate !== undefined && rejectRate >= THRESHOLDS.highRejectRate) {
      const topReason = [...input.bids.rejections].sort((a, b) => b.count - a.count)[0];
      risks.push({
        kind: 'risk',
        subject: 'callgrid:acceptance',
        severity: 'high',
        activityType: 'diagnosis',
        envelope: riskEnvelope(
          input,
          'acceptance',
          'buyer',
          0.6,
          `Bid rejection rate is ${fmtRate(rejectRate)}${topReason ? `, led by "${topReason.reason}" (${topReason.count})` : ''} — a large share of pings are not converting to accepted bids.`,
          'Acceptance is low. Address the leading rejection cause.',
          topReason ? `Investigate "${topReason.reason}" rejections and adjust bids, tags, or targeting.` : 'Investigate the leading rejection causes and adjust bids/targeting.',
          'Reducing rejections recovers auctions that are currently lost before revenue.',
          'medium',
          'Unaddressed rejections waste traffic spend on pings that never win.',
          'Recovers otherwise-lost auctions.',
          [`Reject rate ${fmtRate(rejectRate)}`, ...(topReason ? [`Top reason ${topReason.reason} (${topReason.count})`] : [])],
          [],
          [],
        ),
      });
    }
    if (winRate !== undefined && winRate <= THRESHOLDS.lowWinRate) {
      // Low win rate is surfaced as an optimization (bid up) rather than a pure
      // risk when margin is healthy; handled in computeOptimizations.
      void winRate;
    }
  }

  return risks;
}

// ---------------------------------------------------------------------------
// OPPORTUNITIES — upside worth pursuing.
// ---------------------------------------------------------------------------
export function computeOpportunities(input: CallGridIntelligenceInput): TaggedRecommendation[] {
  const { current, prior } = input;
  const opps: TaggedRecommendation[] = [];
  const priorSourceRev = new Map((prior?.sources ?? []).map((s) => [s.key, s.revenueCents]));

  // Scale candidates: high qualified rate + positive margin, ranked by margin.
  const scaleCandidates = [...current.sources, ...current.campaigns]
    .filter((d) => d.calls >= THRESHOLDS.minDimensionCalls)
    .map((d) => ({ d, qr: dimQualifiedRate(d), margin: marginCentsOf(d) }))
    .filter((x) => x.qr !== undefined && x.qr >= THRESHOLDS.highQualifiedRate && x.margin > 0)
    .sort((a, b) => b.margin - a.margin)
    .slice(0, 2);

  for (const c of scaleCandidates) {
    const rising = prior ? c.d.revenueCents > (priorSourceRev.get(c.d.key) ?? 0) : false;
    opps.push({
      kind: 'opportunity',
      subject: `source:${c.d.label}`,
      severity: 'normal',
      activityType: 'recommendation',
      envelope: buildEnvelope({
        organizationId: input.organizationId,
        ...(input.locationId ? { locationId: input.locationId } : {}),
        recommendation: `Increase allocation to ${c.d.label} — it qualifies ${fmtRate(c.qr!)} of calls at ${usd(c.margin)} margin${rising ? ' and is growing' : ''}.`,
        action: 'operational_recommendation',
        reason: `${c.d.label} is a high-quality, profitable leg: ${c.d.calls} calls, ${fmtRate(c.qr!)} qualified, ${usd(c.margin)} gross margin${rising ? ', with revenue rising versus the prior window' : ''}.`,
        rootCause: 'unknown',
        confidence: rising ? 0.6 : 0.5,
        evidence: [
          evidenceRow(`${c.d.label}: ${c.d.calls} calls, ${fmtRate(c.qr!)} qualified`),
          evidenceRow(`Gross margin ${usd(c.margin)}`),
          ...(rising ? [evidenceRow('Revenue rising vs prior window')] : []),
        ],
        missingEvidence: input.bids ? [] : ['Bid/auction facts would confirm headroom to win more of this traffic.'],
        unknowns: prior ? [] : ['Whether this strength is sustained — no prior window to compare.'],
        suggestedAction: `Raise budget or routing weight toward ${c.d.label} and re-measure next window.`,
        expectedOutcome: { statement: `More qualified calls at a comparable ${usd(c.margin)}-margin profile.`, metric: 'qualified_calls' },
        risk: { level: 'low', description: 'Scaling a source can regress quality as volume grows; re-measure.', costOfInaction: 'Leaving a profitable, high-quality source under-allocated forgoes margin.' },
        businessImpact: `Grows profitable volume on the best-performing traffic.`,
      }),
    });
  }

  // Buyer ready to scale: high conversion + positive margin + rising revenue.
  if (prior) {
    const priorBuyers = new Map(prior.buyers.map((b) => [b.key, b]));
    const buyerScale = current.buyers
      .filter((b) => b.calls >= THRESHOLDS.minDimensionCalls)
      .map((b) => ({ b, cr: ratio(b.converted, b.calls), margin: marginCentsOf(b), prior: priorBuyers.get(b.key) }))
      .filter((x) => x.cr !== undefined && x.margin > 0 && x.prior && x.b.revenueCents > x.prior.revenueCents)
      .sort((a, b) => b.margin - a.margin)
      .slice(0, 1);
    for (const x of buyerScale) {
      opps.push({
        kind: 'opportunity',
        subject: `buyer:${x.b.label}`,
        severity: 'normal',
        activityType: 'recommendation',
        envelope: buildEnvelope({
          organizationId: input.organizationId,
          ...(input.locationId ? { locationId: input.locationId } : {}),
          recommendation: `Send ${x.b.label} more volume — converting ${fmtRate(x.cr!)} at ${usd(x.margin)} margin and growing.`,
          action: 'operational_recommendation',
          reason: `Buyer ${x.b.label} converts ${fmtRate(x.cr!)} of ${x.b.calls} calls at ${usd(x.margin)} margin, with revenue up versus the prior window — it has appetite for more.`,
          rootCause: 'buyer',
          confidence: 0.6,
          evidence: [
            evidenceRow(`${x.b.label}: ${x.b.calls} calls, ${fmtRate(x.cr!)} converted`),
            evidenceRow(`Gross margin ${usd(x.margin)}`),
            evidenceRow('Revenue rising vs prior window'),
          ],
          missingEvidence: ['Buyer cap/capacity is not exposed by CallGrid; the ceiling on additional volume is unknown.'],
          unknowns: ['How much additional volume the buyer will accept before its cap.'],
          suggestedAction: `Offer ${x.b.label} additional matching traffic, or request a payout/volume increase.`,
          expectedOutcome: { statement: 'More converted calls and revenue at a comparable margin.', metric: 'revenue' },
          risk: { level: 'low', description: 'Buyer may cap or lower payout as volume rises.', costOfInaction: 'A growing, profitable buyer left under-supplied caps revenue.' },
          businessImpact: 'Grows revenue with a proven, profitable buyer.',
        }),
      });
    }
  }

  return opps;
}

// ---------------------------------------------------------------------------
// OPTIMIZATIONS — concrete lever tuning.
// ---------------------------------------------------------------------------
export function computeOptimizations(input: CallGridIntelligenceInput): OptimizationAction[] {
  const { current } = input;
  const actions: OptimizationAction[] = [];

  // Sources wasting money: cost incurred, margin negative (or ~0 revenue + low quality).
  const wasteful = current.sources
    .filter((s) => s.calls >= THRESHOLDS.minDimensionCalls)
    .map((s) => ({ s, margin: marginCentsOf(s), qr: dimQualifiedRate(s) }))
    .filter((x) => x.margin < 0 || (x.s.revenueCents === 0 && x.s.costCents > 0) || (x.qr !== undefined && x.qr <= THRESHOLDS.lowQualifiedRate))
    .sort((a, b) => a.margin - b.margin)
    .slice(0, 3);
  for (const x of wasteful) {
    const negative = x.margin < 0;
    actions.push({
      kind: negative ? 'pause' : 'decrease',
      target: `source:${x.s.key}`,
      targetLabel: x.s.label,
      reason: negative
        ? `${x.s.label} is losing money: ${usd(x.s.revenueCents)} revenue against ${usd(x.s.payoutCents + x.s.costCents)} payout+cost (margin ${usd(x.margin)}) over ${x.s.calls} calls.`
        : `${x.s.label} qualifies only ${x.qr !== undefined ? fmtRate(x.qr) : 'few'} of ${x.s.calls} calls${x.s.revenueCents === 0 ? ' and produced no revenue' : ''} while incurring cost.`,
      expectedImpact: negative
        ? `Pausing removes a ${usd(-x.margin)} loss/window.`
        : 'Trimming spend here reduces wasted cost with little revenue at stake.',
      confidence: negative ? 0.65 : 0.5,
      evidence: [
        evidenceRow(`${x.s.label}: ${x.s.calls} calls, margin ${usd(x.margin)}`),
        evidenceRow(`Revenue ${usd(x.s.revenueCents)}, payout+cost ${usd(x.s.payoutCents + x.s.costCents)}`),
      ],
    });
  }

  // Negative-margin buyers → negotiate payout.
  const negotiate = current.buyers
    .filter((b) => b.calls >= THRESHOLDS.minDimensionCalls && marginCentsOf(b) < 0)
    .sort((a, b) => marginCentsOf(a) - marginCentsOf(b))
    .slice(0, 2);
  for (const b of negotiate) {
    const margin = marginCentsOf(b);
    actions.push({
      kind: 'negotiate',
      target: `buyer:${b.key}`,
      targetLabel: b.label,
      reason: `${b.label} pays ${usd(b.payoutCents)} on ${usd(b.revenueCents)} revenue across ${b.calls} calls — a negative ${usd(margin)} margin.`,
      expectedImpact: `Renegotiating payout or reallocating this traffic recovers up to ${usd(-margin)}/window.`,
      confidence: 0.55,
      evidence: [
        evidenceRow(`${b.label}: revenue ${usd(b.revenueCents)}, payout ${usd(b.payoutCents)}`),
        evidenceRow(`Margin ${usd(margin)} over ${b.calls} calls`),
      ],
    });
  }

  // Bid tuning — bid facts only. Absent → no fabricated bid advice.
  if (input.bids?.bySource) {
    for (const s of input.bids.bySource) {
      if (s.winRate === undefined) continue;
      if (s.winRate <= THRESHOLDS.lowWinRate) {
        actions.push({
          kind: 'increase',
          target: `bid:${s.key}`,
          targetLabel: s.label,
          reason: `${s.label} wins only ${fmtRate(s.winRate)} of auctions — bids may be under market.`,
          expectedImpact: 'A higher bid should win more of this traffic; re-measure win rate and margin.',
          confidence: 0.5,
          evidence: [evidenceRow(`${s.label} win rate ${fmtRate(s.winRate)}`)],
        });
      } else if (s.winRate >= THRESHOLDS.highWinRate) {
        actions.push({
          kind: 'decrease',
          target: `bid:${s.key}`,
          targetLabel: s.label,
          reason: `${s.label} wins ${fmtRate(s.winRate)} of auctions — there may be room to lower bids and hold volume while widening margin.`,
          expectedImpact: 'A lower bid may preserve most volume at a better margin; re-measure.',
          confidence: 0.45,
          evidence: [evidenceRow(`${s.label} win rate ${fmtRate(s.winRate)}`)],
        });
      }
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// MARKET INTELLIGENCE — behavior shifts we CAN see; pricing/competition we
// mostly cannot (needs multi-window bid facts we do not have).
// ---------------------------------------------------------------------------
export function computeMarket(
  input: CallGridIntelligenceInput,
  whatChanged: IntelligenceChange[],
): MarketIntelligence {
  const observations: MarketObservation[] = [];

  // Buyer/vendor behavior shifts derived from real per-dimension deltas.
  const buyerShift = whatChanged.find((c) => c.metric === 'buyer_revenue' && c.significance !== 'minor');
  if (buyerShift) {
    observations.push({
      label: 'Buyer behavior shift',
      detail: `${buyerShift.label} ${buyerShift.direction === 'up' ? 'rose' : 'fell'} ${buyerShift.changePercent !== undefined ? fmtPct(buyerShift.changePercent) : 'materially'} — a shift in how much this buyer is taking.`,
      confidence: 0.5,
    });
  }
  const sourceShift = whatChanged.find((c) => c.metric === 'source_revenue' && c.significance !== 'minor');
  if (sourceShift) {
    observations.push({
      label: 'Vendor/source behavior shift',
      detail: `${sourceShift.label} ${sourceShift.direction === 'up' ? 'rose' : 'fell'} ${sourceShift.changePercent !== undefined ? fmtPct(sourceShift.changePercent) : 'materially'} — traffic contribution from this source is changing.`,
      confidence: 0.5,
    });
  }

  // Winning-bid / market-pricing / competitive-pressure / seasonality all need
  // evidence we do not have on the call-economics path.
  const notEnough: string[] = [];
  if (!input.bids) {
    notEnough.push('winning-bid trends, market pricing and competitive pressure (no bid/auction report facts supplied)');
  } else {
    // With a single window of bid facts we can state a level, not a trend.
    if (input.bids.avgWinningBidCents !== undefined) {
      observations.push({
        label: 'Winning-bid level',
        detail: `Average winning bid is ${usd(input.bids.avgWinningBidCents)} this window. A prior window of bid facts is needed to establish a pricing trend.`,
        confidence: 0.4,
      });
    }
    notEnough.push('winning-bid trend and seasonality (only one window of bid facts available)');
  }

  return observations.length > 0
    ? { observations, ...(notEnough.length ? { notEnoughDataReason: `Not enough data for ${notEnough.join('; ')}.` } : {}) }
    : { observations: [], notEnoughDataReason: `Not enough data for market pricing, competitive pressure or seasonality: ${notEnough.join('; ') || 'no comparable market facts on the current data path'}.` };
}

// ---------------------------------------------------------------------------
// PREDICTIVE INTELLIGENCE — honest, low-confidence, single-trend projections.
// ---------------------------------------------------------------------------
export function computePredictive(input: CallGridIntelligenceInput): PredictiveIntelligence {
  const { current, prior } = input;
  if (!prior) {
    return {
      projections: [],
      notEnoughDataReason: 'No prior window to establish a trend, so no projection can be made without guessing.',
    };
  }

  const projections: PredictiveProjection[] = [];
  const curMargin = marginCentsOf(current);
  const priMargin = marginCentsOf(prior);
  const marginPct = changePercent(curMargin, priMargin);

  if (marginPct !== undefined && marginPct <= -THRESHOLDS.marginCompressionPct) {
    const projected = Math.round(curMargin + (curMargin - priMargin));
    projections.push({
      statement: `If the current trend holds, gross margin declines again next window, toward roughly ${usd(projected)}.`,
      metric: 'margin',
      projected,
      unit: 'usd_cents',
      confidence: 0.35,
      basis: 'Linear extrapolation of a single prior→current change. Low confidence by construction — one period is a direction, not a forecast.',
    });

    // A source trending toward unprofitable.
    const priorSourceMargin = new Map(prior.sources.map((s) => [s.key, marginCentsOf(s)]));
    const crossing = current.sources
      .filter((s) => s.calls >= THRESHOLDS.minDimensionCalls)
      .map((s) => ({ s, cur: marginCentsOf(s), pri: priorSourceMargin.get(s.key) }))
      .filter((x) => x.pri !== undefined && x.pri > 0 && x.cur > 0 && x.cur < x.pri && x.cur - (x.pri - x.cur) < 0)
      .slice(0, 1);
    for (const x of crossing) {
      projections.push({
        statement: `If ${x.s.label}'s margin keeps falling at the current rate, it turns unprofitable within about one more window.`,
        metric: 'source_margin',
        unit: 'usd_cents',
        confidence: 0.3,
        basis: `${x.s.label} margin ${usd(x.pri!)} → ${usd(x.cur)}; extrapolating the same drop crosses zero next window.`,
      });
    }
  }

  return projections.length > 0
    ? { projections, notEnoughDataReason: 'Buyer-cap projections are unavailable: CallGrid does not expose buyer caps, so "buyer reaches cap" cannot be forecast.' }
    : { projections: [], notEnoughDataReason: 'No material trend to project: margin and volume are broadly stable versus the prior window.' };
}

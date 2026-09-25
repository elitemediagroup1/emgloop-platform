// AI capacity: lanes, the recorded operating budget, and the cost ceilings. PR 1 (AI runtime).
//
// Architecture: the Loop Intelligence blueprint, section 8 (approved 2026-09-25). The reviewed
// budget POLICY (routing-policy.ts in @emgloop/providers) still bounds every call's tokens and every
// window's invocations. This file adds the second half: what a day of AI is allowed to COST, split
// into lanes so that background work can never starve live work.
//
// FOUR LANES. Every invocation runs in exactly one:
//   FORWARD      live triage of new messages (a person's day depends on it);
//   SYNTHESIS    domain readings, cross-domain synthesis, verification, the briefing;
//   INTERACTIVE  a person clicked (an explanation, a draft);
//   BACKGROUND   hydration, backfill, any historical import. Isolated: it never borrows.
// A task's route names its lane; a caller may only move work DOWN to BACKGROUND, never claim a lane
// its route does not name.
//
// THE OPERATING BUDGET IS RECORDED, NOT DEPLOYED. The figures an operator raises from observed usage
// live in `ai_controls` (scope BUDGET), read by the gateway with the same short cache and fail-closed
// behaviour as the provider policy. Code holds only (a) the MAXIMUMS a recorded budget may never
// exceed -- the architecture's stress-test ceiling, $100 a day -- and (b) the one limit that is always
// on: the EMERGENCY CEILING of $25 across every organization over a trailing 24 hours.
//
// ABSENT MEANS TODAY'S BEHAVIOUR. With no recorded budget, admission is exactly the reviewed budget
// policy plus the emergency ceiling -- lanes are recorded on every call but no lane cap applies. That
// is deliberate: recording the first budget is an explicit commissioning act, not a side effect of a
// deploy. A recorded budget that cannot be read or does not validate refuses every call (it never
// falls back to "no limits").
//
// COST IS RESERVED AT THE CEILING. A call's cost estimate is its input estimate and its route's full
// output ceiling at the route's price, reserved before the call and replaced by the reported cost
// after it. Spend therefore cannot pass a cap even if every call runs to its ceiling.
//
// PURE. No clock, no I/O. Counters are supplied by the caller.

import type { AiAdmissionRefusal, AiBudgetPolicy } from './runtime';

export const AI_LANES = ['FORWARD', 'SYNTHESIS', 'INTERACTIVE', 'BACKGROUND'] as const;
export type AiLane = (typeof AI_LANES)[number];

export function isAiLane(value: unknown): value is AiLane {
  return typeof value === 'string' && (AI_LANES as readonly string[]).includes(value);
}

/** One micro-dollar is a millionth of a dollar; $1 is exactly 1_000_000. */
export const AI_MICROS_PER_DOLLAR = 1_000_000;

/**
 * Always on, recorded budget or not: every organization, every lane, a trailing 24 hours. Reaching it
 * means an organization cap failed to hold (two business days meeting across midnight, or a bug), so
 * it is treated as an incident. A recorded budget may lower it and may raise it only to its maximum.
 */
export const AI_DEFAULT_EMERGENCY_CEILING_MICROS = 25 * AI_MICROS_PER_DOLLAR;

export interface AiLaneBudget {
  /** What this lane may spend per organization per business day, in micro-dollars. */
  readonly dailyCostMicros: number;
  /** Optional: how many calls this lane may make per organization per business day. */
  readonly maxInvocations?: number | null;
}

/** When the per-task circuit breaker opens: this many FAILED or REJECTED calls in the trailing window. */
export interface AiCircuitBreaker {
  readonly failures: number;
  readonly windowMinutes: number;
}

/**
 * The operating budget, as recorded (`ai_controls`, scope BUDGET). Every amount is integer
 * micro-dollars. Invocation caps REPLACE the reviewed policy's invocation caps while recorded; the
 * policy's token caps and per-call limits stay in force underneath.
 */
export interface AiOperatingBudget {
  /** A label an operator chose, e.g. `operating.2026-09-26.1`. Shown on the status page. */
  readonly label: string;
  /** Per organization, per its business day, every lane together. */
  readonly organizationDailyCostMicros: number;
  /** Trailing 24 hours, every organization, every lane. */
  readonly emergencyCostMicros: number;
  readonly lanes: Readonly<Record<AiLane, AiLaneBudget>>;
  /** Unallocated room FORWARD alone may use after its own lane is spent. */
  readonly forwardReserveCostMicros: number;
  /** BACKGROUND is refused while the organization has spent this much today... */
  readonly backgroundMaxOrganizationSpendMicros: number;
  /** ...or while FORWARD has used at least this fraction of its lane (0..1). */
  readonly backgroundMaxForwardUsedFraction: number;
  /** Invocation caps per BUDGET CLASS (the reviewed policy's classes), per organization per day. */
  readonly classInvocations: Readonly<Record<string, number>>;
  readonly organizationDailyInvocations: number;
  readonly globalDailyInvocations: number;
  /** Null: no breaker. */
  readonly circuitBreaker: AiCircuitBreaker | null;
}

/**
 * What a recorded budget may never exceed without a code change: the architecture's stress-test
 * ceiling. Raising any of these is a reviewed pull request, not an operations run.
 */
export const AI_OPERATING_BUDGET_MAXIMUMS = Object.freeze({
  organizationDailyCostMicros: 100 * AI_MICROS_PER_DOLLAR,
  emergencyCostMicros: 125 * AI_MICROS_PER_DOLLAR,
  classInvocations: 2_000,
  organizationDailyInvocations: 5_000,
  globalDailyInvocations: 6_000,
  laneInvocations: 5_000,
  breakerFailures: 1_000,
  breakerWindowMinutes: 24 * 60,
  labelChars: 80,
});

export const AI_OPERATING_BUDGET_REFUSALS = [
  'NOT_AN_OBJECT',
  'LABEL_INVALID',
  'AMOUNT_INVALID',
  'AMOUNT_ABOVE_MAXIMUM',
  'LANE_MISSING',
  'LANE_UNKNOWN',
  'LANES_EXCEED_ORGANIZATION',
  'EMERGENCY_BELOW_ORGANIZATION',
  'FRACTION_INVALID',
  'CLASS_UNKNOWN',
  'INVOCATIONS_INVALID',
  'BREAKER_INVALID',
  'UNKNOWN_KEY',
] as const;
export type AiOperatingBudgetRefusal = (typeof AI_OPERATING_BUDGET_REFUSALS)[number];

const BUDGET_KEYS = [
  'label',
  'organizationDailyCostMicros',
  'emergencyCostMicros',
  'lanes',
  'forwardReserveCostMicros',
  'backgroundMaxOrganizationSpendMicros',
  'backgroundMaxForwardUsedFraction',
  'classInvocations',
  'organizationDailyInvocations',
  'globalDailyInvocations',
  'circuitBreaker',
] as const;

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function wholeAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Everything wrong with an operating budget, checked TOTALLY: an unknown key is refused, not ignored,
 * because a misspelt cap that is silently dropped is a cap nobody has. `knownClasses` are the reviewed
 * policy's budget classes; a budget may not invent one.
 */
export function aiOperatingBudgetRefusals(value: unknown, knownClasses: readonly string[]): AiOperatingBudgetRefusal[] {
  if (!isRecord(value)) return ['NOT_AN_OBJECT'];
  const out: AiOperatingBudgetRefusal[] = [];
  const M = AI_OPERATING_BUDGET_MAXIMUMS;
  if (Object.keys(value).some((k) => !(BUDGET_KEYS as readonly string[]).includes(k))) out.push('UNKNOWN_KEY');
  if (typeof value.label !== 'string' || !LABEL.test(value.label)) out.push('LABEL_INVALID');

  const amount = (v: unknown, max: number) => {
    if (!wholeAmount(v)) out.push('AMOUNT_INVALID');
    else if (v > max) out.push('AMOUNT_ABOVE_MAXIMUM');
  };
  amount(value.organizationDailyCostMicros, M.organizationDailyCostMicros);
  amount(value.emergencyCostMicros, M.emergencyCostMicros);
  amount(value.forwardReserveCostMicros, M.organizationDailyCostMicros);
  amount(value.backgroundMaxOrganizationSpendMicros, M.organizationDailyCostMicros);

  const org = wholeAmount(value.organizationDailyCostMicros) ? value.organizationDailyCostMicros : null;
  if (org !== null && wholeAmount(value.emergencyCostMicros) && value.emergencyCostMicros < org) out.push('EMERGENCY_BELOW_ORGANIZATION');

  if (!isRecord(value.lanes)) out.push('LANE_MISSING');
  else {
    const lanes = value.lanes;
    if (Object.keys(lanes).some((k) => !isAiLane(k))) out.push('LANE_UNKNOWN');
    let laneTotal = 0;
    for (const lane of AI_LANES) {
      const entry = lanes[lane];
      if (!isRecord(entry)) {
        out.push('LANE_MISSING');
        continue;
      }
      if (Object.keys(entry).some((k) => k !== 'dailyCostMicros' && k !== 'maxInvocations')) out.push('UNKNOWN_KEY');
      amount(entry.dailyCostMicros, M.organizationDailyCostMicros);
      if (wholeAmount(entry.dailyCostMicros)) laneTotal += entry.dailyCostMicros;
      if (entry.maxInvocations !== undefined && entry.maxInvocations !== null) {
        if (!wholeAmount(entry.maxInvocations) || entry.maxInvocations > M.laneInvocations) out.push('INVOCATIONS_INVALID');
      }
    }
    // The lanes and the forward reserve partition the organization's day; they may not promise more.
    const reserve = wholeAmount(value.forwardReserveCostMicros) ? value.forwardReserveCostMicros : 0;
    if (org !== null && laneTotal + reserve > org) out.push('LANES_EXCEED_ORGANIZATION');
  }

  const fraction = value.backgroundMaxForwardUsedFraction;
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) out.push('FRACTION_INVALID');

  if (!isRecord(value.classInvocations)) out.push('INVOCATIONS_INVALID');
  else {
    for (const [cls, cap] of Object.entries(value.classInvocations)) {
      if (!knownClasses.includes(cls)) out.push('CLASS_UNKNOWN');
      if (!wholeAmount(cap) || cap > M.classInvocations) out.push('INVOCATIONS_INVALID');
    }
  }
  if (!wholeAmount(value.organizationDailyInvocations) || value.organizationDailyInvocations > M.organizationDailyInvocations) out.push('INVOCATIONS_INVALID');
  if (!wholeAmount(value.globalDailyInvocations) || value.globalDailyInvocations > M.globalDailyInvocations) out.push('INVOCATIONS_INVALID');

  const breaker = value.circuitBreaker;
  if (breaker !== null) {
    if (!isRecord(breaker) || Object.keys(breaker).some((k) => k !== 'failures' && k !== 'windowMinutes')) out.push('BREAKER_INVALID');
    else if (
      !wholeAmount(breaker.failures) ||
      breaker.failures < 1 ||
      breaker.failures > M.breakerFailures ||
      !wholeAmount(breaker.windowMinutes) ||
      breaker.windowMinutes < 1 ||
      breaker.windowMinutes > M.breakerWindowMinutes
    ) {
      out.push('BREAKER_INVALID');
    }
  }
  return [...new Set(out)];
}

/** A value that passed `aiOperatingBudgetRefusals`, frozen. Null when it did not. */
export function aiOperatingBudgetOf(value: unknown, knownClasses: readonly string[]): AiOperatingBudget | null {
  if (aiOperatingBudgetRefusals(value, knownClasses).length > 0) return null;
  const v = value as AiOperatingBudget;
  return Object.freeze({
    ...v,
    lanes: Object.freeze(Object.fromEntries(AI_LANES.map((l) => [l, Object.freeze({ ...v.lanes[l] })]))) as Readonly<Record<AiLane, AiLaneBudget>>,
    classInvocations: Object.freeze({ ...v.classInvocations }),
    circuitBreaker: v.circuitBreaker ? Object.freeze({ ...v.circuitBreaker }) : null,
  });
}

/**
 * The reviewed budget policy with a recorded operating budget's invocation caps applied. With no
 * recorded budget it is the reviewed policy UNCHANGED -- the same object -- so today's admission is
 * exactly what it was. Token caps and per-call limits always come from the reviewed policy.
 */
export function aiEffectiveBudgetPolicy(policy: AiBudgetPolicy, operating: AiOperatingBudget | null): AiBudgetPolicy {
  if (!operating) return policy;
  const classes = Object.fromEntries(
    Object.entries(policy.classes).map(([name, cls]) => {
      const cap = operating.classInvocations[name];
      return [name, cap === undefined ? cls : { ...cls, taskDaily: { ...cls.taskDaily, maxInvocations: cap } }];
    }),
  );
  return Object.freeze({
    version: `${policy.version}+${operating.label}`,
    classes: Object.freeze(classes),
    organizationDaily: Object.freeze({ ...policy.organizationDaily, maxInvocations: operating.organizationDailyInvocations }),
    globalDaily: Object.freeze({ ...policy.globalDaily, maxInvocations: operating.globalDailyInvocations }),
  });
}

/** What has been spent, in micro-dollars and calls, in the windows the capacity checks read. */
export interface AiCostSnapshot {
  /** This organization, its business day, every lane. */
  readonly organizationMicros: number;
  /** This organization, its business day, per lane. */
  readonly laneMicros: Readonly<Record<AiLane, number>>;
  readonly laneInvocations: Readonly<Record<AiLane, number>>;
  /** Every organization the runtime is enabled for, trailing 24 hours. */
  readonly globalMicros: number;
  /** This task's FAILED and REJECTED calls in this organization over the breaker's trailing window. */
  readonly taskRecentFailures: number;
}

export const AI_NO_COST: AiCostSnapshot = Object.freeze({
  organizationMicros: 0,
  laneMicros: Object.freeze({ FORWARD: 0, SYNTHESIS: 0, INTERACTIVE: 0, BACKGROUND: 0 }),
  laneInvocations: Object.freeze({ FORWARD: 0, SYNTHESIS: 0, INTERACTIVE: 0, BACKGROUND: 0 }),
  globalMicros: 0,
  taskRecentFailures: 0,
});

/**
 * Whether ONE more call of this cost fits, in this lane. "Fits" includes the call itself.
 *
 *   emergency   always, from the recorded budget or the default: global spend + this call;
 *   cost        with a recorded budget: the organization's day, and the lane (FORWARD may also use
 *               the forward reserve);
 *   background  with a recorded budget: refused while the organization's day or FORWARD's lane is
 *               too far along, so live work keeps its headroom;
 *   invocations a lane's own call cap, when it names one;
 *   breaker     too many recent failures of this task.
 *
 * An unpriced call cannot be held to a cost cap, so under a recorded budget it is refused.
 */
export function aiCapacityRefusals(input: {
  readonly operating: AiOperatingBudget | null;
  readonly lane: AiLane;
  readonly estimateMicros: number | null;
  readonly cost: AiCostSnapshot;
}): AiAdmissionRefusal[] {
  const { operating, lane, cost } = input;
  const out: AiAdmissionRefusal[] = [];
  const estimate = input.estimateMicros ?? 0;
  const emergency = operating ? operating.emergencyCostMicros : AI_DEFAULT_EMERGENCY_CEILING_MICROS;
  if (cost.globalMicros + estimate > emergency) out.push('BUDGET_EMERGENCY_CEILING');
  if (!operating) return out;

  if (input.estimateMicros === null) out.push('BUDGET_COST_UNPRICED');
  if (cost.organizationMicros + estimate > operating.organizationDailyCostMicros) out.push('BUDGET_ORGANIZATION_COST_EXHAUSTED');

  const laneBudget = operating.lanes[lane];
  const laneRoom = laneBudget.dailyCostMicros + (lane === 'FORWARD' ? operating.forwardReserveCostMicros : 0);
  if (cost.laneMicros[lane] + estimate > laneRoom) out.push('BUDGET_LANE_EXHAUSTED');
  if (typeof laneBudget.maxInvocations === 'number' && cost.laneInvocations[lane] + 1 > laneBudget.maxInvocations) out.push('BUDGET_LANE_EXHAUSTED');

  if (lane === 'BACKGROUND') {
    const forwardCap = operating.lanes.FORWARD.dailyCostMicros;
    const forwardUsed = forwardCap > 0 ? cost.laneMicros.FORWARD / forwardCap : 1;
    if (cost.organizationMicros >= operating.backgroundMaxOrganizationSpendMicros || forwardUsed >= operating.backgroundMaxForwardUsedFraction) {
      out.push('BUDGET_BACKGROUND_DEFERRED');
    }
  }

  if (operating.circuitBreaker && cost.taskRecentFailures >= operating.circuitBreaker.failures) out.push('TASK_CIRCUIT_OPEN');
  return out;
}

/**
 * The initial production operating budget (blueprint section 8, approved as an initial control to be
 * recalibrated from telemetry): $20 per organization per business day, $25 emergency, four lanes.
 * Recorded by the `record-ai-budget` workflow when an operator chooses it; nothing applies it
 * automatically. The class caps are for today's two AI-enabled people; they rise per person.
 */
export const AI_OPERATING_BUDGET_INITIAL: AiOperatingBudget = Object.freeze({
  label: 'operating.initial.1',
  organizationDailyCostMicros: 20 * AI_MICROS_PER_DOLLAR,
  emergencyCostMicros: 25 * AI_MICROS_PER_DOLLAR,
  lanes: Object.freeze({
    FORWARD: Object.freeze({ dailyCostMicros: 8 * AI_MICROS_PER_DOLLAR }),
    SYNTHESIS: Object.freeze({ dailyCostMicros: 6 * AI_MICROS_PER_DOLLAR }),
    INTERACTIVE: Object.freeze({ dailyCostMicros: 2_500_000 }),
    BACKGROUND: Object.freeze({ dailyCostMicros: 2 * AI_MICROS_PER_DOLLAR, maxInvocations: 60 }),
  }),
  forwardReserveCostMicros: 1_500_000,
  backgroundMaxOrganizationSpendMicros: 12 * AI_MICROS_PER_DOLLAR,
  backgroundMaxForwardUsedFraction: 0.75,
  // telegram-content-triage: 30 forward per Telegram person (1 today) + 40 background hydration.
  classInvocations: Object.freeze({ 'telegram-content-triage': 70, 'mail-reply-draft': 10, 'case-explanation': 6 }),
  organizationDailyInvocations: 300,
  globalDailyInvocations: 360,
  circuitBreaker: Object.freeze({ failures: 10, windowMinutes: 60 }),
});

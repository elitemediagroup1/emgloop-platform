// The Objective Measure Binding contract, v1 -- how a Performance Objective
// acquires something Loop can honestly measure it against.
//
// WHY THIS FILE EXISTS. Stage 1 gave Loop human-authored intent and deliberately
// refused to give it a metric: "knowing WHAT MATTERS precedes calculating whether
// a number was hit." That refusal was correct and it is now the binding
// constraint -- Stage 3 cannot say "conversion fell relative to THIS objective"
// without knowing which population and which measure the objective refers to.
//
// THIS IS NOT A KPI SYSTEM, AND THE ABSENCES ARE THE DESIGN. There is no target,
// no baseline, no target date, no unit column, no attainment, no progress, no
// achievement state and no formula builder. Every one of them is a claim about
// measured performance against a goal, which is a different product and a
// separate approval. A binding says WHAT TO MEASURE and WHICH ROWS COUNT. It says
// nothing about whether the number is good enough.
//
// THE POPULATION IS SELECTED, NEVER INFERRED. Loop does not parse the objective's
// prose, does not derive a vertical from provider labels, and does not model
// geography. It offers the dimension members it has ACTUALLY OBSERVED and a human
// ticks the ones that count. That confirmation is the definition -- permanently,
// and inspectably.
//
// WHY NOT DERIVE THE POPULATION FROM COMMERCIAL SIGNALS. Because TERM_MATCH is a
// deliberately dumb lexical mechanism whose own contract says "commercial
// relevance is not lexical overlap", and production has already put an SSDI call,
// a Final Expense call and a Pest Control call into the signal set for "Grow
// roofing lead revenue in Texas". Using that set as a denominator would turn a
// documented limitation into a percentage. Signals may be CITED beside a
// measurement; they may never define one.
//
// LABELS ARE DISPLAY, IDENTITY IS THE EXTERNAL ID. A provider label is text that
// can be re-spelled upstream ("Roofing - TX" and "Roofing - Texas" are the same
// business motion and different strings). A member with no stable external id
// therefore cannot be bound at all -- see `BindingMemberCandidate`.
//
// PRISMA-FREE, deliberately -- the rule `performance-objective.ts` and
// `commercial-signal.ts` already follow.

export const OBJECTIVE_MEASURE_BINDING_CONTRACT_VERSION = 'objective-measure-binding.v1';

// --- What can be measured -----------------------------------------------------

/**
 * The measures Loop can compute honestly TODAY, and nothing else.
 *
 * A CLOSED VOCABULARY. Every member maps to a quantity that already exists on
 * `marketplace_calls` and a formula that already exists in the CallGrid metric
 * contract. Adding a member is a change to this file plus a real formula; it is
 * never a free-text string a caller invents, and it is never a column a
 * migration has to add -- the persisted column is a String precisely so a sixth
 * measure is a contract change rather than production DDL, the same reasoning
 * `CommercialSignal.relevanceBasis` gives.
 */
export const MEASURE_METRICS = [
  'CALL_VOLUME',
  'REVENUE',
  'MONETIZED_RATE',
  'CONVERSION_RATE',
  'NO_ROUTE_RATE',
] as const;
export type MeasureMetric = (typeof MEASURE_METRICS)[number];

export function isMeasureMetric(v: string): v is MeasureMetric {
  return (MEASURE_METRICS as readonly string[]).includes(v);
}

/**
 * What a measured value IS.
 *
 * Derived from the metric rather than stored, so a value and its unit can never
 * disagree. This is deliberately NOT `DECISION_IMPACT_UNITS`, which is RESERVED
 * in the decision contract: reading a reserved field would be exactly the
 * "describes a system that does not exist" failure that contract exists to stop.
 */
export type MeasureUnit = 'COUNT' | 'CENTS' | 'RATIO';

/** How a measure behaves and what the reader must be told about it. */
export interface MeasureMetricDefinition {
  metric: MeasureMetric;
  label: string;
  unit: MeasureUnit;
  /** One line a human can check the arithmetic against. */
  formula: string;
  /**
   * Caveats that travel with EVERY measurement of this metric, forever. Evidence
   * that keeps its value and loses its caveats is how a hedged claim becomes a
   * confident one.
   */
  limitations: readonly string[];
}

export const MEASURE_METRIC_DEFINITIONS: Record<MeasureMetric, MeasureMetricDefinition> = {
  CALL_VOLUME: {
    metric: 'CALL_VOLUME',
    label: 'Call volume',
    unit: 'COUNT',
    formula: 'Count of calls in the bound population over the window.',
    limitations: [
      'Counts calls Loop received from the provider. A call the provider never sent is invisible here.',
    ],
  },
  REVENUE: {
    metric: 'REVENUE',
    label: 'Revenue',
    unit: 'CENTS',
    formula: 'Sum of revenue on calls that reported one. Calls with no reported revenue are excluded, never counted as zero.',
    limitations: [
      'Revenue is a lower bound: calls that reported no revenue are excluded from the total rather than treated as $0.',
      'CallGrid exposes no aggregate call-stats endpoint, so these figures cannot be reconciled against the provider automatically.',
    ],
  },
  MONETIZED_RATE: {
    metric: 'MONETIZED_RATE',
    label: 'Monetized rate',
    unit: 'RATIO',
    formula: 'Calls flagged monetized, divided by calls that carried the flag at all.',
    limitations: [
      'Monetized is DERIVED BY LOOP (billable or converted or paid) and is not a provider quality judgement. It means the call produced a positive commercial outcome, never that it met a qualification standard.',
      'Calls where the flag was absent are excluded from both sides of the ratio.',
    ],
  },
  CONVERSION_RATE: {
    metric: 'CONVERSION_RATE',
    label: 'Conversion rate',
    unit: 'RATIO',
    formula: 'Calls flagged converted, divided by calls that carried the flag at all.',
    limitations: [
      'Conversion is the provider\'s own flag. Loop does not observe what happened after the call and cannot verify it.',
      'Calls where the flag was absent are excluded from both sides of the ratio.',
    ],
  },
  NO_ROUTE_RATE: {
    metric: 'NO_ROUTE_RATE',
    label: 'No-route rate',
    unit: 'RATIO',
    formula: 'Calls flagged no-route, divided by calls that carried the flag at all.',
    limitations: [
      'A no-route call is one the provider could not deliver. WHY it could not be delivered is not visible to Loop, and no buyer capacity, cap or budget exists anywhere in the platform to infer it from.',
      'Calls where the flag was absent are excluded from both sides of the ratio.',
    ],
  },
};

// --- Which way is good --------------------------------------------------------

/**
 * Whether a rise is good news or bad news, for this objective.
 *
 * This is HUMAN INTENT, not measurement -- the same kind of statement the
 * objective's own title already is -- which is why it belongs here and a target
 * does not. Without it Loop can only say "revenue changed 24%"; with it, and with
 * nothing else added, Loop can say "revenue fell 24%, against your stated
 * direction". No target is required to say that, and none is offered.
 */
export const MEASURE_DIRECTIONS = ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER'] as const;
export type MeasureDirection = (typeof MEASURE_DIRECTIONS)[number];

export function isMeasureDirection(v: string): v is MeasureDirection {
  return (MEASURE_DIRECTIONS as readonly string[]).includes(v);
}

export const MEASURE_DIRECTION_LABELS: Record<MeasureDirection, string> = {
  HIGHER_IS_BETTER: 'Higher is better',
  LOWER_IS_BETTER: 'Lower is better',
};

// --- The population -----------------------------------------------------------

/**
 * The dimensions a population may be selected over.
 *
 * EXACTLY THE FOUR THAT EXIST. These are the attribution dimensions
 * `marketplace_calls` actually carries, and the same four the CallGrid engine
 * already groups by. There is no VERTICAL member and there must not be: Loop has
 * no vertical column, enum or table anywhere, and deriving one by parsing
 * provider label text would put industry-specific data into a shared layer on a
 * foundation of unnormalized strings.
 *
 * Geography is likewise absent as a dimension. Where the caller physically was
 * (`callerState`) is a different fact from which business motion a campaign
 * belongs to, and only a human can say which one an objective means -- see
 * `callerStates` on the binding, which is an OPTIONAL ADDITIONAL restriction and
 * defaults to none.
 */
export const BINDING_DIMENSIONS = ['CAMPAIGN', 'SOURCE', 'BUYER', 'VENDOR'] as const;
export type BindingDimension = (typeof BINDING_DIMENSIONS)[number];

export function isBindingDimension(v: string): v is BindingDimension {
  return (BINDING_DIMENSIONS as readonly string[]).includes(v);
}

export const BINDING_DIMENSION_LABELS: Record<BindingDimension, string> = {
  CAMPAIGN: 'Campaign',
  SOURCE: 'Source',
  BUYER: 'Buyer',
  VENDOR: 'Vendor',
};

/**
 * One selectable member, as offered to the person confirming a binding.
 *
 * `externalId` IS the identity and it is non-nullable here on purpose. A
 * dimension member the provider gave a label but no id cannot be bound at all,
 * because a binding keyed on a label would silently change population the day
 * somebody renames a campaign upstream. The picker must not offer such members,
 * and the surface should say why rather than hiding them.
 */
export interface BindingMemberCandidate {
  dimension: BindingDimension;
  externalId: string;
  /** What the provider called it. DISPLAY ONLY -- never identity. */
  label: string | null;
  /** How many calls carried it over the offer window, so a human can judge. */
  observedCalls: number;
}

/** One confirmed member of a population. */
export interface BindingMember {
  dimension: BindingDimension;
  externalId: string;
  /** The label AS IT READ WHEN CONFIRMED. Display only; may be stale by design. */
  labelAtConfirmation: string | null;
}

// --- The view -----------------------------------------------------------------

/**
 * One binding, as every caller outside the persistence layer sees it.
 *
 * IMMUTABLE AFTER CONFIRMATION. Nothing on this shape is editable. Changing what
 * an objective measures means confirming a NEW version and superseding this one,
 * because a binding that can be edited retroactively rewrites the meaning of
 * every Headline ever produced under it -- the same reasoning that made Stage 2
 * reject a projection over editable objective text.
 *
 * Dates are ISO strings, matching every other repository view in this platform.
 */
export interface ObjectiveMeasureBindingView {
  id: string;
  performanceObjectiveId: string;
  /** 1-based, monotonic per objective. */
  version: number;

  metric: MeasureMetric;
  direction: MeasureDirection;
  /** The confirmed population. Empty means the binding measures nothing. */
  members: BindingMember[];
  /**
   * OPTIONAL ADDITIONAL RESTRICTION on where the caller physically was. EMPTY BY
   * DEFAULT, and empty means no restriction at all -- never "unknown" and never
   * a filter that quietly matches nothing.
   */
  callerStates: string[];

  confirmedByUserId: string | null;
  confirmedByName: string | null;
  confirmedAt: string;
  /** Set when a later version replaced this one. The only writable fields. */
  supersededAt: string | null;
  supersededByBindingId: string | null;
  createdAt: string;
}

/** True when this binding is the one a measurement run should use. */
export function isActiveBinding(b: Pick<ObjectiveMeasureBindingView, 'supersededAt'>): boolean {
  return b.supersededAt === null;
}

// --- Validation ---------------------------------------------------------------

/**
 * Why a proposed binding was refused. A closed vocabulary so the form, the
 * action and the repository cannot drift on what counts as invalid -- the shape
 * `PERFORMANCE_OBJECTIVE_REJECTIONS` already established.
 */
export const BINDING_REJECTIONS = [
  'METRIC_INVALID',
  'DIRECTION_INVALID',
  /** No dimension member was selected. A population of nothing measures nothing. */
  'POPULATION_REQUIRED',
  /** A member arrived with a blank external id, i.e. a label pretending to be identity. */
  'MEMBER_IDENTITY_REQUIRED',
  'MEMBER_DIMENSION_INVALID',
  /** Two selections named the same dimension member. */
  'MEMBER_DUPLICATED',
  /** A caller-state restriction that is not a two-letter code. */
  'CALLER_STATE_INVALID',
  'TOO_MANY_MEMBERS',
] as const;
export type BindingRejection = (typeof BINDING_REJECTIONS)[number];

export const BINDING_REJECTION_MESSAGES: Record<BindingRejection, string> = {
  METRIC_INVALID: 'Choose what Loop should measure for this objective.',
  DIRECTION_INVALID: 'Say whether a higher number or a lower number is the better outcome.',
  POPULATION_REQUIRED:
    'Select at least one campaign, source, buyer or vendor that belongs to this objective. Loop will not guess.',
  MEMBER_IDENTITY_REQUIRED:
    'One of the selections has no stable identifier from the provider and cannot be measured reliably.',
  MEMBER_DIMENSION_INVALID: 'One of the selections is not a campaign, source, buyer or vendor.',
  MEMBER_DUPLICATED: 'The same item was selected twice.',
  CALLER_STATE_INVALID: 'A caller-state restriction must be a two-letter state code.',
  TOO_MANY_MEMBERS: 'That is more items than one binding can hold. Split the objective instead.',
};

/**
 * Upper bound on selected members.
 *
 * Bounded because the population becomes an `IN` list on every measurement run,
 * and because a binding naming two hundred campaigns is not a measured objective
 * -- it is the whole book with extra steps, and saying so is more useful than
 * quietly running it.
 */
export const BINDING_MAX_MEMBERS = 50;

/**
 * The binding invariants, as a pure function.
 *
 * Pure and persistence-free so the same rule runs in the repository, in a test
 * and in a form. It CANNOT check that the members were actually observed in this
 * organization -- that needs a query, the repository owns it, and keeping the
 * split explicit stops this function from looking like a complete gate.
 */
export function validateBindingShape(input: {
  metric: string;
  direction: string;
  members: ReadonlyArray<{ dimension: string; externalId: string }>;
  callerStates?: readonly string[];
}): BindingRejection | null {
  if (!isMeasureMetric(input.metric)) return 'METRIC_INVALID';
  if (!isMeasureDirection(input.direction)) return 'DIRECTION_INVALID';
  if (input.members.length === 0) return 'POPULATION_REQUIRED';
  if (input.members.length > BINDING_MAX_MEMBERS) return 'TOO_MANY_MEMBERS';

  const seen = new Set<string>();
  for (const m of input.members) {
    if (!isBindingDimension(m.dimension)) return 'MEMBER_DIMENSION_INVALID';
    if (!m.externalId || !m.externalId.trim()) return 'MEMBER_IDENTITY_REQUIRED';
    const key = `${m.dimension}:${m.externalId.trim()}`;
    if (seen.has(key)) return 'MEMBER_DUPLICATED';
    seen.add(key);
  }

  for (const s of input.callerStates ?? []) {
    if (!/^[A-Za-z]{2}$/.test(s.trim())) return 'CALLER_STATE_INVALID';
  }

  return null;
}

/** Members of one dimension, in a stable order. Used to build a query filter. */
export function membersOf(
  members: readonly BindingMember[],
  dimension: BindingDimension,
): string[] {
  return members
    .filter((m) => m.dimension === dimension)
    .map((m) => m.externalId)
    .sort();
}

/**
 * How the population reads to a human, without claiming a vertical or a place.
 *
 * Deliberately describes WHAT WAS SELECTED rather than what it means. Loop does
 * not know that three campaigns are "the Texas roofing business"; a person
 * decided that, and this sentence must not repeat the claim back as if Loop had
 * established it.
 */
export function describePopulation(b: Pick<ObjectiveMeasureBindingView, 'members' | 'callerStates'>): string {
  const counts = BINDING_DIMENSIONS.map((d) => {
    const n = b.members.filter((m) => m.dimension === d).length;
    if (n === 0) return null;
    const noun = BINDING_DIMENSION_LABELS[d].toLowerCase();
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
  }).filter((s): s is string => s !== null);

  const base = counts.length ? counts.join(', ') : 'nothing selected';
  if (b.callerStates.length === 0) return base;
  return `${base}, restricted to callers in ${[...b.callerStates].sort().join(', ')}`;
}

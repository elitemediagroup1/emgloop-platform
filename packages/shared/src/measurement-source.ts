// Measurement source authority — whose number this is.
//
// THE RULE THIS FILE EXISTS TO ENFORCE
//
// A source containing a field does not make it authoritative for that field.
//
// CallGrid reports `revenue`, `billable`, `paid` and `converted` on every call,
// and for one line of business those fields are the truth. For another they are
// structurally empty: the buyer settles the following day and reports outcomes in
// a document that never reaches the provider. On 2026-08-05 EVERY ONE of the 974
// records CallGrid held carried `converted=false` — present, not absent — so a
// conversion rate computed from them would have returned 0% at full coverage,
// cleared every existing guard, and stated a business falsehood as a measured
// fact. Loop was one confirmed binding away from publishing it.
//
// So authority is not a property of a field, a provider, or a pipeline. It is a
// statement a person makes about a POPULATION MEMBER and a MEASURE over a PERIOD,
// and it has to be stored, resolved as of the date being measured, and fail
// closed when it is absent.
//
// THE GRAIN IS (member, metric, date), and it is forced rather than chosen. Loop
// has no program, vertical or product concept — `objective-measure-binding.ts`
// refuses VERTICAL explicitly, because deriving one from provider label text puts
// industry-specific data into a shared layer on unnormalized strings. The
// dimension member is the only unit that exists on both sides of the question,
// and pairing it with the metric buys "the provider for volume, the buyer for
// revenue, same campaign" at no extra cost.
//
// NO LINE OF BUSINESS APPEARS IN THIS FILE, and none may appear anywhere in Stage
// 3. A program with a separate authoritative source is TWO ROWS OF DATA naming
// external ids and a source key. There is no branch, constant or string that
// knows which program it is; a test asserts as much.
//
// PURE. No clock, no I/O, no persistence.

import { isEffectiveOn, isEffectiveRangeValid, type BusinessDate, type EffectiveDateRange } from './business-time';
import { isMeasureMetric, type MeasureMetric } from './objective-measure-binding';
import type { BindingDimension } from './objective-measure-binding';

export const MEASUREMENT_SOURCE_CONTRACT_VERSION = 'measurement-source.v1';

// --- What a source is -----------------------------------------------------------

/**
 * What KIND of thing a source is, which decides how its availability is proven.
 *
 * A source Loop polls proves availability by being observed and reconciled. A
 * source that arrives proves it by having arrived. Those are different mechanisms
 * and the kind is what selects between them.
 *
 * DELIBERATELY NOT A TRANSPORT. `BUYER_REPORT` is what the thing IS; a spreadsheet
 * is how today's copy travels. Naming the kind after the current file format would
 * put a vendor in the domain model and would need renaming the first time the same
 * buyer sent a CSV.
 */
export const MEASUREMENT_SOURCE_KINDS = [
  /** A provider stream Loop polls and reconciles, e.g. a call-tracking platform. */
  'PROVIDER_STREAM',
  /** An outcome report supplied by a counterparty AFTER the activity it describes. */
  'BUYER_REPORT',
] as const;

export type MeasurementSourceKind = (typeof MEASUREMENT_SOURCE_KINDS)[number];

/**
 * One thing Loop is willing to believe, and what it may be believed about.
 *
 * `measureDefinitionIds` is the load-bearing field. Two sources may only be
 * combined in one measurement when they declare the SAME definition id for the
 * metric — because a provider's "converted" flag and a counterparty's own record
 * of a completed sale are not the same statement, and nothing except a declaration
 * can establish that they are. Without it, aggregation silently averages two
 * different questions and reports the result as one.
 */
export interface MeasurementSourceDefinition {
  key: string;
  kind: MeasurementSourceKind;
  displayName: string;
  /** The measures this source may be authoritative for. Never all by default. */
  supportedMetrics: readonly MeasureMetric[];
  /** metric -> definition id. A supported metric with no definition is not usable. */
  measureDefinitionIds: Readonly<Partial<Record<MeasureMetric, string>>>;
  /** Set for PROVIDER_STREAM, null otherwise. Ties the source to an observed stream. */
  provider: string | null;
  stream: string | null;
}

/** Whether a source may supply a measure at all. Fails closed on a missing definition. */
export function sourceSupports(
  source: MeasurementSourceDefinition,
  metric: MeasureMetric,
): boolean {
  return source.supportedMetrics.includes(metric) && !!source.measureDefinitionIds[metric];
}

/** The definition id a source uses for a metric, or null when it does not supply it. */
export function measureDefinitionId(
  source: MeasurementSourceDefinition,
  metric: MeasureMetric,
): string | null {
  return source.measureDefinitionIds[metric] ?? null;
}

// --- Availability of a source that ARRIVES ---------------------------------------

/**
 * Whether an arriving source's data for one business date is here.
 *
 * PARTIAL is not a smaller COMPLETE. A report whose rows did not all match a local
 * call describes an unknown total, not a lower one, and treating it as a total is
 * the false-zero failure wearing a different hat.
 */
export const SOURCE_OUTCOME_STATES = [
  /** Expected, not yet received. The normal state of yesterday, this morning. */
  'PENDING',
  /** Received, and every row matched a local record. */
  'COMPLETE',
  /** Received with unmatched rows. Explicitly NOT complete. */
  'PARTIAL',
  /** Replaced by a later version. A measurement made under it was true at the time. */
  'SUPERSEDED',
] as const;

export type SourceOutcomeState = (typeof SOURCE_OUTCOME_STATES)[number];

export const SOURCE_OUTCOME_STATE_LABELS: Record<SourceOutcomeState, string> = {
  PENDING: 'The authoritative report for this day has not arrived.',
  COMPLETE: 'The authoritative report arrived and every row matched a call.',
  PARTIAL: 'The authoritative report arrived with rows that matched no call.',
  SUPERSEDED: 'A later version of this report replaced this one.',
};

/** One arriving source's standing for one business date. */
export interface SourceOutcomeDayFact {
  sourceKey: string;
  businessDate: BusinessDate;
  state: SourceOutcomeState;
  /** Monotonic per (source, date). A correction is a new version, never an edit. */
  version: number;
}

/** Only COMPLETE may be measured from. Absence is PENDING by another name. */
export function outcomeDataAvailable(state: SourceOutcomeState | null | undefined): boolean {
  return state === 'COMPLETE';
}

// --- Authority --------------------------------------------------------------------

/**
 * One statement: for this member and this measure, over this period, believe this
 * source.
 *
 * EFFECTIVE-DATED for historical correctness. A program can change buyer, and
 * re-running last month's comparison must resolve the authority that was in force
 * last month — otherwise a stored Headline silently changes meaning when a
 * configuration changes, which is the same defect immutable bindings exist to
 * prevent.
 */
export interface MeasureSourceAuthorityDeclaration extends EffectiveDateRange {
  dimension: BindingDimension;
  memberExternalId: string;
  metric: MeasureMetric;
  sourceKey: string;
}

export function authorityDeclarationProblems(d: MeasureSourceAuthorityDeclaration): string[] {
  const problems: string[] = [];
  if (typeof d.memberExternalId !== 'string' || d.memberExternalId.trim() === '') {
    problems.push('memberExternalId is required');
  }
  if (!isMeasureMetric(d.metric)) problems.push(`${d.metric} is not a measure`);
  if (typeof d.sourceKey !== 'string' || d.sourceKey.trim() === '') {
    problems.push('sourceKey is required');
  }
  if (!isEffectiveRangeValid(d)) problems.push('effective range is empty, inverted or malformed');
  return problems;
}

export function isAuthorityDeclarationValid(d: MeasureSourceAuthorityDeclaration): boolean {
  return authorityDeclarationProblems(d).length === 0;
}

/** Why authority did or did not resolve. */
export const AUTHORITY_OUTCOMES = ['RESOLVED', 'MISSING', 'CONFLICT'] as const;
export type AuthorityOutcome = (typeof AUTHORITY_OUTCOMES)[number];

export interface AuthorityResolution {
  outcome: AuthorityOutcome;
  /** Set only when exactly one declaration applied. */
  sourceKey: string | null;
  matches: number;
}

/**
 * Resolve which source is authoritative for one member and measure on one date.
 *
 * FAILS CLOSED IN BOTH DIRECTIONS, and neither direction has a fallback.
 *
 * No declaration is MISSING, never "assume the provider". A default to the
 * provider is precisely the assumption that made a conversion rate computable
 * from fields nobody had said were authoritative.
 *
 * Two declarations are CONFLICT, never a precedence puzzle. Any tie-break — most
 * recent, most specific, first written — would be invented here and would resolve
 * a disagreement the organization has not actually settled. The organization has
 * said two things; a person closes one.
 */
export function resolveAuthority(
  declarations: readonly MeasureSourceAuthorityDeclaration[],
  dimension: BindingDimension,
  memberExternalId: string,
  metric: MeasureMetric,
  on: BusinessDate,
): AuthorityResolution {
  const matching = declarations.filter(
    (d) =>
      isAuthorityDeclarationValid(d) &&
      d.dimension === dimension &&
      d.memberExternalId === memberExternalId &&
      d.metric === metric &&
      isEffectiveOn(d, on),
  );

  if (matching.length === 0) return { outcome: 'MISSING', sourceKey: null, matches: 0 };
  const only = matching[0];
  if (matching.length > 1 || !only) {
    return { outcome: 'CONFLICT', sourceKey: null, matches: matching.length };
  }
  return { outcome: 'RESOLVED', sourceKey: only.sourceKey, matches: 1 };
}

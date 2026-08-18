// Measurement readiness — the gate, assembled.
//
// THE ONE INVARIANT
//
// A measure may be computed only when every call it would count belongs to a
// population member whose expectation is KNOWN, whose day was OBSERVED and
// RECONCILED for that member, and whose authoritative source FOR THAT SPECIFIC
// MEASURE is uniquely resolved and has delivered its data — for every business
// date in the compared periods. Anything short of that returns a reason, never a
// number.
//
// WHY THIS IS A SEPARATE PURE FUNCTION AND NOT A SERVICE
//
// Because `assessWindowObservation` already proved the shape works. An impure
// caller resolves facts; a pure function judges them; `measureChange` takes the
// judgement as a REQUIRED input so the type system refuses to compile a caller
// that never asked. The same file that reads no clock reads no ledger, and the
// same test that pins the August 2026 ingestion gap can pin these.
//
// EVERY REFUSAL NAMES A DIFFERENT NEXT MOVE. That is the test of whether a reason
// code earns its place: "run certification", "run reconciliation", "declare the
// campaign", "recover the day", "declare an authority", "close one of two", "wait
// for the report". A gate that returns one boolean teaches operators that Loop is
// broken; a gate that returns a work item teaches them what it knows.
//
// WHAT IT DOES NOT DO. It does not compute anything, rank anything, or decide
// whether a number is interesting -- `measureChange` owns materiality and keeps
// owning it. It does not read a database, a clock, an environment or a network.
// And it contains no knowledge of any line of business: a program measured from a
// counterparty's report is DATA -- an authority row naming an external id and a
// source key -- and there is no branch here that knows which program it is.
//
// PURE. Deterministic. Same inputs, same verdict, in a test or six months later.

import type { BusinessDate } from './business-time';
import type { MaterialityWithholding } from './commercial-measurement';
import type { BindingDimension, MeasureMetric } from './objective-measure-binding';
import type { WindowObservation } from './provider-observation';
import {
  memberFact,
  type ReconciliationDayFact,
} from './provider-reconciliation';
import {
  measureDefinitionId,
  outcomeDataAvailable,
  resolveAuthority,
  sourceSupports,
  type MeasureSourceAuthorityDeclaration,
  type MeasurementSourceDefinition,
  type SourceOutcomeDayFact,
} from './measurement-source';

export const MEASUREMENT_READINESS_RULE_VERSION = 'measurement-readiness.v1';

// --- The vocabulary is borrowed, not invented ------------------------------------

/**
 * The members of the EXISTING withholding vocabulary that mean "could not be
 * computed", as opposed to "was computed and is not worth saying".
 *
 * A NAMED SUBSET, NOT A SECOND VOCABULARY. `MATERIALITY_WITHHOLDINGS` is already
 * the closed list of reasons Stage 3 stays silent, already carries labels, and is
 * already the type `headline-detection.service.ts` reports. A parallel enum
 * meaning the same things would be the failure mode CLAUDE.md names first.
 */
export const READINESS_WITHHOLDINGS = [
  'WINDOW_NOT_OBSERVED',
  'RECONCILIATION_MISSING',
  'RECONCILIATION_INCONCLUSIVE',
  'CAMPAIGN_EXPECTATION_UNKNOWN',
  'POPULATION_INCOMPLETE',
  'SOURCE_AUTHORITY_MISSING',
  'SOURCE_AUTHORITY_CONFLICT',
  'MEASURE_NOT_SUPPORTED_BY_SOURCE',
  'AUTHORITATIVE_DATA_PENDING',
  'AUTHORITATIVE_DATA_INCOMPLETE',
  'MIXED_SOURCE_AGGREGATION_UNSUPPORTED',
  'CALL_UNATTRIBUTED',
] as const;

export type ReadinessWithholding = (typeof READINESS_WITHHOLDINGS)[number];

/** Compile-time proof that the subset really is a subset. */
const _readinessIsSubsetOfWithholdings: readonly MaterialityWithholding[] = READINESS_WITHHOLDINGS;
void _readinessIsSubsetOfWithholdings;

// --- What kind of problem it is ---------------------------------------------------

/**
 * The four outcomes, chosen by WHO can act on them.
 *
 * NOT_READY  — an operation fixes it: run a job, recover a day, wait for a report.
 * CONFIG_ERROR — a person must decide something Loop cannot infer.
 * INCONCLUSIVE — the evidence impeaches itself; neither of the above helps yet.
 * READY — nothing objected.
 */
export const READINESS_OUTCOMES = ['READY', 'NOT_READY', 'CONFIG_ERROR', 'INCONCLUSIVE'] as const;
export type ReadinessOutcome = (typeof READINESS_OUTCOMES)[number];

/** Ascending. The verdict takes the most severe outcome any finding carries. */
export const READINESS_OUTCOME_SEVERITY: Record<ReadinessOutcome, number> = {
  READY: 0,
  NOT_READY: 1,
  CONFIG_ERROR: 2,
  INCONCLUSIVE: 3,
};

/**
 * Which outcome each reason produces.
 *
 * The split is by remedy, not by severity of consequence. `POPULATION_INCOMPLETE`
 * is NOT_READY because recovering a day fixes it; `CAMPAIGN_EXPECTATION_UNKNOWN`
 * is CONFIG_ERROR because no amount of running jobs will answer a question only a
 * person can answer.
 */
export const READINESS_OUTCOME_BY_REASON: Record<ReadinessWithholding, ReadinessOutcome> = {
  WINDOW_NOT_OBSERVED: 'NOT_READY',
  RECONCILIATION_MISSING: 'NOT_READY',
  RECONCILIATION_INCONCLUSIVE: 'INCONCLUSIVE',
  CAMPAIGN_EXPECTATION_UNKNOWN: 'CONFIG_ERROR',
  POPULATION_INCOMPLETE: 'NOT_READY',
  SOURCE_AUTHORITY_MISSING: 'CONFIG_ERROR',
  SOURCE_AUTHORITY_CONFLICT: 'CONFIG_ERROR',
  MEASURE_NOT_SUPPORTED_BY_SOURCE: 'CONFIG_ERROR',
  AUTHORITATIVE_DATA_PENDING: 'NOT_READY',
  AUTHORITATIVE_DATA_INCOMPLETE: 'NOT_READY',
  MIXED_SOURCE_AGGREGATION_UNSUPPORTED: 'CONFIG_ERROR',
  CALL_UNATTRIBUTED: 'CONFIG_ERROR',
};

// --- What the caller must resolve --------------------------------------------------

/**
 * One slice of the bound population, keyed by the member that decides its source.
 *
 * THE CALLER MUST INCLUDE EVERY BOUND MEMBER, INCLUDING ONES THAT CONTRIBUTED NO
 * CALLS. This is the subtle one. If partitions were derived only from calls that
 * arrived, a campaign that went completely silent would vanish from the population
 * and the gate would find nothing wrong with measuring the survivors -- which is
 * exactly the August 2026 shape, where three campaigns contributed 106 absences
 * and zero rows. A member with `localCalls: 0` is still a member, and its
 * reconciliation and authority are still checked.
 */
export interface ReadinessPartition {
  dimension: BindingDimension;
  memberExternalId: string;
  /** Calls this member contributed to the bound population across both windows. */
  localCalls: number;
}

/**
 * Everything the gate needs, already resolved by the impure layer.
 *
 * Nothing here is fetched, derived from a clock, or defaulted. A caller that has
 * not answered a question cannot construct this object.
 */
export interface ReadinessInput {
  metric: MeasureMetric;
  /** Every business date both compared windows cover, in order. */
  dates: readonly BusinessDate[];
  /** The existing observation verdict, unchanged and evaluated first. */
  observation: WindowObservation;
  /** Every member of the bound population. See `ReadinessPartition`. */
  partitions: readonly ReadinessPartition[];
  /** Calls in the bound population carrying no member id at all. */
  unattributedCalls: number;
  /** One fact per date. A date with no fact was never reconciled. */
  reconciliation: readonly ReconciliationDayFact[];
  authorities: readonly MeasureSourceAuthorityDeclaration[];
  sources: readonly MeasurementSourceDefinition[];
  /** Availability facts for arriving sources. Absent means PENDING. */
  outcomeDays: readonly SourceOutcomeDayFact[];
}

// --- The verdict ---------------------------------------------------------------------

/** One thing standing between this measure and a number. */
export interface ReadinessFinding {
  reason: ReadinessWithholding;
  /** The date it applies to, or null when it is a property of the whole window. */
  businessDate: BusinessDate | null;
  /** The member it applies to, or null when it is not member-specific. */
  memberExternalId: string | null;
  /** One plain sentence. Never a credential, an identity or a phone number. */
  detail: string;
}

export interface MeasurementReadiness {
  ruleVersion: string;
  metric: MeasureMetric;
  outcome: ReadinessOutcome;
  /** True only when nothing objected. The `fullyObserved` convention. */
  ready: boolean;
  dates: readonly BusinessDate[];
  findings: readonly ReadinessFinding[];
  /** The distinct sources that resolved, in first-seen order. Empty when none did. */
  resolvedSourceKeys: readonly string[];
}

function verdict(
  input: ReadinessInput,
  findings: ReadinessFinding[],
  resolvedSourceKeys: string[],
): MeasurementReadiness {
  let outcome: ReadinessOutcome = 'READY';
  for (const f of findings) {
    const candidate = READINESS_OUTCOME_BY_REASON[f.reason];
    if (READINESS_OUTCOME_SEVERITY[candidate] > READINESS_OUTCOME_SEVERITY[outcome]) {
      outcome = candidate;
    }
  }
  return {
    ruleVersion: MEASUREMENT_READINESS_RULE_VERSION,
    metric: input.metric,
    outcome,
    ready: findings.length === 0,
    dates: input.dates,
    findings,
    resolvedSourceKeys,
  };
}

/**
 * Assess whether a measure may be computed over a set of business dates.
 *
 * ORDER IS DELIBERATE AND CHEAPEST-REFUSAL-FIRST. Observation is window-wide and
 * settles everything at once, so it short-circuits: there is no point resolving
 * authority for a day nobody read. Unattributed calls short-circuit next, because
 * a population that cannot be partitioned cannot be assessed at all. Everything
 * after that accumulates, so an operator sees every problem in one pass instead of
 * fixing four in four sittings.
 *
 * DETERMINISM comes from iteration order alone: dates in the order given, members
 * in the order given, checks in a fixed order within each pair. Nothing is sorted,
 * nothing is keyed on object identity, and no set iteration reaches the output.
 */
export function assessReadiness(input: ReadinessInput): MeasurementReadiness {
  // 1 · OBSERVATION. Unchanged, first, and fatal on its own.
  if (!input.observation.fullyObserved) {
    return verdict(
      input,
      input.observation.uncertified.map((u) => ({
        reason: 'WINDOW_NOT_OBSERVED' as const,
        businessDate: u.businessDate,
        memberExternalId: null,
        detail: u.reason,
      })),
      [],
    );
  }

  // 2 · ATTRIBUTION. A call with no member has no resolvable source, and guessing
  //     one is the whole failure this gate exists to stop.
  if (input.unattributedCalls > 0) {
    return verdict(
      input,
      [
        {
          reason: 'CALL_UNATTRIBUTED',
          businessDate: null,
          memberExternalId: null,
          detail: `${input.unattributedCalls} calls in this population carry no campaign.`,
        },
      ],
      [],
    );
  }

  const findings: ReadinessFinding[] = [];
  const resolvedSourceKeys: string[] = [];
  const definitionIds: string[] = [];
  const byDate = new Map(input.reconciliation.map((r) => [r.businessDate, r]));
  const sourceByKey = new Map(input.sources.map((s) => [s.key, s]));

  for (const date of input.dates) {
    const day = byDate.get(date);

    // 3 · DAY-WIDE reconciliation. A missing or unsound comparison blocks every
    //     population on that date, because its failure is about the comparison
    //     rather than about any one campaign.
    if (!day) {
      findings.push({
        reason: 'RECONCILIATION_MISSING',
        businessDate: date,
        memberExternalId: null,
        detail: 'This day was observed but never reconciled.',
      });
      continue;
    }
    if (day.state === 'INCONCLUSIVE') {
      findings.push({
        reason: 'RECONCILIATION_INCONCLUSIVE',
        businessDate: date,
        memberExternalId: null,
        detail: 'The identity comparison for this day is not sound.',
      });
      continue;
    }

    for (const partition of input.partitions) {
      // 4 · MEMBER completeness. A day may be UNRECONCILED overall and still
      //     measurable for a population it does not touch -- which is the entire
      //     reason reconciliation is explained per member.
      const member = memberFact(day, partition.dimension, partition.memberExternalId);
      const expectation = member?.expectation ?? 'UNKNOWN';

      if (expectation === 'UNKNOWN') {
        findings.push({
          reason: 'CAMPAIGN_EXPECTATION_UNKNOWN',
          businessDate: date,
          memberExternalId: partition.memberExternalId,
          detail: 'Nobody has declared whether this campaign was expected on this date.',
        });
      } else if (expectation === 'EXPECTED' && (member?.providerOnly ?? 0) > 0) {
        findings.push({
          reason: 'POPULATION_INCOMPLETE',
          businessDate: date,
          memberExternalId: partition.memberExternalId,
          detail: `${member?.providerOnly ?? 0} records the provider holds for this campaign did not reach Loop.`,
        });
      }
      // NOT_CONFIGURED and EXCLUDED members contribute no absence and no block.
      // Their provider-only records are counted on the day's fact and are not
      // defects -- a campaign that was never connected cannot have failed to
      // deliver.

      // 5 · AUTHORITY, resolved AS OF THIS DATE. Never current-state.
      const authority = resolveAuthority(
        input.authorities,
        partition.dimension,
        partition.memberExternalId,
        input.metric,
        date,
      );
      if (authority.outcome === 'MISSING') {
        findings.push({
          reason: 'SOURCE_AUTHORITY_MISSING',
          businessDate: date,
          memberExternalId: partition.memberExternalId,
          detail: `No source is declared authoritative for ${input.metric} on this campaign.`,
        });
        continue;
      }
      if (authority.outcome === 'CONFLICT') {
        findings.push({
          reason: 'SOURCE_AUTHORITY_CONFLICT',
          businessDate: date,
          memberExternalId: partition.memberExternalId,
          detail: `${authority.matches} sources are declared authoritative for ${input.metric} on this campaign.`,
        });
        continue;
      }

      const source = authority.sourceKey ? sourceByKey.get(authority.sourceKey) : undefined;
      if (!source || !sourceSupports(source, input.metric)) {
        findings.push({
          reason: 'MEASURE_NOT_SUPPORTED_BY_SOURCE',
          businessDate: date,
          memberExternalId: partition.memberExternalId,
          detail: `The declared source does not supply ${input.metric}.`,
        });
        continue;
      }
      if (!resolvedSourceKeys.includes(source.key)) resolvedSourceKeys.push(source.key);
      const definition = measureDefinitionId(source, input.metric);
      if (definition && !definitionIds.includes(definition)) definitionIds.push(definition);

      // 6 · AVAILABILITY, by source kind. A provider stream proved its
      //     availability in steps 1, 3 and 4; asking again would be a third row
      //     asserting what two already say.
      if (source.kind === 'BUYER_REPORT') {
        const outcome = input.outcomeDays.find(
          (o) => o.sourceKey === source.key && o.businessDate === date,
        );
        if (!outcome || outcome.state === 'PENDING' || outcome.state === 'SUPERSEDED') {
          findings.push({
            reason: 'AUTHORITATIVE_DATA_PENDING',
            businessDate: date,
            memberExternalId: partition.memberExternalId,
            detail: 'The authoritative report for this day has not arrived.',
          });
        } else if (!outcomeDataAvailable(outcome.state)) {
          findings.push({
            reason: 'AUTHORITATIVE_DATA_INCOMPLETE',
            businessDate: date,
            memberExternalId: partition.memberExternalId,
            detail: 'The authoritative report for this day arrived with rows that matched no call.',
          });
        }
      }
    }
  }

  // 7 · MIXED SOURCES. Two sources may only be summed when they declare the SAME
  //     definition of the measure. v1 refuses what it cannot prove comparable, and
  //     enabling it is a data change rather than a code change: the day two
  //     sources declare one definition id, this guard passes on its own.
  if (definitionIds.length > 1) {
    findings.push({
      reason: 'MIXED_SOURCE_AGGREGATION_UNSUPPORTED',
      businessDate: null,
      memberExternalId: null,
      detail: `This population spans ${definitionIds.length} different definitions of ${input.metric}.`,
    });
  }

  return verdict(input, findings, resolvedSourceKeys);
}

/**
 * One line naming what stands in the way, for a measurement's `unknowns`.
 *
 * Names the reasons rather than counting them, the rule `describeUnobserved`
 * already follows: a reader needs to know what to go and fix, not how many things
 * are wrong. Long lists are capped and the cap says so.
 */
export function describeNotReady(readiness: MeasurementReadiness, limit = 6): string {
  if (readiness.ready) return '';
  const seen: ReadinessWithholding[] = [];
  for (const f of readiness.findings) if (!seen.includes(f.reason)) seen.push(f.reason);
  const shown = seen.slice(0, limit);
  const remainder = seen.length - shown.length;
  const list = shown.join(', ') + (remainder > 0 ? ` and ${remainder} more` : '');
  return `This measure cannot be computed over the compared periods (${list}).`;
}

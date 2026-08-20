// Measurement readiness — the gate, assembled.
//
// THE ONE INVARIANT
//
// A measure may be computed only when every call it would count belongs to a
// population member whose expectation is KNOWN, whose day was OBSERVED and
// RECONCILED for that member, and whose authoritative source FOR THAT SPECIFIC
// MEASURE is uniquely resolved and has delivered its data — for every business
// date in the compared periods. And no member may contribute calls it was
// declared not to contribute: a declaration the population contradicts is a
// refusal, not a rounding error. Anything short of that returns a reason, never a
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
// campaign", "re-declare the campaign", "recover the day", "declare an authority",
// "close one of two", "wait for the report". A gate that returns one boolean
// teaches operators that Loop is broken; a gate that returns a work item teaches
// them what it knows.
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
  'CAMPAIGN_EXPECTATION_CONTRADICTED',
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
  CAMPAIGN_EXPECTATION_CONTRADICTED: 'CONFIG_ERROR',
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
  /**
   * Calls this member contributed to the bound population across both windows.
   *
   * A WINDOW-WIDE TOTAL, AND NEVER THE PARTICIPATION TEST. Whether a member
   * contributed calls ON A GIVEN DATE is read from that date's reconciliation
   * member fact (`localCount`), because a campaign can be connected on one date
   * of a window and disconnected on the next, and one summed number cannot say
   * which.
   */
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
      } else if (expectation === 'EXPECTED') {
        if ((member?.providerOnly ?? 0) > 0) {
          findings.push({
            reason: 'POPULATION_INCOMPLETE',
            businessDate: date,
            memberExternalId: partition.memberExternalId,
            detail: `${member?.providerOnly ?? 0} records the provider holds for this campaign did not reach Loop.`,
          });
        }
      } else {
        // 4b · A MEMBER DECLARED NOT TO PARTICIPATE, ON THIS DATE.
        //
        // Participation is asked PER BUSINESS DATE, from the member fact the day
        // already resolved. A window-wide total cannot answer it: a campaign
        // disconnected on the 5th and delivering on the 4th carries one
        // `localCalls` number and two different answers.
        //
        // IT DID NOT PARTICIPATE. Nothing about it is a defect -- a campaign that
        // was never connected cannot have failed to deliver -- and nothing about
        // it is measured either. No authority is required for a member that
        // contributed no call: demanding one would send an operator to declare a
        // source for a measure that will never read it.
        //
        // IT DID PARTICIPATE. The declaration and the observed population
        // disagree, and neither may be quietly preferred. Counting the calls
        // overrides a human declaration with observed traffic; discarding them
        // measures a population that is not the bound one; asking for an
        // authority answers a question nobody asked. The contradiction stays
        // visible until a person re-declares the campaign or removes it from the
        // population -- and it is reported INSTEAD OF, not alongside, the
        // authority findings, because those are not what is wrong here.
        const participated = member?.localCount ?? 0;
        if (participated > 0) {
          const declared =
            expectation === 'EXCLUDED' ? 'deliberately excluded' : 'not connected to Loop';
          findings.push({
            reason: 'CAMPAIGN_EXPECTATION_CONTRADICTED',
            businessDate: date,
            memberExternalId: partition.memberExternalId,
            detail: `${participated} calls in this population came from a campaign declared ${declared} on this date.`,
          });
        }
        continue;
      }

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
/**
 * The single reason a caller with room for one is told.
 *
 * THE MOST SEVERE FINDING WINS, and ties break on the order `assessReadiness`
 * produced -- dates in the order given, members in the order given, checks in a
 * fixed order within each pair. So the same input always names the same reason,
 * and it can never disagree with the verdict's own outcome.
 *
 * ONE DEFINITION, TWO CALLERS. `measureChange` reports it as `withheld` and the
 * detection service reports it on an objective it never measured. Working it out
 * twice would let a run summary and the measurement it describes name different
 * reasons for the same refusal.
 *
 * Nothing is discarded: every finding survives in `readiness.findings`.
 */
export function principalReadinessReason(readiness: MeasurementReadiness): ReadinessWithholding {
  const atVerdict = readiness.findings.find(
    (f) => READINESS_OUTCOME_BY_REASON[f.reason] === readiness.outcome,
  );
  // `ready` is false only when a finding exists, so the fallback is unreachable
  // by construction -- and it fails toward "could not look" rather than toward a
  // number, because a caller that somehow got here has not earned one.
  return atVerdict?.reason ?? readiness.findings[0]?.reason ?? 'WINDOW_NOT_OBSERVED';
}

/**
 * One line per obstruction, naming the date and the member it belongs to.
 *
 * WHY THIS EXISTS BESIDE `describeNotReady` AND NOT INSIDE IT. That function
 * answers "what kind of problem is this" in one sentence, which is what a banner
 * has room for. This answers "where", which is what somebody about to fix it
 * needs — and `describeUnobserved` already proved the difference is worth the two
 * functions: an operator told three days were unobserved still has to ask WHICH
 * three before they can do anything.
 *
 * DEDUPED ON THE WHOLE LINE, so one reason firing across fourteen days and four
 * campaigns does not produce fifty-six identical sentences. Order is the order
 * `assessReadiness` produced, which is deterministic, and the cap says how much
 * it hid rather than trailing off.
 */
export function describeReadinessFindings(
  readiness: MeasurementReadiness,
  limit = 8,
): readonly string[] {
  const lines: string[] = [];
  for (const f of readiness.findings) {
    const where = [f.businessDate, f.memberExternalId].filter((x) => x !== null).join(' · ');
    const line = where === '' ? f.detail : `${where} — ${f.detail}`;
    if (!lines.includes(line)) lines.push(line);
  }
  if (lines.length <= limit) return lines;
  const remainder = lines.length - limit;
  return [...lines.slice(0, limit), `and ${remainder} more.`];
}

export function describeNotReady(readiness: MeasurementReadiness, limit = 6): string {
  if (readiness.ready) return '';
  const seen: ReadinessWithholding[] = [];
  for (const f of readiness.findings) if (!seen.includes(f.reason)) seen.push(f.reason);
  const shown = seen.slice(0, limit);
  const remainder = seen.length - shown.length;
  const list = shown.join(', ') + (remainder > 0 ? ` and ${remainder} more` : '');
  return `This measure cannot be computed over the compared periods (${list}).`;
}

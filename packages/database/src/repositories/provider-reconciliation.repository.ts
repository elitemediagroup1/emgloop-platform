// ProviderReconciliationRepository -- Commercial Intelligence Stage 3 correctness.
//
// Persistence for "the identities the provider held for this business date, and
// whether they reached Loop". It stores the outcome of a comparison and reads it
// back. It never queries a provider, never reads an IntegrationEvent, never
// decides what a comparison MEANS -- that rule is pure and lives in
// @emgloop/shared -- and never repairs anything it finds.
//
// ONE CURRENT ANSWER PER DAY, REWRITTEN IN PLACE. This follows
// ProviderObservationRepository.recordDay exactly, and for the same reason: a day
// may legitimately be reconciled again -- a late delivery arrived, a historical
// declaration was finally recorded, a previous run was inconclusive -- and each
// run must leave ONE current answer rather than a pile a reader has to reconcile.
// An append-only version table was considered and rejected: the auditability it
// would buy is already bought more cheaply, because a member row NAMES the
// declaration it resolved to and PR 2 never rewrites a declaration. What the
// comparison used is therefore still readable even after somebody declares
// something new, and a second history table would be a parallel system carrying
// the same facts.
//
// THE DAY AND ITS MEMBERS ARE WRITTEN IN ONE TRANSACTION, AND THE MEMBER SET IS
// REPLACED RATHER THAN MERGED. A member that stopped appearing in the provider's
// population must not linger from a previous run looking like a current fact, and
// a half-written verdict is worse than no verdict.
//
// IT REFUSES TO STORE A COMPARISON THAT DOES NOT ADD UP. `countProblems` runs
// before the transaction opens; a violation means Loop's own set computation is
// wrong, not that the data is bad, and persisting INCONCLUSIVE would still assert
// that a comparison happened. The migration carries the same three equations as
// CHECK constraints, because an application-level invariant is exactly what
// Sprint 29A proved review cannot sustain.
//
// TENANT-FIRST. `organizationId` is the first argument of every method, leads the
// day's unique key, and is denormalised onto the member row so a member read is
// scoped in its own right rather than only through its parent.

import type { PrismaClient } from '@prisma/client';
import {
  RECONCILIATION_STATES,
  countProblems,
  dimensionSupported,
  type BindingDimension,
  type BusinessDate,
  type ReconciliationCounts,
  type ReconciliationState,
  type ResolvedExpectation,
} from '@emgloop/shared';

import { businessDateToColumn, columnToBusinessDate } from './provider-observation.repository';

/** The local stage a comparison was made at. The only value this version writes. */
export const INTEGRATION_EVENT_STAGE = 'integration_event';

/**
 * Counts describing the EVIDENCE rather than the calls.
 *
 * Kept apart from `ReconciliationCounts` on purpose: a number in there is a fact
 * about calls and participates in the three equations, while a number in here is
 * a fact about how trustworthy the comparison was and participates in none of
 * them. Merging the two would have meant the equations quietly stopped holding
 * whenever the evidence was imperfect.
 */
export interface ReconciliationEvidenceCounts {
  providerRecords: number;
  providerUnattributed: number;
  localRowsScanned: number;
  localInWindow: number;
  localUnresolvedOccurrence: number;
  localMissingIdentity: number;
  pagesFetched: number;
  pageCap: number;
  truncated: boolean;
}

/** One member's row, as the service computed it. */
export interface ReconciliationMemberInput {
  dimension: BindingDimension;
  memberExternalId: string;
  providerCount: number;
  providerOnly: number;
  localCount: number;
  localOnly: number;
  /** What was in force ON THE BUSINESS DATE, resolved at comparison time. */
  expectationState: ResolvedExpectation;
  /** The declaration that said so, or null when none did or more than one did. */
  expectationId: string | null;
  /** How many declarations matched. More than one is a configuration defect. */
  expectationMatches: number;
  /** Display only. Never identity, and null when the provider supplied none. */
  labelAtObservation: string | null;
}

/** Everything one reconciliation run established. */
export interface RecordReconciliationInput {
  provider: string;
  stream: string;
  businessDate: BusinessDate;
  timezone: string;
  /** The UTC interval a record must have OCCURRED in to belong to this day. */
  windowStart: Date;
  windowEnd: Date;
  /** The wider interval the local delivery scan actually covered. */
  scanStart: Date;
  scanEnd: Date;
  state: ReconciliationState;
  ruleVersion: string;
  localStage: string;
  counts: ReconciliationCounts;
  evidence: ReconciliationEvidenceCounts;
  members: readonly ReconciliationMemberInput[];
  /** Why the comparison is not sound. Null when it is. */
  reason: string | null;
  observedAt: Date;
  reconciledAt: Date;
}

/** One member fact, as a caller reads it back. */
export interface ReconciliationMemberView {
  dimension: BindingDimension | null;
  memberExternalId: string;
  providerCount: number;
  providerOnly: number;
  localCount: number;
  localOnly: number;
  expectationState: ResolvedExpectation;
  expectationId: string | null;
  expectationMatches: number;
  labelAtObservation: string | null;
}

/** One day's stored reconciliation. */
export interface ReconciliationDayView {
  businessDate: BusinessDate;
  timezone: string;
  /** Null when the stored vocabulary cannot be read. FAILS CLOSED: a caller must
      treat an unreadable state as "not reconciled", never guess which it meant. */
  state: ReconciliationState | null;
  ruleVersion: string;
  localStage: string;
  counts: ReconciliationCounts;
  evidence: ReconciliationEvidenceCounts;
  reason: string | null;
  observedAt: string;
  reconciledAt: string;
  members: ReconciliationMemberView[];
}

/** Why a reconciliation was refused. A CLOSED LIST. */
export type RecordReconciliationRejection =
  /** The three set equations do not hold. Loop's own comparison is wrong, so
      there is nothing here worth storing under any state. */
  | 'INCOHERENT_COUNTS'
  /** A member row is internally inconsistent, or names a dimension this version
      cannot declare against. */
  | 'INVALID_MEMBER'
  /** The state is not a member of RECONCILIATION_STATES. */
  | 'INVALID_STATE';

export type RecordReconciliationResult =
  | { ok: true; day: ReconciliationDayView }
  | { ok: false; reason: RecordReconciliationRejection; problems: readonly string[] };

function isReconciliationState(value: unknown): value is ReconciliationState {
  return typeof value === 'string' && (RECONCILIATION_STATES as readonly string[]).includes(value);
}

/**
 * A stored resolved expectation, or UNKNOWN when it cannot be read.
 *
 * FAILS CLOSED, like every other vocabulary read in this stage. UNKNOWN is the
 * one resolved value that is safe to substitute, because it is what "we cannot
 * say" already means everywhere else in the gate.
 */
function toResolvedExpectation(value: string): ResolvedExpectation {
  if (value === 'EXPECTED' || value === 'NOT_CONFIGURED' || value === 'EXCLUDED') return value;
  return 'UNKNOWN';
}

function memberProblems(m: ReconciliationMemberInput): string[] {
  const problems: string[] = [];
  if (!dimensionSupported(m.dimension)) {
    problems.push(`dimension ${m.dimension} is not supported in this version`);
  }
  if (typeof m.memberExternalId !== 'string' || m.memberExternalId.trim() === '') {
    problems.push('memberExternalId is required -- a member keyed on a label is not identity');
  }
  const counts = [m.providerCount, m.providerOnly, m.localCount, m.localOnly, m.expectationMatches];
  if (counts.some((v) => !Number.isInteger(v) || v < 0)) {
    problems.push(`every count on ${m.memberExternalId} must be a non-negative integer`);
  } else {
    if (m.providerOnly > m.providerCount) {
      problems.push(`${m.memberExternalId}: providerOnly exceeds providerCount`);
    }
    if (m.localOnly > m.localCount) {
      problems.push(`${m.memberExternalId}: localOnly exceeds localCount`);
    }
  }
  // The same invariant the migration's CHECK enforces: a resolved declaration
  // must be named, and only UNKNOWN may legitimately name none.
  if (m.expectationId === null && m.expectationState !== 'UNKNOWN') {
    problems.push(`${m.memberExternalId}: ${m.expectationState} without naming the declaration that said so`);
  }
  return problems;
}

export class ProviderReconciliationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Record one day's comparison, replacing any previous answer for that day.
   *
   * REFUSES BEFORE IT WRITES. The equations are checked first, because a stored
   * fact that does not add up is worse than no fact: the whole purpose of this
   * table is to be the thing a measurement gate is allowed to trust.
   */
  async recordDay(
    organizationId: string,
    input: RecordReconciliationInput,
  ): Promise<RecordReconciliationResult> {
    if (!isReconciliationState(input.state)) {
      return { ok: false, reason: 'INVALID_STATE', problems: [`unknown state ${String(input.state)}`] };
    }
    const countIssues = countProblems(input.counts);
    if (countIssues.length > 0) {
      return { ok: false, reason: 'INCOHERENT_COUNTS', problems: countIssues };
    }
    const memberIssues = input.members.flatMap(memberProblems);
    if (memberIssues.length > 0) {
      return { ok: false, reason: 'INVALID_MEMBER', problems: memberIssues };
    }
    // Two rows for one member in a single run would collide on the member unique
    // and abort the transaction with a P2002 the caller cannot act on. Caught
    // here so it reads as the computation defect it is.
    const seen = new Set<string>();
    for (const m of input.members) {
      const key = `${m.dimension} ${m.memberExternalId}`;
      if (seen.has(key)) {
        return {
          ok: false,
          reason: 'INVALID_MEMBER',
          problems: [`${m.memberExternalId} appears more than once in one comparison`],
        };
      }
      seen.add(key);
    }

    const businessDate = businessDateToColumn(input.businessDate);
    const dayData = {
      timezone: input.timezone,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      scanStart: input.scanStart,
      scanEnd: input.scanEnd,
      state: input.state,
      ruleVersion: input.ruleVersion,
      localStage: input.localStage,
      providerRecords: input.evidence.providerRecords,
      providerUnique: input.counts.providerUnique,
      providerDuplicateIds: input.counts.providerDuplicateIds,
      providerUnattributed: input.evidence.providerUnattributed,
      localRowsScanned: input.evidence.localRowsScanned,
      localInWindow: input.evidence.localInWindow,
      localUnique: input.counts.localUnique,
      localDuplicateIds: input.counts.localDuplicateIds,
      localUnresolvedOccurrence: input.evidence.localUnresolvedOccurrence,
      localMissingIdentity: input.evidence.localMissingIdentity,
      intersection: input.counts.intersection,
      providerOnly: input.counts.providerOnly,
      localOnly: input.counts.localOnly,
      providerOnlyExpected: input.counts.providerOnlyExpected,
      providerOnlyNotConfigured: input.counts.providerOnlyNotConfigured,
      providerOnlyExcluded: input.counts.providerOnlyExcluded,
      providerOnlyUnknownMember: input.counts.providerOnlyUnknownMember,
      pagesFetched: input.evidence.pagesFetched,
      pageCap: input.evidence.pageCap,
      truncated: input.evidence.truncated,
      reason: input.reason,
      observedAt: input.observedAt,
      reconciledAt: input.reconciledAt,
    };

    const day = await this.prisma.$transaction(async (tx) => {
      const row = await tx.providerReconciliationDay.upsert({
        where: {
          reconciliation_day_identity: {
            organizationId,
            provider: input.provider,
            stream: input.stream,
            businessDate,
          },
        },
        create: {
          organizationId,
          provider: input.provider,
          stream: input.stream,
          businessDate,
          ...dayData,
        },
        update: dayData,
      });

      // REPLACE, DO NOT MERGE. A member that no longer appears in the provider's
      // population must not survive from a previous run looking current, and
      // upserting member-by-member would leave exactly those rows behind.
      await tx.providerReconciliationMember.deleteMany({
        where: { reconciliationDayId: row.id },
      });
      for (const m of input.members) {
        await tx.providerReconciliationMember.create({
          data: {
            reconciliationDayId: row.id,
            organizationId,
            memberDimension: m.dimension,
            memberExternalId: m.memberExternalId,
            providerCount: m.providerCount,
            providerOnly: m.providerOnly,
            localCount: m.localCount,
            localOnly: m.localOnly,
            expectationState: m.expectationState,
            expectationId: m.expectationId,
            expectationMatches: m.expectationMatches,
            labelAtObservation: m.labelAtObservation,
          },
        });
      }
      return row.id;
    });

    const stored = await this.findDay(organizationId, input.provider, input.stream, input.businessDate);
    // Unreachable in practice -- the transaction just committed it -- but a null
    // here would mean a tenant mismatch, and inventing a view would hide it.
    if (!stored) {
      return {
        ok: false,
        reason: 'INCOHERENT_COUNTS',
        problems: [`the reconciliation row ${day} could not be read back within its organization`],
      };
    }
    return { ok: true, day: stored };
  }

  /**
   * One day's stored reconciliation, or null when none exists.
   *
   * THE ABSENCE OF A ROW MEANS THE DAY WAS NEVER RECONCILED, and it certifies
   * nothing -- the convention `ProviderObservationRepository.statusesForDates`
   * already holds. There is deliberately no way to ask this method for a default.
   */
  async findDay(
    organizationId: string,
    provider: string,
    stream: string,
    businessDate: BusinessDate,
  ): Promise<ReconciliationDayView | null> {
    const row = await this.prisma.providerReconciliationDay.findFirst({
      where: {
        organizationId,
        provider,
        stream,
        businessDate: businessDateToColumn(businessDate),
      },
    });
    if (!row) return null;
    const members = await this.prisma.providerReconciliationMember.findMany({
      where: { organizationId, reconciliationDayId: row.id },
      orderBy: { memberExternalId: 'asc' },
    });
    return toDayView(row, members);
  }

  /**
   * The state of each requested business date, for one tenant and stream.
   *
   * RETURNS ONLY WHAT EXISTS, and omits a day whose stored state cannot be read
   * rather than guessing -- so a caller gating on this map treats both "never
   * reconciled" and "unreadable" as the same refusal.
   */
  async statesForDates(
    organizationId: string,
    provider: string,
    stream: string,
    businessDates: readonly BusinessDate[],
  ): Promise<Map<BusinessDate, ReconciliationState>> {
    const out = new Map<BusinessDate, ReconciliationState>();
    if (businessDates.length === 0) return out;
    const rows = await this.prisma.providerReconciliationDay.findMany({
      where: {
        organizationId,
        provider,
        stream,
        businessDate: { in: businessDates.map(businessDateToColumn) },
      },
      select: { businessDate: true, state: true },
    });
    for (const row of rows) {
      if (isReconciliationState(row.state)) {
        out.set(columnToBusinessDate(row.businessDate), row.state);
      }
    }
    return out;
  }

  /**
   * Every stored member fact for one member across a set of dates.
   *
   * The read a per-binding readiness gate will need, present now because the
   * member table exists to serve it -- but nothing in this branch calls it, and
   * nothing in this branch wires readiness to anything.
   */
  async memberFactsForDates(
    organizationId: string,
    provider: string,
    stream: string,
    dimension: BindingDimension,
    memberExternalId: string,
    businessDates: readonly BusinessDate[],
  ): Promise<Map<BusinessDate, ReconciliationMemberView>> {
    const out = new Map<BusinessDate, ReconciliationMemberView>();
    if (businessDates.length === 0) return out;
    // TWO SCOPED READS RATHER THAN A RELATION FILTER. The day ids are resolved
    // WITHIN the organization first, and the member read is then scoped by both
    // those ids and the organization again -- so a member row can only be reached
    // through a day this tenant owns, and the tenant is stated at each step
    // rather than inherited implicitly through a join.
    const days = await this.prisma.providerReconciliationDay.findMany({
      where: {
        organizationId,
        provider,
        stream,
        businessDate: { in: businessDates.map(businessDateToColumn) },
      },
      select: { id: true, businessDate: true },
    });
    if (days.length === 0) return out;
    const dateById = new Map(days.map((d) => [d.id, columnToBusinessDate(d.businessDate)]));
    const rows = await this.prisma.providerReconciliationMember.findMany({
      where: {
        organizationId,
        memberDimension: dimension,
        memberExternalId,
        reconciliationDayId: { in: [...dateById.keys()] },
      },
    });
    for (const row of rows) {
      const date = dateById.get(row.reconciliationDayId);
      if (date) out.set(date, toMemberView(row));
    }
    return out;
  }
}

function toMemberView(row: {
  memberDimension: string;
  memberExternalId: string;
  providerCount: number;
  providerOnly: number;
  localCount: number;
  localOnly: number;
  expectationState: string;
  expectationId: string | null;
  expectationMatches: number;
  labelAtObservation: string | null;
}): ReconciliationMemberView {
  return {
    dimension: dimensionSupported(row.memberDimension) ? row.memberDimension : null,
    memberExternalId: row.memberExternalId,
    providerCount: row.providerCount,
    providerOnly: row.providerOnly,
    localCount: row.localCount,
    localOnly: row.localOnly,
    expectationState: toResolvedExpectation(row.expectationState),
    expectationId: row.expectationId,
    expectationMatches: row.expectationMatches,
    labelAtObservation: row.labelAtObservation,
  };
}

function toDayView(
  row: {
    businessDate: Date;
    timezone: string;
    state: string;
    ruleVersion: string;
    localStage: string;
    providerRecords: number;
    providerUnique: number;
    providerDuplicateIds: number;
    providerUnattributed: number;
    localRowsScanned: number;
    localInWindow: number;
    localUnique: number;
    localDuplicateIds: number;
    localUnresolvedOccurrence: number;
    localMissingIdentity: number;
    intersection: number;
    providerOnly: number;
    localOnly: number;
    providerOnlyExpected: number;
    providerOnlyNotConfigured: number;
    providerOnlyExcluded: number;
    providerOnlyUnknownMember: number;
    pagesFetched: number;
    pageCap: number;
    truncated: boolean;
    reason: string | null;
    observedAt: Date;
    reconciledAt: Date;
  },
  members: Parameters<typeof toMemberView>[0][],
): ReconciliationDayView {
  return {
    businessDate: columnToBusinessDate(row.businessDate),
    timezone: row.timezone,
    state: isReconciliationState(row.state) ? row.state : null,
    ruleVersion: row.ruleVersion,
    localStage: row.localStage,
    counts: {
      providerUnique: row.providerUnique,
      providerDuplicateIds: row.providerDuplicateIds,
      localUnique: row.localUnique,
      localDuplicateIds: row.localDuplicateIds,
      intersection: row.intersection,
      providerOnly: row.providerOnly,
      localOnly: row.localOnly,
      providerOnlyExpected: row.providerOnlyExpected,
      providerOnlyNotConfigured: row.providerOnlyNotConfigured,
      providerOnlyExcluded: row.providerOnlyExcluded,
      providerOnlyUnknownMember: row.providerOnlyUnknownMember,
    },
    evidence: {
      providerRecords: row.providerRecords,
      providerUnattributed: row.providerUnattributed,
      localRowsScanned: row.localRowsScanned,
      localInWindow: row.localInWindow,
      localUnresolvedOccurrence: row.localUnresolvedOccurrence,
      localMissingIdentity: row.localMissingIdentity,
      pagesFetched: row.pagesFetched,
      pageCap: row.pageCap,
      truncated: row.truncated,
    },
    reason: row.reason,
    observedAt: row.observedAt.toISOString(),
    reconciledAt: row.reconciledAt.toISOString(),
    members: members.map(toMemberView),
  };
}

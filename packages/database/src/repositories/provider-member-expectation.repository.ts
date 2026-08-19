// ProviderMemberExpectationRepository -- Commercial Intelligence Stage 3 correctness.
//
// Persistence for "was this provider population member supposed to send records
// to Loop on this business date". It stores human declarations and resolves them;
// it never reads traffic, never queries a provider, and never decides what a
// declaration MEANS -- that rule is pure and lives in @emgloop/shared.
//
// EXPECTATION IS DECLARED, NEVER INFERRED, and this file is where that discipline
// has to hold, because it is the only place a write could happen. There is no
// method here that takes a call count, an IntegrationEvent, a webhook
// configuration or a reconciliation result. A campaign that broke would otherwise
// silently un-expect itself the moment it stopped delivering, and the alarm would
// disarm exactly when it was needed. Traffic that contradicts a declaration is
// reported as CAMPAIGN_EXPECTATION_CONTRADICTED and waits for a person.
//
// HISTORY IS NEVER REWRITTEN. Changing what is expected of a member is a NEW
// declaration from a new date; the row it succeeds has exactly one column written
// -- `effectiveTo` -- and keeps its state, basis, reason and author. The
// alternative retroactively converts every day before a webhook was attached into
// a delivery failure nobody could have prevented. This is the same stance
// ObjectiveMeasureBindingRepository takes with supersession, for the same reason.
//
// UNKNOWN IS NOT STORABLE AND NOT WRITABLE. Only the three declarable states
// reach a column. "Nobody has said" is the ABSENCE of a row covering the date,
// and it fails closed at the measurement gate.
//
// TENANT-FIRST. `organizationId` is the first argument of every method, leads the
// lookup index and both database constraints. Sprint 29A's lesson was that
// caller-enforced isolation cannot be sustained by review, so there is no method
// here that can be called without a tenant.
//
// BUSINESS DATES ARE STRINGS AT THE BOUNDARY, DATES IN THE COLUMN, exactly as
// ProviderObservationRepository established: callers speak 'YYYY-MM-DD' because
// that is what a business date IS, and the conversion pins the bare DATE column
// to UTC midnight in both directions so a server in any zone reads the same day.

import type { PrismaClient, ProviderMemberExpectation } from '@prisma/client';
import {
  declarationProblems,
  dimensionSupported,
  isEffectiveOn,
  isMemberExclusionReason,
  isMemberExpectationBasis,
  isMemberExpectationState,
  resolveExpectation,
  type BindingDimension,
  type BusinessDate,
  type ExpectationResolution,
  type MemberExclusionReason,
  type MemberExpectationBasis,
  type MemberExpectationDeclaration,
  type MemberExpectationState,
} from '@emgloop/shared';

import { businessDateToColumn, columnToBusinessDate } from './provider-observation.repository';

/** One declaration, as an operator asks for it to be recorded. */
export interface DeclareExpectationInput {
  provider: string;
  stream: string;
  /** A member of EXPECTATION_DIMENSIONS. 'CAMPAIGN' in v1. */
  dimension: BindingDimension;
  /** The provider's own id for the member. Never a label. */
  memberExternalId: string;
  state: MemberExpectationState;
  /** Required when state is EXCLUDED, forbidden otherwise. */
  exclusionReason?: MemberExclusionReason | null;
  basis: MemberExpectationBasis;
  /** Why, in plain language. Required: an unexplained declaration is a place to hide. */
  reason: string;
  /** INCLUSIVE. The first business date this declaration speaks for. */
  effectiveFrom: BusinessDate;
  /** EXCLUSIVE. Omit or pass null for open-ended. */
  effectiveTo?: BusinessDate | null;
  /** Who said it. Null when no human actor is resolvable -- never a stand-in. */
  declaredByUserId?: string | null;
}

/**
 * Why a declaration was refused. A CLOSED LIST, and each member names a different
 * thing the caller must change.
 */
export type DeclareRejection =
  /** The declaration is not well formed: unsupported dimension, missing member
      id, EXCLUDED without a reason, or an empty/inverted effective range. */
  | 'INVALID_DECLARATION'
  /** No plain-language reason was given. */
  | 'REASON_REQUIRED'
  /** A declaration already in force would be overwritten rather than succeeded.
      Retire or re-date the existing one first; this method will not silently
      delete somebody else's statement about the same member. */
  | 'OVERLAPS_EXISTING';

/** A stored declaration, as a caller sees it. */
export interface ExpectationDeclarationView extends MemberExpectationDeclaration {
  id: string;
  provider: string;
  stream: string;
  reason: string;
  declaredByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What `declare` WOULD do, without doing it.
 *
 * Exists because an operator pointing a production write at a live tenant should
 * be able to see the answer before committing to it, and because the only honest
 * way to offer that is to ask the same question the write asks.
 */
export interface DeclarationPreview {
  outcome: 'CREATED' | 'ALREADY_EQUIVALENT' | 'BLOCKED';
  /** The declaration in force on `effectiveFrom` today, or null when none is. */
  effectiveNow: ExpectationDeclarationView | null;
  /** The declaration the write would END at the new start date, when there is one. */
  supersedes: ExpectationDeclarationView | null;
  /** Set only when BLOCKED, and drawn from the same closed list `declare` uses. */
  reason: DeclareRejection | null;
  problems: readonly string[];
}

export type DeclareResult =
  | {
      ok: true;
      declaration: ExpectationDeclarationView;
      /** The declaration this one ended, or null when it started a fresh history. */
      supersededId: string | null;
      /** True when an identical declaration was already in force and nothing was
          written. Re-stating what the record already says is not a change. */
      unchanged: boolean;
    }
  | { ok: false; reason: DeclareRejection; problems: readonly string[] };

/**
 * A stored row as the pure contract's declaration, or null when it cannot be read.
 *
 * FAILS CLOSED ON A VOCABULARY IT DOES NOT RECOGNISE. The state, dimension, basis
 * and exclusion reason are TEXT columns so the vocabularies can widen without
 * production DDL -- which means a row can outlive the build that wrote it, or be
 * corrupted by a direct write. Such a row is not interpreted; the caller counts it
 * and fails closed rather than guessing which of three states it meant.
 */
function toDeclaration(row: ProviderMemberExpectation): MemberExpectationDeclaration | null {
  if (!dimensionSupported(row.memberDimension)) return null;
  if (!isMemberExpectationState(row.state)) return null;
  if (!isMemberExpectationBasis(row.basis)) return null;
  if (row.exclusionReason !== null && !isMemberExclusionReason(row.exclusionReason)) return null;
  return {
    dimension: row.memberDimension,
    memberExternalId: row.memberExternalId,
    state: row.state,
    exclusionReason: row.exclusionReason,
    basis: row.basis,
    effectiveFrom: columnToBusinessDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : columnToBusinessDate(row.effectiveTo),
  };
}

function toView(row: ProviderMemberExpectation, declaration: MemberExpectationDeclaration): ExpectationDeclarationView {
  return {
    ...declaration,
    id: row.id,
    provider: row.provider,
    stream: row.stream,
    reason: row.reason,
    declaredByUserId: row.declaredByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The raw stored range, for a row whose vocabulary could not be read. */
function rawRangeCovers(row: ProviderMemberExpectation, on: BusinessDate): boolean {
  return isEffectiveOn(
    {
      effectiveFrom: columnToBusinessDate(row.effectiveFrom),
      effectiveTo: row.effectiveTo === null ? null : columnToBusinessDate(row.effectiveTo),
    },
    on,
  );
}

/**
 * Whether two half-open business-date ranges share at least one date.
 *
 * String comparison, deliberately: a business date is zero-padded 'YYYY-MM-DD',
 * so lexical order IS calendar order, and comparing strings keeps a timezone out
 * of a question that has none. A null upper bound is unbounded. THE SAME RULE THE
 * DATABASE'S EXCLUDE CONSTRAINT APPLIES over daterange(from, to, '[)'), so the
 * pre-check and the backstop cannot disagree about what an overlap is.
 */
function rangesOverlap(
  aFrom: BusinessDate,
  aTo: BusinessDate | null,
  bFrom: BusinessDate,
  bTo: BusinessDate | null,
): boolean {
  const aBeforeB = aTo !== null && aTo <= bFrom;
  const bBeforeA = bTo !== null && bTo <= aFrom;
  return !aBeforeB && !bBeforeA;
}

/**
 * Whether a database error is the overlap invariant firing.
 *
 * The repository resolves overlaps itself, inside a transaction, so this path is
 * only reached when two declarations race -- each passing its own pre-check and
 * both committing. Postgres raises 23P01 for an exclusion violation, which Prisma
 * surfaces as an unknown request error rather than a typed one, so the shape is
 * matched rather than the code alone.
 */
function isOverlapViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 'P2002' || code === '23P01') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /exclusion constraint|23P01|provider_member_expectations_no_overlap/i.test(message);
}

/**
 * What a declaration WOULD do, worked out from the rows that already exist.
 *
 * PURE, AND THE ONLY PLACE THIS IS DECIDED. `declare` acts on it inside a
 * transaction and `previewDeclaration` reports it without one, so an operator
 * asking "what would this do" and the write that follows can never disagree.
 * Reimplementing the same reasoning in a dry-run path would be the parallel
 * system CLAUDE.md names first, and the one place it would eventually diverge is
 * the place where somebody is deciding whether to write to production.
 */
export type DeclarationDecision =
  /** An existing declaration already covers this range and says the same thing. */
  | { kind: 'EQUIVALENT'; row: ProviderMemberExpectation }
  /** Writing would have to delete or re-date somebody else's statement. */
  | { kind: 'BLOCKED'; problems: string[] }
  /** Write it, ending `predecessor` at the new start date when there is one. */
  | { kind: 'CREATE'; predecessor: ProviderMemberExpectation | null };

/** Shape validation, judged by the pure contract. Null when well formed. */
function candidateProblems(
  candidate: MemberExpectationDeclaration,
  input: DeclareExpectationInput,
  reason: string,
): { reason: DeclareRejection; problems: string[] } | null {
  // SHAPE FIRST, and the rule is the pure one. Dimension support, member
  // identity, the EXCLUDED-needs-a-reason pairing and the effective range are
  // all judged by @emgloop/shared, so the persisted rows and the contract that
  // reads them can never drift into disagreeing about what is well formed.
  const problems = declarationProblems(candidate);
  if (!isMemberExpectationState(input.state)) problems.push(`state ${String(input.state)} is not declarable`);
  if (!isMemberExpectationBasis(input.basis)) problems.push(`basis ${String(input.basis)} is not a known basis`);
  if (problems.length > 0) return { reason: 'INVALID_DECLARATION', problems };
  if (reason === '') {
    return {
      reason: 'REASON_REQUIRED',
      problems: ['a declaration must say why, in plain language'],
    };
  }
  return null;
}

/** Build the candidate a caller's input describes, with the trimming applied. */
function candidateFrom(input: DeclareExpectationInput): {
  candidate: MemberExpectationDeclaration;
  reason: string;
} {
  return {
    candidate: {
      dimension: input.dimension,
      memberExternalId: input.memberExternalId?.trim() ?? '',
      state: input.state,
      exclusionReason: input.exclusionReason ?? null,
      basis: input.basis,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
    },
    reason: input.reason?.trim() ?? '',
  };
}

/**
 * Decide what a well-formed candidate would do against the member's existing rows.
 *
 * Pure: no clock, no I/O, no transaction. `rows` must already be scoped to the
 * organization, provider, stream, dimension and member -- this function does not
 * re-check tenancy, because a caller who reached it with the wrong rows has
 * already made a mistake no arithmetic here could catch.
 */
function decideDeclaration(
  rows: readonly ProviderMemberExpectation[],
  candidate: MemberExpectationDeclaration,
): DeclarationDecision {
  const overlapping = rows.filter((row) =>
    rangesOverlap(
      columnToBusinessDate(row.effectiveFrom),
      row.effectiveTo === null ? null : columnToBusinessDate(row.effectiveTo),
      candidate.effectiveFrom,
      candidate.effectiveTo,
    ),
  );

  // NOTHING TO SAY THAT IS NOT ALREADY SAID. An existing declaration that
  // covers the whole new range and states the same thing makes this a no-op.
  // Writing anyway would split one interval into two identical rows and put a
  // second author on half of a statement one person made.
  const equivalent = overlapping.find((row) => {
    const declaration = toDeclaration(row);
    if (!declaration) return false;
    if (
      declaration.state !== candidate.state ||
      declaration.exclusionReason !== candidate.exclusionReason ||
      declaration.basis !== candidate.basis
    ) {
      return false;
    }
    if (declaration.effectiveFrom > candidate.effectiveFrom) return false;
    if (declaration.effectiveTo === null) return true;
    return candidate.effectiveTo !== null && declaration.effectiveTo >= candidate.effectiveTo;
  });
  if (equivalent) return { kind: 'EQUIVALENT', row: equivalent };

  // A declaration starting ON OR AFTER the new one would have to be deleted or
  // re-dated to make room. Neither is this method's decision.
  const laterOrSameStart = overlapping.filter(
    (row) => columnToBusinessDate(row.effectiveFrom) >= candidate.effectiveFrom,
  );
  if (laterOrSameStart.length > 0) {
    return {
      kind: 'BLOCKED',
      problems: laterOrSameStart.map(
        (row) => `a declaration already starts on ${columnToBusinessDate(row.effectiveFrom)} for this member`,
      ),
    };
  }

  // Under the database invariant at most one earlier declaration can still be in
  // force. More than one means the table has been written around, and truncating
  // several rows on a guess is not a repair.
  if (overlapping.length > 1) {
    return {
      kind: 'BLOCKED',
      problems: [`${overlapping.length} declarations are already in force for this member`],
    };
  }

  return { kind: 'CREATE', predecessor: overlapping[0] ?? null };
}

export class ProviderMemberExpectationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Record what a person says about one member, from one business date onward.
   *
   * THE ONLY WRITE IN THIS FILE, and it preserves history by construction. A
   * declaration already in force that STARTS EARLIER is ended at the new
   * declaration's start date -- one column, written once -- and everything it
   * said about the dates it covered stays exactly as it was. A declaration that
   * starts on or after the new one is NOT touched: silently swallowing a future
   * statement somebody else recorded would be the same class of overwrite this
   * table exists to prevent, so it is refused and named.
   *
   * IDEMPOTENT ON AN IDENTICAL STATEMENT. Re-declaring what the record already
   * says returns the existing row and writes nothing, rather than fragmenting one
   * interval into two rows that mean the same thing.
   */
  async declare(organizationId: string, input: DeclareExpectationInput): Promise<DeclareResult> {
    const { candidate, reason } = candidateFrom(input);
    const memberExternalId = candidate.memberExternalId;

    const shape = candidateProblems(candidate, input, reason);
    if (shape) return { ok: false, reason: shape.reason, problems: shape.problems };

    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.providerMemberExpectation.findMany({
          where: {
            organizationId,
            provider: input.provider,
            stream: input.stream,
            memberDimension: input.dimension,
            memberExternalId,
          },
          orderBy: { effectiveFrom: 'asc' },
        });

        // THE DECISION IS MADE IN ONE PLACE, and `previewDeclaration` asks the
        // same function without a transaction. Working it out twice is how a
        // dry run eventually reassures somebody about a write that then does
        // something else.
        const decision = decideDeclaration(rows, candidate);

        if (decision.kind === 'EQUIVALENT') {
          const declaration = toDeclaration(decision.row)!;
          return {
            ok: true as const,
            declaration: toView(decision.row, declaration),
            supersededId: null,
            unchanged: true,
          };
        }
        if (decision.kind === 'BLOCKED') {
          return {
            ok: false as const,
            reason: 'OVERLAPS_EXISTING' as const,
            problems: decision.problems,
          };
        }

        const predecessor = decision.predecessor;
        if (predecessor) {
          // ONE COLUMN. The state, basis, reason and author of what was true
          // before this date are never touched.
          await tx.providerMemberExpectation.update({
            where: { id: predecessor.id },
            data: { effectiveTo: businessDateToColumn(candidate.effectiveFrom) },
          });
        }

        const created = await tx.providerMemberExpectation.create({
          data: {
            organizationId,
            provider: input.provider,
            stream: input.stream,
            memberDimension: candidate.dimension,
            memberExternalId,
            state: candidate.state,
            exclusionReason: candidate.exclusionReason,
            basis: candidate.basis,
            reason,
            effectiveFrom: businessDateToColumn(candidate.effectiveFrom),
            effectiveTo:
              candidate.effectiveTo === null ? null : businessDateToColumn(candidate.effectiveTo),
            declaredByUserId: input.declaredByUserId ?? null,
          },
        });

        return {
          ok: true as const,
          declaration: toView(created, toDeclaration(created)!),
          supersededId: predecessor?.id ?? null,
          unchanged: false,
        };
      });
    } catch (error) {
      // The backstop firing means two declarations raced. Reporting it as the
      // overlap it is beats a 500 the caller cannot act on.
      if (isOverlapViolation(error)) {
        return {
          ok: false,
          reason: 'OVERLAPS_EXISTING',
          problems: ['another declaration for this member was recorded concurrently'],
        };
      }
      throw error;
    }
  }

  /**
   * What `declare` would do with this input, WITHOUT writing anything.
   *
   * THE SAME DECISION, ASKED WITHOUT A TRANSACTION. Shape is judged by
   * `candidateProblems` and the outcome by `decideDeclaration` -- the two
   * functions `declare` itself calls -- so a preview cannot say CREATED and then
   * have the write refuse, or say ALREADY_EQUIVALENT and then have the write
   * split an interval. There is no second copy of this reasoning anywhere.
   *
   * READ-ONLY BY CONSTRUCTION: one `findMany` and pure functions. It opens no
   * transaction, and the only Prisma call it can make is a select.
   */
  async previewDeclaration(
    organizationId: string,
    input: DeclareExpectationInput,
  ): Promise<DeclarationPreview> {
    const { candidate, reason } = candidateFrom(input);

    const shape = candidateProblems(candidate, input, reason);
    if (shape) {
      return {
        outcome: 'BLOCKED',
        effectiveNow: null,
        supersedes: null,
        reason: shape.reason,
        problems: shape.problems,
      };
    }

    const rows = await this.prisma.providerMemberExpectation.findMany({
      where: {
        organizationId,
        provider: input.provider,
        stream: input.stream,
        memberDimension: input.dimension,
        memberExternalId: candidate.memberExternalId,
      },
      orderBy: { effectiveFrom: 'asc' },
    });

    // What an operator most wants to see: what the record says TODAY about the
    // date they are declaring for. Rows whose stored vocabulary cannot be read
    // are not rendered as declarations -- they cannot be shown without inventing
    // what they meant -- but they are still counted by `decideDeclaration`, so a
    // preview can legitimately report BLOCKED with nothing to display.
    let effectiveNow: ExpectationDeclarationView | null = null;
    for (const row of rows) {
      const declaration = toDeclaration(row);
      if (declaration && isEffectiveOn(declaration, candidate.effectiveFrom)) {
        effectiveNow = toView(row, declaration);
        break;
      }
    }

    const decision = decideDeclaration(rows, candidate);
    if (decision.kind === 'EQUIVALENT') {
      const declaration = toDeclaration(decision.row)!;
      return {
        outcome: 'ALREADY_EQUIVALENT',
        effectiveNow: toView(decision.row, declaration),
        supersedes: null,
        reason: null,
        problems: [],
      };
    }
    if (decision.kind === 'BLOCKED') {
      return {
        outcome: 'BLOCKED',
        effectiveNow,
        supersedes: null,
        reason: 'OVERLAPS_EXISTING',
        problems: decision.problems,
      };
    }

    const predecessor = decision.predecessor;
    const predecessorDeclaration = predecessor ? toDeclaration(predecessor) : null;
    return {
      outcome: 'CREATED',
      effectiveNow,
      supersedes:
        predecessor && predecessorDeclaration ? toView(predecessor, predecessorDeclaration) : null,
      reason: null,
      problems: [],
    };
  }

  /**
   * What was in force for one member on one business date.
   *
   * RETURNS THE PR 1 VOCABULARY, judged by the PR 1 rule. This method resolves
   * nothing itself: it hands the stored declarations to `resolveExpectation` and
   * returns what that says, so the persisted answer and the pure answer cannot
   * diverge. No declaration is UNKNOWN. More than one is ALSO UNKNOWN, because
   * two statements about one date mean the organization has said two things and
   * no tie-break exists that would not be invented here.
   */
  async resolveOn(
    organizationId: string,
    provider: string,
    stream: string,
    dimension: BindingDimension,
    memberExternalId: string,
    on: BusinessDate,
  ): Promise<ExpectationResolution> {
    const { resolution } = await this.resolveSourceOn(
      organizationId,
      provider,
      stream,
      dimension,
      memberExternalId,
      on,
    );
    return resolution;
  }

  /**
   * The same resolution, plus the id of the ROW that produced it.
   *
   * ADDED FOR RECONCILIATION, which must record not merely what was expected on a
   * date but WHICH STATEMENT said so. A reconciliation fact that stored only the
   * state would silently change meaning the moment somebody recorded a different
   * declaration -- the historical verdict would keep its number while losing the
   * reason it reached it, which is the exact defect PR #153 found in the Decision
   * Center's evidence.
   *
   * `resolveOn` delegates here rather than querying separately, so there remains
   * exactly ONE semantic path for deciding what was in force on a date. The id is
   * null whenever the state is UNKNOWN, because UNKNOWN is precisely the case
   * where no single declaration applied.
   */
  async resolveSourceOn(
    organizationId: string,
    provider: string,
    stream: string,
    dimension: BindingDimension,
    memberExternalId: string,
    on: BusinessDate,
  ): Promise<{ resolution: ExpectationResolution; declarationId: string | null }> {
    const rows = await this.prisma.providerMemberExpectation.findMany({
      where: {
        organizationId,
        provider,
        stream,
        memberDimension: dimension,
        memberExternalId,
      },
      orderBy: { effectiveFrom: 'asc' },
    });

    const declarations: MemberExpectationDeclaration[] = [];
    // Parallel to `declarations`, index for index: which row each parsed
    // declaration came from. Kept as a second array rather than folded into the
    // declaration, because the pure contract's shape has no id and must not gain
    // one -- persistence is this layer's concern, not the rule's.
    const sourceIds: string[] = [];
    // Rows whose stored vocabulary cannot be read AND which cover the date asked
    // about. They are not interpreted, and they are not ignored either: dropping
    // one could turn a two-way conflict into a confident answer.
    let unreadableOnDate = 0;
    for (const row of rows) {
      const declaration = toDeclaration(row);
      if (declaration) {
        declarations.push(declaration);
        sourceIds.push(row.id);
      } else if (rawRangeCovers(row, on)) unreadableOnDate += 1;
    }

    const resolution = resolveExpectation(declarations, dimension, memberExternalId, on);
    if (unreadableOnDate > 0) {
      return {
        resolution: {
          state: 'UNKNOWN',
          declaration: null,
          matches: resolution.matches + unreadableOnDate,
        },
        declarationId: null,
      };
    }
    // The resolver returns the declaration OBJECT; the row it came from is the
    // one whose parsed form is that object. Identity comparison is exact -- the
    // objects in `declarations` are the same references the resolver filtered --
    // so no re-matching by value is needed and none is attempted.
    const index = resolution.declaration ? declarations.indexOf(resolution.declaration) : -1;
    const source = index >= 0 ? sourceIds[index] : undefined;
    return { resolution, declarationId: source ?? null };
  }

  /**
   * Every declaration ever made about one member, oldest first.
   *
   * THE AUDIT VIEW. Closed intervals are returned alongside the one in force,
   * because the question this table answers is "what did we say then", not "what
   * do we say now". Rows whose stored vocabulary cannot be read are omitted --
   * they cannot be rendered as a declaration without inventing what they meant.
   */
  async declarationsFor(
    organizationId: string,
    provider: string,
    stream: string,
    dimension: BindingDimension,
    memberExternalId: string,
  ): Promise<ExpectationDeclarationView[]> {
    const rows = await this.prisma.providerMemberExpectation.findMany({
      where: {
        organizationId,
        provider,
        stream,
        memberDimension: dimension,
        memberExternalId,
      },
      orderBy: { effectiveFrom: 'asc' },
    });
    const out: ExpectationDeclarationView[] = [];
    for (const row of rows) {
      const declaration = toDeclaration(row);
      if (declaration) out.push(toView(row, declaration));
    }
    return out;
  }
}

// What could be done about a Finding — recorded, ranked with a stated basis, and
// never turned into work.
//
// WHAT THIS IS. The one place a recommendation set is written, read, selected,
// dismissed and revised. It writes exactly two kinds of row, both of which
// already exist: a `CognitiveDecision` per option -- the model this repository
// already uses for "a decision made from state, policy and evidence", carrying
// the RECOMMEND outcome and the approval columns -- and an observation on the
// Case's own append-only log linked to it through `OperationalObservation
// .decisionId`, an FK that has been in the schema since the Decision Center
// shipped. No new table. No migration.
//
// IT CREATES NOTHING EXECUTABLE. No `WorkInstance`, no `WorkStage`, no
// `Blueprint`, no assignment, no notification, no send. A proposed sequence is a
// sentence a person can read, not a plan the system has started. That is not
// restraint -- writing a Blueprint per recommendation would put every proposal
// into the organization's Work Type catalogue, because `listWorkTypes` reads
// every Blueprint in the org.
//
// THE CEILING IS ENFORCED HERE, NOT SUGGESTED. An option's posture is checked
// against the evidence strength of the Finding it rests on, and the whole set is
// REFUSED if any option exceeds it. A set is never quietly downgraded: silently
// weakening somebody's proposal is worse than telling them it was not allowed.
// Evidence strength itself comes from the Finding service's establishment
// verdict, so there is one answer to "how well established is this" and Stage 4
// cannot recommend past what Stage 3 proved.
//
// THE MACHINE'S WORDS ARE NEVER OVERWRITTEN. Selecting uses the existing
// approval columns. Dismissing writes only to the log. A person's revision is a
// NEW row naming what it was derived from. There is no update path to an
// option's text anywhere in this file, so "machine history is preserved" is a
// property of the shape rather than of somebody's care.
//
// NO MODEL, AND THE PROVENANCE COLUMN IS ALREADY WAITING FOR ONE. Nothing here
// generates an option; a caller supplies them and declares the author. When a
// model eventually writes one it arrives as `author: 'MODEL'` and is stored as
// such, so generated text can never be mistaken for a measurement later.

import type { CognitiveDecision, PrismaClient } from '@prisma/client';
import {
  RECOMMENDATION_DECISION_TYPE,
  RECOMMENDATION_DISMISSED_REASON,
  RECOMMENDATION_RECORDED_REASON,
  RECOMMENDATION_REVISED_REASON,
  RECOMMENDATION_RULE_VERSION,
  RECOMMENDATION_SELECTED_REASON,
  compareOptions,
  diffSequence,
  factorsAffectedBy,
  findingEvidenceStrength,
  optionsInRank,
  recommendationKey,
  recommendationKeyPrefix,
  revisionKey,
  validateRecommendationSet,
  type CaseFindingView,
  type EvidenceStrength,
  type OptionComparison,
  type RecommendationAuthor,
  type RecommendationOption,
  type RecommendationRejection,
  type RecommendedAction,
  type SequenceRevision,
} from '@emgloop/shared';

import { CognitiveDecisionRepository } from '../repositories/cognitive/decision.repository';
import { CaseFindingService } from './case-finding.service';
import { DecisionEngine } from './decision/decision-engine';
import type { DecisionActor } from './decision/decision-engine.contracts';

/** How a request to record a set ended. Only one of them writes. */
export const RECOMMENDATION_RECORD_OUTCOMES = [
  'RECORDED',
  /** No such Case in this organization. Not-found, never forbidden. */
  'CASE_NOT_FOUND',
  /**
   * The Case carries no Finding.
   *
   * A RECOMMENDATION WITHOUT A FINDING IS AN OPINION. There would be nothing to
   * measure the ceiling against, so there is nothing to check, so anything could
   * be proposed. Refused rather than defaulted to the weakest evidence.
   */
  'NO_FINDING',
  /** The set could not be represented. `rejections` says why, in full. */
  'REJECTED',
] as const;
export type RecommendationRecordOutcome = (typeof RECOMMENDATION_RECORD_OUTCOMES)[number];

export interface RecordRecommendationsResult {
  outcome: RecommendationRecordOutcome;
  caseId: string;
  /** Which set this became. 1 for the first; supersession increments it. */
  setNumber: number | null;
  /** The decision rows written, one per option, in rank order. */
  optionIds: readonly string[];
  /** Every reason the set was refused. Empty unless REJECTED. */
  rejections: readonly RecommendationRejection[];
  /** Which option each rejection came from, in the same order. */
  offendingKeys: readonly string[];
}

export interface RecordRecommendationsInput {
  options: readonly RecommendationOption[];
  /** Who wrote them. A model declares MODEL and is stored as such. */
  author: RecommendationAuthor;
  actor: DecisionActor;
  /** When Loop proposed it. Defaults to the operation's clock. */
  issuedAt?: Date;
}

/** One option, read back with everything a person needs to weigh it. */
export interface RecommendationOptionView extends RecommendationOption {
  /** The `CognitiveDecision` row this option is. */
  decisionId: string;
  author: RecommendationAuthor;
  /** Set when a person selected this option. The existing approval columns. */
  selectedByUserId: string | null;
  selectedAt: string | null;
  /** True when a person set this option aside. From the Case's log. */
  dismissed: boolean;
  /**
   * A person's revision of this option, when one exists.
   *
   * A SEPARATE ROW. This option's own words are exactly what Loop wrote.
   */
  revision: RecommendationRevisionView | null;
}

export interface RecommendationRevisionView {
  decisionId: string;
  actions: readonly RecommendedAction[];
  revisedByUserId: string | null;
  revisedAt: string;
  /** What moved, computed. Never what it means. */
  changed: SequenceRevision;
  /**
   * The comparisons this revision could have changed.
   *
   * THE QUESTION, NOT THE ANSWER. Loop names the factors a person should
   * re-weigh; it does not claim to know which way they moved, because that is a
   * business judgement it has no basis for.
   */
  factorsToReconsider: readonly string[];
}

/** Everything proposed about one Case, with its history. */
export interface CaseRecommendationsView {
  caseId: string;
  findingId: string;
  /** The current set. Earlier sets are in `supersededSets`, unchanged. */
  setNumber: number;
  ruleVersion: string;
  /** The Finding's state when this set was written. A snapshot, deliberately. */
  findingStateAtIssue: string;
  evidenceStrengthAtIssue: EvidenceStrength;
  options: readonly RecommendationOptionView[];
  /**
   * Pairwise comparisons between adjacently ranked options.
   *
   * THIS IS THE ANSWER TO "WHY IS THIS ONE FIRST". Computed from the declared
   * factor profiles, with no weighting and no score, so a surface can render the
   * actual reasons rather than a number nobody can reconstruct.
   */
  comparisons: readonly OptionComparison[];
  /** Every earlier set, newest first. Never edited. */
  supersededSets: readonly { setNumber: number; options: readonly RecommendationOptionView[] }[];
}

// --- Seams -----------------------------------------------------------------------

/** The Decision Center surface: one read, one log append. */
export type RecommendationCaseAccess = Pick<DecisionEngine, 'get' | 'addObservation'>;

/** The Finding read that supplies the ceiling. One method, and it is a read. */
export type RecommendationFindingReader = Pick<CaseFindingService, 'get'>;

export interface CaseRecommendationDeps {
  cases?: RecommendationCaseAccess;
  findings?: RecommendationFindingReader;
  decisions?: CognitiveDecisionRepository;
}

export class CaseRecommendationService {
  private readonly cases: RecommendationCaseAccess;
  private readonly findings: RecommendationFindingReader;
  private readonly decisions: CognitiveDecisionRepository;
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient, deps: CaseRecommendationDeps = {}) {
    this.prisma = prisma;
    this.cases = deps.cases ?? new DecisionEngine(prisma);
    this.findings = deps.findings ?? new CaseFindingService(prisma);
    this.decisions = deps.decisions ?? new CognitiveDecisionRepository(prisma);
  }

  // =========================================================================
  // Writing
  // =========================================================================

  /**
   * Record what could be done about this Case's Finding.
   *
   * VALIDATED BEFORE ANYTHING IS WRITTEN, so a refused set leaves no partial
   * trace: an option that exceeded its evidence cannot end up stored while its
   * siblings were rejected.
   *
   * IDEMPOTENT PER SET. Each option's key is derived from (case, set number,
   * option key), so re-running the same producer over the same set converges on
   * the same rows instead of accumulating a second copy of every proposal.
   */
  async record(
    organizationId: string,
    caseId: string,
    input: RecordRecommendationsInput,
  ): Promise<RecordRecommendationsResult> {
    const empty = { setNumber: null, optionIds: [], rejections: [], offendingKeys: [] } as const;
    if (!caseId?.trim()) return { outcome: 'CASE_NOT_FOUND', caseId, ...empty };
    const id = caseId.trim();

    const view = await this.cases.get(organizationId, id);
    if (!view) return { outcome: 'CASE_NOT_FOUND', caseId: id, ...empty };

    const finding = await this.findings.get(organizationId, id);
    if (!finding) return { outcome: 'NO_FINDING', caseId: id, ...empty };

    const evidenceStrength = strengthOf(finding);
    const validation = validateRecommendationSet({ options: input.options, evidenceStrength });
    if (!validation.ok) {
      return {
        outcome: 'REJECTED',
        caseId: id,
        setNumber: null,
        optionIds: [],
        rejections: validation.rejections,
        offendingKeys: validation.offendingKeys,
      };
    }

    const existing = await this.loadOptionRows(organizationId, id);
    const setNumber = highestSet(existing) + 1;
    const issuedAt = input.issuedAt ?? new Date();
    const optionIds: string[] = [];

    for (const option of optionsInRank({ options: input.options })) {
      // RECORDED THROUGH THE REPOSITORY THAT OWNS THIS MODEL, so the idempotency
      // guard and the P2002 convergence are the ones already proven, not a second
      // implementation of them here.
      const row = await this.decisions.recordIdempotent(organizationId, {
        decisionType: RECOMMENDATION_DECISION_TYPE,
        // The platform's existing outcome vocabulary. RECOMMEND is exactly what
        // this is: a durable record of decision support, never an instruction.
        decision: 'RECOMMEND',
        reason: option.summary,
        // NO CONFIDENCE. The column exists and nothing reads it; a number here
        // would be authority the architecture never granted.
        confidence: null,
        // AN OPTION IS NOT PRE-APPROVED. A person selecting one is what fills the
        // approval columns, and until then nothing is signed off.
        requiresApproval: true,
        idempotencyKey: recommendationKey(id, setNumber, option.key),
        // The finding and case this rests on, and the evidence state AT ISSUE.
        // Snapshotted deliberately: a recommendation read next month must show
        // what was known when it was written, not what is known now.
        inputStateSnapshot: {
          caseId: id,
          findingId: finding.findingId,
          findingStateAtIssue: finding.state,
          evidenceStrengthAtIssue: evidenceStrength,
          issuedAt: issuedAt.toISOString(),
          author: input.author,
          setNumber,
        },
        // The structured basis a surface reconstructs the ranking from.
        policyEvaluation: {
          ruleVersion: RECOMMENDATION_RULE_VERSION,
          option,
        },
      });
      optionIds.push(row.id);

      await this.cases.addObservation(organizationId, id, {
        observationType: 'RECOMMENDATION_RECORDED',
        actor: input.actor,
        reason: RECOMMENDATION_RECORDED_REASON,
        note: option.label,
        occurredAt: issuedAt,
      });
      await this.linkObservation(organizationId, id, row.id);
    }

    return {
      outcome: 'RECORDED',
      caseId: id,
      setNumber,
      optionIds,
      rejections: [],
      offendingKeys: [],
    };
  }

  /**
   * A person chooses one of the options.
   *
   * THE EXISTING APPROVAL PRIMITIVE, NOT A NEW ONE. `CognitiveDecision` already
   * carries `approvedAt` / `approvedBy` and its repository already refuses to
   * reach across a tenant. Inventing a second way to record sign-off would be a
   * second answer to "did anybody approve this".
   *
   * SELECTING IS NOT DOING. It records that a person intends to pursue an option.
   * It creates no work, sends nothing, and changes nothing outside Loop.
   */
  async select(
    organizationId: string,
    caseId: string,
    optionKey: string,
    actor: DecisionActor,
  ): Promise<CognitiveDecision | null> {
    const row = await this.currentOptionRow(organizationId, caseId, optionKey);
    if (!row) return null;
    if (!actor.userId) throw new Error('Selecting a recommendation requires an attributed person');

    const approved = await this.decisions.approve(organizationId, row.id, actor.userId);
    if (!approved) return null;
    await this.cases.addObservation(organizationId, caseId, {
      observationType: 'RECOMMENDATION_SELECTED',
      actor,
      reason: RECOMMENDATION_SELECTED_REASON,
      note: optionKey,
    });
    await this.linkObservation(organizationId, caseId, row.id);
    return approved;
  }

  /**
   * A person sets an option aside.
   *
   * WRITES ONLY TO THE LOG. The option's row is untouched, so what Loop proposed
   * survives the disagreement exactly as written.
   */
  async dismiss(
    organizationId: string,
    caseId: string,
    optionKey: string,
    actor: DecisionActor,
  ): Promise<boolean> {
    const row = await this.currentOptionRow(organizationId, caseId, optionKey);
    if (!row) return false;
    await this.cases.addObservation(organizationId, caseId, {
      observationType: 'RECOMMENDATION_DISMISSED',
      actor,
      reason: RECOMMENDATION_DISMISSED_REASON,
      note: optionKey,
    });
    await this.linkObservation(organizationId, caseId, row.id);
    return true;
  }

  /**
   * A person proposes their own version of an option's sequence.
   *
   * A NEW ROW, NAMING WHAT IT CAME FROM. The machine's option keeps its text, its
   * order and its factors; the revision is stored beside it and the read model
   * returns both. There is no path in this service that edits an option, which is
   * why "human intervention preserves machine output" needs no discipline to
   * hold.
   *
   * THE SAME VERB GUARD APPLIES. A person may reorder what Loop proposed and add
   * steps of their own, but a step that instructs a change is still refused --
   * the constraint is about what Loop is allowed to have written down as its
   * advice, not about who typed it.
   */
  async revise(
    organizationId: string,
    caseId: string,
    optionKey: string,
    revised: readonly RecommendedAction[],
    actor: DecisionActor,
  ): Promise<{ decisionId: string; changed: SequenceRevision } | null> {
    const row = await this.currentOptionRow(organizationId, caseId, optionKey);
    if (!row) return null;
    const parsed = parseOption(row);
    if (!parsed) return null;

    const check = validateRecommendationSet({
      options: [{ ...parsed.option, actions: revised }],
      evidenceStrength: parsed.evidenceStrengthAtIssue,
    });
    if (!check.ok) {
      throw new Error(`This revision cannot be recorded: ${check.rejections.join(', ')}`);
    }

    const changed = diffSequence(parsed.option.actions, revised);
    const created = await this.decisions.recordIdempotent(organizationId, {
      decisionType: RECOMMENDATION_DECISION_TYPE,
      decision: 'RECOMMEND',
      reason: parsed.option.summary,
      confidence: null,
      requiresApproval: true,
      idempotencyKey: revisionKey(caseId, parsed.setNumber, optionKey),
      inputStateSnapshot: {
        caseId,
        findingId: parsed.findingId,
        findingStateAtIssue: parsed.findingStateAtIssue,
        evidenceStrengthAtIssue: parsed.evidenceStrengthAtIssue,
        issuedAt: new Date().toISOString(),
        // THE PROVENANCE THAT MAKES THIS SAFE TO STORE. A person wrote it, and it
        // names the machine row it came from rather than replacing it.
        author: 'HUMAN' as RecommendationAuthor,
        setNumber: parsed.setNumber,
        derivedFromDecisionId: row.id,
        revisedByUserId: actor.userId ?? null,
      },
      policyEvaluation: {
        ruleVersion: RECOMMENDATION_RULE_VERSION,
        option: { ...parsed.option, actions: revised },
      },
    });

    await this.cases.addObservation(organizationId, caseId, {
      observationType: 'RECOMMENDATION_REVISED',
      actor,
      reason: RECOMMENDATION_REVISED_REASON,
      note: optionKey,
    });
    await this.linkObservation(organizationId, caseId, created.id);
    return { decisionId: created.id, changed };
  }

  // =========================================================================
  // Reading
  // =========================================================================

  /**
   * Everything proposed about one Case. READ ONLY.
   *
   * NOT-FOUND, NEVER FORBIDDEN, on every side: a Case in another organization, a
   * Case that does not exist, and a Case nobody has recommended anything about
   * all answer null.
   */
  async get(organizationId: string, caseId: string): Promise<CaseRecommendationsView | null> {
    if (!caseId?.trim()) return null;
    const id = caseId.trim();
    const view = await this.cases.get(organizationId, id);
    if (!view) return null;

    const rows = await this.loadOptionRows(organizationId, id);
    if (rows.length === 0) return null;

    const dismissedKeys = await this.dismissedKeys(organizationId, id);
    const bySet = new Map<number, RecommendationOptionView[]>();
    const revisions = new Map<string, CognitiveDecision>();

    for (const row of rows) {
      const parsed = parseOption(row);
      if (!parsed) continue;
      if (parsed.derivedFromDecisionId) {
        revisions.set(parsed.derivedFromDecisionId, row);
        continue;
      }
      const bucket = bySet.get(parsed.setNumber) ?? [];
      bucket.push(toOptionView(row, parsed, dismissedKeys.has(parsed.option.key), null));
      bySet.set(parsed.setNumber, bucket);
    }

    // Attach each revision to the option it was derived from, and compute the
    // diff here rather than storing it: the diff is a function of two stored
    // sequences, and a stored copy could disagree with them.
    for (const [setNumber, options] of bySet) {
      bySet.set(
        setNumber,
        options.map((o) => {
          const rev = revisions.get(o.decisionId);
          if (!rev) return o;
          const parsedRev = parseOption(rev);
          if (!parsedRev) return o;
          const changed = diffSequence(o.actions, parsedRev.option.actions);
          return {
            ...o,
            revision: {
              decisionId: rev.id,
              actions: parsedRev.option.actions,
              revisedByUserId: parsedRev.revisedByUserId,
              revisedAt: rev.createdAt.toISOString(),
              changed,
              factorsToReconsider: factorsAffectedBy(changed),
            },
          };
        }),
      );
    }

    const setNumbers = [...bySet.keys()].sort((a, b) => b - a);
    const currentSet = setNumbers[0];
    if (currentSet === undefined) return null;
    const current = (bySet.get(currentSet) ?? []).sort((a, b) => a.rank - b.rank);
    const head = current[0];
    if (!head) return null;
    const headParsed = rows.find((r) => r.id === head.decisionId);
    const meta = headParsed ? parseOption(headParsed) : null;

    return {
      caseId: id,
      findingId: meta?.findingId ?? '',
      setNumber: currentSet,
      ruleVersion: RECOMMENDATION_RULE_VERSION,
      findingStateAtIssue: meta?.findingStateAtIssue ?? '',
      evidenceStrengthAtIssue: meta?.evidenceStrengthAtIssue ?? 'INSUFFICIENT',
      options: current,
      comparisons: adjacentComparisons(current),
      supersededSets: setNumbers.slice(1).map((n) => ({
        setNumber: n,
        options: (bySet.get(n) ?? []).sort((a, b) => a.rank - b.rank),
      })),
    };
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Every option row for one Case, tenant-scoped.
   *
   * KEYED, NOT SEARCHED. The prefix is derived by the shared function that wrote
   * it, and the read is scoped by `organizationId` first, so this cannot reach a
   * row belonging to another tenant even if two tenants held the same case id.
   */
  private loadOptionRows(organizationId: string, caseId: string): Promise<CognitiveDecision[]> {
    return this.prisma.cognitiveDecision.findMany({
      where: {
        organizationId,
        decisionType: RECOMMENDATION_DECISION_TYPE,
        idempotencyKey: { startsWith: recommendationKeyPrefix(caseId) },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** The current set's row for one option key, or null. */
  private async currentOptionRow(
    organizationId: string,
    caseId: string,
    optionKey: string,
  ): Promise<CognitiveDecision | null> {
    const rows = await this.loadOptionRows(organizationId, caseId);
    const set = highestSet(rows);
    if (set === 0) return null;
    const key = recommendationKey(caseId, set, optionKey);
    return rows.find((r) => r.idempotencyKey === key) ?? null;
  }

  /** The option keys a person has set aside, read from the Case's own log. */
  private async dismissedKeys(organizationId: string, caseId: string): Promise<Set<string>> {
    const rows = await this.prisma.operationalObservation.findMany({
      where: { organizationId, priorityId: caseId, reason: RECOMMENDATION_DISMISSED_REASON },
      select: { note: true },
    });
    return new Set(rows.map((r) => r.note).filter((n): n is string => !!n));
  }

  /**
   * Point the observation just appended at the decision it is about.
   *
   * A SECOND STATEMENT, NOT A SECOND TRUTH. `addObservation` does not accept a
   * `decisionId`, and widening the engine's action contract for this would put a
   * cognitive-layer id into every operator action. The column is the schema's own
   * link between the two views of a decision, so it is set on the row that was
   * just written -- scoped to the organization and the case, so it can only ever
   * touch a row this tenant owns.
   */
  private async linkObservation(
    organizationId: string,
    caseId: string,
    decisionId: string,
  ): Promise<void> {
    const latest = await this.prisma.operationalObservation.findFirst({
      where: { organizationId, priorityId: caseId },
      orderBy: { sequence: 'desc' },
      select: { id: true, decisionId: true },
    });
    if (!latest || latest.decisionId) return;
    await this.prisma.operationalObservation.update({
      where: { id: latest.id },
      data: { decisionId },
    });
  }
}

// --- Projections ---------------------------------------------------------------------

/** The evidence strength of the Finding a set rests on. One derivation, shared. */
function strengthOf(finding: CaseFindingView): EvidenceStrength {
  return findingEvidenceStrength({
    state: finding.state,
    establishedBy: finding.establishedBy,
    establishment: finding.establishment,
    supportingCount: finding.supporting.length,
  });
}

interface ParsedOption {
  option: RecommendationOption;
  setNumber: number;
  findingId: string;
  findingStateAtIssue: string;
  evidenceStrengthAtIssue: EvidenceStrength;
  author: RecommendationAuthor;
  derivedFromDecisionId: string | null;
  revisedByUserId: string | null;
}

/**
 * Read one stored option back.
 *
 * RETURNS NULL RATHER THAN GUESSING. A row whose JSON this build cannot
 * interpret is dropped from the read, exactly as `statesForDates` drops a
 * reconciliation state it does not recognise: the alternative is inventing a
 * shape and rendering a proposal nobody wrote.
 */
function parseOption(row: CognitiveDecision): ParsedOption | null {
  const snapshot = row.inputStateSnapshot as Record<string, unknown> | null;
  const policy = row.policyEvaluation as Record<string, unknown> | null;
  const option = policy?.option as RecommendationOption | undefined;
  if (!option || typeof option.key !== 'string' || !Array.isArray(option.actions)) return null;
  const setNumber = typeof snapshot?.setNumber === 'number' ? snapshot.setNumber : null;
  if (setNumber === null) return null;

  return {
    option,
    setNumber,
    findingId: typeof snapshot?.findingId === 'string' ? snapshot.findingId : '',
    findingStateAtIssue:
      typeof snapshot?.findingStateAtIssue === 'string' ? snapshot.findingStateAtIssue : '',
    evidenceStrengthAtIssue: (snapshot?.evidenceStrengthAtIssue ??
      'INSUFFICIENT') as EvidenceStrength,
    author: (snapshot?.author ?? 'MACHINE') as RecommendationAuthor,
    derivedFromDecisionId:
      typeof snapshot?.derivedFromDecisionId === 'string' ? snapshot.derivedFromDecisionId : null,
    revisedByUserId: typeof snapshot?.revisedByUserId === 'string' ? snapshot.revisedByUserId : null,
  };
}

function toOptionView(
  row: CognitiveDecision,
  parsed: ParsedOption,
  dismissed: boolean,
  revision: RecommendationRevisionView | null,
): RecommendationOptionView {
  return {
    ...parsed.option,
    decisionId: row.id,
    author: parsed.author,
    // THE EXISTING APPROVAL COLUMNS, READ AS SELECTION. One set of columns, one
    // answer to "did a person sign off on this".
    selectedByUserId: row.approvedBy,
    selectedAt: row.approvedAt?.toISOString() ?? null,
    dismissed,
    revision,
  };
}

function highestSet(rows: readonly CognitiveDecision[]): number {
  let highest = 0;
  for (const row of rows) {
    const parsed = parseOption(row);
    if (parsed && parsed.setNumber > highest) highest = parsed.setNumber;
  }
  return highest;
}

/**
 * Why each option sits above the next.
 *
 * ADJACENT PAIRS ONLY, deliberately. "Why is this first" is answered by
 * comparing it to the one below it; comparing every pair would produce n² answers
 * a person cannot read, and the ordering is transitive by declaration anyway.
 */
function adjacentComparisons(options: readonly RecommendationOptionView[]): OptionComparison[] {
  const out: OptionComparison[] = [];
  for (let i = 0; i + 1 < options.length; i += 1) {
    const left = options[i];
    const right = options[i + 1];
    if (left && right) out.push(compareOptions(left, right));
  }
  return out;
}

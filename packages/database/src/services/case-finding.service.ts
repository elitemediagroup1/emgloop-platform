// Findings on an investigation — recording what Loop concludes, and refusing to
// let it call that conclusion established on its own.
//
// WHAT THIS IS. The one place a Finding is written, read and superseded. It
// writes exactly two kinds of row: a hypothesis, through the repository that
// already owns the "created PROPOSED, accepted only by an attributed human"
// invariant; and the Case's link to it, through the Decision Engine, which
// appends an observation so the attachment is on the investigation's own log.
// There is no third table, no Finding model and no migration.
//
// ESTABLISHMENT IS DERIVED, NEVER STORED, AND NO PERSON CAN SET IT. `get`
// recomputes the gate on every read from the live Stage 3 verdict and the Case's
// evidence, and reports a person's acceptance or rejection on a separate axis
// that the gate never reads. Human authority may authorize action under
// uncertainty; it cannot authorize certainty. That is the whole
// design: a Finding whose day stops reconciling, whose authority becomes
// contested or whose evidence gains a contradiction STOPS being established by
// itself, with no job to run and no row anyone has to remember to correct. A
// stored `established` flag would have to be un-set by something, and in this
// repository nothing ever is.
//
// THERE IS NO SECOND READINESS ENGINE. The verdict comes from
// `HeadlineDetectionService.readinessFor`, which shares its one call to
// `assessReadiness` with the detection path. If Stage 3 would refuse to measure
// the window, Stage 4 cannot establish a claim over it -- and that is a property
// of there being one function, not of two layers agreeing.
//
// NO MODEL, AND NO PLACE FOR ONE TO HIDE. Nothing here generates a claim. A
// caller supplies the sentence and says what kind of claim it is; this service
// decides only what the organization is allowed to treat as settled. The
// authority boundary is deliberately built before the generative layer, so
// whatever eventually writes claims arrives into a gate that already exists.
//
// A FINDING IS NEVER EDITED. There is no update path on this service and no
// update path on the repository beneath it. A claim changes by a NEW claim
// superseding it, and the old one keeps its words, its window and its generator
// forever.

import type { PrismaClient } from '@prisma/client';
import type { DecisionEvidence, IntelligenceHypothesis } from '@prisma/client';
import {
  FINDING_CONTRADICTION_NONE,
  INVESTIGATION_PRODUCER,
  FINDING_INELIGIBILITY_LABELS,
  FINDING_INFERENCE_UNAVAILABLE,
  FINDING_RECORDED_REASON,
  FINDING_SUPERSEDED_REASON,
  assessFindingEstablishment,
  findEvidenceContradictions,
  findingClaimKind,
  findingEvidenceState,
  findingHypothesisType,
  isMeasuredEvidence,
  findingJudgment,
  findingLifecycle,
  type CaseFindingView,
  type FindingClaimKind,
  type FindingEstablishment,
  type FindingEvidenceRef,
  type FindingGeneratedBy,
  type FindingLineageEntry,
  type FindingReasoning,
  type FindingRecordFacts,
  type FindingStatement,
  type HeadlineView,
  type MeasurementReadiness,
} from '@emgloop/shared';

import { HeadlineRepository } from '../repositories/headline.repository';
import { IntelligenceHypothesisRepository } from '../repositories/cognitive/hypothesis.repository';
import { MarketplaceCallRepository } from '../repositories/marketplace-call.repository';
import { MeasurementSourceRepository } from '../repositories/measurement-source.repository';
import { ObjectiveMeasureBindingRepository } from '../repositories/objective-measure-binding.repository';
import { PerformanceObjectiveRepository } from '../repositories/performance-objective.repository';
import { ProviderObservationRepository } from '../repositories/provider-observation.repository';
import { ProviderReconciliationRepository } from '../repositories/provider-reconciliation.repository';
import { HeadlineDetectionService } from './headline-detection.service';
import { DecisionEngine } from './decision/decision-engine';
import type { DecisionActor } from './decision/decision-engine.contracts';

/** How a request to record a Finding ended. Only two of them write. */
export const FINDING_RECORD_OUTCOMES = [
  /** A new Finding was recorded on a Case that carried none. */
  'RECORDED',
  /** A new Finding replaced the Case's previous one, which is kept in full. */
  'SUPERSEDED_PREVIOUS',
  /**
   * No such Case in this organization.
   *
   * NOT-FOUND, NEVER FORBIDDEN. A Case belonging to another tenant answers
   * exactly as a Case that does not exist.
   */
  'CASE_NOT_FOUND',
  /**
   * The Case already carries a Finding and the caller did not say it was
   * replacing it. Nothing was written.
   */
  'FINDING_ALREADY_RECORDED',
] as const;
export type FindingRecordOutcome = (typeof FINDING_RECORD_OUTCOMES)[number];

export interface RecordFindingResult {
  outcome: FindingRecordOutcome;
  caseId: string;
  /** The Finding now on the Case, when there is one. */
  findingId: string | null;
  /** The Finding this one replaced, when it replaced one. */
  supersededFindingId: string | null;
}

/** What a caller supplies. Note what is absent: no confidence, no establishment. */
export interface RecordFindingInput {
  /** THE CLAIM, in one line. */
  claim: string;
  /** The analytical conclusion, when the caller wrote one. */
  conclusion?: string | null;
  claimKind: FindingClaimKind;
  /** How the claim came to exist. Recorded, and never used to relax the gate. */
  generatedBy: FindingGeneratedBy;
  ruleVersion?: string | null;
  supportingWindowStart?: Date | null;
  supportingWindowEnd?: Date | null;
  /** Who is recording it. A model is SYSTEM, like every other producer. */
  actor: DecisionActor;
  /**
   * Replace the Case's current Finding with this one.
   *
   * OPT-IN, BECAUSE A REPLACEMENT IS A DIFFERENT ACT FROM A FIRST CLAIM. A
   * caller that has not decided to supersede gets `FINDING_ALREADY_RECORDED`
   * and writes nothing, rather than silently displacing a claim somebody may
   * have already read.
   */
  supersedeExisting?: boolean;
}

// --- The seams ------------------------------------------------------------------

/** The Decision Center surface this service needs. One read, one linkage. */
export type CaseFindingCaseAccess = Pick<DecisionEngine, 'get' | 'linkHypothesis'>;

/** The Headline read used to find which objective a claim is measured against. */
export interface CaseFindingHeadlineReader {
  get(organizationId: string, id: string): Promise<HeadlineView | null>;
}

/**
 * The Stage 3 verdict, live.
 *
 * A SEAM WITH ONE PRODUCTION IMPLEMENTATION, and it is the detection service --
 * not a copy of it. Injectable so a test can pin a verdict without standing up
 * six repositories, never so a caller can supply a friendlier one: the default
 * is wired below and no other implementation exists in this package.
 */
export interface CaseFindingReadinessReader {
  readinessFor(
    organizationId: string,
    performanceObjectiveId: string,
    now: Date,
  ): Promise<{ readiness: MeasurementReadiness } | null>;
}

export interface CaseFindingDeps {
  cases?: CaseFindingCaseAccess;
  headlines?: CaseFindingHeadlineReader;
  hypotheses?: IntelligenceHypothesisRepository;
  /**
   * Defaults to the detection service, which is the only implementation.
   *
   * PASSING NULL EXPLICITLY MEANS NO VERDICT CAN BE OBTAINED, and that fails
   * closed: every measurement-backed claim reports READINESS_NOT_PROVEN and
   * stays DEVELOPING. It is never read as "fine".
   */
  readiness?: CaseFindingReadinessReader | null;
}

/** Bounded so a supersession cycle written by a future bug cannot hang a page. */
const MAX_CHAIN = 50;

export class CaseFindingService {
  private readonly cases: CaseFindingCaseAccess;
  private readonly headlines: CaseFindingHeadlineReader;
  private readonly hypotheses: IntelligenceHypothesisRepository;
  private readonly readiness: CaseFindingReadinessReader | null;

  constructor(prisma: PrismaClient, deps: CaseFindingDeps = {}) {
    this.cases = deps.cases ?? new DecisionEngine(prisma);
    this.headlines = deps.headlines ?? new HeadlineRepository(prisma);
    this.hypotheses = deps.hypotheses ?? new IntelligenceHypothesisRepository(prisma);
    // WIRED TO THE DETECTION SERVICE, NOT TO A COPY OF ITS RULES. `readinessFor`
    // shares its one `assessReadiness` call with `detect`, so a claim can never
    // be established over a window Stage 3 would have refused to measure.
    this.readiness =
      deps.readiness === undefined
        ? new HeadlineDetectionService(
            new PerformanceObjectiveRepository(prisma),
            new ObjectiveMeasureBindingRepository(prisma),
            new MarketplaceCallRepository(prisma),
            new HeadlineRepository(prisma),
            new ProviderObservationRepository(prisma),
            new ProviderReconciliationRepository(prisma),
            new MeasurementSourceRepository(prisma),
          )
        : deps.readiness;
  }

  // =========================================================================
  // Writing
  // =========================================================================

  /**
   * Record a Finding on an investigation.
   *
   * THREE WRITES, IN THE ORDER THAT SURVIVES BEING INTERRUPTED:
   *
   *   1. the new claim, always PROPOSED, through the repository that owns that
   *      invariant. Interrupted here, it is an orphan row nothing points at.
   *   2. the supersession of the previous claim, if there is one. Interrupted
   *      here, the Case still points at a claim that now names its successor --
   *      which `get` follows forward, so the read is already correct, and the
   *      next write completes the link.
   *   3. the link on the Case, through the engine, which appends the observation.
   *
   * The reverse order would leave a Case pointing at a new claim while the old
   * one was still live: two current beliefs, and no way to tell which.
   */
  async record(
    organizationId: string,
    caseId: string,
    input: RecordFindingInput,
  ): Promise<RecordFindingResult> {
    if (!caseId?.trim()) {
      return { outcome: 'CASE_NOT_FOUND', caseId, findingId: null, supersededFindingId: null };
    }
    if (!input.claim?.trim()) {
      throw new Error('A finding must state its claim');
    }
    const id = caseId.trim();
    const view = await this.cases.get(organizationId, id);
    if (!view) {
      return { outcome: 'CASE_NOT_FOUND', caseId: id, findingId: null, supersededFindingId: null };
    }

    // Heal an interrupted supersession before deciding anything, so "what is the
    // current Finding" is answered from the chain rather than from a stale column.
    const existing = await this.settleLink(organizationId, id, view.decision.hypothesisId, input.actor);

    if (existing && !input.supersedeExisting) {
      return {
        outcome: 'FINDING_ALREADY_RECORDED',
        caseId: id,
        findingId: existing.id,
        supersededFindingId: null,
      };
    }

    const created = await this.hypotheses.propose(organizationId, {
      hypothesisType: findingHypothesisType(input.claimKind),
      title: input.claim.trim(),
      summary: input.conclusion ?? null,
      // NO CONFIDENCE. The column exists and nothing reads it, so a number
      // written here would be authority the architecture never granted.
      confidence: null,
      supportingWindowStart: input.supportingWindowStart ?? null,
      supportingWindowEnd: input.supportingWindowEnd ?? null,
      scope: 'OPERATIONAL',
      sensitivity: 'INTERNAL',
      generatedBy: input.generatedBy,
      ruleVersion: input.ruleVersion ?? null,
    });

    if (existing) {
      await this.hypotheses.supersede(organizationId, existing.id, created.id);
    }

    await this.cases.linkHypothesis(organizationId, id, {
      hypothesisId: created.id,
      supersedes: existing?.id ?? null,
      actor: input.actor,
      observationType: existing ? 'FINDING_SUPERSEDED' : 'FINDING_RECORDED',
      reason: existing ? FINDING_SUPERSEDED_REASON : FINDING_RECORDED_REASON,
    });

    return {
      outcome: existing ? 'SUPERSEDED_PREVIOUS' : 'RECORDED',
      caseId: id,
      findingId: created.id,
      supersededFindingId: existing?.id ?? null,
    };
  }

  /**
   * A person accepts the claim. A JUDGMENT, AND NOTHING MORE.
   *
   * It is recorded, attributed and shown, and it does not establish anything:
   * whether Loop can establish the claim is decided by the evidence alone, on
   * every read, and the gate never reads this. The repository refuses an
   * unattributed actor.
   *
   * SCOPED TO THE CASE'S CURRENT FINDING. The claim must be the one this Case
   * currently carries, in this organization, and still current -- not a
   * superseded ancestor and not another Case's claim that happens to share the
   * tenant. Anything else answers null, exactly as a claim that does not exist
   * would, and nothing is written.
   */
  async accept(
    organizationId: string,
    caseId: string,
    findingId: string,
    acceptedByUserId: string,
  ): Promise<IntelligenceHypothesis | null> {
    const target = await this.judgeable(organizationId, caseId, findingId);
    if (!target) return null;
    return this.hypotheses.accept(organizationId, target.id, acceptedByUserId);
  }

  /**
   * A person rejects the claim. A JUDGMENT, AND NOTHING MORE.
   *
   * The claim stays the current one on the Case and Loop keeps evaluating its
   * evidence: a person disagreeing does not weaken the evidence, so a rejected
   * claim can still read as established. Scoped exactly as `accept` is.
   */
  async reject(
    organizationId: string,
    caseId: string,
    findingId: string,
    rejectedByUserId: string,
  ): Promise<IntelligenceHypothesis | null> {
    const target = await this.judgeable(organizationId, caseId, findingId);
    if (!target) return null;
    return this.hypotheses.reject(organizationId, target.id, rejectedByUserId);
  }

  // =========================================================================
  // Reading
  // =========================================================================

  /**
   * The Finding currently on an investigation, assembled. READ ONLY.
   *
   * NOT-FOUND, NEVER FORBIDDEN, on both sides: a Case in another organization
   * and a Case that does not exist answer identically, and so does a Case whose
   * linked hypothesis was written by some other producer -- that is not a
   * Finding, and rendering it as one would give a producer's private belief
   * Stage 4 authority nobody granted it.
   *
   * @param now injected so the caller owns the clock. The Stage 3 verdict is
   *            derived from it, and a test can pin the window.
   */
  async get(
    organizationId: string,
    caseId: string,
    now: Date = new Date(),
  ): Promise<CaseFindingView | null> {
    if (!caseId?.trim()) return null;
    const id = caseId.trim();
    const view = await this.cases.get(organizationId, id);
    if (!view?.decision.hypothesisId) return null;

    const finding = await this.headOfChain(organizationId, view.decision.hypothesisId);
    if (!finding) return null;
    const claimKind = findingClaimKind(finding.hypothesisType);
    if (!claimKind) return null;

    // MEASURED EVIDENCE ONLY, AND THE FILTER IS THE WHOLE ISOLATION.
    //
    // A human report is not an input to a measurement gate. If reports reached
    // `supporting`, two different things would go wrong at once: a report could
    // never SATISFY readiness (nothing here derives readiness from Case evidence),
    // but its missing completeness WOULD be read as "the producer did not say how
    // much of the population reported" -- so somebody adding a note to a Case
    // would silently demote an established claim. Stage 3 truth is unchanged by
    // anything a person writes down.
    const supporting = view.evidence.filter(isMeasuredEvidence).map(toEvidenceRef);
    const contradicting = findEvidenceContradictions(supporting);
    const facts = recordFacts(finding);
    // LIFECYCLE, NOT JUDGMENT, DECIDES WHETHER THE EVIDENCE IS EVALUATED. A
    // superseded or expired claim is history; a rejected one is still the claim
    // on the Case, and its evidence is read exactly as an unjudged one's is.
    const lifecycle = findingLifecycle(facts);
    const current = lifecycle === 'CURRENT';

    const readiness =
      claimKind === 'MEASUREMENT_BACKED' && current
        ? await this.readinessForCase(organizationId, view.decision, now)
        : null;

    const establishment = assessFindingEstablishment({
      claimKind,
      current,
      readiness,
      supporting,
      contradicting,
    });

    const lineage = await this.hypotheses.lineageOf(organizationId, finding.id);

    return {
      findingId: finding.id,
      caseId: view.decision.id,
      claim: finding.title,
      conclusion: finding.summary,
      claimKind,
      generatedBy: finding.generatedBy as FindingGeneratedBy,
      // THREE AXES, EACH FROM ITS OWN SOURCE. Evidence state from the gate and
      // nothing else; judgment from the attributed columns; lifecycle from
      // supersession and expiry. None is computed from another.
      evidenceState: findingEvidenceState(establishment),
      judgment: findingJudgment(facts),
      lifecycle,
      establishment,
      reasoning: deriveReasoning(view.evidence, supporting, contradicting, establishment, current),
      supporting,
      createdAt: finding.createdAt.toISOString(),
      supportingWindowStart: finding.supportingWindowStart?.toISOString() ?? null,
      supportingWindowEnd: finding.supportingWindowEnd?.toISOString() ?? null,
      ruleVersion: finding.ruleVersion,
      lineage: lineage.map(toLineageEntry),
    };
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * The Stage 3 verdict for the measure this Case was opened over.
   *
   * ONLY A HEADLINE-ORIGIN CASE HAS ONE, and that is correct rather than a gap:
   * a Case opened by some other producer was never measured against a
   * `PerformanceObjective`, so there is no objective whose readiness could be
   * assessed. It reports no verdict, and no verdict is a refusal.
   *
   * THE HEADLINE IS RE-READ THROUGH ITS OWN ORGANIZATION-SCOPED READ, exactly as
   * the Case Brief does it. The Case names an id; only the Headline repository
   * decides whether this organization may have it.
   */
  private async readinessForCase(
    organizationId: string,
    decision: { sourceSystem: string; sourceReference: string | null },
    now: Date,
  ): Promise<MeasurementReadiness | null> {
    if (!this.readiness) return null;
    if (decision.sourceSystem !== INVESTIGATION_PRODUCER || !decision.sourceReference) return null;
    const headline = await this.headlines.get(organizationId, decision.sourceReference);
    if (!headline) return null;
    const assessed = await this.readiness.readinessFor(
      organizationId,
      headline.performanceObjectiveId,
      now,
    );
    return assessed?.readiness ?? null;
  }

  /**
   * Follow a supersession chain forward to the claim that stands today.
   *
   * READS ARE CORRECT EVEN MID-REPAIR. A supersession interrupted between
   * marking the old claim and relinking the Case leaves the column pointing
   * backwards; walking forward means a surface still shows the current claim,
   * and the stale column is repaired by the next write rather than by a job.
   */
  private async headOfChain(
    organizationId: string,
    id: string,
  ): Promise<IntelligenceHypothesis | null> {
    let current = await this.hypotheses.findById(organizationId, id);
    const seen = new Set<string>();
    for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
      if (!current?.supersededById || seen.has(current.id)) break;
      seen.add(current.id);
      const next = await this.hypotheses.findById(organizationId, current.supersededById);
      if (!next) break;
      current = next;
    }
    return current;
  }

  /**
   * The Finding a person may judge on this Case, or null. A READ, and no repair.
   *
   * THREE SCOPES, ALL REQUIRED. The Case must exist in this organization; the
   * claim must be the head of that Case's own chain -- so another Case's claim,
   * or a superseded ancestor of this one, is refused; and it must still be
   * CURRENT and a governed Finding. Every refusal is the same null, so this can
   * never be used to learn that a claim exists somewhere it may not be touched.
   */
  private async judgeable(
    organizationId: string,
    caseId: string,
    findingId: string,
  ): Promise<IntelligenceHypothesis | null> {
    if (!caseId?.trim() || !findingId?.trim()) return null;
    const view = await this.cases.get(organizationId, caseId.trim());
    if (!view?.decision.hypothesisId) return null;
    const head = await this.headOfChain(organizationId, view.decision.hypothesisId);
    if (!head || head.id !== findingId.trim()) return null;
    if (!findingClaimKind(head.hypothesisType)) return null;
    if (findingLifecycle(recordFacts(head)) !== 'CURRENT') return null;
    return head;
  }

  /**
   * Resolve the Case's current Finding, completing an interrupted link on the way.
   *
   * THE ONE WRITE ON A READ-SHAPED PATH, and it is a repair: it only ever moves
   * the column forward onto a successor the chain already names, and it is a
   * no-op when the column is already right.
   */
  private async settleLink(
    organizationId: string,
    caseId: string,
    linkedId: string | null,
    actor: DecisionActor,
  ): Promise<IntelligenceHypothesis | null> {
    if (!linkedId) return null;
    const head = await this.headOfChain(organizationId, linkedId);
    if (!head) return null;
    if (head.id !== linkedId) {
      await this.cases.linkHypothesis(organizationId, caseId, {
        hypothesisId: head.id,
        supersedes: linkedId,
        actor,
        observationType: 'FINDING_SUPERSEDED',
        reason: FINDING_SUPERSEDED_REASON,
      });
    }
    // A hypothesis some other producer wrote is not a Finding, and must not be
    // superseded by one: it belongs to a different story on the same thread.
    return findingClaimKind(head.hypothesisType) ? head : null;
  }
}

// --- Projections ------------------------------------------------------------------

function toEvidenceRef(e: DecisionEvidence): FindingEvidenceRef {
  return {
    id: e.id,
    source: e.source,
    metricKey: e.metricKey,
    window: e.window,
    value: e.derivedValue,
    // NULL IS NOT ONE. Carried through unchanged; the gate gives silence and
    // partial coverage different refusals.
    completeness: e.completeness,
  };
}

/**
 * The stored row, in the plain values the shared axis derivations read.
 *
 * ONE TRANSLATION, so the judgment and lifecycle a surface sees come from the
 * same functions the fixtures exercise, and this file holds no second opinion
 * about what a status means.
 */
function recordFacts(h: IntelligenceHypothesis): FindingRecordFacts {
  return {
    status: h.status,
    supersededById: h.supersededById,
    acceptedBy: h.acceptedBy,
    acceptedAt: h.acceptedAt?.toISOString() ?? null,
    rejectedBy: h.rejectedBy,
    rejectedAt: h.rejectedAt?.toISOString() ?? null,
  };
}

function toLineageEntry(h: IntelligenceHypothesis): FindingLineageEntry {
  const facts = recordFacts(h);
  return {
    findingId: h.id,
    claim: h.title,
    conclusion: h.summary,
    lifecycle: findingLifecycle(facts),
    judgment: findingJudgment(facts),
    generatedBy: h.generatedBy as FindingGeneratedBy,
    createdAt: h.createdAt.toISOString(),
    supersededById: h.supersededById,
  };
}

/**
 * What the Finding knows, what it inferred, what is missing, what disagrees.
 *
 * KNOWN comes from the evidence and cites the row it came from. INFERRED IS
 * EMPTY AND SAYS SO: nothing recorded today writes out the steps between a
 * measurement and a conclusion, and filling this with the claim restated would
 * teach a reader that Loop showed its working when it did not.
 *
 * MISSING is two different absences, deliberately joined: what the evidence
 * itself leaves open, and what currently stops the claim from being established.
 * Both answer "what would settle this", which is the question the heading asks.
 */
function deriveReasoning(
  evidence: readonly DecisionEvidence[],
  supporting: readonly FindingEvidenceRef[],
  contradicting: ReturnType<typeof findEvidenceContradictions>,
  establishment: FindingEstablishment,
  current: boolean,
): FindingReasoning {
  // ONLY WHAT THE GATE ACTUALLY READ. `supporting` is measured evidence, so every
  // statement here names a measure; a row that named none would be reported as
  // that rather than given a metric it does not have.
  const known: FindingStatement[] = supporting.map((e) => ({
    text: e.metricKey
      ? e.window
        ? `${e.metricKey} (${e.window})`
        : e.metricKey
      : 'evidence naming no measure',
    evidenceId: e.id,
  }));

  const missing: string[] = [];
  const push = (s: string) => {
    if (s && !missing.includes(s)) missing.push(s);
  };
  for (const e of evidence) for (const u of e.unknowns) push(u);
  if (current) for (const r of establishment.reasons) push(FINDING_INELIGIBILITY_LABELS[r]);

  const unavailable: FindingReasoning['unavailable'] = { INFERRED: FINDING_INFERENCE_UNAVAILABLE };
  if (known.length === 0) {
    unavailable.KNOWN = 'Nothing has been recorded on this investigation that supports the claim.';
  }
  if (contradicting.length === 0) unavailable.CONTRADICTORY = FINDING_CONTRADICTION_NONE;
  if (missing.length === 0) {
    unavailable.MISSING = 'Nothing is currently standing between this finding and its evidence.';
  }

  return { known, inferred: [], missing, contradictory: contradicting, unavailable };
}

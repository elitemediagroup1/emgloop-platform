// CommercialSignalEvaluationService -- Commercial Intelligence Stage 2.
//
// The one place that turns data Loop already observes into objective-relative
// Commercial Signals. It reads two domains and writes one:
//
//   READ   performance_objectives  (Stage 1 -- what we are trying to accomplish)
//   READ   marketplace_calls       (CallGrid -- what actually happened)
//   WRITE  commercial_signals      (positive relevance determinations only)
//
// IT OWNS NO DATA IT READS. Calls belong to the Marketplace domain and are read
// through MarketplaceCallRepository, not by reaching into `prisma.marketplaceCall`
// from here. Objectives belong to Stage 1 and are read through their repository.
// Commercial Intelligence consumes other domains' truth; it never takes custody
// of it, and nothing in this file writes to either source.
//
// IT DOES NOTHING DOWNSTREAM. Establishing a signal creates no headline, no
// case, no subject, no evidence, no finding, no opportunity, no decision, no
// work item, no notification and no outbound message of any kind, and it
// publishes no event. A signal is intelligence. It is not authorization and it
// is not execution. If a future stage needs to react to one, that stage adds the
// consumer -- this service will not grow a side effect.
//
// THE EVALUATION IS PURE AND LIVES ELSEWHERE. `evaluateTermMatch` is a pure
// function in @emgloop/shared: no clock, no I/O, no randomness. This service
// supplies it with observations and objectives, and persists what comes back.
// That split is what makes a stored determination reproducible -- the same
// inputs give the same answer in a test, here, and in six months.
//
// TERM_MATCH IS SCAFFOLDING, NOT THE MODEL. See the long note in
// packages/shared/src/commercial-signal.ts. It is a deliberately dumb
// deterministic mechanism chosen to prove the architecture without inventing a
// relevance model nobody has approved. Replacing it means producing a different
// CommercialRelevance; it does not mean changing this service's shape, the
// table, or what a Signal means.

import {
  evaluateTermMatch,
  type CommercialObservation,
  type PerformanceObjectiveView,
} from '@emgloop/shared';

import type { PerformanceObjectiveRepository } from '../repositories/performance-objective.repository';
import type { MarketplaceCallRepository } from '../repositories/marketplace-call.repository';
import type { CommercialSignalRepository } from '../repositories/commercial-signal.repository';

/** What one evaluation run examined and what it concluded. */
export interface EvaluationRunSummary {
  /** Objectives in scope: ACTIVE only. Archived intent is history, not intent. */
  objectivesConsidered: number;
  /** Observations read from the source domain over the window. */
  observationsExamined: number;
  /** Determinations recorded for the first time. */
  established: number;
  /** Determinations Loop had already made and has now simply seen again. */
  reaffirmed: number;
  /** The window actually used, echoed back so a caller can state it honestly. */
  since: Date;
  until: Date;
}

export interface EvaluationRunOptions {
  since: Date;
  until: Date;
  /**
   * Ceiling on observations READ from the source per run. Bounded because an
   * unbounded evaluation over an unbounded window is a request-path timeout
   * waiting to happen, and because a truncated run must be visible rather than
   * silent: the caller compares `observationsExamined` against this limit.
   */
  maxObservations?: number;
}

const DEFAULT_MAX_OBSERVATIONS = 500;

/**
 * A CallGrid call, restated as an observation Commercial Intelligence can read.
 *
 * THIS IS THE ONLY CALLGRID-SHAPED CODE IN COMMERCIAL INTELLIGENCE, and it is
 * deliberately confined to one small function: the contract in @emgloop/shared
 * knows nothing about calls, buyers, campaigns or providers, so a second source
 * is a second mapper rather than a change to the primitive.
 *
 * The descriptors are the labels THE PROVIDER ALREADY SUPPLIED. Loop invents no
 * vocabulary here, derives nothing, and infers nothing about the call.
 */
function callAsObservation(call: {
  provider: string;
  externalId: string;
  sourceOccurredAt: Date;
  buyerLabel: string | null;
  vendorLabel: string | null;
  sourceLabel: string | null;
  campaignLabel: string | null;
  callerState: string | null;
  status: string | null;
}): CommercialObservation {
  const descriptors = [
    call.buyerLabel,
    call.vendorLabel,
    call.sourceLabel,
    call.campaignLabel,
    call.callerState,
  ].filter((d): d is string => Boolean(d && d.trim()));

  // A one-line restatement for explanation only. The authoritative record stays
  // in marketplace_calls, and `sourceReference` is how a reader gets back to it.
  const described = descriptors.length ? descriptors.join(' / ') : 'no labels supplied';
  const summary = `Call ${call.externalId} (${call.status ?? 'status unknown'}): ${described}`;

  return {
    // The sensor names itself. Never hardcoded to 'callgrid' here: the column
    // exists precisely so a second sensor does not need a code change.
    sourceSystem: call.provider.toUpperCase(),
    sourceKey: call.externalId,
    sourceReference: call.externalId,
    observedAt: call.sourceOccurredAt,
    summary,
    descriptors,
  };
}

export class CommercialSignalEvaluationService {
  constructor(
    private readonly objectives: PerformanceObjectiveRepository,
    private readonly calls: MarketplaceCallRepository,
    private readonly signals: CommercialSignalRepository,
  ) {}

  /**
   * Evaluate one organization's recent observable activity against its active
   * objectives.
   *
   * TENANT-SCOPED THROUGHOUT. `organizationId` comes from the caller's signed
   * session and is passed to every repository call; there is no path here that
   * reads or writes another tenant's row, and no cross-tenant evaluation is
   * possible because both sides of every comparison are loaded org-scoped.
   *
   * USER SCOPE DOES NOT LEAVE THE TENANT. A USER-scoped objective is evaluated
   * exactly like an ORGANIZATION-scoped one and its signals belong to the
   * organization. Nothing here reads `scopeUserId` to decide what to evaluate,
   * because that field says whose objective it IS -- not whose data may be
   * looked at, and certainly not who reports to whom. `MANAGER` is not consulted
   * anywhere in this service.
   *
   * OBJECTIVE-RELATIVE BY CONSTRUCTION. Every observation is evaluated
   * separately against every active objective. The same call can produce a
   * signal for one objective and nothing at all for another, which is the whole
   * point: commercial significance is not a property a fact carries on its own.
   */
  async evaluateRecentActivity(
    organizationId: string,
    opts: EvaluationRunOptions,
  ): Promise<EvaluationRunSummary> {
    const maxObservations = Math.min(2000, Math.max(1, opts.maxObservations ?? DEFAULT_MAX_OBSERVATIONS));

    // ACTIVE only. An archived objective is a record of what the organization
    // used to be pursuing, and evaluating against it would manufacture present
    // relevance to past intent.
    const objectives = await this.objectives.list(organizationId, { status: 'ACTIVE' });

    const rows = await this.calls.listWindowSummaries(
      organizationId,
      opts.since,
      opts.until,
      maxObservations,
    );
    const observations = rows.map(callAsObservation);

    let established = 0;
    let reaffirmed = 0;

    for (const observation of observations) {
      for (const objective of objectives) {
        const relevance = evaluateTermMatch(objective, observation);
        // No relevance, no record. Stage 2 stores no negative evaluations, and
        // the absence of a row must never later be read as "Loop looked at this
        // and decided it did not matter".
        if (!relevance) continue;

        const result = await this.signals.establish(organizationId, {
          performanceObjectiveId: objective.id,
          observation,
          relevance,
        });
        // null means the objective did not resolve inside this organization.
        // It was loaded org-scoped a moment ago, so this is only reachable if it
        // was archived away or deleted mid-run; the correct response is to skip
        // it, not to write a signal against a referent that is no longer there.
        if (!result) continue;

        if (result.outcome === 'ESTABLISHED') established += 1;
        else reaffirmed += 1;
      }
    }

    return {
      objectivesConsidered: objectives.length,
      observationsExamined: observations.length,
      established,
      reaffirmed,
      since: opts.since,
      until: opts.until,
    };
  }
}

/** Exported so a caller can tell whether a run was truncated, and say so. */
export const COMMERCIAL_SIGNAL_MAX_OBSERVATIONS = DEFAULT_MAX_OBSERVATIONS;

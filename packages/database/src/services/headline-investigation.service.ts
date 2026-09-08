// Headline → human Investigate decision → Case.
//
// WHAT THIS IS. The one governed transition from an attention surface to an
// authorized organizational investigation. It reads a Headline, opens a thread in
// the Decision Center, and records the person who decided it was worth opening.
//
// WHAT IT IS NOT, AND THE LIST MATTERS. It establishes no Finding, generates no
// Recommendation, creates no Work, assigns nobody, sets no deadline and calls no
// model. A Case that arrived carrying conclusions would have decided the thing a
// person just authorized somebody to go and find out.
//
// WHY IT LIVES HERE RATHER THAN IN THE DECISION ENGINE. The Decision Center is
// producer-neutral on purpose -- CallGrid, accounting and website intelligence all
// open threads in it, and its own folder split was made "by COUPLING, not by
// convenience". A Headline is a Commercial Intelligence concept. Teaching the
// engine what a Headline is would run the coupling the wrong way and make the
// next producer import from a CI file. So this service knows about both and the
// engine keeps knowing about neither.
//
// NO NEW CASE MODEL. `OperationalPriority` already is a durable investigation
// with an append-only observation log, immutable evidence carrying its own
// limitations and unknowns, separate accountability and execution owners, a
// lifecycle, an outcome and a generic destination reference for work.
// `headline.repository.ts` says so in its own header: "the thing being modelled
// is a Decision and DecisionEngine + operational_priorities already exist for it."
// This service is that sentence, implemented.
//
// THE HEADLINE IS NOT MUTATED. Promotion writes nothing to the Headline -- no
// state, no owner, no lifecycle, no dismissal. A Headline records that something
// changed and by how much; whether anyone chose to look into it is a different
// fact living in a different place, which is exactly why the Headline repository
// refuses to grow an assign method.

import type { PrismaClient } from '@prisma/client';
import {
  INVESTIGATION_AUTHORIZED_REASON,
  INVESTIGATION_PRODUCER,
  INVESTIGATION_PRODUCER_VERSION,
  investigationDetectionKey,
  investigationRecurrenceKey,
  isInvestigationAuthorization,
  severityForHeadline,
  type HeadlineView,
  type PromotionOutcome,
} from '@emgloop/shared';

import { HeadlineRepository } from '../repositories/headline.repository';
import { OperationalPriorityRepository } from '../repositories/operational-priority.repository';
import { DecisionEngine } from './decision/decision-engine';

/** The Headline read this service needs. Narrow on purpose: it cannot write one. */
export interface HeadlineReader {
  get(organizationId: string, id: string): Promise<HeadlineView | null>;
}

/** The Decision Center operations this service may perform. Nothing else. */
export type InvestigationOpener = Pick<DecisionEngine, 'create' | 'addObservation' | 'get'>;

/**
 * The reverse lineage lookup: given a Headline's investigation identity, the
 * thread. Separate from the engine because it is a READ of an existing
 * repository method, and widening the engine's surface for a read it already
 * exposes elsewhere would be the wrong place to add one.
 */
export interface InvestigationFinder {
  findByRecurrenceKey(
    organizationId: string,
    sourceSystem: string,
    recurrenceKey: string,
  ): Promise<{ id: string } | null>;
}

export interface HeadlineInvestigationDeps {
  headlines?: HeadlineReader;
  decisions?: InvestigationOpener;
  finder?: InvestigationFinder;
}

export interface PromoteHeadlineInput {
  headlineId: string;
  /**
   * The person authorizing the investigation. REQUIRED, and the reason it is
   * required is the whole product contract: nothing else in this file can create
   * a Case, and this field is the only way in.
   */
  actorUserId: string;
  /** The authorizer's own words, when they leave any. Never Loop's. */
  note?: string | null;
  /** Injected so a caller owns the clock and a test can pin it. */
  now?: Date;
}

export interface PromotionResult {
  outcome: PromotionOutcome;
  /** The investigation, when one exists to navigate to. */
  caseId: string | null;
  headlineId: string;
  /** True only when THIS call opened it. */
  opened: boolean;
  /**
   * Whether the log carries an attributed human authorization for this
   * investigation. Surfaced rather than assumed: opening the thread and recording
   * who authorized it are two statements, and a caller is entitled to know if the
   * second one is missing.
   */
  humanAuthorizationRecorded: boolean;
  /**
   * Whether THIS call is the one that appended it.
   *
   * DIFFERENT FROM `humanAuthorizationRecorded`, which answers "is one present".
   * This answers "did something just happen", and a caller with a supplementary
   * trail to write needs the second question: a repeated press appends nothing
   * and must record nothing, while a press that completes an interrupted
   * promotion appends the authorization and must record that it did. Keying a
   * trail on `opened` instead misses exactly that case.
   */
  authorizationAppendedNow: boolean;
  /** One sentence for an operator. Never a credential, never a payload. */
  reason: string;
}

export class HeadlineInvestigationService {
  private readonly headlines: HeadlineReader;
  private readonly decisions: InvestigationOpener;
  private readonly finder: InvestigationFinder;

  constructor(prisma: PrismaClient, deps: HeadlineInvestigationDeps = {}) {
    this.headlines = deps.headlines ?? new HeadlineRepository(prisma);
    this.decisions = deps.decisions ?? new DecisionEngine(prisma);
    this.finder = deps.finder ?? new OperationalPriorityRepository(prisma);
  }

  /**
   * Authorize an investigation into a Headline.
   *
   * IDEMPOTENT BY IDENTITY, NOT BY A GUARD HERE. The Decision Center keys a
   * thread on `(organization, producer, recurrenceKey)` and the key is derived
   * from the Headline id, so a second press -- or two simultaneous presses --
   * resolves to the row that already exists rather than opening a second
   * investigation into the same thing. This method therefore never has to ask
   * "does one exist" before writing, which is the read-then-write race that
   * question always is.
   *
   * TWO STATEMENTS, IN ORDER. The Decision Center's own opening row is a SYSTEM
   * detection: it records what the Headline measured, and a machine measured it.
   * The human's act is a second, attributed observation immediately after. Both
   * are in the log and neither pretends to be the other. If a process dies between
   * them the thread exists with the machine's half only -- `humanAuthorizationRecorded`
   * reports that honestly rather than the caller assuming it, and a later promotion
   * of the same Headline appends the missing authorization.
   */
  async promote(organizationId: string, input: PromoteHeadlineInput): Promise<PromotionResult> {
    const headlineId = input.headlineId?.trim() ?? '';
    const actorUserId = input.actorUserId?.trim() ?? '';
    const base = {
      caseId: null,
      headlineId,
      opened: false,
      humanAuthorizationRecorded: false,
      authorizationAppendedNow: false,
    };

    if (!actorUserId) {
      // Refused BEFORE the Headline is read. An unattributed promotion must not
      // even get to discover whether the Headline exists.
      return {
        ...base,
        outcome: 'NO_AUTHORIZING_HUMAN',
        reason: 'A promotion must name the person authorizing it. Nothing was read or written.',
      };
    }
    if (!headlineId) {
      return {
        ...base,
        outcome: 'HEADLINE_NOT_FOUND',
        reason: 'No headline was named.',
      };
    }

    // RESOLVED WITHIN THE ORGANIZATION, failing closed to null. A Headline
    // belonging to another tenant is indistinguishable from one that does not
    // exist, which is what stops this answer being used to enumerate them.
    const headline = await this.headlines.get(organizationId, headlineId);
    if (!headline) {
      return {
        ...base,
        outcome: 'HEADLINE_NOT_FOUND',
        reason: `No headline "${headlineId}" in this organization.`,
      };
    }

    const now = input.now ?? new Date();
    const opened = await this.decisions.create(organizationId, {
      producer: INVESTIGATION_PRODUCER,
      recurrenceKey: investigationRecurrenceKey(headline.id),
      detectionKey: investigationDetectionKey(headline.id),
      // WHEN THE HEADLINE WAS FIRST DETECTED, not when somebody pressed the
      // button. The thread is about a development that happened in the world; the
      // authorization has its own timestamp on its own observation.
      detectedAt: new Date(headline.firstDetectedAt),
      title: headline.statement,
      summary: headline.objectiveTitle,
      severity: severityForHeadline(headline.measurement.againstObjective),
      // The opaque producer handle the Decision Center already documents as
      // "never parsed here". A Headline id fits that contract exactly, and it is
      // what makes the thread navigable back to what opened it WITHOUT a schema
      // change and without copying the Headline into the Case.
      sourceReference: headline.id,
      producerVersion: INVESTIGATION_PRODUCER_VERSION,
      // NO HYPOTHESIS. Passing one would open a belief, and a belief is a Finding
      // in everything but name. PR 1 establishes none.
      evidence: [headlineEvidence(headline)],
    });

    const caseId = opened.decision.id;
    const alreadyOpen = opened.effect !== 'CREATED';

    // THE HUMAN'S OWN ROW. Appended even when the thread already existed and
    // lacks one, so a promotion interrupted between the two writes converges
    // rather than leaving an investigation nobody is recorded as authorizing.
    const appendedNow = !alreadyOpen || !(await this.hasHumanAuthorization(organizationId, caseId));
    if (appendedNow) {
      await this.decisions.addObservation(organizationId, caseId, {
        // REVIEWED is the existing vocabulary member for a person having looked
        // and formed a view. A dedicated INVESTIGATION_AUTHORIZED member would be
        // a Prisma enum migration and is deliberately deferred; the reason line
        // below carries the meaning in the meantime.
        observationType: 'REVIEWED',
        occurredAt: now,
        actor: { type: 'HUMAN', userId: actorUserId, source: 'operator' },
        reason: INVESTIGATION_AUTHORIZED_REASON,
        note: input.note ?? null,
      });
    }

    return {
      outcome: alreadyOpen ? 'ALREADY_INVESTIGATING' : 'PROMOTED',
      caseId,
      headlineId: headline.id,
      opened: !alreadyOpen,
      // True either way by this point: it was already there, or it was just
      // appended. The authoritative record is complete in both cases.
      humanAuthorizationRecorded: true,
      authorizationAppendedNow: appendedNow,
      reason: alreadyOpen
        ? 'This headline is already under investigation. Nothing new was opened.'
        : 'An investigation was opened and the authorizing person was recorded.',
    };
  }

  /**
   * The investigation opened from a Headline, if there is one.
   *
   * The lineage read in the other direction, for a surface that has a Headline and
   * wants to know whether pressing Investigate will open something or navigate to
   * something. Derived from the same identity the promotion uses, so the two can
   * never disagree.
   */
  async findCaseForHeadline(
    organizationId: string,
    headlineId: string,
  ): Promise<{ caseId: string; humanAuthorizationRecorded: boolean } | null> {
    if (!headlineId?.trim()) return null;
    const found = await this.finder.findByRecurrenceKey(
      organizationId,
      INVESTIGATION_PRODUCER,
      investigationRecurrenceKey(headlineId.trim()),
    );
    if (!found) return null;
    return {
      caseId: found.id,
      humanAuthorizationRecorded: await this.hasHumanAuthorization(organizationId, found.id),
    };
  }

  /** Whether the log carries an attributed human observation for this thread. */
  private async hasHumanAuthorization(organizationId: string, caseId: string): Promise<boolean> {
    const view = await this.decisions.get(organizationId, caseId);
    if (!view) return false;
    // THE SHARED PREDICATE, not a local spelling of it. An operator can record a
    // plain REVIEWED on any thread; only the row carrying the authorization reason
    // is the authorization, and the Case Brief resolves it the same way.
    return view.observations.some((o) =>
      isInvestigationAuthorization({
        actorType: o.actorType,
        observationType: o.observationType,
        reason: o.reason,
      }),
    );
  }
}

/**
 * The Headline's measurement, as one immutable piece of Case evidence.
 *
 * ONE ROW, NOT A COPY OF THE HEADLINE. The Headline stays authoritative for what
 * it measured -- its values are written once and never revised -- and this is the
 * opening snapshot the Decision Center's evidence table exists to hold.
 *
 * THE CAVEATS TRAVEL WITH IT. `limitations` and `unknowns` are carried across
 * because the alternative is an investigation whose evidence set has a number and
 * no caveats, and "evidence that keeps its value and loses its caveats is how a
 * hedged claim becomes a confident one" is the reason those columns exist.
 *
 * `statement` IS NOT EVIDENCE and is not copied here. It is Loop's own words about
 * its own numbers, and Stage 2 already shipped a defect where CI-authored text
 * became the evidence for CI's own conclusion. It travels as the thread's title,
 * where a person reads it, and nowhere a rule can.
 */
function headlineEvidence(headline: HeadlineView): {
  source: string;
  metricKey: string;
  window: string;
  ruleId: string;
  ruleVersion: string;
  producerVersion: string;
  derivedValue: number | null;
  completeness: number | null;
  entityType: string;
  entityId: string;
  entityName: string | null;
  limitations: string[];
  unknowns: string[];
  observedAt: Date;
} {
  return {
    source: INVESTIGATION_PRODUCER,
    metricKey: headline.measurement.metric,
    window: headline.measurement.comparisonBasis,
    ruleId: headline.ruleId,
    ruleVersion: headline.ruleVersion,
    producerVersion: headline.producerVersion,
    derivedValue: headline.measurement.currentValue,
    completeness: headline.measurement.currentCoverage,
    // The entity this evidence is about is the HEADLINE, which is what makes the
    // evidence row navigable back to the thing that opened the thread.
    entityType: 'headline',
    entityId: headline.id,
    entityName: headline.objectiveTitle,
    limitations: headline.limitations,
    unknowns: headline.unknowns,
    observedAt: new Date(headline.lastDetectedAt),
  };
}

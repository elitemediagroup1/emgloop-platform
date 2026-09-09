// Multiple people on one investigation, without building a second task system.
//
// WHAT THIS IS. The one place a Case's participants are added, changed, released
// and read. It writes exactly two kinds of row: the participant, through the
// repository that owns that table; and an observation on the Case's own
// append-only log, through the Decision Engine, so every act of asking somebody
// for something is attributed and permanent.
//
// THE BOUNDARY THIS FILE EXISTS TO HOLD. Commercial Intelligence owns why
// somebody is involved. Work OS owns the executable obligation. So there is no
// due date here, no dependency, no SLA, no blocked state and no completion --
// not because they are uninteresting, but because a Case status beside a Work
// status is a second answer to "is it done", and the copy always goes stale. The
// Case REFERENCES work through the destination columns the Decision Center
// already writes on a CONVERTED_TO_WORK outcome; it copies none of its state.
//
// IT CREATES NO WORK, AND CANNOT. There is no Work OS repository in this file,
// no blueprint, no instance, no stage, no assignment and no notification. Asking
// Charlie to decide something creates a participant row and a log entry, and
// nothing anywhere else.
//
// OWNER AND ASSIGNEE ARE NEVER TOUCHED. They are the Decision Center's answers to
// accountability and execution and remain exactly what they were; participation
// answers a third question. Adding four participants leaves both columns as they
// were, which the suite asserts rather than assumes.
//
// ROUTING IS A SUGGESTION, NEVER AN ASSIGNMENT. The one deterministic
// responsibility fact this repository has is a USER-scoped PerformanceObjective.
// `suggest` proposes the person who owns the objective a Case was measured
// against, with the reason stated, and proposes the WEAKEST contribution that
// fits. A person adds them. Nothing here assigns anybody, because "relevant to
// your objective" and "responsible for handling this" are different claims and
// only a person can make the second.

import type { CaseParticipant, PrismaClient } from '@prisma/client';
import {
  CASE_WORK_OWNERSHIP,
  INVESTIGATION_PRODUCER,
  PARTICIPANT_ADDED_REASON,
  PARTICIPANT_CHANGED_REASON,
  PARTICIPANT_RELEASED_REASON,
  isCaseContribution,
  suggestParticipants,
  type CaseContribution,
  type CaseParticipantView,
  type CaseParticipationView,
  type CaseWorkReference,
  type HeadlineView,
  type ParticipantSuggestion,
} from '@emgloop/shared';

import { CaseParticipantRepository } from '../repositories/case-participant.repository';
import { HeadlineRepository } from '../repositories/headline.repository';
import { PerformanceObjectiveRepository } from '../repositories/performance-objective.repository';
import { DecisionEngine } from './decision/decision-engine';
import type { DecisionActor } from './decision/decision-engine.contracts';

/** How a request to change participation ended. Only two of them write. */
export const PARTICIPATION_OUTCOMES = [
  'ADDED',
  /** The person was already involved for this contribution; the ask was restated. */
  'CHANGED',
  'RELEASED',
  /** No such Case in this organization. Not-found, never forbidden. */
  'CASE_NOT_FOUND',
  /** No such person in this organization, or they were not involved. */
  'PARTICIPANT_NOT_FOUND',
] as const;
export type ParticipationOutcome = (typeof PARTICIPATION_OUTCOMES)[number];

export interface ParticipationResult {
  outcome: ParticipationOutcome;
  caseId: string;
  participantId: string | null;
}

export interface AddCaseParticipantInput {
  userId: string;
  contribution: CaseContribution;
  /** Why this person, in the asker's words. Required. */
  request: string;
  /** Who is asking. A person, always: Loop suggests, people invite. */
  actor: DecisionActor;
}

// --- Seams ---------------------------------------------------------------------

/** The Decision Center surface: one read, one log append. */
export type ParticipationCaseAccess = Pick<DecisionEngine, 'get' | 'addObservation'>;

/** The Headline read used to find which objective a Case was measured against. */
export interface ParticipationHeadlineReader {
  get(organizationId: string, id: string): Promise<HeadlineView | null>;
}

export interface CaseParticipationDeps {
  cases?: ParticipationCaseAccess;
  participants?: CaseParticipantRepository;
  headlines?: ParticipationHeadlineReader;
  objectives?: Pick<PerformanceObjectiveRepository, 'get'>;
}

export class CaseParticipationService {
  private readonly cases: ParticipationCaseAccess;
  private readonly participants: CaseParticipantRepository;
  private readonly headlines: ParticipationHeadlineReader;
  private readonly objectives: Pick<PerformanceObjectiveRepository, 'get'>;

  constructor(prisma: PrismaClient, deps: CaseParticipationDeps = {}) {
    this.cases = deps.cases ?? new DecisionEngine(prisma);
    this.participants = deps.participants ?? new CaseParticipantRepository(prisma);
    this.headlines = deps.headlines ?? new HeadlineRepository(prisma);
    this.objectives = deps.objectives ?? new PerformanceObjectiveRepository(prisma);
  }

  // =========================================================================
  // Writing
  // =========================================================================

  /**
   * Ask somebody to contribute to an investigation.
   *
   * TWO WRITES, IN THE ORDER THAT SURVIVES BEING INTERRUPTED: the participant
   * row first, then the log entry. Interrupted between them, the person is
   * involved and the log is silent -- visible and repairable by re-asking, which
   * is idempotent. The reverse order would claim on the permanent record that
   * somebody was asked when they were not.
   *
   * A PERSON ASKS. `actor` is passed through to the log unchanged, so a SYSTEM
   * actor is recorded as a system act rather than being refused -- but nothing in
   * this package calls it that way, and `suggest` deliberately returns proposals
   * rather than performing them.
   */
  async add(
    organizationId: string,
    caseId: string,
    input: AddCaseParticipantInput,
  ): Promise<ParticipationResult> {
    if (!caseId?.trim()) return { outcome: 'CASE_NOT_FOUND', caseId, participantId: null };
    if (!isCaseContribution(input.contribution)) {
      throw new Error(`Unknown contribution "${input.contribution}"`);
    }
    const id = caseId.trim();
    const view = await this.cases.get(organizationId, id);
    if (!view) return { outcome: 'CASE_NOT_FOUND', caseId: id, participantId: null };

    const before = await this.participants.list(organizationId, id);
    const existing = before.find(
      (p) => p.userId === input.userId && p.contribution === input.contribution && !p.releasedAt,
    );

    const row = await this.participants.add(organizationId, id, {
      userId: input.userId,
      contribution: input.contribution,
      request: input.request,
      addedByUserId: input.actor.userId ?? null,
    });
    // NOT-FOUND, NEVER FORBIDDEN, AND NO LOG ENTRY FOR A WRITE THAT DID NOT
    // HAPPEN. A person from another organization resolves to null in the
    // repository and nothing is recorded here.
    if (!row) return { outcome: 'PARTICIPANT_NOT_FOUND', caseId: id, participantId: null };

    await this.cases.addObservation(organizationId, id, {
      observationType: existing ? 'PARTICIPANT_CHANGED' : 'PARTICIPANT_ADDED',
      actor: input.actor,
      reason: existing ? PARTICIPANT_CHANGED_REASON : PARTICIPANT_ADDED_REASON,
      note: `${input.contribution}: ${input.userId}`,
      assignedToUserId: input.userId,
    });

    return {
      outcome: existing ? 'CHANGED' : 'ADDED',
      caseId: id,
      participantId: row.id,
    };
  }

  /**
   * Release somebody from an investigation.
   *
   * THE ROW SURVIVES, RELEASED. Who was asked, for what and why is history, and
   * a Case that has been through three people must not read as though it was
   * always handled by one.
   */
  async release(
    organizationId: string,
    caseId: string,
    userId: string,
    contribution: CaseContribution,
    actor: DecisionActor,
  ): Promise<ParticipationResult> {
    if (!caseId?.trim()) return { outcome: 'CASE_NOT_FOUND', caseId, participantId: null };
    const id = caseId.trim();
    const view = await this.cases.get(organizationId, id);
    if (!view) return { outcome: 'CASE_NOT_FOUND', caseId: id, participantId: null };

    const released = await this.participants.release(
      organizationId,
      id,
      userId,
      contribution,
      actor.userId ?? null,
    );
    if (!released) return { outcome: 'PARTICIPANT_NOT_FOUND', caseId: id, participantId: null };

    await this.cases.addObservation(organizationId, id, {
      observationType: 'PARTICIPANT_RELEASED',
      actor,
      reason: PARTICIPANT_RELEASED_REASON,
      note: `${contribution}: ${userId}`,
      assignedToUserId: userId,
    });
    return { outcome: 'RELEASED', caseId: id, participantId: released.id };
  }

  // =========================================================================
  // Reading
  // =========================================================================

  /**
   * Who is on this investigation, what each is for, and what work it produced.
   *
   * THE WORK IS A REFERENCE AND NOTHING MORE. It is read from the destination
   * columns the Decision Center already writes on a CONVERTED_TO_WORK outcome, so
   * this view carries the work's identity and never its title, status, assignee or
   * completion. A surface that wants those reads Work OS through the pointer.
   */
  async get(organizationId: string, caseId: string): Promise<CaseParticipationView | null> {
    if (!caseId?.trim()) return null;
    const id = caseId.trim();
    const view = await this.cases.get(organizationId, id);
    if (!view) return null;

    const rows = await this.participants.list(organizationId, id);
    const all = rows.map(toParticipantView);
    const participants = all.filter((p) => p.active);

    return {
      caseId: id,
      ownerUserId: view.ownerUserId,
      assigneeUserId: view.assigneeUserId,
      participants,
      released: all.filter((p) => !p.active).reverse(),
      awaiting: participants.filter((p) => p.awaited),
      work: view.observations
        .filter((o) => o.destinationSystem)
        .map((o) => ({
          system: o.destinationSystem as string,
          type: o.destinationType,
          id: o.destinationId,
          recordedAt: o.recordedAt.toISOString(),
          observationId: o.id,
        })) satisfies CaseWorkReference[],
    };
  }

  /**
   * Who this investigation is plausibly relevant to. A PROPOSAL, NEVER A WRITE.
   *
   * ONE DETERMINISTIC INPUT, AND IT IS THE ONLY ONE THAT EXISTS. A USER-scoped
   * `PerformanceObjective` is a person stating in their own words what they are
   * trying to accomplish, so a Case measured against it is relevant to them as a
   * matter of record. There is nothing else: `SystemRole` is an authorization
   * level and this schema documents that it is not an organizational fact, and
   * there is no team, division or reporting relationship to read.
   *
   * Returns an empty list rather than a guess when the Case was not opened from a
   * Headline, or when the objective belongs to the organization rather than a
   * person -- which is the common case today.
   */
  async suggest(organizationId: string, caseId: string): Promise<ParticipantSuggestion[]> {
    if (!caseId?.trim()) return [];
    const id = caseId.trim();
    const view = await this.cases.get(organizationId, id);
    if (!view) return [];

    const decision = view.decision;
    if (decision.sourceSystem !== INVESTIGATION_PRODUCER || !decision.sourceReference) return [];

    // RE-READ THROUGH THE HEADLINE'S OWN ORGANIZATION-SCOPED READ, exactly as the
    // Case Brief does. The Case names an id; only the Headline repository decides
    // whether this organization may have it.
    const headline = await this.headlines.get(organizationId, decision.sourceReference);
    if (!headline) return [];
    const objective = await this.objectives.get(organizationId, headline.performanceObjectiveId);
    if (!objective) return [];

    const existing = await this.participants.list(organizationId, id);
    return suggestParticipants({
      objective: {
        id: objective.id,
        scope: objective.scope,
        scopeUserId: objective.scopeUserId,
      },
      existingUserIds: [
        ...existing.filter((p) => !p.releasedAt).map((p) => p.userId),
        ...(view.ownerUserId ? [view.ownerUserId] : []),
        ...(view.assigneeUserId ? [view.assigneeUserId] : []),
      ],
    });
  }

  /**
   * Which layer owns which noun, read back from the shared declaration.
   *
   * Exposed so a surface and a test can assert the boundary rather than restate
   * it. Nothing computes from it; it exists so the answer has exactly one home.
   */
  static ownership(): typeof CASE_WORK_OWNERSHIP {
    return CASE_WORK_OWNERSHIP;
  }
}

// --- Projections ----------------------------------------------------------------

const AWAITED: readonly string[] = ['DECIDE', 'APPROVE'];

function toParticipantView(p: CaseParticipant): CaseParticipantView {
  const active = p.releasedAt === null;
  return {
    id: p.id,
    caseId: p.priorityId,
    userId: p.userId,
    contribution: p.contribution as CaseContribution,
    request: p.request,
    addedByUserId: p.addedByUserId,
    addedAt: p.addedAt.toISOString(),
    releasedAt: p.releasedAt?.toISOString() ?? null,
    releasedByUserId: p.releasedByUserId,
    active,
    // DERIVED FROM WHAT WAS ASKED, NOT FROM A STATUS SOMEBODY SETS. "The case is
    // waiting on Charlie" is a property of having asked Charlie to decide, so it
    // cannot be left stale by anyone forgetting to update it.
    awaited: active && AWAITED.includes(p.contribution),
  };
}

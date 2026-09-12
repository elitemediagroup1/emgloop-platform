// A person puts what they know on a Case -- and Loop records that they reported
// it, not that it is true.
//
// THE ONE AUTHORITATIVE APPEND PATH for a human report, and it writes through the
// authorities that already exist: the evidence row through the Decision Engine
// (which is what makes it immutable, attributed and logged), and nothing else
// anywhere. There is no second evidence store, no Case notes table pretending to
// be evidence, and no shortcut past the engine.
//
// WHAT A REPORT ESTABLISHES. That the person reported it. "Matt reported that the
// API token expired" is true the moment it is written; "the API token expired" is
// a separate claim that has to meet the governed standard for claims of its kind.
// Organizational authority does not close that gap -- this service will take a
// report from an owner and from a released participant's colleague on exactly the
// same terms, because seniority is not evidence.
//
// AUTHORIZATION IS RESOLVED HERE, NOT ASSERTED BY THE CALLER. The caller hands
// over an organization and a user id from the session and nothing else; this file
// resolves organization -> Case -> participation -> person against the database
// every time. A boolean passed in from a page would be caller-enforced isolation,
// which is the exact failure mode `CLAUDE.md` records three cross-tenant writes
// against.
//
// THE INSTANCE-SCOPED GRANT IS NARROW BY CONSTRUCTION. Being an active
// participant on a Case permits ONE act: appending a human report to THAT Case.
// It is not a role, it is not stored anywhere, and it grants nothing else --
// judging a Finding, changing the lifecycle, managing participants, creating work
// and everything else still go through the organization-level permission they
// always did. The grant ends the moment the participant is released, because it
// is derived from the participant row rather than copied out of it.
//
// NO PERSON-LEVEL TRUST OF ANY KIND. Nothing here scores a reporter, weights a
// report by who wrote it, or reads anybody's history. Two people reporting the
// same sentence produce two pieces of evidence of equal standing, and that
// standing is "somebody reported this".

import type { PrismaClient, DecisionEvidence } from '@prisma/client';
import { HUMAN_REPORT_SOURCE } from '@emgloop/shared';

import { CaseParticipantRepository } from '../repositories/case-participant.repository';
import { IamRepository } from '../repositories/iam.repository';
import { DecisionEngine } from './decision/decision-engine';

/** How a request to report evidence ended. Exactly one of them writes. */
export const EVIDENCE_REPORT_OUTCOMES = [
  /** The report is on the Case, immutably, attributed to the person who wrote it. */
  'RECORDED',
  /**
   * No such Case in this organization.
   *
   * NOT-FOUND, NEVER FORBIDDEN. A Case in another tenant answers exactly as one
   * that does not exist, so this can never be used to learn that a Case is there.
   */
  'CASE_NOT_FOUND',
  /**
   * This person may not report on this Case: no organization-level write
   * authority, and not an active participant on it.
   */
  'NOT_AUTHORIZED',
  /** Nothing was reported. An empty statement is not evidence of anything. */
  'EMPTY_STATEMENT',
] as const;
export type EvidenceReportOutcome = (typeof EVIDENCE_REPORT_OUTCOMES)[number];

export interface ReportEvidenceResult {
  outcome: EvidenceReportOutcome;
  caseId: string;
  /** The evidence row, when one was written. */
  evidenceId: string | null;
}

export interface ReportEvidenceInput {
  /**
   * WHAT THE PERSON REPORTED, exactly as they wrote it.
   *
   * Stored verbatim. This service checks that it is not empty and otherwise does
   * not touch it: trimming, collapsing or summarizing a person's own words would
   * be editing the evidence.
   */
  statement: string;
  /**
   * Who is reporting, FROM THE SESSION. There is no form field for this: the web
   * action reads it off the session and the engine writes the evidence's reporter
   * from the actor, so the two cannot disagree.
   */
  reportedByUserId: string;
  /**
   * When the thing being reported happened, if the person said.
   *
   * DEFAULTS TO NOW AND IS NOT INVENTED. `observedAt` already means "when the
   * evidence describes the world" and `createdAt` means "when Loop learned it";
   * a report about last Tuesday keeps both, and one with no stated time is
   * recorded as being about the moment it was written.
   */
  observedAt?: Date;
}

/** The Decision Center surface this service needs. One read, one append. */
export type CaseEvidenceCaseAccess = Pick<DecisionEngine, 'get' | 'addEvidence'>;

/** The two authorities a report may rest on. Both are resolved, never asserted. */
export interface CaseEvidenceDeps {
  cases?: CaseEvidenceCaseAccess;
  participants?: Pick<CaseParticipantRepository, 'isActiveParticipant'>;
  iam?: Pick<IamRepository, 'can'>;
}

export class CaseEvidenceService {
  private readonly cases: CaseEvidenceCaseAccess;
  private readonly participants: Pick<CaseParticipantRepository, 'isActiveParticipant'>;
  private readonly iam: Pick<IamRepository, 'can'>;

  constructor(prisma: PrismaClient, deps: CaseEvidenceDeps = {}) {
    this.cases = deps.cases ?? new DecisionEngine(prisma);
    this.participants = deps.participants ?? new CaseParticipantRepository(prisma);
    this.iam = deps.iam ?? new IamRepository(prisma);
  }

  /**
   * May this person report evidence on this Case?
   *
   * THE SAME QUESTION THE WRITE ASKS, so a surface showing the control and the
   * action authorizing it can never disagree. A page calling this is deciding
   * what to render; it is not granting anything, and the write re-resolves
   * everything from scratch regardless of what the page believed.
   */
  async canReport(organizationId: string, caseId: string, userId: string): Promise<boolean> {
    if (!organizationId?.trim() || !caseId?.trim() || !userId?.trim()) return false;
    const view = await this.cases.get(organizationId, caseId.trim());
    if (!view) return false;
    return this.authorized(organizationId, caseId.trim(), userId);
  }

  /**
   * Record what somebody reported. APPENDS; it never edits, replaces or dedupes.
   *
   * TWO PEOPLE REPORTING THE SAME SENTENCE ARE TWO PIECES OF EVIDENCE, and so is
   * one person saying the same thing again a week later -- the second one is a
   * fact about the week, and a system that collapsed it by text would destroy
   * that. There is deliberately no idempotency key: the engine's keys exist where
   * a re-run of the same analysis would duplicate itself, and a person pressing a
   * button twice is not that. What is written is what somebody said, when.
   */
  async report(
    organizationId: string,
    caseId: string,
    input: ReportEvidenceInput,
  ): Promise<ReportEvidenceResult> {
    const id = caseId?.trim() ?? '';
    const base = { caseId: id, evidenceId: null };
    if (!id) return { ...base, outcome: 'CASE_NOT_FOUND' };
    if (!input.statement || !input.statement.trim()) {
      return { ...base, outcome: 'EMPTY_STATEMENT' };
    }
    if (!input.reportedByUserId?.trim()) return { ...base, outcome: 'NOT_AUTHORIZED' };

    // THE CASE, RESOLVED WITHIN THE ORGANIZATION, FIRST. Everything after this
    // knows it is talking about a Case this tenant actually has.
    const view = await this.cases.get(organizationId, id);
    if (!view) return { ...base, outcome: 'CASE_NOT_FOUND' };

    const mayReport = await this.authorized(organizationId, id, input.reportedByUserId);
    if (!mayReport) return { ...base, outcome: 'NOT_AUTHORIZED' };

    const { evidence } = await this.cases.addEvidence(
      organizationId,
      id,
      {
        source: HUMAN_REPORT_SOURCE,
        evidenceClass: 'HUMAN_REPORTED',
        // VERBATIM. Not trimmed, not normalized, not summarized.
        statement: input.statement,
        ...(input.observedAt ? { observedAt: input.observedAt } : {}),
      },
      // THE ACTOR IS THE REPORTER, and the engine writes the evidence's reporter
      // from it. There is no path here through which a person could be recorded
      // as having reported something somebody else typed.
      { type: 'HUMAN', userId: input.reportedByUserId, source: HUMAN_REPORT_SOURCE },
    );

    return { caseId: id, outcome: 'RECORDED', evidenceId: evidence.id };
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Either authority, resolved against the database.
   *
   * ORDER IS NOT SIGNIFICANT AND NEITHER IS WIDER THAN THE OTHER: an owner is
   * not a better reporter than the person who was asked to look at this Case,
   * and the evidence each of them writes carries identical standing.
   */
  private async authorized(
    organizationId: string,
    caseId: string,
    userId: string,
  ): Promise<boolean> {
    const orgWide = await this.iam.can({
      organizationId,
      userId,
      resource: 'commercialIntelligence',
      action: 'update',
    });
    if (orgWide) return true;
    return this.participants.isActiveParticipant(organizationId, caseId, userId);
  }
}

// Who is involved in an investigation, what each of them is being asked for, and
// the line between that and the work itself.
//
// THE PROBLEM TWO COLUMNS CANNOT SOLVE. A Case already carries `ownerUserId`
// (accountability -- who answers for this reaching an outcome) and
// `assigneeUserId` (execution -- who is actively working it). Those are two
// genuinely different questions and the Decision Center was right to keep them
// apart. But a real investigation routinely needs THREE people for three
// different reasons: one to decide, one to change something technical, one to
// handle the buyer relationship. Rotating `assigneeUserId` between them would
// destroy the only answer to "who is working this", and naming one of them owner
// would silently demote the other two to nobody.
//
// SO PARTICIPATION IS ITS OWN FACT, AND IT IS NOT A TASK. A participant row says
// WHY a person is relevant to an investigation and WHAT is being asked of them.
// It carries no due date, no dependency, no SLA, no blocked state and no
// completion, because every one of those is an execution obligation and this
// platform already has a layer that owns those.
//
// THE BOUNDARY, STATED ONCE AND ENFORCED BY ABSENCE:
//
//   COMMERCIAL INTELLIGENCE owns   why something needs attention, the Case, the
//                                  Finding, the Recommendation, the proposed
//                                  sequence, and why a person is involved.
//   WORK OS owns                   the executable obligation: the instance, the
//                                  stage, the assignment, who completed it and
//                                  when.
//
// There is deliberately no CI task status beside a Work status, no CI due date
// beside a Work due date, no CI completion beside a Work completion. Where an
// investigation does become work, the Case REFERENCES the Work object through
// the destination columns the Decision Center already carries on its log
// (`destinationSystem` / `destinationType` / `destinationId`, written on a
// CONVERTED_TO_WORK outcome) rather than copying any of its mutable state. A copy
// would be a second answer to "is it done", and the copy is always the one that
// goes stale.
//
// WHAT IS DELIBERATELY MISSING FROM THE STATUS VOCABULARY. There is none. A
// participant is present or has been released, following `WorkAssignment`'s own
// `assignedAt` / `unassignedAt` convention rather than inventing an enum beside
// it. No DONE, because completing an obligation is Work OS's answer. No BLOCKED
// and no WAITING, because those are execution states and this repository does not
// yet have an owner for them -- see `CASE_PARTICIPATION_DEFERRED`.
//
// PURE. No clock, no I/O, no randomness.

/**
 * What a person is being asked to contribute.
 *
 * CLOSED, AND CHOSEN BY WHO CAN DO IT rather than by department. Each member is
 * a different KIND of contribution, so two people on one Case never collapse into
 * "involved" -- which is the whole reason this exists.
 *
 * DECIDE          A judgement only this person can make. The Case waits on them.
 * INVESTIGATE     Establish what is actually happening. Usually technical.
 * RELATIONSHIP    Speak to the counterparty. Owns what gets said and by whom.
 * DOMAIN_INPUT    Knows something the investigation needs. Not accountable.
 * APPROVE         Must sign off before something consequential happens.
 * INFORMED        Needs to know. Asked for nothing.
 */
export const CASE_CONTRIBUTIONS = [
  'DECIDE',
  'INVESTIGATE',
  'RELATIONSHIP',
  'DOMAIN_INPUT',
  'APPROVE',
  'INFORMED',
] as const;
export type CaseContribution = (typeof CASE_CONTRIBUTIONS)[number];

export function isCaseContribution(value: string): value is CaseContribution {
  return (CASE_CONTRIBUTIONS as readonly string[]).includes(value);
}

export const CASE_CONTRIBUTION_LABELS: Record<CaseContribution, string> = {
  DECIDE: 'Decision needed',
  INVESTIGATE: 'Investigation needed',
  RELATIONSHIP: 'Relationship handling needed',
  DOMAIN_INPUT: 'Input needed',
  APPROVE: 'Approval needed',
  INFORMED: 'Kept informed',
};

/** What each contribution actually asks of the person, in one sentence. */
export const CASE_CONTRIBUTION_DESCRIPTIONS: Record<CaseContribution, string> = {
  DECIDE: 'This person makes a call that nobody else on the case can make for them.',
  INVESTIGATE: 'This person establishes what is actually happening.',
  RELATIONSHIP: 'This person owns what gets said to the counterparty, and by whom.',
  DOMAIN_INPUT: 'This person knows something the investigation needs. They are not accountable for it.',
  APPROVE: 'Nothing consequential happens here until this person signs off.',
  INFORMED: 'This person needs to know. Nothing is being asked of them.',
};

/**
 * Contributions that make the Case WAIT on somebody.
 *
 * Named so a surface can answer "who is this blocked on" WITHOUT a blocked state
 * existing anywhere: it is a property of what was asked, not a status somebody
 * has to remember to set — and therefore it cannot go stale.
 */
export const AWAITED_CONTRIBUTIONS: readonly CaseContribution[] = ['DECIDE', 'APPROVE'];

export function contributionIsAwaited(contribution: CaseContribution): boolean {
  return AWAITED_CONTRIBUTIONS.includes(contribution);
}

// --- One participant -----------------------------------------------------------------

/**
 * One person's involvement in one investigation.
 *
 * NO STATUS COLUMN, DELIBERATELY. Presence and release, following
 * `WorkAssignment`'s `assignedAt` / `unassignedAt` shape. A participant is active
 * exactly when they have not been released, which cannot disagree with itself the
 * way a status enum maintained beside a timestamp can.
 */
export interface CaseParticipantView {
  id: string;
  caseId: string;
  userId: string;
  contribution: CaseContribution;
  /**
   * WHY this person, in the words of whoever added them.
   *
   * REQUIRED. A participant with no stated reason is a name on a list, and the
   * person who arrives at the Case next has to guess what was wanted from them.
   */
  request: string;
  addedByUserId: string | null;
  addedAt: string;
  /** Set when they were released. Null while they are still involved. */
  releasedAt: string | null;
  releasedByUserId: string | null;
  /** True while they are still involved. Derived, never stored. */
  active: boolean;
  /** True when the Case is waiting on this person. Derived from the contribution. */
  awaited: boolean;
}

/**
 * The people on one investigation, and what each is for.
 *
 * OWNER AND ASSIGNEE ARE CARRIED ALONGSIDE, NOT ABSORBED. They remain the
 * Decision Center's answers to accountability and execution; participation
 * answers a third question and does not overwrite either. A surface renders all
 * three.
 */
export interface CaseParticipationView {
  caseId: string;
  /** Accountability. Unchanged by anything in this contract. */
  ownerUserId: string | null;
  /** Execution. Unchanged by anything in this contract. */
  assigneeUserId: string | null;
  /** Everyone currently involved, in the order they were added. */
  participants: readonly CaseParticipantView[];
  /** Everyone released, newest first. Kept, because who was asked is history. */
  released: readonly CaseParticipantView[];
  /**
   * The people this Case is waiting on, derived from their contributions.
   *
   * NOT A BLOCKED STATE. It says "two people were asked to decide and have not
   * been released", which is a fact about the request rather than a status
   * anybody maintains.
   */
  awaiting: readonly CaseParticipantView[];
  /** The Work this Case produced, if any. A REFERENCE. See `CaseWorkReference`. */
  work: readonly CaseWorkReference[];
}

// --- The Work boundary ------------------------------------------------------------------

/**
 * A pointer to work that exists somewhere else.
 *
 * EVERY FIELD HERE IS AN IDENTIFIER OR A TIMESTAMP OF THE REFERENCE ITSELF.
 * There is no title, no status, no assignee, no due date and no completion --
 * not because they are uninteresting, but because Work OS owns them and a copy
 * here would be a second answer that goes stale the first time somebody advances
 * a stage. A surface that wants those reads them from Work OS through this
 * pointer.
 *
 * THE COLUMNS ARE THE ONES THAT ALREADY EXIST. `OperationalObservation` has
 * carried `destinationSystem` / `destinationType` / `destinationId` since the
 * Decision Center shipped, written when an outcome is CONVERTED_TO_WORK,
 * "generic on purpose: the Decision Engine records that work was created
 * somewhere, never which product". This type is that fact, read back.
 */
export interface CaseWorkReference {
  /** Which system holds it, e.g. 'work-os'. Never parsed for meaning. */
  system: string;
  /** What kind of thing it is there, e.g. 'work_instance'. Opaque. */
  type: string | null;
  /** Its id there. Opaque. */
  id: string | null;
  /** When the Case recorded that work had been created. */
  recordedAt: string;
  /** The observation that recorded it, so the act stays auditable. */
  observationId: string;
}

/**
 * Everything about an execution obligation that Commercial Intelligence must
 * never store.
 *
 * A LIST, SO IT CAN BE TESTED. A contract that merely says "do not duplicate task
 * state" is a comment; this is asserted against the participant contract and the
 * migration, so adding `dueDate` to a Case participant fails a test rather than a
 * review.
 */
export const WORK_OWNED_FIELDS = [
  'dueDate',
  'dueAt',
  'startedAt',
  'completedAt',
  'completedBy',
  'status',
  'blockedBy',
  'dependsOn',
  'slaMinutes',
  'escalatedAt',
  'priorityRank',
] as const;
export type WorkOwnedField = (typeof WORK_OWNED_FIELDS)[number];

/**
 * Which layer owns each noun, stated once so the answer cannot drift between
 * two files that both think they know.
 */
export const CASE_WORK_OWNERSHIP = {
  case: 'COMMERCIAL_INTELLIGENCE',
  finding: 'COMMERCIAL_INTELLIGENCE',
  recommendation: 'COMMERCIAL_INTELLIGENCE',
  actionSequence: 'COMMERCIAL_INTELLIGENCE',
  caseParticipation: 'COMMERCIAL_INTELLIGENCE',
  caseOutcome: 'COMMERCIAL_INTELLIGENCE',
  executionObligation: 'WORK_OS',
  taskAssignee: 'WORK_OS',
  taskStatus: 'WORK_OS',
  dueDate: 'WORK_OS',
  completion: 'WORK_OS',
  dependency: 'UNOWNED',
} as const;

/**
 * What this contract deliberately does not attempt, and why.
 *
 * WRITTEN DOWN BECAUSE THE GAPS ARE REAL AND THE NEXT PERSON WILL HIT THEM. An
 * unbuilt capability that nobody recorded becomes a capability somebody assumes
 * exists -- which is how `EVENT_BUS.md` came to be cited by three other documents.
 */
export const CASE_PARTICIPATION_DEFERRED = {
  acknowledgement:
    'Whether a participant has SEEN what was asked of them is not recorded. It is the ' +
    'first step of a task lifecycle, and Work OS owns task lifecycles.',
  escalation:
    'Escalating to a manager is not implementable: this schema has no reporting ' +
    'relationship, no team and no division, so "their manager" resolves to nothing.',
  sla:
    'No clock runs on participation. Work OS carries no due date, dependency or SLA ' +
    'either, so building one here would put the first execution clock in the layer ' +
    'that explicitly does not own execution.',
  automaticRouting:
    'Loop cannot yet choose who should participate. The only responsibility fact in ' +
    'this schema is a USER-scoped PerformanceObjective; a SystemRole is an ' +
    'authorization level and is documented as not being an organizational fact.',
} as const;

// --- What can be routed automatically today ------------------------------------------------

/**
 * The one deterministic responsibility signal this repository actually has.
 *
 * A `PerformanceObjective` scoped to a USER is a person stating, in their own
 * words, what they are trying to accomplish. A Case opened from a Headline
 * measured against that objective is therefore relevant to that person as a
 * matter of record rather than of inference.
 *
 * IT IS A SUGGESTION AND NOTHING MORE. It proposes a participant; a person adds
 * them. Nothing here assigns anybody, because "relevant to your objective" is not
 * the same claim as "responsible for handling this", and only a person can make
 * the second.
 */
export interface ParticipantSuggestion {
  userId: string;
  contribution: CaseContribution;
  /** Why Loop thinks so, in one sentence a person can check. */
  basis: string;
  /** The objective that made this person relevant. Inspectable, not a score. */
  performanceObjectiveId: string;
}

export const SUGGESTION_BASIS =
  'This case was measured against a performance objective this person owns.';

/**
 * Who a Case is plausibly relevant to, from objective ownership alone.
 *
 * DETERMINISTIC AND EXPLAINABLE: one input, one rule, one stated reason. Returns
 * nothing when the Case was not measured against a user-scoped objective, which
 * is the common case today and is reported as such rather than filled in from the
 * nearest available person.
 */
export function suggestParticipants(input: {
  /** The objective the Case's Headline was measured against, when there was one. */
  objective: { id: string; scope: string; scopeUserId: string | null } | null;
  /** People already on the Case, so a suggestion never repeats one. */
  existingUserIds: readonly string[];
}): ParticipantSuggestion[] {
  const objective = input.objective;
  if (!objective || objective.scope !== 'USER' || !objective.scopeUserId) return [];
  if (input.existingUserIds.includes(objective.scopeUserId)) return [];
  return [
    {
      userId: objective.scopeUserId,
      // THE WEAKEST CONTRIBUTION THAT FITS. Owning the objective a case was
      // measured against makes somebody relevant; it does not make them the
      // decider, and proposing DECIDE would be Loop assigning authority.
      contribution: 'DOMAIN_INPUT',
      basis: SUGGESTION_BASIS,
      performanceObjectiveId: objective.id,
    },
  ];
}

// --- The Case's own log ----------------------------------------------------------------------

/** The exact line written on the Case when somebody is asked to participate. */
export const PARTICIPANT_ADDED_REASON =
  'A person was asked to contribute to this investigation. Being asked is not being ' +
  'assigned work, and nothing was created anywhere else.';

/** The exact line written when somebody is released from an investigation. */
export const PARTICIPANT_RELEASED_REASON =
  'A person was released from this investigation. What they were asked for is kept.';

/** The exact line written when what a person is being asked for changes. */
export const PARTICIPANT_CHANGED_REASON =
  'What a person is being asked to contribute to this investigation changed. The previous ' +
  'request is kept on this log.';

export const PARTICIPATION_EVENTS = ['ADDED', 'RELEASED', 'CHANGED'] as const;
export type ParticipationEvent = (typeof PARTICIPATION_EVENTS)[number];

/**
 * True when this log row records a participation event of the given kind.
 *
 * THE SAME DEVICE AND THE SAME RECORDED DEBT as the Finding and Recommendation
 * predicates: a dedicated `OperationalObservationType` member is a database enum
 * and therefore a migration, so `NOTE_ADDED` carries the distinction through an
 * exact reason line. These predicates are the only place allowed to read it back
 * out.
 */
export function isParticipationEvent(
  observation: { observationType: string; reason: string | null },
  kind: ParticipationEvent,
): boolean {
  if (observation.observationType !== 'NOTE_ADDED') return false;
  const expected =
    kind === 'ADDED'
      ? PARTICIPANT_ADDED_REASON
      : kind === 'RELEASED'
        ? PARTICIPANT_RELEASED_REASON
        : PARTICIPANT_CHANGED_REASON;
  return observation.reason === expected;
}

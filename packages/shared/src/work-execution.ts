// Execution truth, and the policy evaluated against it. THE WORK OS SIDE OF THE
// STAGE 4 BOUNDARY.
//
// WHY THIS IS HERE AND NOT IN COMMERCIAL INTELLIGENCE. A Case can ask somebody
// to do something. It cannot own whether they have done it, when they were
// supposed to, or what is stopping them -- that is execution, and execution is
// Work OS. Building an execution clock inside CI would have created a second
// task truth: two places that both believe they know whether a thing is late,
// disagreeing the first time one of them is not written to.
//
// THE DISTINCTION THAT ORGANISES THIS WHOLE FILE. A due time is EXECUTION TRUTH:
// somebody said this should happen by then, and it is recorded. "Twelve hours
// actionable and unresolved is reminder-eligible" is POLICY: it is evaluated
// against that truth, produces the same answer every time it is asked, and is
// stored nowhere. Nothing here writes "a reminder fired". A stored reminder flag
// is a fact about a delivery, and this file is not about deliveries.
//
// EVERYTHING IS DERIVED FROM HISTORY, AND NOTHING IS COUNTED. Time actionable,
// time waiting, time blocked and the number of extensions are all replayed from
// the stage's event log. A counter column would be a second representation of
// the same fact, and it would drift the first time an event was written without
// it -- which is the failure this repository has already made five times under
// other names.
//
// PURE. No clock, no I/O, no randomness. `now` is an argument. Same inputs, same
// verdict -- which is what lets an operator be told exactly why something is
// overdue, and what lets that answer be tested.
//
// NO MODEL DECIDES ANY OF THIS. Whether work is late is arithmetic over
// timestamps. It must stay arithmetic.

export const WORK_EXECUTION_RULE_VERSION = 'work-execution.v1';

// --- Status ---------------------------------------------------------------------------

/**
 * Where an execution obligation stands.
 *
 * THE FIRST FIVE ARE UNCHANGED, DELIBERATELY. `pending`, `ready`,
 * `in_progress`, `completed` and `skipped` are what `work_stages.status` has
 * held since Work OS shipped, in that spelling, and every existing row uses
 * them. Introducing a parallel `executionState` column beside them would have
 * been the repository's defining failure mode -- three workflow systems, two
 * shells, two token sets -- committed once more, for the sake of nicer names.
 *
 * THREE ARE ADDED, because the model could not previously distinguish three
 * genuinely different situations, all of which had to be recorded as
 * `in_progress`:
 *
 *   · WAITING ON SOMEBODY HERE. The obligation is real and unmet, and the person
 *     who owns it is not the person holding it up.
 *   · WAITING ON SOMEBODY OUTSIDE. Same, except Loop has no authority over when
 *     it resolves, which is why the two are not one state.
 *   · BLOCKED. Something else must happen first, and it is named.
 *
 * Collapsing those into "in progress" makes an accountability clock lie in both
 * directions: it reports somebody as sitting on work they cannot do, and it
 * hides work that genuinely is being sat on.
 */
export const WORK_EXECUTION_STATES = [
  'pending',
  'ready',
  'in_progress',
  'waiting_internal',
  'waiting_external',
  'blocked',
  'completed',
  'skipped',
] as const;

export type WorkExecutionState = (typeof WORK_EXECUTION_STATES)[number];

export function isWorkExecutionState(value: string): value is WorkExecutionState {
  return (WORK_EXECUTION_STATES as readonly string[]).includes(value);
}

/**
 * States in which the clock of accountability RUNS.
 *
 * The obligation is live and the owner can move it. `pending` is not here: a
 * later step nobody has reached yet is not somebody's overdue work.
 */
export const ACTIONABLE_STATES: readonly WorkExecutionState[] = ['ready', 'in_progress'];

/** States that are legitimate waiting rather than execution. */
export const WAITING_STATES: readonly WorkExecutionState[] = [
  'waiting_internal',
  'waiting_external',
  'blocked',
];

/** States in which nothing further is expected. */
export const TERMINAL_STATES: readonly WorkExecutionState[] = ['completed', 'skipped'];

export function isActionable(state: WorkExecutionState): boolean {
  return ACTIONABLE_STATES.includes(state);
}
export function isWaiting(state: WorkExecutionState): boolean {
  return WAITING_STATES.includes(state);
}
export function isTerminal(state: WorkExecutionState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * The states a stage may move to from where it is.
 *
 * FAIL CLOSED. A transition not listed is refused rather than allowed with a
 * warning, and the terminal states have no exits at all -- reopening completed
 * work is a different act with a different name, and letting it happen through
 * a status write would erase the completion from the only place it is recorded.
 */
export const ALLOWED_TRANSITIONS: Record<WorkExecutionState, readonly WorkExecutionState[]> = {
  pending: ['ready', 'skipped'],
  ready: ['in_progress', 'waiting_internal', 'waiting_external', 'blocked', 'completed', 'skipped'],
  in_progress: ['ready', 'waiting_internal', 'waiting_external', 'blocked', 'completed', 'skipped'],
  waiting_internal: ['ready', 'in_progress', 'waiting_external', 'blocked', 'completed', 'skipped'],
  waiting_external: ['ready', 'in_progress', 'waiting_internal', 'blocked', 'completed', 'skipped'],
  blocked: ['ready', 'in_progress', 'waiting_internal', 'waiting_external', 'completed', 'skipped'],
  completed: [],
  skipped: [],
};

export function transitionAllowed(from: WorkExecutionState, to: WorkExecutionState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// --- What we are waiting for ------------------------------------------------------------

/**
 * Why an obligation is waiting, as a value rather than a sentence.
 *
 * FREE TEXT MUST NOT DECIDE WHETHER THE CLOCK PAUSES. "waiting on the buyer" and
 * "waiting on Mike" are the same English shape and completely different
 * accountability, and a policy that reads prose to tell them apart is a policy
 * that can be moved by wording. The reason is a code; the sentence beside it is
 * for the person reading it.
 */
export const WAIT_REASONS = [
  /** Somebody inside the organization owes an input, an answer or a decision. */
  'AWAITING_INTERNAL_INPUT',
  /** Somebody inside must approve before this can proceed. */
  'AWAITING_INTERNAL_APPROVAL',
  /** A counterparty outside the organization owes a response. */
  'AWAITING_EXTERNAL_RESPONSE',
  /** A scheduled external event has to happen first. */
  'AWAITING_EXTERNAL_EVENT',
  /** Data Loop does not yet have has to arrive before this is answerable. */
  'AWAITING_DATA',
  /** Another execution obligation, named on a dependency row, must resolve. */
  'AWAITING_DEPENDENCY',
] as const;

export type WaitReason = (typeof WAIT_REASONS)[number];

export function isWaitReason(value: string): value is WaitReason {
  return (WAIT_REASONS as readonly string[]).includes(value);
}

/**
 * Which waiting state each reason belongs in.
 *
 * DERIVED, NEVER BOTH RECORDED. If the state and the reason were independent
 * columns, a row could claim to be waiting internally on an external response,
 * and nothing would catch it.
 */
export const WAIT_STATE_FOR_REASON: Record<WaitReason, WorkExecutionState> = {
  AWAITING_INTERNAL_INPUT: 'waiting_internal',
  AWAITING_INTERNAL_APPROVAL: 'waiting_internal',
  AWAITING_EXTERNAL_RESPONSE: 'waiting_external',
  AWAITING_EXTERNAL_EVENT: 'waiting_external',
  AWAITING_DATA: 'waiting_external',
  AWAITING_DEPENDENCY: 'blocked',
};

/** What is being waited on, structurally. */
export interface WaitDeclaration {
  reason: WaitReason;
  /**
   * WHO OR WHAT, in the caller's own terms -- a user id, a buyer name, a data
   * source. Opaque here: this file never parses it, and nothing branches on it.
   */
  subject: string | null;
  /**
   * WHEN WE EXPECT IT, if anybody said. Null is "we do not know", and it stays
   * null rather than becoming a guess -- a fabricated expectation would make an
   * unbounded wait look managed.
   */
  expectedResolutionAt: Date | null;
  /** The sentence a person reads. Never consulted by policy. */
  note: string | null;
}

// --- The event log --------------------------------------------------------------------

/**
 * What the stage's append-only log records.
 *
 * ONE ROW PER THING THAT HAPPENED, and every duration below is replayed from
 * them. This is the same shape the Decision Center uses for a Case, for the same
 * reason: a projection can be rebuilt and a counter cannot be un-drifted.
 */
export const WORK_EVENT_TYPES = [
  'STATE_CHANGED',
  /** A due time was set for the first time. */
  'DUE_SET',
  /** A due time already set was moved. Every one of these stays visible. */
  'DUE_EXTENDED',
  /** A dependency was declared. */
  'DEPENDENCY_ADDED',
  /** A dependency was resolved by the authority that owns it. */
  'DEPENDENCY_RESOLVED',
  /** A note, carrying no state meaning at all. */
  'NOTE_ADDED',
] as const;

export type WorkEventType = (typeof WORK_EVENT_TYPES)[number];

export interface WorkStageEventRecord {
  eventType: WorkEventType;
  occurredAt: Date;
  sequence: number;
  fromStatus: WorkExecutionState | null;
  toStatus: WorkExecutionState | null;
  waitReason: WaitReason | null;
  expectedResolutionAt: Date | null;
  /** The due time as of this event, when the event set or moved one. */
  dueAt: Date | null;
  actorUserId: string | null;
}

// --- Replay ----------------------------------------------------------------------------

/** How long the obligation spent in each state, in milliseconds. */
export interface ExecutionDurations {
  actionableMs: number;
  waitingInternalMs: number;
  waitingExternalMs: number;
  blockedMs: number;
  /** First actionable to completion. Null while it is unfinished. */
  elapsedToCompletionMs: number | null;
}

/**
 * Replay the log into durations.
 *
 * ORDERED BY SEQUENCE, NEVER BY TIMESTAMP. Two events can share a millisecond;
 * the monotonic sequence is what gives the log a deterministic order, exactly as
 * on the Case side.
 *
 * TIME IS ATTRIBUTED TO THE STATE IT WAS SPENT IN, not to the state the stage
 * ends in. This is the difference between "she has had it for two days" and "she
 * has been able to act on it for forty minutes", and Stage 4 needs the second.
 */
export function replayDurations(
  events: readonly WorkStageEventRecord[],
  now: Date,
): ExecutionDurations {
  const log = [...events].sort((a, b) => a.sequence - b.sequence);
  const out: ExecutionDurations = {
    actionableMs: 0,
    waitingInternalMs: 0,
    waitingExternalMs: 0,
    blockedMs: 0,
    elapsedToCompletionMs: null,
  };

  let state: WorkExecutionState | null = null;
  let since: Date | null = null;
  let firstActionableAt: Date | null = null;
  let completedAt: Date | null = null;

  const credit = (to: Date) => {
    if (state === null || since === null) return;
    const ms = Math.max(0, to.getTime() - since.getTime());
    if (isActionable(state)) out.actionableMs += ms;
    else if (state === 'waiting_internal') out.waitingInternalMs += ms;
    else if (state === 'waiting_external') out.waitingExternalMs += ms;
    else if (state === 'blocked') out.blockedMs += ms;
  };

  for (const e of log) {
    if (e.eventType !== 'STATE_CHANGED' || e.toStatus === null) continue;
    credit(e.occurredAt);
    state = e.toStatus;
    since = e.occurredAt;
    if (firstActionableAt === null && isActionable(e.toStatus)) firstActionableAt = e.occurredAt;
    if (e.toStatus === 'completed') completedAt = e.occurredAt;
  }

  // The open interval, up to the moment being asked about. A stage sitting
  // actionable right now is accruing accountability right now, and a report that
  // only counted closed intervals would show zero on the worst case in the queue.
  if (state !== null && !isTerminal(state)) credit(now);

  if (firstActionableAt && completedAt) {
    out.elapsedToCompletionMs = Math.max(0, completedAt.getTime() - firstActionableAt.getTime());
  }
  return out;
}

/**
 * How many times a due time was moved.
 *
 * DERIVED FROM THE LOG, so it cannot be reset. "This has been extended four
 * times" is one of the few facts about execution that a person genuinely needs
 * and that nobody volunteers, and a counter column could be written back to
 * zero by any code path that forgot it.
 */
export function extensionCount(events: readonly WorkStageEventRecord[]): number {
  return events.filter((e) => e.eventType === 'DUE_EXTENDED').length;
}

// --- Policy ------------------------------------------------------------------------------

/**
 * The default accountability policy.
 *
 * TWELVE AND TWENTY-FOUR HOURS OF ACTIONABLE TIME -- not wall-clock time since
 * the work was created. Work that spent a day waiting on a buyer has not been
 * ignored, and a policy that counted that day would page somebody for
 * somebody else's silence.
 */
export const REMINDER_AFTER_ACTIONABLE_MS = 12 * 60 * 60 * 1000;
export const ESCALATION_AFTER_ACTIONABLE_MS = 24 * 60 * 60 * 1000;

/** Why a piece of work is where it is, as a value the UI can switch on. */
export const SLA_STATES = [
  /** Live, and inside the policy window. */
  'WITHIN_POLICY',
  /** Actionable for at least the reminder threshold and still unresolved. */
  'REMINDER_ELIGIBLE',
  /** Actionable for at least the escalation threshold and still unresolved. */
  'ESCALATION_ELIGIBLE',
  /** Legitimately waiting. The clock is not running, and the wait is recorded. */
  'PAUSED_WAITING',
  /** Finished. */
  'CLOSED',
  /**
   * There is not enough history to say.
   *
   * A STAGE WITH NO EVENT LOG IS NOT COMPLIANT, IT IS UNKNOWN. Every work item
   * created before this foundation existed is in exactly that position, and
   * reporting them as within policy would be the system inventing a clean bill
   * of health for work it has never measured.
   */
  'UNKNOWN',
] as const;

export type SlaState = (typeof SLA_STATES)[number];

export interface ExecutionAssessment {
  ruleVersion: string;
  state: WorkExecutionState;
  sla: SlaState;
  durations: ExecutionDurations;
  extensions: number;
  /** True when the obligation is live and its owner can act on it right now. */
  actionable: boolean;
  /** The declared wait, when there is one. Structured, never inferred from prose. */
  waiting: WaitDeclaration | null;
  /** Past its recorded due time. Null when no due time was ever set. */
  overdue: boolean | null;
  dueAt: Date | null;
  reminderEligible: boolean;
  escalationEligible: boolean;
  /**
   * WHO to escalate to. Null, and null is the honest answer today -- see
   * `ESCALATION_DESTINATION_ABSENT`.
   */
  escalationDestinationUserId: string | null;
  /** Plain sentences a surface can render, in the order they were derived. */
  explanation: readonly string[];
}

/**
 * WHY THERE IS NO ESCALATION DESTINATION.
 *
 * Escalation needs somebody to escalate TO, and this platform has no
 * organizational answer to that question. There is no Team model, no Division,
 * no reporting relationship, and `User.organizationId` is a scalar with no
 * membership table. `SystemRole` is an AUTHORIZATION LEVEL and not an
 * organizational fact -- `iam.repository.ts` already refuses to treat MANAGER as
 * "the people they manage" for exactly this reason, and treating it as a
 * hierarchy here would contradict a decision this repository has already made in
 * writing.
 *
 * SO ELIGIBILITY AND DESTINATION ARE SEPARATED. Loop can say, deterministically
 * and correctly, "this work has been actionable for over twenty-four hours and
 * is eligible for escalation". It must not also invent who is accountable for
 * that. Naming a wrong person is worse than naming nobody: it moves real
 * accountability onto somebody who never accepted it.
 *
 * THIS IS THE EXTENSION POINT AND NOTHING MORE. When a genuine responsibility
 * authority exists, it fills `escalationDestinationUserId` and every consumer of
 * this contract keeps working unchanged.
 */
export const ESCALATION_DESTINATION_ABSENT =
  'Loop can tell that this is eligible for escalation, but not who it should go to: ' +
  'this platform has no reporting relationship between people. A role is a permission ' +
  'level, not a manager.';

export interface ExecutionInput {
  state: WorkExecutionState;
  dueAt: Date | null;
  events: readonly WorkStageEventRecord[];
  /** The currently declared wait, when the stage is waiting. */
  waiting: WaitDeclaration | null;
  /** Unresolved dependencies. Any one of them keeps this from being actionable. */
  openDependencies: number;
  now: Date;
}

/**
 * The whole assessment, deterministically.
 *
 * ORDER MATTERS AND IS DELIBERATE. Closed beats everything, because finished
 * work is not late. Waiting beats the clock, because that is what "waiting
 * pauses the clock" means. Unknown beats compliance, because a stage with no
 * history has not been measured and must not be reported as fine.
 *
 * STATUS CHANGES EXTEND ACCOUNTABILITY; THEY DO NOT ERASE IT. The actionable
 * time already accrued stays accrued across a wait -- so a stage that sat
 * actionable for twenty hours, waited a week, and became actionable again is
 * four hours from escalation, not twenty-four. Letting a wait reset the clock
 * would make "mark it as waiting" the cheapest way to make an overdue item look
 * healthy, and somebody would find that out.
 */
export function assessExecution(input: ExecutionInput): ExecutionAssessment {
  const durations = replayDurations(input.events, input.now);
  const extensions = extensionCount(input.events);
  const explanation: string[] = [];

  const hasHistory = input.events.some((e) => e.eventType === 'STATE_CHANGED');
  const actionable = isActionable(input.state) && input.openDependencies === 0;
  const overdue = input.dueAt === null ? null : input.now.getTime() > input.dueAt.getTime();

  let sla: SlaState;
  if (isTerminal(input.state)) {
    sla = 'CLOSED';
    explanation.push(
      input.state === 'completed' ? 'This work is complete.' : 'This step was skipped.',
    );
  } else if (!hasHistory) {
    sla = 'UNKNOWN';
    explanation.push(
      'Loop cannot say whether this is on track: no execution history has been recorded for it.',
    );
  } else if (isWaiting(input.state)) {
    sla = 'PAUSED_WAITING';
    explanation.push(waitSentence(input.waiting, input.openDependencies));
    explanation.push(
      `The accountability clock is paused, and the ${formatHours(durations.actionableMs)} already ` +
        'spent actionable is kept.',
    );
  } else if (durations.actionableMs >= ESCALATION_AFTER_ACTIONABLE_MS) {
    sla = 'ESCALATION_ELIGIBLE';
    explanation.push(
      `Actionable for ${formatHours(durations.actionableMs)} and still unresolved, past the ` +
        `${ESCALATION_AFTER_ACTIONABLE_MS / 3_600_000}-hour escalation threshold.`,
    );
    explanation.push(ESCALATION_DESTINATION_ABSENT);
  } else if (durations.actionableMs >= REMINDER_AFTER_ACTIONABLE_MS) {
    sla = 'REMINDER_ELIGIBLE';
    explanation.push(
      `Actionable for ${formatHours(durations.actionableMs)} and still unresolved, past the ` +
        `${REMINDER_AFTER_ACTIONABLE_MS / 3_600_000}-hour reminder threshold.`,
    );
  } else {
    sla = 'WITHIN_POLICY';
    explanation.push(`Actionable for ${formatHours(durations.actionableMs)}.`);
  }

  if (overdue === true && sla !== 'CLOSED') {
    explanation.push('It is also past the time it was expected to be done.');
  }
  if (extensions > 0) {
    // Never hidden. An obligation moved four times is a different fact from one
    // moved once, and only the log knows.
    explanation.push(
      `Its expected time has been moved ${extensions} ${extensions === 1 ? 'time' : 'times'}.`,
    );
  }

  return {
    ruleVersion: WORK_EXECUTION_RULE_VERSION,
    state: input.state,
    sla,
    durations,
    extensions,
    actionable,
    waiting: input.waiting,
    overdue,
    dueAt: input.dueAt,
    reminderEligible: sla === 'REMINDER_ELIGIBLE' || sla === 'ESCALATION_ELIGIBLE',
    escalationEligible: sla === 'ESCALATION_ELIGIBLE',
    // Deterministically unknown, and deliberately so. See the constant above.
    escalationDestinationUserId: null,
    explanation,
  };
}

function waitSentence(waiting: WaitDeclaration | null, openDependencies: number): string {
  if (openDependencies > 0 && (waiting === null || waiting.reason === 'AWAITING_DEPENDENCY')) {
    return openDependencies === 1
      ? 'Blocked on one thing that has to resolve first.'
      : `Blocked on ${openDependencies} things that have to resolve first.`;
  }
  if (waiting === null) {
    // A wait with nothing declared is not describable, and saying so is better
    // than inventing a reason for it.
    return 'Waiting, with no reason recorded.';
  }
  const subject = waiting.subject ? ` on ${waiting.subject}` : '';
  const expected = waiting.expectedResolutionAt
    ? ` Expected to resolve by ${waiting.expectedResolutionAt.toISOString()}.`
    : ' No expected resolution time was given.';
  return `${WAIT_REASON_LABELS[waiting.reason]}${subject}.${expected}`;
}

export const WAIT_REASON_LABELS: Record<WaitReason, string> = {
  AWAITING_INTERNAL_INPUT: 'Waiting for input from someone here',
  AWAITING_INTERNAL_APPROVAL: 'Waiting for an approval here',
  AWAITING_EXTERNAL_RESPONSE: 'Waiting for a response from outside',
  AWAITING_EXTERNAL_EVENT: 'Waiting for something scheduled to happen',
  AWAITING_DATA: 'Waiting for data to arrive',
  AWAITING_DEPENDENCY: 'Blocked on something else finishing',
};

function formatHours(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)} minutes`;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'hour' : 'hours'}`;
}

// --- Dependencies --------------------------------------------------------------------

/**
 * What an obligation can be waiting on.
 *
 * DELIBERATELY NOT STAGE-TO-STAGE WITHIN ONE WORK ITEM. `work_stages.position`
 * already sequences the steps of a work item, and `completeWorkStep` already
 * makes the next one ready. A dependency row saying "step 3 waits for step 2"
 * would be a second, contradictable representation of a fact the position column
 * already owns -- and the two would disagree the first time somebody skipped a
 * step.
 */
export const DEPENDENCY_KINDS = [
  /** Another work item, anywhere in this organization, must complete. */
  'WORK_INSTANCE',
  /**
   * Something outside Work OS must happen -- a buyer replies, a report lands, a
   * contract is signed. Named structurally so it can be resolved deliberately
   * rather than by somebody deleting the row.
   */
  'EXTERNAL_CONDITION',
] as const;

export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

/** How a dependency stopped blocking. Never absent on a resolved dependency. */
export const DEPENDENCY_RESOLUTIONS = [
  /** The work item it named completed. Work OS observed its own transition. */
  'DEPENDED_WORK_COMPLETED',
  /** A person recorded that the condition is met. */
  'CONFIRMED_BY_PERSON',
  /** A person recorded that it will never be met, and this no longer waits on it. */
  'ABANDONED',
] as const;

export type DependencyResolution = (typeof DEPENDENCY_RESOLUTIONS)[number];

export interface DependencyView {
  id: string;
  kind: DependencyKind;
  /** Set when `kind` is WORK_INSTANCE. */
  dependsOnWorkInstanceId: string | null;
  /** What the condition is, in the caller's terms. Never parsed. */
  conditionSubject: string | null;
  description: string;
  expectedResolutionAt: Date | null;
  resolvedAt: Date | null;
  resolution: DependencyResolution | null;
  createdAt: Date;
}

export function dependencyIsOpen(d: Pick<DependencyView, 'resolvedAt'>): boolean {
  return d.resolvedAt === null;
}

/** Why a proposed dependency was refused. Fail closed, with a reason. */
export const DEPENDENCY_REFUSALS = [
  'SELF_DEPENDENCY',
  'CROSS_TENANT',
  'WORK_NOT_FOUND',
  'STAGE_NOT_FOUND',
  'CYCLE',
  'ALREADY_DECLARED',
  'MISSING_SUBJECT',
] as const;

export type DependencyRefusal = (typeof DEPENDENCY_REFUSALS)[number];

export const DEPENDENCY_REFUSAL_LABELS: Record<DependencyRefusal, string> = {
  SELF_DEPENDENCY: 'Work cannot wait for itself.',
  CROSS_TENANT: 'That work belongs to another organization.',
  WORK_NOT_FOUND: 'There is no such work item here.',
  STAGE_NOT_FOUND: 'There is no such step here.',
  CYCLE: 'That would make two pieces of work wait for each other.',
  ALREADY_DECLARED: 'This already waits on that.',
  MISSING_SUBJECT: 'A dependency has to name what it is waiting for.',
};

/**
 * Whether adding `from waits on to` would close a cycle.
 *
 * PURE, AND GIVEN THE GRAPH RATHER THAN FETCHING IT. The caller loads the
 * organization's open work-to-work dependencies -- which is already
 * tenant-scoped -- and this walks them. A cycle is not merely untidy: every work
 * item in it waits forever, and nothing in the system would ever say why.
 *
 * BOUNDED. A malformed graph that somehow already contains a cycle terminates
 * on the visited set rather than recursing until the stack gives out.
 */
export function wouldCreateCycle(
  edges: readonly { from: string; to: string }[],
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === from) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of out.get(node) ?? []) stack.push(next);
  }
  return false;
}

// --- What Work OS owns, stated once ----------------------------------------------------

/**
 * The execution facts that live here and may not be copied into a Case.
 *
 * ASSERTED BY TESTS ON BOTH SIDES. The Case side lists the same field names as
 * Work-owned and proves its own tables carry none of them; this is the other end
 * of that contract, and having both makes the boundary a thing that fails a test
 * rather than a thing somebody remembers.
 */
export const WORK_OWNED_EXECUTION_FIELDS = [
  'status',
  'executionState',
  'dueAt',
  'actionableAt',
  'startedAt',
  'completedAt',
  'ownerUserId',
  'assigneeUserId',
  'waitReason',
  'expectedResolutionAt',
  'dependency',
  'slaState',
] as const;

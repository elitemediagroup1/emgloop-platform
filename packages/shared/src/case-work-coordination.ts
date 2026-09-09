// What the Case asked for, and where that stands — WITHOUT the Case owning any
// of the answer.
//
// THE ONE RULE THIS FILE EXISTS TO HOLD. Commercial Intelligence READS execution
// state. It does not copy it. Every execution field below is assembled at read
// time from Work OS and is stored in no Commercial Intelligence table, because a
// copy is a second answer that goes stale the first time somebody advances a
// stage — and the person reading the Case would then be looking at a status the
// person doing the work had already changed.
//
// WHY THE VIEW IS SHAPED AROUND QUESTIONS. A Case surface has to answer a
// specific list: what did we ask, was work created, which work item, what state
// is it in, is it inside policy, is it blocked, on what, and when is that
// expected to clear. Shaping the contract around those questions rather than
// around the tables means a surface never has to join a Case to Work OS itself —
// which is the moment somebody would reimplement the tenant check.
//
// UNKNOWN SURVIVES. A reference to a system this build cannot read, a work item
// that no longer exists, and work with no recorded history are three DIFFERENT
// answers, and none of them is "fine". They are carried as distinct values
// rather than flattened into a null the UI would render as a blank.
//
// PURE. No clock, no I/O. The assembly happens in the service; the shapes and
// the vocabulary live here.

import type {
  DependencyKind,
  ExecutionDurations,
  SlaState,
  WaitReason,
  WorkExecutionState,
} from './work-execution';

export const CASE_COORDINATION_RULE_VERSION = 'case-work-coordination.v1';

/**
 * The system whose work this build can actually read.
 *
 * CHECKED BEFORE THE REFERENCE IS TRUSTED. `destinationSystem` is deliberately
 * generic — the Decision Engine "records that work was created somewhere, never
 * which product" — so a reference could name a system that does not exist here,
 * or one added later. Treating every reference as a Work OS id would make the
 * first non-Work-OS producer read back as a missing work item.
 */
export const WORK_OS_SYSTEM = 'work-os';

/** Why an execution state could not be read. Never collapsed into a null. */
export const COORDINATION_UNKNOWNS = [
  /**
   * The Case says work was created in a system this build cannot read. That is
   * a limit of this build, NOT a statement about the work.
   */
  'SYSTEM_NOT_READABLE',
  /**
   * The reference names a work item that does not resolve in this organization.
   * Deleted, or never there. Either way Loop must not guess which.
   */
  'WORK_NOT_FOUND',
  /**
   * The work exists and has no execution history. Every work item created before
   * the execution foundation is here, and it is NOT the same as being on track.
   */
  'NOT_MEASURED',
] as const;

export type CoordinationUnknown = (typeof COORDINATION_UNKNOWNS)[number];

export const COORDINATION_UNKNOWN_LABELS: Record<CoordinationUnknown, string> = {
  SYSTEM_NOT_READABLE: 'This work lives in a system Loop cannot read the status of.',
  WORK_NOT_FOUND: 'Loop cannot find the work this Case pointed at.',
  NOT_MEASURED: 'Loop has no execution history for this work, so it cannot say whether it is on track.',
};

/** One open block, in the terms a person reads. */
export interface CoordinationBlocker {
  id: string;
  kind: DependencyKind;
  description: string;
  /** When it is expected to clear, IF anybody said. Null is unknown, never soon. */
  expectedResolutionAt: string | null;
  /** The work item it waits on, when it waits on one. Opaque to this contract. */
  dependsOnWorkInstanceId: string | null;
}

/**
 * Execution state, read from Work OS and owned by Work OS.
 *
 * EVERY FIELD IS DERIVED AT READ TIME. None of it is written anywhere in
 * Commercial Intelligence, and `WORK_OWNED_FIELDS` in `case-participation.ts`
 * names the same facts from the other direction so both ends of the boundary
 * fail a test rather than a review.
 */
export interface CoordinationExecution {
  workStageId: string;
  stageName: string;
  ownerUserId: string | null;
  state: WorkExecutionState;
  actionable: boolean;
  sla: SlaState;
  dueAt: string | null;
  /** Null when no due time was ever set. Null is unknown, not on time. */
  overdue: boolean | null;
  waiting: {
    reason: WaitReason;
    subject: string | null;
    expectedResolutionAt: string | null;
  } | null;
  reminderEligible: boolean;
  escalationEligible: boolean;
  /**
   * Null, and null is the honest answer: this platform has no reporting
   * relationship. See ESCALATION_DESTINATION_ABSENT in `work-execution.ts`.
   */
  escalationDestinationUserId: string | null;
  durations: ExecutionDurations;
  extensions: number;
  /** Why it is where it is, in sentences, produced by the same walk as the verdict. */
  explanation: readonly string[];
}

/** One thing the Case asked for, and where it stands. */
export interface CoordinatedWork {
  /** The reference the Case recorded. Opaque identifiers only. */
  system: string;
  type: string | null;
  id: string | null;
  recordedAt: string;
  observationId: string;
  /** The instance's own lifecycle in Work OS: active | completed | cancelled. */
  workStatus: string | null;
  /** Present only when Work OS could be read for this reference. */
  execution: CoordinationExecution | null;
  /** Open blocks. Empty is "nothing is blocking it", which is a real answer. */
  blockers: readonly CoordinationBlocker[];
  /** Why `execution` is null, when it is. Exactly one reason, never a guess. */
  unknown: CoordinationUnknown | null;
}

/** Somebody the Case asked for something, and what for. */
export interface CoordinatedAsk {
  userId: string;
  contribution: string;
  request: string;
  active: boolean;
  askedAt: string;
}

export interface CaseCoordinationView {
  ruleVersion: string;
  caseId: string;
  /** What the Case asked, of whom. Owned here. */
  asks: readonly CoordinatedAsk[];
  /** What the Case pointed at, and where each stands. Owned by Work OS. */
  work: readonly CoordinatedWork[];
  /**
   * What this read could not establish, in plain sentences.
   *
   * CARRIED, NOT HIDDEN. A Case whose only work reference points at a deleted
   * item must not read as a Case with nothing outstanding.
   */
  notKnown: readonly string[];
}

// --- Derived answers ----------------------------------------------------------------

/**
 * Whether anything the Case asked for is currently late enough to act on.
 *
 * DERIVED FROM WORK OS'S VERDICT, NEVER RE-DECIDED HERE. This reads the flag the
 * execution assessor produced; it does not compare timestamps of its own. Two
 * places computing "is it late" is exactly the duplicate task truth the whole
 * boundary exists to prevent.
 */
export function caseHasEscalationEligibleWork(view: CaseCoordinationView): boolean {
  return view.work.some((w) => w.execution?.escalationEligible === true);
}

export function caseHasReminderEligibleWork(view: CaseCoordinationView): boolean {
  return view.work.some((w) => w.execution?.reminderEligible === true);
}

/** Everything currently blocking anything this Case asked for. */
export function caseBlockers(view: CaseCoordinationView): readonly CoordinationBlocker[] {
  return view.work.flatMap((w) => w.blockers);
}

/**
 * Whether every piece of work this Case pointed at is finished.
 *
 * FALSE WHEN ANYTHING IS UNKNOWN, deliberately. A Case with one completed work
 * item and one that cannot be read is not a Case whose work is done, and
 * answering `true` would let a later auto-resolution close it on the strength of
 * a reference nobody could follow.
 */
export function caseWorkAllComplete(view: CaseCoordinationView): boolean {
  if (view.work.length === 0) return false;
  return view.work.every((w) => w.unknown === null && w.workStatus === 'completed');
}

/**
 * Whether the coordination read is complete enough to reason from.
 *
 * THE GATE ANY LATER AUTOMATION MUST PASS. Auto-resolution, monitoring and
 * all-clear each need to know that Loop could actually see everything it was
 * asked about — not merely that nothing looked wrong.
 */
export function coordinationIsComplete(view: CaseCoordinationView): boolean {
  return view.notKnown.length === 0;
}

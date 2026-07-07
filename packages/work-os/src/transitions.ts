/**
 * Work OS - Transitions and Decision Points
 *
 * A Transition is a declared, directed edge between two stage definitions: work
 * MAY move from stage A to stage B when a guard is satisfied. A DecisionPoint is
 * a branch where one of several transitions is taken based on a recorded
 * decision. Together they let a workflow express sequence, branching, looping,
 * and skipping as data.
 *
 * No engine walks these edges. They are the graph a future runtime would read to
 * answer "what stage is it in?" and "where can it go next?".
 *
 * Pure contracts only.
 */

import type {
  TransitionId,
  DecisionPointId,
  StageDefinitionId,
} from "./workflow-ids";
import type { CriteriaGate } from "./criteria";

/** What kind of movement a transition represents. */
export const TRANSITION_KINDS = [
  "advance",
  "loop_back",
  "skip",
  "branch",
  "cancel",
  "escalate",
] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/**
 * A directed edge between stages. `loop_back` (to an earlier stage) and
 * `skip` (past one or more stages) are first-class kinds, which is how the
 * model answers "can stages loop?" and "can stages be skipped?" declaratively.
 * `guard` is the condition under which the transition is permitted.
 */
export interface Transition {
  readonly id: TransitionId;
  readonly from: StageDefinitionId;
  readonly to: StageDefinitionId;
  readonly kind: TransitionKind;
  /** Condition permitting this transition. Evaluated by a runtime, not here. */
  readonly guard?: CriteriaGate;
  /** Optional label for the edge (e.g. "Rejected", "Needs rework"). */
  readonly label?: string;
}

/** A branch option at a decision point: a choice and the transition it takes. */
export interface DecisionBranch {
  readonly key: string;
  readonly label: string;
  readonly transitionId: TransitionId;
}

/**
 * A DecisionPoint is where a workflow forks. It references a Decision (from
 * governance.ts, by id at the WorkItem level) and enumerates the branches. The
 * model records the possible branches; which one is taken is a recorded
 * Decision, not computed logic here.
 */
export interface DecisionPoint {
  readonly id: DecisionPointId;
  readonly stageId: StageDefinitionId;
  readonly question: string;
  readonly branches: readonly DecisionBranch[];
}

/**
 * Work OS - Workflow State Semantics
 *
 * The spec calls out several named states: Waiting, Completed, Cancelled,
 * Paused, Review. Rather than invent a second parallel status enum (which would
 * duplicate WorkStatus from primitives.ts), the workflow layer defines the set
 * of states a *stage* can express and maps each onto the canonical WorkStatus.
 * This keeps a single source of truth for status while giving the workflow
 * model the vocabulary the spec requires.
 *
 * Everything here is declarative. No state machine executes these; they are the
 * labels a runtime would later interpret.
 *
 * Pure contracts only.
 */

import type { WorkStatus } from "./primitives";

/**
 * The lifecycle states a workflow stage can be in. A superset-friendly list
 * that names the spec's states explicitly while remaining rollup-compatible
 * with WorkStatus.
 */
export const WORKFLOW_STAGE_STATES = [
  "pending",
  "active",
  "review",
  "waiting",
  "blocked",
  "paused",
  "completed",
  "cancelled",
] as const;
export type WorkflowStageState = (typeof WORKFLOW_STAGE_STATES)[number];

/**
 * Declarative mapping from a workflow stage state to the canonical WorkStatus.
 * Expressed as data (a lookup type), not logic, so there is no runtime branch.
 * A consumer reads this to roll a stage state up to the universal status.
 */
export type StageStateToStatus = {
  readonly [S in WorkflowStageState]: WorkStatus;
};

/**
 * The canonical mapping. Declared `as const satisfies` so it is validated
 * against the type at compile time but ships as a plain readonly object of
 * data, not executable logic.
 */
export const STAGE_STATE_STATUS: StageStateToStatus = {
  pending: "todo",
  active: "in_progress",
  review: "in_review",
  waiting: "waiting",
  blocked: "blocked",
  paused: "waiting",
  completed: "done",
  cancelled: "cancelled",
} as const;

/** Whether a stage state is terminal (work leaves the flow at this state). */
export const TERMINAL_STAGE_STATES = ["completed", "cancelled"] as const;
export type TerminalStageState = (typeof TERMINAL_STAGE_STATES)[number];

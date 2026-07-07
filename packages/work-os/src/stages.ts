/**
 * Work OS - Stage Definitions
 *
 * A StageDefinition is the blueprint of a single step in a WorkflowTemplate. It
 * is richer than the structural WorkflowStage (identifiers.ts / structure.ts):
 * where WorkflowStage records where a concrete piece of work sits, a
 * StageDefinition describes how a step COULD behave in the abstract - its
 * execution mode, whether it is optional or skippable or loopable, its gates,
 * and the rules that govern assignment/approval/handoff/escalation.
 *
 * This separation is deliberate and avoids duplication: the two layers describe
 * different things (instance placement vs. reusable blueprint) and are linked by
 * id, never merged.
 *
 * Pure contracts only. No execution mode is executed; these are labels.
 */

import type { StageDefinitionId } from "./workflow-ids";
import type { WorkflowStageState } from "./states";
import type { EntryCriteria, ExitCriteria } from "./criteria";
import type {
  AssignmentRule,
  ApprovalRule,
  HandoffRule,
  EscalationRule,
} from "./rules";

/**
 * How a stage runs relative to its siblings. `sequential` stages run one after
 * another; `parallel` stages may run at the same time as their siblings. This
 * single field is how the model answers "can stages run in parallel?" without
 * any scheduler.
 */
export const STAGE_EXECUTION_MODES = ["sequential", "parallel"] as const;
export type StageExecutionMode = (typeof STAGE_EXECUTION_MODES)[number];

/** Semantic category of a stage, for reporting and default state mapping. */
export const STAGE_KINDS = [
  "work",
  "review",
  "approval",
  "decision",
  "wait",
  "handoff",
  "milestone",
] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/**
 * The reusable blueprint of one workflow step.
 *
 * Booleans answer the spec's capability questions directly and declaratively:
 * - optional / skippable: "can stages be optional / skipped?"
 * - loopable: "can stages loop?" (paired with a loop_back Transition)
 * - executionMode: "can stages run in parallel?"
 * - approval rules with quorum: "can stages require multiple approvals?"
 */
export interface StageDefinition {
  readonly id: StageDefinitionId;
  readonly name: string;
  readonly kind: StageKind;
  /** Order hint within its group. Parallel siblings may share a position. */
  readonly position: number;
  readonly executionMode: StageExecutionMode;

  /** Default lifecycle state this stage begins in. */
  readonly initialState: WorkflowStageState;

  /** Whether the stage may be omitted entirely for some work. */
  readonly optional?: boolean;
  /** Whether the stage may be skipped once entered (via a skip Transition). */
  readonly skippable?: boolean;
  /** Whether work may loop back to this stage (via a loop_back Transition). */
  readonly loopable?: boolean;

  readonly entry?: EntryCriteria;
  readonly exit?: ExitCriteria;

  readonly assignmentRules?: readonly AssignmentRule[];
  readonly approvalRules?: readonly ApprovalRule[];
  readonly handoffRules?: readonly HandoffRule[];
  readonly escalationRules?: readonly EscalationRule[];

  /** Nested child stage ids, e.g. for a parallel group. Composition by id. */
  readonly children?: readonly StageDefinitionId[];
}

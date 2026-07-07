/**
 * Work OS - Workflow Definition Identifiers
 *
 * Branded ids for the workflow *definition* (blueprint) layer introduced by the
 * Workflow Model. These sit alongside the structural WorkflowId /
 * WorkflowStageId from identifiers.ts (which identify a concrete workflow and
 * its placed stages). The definition layer describes how work CAN flow; the
 * structural layer records how a specific piece of work IS flowing.
 *
 * Reuses the shared `Id<B>` brand so there is no new branding mechanism.
 *
 * Pure contracts only.
 */

import type { Id } from "./identifiers";

/** A reusable workflow blueprint (e.g. "Website Build", "Creator Onboarding"). */
export type WorkflowTemplateId = Id<"WorkflowTemplate">;

/** A stage inside a template's definition. */
export type StageDefinitionId = Id<"StageDefinition">;

/** A directed transition between two stage definitions. */
export type TransitionId = Id<"Transition">;

/** A rule that decides assignment/handoff/approval/escalation within a stage. */
export type WorkflowRuleId = Id<"WorkflowRule">;

/** A decision point (branch) inside a workflow. */
export type DecisionPointId = Id<"DecisionPoint">;

/** A named criterion used as entry/exit gate on a stage. */
export type CriterionId = Id<"Criterion">;

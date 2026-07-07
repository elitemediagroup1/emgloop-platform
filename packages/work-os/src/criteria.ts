/**
 * Work OS - Entry / Exit Criteria and Blockers
 *
 * Criteria are the declarative gates on a stage: what must be true to ENTER it
 * and what must be true to LEAVE it. A Blocker is a declared, explainable reason
 * that a stage cannot currently proceed. None of these are evaluated here; they
 * are the conditions a future runtime would check. Storing them as data is what
 * makes "what is blocking it?" and "why is it next?" answerable without an
 * engine.
 *
 * Pure contracts only.
 */

import type { CriterionId } from "./workflow-ids";
import type { WorkItemId } from "./identifiers";

/** The kinds of condition a criterion can express. Provider-neutral. */
export const CRITERION_KINDS = [
  "approval_satisfied",
  "dependency_satisfied",
  "checklist_complete",
  "field_present",
  "decision_made",
  "manual_confirmation",
  "custom",
] as const;
export type CriterionKind = (typeof CRITERION_KINDS)[number];

/**
 * A single declarative condition. `expression` is an opaque, runtime-interpreted
 * predicate descriptor (never executable code here) so the model can express
 * arbitrary gates without embedding logic. `negate` flips the sense of the
 * condition.
 */
export interface Criterion {
  readonly id: CriterionId;
  readonly kind: CriterionKind;
  readonly label: string;
  /** Opaque descriptor a runtime evaluates. Not code, not executed here. */
  readonly expression?: string;
  readonly negate?: boolean;
}

/** How multiple criteria combine when gating a stage. */
export const CRITERIA_COMBINATORS = ["all", "any", "none"] as const;
export type CriteriaCombinator = (typeof CRITERIA_COMBINATORS)[number];

/** A gate is a set of criteria plus how they combine. Used for entry and exit. */
export interface CriteriaGate {
  readonly combinator: CriteriaCombinator;
  readonly criteria: readonly Criterion[];
}

/** Entry criteria: conditions required to enter a stage. */
export type EntryCriteria = CriteriaGate;

/** Exit criteria: conditions required to leave a stage. */
export type ExitCriteria = CriteriaGate;

/** Why a blocker exists, for explainability and escalation routing. */
export const BLOCKER_KINDS = [
  "dependency",
  "approval",
  "missing_input",
  "external",
  "manual_hold",
] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

/**
 * A declared reason a WorkItem cannot currently advance. A Blocker references
 * the work it blocks and, optionally, the required work it is waiting on. It is
 * data the model records, never a computed state.
 */
export interface Blocker {
  readonly kind: BlockerKind;
  readonly reason: string;
  /** The WorkItem that is blocked. */
  readonly workItemId: WorkItemId;
  /** Optional WorkItem being waited on (mirrors Dependency, at stage level). */
  readonly waitingOn?: WorkItemId;
  readonly raisedAt?: string;
  readonly clearedAt?: string;
}

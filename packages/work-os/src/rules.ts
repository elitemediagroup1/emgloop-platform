/**
 * Work OS - Workflow Rules (assignment, approval, escalation, handoff)
 *
 * Rules are the declarative policies attached to a stage that answer the human
 * questions: who owns this now, who receives it next, why, and what approvals
 * are required. Crucially, a rule is a *description of intent*, not an executor.
 * It names WHO by role or reference and WHEN by criteria; it never runs. This is
 * how "Matt then Charlie then Developer then QA then Client" is expressed as
 * data rather than hardcoded logic.
 *
 * Reuses ActorRef, AssignmentRole (from actors.ts) and ApprovalState (from
 * governance.ts) rather than redefining responsibility or approval concepts.
 *
 * Pure contracts only.
 */

import type { WorkflowRuleId, StageDefinitionId } from "./workflow-ids";
import type { ActorRef, AssignmentRole } from "./actors";
import type { CriteriaGate } from "./criteria";

/**
 * How a rule selects the actor(s) it targets. `by_role` keeps the model
 * un-hardcoded: a stage says "assign to the reviewer role", and which concrete
 * actor fills that role is resolved elsewhere at runtime.
 */
export const ACTOR_SELECTOR_KINDS = [
  "by_role",
  "by_reference",
  "by_owner_of",
  "by_capability",
] as const;
export type ActorSelectorKind = (typeof ACTOR_SELECTOR_KINDS)[number];

/**
 * A declarative pointer to "who", resolved at runtime. At most one concrete
 * `actor` is embedded (for by_reference); the other kinds carry a string key
 * (role name, capability key, relation) the runtime resolves. No resolution
 * happens here.
 */
export interface ActorSelector {
  readonly kind: ActorSelectorKind;
  /** Role/capability/relation key for non-reference selectors. */
  readonly key?: string;
  /** Concrete actor for by_reference selectors only. */
  readonly actor?: ActorRef;
}

/** Assignment rule: who a stage assigns work to, and in what role. */
export interface AssignmentRule {
  readonly id: WorkflowRuleId;
  readonly stageId: StageDefinitionId;
  readonly assignTo: ActorSelector;
  readonly role: AssignmentRole;
  /** Optional gate controlling when this assignment applies. */
  readonly when?: CriteriaGate;
}

/** How many approvals a gate needs and from whom. */
export interface ApprovalRule {
  readonly id: WorkflowRuleId;
  readonly stageId: StageDefinitionId;
  readonly approvers: readonly ActorSelector[];
  /** Number of approvals required (defaults to all approvers). Multiple = true. */
  readonly quorum?: number;
  /** Whether approvals must be collected in listed order. */
  readonly ordered?: boolean;
  readonly when?: CriteriaGate;
}

/**
 * Handoff rule: who receives the work when this stage completes, and why. This
 * is the declarative form of "who receives it next" and is what chains actors
 * across stages without embedding a fixed sequence in code.
 */
export interface HandoffRule {
  readonly id: WorkflowRuleId;
  readonly stageId: StageDefinitionId;
  readonly recipient: ActorSelector;
  /** Human-readable reason recorded for explainability ("why"). */
  readonly reason?: string;
  readonly when?: CriteriaGate;
}

/** What triggers an escalation. */
export const ESCALATION_TRIGGERS = [
  "overdue",
  "blocked_too_long",
  "approval_timeout",
  "manual",
] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

/**
 * Escalation rule: when a stage stalls, who it escalates to. Declares the
 * trigger and target only; no timer runs here. A runtime observes the trigger
 * condition and applies the escalation.
 */
export interface EscalationRule {
  readonly id: WorkflowRuleId;
  readonly stageId: StageDefinitionId;
  readonly trigger: EscalationTrigger;
  readonly escalateTo: ActorSelector;
  /** Optional declared threshold (e.g. ISO 8601 duration) the runtime reads. */
  readonly after?: string;
}

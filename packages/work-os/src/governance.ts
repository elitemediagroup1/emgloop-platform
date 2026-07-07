/**
 * Work OS - Approvals and Decisions
 *
 * Approval and Decision are the governance primitives that make the Work OS
 * safe for regulated flows (government contracts, finance) as well as casual
 * ones. An Approval is a requested sign-off with an outcome. A Decision is a
 * recorded choice among options, with rationale, so the "why" behind work is
 * auditable.
 *
 * The Work OS records approvals and decisions; it never *makes* them. Automated
 * decisioning would be Brain territory and is explicitly out of scope.
 *
 * Pure contracts only.
 */

import type {
  ApprovalId,
  DecisionId,
  WorkItemId,
} from "./identifiers";
import type { ActorRef } from "./actors";

/** The state of an approval request. */
export const APPROVAL_STATES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "expired",
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/**
 * A requested sign-off on a WorkItem. `quorum` supports multi-approver gates
 * (e.g. two of three) without an engine: it is a declared requirement that a
 * runtime evaluates later.
 */
export interface Approval {
  readonly id: ApprovalId;
  readonly workItemId: WorkItemId;
  readonly requestedBy: ActorRef;
  readonly approvers: readonly ActorRef[];
  /** Number of approvals required to satisfy the gate. Defaults to all. */
  readonly quorum?: number;
  readonly state: ApprovalState;
  readonly requestedAt: string;
  readonly resolvedAt?: string;
  readonly note?: string;
}

/** A single option under consideration in a Decision. */
export interface DecisionOption {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
}

/** Whether a decision is still open or has been settled. */
export const DECISION_STATES = ["open", "decided", "deferred"] as const;
export type DecisionState = (typeof DECISION_STATES)[number];

/**
 * A recorded choice among options. The chosen option and rationale are stored
 * so any downstream reader can answer "why did we do it this way?". A Decision
 * may link out to a Brain recommendation via DomainLink on its WorkItem, but it
 * never embeds Brain types.
 */
export interface Decision {
  readonly id: DecisionId;
  readonly workItemId: WorkItemId;
  readonly question: string;
  readonly options: readonly DecisionOption[];
  readonly state: DecisionState;
  /** Key of the chosen option, present once state is "decided". */
  readonly chosenKey?: string;
  readonly decidedBy?: ActorRef;
  readonly decidedAt?: string;
  readonly rationale?: string;
}

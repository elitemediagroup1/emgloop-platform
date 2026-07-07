/**
 * Work OS read views.
 *
 * Denormalized, read optimized projections that answer the operational
 * questions every person in the company has: what do I do next, what is
 * assigned to me, what is blocked, what am I waiting on, what approvals do I
 * owe, what am I waiting to be approved, which workflows are active, what is
 * overdue, what unlocks other people, and what changed recently.
 *
 * These are CONTRACTS ONLY. They are the shapes a future runtime would compute
 * and return. This package computes nothing and stores nothing. All entity
 * data is referenced by id or embedded from existing PR #70 / PR #71 types;
 * no entity type is redefined here.
 */

import type {
  WorkItemId,
  WorkspaceId,
  ProjectId,
  WorkflowId,
  WorkflowStageId,
  ApprovalId,
  DependencyId,
  ActorId,
} from "./identifiers";
import type { WorkStatus, WorkPriority, DueDate } from "./primitives";
import type { WorkItem, WorkItemKind } from "./work-item";
import type { ActorRef, AssignmentRole } from "./actors";
import type { Approval, ApprovalState } from "./governance";
import type { Dependency } from "./relationships";
import type { Activity } from "./activity";
import type { WorkflowStageState } from "./states";

/**
 * A lightweight, list ready reference to a work item. It embeds only the
 * fields a caller needs to render a row and decide what to do, avoiding a
 * second lookup while never duplicating the \`WorkItem\` contract.
 */
export interface WorkItemRef {
  readonly id: WorkItemId;
  readonly title: WorkItem["title"];
  readonly kind: WorkItemKind;
  readonly status: WorkStatus;
  readonly priority: WorkPriority;
  readonly due?: DueDate;
  readonly workspaceId?: WorkspaceId;
  readonly projectId?: ProjectId;
  readonly isBlocked: boolean;
  readonly isOverdue: boolean;
}

/**
 * The reason a single item is the recommended next action, expressed as a
 * declarative label plus a human readable rationale. The Brain or a future
 * runtime supplies the reasoning; this shape only carries it.
 */
export const NEXT_ACTION_REASONS = [
  "highest_priority",
  "due_soonest",
  "overdue",
  "unblocks_others",
  "explicitly_assigned",
  "awaiting_your_approval",
  "ready_to_start",
  "continues_in_progress",
] as const;
export type NextActionReason = (typeof NEXT_ACTION_REASONS)[number];

/**
 * A single recommended next action for an actor. \`reason\` names why it is next
 * and \`rationale\` is optional prose. This is a projection, not a decision
 * engine: the recommendation is computed elsewhere.
 */
export interface NextActionView {
  readonly forActor: ActorId;
  readonly item?: WorkItemRef;
  readonly reason?: NextActionReason;
  readonly rationale?: string;
  readonly downstreamCount: number;
  readonly computedAt: string;
}

/**
 * Everything assigned to a single actor, grouped by the assignment role so the
 * caller can separate owned work from review work and delegated work.
 */
export interface MyWorkView {
  readonly forActor: ActorId;
  readonly next?: NextActionView;
  readonly assigned: readonly WorkItemRef[];
  readonly byRole: ReadonlyArray<{
    readonly role: AssignmentRole;
    readonly items: readonly WorkItemRef[];
  }>;
  readonly blockedCount: number;
  readonly waitingCount: number;
  readonly overdueCount: number;
  readonly computedAt: string;
}

/**
 * A single queue rendered for consumption: its ready items in intended order.
 * Ordering is supplied by the caller's query; this view only carries it.
 */
export interface WorkQueueView {
  readonly forActor?: ActorId;
  readonly items: readonly WorkItemRef[];
  readonly readyCount: number;
  readonly totalCount: number;
  readonly computedAt: string;
}

/**
 * One blocked item together with what is blocking it. Blockers are referenced
 * by their existing \`Dependency\` identity, never redefined.
 */
export interface BlockedEntry {
  readonly item: WorkItemRef;
  readonly blockedBy: readonly WorkItemRef[];
  readonly dependencyIds: readonly DependencyId[];
  readonly waitingSince?: string;
}

/**
 * All blocked work in scope, with the blocking relationships attached.
 */
export interface BlockedWorkView {
  readonly forActor?: ActorId;
  readonly entries: readonly BlockedEntry[];
  readonly totalBlocked: number;
  readonly computedAt: string;
}

/**
 * One approval an actor owes: a decision they must make before work proceeds.
 * The approval identity and state come from the existing \`Approval\` contract.
 */
export interface ApprovalTask {
  readonly approvalId: ApprovalId;
  readonly item: WorkItemRef;
  readonly requestedBy: ActorRef;
  readonly requestedAt: Approval["requestedAt"];
  readonly state: ApprovalState;
  readonly unblocksCount: number;
}

/**
 * The set of approvals an actor owes right now. Answers "what approvals do I
 * owe" and, via \`unblocksCount\`, "which of my approvals unblock other people".
 */
export interface ApprovalInboxView {
  readonly forActor: ActorId;
  readonly pending: readonly ApprovalTask[];
  readonly totalPending: number;
  readonly totalUnblocking: number;
  readonly computedAt: string;
}

/**
 * What a caller is passively waiting on: work they own or watch that is stalled
 * on someone or something else. \`waitingOn\` references the responsible actor
 * when known.
 */
export interface WaitingEntry {
  readonly item: WorkItemRef;
  readonly waitingOn?: ActorRef;
  readonly approvalId?: ApprovalId;
  readonly dependencyId?: DependencyId;
  readonly since?: string;
}

/**
 * All items an actor is waiting on, including approvals they requested and
 * dependencies that are not yet satisfied.
 */
export interface WaitingOnView {
  readonly forActor: ActorId;
  readonly entries: readonly WaitingEntry[];
  readonly totalWaiting: number;
  readonly computedAt: string;
}

/**
 * Progress of a single active workflow instance: which stage it is in, how far
 * it has advanced, and whether it is currently stalled in a waiting state.
 * Stage identity and state semantics come from PR #70 / PR #71.
 */
export interface WorkflowProgressEntry {
  readonly workflowId: WorkflowId;
  readonly currentStageId?: WorkflowStageId;
  readonly currentStageState?: WorkflowStageState;
  readonly currentOwner?: ActorRef;
  readonly nextOwner?: ActorRef;
  readonly completedStages: number;
  readonly totalStages: number;
  readonly isWaiting: boolean;
  readonly isBlocked: boolean;
  readonly stalledSince?: string;
}

/**
 * All active workflows in scope. Answers "what workflows are active" and, by
 * filtering on \`isWaiting\`, "which workflows are stuck in waiting".
 */
export interface WorkflowProgressView {
  readonly entries: readonly WorkflowProgressEntry[];
  readonly activeCount: number;
  readonly waitingCount: number;
  readonly blockedCount: number;
  readonly computedAt: string;
}

/**
 * A recent change feed. Each entry references an existing \`Activity\` by id and
 * carries a resolved actor and target for display; the \`Activity\` contract is
 * not redefined here.
 */
export interface WorkActivityEntry {
  readonly activityId: Activity["id"];
  readonly verb: Activity["verb"];
  readonly actor: ActorRef;
  readonly item?: WorkItemRef;
  readonly occurredAt: string;
}

/**
 * The "what changed recently" view for a scope or a single actor.
 */
export interface WorkActivityView {
  readonly forActor?: ActorId;
  readonly entries: readonly WorkActivityEntry[];
  readonly totalCount: number;
  readonly computedAt: string;
}

/**
 * A per actor workload summary used to answer "who is overloaded" and to
 * balance handoffs. Counts only; no scheduling logic lives here.
 */
export interface WorkloadEntry {
  readonly actor: ActorRef;
  readonly openCount: number;
  readonly inProgressCount: number;
  readonly blockedCount: number;
  readonly overdueCount: number;
  readonly approvalsOwed: number;
  readonly unblocksOthersCount: number;
}

/**
 * Workload across a team. Answers "what is the highest priority for the team"
 * indirectly by exposing where work and approvals are concentrated.
 */
export interface TeamWorkloadView {
  readonly workspaceId?: WorkspaceId;
  readonly entries: readonly WorkloadEntry[];
  readonly unassignedCount: number;
  readonly computedAt: string;
}

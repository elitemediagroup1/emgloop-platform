/**
 * Work OS - The WorkItem (universal unit of execution)
 *
 * WorkItem is the heart of the model. Everything that can be executed is a
 * WorkItem: a Task is a WorkItem, a Milestone references WorkItems, an Approval
 * hangs off a WorkItem. By making one universal unit rather than a dozen
 * bespoke ones, the same queues, notifications, dependencies, and links work
 * for every use case: website builds, creator management, government contracts,
 * CRM onboarding, marketplace investigations, sales, marketing, internal ops,
 * personal tasks, and future products.
 *
 * A WorkItem is capable of: being assigned, approved, blocked, dependent,
 * watched, commented on, and attached to Brain / Marketplace / CRM / Creator /
 * Business. Those capabilities are expressed as related entities keyed by
 * WorkItemId, not as embedded arrays, so the core stays lean and the sub-
 * entities can be loaded on demand at runtime.
 *
 * Pure contracts only. No methods, no persistence, no runtime.
 */

import type { TenantScope, Metadata } from "@emgloop/shared";
import type {
  WorkItemId,
  WorkspaceId,
  ProjectId,
  WorkflowStageId,
  QueueId,
  MilestoneId,
} from "./identifiers";
import type { WorkStatus, WorkPriority, Timing } from "./primitives";
import type { Owner, ActorRef } from "./actors";
import type { DomainLinkSet } from "./links";

/**
 * The nature of a WorkItem. `task` is the everyday atom; the others let the
 * universal unit stand in for higher-order work without new top-level entities.
 * "custom" keeps the model open for future kinds.
 */
export const WORK_ITEM_KINDS = [
  "task",
  "subtask",
  "approval_item",
  "decision_item",
  "review",
  "milestone_item",
  "custom",
] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

/**
 * The canonical WorkItem. Sub-entities (comments, checklists, attachments,
 * assignments, watchers, dependencies, approvals, decisions, activity) are
 * associated by WorkItemId rather than embedded, keeping this record small and
 * composable. Denormalized convenience fields (owner, status, priority) live
 * here because they drive queues and filtering directly.
 */
export interface WorkItem {
  readonly id: WorkItemId;
  readonly tenant: TenantScope;
  readonly kind: WorkItemKind;

  readonly title: string;
  readonly description?: string;

  /** Structural placement. A WorkItem always belongs to a Workspace. */
  readonly workspaceId: WorkspaceId;
  readonly projectId?: ProjectId;
  readonly stageId?: WorkflowStageId;
  readonly queueId?: QueueId;
  readonly milestoneId?: MilestoneId;
  /** Parent WorkItem for subtask nesting. */
  readonly parentId?: WorkItemId;

  /** Execution state. Set by callers / the Brain; never derived here. */
  readonly status: WorkStatus;
  readonly priority: WorkPriority;
  readonly timing?: Timing;

  /** The single accountable actor. */
  readonly owner?: Owner;
  /** Denormalized current assignees, for quick "who is on this" reads. */
  readonly assignees?: readonly ActorRef[];

  /** Outward links to other Loop domains. Reference-only, never embedded types. */
  readonly links?: DomainLinkSet;

  readonly createdAt: string;
  readonly createdBy?: ActorRef;
  readonly updatedAt?: string;

  /** Open, tenant-defined metadata bag from @emgloop/shared. */
  readonly metadata?: Metadata;
}

/**
 * Work OS - Structural Containers
 *
 * Workspace, Project, Workflow, WorkflowStage, Milestone, and Queue are the
 * scaffolding that WorkItems live inside. They are deliberately thin: a
 * Workflow is a named, ordered set of Stages (a template of "how work moves"),
 * not an execution engine. A Queue is a saved lens over WorkItems ("what do I
 * do next"), not a runtime scheduler.
 *
 * Pure contracts only.
 */

import type { TenantScope, Metadata } from "@emgloop/shared";
import type {
  WorkspaceId,
  ProjectId,
  WorkflowId,
  WorkflowStageId,
  MilestoneId,
  QueueId,
  WorkItemId,
  ActorId,
} from "./identifiers";
import type { WorkStatus, WorkPriority, DueDate } from "./primitives";
import type { Owner } from "./actors";

/**
 * The top-level container. A Workspace scopes a body of work for a tenant
 * (e.g. "Website", "Government Contracts", "Personal"). It is the universal
 * boundary that makes the same engine serve many products.
 */
export interface Workspace {
  readonly id: WorkspaceId;
  readonly tenant: TenantScope;
  readonly name: string;
  readonly description?: string;
  readonly owner?: Owner;
  readonly archived?: boolean;
  readonly createdAt: string;
  readonly metadata?: Metadata;
}

/** A bounded body of related WorkItems inside a Workspace. */
export interface Project {
  readonly id: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly description?: string;
  readonly owner?: Owner;
  /** Optional workflow this project's items move through. */
  readonly workflowId?: WorkflowId;
  readonly status?: WorkStatus;
  readonly priority?: WorkPriority;
  readonly targetDate?: DueDate;
  readonly archived?: boolean;
  readonly createdAt: string;
  readonly metadata?: Metadata;
}

/**
 * A single stage in a Workflow. Stages carry the human label of "where in the
 * pipeline" a WorkItem sits and map onto the universal WorkStatus for rollup.
 * Order is explicit via `position`; no engine sequences them.
 */
export interface WorkflowStage {
  readonly id: WorkflowStageId;
  readonly workflowId: WorkflowId;
  readonly name: string;
  readonly position: number;
  /** The universal status this stage rolls up to. */
  readonly maps_to: WorkStatus;
  /** Whether entering this stage requires an Approval to be satisfied. */
  readonly requiresApproval?: boolean;
  /** Whether this is a terminal stage (work leaves the flow here). */
  readonly terminal?: boolean;
}

/**
 * A named, ordered template of Stages describing HOW work moves. Reusable
 * across projects. A Workflow is data, not runtime; nothing here executes a
 * transition.
 */
export interface Workflow {
  readonly id: WorkflowId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly description?: string;
  readonly stages: readonly WorkflowStage[];
  readonly archived?: boolean;
  readonly createdAt: string;
  readonly metadata?: Metadata;
}

/**
 * A meaningful checkpoint that groups WorkItems toward an outcome/date. A
 * Milestone references its WorkItems by id; it does not own them, so an item can
 * contribute to reporting without being duplicated.
 */
export interface Milestone {
  readonly id: MilestoneId;
  readonly workspaceId: WorkspaceId;
  readonly projectId?: ProjectId;
  readonly name: string;
  readonly due?: DueDate;
  readonly workItemIds: readonly WorkItemId[];
  readonly reachedAt?: string;
  readonly createdAt: string;
}

/** How a Queue selects and orders WorkItems. Declarative, not executable. */
export interface QueueRule {
  /** Field-oriented filter clauses, interpreted by a runtime, not here. */
  readonly filter?: Readonly<Record<string, unknown>>;
  /** Ordered list of sort keys, e.g. ["priority", "due"]. */
  readonly orderBy?: readonly string[];
}

/**
 * A Queue is a saved lens that answers "what do I do next?". It is a definition
 * (rule) plus optional pinned items, never a materialized list. The engine that
 * resolves a Queue into concrete WorkItems is a future runtime concern.
 */
export interface Queue {
  readonly id: QueueId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly rule: QueueRule;
  /** Actor whose "next" this queue represents, if personal. */
  readonly ownerId?: ActorId;
  readonly pinned?: readonly WorkItemId[];
  readonly createdAt: string;
}

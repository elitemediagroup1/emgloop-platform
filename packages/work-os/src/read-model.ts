/**
 * Work OS read model facade.
 *
 * A single declarative description of the read surface a future Work OS runtime
 * is expected to expose. It is a contract, not an implementation: every member
 * is a shape, and no member is a callable. A runtime, a UI, or the Brain can
 * all target this same read model, guaranteeing they see identical work.
 *
 * Nothing here executes. There is no data access, no caching, no runtime. The
 * runtime that satisfies this contract lives outside this contracts package and
 * will be introduced only by a later, separately approved implementation PR.
 */

import type { ActorId, WorkspaceId } from "./identifiers";
import type { WorkSearchQuery, WorkQueryResult } from "./query";
import type {
  MyWorkView,
  NextActionView,
  WorkQueueView,
  BlockedWorkView,
  ApprovalInboxView,
  WaitingOnView,
  WorkflowProgressView,
  WorkActivityView,
  TeamWorkloadView,
  WorkItemRef,
} from "./read-views";

/**
 * Names the read views this package defines. Useful for capability discovery
 * and for a runtime to advertise which projections it can serve.
 */
export const WORK_READ_VIEWS = [
  "my_work",
  "next_action",
  "work_queue",
  "blocked_work",
  "approval_inbox",
  "waiting_on",
  "workflow_progress",
  "work_activity",
  "team_workload",
] as const;
export type WorkReadViewName = (typeof WORK_READ_VIEWS)[number];

/**
 * The parameters a caller supplies to request a read view. Declarative context
 * only: who is asking and in what scope. It carries no behavior.
 */
export interface ReadContext {
  readonly forActor: ActorId;
  readonly workspaceId?: WorkspaceId;
}

/**
 * The complete Work OS read surface, described as data shapes keyed by view.
 *
 * This is intentionally a mapping of view name to the shape that view returns,
 * NOT an interface of methods. Keeping it declarative preserves the package's
 * contracts only guarantee: consumers depend on the shape of what they will
 * receive, while the mechanism of retrieval is defined by a future runtime.
 */
export interface WorkReadModel {
  readonly context: ReadContext;
  readonly views: {
    readonly my_work: MyWorkView;
    readonly next_action: NextActionView;
    readonly work_queue: WorkQueueView;
    readonly blocked_work: BlockedWorkView;
    readonly approval_inbox: ApprovalInboxView;
    readonly waiting_on: WaitingOnView;
    readonly workflow_progress: WorkflowProgressView;
    readonly work_activity: WorkActivityView;
    readonly team_workload: TeamWorkloadView;
  };
  readonly search: {
    readonly query: WorkSearchQuery;
    readonly result: WorkQueryResult<WorkItemRef>;
  };
}

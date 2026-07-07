/**
 * Work OS query contracts.
 *
 * Declarative shapes that describe HOW work is filtered, sorted, and paged.
 * These are contracts only: no query builder, no execution, no data access.
 * A future runtime is expected to accept a \`WorkSearchQuery\` and return a
 * \`WorkQueryResult\`; this package only defines the shapes, never the mechanism.
 */

import type {
  WorkspaceId,
  ProjectId,
  WorkItemId,
  QueueId,
  MilestoneId,
  WorkflowId,
  ActorId,
} from "./identifiers";
import type { WorkStatus, WorkPriority } from "./primitives";
import type { WorkItemKind } from "./work-item";
import type { AssignmentRole } from "./actors";
import type { LinkDomain } from "./links";

/**
 * Comparison operators available to a declarative filter clause. These name
 * intent only; no comparison is performed inside this package.
 */
export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "in",
  "not_in",
  "lt",
  "lte",
  "gt",
  "gte",
  "exists",
  "is_null",
  "before",
  "after",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/**
 * Fields a caller may filter or sort work by. Provider neutral and stable:
 * these are logical work attributes, never storage columns.
 */
export const WORK_FIELDS = [
  "status",
  "priority",
  "kind",
  "workspaceId",
  "projectId",
  "queueId",
  "milestoneId",
  "workflowId",
  "stageId",
  "ownerId",
  "assigneeId",
  "watcherId",
  "dueAt",
  "startAt",
  "completedAt",
  "createdAt",
  "updatedAt",
  "isBlocked",
  "isOverdue",
  "linkDomain",
] as const;
export type WorkField = (typeof WORK_FIELDS)[number];

/**
 * A single declarative predicate over a work field. The \`value\` is opaque to
 * this package; interpretation belongs to a future runtime.
 */
export interface FilterClause {
  readonly field: WorkField;
  readonly operator: FilterOperator;
  readonly value?: unknown;
}

/**
 * How multiple clauses combine. Declarative only.
 */
export const FILTER_COMBINATORS = ["all", "any", "none"] as const;
export type FilterCombinator = (typeof FILTER_COMBINATORS)[number];

/**
 * A tree of predicates. \`combinator\` describes how \`clauses\` and nested
 * \`groups\` are combined, without prescribing evaluation order.
 */
export interface WorkFilter {
  readonly combinator: FilterCombinator;
  readonly clauses?: readonly FilterClause[];
  readonly groups?: readonly WorkFilter[];
}

/**
 * Sort direction.
 */
export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/**
 * A single declarative sort key. Multiple keys are applied in array order.
 */
export interface WorkSort {
  readonly field: WorkField;
  readonly direction: SortDirection;
}

/**
 * Cursor based paging request. Cursors are opaque tokens minted by a future
 * runtime; this package treats them as strings and never generates them.
 */
export interface WorkPage {
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * A complete, declarative work query. It composes an optional scope, a filter
 * tree, sort order, and paging. It contains no logic and performs no work.
 */
export interface WorkSearchQuery {
  readonly workspaceId?: WorkspaceId;
  readonly projectId?: ProjectId;
  readonly queueId?: QueueId;
  readonly milestoneId?: MilestoneId;
  readonly workflowId?: WorkflowId;
  readonly forActor?: ActorId;
  readonly kinds?: readonly WorkItemKind[];
  readonly statuses?: readonly WorkStatus[];
  readonly priorities?: readonly WorkPriority[];
  readonly assignmentRoles?: readonly AssignmentRole[];
  readonly linkDomains?: readonly LinkDomain[];
  readonly filter?: WorkFilter;
  readonly sort?: readonly WorkSort[];
  readonly page?: WorkPage;
}

/**
 * Envelope returned for a query. Generic over the row shape so the same
 * contract serves item lists and any of the read views in this package.
 */
export interface WorkQueryResult<TRow> {
  readonly rows: readonly TRow[];
  readonly total?: number;
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  readonly ids: readonly WorkItemId[];
}

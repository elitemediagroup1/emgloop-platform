/**
 * Work OS - Canonical Identifiers
 *
 * Branded string identifiers for every core entity. Branding keeps the type
 * system honest: a TaskId can never be silently used where a ProjectId is
 * expected, even though both are strings at runtime.
 *
 * Pure contracts only. No runtime logic.
 */

/** Opaque, branded identifier. `B` is a phantom tag; the value is a string. */
export type Id<B extends string> = string & { readonly __brand: B };

export type WorkspaceId = Id<"Workspace">;
export type ProjectId = Id<"Project">;
export type WorkflowId = Id<"Workflow">;
export type WorkflowStageId = Id<"WorkflowStage">;
export type WorkItemId = Id<"WorkItem">;
export type TaskId = Id<"Task">;
export type ApprovalId = Id<"Approval">;
export type DecisionId = Id<"Decision">;
export type DependencyId = Id<"Dependency">;
export type MilestoneId = Id<"Milestone">;
export type QueueId = Id<"Queue">;
export type AssignmentId = Id<"Assignment">;
export type CommentId = Id<"Comment">;
export type ChecklistId = Id<"Checklist">;
export type ChecklistItemId = Id<"ChecklistItem">;
export type AttachmentId = Id<"Attachment">;
export type ActivityId = Id<"Activity">;
export type NotificationId = Id<"Notification">;
export type WatcherId = Id<"Watcher">;
export type RelationshipId = Id<"Relationship">;

/**
 * Actor identifier. An actor is anyone or anything that can own, be assigned,
 * watch, comment, or act: a human user, a team, or an automated system. Kept
 * as a distinct brand so ownership and assignment stay actor-typed rather than
 * user-typed, which is what makes the model universal.
 */
export type ActorId = Id<"Actor">;
export type TeamId = Id<"Team">;
export type UserId = Id<"User">;

/**
 * External entity identifier. Work items connect outward to other Loop domains
 * (Brain, Marketplace, CRM, Creator, Business) without importing their types.
 * Those domains are referenced by id + kind only, keeping this package neutral
 * and free of duplication.
 */
export type ExternalId = Id<"External">;

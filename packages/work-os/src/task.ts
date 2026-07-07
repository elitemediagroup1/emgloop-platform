/**
 * Work OS - Task
 *
 * Task is the most common WorkItem and is modeled as a semantic alias rather
 * than a parallel entity. This is a deliberate anti-duplication choice: a Task
 * is simply a WorkItem whose kind is "task" or "subtask", so it inherits every
 * capability (assignment, approval, blocking, watching, comments, links) for
 * free. Introducing a separate Task interface would fork the model and is
 * exactly what this package avoids.
 *
 * Pure contracts only.
 */

import type { WorkItem, WorkItemKind } from "./work-item";

/** The subset of WorkItemKind values that read naturally as a "task". */
export type TaskKind = Extract<WorkItemKind, "task" | "subtask">;

/**
 * A Task is a WorkItem narrowed to a task-like kind. Same shape, same
 * capabilities, no new fields. Callers that specifically deal in tasks can use
 * this alias for intent without diverging the data model.
 */
export type Task = WorkItem & { readonly kind: TaskKind };

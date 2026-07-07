/**
 * Work OS - Shared Primitives
 *
 * Small, universal value types shared by every entity. These are execution-
 * domain primitives (status of work, priority of work, timing of work). They
 * are intentionally distinct from Brain's cognitive primitives (confidence,
 * evidence) and Marketplace's measurement primitives (trend, health). The Work
 * OS is the layer that *executes*; these types describe execution, not
 * intelligence.
 *
 * Pure contracts only.
 */

/**
 * Canonical lifecycle status for any WorkItem. Deliberately generic so it can
 * describe a website build task, a government contract milestone, or a personal
 * to-do. Stage-specific labels live on WorkflowStage; this is the universal
 * rollup state used for filtering, queues, and reporting.
 */
export const WORK_STATUSES = [
  "draft",
  "todo",
  "in_progress",
  "blocked",
  "waiting",
  "in_review",
  "approved",
  "done",
  "cancelled",
  "archived",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/** Ordinal weight for a WorkStatus, useful for sorting without runtime logic. */
export type StatusCategory = "open" | "active" | "paused" | "closed";

/**
 * Priority is a bounded ordinal scale. The *ordering* is meaningful (higher =
 * more urgent) but the Work OS never computes priority itself. The Brain
 * determines priority; the Work OS records and executes it. This separation is
 * why WorkPriority is a plain data field, never a derived value here.
 */
export const WORK_PRIORITIES = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
  "critical",
] as const;
export type WorkPriority = (typeof WORK_PRIORITIES)[number];

/**
 * DueDate is a value object, not a bare timestamp, so timing semantics stay
 * explicit. A due date can be hard (a real deadline) or soft (a target). Both
 * are ISO 8601 strings; the Work OS stores no Date objects and does no clock
 * math (that is runtime logic, out of scope for a contracts package).
 */
export interface DueDate {
  /** ISO 8601 timestamp the work is due by. */
  readonly at: string;
  /** Whether missing this date is a real failure or just a target. */
  readonly kind: "hard" | "soft";
  /** Optional IANA timezone the date was authored in. */
  readonly timezone?: string;
}

/** Confidence-free timing envelope common to schedulable entities. */
export interface Timing {
  readonly startAt?: string;
  readonly due?: DueDate;
  readonly completedAt?: string;
}

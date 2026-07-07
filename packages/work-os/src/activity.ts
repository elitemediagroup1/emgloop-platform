/**
 * Work OS - Activity and Notifications
 *
 * Activity is the append-only record of what happened to a WorkItem; it powers
 * audit and the "why is it next" explanation. Notification is the delivery of a
 * relevant Activity to a Watcher. Both are contracts only: the Work OS defines
 * the shape of an event, it does not emit, queue, or deliver anything (that is
 * runtime).
 *
 * Note: this Activity is Work-OS scoped (task/work lifecycle). It is distinct
 * from Brain Activity (cognitive events) and from shared LoopEventType (the
 * platform event bus). A WorkItem links OUT to Brain Activity via DomainLink;
 * it does not redefine it.
 *
 * Pure contracts only.
 */

import type {
  ActivityId,
  NotificationId,
  WatcherId,
  WorkItemId,
} from "./identifiers";
import type { ActorRef } from "./actors";

/** Lifecycle verbs describing what happened to a WorkItem. */
export const ACTIVITY_VERBS = [
  "created",
  "updated",
  "status_changed",
  "assigned",
  "reassigned",
  "handed_off",
  "commented",
  "blocked",
  "unblocked",
  "approved",
  "rejected",
  "completed",
  "reopened",
  "linked",
  "attached",
] as const;
export type ActivityVerb = (typeof ACTIVITY_VERBS)[number];

/**
 * An immutable record of a single change. `data` is an open, JSON-serializable
 * bag for verb-specific detail (e.g. from/to status). It is intentionally
 * loosely typed here because the Work OS records events; interpreting them is a
 * runtime concern.
 */
export interface Activity {
  readonly id: ActivityId;
  readonly workItemId: WorkItemId;
  readonly verb: ActivityVerb;
  readonly actor: ActorRef;
  readonly at: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Delivery channels a Notification may target. Provider-neutral. */
export const NOTIFICATION_CHANNELS = [
  "in_app",
  "email",
  "push",
  "digest",
] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * A Notification pairs an Activity with a recipient Watcher. The Work OS models
 * that a notification is WARRANTED; whether and how it is sent is a runtime
 * concern outside this package.
 */
export interface Notification {
  readonly id: NotificationId;
  readonly watcherId: WatcherId;
  readonly recipient: ActorRef;
  readonly activityId: ActivityId;
  readonly workItemId: WorkItemId;
  readonly channel: NotificationChannel;
  readonly readAt?: string;
  readonly createdAt: string;
}

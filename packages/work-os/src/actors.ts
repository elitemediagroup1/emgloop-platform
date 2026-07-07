/**
 * Work OS - Actors, Ownership, Assignment, Watchers
 *
 * The Work OS answers questions like "who does this next?" and "who receives
 * this after me?". To do that universally it never hard-codes "user". Instead
 * every responsible party is an Actor: a human, a team, or an automated system.
 * This is what lets the same model drive personal tasks and government
 * contracts alike.
 *
 * Pure contracts only.
 */

import type { ActorId, AssignmentId, WatcherId, WorkItemId } from "./identifiers";

/** The kinds of thing that can hold responsibility in the Work OS. */
export const ACTOR_KINDS = ["user", "team", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * A reference to a responsible party. Only an id + kind (+ optional label for
 * display) so the Work OS never owns identity. Identity, roles, and permissions
 * live in @emgloop/shared; this package references actors, it does not define
 * them.
 */
export interface ActorRef {
  readonly id: ActorId;
  readonly kind: ActorKind;
  /** Optional denormalized display label. Never authoritative. */
  readonly label?: string;
}

/**
 * Owner is the single accountable actor for a WorkItem ("the buck stops here").
 * Distinct from assignees: there is exactly one owner, but there can be many
 * assignees. Owner answers "who is ultimately responsible", assignment answers
 * "who is doing it right now".
 */
export interface Owner {
  readonly actor: ActorRef;
  readonly since?: string;
}

/** The role an assignee plays on a WorkItem within a given assignment. */
export const ASSIGNMENT_ROLES = [
  "doer",
  "reviewer",
  "approver",
  "collaborator",
  "recipient",
] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

/**
 * Assignment binds an actor to a WorkItem in a specific role, at a specific
 * position in the flow. The `handoffTo` field is how the Work OS models "who
 * receives this after me" without a workflow engine: it is declared data, not
 * executed logic.
 */
export interface Assignment {
  readonly id: AssignmentId;
  readonly workItemId: WorkItemId;
  readonly actor: ActorRef;
  readonly role: AssignmentRole;
  readonly assignedAt: string;
  readonly assignedBy?: ActorRef;
  /** The next actor this work is declared to flow to. */
  readonly handoffTo?: ActorRef;
  readonly acceptedAt?: string;
}

/** How a watcher came to watch, so notifications can be tuned downstream. */
export const WATCH_REASONS = [
  "owner",
  "assignee",
  "mentioned",
  "subscribed",
  "manual",
] as const;
export type WatchReason = (typeof WATCH_REASONS)[number];

/** A watcher receives notifications about a WorkItem without owning it. */
export interface Watcher {
  readonly id: WatcherId;
  readonly workItemId: WorkItemId;
  readonly actor: ActorRef;
  readonly reason: WatchReason;
  readonly since: string;
}

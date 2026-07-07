/**
 * Work OS - Relationships, Dependencies, Blocking
 *
 * The questions "what is blocked?" and "what am I waiting on?" are answered by
 * declared relationships between WorkItems. These are DATA, not a scheduler.
 * The Work OS records that A blocks B; it does not run a graph engine to resolve
 * the order. Resolution is a future runtime concern deliberately excluded here.
 *
 * Pure contracts only.
 */

import type {
  DependencyId,
  RelationshipId,
  WorkItemId,
} from "./identifiers";

/**
 * Directed relationship kinds between two WorkItems. `blocks` / `blocked_by`
 * are inverses; a well-formed dataset stores one side and derives the other at
 * read time (derivation is a runtime concern, not modeled here).
 */
export const RELATIONSHIP_KINDS = [
  "blocks",
  "blocked_by",
  "depends_on",
  "duplicates",
  "relates_to",
  "parent_of",
  "child_of",
  "follows",
  "precedes",
] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

/** A directed edge from one WorkItem to another. */
export interface Relationship {
  readonly id: RelationshipId;
  readonly from: WorkItemId;
  readonly to: WorkItemId;
  readonly kind: RelationshipKind;
  readonly createdAt?: string;
}

/** Why a dependency exists, for explainability ("why is it next / blocked?"). */
export const DEPENDENCY_TYPES = [
  "hard",
  "soft",
  "resource",
  "approval",
] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

/**
 * Dependency is a first-class, explainable form of "blocked_by". It records not
 * just that B waits on A, but why, and whether it is satisfied. This is the
 * data the execution layer reads to answer "what is blocked?" without any
 * engine.
 */
export interface Dependency {
  readonly id: DependencyId;
  /** The WorkItem that is waiting. */
  readonly dependentId: WorkItemId;
  /** The WorkItem being waited on. */
  readonly requiredId: WorkItemId;
  readonly type: DependencyType;
  readonly satisfied: boolean;
  /** Human-readable reason, e.g. "needs legal approval first". */
  readonly reason?: string;
}

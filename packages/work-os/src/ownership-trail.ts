/**
 * Work OS - Ownership Trail
 *
 * The spec asks the model to answer "who owns this now?", "who owned it
 * before?", and "who receives it next?". Current ownership already lives on
 * WorkItem (Owner) and next-recipient intent lives on Assignment.handoffTo and
 * HandoffRule. What remains is the historical chain: an ordered, append-only
 * trail of past custody. That is modeled here as declarative data - a list of
 * spans - not as behavior.
 *
 * Reuses ActorRef (actors.ts) and StageDefinitionId (workflow-ids.ts) rather
 * than redefining actors or stages.
 *
 * Pure contracts only.
 */

import type { ActorRef } from "./actors";
import type { WorkItemId } from "./identifiers";
import type { StageDefinitionId } from "./workflow-ids";

/**
 * A single span of custody: an actor held this WorkItem, in a given stage, for a
 * bounded time, then handed it to the next actor. Chaining these answers "who
 * owned it before" and, read forward, "who receives it next".
 */
export interface CustodySpan {
  readonly workItemId: WorkItemId;
  readonly actor: ActorRef;
  readonly stageId?: StageDefinitionId;
  readonly receivedAt: string;
  readonly releasedAt?: string;
  /** The actor this custody was handed to next, if any. */
  readonly handedTo?: ActorRef;
  /** Human-readable reason for the handoff ("why"). */
  readonly reason?: string;
}

/**
 * The full ordered custody history for a WorkItem. Element 0 is the earliest
 * owner; the last element without a `releasedAt` is the current owner. This is
 * a read model shape, populated by a runtime; the Work OS only defines it.
 */
export interface OwnershipTrail {
  readonly workItemId: WorkItemId;
  readonly spans: readonly CustodySpan[];
}

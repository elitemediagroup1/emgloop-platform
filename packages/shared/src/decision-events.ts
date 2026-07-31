// The Decision Event Contract, v1 — what leaves the Decision Engine, and what a
// subscriber may rely on.
//
// WHY THIS IS CODE AND NOT A MARKDOWN DOCUMENT. `EVENT_BUS.md` describes a bus
// that was never built, and three other docs now cite it. A prose contract for an
// event stream is the same failure waiting to happen: it cannot be imported, it
// cannot be type-checked, and nothing fails when the code and the prose disagree.
// This file is the contract. `docs/architecture/decision-events.md` points AT it
// and restates nothing.
//
// The same anti-drift device as `decision-contract.ts`: the map below is TOTAL
// over `ObservationType`, so a new observation type does not compile until
// somebody decides what the world gets told. `packages/database` types its own
// map against the Prisma enum using these names, so an event name that does not
// exist here is a compile error rather than a subscriber that silently never
// fires. Tests then walk it in both directions.
//
// PRISMA-FREE, deliberately. Subscribers depend on the contract, never on
// persistence — the same rule `cognitive-context.ts` follows.
//
// WHAT THIS FILE DOES NOT DO: it does not claim events are delivered. Read
// `DELIVERY_GUARANTEES` before building a subscriber. As of v1 the single most
// important entry is NOT_BUILT.

import type { ObservationType, PriorityState, OperationalOutcome } from './operational-lifecycle';
import { OBSERVATION_TYPES } from './operational-lifecycle';

export const DECISION_EVENT_CONTRACT_VERSION = 'decision-events.v1';

// --- The vocabulary -----------------------------------------------------------

export const DECISION_EVENT_NAMES = [
  'DecisionCreated',
  'DecisionObserved',
  'DecisionReopened',
  'DecisionReviewed',
  'DecisionAssigned',
  'DecisionUnassigned',
  'DecisionOwnerChanged',
  'DecisionPriorityChanged',
  'DecisionSeverityChanged',
  'DecisionEvidenceAdded',
  'DecisionWatched',
  'DecisionUnwatched',
  'DecisionNoteAdded',
  'DecisionProgressRecorded',
  'DecisionEscalated',
  'DecisionOutcomeRecorded',
  'DecisionResolved',
  'DecisionClosed',
] as const;

export type DecisionEventName = (typeof DECISION_EVENT_NAMES)[number];

export function isDecisionEventName(value: string): value is DecisionEventName {
  return (DECISION_EVENT_NAMES as readonly string[]).includes(value);
}

/**
 * The event a given observation announces. THE canonical map — `packages/database`
 * consumes this rather than declaring its own.
 *
 * Total rather than a lookup with a fallback: a new observation type must force a
 * deliberate decision about what the world gets told, at compile time rather than
 * in production as a silently unpublished change.
 *
 * Note the shape of the collapses, because they are contract, not accident:
 *   · ASSIGNED and REASSIGNED both announce `DecisionAssigned`. A subscriber that
 *     needs to tell a first assignment from a handover reads `changeType`, which
 *     carries the observation type verbatim.
 *   · The four contact/response types collapse to `DecisionProgressRecorded`.
 *     Somebody moved it forward; the specific move is on the observation.
 *   · DISMISSED announces `DecisionClosed`, NOT `DecisionDismissed`. There is no
 *     `DecisionDismissed` event and never has been.
 *
 * THERE IS NO `DecisionMerged` EVENT. Merging is an OUTCOME (`MERGED`), recorded
 * by a resolve or an ignore, so a merge arrives as `DecisionResolved` or
 * `DecisionClosed` carrying `outcome: 'MERGED'`. A subscriber that switches on a
 * `DecisionMerged` event will never fire.
 */
export const DECISION_EVENT_TYPE: Record<ObservationType, DecisionEventName> = {
  SITUATION_DETECTED: 'DecisionCreated',
  SITUATION_RESIGHTED: 'DecisionObserved',
  REOPENED: 'DecisionReopened',
  REVIEWED: 'DecisionReviewed',
  ASSIGNED: 'DecisionAssigned',
  REASSIGNED: 'DecisionAssigned',
  UNASSIGNED: 'DecisionUnassigned',
  OWNER_CHANGED: 'DecisionOwnerChanged',
  PRIORITY_CHANGED: 'DecisionPriorityChanged',
  SEVERITY_CHANGED: 'DecisionSeverityChanged',
  EVIDENCE_ADDED: 'DecisionEvidenceAdded',
  WATCH_STARTED: 'DecisionWatched',
  WATCH_STOPPED: 'DecisionUnwatched',
  NOTE_ADDED: 'DecisionNoteAdded',
  CONTACT_ATTEMPTED: 'DecisionProgressRecorded',
  CONTACT_COMPLETED: 'DecisionProgressRecorded',
  AWAITING_RESPONSE: 'DecisionProgressRecorded',
  RESPONSE_RECEIVED: 'DecisionProgressRecorded',
  ESCALATED: 'DecisionEscalated',
  OUTCOME_RECORDED: 'DecisionOutcomeRecorded',
  RESOLVED: 'DecisionResolved',
  DISMISSED: 'DecisionClosed',
};

/** Which observation types announce a given event. Derived, never hand-listed. */
export function observationTypesFor(event: DecisionEventName): ObservationType[] {
  return OBSERVATION_TYPES.filter((t) => DECISION_EVENT_TYPE[t] === event);
}

// --- The payload --------------------------------------------------------------

/**
 * What every decision event carries. Identical for all event names — the name and
 * `changeType` say what happened; this says where the decision now stands.
 *
 * DELIBERATELY CARRIES NO BUSINESS CONTENT. No title, no severity, no impact, no
 * evidence. Two reasons, both learned elsewhere in this repo:
 *
 *   1. A payload that duplicates the row goes stale the moment the row changes,
 *      and a subscriber acting on a stale copy is worse than one that re-reads.
 *   2. An outbox row is not tenant-scoped by anything the subscriber controls.
 *      Copying business content into it widens what a delivery bug can leak.
 *
 * A subscriber that needs the title, severity or impact re-reads the decision by
 * `decisionId`, scoped to the organization on the OUTBOX ROW — never to anything
 * inside this payload.
 */
// Declared as a type alias rather than an interface deliberately: the outbox
// stores a JSON column typed `Record<string, unknown>`, and TypeScript gives an
// implicit index signature to type aliases but not to interfaces. The alternative
// was a cast at the enqueue site, which would have defeated the point of typing
// the payload at all.
export type DecisionEventPayloadV1 = {
  /** `operational_priorities.id`. The subject. */
  decisionId: string;
  /** The producer that raised it. See `DECISION_PRODUCERS`. */
  producer: string;
  /** The observation that caused this event. Immutable, append-only. */
  observationId: string;
  /**
   * Position in this decision's log — the order Loop LEARNED things, not the
   * order they occurred. Monotonic per decision, gap-free, and the only correct
   * way to order two events about the same decision.
   */
  sequence: number;
  /** The lane before this change. Null when the decision did not exist yet. */
  previousState: PriorityState | null;
  /** The lane after this change, projected from the whole log. */
  newState: PriorityState;
  /** Who answers for it now, projected. Null when nobody does. */
  ownerUserId: string | null;
  /** Who is working it now, projected. Null when nobody is. */
  assigneeUserId: string | null;
  /** The recorded outcome, when one has been recorded. Null otherwise. */
  outcome: OperationalOutcome | null;
};

/**
 * The routing key a subscription matches on.
 *
 * Namespaced by producer so a subscriber can watch one producer's decisions
 * without matching every decision on the platform, and prefixed with `decision.`
 * so it can never collide with an active-state key.
 */
export function decisionStateKey(producer: string, recurrenceKey: string): string {
  return `decision.${producer}.${recurrenceKey}`;
}

/** The prefix every decision routing key starts with. */
export const DECISION_STATE_KEY_PREFIX = 'decision.';

// --- The guarantees -----------------------------------------------------------

/**
 * GUARANTEED — holds today, and something enforces it.
 * PARTIAL     — holds under stated conditions; the exceptions are named.
 * NOT_BUILT   — does NOT hold. Nothing enforces it and no subscriber may assume it.
 */
export type GuaranteeStatus = 'GUARANTEED' | 'PARTIAL' | 'NOT_BUILT';

export interface DeliveryGuarantee {
  id: string;
  status: GuaranteeStatus;
  /** What a subscriber may rely on, stated as a property. */
  statement: string;
  /** What makes it true — or, for NOT_BUILT, what would have to exist. */
  enforcedBy: string;
}

/**
 * What a subscriber may and may not rely on.
 *
 * Read the NOT_BUILT rows first. A contract that lists only its guarantees is how
 * a reader concludes the rest are guaranteed too.
 */
export const DELIVERY_GUARANTEES: readonly DeliveryGuarantee[] = [
  {
    id: 'atomic-enqueue',
    status: 'GUARANTEED',
    statement:
      'An event exists if and only if the fact that caused it committed. The event row is written in the same transaction as the observation and the projection, so there is no state change without an event and no event without a state change.',
    enforcedBy:
      'DecisionEngine passes the transaction client to outbox.enqueue(); a rollback takes the event with it.',
  },
  {
    id: 'one-event-per-change',
    status: 'GUARANTEED',
    statement: 'Exactly one event per lifecycle operation. Never zero, never two.',
    enforcedBy: 'A single enqueue call on the one write path in DecisionEngine.',
  },
  {
    id: 'idempotent-detection',
    status: 'GUARANTEED',
    statement:
      'Re-running an analysis for a period it has already covered does not republish. A server-rendered surface can re-render freely without emitting duplicate DecisionCreated / DecisionObserved events.',
    enforcedBy: 'Unique (priorityId, detectionKey) on the detection observation.',
  },
  {
    id: 'no-double-dispatch',
    status: 'GUARANTEED',
    statement:
      'A given (event, subscriber) pair is never dispatched twice concurrently, and never re-dispatched once it has succeeded. Running two publishers at once is safe.',
    enforcedBy:
      'Unique (outboxId, subscriptionId) on StateChangeDelivery plus a conditional claim (PENDING|FAILED and due -> PROCESSING) that reports whether THIS caller won.',
  },
  {
    id: 'independent-retry',
    status: 'GUARANTEED',
    statement:
      'Each subscriber retries and dead-letters on its own. A failing OPTIONAL subscriber never blocks its siblings or the parent event; a REQUIRED subscriber that dead-letters fails the parent, closed rather than silent.',
    enforcedBy:
      'Per-delivery attemptCount / availableAt back-off, and reconcileParent() in StateChangePublisher.',
  },
  {
    id: 'at-least-once',
    status: 'GUARANTEED',
    statement:
      'A claimed delivery always reaches a terminal state. It succeeds, retries with back-off, or dead-letters — including when the worker dies mid-handler, which previously stranded it in PROCESSING forever: never retried, never dead-lettered, never surfaced.',
    enforcedBy:
      'StateChangeDeliveryRepository.reclaimStale(), called at the start of every publisher pass: a delivery held past the lease returns to PENDING, or dead-letters with a stated reason once its attempts are spent so a handler that reliably kills its worker surfaces instead of looping. Subscribers must still be idempotent — a reclaimed or FAILED delivery may already have had a side effect.',
  },
  {
    id: 'per-subject-ordering',
    status: 'NOT_BUILT',
    statement:
      'Events about the SAME decision may arrive out of order. The drain examines rows oldest-first, but per-delivery retry is independent, so a later event can succeed while an earlier one is still backing off.',
    enforcedBy:
      'Nothing. Subscribers MUST order by payload.sequence and MUST NOT assume previousState matches the state they last saw. Ignore an event whose sequence is below the highest already applied for that decisionId.',
  },
  {
    id: 'delivery-execution',
    status: 'PARTIAL',
    statement:
      'A drain exists and runs on a schedule: OutboxDrainRunner resolves which organizations have work and runs a bounded pass for each, triggered by a guarded endpoint. It is PARTIAL rather than GUARANTEED because whether it actually runs depends on configuration this repository cannot assert — OUTBOX_DRAIN_SECRET in the deployment, plus OUTBOX_DRAIN_URL and OUTBOX_DRAIN_SECRET in the scheduled workflow. Unconfigured, the endpoint fails closed with 401 and nothing is delivered.',
    enforcedBy:
      'OutboxDrainRunner + POST /api/internal/outbox/drain + .github/workflows/drain-outbox.yml. The trigger is deliberately replaceable: swapping the schedule for a queue worker or a Lambda changes the caller and nothing downstream. Verify with a manual workflow_dispatch run before relying on it.',
  },
];

export function guaranteeStatus(id: string): GuaranteeStatus | null {
  return DELIVERY_GUARANTEES.find((g) => g.id === id)?.status ?? null;
}

// --- What a subscriber must do ------------------------------------------------

/**
 * The rules every decision subscriber follows — Work OS today, CRM and Accounting
 * later. Stated here rather than in each subscriber, so producer #2 inherits them
 * instead of rediscovering them.
 *
 * These are not style guidance. Each one corresponds to a way the stream can
 * legitimately behave that a naive handler gets wrong.
 */
export const SUBSCRIBER_RULES: readonly string[] = [
  'Be idempotent. A FAILED delivery retries, and your side effect may already have happened. Key your work off (decisionId, sequence) or an equivalent stable key — never off wall-clock time.',
  'Order by payload.sequence, not by arrival. Two events about one decision can arrive out of order; drop any whose sequence you have already applied.',
  'Never require identityId. It is null for most decisions, deliberately — a decision usually describes the business, not a person. A handler that returns early without one will silently no-op on nearly every decision.',
  'Take the organization from the outbox row, never from the payload. The payload is data; the row is the trusted server context.',
  're-read the decision by decisionId for any business content. The payload carries no title, severity or impact on purpose, so it cannot go stale.',
  'Switch on eventType for what happened, and read changeType when you need the finer observation type (first assignment vs handover, which kind of progress).',
  'Do not switch on DecisionDismissed or DecisionMerged. Neither exists. Dismissal is DecisionClosed; a merge is DecisionResolved or DecisionClosed carrying outcome MERGED.',
];

# The Decision Event Contract

**Status:** v1. The vocabulary, the payload and the routing key are built and published today, and
a drain now delivers them. Read *The gap* before building a subscriber: ordering is not guaranteed,
and delivery depends on configuration this repository cannot assert.

**This document is not the contract.** The contract is
[`packages/shared/src/decision-events.ts`](../../packages/shared/src/decision-events.ts). It is
code so it can be imported, type-checked and tested, and so this file cannot quietly drift away
from it the way `EVENT_BUS.md` did. Everything below is orientation; nothing below is
authoritative. When the two disagree, the code wins and this file is wrong.

---

## Why the contract is code

`docs/EVENT_BUS.md` describes a bus that was never built, and three other docs now cite it. A
prose contract for an event stream repeats that failure: nothing fails when reality moves.

So the contract enforces itself instead:

| Device | What it catches |
|---|---|
| `DECISION_EVENT_TYPE` is **total** over `ObservationType` | A new observation type does not compile until somebody decides what the world gets told |
| `packages/database` types its map as `Record<OperationalObservationType, DecisionEventName>` | An event name the contract does not declare is a compile error, not a subscriber that silently never fires |
| The engine's payload is annotated `DecisionEventPayloadV1` | A renamed or dropped field is a compile error rather than a runtime break in every subscriber |
| Tests walk the map against the **Prisma enum** in both directions | The schema and the contract cannot diverge |
| A test scans for an `OutboxDrainRunner` caller | Remove the trigger and `delivery-execution` must go back to `NOT_BUILT`; add one and it may not stay `NOT_BUILT` |
| A test reads the reclaim and the publisher | Delete `reclaimStale` and `at-least-once` may no longer claim `GUARANTEED` |
| A test reads the drain route | It fails if the endpoint ever starts reading an organization, a query string or a body |

The last two are the point. The contract is not allowed to describe a system that does not exist,
**and it is not allowed to keep describing one that has since been built.**

## What is published

One event per lifecycle operation, written in the same transaction as the fact that caused it.
Eighteen event names over twenty-two observation types — read `DECISION_EVENT_TYPE` for the map.

Three collapses are deliberate and asserted by test, not accidental:

- `ASSIGNED` and `REASSIGNED` both announce `DecisionAssigned`. First assignment vs handover
  rides on `changeType`.
- The four contact/response types collapse to `DecisionProgressRecorded`.
- `DISMISSED` announces **`DecisionClosed`**.

**There is no `DecisionDismissed` and no `DecisionMerged`.** Both were assumed to exist while
planning the first subscriber. A merge is an *outcome*, so it arrives as `DecisionResolved` or
`DecisionClosed` carrying `outcome: 'MERGED'`. A handler switching on either missing name compiles,
registers, and never fires — which is why the contract asserts their absence.

## What a subscriber receives

Nine fields, identical for every event name: the decision, the producer, the observation, the
`sequence`, the state before and after, owner, assignee, outcome.

The payload deliberately carries **no title, severity, impact or evidence**. A payload that
duplicates the row goes stale the moment the row changes, and copying business content into an
outbox row widens what a delivery bug can leak. A subscriber needing any of that re-reads the
decision by `decisionId`, scoped to the organization on the **outbox row** — never to anything
inside the payload.

`SUBSCRIBER_RULES` in the contract lists the rest. Each rule corresponds to a way the stream can
legitimately behave that a naive handler gets wrong.

## The gap

`DELIVERY_GUARANTEES` marks each guarantee `GUARANTEED`, `PARTIAL` or `NOT_BUILT`. Read the
non-guaranteed ones first — a contract listing only its guarantees reads as though the rest are
guaranteed too.

**`per-subject-ordering` is `NOT_BUILT`, and this is the one that will bite a handler author.** The
drain examines rows oldest-first, but per-delivery retry is independent, so a later event can
succeed while an earlier one is still backing off. Order by `payload.sequence`; never assume
`previousState` matches what you last saw.

**`delivery-execution` is `PARTIAL`.** The drain is built — `OutboxDrainRunner` resolves which
organizations have work and runs a bounded pass for each, triggered by a guarded endpoint on a
schedule. It is not `GUARANTEED` because whether it actually runs depends on configuration this
repository cannot assert. See *Running the drain*.

**`at-least-once` is now `GUARANTEED`**, and was not before. `claim()` covers `PENDING`/`FAILED`
only, so a worker that died mid-handler used to strand its delivery in `PROCESSING` forever —
never retried, never dead-lettered, never surfaced. `reclaimStale()` now runs at the start of every
pass: a delivery held past the lease returns to `PENDING`, or dead-letters with a stated reason once
its attempts are spent, so a handler that reliably kills its worker surfaces instead of looping.

Handlers must still be idempotent. A reclaimed or `FAILED` delivery may already have had a side
effect.

## Running the drain

Nothing about the schedule reaches the runner, the publisher or the engine — that is the point.
Replacing the trigger with EventBridge, a queue worker, an ECS scheduled task or an admin button is
a change to the caller alone.

| Piece | Where |
|---|---|
| What a pass *is* | `OutboxDrainRunner` (`packages/database/src/services/cognitive/`) |
| The endpoint | `POST /api/internal/outbox/drain` |
| The schedule | `.github/workflows/drain-outbox.yml`, every 5 minutes |

Required configuration, **without which nothing is delivered**:

- `OUTBOX_DRAIN_SECRET` in the deployment environment. Absent, the endpoint returns 401 — it fails
  closed rather than running unauthenticated, because an open drain endpoint is a denial-of-service
  lever on every tenant's queue at once.
- `OUTBOX_DRAIN_URL` and `OUTBOX_DRAIN_SECRET` as repository secrets for the workflow.

Verify with a manual `workflow_dispatch` run before relying on it. The response body is the
observability surface until an admin page exists: organizations drained, what published, what was
reclaimed, what dead-lettered, and whether the pass ran out of time. Counters and ids only — no
payloads and no tenant rows.

The endpoint takes **no organization and no parameters**, and a test asserts it never will. A drain
that accepted a tenant would be a cross-tenant lever behind a secret that authenticates a class of
caller rather than a tenant.

## Adding a subscriber

Register a `StateChangeSubscription` with `subscriberType`, an `eventTypes` list drawn from
`DECISION_EVENT_NAMES`, and a `stateKeyPattern` built with `decisionStateKey(producer,
recurrenceKey)` to watch one producer without matching every decision on the platform. Mark it
`required` only if the parent publication should fail when it dead-letters.

Read `SUBSCRIBER_RULES` first, and confirm the drain is configured — an unconfigured drain means a
correctly-registered subscriber still receives nothing.

Note that the existing cognitive `work-os` subscriber is **not** a Work OS integration: it is
identity-scoped, and `identityId` is null for most decisions by design, so it would no-op on
nearly all of them. It records a `CognitiveDecision`; it creates no `WorkInstance`.

## Versioning

`DECISION_EVENT_CONTRACT_VERSION` is `decision-events.v1`. Adding a payload field is additive.
Renaming or removing one is a v2 — the sample in `packages/shared/test/decision-events.test.ts` is
the guard that forces that call to be made deliberately rather than discovered by a subscriber.

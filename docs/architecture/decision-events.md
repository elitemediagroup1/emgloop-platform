# The Decision Event Contract

**Status:** v1. The vocabulary, the payload and the routing key are built and published today.
**Delivery is not** — see *The gap* below before building a subscriber.

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
| A test scans for a `StateChangePublisher` caller | If somebody builds the drain and forgets this contract, the suite fails and names the line to change |
| A test reads `claim()` | If somebody adds a lease, the `at-least-once` caveat stops being allowed to say `PARTIAL` |

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

**`delivery-execution` is `NOT_BUILT`. Nothing drains the outbox in production.**
`StateChangePublisher` has no caller outside its own tests: no cron, no route, no worker. Events
are written and accumulate unread, so every other guarantee currently describes rows nobody
reads. **A subscriber built before a drain exists is provably dead code.**

Two more worth knowing before writing a handler:

- **`per-subject-ordering` is `NOT_BUILT`.** The drain examines rows oldest-first, but per-delivery
  retry is independent, so a later event can succeed while an earlier one is still backing off.
  Order by `payload.sequence`; never assume `previousState` matches what you last saw.
- **`at-least-once` is `PARTIAL`.** `claim()` is a conditional update over `PENDING`/`FAILED` only,
  so a worker that dies mid-handler strands its delivery in `PROCESSING` and nothing reclaims it.
  Closing this needs a visibility timeout. Handlers must still be idempotent, because a `FAILED`
  delivery that already had a side effect does retry.

## Adding a subscriber

Not yet — see above. When the drain exists: register a `StateChangeSubscription` with
`subscriberType`, an `eventTypes` list drawn from `DECISION_EVENT_NAMES`, and a `stateKeyPattern`
built with `decisionStateKey(producer, recurrenceKey)` to watch one producer without matching every
decision on the platform. Mark it `required` only if the parent publication should fail when it
dead-letters.

Note that the existing cognitive `work-os` subscriber is **not** a Work OS integration: it is
identity-scoped, and `identityId` is null for most decisions by design, so it would no-op on
nearly all of them. It records a `CognitiveDecision`; it creates no `WorkInstance`.

## Versioning

`DECISION_EVENT_CONTRACT_VERSION` is `decision-events.v1`. Adding a payload field is additive.
Renaming or removing one is a v2 — the sample in `packages/shared/test/decision-events.test.ts` is
the guard that forces that call to be made deliberately rather than discovered by a subscriber.

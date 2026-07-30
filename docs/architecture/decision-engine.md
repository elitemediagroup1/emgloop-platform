# The Decision Engine

**Status:** built and merged-pending. The canonical application service for turning
intelligence into durable operational decisions. CallGrid Intelligence is its first producer
and consumes it exactly as every later producer will.

This document describes what exists. Where something is not built, it says so.

---

## Purpose

One responsibility: **turn intelligence into durable operational decisions.** Nothing more.

The engine runs *after* intelligence has been produced. It never reads raw data, never
computes a metric, never applies a threshold and never decides whether something is
significant. Its input is a producer's conclusion.

## Position in the platform

```
External event → capture → normalize → identity → memory → knowledge → active state
      → INTELLIGENCE PRODUCER → Decision Engine → Decision Center
      → Outbox → Subscribers → Products
```

## Boundaries

| Owns | Does not own |
|---|---|
| Lifecycle invariants | Analysis, scoring, thresholds |
| Transaction boundaries | Presentation, queue layout |
| Projection maintenance | Delivery to subscribers |
| Exactly one domain event per lifecycle operation | Knowing that subscribers exist |
| Organization scoping | Producer subject semantics |

**It knows nothing about** buyers, campaigns, calls, invoices, pages, tickets or revenue —
nor about Work OS, CRM, notifications or any other consumer. A producer's subject travels in
`sourceReference`, which is opaque here and never parsed.

---

## Producer contract

Producers import from **one** place:

```ts
import { decisionEngine } from '@emgloop/database';
```

Reaching past that into `repositories.operationalPriorities`, into Prisma, or into the outbox
skips the transaction boundary, the projection rewrite and the publication **in one go** — and
every one of those failures is silent. The engine is the boundary precisely so a producer
cannot half-record something.

### Opening a decision

```ts
await decisionEngine.create(organizationId, {
  producer: 'ACCOUNTING',
  recurrenceKey: 'invoice-aging::acme-corp',   // rule + subject, NEVER a timestamp
  detectionKey: 'month:2026-07',               // the analysis period's identity
  detectedAt: periodEnd,
  title: 'Acme Corp invoices ageing past 90 days',
  severity: 'HIGH',                            // DECISION_SEVERITIES, validated
  impactCents: 1_240_000,
  sourceReference: 'customer:acme-corp',
  producerVersion: 'accounting-engine@2.1.0',
  evidence: [...],
});
```

**Two keys, two idempotency axes.** `(organizationId, producer, recurrenceKey)` is the
decision's identity, so the same situation tomorrow lands on the same row.
`(decisionId, detectionKey)` is the *sighting's* identity, so re-analysing one period any
number of times records exactly one sighting. A producer that cannot supply both cannot be
trusted not to duplicate itself, and `create` rejects it.

### The public API

| Lifecycle | Reads |
|---|---|
| `create` · `update` · `addObservation` · `addEvidence` | `get` · `getHistory` · `getTimeline` |
| `assign` · `unassign` · `setOwner` · `watch` · `unwatch` · `escalate` | `getEvidence` · `getCurrentState` |
| `resolve` · `ignore` · `reopen` · `recordOutcome` | `list` · `countsByState` · `rebuildProjection` |

---

## The decision model

### Owner ≠ assignee ≠ state

Three dimensions, and **none is derived from another**:

- **Owner** — accountability. Who answers for this reaching an outcome. Changes rarely.
- **Assignee** — execution. Who is working it now, or nobody. Changes often.
- **State** — where it sits in the Decision Center.

A manager owns revenue quality; a specialist works the item; the item sits in a lane. Taking
ownership does not take the work and does not move the lane. Reassigning a watched item keeps
it watched. Unassigning returns it to the queue but leaves accountability intact.

### States

`NEEDS_REVIEW` · `ASSIGNED` · `WATCHING` · `RESOLVED` · `DISMISSED`

`REVIEWED` deliberately **does not** clear the lane. Reading is not deciding, and telling
"nobody has looked at this" from "somebody looked and chose not to act" is a real operational
distinction.

### Outcomes

`RECOVERED` · `PARTIALLY_RECOVERED` · `NOT_RECOVERED` · `NO_ACTION_NEEDED` · `FALSE_POSITIVE` ·
`ACCEPTED_RISK` · `NOT_ACTIONABLE` · `DUPLICATE` · `MERGED` · `SUPPRESSED` · `EXPIRED` ·
`CONVERTED_TO_WORK` · `UNKNOWN`

**A state says where it is; an outcome says how it ended.** `ignore()` is an *action*, not an
outcome — the outcome carries *why*, because "dismissed" records what the operator did and
nothing about what was true.

`CONVERTED_TO_WORK` is generic on purpose. The destination lives on the observation
(`destinationSystem` / `destinationType` / `destinationId`), so the engine records *that* work
was created somewhere and never *which product* — CRM, Accounting, Support and an external
ticketing system all produce the same outcome.

---

## Observation model

Every action appends one immutable observation. There is no `updatedAt`, and no method that
could edit or delete one.

Each carries: type, actor (`HUMAN` needs a user; `SYSTEM` does not), source, `occurredAt` (when
it happened in the world), `recordedAt` (when Loop learned it), `previousState`, `newState`,
`reason`, optional evidence reference, and a monotonic `sequence`.

**`sequence` is the ordering key for state, not `occurredAt`.** An operator recording on
Thursday that they called on Tuesday is appending a fact, not rewriting Wednesday's decision.
The timeline sorts by occurrence for reading; state does not.

## Evidence model

Append-only and immutable. `addEvidence` means *append*.

Each row carries source, metric key, window, `ruleId`/`ruleVersion`, `formulaVersion`,
`calculationVersion`, `producerVersion`, confidence, raw/normalized/derived values,
completeness, entity, **limitations and unknowns**, and `observedAt`.

Limitations travel with the value forever. Evidence that keeps its number and loses its
caveats is how a hedged claim becomes a confident one.

## Projection model

**The log is the truth. The columns on `operational_priorities` are a rebuildable cache.**

`projectLifecycle` in `@emgloop/shared` is the single definition of current state; it is pure,
takes no clock and is total. `getCurrentState()` computes from the log and never reads the
cached column. `rebuildProjection()` restores the columns from the log alone.

`projectionVersion` records which reducer wrote the cache, so a changed reducer is detectable
rather than silently mixed.

---

## Outbox integration

**Loop has exactly one event bus.** `StateChangeOutbox` carries active state and decisions and
will carry work items, memory, knowledge and identity — as `subjectType` values, never as
second outboxes.

```
subjectType   what changed   (ACTIVE_STATE | DECISION | WORK_ITEM | MEMORY | KNOWLEDGE | IDENTITY)
subjectId     which one
eventType     what happened  ('DecisionAssigned')
identityId    NULLABLE
stateKey      'decision.<PRODUCER>.<recurrenceKey>'
```

`identityId` is nullable because most decisions describe the **business** rather than a person
— revenue concentration, profit volatility, funnel drop. Fabricating an identity to satisfy a
column would put non-entities into the identity graph forever.

`subjectType` and `eventType` are separate columns because one subject emits many event types;
collapsing them would force subscribers to parse strings to learn what changed.

### Events

`DecisionCreated` · `DecisionObserved` · `DecisionReopened` · `DecisionReviewed` ·
`DecisionAssigned` · `DecisionUnassigned` · `DecisionOwnerChanged` · `DecisionPriorityChanged` ·
`DecisionSeverityChanged` · `DecisionEvidenceAdded` · `DecisionWatched` · `DecisionUnwatched` ·
`DecisionNoteAdded` · `DecisionProgressRecorded` · `DecisionEscalated` ·
`DecisionOutcomeRecorded` · `DecisionResolved` · `DecisionClosed`

The mapping is a **total** `Record` over observation types, so adding an observation type
forces a deliberate decision about what the world is told — at compile time, rather than as a
silently unpublished change in production.

## Transaction guarantee

Every state-changing operation is atomic:

1. validate the actor and input
2. resolve the decision **within the organization**
3. validate the lifecycle transition
4. append the immutable observation
5. rewrite the projection from the **whole** log
6. write the domain event to the outbox
7. commit once

No operation appends without publishing, or publishes without persisting. A subscriber that
learns about something which did not happen is a bug; one that never learns about something
which did is worse.

## Idempotency and replay

- Re-running an analysis period: one sighting, no event, `effect: 'UNCHANGED'`.
- Concurrent first-creates: the unique wins, the loser is treated as a sighting.
- A sighting from a period that ended **before** an existing resolution does **not** reopen —
  reading history is not relapsing.
- Detection timestamps move forward only, so browsing an older period cannot rewind
  `lastDetectedAt`.

## Tenancy

`organizationId` is the first argument of every method and always comes from the signed
session. Rows are resolved within the organization before being touched. A cross-organization
id raises `DecisionNotFoundError` — **not-found, never forbidden**, because distinguishing them
leaks the existence of other tenants' rows.

---

## Extending: adding a producer

1. Map your severity into `DECISION_SEVERITIES` at your boundary.
2. Derive a stable `recurrenceKey` from your rule plus your subject — never a timestamp.
3. Derive a `detectionKey` identifying your analysis period.
4. Call `decisionEngine.create(...)` with your producer name.

That is the whole integration. Queue, lanes, ownership, assignment, history, evidence,
outcomes, timeline and publication all follow, and **no platform change is required.**

If your impact is not money, leave `impactCents` null and say what it is in `impactLabel`.
`impactUnit` is RESERVED in the contract — writing a session count into a cents column would
have every surface render it as dollars.

## Not built

- **No subscriber consumes decision events yet.** The engine publishes; the outbox delivers to
  matching `StateChangeSubscription` rows, and none are registered for `DECISION` subjects.
  Wiring a consumer (Work OS first) is its own branch. Until then the events accumulate and
  are delivered to nobody, which is the correct behaviour for a bus with no listeners.
- **`impactUnit`, `category`, `tags`, sortable `confidence`, `relatedDecisionIds`, `dueAt`** are
  RESERVED — see `packages/shared/src/decision-contract.ts`, where a test enforces that reserved
  fields genuinely do not exist.
- **Cross-decision relationships** are computed per analysis run and not persisted.

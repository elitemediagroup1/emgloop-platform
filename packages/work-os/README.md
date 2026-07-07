# @emgloop/work-os

Canonical domain model for the **Loop Work OS** &mdash; the execution engine of Loop.

> This is **not** a task manager. It is **not** a Monday.com clone. It is the
> layer that turns priorities into executed work across every product in Loop.

## What this package is

A **pure contracts package**. It contains only TypeScript types and the small
`as const` literal arrays that back those types. There is:

- **No** runtime logic
- **No** backend wiring
- **No** database or schema changes
- **No** API surface
- **No** persistence
- **No** UI
- **No** workflow engine, task engine, or automations
- **No** Brain execution

If it computes, stores, renders, or sends something, it does **not** belong
here. Those are downstream runtime concerns that will consume these contracts.

## The mission it models

Every person in the company should always be able to answer:

- What do I do next?
- Why is it next?
- What is blocked?
- Who receives this after me?
- What am I waiting on?
- What is the highest priority?

The **Brain determines priorities. The Work OS executes them.** That division is
load-bearing in the type design: priority and status are plain recorded fields
on a `WorkItem`, never values derived inside this package.

## The core idea: one universal unit

The model is built around a single universal unit of execution, the
`WorkItem`. A `Task` is just a `WorkItem`; a `Milestone` references
`WorkItem`s; an `Approval` hangs off a `WorkItem`. Because there is one unit
rather than a dozen bespoke ones, the same queues, notifications, dependencies,
approvals, and cross-domain links work for **every** use case:

website builds, creator management, government contracts, CRM onboarding,
marketplace investigations, sales, marketing, internal operations, personal
tasks, and future products.

Every `WorkItem` is capable of being: assigned, approved, blocked, dependent,
watched, commented on, and attached to Brain, Marketplace, CRM, Creator, and
Business.

## Module map

| Module | Responsibility |
| --- | --- |
| `identifiers.ts` | Branded ids (`WorkItemId`, `ProjectId`, `ActorId`, ...) so ids can never be crossed |
| `primitives.ts` | Universal `WorkStatus`, `WorkPriority`, `DueDate`, `Timing` |
| `actors.ts` | `ActorRef`, `Owner`, `Assignment`, `Watcher` (human / team / system) |
| `links.ts` | `DomainLink` &mdash; neutral pointers to Brain / Marketplace / CRM / Creator / Business |
| `collaboration.ts` | `Comment`, `Checklist`, `Attachment` (attachments are references, not bytes) |
| `relationships.ts` | `Relationship`, `Dependency` (blocked / waiting, as data) |
| `activity.ts` | `Activity`, `Notification` (Work-OS scoped events) |
| `governance.ts` | `Approval`, `Decision` (recorded, never auto-made) |
| `work-item.ts` | The universal `WorkItem` |
| `task.ts` | `Task` as a semantic alias over `WorkItem` |
| `structure.ts` | `Workspace`, `Project`, `Workflow`, `WorkflowStage`, `Milestone`, `Queue` |

## Architectural reasoning

### 1. Actors, not users

Responsibility is never typed as "user". Every owner, assignee, and watcher is
an `ActorRef` of kind `user`, `team`, or `system`. This is what makes the
model universal: an automated system can own work the same way a person can,
and "who receives this after me" (`Assignment.handoffTo`) is expressed once for
all actor kinds.

### 2. Links, not imports

A `WorkItem` connects outward to other Loop domains through `DomainLink`, a
neutral `{ domain, entityType, entityId, relation }` reference. This package
**never imports** Brain, Marketplace, CRM, Creator, or Business types. That is a
deliberate anti-coupling and anti-duplication decision: the execution engine
must not depend on every product, and every product must not have its types
re-declared here.

### 3. Data, not engines

Dependencies, workflows, queues, approvals, and handoffs are all **declarative
data**. The model records that A blocks B, that a queue selects certain items,
that a stage requires approval &mdash; it never runs a scheduler, resolver, or
state machine. Execution is a future runtime that reads these contracts.

### 4. Provider neutrality

No provider, vendor, or storage system appears in any type. Attachments carry an
opaque `uri`; links carry opaque ids. The package can back any future
implementation without change.

### 5. No duplication with Brain, Marketplace, or CRM

- **Brain** owns cognition: confidence, evidence, recommendations, priority
  *determination*. Work OS owns execution: it *records* the resulting priority
  and *links* to the Brain recommendation, it does not restate Brain types.
- **Marketplace** owns measurement: trend, health, funnels. Work OS links to a
  campaign / buyer / source / vendor by reference only.
- **CRM** owns relationships and records. Work OS links to a CRM entity by
  reference only.
- **Shared** owns identity and cross-cutting primitives. Work OS **reuses**
  `TenantScope`, `Metadata`, and `Result` from `@emgloop/shared` rather than
  redefining them.

The one intentional overlap in *name* is `WorkStatus` / `WorkPriority` versus
Brain's cognitive `Priority`. They are namespaced to different packages and
describe different things (execution state vs. computed importance), so they are
distinct types by design, not duplicates.

## Consuming this package

```ts
import type { WorkItem, WorkStatus, DomainLink } from "@emgloop/work-os";
```

Everything is exported from the package root barrel (`src/index.ts`).

## Status

Draft architecture for review. No implementation, no wiring, no persistence.

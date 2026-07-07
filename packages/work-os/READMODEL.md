# Work OS Read Model & Query Contracts (PR #72)

This document describes the read surface of the Loop Work OS. It is contracts
only: shapes that describe what a future runtime will return. This package
computes nothing, stores nothing, and executes nothing. There is no UI, no
repository, no persistence, no API route, and no Brain execution here.

## Why a read model exists

The domain model (PR #70) and workflow model (PR #71) describe what work *is*
and how it *flows*. They do not describe how a person *asks* about their work.
The read model closes that gap. It defines the questions the Work OS must
answer and the exact shape of each answer, so that a UI, an API, and the Brain
can all target one contract and see identical work.

## The questions and the views that answer them

| Question | Contract |
| --- | --- |
| What is my next action? | `NextActionView` |
| What work is assigned to me? | `MyWorkView` |
| What is blocked? | `BlockedWorkView` |
| What am I waiting on? | `WaitingOnView` |
| What approvals do I owe? | `ApprovalInboxView` (`pending`) |
| What approvals am I waiting for? | `WaitingOnView` (`approvalId` entries) |
| What workflows are active? | `WorkflowProgressView` |
| What work is overdue? | `WorkQueueView` / any view via `isOverdue` |
| What work unlocks other people? | `ApprovalInboxView.totalUnblocking`, `WorkloadEntry.unblocksOthersCount`, `NextActionView.downstreamCount` |
| What changed recently? | `WorkActivityView` |
| Who is overloaded? | `TeamWorkloadView` |

## Query contracts

Reads are described declaratively. A caller composes a `WorkSearchQuery` from a
scope, a `WorkFilter` predicate tree, an ordered list of `WorkSort` keys, and a
cursor based `WorkPage`. A future runtime returns a `WorkQueryResult`. No query
is built or executed inside this package; `FilterClause.value` and page cursors
are opaque to it.

## How this answers "what do I do next?"

`NextActionView` names a single recommended item, a `NextActionReason` (for
example `unblocks_others` or `due_soonest`), an optional human rationale, and a
`downstreamCount` of how many people that item unblocks. The recommendation is
computed elsewhere (by the Brain or a future runtime); this shape only carries
it, keeping the package declarative.

## Worked examples

### Charlie logs in and sees his Next Action

A runtime resolves Charlie to an `ActorId` and produces a `MyWorkView` whose
`next` is a `NextActionView`. If Charlie is the current owner of a workflow
stage that several other stages depend on, `reason` is `unblocks_others` and
`downstreamCount` reflects the waiting people. Charlie sees one clear action.

### Matt logs in and sees approvals that unblock other people

Matt's `ApprovalInboxView` lists `ApprovalTask` entries. Each carries an
`unblocksCount`; `totalUnblocking` summarizes how many downstream items his
pending approvals are gating. Sorting the inbox by `unblocksCount` surfaces the
approvals that free the most people first. No approval is granted here; the
view only shows what is owed.

### A project manager sees workflows stuck in Waiting

The PM requests a `WorkflowProgressView`. Each `WorkflowProgressEntry` exposes
`currentStageState` and an `isWaiting` flag derived from the PR #71 stage state
semantics, plus `stalledSince`. Filtering entries where `isWaiting` is true
shows every workflow parked in a waiting state and who the current owner is.

### The Brain later consumes the same read model to prioritize work

Because `WorkReadModel` is a declarative shape (view name to returned shape,
never methods), the Brain can request the same `WorkSearchQuery` and
`WorkQueryResult` and the same views a person sees. The Brain reads
`downstreamCount`, `unblocksOthersCount`, `isOverdue`, and `isBlocked` to rank
work, then writes its recommendation back into `NextActionView.reason`. One
read model serves people and the Brain identically.

## Anti-duplication

This PR adds only projection and query shapes. It does not redefine any entity.
It reuses `WorkItem`, `WorkItemKind` (PR #70), `ActorRef`, `Assignment`,
`AssignmentRole` (PR #70), `Approval`, `ApprovalState` (PR #70), `Dependency`
(PR #70), `Activity` (PR #70), `WorkflowStageState` (PR #71), and the shared
`WorkStatus` / `WorkPriority` / `DueDate` primitives. Views reference entities by
id or embed existing fields; no new entity type is introduced.

## Boundaries

- No runtime, no execution, no data access.
- No repositories, no persistence, no schema, no API routes.
- No UI. No Brain execution. Provider neutral throughout.
- The runtime that satisfies `WorkReadModel` arrives only in a later, separately
  approved implementation PR.

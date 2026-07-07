# Work OS - Workflow Model

Declarative contracts describing **how work flows through Loop**. This layer
extends the canonical domain model (PR #70) with the vocabulary of movement:
templates, stages, transitions, criteria, rules, states, and an ownership trail.

> Architecture only. No UI, no repositories, no persistence, no runtime, no
> workflow engine, no backend, no API, no schema, no Brain execution. Every type
> here is data a future runtime would read; nothing here executes.

## Two layers, no duplication

PR #70 already defined a **structural** `Workflow` and `WorkflowStage`: they
record where a concrete piece of work currently sits. PR #71 adds the
**definition (blueprint)** layer: how work *can* move in the abstract.

| Concern | Type | Layer |
| --- | --- | --- |
| Where this work sits now | `Workflow`, `WorkflowStage` | structural (PR #70) |
| How this kind of work flows | `WorkflowTemplate`, `StageDefinition` | blueprint (PR #71) |

The two are linked by id, never merged. Status stays single-sourced:
`WorkflowStageState` maps onto `WorkStatus` via `STAGE_STATE_STATUS` rather
than introducing a second status enum.

## What the model answers

- **Who owns this now?** `WorkItem.owner` (PR #70), current `CustodySpan`.
- **Who owned it before?** The ordered `OwnershipTrail.spans`.
- **Who receives it next?** `HandoffRule.recipient` and `Assignment.handoffTo`.
- **Why?** `HandoffRule.reason`, `Transition.label`, `CustodySpan.reason`.
- **What is blocking it?** `Blocker`, plus `Dependency` from PR #70.
- **What approvals are required?** `ApprovalRule` (with `quorum` for multiple).
- **What stage is it in?** `WorkflowStageState` on the current stage.
- **Can stages run in parallel?** `StageDefinition.executionMode = "parallel"`.
- **Can stages require multiple approvals?** `ApprovalRule.quorum`.
- **Can stages be skipped?** `StageDefinition.skippable` + `skip` transition.
- **Can stages be optional?** `StageDefinition.optional`.
- **Can stages loop?** `StageDefinition.loopable` + `loop_back` transition.

## Worked example: Matt -> Charlie -> Developer -> QA -> Client

This chain is expressed as **data in a template**, never hardcoded. The people
are resolved by role at runtime; the template only names roles and rules.

Define one `WorkflowTemplate` (domain `website`) with five `StageDefinition`s:

1. **Intake** (kind `work`) - `AssignmentRule` assigns to the `owner`-role
   selector (resolves to Matt for this workspace). Its `HandoffRule` recipient
   is the `by_role` selector "producer", reason "scoped and approved".
2. **Production** (kind `work`) - assigned by role "producer" (resolves to
   Charlie). `HandoffRule` recipient role "developer", reason "ready to build".
3. **Development** (kind `work`) - assigned by role "developer". `ExitCriteria`
   requires a checklist-complete `Criterion`. `HandoffRule` recipient role "qa".
4. **QA** (kind `review`, `initialState = review`) - `ApprovalRule` with the
   "qa" approver. A `loop_back` `Transition` (labelled "Needs rework") returns
   to Development if QA rejects, demonstrating looping. On pass, `HandoffRule`
   recipient role "client".
5. **Client Approval** (kind `approval`, terminal) - `ApprovalRule` with the
   "client" approver; a `Transition` of kind `advance` to a completed terminal
   stage.

Because every step names a **role selector** (`by_role`) rather than a person,
the same template drives a government proposal (Analyst -> Manager -> Legal ->
Client) or creator onboarding (Scout -> Manager -> Compliance -> Creator) simply
by binding different actors to the roles. Nothing about "Matt" or "QA" is baked
into the contracts.

### Ownership trail for the example

As work moves, a runtime appends `CustodySpan`s: Matt (Intake) -> Charlie
(Production) -> Developer (Development) -> QA (QA, possibly looping back) ->
Client (Client Approval). Reading the trail backward answers "who owned it
before"; reading the open span answers "who owns it now"; the current stage's
`HandoffRule` answers "who receives it next".

## Module map (PR #71)

| Module | Responsibility |
| --- | --- |
| `workflow-ids.ts` | Branded ids for the definition layer |
| `states.ts` | `WorkflowStageState` + declarative mapping to `WorkStatus` |
| `criteria.ts` | `Criterion`, entry/exit `CriteriaGate`, `Blocker` |
| `rules.ts` | `AssignmentRule`, `ApprovalRule`, `HandoffRule`, `EscalationRule` |
| `transitions.ts` | `Transition` (advance/loop/skip/branch), `DecisionPoint` |
| `stages.ts` | `StageDefinition` (parallel/sequential/optional/loopable) |
| `template.ts` | `WorkflowTemplate` composing the above |
| `ownership-trail.ts` | `CustodySpan`, `OwnershipTrail` |

## Verification

Pure contracts, provider-neutral, no duplication with the PR #70 Work OS
package. Reuses `ActorRef`, `AssignmentRole`, `ApprovalState`, `WorkStatus`,
`Dependency`, and the `Id` brand rather than redefining them. Everything is
declarative; no execution logic, runtime, or automation is included.

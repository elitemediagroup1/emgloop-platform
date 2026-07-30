# Loop Engineering Principles

**These are laws about how the system is built, not advice about how we work.**

`CLAUDE.md` is the operating manual for this repository — branch discipline, validation,
review, the boundaries between layers. It stays the authority on all of that. This file is
narrower and longer-lived: it is the set of **platform invariants** that every module, every
producer and every agent is measured against, and that should still be true when the repo
layout, the framework and the deployment target have all changed.

**Scope test.** If a statement is about *how a person should work here*, it belongs in
`CLAUDE.md`. If it is about *what must be true of the system's data and behaviour*, it belongs
here. Nothing is stated in both places; where the two touch, one links to the other.

---

## How to read a rule

Every rule carries four things, and the fourth is the one that matters:

| | |
|---|---|
| **The rule** | Stated as a law, not a preference. |
| **Why** | The scar, or the failure it prevents. A rule without a reason gets negotiated away. |
| **Violation looks like** | The concrete shape of breaking it, so it is recognisable in review. |
| **Enforced by** | A test, a type, or **nothing yet** — stated honestly. |

**A rule whose enforcement is "convention only" is a rule we are currently trusting people to
remember, and this repo has already proved that does not hold.** Four consecutive org-scoping
PRs introduced three cross-tenant writes while everyone involved was actively thinking about
tenancy. Where a rule matters and is unenforced, that is a gap with a name, not a comfort.

---

## Rule 1 — Truth is append-only

Facts are recorded, never overwritten. A correction is a new fact that supersedes an old one;
it is not an edit.

**Why.** The value of a record is not what it says today, it is what it lets you ask later.
Overwriting destroys questions you have not thought of yet — how long recovery takes, which
intervention worked, how often the system was wrong — and it destroys them silently, so nobody
discovers the loss until they need the answer.

**Violation looks like:** an `updatedAt` on a log table; a repository method that mutates a
recorded event; a "fix the data" script; storing only the latest value of something that moves.

**Enforced by:** `operational_observations` has no `updatedAt` and
`OperationalPriorityRepository` exposes no update or delete path for one — asserted directly in
`packages/database/test/operational-lifecycle.repository.test.ts`. `MemoryEvent` in the
cognitive layer holds the same shape. **Not enforced anywhere else**: nothing stops a new table
being built mutable.

---

## Rule 2 — Current state is always a projection, and always rebuildable

Stored state is a cache of the log. It is written in the same transaction as the fact that
causes it, and it can be reconstructed from that log alone at any time.

**Why.** A cache you cannot rebuild is not a cache, it is a second source of truth — and two
sources of truth diverge, always, and you find out from a customer. Being able to rebuild is
what makes it safe to change the reducer, to fix a bug in a derivation, or to add a field
retroactively.

**Violation looks like:** a status column set directly; a derived value with no function that
produces it; a projection that cannot be recomputed because the inputs were not kept.

**Enforced by:** `projectLifecycle` in `@emgloop/shared` is the single definition of decision
state; `rebuildProjection` restores the columns from the log, and a test corrupts them the way a
bad migration would and rebuilds. `projectionVersion` on each row records which reducer wrote
it, so a changed reducer is detectable rather than silently mixed.

---

## Rule 3 — Every conclusion points to evidence, and the evidence outlives the conclusion

A number on screen traces to a row. A claim traces to the values behind it. And when a
conclusion is *stored*, its evidence is stored with it.

**Why.** The second half is the part that is easy to miss and expensive to skip. A live analysis
can always re-derive its own evidence; a decision closed six weeks ago, under a rule version
that has since moved, cannot. Without a snapshot, the moment a threshold changes, every
historical decision keeps its conclusion and loses its reason — and the outcome data you were
going to use to judge whether the system's recommendations were any good becomes
uninterpretable.

**Violation looks like:** a figure with no lineage; a stored finding without its rule version; a
snapshot that keeps the claim and drops the limitations.

**Enforced by:** the engine refuses to emit a finding with no supporting evidence
(`callgrid-intelligence.ts`), and the Decision Center writes a `DecisionEvidenceSnapshot` —
rules, versions, values, formulas, **limitations and unknowns** — into the opening observation,
which is immutable. Truncation of a large snapshot is disclosed, never silent.

---

## Rule 4 — Every decision has a lifecycle, and it completes only by resolution, dismissal, or measurable work

A priority is not complete when it has been understood. It is complete when it has been
resolved, deliberately dismissed, or turned into work whose outcome can later be evaluated.

**Why.** Understanding is not action, and a system that treats "the operator read it" as
completion produces a queue that empties without anything happening. Distinguishing "nobody has
looked at this" from "somebody looked and chose not to act" is the difference between two very
different operational problems.

**Violation looks like:** an item that disappears from a queue because it was viewed; a
dismissal with no recorded reason; a "done" with no outcome.

**Enforced by:** `REVIEWED` deliberately does not clear the lane (tested); dismissal requires an
outcome, and the outcomes distinguish *Loop should not have raised it* from *real and accepted*
from *real and not actionable*, because collapsing those destroys the only feedback the
intelligence gets about its own accuracy.

---

## Rule 5 — Every intelligence producer emits generic decisions

Detection is module-specific. Decisions are not. A producer contributes a `sourceSystem` value,
never its own priority table, its own lifecycle, or its own queue.

**Why.** Per-module lifecycle tables make every new intelligence module a migration, and they
guarantee that the second module's queue behaves subtly differently from the first. This repo
already carries three workflow systems, two shells, three nav configs and two token sets — every
one of them locally reasonable at the time.

**Violation looks like:** `CallGridDecision`, `AccountingPriority`, `MarketingQueue`; a producer
writing its own severity vocabulary into the shared column; a lifecycle state that only one
module understands.

**Enforced by:** `DECISION_FIELDS` in `@emgloop/shared/decision-contract.ts` marks every field
`PERSISTED` or `RESERVED`, and a test in `@emgloop/database` walks that list against the real
Prisma columns — a field claimed as stored that has no column fails the build, and a reserved
field that quietly gained one fails too. **The severity vocabulary is not enforced at the
column** (it is a String so a producer is never blocked by a migration); `isDecisionSeverity`
exists for producers to check at their boundary, and that check is convention today.

---

## Rule 6 — Products subscribe; they do not couple

A producer publishes what happened. Consumers decide what to do about it. A producer must not
know the name of any consumer.

**Why.** The moment CallGrid creates a Work OS record directly, CallGrid depends on Work OS, and
every future producer inherits that dependency. Publication keeps the graph acyclic and lets a
consumer be added, changed or removed without touching anything that produces.

**Violation looks like:** an intelligence module importing another product's repository; a
detection path that creates a work item, sends a notification, or writes to a CRM record.

**Enforced by:** **NOTHING YET — this is the largest open gap in this document.** The cognitive
layer has the machinery (transactional outbox, `StateChangeSubscription`, exactly-once delivery
per subscriber, a `WORK_OS` subscriber type) and the Decision Center **does not publish into it
yet**. Today the rule holds only because the Decision Center was deliberately built to touch
nothing else — which is discipline, not enforcement. Wiring publication is the next foundation
layer, and until it exists, this rule is a commitment rather than a guarantee.

---

## Rule 7 — Unknown is more truthful than fabricated certainty

A value that cannot be measured is reported as unknown, with the reason. It is never defaulted,
zeroed, estimated, or quietly omitted.

**Why.** "0" and "we could not measure this" look identical on a screen and mean opposite
things — one is a claim about the world and the other is a claim about our instrumentation. This
codebase's single worst class of bug was an accumulator that added `?? 0` with no coverage
counter, which made an unpriced buyer indistinguishable from one that earned nothing and
silently corrupted every ranking built on top.

**Violation looks like:** `?? 0` on a measurement; a percentage computed off a zero denominator;
an empty state that reads as an all-clear; a confidence score invented to fill a field.

**Enforced by:** coverage counters in `aggregateWindow`; unknown values sort last in both
directions; every scoring component whose input is missing is *withheld from numerator and
denominator* rather than zeroed, and `determinacy` reports how much of the scale actually ran;
rates in the Decision Center return `null` with an `unavailableReason` rather than 0%; an empty
queue states what was examined, because "nothing needed you" and "nothing could be read" must
never look alike.

---

## Rule 8 — History compounds; predictions expire

Prefer recording what happened over projecting what will. Where a projection is offered, it
states its assumption, and it is withheld when the assumption cannot be checked.

**Why.** A recorded outcome is worth more every year. A forecast is worth less every day, and a
wrong one is worth less than nothing because decisions get made on it. Loop's advantage is the
accumulating record of what actually worked, not the confidence of its guesses.

**Violation looks like:** an annualised figure from a partial period; a recovery estimate; "this
will cost you $X" where X was modelled rather than measured.

**Enforced by:** annualisation is withheld unless the series shows stability and is always
suppressed on a live window; `ifIgnored` restates a measured rate under a stated condition and
deliberately refuses to say what acting would recover, because that requires a counterfactual
Loop cannot see; measured effect on a decision is typed in by a human, never computed.

---

## Adding a rule

A rule earns its place by having cost something. The bar is a real incident, a real class of bug,
or a real architectural decision that will be re-litigated if it is not written down.

When adding one:

1. State it as a law.
2. Give the scar, specifically. "Sprint 29A found three cross-tenant writes" beats "isolation matters".
3. Show what breaking it looks like in code.
4. **Say honestly what enforces it.** If nothing does, say "nothing yet" — an unenforced rule
   that claims enforcement is worse than an honest gap, because it stops anyone building the check.

Never add a rule for something not yet built. A principle describing an unbuilt system is the same
failure as a doc describing one, and this repo already has `docs/EVENT_BUS.md` — a document for a
system that never existed, now cited by three others.

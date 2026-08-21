# EMG Loop — UI/UX Product Handoff

**Audience: Charlie and Elxi.** This is what Loop is, what is real today, and what
you can safely design against. It is written for designers, not engineers — where
implementation detail appears it is because a design decision depends on it.

Read `docs/PROJECT_STATUS.md` for where the work currently stands. This document
describes *contracts*, not progress.

---

## What EMG Loop is

**INITIATE → CAPTURE → COMPOUND.**

Loop is the operating intelligence layer for Elite Media Group. Activity flows in
from the systems EMG already runs, Loop normalizes it, resolves who and what each
record is about, builds durable business entities and relationships, and keeps
track of the difference between *what it observed* and *what is true*.

Loop is **not another dashboard**. A dashboard's job is to show numbers. Loop's job
is to be trustworthy about them — including when the honest answer is that it does
not know.

---

## Elite Media Group

Performance marketing and lead generation across verticals including Medicare, ACA,
Final Expense, Spanish Final Expense, SSDI, Pest Control, HVAC, Home Insurance,
Auto Insurance, Home Security and related businesses.

The relationships that matter to the product: **publishers, vendors, buyers,
marketplaces, agencies, and internal campaigns**. A "call" is rarely just a call —
it belongs to a campaign, came from a source, was routed to a buyer, and carries
money in two directions.

**CallGrid** is currently the critical call-routing and marketplace data source.
Revenue-bearing CallGrid data is a high-rigor domain: a wrong number here becomes a
wrong business decision.

---

## EMG Talent Group

A separate EMG business line representing creators and talent. Its eventual Loop
lifecycle:

discovery → creator intelligence → media kit → brand matching → outreach →
replies → negotiation → contract → deliverables → approvals → performance →
invoicing/payment → relationship memory

**Talent is a future first-class Loop domain and is not part of the current
backend work.** It matters here for one reason: the architecture must not become
CallGrid-shaped. Design vocabulary that assumes "everything is a call" will not
survive contact with Talent.

---

## Product philosophy

> **MORE TRUSTWORTHY THAN A DASHBOARD.**

The sentence the whole product is organized around:

> **"I don't know, and here is specifically why."**

That is not an error state. It is a first-class product answer, and often the most
valuable one on the screen. Both of these are correct, complete Loop outputs:

- *"Buyer CEM's monetized rate fell 31% over the last 7 business days."*
- *"Pest Control revenue for Aug 12 is withheld because no source authority has
  been declared."*

A design that renders the first beautifully and the second as a blank cell has
made the product less trustworthy than a spreadsheet.

**The backend — not an LLM — decides whether a claim is assertable.** There is no
LLM in Loop today. Every number, every withholding reason and every "we don't
know" comes from typed backend contracts.

---

## What is real today

Durable, in production, and safe to design against:

- **Authentication, roles and permissions.** Cookie session, deny-by-default RBAC,
  server-side enforcement. One organization per user.
- **CallGrid ingestion via webhook.** Live calls arrive, get a canonical identity,
  become `IntegrationEvent` rows, and project into the operational read model.
- **The CRM surfaces** — customers, conversations, pipeline, inbox, live calls,
  workflows, users, settings. 36 mature routes.
- **Marketplace read models** — calls, campaigns, buyers, vendors, sources, bids,
  auction reports.
- **Stage 3 evidence architecture** (below): identity, occurrence, provenance,
  coverage, reconciliation, convergence, withholding.
- **The vocabularies** every uncertainty state in this document names. They are
  shipped, typed, and exported from `@emgloop/shared`.

## What remains unfinished

Be explicit with yourselves about these — designing around them is fine, designing
*as if they exist* is not:

- **No LLM.** No generated narrative, no confidence score, no natural-language
  briefing. "AI Employees" are assignable identities and configuration today, not
  reasoning agents.
- **Routine polling is built but switched off**, pending an external monitor.
- **The August 2026 data gap has not been recovered.** The operation exists; it has
  not been run.
- **Ingestion is single-tenant.** One customer's data flows today.
- **No outbound drafting.** Loop prepares nothing to send.
- **Executive Brain** exists as a surface but is fed by a demonstration path, not a
  production reasoning engine.

---

## Stage 3 in product language

Nine ideas. You need these to design the evidence surfaces; you do not need to know
how any of them is implemented.

**Webhook fast path.** CallGrid pushes each call to Loop as it happens. Fast, and
not guaranteed — in August 2026 it silently stopped for about three days.

**REST completeness path.** Loop also *asks* CallGrid for a time range and checks
what it got. This is how a gap gets found and closed. Slower, and provable.

**Canonical identity.** Every call has exactly one identity, from the provider. If
a record arrives without one, Loop **refuses it** rather than inventing an id. One
call is one row, however many times it is seen.

**Occurrence vs receipt time.** *When the call happened* and *when Loop first
received it* are different facts and are stored separately. A call recovered in
September that happened in August belongs to **August** everywhere in the product.
Never show a recovery date as a business date.

**Provenance.** Each record remembers how Loop came to know it: pushed live
(`WEBHOOK`), read back by routine polling (`API_POLL`), deliberately fetched
because it was missing (`API_RECOVERY`), or re-run from evidence Loop already held
(`LOCAL_REPROCESS`). These are different stories and the UI should be able to tell
them apart.

**Coverage.** Loop tracks the provider time it has *proven* it captured completely.
Not "when we last ran" and not "the newest call we saw" — the boundary of an
interval that was read completely and applied fully. Everything after that boundary
is unproven.

**Reconciliation.** Comparing what the provider holds for a business day against
what Loop holds. Four outcomes, and they are not degrees of the same thing:
everything accounted for; a known bounded gap; a gap nobody has declared either
way; or a comparison that cannot be trusted at all.

**Withholding.** When Loop cannot stand behind a number, it does not show a
plausible one. It withholds, and names one of thirteen specific reasons.

**Recovery.** A person deliberately re-fetches a historical range. Recorded as
`API_RECOVERY` forever, so a recovered population never looks like ordinary traffic.

**Fact conflict.** Provider values can change after a call ends — revenue often
settles later. When two *settled* values disagree, Loop changes nothing and records
the disagreement for a person. It will not pick a side.

---

## Executive OS

The intended top-level experience is a **ranked operating briefing**, not a KPI
wall. The question it answers is *"what should I look at, and why?"*

Every briefing item must be able to carry:

| | |
|---|---|
| **What happened / changed** | the measured development |
| **Why it matters** | whether it runs against a stated objective |
| **Priority** | where it sits in the ranking |
| **Affected entities** | buyer, campaign, vendor, source, vertical |
| **Economic impact** | when it can be established |
| **Evidence status** | what this claim can and cannot support |
| **Coverage / readiness** | whether the underlying period was fully captured |
| **Source / provenance** | how Loop came to know it |
| **Withheld / unknown reason** | when there is no number |
| **Time / business period** | which Eastern business days |
| **Recommended next action** | what a person can do about it |
| **Action state** | untouched, assigned, watching, resolved, dismissed |
| **Human approval requirement** | whether anything consequential needs a decision |

**Not every item has every field, and that is the design problem.** An item with a
number and an item with a withholding reason are both first-class and should feel
like siblings, not like a success and a failure.

The backend contract for this exists today and is called `HeadlineView`. It already
carries the measurement, the windows, the coverage, the limitations, the unknowns,
the rule that fired, the recurrence count and the dismissal state.

**Two fields it does not yet carry: an explicit priority rank, and a
machine-readable recommended action.** See *What requires backend coordination*.

---

## Evidence and uncertainty

These are shipped vocabularies. **Use them; do not invent a parallel set.**

### Value states the UI must preserve

| State | What it means | What it must never render as |
|---|---|---|
| **KNOWN** | Loop has the value | — |
| **UNKNOWN** | the provider has not said, or said something ambiguous | `0`, `false`, an empty cell, an unchecked box |
| **WITHHELD** | Loop could compute it but will not stand behind it | a number, or a blank |
| **INCOMPLETE** | the population is a lower bound | a total, a percentage, or a comparison |
| **CONFLICTED** | two settled values disagree; nothing was changed | either value on its own |
| **NOT APPLICABLE** | the concept does not apply to this metric | `0` or `—` without explanation |

### The shipped vocabularies

- **`READINESS_WITHHOLDINGS`** — 13 reasons a measurement is withheld, from
  `WINDOW_NOT_OBSERVED` to `SOURCE_AUTHORITY_MISSING` to `CALL_UNATTRIBUTED`.
- **`MATERIALITY_WITHHOLDINGS`** — why a measurement did not become a briefing item.
  Ships with `MATERIALITY_WITHHOLDING_LABELS` (plain-language) **and**
  `MATERIALITY_WITHHOLDING_NEXT_ACTIONS` (what to offer the person). Use both.
- **`RECONCILIATION_STATES`** — `RECONCILED` / `UNRECONCILED` /
  `UNKNOWN_EXPECTATION` / `INCONCLUSIVE`, with `RECONCILIATION_STATE_LABELS`.
- **`COVERAGE_HEALTH_STATUSES`** — `HEALTHY` / `LAGGING` / `STALE` / `NEVER_PROVEN`.
- **`OBSERVATION_SOURCES`** — `WEBHOOK` / `API_POLL` / `API_RECOVERY` /
  `LOCAL_REPROCESS`, with `OBSERVATION_SOURCE_LABELS`.
- **`FACT_CONVERGENCE_DECISIONS`** — including `CONFLICT` and `REMAIN_UNKNOWN`.
- **`NOT_MEASURABLE_INCOMPLETE_DATA`** and **`NOT_MEASURABLE_AWAITING_DATA`** —
  the two display strings for a withheld value. They read differently on purpose:
  one is missing configuration, the other is data that has not arrived yet.

### The distinction that carries the most design weight

> **"Nothing needs attention" and "Loop could not look" produce the same empty
> list.**

An empty list on its own is not an all-clear. To claim one, a surface has to say
what it checked and through when. Both states are in the fixtures
(`NOTHING_NEEDS_ATTENTION` and `NOTHING_KNOWN_YET`) precisely so you can design
them as visibly different things.

---

## Actions and approvals

Loop's human action model already exists as a shipped vocabulary.

**`PRIORITY_STATES`** — the lifecycle of an item needing a person:
`NEEDS_REVIEW` → `ASSIGNED` → `WATCHING` → `RESOLVED` / `DISMISSED`.

**`OBSERVATION_TYPES`** — 22 recorded lifecycle events, including `REVIEWED`,
`ASSIGNED`, `ESCALATED`, `NOTE_ADDED`, `CONTACT_ATTEMPTED`, `OUTCOME_RECORDED`.
This is what a timeline on an item renders.

**`OPERATIONAL_OUTCOMES`** — how something ended: `RECOVERED`, `NO_ACTION_NEEDED`,
`FALSE_POSITIVE`, `ACCEPTED_RISK`, `CONVERTED_TO_WORK`, and others.

**`HEADLINE_DISMISSAL_BASES`** — `WRONG` or `IMMATERIAL`, with labels and help
text. Dismissing an item never suppresses its recurrence; it records a judgement.

Mapping to the verbs in the brief:

| Verb | Backing today |
|---|---|
| **VIEW** | yes — read surfaces exist |
| **INVESTIGATE** | yes — evidence drill-down data exists |
| **ASSIGN** | yes — `ASSIGNED` state + `ASSIGNED`/`REASSIGNED` observations |
| **RESOLVE** | yes — `RESOLVED` state + `OPERATIONAL_OUTCOMES` |
| **DISMISS** | yes — with a required basis |
| **DRAFT** | **no** — Loop drafts no outbound content |
| **APPROVE / REJECT** | **no explicit approval primitive** — see coordination |

**Nothing consequential or outbound happens without a human.** Future Talent
outreach follows: *AI prepares draft → human reviews → human sends*. Design the
approval step as real and load-bearing, never as a confirmation dialog.

---

## Current screen inventory

**Real production functionality.** The CRM is mature; `/app` is the newer,
config-driven shell. Both exist, which is a known duplication being resolved
backend-side, not a design question for you yet.

| Surface | Status | Note |
|---|---|---|
| `/app` Executive home + Brain | **REDESIGN** | The intended Executive OS lives here. Fed by a demonstration path today. |
| `/app/admin/marketplace/*` (calls, campaigns, buyers, vendors, sources, bids, auction) | **KEEP** | Real read models, real data. Strongest existing surface. |
| `/app/admin/administration/objectives` | **REDESIGN** | Where objectives and Headlines surface. Closest thing to the briefing today. |
| `/app/admin/administration/diagnostics/callgrid` | **KEEP** | Real coverage/reconciliation diagnostics. Operator-facing. |
| `/app/admin/work/*`, `/app/employee/work/*` | **KEEP** | Real Work OS: blueprints, instances, stages, assignment. |
| `/crm/*` (36 routes) | **KEEP** | Customers, conversations, pipeline, inbox, live calls, workflows, users, settings. |
| `/crm/revenue` | **KEEP** | Cited internally as the honest-empty-state exemplar. Read it before designing an empty state. |
| `/crm/integrations/*`, `/crm/settings/integrations/callgrid` | **REDESIGN** | Integration health. Real data, operator-shaped presentation. |
| `/crm/intelligence`, `/crm/analytics` | **REDESIGN** | Real data, dashboard-shaped. |
| `/app/business`, `/app/client` | **FUTURE** | Workspace shells that are not reachable today. |
| `/app/creator/*` | **FUTURE** | Talent. Out of scope. |
| `/demo/*`, `/dashboard`, `/status`, `/login` (root) | **REPLACE** | Demo and Sprint-1 placeholders. Not production. |
| `_loop-os` primitives + `design-system.css` | **KEEP** | The shared component and token layer. Extend it; do not start a second one. |

**BACKEND-READY / UI-MISSING** — contracts that exist with no surface:

- **Coverage health** (`COVERAGE_HEALTH_STATUSES`, `/api/internal/coverage-health`)
- **Provider fact conflicts** (`provider_fact_revisions`) — recorded, never displayed
- **Three-population verification** (provider vs captured vs projected per day)
- **Recovery and drain operation results** — visible only in job logs
- **`MATERIALITY_WITHHOLDING_NEXT_ACTIONS`** — recommended actions exist, unrendered

---

## Screens Charlie and Elxi should design first

1. **Executive Brief / Home** — the ranked briefing. Must handle a mixed list of
   items with numbers and items with withholding reasons, plus the two different
   empty states.
2. **Attention / What Changed** — the full list behind the brief. Filtering,
   ranking, dismissal with a basis, and recurrence.
3. **Evidence / Why Loop Believes This** — the drill-down. Coverage, reconciliation
   state, provenance, limitations, unknowns, and the rule that fired. This is the
   screen that makes the product's claim true.
4. **Entity / Relationship Detail** — buyer, campaign, vendor, vertical. Economics
   over time, with per-value evidence state.
5. **Action / Approval** — an item needing a person: assign, investigate, resolve,
   dismiss with a basis, and the human-approval step for anything consequential.

`_loop-os/EntityPage` already establishes a detail-page pattern for (4). Start
there rather than inventing a second one.

---

## Required states

Every surface should be designed for all of these. Fixtures exist for the
data-bearing ones (see below).

`loading` · `healthy` · `empty (nothing needs attention)` ·
`empty (nothing known yet)` · `unknown` · `withheld` · `incomplete` ·
`conflicted` · `integration degraded` · `attention required` ·
`action pending approval` · `permission denied` · `error`

Note that **empty splits into two**, for the reason given above.

---

## Design fixtures

`packages/shared/src/product-states.fixture.ts`, exported from `@emgloop/shared`.

Ten representative states, typed as the **real** product contracts — if a contract
changes shape the fixtures stop compiling, so a surface built against them is built
against production's shape:

| Fixture | State |
|---|---|
| `HEALTHY_KNOWN_METRIC` | a resolved metric that still carries its caveats |
| `WITHHELD_METRIC` / `WITHHELD_METRIC_AWAITING` | the two withholding classes |
| `INCOMPLETE_CAPTURE` | population is a lower bound; nothing concludable |
| `RECOVERY_ISSUE` | a known, bounded gap |
| `UNDECLARED_GAP` | absences nobody has declared either way |
| `PROVIDER_FACT_CONFLICT` | two settled values disagree; nothing moved |
| `UNKNOWN_FACT` | provider silence that looks exactly like a "no" |
| `HIGH_PRIORITY_ATTENTION` / `INFORMATIONAL_ATTENTION` / `DISMISSED_ATTENTION` | briefing items |
| `ACTION_AWAITING_APPROVAL` | an item needing a person |
| `COVERAGE_HEALTHY` / `COVERAGE_STALE` / `COVERAGE_NEVER_PROVEN` | integration health |
| `NOTHING_NEEDS_ATTENTION` / `NOTHING_KNOWN_YET` | the all-clear and its look-alike |

They deliberately contain **no generated narrative and no confidence score**,
because Loop cannot produce those. A fixture that renders better than production
teaches a surface to display something that will never arrive.

---

## What designers may change freely

Visual hierarchy · layout · navigation proposals · interaction patterns ·
responsive behaviour · information density · component design · how the briefing is
presented · how evidence drill-down is presented · terminology *shown to users*
(the internal vocabularies are contracts; their **labels** are yours to improve).

---

## What you must not work around

These are not style preferences. Each one has already caused a real defect here.

- **Do not interpret `null` as zero.** Unknown revenue is not $0.
- **Do not interpret `false` as unknown, or unknown as `false`.** A pending
  conversion and a non-conversion are the same bytes from the provider and
  different facts in the business.
- **Do not hide `unknown` because it looks cleaner.** It is the product.
- **Do not compute certified metrics client-side from a partial population.** If
  the population is incomplete, the number is not a number.
- **Do not treat HTTP 200 as trusted data.** A successful response can carry an
  `INCONCLUSIVE` verdict or a withheld value. *HTTP success is not business
  success* is the sentence Stage 3 exists because of.
- **Do not merge provider observation with business truth.** "CallGrid said" and
  "this is so" are different claims.
- **Do not strip evidence or coverage state off an important claim** to fit a
  layout. If it does not fit, the layout is wrong.
- **Do not render an empty list as an all-clear** without saying what was checked.

---

## What requires backend coordination

Raise these before designing around them:

1. **Priority ranking.** `HeadlineView` has no rank field. What orders the brief —
   economic impact, recency, recurrence, objective weight — is an unmade decision.
2. **Machine-readable recommended actions on briefing items.**
   `MATERIALITY_WITHHOLDING_NEXT_ACTIONS` exists for withholdings; briefing items
   with numbers have no equivalent.
3. **An explicit approve/reject primitive.** `PRIORITY_STATES` covers assignment
   and resolution but has no approval gate.
4. **Economic impact on a briefing item.** Rate changes carry no money figure today.
5. **Surfacing fact conflicts.** Recorded durably, no read model or surface.
6. **Coverage health in the product UI.** The endpoint is operational, not product.
7. **Cross-entity relationship queries** (buyer × campaign × vertical over time)
   beyond what the marketplace read models already aggregate.
8. **Multi-tenancy.** One organization per user, single-tenant ingestion. Do not
   design an organization switcher yet.

# Operational Readiness Engine — Sprint 27B (PR #121B)

**Status:** implemented in PR #121B. Builds on the Work Intelligence foundation
(#121A). This doc describes what is **built**, not what is planned; it dies with
the feature. Where it and the code disagree, the code wins — fix the doc.

Audience: the next engineer adding a readiness type or wiring the engine to a
caller. Read the code it points at.

---

## What this is

A **provider-neutral** engine that DERIVES whether a real-world business process
has satisfied every required prerequisite and is therefore eligible to move to its
next operational stage. It sits between Decision and Work:

```
Information → Evidence → Reasoning → Decision → OPERATIONAL READINESS →
Suggested Handoff → Human Confirmation → Work Execution → Verification → Memory
```

It is **not** part of Work OS. **Work is created FROM readiness; readiness is
never created from work.** Concretely: the engine never reads or writes a
`WorkInstance`. Readiness is a *conclusion over supplied evidence*, never a stored
or user-entered state — there is no `ready` column anywhere.

Code:
- `packages/database/src/services/operational-readiness.ts` — the pure kernel:
  the readiness contract types, `classifyFacet` (the one place a requirement +
  evidence becomes a facet), `aggregate`/`evaluateReadiness`, and the adapter
  registry. No I/O, no clock except an injected `now`.
- `packages/database/src/services/operational-readiness.adapters.ts` — the Buyer /
  Destination and Vendor / Source adapters. The **only** place buyer/vendor
  knowledge lives.
- `packages/database/src/services/operational-readiness.service.ts` —
  `OperationalReadinessService`: runs the kernel, then resolves the next
  responsibility KEY to a PERSON and returns a **suggested handoff descriptor**.
  Creates no work, writes no handoff, persists no readiness.
- Tests: `packages/database/test/operational-readiness.test.ts`.

No migration. No new tables. Readiness is derived; evidence is an input.

---

## The load-bearing rules

1. **Readiness is DERIVED, never checked.** Every conclusion answers *why* and
   points at evidence (`reason`, `supportingEvidence`, per-requirement `reason`).
2. **Unknown never becomes Ready.** Absent evidence is `unknown` → the requirement
   is `missing`. Missing evidence never satisfies.
3. **Not Required ≠ Missing.** Applicability is derived by the adapter (e.g. the
   MSA/IO/payout/caps contract requirements apply only when a contract applies to
   the destination). A non-required requirement is `not_required` — informational,
   and it **never** fails readiness.
4. **Expired / revoked evidence revokes readiness.** Checked before satisfaction so
   a formerly-satisfying status that has lapsed cannot slip through.
5. **Approvals are version-specific.** The vendor adapter reuses the Sprint 27
   policy's `isCurrentVersionApproved`: a new creative version inherits nothing, so
   re-submitting resets approval and revokes readiness. Internal ≠ buyer.
6. **"Not Ready" is differentiated**, never one bucket:
   `blocked` (active hard blocker) · `incomplete` (an internal responsibility can
   act) · `waiting` (only an external party — buyer/vendor/documents — is
   outstanding → attention, not executable work) · `attention_required` (an
   orphaned or otherwise non-actionable gap).
7. **The engine identifies a RESPONSIBILITY, never a user.** `nextResponsibilityKey`
   is a key (e.g. `CONTRACT_REVIEW`, `CALLGRID_OPTIMIZATION`). Loop resolves the
   person: Responsibility → Assigned Person → Suggested Handoff. Never reversed.
8. **The engine only SUGGESTS.** Disposition is `no_action | attention |
   suggested_handoff`. A suggestion is not work and not a handoff row. Human
   confirmation and recipient acceptance sit between it and any work — both outside
   this engine.

---

## Adding a readiness type

Implement a `ReadinessAdapter<TEvidence>`: declare the requirement set (key, label,
category, owning responsibility, applicability, external waiting party), map your
own evidence to facets **through `classifyFacet`** (so satisfaction semantics stay
identical everywhere), and name the `advanceResponsibility` for a ready process.
Then `registerReadinessAdapter(...)`. The kernel does not change. Future types the
engine is designed for: Creator, Campaign, Launch, Invoice, Payment, Client,
Employee Onboarding, AI Worker Deployment.

---

## What this PR deliberately does NOT do

No Buyer/Vendor entities (soft attribution only — see WORK_INTELLIGENCE truth #4).
No automatic work creation. No Work OS UI, no Executive Brain → Work bridge, no
Creator/Client workflows. Those are separate, later PRs.

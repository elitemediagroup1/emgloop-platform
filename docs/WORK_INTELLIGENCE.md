# Work Intelligence — Sprint 27 Foundation (PR #121A)

**Status:** implemented in PR #121A (domain foundation). Buyer/vendor readiness
rules (#121B), internal Work OS UI (#121C), and the Executive Brain → Work bridge
(#121D) are separate, later PRs. This doc describes what is **built**, not what is
planned. It dies with the feature it documents.

Audience: the next engineer working on Work OS. Read the code it points at; where
this doc and the code disagree, the code wins and this doc is wrong — fix it.

---

## What this is

Work Intelligence extends the existing **Work OS Blueprint Runtime** (PR #75) so
Loop can coordinate real internal operations for Elite Media Group. It is **not**
a new work engine and **not** a task-management product. It is the execution layer
beneath Loop's intelligence.

Runtime code:
- `packages/database/src/repositories/work-intelligence.policy.ts` — pure policy
  (lifecycle graph, readiness derivation, version-approval truth, routing, dedupe).
- `packages/database/src/repositories/work-intelligence.repository.ts` —
  `WorkIntelligenceRepository`: manual work, lifecycle, requirements, links,
  blockers, handoffs, assets/approvals, events. All org-scoped.
- `packages/database/src/repositories/responsibility.repository.ts` —
  `ResponsibilityRepository`: first-class responsibilities + routing resolution.
- `packages/database/src/repositories/work.repository.ts` — the PR #75 blueprint
  runtime, unchanged except org-scope fixes (see below).
- Schema: `packages/database/prisma/schema.prisma` (Sprint 27 block).
- Migration: `…/migrations/20260720000000_sprint27_work_intelligence_foundation`.
- Tests: `packages/database/test/work-intelligence.test.ts`.

---

## The ten load-bearing truths

1. **Work is an execution layer, not the platform center.** The platform flow is
   Information → Evidence → Reasoning → Decision → Attention → Work → Execution →
   Verification → Organizational Memory. `WorkInstance` references evidence and
   context; it does not own organizational truth (observations, recommendations,
   companies, contracts, conversations, memory).

2. **Not every observation becomes work.** Most do not. The four outcomes of a
   meaningful observation are **memory**, **attention**, **work**, and
   **automated action**. Only the *work* path is implemented here; the Attention
   classifier and the Brain→Work bridge arrive in PR #121D.

3. **Responsibility is first-class and its assignment is configurable.**
   A `Responsibility` (e.g. `CALLGRID_SETUP`) is an organizational capability;
   `ResponsibilityAssignment` maps it to an actor. Users change; responsibilities
   remain. No user name appears in reusable domain logic — the Elite Media Group
   mapping is organization-specific seed data (PR #121B), never code.

4. **Buyer/vendor soft attribution is TEMPORARY.** The repository has no canonical
   `Company`, `Relationship`, `BuyerAccount`/`VendorAccount`, `Campaign`, `Source`,
   or `Destination` entities, and the marketplace layer deliberately refuses to
   fabricate them. For Alpha, a `WorkInstance` carries `attributionType` /
   `attributionLabel` / `attributionExternalId` soft links. **This is an Alpha
   compromise.** The long-term platform must introduce those canonical entities.
   Do not present soft attribution as the permanent architecture; do not build the
   canonical entities in this sprint.

5. **Readiness is DERIVED, never stored.** There is no editable `ready` column
   anywhere. Readiness is computed from `WorkRequirement` rows plus current-version
   approval facts by `deriveReadiness` / `computeReadiness`. Unknown is not
   satisfied; a non-required requirement is excluded (non-required ≠ missing);
   expired or revoked evidence revokes readiness.

6. **Handoff is an auditable event.** `WorkHandoff` records who, when, why, the
   readiness snapshot at propose-time, and unresolved warnings. Loop may *suggest*
   a handoff; it never performs one silently. Only the intended recipient may
   accept or reject. Acceptance changes owner + responsibility; rejection preserves
   existing ownership. Every transition writes a `WorkEvent`.

7. **Completion is distinct from verification.** `completedAt`/`completedByUserId`
   and `verifiedAt`/`verifiedByUserId` are separate. Setup work
   (`buyer_setup`, `vendor_setup`) requires an **independent verifier**: the
   verifier cannot equal the completer. Reopening preserves completion and
   verification history — it never erases it.

8. **Approvals are version-specific.** A `WorkAssetApproval` decision applies to
   exactly one `WorkAssetVersion` at one `scope` (`internal` | `buyer`). A new
   version inherits nothing. Internal approval is not buyer approval and vice
   versa. A revoked approval no longer counts. Readiness evaluates the current
   version only.

9. **Provenance is explicit.** `WorkInstance.source` is `manual | brain | rule`.
   Manual work records that it was manual; system-proposed work (later) retains
   its evidence links. Deduplication uses a deterministic `dedupeKey` with a DB
   unique constraint on `(organizationId, dedupeKey)`.

10. **Automated live work is DISABLED in Sprint 27.** No production work is created
    automatically. `AUTOMATED_ACTION_CANDIDATE` is informational only and never
    executes. Draft proposed work (a narrow allowlist requiring human acceptance)
    is wired in PR #121D, not here.

Canonical buyer/vendor modeling is **not** complete. See truth #4.

---

## Organization scoping (Multi-Tenant Rules)

- Every repository method takes `organizationId` first and resolves single rows
  with `findFirst({ where: { id, organizationId } })`, failing closed to null. A
  cross-org id is **not-found**, never forbidden — no other tenant's existence
  leaks.
- `WorkAssignment` and `WorkComment` gained `organizationId` (backfilled from the
  parent instance in the migration). `WorkRepository.getWorkInstance` is now
  `getWorkInstance(organizationId, id)` — isolation is enforced in the repository,
  not by the caller. The two `apps/web` call sites were updated accordingly.
- Isolation is enforced in repository methods, not by caller discipline; tests
  prove cross-org reads and mutations fail.

## Status vocabulary

Instance lifecycle: `draft | open | in_progress | blocked | waiting | completed |
verified | reopened | cancelled | archived`. The PR #75 blueprint runtime's
legacy `active` value remains valid on the column; the Sprint 27 lifecycle methods
refuse to drive a legacy `active` instance (use `WorkRepository` for blueprint
stage-flow work). The allowed transition graph and its guards live in
`work-intelligence.policy.ts` (`ALLOWED_TRANSITIONS`). Deletion is soft
(`cancelled` / `archived`); there is no hard delete in Alpha.

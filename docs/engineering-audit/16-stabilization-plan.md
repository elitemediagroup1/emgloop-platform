# 16 — Immediate Stabilization Plan

Work that should happen **before major new features**. Goal: make the write path and the deploy process as trustworthy as the read path already is. Nothing here is a new product; it is foundation.

## Phase 0 — Stop-the-line (this week)

| # | Action | Debt | Why now |
|---|---|---|---|
| 0.1 | **Verify preview≠production DB** in the Netlify UI; if shared, split immediately | TD-06 | A preview deploy could be mutating production data right now |
| 0.2 | Land PR #146 (CallGrid date-control) via Matt; confirm served build | — | In-flight, validated in CI, unblocks CallGrid validation |
| 0.3 | Fix the em-dash migration byte (`--`) | TD-07 | Apply-from-empty is currently broken |
| 0.4 | Confirm no real secrets in any committed file (done: clean) + rotate `LOOP_EVENT_SECRET` if ever shared broadly | TD-03 | Shared master key |

## Phase 1 — Stabilize foundations (1–2 sprints)

| # | Action | Debt |
|---|---|---|
| 1.1 | CI gate on PR→main: `npm ci` → `turbo typecheck` (exclude `marketplace-intelligence`) → `build --filter=@emgloop/web` → `turbo test` | TD-04, TD-05 |
| 1.2 | Add ESLint config + `next lint` wired into CI (start non-blocking, then enforce) | (lint gap) |
| 1.3 | Pin Node to one version across `engines`/Netlify/CI | TD-04/DEPLOY-004 |
| 1.4 | Add **cross-tenant isolation** test module (repositories) — the first web/integration tests | TEST-001 |
| 1.5 | Migration apply-from-empty CI job against a scratch DB | TD-07/DB-003 |

## Phase 2 — Restore engineering confidence (1–2 sprints)

| # | Action | Debt |
|---|---|---|
| 2.1 | Authorization: add `requirePermission` to `/app/admin/*` pages/actions (or layout-level `resource:action`) | TD-08 |
| 2.2 | Authorization test module (role×resource×action, DENY-wins) | TEST-002 |
| 2.3 | Retire dead code: delete `apps/api`, orphan `work-os` + `marketplace-intelligence` (after zero-ref confirm), `/login` placeholder, 5 sprint CSS files | TD-16, TD-17, TD-20 |
| 2.4 | Consolidate formatters to `_loop-os/format.ts` + guard test | TD-18 |
| 2.5 | Non-disclosing errors everywhere; reset-token out of URL; stale `health` fixed/deleted | TD-23, TD-24, TD-25 |
| 2.6 | Correct/collapse docs: fix README status, delete or build-then-keep `EVENT_BUS.md`, collapse 4 arch docs into one, write `LOCAL_DEVELOPMENT.md` + `ENVIRONMENT_VARIABLES.md` | TD-21, TD-22 |

## Phase 3 — Prepare for feature development (2–3 sprints)

| # | Action | Debt |
|---|---|---|
| 3.1 | Org-scoped unique keys migration (`integration_events`, `marketplace_calls`) | TD-02 |
| 3.2 | Add missing org FKs (14 models) | TD-14 |
| 3.3 | Remove `$executeRawUnsafe` DDL shim; standardize `migrate deploy`; establish a trustworthy migration baseline | TD-13, DEPLOY-003 |
| 3.4 | Fix 200-on-failure webhook contract (persist-fast + 5xx on failure) | TD-10 |
| 3.5 | Design (not yet build) per-org ingestion routing + credentials — the customer-#2 gate | TD-01 |

**Exit criteria:** green repo-wide CI on every PR; cross-tenant + authz tests passing; no orphan packages; accurate onboarding docs; trustworthy migrations; org-scoped keys/FKs; honest webhook status codes. Only then start Phase A→I feature work in `17-engineering-roadmap`.

**Explicitly excluded from stabilization:** any LLM/AI Employee work, the Accounting Center, email/calendar sync, the shell unification, and Teams/browser automation. Those are feature phases and must wait for the floor.

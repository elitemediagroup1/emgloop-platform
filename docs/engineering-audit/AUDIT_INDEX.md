# EMG Loop — Engineering Audit

**Baseline:** production `main` @ `ab830f8` · **Branch:** `chore/engineering-audit` · **Method:** full-codebase evidence sweep (source + live commands: typecheck/build/test/prisma-validate). No production runtime, DB, or browser was available — items needing those are labelled *unverified* in `20-open-questions`.

**Scope note:** the in-flight CallGrid date-control correction (**PR #146**) is *not* in this baseline; it is noted where relevant and is orthogonal to the audit's findings.

## Read in this order
1. **[00 — Executive Summary](00-executive-summary.md)** — leadership, plain language
2. [01 — Current System Overview](01-current-system-overview.md)
3. [02 — Repository Map](02-repository-map.md)
4. [03 — Current Architecture](03-current-architecture.md) · [04 — Target Architecture](04-target-architecture.md)
5. [05 — Feature/Route Inventory](05-feature-inventory.md) · [`feature-inventory.csv`](feature-inventory.csv)
6. [06 — API Inventory](06-api-inventory.md) · [`api-inventory.csv`](api-inventory.csv)
7. [07 — Database & Domain Review](07-database-review.md)
8. [08 — Auth, Authorization & Tenancy](08-auth-and-tenancy-review.md)
9. [09 — Provider & Integration](09-provider-and-integration-review.md)
10. [10 — AI, Workflow, Ingestion & Memory](10-ai-and-workflow-review.md)
11. [11 — Security Report](11-security-report.md) · [`security-findings.csv`](security-findings.csv)
12. [12 — Performance & Scalability](12-performance-and-scalability.md)
13. [13 — Testing Report](13-testing-report.md)
14. [14 — Deployment Readiness](14-deployment-readiness.md)
15. [15 — Technical-Debt Register](15-technical-debt-register.md) · [`technical-debt.csv`](technical-debt.csv)
16. [16 — Stabilization Plan](16-stabilization-plan.md)
17. [17 — Engineering Roadmap](17-engineering-roadmap.md)
18. [18 — Sprint Plan](18-sprint-plan.md)
19. [19 — New-Engineer Handoff](19-engineer-handoff.md)
20. [20 — Open Questions & Unknowns](20-open-questions.md)

## The verdict in three lines
- **Continue on this foundation — don't rewrite.** The read path is genuinely good; the code is clean at the detail level (no fake code, ~no ignored errors, 310 passing tests).
- **The write path is the work:** tenancy, async ingestion, tests/CI, and docs — in that order.
- **Hard gate:** the product cannot safely onboard customer #2 until single-tenant ingestion (`LIVE_ORG_SLUG`), global unique keys, and the shared-secret knowledge API are fixed.

## Verified corrections to `CLAUDE.md` / `docs/` (update at source)
| Claim | Reality |
|---|---|
| 47 models / 27 enums / 5 migrations | **51 / 28 / 7** |
| 19 API route handlers | **25** |
| ~10 org-no-FK models | **14** |
| "2 test files" | **25 files / 310 tests, all pass** |
| 87 docs; EVENT_BUS.md cited by 3 | **92 docs; cited by 10** |
| 6 packages | **7** (`packages/intelligence` omitted) |
| Lockfile untracked "by convention" | **committed** (CI still uses `npm install`) |
| "Brain Status: Online" hardcoded anti-pattern | **no longer present** (health derives from real report) |

## Baseline validation (live, `ab830f8`)
typecheck ✅ all shipping packages (0 errors) · `marketplace-intelligence` ❌ 62 (orphan, non-gating) · build ✅ `@emgloop/web` · tests ✅ 310/310 · prisma validate ✅ · lint ❌ unconfigured.

# 13 — Testing Gap Report

## Current coverage (verified by running the suites)

**25 test files · 310 tests · 310 passing.** (CLAUDE.md's "2 test files for ~48,000 lines" is **badly stale** — update it.)

| Suite | Files | Tests | Type |
|---|---|---|---|
| `packages/shared/test` | 8 | 94 | unit (Truth model, business-time, CallGrid windows, identity, knowledge contract) |
| `packages/database/test` | 11 | 150 | unit/integration over repositories & services (incl. `workflow-engine.test.ts`, verification suites, `FakePrisma` in-memory double) |
| `packages/providers/test` | 6 | 66 | unit (webhook security, adapters, parsing) |
| **Total** | **25** | **310** | — |

Runner: `node --import tsx --test`. Green across the board.

## Structural gaps

| Area | Covered? | Gap |
|---|---|---|
| Truth/format/date logic | ✅ Strong | — |
| Repositories/services (DB) | ✅ Good (via `FakePrisma`) | Real-Prisma integration tests absent |
| Webhook security/adapters | ✅ Good | — |
| Workflow engine | ✅ Some (`workflow-engine.test.ts`) | Scheduler (none exists) |
| **`apps/web`** | ❌ **None** | Zero web tests — no route/action/component/e2e |
| **Cross-tenant isolation** | ❌ **None** | The exact class that caused the Sprint-29A scars is untested |
| **Authorization matrix** | ❌ None | No test asserts role×resource×action |
| Auth flows (login/reset/invite) | ❌ None | — |
| API route handlers | ❌ None | No handler-level tests |
| Migration apply-from-empty | ❌ None | Would have caught the em-dash migration (DB-003) |
| Provider contract tests | ⚠️ Partial | Adapters tested; no cross-provider contract conformance |
| `marketplace-intelligence` | n/a | Doesn't typecheck; orphan |

## Finding TEST-001 — High — Testing / Multi-tenancy
**No cross-tenant isolation tests exist**, despite three cross-tenant *write* bugs having shipped historically (CLAUDE.md §Multi-Tenant Rules). Every tenancy guarantee is currently enforced by human review — the exact failure mode the constitution says review cannot sustain.
**Recommendation:** make cross-tenant access the **first** web/integration test module (see below). **Effort:** Medium. **Priority:** Immediate (Phase 2 floor).

## Finding TEST-002 — High — Testing / CI
**No repo-wide CI gate on `main`.** The only PR check (`verified-knowledge-ci.yml`) typechecks + tests just `shared` + `database`. `apps/web`, `providers`, and the build are not gated on PRs.
**Recommendation:** CI job on PR to `main`: install with `npm ci` (lockfile is committed), `turbo run typecheck` (excluding the known-broken orphan), `turbo run build --filter=@emgloop/web`, and `turbo run test`. **Effort:** Small–Medium. **Priority:** Immediate.

## Recommended test pyramid for EMG Loop

```
        e2e (Playwright) — few
        └ login→route→data smoke on /crm + /app/admin
      integration — moderate
        └ API handlers, webhook verify/replay, ingestion pipeline, cross-tenant isolation, authz matrix, migration apply-from-empty
      unit — many (already strong)
        └ Truth/format/date, repositories (FakePrisma), providers, workflow engine, brain diagnosers
```

**Minimum new modules to add, in priority order:**
1. **Cross-tenant isolation** — attempt to read/write another org's rows through each repository; assert null/not-found. *(TEST-001)*
2. **Authorization** — role × resource × action against the matrix, incl. DENY-wins and the `/app/admin/*` gap.
3. **Webhook idempotency + verification** — signature, replay, timestamp tolerance, fail-closed-on-missing-secret.
4. **Auth flows** — login active-only, reset single-use, invite acceptance, metadata-merge non-clobber.
5. **Ingestion pipeline** — raw persist → normalize → project; dedup; 200-on-failure regression once fixed.
6. **Migration apply-from-empty** — CI applies all migrations to a scratch DB (would catch DB-003).
7. Later, per phase: provider-contract conformance, workflow execution, AI approval rules, invoice reconciliation, email/calendar sync.

**Coverage target:** not a percentage — a **capability checklist**. Every tenancy/auth/ingestion invariant in `CLAUDE.md` should map to at least one test before the next feature phase.

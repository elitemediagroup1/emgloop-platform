# 18 — Recommended Sprint Plan (next 8 sprints)

One objective per sprint. Each is independently shippable and testable. Sprints 1–5 are the stabilization floor (`16`); 6–8 begin Phase B/C/D foundations. **No sprint mixes unrelated work.** Matt merges; nothing here merges itself.

---

## Sprint 1 — CI floor & reproducible builds
- **Objective:** every PR to `main` is gated.
- **Tasks:** commit-lockfile decision → switch CI to `npm ci`; add PR workflow (`typecheck` excl. `marketplace-intelligence`, `build --filter=@emgloop/web`, `turbo test`); pin Node to 20 across `engines`/Netlify/CI; add ESLint config (non-blocking first).
- **Affected:** `.github/workflows/*`, root `package.json`, `netlify.toml`, new `.eslintrc`.
- **Acceptance:** a PR that breaks typecheck/build/test cannot be green. **Tests:** existing 310 run in CI. **Migration:** none. **Security:** none. **Excludes:** any authz/tenancy code, ESLint enforcement (config only).

## Sprint 2 — Cross-tenant & authorization test net
- **Objective:** encode the tenancy/authz invariants as tests.
- **Tasks:** cross-tenant repository access module (assert null/not-found across orgs); authz matrix module (role×resource×action, DENY-wins); auth-flow tests (login active-only, reset single-use, metadata-merge non-clobber).
- **Affected:** new `packages/database/test/*`, `apps/web` test harness bootstrap.
- **Acceptance:** attempting another org's row returns not-found in every tested repo. **Tests:** the new modules. **Migration:** none. **Security:** this *is* the security net. **Excludes:** fixing found gaps (Sprint 3) — this sprint only proves them.

## Sprint 3 — Close the `/app/admin/*` authorization gap
- **Objective:** matrix-level authorization on the newest surfaces.
- **Tasks:** add `requirePermission(resource,action)` to marketplace/brain/work admin pages+actions (or a `resource:action` requirement in `app/admin/layout.tsx`); non-disclosing errors (`mapThrownError`) everywhere; reset token out of URL; fix/delete stale `health`.
- **Affected:** `app/app/admin/**`, `auth/actions.ts`, `api/**` error paths, `api/health`.
- **Acceptance:** Sprint-2 authz tests pass for `/app/admin/*`; no `err.message` reaches a client. **Migration:** none. **Security:** SEC-H3, SEC-L1/L2/L3. **Excludes:** tenancy/schema work.

## Sprint 4 — Migration baseline & apply-from-empty
- **Objective:** trustworthy migrations.
- **Tasks:** fix em-dash byte (DB-003); remove `$executeRawUnsafe` DDL shim, move enum additions to a migration (SEC-M2); CI job applying all migrations to a scratch Postgres; document a rollback runbook.
- **Affected:** `packages/database/prisma/migrations/*`, `crm/live-org.ts`, `.github/workflows/*`, `docs/runbooks/*`.
- **Acceptance:** migrations apply cleanly from empty in CI; no DDL runs from a request path. **Tests:** apply-from-empty CI. **Migration:** yes (corrective + enum). **Security:** SEC-M2. **Excludes:** org-key/FK changes (Sprint 5).

## Sprint 5 — Tenant-safe data layer
- **Objective:** remove cross-tenant collision + orphan risk.
- **Tasks:** org-scoped unique keys migration (`integration_events`, `marketplace_calls`, TD-02) with backfill; add org FKs to the 14 gap models (TD-14); fix 200-on-failure webhook contract (TD-10).
- **Affected:** `schema.prisma`, new migrations, webhook routes.
- **Acceptance:** duplicate `externalId` across two orgs both persist; org deletion cascades; a failed ingest returns 5xx and redelivers. **Tests:** ingestion + cross-tenant regression. **Migration:** yes (careful, backfill). **Security:** SEC-M1, SEC-M3. **Excludes:** per-org routing (design only).

## Sprint 6 — Dead-code retirement & doc truth
- **Objective:** eliminate parallel systems; make docs safe for a new engineer.
- **Tasks:** delete `apps/api`, orphan `work-os` + `marketplace-intelligence` (after zero-ref confirm), `/login`, sprint CSS; consolidate formatters (TD-18) + guard test; correct README status/structure; collapse 4 arch docs → one; delete or build `EVENT_BUS.md`; write `LOCAL_DEVELOPMENT.md` + `ENVIRONMENT_VARIABLES.md`; fix `.env.example` drift.
- **Affected:** `apps/api`, `packages/{work-os,marketplace-intelligence}`, `apps/web/src/app/login`, `crm/*.css`, `docs/*`, `.env.example`.
- **Acceptance:** `grep @emgloop/work-os` / `@emgloop/marketplace-intelligence` returns nothing; a new hire runs the app from docs alone. **Migration:** none. **Excludes:** shell unification.

## Sprint 7 — Knowledge/event credential scoping (Phase B tail)
- **Objective:** end the shared-secret master key.
- **Tasks:** per-producer credentials mapped to allowed scopes; derive knowledge/event scope from the credential, not the query/body (SEC-H1); timing-safe secret compares (SEC-L4); add scope-binding tests.
- **Affected:** `lib/knowledge/gateway.ts`, `api/v1/events`, `api/v1/knowledge/*`, credential storage.
- **Acceptance:** a credential cannot name a scope it isn't authorized for; scope-binding tests green. **Migration:** maybe (credential model). **Security:** SEC-H1. **Excludes:** the `LoopEvent` consumer (Phase E).

## Sprint 8 — Membership model foundation (Phase B→H enabler)
- **Objective:** unblock multi-org roles without breaking single-org today.
- **Tasks:** introduce `OrganizationMembership(orgId, userId, role)` additively; keep `User.organizationId` working via a compatibility read; migrate reads behind a helper; tests for membership resolution + isolation.
- **Affected:** `schema.prisma`, `iam.repository.ts`, `auth.repository.ts`, session resolution.
- **Acceptance:** existing single-org auth unchanged; a user can (in test) belong to >1 org; isolation tests hold. **Migration:** yes (additive). **Security:** tenancy foundation. **Excludes:** org switcher UI, super-admin (later).

---

**After Sprint 8:** the floor is done and Phase C (domain/memory) + Phase D (per-org ingestion routing — the customer-#2 gate) can begin. Revisit this plan at Sprint 5 with real deploy/runtime feedback.

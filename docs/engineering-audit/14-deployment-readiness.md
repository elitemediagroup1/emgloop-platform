# 14 — Deployment Readiness

**Can it be deployed safely today, for the current single tenant? — Yes, with caveats.** It already runs in production on Netlify. **Can it onboard a second customer safely? — No** (tenancy gates SEC-H1/H2/M3). **Is the deploy *process* trustworthy? — Partially** — the build is clean but the safety net (CI gate, migration baseline, preview/prod isolation, rollback) is thin.

## Validation performed this audit (live commands on `ab830f8`)

| Check | Result |
|---|---|
| `tsc --noEmit` — shared, database, intelligence, brain, providers, work-os, apps/web | ✅ **0 errors each** |
| `tsc --noEmit` — marketplace-intelligence (orphan, non-gating) | ❌ 62 errors (pre-existing, exact) |
| `turbo run build --filter=@emgloop/web` | ✅ PASS (~1m14s) |
| Tests — shared/database/providers | ✅ **310/310 pass** |
| `prisma validate` (dummy `DATABASE_URL`) | ✅ valid |
| `turbo run lint` | ❌ no ESLint config (never configured) |

> ⚠️ **Stale-artifact trap observed:** a leftover `.next/` from a prior branch produced 4 phantom `apps/web` typecheck errors (references to routes that don't exist on this branch). A fresh build cleared them. **Always rebuild before trusting `apps/web` typecheck** — the "false baseline" hazard is real here.

## Deployment topology (verified)

- **Netlify:** `npm run build -- --filter=@emgloop/web`, publish `apps/web/.next`, Node 22, `@netlify/plugin-nextjs`. **No redirects/headers/functions/context blocks in `netlify.toml`.**
- **Migrations:** **not run at build** (build = `prisma generate` only). Applied **manually** via `deploy-prisma-migrations.yml` (`workflow_dispatch`, typed confirmation, `DIRECT_DATABASE_URL`). A one-off `prisma-baseline-recovery.yml` exists.
- **CI:** only `verified-knowledge-ci.yml` (PR to main; typechecks/tests `shared`+`database` only). **No repo-wide gate.**

## Findings

### DEPLOY-001 — High — Deployment / Multi-tenancy
**Preview vs production environment separation is undefined in-repo.** `netlify.toml` has **no `[context.production]`/`[context.deploy-preview]` blocks**, so nothing scopes `DATABASE_URL`/`DIRECT_DATABASE_URL` per context. If Netlify UI env vars are set at the shared scope (the default), **deploy previews connect to the production database** — and with single-tenant ingestion, a preview could mutate production data. **Unverified from repo — must be confirmed in the Netlify UI out-of-band.** *Remediation:* separate preview/staging DB + per-context env vars. **Priority:** Immediate (verify), then fix. **Effort:** Small (config) once confirmed.

### DEPLOY-002 — High — DevOps
**No repo-wide CI gate on `main`.** Combined with committed-lockfile drift (CI still uses `npm install`, not `npm ci`), a bad merge can reach production without typecheck/build/test verification. *Remediation:* PR gate (`npm ci` → typecheck → build → test); see TEST-002. **Priority:** Immediate. **Effort:** Small–Medium.

### DEPLOY-003 — Medium — DevOps / Data safety
**No rollback path for schema/data.** Only a *forward* recovery workflow exists; migration history is a reconstruction and production has no `_prisma_migrations` table (migrations "fragile"). The em-dash migration (DB-003) means apply-from-empty is currently broken. *Remediation:* fix DB-003, add an apply-from-empty CI job, document a rollback runbook, treat the baseline as a Phase-C deliverable. **Priority:** Near-term. **Effort:** Medium.

### DEPLOY-004 — Low — DevOps
Node version inconsistent: `engines >=20`, Netlify 22, CI 20. Pin one (recommend 20 LTS across all three) to avoid environment-specific build surprises. **Effort:** Small.

## Recommended deployment pipeline (target)

1. **Local** — `npm ci`, `.env` from an accurate `ENVIRONMENT_VARIABLES.md`, `prisma migrate dev`, seed (demo gated).
2. **PR validation** — `npm ci` → `turbo typecheck` (exclude orphan) → `turbo build --filter=@emgloop/web` → `turbo test` → cross-tenant test module. **Required to merge.**
3. **Preview** — isolated DB, per-context env, never production credentials.
4. **Staging** — mirrors prod; run migration apply-from-empty + smoke tests.
5. **Production** — merge (Matt) → Netlify deploy of the exact commit → verify served build → migrations via `workflow_dispatch` with confirmation.
6. **Post-deploy** — smoke test, monitor, documented rollback (code via Netlify; schema via reversible migrations).

## Deploy-readiness verdict

| Question | Answer |
|---|---|
| Builds cleanly? | ✅ Yes |
| Tests pass? | ✅ 310/310 (but no web/e2e/cross-tenant) |
| Safe for current single tenant? | ✅ Yes |
| Safe for a second tenant? | ❌ No — SEC-H1/H2/M3 |
| Deploy process trustworthy? | ⚠️ Partial — no CI gate, preview/prod isolation unverified, no rollback, fragile migrations |

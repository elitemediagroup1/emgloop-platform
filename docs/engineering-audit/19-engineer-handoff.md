# 19 — New-Engineer Handoff Guide

You can run and extend EMG Loop from this guide + `CLAUDE.md` (the engineering constitution — read it first). **Do not trust `docs/` outside this audit folder** — README, AUTHENTICATION.md, EVENT_BUS.md, and DATA_MODEL.md are stale/misleading (see `20`/TD-21).

## Run it locally
- **Stack:** Turborepo + npm workspaces; Node 20; Next.js 14 (App Router); PostgreSQL (Neon) + Prisma. One deployable: `apps/web`.
- **Steps** (an accurate `LOCAL_DEVELOPMENT.md` doesn't exist yet — TD-22; until it does):
  1. `npm install` (a `package-lock.json` **is** committed — you can `npm ci`).
  2. Create `.env` — you need at least `DATABASE_URL`, `DIRECT_DATABASE_URL`. For webhooks: `CALLGRID_API_BASE_URL`, `CALLGRID_API_KEY`, `CALLGRID_WEBHOOK_SECRET`, `WEBSITE_WEBHOOK_SECRET`. For email: `RESEND_API_KEY`, `LOOP_EMAIL_FROM`. For the knowledge/event gateway: `LOOP_EVENT_SECRET`. `NEXT_PUBLIC_APP_URL` for the browser. (`.env.example` is partially wrong — cross-check against this list.)
  3. `npm run db:generate`; apply migrations against your dev DB (note DB-003 — the Sprint-11 migration has a bad byte; apply-from-empty may fail until fixed).
  4. `npm run dev` (filters to `@emgloop/web`).
- **Validate before committing:** `turbo run typecheck` (expect `marketplace-intelligence` to fail — it's an orphan, non-gating), `turbo run build --filter=@emgloop/web`, and package tests (`npm test` in `packages/{shared,database,providers}` → 310 pass). Lint is unconfigured.

## Where the major systems live
| System | Path |
|---|---|
| Product shell / routes | `apps/web/src/app/{crm,app}/**`, `src/workspaces/**` |
| Auth | `apps/web/src/auth/**`, `packages/database/src/repositories/auth.repository.ts` |
| RBAC | `packages/database/src/repositories/iam.repository.ts` (the `MATRIX`) |
| Persistence | `packages/database/src/repositories/*.repository.ts`, `services/*` |
| Ingestion | `api/webhooks/{callgrid,website}`, `packages/database/src/services/ingestion.service.ts`, `normalization.repository.ts` |
| Providers | `packages/providers/src/{interfaces,adapters,mocks}` |
| Brain (deterministic) | `packages/brain`, `packages/intelligence` |
| Work OS (real runtime) | `packages/database/src/repositories/work.repository.ts` + `src/work-os/*` |
| CallGrid Intelligence UI | `apps/web/src/app/app/admin/marketplace/**` |

## Safe to modify vs fragile
- **Safe:** CRM pages/actions (guarded, org-scoped, tested patterns), `_loop-os` primitives, adding a repository method (org-first, fail-closed to null — copy `AIEmployeeRepository`).
- **Fragile — extra care (touch only with tests):** anything tenancy (webhooks, `live-org.ts`, repositories), auth/session, `iam.repository.ts` MATRIX, migrations (baseline is a reconstruction), the two-shell CSS/token layering (`crm`/`app` layouts).
- **Don't:** add a 4th `LIVE_ORG_SLUG` reader; add a parallel system (workflow/shell/nav/token); merge to `main` (Matt merges); commit real secrets; run DDL from a request path.

## Where the mocks / unbuilt things are
- **Real:** CallGrid + Website ingestion, Resend email, the deterministic Brain diagnosers.
- **Mock/config-only (honest):** all LLM/"AI" (mock heuristic — no Anthropic/OpenAI SDK), SMS/Voice/Calendar/Payment/Analytics providers, AI Employees (identity config that never acts). Mocks live in `packages/providers/src/mocks` and the `/demo` sandbox — **they cannot run in production** (registry + email fail closed).
- **Disconnected:** `LoopEvent` gateway (`/api/v1/events`) stores rows nothing reads; `v1/knowledge/*` has no in-app consumer.

## How organization scoping works
Org **always** comes from the signed session (`session.organizationId`) — never from client input. Repositories take `organizationId` first and resolve `findFirst({id, organizationId})`, failing closed to null. The one exception is `AuthRepository`. Ingestion is the current violation: it hard-binds to `LIVE_ORG_SLUG` (single tenant).

## How to add things
- **API/action:** guard first (`requirePermission(resource,action)` or `requireCrmContext`), derive org from session, go through a repository, validate input manually (no zod yet), return not-found (null) on cross-org.
- **Model:** edit `schema.prisma`, add a migration, `db:generate`; carry `organizationId` **with an FK**; org-scope any unique key.
- **Provider:** implement the interface in `adapters/`, register via a named getter; never import a vendor SDK outside the adapter.
- **Workflow:** extend the real CRM engine (`workflows.repository.ts`) or Work OS (`work.repository.ts`) — do **not** revive the dead `@emgloop/work-os` package.

## Major known risks (read `11`, `14`, `15`)
Single-tenant ingestion (customer-#2 blocker); shared-secret knowledge master key; synchronous ingestion + 200-on-failure; preview/prod DB isolation unverified; no repo-wide CI gate; coarse `/app/admin/*` authorization; fragile migrations.

## Deploy
Netlify builds `--filter=@emgloop/web` on merge to `main`. Migrations run **manually** via GitHub `workflow_dispatch` (`deploy-prisma-migrations.yml`) with a typed confirmation — never from a request path or the build. Verify the served commit after deploy; there is no tested rollback yet.

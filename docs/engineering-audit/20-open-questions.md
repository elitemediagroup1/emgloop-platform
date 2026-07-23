# 20 — Open Questions & Unknowns

Everything below could **not** be verified from the repository/sandbox (no live DB, no production runtime, no browser, no Netlify UI access). Each item states what was attempted, what was unavailable, why it matters, and what access is needed.

| # | Unknown | Attempted | Unavailable | Why it matters | Needed |
|---|---|---|---|---|---|
| 1 | **Do preview deploys share the production DB?** | Read `netlify.toml` (no context blocks) | Netlify UI env-var scoping | A preview could mutate prod data (DEPLOY-001) | Netlify UI access / confirmation from Matt |
| 2 | **Production migration state** | `prisma migrate status` | Live DB connection; prod has no `_prisma_migrations` table | Migration drift risk; apply-from-empty broken (DB-003) | `DIRECT_DATABASE_URL` (read) or DBA confirmation |
| 3 | **Live production numbers / on-screen reconciliation** (CallGrid) | Static code trace of the aggregation path | DB + runtime + browser | PR #146 validation (Buyers/Vendors/Sources/Campaigns) | A browser authenticated to `app.emgloop.com` |
| 4 | **Actual runtime performance** (latency, cold starts, Neon connection limits) | Structural analysis | Load testing against a deployment | Scale planning (`12`) | A staging deploy + load test |
| 5 | **Netlify deploy trigger & rollback** | Read `netlify.toml`, workflows | Netlify project settings | Deploy safety/rollback (DEPLOY-003) | Netlify UI |
| 6 | **Whether orphan packages are referenced dynamically** | Static `@emgloop/*` import grep (0 hits) | Runtime/string-ref analysis | Safe deletion of `work-os`/`marketplace-intelligence` (TD-16) | Confirm no dynamic import before delete |
| 7 | **Line-by-line validation in non-CRM server actions** | Sampled CRM actions | Time-boxed | Some `app/admin`/`employee`/setup/login actions not fully audited | A focused pass in Sprint 2/3 |
| 8 | **Per-route test coverage & real-Prisma integration** | Ran unit suites (310 pass) | No web/e2e/integration-DB tests exist | Confidence on routes/ingestion end-to-end | Build the suites (Sprint 2) |
| 9 | **Is `LOOP_EVENT_SECRET` shared with external producers today?** | Code shows single shared secret | Ops knowledge | Cross-tenant master-key blast radius (SEC-H1) | Confirm distribution + rotate |
| 10 | **Whether CallGrid webhook signing secret is per-tenant** | Code uses one global secret | Provider config | Customer-#2 gate (SEC-H2) | CallGrid account config |

**Distinguish verified vs inferred:** every finding in this audit tagged *(inferred)* or listed above should be treated as provisional until the corresponding access is granted. Everything else is quoted from tracked source or live command output on `ab830f8`.

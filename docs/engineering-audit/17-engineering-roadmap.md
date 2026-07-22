# 17 — Engineering Roadmap

Ordered A→I. Each phase unlocks the next. Phases A–B are the stabilization floor (`16-stabilization-plan`); C onward builds toward the vision. This mirrors — and sequences — CLAUDE.md's Long-Term Goals.

> **Golden rule (from the audit):** async and safe **before** smart. No AI Employees until tenancy, an async spine, and a real test suite exist. Building agents on caller-enforced tenancy + synchronous ingestion + ~no web tests would compound every risk.

---

### Phase A — Repository & build stabilization
- **Objective:** clean, gated, reproducible builds.
- **Scope:** committed-lockfile + `npm ci`; repo-wide CI gate (typecheck/build/test); ESLint config; pin Node; delete dead code (`apps/api`, orphan packages, `/login`, sprint CSS); consolidate formatters; correct/collapse docs; write onboarding docs.
- **Dependencies:** none. **Risk:** low. **Effort:** Medium.
- **Acceptance:** every PR to `main` runs and must pass typecheck+build+test; a new engineer can go from clone to running app using `LOCAL_DEVELOPMENT.md`.

### Phase B — Authentication & tenant safety
- **Objective:** authorization and tenancy enforced structurally, not by review.
- **Scope:** `requirePermission` on `/app/admin/*`; cross-tenant + authz test suites; org-scoped unique keys (TD-02); missing org FKs (TD-14); **introduce `OrganizationMembership`** (enabling multi-org roles); knowledge-scope-from-credential (SEC-H1); timing-safe secret compares.
- **Dependencies:** A. **Risk:** medium (schema migrations). **Effort:** Large.
- **Acceptance:** cross-tenant tests green; no page/action under `/app/admin/*` lacks a matrix check; second-tenant data cannot collide.

### Phase C — Domain & database foundation
- **Objective:** a schema that can hold organizational memory; trustworthy migrations.
- **Scope:** canonical entity model (people/companies/threads/commitments/deadlines/decisions/risks/events); activity + event models; provider records + external IDs; audit history; `SyncCursor`; fix migration baseline (DB-003) + apply-from-empty CI; `deletedAt`/retention where audit needs it.
- **Dependencies:** B. **Risk:** medium-high. **Effort:** Large/Multi-phase.
- **Acceptance:** migrations apply cleanly from empty in CI; the memory schema exists and is documented in one `DOMAIN_MODEL.md`.

### Phase D — Integration foundation
- **Objective:** add providers without new silos.
- **Scope:** provider connection lifecycle + **encrypted credential vault**; OAuth (Google/Microsoft) connect/refresh/disconnect; sync cursors + incremental sync; webhook subscription + renewal + polling fallback; per-provider retries/rate-limits; provider health projection; **per-org webhook routing + credentials — delete `LIVE_ORG_SLUG`** (customer-#2 gate).
- **Dependencies:** B, C. **Risk:** high. **Effort:** Multi-phase.
- **Acceptance:** a second tenant onboards with its own routing/creds; a new provider is an adapter + config, not a pipeline.

### Phase E — Organizational memory
- **Objective:** the "brain's" substrate.
- **Scope:** async spine (persist-fast → queue → workers → DLQ + shared replay store); event bus (publish/subscribe/replay) or delete `EVENT_BUS.md`; bridge Spine-B `LoopEvent` into normalization; entity resolution / identity graph; relationship mapping; source provenance; searchable history (search/vector index).
- **Dependencies:** C, D. **Risk:** high. **Effort:** Multi-phase.
- **Acceptance:** an inbound signal from any provider becomes connected memory asynchronously with retries; no consumer is inline; `LoopEvent` has a consumer.

### Phase F — Work Operating System
- **Objective:** one work model, linked to memory, that can remind and escalate.
- **Scope:** collapse to a single workflow model (retire the dead `work-os` package's contracts); link Work OS to the record graph (TD-12); tasks/assignments/approvals/reminders/notifications (email/SMS/push); **scheduler** for SCHEDULE workflows + due dates (TD-15); distinguish suggested/approved/assigned/recurring at the model level.
- **Dependencies:** C, E. **Risk:** medium. **Effort:** Large.
- **Acceptance:** "start work from this call/customer" works; a due date fires a reminder; one workflow system, not three.

### Phase G — AI Employees (deliberately last)
- **Objective:** real, scoped, approval-gated actors.
- **Scope:** a real AI provider behind `ai.provider.ts`; wire `channels`/`operatingHours`/`escalationRules`/`dnaOverrides`; scoped memory + tools (allow/forbid); **human approval before external actions**; cost + action limits; full audit/execution history with citations; escalation + override. Implement the named `BrainService` sub-services over real signals first.
- **Dependencies:** B, E, F. **Risk:** high. **Effort:** Multi-phase.
- **Acceptance:** every AI action is scoped, logged, cited, and (for external effects) approved; no cross-tenant leakage; UI never overclaims.

### Phase H — Department modules
- **Objective:** vertical operating surfaces over the shared memory.
- **Scope:** Accounting Center (invoice↔CallGrid reconciliation — new finance domain per `10-ai-and-workflow-review` §D + `07-database-review` DB-004), Sales, Client Success, Talent Management, Executive Operations. Each projects into shared types; none forks intelligence shapes.
- **Dependencies:** C–G as relevant per module. **Risk:** medium per module. **Effort:** Large each.
- **Acceptance:** a module is config + projections, not a parallel system; Accounting can reconcile a real CallGrid invoice end-to-end with an audit trail.

### Phase I — Scale & reliability
- **Objective:** run many tenants reliably.
- **Scope:** queues/workers hardening; scheduled jobs; connection pooling; read replica / analytics DB; search + vector; object storage; caching; rate limiting; observability (correlation ids, audit, traces); disaster recovery + rollback.
- **Dependencies:** E onward. **Risk:** medium. **Effort:** Multi-phase.
- **Acceptance:** the 100-org / 1,000-user scenario in `12-performance-and-scalability` holds with monitoring and a tested rollback.

---

### Also: Shell unification (cross-cutting, plan-first)
Move `/crm`'s 36 real routes into `/app`'s config-driven, fail-closed shell — one nav, one guard family, one token set, phantom workspaces resolved. **Write the plan first** (none exists). Sequence after Phase B (guards unified) and alongside C. Do **not** start as a side effect.

# 07 — Database & Domain Model Review

**Schema:** `packages/database/prisma/schema.prisma` (1,838 lines) · PostgreSQL (Neon) · Prisma `^5.18.0` (CLI 5.22.0) · `prisma validate` → **valid**.
**Build/seed:** `build` + `postinstall` run **`prisma generate` only** (no migrate). Production has no `_prisma_migrations` table; migration history is a reconstruction.

---

## 1. Real counts (CLAUDE.md is stale)

| Item | CLAUDE.md | **Actual** |
|---|---|---|
| Models | 47 | **51** |
| Enums | 27 | **28** |
| Migrations | 5 | **7** |

Drift is the 4 `Marketplace*` models + `MarketplaceReportRunStatus` enum + 2 migrations added after the constitution. Update `CLAUDE.md` §Database and `DATA_MODEL.md` (which still says 28).

---

## 2. Model domains (51 models)

- **Tenant core (org-FK'd):** Organization, Location, Role, User, Customer, Interaction, Conversation, Message, Booking, Order, ServiceRequest, Signal, Workflow, WorkflowRun, AIAgent, AIEmployee, VoiceProfile, ProviderConnection, IntegrationEvent, AuditLog, OrganizationSettings/Preferences/DNA, Invitation, PasswordReset, UserSession, Permission, OrganizationCapability, DomainEvent — all carry `organizationId` **with** an `organization` relation.
- **Global catalog:** Capability (`@@unique(key)`, no org — correct).
- **Work OS (org scalar, NO FK):** Blueprint, WorkInstance, WorkNotification; child rows (BlueprintStage, WorkStage, WorkAssignment, WorkComment) scope only through parents.
- **Verified Knowledge `vk_*` (7 tables, org nullable, NO FK):** scoped by `platform`+`property`, not org.
- **Marketplace (4 tables, org scalar, NO FK):** MarketplaceCall, MarketplaceBidSourceSnapshot, MarketplacePingDestinationSnapshot, MarketplaceReportRun.
- **Producer event store (no org at all):** LoopEvent (platform/site-scoped).

Every model has `createdAt` (most `+updatedAt`). **No model has a `deletedAt` soft-delete column** — lifecycle is via status enums / `isActive` / `onDelete: Cascade`.

---

## 3. Findings

### Finding DB-001 — High — Multi-tenancy / Data-integrity
**Title:** 14 models carry `organizationId` as a bare scalar with **no foreign key** to Organization.
**Evidence:** Work OS (Blueprint, WorkInstance, WorkNotification), `vk_*` (7), Marketplace (4). Every migration header states the FK omission is deliberate ("purely additive"). *(CLAUDE.md said ~10; real is 14 because the 4 Marketplace tables post-date it.)*
**Why it matters:** Deleting an Organization **orphans** these rows (no cascade), and nothing at the DB level prevents an `organizationId` that references no org. Referential integrity for tenant data is partially enforced only in application code.
**Recommendation:** Add FKs with `onDelete: Cascade` in a dedicated additive migration once the migration baseline is trustworthy (Roadmap Phase C). Until then, document the orphan risk in any org-deletion runbook.
**Effort:** Medium. **Priority:** Before onboarding customer #2 / before any org-deletion feature.

### Finding DB-002 — High — Multi-tenancy
**Title:** `integration_events` is uniquely keyed `@@unique([provider, externalId])` **globally**, not per-org; `marketplace_calls` repeats the same pattern.
**Evidence:** `schema.prisma:766` (IntegrationEvent), `:1598` (MarketplaceCall).
**Why it matters:** Two tenants receiving a provider event with the same `externalId` **collide** — the second is treated as a duplicate and dropped. This silently loses data the moment a second tenant exists. Cannot be fixed in callers; needs a migration to `@@unique([organizationId, provider, externalId])`.
**Recommendation:** Migration to make the unique key org-scoped. Coordinate with the `LIVE_ORG_SLUG` removal (they share the multi-tenancy gate).
**Effort:** Medium (migration + backfill). **Priority:** Before customer #2. **Dependency:** trustworthy migration baseline.

### Finding DB-003 — Medium — Database / Migration safety
**Title:** The Sprint-11 migration's first line begins with a UTF-8 em-dash `—` (`e2 80 94`) instead of `--`.
**Evidence:** `migrations/20250626000000_sprint_11_provider_category_ingestion_analytics/migration.sql:1` (hexdump-confirmed).
**Why it matters:** That line is **not a valid SQL comment**; a clean `prisma migrate deploy` would throw a syntax error before reaching the `ALTER TYPE`. It has only ever "worked" because production self-healed the enum at runtime, not by applying the file. This is a live landmine for anyone rebuilding the DB from migrations.
**Recommendation:** Fix the byte to `--` in a corrective commit; make repeatable migration-apply from empty a CI job (Roadmap Phase A/C).
**Effort:** Small. **Priority:** Next sprint (part of migration-baseline work).

### Finding DB-004 — Medium — Domain modelling
**Title:** No accounting/finance domain exists — money is fields, not a domain.
**Evidence:** Zero models match invoice/bill/payment/reconciliation/ledger/bank/payout/transaction. Money lives as `*Cents` fields on `Order`, `MarketplaceCall`, and Marketplace snapshots; `ProviderCategory.PAYMENT` enum exists with no backing tables.
**Why it matters:** The planned **Accounting Center** (invoice ↔ CallGrid reconciliation) has no schema to build on. See `10-ai-and-workflow-review` §Accounting readiness for the proposed minimum domain.
**Recommendation:** Model Invoice / InvoiceLineItem / Bill / Payment / ReconciliationRecord / Discrepancy / Approval / Attachment / AccountingConnection as a new bounded context (Roadmap Phase H). Reuse `ProviderConnection` + `IntegrationEvent` for QuickBooks/bank ingest.
**Effort:** Large. **Priority:** Near-term (when Accounting Center is scheduled), not before foundations.

### Finding DB-005 — Medium — Domain modelling / Scale
**Title:** No sync-cursor/watermark model, no DLQ/retry table, no core-pipeline entity-resolution model.
**Evidence:** `ProviderConnection.lastSyncedAt` is the only cursor-like field. Entity resolution exists only inside `vk_*` (platform-scoped), not for `Customer`/`Interaction` (which dedup on `@@unique([org, externalId])` + last-7-digit phone match in `IngestionService.resolveCustomer`).
**Why it matters:** Blocks reliable incremental sync across many providers and blocks the async spine (Roadmap Phase D/E). See `10-ai-and-workflow-review`.
**Recommendation:** Add `SyncCursor` (per org+provider+stream) and a durable dead-letter/retry table when the queue lands.
**Effort:** Medium. **Priority:** Phase D.

### Finding DB-006 — Informational — Modelling honesty (a strength)
`MarketplaceCall` money is **nullable cents, never 0-defaulted** — matching the "Unknown is not zero" Truth discipline. Two columns use `@map` to preserve physical names after renames (`monetized @map("qualified")`, `connectedDurationSeconds @map("durationSeconds")`) to avoid a migration. Good, honest data modelling — preserve it.

---

## 4. Repository org-scoping (verified)

- **Reference-safe (org-first, resolve-within-org, fail-closed to null):** `AIEmployeeRepository` (`updateEmployee(organizationId, id, fields)` → `findFirst({id, organizationId})`, `if(!existing) return null`), `MarketplaceCallRepository` (all reads take `organizationId` first).
- **Mixed (the surface the PR #76 scar warns about):** `WorkRepository` — good in `completeCurrentStage`/`createBlueprintStage` (explicit `organizationId !==` checks → treat as not-found), weaker in `getWorkInstance(id)`, `createBlueprint(input)`, `markNotificationRead(notificationId, userId)` which rely on org travelling inside the input object. Tighten these to first-arg org scope.
- **Legitimate cross-org exception:** `AuthRepository` (per CLAUDE.md).

`NormalizationEngine` lives in `normalization.repository.ts` but is a **service** — the naming leak CLAUDE.md flags. Rename when touched.

---

## 5. Structural ceiling: one org per user

`User.organizationId` is a scalar with a single FK. **No membership table, no org switcher.** This blocks platform super-admin, cross-org vendors/creators/clients, and any of the target roles that span organizations (see `08-auth-and-tenancy-review` §7). Introducing an `OrganizationMembership(orgId, userId, role)` join is the enabling schema change for Roadmap Phase B/H — a schema decision, not a refactor.

---

## 6. Retain / refactor / replace

| Verdict | Models |
|---|---|
| **Retain** | All org-FK'd tenant-core models; Capability catalog; the ingestion trio (ProviderConnection, IntegrationEvent, DomainEvent) |
| **Refactor** | Work OS + Marketplace + `vk_*` → add org FKs (DB-001); IntegrationEvent/MarketplaceCall → org-scoped unique (DB-002); add `deletedAt` where audit needs it |
| **Add** | OrganizationMembership; SyncCursor; DLQ/retry; Accounting domain (DB-004); core-pipeline entity-resolution |
| **Replace/retire** | The dead `@emgloop/work-os` package's parallel workflow model (not a DB model, but the "canonical contracts the runtime ignores") |

Cross-refs: tenancy → `08`; ingestion/events → `10`; migration/deploy safety → `14`; debt table → `15`.

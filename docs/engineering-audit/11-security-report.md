# 11 — Security Report

**Method:** static review of auth, RBAC, tenancy, API handlers, webhook verification, secret handling, injection sinks, and logging (no exploitation, no production testing). **Headline: no Critical or High finding that blocks production for the *current single tenant*.** The High-severity items are **multi-tenancy readiness gates** — they block *customer #2*, not the current deployment. Authentication and webhook verification are genuinely strong.

## Severity summary

| Sev | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 3 | SEC-H1 (knowledge shared-secret cross-tenant), SEC-H2 (LIVE_ORG_SLUG single-tenant), SEC-H3 (authz coarse on `/app/admin/*`) |
| Medium | 3 | SEC-M1 (200-on-failure), SEC-M2 (`$executeRawUnsafe` DDL in request path), SEC-M3 (global unique keys) |
| Low | 4 | SEC-L1 (reset token in URL), SEC-L2 (err.message leak), SEC-L3 (stale health endpoint), SEC-L4 (non-timing-safe secret compare) |
| Informational | — | strong auth primitives; no secrets committed; no injection sinks; clean logs |

---

## High

### SEC-H1 — Knowledge/event shared secret is a cross-tenant, cross-capability master key
- **Category:** Multi-tenancy / API. **Blocks production?** For a second knowledge producer/tenant: **yes**.
- **Evidence:** `api/v1/events/route.ts:49,57`, `lib/knowledge/gateway.ts:68,74` — one `LOOP_EVENT_SECRET` authenticates both the event gateway and all knowledge routes; tenant scope (`organizationId`/`platform`) is **client-supplied** and only presence-checked. Plain `!==` compare.
- **Attack scenario:** any holder of the secret names an arbitrary `organizationId` and reads/writes any scope's knowledge/claims.
- **Remediation:** per-producer credentials mapped to allowed scopes; derive scope from the credential; `timingSafeEqual`. **Effort:** Medium. **Priority:** Before new features / second producer.

### SEC-H2 — Single-tenant ingestion (`LIVE_ORG_SLUG`)
- **Category:** Multi-tenancy. **Blocks production?** Blocks **onboarding a second customer**.
- **Evidence:** `crm/live-org.ts:18` consumed by callgrid/website webhooks + callgrid sync; one global webhook URL + one global signing secret.
- **Attack/impact scenario:** not an external attack — a **data-integrity** failure: all inbound data writes into `servicesinmycity-demo` regardless of origin. A second tenant's webhooks would contaminate the first.
- **Remediation:** per-org routing + per-org signing secrets; derive org from the credential. **Effort:** Large. **Priority:** Before customer #2. (CLAUDE.md Long-Term Goal #1.)

### SEC-H3 — Authorization on `/app/admin/*` is workspace-level, not matrix-level
- **Category:** Authorization. **Blocks production?** No (read-mostly today), but must be fixed before any mutation lands there.
- **Evidence:** `app/app/admin/layout.tsx:18` `requireWorkspace('ADMIN')` only; marketplace/brain/work pages lack `requirePermission`. A MANAGER reaches admin intelligence surfaces the matrix would restrict. Full detail in `08-auth-and-tenancy-review` AUTHZ-001.
- **Remediation:** add `requirePermission(resource,action)` per page/action, or require a `resource:action` in the admin layout. **Effort:** Medium. **Priority:** Before new features.

---

## Medium

### SEC-M1 — Webhooks/auction-sync return 200 on failure
- **Category:** API/Reliability. **Evidence:** `webhooks/callgrid`, `webhooks/website`, `integrations/callgrid/auction-sync` return `ok:true` on partial/total failure. **Impact:** providers don't redeliver → silent data loss. **Remediation:** 5xx on persist failure. **Effort:** Medium. **Priority:** Next sprint. (See API-002.)

### SEC-M2 — `$executeRawUnsafe` DDL reachable from the webhook request path
- **Category:** Production safety. **Evidence:** `crm/live-org.ts:66-67` runs `ALTER TYPE "ProviderCategory" ADD VALUE IF NOT EXISTS …` inside `ensureLiveOrganization()`, imported by callgrid/website webhooks + callgrid sync.
- **Why it matters:** violates two CLAUDE.md rules ("zero raw SQL", "no destructive DDL from a request path"). **Mitigations present:** static literals (not injectable), `schemaChecked` once-per-instance flag, try/catch, additive-only. Low exploit risk; real risk is an unexpected schema mutation from request traffic.
- **Remediation:** remove the shim once `migrate deploy` is standard; move enum additions to a migration. **Effort:** Small. **Priority:** Next sprint (with migration-baseline work).

### SEC-M3 — Global unique keys enable cross-tenant collision
- **Category:** Multi-tenancy/DB. **Evidence:** `integration_events` and `marketplace_calls` `@@unique([provider, externalId])` (DB-002). **Impact:** second tenant's same-`externalId` events dropped as duplicates. **Remediation:** org-scoped unique key (migration). **Effort:** Medium. **Priority:** Before customer #2.

---

## Low

- **SEC-L1** — reset token echoed in redirect URL (`auth/actions.ts:96`) → history/referrer/log exposure. Deliver via email only. *Small / Next sprint.*
- **SEC-L2** — `err.message` echoed to clients (`brain/call-handling-briefing:253`, `sync:110`, `backfill:78`). Adopt the knowledge routes' non-disclosing `mapThrownError`. *Small / Next sprint.*
- **SEC-L3** — `health` endpoint always reports `not_configured` (stale) — misleading monitor signal. Make real or delete. *Small.*
- **SEC-L4** — `LOOP_EVENT_SECRET` compared with plain `!==` (not `timingSafeEqual`), unlike the webhook HMAC path. Low practical risk; align for consistency. *Small.*

---

## Informational — verified strengths (preserve)

- **Authentication:** scrypt + per-user salt, SHA-256 token-at-rest, `timingSafeEqual`, httpOnly+secure+lax cookie, anti-enumeration reset, single-use hashed reset/invite tokens.
- **Webhook verification:** HMAC-SHA256, timing-safe, 300 s tolerance, fail-closed when secret missing, unsigned rejected in prod.
- **Secrets:** **zero `NEXT_PUBLIC_` usage**, no hardcoded keys/tokens/passwords, only blank `.env.example` committed.
- **Injection:** no `eval`, no `dangerouslySetInnerHTML`, no dynamic raw SQL (the one raw call is a static-literal DDL shim, SEC-M2).
- **Tenancy:** no `formData.get('orgId')` anywhere; core CRM derives org from session; repositories scope `{id, organizationId}` and fail closed.
- **Logging:** 47 `console.*` calls, none logging secrets/tokens/PII.
- **Metadata bag** merged, not replaced (the historical clobber bug is fixed and guarded).

## Recommended security test suite (none exists today)
Start with **cross-tenant access attempts** (the class that produced the Sprint-29A scars): attempt to read/write another org's rows via every repository; assert null/not-found. Then: authz matrix per role per resource; webhook signature/replay/timestamp; reset/invite token single-use; knowledge-scope binding once SEC-H1 is fixed. See `13-testing-report`.

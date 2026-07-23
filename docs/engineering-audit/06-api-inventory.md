# 06 — API Inventory

**Surface:** **25** route handlers under `apps/web/src/app/api/**` (CLAUDE.md says 19 — stale; the 7 `v1/knowledge/*` routes post-date it) + server actions in `apps/web/src/crm/**` and `app/**/actions.ts`. **No standalone API app** — `apps/api` is a dead 35-line stub.

**Validation posture:** **No `zod` anywhere** in `apps/web/src` — all input validation is manual `String(formData.get())` coercion / regex / whitelist. Guards: `requirePermission(resource,action)`, `requireSession`, `requireCrmContext()` (auth+org), `customerBelongsToOrg` (per-record).

---

## 1. Route handlers

Legend: **Auth** · **Org** (S=session-derived, H=hardcoded `LIVE_ORG_SLUG`, C=client-supplied, —=public) · **200-on-fail?**

| Path (`.../api/`) | Methods | Purpose | Auth | Org | 200-on-fail |
|---|---|---|---|---|---|
| `webhooks/callgrid` | POST,GET | CallGrid ingress → full pipeline | HMAC/bearer/static over `CALLGRID_WEBHOOK_SECRET`, fail-closed prod | **H** | `ok:true` even if `results[].failed` |
| `webhooks/website` | POST,GET | Website ingress, 2 auth tiers | public `pk_emg_*`+domain OR HMAC | **H** | same partial-failure masking |
| `integrations/callgrid/sync` | POST | Pull reconcile recent calls | `can('integrations','manage')` | **H** | 500 on error |
| `integrations/callgrid/auction-sync` | POST | 1-day auction report ingest | `can('integrations','manage')` | S | **`200 ok:true` for partial/failed by design** |
| `integrations/callgrid/backfill` | POST | Retrofit MarketplaceCall projection | `can('integrations','manage')` | S | 500 |
| `integrations/callgrid/reconcile` | GET | Live-vs-Loop forensics (read-only) | `can('integrations','manage')` | S | 502 on upstream |
| `integrations/callgrid/auction-reconcile` | GET | Auction diff (read-only) | `can('integrations','manage')` | S | body-level ok |
| `integrations/callgrid/discover-reports` | GET | Probe report contracts | `can('integrations','manage')` | S | body-level |
| `brain/call-handling-briefing` | GET | Brain diagnostic (read-only, **unlinked**) | `can('intelligence','manage')` | S | 500, **leaks `err.message`** |
| `live/activity` · `live/calls` · `live/websites` | GET | Live feeds (polled) | `can('intelligence','view')` | S | — |
| `revenue` · `traffic` | GET | Dashboards | `can('analytics','view')` | S | surfaces `partial` |
| `sdk/config` | GET | Public per-property SDK config | **none** | property | 404 |
| `sdk/emg-loop` | GET,OPTIONS | Serves browser SDK JS, `ACAO:*` | **none** | — | — |
| `health` | GET | Health probe | **none** | — | **stale: reports everything `not_configured`** |
| `v1/events` | POST,GET(405) | Loop Event Gateway (store raw) | shared `LOOP_EVENT_SECRET`, **plain `!==`** | **C** (body `platform`/`site`) | dedup `eventId`; **no consumer** |
| `v1/knowledge/import` | POST | Batch KG import | `authenticateService` (`LOOP_EVENT_SECRET`) | **C** scope | idempotent `(scope,key)`, 409 |
| `v1/knowledge/claims` | GET | Query claims | `authenticateService` | **C** | non-disclosing |
| `v1/knowledge/claims/[id]` · `entities/[id]` · `readiness` · `stats` | GET | KG reads/probes | `authenticateService` | **C** | non-disclosing |
| `v1/knowledge/query` | GET,POST | **Re-export of `../claims`** (alias) | inherited | **C** | duplicate URL |

---

## 2. Webhook verification (strong — a bright spot)

Shared crypto in `packages/providers/src/webhook-security.ts`: HMAC-SHA256, **constant-time compare** (`safeEqualHex` → `timingSafeEqual`), message binds `timestamp.rawBody`, **300 s tolerance**, **fail-closed when secret missing** (prod never allows unsigned via `webhook-runtime.ts`). CallGrid multi-mode: signature is authoritative when present (no fall-through on failure); bearer/static tokens compared via length-safe hashed compare. **Replay protection is an in-memory `Map`** (best-effort per serverless instance; documented). Idempotency on `(provider, externalId)` is the real defense.

---

## 3. Findings

### Finding API-001 — Medium — Multi-tenancy / API (see also TENANCY-001)
**Title:** `v1/events` and all `v1/knowledge/*` routes authenticate with one shared `LOOP_EVENT_SECRET` and take **tenant scope from the client** (query/body), never binding it to the credential.
**Evidence:** `api/v1/events/route.ts:49,57`; `lib/knowledge/gateway.ts:68,74` (`resolveScopeFromQuery`, `validateScopeObject`). Both use plain `!==` string compare (not `timingSafeEqual`, unlike the webhook path).
**Why it matters:** The shared secret is effectively a **cross-tenant, cross-capability master key** — a holder can name any `organizationId`/`platform` and read/write any scope. This is the "self-declared isolation" CLAUDE.md flags, now confirmed at the code level.
**Recommendation:** Derive scope from the credential (per-producer keys mapped to allowed scopes); switch secret comparison to `timingSafeEqual`. Until then, keep tenant-sensitive data out of the knowledge graph.
**Effort:** Medium. **Priority:** Before new features / before a second knowledge producer.

### Finding API-002 — Medium — API contract / Reliability
**Title:** Webhooks and `auction-sync` return HTTP `200 ok:true` on partial/total ingest failure.
**Evidence:** `webhooks/callgrid` & `webhooks/website` return `ok:true` with `results[].status==='failed'` nested; `auction-sync` returns `200` for `partial`/`failed` runs by design (verdict in `result.overall`).
**Why it matters:** Providers key redelivery off HTTP status. A `200` on a failed ingest means **the provider never retries** — silent data loss. CLAUDE.md Long-Term Goal #3 calls this out ("Fix the 200-on-failure contract").
**Recommendation:** Return `5xx` when any event fails to persist so providers redeliver; keep the raw-persist-then-process split so a persisted-but-unprocessed event is retryable without provider help.
**Effort:** Medium. **Priority:** Next sprint (couples with the async spine).

### Finding API-003 — Low — Observability / Correctness
**Title:** `health` route is a stale Sprint-1 placeholder reporting every provider and the database as `not_configured`.
**Evidence:** `api/health/route.ts` — hardcoded response despite a live DB and real CallGrid/Resend/Website providers.
**Why it matters:** A health endpoint that always reports "down" is worse than none — monitors and humans learn to ignore it.
**Recommendation:** Make it a real probe (DB ping + provider-connection status) or delete it.
**Effort:** Small. **Priority:** Next sprint.

### Finding API-004 — Low — Security / Info-leak
**Title:** A few routes echo `err.message` to clients.
**Evidence:** `brain/call-handling-briefing/route.ts:253`, `integrations/callgrid/sync/route.ts:110`, `backfill/route.ts:78`. (The knowledge routes' `mapThrownError` non-disclosing pattern is the model to copy.)
**Recommendation:** Return a generic error + server-side log with a correlation id; adopt `mapThrownError` everywhere.
**Effort:** Small. **Priority:** Next sprint.

### Finding API-005 — Informational — Disconnected
`v1/events` stores `LoopEvent` rows that **nothing reads** (`listLoopEvents`/`markLoopEventProcessed` have zero callers). `v1/knowledge/*` `verifiedKnowledge` repo is referenced only by those routes — no in-app consumer. Both are external-facing gateways. Per CLAUDE.md: "give `LoopEvent` a consumer or delete the gateway." See `10-ai-and-workflow-review` §Events.

### Positive
All CRM server actions derive org from `session.organizationId` (`grep formData.get('orgId')` → 0 hits), mutating actions all call `requirePermission` (~40 sites), and status codes are generally correct (401/403/404/400/405/500/502). The one debt cast is `admin-actions.ts:374` (`statusRaw as any`, whitelist-checked first).

---

## 4. Server actions (summary)

| File | Guarded by | Org from session? |
|---|---|---|
| `crm/admin-actions.ts` (invite/role/status/org/AI-employee) | `requirePermission` per action | ✓ |
| `crm/actions.ts` (notes/status/tags/assign/pipeline/bulk) | `requireCrmContext` + `customerBelongsToOrg` | ✓ |
| `crm/integration-actions.ts` | `requirePermission('integrations')` | ✓ |
| `crm/workflow-actions.ts` | `requirePermission('workflows')` | ✓ |
| `crm/conversation-actions.ts` | `requirePermission('inbox'/'customers')` | ✓ |
| `app/admin/**/actions.ts`, `employee/work/actions.ts`, `setup-actions.ts`, `auth/actions.ts` | mixed (login/setup intentionally unauthenticated) | varies — **not line-audited (unverified)** |

Note: several actions **silently `return`** (no-op) on invalid input / cross-org id — deliberate fail-closed-as-not-found, but users get no error feedback. Consider surfacing a benign validation message.

Cross-refs: verification crypto detail → `09`; ingestion pipeline → `10`; security severities → `11`.

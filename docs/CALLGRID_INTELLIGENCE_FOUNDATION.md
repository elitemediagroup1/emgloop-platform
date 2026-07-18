# CallGrid Intelligence Foundation — Discovery, Business Model, Gap Analysis

**Status:** Discovery deliverable (Tasks 1–3). No feature code. Facts only, with file:line evidence.
**Author:** Lead Platform Engineer discovery pass.
**Environment boundary (read first):** This report is built from the EMG Loop **codebase**. This environment has **no CallGrid API credentials, no CallGrid API documentation beyond what the code encodes, and no live database.** Therefore "what CallGrid exposes" is asserted as *fact* only where the code integrates or the confirmed OpenAPI comment records it. Anything else is marked **UNVERIFIABLE FROM HERE** and is never assumed to exist. This directly honors the mission rule: *do not fabricate; if CallGrid cannot expose something, document it.*

---

## 0. Executive finding

Brain's operational picture of CallGrid is limited by a hard external fact, not by Loop's effort:

> **The only CallGrid API surface the platform integrates — or documents as confirmed — is a single endpoint, `GET /api/call` (completed calls), plus call-lifecycle webhooks.** The confirmed CallGrid OpenAPI `Call` object carries ids, economics (revenue/payout/cost/rate), duration and status flags — and **nothing about bids, auctions, winning bids, rejections, caps, recordings, transcripts, refunds, chargebacks, agents, or dispositions.**

Everything the mission lists under *Bids / Auctions / Winning Bid / Rejected Bids / Rate-Limited Bids / Caps / Recordings / Transcripts / Refunds / Chargebacks / Disposition / Agent* is **not present on any CallGrid surface the code integrates or confirms.** The `bidStats`/`stats`/`rejections` "report endpoints" appear **only as comments and unused type stubs** in `packages/marketplace-intelligence` (`callgrid-input.ts:10`, `callgrid-assembler.ts:5`) — there is **no client, no fetch, no persistence, no runtime reference** to them anywhere in `packages/providers` or `apps/web`.

So the honest scope of "complete visibility into what CallGrid can technically provide" splits cleanly:
- **Attainable now (verifiable):** complete, first-class **per-call** visibility (the `/api/call` object + webhook lifecycle). Today this data is real but lives in JSON (`Interaction.metadata`), not as a queryable business entity.
- **Blocked (needs CallGrid access we cannot verify):** the entire **bid/auction economy** and **call media** (recordings/transcripts) and **financial reversals** (refunds/chargebacks). These require either a confirmed CallGrid reports/GraphQL API + credentials, or additional webhook event types — none of which are evidenced in this environment.

---

## 1. Verified CallGrid API inventory (facts)

| Surface | Exists in code? | Exact location | Auth | Notes |
| --- | --- | --- | --- | --- |
| **REST — completed calls** | ✅ Integrated | `GET {CALLGRID_API_BASE_URL||https://api.callgrid.com}/api/call` — `callgrid-api.ts:31-32`, request built `:284-290` (`startDate`,`endDate`,`maxItems`,`useCursor`,`searchAfter`,`reportTimeZone`) | Bearer `CALLGRID_API_KEY` (`:297`) | Cursor pagination (`fetchAllCallGridCalls` `:326`, cap 25 pages `:329`). The **only** CallGrid REST endpoint the platform calls. |
| **Confirmed `Call` schema** | ✅ Documented from OpenAPI | `callgrid-api.ts:15-27` (header, read from `api.callgrid.com/openapi`) | — | Fields: `id, buyerId, sourceId, destinationId, campaignId, phoneNumberId, callHash, callSid, to, from, callStatus, callDuration, live, completed, ended, connected, connectFailed, noConnect, noRoute, duplicate, blocked, paid, converted, billable, revenue, payout, rate, cost, createdAt, updatedAt`. **Only ids — no vendor field, no names** (`:21-22`). |
| **REST — reports/bidStats/stats/rejections** | ❌ NOT integrated | Referenced only as comments/type stubs: `marketplace-intelligence/src/callgrid-input.ts:10`, `callgrid-assembler.ts:5,117,205`. No client, no `fetch`, no route. | — | **UNVERIFIABLE FROM HERE.** Cannot confirm these endpoints exist on CallGrid. Building a client would be fabrication until confirmed. |
| **GraphQL API** | ❌ None | grep: no GraphQL client/schema for CallGrid anywhere. | — | UNVERIFIABLE. |
| **Webhook (real-time)** | ✅ Integrated | `POST /api/webhooks/callgrid` — `apps/web/src/app/api/webhooks/callgrid/route.ts`; parse `callgrid.provider.ts:191`. | HMAC via `CALLGRID_WEBHOOK_SECRET` (`callgrid-webhook-verification.ts`) | Events (call lifecycle **only**): `call.inbound/answered/missed/completed/voicemail/transferred` — `CALLGRID_EVENT_MAP` `callgrid.provider.ts:51-77`. No bid/auction/refund/recording events. |
| **Manual sync / reconciliation** | ✅ Integrated | `POST /api/integrations/callgrid/sync` → `CallGridReconciliationService.reconcile()` (`callgrid-reconciliation.service.ts:136`) → `/api/call`. | Bearer | On-demand backfill/enrich. Ranges `today/24h/7d` (`sinceForRange :115`). |
| **Scheduler / cron / queue / poller** | ❌ **None** | grep: no `node-cron`, `BullMQ`, worker, or `setInterval` poller for CallGrid. Sync is manual only. | — | If scheduled polling is wanted, it must be **built** (e.g. a protected cron endpoint / Netlify scheduled function invoking the existing reconcile). |
| **Env / config** | — | `CALLGRID_API_KEY`, `CALLGRID_API_BASE_URL`, `CALLGRID_WEBHOOK_SECRET`, `CALLGRID_ADDED` | — | Base URL overridable so prod host can be confirmed without a code change (`callgrid-api.ts:12-13`). |

---

## 2. Persistence inventory (where CallGrid data lands today)

No CallGrid-specific Prisma model exists (verified against `packages/database/prisma/schema.prisma` + all migrations). A call flows into **generic** tables:

- **`IntegrationEvent`** (`schema.prisma:748-770`) — raw envelope; full payload in `.payload` JSON (`ingestion.service.ts:151`). Idempotency key `@@unique(provider, externalId)`.
- **`Interaction`** (`schema.prisma:371-397`) — the call as a normalized interaction. First-class columns: `channel=PHONE, kind=PHONE_CALL, direction, occurredAt, provider='callgrid', externalId`. **All economics/attribution live in `Interaction.metadata` JSON** (`normalization.repository.ts:257-262`) — keys: `revenue, payout, cost, telco, rate, durationSeconds, buyer(Id), vendor(Id), source(Id), campaign(Id), destination(Id/Number), callerState, callerZip, billable, paid, converted, completed, noRoute, qualified, endedBy`.
- **`Signal`**, **`DomainEvent`** — derived/advisory copies of the same metadata.
- **`Interaction.payload`** JSON column exists but is **never written** for calls (stays `{}`).

**Consequence:** every economic/attribution field is present-or-absent (never fabricated to 0) but is **unqueryable at the SQL/column level** — consumers parse JSON at read time (`revenue-intelligence.repository.ts:178-184`).

---

## 3. Per-concept discovery table

For each concept: **(1)** CallGrid exposes it? **(2)** where? **(3)** Loop ingests it? **(4)** stored where? **(5)** consumed by? **(6)** should consume? **(7)** Brain access? **(8)** what to build.

Legend for column 8: 🟢 already available · 🟡 promote-from-JSON (real data, needs persistence) · 🔴 needs CallGrid access we cannot verify.

### Group A — Calls & call lifecycle (VERIFIED, real)

| Concept | 1 Exposed | 2 Where | 3 Ingested | 4 Stored | 5 Consumes today | 6 Should | 7 Brain | 8 To build |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Call | ✅ | `/api/call`; webhook | ✅ | `Interaction` (+metadata) | revenue/traffic/live repos, Module 1 | Brain | ✅ | 🟡 first-class `Call` entity |
| Call Status | ✅ | `callStatus`; webhook `CALLGRID_EVENT_MAP` | ✅ (coarse) | `Interaction.channel/kind/direction`; raw in metadata | live repos | Brain | ✅ | 🟡 persist raw `callStatus` (BUSY/FAILED/REJECTED distinctions currently collapsed) |
| Duration | ✅ | `callDuration` | ✅ | metadata `durationSeconds` | traffic/live | Brain | ✅ | 🟡 column |
| Disposition | ⚠️ partial | `endedBy` (webhook only, `callgrid.provider.ts:214`); status flags | partial | metadata `endedBy` | — | Brain | ✅ | 🟡 persist; 🔴 richer disposition (agent notes) not exposed |
| Qualified Calls | ✅ (derived) | derived from billable/converted/paid `callgrid-api.ts:198` | ✅ | metadata `qualified` | traffic, Module 1 | Brain | ✅ | 🟡 column |
| Billable Calls | ✅ | `billable` | ✅ | metadata `billable` | Module 1 | Brain | ✅ | 🟡 column |
| Routing / Destination | ✅ (ids) | `destinationId`, `to` | ✅ | metadata `destination(Id/Number)` | — | Brain | ✅ | 🟡 column; 🔴 routing *decisions* (why routed) not exposed |
| Geo — State / City / ZIP | ⚠️ partial | `InboundState`/`InboundZip` (webhook `:264-265`); **not** on REST `Call` object | partial (webhook only) | metadata `callerState/callerZip` | — | Brain | ✅ | 🟡 column; 🔴 City not exposed |
| Agent | ❌ | not on `Call` object; no webhook field | ❌ | — | — | Brain | ✅ | 🔴 needs CallGrid API confirmation |
| Schedule / Time-of-day / Day-of-week | ✅ (derivable) | from `createdAt`/`occurredAt` | ✅ | `Interaction.occurredAt` | — | Brain | ✅ | 🟢 derive in intelligence (real timestamp) |

### Group B — Economics (VERIFIED, real; margin derivable)

| Concept | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Revenue | ✅ | `revenue` | ✅ | metadata `revenue` | revenue/traffic, Module 1 | Brain | ✅ | 🟡 column |
| Payout | ✅ | `payout` | ✅ | metadata `payout` | Module 1 | Brain | ✅ | 🟡 column |
| Cost (telco) | ✅ | `cost` (`telco` mirror) | ✅ | metadata `cost/telco` | Module 1 | Brain | ✅ | 🟡 column |
| Rate | ✅ | `rate` | ✅ | metadata `rate` | — | Brain | ✅ | 🟡 column |
| Margin / Profit | ⚠️ derived | `revenue − payout − cost` (all real) | ✅ (derivable) | not stored | Module 1 (computed) | Brain | ✅ | 🟢 compute from real terms (never estimated) |
| ROI | ⚠️ derived | `(revenue − payout − cost) / cost` | ✅ (derivable when cost>0) | not stored | — | Brain | ✅ | 🟢 compute; undefined when cost=0 (never faked) |
| Refunds | ❌ | not on `Call` object; no webhook | ❌ | — | — | Brain | ✅ | 🔴 needs CallGrid financial API/webhook (unverified) |
| Chargebacks | ❌ | not exposed | ❌ | — | — | Brain | ✅ | 🔴 needs CallGrid financial API/webhook (unverified) |

### Group C — Attribution entities (VERIFIED as ids; names only via webhook)

| Concept | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Buyer | ✅ id | `buyerId` (REST); `buyer`/`BuyerName` (webhook/legacy only) | ✅ | metadata `buyerId`,`buyer` | revenue/traffic, Module 1 | Brain | ✅ | 🟡 first-class `Buyer` entity; 🔴 **name→id resolution** needs a CallGrid entity endpoint (REST gives only ids) |
| Vendor | ⚠️ | **NOT on REST `Call` object** (`callgrid-api.ts:21`); only webhook `vendor`/`VendorName` | partial | metadata `vendor` | traffic | Brain | ✅ | 🔴 vendor identity needs a CallGrid vendor endpoint (unverified) |
| Publisher | ⚠️ | treated as Source/Vendor; no distinct field | partial | metadata `source`/`vendor` | traffic | Brain | ✅ | 🔴 distinct publisher entity needs CallGrid API |
| Traffic Source | ✅ id | `sourceId`; `source`/`SourceName` (webhook) | ✅ | metadata `sourceId`,`source` | traffic, Module 1 | Brain | ✅ | 🟡 first-class `Source`; 🔴 name resolution |
| Campaign | ✅ id | `campaignId`; `campaign` (webhook) | ✅ | metadata `campaignId`,`campaign` | traffic, Module 1 | Brain | ✅ | 🟡 first-class `Campaign`; 🔴 name resolution |
| Vertical / Service Type | ❌ | not on `Call` object; no field | ❌ | — | — | Brain | ✅ | 🔴 needs CallGrid campaign/vertical metadata API (unverified) |

### Group D — Bid / auction economy (**NOT EXPOSED by any verified surface**)

Every row here: **1 = NO** (no verified CallGrid surface exposes it), **3 = NO**, **4 = —**, **7 = YES (Brain should)**, **8 = 🔴**. The `bidStats`/`rejections`/`stats` types in `callgrid-input.ts` are **contract stubs, not an integration** — nothing fetches them.

| Concept | Status | What must be built (once CallGrid access is confirmed) |
| --- | --- | --- |
| Bids / Bid Requests / Bid Responses | 🔴 not exposed | Confirm CallGrid bid/reports API (or bid webhook) → adapter client → persistence (`Bid`/`Auction`) → repository → intelligence |
| Auction Results / Winners / Losers | 🔴 not exposed | Same. No auction object anywhere in code. |
| Winning Bid / Avg Winning Bid / Avg Bid | 🔴 not exposed | Same (would come from a `bidStats` report *if it exists*). |
| Rejected Bids / rejection causes | 🔴 not exposed | Would come from `bidStats/rejections` *if confirmed*; type stub only (`callgrid-input.ts:70-91`). |
| Rate-Limited Bids | 🔴 not exposed | No field/endpoint anywhere. |
| Buyer Caps / Vendor Caps | 🔴 not exposed | No cap field on `Call`; no caps endpoint. Confirm CallGrid caps API. |

### Group E — Call media (**NOT EXPOSED**)

| Concept | Status | Evidence / build |
| --- | --- | --- |
| Call Recordings (URL/audio) | 🔴 not exposed | No `recording`/`recordingUrl` mapped anywhere; provider header *claims* it but no `pickField` reads it (`callgrid.provider.ts` — grep-confirmed absent). Needs confirmed recording field/API. |
| Transcripts | 🔴 not exposed | No transcript ingested; live webhooks historically empty. `signal-registry.ts:87` only opportunistically reads `metadata.transcript` if it ever appeared. Needs CallGrid transcription (or a transcript sensor). |

### Group F — Trends & seasonality (derivable from real timestamps)

| Concept | Status | Build |
| --- | --- | --- |
| Time-of-day / Day-of-week / Hourly / Daily / Weekly / Monthly trends | 🟢 derivable | Real `occurredAt` supports all of these deterministically. Needs windowing/bucketing in the intelligence layer + enough history. **No CallGrid dependency.** |
| Seasonality | 🟡 derivable *with history* | Needs multiple periods of stored calls; honest "Not enough data" until history accrues. |

### Group G — Operational health (Loop-side, real)

| Concept | 1 | 3 | 4 | Build |
| --- | --- | --- | --- | --- |
| API Errors | ✅ (Loop-side) | ✅ | `CallGridApiError` (`callgrid-api.ts:70`); reconcile `errors[]` (`callgrid-reconciliation.service.ts:100-112`) | 🟢 surface in briefing "evidence sources" |
| Sync Errors | ✅ | ✅ | reconcile result counts | 🟢 surface |
| Webhook Failures | ✅ | ✅ | `IntegrationEvent.status=FAILED` + `.error` (`ingestion.service.ts:283`) | 🟢 surface |
| Latency | ⚠️ partial | ❌ | not measured | 🟡 measure fetch latency in the client; not a CallGrid field |

---

## 4. The canonical Business Model (sensor-neutral)

Designed around **business concepts**, not CallGrid tables or JSON. CallGrid is one **sensor** that populates these; a future Ringba/Invoca/internal auction populates the same shapes. (This aligns with the existing `@emgloop/marketplace-intelligence` canon and the Platform Constitution's provider-agnostic rule — the persistence must not be a CallGrid-branded fork.)

**Operational entities** (facts a sensor emits):
- **Call** — one phone call: identity, timestamps, duration, status/disposition, geo, routing/destination, and its economics (revenue, payout, cost, rate) + outcome flags (billable/qualified/converted). *Real today (in JSON).*
- **Buyer / Vendor / Source / Campaign** — marketplace participants, each an identity + rolled-up performance over a window. *Ids real today; names partial.*
- **Auction** — one bid event for a call: the requests, the responses, the winner, the losers, the winning price. *Not available.*
- **Bid** — one participant's offer in an Auction: amount, accepted/rejected + reason, rate-limited. *Not available.*
- **Transcript / Recording** — the call's media + extracted signals. *Not available.*
- **RevenueEvent / Reversal** — realized revenue and its refunds/chargebacks. *Realized real (as call revenue); reversals not available.*

**Intelligence entities** (what Brain produces — already modeled in `@emgloop/intelligence`, reused verbatim):
- **Trend / Change** — a metric's movement across windows.
- **OptimizationOpportunity** & **Risk** — each a Brain `RecommendationEnvelope` (reason + expected impact + confidence).
- **Recommendation** — the canonical explainable action.
- **Forecast** — a directional projection with an explicit basis + confidence.

**Lifecycles Brain must reason across** (mission Task 5): Auction → Call → Revenue → Profitability, per Buyer / Vendor / Source / Campaign, over time. Today only the **Call → Revenue → Profitability** spine is populatable; the **Auction** spine is blocked on CallGrid access.

---

## 5. Gap analysis (per entity)

| Entity | State | Classification |
| --- | --- | --- |
| **Call** | Real, but in JSON | **Partially complete** — needs first-class persistence + transformation + repository (🟡). |
| **Buyer / Source / Campaign** | Ids real, names partial | **Partially complete** — persist rollups from calls (🟡); name↔id resolution **needs CallGrid entity API** (🔴). |
| **Vendor / Publisher** | Webhook-only, absent on REST | **Partially complete / Needs CallGrid API** (🔴 for identity). |
| **Margin / Profit / ROI / Trends / Seasonality** | Derivable from real data | **Missing computation only** — build in intelligence layer, no CallGrid dep (🟢/🟡). |
| **Auction / Bid / Winning Bid / Rejections / Rate-limited / Caps** | Not exposed | **Impossible today → Needs CallGrid API + new webhook + new persistence + repository + intelligence** (🔴). |
| **Recordings / Transcripts** | Not exposed | **Impossible today → Needs CallGrid media API/transcription + new persistence** (🔴). |
| **Refunds / Chargebacks** | Not exposed | **Impossible today → Needs CallGrid financial API/webhook** (🔴). |
| **Agent / Vertical / City** | Not exposed | **Missing → Needs CallGrid API confirmation** (🔴). |
| **Optimization / Risk / Recommendation / Forecast** | Modeled in `@emgloop/intelligence` | **Complete** (reused). Quality scales with the data above. |
| **API/Sync/Webhook health** | Real, Loop-side | **Complete** — surface it (🟢). |

---

## 6. What can be built now WITHOUT fabrication (implementation scope)

The grounded, non-fabricated foundation — makes the **real per-call data** a first-class, queryable business entity and lets Brain reason across the full **call → revenue → profitability** lifecycle with exact data and time-based trends:

1. **Persistence:** a sensor-neutral, first-class **Call** entity (every field `/api/call` + webhooks provably deliver), replacing per-request JSON parsing. Additive; the JSON path stays intact.
2. **Transformation:** a projection service that materializes Call rows from the already-ingested `Interaction` store — idempotent (keyed on provider+externalId), org-scoped, demo-filtered.
3. **Repository:** windowed aggregates (current vs prior) straight from the persisted entity, incl. time-of-day/day-of-week trend buckets.
4. **Intelligence:** the module reads the persisted entity; add trend/seasonality reasoning that the real timestamps support.
5. **Health:** surface API/sync/webhook health as "evidence sources" in the briefing.

Everything in Groups D/E and the 🔴 rows is **documented, not built** — each with the exact steps to build it the moment CallGrid access is confirmed. Building a client against `bidStats`/recordings/refunds now would be fabricating an integration against an unverified API, which the mission forbids.

---

## 7. Decisions that require the business owner

1. **CallGrid bid/auction/reports/media access.** The bid economy, recordings, transcripts, refunds and caps are the bulk of the mission's ask, and none are verifiable from this environment. To build them, Loop needs one of: (a) CallGrid reports/GraphQL API docs + credentials, (b) confirmation the `bidStats`/`stats`/`rejections` endpoints exist + their real shape, (c) additional CallGrid webhook event types. Until then these are documented gaps.
2. **Persistence architecture.** Recommended: a sensor-neutral first-class entity (any sensor can populate), consistent with the Constitution and the marketplace canon — not a CallGrid-branded table, and not staying in JSON.

---

## 8. MarketplaceCall — migration & rollback plan (implemented)

The sensor-neutral `MarketplaceCall` projection is implemented in this branch (schema, projection mapper, repository, read-path wiring, tests).

**Migration** — `packages/database/prisma/migrations/20260717000000_marketplace_call/migration.sql`:
- **Additive & non-destructive.** Creates exactly one table (`marketplace_calls`). It does **not** alter or drop `interactions`, `integration_events`, or any existing table. `Interaction`/`Interaction.metadata` remain the source of truth (spec pts 3, 7).
- Verified to **exactly match Prisma's own generated DDL** for the model (columns, types, defaults, unique key `(provider, externalId)`, all indexes).
- Apply with `prisma migrate deploy` (no data transform; the projection is populated separately by `projectWindow`, the ingestion write-through, or the read-path backfill).

**Rollback** — zero-data-loss because nothing else is touched:
```sql
DROP TABLE "marketplace_calls";
```
The projection is **rebuildable at any time** from `interactions` via `MarketplaceCallRepository.projectWindow(orgId, since, until)` (idempotent upsert on `(provider, externalId)`), so dropping it loses no source data. Reverting the code (repository + loader) restores the prior `Interaction.metadata` read path.

**Backfill / population paths** (spec pt 16):
1. **Read-path self-heal** (implemented): when a window has zero projected rows, the loader runs `projectWindow` for that window before aggregating — idempotent, bounded to the window.
2. **Scheduled/manual sync** (recommended next): call `projectWindow` from the existing reconciliation/sync path or a cron endpoint.
3. **Ingest write-through** (recommended next): `projectInteraction` after each Interaction is normalized, for real-time freshness.

**Tests** (`marketplace-call.verification.ts`, run via tsx — all pass): idempotent projection, null preservation, tenant isolation, cents-based economics, duplicate external ids, reprocessing an updated Interaction.

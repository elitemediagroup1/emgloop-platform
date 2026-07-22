# 12 — Performance & Scalability

Assessed from architecture + code shape (no load testing possible in this environment — runtime numbers are **unverified**; the structural risks below are verified from code).

## 1. What fails first as usage grows

| Rank | Bottleneck | Evidence | Fails at |
|---|---|---|---|
| 1 | **Synchronous ingestion in the webhook request** | `IngestionService.ingest` runs normalize→project→enrich→NBA before returning (`ING-001`) | High webhook volume / any slow downstream step |
| 2 | **Serverless DB connections (Prisma on Netlify functions)** | Prisma client per function invocation against Neon; no evidence of pooling config | Concurrency spikes → connection exhaustion |
| 3 | **In-memory replay `Map` + in-request idempotency** | `webhook-security.ts` `seenSignatures` Map, per-instance | Multiple serverless instances → replay protection ineffective |
| 4 | **Global unique keys** (`integration_events`, `marketplace_calls`) | `@@unique([provider, externalId])` | Second tenant → cross-tenant collisions/drops (DB-002) |
| 5 | **Unbounded activity/event tables** | `Interaction`, `Signal`, `DomainEvent`, `AuditLog`, `MarketplaceCall` grow without partitioning/archival; no `deletedAt`/retention | Large tenants over time → query latency |
| 6 | **No caching / repeated dashboard reads** | dashboards are `force-dynamic` server reads each request | Many concurrent execs on wide aggregates |

## 2. Growth scenarios (structural, not benchmarked)

| Scenario | Holds today? | First required change |
|---|---|---|
| 1 org / 10 users | ✅ Yes | — |
| 10 orgs / 100 users | ⚠️ **Blocked by tenancy** (`LIVE_ORG_SLUG`, global keys), not by perf | Per-org ingestion + org-scoped keys |
| 100 orgs / 1,000 users | ❌ | Async spine + connection pooling + table indexing/partitioning |
| 1,000 orgs / 10,000 users | ❌ | Dedicated workers, read replicas / analytics DB, search index |
| High-volume email ingestion | ❌ | Queue + workers + sync cursors + backpressure |
| High-volume webhooks | ❌ | Persist-fast + queue; drop the 200-on-failure contract |
| Large AI usage | ❌ (no AI yet) | Cost limits, rate limits, async execution |
| Large activity history | ⚠️ | Indexing already decent (`[org, occurredAt]` etc.); add partitioning + archival |

## 3. Provisioning milestones

- **Now → customer #2:** per-org routing/creds, org-scoped unique keys (tenancy, not perf).
- **Queue + workers + DLQ + shared replay store:** the moment ingestion moves off the request path (Phase 3) — required before onboarding beyond a handful of active tenants.
- **Connection pooling (PgBouncer / Neon pooled URL):** verify/enable now; serverless + Prisma needs it before concurrency grows.
- **Scheduled jobs:** when reminders/SCHEDULE workflows ship (WF-001).
- **Search index / vector search:** when organizational-memory retrieval and AI recall land (Phase E/G).
- **Analytics/read replica:** when executive dashboards over large tenants get slow.
- **Object storage:** when documents/attachments/email bodies are ingested (email/calendar/accounting phases).

## 4. Quick wins (verified, low-risk)

- Enable/verify the **Neon pooled connection string** for serverless functions.
- Add `.filter`-friendly indexes already largely present — audit `MarketplaceCall` and `vk_*` query paths when they get hot.
- Consolidate duplicated formatters (FE-001) — trivial, avoids recompute inconsistencies.
- Cache the unlinked/expensive Brain briefing if it ever gets linked.

## 5. Frontend performance

Server-component-first with only 6 tiny client leaves → **small client bundles, minimal hydration** (a genuine strength). Shared First-Load JS ≈ 87 kB (from build output). Risk is server-side data fetch latency on wide aggregates, not client weight. Keep the server-component discipline.

**Unverified:** all latency/throughput numbers, cold-start impact, Netlify function timeout headroom, actual Neon connection limits — require load testing against a real deployment.

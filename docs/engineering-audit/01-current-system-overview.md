# 01 — Current System Overview

## What EMG Loop is today (evidence-based)

A **single-tenant, single-deployable CRM + CallGrid marketplace-intelligence application** with an honest, well-built **read path** and an incomplete, fragile **write/processing path**. It is not yet the "organizational memory / operating brain" of the product vision — but the foundation for it (clean auth, repository pattern, provider abstraction, Truth-honest data discipline) is real.

## How it works (one paragraph)

A user logs in (`/crm/login`), gets an httpOnly `emgloop_session` cookie (scrypt + SHA-256 token-at-rest), and is routed once (`app/app/page.tsx`) to a workspace home based on their `SystemRole`. Pages are React Server Components that guard themselves (`requirePermission` / `requireCrmContext`) and read through org-scoped repositories in `packages/database`. Inbound data arrives by CallGrid/Website webhooks, is verified (HMAC, timing-safe, fail-closed), stored raw as an `IntegrationEvent`, then **synchronously** normalized into `Interaction`/`Signal`/`DomainEvent`, projected into `MarketplaceCall`, and run through a real trigger→action workflow engine — all inside the webhook request. The CallGrid Intelligence surface (`/app/admin/marketplace`) and the CRM surface (`/crm/*`) render this data with deliberately honest empty/unknown states. "AI" and "Brain" are deterministic rule logic; there is no LLM.

## What's built vs. not (headline)

**Built & production-grade:** authentication, RBAC matrix, CRM (customers/conversations/pipeline/inbox/revenue/analytics/workflows/settings/audit), CallGrid ingestion + reconciliation + intelligence dashboards, Work OS (blueprints/instances/stages/assignments), team lifecycle + invitations, the admin command center, Resend email.

**Config-only / honest placeholders:** AI Employees (identity config, no execution), Executive Brain (deterministic, one unlinked endpoint), Creator Hub / Accounting / CRM-nav items (honest "not configured").

**Not built:** any LLM, SMS/Voice/Calendar/Payment/Analytics providers, async processing (queue/worker/DLQ), event bus, scheduler, multi-tenant ingestion, org membership, accounting domain, email/calendar sync, a real test suite + CI gate.

## The through-line (matches CLAUDE.md)

> The read path is trustworthy; the write path is not. Everything worth doing next is about making the write path — tenancy, ingestion, events, tasks — as reliable as the read path, and only then making it *smart* (AI).

## Biggest risks, ranked

1. **Single-tenant ingestion** (`LIVE_ORG_SLUG` + global unique keys) — blocks customer #2 and would silently cross-contaminate data. *(Blocker)*
2. **Synchronous ingestion + 200-on-failure** — silent data loss + no scale headroom.
3. **Preview/prod DB separation unverified** — preview deploys may hit production data.
4. **Authorization coarseness on `/app/admin/*`** — workspace-level guard, not matrix-level.
5. **Almost no automated safety net** — a handful of tests, no repo-wide CI gate on `main`.
6. **Stale/aspirational docs** — a new engineer would be actively misled by README, AUTHENTICATION.md, EVENT_BUS.md, DATA_MODEL.md.

Read next: `00-executive-summary` (leadership), `03/04` (architecture), `16` (stabilization), `17` (roadmap).

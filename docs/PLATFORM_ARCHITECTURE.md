# EMG Loop — Platform Architecture

EMG Loop is an intelligence platform. Its core product is the **Brain**: a
provider-agnostic, tenant-safe system that ingests, normalizes, understands, and
acts on real business events. CRM, Analytics, AI Employees, Workflows, Creator
Management, Business Portals, Customer Portals, and Revenue Intelligence are all
**interfaces into the Brain** — not standalone features.

This document is the permanent reference for how the pieces fit together. It was
established in Sprint 12 (EMG Brain Foundation). It does not change Sprint 11
behavior; it formalizes the architecture every future sprint plugs into.

## Packages

- `@emgloop/shared` — cross-cutting types/constants (events, channels, tenancy).
- `@emgloop/providers` — provider abstraction + registry + adapters (CallGrid).
- `@emgloop/database` — Prisma schema, repositories, and the Sprint 10/11
  services (Normalization, SignalRegistry enrichment, IngestionService,
  NextBestActionService).
- `@emgloop/brain` — **new in Sprint 12.** The permanent Brain architecture:
  contracts and deterministic scaffolding for the pipeline, signals, memory,
  identity, graph, knowledge, recommendation, revenue, trust, verticals, and the
  Integration Hub. Contracts only — no AI, no DB coupling (depends only on
  `@emgloop/shared`), and intentionally not yet wired into the web build.
- `apps/web` — the Next.js app (CRM + admin + webhooks).

## The Brain Pipeline

Every event flows through one path:

```
Provider
  -> Adapter
  -> Normalization
  -> Integration Event
  -> Event Store
  -> Brain
       -> Identity Resolution
       -> Memory Update
       -> Signal Detection
       -> Intent
       -> Customer Graph
       -> Recommendation
       -> Next Best Action
  -> Workflow
  -> CRM
  -> Analytics
  -> Portals
```

Sprint 10/11 implement the left half concretely (Provider, Adapter,
Normalization, Integration Event, and the first Signals/Workflows/NBA). Sprint 12
defines the permanent contracts for the Brain stages so the remaining stages are
filled in by future sprints without re-architecting.

See: `BRAIN.md`, `SIGNAL_REGISTRY.md`, `MEMORY_SYSTEM.md`,
`NEXT_BEST_ACTION.md`, `KNOWLEDGE_ENGINE.md`, `REVENUE_INTELLIGENCE.md`,
`TRUST_BOUNDARIES.md`, `INTEGRATION_HUB.md`, `API_STANDARDS.md`.

## Multi-tenancy & Trust

Every Brain object is scoped to one organization. Customer records NEVER cross
organizations. Only generalized, non-identifying learning may move to the
network or platform tier. See `TRUST_BOUNDARIES.md`.

## Vertical Brains

Care, Pets, Marriage, Services, Homes, Creator, Business, and Revenue Brains all
share the same core infrastructure and specialize only their knowledge and
prioritized signals. A vertical is configuration, not a fork.

## Deployment Architecture

The temporary runtime schema-compatibility shim from Sprint 11 remains in place.
The documented target process is:

```
Migration Created -> Reviewed -> Approved -> Applied -> Deploy
  -> Schema Verification -> Health Check
```

The current Netlify build runs only `prisma generate` (never `migrate deploy`),
which is why the shim still exists. Migrating to the process above is a tracked
follow-up (see `API_STANDARDS.md` and the Sprint 13 recommendation).

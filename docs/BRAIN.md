# BRAIN.md — The EMG Brain

The Brain is the center of EMG Loop. It receives normalized events and runs them
through a single, permanent pipeline that resolves identity, updates memory,
detects signals, infers intent, updates the customer graph, and produces
recommendations / next best actions that workflows, the CRM, analytics, and
portals consume.

This document describes the architecture established in Sprint 12
(`@emgloop/brain`). The package contains **contracts and deterministic
scaffolding only** — no AI, no provider integrations, no database coupling.

## Service boundaries

The Brain is composed of permanent service boundaries (`src/services.ts`):

- **BrainService** — top-level facade; `process(event)` runs the full pipeline.
- **IdentityResolutionService** — canonical identity engine (`src/identity.ts`).
- **MemoryService** — structured memory (`src/memory.ts`).
- **SignalRegistryService** — signal detection (catalog in `src/signals.ts`).
- **IntentService** — intent classification.
- **CustomerGraphService / OrganizationGraphService** — the intelligence graph
  (`src/graph.ts`).
- **KnowledgeService** — governed knowledge (`src/knowledge.ts`).
- **RecommendationService / NextBestActionService** — explainable
  recommendations (`src/recommendation.ts`).
- **RevenueIntelligenceService** — revenue attribution (`src/revenue.ts`).
- **LearningService** — outcome aggregation boundary (deterministic only).
- **TrustService** — data boundary enforcement (`src/trust.ts`).

## Pipeline

`src/pipeline.ts` defines `BRAIN_PIPELINE_STAGES`, the `BrainEvent` unit of work,
the `BrainPipelineStageHandler` contract (a pure, tenant-safe transform), and the
`BrainPipeline` executor that runs handlers in order and returns a
`BrainProcessResult`.

## Relationship to Sprint 11

Sprint 11 already implements working versions of several Brain concerns inside
`@emgloop/database` (NormalizationEngine, the SignalRegistry enrichment engine,
the IngestionService, and the rules-based NextBestActionService). Sprint 12 does
**not** replace them. The Brain package names the permanent boundaries those
implementations align to, so future sprints can lift them behind the Brain
facade without breaking callers.

## Principles

1. Provider-agnostic: no provider-specific logic in the Brain.
2. Tenant-safe: every object is organization-scoped; customer data never crosses
   tenants (enforced by the Trust layer).
3. Deterministic first: Sprint 12 contracts are satisfiable by rules; AI can be
   added later behind the same interfaces.
4. Explainable: signals and recommendations always carry evidence and reasons.

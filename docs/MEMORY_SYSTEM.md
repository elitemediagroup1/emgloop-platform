# MEMORY_SYSTEM.md — Structured Memory

Memory is the Brain's persistent understanding. Sprint 12 defines structured
memory contracts (`packages/brain/src/memory.ts`). There is **no vector
database** yet — memory is structured and deterministic.

## Memory kinds

Customer, Organization, Campaign, Workflow, Creator, AI Employee, Revenue,
Institutional, Knowledge.

## Every memory object declares

- **owner** — user id, AI employee id, or `system`.
- **scope** — organization (+ optional subject / location).
- **visibility** — private | network | platform.
- **confidence** — 0..1.
- **lifespan** — optional expiry and/or decay half-life.
- **version** — monotonic; bumped on each write.
- **audit** — append-only audit trail.
- **allowedAIEmployees** — which AI Employees may read it (`*` = any in-tenant).
- **body** — the structured payload (typed per memory kind).

## Access

The `MemoryStore` contract exposes `get(kind, scope)` and `upsert(record)`.
Implementations must enforce scope and visibility and never return another
organization's private memory. Cross-tenant reads are governed by the Trust
layer (see `TRUST_BOUNDARIES.md`).

## Roadmap

A later sprint may add embeddings/vector retrieval behind this same contract.
Structured memory remains the source of truth and the audit/version/expiry
guarantees do not change.

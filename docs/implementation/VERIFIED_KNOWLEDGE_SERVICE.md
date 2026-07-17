# Verified Knowledge Service (kg.v1)

EMG Loop's durable system of record for the **verified knowledge graph** produced
and consumed by PetsInMyCity. This is deliberately **distinct** from the embedding
/ RAG document store: those are AI retrieval documents; this is a verified fact
graph (entities, claims, relationships, sources, provenance, lifecycle).

Boundary: `PetsInMyCity -> authenticated Loop API -> EMG Loop -> Prisma -> Neon`.

Loop **stores and returns** verified objects plus their complete metadata. Loop is
**not** the delivery authority: PetsInMyCity's Knowledge Delivery Platform (KDP)
alone decides admissibility, freshness, ranking, conflict resolution, and safety.
Loop applies no such filtering in this phase.

The integration contract is `docs/implementation/LOOP_KNOWLEDGE_CONTRACT.md`
(authored on the PetsInMyCity side). Transport types live in
`packages/shared/src/knowledge.ts`; a copied contract fixture lives in
`packages/shared/src/knowledge-contract.fixture.ts`.

## API surface (internal, service-to-service only)

All endpoints are versioned under `/api/v1/knowledge/*`, authenticate with the
shared secret header `x-emg-loop-secret`, fail closed, and are never exposed to
browsers. Every response carries a `trace_id`.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/v1/knowledge/import` | Idempotent, atomic batch import |
| GET | `/api/v1/knowledge/claims?platform=..&subject=..[&predicate=..]` | Query claims for a subject |
| GET | `/api/v1/knowledge/claims/:claimId?platform=..` | Fetch one claim by stable id |
| GET | `/api/v1/knowledge/entities/:stableId?platform=..` | Fetch one entity by stable id |
| GET | `/api/v1/knowledge/stats?platform=..` | Scoped counts |
| GET | `/api/v1/knowledge/readiness` | Protected readiness probe |

Scope query params: `platform` (required), plus optional `property`,
`organizationId`, `workspaceId`. Scope is applied at the persistence query level,
so a request can never observe another platform/property/organization's data.

## Auth

Service-to-service only. The endpoints reuse the Loop Event Gateway secret
(`LOOP_EVENT_SECRET`); producers send it as `x-emg-loop-secret`. Missing or
invalid secret -> `401 unauthorized`. If the secret is unset on the Loop side the
endpoints fail closed (also `401`). The secret is never logged or returned.

## Tenant / platform isolation

Every stored row carries `(platform, property, organizationId?)`. Reads and writes
filter by that scope in the `WHERE` clause. Cross-tenant reads return `not_found`
or empty results rather than leaking. Provenance links and relationships are
created within a single scope only.

## Idempotency

Imports are idempotent on `(platform, property, idempotency_key)`. The batch is
hashed (sha256 of the serialized payload):

- same key + identical payload -> returns the prior result (`duplicate: true`)
- same key + different payload -> `409 conflict` (IDEMPOTENCY_CONFLICT)
- concurrent same-key imports -> the DB unique index is the race backstop; the
  loser observes P2002 and returns the winner's result as a duplicate

The idempotency key should be deterministic from dataset identity + version, not a
random request id.

## Versioning (append-only)

Entities and claims keep a stable id separate from a numeric version. Re-importing
a changed object appends a new `*Version` row and bumps the current-version
pointer; prior versions are never destroyed. Unchanged re-imports converge via
idempotency.

## Provenance

Sources are stored once per scope (`sourceKey`) and linked many-to-many to targets
(entity / claim / relationship) through `VerifiedKnowledgeProvenance`, unique on
`(sourceId, targetType, targetKey)`. Retrieval returns the linked sources inline so
the KDP has what it needs to gate delivery. Loop does not decide sufficiency.

## Transactions

A batch is validated before any mutation and applied inside a single Prisma
`$transaction`: sources, entities (+versions), claims (+versions), relationships,
provenance, and the import-batch audit row commit together or roll back together.
No silent partial durable state. A provenance link to an unknown source aborts the
whole transaction.

## Batch limits

Documented + enforced in `KNOWLEDGE_BATCH_LIMITS` (`packages/shared/src/knowledge.ts`):
4 MB body, 5k entities, 20k claims, 20k relationships, 10k sources, 40k
entity/claim source links. Exceeding a limit returns `413 too_large`.

## Typed errors

Envelope `{ ok: false, error: CODE, message, trace_id }`. Codes map to statuses in
`KNOWLEDGE_ERROR_STATUS` (bad_request 400, unauthorized 401, forbidden 403,
not_found 404, conflict 409, gone 410, too_large 413, schema_incompatible 422,
rate_limited 429, unavailable 503, internal 500). Errors never expose Prisma
traces, SQL, connection strings, secrets, or stack frames.

## Readiness

`GET /api/v1/knowledge/readiness` authenticates, then runs a trivial scoped count
against a vk_* table to confirm the schema exists, the migration is applied, and
Neon is reachable. It returns only `{ contract_version, schema_ready }` — no db
URLs, credentials, SQL, or schema internals. Failure -> `503 unavailable`.

## Data model (additive, no FKs to existing production tables)

New `vk_*` tables (mirroring the additive `loop_events` precedent):
`VerifiedKnowledgeSource`, `VerifiedKnowledgeEntity`, `VerifiedKnowledgeEntityVersion`,
`VerifiedKnowledgeClaim`, `VerifiedKnowledgeClaimVersion`, `VerifiedKnowledgeRelationship`,
`VerifiedKnowledgeProvenance`, `VerifiedKnowledgeLifecycleEvent`,
`VerifiedKnowledgeImportBatch`. Composite uniqueness on scope + stable id,
scope + version, and scope + idempotency key. Indexes support scoped queries.

## Testing (secret-free)

Tests run with the built-in Node test runner via `tsx` and require **no** database
or production credentials:

- `packages/shared/test/knowledge-contract.test.ts` — contract + fixture shape
- `packages/database/test/verified-knowledge.repository.test.ts` — repository
  behaviour (import counts, idempotency, idempotency conflict, append-only
  versioning, cross-tenant isolation, provenance) against an in-memory fake Prisma

Run: `npm run -w @emgloop/shared test` and `npm run -w @emgloop/database test`.
CI: `.github/workflows/verified-knowledge-ci.yml` runs typecheck + both suites on
pull requests with dummy env values.

## Deployment (manual, post-merge — performed by a human)

This PR intentionally does **not** touch production. After merge:

1. Ensure `LOOP_EVENT_SECRET` is set in Netlify (already used by the Event Gateway).
2. Apply the migration to Neon via the existing manual workflow
   (`deploy-prisma-migrations.yml`, `workflow_dispatch`). The migration
   `20260716000000_verified_knowledge_service` is additive only.
3. Deploy the web app through the normal Netlify pipeline (Prisma client
   regenerates on build).
4. Verify with `GET /api/v1/knowledge/readiness` (expect `schema_ready: true`).
   This validates the service WITHOUT importing any Austin data.
5. Only after PetsInMyCity PR #12 is merged should the real Austin batch be
   imported (by the producer calling `POST /api/v1/knowledge/import`).

### Rollback

The change is additive: the `vk_*` tables are independent of existing models. To
roll back, redeploy the previous web build. The tables can remain in place
harmlessly, or be dropped separately if desired (a destructive step performed
manually, never by this PR).

## Non-goals

No Lucy integration, public APIs, editorial publishing, KDP delivery policy,
embeddings/vector/RAG, dashboards, web research, additional cities, direct
PetsInMyCity DB access, or cross-EMG federation.

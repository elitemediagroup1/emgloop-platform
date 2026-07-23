# Loop Cognitive Architecture

**Status:** Increments 1–2 — **implemented**. Increment 1 = canonical domain model
+ repositories. Increment 2 = the `CognitiveEventProcessor` (nine stages),
`GovernanceEvaluator`, knowledge + active-state evaluator registries,
`CognitiveProcessingAttempt` retry/dead-letter, and the `LoopEventConsumer` that
reuses the existing ingress seam. Increments 3–4 (explainability/publishing;
real-time vertical slice + admin page) — **designed here, not yet built**. Each
section marks what is live today vs. planned.

> **Not production-ready** until the migration blocker is resolved — see
> `docs/architecture/migration-remediation-plan.md`.

> This is the canonical implementation document for the cognitive foundation.
> Where it disagrees with older `docs/` (EVENT_BUS.md, DATA_MODEL.md), this file
> and the code win. Do not claim the Brain or aggregate intelligence exist — they
> do not (see Non-goals).

---

## Product principle

Loop is not a system that periodically remembers. **Loop continuously maintains
reality.** Every permitted event resolves an identity, persists an immutable
historical fact, updates only the affected slice of current state, records *why*
that state holds, and publishes the change so products can react — with
governance, evidence, and auditability preserved end to end.

Applications and (eventually) the Brain read a **governed active-state
projection**; they must not independently reconstruct context from raw history
when a projection already exists.

---

## Architecture (data flow)

```
External event
   │  (provider adapter normalizes raw → canonical)
   ▼
Capture ──► Normalize ──► Resolve identity ──► Persist durable memory
                                                     │
                                                     ▼
                                      Evaluate governance (deny-by-default)
                                                     │
                                                     ▼
                                        Update relevant knowledge
                                                     │
                                                     ▼
                              Recalculate ONLY affected active-state keys
                                                     │
                                   ┌─────────────────┴─────────────────┐
                                   ▼  (one DB transaction)             │
                        state record + revision + evidence + outbox    │
                                   └─────────────────┬─────────────────┘
                                                     ▼
                                    Publish state change (outbox drain)
                                                     │
                                                     ▼
                                    Internal subscribers react
                                     (audit · decision · work · cache)
                                                     │
                                                     ▼
                                    Persist decision / work recommendation
```

Invariants that hold at every step:

- Durable memory is persisted **before** active-state calculation.
- A state change is **never published before its transaction commits** (outbox).
- Subscribers **never mutate** the original event.
- Recalculation touches **only affected state keys**, never a full rebuild.

---

## The canonical model (13 concepts, never collapsed)

These are distinct on purpose. Collapsing any of them into a generic "memory"
blob is the anti-pattern this architecture exists to prevent.

| # | Concept | Model | Answers |
|---|---|---|---|
| 1 | Identity | `CognitiveIdentity` | Who/what is this? |
| 2 | Role | `IdentityRole` | In what capacity does it currently participate? |
| 3 | Durable memory | `MemoryEvent` | What happened? |
| 4 | Knowledge/fact | `KnowledgeAssertion` | What do we know/believe, and why? |
| 5 | Relationship | `IdentityRelationship` | How are two identities connected? |
| 6 | Governance | `DataGovernancePolicy` | For what purpose may data be used? |
| 7 | Active state | `ActiveStateRecord` | What is currently true? |
| 8 | State evidence | `ActiveStateEvidence` | Why does the state hold this value? |
| 9 | State change | `ActiveStateRevision` + `StateChangeOutbox` | What changed, and publish it. |
| 10 | Hypothesis | `IntelligenceHypothesis` | What *appears* true but isn't accepted yet? |
| 11 | Organizational knowledge | `KnowledgeAssertion` (class `ORGANIZATIONAL`) | What has the org accepted as durable truth? |
| 12 | Subscription | `StateChangeSubscription` | Which internal service reacts to which changes? |
| 13 | Decision | `CognitiveDecision` | What was decided from state + policy + evidence? |

Supporting: `IdentityEvidence` (hashed identifiers) and `IdentityResolutionLink`
(reversible identity links).

All 15 tables are **additive**, org-scoped, and follow the newest subsystem
tenancy precedent (plain indexed `organizationId`, integrity enforced in the
repository layer). See `packages/database/prisma/schema.prisma` (section
"LOOP COGNITIVE ARCHITECTURE FOUNDATION").

---

## Identity vs. Role

The **identity is stable**; **roles are additive and may overlap**. A person can
be simultaneously a `LEAD` and a `CONSUMER`; assigning a new role never rewrites
the identity's `entityType`. This is why role is a separate table, not a column.

`CognitiveIdentity` is **not** the CRM `Customer`. CRM/Customer rows *reference*
the cognitive identity; the cognitive layer never depends on CRM. (Today's live
`IngestionService.resolveCustomer` is the de-facto resolver that the cognitive
identity will absorb — see Consolidation.)

## Memory vs. Knowledge

- **Memory** (`MemoryEvent`) is *what happened*: `PRODUCT_CLICKED`. Immutable.
  The repository exposes **no** method that mutates payload/type/timestamp — only
  `processingStatus` advances.
- **Knowledge** (`KnowledgeAssertion`) is *what we believe*: `observedInterest.color
  = Purple`, class `OBSERVED`. A memory event must never encode a conclusion
  (`INTERESTED_IN_PURPLE_SHOES`), and an inferred/predicted belief must never read
  back as a declared fact. The `assertionClass` (DECLARED/OBSERVED/INFERRED/
  PREDICTED/ORGANIZATIONAL) is preserved exactly.

## Active state is a *derived projection*

`ActiveStateRecord` is one row per `(org, identity, domain, stateKey)` — never a
giant blob. It is recomputed from memory + knowledge by versioned deterministic
rules. Every non-static state **must** carry inspectable `ActiveStateEvidence`
citing a memory event, knowledge assertion, or relationship — a confidence of
0.92 with no evidence and no rule version is forbidden.

### Evidence & revision requirements (enforced today)

`ActiveStateRepository.applyStateChange` is the correctness spine:

- **Unchanged value ⇒ no revision, no outbox** — only `lastEvaluatedAt` advances.
  A false state change is never published.
- **Every real change ⇒ exactly one `ActiveStateRevision`.**
- **A real change requires ≥1 evidence reference** (rejected otherwise).
- The state write, its revision, its evidence, and the `StateChangeOutbox` row all
  **commit in one transaction** (transactional outbox).

## Governance model (deny-by-default)

`DataGovernancePolicy` declares, per entity/event/predicate + sensitivity, the
`allowedPurposes` / `deniedPurposes`, whether aggregation / AI reasoning /
external disclosure is permitted, retention, and consent/approval requirements.

Evaluation (the `GovernanceEvaluator`, Increment 2) is **deny-by-default**: it
denies when no policy matches, consent is missing where required, the requested
purpose is absent, a denied purpose applies, the data is expired, a link was
reversed, or an assertion was revoked. Purpose limitation is real: individual
sensitive data is unavailable to a SALES purpose unless explicitly permitted, and
**aggregate eligibility is stored separately** (`MemoryEvent.aggregationEligibility`)
from individual-use purposes.

Sensitive identifiers are **never stored raw**: `IdentityEvidence.normalizedValueHash`
is an HMAC-SHA256 keyed by an env secret and **salted with `organizationId`**, so
the same email in two tenants yields different hashes — a hard cross-org
correlation boundary. A missing secret fails closed in production.

## Hypothesis vs. accepted truth

`IntelligenceHypothesis` is what *appears* to exist but is **not** accepted
organizational truth. It is only ever created `PROPOSED`; there is **no
auto-accept path**, and acceptance requires an explicit attributed human actor.
AI-generated hypotheses are subject to the same rule — an AI model can never
promote its own guess into accepted truth. (No engine generates hypotheses in
this foundation.)

## Subscriber model

`StateChangeSubscription` maps a state-change pattern (domain + stateKey glob) to
an internal reactor. **Increment 1 supports `INTERNAL_HANDLER` delivery only** —
no outbound webhooks. The publisher (Increment 3) drains the outbox, matches
subscriptions, and dispatches idempotently to internal handlers (audit, decision
evaluation, a *draft* Work OS recommendation, cache invalidation).

---

## Vertical-slice example (Increment 4 — planned)

A permitted person clicks a purple running-shoe link from SMS:

1. `PRODUCT_CLICKED` captured → identity resolved → `MemoryEvent` persisted
   ("clicked Purple Running Shoe from SMS at T") — **not** "wants purple shoes".
2. Governance allows `PERSONALIZATION` → `KnowledgeAssertion`s created (OBSERVED):
   `observedInterest.product`, `.category=Footwear`, `.attribute.color=Purple`.
3. Commerce `ActiveStateRecord`s updated (`currentProductInterest`,
   `currentCategoryInterest`, `currentAttributeInterest.color`, `intentStrength`,
   `lastCommerceSignalAt`) — confidence from the versioned rule, not hardcoded.
4. `ActiveStateEvidence` cites the click; one revision per changed key; outbox rows
   published; a `CognitiveDecision RECOMMEND` recorded (**no SMS is sent**).
5. A product consumer queries context for `PERSONALIZATION` and sees the state; a
   `SALES` query is denied the individual sensitive state.

---

## Non-goals (do not build here)

- **No Brain, no LLM, no prompts, no conversational UI, no autonomous actions.**
  The foundation is deterministic and inspectable first; the Brain will later
  *consume* memory/state/knowledge/evidence/governance, not own them.
- **No aggregate intelligence engine** (regional demand, market gaps, provider
  shortages, revenue opportunities). Only the `IntelligenceHypothesis` model +
  repository exist; computing hypotheses needs a separate approved spec with
  privacy-safe aggregation.
- **No Organizational Memory product UI, no new top-level sidebar product.** Only
  an internal admin validation page (Increment 4).
- **No external message sending.** Decisions are recorded, never executed.

---

## Consolidation — how this relates to existing systems

This is **not** a parallel system. Classification of overlapping components:

| Existing | Decision | Rationale |
|---|---|---|
| `LoopEvent` gateway + store | **REUSE (ingress)** | Its idle `processed` flag becomes the Increment-2 consumer seam. No second HTTP receiver. |
| `DomainEvent` (Executive Brain fact log) | **REUSE / coexist** | Complementary internal fact log. |
| `IntegrationEvent` | **ADAPT** | External-webhook record; live ingestion runs through it, not LoopEvent. |
| `Customer` + `IngestionService.resolveCustomer` | **ADAPT** | De-facto identity resolver the cognitive identity will absorb; Customer references CognitiveIdentity. |
| `packages/intelligence` (live Executive Brain) | **REUSE** | Hypotheses/decisions feed its sensor/observation model; do not fork it. |
| `packages/brain` type contracts (`memory.ts`, `knowledge.ts`) | **REUSE (shapes)** | The type vocabulary these tables realize. |
| `VerifiedKnowledge` (kg.v1) | **Coexist, do NOT extend** | External verbatim passthrough — a different contract from internal assertions. |
| `work-os/governance.ts` (Approval/Decision types) | **Design input** | Orphaned types-only; `CognitiveDecision` persists the shape. |
| `packages/marketplace-intelligence` | **DEPRECATE** | Zero importers, 62 typecheck errors, superseded by `packages/intelligence`. Not deleted this sprint. |
| Outbox / queue / subscriptions / consent / policy | **BUILD** | Genuinely unbuilt; extended from the LoopEvent seam, not a parallel store. |

---

## Future phases

- **Increment 2 (DONE)** — `CognitiveEventProcessor`: idempotency → normalize →
  resolve identity → durable memory → governance → knowledge → affected-state
  recalc → transaction → status transitions, with `CognitiveProcessingAttempt`
  retry/dead-letter. Evaluators are pure (no Prisma); the processor is the only
  I/O component and persists solely through the Increment 1 repositories. The
  `LoopEventConsumer` drains the existing `LoopEvent` store (its previously
  zero-caller `processed`/`markLoopEventProcessed` seam) — no second receiver.
  Org is resolved from `LoopEvent.platform` via an injected server-side resolver,
  never from the event body.
- **Increment 3 (DONE)** — `CognitiveContextService` (`getIdentityContext`,
  `explainActiveState`) maps stored rows to the Prisma-free `cognitive-context.v1`
  DTOs in `@emgloop/shared`, deny-by-default: expired/revoked/suppressed/
  unpermitted data is omitted (and disclosed in `unknowns`), stale-but-live state
  is returned and labelled, raw memory payloads never leave. `StateChangePublisher`
  drains the transactional outbox and fans each change out to one
  `StateChangeDelivery` per matching ACTIVE subscription — exactly-once per
  (change, subscriber) via the `(outboxId, subscriptionId)` unique + atomic
  single-claim, independent per-subscriber retry/dead-letter, and a `required`
  subscriber's dead-letter fails the parent while optional ones never block it.
  Four internal subscribers (audit, decision-evaluation, work-os, dashboard-
  invalidation), none of which execute an external action. `DecisionPolicyRegistry`
  is pure: three declarative policies over governed context with deterministic,
  order-independent messaging precedence (SUPPRESS > QUEUE > RECOMMEND > NO_ACTION);
  decisions are RECORDED (idempotent by revision+policy+version), never sent.
- **Increment 4** — real-time product-click vertical slice + admin-only validation
  page `/app/admin/administration/cognitive-architecture` (simulator disabled in
  production unless an explicit safe flag is set).

## Backfill strategy (future, documented, not run)

Existing CRM contacts and historical events are **not** migrated or backfilled by
this increment. A future backfill will: (1) project each `Customer` into a
`CognitiveIdentity` (idempotent on a derived canonical key), (2) replay a bounded
window of `DomainEvent`/`Interaction` history into `MemoryEvent` via the
processor's idempotent path, (3) derive active state from replayed memory. It runs
as a deliberate `workflow_dispatch`, never from a request path.

## Known migration caveat

Production has no `_prisma_migrations` table and the build runs only
`prisma generate`; the historical migration chain also contains a pre-existing
non-ASCII (em-dash) syntax error in `sprint_11` that blocks `migrate deploy`
replay. This increment's migration is therefore validated by schema-diff against a
clean Postgres **from zero** and **from the current schema** (additive, 0
destructive statements), and must be applied as a deliberate human step.

# EMG Loop Architecture — Boundaries (Phase 1)

> This document is the permanent reference for **where logic belongs** in EMG
> Loop. It is derived from the EMG Loop Constitution and the Master
> Architectural Blueprint. Every future pull request must comply with it.
> If a change does not fit one of these boundaries, the boundary — not the
> change — must be discussed first.

## The three layers

EMG Loop separates responsibilities into three strict layers. Data flows in one
direction: **Sensors → Brain → (Services / CRM read the Brain's output).**

### 1. Sensors (`@emgloop/providers`)

A Sensor observes the outside world and emits **Facts**. Nothing else.

A Sensor **may**:
- observe (pull or receive) raw events from a source system
- normalize a raw event into Loop's canonical vocabulary
- emit immutable `Fact` objects
- report its own `health()` and `capabilities()`

A Sensor **must never**:
- score, rank, or prioritize
- diagnose a root cause
- produce a recommendation
- run an optimization or experiment
- write to Knowledge or Recommendation layers

Contract: `Sensor` in `packages/providers/src/interfaces/sensor.provider.ts`.
Output unit: `Fact` in `packages/providers/src/facts.ts` (Sensors are the
producers, so Facts live in the providers package; `@emgloop/brain` re-exports
them for convenience, preserving the acyclic `brain -> providers` direction).

> A Fact states **what was observed** — never what it means.

### 2. Brain (`@emgloop/brain`)

The Brain is the only layer that **interprets, decides, and recommends**. It
consumes Facts and Signals and produces Knowledge and Recommendations.

The Brain **owns**:
- signals, memory, identity, and the knowledge graph
- diagnosis and root-cause attribution (`vendor | buyer | emg | unknown`)
- every recommendation, expressed as a `RecommendationEnvelope`
- confidence, evidence, alternatives, and unknowns (the `TrustAssessment`)

The Brain **must never**:
- talk to a vendor SDK directly (that is a Sensor's job)
- guess. When evidence is insufficient the honest answer is `unknown`.

Canonical output: `RecommendationEnvelope` in
`packages/brain/src/recommendation.ts`.

### 3. Services / CRM (the application layer)

Infrastructure and application code (database services, API routes, CRM pages)
**invoke** the Brain and **persist / present** its output. They do not decide.

The application layer **must never** own a business decision. If decision logic
is found in a service (for example, the current Next Best Action logic in the
database package), it is a **boundary violation** and is scheduled to move into
the Brain in a later Phase 1 PR. This PR establishes the target contracts; it
does not yet move that logic.

## The canonical Recommendation Envelope

Every recommendation anywhere in Loop inherits `RecommendationEnvelope`:

| Field | Meaning |
|---|---|
| `recommendation` | What Loop recommends doing |
| `reason` | Why (the diagnosis in plain language) |
| `rootCause` | `vendor \| buyer \| emg \| unknown` |
| `trust` | Confidence + evidence + missing evidence |
| `alternativesConsidered` | Other explanations weighed |
| `unknowns` | Open questions that remain |
| `suggestedAction` | The concrete next step |
| `expectedOutcome` | What we expect to happen |
| `risk` | Risk of acting — and of not acting |
| `businessImpact` | Estimated impact in the org's terms |

No recommendation may omit these. "We don't know" is a valid, first-class value.

## Why these boundaries exist

- **Sensors stay swappable.** If CallGrid is replaced tomorrow, only a Sensor
  changes; the Brain is untouched.
- **Decisions stay explainable.** Because only the Brain decides, every decision
  carries its evidence and its uncertainty.
- **Honesty is structural.** `unknown` root causes and `missingEvidence` are
  fields, not afterthoughts — the system cannot quietly pretend to know.

_Last updated: Phase 1 — Recommendation Envelope + Sensor contracts._

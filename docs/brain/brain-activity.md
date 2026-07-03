# Brain Activity — the canonical output of the Brain

_Phase 1 (Brain Output layer). Additive, contracts + pure functions only. No
schema, UI, database, LLM, CallGrid, ingestion, or runtime-behavior changes._

## Why this layer exists

The EMG Loop Constitution holds that **the Brain owns decisions** and that
**every recommendation must be explainable**. By this point the Brain can:

- **Observe** — Facts/Signals become `Observation`s (`facts.ts`, `diagnostics.ts`).
- **Diagnose** — a `DiagnosticEngine` produces an explainable `DiagnosticAssessment`
  (`diagnostics.ts`; first concrete diagnoser in `buyer-call-handling-diagnoser.ts`).
- **Recommend** — a `DiagnosticAssessment` is reshaped toward a
  `RecommendationEnvelope` (`recommendation.ts`, `diagnostics-recommendation.ts`).

What was missing was a **single, standard way to publish** that reasoning so the
rest of the platform can consume it uniformly. Without one, every consumer would
reach into diagnostics/recommendation internals in its own way, and the Brain's
output would have no stable contract. `BrainActivity` is that contract.

## The pipeline

```
Observations
     v
DiagnosticAssessment
     v
RecommendationEnvelope
     v
BrainActivity          <-- the Brain's single, canonical output
     v
(Consumers)
```

Examples of future consumers (none wired in this PR): Employee workspace,
Business Owner workspace, Creator workspace, Notifications, Daily Briefings, the
Experiment Engine, and the Knowledge Engine. They all read the **same**
`BrainActivity` shape, regardless of which diagnoser produced it.

## What a BrainActivity is

A `BrainActivity` is an **immutable, point-in-time** record of one thing the
Brain noticed and reasoned about. It carries everything a consumer needs to
understand and trust it without re-deriving anything:

| Field | Meaning |
| --- | --- |
| `id` | Stable unique identifier for this activity. |
| `timestamp` | When the Brain produced it (point-in-time). |
| `organizationId` / `locationId` | Tenant scope (`TenantScope`). |
| `subject` | What the activity concerns (matches the assessment subject). |
| `activityType` | `diagnosis` / `recommendation` / `observation` / `alert` / `unknown`. |
| `severity` | Triage band, reusing the shared `Priority` vocabulary. |
| `visibility` | Trust-layer visibility, inherited from the envelope. |
| `recommendation` | Plain-language recommendation text (empty on honest `unknown`). |
| `recommendationEnvelope` | The full, explainable `RecommendationEnvelope`. |
| `evidence` | Evidence the Brain rested on. |
| `confidence` | Overall confidence, [0,1]. |
| `missingEvidence` | What the Brain still wishes it had. |
| `alternativesConsidered` | Alternatives weighed but not selected. |
| `unknowns` | Open questions that remain. |
| `assessmentRef` | Reference back to the source `DiagnosticAssessment`. |

### Immutability

Immutability is enforced structurally — every field is `readonly` and every
collection is a `ReadonlyArray` — and observably at runtime via
`Object.freeze`. A `BrainActivity` is a fact about a moment; it is never edited
in place. A later reading of the same subject produces a **new** activity.

## The publisher

`createBrainActivityPublisher()` returns a `BrainActivityPublisher` whose
`publish()` method is a **pure projection**:

```
publish({ assessment, envelope, id, timestamp }) => BrainActivity
```

It performs **no persistence, no I/O, and makes no new decision**. Identity and
time are caller-supplied so the projection stays pure (no clock, no RNG inside).
`activityType` and `severity` are derived deterministically from the diagnosis:
severity is the highest finding severity; an honest `unknown` state with no
findings surfaces as an `unknown` activity. Deciding *what to recommend* remains
the job of a `RecommendationEngine` — the publisher only packages what is
already known. A ready-made `brainActivityPublisher` and a one-shot
`publishBrainActivity()` are exported for convenience.

## Demonstration

`demonstrateBrainActivityFlow()` shows the full Observe -> Diagnose -> Recommend
-> Publish flow end-to-end using the Buyer/Call-Handling diagnoser from PR #33.
It is pure and deterministic: given the same metrics it always yields the same
`BrainActivity`. It touches no database, no CallGrid, no clock and no RNG, and it
is **not wired into any runtime path** — it exists only to prove the pipeline
composes.

## Constitutional principles satisfied

- **The Brain owns decisions.** `BrainActivity` is authored only by the Brain; it
  is the Brain's output boundary. Services/UI consume it, they do not produce it.
- **Every recommendation is explainable.** The activity carries the full
  envelope, evidence, confidence, alternatives, and unknowns.
- **"Unknown" is first-class.** An honest `unknown` assessment publishes as an
  `unknown` activity with empty recommendation text — never fabricated.
- **Additive and reversible.** New contracts + pure functions; nothing renamed,
  no behavior changed, not wired into any runtime path.

## Limitations / non-goals (this PR)

- No persistence, store, feed, or query layer — publishing only.
- No UI, notifications, or briefings wiring.
- No new diagnosers; the demonstration reuses the existing PR #33 diagnoser.
- No experiments, knowledge engine, Digital Twins, or LLM.

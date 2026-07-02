# Diagnostics → Recommendations: the adapter pathway

_Phase 1 — Brain Boundary. Additive, adapter-only, behavior-preserving. No schema, no UI, no new diagnosers._

## Why this exists

The Brain can now **think** (`diagnostics.ts`) and it can **recommend**
(`recommendation.ts`, `next-best-action.ts`). What was missing was the **bridge**:
a type-safe way for a Recommendation Engine to reason _from_ an explainable
diagnosis instead of _from_ raw facts.

`diagnostics-recommendation.ts` is that bridge. It is **pure** (no I/O, no
persistence), it adds **no new decision logic**, and it **does not change** the
existing Next Best Action behavior. It only reshapes data the diagnosis already
computed. Choosing _what_ to recommend stays the job of a `RecommendationEngine`;
the adapter supplies the evidentiary spine, the engine supplies the judgement.

## The full flow

```
Observations
   │  (Sensors emit Facts → Observations)
   ▼
DiagnosticAssessment            ← produced by a DiagnosticEngine (diagnostics.ts)
   │
   ├─ diagnosticAssessmentToRecommendationContext(assessment, hints?)
   │     → RecommendationContext            ← consumed by the EXISTING engine, unchanged
   │
   └─ recommendationEnvelopeSpineFromAssessment(assessment)
         → RecommendationEnvelopeSpine       ← evidentiary fields for a FUTURE
                                               envelope-based engine to complete
   ▼
RecommendationEnvelope           ← authored by the RecommendationEngine (adds the
                                    chosen action, expected outcome, risk, impact)
```

## Two conversion paths

### 1. `DiagnosticAssessment → RecommendationContext` (works today)

Feeds the current, unchanged Next Best Action engine. The engine still receives
exactly the shape it always has — we simply source the fields from a diagnosis.

```ts
import {
  diagnosticAssessmentToRecommendationContext,
} from '@emgloop/brain';

const context = diagnosticAssessmentToRecommendationContext(assessment, {
  eventType: 'inbound_call',
  channel: 'phone',
});
const result = await engine.recommend(context); // existing RecommendationEngine
```

`signalKeysFromAssessment` derives the engine's `signalKeys` from the evidence the
diagnosis already gathered (evidence `ref`, else `kind`), de-duped and
order-preserving.

### 2. `DiagnosticAssessment → RecommendationEnvelope` building blocks (for future engines)

These helpers project a diagnosis onto the explainable fields a
`RecommendationEnvelope` carries, **without** authoring a full envelope:

- `trustAssessmentFromAssessment` — confidence + evidence + what is missing.
- `evidenceFromAssessment` — the de-duped evidence spine.
- `unknownsFromAssessment` / `missingEvidenceLabels` — the honest gaps, as strings.
- `primaryRootCause` — the leading attributed `RootCause`, or `'unknown'`.
- `recommendationEnvelopeSpineFromAssessment` — the whole spine in one call.

They deliberately stop short of the envelope's `action`, `suggestedAction`,
`expectedOutcome`, `risk`, and `businessImpact` — those are **decisions** only a
`RecommendationEngine` may make.

## Behavior preservation

Nothing in this PR is wired into a running code path. The existing
`NextBestActionService` and `RecommendationEngine` are untouched. The adapter is a
set of pure, tree-shakeable functions that future engines may opt into. Current
Next Best Action output is therefore **identical** to before.

## Constitutional principles satisfied

- **The Brain owns decisions.** The adapter maps data only; it never decides. The
  engine remains the sole author of recommendations.
- **Every recommendation is explainable.** The pathway carries `Evidence`,
  `confidence`, and `rootCause` straight through from diagnosis to envelope.
- **"Unknown" is first-class.** `unknowns` and `missingEvidence` are projected
  onward, never dropped; `primaryRootCause` honestly returns `'unknown'`.
- **No single truth is forced.** `alternativesConsidered` is carried through from
  the diagnosis's weighed alternatives.

## Out of scope (by instruction)

No schema changes, no UI, no new diagnosers, no CallGrid behavior changes, and no
experiment / knowledge / digital-twin work. Adapter and documentation only.

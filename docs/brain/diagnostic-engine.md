# The Brain's Diagnostic Engine

_Phase 1 — Diagnostic Foundation. Contracts only; additive; no schema changes._

## Why this exists

Before Phase 1, the Brain could **recommend** (see `recommendation.ts` and
`next-best-action.ts`) but it could not **think**. Recommendations were produced
from raw facts, which meant the platform could act without ever explaining what
it believed to be true, why, or how sure it was.

The Diagnostic Engine establishes the Brain's permanent **reasoning vocabulary**:
the canonical models every future recommendation will rest on. This phase does
**not** diagnose any specific business. It only fixes the architecture so that
every later diagnoser plugs into the same explainable contract.

## The Constitutional pipeline

```
Observe  ->  Understand  ->  Diagnose  ->  Recommend  ->  Experiment  ->  Learn
```

This module implements **only the Observe -> Diagnose span**. Experiments,
Knowledge, and Digital Twins are explicitly out of scope for this phase.

| Stage      | Model(s) introduced                                   |
| ---------- | ----------------------------------------------------- |
| Observe    | `Observation`, `DiagnosticState`                       |
| Understand | `Unknown`, `MissingEvidence`                           |
| Diagnose   | `Finding`, `DiagnosticRootCause`, `DiagnosticAssessment` |

## The vocabulary

- **Observation** — one perceived data point, scoped to a subject, carrying the
  `Evidence` trail back to the Fact(s)/Signal(s) it came from. Asserts no meaning.
- **Finding** — an interpreted statement about what Observations _mean_.
  Explainable by construction: always carries evidence and a confidence.
- **DiagnosticRootCause** — a structured, explainable attribution of _why_ a
  Finding is happening, including the alternatives considered.
- **DiagnosticAssessment** — the single explainable output of a diagnosis pass:
  observations + findings + root causes + unknowns + missing evidence + overall
  confidence. This is the object recommendations are meant to consume.
- **Unknown** — a first-class representation of ignorance. "We don't know" is a
  real, reportable result, never a silent gap.
- **MissingEvidence** — the evidence that, if collected, would most raise
  confidence. This is how the Brain asks better questions.
- **Evidence / Confidence / AlternativeExplanation / RootCause** — reused from the
  existing Brain (`types.ts`, `recommendation.ts`) rather than redeclared, so
  there is exactly one source of truth per idea.

## Constitutional guarantees encoded in the contract

1. **The Brain owns decisions.** Diagnosis is a pure Brain capability; the data
   and service layers never interpret facts themselves.
2. **Every conclusion is explainable.** `Finding` and `DiagnosticRootCause`
   cannot exist without attached `Evidence`; `DiagnosticAssessment` always carries
   its confidence.
3. **"Unknown" is first-class.** `DiagnosticState` includes `'unknown'`, and every
   assessment has `unknowns` and `missingEvidence` arrays that are never faked away.
4. **No single truth is forced.** `DiagnosticRootCause.alternatives` preserves the
   explanations the engine considered but did not select.

## How future engines consume diagnostics

A diagnoser implements the `DiagnosticEngine` interface:

```ts
import type { DiagnosticEngine, DiagnosticContext, DiagnosticAssessment } from '@emgloop/brain';

export const leadResponseDiagnoser: DiagnosticEngine = {
  id: 'lead-response-diagnoser',
  diagnose(context: DiagnosticContext): DiagnosticAssessment {
    // Pure, deterministic in Phase 1: read context.observations, build findings,
    // attribute root causes with evidence, and honestly report what is unknown.
    // No I/O, no persistence, no fabricated certainty.
    ...
  },
};
```

Callers assemble `Observation`s from Facts/Signals, pass a `DiagnosticContext`,
and receive a `DiagnosticAssessment`. The **Recommendation Engine** is intended to
eventually take a `DiagnosticAssessment` as its input in place of raw facts, so
that every recommendation is grounded in an explainable diagnosis.

## Contract rules for implementers

- Be **pure** with respect to input: no I/O, no persistence, no side effects.
- **Never fabricate certainty** — return `Unknown` / `MissingEvidence` honestly,
  and use `state: 'unknown'` when data is present but ambiguous.
- **Always attach `Evidence`** to every `Finding` and `DiagnosticRootCause`.
- On empty input, return an honest `'unknown'` assessment rather than inventing
  findings.

## Explicitly out of scope for this phase

No experiments, no knowledge/learning loop, no Digital Twins, no schema changes,
no UI, no new integrations, and no change to CallGrid behavior. This phase is the
vocabulary and the contract only.

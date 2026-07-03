# Brain Activity verification harness

_Phase 1 (Brain Output verification). Pure, framework-free. No schema, UI, runtime
wiring, database writes, CallGrid, or LLM. Draft only._

## Purpose

This harness proves the Brain's output pipeline works end-to-end and that a
published `BrainActivity` faithfully preserves the reasoning it was built from. It
is the safety net for the Observe → Diagnose → Recommend → Publish flow assembled
across PRs #31–#34.

## Why pure functions instead of a test framework

The repository intentionally ships **no test runner** — the only package scripts
are `typecheck` (`tsc --noEmit`) and `build`, orchestrated by turbo. The task
forbids introducing a new framework, so the harness is written as ordinary,
strongly-typed **pure functions** in `packages/brain/src/brain-activity-verification.ts`.

Two things verify it:

1. **The build/typecheck** compiles the harness against the *real* contracts
   (`DiagnosticAssessment`, `RecommendationEnvelope`, `BrainActivity`, the
   diagnoser, and the adapter). If any type drifts, the green preview goes red.
2. **`runBrainActivityVerification()`** can be called by any consumer — or a
   future test runner, if one is ever added — to execute the checks at runtime.
   It returns a structured `VerificationReport` (`passed`, `total`, `failures`,
   and per-scenario `checks`); it prints nothing and throws nothing.

## What it proves

The harness runs four deterministic scenarios over two fixed fixtures:

- `BUYER_ROOT_CAUSE_METRICS` — a healthy sample (120 calls) that trips three
  buyer-owned signals (low answer rate, buyer-ended calls, short calls) and no
  vendor/EMG signal, so the diagnoser must attribute a **buyer** root cause.
- `INSUFFICIENT_EVIDENCE_METRICS` — a sample of 5 calls, below the diagnoser's
  minimum of 20, so it must return an **honest unknown**.

| # | Scenario | Proves |
| --- | --- | --- |
| 1 | buyer root cause diagnosis | diagnoser yields a `buyer`-attributed, `inferred` assessment with findings and evidence |
| 2 | honest unknown diagnosis | insufficient sample yields `unknown` state, no findings, named unknowns and missing evidence |
| 3 | flow + field preservation | the assessment flows DiagnosticAssessment → adapter spine → RecommendationEnvelope → `BrainActivity` |
| 4 | (same case) field preservation | the `BrainActivity` preserves type, severity, confidence, evidence, missing evidence, alternatives, unknowns, and the recommendation envelope |
| 5 | immutability | the published `BrainActivity` is frozen and a mutation attempt does not change it |

Determinism is guaranteed: the fixtures pin every metric and the timestamp, the
diagnoser is deterministic, the adapter and publisher are pure, and no clock or
RNG is consulted. The same inputs always produce the same report.

## Limitations / non-goals

- Not wired into CI or any runtime — it is exercised by the typecheck/build and
  is callable on demand.
- No new dependencies and no test framework introduced.
- Reuses the existing PR #33 diagnoser and PR #34 flow; it adds no diagnosers and
  changes no behavior.

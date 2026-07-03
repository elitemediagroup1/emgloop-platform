# Call-Handling Metrics Assembler — real-data intake for the Brain

_Phase 1 · additive, read-only, deterministic · not wired into any runtime path._

## Why this exists

Earlier Phase 1 PRs gave the Brain a complete reasoning pipeline that runs from a
plain metrics object:

```
CallHandlingMetrics
  -> buyerCallHandlingDiagnoser        (diagnose)
  -> DiagnosticAssessment
  -> diagnostics->recommendation adapter (evidentiary spine)
  -> RecommendationEnvelope
  -> BrainActivity                     (the Brain's canonical output)
```

What was missing was the step *before* the metrics: a way to turn the platform's
**already-ingested, reconciled CallGrid interaction records** into that
`CallHandlingMetrics` shape, so the very same pipeline can run on real data
instead of hand-authored fixtures. The Call-Handling Metrics Assembler
(`packages/brain/src/call-handling-metrics-assembler.ts`) is that step.

```
Reconciled CallGrid interactions (already ingested)
  -> assembleCallHandlingMetrics       (this file: pure aggregation)
  -> CallHandlingMetrics
  -> ...the existing Observe -> Diagnose -> Recommend -> Publish flow...
  -> BrainActivity
```

## What it is (and is not)

It **is** a pure, read-only aggregator. It accepts a `CallWindow` — a tenant
scope plus a read-only array of `ReconciledCallRecord` the caller already holds —
counts the records, computes the call-handling ratios, preserves attribution,
and returns `AssembledCallHandlingMetrics`.

It is **not** invasive in any way. It does not read the database, call CallGrid,
subscribe to ingestion, or mutate its inputs. It performs no I/O, uses no clock
and no RNG, writes nothing, and is wired into no live path. It introduces **no
new decision logic**: it only *counts what the records already state* and hands
the result to the existing (unchanged) diagnose -> recommend -> publish flow.
Whether to run it on live data, and what to do with the resulting
`BrainActivity`, remain later decisions made outside this file.

## The input: a reconciled call record

`ReconciledCallRecord` models only the fields the diagnoser cares about, using
the reconciled call vocabulary the platform already produces:

- `status` — one of `answer ` `complete ` `transfer ` `voicemail ` `miss `
  `no_answer ` `hangup ` `no_route`.
- `durationSeconds` — handled duration, when the call connected.
- `endedBy` — `buyer ` `caller ` `system ` `unknown`.
- `billable` / `qualified` — reconciled outcome flags, when known.
- `vendorId` / `buyerId` / `source` / `campaign` — attribution, preserved.

Every field except `status` is optional. **Missing evidence stays missing:** a
metric with no supporting records is returned `undefined` rather than a
fabricated `0`, so the diagnoser can treat it as honestly unknown.

## The aggregation

`assembleCallHandlingMetrics(window)` produces:

| Metric | How it is computed |
| --- | --- |
| `sampleSize` | total records in the window |
| `answerRate` | answered / routable (total minus no-route) |
| `buyerEndedRate` | buyer-ended / connected-with-known-ender |
| `callerEndedRate` | caller-ended / connected-with-known-ender |
| `noRouteRate` | no-route / total |
| `shortCallRate` | short answered / answered-with-known-duration |
| `avgDurationSeconds` | mean duration over answered calls with a duration |

"Short" means an answered call at/below `SHORT_CALL_MAX_SECONDS` (30s), an
explicit, documented threshold. The raw `counts` are returned alongside the
ratios so a reviewer can audit exactly how each rate was derived. Attribution is
collapsed to a single value per field when all records agree, and reported as
`mixed` when they do not — never guessed. `billableRate` and `qualifiedRate` are
computed over records that carry the respective flag.

## The end-to-end run

`assembleAndRunCallHandlingFlow(inputs)` aggregates a window and then calls the
existing `demonstrateBrainActivityFlow` with the assembled metrics, returning
both the `assembled` result and the full `flow` (assessment, recommendation
context, envelope, and the published, immutable `BrainActivity`). Identity and
time are caller-supplied so the whole path stays a pure function.

`demonstrateCallHandlingAssemblyFlow()` runs it on a fixed 60-call example
window that exhibits a buyer-owned problem (low answer rate, frequent buyer
hang-ups, short handled calls). Deterministically this yields three buyer
signals and zero vendor/EMG signals, so the diagnosis attributes the **buyer**
as the root cause with confidence 0.8 and the flow publishes a `recommendation`
BrainActivity — proving the loop composes on realistically-shaped data.

## Constitutional principles satisfied

- **The Brain owns decisions; sensors emit facts.** The assembler only turns
  facts (reconciled records) into the metrics the Brain reasons over; it makes
  no decision itself.
- **Every recommendation is explainable.** Counts travel with the metrics and
  the evidence trail continues through the existing adapter and envelope.
- **"Unknown" is first-class.** Absent metrics stay `undefined` and mixed
  attribution is reported as `mixed`, never fabricated.
- **Additive and behaviour-preserving.** No schema, UI, DB, ingestion, or
  CallGrid change; the existing pipeline is reused unchanged.

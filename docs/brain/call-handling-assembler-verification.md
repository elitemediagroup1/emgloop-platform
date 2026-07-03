# Call-Handling Assembler verification harness

_Phase 1 · pure, framework-free, deterministic · not wired into any runtime path._

## Purpose

PR #35 added a framework-free verification harness for the Brain Activity flow,
and PR #36 added the Call-Handling Metrics Assembler that turns reconciled
CallGrid interaction records into a `CallHandlingMetrics` object. This harness
(`packages/brain/src/call-handling-assembler-verification.ts`) extends the same
proof pattern to the assembler, so the real-data intake path is checked by the
same normal `typecheck`/`build` the rest of the package uses.

Consistent with the repo (only `typecheck`/`build` via turbo, **no test runner**,
and none may be added), the harness is a set of **pure functions**. It builds
fixed reconciled-call records, runs the **real** assembler and the **real**
Observe -> Diagnose -> Recommend -> Publish flow over them, and records
invariants with a tiny internal `Checker`. It performs no I/O, no persistence, no
DB writes, touches no CallGrid path, uses no LLM, and is wired into no runtime.
A caller (or a future test runner) may invoke
`runCallHandlingAssemblerVerification()` to execute the checks at runtime.

## What it proves

The harness runs six deterministic scenarios covering the seven required proofs:

1. **Expected metrics.** `assembleCallHandlingMetrics` over a fixed 60-call
   window yields the exact expected `CallHandlingMetrics`: `sampleSize` 60,
   `answerRate` = 30/54, `buyerEndedRate` = 24/30, `callerEndedRate` = 6/30,
   `noRouteRate` = 6/60, `shortCallRate` = 24/30, `avgDurationSeconds` = 45.6,
   and `billableRate`/`qualifiedRate` = 6/60.
2. **Missing stays missing.** For a window whose answered records carry no
   duration, no `endedBy`, and no billable/qualified flags, the dependent metrics
   are strictly `undefined` — never a fabricated `0` — while `sampleSize` and the
   status-derivable `answerRate` are still present.
3. **Single attribution preserved.** When every record agrees, the single
   `vendorId`/`buyerId`/`source`/`campaign` is carried through and `mixed` is
   `false`.
4. **Mixed attribution honest.** With two distinct vendors/buyers, `mixed` is
   `true` and no single value is collapsed.
5. **Full flow.** Assembled metrics flow through
   `CallHandlingMetrics -> buyer diagnoser -> DiagnosticAssessment ->
   RecommendationEnvelope -> BrainActivity` via `assembleAndRunCallHandlingFlow`.
6. **Buyer-owned activity.** The buyer window yields a buyer-root-cause
   assessment, a buyer envelope, and a frozen `recommendation` BrainActivity.
7. **Honest unknown.** A 6-call window (below the minimum sample of 20) yields an
   `unknown` assessment, an `unknown` envelope root cause, and a frozen activity —
   proving "unknown" remains first-class end-to-end.

## Constitutional principles satisfied

- **The Brain owns decisions.** The harness only checks the existing assembler
  and flow; it introduces no decision logic of its own.
- **"Unknown" is first-class.** Scenarios 2 and 7 assert that absent evidence
  stays absent and that insufficient evidence yields an honest unknown.
- **Everything explainable.** Each check is named and recorded in the returned
  `AssemblerVerificationReport`, so a reviewer sees exactly what passed.
- **Additive and behaviour-preserving.** No schema, UI, DB, runtime wiring, or
  CallGrid change; no test framework added.

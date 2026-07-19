# Executive Brain

The platform's executive reasoning layer. It does **not** report data — it
explains the business: *what happened, why it happened, what matters, what to do.*
Every statement it makes is backed by evidence that cleared the Evidence Engine.

This documents what is **built**, not what is planned. If the feature is removed,
delete this file with it.

---

## Where it sits

```
providers → database → Evidence Engine → Executive Brain → UI
                            (per-domain      (provider-neutral
                             confidence)      reasoning)
```

The Executive Brain reasons over **sensors**. Marketplace is the first and today
the only instrumented one; CRM, Calendar, Email, Analytics and Website are
declared *uninstrumented* so the UI states they are not yet wired rather than
omitting them. Adding a sensor is writing an Evidence Engine contributor and an
adapter — the Brain does not change. That neutrality is asserted in
`executive/verification.ts`, which drives the same `runExecutiveBrain` with two
unrelated synthetic domains and the real Marketplace adapter.

## Files (`src/executive/`)

| File | Owns |
|---|---|
| `observation.ts` | The canonical `ExecutiveObservation` model + `buildObservation` (the ONLY constructor) + `deriveObservationConfidence`. |
| `sensor.ts` | The `ExecutiveSensor` contract — `instrumented` (report + findings) or `uninstrumented` (reason + unblockedBy). |
| `brain.ts` | `runExecutiveBrain(sensors, now)` → `ExecutiveBrainReport`. Pure, deterministic. |
| `verification.ts` | Deterministic proof of all six mission invariants + provider-neutrality. |

The Marketplace adapter lives at `src/marketplace/executive-sensor.ts` —
`marketplaceExecutiveSensor(engineResult)`. It is the only place marketplace
vocabulary crosses into the Brain; the Brain imports nothing from marketplace.

## The Observation model

One narrative unit carrying everything an executive needs to judge and act:

`observation` · `evidence` (non-empty) · `businessImpact` · `recommendation`
(optional) · `confidence` (derived) · `owner` (optional) · `severity` ·
`timestamp` · `source`.

It supersedes the two older units — the CallGrid module's
`RecommendationEnvelope` opportunities/risks and its `IntelligenceChange` "what
changed" list — which each described a slice of the same thing and carried a
confidence the module asserted about itself.

## The invariants (enforced, not hoped-for)

1. **No evidence, no observation.** `buildObservation` refuses to assemble one
   without a non-empty evidence array. A finding that cites a metric which is
   withheld or absent is **suppressed** (and recorded in `report.suppressed`),
   never trusted.
2. **Confidence is derived, never asserted.** An observation's confidence is the
   weakest-link of the Evidence Engine confidences of the metrics it cites. A
   caller cannot pass one in. This is the fix for the old briefing, which ranked
   opportunities/risks by a confidence each module authored about itself.
3. **Unknown never becomes zero.** Observations are built only over metrics that
   cleared the Evidence Engine's withholding rules; a withheld metric never
   reaches the surface, so a zero is never dressed as a reading. `overallConfidence`
   is `null` — not `0` — when nothing is measured.
4. **Contradictory evidence lowers confidence.** The Evidence Engine discounts a
   contradicted metric and then withholds it; the Brain drops any finding that
   leaned on it, naming the contradiction in the suppression.
5. **Empty datasets produce truthful summaries.** No sensors, or sensors that saw
   nothing, yield empty observation lists and an `unknown` system-health posture —
   never an invented summary.
6. **Never fabricates.** Every observation on the report traces to ≥1 available
   metric in a sensor's report.

`System Health` and `Evidence Coverage` are **derived from counts**, never
authored, mirroring the discipline in `coverage.ts` and `marketplace/score.ts`.

## Verifying

```
npx tsx packages/intelligence/src/executive/verification.ts
```

Pure, framework-free, deterministic — the package's established convention (see
`evidence/verification.ts`). No clock, no I/O; `now` is injected.

## Consumed by

- `/app/admin/marketplace` — the Marketplace workspace's Overview, scoped entry.
- `/app/admin/brain` — the admin Executive Brain surface.

Both render `ExecutiveBrainView` over the report from
`_executive/executive-brain-data.ts`, the single loader. There is no second
executive path — `assembleExecutiveBriefing` and the CallGrid intelligence module
were retired in the same change.

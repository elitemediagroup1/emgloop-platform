# Marketplace Intelligence — Brain Enrichment (PR #46)

Pure, deterministic, **unwired** reasoning layer that turns an already-assembled
Marketplace Intelligence snapshot into an enriched one. It is additive and
touches no runtime path: no UI, no API, no DB reads/writes, no schema changes,
no CallGrid settings, no LLM. It reuses the existing Brain contracts and never
declares a new public shape for its output.

## Where it sits

    CallGrid reconciled facts
            v
    assembleMarketplaceIntelligence()   (PR #44)  -> snapshot with BRAIN_NOT_WIRED
            v
    enrichMarketplaceIntelligence()     (PR #46)  <- this module
            v
    enriched MarketplaceIntelligence    (health, confidence, recommendations, insights)

PR #44 honestly leaves every Brain judgement empty: `health: 'unknown'`,
confidence at the no-diagnosis floor, empty `recommendations`/`insights`, and a
`BRAIN_NOT_WIRED` marker in `unknowns`/`missingEvidence`/`metadata.note`. This
module is the reasoning step that fills those in — but only from evidence that
is actually present, and only via deterministic rules.

## Public API

```ts
enrichMarketplaceIntelligence(
  snapshot: MarketplaceIntelligence,
  now: Date,
): MarketplaceIntelligence
```

- The input is **never mutated**; a new snapshot is returned.
- `now` is caller-supplied (never a clock read) so the result is reproducible;
  it is used only as the insight timestamp.
- Recommendations are emitted as the existing `RecommendationEnvelope` contract
  from `@emgloop/brain`; insights as the existing `BrainActivity` contract
  (aliased `MarketplaceBrainInsight`). No new output type is introduced.

## Deterministic rules (narrow first slice)

Each rule reads only fields already on the snapshot. If the field(s) it needs
are `undefined`, the rule stays silent and the subject remains honestly unknown.

| Rule | Reads | Fires when | rootCause | Severity |
|---|---|---|---|---|
| Profitability issue | `profitability.netProfit` | net profit <= 0 | `emg` | critical if < 0 else high |
| Low billable rate | `buyer.billableRate` | rate < 0.5 | `buyer` | high |
| High rejection rate | `source.bidsSent`, `source.bidsAccepted` | (sent-accepted)/sent >= 0.4 | `emg` | high |
| Poor source fulfillment | `source.fulfillment` | fulfillment < 0.6 | `vendor` | normal |
| Unknown | — | no rule can fire | — | snapshot stays `unknown` |

Thresholds are named constants in `ENRICHMENT_THRESHOLDS` so a later PR can tune
them without touching logic.

## What enrichment does and does not do

- **Grades** `health` from the highest-severity firing rule
  (critical > at_risk > watch > healthy) and sets `confidence` to the maximum
  rule confidence.
- **Removes** the `BRAIN_NOT_WIRED` marker from `unknowns`, `missingEvidence`,
  and `metadata.note` **only where enrichment succeeded**, preserving every
  other honest unknown/missing-evidence entry.
- **Preserves** all unknowns and keeps the `BRAIN_NOT_WIRED` marker when no rule
  can fire — enrichment never manufactures certainty it does not have.
- **Never invents** recommendations: every recommendation is produced by a rule
  above, with fixed template text, fixed `operational_recommendation` action,
  and evidence drawn from the snapshot's own numbers. `alternativesConsidered`
  is left empty rather than fabricated.
- **Never touches** entity metrics: missing values stay `undefined`.
- **Stays provider-neutral**: no CallGrid vocabulary appears in the Brain output;
  canonical fields (e.g. `sourceId`) are untouched.

## Verification

`brain-enrichment-verification.ts` mirrors the PR #45 harness: a tiny
framework-free `Checker`, fixed provider-neutral snapshots, and the **real**
`enrichMarketplaceIntelligence` run over them. Invoke
`runBrainEnrichmentVerification()` to get a structured `VerificationReport`.
It adds **no** test runner (the repo has only `typecheck`/`build` via turbo) and
performs no I/O.

Scenarios: profitability issue, low billable rate, high rejection rate, poor
source fulfillment, unknown-when-insufficient, missing-stays-missing, and
provider-neutral (no CallGrid leakage, canonical fields preserved).

## Guardrails honored

Draft PR only. No merge. No UI, API, DB, schema changes, runtime wiring, CallGrid
settings, or LLM. Pure and deterministic; not imported by any runtime path.

## Recommended next step

Wire `enrichMarketplaceIntelligence` behind an explicit, opt-in call site (still
no UI/API/DB coupling), and broaden the rule set (trends, vendor scorecards,
campaign margin) once these first five rules are validated in review.

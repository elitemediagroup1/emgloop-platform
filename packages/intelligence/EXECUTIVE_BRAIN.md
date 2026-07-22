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
| `observation.ts` | The canonical `ExecutiveObservation` model + `buildObservation` (the ONLY constructor) + `deriveObservationConfidence`. Kinds: `observation` · `change` · `correlation` · `risk` · `opportunity`. |
| `sensor.ts` | The `ExecutiveSensor` contract — `instrumented` (report + findings) or `uninstrumented` (reason + unblockedBy). |
| `domain-sensor.ts` | `buildDomainSensor(spec)` — the reusable builder that turns windowed counts into an EvidenceReport plus auto-generated coverage-gap and What-Changed findings. Every non-marketplace sensor is a few dozen lines on top of this. |
| `correlation.ts` | `runCorrelations(observations, ts)` + `CORRELATION_RULES` — cross-sensor conclusions, each fired only when the observations it joins already exist, and citing them. |
| `brain.ts` | `runExecutiveBrain(sensors, now)` → `ExecutiveBrainReport`. Pure, deterministic. |
| `verification.ts` | Deterministic proof of all six mission invariants + provider-neutrality + the Sprint 26 additions. |

The Marketplace adapter lives at `src/marketplace/executive-sensor.ts` —
`marketplaceExecutiveSensor(engineResult)`. It is the only place marketplace
vocabulary crosses into the Brain; the Brain imports nothing from marketplace.

## Sensors — instrumented vs honestly missing

A sensor is instrumented only when a real, org-scoped, windowed read exists. The
data loader (`apps/web/.../_executive/executive-brain-data.ts`) is where the
boundary is drawn, and it is drawn honestly — a domain with no rows is declared
`uninstrumented`, never faked, so the Evidence Coverage board shows it as
**missing** with what would connect it.

| Sensor | State | Source |
|---|---|---|
| Marketplace | instrumented | `MarketplaceCall` coverage + rules |
| CRM | instrumented | `CrmRepository.windowCounts` (customers, conversations, assignment) |
| Website Analytics | instrumented | `WebsiteAnalyticsRepository.getWebsiteAnalytics` totals |
| Website Forms | instrumented | same read — form submits / appointment requests |
| Loop Activity | instrumented | `DomainEventRepository.windowActivity` (org event spine) |
| Users | instrumented | `IamRepository.userCounts` (roster) |
| Marketplace Auction | instrumented | `MarketplaceAuctionRepository.latestRuns` (presence + freshness) |
| Gmail | **missing** | no inbound email ingestion exists (only outbound Resend) |
| Google Calendar | **missing** | only a mock calendar provider; bookings unpopulated |
| AI Conversations | **missing** | no LLM in the platform — AI Employees are config, not reasoning |
| Tasks | **missing** | no Task model (Work OS is a different domain) |
| Opportunities | **missing** | no Opportunity model (only an `UPSELL_OPPORTUNITY` signal type) |
| Creator Pipeline | **missing** | shell-stub workspace, no data |
| Client Pipeline | **missing** | shell-stub workspace, no data |

Three capabilities were deliberately **not** restored because they have no data
to back them: **Predictive** (needs a historical store — the planned Executive
Memory), **Transcript** (no transcript content exists anywhere), and any
**AI-conversation** intelligence (no LLM). Filling those panels would fabricate
the evidence the Brain exists to refuse.

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

## What the report carries (Sprint 26)

`ExecutiveBrainReport` adds, on top of `summary/risks/opportunities/recommendations`:

- **`whatChanged`** — `change` observations, each a real prior-vs-current movement
  with its delta, suppressed if the metric did not clear the engine in the window.
- **`correlations`** — cross-sensor conclusions. A correlation is evidence-gated:
  it fires only when every observation it joins already exists, cites them all,
  and takes its confidence as their weakest link. It cannot invent a signal.
- **`evidenceCoverage.statusCounts`** and a per-sensor **`status`** —
  `healthy` / `stale` / `connected` / `missing`, each DERIVED from data presence
  and freshness. This is the first-class coverage board: an executive sees which
  systems are connected, healthy, going stale, or absent, at a glance.
- Every observation carries an **`affectedArea`** for the Details panel.

## Verifying

```
npx tsx packages/intelligence/src/executive/verification.ts
```

Eleven checks: the six mission invariants, provider-neutrality, and the Sprint 26
additions (What Changed, its suppression when unevidenced, evidence-gated
correlation, and the derived coverage status). Pure, framework-free, deterministic
— the package's established convention (see `evidence/verification.ts`). No clock,
no I/O; `now` is injected.

## Consumed by

- `/app/admin/marketplace` — the Marketplace workspace's Overview, scoped entry.
- `/app/admin/brain` — the admin Executive Brain surface.

Both render `ExecutiveBrainView` over the report from
`_executive/executive-brain-data.ts`, the single loader. There is no second
executive path — `assembleExecutiveBriefing` and the CallGrid intelligence module
were retired in the same change.

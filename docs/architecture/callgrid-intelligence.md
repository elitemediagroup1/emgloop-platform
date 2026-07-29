# CallGrid Intelligence

**CallGrid reports the marketplace. Loop explains it.**

This document describes what is built. It is not a plan. See
[`callgrid-data-contract.md`](./callgrid-data-contract.md) for what the provider
actually exposes.

---

## Purpose

CallGrid Intelligence (`/app/admin/marketplace/*`) must contain enough raw
operational data to be trusted and verified, while its primary value is analysis
a person cannot easily get by reading CallGrid reports by hand.

Every page answers: what happened · what changed · why · does it matter · who
contributed · what to investigate · what action is reasonable · what is unknown.

A metric table is not intelligence. A percentage change is not intelligence. A
generic recommendation is not intelligence.

---

## Layers

```
MarketplaceCall projection ─┐
                            ├─→ callgrid-report.ts ─→ intelligence engine ─→ surfaces
bid / ping snapshots ───────┘   (canonical reports)     (findings)           (render only)
```

Each layer may only read the one below it.

| Module | Owns | Never does |
|---|---|---|
| `callgrid-metric-contract.ts` | Every metric definition + the one implementation of each formula | Reads data. Judges significance. |
| `callgrid-window.ts` | Every reporting preset and its comparison period | Anything provider-specific |
| `callgrid-report.ts` | Turning a window into metrics + ranked dimension rows | Business judgement |
| `bid-report.ts` | Reading the latest stored bid snapshot | Calling CallGrid at render time |
| `callgrid-intelligence.ts` | Finding / evidence contracts + the significance registry | Analysis |
| `callgrid-intelligence-engine.ts` | The analysis rules | I/O, thresholds of its own, LLM calls |
| `callgrid-bid-intelligence.ts` | Rejection classification, bid findings, review priority | Any monetary claim |
| `intelligence-ui.tsx` | Rendering findings, evidence, unknowns | Computing anything |

**No page component defines a business metric.** If it is not in the metric
contract, it does not exist.

---

## The date-window contract

One resolver: `resolveCallGridWindow({ preset, start?, end? }, now)`. Pure,
`now` injected, every boundary an Eastern (`America/New_York`) calendar boundary,
DST handled by ICU. Windows are half-open `[start, end)`.

### The correction that mattered most

Before 2026-07-29, `today` and every trailing-N-day preset compared a **partial**
window against **N complete prior days**. At 9am, "Today" reported a ~-85%
revenue collapse — every single morning. That is the clock, not the business, and
it is the single largest reason the numbers were not trusted when switching
between Today / Yesterday / This Week.

Now every in-progress window is **elapsed-matched**: the comparison is cut at the
same *wall-clock* point of its own period.

- Wall-clock, not elapsed milliseconds — on a DST-transition day those differ by
  an hour, which would silently compare 14 hours against 13.
- `this_month` clamps to the last day of a shorter previous month (Mar 31 → Feb 28).
- `year_to_date` clamps Feb 29 → Feb 28.
- A custom range ending today ends at **now**, not at a future midnight, and gets
  the same elapsed treatment. A range entirely in the future is invalid.

`comparisonBasis` records which happened: `elapsed_matched`, `complete_period`,
or `none`. The UI names the cut time — "Yesterday · through 2:30 PM" — because a
delta on a live window is only trustworthy if you can see where it was cut.

Completed presets (yesterday, last week, last 2 weeks, last month) compare whole
period against whole prior period, unchanged.

Invalid ranges normalise to Today **and report `isValid: false`**, which the
surface states rather than silently substituting.

---

## Truthfulness

Five classifications, applied to every value and conclusion:

| Class | Meaning |
|---|---|
| `VERIFIED` | Directly reported by CallGrid |
| `DERIVED` | Calculated from verified inputs via a versioned formula |
| `INFERRED` | A conclusion supported by verified/derived evidence, not stated by CallGrid |
| `UNKNOWN` | Not enough evidence to determine |
| `UNAVAILABLE` | The provider does not expose what this needs |

### Zero is never a substitute for absence

- A window read that **failed** → Unavailable. No number.
- A window with calls but **no economics** → Unknown. Never `$0`.
- A window genuinely containing **no calls** → a real `$0`.
- A dimension row nobody priced → `revenueCents: null`, renders "Unknown", and
  **sorts last in both directions** so it can never appear as best or worst.
- A bid field no row reported → absent, not summed as zero (`sumReported`
  returns `{ total: null, reported, of }` so partial coverage is disclosed).

Coverage below 1 makes a total a **lower bound**, and the surface says so.
Profit coverage is the *weakest* of revenue/payout/cost, because profit computed
over rows missing payout or cost **overstates** margin.

A repo-wide guard test (`truth-adoption.test.ts`) fails the build if a new
executive surface coerces a measurement to zero. It caught a line in this sprint.

---

## The finding contract

Every statement the product makes about the business is a `CallGridFinding`.
Three rules are enforced by `findingViolations()`, which the test suite runs over
everything the engine emits:

1. **No finding without evidence.**
2. **No finding without `ruleId` + `ruleVersion`** — so any conclusion is reproducible.
3. **No recommendation outside the safe vocabulary.**

A finding carries: type, plain-language summary, classification, severity,
confidence, both windows, primary metric, current/comparison values, absolute and
percentage change, affected entities, drivers, supporting evidence, **limitations**,
**unknowns**, recommended review, action safety, and rule identity.

`confidence` is deterministic arithmetic over data coverage and sample size —
never a model's self-assessment — and is capped at 0.95.

### Evidence

`CallGridEvidenceReference` records source type, provider report, metric key,
entity, window, provider field, raw / normalized / derived value, formula +
version, classification, completeness and notes. The evidence drawer is a native
`<details>` — inspecting a conclusion costs no client JavaScript.

---

## Significance

`CALLGRID_SIGNIFICANCE_RULES` — versioned, inspectable, and the only place
thresholds live. No component has a threshold in it.

Each rule declares `minimumDataRequirements`, `absoluteThreshold`,
`percentageThreshold`, `minimumVolume`, `baselineWindow`, `severityLogic`,
`suppressionConditions`, and an `explanation`.

Rules today: `revenue-change`, `profit-change`, `volume-change`,
`entity-contribution`, `revenue-concentration`, `entity-inactive`,
`billable-efficiency`, `value-per-call`, `rank-movement`,
`bid-outcome-volume`, `bid-win-rate`.

Findings require **both** a proportional and an absolute threshold, so a 300%
swing on $30 stays silent. Revenue changes are suppressed entirely when coverage
is under 50% — the totals are lower bounds and the "change" may just be what
happened to get priced.

---

## What the engine produces

Families implemented: overall performance change · contribution analysis ·
volume-versus-value inference · concentration · entity lifecycle (inactive,
newly active) · rank movement · margin · billable efficiency · per-dimension
efficiency movers.

### Language rules encoded in the engine

- **Contribution, never causation.** "X is the largest contributor to the
  decline, accounting for 62% of it — this establishes contribution, not cause."
  A test asserts no finding contains *caused* / *due to* / *because of*.
- **Concentration is dependency, not fault.** Never "the buyer will leave".
- **Billable rate is efficiency, not quality.** CallGrid exposes nothing that
  would make it a quality measure, and the finding says so.
- **Inactivity is an observation.** Never "reached its cap" / "paused" /
  "stopped buying" — none of which CallGrid reports.

### Recommendation safety

Allowed openers: Review, Investigate, Confirm, Compare, Check, Evaluate, Monitor,
Contact, Consider, Validate.

Forbidden without verified support: Increase, Decrease, Pause, Resume, Reroute,
Raise, Lower, Optimize, Recover, Guarantee, Boost, Scale.

Enforced by `isSafeRecommendation()` inside `findingViolations()` and asserted
across every generated recommendation in the test suite.

---

## Bid intelligence

Counting rejections is not intelligence — most rejections are configuration
working as intended.

`BID_REJECTION_CLASSIFICATIONS` maps each provider field to a category
(`EXPECTED_CONFIGURATION`, `POTENTIALLY_PREVENTABLE`, `TRAFFIC_OR_IDENTITY`,
`COMMERCIAL_OR_ACCEPTANCE`, `UNKNOWN`), a preventability
(`EXPECTED` / `POSSIBLY_PREVENTABLE` / `NOT_DETERMINABLE`), the operational
meaning, the evidence required before acting, the one safe recommendation, and
the **unsafe claims** that must never be made from it.

### Bid Review Priority

A deterministic 0–100 **ordering** score (`scoreReviewPriority`, v1) over: share
of its own grain (≤40), preventability class (≤25), entities affected (≤15),
log-scaled volume (≤15), snapshot freshness (≤5), damped by reporting
completeness. → LOW / MEDIUM / HIGH / CRITICAL.

**It is not a value, a cost, or an amount.** Bid reports carry no revenue, so no
monetary impact can be derived from them. A possibly-preventable category
outranks expected configuration at equal share, which is the whole point.

Historical bid comparison appears **only** when a genuinely earlier snapshot is
stored. There is none today, so no bid trend is shown anywhere and the absence is
stated.

---

## Reconciliation

`reconcileCallGridReport()` — pure, with an admin-only panel at
`/app/admin/administration/diagnostics/callgrid`.

**Leg 1 — internal (fully automated):** window resolution, timezone, validity,
comparison symmetry (catches a partial window compared against a complete
period), read health, revenue coverage, row caps, Overview ↔ subpage top-entity
agreement, and zero-coercion ordering.

**Leg 2 — provider (cannot be automated):** CallGrid has no working aggregate
call-statistics endpoint, so there is no machine-readable provider total to
compare against. The harness accepts figures read from the CallGrid interface
(`?cgCalls=&cgBillable=&cgRevenueCents=&cgProfitCents=&cgTop=`) and classifies
each difference.

Flags: `MATCH`, `ROUNDING_DIFFERENCE`, `DATE_MISMATCH`, `ENTITY_MISMATCH`,
`GRAIN_MISMATCH`, `CAP_LIMITATION`, `MISSING_PROVIDER_DATA`, `ZERO_COERCION`,
`UNKNOWN`. Defects are the subset that mean Loop is wrong.

**`fullyReconciled` requires no defects AND nothing unverified.** A window with
zero defects but unentered CallGrid figures reports *"This is NOT a pass."*

### Structural reconciliation

Overview Top Buyer **is** `dimensions.buyers[0]`, which **is** the first row the
Buyers table renders — the same array from one aggregation path. They cannot
disagree because there is no second path, and the harness asserts it anyway.

---

## Unknowns

Every page shows what Loop cannot determine, where it affects interpretation —
not buried in diagnostics. Causation, the missing roster, partial coverage,
in-progress periods, buyer capacity, per-opportunity value, route fallback,
bid history, and destination acceptance denominators are all stated in product
language.

---

## LLM narrative

**Not enabled.** Every string is deterministic template language built from
structured findings. There is no LLM in this path.

If one is added later it may only convert approved structured findings into
readable prose. It may not query CallGrid, calculate a metric, select a field,
determine truth, invent a cause or a recommendation, assign severity, calculate
confidence, or override an unknown. Its output must validate against the
structured finding IDs, and the deterministic templates must remain the fallback.

---

## Production validation

The sandbox has **no database, no runtime and no browser**, so no figure here has
been seen against real data. Production validation (per period: Loop vs CallGrid
revenue / profit / billable / total, plus top-five reconciliation per dimension)
must be run on the deploy using the diagnostics panel, and every discrepancy
classified `MATCH` / `EXPECTED_ROUNDING` / `KNOWN_PROVIDER_LIMITATION` / `BUG`.

# CallGrid Intelligence — Production Reconciliation Worksheet

**Status: NOT STARTED. No figure in this document has been observed against real data.**

This is the instrument for validating PR #149 against real CallGrid production data. It is
deliberately shipped **empty**. Every cell marked `—` requires a human with two credentials this
repository's automation does not have:

1. **A Loop admin session** on the deploy (`/app/admin/*` is guarded server-side).
2. **A CallGrid UI login** — the external source of truth.

Nothing in this file may be filled in from inference. A cell is either an observed value or `—`.

> **Why a human is required, permanently.** CallGrid has **no working aggregate call-statistics
> endpoint**. `POST /api/reports/stats` returned HTTP 400 on the live discovery run (2026-07-18)
> and has never returned 200; it is recorded in `callgrid-reports.ts` with empty `rowFields` /
> `footerTotalsFields` because its response shape was never observed. Loop's call economics come
> from ingested call records, not from a CallGrid report. So "do Loop's numbers match CallGrid's?"
> **cannot be automated** — it is answered by a person reading the CallGrid interface.
>
> That endpoint is also the **only** one accepting `reportTimeZone`, which is why §3 below lists
> CallGrid's bucketing timezone as UNVERIFIED rather than assumed.

---

## 1. Deployment facts

| Field | Value |
|---|---|
| PR | [#149](https://github.com/elitemediagroup1/emgloop-platform/pull/149) — **Draft** |
| Branch | `feat/callgrid-intelligence-factuality` |
| Base | `main` @ `9551cdc` — no merge conflicts, branch is current |
| Preview commit SHA | `886e89008477ac9a3c4db729aca8a342a27e478e` |
| Preview URL | https://deploy-preview-149--emgloop2.netlify.app |
| Netlify deploy ID | `6a6a1734d96e2e0008cbfac7` |
| Netlify project | `emgloop2` |
| Deploy status | ✅ ready (`netlify/emgloop2/deploy-preview` passed) |
| Migration included | **None** (verified: no `schema.prisma` or migration file in the diff) |
| Database environment | **— UNCONFIRMED.** Netlify deploy previews inherit production env vars unless scoped. Whether this preview reads the production Neon database has **not** been verified and must be confirmed before any number here is trusted. |
| Organization tested | — (expected `servicesinmycity-demo` via `LIVE_ORG_SLUG`) |
| Validated by | — |
| Date validated | — |

⚠️ **Confirm the database environment first.** If the preview points at production, every read is
real but is also a live-data read. If it points elsewhere, this worksheet validates nothing.

---

## 2. Loop-side definitions — VERIFIED FROM CODE

These are Loop's actual implemented definitions, read from source. This half of Steps 7–9 is
**verified**. The CallGrid half of each is **unverified** and is what the human must establish.

### Inclusion rule
Every metric below is computed over `MarketplaceCall` rows where:

```
organizationId = <session org>          — never from a query param
sourceOccurredAt >= start AND < end     — HALF-OPEN; end is EXCLUSIVE
```

`packages/database/src/repositories/marketplace-call.repository.ts:192`

**There is no status filter of any kind.** Loop counts every ingested call in the window.

### Metric definitions
Source: `packages/shared/src/callgrid-metric-contract.ts`

| Metric | Loop's formula | Provider field(s) | CallGrid-side question to answer |
|---|---|---|---|
| **Total Calls** | `count(calls in window)` | — | Does CallGrid's "Total" also count every call, or does it exclude duplicates / unanswered / no-route? **If CallGrid excludes any status, Loop overcounts.** |
| **Billable Calls** | `count(calls where monetized = true)` | `monetized` | Is CallGrid's "Billable" the same flag? |
| **Revenue** | `sum(revenueCents) where revenueCents IS NOT NULL` | `revenueCents` | Gross or net? Are adjustments included? Do later updates overwrite or append? |
| **Profit** | `sum(revenueCents) − sum(payoutCents) − sum(costCents)` | `revenueCents`, `payoutCents`, `costCents` | **Highest-risk definition.** Loop subtracts payout **and** cost. If CallGrid's profit is revenue − payout only, Loop understates profit on every row. |
| **Revenue / billable call** | `revenue / billableCalls` | | |
| **Billable rate** | `billableCalls / totalCalls` | | |

**Null is never zero.** Every field is nullable and never 0-defaulted; per-row coverage counters
(`callsWithRevenue`, `callsWithCost`, `callsWithPayout`) track how many rows actually carried a
value, so an unpriced entity renders **Unknown** and sorts last — it does not collapse into a fake
`$0` row. Profit completeness is the **weakest** of the three coverages, because profit computed
over rows missing payout or cost **overstates** profit.

### Timestamp
Bucketing uses **`sourceOccurredAt`** — the provider's call timestamp, not Loop's ingestion time.

⚠️ **Unverified:** whether `sourceOccurredAt` is call *start* or call *end*. This determines which
day a call spanning midnight lands in. Establish this before accepting any single-day match.

---

## 3. Timezone — Loop side VERIFIED, CallGrid side UNVERIFIED

Loop resolves every window in **`America/New_York`** (`packages/shared/src/business-time.ts`).
Verified by executing the real resolver (`resolveCallGridWindow`):

| Case | Window (UTC) | Length | Verdict |
|---|---|---|---|
| Normal EDT day (2025-07-15) | `04:00Z` → next `04:00Z` | 24h | ✅ |
| Spring forward (2025-03-09) | `2025-03-09T05:00Z` → `2025-03-10T04:00Z` | **23h** | ✅ DST-correct |
| Fall back (2025-11-02) | `2025-11-02T04:00Z` → `2025-11-03T05:00Z` | **25h** | ✅ DST-correct |
| Month boundary (2026-06-30) | `04:00Z` → `2026-07-01T04:00Z` | 24h | ✅ |
| Year boundary (2025-12-31) | `05:00Z` → `2026-01-01T05:00Z` | 24h | ✅ EST-correct |
| Future-dated range | falls back to Today, `isValid: false` | — | ✅ fails closed |

⚠️ **CallGrid's bucketing timezone is UNVERIFIED.** The only endpoint that accepts `reportTimeZone`
is the one that returns HTTP 400. **If CallGrid's UI buckets in UTC or another zone, single-day
figures will differ by the calls falling in the offset hours — and this will look like an ingestion
gap when it is a timezone difference.** Establish this before classifying any single-day mismatch.

Record CallGrid's timezone setting here: **—**

---

## 4. Period windows — Loop's exact UTC boundaries

Computed from the real resolver at an illustrative `now = 2026-07-29 10:15 ET`. **Re-run for your
actual validation date** — live windows cut at the current wall clock.

| # | Period | Loop URL `?range=` | Eastern start | Eastern end | UTC start | UTC end (exclusive) | Completed? | Comparison basis |
|---|---|---|---|---|---|---|---|---|
| 1 | Yesterday | `yesterday` | Jul 28 00:00 | Jul 29 00:00 | `2026-07-28T04:00Z` | `2026-07-29T04:00Z` | ✅ | complete_period — "The day before" |
| 2 | Two days ago | `custom&s=2026-07-27&e=2026-07-27` | Jul 27 00:00 | Jul 28 00:00 | `2026-07-27T04:00Z` | `2026-07-28T04:00Z` | ✅ | complete_period |
| 3 | Historical weekday (Wed Jul 22) | `custom&s=2026-07-22&e=2026-07-22` | Jul 22 00:00 | Jul 23 00:00 | `2026-07-22T04:00Z` | `2026-07-23T04:00Z` | ✅ | complete_period |
| 4 | Historical weekend (Sat Jul 25) | `custom&s=2026-07-25&e=2026-07-25` | Jul 25 00:00 | Jul 26 00:00 | `2026-07-25T04:00Z` | `2026-07-26T04:00Z` | ✅ | complete_period |
| 5 | Last 7 Days | `last_7_days` | Jul 23 00:00 | **now** | `2026-07-23T04:00Z` | `2026-07-29T14:15Z` | ❌ **live** | elapsed_matched |
| 6 | Last Week | `last_week` | Jul 20 00:00 | Jul 27 00:00 | `2026-07-20T04:00Z` | `2026-07-27T04:00Z` | ✅ | complete_period — "The prior week" |
| 7 | This Month **through yesterday** | ⚠️ see note | Jul 1 00:00 | Jul 29 00:00 | `2026-07-01T04:00Z` | `2026-07-29T04:00Z` | ✅ | complete_period |
| 8 | Custom completed range | `custom&s=2026-07-20&e=2026-07-26` | Jul 20 00:00 | Jul 27 00:00 | `2026-07-20T04:00Z` | `2026-07-27T04:00Z` | ✅ | complete_period |
| 9 | Today | `today` | Jul 29 00:00 | **now** | `2026-07-29T04:00Z` | `2026-07-29T14:15Z` | ❌ **live** | elapsed_matched — "Yesterday to the same time" |

> ⚠️ **Note on #7.** Loop's `this_month` preset **includes today** and is therefore a *live* window
> ending at `now`, not "through yesterday". To validate "This Month through yesterday" as specified,
> use `custom&s=2026-07-01&e=2026-07-28`. Do not use `range=this_month` for that row.

**Validate in the order 1 → 8 (completed periods) before 9 (Today).**

---

## 5. Per-period reconciliation

Fill one block per period. **Do not mark `MATCH` without actual values from both systems.**
Structural agreement is not numeric reconciliation.

Result vocabulary: `MATCH` · `EXPECTED_ROUNDING` · `KNOWN_PROVIDER_LIMITATION` ·
`LIVE_WINDOW_MISMATCH` · `INGESTION_GAP` · `MAPPING_BUG` · `TIMEZONE_BUG` · `FILTER_MISMATCH` ·
`UNRESOLVED`

### Template — copy once per period

```
Period:              
Eastern start:                          Eastern end:            
CallGrid timezone:   —                  Loop timezone: America/New_York
```

| Metric | CallGrid | Loop | Difference | Difference % | Result | Explanation |
|---|---|---|---|---|---|---|
| Revenue | — | — | — | — | — | — |
| Profit | — | — | — | — | — | — |
| Billable Calls | — | — | — | n/a | — | — |
| Total Calls | — | — | — | n/a | — | — |

| Field | CallGrid | Loop |
|---|---|---|
| Filters applied | — | — |
| Completeness / coverage | — | — |
| Record count | — | — |
| Excluded rows | — | — |

**Overall result:** — **Explanation:** —

---

### Period 1 — Yesterday (**validate this first**)

Yesterday is the first required truth test: it is a completed Eastern day with no live-window
ambiguity. **If Yesterday does not reconcile, stop and fix the canonical defect before validating
any other period.**

| Metric | CallGrid | Loop | Difference | Difference % | Result | Explanation |
|---|---|---|---|---|---|---|
| Revenue | — | — | — | — | — | — |
| Profit | — | — | — | — | — | — |
| Billable Calls | — | — | — | n/a | — | — |
| Total Calls | — | — | — | n/a | — | — |

Top entities (must equal the first-ranked row on each subpage):

| | CallGrid | Loop | Match? |
|---|---|---|---|
| Top Buyer | — | — | — |
| Top Vendor | — | — | — |
| Top Source | — | — | — |
| Top Campaign | — | — | — |

**Overall result:** — **Explanation:** —

### Periods 2–8

_Copy the template above for each. Not started._

### Period 9 — Today (live window)

Compare **at the same clock time**: Loop "Today through HH:MM ET" against CallGrid "Today through
approximately HH:MM ET". Never compare a partial day against a complete previous day.

| Field | Value |
|---|---|
| Clock time of comparison (ET) | — |
| Loop header reads | — (expected: `Today · Live`) |
| Loop comparison label reads | — (expected: `Yesterday to the same time`) |
| Comparison basis | expected `elapsed_matched` |

| Metric | CallGrid (same cutoff) | Loop | Difference | Result |
|---|---|---|---|---|
| Revenue | — | — | — | — |
| Profit | — | — | — | — |
| Billable Calls | — | — | — | — |
| Total Calls | — | — | — | — |

---

## 6. Mismatch trace

For **every** mismatch, trace the full chain and record the value at each hop. Fix only at the
canonical layer — **never** with a page-component exception.

| Hop | Value observed |
|---|---|
| CallGrid visible report | — |
| CallGrid provider source / exported detail | — |
| Loop ingestion record (`integration_events`) | — |
| `MarketplaceCall` projection | — |
| `aggregateWindow()` | — |
| Canonical metric implementation | — |
| Canonical dimension row | — |
| Overview value | — |
| Subpage value | — |
| Intelligence finding | — |

**Permitted fix sites:** ingestion mapping · canonical projection · date-window resolver ·
metric contract · canonical report service.
**Forbidden:** page components, per-page exceptions.

---

## 7. Dimension reconciliation (top 5 per dimension, per completed period)

Repeat for Buyers / Vendors / Sources / Campaigns.

| Rank | Entity ID | Entity Name | CG Revenue | Loop Revenue | Δ | CG Billable | Loop Billable | Δ | CG Total | Loop Total | Δ | Result | Explanation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 2 | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 3 | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 4 | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 5 | — | — | — | — | — | — | — | — | — | — | — | — | — |

Assertions to confirm for each dimension:

- [ ] Overview's top entity **equals** the subpage's first-ranked row
- [ ] Display names map to the correct provider identity
- [ ] Unpriced entities render **Unknown** and sort last — they do **not** collapse into one fake `$0` entity
- [ ] Entity counts mean **observed this period**, not configured roster
- [ ] No CRM record is substituted for a marketplace entity
- [ ] Duplicate display names do **not** merge distinct IDs
- [ ] Missing names do **not** merge unrelated IDs

⚠️ **Campaign and vendor profit is not attributable at that grain** and the pages say so. If a
profit figure appears at a grain whose inputs are not attributable, that is a defect — **remove the
metric, do not estimate it.**

---

## 8. Bid reconciliation — snapshot only

⚠️ Bid data is **snapshot-only**: one window is stored, so **no bid trend is shown anywhere**.
Historical bid snapshots are a separate ingestion project. Confirm no trend appears.

| Field | Value |
|---|---|
| Snapshot date | — |
| Requested UTC window | — |
| Last sync | — |
| Source rows | — |
| Destination rows | — |
| Completeness | — |

⚠️ **Source and destination counts are different sides of the marketplace and are never combined.**
`sourceId` is the only join key, and only within one report window.

### Source grain (`/api/reports/bidStats`, `bidStats/rejections`)

| Metric | CallGrid | Loop | Δ | Result |
|---|---|---|---|---|
| Bid Opportunities | — | — | — | — |
| Bids Submitted | — | — | — | — |
| Bids Won | — | — | — | — |
| Rejected Opportunities | — | — | — | — |
| Win Rate | — | — | — | — |
| Reject Rate | — | — | — | — |
| Rejection categories | — | — | — | — |

> Win rate and reject rate are stored **verbatim from the provider** and are **not** recomputed from
> counts — the provider owns those denominators. Confirm Loop displays the provider's value.

### Destination grain (`/api/reports/pingStats`)

| Metric | CallGrid | Loop | Δ | Result |
|---|---|---|---|---|
| Accepted | — | — | — | — |
| Rate Limited | — | — | — | — |
| Timed Out | — | — | — | — |
| Below Minimum Revenue | — | — | — | — |
| Failed Tag Rules | — | — | — | — |
| API Failed | — | — | — | — |
| Suppressed | — | — | — | — |
| Invalid Number | — | — | — | — |
| Missing Amount | — | — | — | — |

Confirm:
- [ ] The snapshot date is visible on the page
- [ ] The selected CallGrid date is **not** falsely applied to snapshot-only metrics
- [ ] No bid trend appears anywhere
- [ ] Denominators match the provider's

---

## 9. Intelligence validation (≥5 completed periods, materially different performance)

For each finding, mark: `ACCEPT` · `REWRITE` · `RULE_DEFECT` · `DATA_DEFECT` · `NOT_USEFUL` ·
`UNSUPPORTED`. **No finding is accepted merely because the code produced it.**

| # | Period | Finding (ruleId@version) | Values correct? | Comparison period correct? | Arithmetic reproducible? | Classification correct? | Severity reasonable? | Contribution ≠ causation? | Unknowns visible? | Review safe? | Useful to an operator? | Merely restates the metric? | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | — | — | — | — | — | — | — | — | — | — | — | — | — |

Cover per period: primary performance · top positive driver · top negative driver ·
volume-vs-value · concentration · margin (where supported) · buyer · vendor · source · campaign ·
bid · unknowns · recommended review.

### The bar for "intelligence, not reporting"

`Revenue is down 25%.` is **reporting** and is not sufficient. For every primary performance change
the system should attempt: largest contributing buyer / vendor / source / campaign · whether the
change is volume-driven or value-per-call-driven · whether profit moved differently from revenue ·
whether concentration increased · whether a former top entity went inactive · or an explicit
statement that the data is insufficient to determine cause.

**Accepted shape:**

> Revenue declined 18% versus the prior completed period. The largest negative contributor was
> Buyer X, whose revenue decreased by $420 and represented 61% of the total decline. Billable calls
> fell 16%, while revenue per billable call remained within 2% of the comparison period. The change
> therefore appears primarily **volume-driven** rather than price-driven. Loop cannot determine
> whether Buyer X's decline was caused by caps, schedule, routing, demand, or buyer-side
> availability because those fields are not exposed. **Recommended review:** compare Buyer X's
> activity and associated campaigns before changing traffic or payouts.

**Rejected shape:** `Revenue is down. Contact the buyer and increase traffic.`

### Correcting a bad finding — in this order

| Wrong thing | Fix at |
|---|---|
| The data | metric source |
| The derivation | formula |
| The significance / interpretation | rule |
| Only the wording | template |
| Insufficient evidence | **suppress the finding** |

- **Do not** use an LLM to hide a weak deterministic finding.
- **Do not** broaden a rule merely to guarantee something always appears.
- `No evidence-backed finding for this period.` is **preferable** to a weak or fabricated insight.

### Bids page — must prioritize, not list

Useful: *"Destination A represents 72% of all observed rate-limited outcomes."*
Not useful: *"Rate Limited: 77,921."*

Each top bid issue must carry: source or destination · category · count · rate (when valid) · share
of the relevant denominator · classification · preventability · why it matters · what is known ·
what remains unknown · safe recommended review · evidence.

⚠️ Bid reports carry **no revenue**, so no monetary claim may be made about a bid issue. The
review-priority score orders work **without pricing it**.

---

## 10. Evidence drawer validation

For every accepted finding, open the drawer and confirm **present**:

- [ ] Selected period · [ ] Comparison period · [ ] Metric definition · [ ] Provider source
- [ ] Entity IDs **and** names · [ ] Current values · [ ] Comparison values · [ ] Calculation
- [ ] Rule ID · [ ] Rule version · [ ] Classification · [ ] Confidence
- [ ] Limitations · [ ] Unknowns

And confirm **absent** (security):

- [ ] No provider credentials · [ ] No raw sensitive phone numbers · [ ] No raw private call records
- [ ] No secrets · [ ] No internal stack traces

---

## 11. Production screenshots

Real production data only. Not captured: all.

| Surface | Captured |
|---|---|
| Overview — Yesterday | — |
| Overview — Today | — |
| Overview — Last 7 Days | — |
| Buyers | — |
| Vendors | — |
| Sources | — |
| Campaigns | — |
| Bids | — |
| Activity | — |
| One evidence drawer | — |
| Administration → CallGrid diagnostics | — |

---

## 12. Reconciliation harness

`/app/admin/administration/diagnostics/callgrid`

The harness proves everything internal automatically and accepts CallGrid's figures typed in from
the UI. **`fullyReconciled` requires no defects AND nothing unverified** — a window with unentered
figures reports *"This is NOT a pass."*

**Query contract** (`reconciliation-panel.tsx:64–101`):

```
?range=<preset>            today | yesterday | this_week | last_2_days | last_7_days |
                           last_14_days | last_30_days | last_week | last_2_weeks |
                           this_month | last_month | year_to_date | custom
&s=YYYY-MM-DD&e=YYYY-MM-DD  (custom only)
&dim=<overview|buyers|vendors|sources|campaigns|bids-source|bids-destination>
&topN=5                     (1–25)
&cgCalls=          CallGrid Total Calls
&cgBillable=       CallGrid Billable Calls
&cgRevenueCents=   CallGrid Revenue — IN CENTS
&cgProfitCents=    CallGrid Profit  — IN CENTS
&cgTop=            CallGrid top entity name
```

⚠️ **Revenue and profit are entered in CENTS, not dollars.** `$1,234.56` is `123456`.

Example — Yesterday, buyers, with CallGrid figures entered:

```
/app/admin/administration/diagnostics/callgrid?range=yesterday&dim=buyers&topN=5
  &cgCalls=412&cgBillable=118&cgRevenueCents=286400&cgProfitCents=94100&cgTop=Acme%20Home
```

---

## 13. Acceptance checklist

CallGrid Intelligence is **not** complete until every box is ticked. **All are currently unticked.**

- [ ] Preview database environment confirmed
- [ ] ≥6 completed periods numerically reconciled
- [ ] Today validated at the same time cutoff
- [ ] Top-five dimensions reconciled (buyers, vendors, sources, campaigns)
- [ ] Bid **source** snapshot reconciled
- [ ] Bid **destination** snapshot reconciled
- [ ] No unexplained discrepancy remains
- [ ] Every accepted intelligence finding manually reviewed
- [ ] Bids page provides prioritized operational intelligence, not a table
- [ ] Evidence drawers accurate and leak nothing
- [ ] Unsupported metrics removed (not estimated)
- [ ] Unknowns visible
- [ ] Call-status semantics verified against CallGrid
- [ ] Revenue definition verified against CallGrid
- [ ] Profit definition verified against CallGrid
- [ ] CallGrid's bucketing timezone established
- [ ] Production serving the correct deployment (merge SHA + asset hashes verified)

---

## 14. Open questions for CallGrid — answer these first

These block classification of any mismatch. Each is currently **unanswered**.

1. What timezone does the CallGrid UI report bucket in? Is it configurable per user?
2. Does "Total Calls" include duplicates, unanswered, rejected, and no-route calls?
3. Is "Billable" the same flag Loop receives as `monetized`?
4. Is Profit `revenue − payout`, or `revenue − payout − cost`?
5. Is `sourceOccurredAt` call start or call end? Which bucket does a midnight-spanning call land in?
6. Are revenue figures gross or net, and are adjustments included?
7. When a call is updated after its initial event, does CallGrid overwrite or append?
8. Is there any row cap or truncation in the UI report?

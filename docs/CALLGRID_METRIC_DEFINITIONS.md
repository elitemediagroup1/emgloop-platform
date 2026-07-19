# CALLGRID_METRIC_DEFINITIONS.md — what every CallGrid number in EMG Loop means

**Status:** Canonical source of truth for CallGrid reporting definitions.
**Audience:** anyone adding, changing, or trusting a CallGrid metric.
**Companion:** `docs/CALLGRID_DATA_LINEAGE.md` (source → UI path), `callgrid-reconciliation.harness.ts`.

---

## 0. How to read this document — read this first

Definitions here are derived by **reading Loop's code**, not from a CallGrid specification. Loop has
no CallGrid API documentation in the repository beyond `docs/integrations/CALLGRID.md`, which
documents one webhook shape and nothing about metric semantics.

Every entry therefore carries a confidence marker, and the markers are the most important content
on this page:

| Marker | Meaning |
|---|---|
| **[COMPUTED]** | Loop computes this and the computation is verified by a harness. The definition is what Loop does. |
| **[MAPPED]** | Loop reads this from a source field documented in `docs/integrations/CALLGRID.md`. |
| **[INFERRED]** | Loop reads this from a source field name that is **not documented anywhere**. The mapping is a guess made by whoever wrote the adapter. **Do not trust without confirmation from CallGrid.** |
| **[ABSENT]** | Loop has no field for this. It cannot be reported at all. |

**An [INFERRED] metric may be silently wrong.** It will look correct — a number will render, tests
will pass — because nothing in the codebase can detect that a field name was guessed. Only a
reconciliation run against real CallGrid records can settle it.

---

## 1. The documented source payload

This is the entire documented CallGrid webhook contract (`docs/integrations/CALLGRID.md`):

```json
{
  "event": "call.completed", "call_id": "cg_abc123",
  "from": "+1...", "to": "+1...", "direction": "inbound",
  "duration_seconds": 142,
  "started_at": "2026-06-25T14:32:00Z", "ended_at": "2026-06-25T14:34:22Z",
  "recording_url": "...", "transcript": null,
  "utm_source": "google", "utm_campaign": "summer-campaign"
}
```

**Note what is not there: no revenue, no payout, no cost, no buyer, no qualified, no billable, no
transfer, no acceptance, no rejection.** Loop stores columns for all of those. That gap is the single
most important finding of the Sprint 32 audit and is why most economic metrics below are [INFERRED].

---

## 2. Volume metrics

| EMG Loop term | Definition as Loop computes it | Confidence |
|---|---|---|
| **Total calls** | Count of `MarketplaceCall` rows with `sourceOccurredAt` in `[since, until)`. One row per `(provider, externalId)`. | **[COMPUTED]** |
| **Unique calls** | Identical to total calls — the `@@unique([provider, externalId])` constraint makes duplicates impossible at rest. A repeated webhook upserts. | **[COMPUTED]** |
| **Duplicate calls** | Count where `duplicate === true`. Null (sensor did not say) is **not** counted as false. | **[INFERRED]** |
| **Connected calls** | Derived from `status`/`rawStatus`/`noRoute`. Loop treats a call as connectivity-known if any of the three is non-null. | **[INFERRED]** |
| **Answered calls** | **No distinct definition.** Loop does not separate "answered" from "connected". | **[ABSENT]** |
| **Missed / abandoned calls** | **No distinct definition.** Not separated from connect failures. | **[ABSENT]** |
| **Transferred calls** | **No field.** `MarketplaceCall` has no transfer column. | **[ABSENT]** |
| **Accepted / rejected calls** | **No field.** These are bid/auction concepts requiring the unbuilt bid-report path. | **[ABSENT]** |

## 3. Outcome metrics

| EMG Loop term | Definition | Confidence |
|---|---|---|
| **Qualified calls** | Count where `qualified === true`. Null is not false. Note this is the **buyer's own flag**, not a Loop judgement. | **[INFERRED]** |
| **Billable calls** | Count where `billable === true`. Column exists; no consumer reads it. | **[INFERRED]** |
| **Converted calls** | Count where `converted === true`. | **[INFERRED]** |
| **Bookings** | *Different source entirely.* Counted from the CRM `Booking` relation, **not** from CallGrid. Placing it beside CallGrid call counts invites a false conversion rate. | **[COMPUTED]** |
| **Lead count** | **Not a CallGrid metric in Loop.** No CallGrid-derived lead concept exists. | **[ABSENT]** |

## 4. Party metrics

| EMG Loop term | Definition | Confidence |
|---|---|---|
| **Buyer count** | Distinct non-null `buyerExternalId`/`buyerLabel` in the window. Absent attribution is excluded, not counted as an "unknown buyer". | **[INFERRED]** |
| **Active buyers** | On the marketplace sub-pages: buyers with revenue > 0 **or** orders > 0. Depends on coerced values — see the debt ledger in `TRUTH_STATES.md`. | **[COMPUTED]** |
| **Available buyers** | **No field.** Requires buyer caps, which CallGrid has not confirmed exposing. | **[ABSENT]** |
| **Buyer matches / responses** | **No field.** Bid-level concepts. | **[ABSENT]** |
| **Vendor / source / campaign counts** | Distinct non-null label per dimension. | **[INFERRED]** |

## 5. Rate metrics — denominators matter more than numerators

Every rate below is stated as *numerator ÷ denominator*, because the denominator is where rates
mislead. A rate over a window with partial coverage is itself partial.

| EMG Loop term | Definition | Confidence |
|---|---|---|
| **Connection rate** | Not currently displayed as a rate. Connectivity failures are surfaced as a risk rule at ≥20%. | **[COMPUTED]** |
| **Qualification rate** | `qualified calls ÷ total calls` in the window. Denominator is **all** calls, including those whose `qualified` flag is null — so a sparsely-flagged window understates it. | **[COMPUTED]** |
| **Conversion rate** | On traffic surfaces: `bookings ÷ calls`. **The numerator is CRM-sourced and the denominator is CallGrid-sourced.** Treat with suspicion. | **[COMPUTED]** |
| **Attribution rate** | `calls with a real vendor ÷ total calls`. | **[COMPUTED]** |
| **Transfer / acceptance rate** | **Cannot be computed.** Underlying fields absent. | **[ABSENT]** |

## 6. Money metrics

**Unit rule: Loop stores integer CENTS everywhere. `MarketplaceCall.revenueCents` and friends are
cents by name and by contract. The source unit is NOT documented** — the reconciliation harness
therefore requires the unit to be declared explicitly per run (`sourceMoneyUnit`) rather than guessed,
because a dollars/cents confusion is a silent 100× error.

| EMG Loop term | Definition | Confidence |
|---|---|---|
| **Revenue** | Sum of non-null `revenueCents`. Nulls are **not** summed as zero; they reduce coverage and degrade the measurement to PARTIAL. | **[INFERRED]** source field |
| **Payout** | Sum of non-null `payoutCents`. | **[INFERRED]** |
| **Cost** | Sum of non-null `costCents`. | **[INFERRED]** |
| **Gross profit / margin** | `revenue − payout − cost`. **Derived, never stored.** Only meaningful when all three have full coverage; with partial coverage it is a lower bound of unknown direction. | **[COMPUTED]** |
| **Revenue per call** | `revenue ÷ calls`. ⚠️ On the Marketplace overview, realized revenue is **all-time** while calls are **7-day** — these are now labelled per tile precisely so they are not divided. | **[COMPUTED]** |
| **Revenue per qualified / accepted call** | Not computed. Accepted calls are [ABSENT]. | **[ABSENT]** |
| **Cost per call** | Not currently displayed. | **[ABSENT]** |
| **Realized vs pending revenue** | *CRM Orders, not CallGrid.* Realized = orders in PLACED/IN_PROGRESS/READY/FULFILLED; pending = DRAFT. An order with no captured amount degrades the read to PARTIAL. | **[COMPUTED]** |

## 7. Duration metrics

| EMG Loop term | Definition | Confidence |
|---|---|---|
| **Call duration** | `durationSeconds`, integer **seconds**. Source documents `duration_seconds`, so the unit agrees. | **[MAPPED]** |
| **Average call duration** | `sum(durationSeconds) ÷ count of calls WITH a duration`. The denominator excludes unknowns rather than treating them as zero-length. | **[COMPUTED]** |
| **Connected duration** | **No separate field.** Cannot be distinguished from total duration. | **[ABSENT]** |

## 8. Trust metrics

| EMG Loop term | Definition | Confidence |
|---|---|---|
| **Coverage** | For a capability: `calls carrying the field ÷ calls examined`. For a bounded read: rows scanned, with `total: null` when the true denominator is unknown. | **[COMPUTED]** |
| **Confidence** | CallGrid module read, `[0, 0.7]`. Starts at 0.3, +0.2 for ≥10 calls, +0.15 for a prior window, +0.1 for ≥80% revenue coverage, +0.05 for bid facts. **Hard-capped at 0.7** — one period is a direction, not a certainty. Returns 0 when there are no calls. | **[COMPUTED]** |
| **Unknown / unavailable / partial** | Truth States. See `docs/TRUTH_STATES.md`. Only SUCCESS and EMPTY may render a numeric zero. | **[COMPUTED]** |

---

## 9. What must be confirmed with CallGrid

These are the questions whose answers would move metrics out of [INFERRED]:

1. **Which API or webhook carries economics?** The documented webhook carries none. Where do
   `revenue`, `payout`, `cost` and `buyer` actually come from, and what are their exact field names?
2. **Is source money in dollars or cents?** A wrong assumption is a silent 100× error.
3. **What are the exact values of `status` / `rawStatus`?** Loop's connect-failure rule keys off
   `connectFailed`/`noConnect`/`noRoute`; the full enumeration is unconfirmed.
4. **What is `qualified` semantically?** Buyer-asserted, CallGrid-asserted, or rule-derived? It drives
   a rate shown to executives.
5. **What timezone are source timestamps in?** The documented example is UTC (`Z`), but whether every
   payload is UTC is unconfirmed. A non-UTC local string parsed by `new Date()` is
   implementation-defined and would move calls across day boundaries.
6. **Does CallGrid ever restate a call?** Late revenue, corrected buyer. Loop upserts on
   `(provider, externalId)`, so a restatement overwrites — which is right only if CallGrid always
   sends the complete record.

Until 1 and 2 are answered, **no economic figure in EMG Loop can be called verified.**

---

## 10. Data lineage — source to UI

```
CallGrid webhook                    CallGrid REST API
  callgrid.provider.ts                callgrid-api.ts
  pick() → numeric()/boolFrom()       pickField() → toNumber()/parseDurationSeconds()/boolFrom()
        │                                     │
        └──────────────┬──────────────────────┘
                       ▼
        IntegrationEvent  (raw payload, @@unique[provider, externalId] — NOT org-scoped)
                       ▼
        ingestion.service.ts → normalization.repository.ts
                       ▼
        Interaction  (occurredAt; economics live in metadata JSON, dollars)
                       ▼
        marketplace-call-projection.ts   centsOrNull() = Math.round(dollars × 100)
                       ▼
        MarketplaceCall  (integer CENTS; every measurement column nullable)
                       ▼
        MarketplaceCallRepository.aggregateWindow / coverageObservations
                       ▼
        Truth<T>  (SUCCESS · EMPTY · PARTIAL · UNKNOWN · UNAVAILABLE · ERROR)
                       ▼
        page loader → renderTruth() → KPI tile / Coverage / Briefing
```

**Unit changes exactly once**, at `centsOrNull` — dollars in, cents out, `Math.round` after
multiplication. There is no other `×100` or `÷100` in the ingestion path.

**Timezone is never applied.** `Interaction.occurredAt` flows verbatim to
`MarketplaceCall.sourceOccurredAt`. Every window query is UTC and half-open `[since, until)`.

**Two ingestion paths with different parsers.** The webhook and API adapters do not share their
numeric or duration parsing, so the same call can yield different stored values depending on which
path ingested it first. This is a known defect (Sprint 32, §1.3/2.1).

---

## 11. Sprint 36 — semantic corrections

### `qualified` → `monetized` (RENAMED)

CallGrid sends **no qualified field of any kind**. Loop derived
`billable ∨ converted ∨ paid` and stored it on `MarketplaceCall.qualified`, beside genuine provider
flags, where it was indistinguishable from one. It measures *"the call produced a positive
commercial outcome"*, not *"the call met a qualification standard"* — and an executive reading a
qualification **rate** reads it as call quality.

Renamed across schema, repositories, intelligence contract, and UI (tile now reads **Monetized**).

**No migration was required.** The Prisma field is `monetized @map("qualified")`, so the physical
column is unchanged — confirmed by `prisma migrate diff`, which reports an empty migration.
Migrations here are manually dispatched, so a code/schema skew would take production down; the
column itself can be renamed in a dedicated migration when one is being deployed anyway.

**The metadata key stays `qualified`.** `Interaction.metadata` is stored historical payload and
cannot be rewritten. Only the canonical field is renamed.

### Profit vs Net Profit (CORRECTED)

Proven by CallGrid's report for 2026-07-18:

```
Profit     = Revenue − Payout            540.17 − 461.30 = 78.87   (Margin %    14.60)
Net Profit = Revenue − Payout − Cost     78.87  −  13.76 = 65.11   (Net Margin % 12.05)
```

Loop's derived margin is CallGrid's **Net Profit**, not its Profit.

### Duration (NARROWED)

`billable_duration` / `BillableDuration` removed from the total-duration alias lists. If the primary
key were ever absent, **billable** duration would have landed in a field named **total** duration.
An absent duration now stays unknown.

**Scope remains UNVERIFIED.** The tag is `CallDuration`; whether it means total elapsed, connected,
or talk time is not stated anywhere available to us.

### Timestamp (UNVERIFIED — documented, not guessed)

| | |
|---|---|
| Loop stores | `MarketplaceCall.sourceOccurredAt` ← `Interaction.occurredAt` ← `occurredAtUnix` (tag `UTCUnixTime`) |
| Timezone | **Resolved.** The tag name states UTC; it is an unambiguous epoch |
| Lifecycle event | **Unresolved.** `UTCUnixTime` does not say whether it is call START or END |

This matters: CallGrid's report distinguishes `Ended` (106) from `Completed` (104), so lifecycle
events are tracked separately upstream. If `UTCUnixTime` is the END time, a call starting 23:58 and
ending 00:03 is attributed to the following day, while Loop's field is named `sourceOccurredAt` and
documented "when the call actually occurred" — which reads as start.

**Question for CallGrid:** does `UTCUnixTime` represent call start or call end?

### Window boundary

Reconciliation defaults to the **US/Eastern** day, matching `reportTimeZone=US/Eastern`. `?tz=utc`
selects the raw UTC day. The offset is derived per-date via `Intl` (UTC-4 in EDT, UTC-5 in EST), so a
winter window is not silently shifted.

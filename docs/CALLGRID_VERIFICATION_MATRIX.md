# CALLGRID_VERIFICATION_MATRIX.md — forensic audit, Sprint 33

**Verdict: NOT YET TRUSTWORTHY.**
**Method:** mechanical extraction from source, not reading-and-summarising. Every count below is
reproducible with the commands recorded in §7.
**Live CallGrid data used: none.** No `DATABASE_URL`, no credentials, no captured payloads.

---

## 1. The finding that governs everything else

**The CallGrid numbers displayed on the Marketplace page are not read from the canonical CallGrid
record.** There are two disconnected representations of the same call, and the executive-facing KPIs
read the one with no type safety and no coverage tracking.

| | **Path A — what is displayed** | **Path B — the canonical projection** |
|---|---|---|
| Stored as | `Interaction.metadata` (untyped JSON) | `MarketplaceCall` (typed, nullable columns) |
| Read by | `revenueByDimension`, `trafficIntelligence` | `aggregateWindow`, `coverageObservations` |
| Extraction | `jsonStr(metadata, 'vendor')` — string probing | Typed columns with null semantics |
| Feeds | **Marketplace KPI tiles · CRM Revenue · CRM Traffic** | Executive Briefing · the Coverage panel |

Verified: `revenue-intelligence.repository.ts` queries only `prisma.customer.findMany` (:394) and
`prisma.interaction.findMany` (:543). It contains **zero** references to `marketplaceCall`.

### 1.1 The consequence, stated plainly

On the Marketplace overview, the **Coverage panel** reports on `MarketplaceCall.revenueCents`, while
the **Revenue tile directly above it** is computed from a different store entirely. The panel can
truthfully report "Revenue: Available — 1,284 of 1,284 calls carry revenue" about a field that does
not drive the number above it. Nothing reconciles the two.

### 1.2 Worse: the Revenue tile is not a CallGrid metric at all

`revenueOf()` sums `customer.orders[].totalCents` filtered by
`REVENUE_STATUSES = {PLACED, IN_PROGRESS, READY, FULFILLED}` (:132, :320). Those are **CRM Order
rows**, not CallGrid.

So "Realized revenue" on the Marketplace page is CRM order revenue, displayed beside CallGrid call
counts, beneath a panel describing CallGrid revenue coverage. `MarketplaceCall.revenueCents` — the
actual CallGrid revenue, carrying all the null-safety and coverage work — reaches exactly one
surface: the Executive Briefing on `/app/admin/brain`.

**An executive reading the Marketplace page sees a revenue figure that has never touched CallGrid.**

---

## 2. Field-mapping evidence

Extracted mechanically from the two adapters (53 alias lists, deduplicated):

| Measure | Count |
|---|---|
| Distinct field names Loop attempts to read | **144** |
| Of those, documented in `docs/integrations/CALLGRID.md` | **6** |
| **Undocumented — the mapping is a guess** | **138 (96%)** |
| Documented fields Loop never reads | **6 of 12** |

The 6 documented-and-consumed: `call_id`, `duration_seconds`, `event`, `from`, `started_at`, `to`.

The 6 documented-and-ignored: `direction`, `ended_at`, `recording_url`, `transcript`, `utm_source`,
`utm_campaign`. Note `CALLGRID.md:114` explicitly requires `utm_source`/`utm_campaign` be stored for
attribution — they are read by nothing. `direction` being unread means an outbound CallGrid call is
recorded as `INBOUND` (`ingestion.service.ts:452-457`).

**The doc the adapters cite as their mapping authority — `CALLGRID_RECONCILIATION.md` — does not
exist.** Cited at `CALLGRID.md:127,142` and `callgrid-reconciliation.service.ts:5-6`.

---

## 3. Verification matrix

Status definitions: **VERIFIED** = traced end-to-end AND confirmed against a documented CallGrid
field. **PARTIALLY VERIFIED** = computation is correct and tested, but the source field is a guess.
**UNVERIFIED** = source mapping undocumented and untested against real data. **UNKNOWN** = cannot be
computed at all.

| Metric | CallGrid source field | Transformation | Repository | Displayed | Status |
|---|---|---|---|---|---|
| **Calls** | `event`/`callStatus` → row exists | count of `Interaction` where `channel='PHONE'` | `trafficIntelligence` | Marketplace, CRM Traffic | **PARTIALLY VERIFIED** — count logic tested; membership depends on guessed status mapping |
| **Realized revenue** | **none — not CallGrid** | Σ `Order.totalCents` where status ∈ 4 states | `revenueByDimension` | Marketplace, CRM Revenue | **UNVERIFIED as a CallGrid metric** — it is a CRM metric mislabelled by placement |
| **Qualified calls** | derived from `billable`/`converted`/`paid` | `jsonStr(metadata,'qualified')==='true'` | `trafficIntelligence` | Marketplace, CRM Traffic | **UNVERIFIED** — derivation is a Loop invention, not a CallGrid field |
| **Bookings** | **none — not CallGrid** | count of CRM `Booking` | `trafficIntelligence` | Marketplace | **UNVERIFIED as a CallGrid metric** |
| **Connected calls** | `status`/`rawStatus`/`noRoute` non-null | coverage count | `coverageObservations` | Coverage panel | **UNVERIFIED** — `connectFailed`/`noConnect`/`connected` are never read by either adapter |
| **Billable calls** | `billable`/`is_billable`/`isBillable` | `boolOrNull` | column exists | **nowhere** | **UNVERIFIED** — no consumer |
| **Accepted / rejected calls** | — | — | — | — | **UNKNOWN** — no field, requires unbuilt bid path |
| **Buyer count** | `buyerId`/`buyerName`/`buyer`/`buyer_name` | distinct non-null | `coverageObservations` | Coverage panel | **UNVERIFIED** — `callgrid-api.ts:18-20` states there is *no* name field on the Call object, contradicting the aliases the same file reads |
| **Campaign / Source / Vendor count** | `campaignId`/`sourceId`/`vendorId` + name aliases | distinct non-null | `coverageObservations` | Coverage panel | **UNVERIFIED** — same self-contradiction; documented `utm_campaign` unread |
| **Average duration** | `callDuration`/`duration`/`duration_seconds`/`BillableDuration` | Σ known ÷ count known | `aggregateWindow` | Briefing | **PARTIALLY VERIFIED** — denominator correct; unit unconfirmed and `billable_duration` is conflated with total |
| **Revenue (CallGrid)** | `revenue`/`revenue_amount`/`Revenue` | `Math.round(dollars × 100)` | `aggregateWindow` | Briefing only | **UNVERIFIED** — the dollars assumption is asserted in a comment only |
| **Coverage** | n/a — computed | observed ÷ examined | `coverageObservations` | Coverage panel | **VERIFIED** — 9 adversarial checks; measures what it claims |
| **Confidence** | n/a — computed | 0.3 base + increments, capped 0.7 | `callgrid/module.ts` | Briefing | **VERIFIED** — deterministic, tested |
| **Marketplace health** | derived from attribution % | ratio | `trafficIntelligence` | Marketplace | **UNVERIFIED** — inherits attribution guesses |

**Zero metrics are VERIFIED against CallGrid.** The two VERIFIED entries are self-referential — they
measure Loop's own internal state, not CallGrid data.

---

## 4. Assumption register

Every assumption still present in the CallGrid path.

### 4.1 Unit assumptions
| # | Assumption | Location | Impact if wrong |
|---|---|---|---|
| U1 | Source money is **decimal dollars** | `marketplace-call-projection.ts:93-97` | **100× error on every economic figure.** Asserted in a comment; no documentation, no range check, no sanity bound |
| U2 | Duration is **seconds** | both adapters | 60× error on every duration metric |
| U3 | `billable_duration` ≈ total duration | `callgrid.provider.ts:278`, `callgrid-api.ts:201` | Two distinct quantities in one column, unmarked |

### 4.2 Timezone assumptions
| # | Assumption | Location | Impact if wrong |
|---|---|---|---|
| T1 | Timestamps are ISO-with-offset | `callgrid.provider.ts:234`, `callgrid-api.ts:173` | `new Date(str)` on a non-ISO string is **implementation-defined**; a string without an offset parses as server-local |
| T2 | `reportTimeZone=US/Eastern` is requested but responses are parsed as UTC | `callgrid-api.ts:~290` | Calls after ~19:00 ET land on the wrong calendar day |
| T3 | `'today'` = server-local midnight | `callgrid-reconciliation.service.ts:115-123` | On a UTC host this is 19:00/20:00 ET the previous day — Loop's "today" can never equal CallGrid's |

### 4.3 Fabricated defaults — a value invented when the source was silent
| # | Default | Location | Impact |
|---|---|---|---|
| D1 | `occurredAt = new Date()` on any parse failure | `callgrid.provider.ts:232`, `:235`, `:237`; `callgrid-api.ts:173-174` | A call with an unreadable timestamp is recorded as happening **now**, dropping it into the current reporting window regardless of when it occurred |
| D2 | unknown status → `'call.inbound'` | `callgrid.provider.ts:85`; `reconciliation:275`; `ingestion.service.ts:167-169` | An unknown-disposition call is asserted as a real inbound call and fires an INTENT signal |
| D3 | `externalId = 'callgrid-' + Date.now()` | `callgrid.provider.ts:208`; api `:158` | Destroys idempotency: CallGrid's 5 documented retries create up to 6 distinct call rows |
| D4 | `status ?? 'unknown'` | `callgrid.provider.ts:216`; api `:165` | Feeds D2 |

### 4.4 Field-name assumptions
138 undocumented aliases (§2). The highest-risk are those the API adapter's own header contradicts:
`VendorName`, `SourceName`, `CampaignName`, `BuyerName` are read at `callgrid-api.ts:192-196` while
`:18-20` states no name field exists on the Call object.

### 4.5 Semantic assumptions
| # | Assumption | Impact |
|---|---|---|
| S1 | `qualified` = `billable ∨ converted ∨ paid` | A Loop invention. No CallGrid field; drives a rate shown to executives |
| S2 | A repeated `call_id` is a duplicate to discard | Late revenue posted under the same id is **silently dropped** (`ingestion.service.ts:130-132`); CallGrid receives 200 and never retries |
| S3 | Enrichment is fill-only | A wrong `0` counts as a real value and **permanently blocks** the correct figure |
| S4 | Re-projection is safe | `upsertProjection` does `update: data` — a full replace that **can null out** previously-known columns |

---

## 5. Required CallGrid fields not currently consumed

From the documented contract: `direction`, `ended_at`, `recording_url`, `transcript`, `utm_source`,
`utm_campaign`.

From the API `Call` object as described at `callgrid-api.ts:17-20`: `duplicate`, `blocked`,
`connected`, `connectFailed`, `noConnect`, `callHash`, `callSid`, `live`, `ended`, `phoneNumberId`,
`updatedAt`.

`connected` / `connectFailed` / `noConnect` matter most: the connectivity-failure risk rule and the
"Connected calls" coverage row are both derived by inference because the direct fields are unread.

---

## 6. Transformations that can change business meaning

1. `Math.round(dollars × 100)` — silent 100× if U1 is wrong (`marketplace-call-projection.ts:93`).
2. `new Date()` timestamp fallback — moves a call into the wrong reporting window (D1).
3. `qualified` derivation — manufactures a metric CallGrid never asserted (S1).
4. Unknown status → `call.inbound` — converts "we don't know" into a positive claim (D2).
5. Fill-only enrichment — freezes an early wrong value permanently (S3).
6. `update: data` full replace — demotes known economics to `NULL` on re-projection (S4).
7. Duplicate short-circuit — discards late revenue (S2).

---

## 7. Reproducing this audit

```bash
# 144 candidate field names, 138 undocumented
npx tsx -e "...pick/pickField alias extraction..."   # see git history of this sprint
# revenue-intelligence never touches MarketplaceCall
grep -c "marketplaceCall" packages/database/src/repositories/revenue-intelligence.repository.ts   # 0
# the two stores it does read
grep -n "prisma\..*\.findMany" packages/database/src/repositories/revenue-intelligence.repository.ts
```

---

## 8. Blockers preventing full trust

| # | Blocker | Unblocked by |
|---|---|---|
| B1 | No live CallGrid data of any kind | One API credential, or one exported CSV, or one captured webhook body |
| B2 | Money unit unconfirmed (U1) | One real payload showing a revenue value against a known call |
| B3 | 138 field names unconfirmed | CallGrid's actual field reference, or one full sample payload |
| B4 | Displayed KPIs bypass the canonical record (§1) | An engineering decision on which store is authoritative |
| B5 | Marketplace "Revenue" is CRM order revenue (§1.2) | A decision on what that tile is supposed to mean |

**B1 gates B2 and B3. B4 and B5 are internal and can be resolved without CallGrid.**

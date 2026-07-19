# CALLGRID_AUCTION_FUNNEL.md — the bid lifecycle, and what Loop can prove about it

**Status: NOT YET TRUSTWORTHY.** No bid data has ever been fetched, stored, or reconciled.
**Phase 1 gate: FAILED.** Data access is unverified, so no schema has been built.
**Companion:** `docs/CALLGRID_METRIC_DEFINITIONS.md` (call layer, largely verified).

---

## 1. Why there is no schema in this document

The sprint requires verifying data access before designing schema, and says explicitly: *"Do not
assume the screenshots prove API field names."* That instruction is load-bearing, because the
evidence shows the shortcut would have been wrong.

| Source | What it says | Status |
|---|---|---|
| `/api/call` | The only path any client knows | ✅ **VERIFIED** — 108 records reconciled |
| `/api/reports/bidStats` | Named only in a doc comment | ❌ **UNVERIFIED** — no client, no route, no fetch |
| `/api/reports/bidStats/rejections` | Named only in a doc comment | ❌ **UNVERIFIED** |
| `/api/reports/stats` | Named only in a doc comment | ❌ **UNVERIFIED** |
| OpenAPI spec | `401 Not authenticated` | ❌ **BLOCKED** — needs a credential |
| Owner's report screenshots | Real business vocabulary | ⚠️ **Reference only** — proves concepts, not field names |

### The stub is provably not the report

`CallGridBidStatsRow` exists in `@emgloop/marketplace-intelligence` — a package with **zero
importers** that **does not typecheck**. Sprint 32 classified it `[REPO]`, unconfirmed. Comparing it
against the report the owner actually sees:

| | Fields |
|---|---|
| **Report** | Pings · Bids · **Made** · Won · Rejected · Caller ID · Paused · Closed · **Capped** · Duplicate · **Duplicate Ping** · Tag Rules · Acceptance · **Rate Limited** · Avg Bid Response ms |
| **Stub** | bids · won · total · rated · rejected · totalBidAmount · totalWonAmount · avgBid · avgWinningBid · winRate · bidRate · rejectRate |

**The stub has no `pings` and no `made`** — the two stages at the very top of the funnel. It also has
no capped, rateLimited, duplicatePing, or response time.

A schema built from the stub would be missing the funnel. A schema built from the screenshots would
be inventing field names. **Neither is acceptable**, so `/api/integrations/callgrid/discover-reports`
was built instead: it asks CallGrid directly and reports top-level keys only.

---

## 2. The auction funnel — stages are NOT interchangeable

Business concepts, taken from the owner's report. **These are stage definitions, not field mappings.**

| # | Stage | Meaning | Unit | May differ from previous because |
|---|---|---|---|---|
| 1 | **PING** | An opportunity offered into the auction | count | — |
| 2 | **BID OPPORTUNITY** | A ping a given buyer/destination was eligible to bid on | count | Eligibility filters: caller id, tag rules, paused, closed |
| 3 | **BID EVALUATED** | An opportunity actually evaluated | count | Rate limiting, capacity |
| 4 | **BID MADE** | A bid was actually submitted | count | Price floor, configuration, latency |
| 5 | **BID WON** | The bid won the auction | count | Competition, price |
| 6 | **CALL CREATED** | A `MarketplaceCall` row exists | count | Window boundaries, delayed creation |
| 7 | **CALL CONNECTED** | The call connected | count | Routing, no-answer, busy |
| 8 | **CALL MONETIZED** | Positive commercial outcome (`monetized`) | count | Buyer disposition |

### Relationships that must NOT be assumed

The owner's reference figures make the scale of these gaps concrete:

```
Pings 478,504 → Bids 274,383 → Made 22,402 → Won 106
```

- **Pings ≠ Bids.** 204,121 pings never became a bid opportunity.
- **Bids ≠ Made.** Made % 8.16% — over 91% of evaluated bids were never submitted.
- **Made ≠ Won.** Win % 0.04%.
- **Won ≠ Calls.** Won 106 against 108 calls reconciled for the same date — see §5.
- **Calls ≠ Connected ≠ Monetized.** Already established in the call layer: Connects 104, Billable 18.

**A rate may only be computed when numerator and denominator are proven comparable.** `Made %` and
`Reject %` in the report sum to 100.00%, which suggests they share a denominator — but which one
(Pings or Bids) is **not established**, and the difference changes every downstream conclusion.

---

## 3. Failure taxonomy

Categories from the report. **Owning entity is inferred from the category's meaning and is marked
accordingly** — no category's ownership has been confirmed with CallGrid.

| Category | Likely owner | Operator-actionable? | Notes |
|---|---|---|---|
| **Caller ID** | Source / Vendor | Yes — traffic filtering | Caller-level eligibility rejection |
| **Paused** | Buyer / Destination | Yes — configuration | Deliberately inactive |
| **Closed** | Buyer / Destination | Yes — configuration | Outside operating hours or closed |
| **Capped** | Buyer / Destination | Yes — capacity | Volume or spend ceiling reached |
| **Rate Limited** | Buyer / Destination | Yes — capacity | Concurrency ceiling |
| **Duplicate** | Source / Vendor | Yes — traffic quality | Duplicate call |
| **Duplicate Ping** | Source / Vendor | Yes — traffic quality | **Distinct from Duplicate** — 66,092 vs 18 in the reference data, so they are certainly not the same measure |
| **Tag Rules** | Campaign / Platform | Yes — configuration | Targeting rules excluded the ping |
| **Acceptance** | Buyer | Partly | Buyer declined at acceptance |
| **No Route** | Platform / routing | Yes | Present in the call layer; upstream presence unconfirmed |
| **Unknown / Other** | — | — | Required: the taxonomy must absorb what it cannot classify rather than forcing a fit |

### Mutual exclusivity is UNKNOWN

Whether one ping can carry several rejection reasons is **not established**. This matters
arithmetically: if categories overlap, they must not be summed into a total, and a "dominant
rejection reason" is only meaningful if categories are exclusive.

In the reference data `Rejected` is 251,981 while the named sub-categories visible sum to far less,
which suggests either additional uncounted categories or non-exclusive counting. **Do not sum them
until this is resolved.**

---

## 4. Units — all UNVERIFIED

Nothing below may be stored until the source unit is proven, exactly as the call layer's money unit
was proven by anchoring to an absolute value.

| Quantity | Reference value | Question |
|---|---|---|
| Average Bid | `$11.09` | Dollars or minor units? |
| Average Winning Bid | `$26.33` | Same |
| Total Bid $ | `$585,382.56` | Same |
| Win % | `0.04%` | Arrives as `0.04`, `0.0004`, or `"0.04%"`? |
| Made % / Reject % | `8.16%` / `91.84%` | Same — and over which denominator? |
| Avg Bid Response | `521 ms` | Milliseconds, or seconds rendered as ms? |

**The call layer's lesson applies directly:** aggregate equality cannot prove a unit, because a
comparison applies the same conversion to both sides. Only an absolute value anchored to an
independent figure can.

---

## 5. Won 106 vs Calls 108 — hypotheses, not an answer

Both figures are real. Candidate explanations, none yet tested:

1. **Window boundary** — the call reconciliation ran a UTC day; the report is US/Eastern.
2. **Delayed win** — a bid won near midnight creating a call in the next window.
3. **Calls without a winning bid** — a path that creates a call outside the auction.
4. **Duplicate call creation** — one win producing two rows.
5. **Different report definitions** — the report's `Won` may count something narrower than "call created".

Hypothesis 1 is the most likely given the call layer already proved a 4-hour boundary offset — but
**this must be reconciled, not assumed.**

---

## 6. What would move this to VERIFIED

1. Run `/api/integrations/callgrid/discover-reports` on a preview → establishes the real endpoint,
   envelope, field inventory, and supported groupings.
2. Design the canonical schema from **that** inventory.
3. Prove the money, percentage and latency units by absolute-value anchoring.
4. Ingest one bounded day, idempotently.
5. Reconcile all five groupings against the report.
6. Reconcile the funnel against `MarketplaceCall` and resolve Won-vs-Calls.

Only then do intelligence rules become defensible. A recommendation such as *"your bid price is
uncompetitive"* built on an unverified denominator would be exactly the fabrication this audit
lineage exists to prevent — and it would be far more damaging than a missing feature, because an
operator would act on it.


---

## 7. Discovery findings (Sprint 39) — reference material read, access still blocked

CallGrid's published business documentation was read directly. It is **business reference material,
not an API contract**, and is treated as such.

| Source | Classification | What it gave us |
|---|---|---|
| `callgrid.com/glossary` | **Documented** | Only 4 relevant terms (Campaign, Buyer, Destination, RTB), written as marketing copy. **The entire failure vocabulary is absent** — no Ping, Made, Won, Rejected, Rate Limited, Duplicate Ping, Tag Rules or Capped. |
| `/knowledge-base/call-bidding-error-codes-explained` | **Documented — high value** | Ten error codes, each with a verbatim explanation **and CallGrid's own attribution of who fixes it**. This is the taxonomy's foundation. |
| `/knowledge-base/bid-api` | **Documented** | The Bid API is `POST/GET bid.callgrid.com/api/bid/{Grid-ID}` — a **different host** from `api.callgrid.com`. `dynamicBid` is documented as "Bid amount in USD". |
| Bid **reporting** endpoint | **UNKNOWN** | **Not documented anywhere.** The Bid API guide covers submitting bids only; no `/reports`, no `bidStats`, no aggregates, no grouping. |
| `api.callgrid.com` OpenAPI | **BLOCKED** | 401 — needs a credential. |

### The finding that shapes Module 2

**No bid-reporting API is documented in any public CallGrid source.** The Bid API is for *submitting*
bids into CallGrid; it is not an analytics interface.

That raises a real possibility the discovery endpoint exists to settle: **the bid report the owner
sees may be a first-party UI report with no public API at all.** If every candidate path 404s, the
next question is not "which endpoint" but "CSV export, browser network capture, or nothing" — and
Module 2's ingestion design differs completely between those.

### What the error-code documentation settled

1. **Duplicate caller ≠ duplicate request.** `4005` is *"already been processed and paid out"*;
   `4008` is *"a bid request was submitted more than once"*. That explains the report's Duplicate 18
   against Duplicate Ping 66,092 — they are different measures, now confirmed rather than inferred.
2. **Categories provably overlap.** CallGrid's own description of `4004` (Capacity Check Failed)
   includes *"tag rule failure"* — which is separately `4009`. So the same cause can surface under two
   codes. `taxonomyIsSummable()` returns **false** because of this, and a "dominant failure reason" is
   not yet a valid claim.
3. **Ownership is CallGrid's attribution, not our inference** — publisher/source for caller-id and
   tag-rule failures, buyer or campaign owner for capacity, platform for blocks and number pools.

### Still UNKNOWN

The reporting endpoint · report field names · report money units · percentage representation ·
latency unit · whether event-level bid records exist at all · whether `Made` and `Won` in the report
share the denominator the error codes imply.


---

## 8. CORRECTION + verified API contract (Sprint 39b)

### Correction: I was wrong that no bid-reporting API was documented

Section 7 concluded *"no bid-reporting API is documented in any public CallGrid source."* **That was
wrong.** The OpenAPI specification is **publicly readable, unauthenticated**, at:

```
https://api.callgrid.com/openapi     →  200, 249 KB, OpenAPI 3.0.0, 35 paths
```

I had probed `/api/documentation/json` and `/api/oapi.json` — both 401 — and never tried `/openapi`.

**Methodological lesson worth keeping:** unauthenticated probing cannot prove an endpoint does *not*
exist on this API. Auth fires before routing, so a nonsense path also returns 401. **Only the spec is
authoritative.** The discovery endpoint built in Sprint 38 inherits this flaw — its 401s would have
been uninformative.

### Verified report contract

| Endpoint | Method | Grouping | Envelope |
|---|---|---|---|
| `/api/reports/bidStats` | GET | **source only** | `data[]`, `totalPages`, `footerTotals` |
| `/api/reports/bidStats/rejections` | GET | **source only** | same |
| `/api/reports/pingStats` | GET | **destination only** | + `count` |
| `/api/reports/stats` | POST | **pivotable** (Campaign/Buyer/Source/Destination/InboundState) | + `aggregations` |

- **Auth:** the spec declares `apiKey` **in query string**, not Bearer. Our client sends Bearer and it
  works, so both are accepted — but the spec's scheme is the documented one.
- **Paging:** `page` (zero-based) + `limit`, with `totalPages`. Distinct from `/api/call`'s cursor model.
- **Filters:** `startDate`/`endDate` (ISO 8601, **inclusive both ends** — note `/api/call` uses
  half-open), `search`, `sortColumn`, `sortDirection`, `organizationId`.
- **`footerTotals`** is the report's own totals row — the ideal anchor for reconciliation, exactly the
  absolute-value anchoring that settled the call layer's money unit.

### FINDING: the five-way grouping requirement is NOT satisfiable

The business requirement asks for bid metrics grouped by Campaign, Buyer, Destination, Vendor and
Source. The API does not offer that:

- `bidStats` and `rejections` are **by source only** — no grouping parameter exists.
- `pingStats` is **by destination only**.
- Only `/reports/stats` pivots — and it is a **call** statistics endpoint, not a bid one.

**Campaign-, buyer- and vendor-level bid metrics cannot be retrieved.** Any Module 2 design promising
them would be promising something the provider does not expose.

### FINDING: the report UI and the API use DIFFERENT denominators

The spec documents its rates as formulas. Checked against the owner's report:

| Rate | Spec formula | Spec result | Report shows |
|---|---|---|---|
| `bidRate` | `bids / total × 100` | **57.34%** | Made % **8.16%** |
| `rejectRate` | `rejected / total × 100` | **52.66%** | Reject % **91.84%** |
| `winRate` | `won / bids × 100` | **0.04%** | Win % **0.04%** ✅ |

Only `winRate` agrees. The report's Made % is `made / bids` and its Reject % is `rejected / bids`,
while the API divides both by `total` (ping attempts).

**Consequence:** if Loop consumed `rejectRate` from the API and labelled it "Reject %", it would show
**52.66%** where the operator's own report shows **91.84%** — a 39-point discrepancy on identical
underlying data. This is precisely the denominator trap the rule contract withholds on.

Note also there is **no `made` field** in `bidStats`; the nearest is `rated`. Whether `rated` is the
report's `Made` is **unverified**.

### FINDING: the rejection vocabulary is richer than the error codes

`pingStats` exposes `minRevenue`, `missingAmount`, `invalidNumber`, `durationElapsed`, `pingTimeout`,
`apiFailed`, `suppressed` and `agents` — **none of which map to the 4001–5001 error codes.** A
taxonomy built only from the error-codes article would have silently dropped nine failure modes,
including the only two latency modes and the only pricing mode.

The taxonomy now carries **19 modes** across 9 categories, each citing either the KB article or the
OpenAPI contract.

### Recommended schema — now designable, still not written

Discovery has cleared for these four endpoints, so a schema can now be designed *against a contract*
rather than a guess. The shape the evidence supports:

- **Aggregate snapshots, not event-level rows.** All four endpoints return aggregates. There is no
  per-bid record, so a `MarketplaceBid` event table would be inventing granularity the source does
  not have.
- **Two snapshot entities**, because the grouping keys genuinely differ: one keyed by **source**
  (bidStats + rejections merge cleanly — same key, same window), one keyed by **destination**
  (pingStats).
- **Deterministic key:** `provider + organizationId + windowStart + windowEnd + groupingType +
  groupingExternalId`, since the API exposes no stable snapshot id.
- **Nullable everything.** Unknown is never zero — a metric the report omits must not persist as 0.
- **Store `footerTotals` alongside the rows**, so every ingest carries its own reconciliation anchor.

**Not written as a migration**, because two questions remain open and both change the schema: whether
`rated` is the report's `Made`, and whether the money fields are dollars or minor units. Both are
answerable in one authenticated call.

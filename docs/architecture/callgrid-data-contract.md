# CallGrid Data Contract

What CallGrid actually exposes to Loop, at what grain, with what limitations.

**Audience:** an engineer deciding whether a number can be built. If a field is
not here, it is not available — do not infer it from a field that is.

Written 2026-07-29. Update it when a provider endpoint is verified or withdrawn.

---

## The three verified report endpoints

All three were verified live on 2026-07-18. All three are `GET`, all three accept
`startDate` / `endDate` on the query string, and **none accepts a bucketing
timezone**. That last point is the source of most grain confusion in this system.

| Endpoint | Path | Grain | Stored as |
|---|---|---|---|
| Bid statistics | `/api/reports/bidStats` | one row per traffic **source** | `MarketplaceBidSourceSnapshot` |
| Bid rejections | `/api/reports/bidStats/rejections` | one row per traffic **source** | same row, merged |
| Ping statistics | `/api/reports/pingStats` | one row per **destination** | `MarketplacePingDestinationSnapshot` |

### What "snapshot" means here
Ingestion stores the **latest synchronized window only**. The endpoints take a
date range, but Loop keeps one window per provider, so:

- Bid metrics **cannot honour the calendar selection** on any CallGrid page.
- Bid metrics **cannot be compared over time**. There is no second snapshot.
- The provider's window is requested in **UTC**; call reporting is **Eastern**.
  The two grains coincide only by accident, and `bidSnapshotMatches` claims a
  match only when both are the same single calendar day.

Every surface that shows a bid number states this. Historical bid snapshots are a
separate ingestion project, not a display change.

---

## The endpoint that does NOT work

`POST /api/reports/stats` — aggregate call statistics.

**Status: UNVERIFIED. Returned HTTP 400 on the live discovery run; no 200 has
ever been observed.** It has no client, no snapshot model, and no place in the
funnel, and must not acquire one until a 200 is seen.

This is the single most consequential limitation in the system:

> **There is no machine-readable CallGrid aggregate for call revenue, profit,
> billable calls or total calls.**

Loop's call economics do not come from a CallGrid report at all. They come from
the `MarketplaceCall` projection, built from **ingested call records**. So
"do Loop's numbers match CallGrid's?" cannot be answered by an API call — it can
only be answered by a person reading the CallGrid interface. The reconciliation
harness is built around that fact rather than around a comparison it cannot make.

Unlike the three GET reports, this endpoint takes every input in a JSON body and
is the only one that accepts `reportTimeZone`. `pivot` is the likeliest missing
required field. See `CALL_STATS_CONTRACT` in
`packages/providers/src/adapters/callgrid-report-client.ts`.

---

## Call economics: the `MarketplaceCall` projection

The canonical economics source. Read through
`crmRepos.marketplaceCalls.aggregateWindow(organizationId, since, until)`, which
accepts **arbitrary instants** — this is why elapsed-matched comparison windows
are possible at all.

### Fields used

| Field | Meaning | Null behaviour | Zero behaviour |
|---|---|---|---|
| `sourceOccurredAt` | When the call happened | Never null (row selector) | n/a |
| `revenueCents` | Revenue attributed to the call | Not priced — excluded from sums AND from coverage | A proven $0 for that call |
| `payoutCents` | Vendor payout | Excluded from sums and coverage | A proven $0 |
| `costCents` | Call cost | Excluded from sums and coverage | A proven $0 |
| `monetized` | Provider marked the call billable | Not counted as billable | n/a |
| `converted` | Provider marked the call converted | Not counted | n/a |
| `buyerExternalId` / `buyerLabel` | Buyer identity | A call with no label forms no dimension row but still counts in window totals | n/a |
| `vendorExternalId` / `vendorLabel` | Vendor identity | as above | as above |
| `sourceExternalId` / `sourceLabel` | Source identity | as above | as above |
| `campaignExternalId` / `campaignLabel` | Campaign identity | as above | as above |

### Coverage — the thing that makes totals honest

`aggregateWindow` returns coverage counters at **both** grains:

- window: `callsWithRevenue`, `callsWithPayout`, `callsWithCost`
- per dimension row: the same three counters (added 2026-07-29)

Coverage is what separates *"they all reported $0"* from *"nobody told us"*.
A dimension row whose `callsWithRevenue` is 0 has **unknown** revenue; the report
service maps that to `null`, and it renders as "Unknown" and sorts last.

> Before this change, `bump()` did `cur.revenueCents += rev ?? 0` with no
> counter, so an unpriced buyer was indistinguishable from a buyer that earned
> $0 — and every ranking, share and contribution built on it was wrong.

### Identity
Dimension keys are `(externalId ?? label).toLowerCase()`. Display names are
**not** identity keys. CRM `Customer` records are never substituted for CallGrid
buyers — the `Customer` table holds caller IDs, which is a different thing.

---

## Bid source fields (`MarketplaceBidSourceSnapshot`)

`total`, `bids`, `rated`, `won`, `rejected`, `totalBidAmountCents`,
`totalWonAmountCents`, `avgBidCents`, `avgWinningBidCents`, `winRatePercent`,
`bidRatePercent`, `rejectRatePercent`, `rejectedDetail`, `callerIdRejected`,
`closed`, `paused`, `duplicateCaller`, `duplicateBids`, `failedAcceptance`,
`failedTagRules`.

**Null means the report returned no row for that source. That is not zero** and
is never summed as zero (see `sumReported`).

Win rate is `won / bids` — wins over bids **submitted**. Dividing by `total`
(opportunities presented) conflates "never bid on" with "bid and lost" and
understates the rate.

## Bid destination fields (`MarketplacePingDestinationSnapshot`)

`accepted`, `agents`, `failedAcceptance`, `failedTagRules`, `minRevenue`,
`missingAmount`, `invalidNumber`, `durationElapsed`, `pingTimeout`, `apiFailed`,
`rateLimited`, `suppressed`.

`invalidNumber` and `missingAmount` were stored but not read by the surface until
2026-07-29; both are now exposed.

`accepted` is **not** a total-pings denominator. CallGrid does not report pings
attempted per destination, so no acceptance rate exists.

---

## Grain rules (non-negotiable)

1. **Source grain ≠ destination grain.** A source opportunity and a destination
   ping are different events. Never add them, never divide one by the other.
2. **Call grain ≠ bid grain.** Total calls is not a bid denominator; a won bid is
   not a billable call.
3. `duplicateBids` and `duplicateCaller` are distinct provider conditions and are
   never summed.
4. Shares are computed **within one grain**, against a denominator drawn from the
   same read.

---

## What CallGrid does not expose

These are declared in `CALLGRID_UNAVAILABLE_METRICS` so surfaces can explain an
absence instead of leaving a blank:

- **Buyer capacity, caps, schedules, availability.** A buyer's volume drop can
  never be attributed to a cap being reached.
- **Per-opportunity value.** Bid reports carry no revenue, so "recoverable
  revenue" cannot be computed from a rejection. Ever.
- **Vendor cost** as a separate figure — cost is per call.
- **Route fallback behaviour.** Whether an alternate destination was tried after
  a rejection is unknown, so the consequence of a rejection is unknown.
- **Historical bid snapshots.** One window is stored.
- **An entity roster.** There is no endpoint listing configured buyers, vendors,
  sources or campaigns. "Total buyers" can only ever mean *buyers observed this
  period* — a configured but idle buyer is invisible, and is not counted.
- **Volatility / sustained direction.** These need a rolling series of windows;
  the product reads the selected window and one comparison window.
- **Suppression semantics.** The provider does not document what `suppressed`
  means, so it is classified `UNKNOWN` rather than guessed at.

---

## Single-tenant ingestion (unchanged, still open)

`/api/webhooks/callgrid` and `/api/integrations/callgrid/sync` still resolve the
organization from `LIVE_ORG_SLUG = 'servicesinmycity-demo'`. This sprint did not
touch ingestion and did not make it worse. It remains the gate on customer #2.

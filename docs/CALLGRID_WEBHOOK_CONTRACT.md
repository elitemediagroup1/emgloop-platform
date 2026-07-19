# CALLGRID_WEBHOOK_CONTRACT.md — the confirmed webhook payload

**Status:** CONFIRMED against the live CallGrid webhook template (2026-07-19).
**Supersedes** the illustrative payload in `docs/integrations/CALLGRID.md`, which documented a
different, aspirational shape that production does not send.

## The template CallGrid posts

Every value is a **quoted string** — CallGrid substitutes `[[tag:X]]` into a JSON string literal.
So booleans arrive as `"true"`/`"false"`, money as `"25.50"`, and the epoch as `"1752854400"`.

| Payload key | CallGrid tag | Loop reads it? |
|---|---|---|
| `id` | `CallId` | ✅ 1st-choice alias |
| `callStatus` | `CallStatus` | ✅ 1st |
| `endedBy` | `CallEndedBy` | ✅ 1st |
| `occurredAtUnix` | `UTCUnixTime` | ✅ 1st |
| `callerId` | `CallerId` | ✅ 1st |
| `vendorId` / `vendorName` | `VendorId` / `VendorName` | ✅ 1st |
| `sourceId` / `sourceName` | `SourceId` / `SourceName` | ✅ 1st |
| `campaignId` / `campaignName` | `CampaignId` / `CampaignName` | ✅ 1st |
| `buyerId` / `buyerName` | `BuyerId` / `BuyerName` | ✅ 1st |
| `destinationId` / `destinationName` | `DestinationId` / `DestinationName` | ✅ 1st |
| `inboundState` / `inboundZip` | `InboundState` / `InboundZipCode` | ✅ 1st |
| `durationSeconds` | `CallDuration` | ✅ 1st |
| `billable` `paid` `converted` `completed` `noRoute` | `CallBillable` … `CallNoRoute` | ✅ 1st |
| `revenue` `payout` `cost` | `CallRevenue` `CallPayout` `CallCost` | ✅ 1st |
| `profit` | `CallProfit` | ✅ **now consumed** (was discarded until Sprint 33) |

**26 of 27 keys matched the adapter's first-choice alias.** The webhook field mapping is confirmed
correct — it is no longer an inference.

## What this resolves

- **Field names (webhook path):** confirmed. The 138-undocumented-aliases finding applies to the
  *fallback* aliases, which are now known to be unused for this sender.
- **Timezone (webhook path):** resolved. The tag is `UTCUnixTime` — an unambiguous UTC epoch. There is
  no local-string parsing on this path and no calendar-day risk.
- **Booleans:** resolved. All arrive as strings and `boolFrom` handles `true/True/1/yes` and
  `false/False/0/no`. A missing value stays `undefined`, never `false`.

## What this does NOT resolve

- **The money unit (blocker B2).** `CallRevenue` could be dollars or minor units; the template does not
  say. `centsOrNull` multiplies by 100 on that assumption. **Still the top blocker.**
  The new `profit` invariant in the reconciliation harness checks that
  `profit == revenue − payout − cost`, which catches a mismatch *between* the economic fields but
  cannot settle the absolute unit.
- **The duration unit.** The tag is `CallDuration`, not `CallDurationSeconds`. Loop maps it to a field
  named `durationSeconds`. Unconfirmed.
- **The API/polling path**, which uses different field names and a local-string timestamp.

## Fields absent from the template

`duplicate`, `blocked`, `connected`, `connectFailed`, `noConnect`, recording URL, transcript. Loop's
duplicate-detection and connectivity coverage rows therefore have no source on this path — consistent
with the audit's finding that both are inferred.


---

## Correction (Sprint 34) — production does NOT differ from the repository

Sprint 33 reported that production served a GET handler existing in no branch. **That finding was
wrong, and the error was mine.** The handler is at `apps/web/src/app/api/webhooks/callgrid/route.ts:142`,
declared `export function GET` — without `async`. My grep searched for `export async function GET`
and missed it.

Verified since:

- Production's GET response matches the repo handler's output **field for field**.
- Production build artifact `1528-e25dde69a584c6ad.js` is **byte-identical** to a local build
  (SHA-256 `4e7f41cf8f019b174d5bcc48e650abbc`, 124,341 bytes).
- Shared chunks `1dd3208c`, `6340`, `polyfills` and CSS `e4388e3fb5c8dd76` all match.
- `main-app` and `webpack` entry hashes differ, which is expected: this working tree carries five
  sprints of changes not yet on the deployed branch.

**Deployment conclusion: production is running code consistent with this repository.**

# CallGrid API Reconciliation / Backfill (Sprint 17)

Webhooks are the real-time ingress for CallGrid calls. The CallGrid REST API is
the source-of-truth reconciliation layer that keeps EMG Loop in sync with
CallGrid reporting: it backfills calls the webhook never delivered and enriches
calls that arrived without full attribution.

## Components

- `packages/providers/src/adapters/callgrid-api.ts` - REST client (GET /api/call,
  cursor pagination, date range). Maps PascalCase CallGrid fields (VendorName,
  SourceName, CampaignName, BuyerName, DestinationName, CallerId, Duration,
  Revenue, Payout, InboundState/Zip, Billable, Paid) onto the canonical metadata
  keys the webhook path and the NormalizationEngine already read.
- `CallGridProvider.poll()` - uses the client when an API key is present.
- `packages/database/src/services/callgrid-reconciliation.service.ts` -
  fetch -> dedup -> import missing -> enrich existing (metadata merge only).
- `POST /api/integrations/callgrid/sync` - admin-only (integrations:manage),
  range = today | 24h | 7d.
- Integration OS - "Sync recent CallGrid calls" control + last-API-sync
  diagnostics (fetched / imported / enriched / skipped / failed).

## Guarantees

- No fabricated data, no demo calls, no deletions.
- Idempotent: import dedups on provider + externalId; enrichment never
  overwrites a real existing value.
- Webhook ingestion and Bearer/HMAC webhook auth are untouched.
- The API key value is never logged or returned (boolean presence only).

## Webhook attachment is per campaign (confirmed root cause)

CallGrid does not fire a webhook globally just because one has been created in
the account. Each webhook must be individually attached to every campaign that
should stream events. A webhook that exists in CallGrid but is not attached to
a given campaign will never send events for calls in that campaign, and Loop
has no way to detect this from the webhook side alone - the campaign simply
stays silent.

This was confirmed by attaching the canonical "EMG Loop - Production" webhook
to the "Home Ins - Internal" campaign: real calls immediately began arriving in
Loop with correct caller, vendor, source, campaign, duration, status, and a
unique event id. No code change was required to produce this result - only the
campaign-level attachment in CallGrid.

**Practical implication:** the REST reconciliation layer described above is
still the source-of-truth backfill for any campaign that is missing its
webhook attachment, but it should be treated as a safety net, not a substitute
for attaching the webhook correctly. A campaign left without the webhook
attached will keep needing REST backfill indefinitely instead of receiving
real-time events.

## Required manual production step

1. Set `CALLGRID_API_KEY` in Netlify environment variables.
2. (Optional) Set `CALLGRID_API_BASE_URL` if the CallGrid API host/path differs
   from the documented default.
3. In CallGrid, create one canonical webhook (e.g. "EMG Loop - Production")
   pointed at `POST /api/webhooks/callgrid` with the confirmed JSON body
   template and Bearer/HMAC auth.
4. Attach that webhook to every active campaign individually. Creating or
   configuring the webhook once at the account level is not sufficient -
   CallGrid requires the attachment to be made on each campaign.
5. For each campaign, generate or wait for one completed call and verify it
   appears in Loop (`/crm/live/calls`) with real attribution before treating
   that campaign as done.
6. Any campaign without the webhook attached will not stream real-time events
   to Loop; it will only appear via the REST reconciliation sync below, and
   only up to whatever poll frequency/range is configured.
7. Open Integration OS -> CallGrid -> "Sync recent CallGrid calls" and run a
   sync for the desired range to backfill anything missed before attachment.

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

## Required manual production step

1. Set `CALLGRID_API_KEY` in Netlify environment variables.
2. (Optional) Set `CALLGRID_API_BASE_URL` if the CallGrid API host/path differs
   from the documented default.
3. Open Integration OS -> CallGrid -> "Sync recent CallGrid calls" and run a
   sync for the desired range.

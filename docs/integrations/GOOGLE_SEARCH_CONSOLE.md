# Google Search Console — Integration Planning

Sprint 10. Planning only. No implementation.

GSC provides organic search performance data: impressions, clicks, CTR, average position by query, page, and date. Loop ingests this data to correlate organic search performance with leads and bookings.

---

## Authentication Model

- Type: OAuth2 (Service Account with domain-wide delegation OR user OAuth)
- Scopes: https://www.googleapis.com/auth/webmasters.readonly
- Storage: credentialsRef on ProviderConnection

---

## Webhook Model

GSC does not support webhooks. Polling only.

---

## Polling Model

Search Analytics API:
- Endpoint: POST https://searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
- Dimensions: date, query, page, country, device
- Metrics: clicks, impressions, ctr, position
- Frequency: Daily (data has 2-3 day lag)
- Rate limit: 1,200 req/min per project
- Date range: max 16 months historical

---

## Rate Limits

- 1,200 requests/minute per project
- 25,000 rows per response
- Pagination: startRow parameter

---

## Normalized Event Mapping

| GSC Event             | Loop Event Type          | Creates Signal          |
|-----------------------|--------------------------|-------------------------|
| click (non-brand)     | search.click             | INTENT (if landing page is lead gen) |
| impression spike      | search.impression        | none (aggregate)        |
| position change       | search.position_change   | none (aggregate)        |

---

## Loop Entities Created

1. IntegrationEvent - daily batch rows per query
2. Signal - INTENT when query matches service keywords + click occurs
3. DomainEvent - none directly (signals feed analytics layer)

---

## Workflow Trigger Opportunities

| Trigger                     | Recommended Workflow                          |
|-----------------------------|-----------------------------------------------|
| Ranking drop on key query   | Alert manager                                 |
| Surge in branded searches   | Notify team (high intent week)               |

---

## Notes

- No customer linkage possible (GSC data is aggregate)
- query/page/country stored in Signal.metadata
- Not in scope Sprint 10: OAuth flow, site verification, historical backfill

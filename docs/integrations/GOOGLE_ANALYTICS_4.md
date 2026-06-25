# Google Analytics 4 — Integration Planning

Sprint 10. Planning only. No implementation.

GA4 provides web session data, conversion events, user properties, and
audience intelligence. Loop ingests GA4 data to correlate web activity
with downstream CRM actions (bookings, calls, form submissions).

---

## Authentication Model

- **Type:** OAuth2 (user grants access to GA4 property) OR Service Account (preferred for automation)
- **Scopes:** analytics.readonly
- **Per-tenant:** Yes — one service account or OAuth token per organization
- **Storage:** credentialsRef on ProviderConnection (never raw token/key)
- **Future:** OAuth2 consent flow for organization admin in Sprint 11+

---

## Webhook Model

GA4 does not support webhooks natively.
Use the Data API (polling) and/or BigQuery export for event data.

For near-real-time: GA4 Measurement Protocol (send events TO GA4, not from it).
For analytics reads: Data API polling (see below).

---

## Polling Model

**GA4 Data API (REST):**
- Endpoint: POST https://analyticsdata.googleapis.com/v1beta/properties/{propertyId}:runReport
- Dimensions: date, sessionSource, sessionMedium, sessionCampaign, eventName
- Metrics: sessions, totalUsers, conversions, eventCount
- Daily polling: fetch yesterday's data each morning
- Rate limit: 10 concurrent requests per property; 200,000 requests/day

**Data granularity:** Daily (not real-time via API). BigQuery export enables row-level events.

---

## Rate Limits

- Data API: 200,000 requests/day, 10 concurrent
- Quota errors: retry with exponential backoff
- BigQuery export: no limit (batch, not API)

---

## Normalized Event Mapping

| GA4 Event           | Loop Event Type          | Creates Signal          |
|---------------------|--------------------------|-------------------------|
| session_start       | web.session_start        | none                    |
| page_view           | web.page_view            | none                    |
| purchase            | payment.succeeded        | LIFETIME_VALUE          |
| generate_lead       | web.goal_conversion      | INTENT                  |
| form_submit         | web.form_submit          | INTENT                  |
| contact             | web.goal_conversion      | INTENT                  |

---

## Loop Entities Created

1. IntegrationEvent — daily batch or per-event row
2. Signal — INTENT for conversions/lead generation
3. DomainEvent — triggers workflows on web.goal_conversion events

No Interaction rows (GA4 events are not customer touchpoints — they are aggregate signals).

---

## Workflow Trigger Opportunities

| Trigger                  | Recommended Workflow                        |
|--------------------------|---------------------------------------------|
| web.goal_conversion      | INTENT signal -> assign to agent            |
| Surge in sessions        | Notify manager + adjust capacity            |
| Conversion rate drop     | Alert + pipeline review                     |

---

## Notes

- Customer linkage: by clientId (GA4) -> email/phone match (not always possible)
- Session source/medium stored in Signal.metadata for attribution
- Not in scope Sprint 10: OAuth consent flow, BigQuery connector, Measurement Protocol sender

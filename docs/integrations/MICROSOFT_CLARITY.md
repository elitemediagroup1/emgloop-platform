# Microsoft Clarity — Integration Planning

Sprint 10. Planning only. No implementation.

Microsoft Clarity is a session intelligence tool providing heatmaps, session recordings, rage clicks, dead clicks, and user behavior analytics. Loop ingests Clarity data to detect frustration signals that may indicate service quality issues.

---

## Authentication Model

- Type: Clarity REST API uses API key (Bearer token)
- Scopes: Read project data
- Storage: credentialsRef on ProviderConnection

---

## Webhook Model

Clarity does not support outbound webhooks. Polling only via Clarity Data Export API.

---

## Polling Model

Clarity Data Export API:
- Endpoint: GET https://www.clarity.ms/export/api/v1/{projectId}/dashboard
- Returns: daily/weekly aggregates (rage click rate, dead click rate, scroll depth)
- Frequency: Daily batch
- Rate limit: Not officially documented; treat as 60 req/min

---

## Rate Limits

- 60 req/min (estimated)
- Data availability: 24-48 hour lag

---

## Normalized Event Mapping

| Clarity Metric        | Loop Signal Type   | Trigger Condition                  |
|-----------------------|--------------------|------------------------------------|
| Rage click rate >10%  | CHURN_RISK         | High frustration on key pages      |
| Dead click rate >15%  | CHURN_RISK         | UI confusion indicator             |
| Low scroll depth      | CHURN_RISK         | Users not engaging with content    |

---

## Loop Entities Created

1. IntegrationEvent - daily batch aggregate
2. Signal - CHURN_RISK when frustration thresholds exceeded
3. DomainEvent - for workflow triggering on churn signals

---

## Workflow Trigger Opportunities

| Trigger            | Recommended Workflow                        |
|--------------------|---------------------------------------------|
| Rage click surge   | Alert UX team + log CHURN_RISK signal       |
| Low engagement     | Trigger follow-up content/outreach          |

---

## Notes

- No individual user linkage (Clarity is aggregate by default)
- Page URL stored in Signal.metadata for page-level intelligence
- Not in scope Sprint 10: API client, threshold configuration UI

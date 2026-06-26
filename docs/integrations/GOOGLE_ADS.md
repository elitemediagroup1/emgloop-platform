# Google Ads — Integration Planning

Sprint 10. Planning only. No implementation.

Google Ads provides advertising performance data (impressions, clicks,
conversions) and lead form submissions. Loop ingests this data to attribute
leads to ad campaigns and measure cost-per-lead.

---

## Authentication Model

- **Type:** OAuth2 (Google Ads API requires user consent) OR Service Account via impersonation
- **Scopes:** https://www.googleapis.com/auth/adwords
- **Developer Token:** Required — org-level Google Ads developer token
- **Storage:** credentialsRef on ProviderConnection
- **Future:** OAuth2 consent flow for organization admin in Sprint 11+

---

## Webhook Model

Google Ads does not support webhooks. All data is via polling (REST API).

Lead Form Assets: Google Ads can deliver lead form submissions via webhook to
a registered endpoint (configured in the Google Ads UI). This is the closest
thing to webhook delivery from Google Ads.

Lead form webhook payload:
```json
{
  "lead_id": "AJWt4...",
  "api_version": "2.0",
  "form_id": "12345",
  "campaign_id": "678900",
  "google_key": "...",
  "user_column_data": [
    { "column_name": "FULL_NAME", "string_value": "Jane Smith" },
    { "column_name": "EMAIL", "string_value": "jane@example.com" },
    { "column_name": "PHONE_NUMBER", "string_value": "+12125551234" }
  ],
  "adgroup_id": "...",
  "creative_id": "...",
  "is_test": false
}
```

---

## Polling Model

Google Ads API (REST):
- Customer reports: performance by campaign, ad group, keyword
- Frequency: Daily batch polling
- Authentication: OAuth2 token + developer token in headers
- Rate limit: 10,000 operations/day per manager account

---

## Rate Limits

- Standard access: 10,000 operations/day
- Basic access: 15,000 operations/day
- Lead form webhooks: no limit (inbound)
- Quota type: operation-based (varies by API call complexity)

---

## Normalized Event Mapping

| Google Ads Event       | Loop Event Type          | Creates Signal       |
|------------------------|--------------------------|----------------------|
| Lead form submit       | ads.lead_form_submit     | INTENT               |
| Ad click               | ads.click                | none                 |
| Ad impression          | ads.impression           | none                 |
| Conversion             | ads.conversion           | INTENT               |

---

## Loop Entities Created

1. IntegrationEvent — per lead form submission or daily batch
2. Signal — INTENT for lead_form_submit and conversion events
3. Interaction — SOCIAL/INBOUND for lead_form_submit (customer identity from form data)
4. DomainEvent — triggers workflows on ads.lead_form_submit

---

## Workflow Trigger Opportunities

| Trigger                  | Recommended Workflow                        |
|--------------------------|---------------------------------------------|
| ads.lead_form_submit     | INTENT signal -> immediate agent assignment  |
| ads.conversion           | Mark pipeline as WON                        |
| High cost-per-lead week  | Alert manager (Signal-based)                |

---

## Notes

- lead_id is the idempotency key (externalId)
- User data from lead form: store email/phone for Customer resolution
- Campaign ID/ad group ID stored in Signal.metadata for attribution
- Not in scope Sprint 10: OAuth consent flow, developer token setup, campaign reporting

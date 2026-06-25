# Postmark — Integration Planning

Sprint 10. Planning only. No implementation.

Postmark is a transactional email delivery service. Loop uses Postmark for
outbound transactional emails and ingests delivery/engagement events.

---

## Authentication Model

- Type: Server API Token in X-Postmark-Server-Token header
- Webhook: Postmark delivers event webhooks (no signature verification natively)
- Storage: credentialsRef on ProviderConnection

---

## Webhook Model

Postmark supports webhook delivery for email events (configured per server).
Key events: Delivery, Bounce, SpamComplaint, Open, Click, SubscriptionChange.

Payload example:
{
  "RecordType": "Delivery",
  "MessageID": "abc-123",
  "Recipient": "jane@example.com",
  "DeliveredAt": "2026-06-25T14:00:00Z"
}

Idempotency: MessageID.

---

## Polling Model

Postmark Messages API:
GET /messages/outbound?count=500&offset=0&tag=booking-confirm
Rate limit: Not explicitly documented; treat as 100 req/min.

---

## Rate Limits

- Standard: 100 req/min (API)
- Email send: 500/min on Starter, unlimited on larger plans

---

## Normalized Event Mapping

| Postmark Event  | Loop Event Type    | Creates Signal    | Creates Interaction |
|-----------------|--------------------|-------------------|---------------------|
| Delivery        | email.delivered    | none              | Yes (EMAIL/OUTBOUND) |
| Open            | email.opened       | SATISFACTION      | Yes (EMAIL/INBOUND)  |
| Click           | email.clicked      | INTENT            | Yes (EMAIL/INBOUND)  |
| Bounce          | email.bounced      | CHURN_RISK        | No                   |
| SpamComplaint   | email.unsubscribed | CHURN_RISK        | No                   |

---

## Loop Entities Created

1. IntegrationEvent — per webhook event
2. Interaction — for delivery/open/click
3. Signal — CHURN_RISK (bounce/complaint), INTENT (click), SATISFACTION (open)
4. DomainEvent — triggers follow-up workflows

Customer resolution: by Recipient email address.

---

## Workflow Trigger Opportunities

| Trigger         | Recommended Workflow                    |
|-----------------|-----------------------------------------|
| email.bounced   | CHURN_RISK + update contact email      |
| email.clicked   | INTENT signal + pipeline advance       |
| email.opened    | Tag as engaged                         |

---

## Notes

- MessageID is idempotency key
- No signature verification required (add IP allowlisting for production)
- Not in scope Sprint 10: webhook endpoint, email send actions, templates

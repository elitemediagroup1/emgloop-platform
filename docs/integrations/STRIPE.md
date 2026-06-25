# Stripe — Integration Planning

Sprint 10. Planning only. No implementation. Stripe handles payments and subscriptions.

---

## Authentication Model

- Type: API Key (secret key for server-side, publishable key for client)
- Webhook signing: Stripe-Signature header with HMAC-SHA256
- Storage: credentialsRef on ProviderConnection (never raw secret key)

---

## Webhook Model

Stripe delivers signed webhooks to a registered endpoint.
Endpoint: POST /api/webhooks/stripe (future)

Verification: HMAC-SHA256 using stripe-signature header + webhook secret.
Retry: Stripe retries up to 3 days on non-2xx. Idempotency by event.id.

Key events:
- payment_intent.succeeded
- payment_intent.payment_failed
- customer.subscription.created
- customer.subscription.deleted
- invoice.paid
- checkout.session.completed

---

## Polling Model

Stripe REST API for historical reconciliation:
GET /v1/charges, /v1/payment_intents, /v1/subscriptions
Rate limit: 100 read requests/second in live mode.

---

## Rate Limits

- 100 read req/sec (live mode)
- 25 write req/sec
- Test mode: 25 req/sec

---

## Normalized Event Mapping

| Stripe Event                        | Loop Event Type        | Creates Signal           |
|-------------------------------------|------------------------|--------------------------|
| payment_intent.succeeded            | payment.succeeded      | LIFETIME_VALUE           |
| payment_intent.payment_failed       | payment.failed         | CHURN_RISK               |
| customer.subscription.created      | subscription.created   | UPSELL_OPPORTUNITY       |
| customer.subscription.deleted      | subscription.canceled  | CHURN_RISK               |
| checkout.session.completed          | payment.succeeded      | LIFETIME_VALUE           |

---

## Loop Entities Created

1. IntegrationEvent — per webhook
2. Interaction — INBOUND/OTHER for payment events
3. Signal — LIFETIME_VALUE accumulation; CHURN_RISK on failure/cancellation
4. DomainEvent — triggers payment-related workflows

Customer resolution: Stripe customer.email -> Customer.email match.
Stripe customer.id stored in Customer.metadata.stripeCustomerId.

---

## Workflow Trigger Opportunities

| Trigger              | Recommended Workflow                    |
|----------------------|-----------------------------------------|
| payment.failed       | CHURN_RISK -> agent follow-up           |
| subscription.canceled| CHURN_RISK -> win-back sequence         |
| payment.succeeded    | Send thank-you + upsell prompt          |

---

## Notes

- Stripe event.id is idempotency key
- Amount always in smallest currency unit (cents) - store as cents in metadata
- PCI compliance: never store raw card data; use Stripe's tokenization
- Not in scope Sprint 10: webhook endpoint, API client, billing portal

# Telnyx — Integration Planning

Sprint 10. Planning only. No implementation.

Telnyx is an alternative to Twilio for SMS and voice. Architecture mirrors Twilio nearly identically with minor differences.

---

## Authentication Model

- Type: API Key in Authorization header (Bearer)
- Webhook verification: X-Telnyx-Signature header (HMAC-SHA256)
- Storage: credentialsRef on ProviderConnection

---

## Webhook Model

Telnyx delivers webhooks for calls and messages.
Key events: message.received, message.sent, message.delivery.succeeded, message.delivery.failed, call.initiated, call.answered, call.hangup.

Verification: HMAC-SHA256 of request timestamp + body using public key (Ed25519 for newer events).

---

## Polling Model

REST API: GET /v2/messages, GET /v2/calls
Rate limit: 600 req/min for most endpoints.

---

## Rate Limits

- 600 req/min standard
- SMS: 1 msg/sec/DID

---

## Normalized Event Mapping

Identical to Twilio (see TWILIO.md). Replace provider name 'twilio' with 'telnyx'.

| Telnyx Event           | Loop Event Type   | Creates Signal |
|------------------------|-------------------|----------------|
| message.received       | sms.inbound       | INTENT         |
| call.hangup (inbound)  | call.completed    | RESPONSE_TIME  |
| call.initiated (miss)  | call.missed       | CHURN_RISK     |

---

## Loop Entities Created

Same as Twilio. Interaction, Signal, DomainEvent per relevant event.
Customer resolution: by phone number (E.164 normalization).

---

## Workflow Trigger Opportunities

Same as Twilio. See TWILIO.md for full list.

---

## Notes

- Telnyx and Twilio are interchangeable at the provider-abstraction level
- Both implement the same SmsProvider/VoiceProvider interfaces
- event.id / message_id is idempotency key
- Not in scope Sprint 10: number provisioning, TeXML, outbound actions

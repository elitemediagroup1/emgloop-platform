# Twilio — Integration Planning

Sprint 10. Planning only. No implementation.

Twilio provides SMS, voice calling, and programmable messaging.
Loop uses Twilio as a voice/SMS provider for outbound communication and to receive inbound messages.

---

## Authentication Model

- Type: Account SID + Auth Token (Basic HTTP auth) OR API Key + Secret
- Webhook auth: Signature validation via X-Twilio-Signature (HMAC-SHA1)
- Storage: credentialsRef on ProviderConnection

---

## Webhook Model

Twilio delivers status callbacks and inbound message/call webhooks.

Key webhook events:
- SMS inbound (POST to /api/webhooks/twilio/sms)
- Call inbound (POST to /api/webhooks/twilio/voice)
- SMS delivery status (delivered/failed)
- Call completed (with duration)

Verification: X-Twilio-Signature HMAC-SHA1 of URL + sorted POST params using Auth Token.

---

## Polling Model

Twilio REST API for historical message/call logs.
GET /2010-04-01/Accounts/{SID}/Messages.json
GET /2010-04-01/Accounts/{SID}/Calls.json
Rate limit: 100 req/sec per subaccount.

---

## Rate Limits

- API: 100 req/sec
- SMS: 1 msg/sec/long-code, 100 msg/sec/short-code
- Voice: 1 call/sec by default (can request higher)

---

## Normalized Event Mapping

| Twilio Event      | Loop Event Type  | Creates Signal   | Creates Interaction |
|-------------------|------------------|------------------|---------------------|
| IncomingMessage   | sms.inbound      | INTENT (keyword) | Yes (SMS/INBOUND)   |
| OutboundMessage   | sms.outbound     | none             | Yes (SMS/OUTBOUND)  |
| IncomingCall      | call.inbound     | INTENT           | Yes (PHONE/INBOUND) |
| CompletedCall     | call.completed   | RESPONSE_TIME    | Yes (PHONE)         |
| MissedCall        | call.missed      | CHURN_RISK       | Yes (PHONE/INBOUND) |

---

## Loop Entities Created

1. IntegrationEvent — per webhook
2. Interaction — per inbound/outbound call or message
3. Signal — where applicable
4. DomainEvent — triggers workflows

Customer resolution: by From/To phone number (normalize to E.164).

---

## Workflow Trigger Opportunities

| Trigger         | Recommended Workflow                    |
|-----------------|-----------------------------------------|
| sms.inbound     | Auto-reply + INTENT signal + assign     |
| call.missed     | SMS callback notification               |
| call.completed  | Log + update pipeline                   |

---

## Notes

- MessageSid / CallSid are idempotency keys
- Never store Auth Token raw — use credentialsRef
- International: store phone numbers in E.164 format
- Not in scope Sprint 10: number provisioning, TwiML, send actions

# CallGrid — Integration Planning

Sprint 10. Planning only. No implementation. No real API calls.

CallGrid is a call tracking platform. It provides inbound/outbound call data,
call recordings, transcripts, and attribution — mapping phone calls back to
marketing sources.

---

## Authentication Model

- **Type:** API Key (Bearer token in Authorization header)
- **Per-tenant:** Yes — each organization has its own API key
- **Storage:** credentialsRef on ProviderConnection (never raw key in DB)
- **Rotation:** Supported by swapping credentialsRef
- **Future:** OAuth2 machine-to-machine when/if CallGrid supports it

---

## Webhook Model

CallGrid delivers real-time call events via HTTP POST to a registered endpoint.

**Endpoint:** POST /api/webhooks/callgrid (future, not built in Sprint 10)

**Verification:** HMAC-SHA256 signature in X-CallGrid-Signature header,
compared against the raw request body using the webhook secret (from credentialsRef).

**Payload structure:**
```json
{
  "event": "call.completed",
  "call_id": "cg_abc123",
  "from": "+12125551234",
  "to": "+18885559999",
  "direction": "inbound",
  "duration_seconds": 142,
  "started_at": "2026-06-25T14:32:00Z",
  "ended_at": "2026-06-25T14:34:22Z",
  "recording_url": "https://cdn.callgrid.io/rec/...",
  "transcript": null,
  "utm_source": "google",
  "utm_campaign": "summer-campaign"
}
```

**Retry policy:** CallGrid retries on non-2xx responses with exponential backoff
(max 5 retries over 24 hours). Idempotency enforced by call_id.

---

## Polling Model

CallGrid provides a REST API for historical call data:
GET /v1/calls?from=ISO8601&to=ISO8601&page=N&per_page=100

Use for: initial historical backfill, recovery from missed webhooks.
Rate limit: 100 req/min per API key.
Pagination: cursor-based (next_cursor field in response).

---

## Rate Limits

- Webhook delivery: unlimited (outbound from CallGrid)
- REST API: 100 req/min per API key
- Recording downloads: 50/min
- No burst limit documented

---

## Normalized Event Mapping

| CallGrid Event    | Loop Event Type       | Creates Interaction | Creates Signal         |
|-------------------|-----------------------|---------------------|------------------------|
| call.inbound      | call.inbound          | Yes (PHONE/INBOUND) | INTENT                 |
| call.outbound     | call.outbound         | Yes (PHONE/OUTBOUND)| none                   |
| call.missed       | call.missed           | Yes (PHONE/INBOUND) | CHURN_RISK             |
| call.completed    | call.completed        | Yes (PHONE)         | RESPONSE_TIME          |
| call.voicemail    | call.voicemail        | Yes (PHONE/INBOUND) | none                   |
| call.transferred  | call.transferred      | Yes (PHONE)         | none                   |

---

## Loop Entities Created

Every normalized CallGrid event produces:
1. **IntegrationEvent** — raw payload stored (status: RECEIVED -> PROCESSED)
2. **Interaction** — Interaction row (channel: PHONE, direction from event)
3. **Signal** — Signal row where applicable (see mapping above)
4. **DomainEvent** — triggers any EVENT workflows listening on integration.call.*

Customer resolution: by customerPhone field (from CallGrid "from" number for
inbound, "to" for outbound). Creates no new Customer if not found.

---

## Workflow Trigger Opportunities

| Trigger Event            | Recommended Workflow                      |
|--------------------------|-------------------------------------------|
| call.missed              | Auto-reply SMS + tag "missed-call"        |
| call.inbound (new lead)  | INTENT signal -> assign to agent          |
| call.completed           | Log interaction + update pipeline status  |
| call.voicemail           | Notify agent + schedule callback task     |

---

## Implementation Notes

- call_id is the idempotency key (externalId on Interaction)
- utm_source/utm_campaign should be stored in Interaction.metadata for attribution
- Recording URLs: store reference only, do not download/store audio
- Transcripts (when available): store in Interaction.summary
- Customer phone matching: normalize E.164 before lookup

**Not in scope for Sprint 10:** webhook endpoint, API client, recording fetcher.

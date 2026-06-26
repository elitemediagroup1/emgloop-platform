# Anthropic — Integration Planning

Sprint 10. Planning only. No implementation.

Anthropic provides AI reasoning capabilities (Claude API). In the Loop platform,
Anthropic powers the AI reasoning layer that will eventually interpret signals,
generate natural-language insights, and drive AI Employee conversations.

---

## Authentication Model

- Type: API Key in x-api-key header
- Model selection: via model parameter in request body
- Storage: credentialsRef on ProviderConnection (never raw key)
- No OAuth. No per-user token. Org-level key only.

---

## Webhook Model

Anthropic does not deliver webhooks. All requests are outbound (Loop -> Anthropic).
Server-sent events (SSE) for streaming responses — not a webhook model.

---

## Polling Model

Not applicable. Anthropic is synchronous request/response (REST) or streaming (SSE).

---

## Rate Limits

- Claude 3.5 Sonnet: 400K tokens/min on standard tier
- Claude 3 Opus: 50K tokens/min on standard tier
- Context window: up to 200K tokens
- Requests/min: varies by tier (50-4000)

---

## Loop Integration Pattern

Anthropic is not an ingestion source — it is an AI reasoning provider.
In the Loop architecture it operates as an AiProvider, not an IngestionProvider.

Future uses:
1. Signal interpretation: analyze call transcripts -> sentiment/topic signals
2. Natural language query: "Why did bookings drop last week?" -> Layer 2 intelligence
3. AI Employee conversations: Claude powers conversation responses
4. Workflow generation: suggest workflows from KPI gaps

---

## Normalized Output -> Loop Entities

| Anthropic Use Case          | Loop Entity Created              |
|-----------------------------|----------------------------------|
| Sentiment analysis          | Signal (SENTIMENT, confidence)   |
| Intent classification       | Signal (INTENT or TOPIC)         |
| Response generation         | Message (in Conversation thread) |
| Insight generation          | DiagnosticInsight (Intelligence) |

---

## Notes

- No direct customer data should be sent to Anthropic without tenant consent
- PII handling: anonymize or minimize before AI calls
- Response caching: consider for repeated signal interpretation calls
- Not in scope Sprint 10: API client, prompt templates, AI Employee conversation engine

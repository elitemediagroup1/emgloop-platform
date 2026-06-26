# OpenAI — Integration Planning

Sprint 10. Planning only. No implementation.

OpenAI provides GPT models for AI reasoning, function calling, embeddings,
and the Assistants API. In Loop, OpenAI is an alternative to Anthropic as the
AI reasoning layer — interchangeable via the AiProvider interface.

---

## Authentication Model

- Type: API Key in Authorization: Bearer header
- Organization ID: optional, for org-scoped usage tracking
- Storage: credentialsRef on ProviderConnection
- No OAuth. Org-level key only.

---

## Webhook Model

OpenAI does not deliver webhooks for standard API usage.
Server-sent events (SSE) for streaming completions — not a webhook model.

Exception: OpenAI Assistants API can use tool_call callbacks within a run —
this is synchronous function calling, not external webhook delivery.

---

## Polling Model

Not applicable for real-time use. OpenAI is synchronous request/response.
Run status polling required for Assistants API (long-running runs).

---

## Rate Limits

- GPT-4o: 10,000 RPM / 30M TPM on Tier 4+
- GPT-4 Turbo: 5,000 RPM / 800K TPM on Tier 3
- Embeddings (text-embedding-3-small): 3,000 RPM / 1M TPM

---

## Loop Integration Pattern

Identical to Anthropic at the abstraction level. Both implement AiProvider.
OpenAI specific capabilities:

1. Embeddings: semantic similarity for customer deduplication and topic clustering
2. Function calling: structured output for signal extraction from transcripts
3. Assistants API: stateful AI Employee conversation management
4. Vision: analyze screenshots or images in customer interactions

---

## Normalized Output -> Loop Entities

| OpenAI Use Case             | Loop Entity Created              |
|-----------------------------|----------------------------------|
| Sentiment classification    | Signal (SENTIMENT)               |
| Topic extraction            | Signal (TOPIC)                   |
| Response generation         | Message (in Conversation thread) |
| Embedding-based dedup       | Customer (merge candidate)       |

---

## Notes

- OpenAI and Anthropic are interchangeable via the AiProvider abstraction
- PII: minimize customer data sent to external AI APIs
- Model selection stored in AIEmployee.providerPrefs.aiProvider config
- Not in scope Sprint 10: API client, Assistants API, embedding pipeline

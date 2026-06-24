# Provider Philosophy

> **No provider is ever tightly coupled. Everything supports future replacement.**

The Loop owns the intelligence, not the infrastructure. Every external capability
is reached through a narrow, stable interface, so any vendor can be swapped,
added, or run side-by-side without touching business logic.

## Hard Rules

1. **No vendor SDK types cross a module boundary.** Business logic depends on
   our interfaces only; adapters translate to/from vendor SDKs internally.
2. **No vendor name in core logic.** Modules and AI Employees ask for a
   capability ("send SMS", "synthesize speech"), never for a specific vendor.
3. **Per-tenant credentials, stored by reference.** Connections live in
   \`ProviderConnection\`; secrets are referenced in a secrets manager, never
   stored raw.
4. **Normalized webhooks.** Inbound provider events land in \`IntegrationEvent\`
   as an idempotent, normalized envelope before any module sees them.
5. **Swappable, even at runtime.** A tenant can change providers within a
   category without data migration of business records.
6. **Multiple providers per category.** The registry resolves an adapter by
   \`(category, id)\`, so several can coexist (e.g. failover or per-tenant choice).

## Categories and Candidate Providers

These are **candidates**, not commitments. None are integrated in the foundation.

| Category | Candidate providers |
|----------|--------------------|
| **AI / LLM** | Anthropic, OpenAI, Google |
| **Voice (TTS)** | ElevenLabs |
| **Transcription (STT)** | Deepgram, Google |
| **Telephony / SMS** | Twilio, Telnyx |
| **Payments** | Stripe, Square |
| **Calendar** | Google Calendar, Microsoft |
| **Email — mailbox sync** | Google (Gmail), Microsoft 365 |
| **Email — transactional** | SendGrid, Mailgun, Amazon SES |

> **Refinement (see ARCHITECTURE_REVIEW.md):** the Sprint 1 provider package has
> six categories (ai, voice, sms, email, payment, calendar). Recommend adding a
> distinct **transcription** category (Deepgram/Google STT) so speech-to-text is
> not conflated with voice synthesis, since AI Phone Agents need both.

## Interfaces

Each category is defined by a narrow interface in \`packages/providers\`:
\`AIProvider\`, \`VoiceProvider\`, \`SmsProvider\`, \`EmailProvider\`,
\`PaymentProvider\`, \`CalendarProvider\` (plus a proposed \`TranscriptionProvider\`).
A central registry registers and resolves adapters; no concrete vendor adapters
ship in the foundation.

## Why This Matters

- **No lock-in** — pricing, reliability, or capability changes never trap us.
- **Resilience** — failover and multi-provider strategies are possible.
- **Tenant choice** — different organizations can use different providers.
- **Clean evolution** — adding a provider is adding an adapter, nothing more.

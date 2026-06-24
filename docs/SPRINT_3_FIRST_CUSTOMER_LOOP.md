# Sprint 3 — First Customer Loop

Sprint 3 brings EMG Loop to life with **one complete, end-to-end customer
journey** running entirely on **mock providers**. It proves the platform can
orchestrate a real customer journey — lead to confirmed booking — without any
third-party vendor dependency.

> No real AI. No real SMS. No real voice. No real email. No real calendar. No
> real payments. Every external capability is exercised through a provider
> interface backed by an in-memory mock.

## Demo scenario

**ServicesInMyCity -> HVAC quote request -> EMG Loop.**

1. Customer submits an HVAC quote request (internal demo intake form).
2. A `Customer` record is created.
3. An `Interaction` (`kind = quote_request`) is created — the timeline spine.
4. `Signal` (`lead.received`) and `Event` (`customer.created`) records are written.
5. An **AI Employee** is assigned (assignment interaction + `interaction.assigned` event).
6. The **mock AI** decides the next action through the AI provider interface.
7. A **mock SMS** follow-up is sent through the SMS provider interface.
8. A **mock customer reply** is received (inbound interaction + message + signal).
9. The mock AI re-evaluates and chooses to book.
10. A `Booking` is created, then **confirmed** via the mock calendar provider.
11. The customer **timeline** displays the full journey.
12. The **dashboard** reflects the completed loop with live metrics.

## What was built

### Canonical mock adapters — `packages/providers/src/mocks/`

In-memory implementations of every provider interface, registered into the
shared provider registry via `registerMockProviders()`:

- `mock-ai.provider.ts` — `MockAIProvider` (deterministic intent heuristic).
- `mock-sms.provider.ts` — `MockSmsProvider` (in-memory outbox).
- `mock-voice.provider.ts` — `MockVoiceProvider` (placeholder, no synthesis).
- `mock-email.provider.ts` — `MockEmailProvider` (placeholder, in-memory outbox).
- `mock-calendar.provider.ts` — `MockCalendarProvider` (in-memory events).

These satisfy the SAME interfaces the real adapters will implement, so the
registry-resolved swap is a one-line change with zero consumer impact.

### Web demo module — `apps/web/src/demo/`

Self-contained so the Next.js production build needs no cross-package
transpilation (it mirrors `@emgloop/providers` exactly):

- `providers.ts` — provider contracts + mock adapter instances + demo context.
- `store.ts` — in-memory records (`Customer`, `Interaction`, `Signal`,
  `DomainEvent`, `Message`, `Booking`, `AIEmployeeRef`) with field names
  mirroring the Prisma schema. `Interaction` is the canonical timeline spine.
- `loop-engine.ts` — `runQuoteToBooking()` orchestrates the whole journey
  through the provider abstractions, appending interactions/signals/events at
  each step.
- `seed.ts` — seeds sample requests and derives dashboard metrics.
- `actions.ts` — `submitQuoteRequest` server action.

### Pages — `apps/web/src/app/`

- `demo/page.tsx` — demo hub explaining the loop.
- `demo/intake/page.tsx` — internal HVAC intake form (name, phone, email,
  service type, city/state, preferred window, notes).
- `demo/timeline/page.tsx` — per-customer interaction timeline.
- `dashboard/page.tsx` — live demo metrics + recent activity.
- `page.tsx` — home page links to the demo.

## What is mocked

| Capability | Interface | Mock behavior |
| ---------- | --------- | ------------- |
| AI | `AIProvider` | Deterministic keyword heuristic decides next action |
| SMS | `SmsProvider` | Records outbound messages in memory; returns `delivered` |
| Voice | `VoiceProvider` | Placeholder; returns empty audio / `durationMs: 0` |
| Email | `EmailProvider` | Placeholder; records messages in memory |
| Calendar | `CalendarProvider` | Creates a confirmed in-memory event |
| Customer reply | (engine) | Synthesized inbound SMS to advance the loop |
| Persistence | (store) | Process-local in-memory store; nothing is saved |

## What is real platform architecture

- **Data model.** Records follow the real schema shapes (`Interaction.kind`,
  tenant `organizationId`, signals vs. events separation, booking ->
  `calendarProvider`/`calendarEventId`).
- **Provider abstraction.** The loop engine never references a vendor SDK; it
  only calls provider interface methods.
- **Interaction as the timeline spine.** Every step appends an `Interaction`;
  inbox, analytics, and AI memory can attach to the same spine later.
- **AI Employee as a first-class actor.** Outbound actions are attributed to
  the assigned AI Employee.
- **Signals vs. events.** Inbound facts are `Signal`s; state transitions are
  domain `Event`s — kept separate, as the platform model requires.

## How the loop works

```
Intake form (server action: submitQuoteRequest)
  -> runQuoteToBooking(input)
       addCustomer            -> Customer + Signal(lead.received) + Event(customer.created)
       addInteraction         -> quote_request (timeline spine)
       ensureAIEmployee       -> assignment interaction + Event(interaction.assigned)
       ai.decide()            -> next action via AIProvider
       sms.sendSms()          -> outbound_message interaction + Message
       (simulated reply)      -> inbound_message interaction + Message + Signal
       ai.decide()            -> book via AIProvider
       addBooking             -> booking_created interaction + Event(booking.created)
       calendar.createEvent() -> booking_confirmed interaction + Event(booking.confirmed)
  -> redirect to /demo/timeline?customer=<id>
```

The dashboard calls `ensureSeeded()` then `getMetrics()` to show Total
requests, Active interactions, Booked appointments, Conversion rate, and
Recent timeline activity.

## What will be replaced by real providers later

- `MockAIProvider` -> Anthropic (Claude) adapter behind `AIProvider`.
- `MockSmsProvider` -> Twilio / Telnyx adapter behind `SmsProvider`.
- `MockVoiceProvider` -> ElevenLabs adapter behind `VoiceProvider`.
- `MockEmailProvider` -> SendGrid / Mailgun adapter behind `EmailProvider`.
- `MockCalendarProvider` -> Google Calendar adapter behind `CalendarProvider`.
- In-memory store -> `@emgloop/database` (Prisma) with the same record shapes.
- Simulated inbound reply -> real provider webhooks (`parseInbound`).
- Internal intake form -> real ServicesInMyCity ingestion.

## Known limitations

- The store is process-local and resets on serverless cold starts; pages seed
  on render so the demo is always populated, but data does not persist.
- The AI "decision" is a keyword heuristic, not a model; it is intentionally
  deterministic for a repeatable demo.
- The customer reply is synthesized by the engine, not received from a webhook.
- No authentication, authorization enforcement, or real credentials are wired.
- The web demo carries its own copies of the provider contracts to keep the
  Next.js build self-contained; `@emgloop/providers` remains the canonical home.

## Guardrails honored

- No real authentication added.
- No real provider credentials added.
- No real Twilio / Telnyx / Claude / ElevenLabs integrations.
- No ServicesInMyCity production ingestion.
- UI kept intentionally minimal — one working, demoable loop.

## Next recommended sprint

**Sprint 4 — First Real Provider + Persistence.** Replace one mock (suggested:
SMS via Telnyx/Twilio) with a real adapter behind the existing interface, wire
`@emgloop/database` so records persist, and accept a real inbound webhook via
`parseInbound` — proving the swap path end-to-end on exactly one capability
while everything else stays mocked.

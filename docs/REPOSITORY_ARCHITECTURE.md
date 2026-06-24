# Repository Architecture

Sprint 4 introduces the platform's **real data layer**. The Sprint 3 in-memory
demo store is gone; every read and write in the First Customer Loop now goes to
PostgreSQL through a thin **repository layer** that lives in
`packages/database/src/repositories`.

This document describes that layer: its responsibilities, the classes, how the
loop and UI consume it, and the rules that keep it aligned with the platform
constitution.

## Why a repository layer

The platform separates three concerns deliberately:

- **Providers** (`packages/providers`) handle the *outside world* — AI, SMS,
  voice, email, payments, calendars — behind vendor-agnostic interfaces.
- **Repositories** (`packages/database`) handle the *database* — all Prisma
  access is centralized here.
- **The loop engine** (`apps/web/src/demo/loop-engine.ts`) *orchestrates*
  between them and never touches Prisma or a vendor SDK directly.

Keeping persistence behind repositories means queries are centralized, testable,
and swappable; the loop reads as business logic, not data plumbing; and the
multi-tenant rule (every row carries `organizationId`) is enforced in one place.

## The classes

All repositories take a `PrismaClient` in their constructor and expose
intention-revealing methods. They accept plain input DTOs (see
`repositories/types.ts`) and return Prisma row types.

| Repository | File | Responsibility |
| --- | --- | --- |
| `CustomerRepository` | `customer.repository.ts` | Create/find customers; maps a display name to `firstName`/`lastName`; idempotent `upsertByExternalId`. |
| `InteractionRepository` | `interaction.repository.ts` | The customer-timeline spine: append interactions, read a timeline, recent-activity feeds, counts by kind. |
| `BookingRepository` | `booking.repository.ts` | Booking lifecycle (REQUESTED -> CONFIRMED) and the calendar provider abstraction (`calendarProvider`/`calendarEventId`). |
| `SignalRepository` | `signal.repository.ts` | Append-only soft intelligence; maps coarse labels to the `SignalType` enum. |
| `DomainEventRepository` | `domain-event.repository.ts` | Internal append-only fact log (`customer.created`, `booking.confirmed`, ...). |
| `ConversationRepository` / `MessageRepository` | `messaging.repository.ts` | Conversation + message persistence (messages belong to a conversation). |
| `AIEmployeeRepository` | `ai-employee.repository.ts` | Provisions and resolves the default AI Employee ("Ava"). |

A `createRepositories(prisma)` factory (in `repositories/index.ts`) bundles all of
them into a `Repositories` object. `@emgloop/database` exports a `repositories`
bundle bound to the shared Prisma singleton for app code, while tests can build a
bundle from a dedicated client.

```ts
import { repositories } from '@emgloop/database';
// or, with a custom client:
import { createRepositories } from '@emgloop/database';
const repos = createRepositories(myPrisma);
```

## Domain events vs integration events

The schema already had `IntegrationEvent` for **external** provider webhooks.
Sprint 4 adds a distinct `DomainEvent` model for the platform's **internal**,
append-only fact log. Domain events are immutable and are the seed of the future
event bus (see `EVENT_BUS.md`). Keeping the two separate avoids conflating "a
thing happened in our system" with "a provider told us something".

## Mapping the loop vocabulary to the schema

The loop describes timeline steps with stable, lightweight labels
(`quote_request`, `outbound_message`, channels like `web_chat`). The canonical
schema uses richer enums (`InteractionKind`, `ChannelType`, `InteractionDirection`,
`BookingStatus`, `SignalType`). The web app's
`apps/web/src/demo/repository-store.ts` owns this translation:

- `loopKindToEnum` / `channelToEnum` / `directionFor` map loop labels to enums.
- The original loop label and any extra detail (body text, actor type, statuses)
  are preserved in the interaction's JSON `payload`, so nothing is lost and the
  timeline renders exactly as before.
- View-model mappers (`toCustomerView`, `toTimelineEntry`) decouple the UI from
  raw Prisma row shapes.

## How the loop uses it

`runQuoteToBooking` (in `loop-engine.ts`) now `await`s repository calls at each
step: create customer -> record signal + domain event -> append the quote-request
interaction -> assign the AI Employee -> open a conversation -> send the mock SMS
and persist the interaction + message -> persist the inbound reply -> create then
confirm the booking, persisting an interaction + domain event at every stage.

Crucially, **the provider calls are unchanged**: AI/SMS/calendar still go through
`demoProviders.*` (mock adapters). Only persistence changed.

## Data flow

```
Intake form (Server Action)
        |
        v
  loop-engine.runQuoteToBooking()
        |  (orchestration)
        +--> demoProviders.*  (mock AI / SMS / calendar — unchanged)
        |
        +--> repository layer (Prisma / PostgreSQL)
                 Customer / Interaction / Signal / DomainEvent
                 Conversation / Message / Booking
        |
        v
  Dashboard + Timeline pages read back via the repositories
```

## Seeding

Two seed paths exist, both writing real rows via the repositories:

- `packages/database/prisma/seed.ts` — the canonical `prisma db seed`
  (`npm run seed` in `@emgloop/database`). Seeds the demo organization, the
  default AI Employee, demo customers, and a quote-request interaction each.
  Idempotent via `upsertByExternalId` and `ensureDefault`.
- `apps/web/src/demo/seed.ts` — runs the *full loop* for a few sample requests
  the first time the demo org has no customers, so the dashboard/timeline have
  realistic data on first load.

## Rules (do not break)

- App code depends on **repositories**, never on `PrismaClient` directly.
- Every tenant-scoped write carries `organizationId`.
- Providers stay abstracted and mocked — no real provider APIs in this sprint.
- Industry-specific shape lives in JSON `attributes`/`metadata`/`payload`, not in
  new industry tables.

## Explicitly out of scope for Sprint 4

- Real provider integrations (AI, SMS, voice, email, payments, calendar).
- Authentication / authorization.
- ServicesInMyCity production traffic ingestion.

# Sprint 4 — Real Data Layer

Sprint 4 replaces the Sprint 3 in-memory demo store with the platform's **real
persistence layer** on PostgreSQL + Prisma, while preserving the architecture
exactly. The same First Customer Loop now persists real data: customers,
interactions, signals, domain events, conversations, messages, and bookings are
written to and read from the database through a repository layer.

> Providers are still fully mocked. No real AI, SMS, voice, email, calendar, or
> payments. No authentication. No ServicesInMyCity production traffic. Only the
> data layer changed.

## Objective

Make the existing customer loop persist real data while preserving the
architecture — the provider abstraction, the mock providers, the HVAC intake
demo, and the dashboard/timeline UI are all kept as-is.

## What was built

### Repository layer — `packages/database/src/repositories/`

Prisma-backed repository classes, one import surface via
`createRepositories(prisma)`:

- `CustomerRepository`, `InteractionRepository`, `BookingRepository`,
  `SignalRepository`, `DomainEventRepository`.
- Supporting `ConversationRepository`, `MessageRepository`, and
  `AIEmployeeRepository` (messages belong to a conversation; the loop assigns a
  default AI Employee).

See `REPOSITORY_ARCHITECTURE.md` for the full design.

### Schema — `packages/database/prisma/schema.prisma`

Added a `DomainEvent` model: the platform's internal, append-only fact log
(`customer.created`, `booking.confirmed`, ...), distinct from the existing
`IntegrationEvent` (external provider webhooks).

### Seed scripts

- `packages/database/prisma/seed.ts` — canonical `prisma db seed`: demo
  organization, default AI Employee, demo customers, and a quote-request
  interaction each. Idempotent.
- `apps/web/src/demo/seed.ts` — runs the full loop for sample requests on first
  load so the dashboard/timeline have realistic data.

### Web app

- `apps/web/src/demo/store.ts` — in-memory arrays and `add*`/`getStore`/
  `resetStore` helpers **removed**; now a thin database read facade.
- `apps/web/src/demo/repository-store.ts` — new facade that resolves the demo
  org + AI Employee and maps the loop vocabulary to the schema enums.
- `apps/web/src/demo/loop-engine.ts` — every step now persists via repositories;
  provider calls unchanged.
- Dashboard and timeline pages read back from the database.

## Preserved (unchanged behavior)

- Provider abstraction (`packages/providers`) — exactly as-is.
- Mock providers (`apps/web/src/demo/providers.ts` and
  `packages/providers/src/mocks`).
- The HVAC intake demo and the dashboard + timeline UI.

## Out of scope (deferred)

- Real provider APIs (AI, SMS, voice, email, payments, calendar).
- Authentication / authorization.
- ServicesInMyCity production traffic integration.

## Running it

```bash
# from packages/database
npm run generate        # prisma generate
npm run migrate         # create/apply the migration (adds domain_events, etc.)
npm run seed            # seed the demo org, AI Employee, customers, interactions
```

Then start the web app and open the dashboard/intake/timeline; the loop reads and
writes real rows in PostgreSQL.

# Event Bus — Event-Driven Architecture

The Loop is **event-driven**. Every meaningful platform action emits an event.
Events are the backbone for workflows, automation, analytics, integrations, and
audit. Modules and AI Employees coordinate by publishing and subscribing to
events rather than calling each other directly.

## Principle

> **Every action generates an event.**

If something happened in the platform, there is an event describing it. This
gives us one consistent, replayable record of everything that occurs in a tenant.

## Canonical Events (initial)

| Event | Emitted when |
|-------|--------------|
| \`customer.created\` | a new customer record is created |
| \`customer.updated\` | a customer record changes |
| \`interaction.started\` | any interaction begins (any channel) |
| \`interaction.completed\` | an interaction ends |
| \`message.sent\` | an outbound message is sent |
| \`message.received\` | an inbound message arrives |
| \`call.started\` | a phone call begins |
| \`call.completed\` | a phone call ends (with summary/transcript ref) |
| \`booking.requested\` | a booking is requested |
| \`booking.confirmed\` | a booking is confirmed |
| \`booking.completed\` | a booking is fulfilled |
| \`order.placed\` | an order is placed |
| \`order.fulfilled\` | an order is fulfilled |
| \`invoice.paid\` | a payment/invoice is completed |
| \`review.left\` | a customer leaves a review |
| \`signal.created\` | an AI/behavioral signal is produced |
| \`escalation.triggered\` | an AI Employee escalates to a human |

The catalog is extensible; new events are added as the platform grows. Naming
convention: \`entity.verb\` (past tense).

## Event Envelope

Every event shares a common, tenant-scoped envelope:

| Field | Meaning |
|-------|---------|
| \`id\` | unique event id |
| \`organizationId\` | tenant boundary |
| \`type\` | canonical event name (\`entity.verb\`) |
| \`occurredAt\` | when the action happened |
| \`actorType\` | customer / human / AI employee / system |
| \`actorId\` | who/what caused it |
| \`subjectType\` + \`subjectId\` | the entity the event is about |
| \`payload\` | event-specific data (JSON) |
| \`metadata\` | system/integration data (JSON) |

## Workflows on Top of Events

Workflows (the Sprint 1 \`Workflow\` / \`WorkflowRun\` models) subscribe to events:

\\\`\\\`\\\`
event (booking.confirmed)
   -> matching workflows triggered
   -> WorkflowRun created
   -> steps execute (send SMS, schedule reminder, notify staff, ...)
   -> step actions emit their own events
\\\`\\\`\\\`

Triggers can be event, schedule, webhook, signal, or manual (already modeled on
\`Workflow.trigger\`). This makes automation a first-class, composable layer.

## Relationship to IntegrationEvent

The Sprint 1 \`IntegrationEvent\` model captures **inbound provider** events
(webhooks/syncs) as a normalized, idempotent envelope. The platform event bus is
the **internal** event stream. Recommended direction (see
\`ARCHITECTURE_REVIEW.md\`): introduce a dedicated internal \`Event\` (or
\`DomainEvent\`) table/stream so internal events are first-class and queryable,
with provider webhooks flowing in through \`IntegrationEvent\` and then being
translated into internal events where appropriate.

## Delivery Semantics

- **Append-only & ordered** per organization where ordering matters.
- **At-least-once** delivery to subscribers; handlers must be **idempotent**
  (keyed on event id).
- **Replayable** for backfills, new subscribers, and analytics.
- **Tenant-isolated** — subscribers only ever see their organization's events.

## Why This Matters

- **Automation** — workflows react to anything that happens.
- **Decoupling** — modules and AI Employees never depend on each other's internals.
- **Analytics** — the analytics module is just an event subscriber.
- **Audit** — events plus \`AuditLog\` give a complete, replayable history.
- **Extensibility** — new modules subscribe to existing events with zero changes
  to emitters.

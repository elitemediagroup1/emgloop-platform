# EMG Loop — Architecture

## Overview

EMG Loop is a multi-tenant, AI-first platform built as a TypeScript monorepo.
A Next.js web app provides the operator surface, an API service handles
orchestration and provider calls, and a set of shared packages hold the database
schema, shared types, and provider abstractions.

## Monorepo Layout

\\\`\\\`\\\`
apps/
  web/        Next.js app (operator UI: login, dashboard, health/status)
  api/        API service (route handlers, workflow + provider orchestration)
packages/
  database/   Prisma schema + client (PostgreSQL), migrations
  shared/     Shared types, enums, constants, helpers
  providers/  Provider-agnostic interfaces + registry (AI/voice/SMS/email/pay/cal)
docs/         Constitution, architecture, data model, roadmap
\\\`\\\`\\\`

Tooling: npm workspaces + Turborepo for task orchestration, a shared
\`tsconfig.base.json\`, and Prettier for formatting.

## Layered Design

1. **Presentation (apps/web).** Operator-facing UI. In Sprint 1 this is only an
   app shell: a login placeholder, a dashboard placeholder, and a health/status
   page. No customer-facing features.

2. **Application / API (apps/api).** Stateless handlers that enforce tenant
   scope, run workflows, and call providers through the abstraction layer.

3. **Domain & Data (packages/database).** The Prisma schema is the canonical
   domain model. All persistence flows through the shared Prisma client.

4. **Provider Abstraction (packages/providers).** Narrow interfaces for AI,
   voice, SMS, email, payment, and calendar providers, plus a registry that
   resolves adapters by category and id. No concrete vendor adapters in Sprint 1.

## Multi-Tenancy

Tenancy is row-level. \`Organization\` is the tenant root; every tenant-scoped
model carries \`organizationId\` with a cascading relation. \`Location\` models
physical/branch scope beneath an organization. The data-access layer is
responsible for always constraining queries by \`organizationId\`. \`Role\` +
\`User\` provide per-tenant RBAC via a permissions array.

## Provider Abstraction

Business logic depends on interfaces (\`AIProvider\`, \`VoiceProvider\`,
\`SmsProvider\`, \`EmailProvider\`, \`PaymentProvider\`, \`CalendarProvider\`), never on
vendor SDKs. Per-tenant credentials live in \`ProviderConnection\` (with secrets
stored by reference, not raw). Inbound provider webhooks land in
\`IntegrationEvent\` as a normalized, idempotent envelope before processing.

This is how the platform satisfies "own the intelligence, not the
infrastructure": Claude, ElevenLabs, Twilio, Telnyx, Stripe, Google Calendar,
and SendGrid/Mailgun all become swappable adapters added in later sprints.

## Intelligence Model

\`Conversation\` + \`Message\` capture omni-channel dialogue (with AI or human
actors). \`Interaction\` records channel-agnostic timeline touchpoints.
\`Signal\` is an append-only stream of behavioral/AI intelligence (intent,
sentiment, churn risk, upsell, LTV, no-show risk, ...) attached to customers and
conversations. \`AIAgent\` + \`VoiceProfile\` define the autonomous agents.

## Automation

\`Workflow\` stores declarative trigger config + a step graph; \`WorkflowRun\`
records each execution with input/output and status. Triggers can be events,
schedules, webhooks, signals, or manual.

## Data Sources

External sources (ServicesInMyCity first) are ingested into the generic core.
Source attribution is carried on \`Organization.sourceKey\`,
\`Customer.externalId\`, and \`ServiceRequest.source\`, so additional sources and
future EMG websites attach without schema forks.

## Environments & Config

Configuration is environment-variable driven (see \`.env.example\`). Provider keys
are placeholders in Sprint 1 — nothing is wired to a live vendor.

## Out of Scope for Sprint 1

Real provider integrations, customer-facing features, and production auth are
explicitly deferred. See \`docs/ROADMAP.md\`.


---

## Sprint 1.5 — Architecture Hardening (additions)

The hardening sprint introduced a set of companion documents that extend (and do
not contradict) the architecture above. Start with
\`LOOP_MASTER_BLUEPRINT.md\` — the master vision document every developer reads first.

### Modular architecture
Capabilities ship as **installable modules** that are **organization-enabled, not
hardcoded** (CRM, AI Receptionist, AI Phone Agent, AI Ordering, Scheduling,
Estimates, Payments, Reviews, Reputation, Marketing, Analytics, Knowledge Base,
Messaging). Modules coordinate through the event bus, never via direct internal
calls. See \`MODULE_ARCHITECTURE.md\`.

### Universal interaction model
Every customer interaction on every channel fits one envelope, with kind- and
vertical-specific detail in JSON \`attributes\`. This is the spine of the unified
timeline and inbox. See \`INTERACTION_MODEL.md\`.

### AI Employee system
\`AIAgent\` + \`VoiceProfile\` generalize into **AI Employees** with role, voice,
knowledge, permissions, channels, workflows, memory, and escalation rules
(HVAC Dispatcher, Pizza Order Taker, Salon Receptionist, Medical Scheduler, Real
Estate Assistant). See \`AI_EMPLOYEE_SYSTEM.md\`.

### Organization knowledge base
Per-organization KB (PDFs, SOPs, menus, price lists, FAQs, policies, service
areas) grounds AI Employees before they respond, behind a provider-agnostic
embedding + retrieval interface. See \`KNOWLEDGE_BASE.md\`.

### Event-driven architecture
Every platform action emits an event; workflows and automation are built on the
event bus. Internal events are distinct from inbound provider events
(\`IntegrationEvent\`). See \`EVENT_BUS.md\`.

### Email architecture
Core email sync is **server-side Gmail / Microsoft 365 OAuth**, working on
desktop and mobile equally — **not** built around a Chrome extension. See
\`EMAIL_ARCHITECTURE.md\`.

### Universal inbox
A future unified inbox merges email, SMS, calls, website chat, Facebook,
Instagram, WhatsApp, and future channels over the universal interaction model.
See \`UNIVERSAL_INBOX.md\`.

### Strengthened provider philosophy
No provider is ever tightly coupled; everything is replaceable (Anthropic,
OpenAI, Google, ElevenLabs, Deepgram, Twilio, Telnyx, Stripe, Square, Google
Calendar, Microsoft, SendGrid, Mailgun, Amazon SES). A transcription category is
recommended in addition to the existing six. See \`PROVIDER_PHILOSOPHY.md\`.

### Review & recommendations
\`ARCHITECTURE_REVIEW.md\` records the structural refinements (R1–R9) recommended
before Sprint 2. No schema/code changes were made in this documentation sprint.

# EMG Loop Platform

**EMG Loop** is an AI-first operating system for customer-facing businesses.

It is **not a CRM**. It is the intelligence layer and operating system that sits on
top of customer-facing businesses — handling appointment booking, lead management,
AI phone and SMS agents, AI order taking, customer timelines, workflows, analytics,
and future behavioral intelligence.

The platform is **industry-agnostic from day one**. ServicesInMyCity is the first
data source — not the whole product. The same architecture is designed to power home
services, nail salons, barbershops, doctors' offices, restaurants, pizzerias, law
firms, and other appointment- and order-based businesses.

## Core Principles

1. AI-first, not CRM-first.
2. Industry-agnostic from day one.
3. Multi-tenant SaaS architecture.
4. Provider-agnostic integrations.
5. Own the intelligence, not the infrastructure.
6. ServicesInMyCity is the first data source, not the whole product.
7. Support booking, leads, AI voice/SMS agents, order taking, timelines, workflows,
   analytics, and future behavioral intelligence.

## Monorepo Structure

\`\`\`
apps/
  web/        # Next.js web app (app shell: login, dashboard, health/status)
  api/        # API service (route handlers, provider orchestration)
packages/
  database/   # Prisma schema, client, migrations (PostgreSQL)
  shared/     # Shared types, enums, utilities, constants
  providers/  # Provider-agnostic interfaces (AI, voice, SMS, email, payment, calendar)
docs/         # Platform constitution, architecture, data model, roadmap
\`\`\`

## Tech Direction

- Next.js + TypeScript
- PostgreSQL + Prisma ORM
- Monorepo (npm workspaces + Turborepo)
- Provider abstraction for AI, voice, SMS, email, payments, calendars
- No HubSpot dependency. No direct Twilio dependency.
- Prepared for Claude, ElevenLabs, Twilio, Telnyx, Stripe, Google Calendar,
  SendGrid/Mailgun, and future providers — **none integrated yet**.

## Documentation

- [`docs/PLATFORM_CONSTITUTION.md`](docs/PLATFORM_CONSTITUTION.md) — non-negotiable principles
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system architecture
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — database schema reference
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phased roadmap

## Status

**Sprint 1 — Platform Foundation.** Foundational architecture, repo structure,
documentation, and database schema. No real provider integrations and no
customer-facing features yet.
# emgloop-platform

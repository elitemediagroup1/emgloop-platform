# EMG Loop — Roadmap

A phased plan. Phase 1 powers ServicesInMyCity as the first real data source, on
top of an architecture designed to support many future verticals.

## Sprint 1 — Platform Foundation (current)

- Monorepo structure (\`apps/web\`, \`apps/api\`, \`packages/database\`,
  \`packages/shared\`, \`packages/providers\`, \`docs/\`).
- TypeScript + shared tooling (npm workspaces, Turborepo, base tsconfig,
  Prettier).
- Prisma + PostgreSQL setup and the initial multi-tenant schema (19 models).
- Provider abstraction interfaces (AI, voice, SMS, email, payment, calendar) +
  registry, with NO concrete vendor adapters.
- Platform docs: constitution, architecture, data model, roadmap.
- App shell at app.emgloop.com: login placeholder, dashboard placeholder,
  health/status page.

Explicitly out of scope: real provider integrations and customer-facing
features.

## Phase 1 — ServicesInMyCity as First Data Source

- Ingestion pipeline mapping ServicesInMyCity into the generic core
  (Organization / Location / Customer / ServiceRequest).
- Real authentication and tenant onboarding.
- Operator dashboard with unified customer timeline.

## Phase 2 — Conversational & Booking Core

- SMS provider adapter (Twilio / Telnyx) behind \`SmsProvider\`.
- Email provider adapter (SendGrid / Mailgun) behind \`EmailProvider\`.
- Calendar provider adapter (Google Calendar) behind \`CalendarProvider\`.
- Appointment booking flows and lead management UI.

## Phase 3 — AI Agents

- AI provider adapter (Claude / Anthropic) behind \`AIProvider\`.
- Voice provider adapter (ElevenLabs) behind \`VoiceProvider\`.
- AI phone agents, AI SMS agents, AI order taking (restaurant/pizzeria),
  AI receptionist and follow-up agents.

## Phase 4 — Commerce & Payments

- Payment provider adapter (Stripe) behind \`PaymentProvider\`.
- Order taking and checkout for restaurants/pizzerias; deposits for bookings.

## Phase 5 — Automation & Intelligence

- Workflow engine execution (\`Workflow\` / \`WorkflowRun\`).
- Behavioral intelligence on the \`Signal\` stream: churn risk, upsell, LTV,
  no-show prediction, sentiment.
- Analytics dashboards.

## Phase 6 — Multi-Vertical Expansion

- Vertical configuration packs for nail salons, barbershops, doctors' offices,
  restaurants, pizzerias, law firms, and additional EMG websites — all on the
  same core, with no schema forks.

## Guiding Constraint

No phase should require rebuilding the Sprint 1 foundation. New verticals arrive
through configuration; new vendors arrive through provider adapters.

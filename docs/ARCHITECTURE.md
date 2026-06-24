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

The hardening sprint introduced companion documents that extend (not contradict)
the architecture above. Start with \`LOOP_MASTER_BLUEPRINT.md\` — the master vision
document every developer reads first.

- **Modular architecture** — capabilities ship as installable modules that are
  organization-enabled, not hardcoded (CRM, AI Receptionist, AI Phone Agent, AI
  Ordering, Scheduling, Estimates, Payments, Reviews, Reputation, Marketing,
  Analytics, Knowledge Base, Messaging). Modules coordinate through the event
  bus. See \`MODULE_ARCHITECTURE.md\`.
- **Universal interaction model** — every interaction on every channel fits one
  envelope, with kind/vertical detail in JSON \`attributes\`; the spine of the
  unified timeline and inbox. See \`INTERACTION_MODEL.md\`.
- **AI Employee system** — \`AIAgent\` + \`VoiceProfile\` generalize into AI
  Employees (role, voice, knowledge, permissions, channels, workflows, memory,
  escalation). See \`AI_EMPLOYEE_SYSTEM.md\`.
- **Organization knowledge base** — per-org KB (PDFs, SOPs, menus, price lists,
  FAQs, policies, service areas) grounds AI Employees before they respond. See
  \`KNOWLEDGE_BASE.md\`.
- **Event-driven architecture** — every action emits an event; workflows build on
  the event bus; internal events are distinct from \`IntegrationEvent\`. See
  \`EVENT_BUS.md\`.
- **Email architecture** — core email sync is server-side Gmail / Microsoft 365
  OAuth (desktop + mobile equally), not a Chrome extension. See
  \`EMAIL_ARCHITECTURE.md\`.
- **Universal inbox** — a future unified inbox over the interaction model
  (email, SMS, calls, chat, Facebook, Instagram, WhatsApp, future channels). See
  \`UNIVERSAL_INBOX.md\`.
- **Provider philosophy** — no provider tightly coupled; everything replaceable;
  a transcription category is recommended alongside the existing six. See
  \`PROVIDER_PHILOSOPHY.md\`.
- **Review** — \`ARCHITECTURE_REVIEW.md\` records refinements R1–R9 for Sprint 2.
  No schema/code changes were made in this documentation sprint.


---

## Sprint 2 — Identity & Operating-System Core (additions)

Sprint 2 establishes the identity and OS core: the platform now understands
organizations, locations, users, roles, permissions, capabilities, AI employees,
and provider connections **before** customers. All additive to the Sprint 1
core; the schema grew from 19 to 28 models.

### Authentication foundation
Provider-agnostic, enterprise/SSO-ready, architecture only (no production
flows). Models: \`Invitation\`, \`PasswordReset\`, \`UserSession\`; enum
\`AuthProviderType\` covers password, Google/Microsoft OAuth, SAML, OIDC, and
magic link. No raw secrets are stored. See \`AUTHENTICATION.md\`.

### Multi-tenant organization configuration
\`OrganizationSettings\` and \`OrganizationPreferences\` (each 1:1 with
\`Organization\`) hold operational settings and user-facing preferences, alongside
the existing \`OrganizationStatus\`.

### Organization DNA
\`OrganizationDNA\` is the inheritable identity (brand, voice, hours, industry,
knowledge sources, communication style, compliance, escalation, AI defaults,
provider defaults). AI Employees inherit it. See \`ORGANIZATION_DNA.md\`.

### Capabilities
\`Capability\` (global catalog) + \`OrganizationCapability\` (per-org enablement)
refine the module architecture: capabilities **power** modules, are org-enabled,
and declare dependencies. See \`CAPABILITIES.md\`.

### Roles & permissions
\`SystemRole\` (Owner/Admin/Manager/Employee/AI Employee/Read Only) plus a
deny-by-default \`Permission\` model and a shared \`isAllowed\` resolver. Humans and
AI Employees share one authorization model. See \`ROLES_AND_PERMISSIONS.md\`.

### Provider connections
Lifecycle and multi-provider management on the existing \`ProviderConnection\`
model (multiple providers per org, secrets by reference, no live integrations).
See \`PROVIDER_CONNECTIONS.md\`.

### Review & future ideas
\`SPRINT_2_REVIEW.md\` confirms consistency with the blueprint/constitution and
lists Sprint 3 recommendations; \`FUTURE_CAPABILITIES.md\` parks out-of-roadmap
ideas.


## Sprint 2.5 — Foundation Cleanup & Lock (additions)

This sprint tightened the foundation before the first pull request into `main`.
No business features, live auth, or real provider integrations were added.

### AI Employees as first-class actors

`AIEmployee` is now a concrete model and the high-level AI identity on the
platform. AIAgent is reserved as the lower-level execution runtime that an
employee may be backed by. AI Employees inherit Organization DNA (with
per-employee overrides) and are typed permission subjects.

### Capabilities as the single source of enablement

`OrganizationCapability` is the sole source of truth for what an organization
can do. `OrganizationSettings.modules` is deprecated (kept only for
backward-compat migration). Modules are presentation bundles on top of enabled
capabilities; the app shell, modules, and AI Employee abilities all resolve
enablement through capabilities — one consistent path for humans, UI, and AI.

### Typed permission subjects

Permissions distinguish three subject types — Human User, AI Employee, and
System Process — via `Permission.subjectType` and the `PermissionSubject` types
in `@emgloop/shared`. The `resolvePermission` helper filters rules to the subject
and then applies the existing deny-by-default resolver; explicit deny always
wins.

### Interaction & event boundary locked

`Interaction.kind` is now in the schema; Interaction is the canonical customer
timeline spine that inbox, workflows, analytics, and AI memory attach to. Domain
events (Event Bus), Signals, and IntegrationEvents remain three separate
concerns with distinct lifecycles.

### PR readiness

The branch is being prepared for a squash-merge PR into `main` (do not open it
until asked). Build/typecheck/Prisma commands, required environment variables,
known limitations, and intentionally-unbuilt scope are documented in
PR_READINESS.md. Schema-integrity findings are in SPRINT_2_5_REVIEW.md.

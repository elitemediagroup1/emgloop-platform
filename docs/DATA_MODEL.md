# EMG Loop — Data Model

Canonical reference for the Prisma schema in
\`packages/database/prisma/schema.prisma\` (PostgreSQL). The schema is generic and
multi-tenant; industry-specific shape lives in JSON \`attributes\` / \`metadata\`
columns rather than vertical-specific tables.

## Conventions

- Primary keys are \`cuid()\` strings.
- Every tenant-scoped model has \`organizationId\` with an \`onDelete: Cascade\`
  relation to \`Organization\`.
- Soft relations to optional parents use \`onDelete: SetNull\`.
- Money is stored in integer minor units (cents).
- \`attributes\` = vertical/business data; \`metadata\` = system/integration data.
- Provider references are stored as \`provider\` + \`externalId\` strings, never as
  vendor objects.

## Tenancy & Identity

- **Organization** — tenant root. Has \`industry\`, \`status\`, \`timezone\`,
  \`sourceKey\` (e.g. \`servicesinmycity\`), \`settings\`. Parent of everything.
- **Location** — branch/physical scope under an organization (address, geo,
  hours).
- **Role** — per-tenant role with a \`permissions\` array (RBAC).
- **User** — operator account; references a \`Role\`; auth is external
  (\`authProvider\` + \`externalAuthId\`), no raw passwords stored.

## Customer & Intelligence

- **Customer** — unified customer record; \`externalId\` ties back to the source
  system; \`attributes\` holds vertical fields.
- **Interaction** — a single channel-agnostic timeline touchpoint (channel +
  direction + provider attribution).
- **Conversation** — a threaded dialogue on a channel; can be assigned to a
  \`User\` or an \`AIAgent\`.
- **Message** — an individual message in a conversation; \`actorType\` is
  customer / human agent / AI agent / system.
- **Signal** — append-only behavioral/AI intelligence (intent, sentiment, churn
  risk, upsell, LTV, no-show risk, ...) attached to a customer or conversation,
  with \`confidence\` and \`source\`.

## Commerce

- **Booking** — appointments/reservations; \`startAt\`/\`endAt\`, \`partySize\`,
  calendar provider linkage, JSON \`items\`. Covers salon/medical/restaurant.
- **Order** — orders with status, fulfillment type, money fields, JSON line
  \`items\`, and payment provider linkage. Covers pizzeria/restaurant/retail.
- **ServiceRequest** — lead/quote pipeline (home services, law firms);
  \`status\`, \`source\`, \`category\`, \`estimatedValueCents\`.

## Automation

- **Workflow** — declarative \`trigger\`, \`triggerConfig\`, and step \`definition\`;
  versioned and toggleable.
- **WorkflowRun** — one execution: status, input, output, error, timing.

## AI Agents & Voice

- **AIAgent** — an autonomous agent (phone, SMS, chat, order-taking,
  receptionist, follow-up); \`modelProvider\` + \`model\` are abstracted.
- **VoiceProfile** — a configured voice (\`voiceProvider\`, \`voiceId\`, language,
  tuning \`config\`); referenced by AI agents.

## Provider Plumbing

- **ProviderConnection** — a tenant's connection to an external provider, keyed
  by \`(organizationId, category, provider)\`; secrets stored by reference
  (\`credentialsRef\`).
- **IntegrationEvent** — normalized inbound/outbound provider events
  (webhooks/syncs); idempotent on \`(provider, externalId)\`.

## Audit

- **AuditLog** — who/what/when for changes; before/after JSON snapshots, actor,
  IP, user agent.

## Extensibility Rules

To add a vertical: configure \`Organization.industry\`, populate \`attributes\` on
\`Customer\`/\`Booking\`/\`Order\`/\`ServiceRequest\`, and (if needed) add a new value to
an enum. Do **not** create per-industry tables. To add a provider: register an
adapter against the relevant interface and create a \`ProviderConnection\` — no
core schema change required.

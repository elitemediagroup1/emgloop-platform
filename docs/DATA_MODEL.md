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


---

## Sprint 1.5 — Planned Model Refinements (not yet implemented)

The Architecture Hardening sprint identified refinements to make the modular,
event-driven, knowledge-grounded, AI-Employee vision explicit in the schema.
These are **documented only**; no schema changes were made in this sprint. Full
detail and prioritization are in \`ARCHITECTURE_REVIEW.md\`.

- **Modules:** add \`Module\` (global catalog) and \`OrganizationModule\` (per-tenant
  enablement). Interim mechanism: \`Organization.settings.modules\`.
  (\`MODULE_ARCHITECTURE.md\`)
- **Interaction spine:** add a \`kind\` enum to \`Interaction\` and make it the
  canonical timeline parent that \`Conversation\`, \`Booking\`, \`Order\`,
  \`ServiceRequest\`, reviews, and payments link back to. (\`INTERACTION_MODEL.md\`)
- **Internal events:** add a first-class \`Event\` / \`DomainEvent\` stream (distinct
  from \`IntegrationEvent\`, which remains the normalized inbound-provider
  envelope) and wire \`Workflow\` triggers to it. (\`EVENT_BUS.md\`)
- **AI Employees:** generalize \`AIAgent\` into an \`AIEmployee\` concept (role,
  voice, knowledge scope, permissions, channels[], allowed modules, escalation
  rules, memory link); keep \`VoiceProfile\` linkage. (\`AI_EMPLOYEE_SYSTEM.md\`)
- **Knowledge base:** add \`KnowledgeSource\`, \`KnowledgeDocument\`,
  \`KnowledgeChunk\` (per-org, embedding-backed, provenance-tracked).
  (\`KNOWLEDGE_BASE.md\`)
- **Email:** model mailbox connections as \`ProviderConnection\` (category
  \`email\`, OAuth, tokens by reference) feeding \`Conversation\`/\`Message\`.
  (\`EMAIL_ARCHITECTURE.md\`)
- **Memory:** add a per-customer / per-employee memory store complementing the
  append-only \`Signal\` stream. (\`AI_EMPLOYEE_SYSTEM.md\`)

These keep the current 19-model foundation intact and additive: nothing here
removes or forks an existing model, consistent with "foundation over polish."


---

## Sprint 2 — Identity & Operating-System Core (implemented in schema)

Sprint 2 added **9 models** and **5 enums** (schema now 28 models), all additive
and tenant-scoped. Nothing from Sprint 1 was removed or forked.

### New enums
\`SystemRole\` (OWNER, ADMIN, MANAGER, EMPLOYEE, AI_EMPLOYEE, READ_ONLY),
\`InvitationStatus\`, \`AuthProviderType\` (PASSWORD + GOOGLE/MICROSOFT OAuth, SAML,
OIDC, MAGIC_LINK), \`CapabilityStatus\`, \`PermissionEffect\` (ALLOW/DENY).

### Organization configuration
- **OrganizationSettings** (1:1) — modules (interim), limits, feature flags,
  defaults.
- **OrganizationPreferences** (1:1) — locale, date/time format, week start,
  currency, notifications.

### Organization DNA
- **OrganizationDNA** (1:1) — brand, voice, communicationStyle, businessHours,
  knowledgeSources, complianceRules, escalationRules, aiDefaults,
  providerDefaults, industry, version. Inherited by AI Employees.
  (See \`ORGANIZATION_DNA.md\`.)

### Authentication foundation (architecture only)
- **Invitation** — tokenized (hash stored), expiring, status-tracked; links an
  inviter (\`User\`) and target role.
- **PasswordReset** — tokenized, expiring, single-use request lifecycle.
- **UserSession** — session metadata only (provider, ip, UA, expiry, revocation);
  no raw token material. (See \`AUTHENTICATION.md\`.)

### Permissions (deny-by-default)
- **Permission** — explicit ALLOW/DENY rule targeting a system role, custom role,
  user, or AI employee; resource + action + JSON conditions. DENY wins; no
  matching rule => denied. (See \`ROLES_AND_PERMISSIONS.md\`.)

### Capabilities
- **Capability** — global catalog (key, dependencies, configSchema, isCore).
- **OrganizationCapability** — per-org enablement (status, config, enabledAt),
  unique on \`(organizationId, capabilityId)\`. Capabilities power modules.
  (See \`CAPABILITIES.md\`.)

### Conventions preserved
All new tenant-scoped models carry \`organizationId\` with \`onDelete: Cascade\`;
secrets are referenced, never stored raw; industry/vertical detail stays in JSON.

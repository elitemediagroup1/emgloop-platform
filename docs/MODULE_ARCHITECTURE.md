# Module Architecture

The Loop's capabilities are delivered as **modules**. A module is a
self-contained capability that is **enabled per organization**, never hardcoded
into the core. A pizzeria and a law firm run the same platform with different
modules switched on.

## Why Modules

- **Industry-agnostic:** every business enables only the capabilities it needs.
- **Independent delivery:** modules can ship, version, and evolve separately.
- **Clean boundaries:** modules interact through the event bus and shared data
  model, not through tangled direct calls.
- **Monetization:** modules map naturally to plans, add-ons, and entitlements.

## Module Principles

1. **Org-enabled, not hardcoded.** A module's availability is a configuration
   row, resolved at runtime. Disabling a module hides its surface and pauses its
   automations without data loss.
2. **Event-native.** Modules publish and subscribe to events (see
   \`EVENT_BUS.md\`) rather than calling each other directly.
3. **Provider-agnostic.** Modules that need external capability go through the
   provider interfaces (see \`PROVIDER_PHILOSOPHY.md\`).
4. **Knowledge-aware.** AI modules read from the organization knowledge base
   (see \`KNOWLEDGE_BASE.md\`).
5. **Permission-scoped.** Module actions respect roles and AI Employee
   permissions.
6. **Vertical-neutral.** A module never assumes a single industry; vertical
   behavior comes from configuration and JSON \`attributes\`.

## Module Catalog (initial)

| Module | Purpose | Key dependencies |
|--------|---------|------------------|
| **CRM** | Customer records, timeline, segments | core data model |
| **Messaging** | Two-way SMS / chat threads | SMS provider |
| **AI Receptionist** | Greets, qualifies, routes inbound | AI, Voice, Knowledge Base |
| **AI Phone Agent** | Autonomous voice calls (in/out) | Voice, AI, telephony |
| **AI Ordering** | Takes orders conversationally | AI, Knowledge Base (menu), Payments |
| **Scheduling** | Appointments, availability, reminders | Calendar provider |
| **Estimates** | Quotes / proposals | CRM, Knowledge Base (price list) |
| **Payments** | Invoices, checkout, deposits | Payment provider |
| **Reviews** | Solicit and collect reviews | Messaging, Email |
| **Reputation** | Aggregate and respond to ratings | Reviews, AI |
| **Marketing** | Campaigns, broadcasts, win-back | Messaging, Email, Analytics |
| **Analytics** | Dashboards and reporting | Event bus |
| **Knowledge Base** | Per-org knowledge for AI grounding | ingestion + retrieval |

This catalog is extensible; new modules are added without changing existing ones.

## Data Model Direction

A module registry and per-organization enablement are introduced as a
**foundational change** (documented here, scheduled for implementation — see
\`ARCHITECTURE_REVIEW.md\`):

- \`Module\` — the catalog definition (key, name, description, dependencies,
  default config schema). Global, not tenant-scoped.
- \`OrganizationModule\` — join row enabling a module for an organization
  (\`organizationId\`, \`moduleKey\`, \`status\`, \`config\`, \`enabledAt\`). This is the
  switch that makes modules org-enabled rather than hardcoded.

Until implemented, module enablement can be represented in
\`Organization.settings.modules\` as an interim mechanism, then migrated to the
dedicated tables. AI Employees reference the modules they are allowed to operate.

## Module Lifecycle

\\\`\\\`\\\`
available  ->  enabled (per org)  ->  configured  ->  active
                                                   ->  paused  ->  disabled
\\\`\\\`\\\`

Disabling preserves data and history; re-enabling resumes from configuration.

## Inter-Module Communication

Modules communicate through events. Example: the **Scheduling** module emits
\`booking.confirmed\`; the **Messaging** module subscribes and sends a
confirmation; the **Reviews** module subscribes to \`booking.completed\` to request
a review; **Analytics** subscribes to everything. No module imports another
module's internals.

## Relationship to AI Employees

AI Employees are configured to use a subset of the organization's enabled
modules. A Salon Receptionist might use Scheduling + Messaging + Knowledge Base;
a Pizza Order Taker uses AI Ordering + Payments + Knowledge Base. The module set
an AI Employee may touch is part of its permissions.

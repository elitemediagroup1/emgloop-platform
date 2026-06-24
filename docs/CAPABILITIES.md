# Capabilities

Sprint 1.5 introduced **modules** (\`MODULE_ARCHITECTURE.md\`). Sprint 2 refines
the foundation by introducing **capabilities**: the platform-level building
blocks that **power** modules. Capabilities do **not** replace modules — a module
is a packaged, user-facing product surface; a capability is the underlying
ability the platform registers, enables, and depends on.

> **Capabilities power modules. Modules are how capabilities are presented and
> sold.** A module may compose several capabilities.

## Why a Capability Layer

- A clean place to declare **dependencies** (e.g. AI Ordering needs \`payments\`
  and \`knowledge_base\`).
- A single switch for **enablement** per organization, with lifecycle status.
- A stable target for **permissions** and **AI Employee** reach.
- Decouples "what the platform can do" from "what we package and sell".

## Capability Registration

Capabilities are registered **globally** in a catalog (\`Capability\` model):

| Field | Meaning |
|-------|---------|
| \`key\` | stable id, e.g. \`scheduling\`, \`ai.receptionist\`, \`payments\` |
| \`name\` / \`description\` | human metadata |
| \`category\` | grouping, e.g. \`ai\`, \`commerce\`, \`comms\` |
| \`dependencies\` | other capability keys this one requires |
| \`configSchema\` | JSON Schema for the per-org config it accepts |
| \`isCore\` | whether it is always-on foundational |

The canonical key list lives in \`packages/shared/src/identity.ts\`
(\`CAPABILITY_KEYS\`): crm, messaging, ai.receptionist, ai.phone, ai.ordering,
scheduling, estimates, payments, reviews, reputation, marketing, analytics,
knowledge_base.

## Capability Enablement

Enablement is **per organization** via \`OrganizationCapability\`:

\\\`\\\`\\\`
available -> enabled -> configured -> active
                                   -> paused -> disabled
\\\`\\\`\\\`

Each row carries \`status\` (\`CapabilityStatus\`), \`config\` (validated against the
capability's \`configSchema\`), and \`enabledAt\`. Disabling preserves data and
pauses behavior; re-enabling resumes from config. Interim mechanism before full
rollout: \`OrganizationSettings.modules\`.

## Dependency Rules

1. A capability cannot be \`active\` unless **all** its \`dependencies\` are active
   for the organization.
2. Enabling a capability surfaces (but never silently auto-enables) its missing
   dependencies; the operator confirms.
3. Disabling a capability that others depend on warns and is blocked until
   dependents are disabled or rerouted.
4. Dependency graphs must be **acyclic**; the registry rejects cycles.
5. \`isCore\` capabilities are always active and cannot be disabled.

## Relationship to Modules and AI Employees

- A **module** (\`MODULE_ARCHITECTURE.md\`) declares the capabilities it requires;
  enabling the module enables/needs those capabilities.
- An **AI Employee** (\`AI_EMPLOYEE_SYSTEM.md\`) may only act through capabilities
  the organization has active **and** that the employee is permitted to use.
- **Permissions** (\`ROLES_AND_PERMISSIONS.md\`) reference capability-scoped
  resources (e.g. \`scheduling.booking.create\`).

## Sprint 2 Scope

This document plus the \`Capability\` / \`OrganizationCapability\` models and the
shared \`CAPABILITY_KEYS\` vocabulary. No capability is *implemented* as a working
feature yet — this is the registration/enablement/dependency foundation.

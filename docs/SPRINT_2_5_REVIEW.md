# Sprint 2.5 — Foundation Cleanup & Lock: Review

This document records the schema-integrity findings and decisions made while
hardening the foundation before the first pull request into `main`.

## Scope

Documentation, architecture, and data-model refinement only. No business
features, no live authentication flows, no real provider integrations, and no
ServicesInMyCity workflows were built in this sprint.

## What changed in the schema

- **AIEmployee is now a first-class model.** It carries `organizationId`,
  optional `locationId` and `voiceProfileId`, `name`, `title`, `status`,
  `channels`, DNA-inheritance flags and overrides, knowledge-access rules,
  escalation rules, operating hours, provider preferences, and
  `attributes`/`metadata` JSON. It is also a permission subject.
- **Interaction gained a `kind` field** (enum `InteractionKind`) plus an index
  on `(organizationId, kind)`. Channel = transport, kind = semantic event.
- **Permission gained `subjectType`** (enum `PermissionSubjectType`) and a typed
  `aiEmployee` relation, so AI Employees are explicit permission subjects.
- **OrganizationSettings.modules is deprecated.** It is retained only for
  backward-compat migration and explicitly marked not the source of truth.

Schema totals after this sprint: 29 models, 27 enums, balanced braces, no
duplicate model or enum names.

## AIEmployee vs AIAgent (decision record)

AIEmployee is the high-level identity ("who"): a named role such as "HVAC
Dispatcher" or "Pizza Order Taker" that owns DNA inheritance, channels,
knowledge access, escalation, and operating hours, and can hold permissions.
AIAgent is the lower-level execution runtime ("how"): the model/provider,
system prompt, and runtime config for a single agent run. One AIEmployee may be
backed by one or more AIAgent runtime configs over time. AIAgent is reserved for
execution; new orchestration targets AIEmployee.

## Schema integrity findings

- **Duplicate concepts:** Two competing module/enablement bags existed
  (`Organization.settings` and `OrganizationSettings.modules`). Resolved by
  making OrganizationCapability the single source of truth and deprecating the
  modules bag. `Organization.settings` is retained only for tenant-level
  non-capability preferences.
- **Loose references:** `Permission.aiEmployeeId` was an untyped string; it now
  has a typed relation to AIEmployee and a `subjectType` discriminator.
- **Missing indexes:** Added `(organizationId, kind)` on Interaction and
  `(organizationId, status)` plus `(organizationId, locationId)` on AIEmployee.
- **Tenant scoping:** Every tenant-scoped model verified to carry
  `organizationId`. No tenant-scoped record is missing it.
- **JSON vs structured:** Vertical-specific shape intentionally stays in JSON
  (`attributes`/`metadata`, DNA overrides, escalation/knowledge rules). We did
  not over-normalize industry data into dedicated tables.
- **Naming:** Model and enum names confirmed consistent; no collisions.

## Interaction & event lock

- `Interaction.kind` is present and Interaction remains the canonical customer
  timeline spine. Inbox, workflows, analytics, and AI memory all attach to
  Interaction.
- Domain events (Event Bus), `Signal` (soft intelligence), and
  `IntegrationEvent` (raw provider webhooks) remain three separate concerns and
  are documented as such.

## Carried into Sprint 3

- Implement the permission-resolution engine that loads `ScopedPermissionRule`
  rows and resolves via `resolvePermission` at request time.
- Seed the Capability catalog and default Role rows.
- Decide the secrets-manager approach for provider credential storage.
- Wire AIEmployee DNA inheritance resolution (override-merge precedence).

## Out of scope (intentionally not built)

Live auth, real provider calls, customer-facing UI, and any ServicesInMyCity
ingestion remain out of scope and are deferred to later sprints.

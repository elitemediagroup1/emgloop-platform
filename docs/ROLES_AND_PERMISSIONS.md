# Roles & Permissions

The platform uses **role-based access control with a deny-by-default permission
model**. Roles provide sensible baselines; explicit permission rules refine them.
Both human users and AI Employees are governed by the same model.

## System Roles

| Role | Intent |
|------|--------|
| **Owner** | Full control of the organization, including billing and deletion. The first user is the owner. |
| **Admin** | Manage users, roles, capabilities, providers, and configuration. |
| **Manager** | Operate day-to-day: customers, conversations, bookings, orders within scope. |
| **Employee** | Handle assigned work; limited configuration access. |
| **AI Employee** | A non-human actor; permissions are explicitly granted and capped. |
| **Read Only** | View access; no mutations. |

These map to the \`SystemRole\` enum and the shared \`SYSTEM_ROLES\` vocabulary.
Per-tenant custom roles are also supported via the \`Role\` model.

## Deny-by-Default Model

> Access is **denied** unless an explicit **ALLOW** matches and **no DENY**
> matches.

- Roles carry a base permission set (\`Role.permissions\`).
- \`Permission\` rows add per-organization grants/overrides, targeting a system
  role, a custom role, a specific user, or an AI Employee.
- Each rule has a \`resource\`, an \`action\`, and an \`effect\` (\`ALLOW\` / \`DENY\`),
  plus optional ABAC-style \`conditions\` (limits, ownership, time windows).
- **DENY always wins** over ALLOW. No matching rule => denied.

The reference resolver is in \`packages/shared/src/identity.ts\` (\`isAllowed\`):
an explicit deny short-circuits to false; otherwise access requires at least one
allow.

## Resource / Action Vocabulary

Resources are capability-scoped, e.g. \`scheduling.booking\`, \`crm.customer\`,
\`payments.invoice\`. Actions follow a small core set — \`create\`, \`read\`,
\`update\`, \`delete\`, \`manage\` — where \`manage\` implies the others for that
resource. Capabilities and modules extend the resource list; they never bypass
the resolver.

## AI Employee Permissions

AI Employees are **first-class subjects** of the same model, with extra safety:

- Deny-by-default applies identically; an AI Employee can only use explicitly
  granted resources/actions.
- Sensitive actions (refunds, spend, data writes) carry caps in \`conditions\`
  and may require human approval.
- Every AI Employee has a defined escalation path (see \`AI_EMPLOYEE_SYSTEM.md\`);
  there is no "no fallback" state.
- All actions are audited (\`AuditLog\`) and emit events (\`EVENT_BUS.md\`).

## Example Rules

\\\`\\\`\\\`
{ subject: role:manager,    resource: "crm.customer",        action: "manage", effect: ALLOW }
{ subject: role:read_only,  resource: "*",                   action: "read",   effect: ALLOW }
{ subject: ai:order_taker,  resource: "ai.ordering.order",   action: "create", effect: ALLOW }
{ subject: ai:order_taker,  resource: "payments.refund",     action: "create", effect: DENY  }
\\\`\\\`\\\`

## Data Model

| Model | Role |
|-------|------|
| \`Role\` | per-tenant role definition with a base permissions array |
| \`Permission\` | explicit allow/deny rule (subject + resource + action + conditions) |
| \`User\` | carries a \`SystemRole\` and optional custom \`Role\` |

See \`DATA_MODEL.md\` for fields and \`AUTHENTICATION.md\` for identity.

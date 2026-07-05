# Loop OS — Phase 2 Shell (PR #47)

Phase 2 begins transforming EMG Loop from a CRM into a **Business Operating System**. This PR builds the **shell** of Loop OS — the operating system the functionality will live inside — without implementing feature functionality and without touching the Brain, the database schema, or existing authorization.

## Mental model

- **Sensors** — every external platform (CallGrid, Ringba, Twilio, Meta, Google Ads, TikTok, HubSpot, Salesforce, Stripe, internal systems) is a sensor.
- **The Brain** (PR #29–#46) is the operating system's reasoning core. It is reused as-is: never redesigned, never duplicated, never re-implemented.
- **Workspaces** — everything a human sees is a workspace. The **CRM is now just one workspace** inside Loop, not the application.

## What this PR adds

A configuration-driven workspace layer under `apps/web/src/workspaces/` plus the routes that consume it. Nothing here computes intelligence; pages will consume Brain Activity, Brain Briefings, Marketplace Intelligence, and Recommendation Envelopes in later PRs.

### The one entrance

The homepage of Loop (`/`) **is the login page**. No marketing homepage, no CRM homepage — one entrance (EMG Loop · Email · Password · Sign In). It reuses the existing auth core; an already-authenticated visitor is routed to their workspace via the role router at `/app`.

### Role-based routing (configuration-driven)

Routing is a **data table**, not hard-coded branches. `role-router.ts` maps the existing, unchanged `SystemRole` enum onto the Phase 2 workspace roles:

| SystemRole (DB, unchanged) | Workspace |
|---|---|
| OWNER / ADMIN / MANAGER | ADMIN |
| EMPLOYEE / AI_EMPLOYEE | EMPLOYEE |
| READ_ONLY | CLIENT |

`BUSINESS_OWNER` and `CREATOR` are product roles the DB enum has no dedicated value for yet. Rather than redesign the schema (out of scope), they are opt-in via an explicit workspace hint carried in existing user metadata. Adding a future role — or a dedicated `SystemRole` later — is **one row** in the mapping table. Unknown roles **fail closed** to the most isolated workspace (CLIENT), never ADMIN.

### Workspaces (shells only)

Five workspaces share one design language (the existing brand, sidebar, and design-system CSS) with different navigation, driven entirely by `workspaces/config.ts`:

- **Admin** — the whole OS: Dashboard, Brain, Marketplace Intelligence, Operations, CRM, Businesses, Creators, Employees, Experiments, Knowledge, Settings, System Health, Integrations.
- **Employee** — only assigned work: assigned Businesses/Creators/Campaigns, Tasks, Brain Alerts, Messages, Calendar. No Marketplace Intelligence, no admin tooling, no system settings.
- **Business** — one organization: Dashboard, Calls, Leads, Revenue, Brain Insights, Recommendations, Reports, Messages, Settings.
- **Creator** — a distinct studio experience: Dashboard, Content Calendar, **Upload Video (first-class)**, Content Review Queue, AI Critiques, Brand Deals, Contracts, Payments, Analytics, Messages, Settings.
- **Client** — an isolated, minimal workspace. Routing architecture matters more than features here.

### Marketplace Intelligence is an Admin workspace

Not "CallGrid Analytics", not "Reports". It is provider-neutral and consumes the canonical model from PR #43–#46. It is gated by the existing IAM resource `intelligence`.

## Authorization

Permissions are role-based and enforced **server-side**. The navigation shell may dim items a session can't use, but that is UX, never the security boundary:

- `requireWorkspace(role)` — fail-closed workspace isolation (a Creator can't render the Admin shell by typing the URL; they're routed to their own home).
- `requireWorkspacePermission(role, resource, action)` — reuses the existing deny-by-default IAM matrix (`packages/database`). Backend authorization stays the single source of truth.

## Files

| File | Purpose |
|---|---|
| `workspaces/config.ts` | Roles → nav → route → permission (single source of truth) |
| `workspaces/role-router.ts` | SystemRole → WorkspaceRole → home route (config-driven) |
| `workspaces/WorkspaceShell.tsx` | The one shared navigation shell |
| `workspaces/ShellPage.tsx` | Premium empty-state for shell pages |
| `workspaces/guard.ts` | Workspace isolation over existing auth guards |
| `workspaces/login-action.ts` | Universal login action (reuses auth core) → /app |
| `workspaces/verification.ts` | Pure routing/config verification harness |
| `workspaces/index.ts` | Barrel |
| `app/page.tsx` | Universal login entrance (was marketing homepage) |
| `app/app/page.tsx` | Role router (/app) |
| `app/app/layout.tsx` | Loads shared OS design language |
| `app/app/{admin,employee,business,creator,client}/*` | Workspace layouts, dashboards, catch-all shells, + first-class MI & Upload |

## Verification

`runWorkspaceRoutingVerification()` is a pure, framework-free harness (mirrors PR #45/#46) that asserts: every SystemRole routes to a defined workspace; routing matches the config table; isolation holds (Employee never lands in Admin); the default fails closed (not Admin); product-role hints work and invalid hints are ignored; and every workspace's nav links stay inside its own basePath (with deliberate cross-links like Admin → /crm allowed). No I/O, no runtime wiring; it compiles under typecheck.

## Constraints honored

Draft PR only — **do not merge**. No breaking changes (the existing `/crm` app, `/crm/login`, `loginAction`, guards, and IAM are all untouched). No database redesign or schema change. Reuses existing authorization, the existing Brain architecture, and Marketplace Intelligence. No feature functionality inside the workspaces yet.

## Future PR sequence

1. **PR #48** — Admin Dashboard consumes Brain Briefings + Brain Activity (read-only).
2. **PR #49** — Business workspace consumes Marketplace Intelligence for its org.
3. **PR #50** — Employee workspace: assigned-work queries (tasks, businesses, creators).
4. **PR #51** — Creator Upload Video: wire storage + submit into Content Review Queue.
5. **PR #52** — Creator AI Critiques: Brain analysis of uploaded content (consume, not compute).
6. **PR #53** — Dedicated SystemRole values (if the schema evolves) folded into the router table.

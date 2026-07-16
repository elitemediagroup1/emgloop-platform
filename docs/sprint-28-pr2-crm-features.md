# Sprint 28 — PR 2: Conversations, Workflows & CRM Intelligence organization scoping

Security-critical organization isolation — Sprint 28, PR 2 of 4. Draft only; do not merge.

## Scope

This PR migrates the next coherent CRM subsystem off the deprecated demo-org
resolver (`resolveCrmOrganizationId` / `CRM_ORG_SLUG`) introduced-for-removal in
PR 1, and onto the canonical session context `requireCrmContext()`.

Covered surfaces: Conversations, Workflows, CRM Analytics, CRM Intelligence,
CRM Revenue, CRM Traffic, and the server actions behind them.

Out of scope (unchanged): owner Brain / Marketplace, all `/api/*` routes (PR 3),
`/crm/integrations`, `/crm/users`, `/crm/settings`, `/crm/audit`, the CRM landing
decision, top-bar search, and owner navigation reconnection (PR 4). No Prisma
schema change, no migration, no RBAC or session redesign.

## New fail-closed guards (apps/web/src/crm/crm-data.ts)

- `conversationBelongsToOrg(organizationId, conversationId)` — returns true only
  when the conversation belongs to the caller's session organization; a cross-org
  id returns false and is treated as not-found / unauthorized.
- `workflowBelongsToOrg(organizationId, workflowId)` — same fail-closed contract
  for workflows.

Both read `organizationId` from the signed session only (via `requireCrmContext`
in callers); neither accepts a slug, query param, form field, or browser input,
and neither ever resolves the demo organization.

## Reads secured

- `/crm/conversations` — list + status counts already scoped in the repository;
  org source re-pointed to the session (was the demo resolver).
- `/crm/conversations/[id]` — `getWorkspace(id)` is not org-filtered, so the page
  now verifies `conversationBelongsToOrg` first and returns not-found for a
  cross-org id (fail closed) before loading the thread.
- `/crm/workflows` — list scoped to the session organization.
- `/crm/workflows/[id]` — `getWorkflow(id)` / `listRuns(id)` are not org-filtered,
  so the page verifies `workflowBelongsToOrg` first and returns not-found for a
  cross-org id before loading the builder or run history.
- `/crm/analytics`, `/crm/intelligence`, `/crm/revenue`, `/crm/traffic` — every
  query already takes `organizationId` as a parameter and is org-scoped in the
  repository layer; the org source is re-pointed from the demo resolver to the
  session. No global totals are exposed; existing date filters, aggregation and
  truthful empty states are preserved.

## Writes secured

- `conversation-actions.ts` — `sendMessageAction`, `setConversationStatusAction`
  and `setConversationAssigneeAction` previously mutated by a raw conversationId.
  Each now verifies `conversationBelongsToOrg(session.organizationId, ...)` and
  fails closed before writing. Permission checks and revalidation are unchanged.
- `workflow-actions.ts` — `createWorkflowAction` now derives the org from the
  session (was the demo resolver). `updateWorkflowMetaAction`, `addStepAction`,
  `removeStepAction` and `toggleWorkflowActiveAction` now verify
  `workflowBelongsToOrg(session.organizationId, id)` and fail closed before
  mutating. `runWorkflowAction` was already safe: the repository `runWorkflow`
  resolves the workflow with `findFirst({ id, organizationId })` and every step
  executor scopes to the run's organization, so a cross-org id throws not-found.

## Integration actions

`integration-actions.ts` still imports the deprecated resolver but serves only
`/crm/integrations` (a PR 4 route) and no in-scope PR 2 analytics/revenue/traffic/
intelligence page. Per the staged plan it is intentionally left for PR 4 and is
NOT modified here. Its connection reads/writes already scope by org in the
repository (`getConnection`/`deleteConnection(orgId, ...)`).

## Cross-org protection summary

Direct-record URLs (`/crm/conversations/[id]`, `/crm/workflows/[id]`) fail closed
to not-found for ids outside the session organization. Single-record conversation
and workflow mutations verify ownership before writing. No metric is returned
without organization ownership. No client-supplied organization context is
accepted anywhere.

## Deprecated-resolver status after PR 2

`resolveCrmOrganizationId` / `CRM_ORG_SLUG` remain (transitional, @deprecated) and
are NOT deleted in this PR because consumers still exist. Remaining production
consumers are expected to be limited to owner Brain, owner Marketplace and its
subpages, and the listed `/api/*` routes (all PR 3), plus `integration-actions.ts`
(PR 4). See the PR description for the exact repository-wide usage table.

## Owner navigation

Intentionally withheld. Owner navigation reconnection remains deferred to PR 4.

## Testing

- Per-PR: TypeScript/build verified via the Netlify deploy preview; source-level
  organization-scoping review of every in-scope read and write.
- The full two-organization manual matrix (Org A = Elite Media Group,
  Org B = Test organization) will be executed in the final PR, covering
  conversation/workflow/analytics isolation in both directions.

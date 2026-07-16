# Sprint 28 — PR 1: CRM Core Context + Customer Safety

Status: Draft PR (do not merge). Branch: security/crm-org-context-core.

## Why

The CRM data layer previously resolved its organization from a hardcoded
seed-organization slug (see docs/sprint-28-crm-org-scoping.md). That made
mature CRM pages and actions read/write the demo organization instead of the
authenticated owner's organization — a multi-tenant data-isolation defect.

Sprint 28 fixes this in dependency-ordered Draft PRs. This is PR 1: the
canonical CRM context helper plus the highest-risk customer/core surfaces.

## Canonical context

apps/web/src/crm/crm-data.ts now exports:

- requireCrmContext(returnTo?) -> { userId, organizationId, systemRole,
  roleLabel, session }. It wraps the existing requireWorkspaceSession() guard,
  is server-only, fails closed (redirects to login when unauthenticated), and
  always derives organizationId from the signed session cookie — never from a
  slug, query parameter, form field, or any browser input, and never from the
  demo organization.
- customerBelongsToOrg(organizationId, customerId) -> boolean. A fail-closed
  ownership guard: returns true only when the customer row belongs to the
  session organization. A cross-org id returns false so callers treat it as
  not found / unauthorized.

The demo-only organization resolver has been removed from crm-data.ts. It is no
longer importable by production code. Development seeding is unchanged.

## Reads secured in PR 1

- /crm/customers (list, tags, status counts) — session organization.
- /crm/customers/[id] — session organization; a customer from another
  organization now fails closed (treated as not found).
- /crm/customers/[id]/activity — session organization; cross-org customer
  ignored.
- /crm/pipeline — session organization.
- /crm/inbox — session organization.
- /crm/search — session organization (prerequisite for restoring top-bar
  search in PR 4).
- /crm/merge — session organization.

## Writes secured in PR 1 (apps/web/src/crm/actions.ts)

The single-record mutations previously operated on a raw customerId with no
organization filter (a cross-org mutation hole). Each now derives the
organization from the session and verifies ownership before mutating:

- addNoteAction, setStatusAction, addTagAction, removeTagAction,
  setAssignmentAction, updateCustomerFieldsAction, movePipelineAction.

The bulk actions (bulkSetStatus / bulkAddTag / bulkAssign) already filter their
target ids to the organization in the repository layer; PR 1 only re-points
their organization source to the session. No repository signature or Prisma
schema change was required.

## Not in PR 1 (remaining production resolver usages)

The following still resolve the demo organization and are scheduled for later
PRs (owner navigation stays withheld until they are all secured):

- PR 2 (features): /crm/analytics, /crm/conversations, /crm/conversations/[id],
  /crm/intelligence, /crm/revenue, /crm/traffic, /crm/workflows,
  /crm/workflows/[id], integration-actions.ts, workflow-actions.ts.
- PR 3 (owner intelligence + API): /app/admin/brain, /app/admin/marketplace
  and its subpages, and the /api/brain, /api/live/*, /api/revenue, /api/traffic
  route handlers.

## Owner navigation

Unchanged in PR 1. Employees, Integrations, Settings, Search and a CRM landing
route remain intentionally withheld from the owner shell until PR 4, after all
routes they expose are proven session-organization-scoped.

## Manual two-organization test (to be executed in the final PR)

Organization A (Elite Media Group) and Organization B (a test organization),
each with a distinct customer. While signed into A: only A customers appear in
the list/search/pipeline/inbox; opening a B customer URL fails closed; B
customer mutations are rejected. And symmetrically for B. This must be executed
against two real authenticated organizations before it is claimed as passing.

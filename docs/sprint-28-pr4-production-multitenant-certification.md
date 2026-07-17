# Sprint 28 — PR 4: Production Multi-Tenant Certification (Phase 1)

Status: Draft. This PR contains ONLY the objective, non-breaking security changes
(Parts 1-3, 7-9). The subjective product/UI decisions (Parts 4-6: Owner navigation
restoration, dashboard de-duplication, top-bar trimming) are deliberately NOT
implemented here; they are documented as proposals awaiting explicit approval.

## Executive summary

Every authenticated production CRM surface now derives its organization from the
authenticated server session. The deprecated demo-org resolver
(`resolveCrmOrganizationId` / `CRM_ORG_SLUG`) has been fully removed from the
codebase. There is no demo-org fallback in any authenticated production read or
write path.

A second, distinct organization-resolution mechanism was discovered during
inventory: `crm/live-org.ts` (`ensureLiveOrganization()` / `LIVE_ORG_SLUG`). It
serves TWO different responsibilities, which this PR separates:

1. Authenticated Integrations/Settings pages — MIGRATED to the session context.
2. External provider webhooks (CallGrid, website ingestion) — LEFT UNTOUCHED,
   because they have no authenticated user session and require a separate tenant
   resolution strategy that is out of scope for this sprint.

## Part 1 + 2 — CRM scoping completed and resolver removed

Migrated to the authenticated session:

- `crm/integration-actions.ts` — both server actions now derive `orgId` from the
  session returned by the existing `requirePermission('integrations','create')`
  guard, instead of `resolveCrmOrganizationId()`. RBAC, ownership-scoped writes
  (every `repositories.*` call is passed `organizationId: orgId`), revalidation
  and response behaviour are all preserved. No org id is accepted from form data,
  body, query or headers.
- `app/crm/integrations/page.tsx`
- `app/crm/integrations/[provider]/page.tsx`
- `app/crm/integrations/assistant/page.tsx`
- `app/crm/integrations/website/property/[key]/page.tsx`
- `app/crm/settings/integrations/callgrid/page.tsx`

Each Integrations/Settings page replaced
`const { organizationId } = await ensureLiveOrganization();` with
`const { organizationId } = await requireCrmContext();`. `requirePermission` RBAC
gates are unchanged. Page layout, queries, filters and empty states are unchanged.

Deleted from `crm/crm-data.ts`:

- `export const CRM_ORG_SLUG = 'servicesinmycity-demo'`
- `export async function resolveCrmOrganizationId()`
- the deprecated JSDoc block

No compatibility export was left behind, and it was not replaced with another
slug-based helper. `requireCrmContext()`, `customerBelongsToOrg`,
`conversationBelongsToOrg`, `workflowBelongsToOrg` and the `crmRepos` export
remain.

## Verified-safe (no change required)

The following authenticated pages were inspected and already derive
`organizationId` from the authenticated `requirePermission`/`requireSession`
session and scope every repository read by it; they contained no resolver, no
`ensureLiveOrganization`, and no demo slug:

- `app/crm/users/page.tsx`
- `app/crm/settings/page.tsx`
- `app/crm/audit/page.tsx`
- `app/crm/page.tsx` (session-gated router / redirect)

## Part 3 + 9 — Repository sweep classification

Group A — RESOLVED (no demo dependency remains in authenticated production):
- `crm/crm-data.ts` (resolver + slug deleted)
- `crm/integration-actions.ts`
- all five Integrations/Settings pages above

Group B — INTENTIONAL INFRASTRUCTURE (left in place on purpose):
- `crm/live-org.ts` — `ensureLiveOrganization()` / `LIVE_ORG_SLUG`. Provider
  webhook tenant bootstrap. NOT an authenticated CRM defect.
- `app/api/webhooks/callgrid/route.ts`, `app/api/webhooks/website/route.ts` —
  unauthenticated inbound provider webhooks that resolve their org via
  `LIVE_ORG_SLUG`.
- `app/api/integrations/callgrid/sync/route.ts` — admin sync route using the same
  bootstrap.
- `app/crm/integrations/[provider]/page.tsx` and
  `app/crm/integrations/website/property/[key]/page.tsx` retain a `LIVE_ORG_SLUG`
  import ONLY for the public per-property website SDK install snippet / ingest
  identifier, which is part of the ingestion contract, not org selection.

Allowed non-production hits (unchanged): `packages/database/prisma/seed.ts`,
`apps/web/src/demo/*`, `apps/web/src/auth/bootstrap.ts` (`DEMO_ORG_SLUG`), the PHP
provisioning routes (a separate `crm_org_slug` DB column), docs and `.planning`
history, and an `organization.repository.ts` comment.

## Part 7 — Write-path security review

`crm/integration-actions.ts`: both mutations follow
requirePermission -> session.organizationId -> repositories.*({ organizationId })
-> revalidate. No mutation updates or deletes by raw record id without the
organization scope. Client form data supplies only data fields, never an org id.

`admin-actions.ts`, `settings`, `audit` and `users` server code route all writes
through `repositories.*` with the session `organizationId`; none was found to
mutate by raw id outside the org scope.

## Part 8 — Multi-tenant certification matrix (PENDING live execution)

The full two-organization (Org A = Elite Media Group, Org B = Test Organization)
manual test matrix is defined in the PR description. It has NOT been executed here
because that requires two authenticated organizations with seeded data and live
credentials, which are not available to an automated source-level change. It is
marked PENDING and must be run before flipping to production. No live isolation
claim is made.

## Future architecture recommendation — Webhook tenant resolution

Current (single hardcoded slug):

    Provider event -> LIVE_ORG_SLUG ('servicesinmycity-demo') -> process event

Recommended (multi-tenant):

    Provider event -> (webhook secret | provider account | CallGrid account |
    tracking number | website property mapping) -> Organization -> process event

This is a design change (new mapping, likely schema + per-org webhook secrets) and
is intentionally NOT implemented in this sprint. It must not be forced to share the
authenticated-session resolver, because webhooks have no session. A longer-term
option is to move CallGrid off CRM into a dedicated Traffic ingestion pipeline that
resolves the organization first, then records operational events, with CRM and
Brain consuming from it.

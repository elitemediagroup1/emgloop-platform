# Sprint 28 - PR 3: Owner Brain, Marketplace & API Organization Scoping

## Summary

This PR migrates the Owner Intelligence surfaces (Brain, Marketplace and their
supporting production API routes) off the deprecated hardcoded demo-organization
resolver and onto the canonical session-derived organization context introduced
in PR #98 (`requireCrmContext()` for server components, `getSession()` for API
route handlers).

After this PR, every in-scope Owner page and organization-private API derives
`organizationId` from the authenticated server session. No in-scope surface reads
the demo organization slug, and no supporting API returns demo-org, cross-org, or
global organization business data.

## Canonical context

- Pages / server components: `requireCrmContext()` (from `apps/web/src/crm/crm-data.ts`).
- API route handlers: the existing `getSession()` helper (from `apps/web/src/auth/auth.ts`),
  which returns an `AuthSession` containing `organizationId`. No new competing
  resolver or duplicate session-parsing wrapper was introduced.

## Owner pages migrated

Each page previously called `const org = await resolveCrmOrganizationId();` and now
derives the organization from the authenticated session:
`const { organizationId: org } = await requireCrmContext();`.

- `app/admin/brain/page.tsx`
- `app/admin/marketplace/page.tsx`
- `app/admin/marketplace/activity/page.tsx`
- `app/admin/marketplace/buyers/page.tsx`
- `app/admin/marketplace/campaigns/page.tsx`
- `app/admin/marketplace/sources/page.tsx`
- `app/admin/marketplace/vendors/page.tsx`

Existing real queries, date/filter behavior, honest empty states and visual design
are unchanged. No new metrics, sparklines or fabricated content were added. The
shared `_MarketplaceNav` and `_MarketplaceDecisionQueue` components are pure
presentational and required no changes.

## API routes migrated

All six routes are classified as authenticated, organization-private dashboard
endpoints. Each was already gated by an RBAC `can(...)` permission check. The
migration adds an explicit authenticated-session guard and derives the
organization from the session instead of the demo resolver:

```ts
const session = await getSession();
if (!session) {
  return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}
const orgId = session.organizationId;
```

- `api/revenue/route.ts` - `can('analytics','view')`; response `{ ok, revenue, orgReady, at }`.
- `api/traffic/route.ts` - `can('analytics','view')`; response `{ ok, traffic, orgReady, at }`.
- `api/live/calls/route.ts` - `can('intelligence','view')`; `?limit` filter preserved.
- `api/live/activity/route.ts` - `can('intelligence','view')`; `?limit` filter preserved.
- `api/live/websites/route.ts` - `can('intelligence','view')`; `?limit` and `?property` filters preserved.
- `api/brain/call-handling-briefing/route.ts` - `can('intelligence','manage')`;
  `?since/until/vendor/buyer/source/campaign` filters preserved.

No API accepts an organization identifier from query string, request body or
headers. All client-supplied parameters are data filters (limit, property, date
window, vendor/buyer/source/campaign), never organization selectors. Repository
reads receive the session-derived `orgId` as their scoping argument, so a request
can only ever read its own organization's records. Response JSON keys, status-code
conventions and the pre-existing `orgReady` empty-state contracts are preserved.

## Cross-org protections

- Organization is re-derived server-side from the authenticated session on every request.
- Unauthenticated API requests return 401; unauthorized (RBAC) requests return 403.
- Detail data is fetched through repository methods scoped by `organizationId`, so
  cross-organization identifiers cannot resolve.
- No global aggregate is returned; every metric is bounded to the session organization.

## Out of scope

- CRM customers/conversations/workflows/analytics pages (handled in PR 1/PR 2).
- `integration-actions.ts` and the `/crm/integrations` reconnection (PR 4).
- Owner navigation remains intentionally withheld until PR 4.
- No Prisma schema, migration, authentication, session or RBAC-matrix changes.

## Deprecated resolver status after PR 3

No production `/app/admin/*` or `/api/*` route consumes
`resolveCrmOrganizationId` / `CRM_ORG_SLUG` any longer. The deprecated exports
remain in `crm-data.ts` only because `integration-actions.ts` still consumes them;
that final consumer is migrated in PR 4, after which the deprecated resolver can be
deleted.

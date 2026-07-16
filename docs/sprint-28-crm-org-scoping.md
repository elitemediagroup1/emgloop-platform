# Sprint 28 blocker — /crm is scoped to a hardcoded demo organization

## Confirmed defect

`apps/web/src/crm/crm-data.ts` resolves the CRM organization from a fixed slug,
not from the authenticated session:

```ts
export const CRM_ORG_SLUG = 'servicesinmycity-demo';

export async function resolveCrmOrganizationId(): Promise<string | null> {
  const org = await prisma.organization.findUnique({
    where: { slug: CRM_ORG_SLUG },
    select: { id: true },
  });
  return org ? org.id : null;
}
```

Every `/crm/*` surface (customers, search, users, integrations, settings, the
real Marketplace revenue queries, etc.) reads through `resolveCrmOrganizationId()`,
so they all read the **demo** organization ("ServicesInMyCity (Demo)") instead of
the signed-in owner’s organization. This is the real reason /crm "feels like a
separate app": it is literally scoped to a different, seeded org.

## Consequence for the Owner shell (Sprint 27 decision)

Mature CRM features must NOT be exposed as canonical Owner navigation until this is
fixed. Sprint 27 therefore did **not** link the Owner sidebar to `/crm/*`. The
following capabilities are intentionally withheld from Owner navigation:

- Employees (real impl: `/crm/users`)
- Integrations (real impl: `/crm/integrations`)
- Settings (real impl: `/crm/settings`, plus the Setup Wizard at `/crm/setup`)
- Global Search (real impl: `/crm/search`)
- CRM (the `/crm` app itself)

The Dashboard’s CRM Overview may remain, because Sprint 24/25 reads real
session-organization data directly (not through `resolveCrmOrganizationId`).

## Sprint 28 scope (the fix)

1. Make CRM reads and actions derive `organizationId` from the authenticated
   session (the same source `/app/admin/*` already uses), removing the hardcoded
   `servicesinmycity-demo` slug.
2. Keep the seed org usable for local development only (behind the dev seed
   utility), never as the production runtime default.
3. After the rewrite, wire Employees, Integrations, Settings, Search, and CRM into
   the Owner shell navigation (they can then safely show the owner’s real data).

This defect is **out of scope for Sprint 27** (Owner Shell Cleanup and
Truthfulness) and must be handled as its own data-layer sprint.

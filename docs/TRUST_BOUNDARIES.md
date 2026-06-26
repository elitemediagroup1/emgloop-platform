# TRUST_BOUNDARIES.md — Data Boundaries

The Trust layer (`packages/brain/src/trust.ts`) governs what data can be seen and
what may cross tenant boundaries. It is the most important safety rule in the
platform.

## Intelligence tiers

1. **Private Tenant Intelligence** — belongs to a single organization. Never
   leaves that organization.
2. **EMG Network Intelligence** — generalized, non-identifying patterns shared
   across EMG-operated organizations.
3. **Generalized Platform Intelligence** — fully generalized, non-identifying
   intelligence available platform-wide.

## The cardinal rule

**No customer records may cross organizations.** Only generalized learning
(aggregate patterns with no identifying data) may be promoted to the network or
platform tier.

## Deterministic evaluation

`evaluateAccess(req)` decides, in order:

1. Same organization -> allowed.
2. Cross-organization AND contains a customer record -> **denied** (always).
3. Cross-organization AND private_tenant tier -> denied.
4. Cross-organization AND network/platform tier (generalized) -> allowed.

Every Brain object carries a `visibility` and is classified into a tier; the
Trust service enforces these rules on every cross-tenant access and audits the
decision.

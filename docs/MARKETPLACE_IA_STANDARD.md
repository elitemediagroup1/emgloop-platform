# Marketplace Workspace IA Standard

This note defines the shared information-architecture (IA) standard for the Marketplace
workspace pages so that Marketplace Overview, Campaign Intelligence, Buyer Operating
System, Source / Publisher Operating System, and Vendor Operating System behave as one
cohesive application rather than five pages built at different times.

It was established in PR #63 (Marketplace Workspace Consistency Pass). It is a
presentation / read-only standard: it does not change data, calculations, repositories,
APIs, schema, the Brain, or CallGrid ingestion.

## Scope

Applies to every page under `apps/web/src/app/app/admin/marketplace/`:

- `page.tsx` (Marketplace Overview / Command Center)
- `campaigns/page.tsx` (Campaign Intelligence)
- `buyers/page.tsx` (Buyer Operating System)
- `sources/page.tsx` (Source / Publisher Operating System)
- `vendors/page.tsx` (Vendor Operating System)

All pages are read-only server components using the Loop OS design system introduced in
PR #57. They compose existing repositories only and never fabricate data.

## Page header

Every workspace opens with the Loop OS brief header: an eyebrow lead label naming the
workspace, a one-line summary derived from real data, and a Today chip. No page-specific
header variants.

## Section order

Sub-workspace pages follow the same top-to-bottom order:

1. Executive summary (header brief).
2. Overview modules (six metric modules).
3. Directory / ranked lists.
4. Top-entity detail preview.
5. Quality / fulfillment (real metrics when the repository exposes them; otherwise a
   premium empty state that names the missing data).
6. Recent activity.
7. Brain placeholder (no Brain execution).

## Decision Queue

The "What to review next" card is derived only from facts already present in the data
(idle entities, low-quality entities, unattributed calls, volume leaders). When nothing
is surfaced it shows the "Nothing needs review" empty state.

## Right rail

Every page uses the same rail, in this order, with Title-Case card titles:

- Live Calls
- Integration Status
- Shortcuts

## Shortcuts

The Shortcuts card links to the other Marketplace workspaces (the current page is
excluded) in this canonical order, using these canonical labels:

- Marketplace overview -> /app/admin/marketplace
- Campaign Intelligence -> /app/admin/marketplace/campaigns
- Buyer Operating System -> /app/admin/marketplace/buyers
- Source / Publisher Operating System -> /app/admin/marketplace/sources
- Vendor Operating System -> /app/admin/marketplace/vendors

## Brain link

The Brain placeholder "Open Brain" link points to `/app/admin/brain` on every page.

## Empty states

Missing data always renders a premium empty state (loop-empty) with a short title and a
body that explains what is missing. Data is never fabricated to fill a section.

## Status tones

Tones use the Loop OS `Tone` union: good, warn, crit, idle. Badges use loop-badge--idle
for the Standby / placeholder state (loop-badge--warn does not exist).

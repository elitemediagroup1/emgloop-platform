# Admin Command Center v2 — Decision-First Operating System (PR #52)

Presentation-only evolution of the Admin dashboard into a Mission Control surface.

## Intent

When an administrator opens the dashboard they should immediately understand:

- What needs attention
- What is healthy
- What changed
- Where to go next

The interface prioritizes decisions over statistics. It presents; it does not compute.

## What this PR changes

- `apps/web/src/app/app/admin/page.tsx` — rebuilt as a decision-first layout:
  - Executive summary hero with a time-based greeting and a single status banner.
  - Six operating-system modules (Marketplace, Revenue, Operations, Businesses, Creator Network, Brain).
  - A "Needs attention" panel that surfaces items from existing data only.
  - Marketplace rendered as pure-CSS comparison bars (no chart or JS libraries).
  - An Executive Briefing placeholder that waits for the Brain (never invokes it).
  - Quick Actions styled as application launchers.
- `apps/web/src/app/loop-os.css` — additive v2 styles (modules, banners, bars, launchers, responsive breakpoints). No existing rules removed.

## Data sources (all existing, read-only)

- `revenueIntelligence.revenueByDimension`
- `revenueIntelligence.trafficIntelligence`
- `liveOperations.listLiveCalls`
- `liveOperations.listLiveActivity`
- `loadProviderCards` + `computeSystemHealth` + `connectionLabel`

Every value shown is read from these repositories. "Needs attention" items are surfaced
from data that already exists (integration errors, warnings, providers needing setup,
unattributed calls). Nothing new is calculated beyond display formatting.

## Guarantees

- No Brain logic changed. The Brain is never invoked from this page.
- No Marketplace Intelligence contracts changed.
- No API, database, Prisma, repository, routing, authentication, or permission changes.
- No fabricated metrics, no fake recommendations, no placeholder numbers.
- When data is unavailable, the UI shows premium empty or waiting states.

Draft only. Do not merge.

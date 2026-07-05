# Loop OS - Admin Command Center (PR #51)

Presentation-only PR. Transforms the Admin dashboard from placeholder cards
into a read-only Executive Command Center that answers one question:
**"What deserves my attention right now?"**

## Product posture

Summary first, explanation second, details third. Healthy systems stay quiet;
anything that needs a decision rises. The Command Center **only presents** -
it never computes new intelligence and never writes.

## What it consumes (all existing, read-only)

- `revenueIntelligence.revenueByDimension(orgId)` - Revenue / Profit today
- `revenueIntelligence.trafficIntelligence(orgId)` - Marketplace health, top campaigns / buyers / sources / vendors
- `liveOperations.listLiveCalls(orgId, limit)` - Live Calls + recent calls feed
- `liveOperations.listLiveActivity(orgId, limit)` - Recent Brain / live activity feed
- `loadProviderCards(orgId)` + `computeSystemHealth(cards)` - Integration OS status

All reads go through the existing `loadOrFallback(...)` helper. When the org is
not provisioned (or the DB is not configured) each section renders a premium
skeleton or an explanatory empty state - never fabricated numbers.

## Brain Briefing

The Brain Briefing section shows a premium **"Waiting for Brain"** state and
links to `/app/admin/brain`. By design the dashboard:

- does **not** run Brain flows on page load
- does **not** compute new BrainActivity
- does **not** call `assembleAndRunCallHandlingFlow`

Briefings will appear here once they are persisted and readable. The Brain
already computes; this dashboard only presents.

## Layout

- **Top:** Business Health, Marketplace Health, Revenue Today, Profit Today, Live Calls, Critical Alerts
- **Row 2:** Today's Brain Briefing, Top Recommendations, Top Risks, Top Opportunities
- **Row 3:** Marketplace Overview, Top Campaigns, Top Buyers, Top Sources, Top Vendors
- **Side band:** Recent Brain Activity, Recent Live Calls, Integration Status
- **Bottom:** Quick Actions (Review Marketplace, Review Revenue, Review Live Calls, Creator Queue, Businesses, Settings)

Each card links to its existing page. No card wires or writes data.

## Guarantees

- No backend, API, database, or schema changes
- No new calculations beyond display formatting (currency / number / relative time)
- No Brain logic changes; no Marketplace Intelligence contract changes
- No CallGrid ingestion changes
- Visual language continues PR #50 (`loop-*`); new classes are additive (`loop-cc`, `loop-metric`, `loop-panel`, `loop-waiting`, `loop-feed`, ...)

## Files

- `apps/web/src/app/app/admin/page.tsx` - the Command Center (read-only server component)
- `apps/web/src/app/loop-os.css` - additive Command Center styles
- `docs/LOOP_OS_ADMIN_COMMAND_CENTER.md` - this document

Draft PR only. Do not merge.

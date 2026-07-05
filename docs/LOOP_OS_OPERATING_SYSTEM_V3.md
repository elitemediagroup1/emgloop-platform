# EMG Loop OS v3 - Operating System (PR 53)

Presentation-only transformation of the admin surface into a decision-first
"operating system" dashboard. No backend, API, Brain, Marketplace, Prisma,
repository, routing, permission, or authentication changes.

## Goal

When an administrator opens Loop, they should answer four questions in under
five seconds:

1. Is my business healthy?
2. Does anything need my attention?
3. Where is money moving?
4. What should I do next?

## What changed

- Executive hero with time-based greeting and a single status banner.
- Six operating modules (Marketplace, Revenue, Operations, Businesses,
  Creator Network, Brain) with icon, status dot, one metric, one detail,
  and a decorative CSS/SVG sparkline. Each links to its workspace.
- "Needs Attention" panel surfaced only from existing readable signals
  (integration errors/warnings/needs-setup, unattributed calls). Quiet when
  healthy.
- Marketplace overview with pure-CSS progress bars and four ranked lists.
- Persistent right rail: Executive Briefing placeholders (Brain not invoked),
  Recent Activity, Live Calls, Integration Status pills grouped by state.
- Quick Actions rendered as application launchers.

## Guarantees

- Data is only displayed, never computed or fabricated. Unknown values render
  as premium empty/idle states (em-dash, "Standby", "No data yet").
- The Brain remains the only component that computes intelligence; this PR
  presents placeholders and links to it.
- Pure CSS visuals only; no chart or animation libraries.
- Additive CSS block appended to loop-os.css; no existing rules removed.

## Files

- apps/web/src/app/app/admin/page.tsx
- apps/web/src/app/loop-os.css (additive v3 block)
- docs/LOOP_OS_OPERATING_SYSTEM_V3.md

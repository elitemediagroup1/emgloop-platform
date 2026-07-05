# EMG Loop OS — v4 Experience Refinement (PR #54)

Presentation-only refinement of the Admin Operating System page.
This PR elevates hierarchy, spacing, typography, and motion so EMG Loop
feels like an operating system rather than a dashboard.

## Scope

- Files changed: presentation only.
  - apps/web/src/app/app/admin/page.tsx (adds v4 root class, banner copy refinement)
  - apps/web/src/app/loop-os.css (additive v4 refinement block, scoped to loop-os--v4)
  - docs/LOOP_OS_EXPERIENCE_V4.md (this file)

## What changed

- Executive hero uses larger, calmer type with more breathing room.
- Status banner reads as a single executive takeaway.
- Operating modules feel like launchable applications with soft hover elevation.
- Needs Attention is now an inbox-style list of comfortable rows.
- Marketplace overview uses larger progress bars and lighter rankings.
- Quick Actions behave like application launchers with keyboard focus rings.
- Right rail is persistent and visually secondary.
- Subtle CSS-only entrance motion, with prefers-reduced-motion respected.

## Guarantees

- No backend, API, database, Prisma, repository, Brain, Marketplace, CallGrid,
  routing, authentication, or permission changes.
- No fabricated data. Every value continues to come from existing data sources.
- Pure CSS visuals. No chart or animation libraries added.
- Additive CSS only. Existing rules are not removed.

## Deliberately out of scope

- The left sidebar and universal search live in the shared WorkspaceShell,
  which is used by every workspace. They were intentionally left untouched
  so this refinement does not affect other workspaces. A future PR can bring
  the macOS-style sidebar and Spotlight search treatment to the shared shell.

## Verification

- Existing routes unchanged.
- Existing permissions unchanged.
- Brain untouched (presented only, never computed).
- Marketplace logic untouched.
- Preview green. Leave Draft. Do not merge.

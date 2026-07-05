# Loop OS — Premium Experience (PR #48)

PR #48 is a **presentation-only** upgrade of the Loop OS shell introduced in
PR #47. It does not change authentication, routing, permissions, the Brain,
Marketplace Intelligence, the database, or any backend logic. It introduces a
new premium **dark** theme scoped strictly to the universal login (`/`) and the
workspace shells (`/app/*`). The existing CRM styling is untouched.

## What changed

- **New theme** `apps/web/src/app/loop-os.css` — a self-contained dark theme in a
  new `loop-*` class namespace. It never overrides `crm-*` or `ds-*` classes.
  All motion is CSS-only (keyframe fades, hover transitions, a decorative SVG
  network motif). No JS animation libraries and no new dependencies. Honors
  `prefers-reduced-motion`.
- **Login (`app/page.tsx`)** — redesigned into a split-screen front door: brand,
  headline, Monitor / Understand / Decide / Execute, and a decorative “OS ready”
  strip (Brain / Marketplace / CRM / Creator Studio) on the left, with a premium
  authentication card on the right. The form, its server action
  (`loopLoginAction`), fields, remember-me, error handling and demo-credential
  prefill are all unchanged.
  > The “OS ready” strip is purely decorative: no live system checks, no delay,
  > and it never gates sign-in.
- **`WorkspaceShell.tsx`** — restyled with the new theme and a sectioned sidebar.
  Config-driven navigation, permission dimming via `hasPermission`, and
  `logoutAction` are preserved exactly.
- **`ShellPage.tsx`** — premium empty states; prop contract unchanged.
- **`workspaces/config.ts`** — Admin navigation regrouped into **OPERATING
  SYSTEM**, **WORKSPACES**, **SYSTEM**. The nav label “Marketplace Intelligence”
  is shortened to **Marketplace** (the page title is unchanged). Every `href`,
  `icon`, and `requires` is preserved — no route or permission changed.
- **`app/app/admin/page.tsx`** — a premium placeholder dashboard. No data wired.
- **`app/app/layout.tsx`** — imports `loop-os.css` so the theme applies to
  `/app/*`.

## Guarantees

- No auth / routing / permission / backend / Brain / database changes.
- No CRM CSS changes (the `loop-*` namespace is additive and isolated).
- Verified: all 13 admin nav hrefs and their permission gates are identical to
  PR #47; only grouping and one label changed.

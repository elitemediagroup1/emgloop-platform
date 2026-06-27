# EMG Loop — Operating System Design Language

Sprint 13 establishes the permanent visual language for EMG Loop. The platform is
no longer "CRM-first" — it is **Brain-first**. CRM, Analytics, AI Employees,
Workflows, Revenue, Integrations and Portals are all interfaces into the EMG Brain,
and the interface communicates this.

This sprint is **presentation-layer only**. No business logic, repository logic,
Prisma schema, workflows, providers, Brain logic, APIs, authentication, permissions
or CRM behavior were changed. Everything functions exactly as before.

## Where it lives

- `apps/web/src/app/crm/design-system.css` — design tokens + component upgrades,
  loaded last in `crm/layout.tsx` so it layers over the existing theme.
- `apps/web/src/app/crm/_brand/Logos.tsx` — EMG Loop wordmark/glyph + Elite Media
  Group mark (dependency-free inline SVG).
- `apps/web/src/app/crm/_brand/SidebarIcon.tsx` — line-icon set (no npm deps).
- `apps/web/src/app/crm/layout.tsx` — the left-sidebar Operating System shell.
- `apps/web/src/app/crm/page.tsx` — the executive command center.
- `apps/web/src/app/crm/intelligence/page.tsx` — the signature Brain page.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| `--crm-bg` | `#0B0F14` | App background |
| `--crm-panel` | `#111827` | Panels |
| `--crm-card` | `#151D29` | Cards |
| `--crm-hover` | `#1C2636` | Hover surfaces |
| `--crm-accent` | `#22D3EE` | Electric-cyan primary accent |
| `--crm-green` / `--crm-revenue` | `#34D399` | Success / revenue (emerald) |
| `--crm-amber` | `#F5B544` | Warning |
| `--crm-red` | `#F2545B` | Error / crimson |
| `--crm-navy` → `--crm-teal` | `#1B2A6B` → `#2E9B9B` | Brand gradient (from the logos) |

Typography is **Inter**. Geometry uses a 12px default radius, soft elevation
shadows, and a `160ms` ease for transitions. `prefers-reduced-motion` is honored.

## Primitives

Tokens re-skin every existing shared class (`.crm-panel`, `.crm-card`,
`.crm-table`, `.crm-btn`, `.crm-input`, `.crm-status`, `.crm-tabs`, `.crm-chip`).
New opt-in primitives (`ds-*`) are available for redesigned pages: page headers,
KPI grids, cards, recommendation rows, live-activity feeds, health rows,
empty/loading/skeleton states, toasts, the Brain pipeline flow, and a footer.

## Information architecture

The sidebar groups navigation as **Intelligence** (Overview, Brain, Analytics,
Integrations), **Operations** (Customers, Conversations, Pipeline, Calendar, AI
Employees, Workflows), **Growth** (Revenue, Organizations, plus Creators and
Business Portal as "coming soon" placeholders), and **Workspace** (Team, Settings).
The footer surfaces Brain Status and System Health; the app bar carries a ⌘K
command-bar affordance.

## Brand usage

The EMG Loop wordmark appears in the sidebar header and the login card. The Elite
Media Group mark appears in the login footer. Both are vector components and scale
crisply at any size.

## Empty states

Empty states never say "No data." They use platform language, e.g. "The Brain is
waiting for its first signal." This reinforces the operating-system experience.

# Loop Application Structure — Decision Record

**Status:** Approved by Matt, 2026-09-14. Locked. Reopening any decision below requires an explicit
architecture change, not an implementation convenience.

**Scope:** the authenticated application at `app.emgloop.com`: landing, shell, navigation, route map
and redirects, for every module. Not CRM alone, not the sidebar alone.

## Context

EMG Loop is one application. An audit of `main` at `8adef06` found it behaving like several:

- Normal sign-in landed on `/crm` (the CRM Command Center). `loginAction` redirected to `/crm`, which
  became a page in #226 instead of a redirect to `/app`.
- `/app` never rendered; it redirected each role to its own workspace home.
- One shell component (`WorkspaceShell`) was fed by six nav registries (`CRM_SHELL` plus five role
  workspaces), so entering CRM replaced the whole sidebar.
- Surfaces lived in two URL trees (`/crm/*`, `/app/<role>/*`), with duplicates (two Brains, two Work
  Types pages, three CallGrid configuration entry points) and catch-all routes that render a page for
  any unknown path.
- Several `/app/admin` pages had no authorization of their own; the `requireWorkspace('ADMIN')` layout
  was their only boundary. Work OS has no RBAC resource; its authority is the workspace role.

## Decisions

### D1 — Module prefixes

Canonical authenticated modules:

| Module | Prefix |
|---|---|
| Loop Home | `/app` |
| CRM | `/app/crm` |
| Intelligence | `/app/intelligence` |
| Work OS | `/app/work` |
| Creator Hub | `/app/creator` |
| Accounting | `/app/accounting` |
| Administration | `/app/administration` |

`/app/admin` is not reused as a canonical prefix.

### D2 — Legacy Customer records

`/app/crm/people` and `/app/crm/people/[id]`. The user-facing noun is **People**. Record pages keep
the explicit "Person / Intake Record" framing, so a legacy Customer is not presented as the future
canonical Person Party.

### D3 — Surface placement

- **CRM:** Command Center; People; Relationships (Soon); Opportunities (Soon); Campaigns (Soon);
  Conversations; Intake; Activity; Search; CRM Automations.
- **Intelligence:** Headlines; Your Queue; Brain; CallGrid Intelligence; Analytics; Traffic; Revenue
  Intelligence; Live Operations (Activity, Calls, Websites); governed CI cases and details.
- **Work OS:** My Work; Team Queue; Work Types; future Work OS Workflows.
- **Creator Hub:** the existing honest unavailable state until built.
- **Accounting:** the existing honest unavailable state until built.
- **Administration:** Team; Workspace; Settings; Setup (where required); Objectives; Audit; AI
  Employees; Integrations; CallGrid configuration and diagnostics.

CRM Automations and Work OS Workflows are different authorities and stay distinct. CRM Search stays
CRM-scoped unless a global Loop search is deliberately built.

### D4 — Duplicates are consolidated

- **Brain:** one canonical Brain under Intelligence, preserving distinct useful functionality and data
  from both existing pages.
- **Work Types:** one Work OS Work Types experience. Read and start for those with that authority;
  management controls stay permission-gated. No authority is broadened.
- **CallGrid configuration:** one Administration → Integrations → CallGrid tree, with no loss of
  functionality.

### D5 — One application for every role

Owner, Admin, Manager, Employee, AI Employee and Read Only all enter the unified application at
`/app`. Loop Home and the single nav registry are filtered by existing permissions and existing
role/module authority. No permission is broadened. Read Only is not isolated in a Client placeholder
because of its role; it sees only what it is authorized to see. No separate visual application exists
for any role. Unreachable Business Owner and Creator workspace shells are retired once safe; Creator Hub
remains a module.

### D6 — Development review page

`/app/admin/review` is development-only. It is removed from the production route tree. If kept for
developers, it lives only in a mechanism that cannot become a production data surface, with no new
production URL.

### D7 — Legacy redirects

Ordinary legacy route redirects are kept for at least 12 months. Invitation acceptance and password
reset legacy URLs are supported indefinitely, because issued emails contain them. Every redirect goes
directly to its final canonical destination (no chains), preserves safe query parameters and tokens
where required, never broadens authorization, and is covered by loop and chain tests.

### D8 — PR #235

Not merged standalone. Its grouping, destination permission map, tests and navigation work are reused
in the unified-shell PR, which closes and supersedes it. The interim experience of a Loop sidebar
linking into a second CRM sidebar is not shipped.

## Implementation invariant

Every PR leaves `main` deployable, usable and authorization-safe. No intermediate merge removes an
authorization boundary that a parent layout supplied: a page protected only by
`requireWorkspace('ADMIN')` receives equivalent explicit module or page authority before, or in the
same PR as, any change to that layout protection. No temporary access widening, and no reliance on a
later PR to restore authorization. No stacked PRs without explicit approval.

Each PR: cut from fresh `main`; implement only its scope; run full validation; inspect for
authorization widening and redirect loops; open the PR; stop at the merge checkpoint; after merge,
verify `main` by content before starting the next.

## Sequence

The order changes only if implementation proves a dependency makes it unsafe, in which case work
stops and the dependency is explained.

| PR | Scope | Status |
|---|---|---|
| 1 + 2 | Sign-in lands on Loop (login, already-signed-in login and root go to `/app`; safe deep links survive; `/app` renders Loop Home) **and** one shell, one registry (`LOOP_NAV`); explicit authority on every role-guarded page; supersedes #235 and #236 | In review (one PR) |
| 3 | Route authority: route module, redirect table, public auth routes, `/app/unauthorized`, edge gate for `/app` | Not started |
| 4 | Administration → `/app/administration` | Not started |
| 5 | Intelligence → `/app/intelligence` | Not started |
| 6 | Work OS → `/app/work` | Not started |
| 7 | CRM → `/app/crm` | Not started |
| Final | Retire old registries, layouts and placeholders; reconcile documentation | Not started |

**Sequence change — PR 1 and PR 2 ship as one PR (Matt, 2026-09-14).** Landing on `/app` was only usable
once the single shell existed: before it, `/app` showed each role's old workspace shell, where the
Owner/Admin/Manager sidebar's CRM item opened a placeholder and Employee and Read Only had no path to the
CRM at all. So #236's landing work was carried unchanged into the shell PR, cut from `main` (not stacked),
and landing and shell merge together. #235 and #236 close as superseded.

## Current state (after PR 1 + 2)

**Landing.**
- The landing authority is `apps/web/src/auth/landing.ts`: `LOOP_HOME`, `safeNextPath`,
  `postLoginDestination`, `loginPathFor`.
- A requested destination survives sign-in only if it is a same-origin path into `/app` or `/crm` and
  is not an authentication screen. Everything else goes to `/app`. The destination still enforces its
  own authorization.
- `/app` renders Loop Home. Owner, Admin and Manager see the operational overview, which enforces
  `requireWorkspace('ADMIN')` itself. Everyone else sees the areas of Loop they can open.
- Every role authority's `home` is `/app`, so a wrong-authority redirect lands on a page that renders.

**Shell and navigation.**
- One shell: `WorkspaceShell`. It takes only the session and always renders the one registry,
  `LOOP_NAV` (`apps/web/src/workspaces/config.ts`). Every signed-in surface mounts it: Loop Home, the
  role-guarded `/app` trees and `/crm`. The CRM has no sidebar of its own; its entries are the CRM area of
  `LOOP_NAV` and open the real CRM under `/crm`.
- The shell shows the person: their name and role in the sidebar foot, and their name at the root of the
  breadcrumb. No role- or workspace-branded label.
- Each item states the authority its destination enforces: `requires` for the page's
  `requirePermission`, and `workspace` for its route tree's `requireWorkspace`. The shell hides what a
  person cannot open. Permissions resolve through `IamRepository.canEach`, which applies the same rules
  as `can()` in one read.
- Every page in a role-guarded tree (`/app/admin`, `/app/employee`, `/app/client`, `/app/business`,
  `/app/creator`) enforces that authority itself, as its first awaited call. The five former role-home
  pages are the exception: each only redirects to Loop Home. Tree layouts still guard too, as defence
  in depth; they are no longer the only boundary.

**Left for PR 3.**
- Legacy addresses with no page still render an honest "not available" state inside the shell rather
  than redirecting:
  - `/app/admin/crm`;
  - the old placeholder items in the Employee and Client trees;
  - any other catch-all path.
- The `/app/<role>` home URLs redirect to `/app` from their pages. The redirect table replaces these
  handlings with direct redirects.

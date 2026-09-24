# Loop Application Structure — Decision Record

**Status:** Approved by Matt, 2026-09-14. Locked. Reopening any decision below requires an explicit
architecture change, not an implementation convenience.

**Amended 2026-09-15 by Product decisions C-01 to C-04** (Loop Product and UI Architecture v1.0 conflict
resolution; the specification is `docs/product/loop-product-ui-architecture-v1.0.md`). D1, D2, D3, D4 and
D5 below are the amended decisions. The text they replaced is named under each one and is no longer a
decision. D6, D7, D8 and the implementation invariant are unchanged. The amendments are information
architecture only. They move no route during Identity 2.0 or 2.0b and rename no backend authority.
Identity semantics (C-04) and identity posture (C-05) are recorded in
`docs/architecture/identity-evidence-resolution.md`.

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

### D1 — Operating areas and prefixes (amended by C-01, C-02)

Loop has **five internal operating areas: Home, CRM, Work, Intelligence and Operations.**

| Area | Prefix |
|---|---|
| Home | `/app` |
| CRM | `/app/crm` |
| Work (Work OS) | `/app/work` |
| Intelligence | `/app/intelligence` |
| Operations | not yet decided; set by the route-transition proposal |

These are not peer areas:

- **Administration.** Workspace, Team, Settings, Setup, Audit, AI Employees, Integrations, and permissions
  and governance are system/workspace settings or contextual administration.
- **Accounting.** It remains its own domain and is surfaced contextually.
- **Creator Hub** (C-02). See D5.

`/app/admin` is not reused as a canonical prefix.

**Route transition.** Nothing moves during Identity 2.0 or 2.0b. Charlie and Lexi own the
route-transition proposal: where Operations, the system/workspace settings, contextual Accounting and
Operations → Creators live, and how routes move from where they are today. Product approves it before
any route moves. Until then every existing route stays where it is.

*Replaced:* the 2026-09-14 seven-module table, which made Creator Hub (`/app/creator`), Accounting
(`/app/accounting`) and Administration (`/app/administration`) peer modules.

### D2 — People, Companies and Intake Records (superseded by C-04)

- **People** are established, non-superseded PERSON Parties.
- **Companies** are established, non-superseded COMPANY Parties.
- **Intake** is entry into a commercial process.
- `/app/crm/people` is reserved for PERSON Parties. It never lists Customer rows.
- **Legacy Customer records are Intake Records.** Their exact route is part of the route-transition
  proposal (D1).
- Customer is transitional Intake infrastructure. Customer ≠ Person ≠ Party. An Interaction, a caller
  ID, an anonymous visitor and an Intake record are each not a Person. **FACT ≠ IDENTITY ≠ INTAKE.**
- An existing screen that falsely presents Customer rows as People may receive only the smallest
  semantic wording correction. This includes the People label on `/crm/customers` and the former D2
  "Person / Intake Record" framing.
- No Customer record is deleted, purged, migrated or relinked, and `customerId` systems are not
  rewritten.

The identity rules behind this are in `docs/architecture/identity-evidence-resolution.md` §10–11.

*Replaced:* legacy Customer records at `/app/crm/people` under the noun People, with a
"Person / Intake Record" framing.

### D3 — Surface placement (amended by C-01, C-02, C-03)

- **Home:** Loop Home.
- **CRM:**
  - Command Center; People; Companies; Relationships; Opportunities; Campaigns; Activity.
  - Conversations; Intake Records; Search; CRM Automations.
  - An area whose governing authority is not built is an unavailable item or an honest Unknown state,
    never a stand-in.
- **Work:** My Work; Team Queue; Work Types; future Work OS Workflows.
- **Intelligence:** Headlines; Your Queue; governed CI cases (investigations), findings,
  recommendations, decisions and monitoring; Brain; analytical and interpretive CallGrid surfaces
  (CallGrid Intelligence); Analytics; Traffic; Revenue Intelligence.
- **Operations:**
  - **CallGrid:** its operational surfaces, meaning live execution, routing, operational configuration,
    reconciliation, diagnostics and health (C-03).
  - **Creators:** internal creator administration (C-02).
  - Future operational modules.
- **System/workspace settings and contextual administration** (not a peer area): Workspace; Team;
  Settings; Setup (where required); Audit; AI Employees; Integrations, which for CallGrid holds only
  credentials, connection state and integration governance (C-03); permissions and governance.
- **Accounting:** its own domain, surfaced contextually. It keeps the existing honest unavailable state
  until built.
- **Placed by the route-transition proposal:**
  - Objectives. D3 had placed them under Administration. Their `commercialIntelligence` authority is
    unchanged.
  - Live Operations (Activity, Calls, Websites). The proposal applies the C-01 area definitions and the
    C-03 authority test: live execution and health go to Operations, analysis and interpretation to
    Intelligence.

CRM Automations and Work OS Workflows are different authorities and stay distinct. CRM Search stays
CRM-scoped unless a global Loop search is deliberately built. The specification's governed universal
search is that deliberate build, and it is not yet authorized.

*Replaced:* Creator Hub, Accounting and Administration as peer placements; CallGrid configuration and
diagnostics under Administration; Live Operations and Objectives as fixed placements; the People row
as legacy Customers (D2).

### D4 — Duplicates are consolidated (amended by C-03)

- **Brain:** one canonical Brain under Intelligence, preserving distinct useful functionality and data
  from both existing pages.
- **Work Types:** one Work OS Work Types experience. Read and start for those with that authority;
  management controls stay permission-gated. No authority is broadened.
- **CallGrid:** split by authority, with no duplicate CallGrid tree and no loss of functionality.
  - Operations → CallGrid holds the operational surfaces.
  - Intelligence holds the analytical and interpretive surfaces.
  - System/workspace administration (Integrations) holds only credentials, connection state and
    integration governance.
  - No surface appears in more than one of these places.

*Replaced:* one Administration → Integrations → CallGrid tree.

### D5 — One application for every role (amended by C-02)

Owner, Admin, Manager, Employee, AI Employee and Read Only all enter the unified application at
`/app`. Loop Home and the single nav registry are filtered by existing permissions and existing
role/module authority. No permission is broadened. Read Only is not isolated in a Client placeholder
because of its role; it sees only what it is authorized to see. No separate visual application exists
for any role. Unreachable Business Owner and Creator workspace shells are retired once safe.

**Creator Hub is not a module and not a peer area.**
- Internal creator administration is Operations → Creators.
- `/app/creator` may remain as a transitional route.
- There is no second Creator application.
- A managed creator is a Person with creator participation and capability. Creator is not a Party type.
- External participant authentication, participant memberships, participant portals and multi-org
  sign-in are **not authorized**. The specification's responsive participant experiences stay out of
  scope until Product authorizes them.

*Replaced:* "Creator Hub remains a module".

**Amended 2026-09-22 (Creator Hub functional demo, Matt's instruction).** Exactly one participant
type now has its own login inside the ONE application: a managed creator, `SystemRole.CREATOR`, a
member of the same organization that manages them. It is not a portal, not a second application and
not multi-org sign-in: the creator enters at `/crm/login`, lands on Loop Home, and sees the one
`LOOP_NAV` filtered to the creator group (`/app/creator/*`, transitional route kept). A CREATOR holds
nothing in the permission matrix; what they may read or change is authorized by the `CreatorProfile`
bound to their login, resolved from the signed session. Operations → Creators (`/app/admin/creator-hub`)
is the EMG side of the same objects. Everything else in D5 stands: no participant memberships, no
participant portal, no multi-org sign-in.

**Amended 2026-09-24 (the rail folds; approved).** One shell and one registry stand; what changes is
how much of `LOOP_NAV` is primary. Each group leads with its primary items and keeps the rest behind
one disclosure row, as data in the registry (`NavGroup.fold`, `NavItem.folded`), never a code branch:
- Home: Home, Mail, Connections, all primary.
- CRM: People, Relationships and the Command Center primary; the intake tools fold ("Intake tools").
- Work: My Work primary for every role that has a queue (ADMIN and EMPLOYEE alike; final); Team Work
  and Work Types fold ("Team work & types").
- Intelligence, Operations and Administration fold entirely: the group label is the row. Headlines
  stays registered under Intelligence (a real page; the breadcrumb resolves through the registry) and
  Loop Home links to it directly.
- The creator seat does not fold. The phone's area bar (`areaEntries`, `AreaBar`) is unchanged.

A fold is open exactly when the page shown is inside it, on the server and the first client render
alike; a person's own open/closed choice is a per-browser convenience (`localStorage`,
`loop.nav.folds`), never state the shell trusts. Nothing unbuilt is in the rail any more: the `soon`
items (Opportunities, Campaigns, Work OS Workflows) are removed from `LOOP_NAV`, and the Command
Center's Upcoming list is where what is coming is named; the `soon` mechanism stays so an unbuilt
destination can never be offered as a link. Nav visibility is still not authorization: every
destination enforces its own.

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
| 1 + 2 | Sign-in lands on Loop (login, already-signed-in login and root go to `/app`; safe deep links survive; `/app` renders Loop Home) **and** one shell, one registry (`LOOP_NAV`); explicit authority on every role-guarded page; supersedes #235 and #236 | Merged (#237) |
| 3 | Route authority: route module, redirect table, public auth routes, `/app/unauthorized`, edge gate for `/app` | Not started |
| 4 | ~~Administration → `/app/administration`~~ superseded by C-01; replanned from the route-transition proposal | Awaiting proposal |
| 5 | Intelligence → `/app/intelligence` | Awaiting proposal |
| 6 | Work OS → `/app/work` | Awaiting proposal |
| 7 | CRM → `/app/crm` | Awaiting proposal |
| Final | Retire old registries, layouts and placeholders; reconcile documentation | Not started |

**Sequence change — C-01 (Product, 2026-09-15).** PRs 4–7 and Final are replanned from Charlie and Lexi's
route-transition proposal once Product approves it. PR 4's Administration prefix no longer exists as a
peer area. PR 3's route-authority mechanics are not superseded, but its canonical destinations for any
surface whose area changed come from the approved proposal. No route moves during Identity 2.0 or 2.0b.

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

## Decisions log

| Date | Decision |
|---|---|
| 2026-09-14 | D1–D8 approved and locked (Matt) |
| 2026-09-14 | PR 1 and PR 2 ship as one PR (#237) |
| 2026-09-15 | **C-01:** the five operating areas (Home, CRM, Work, Intelligence, Operations) supersede the parts of D1/D3 that made Creator Hub, Accounting and Administration peer areas. Administrative capabilities become system/workspace settings or contextual administration; Accounting stays its own domain, surfaced contextually. Information architecture only: no route migration during Identity 2.0/2.0b, no backend authority renamed. Charlie and Lexi own the route-transition proposal |
| 2026-09-15 | **C-02:** Creator Hub is not a peer area. Internal creator administration is Operations → Creators; `/app/creator` may remain transitional; no second Creator application; external participant authentication, memberships, portals and multi-org sign-in are not authorized |
| 2026-09-15 | **C-03:** CallGrid is split by authority. Operations → CallGrid holds operational surfaces; Intelligence holds analytical and interpretive surfaces; system/workspace administration holds only credentials, connection state and integration governance. No duplicate tree; D3 and D4 amended; no route moves in Identity 2.0/2.0b |
| 2026-09-15 | **C-04:** D2 superseded. People = established, non-superseded PERSON Parties; Companies = established, non-superseded COMPANY Parties; legacy Customer records are Intake Records; `/app/crm/people` reserved for PERSON Parties. Detail in `identity-evidence-resolution.md` |
| 2026-09-15 | **C-05:** "identity confidence" in the specification means governed identity posture, never a number. Recorded in `identity-evidence-resolution.md`; no effect on this record |
| 2026-09-24 | **The rail folds** (amends D5): each `LOOP_NAV` group leads with its primary items, the rest behind one disclosure row (`NavGroup.fold`, `NavItem.folded`); My Work stays primary; Intelligence, Operations and Administration fold whole; the `soon` items are removed (the Command Center's Upcoming names them) and the mechanism kept; creator seat and phone area bar unchanged |
| 2026-09-24 | **Home is the front door** (amends D5): Loop Home composes existing authorities in a fixed order — Executive KPIs (the CallGrid Command Center context, elapsed-matched; the partial-day-vs-complete-day scorecard is retired), Your briefing (the pure composer), Headlines (the `Headline` authority + its Case), Your day / Needs you / Recent activity, and domain tiles offered only where the rail offers the destination and a domain read exists. Home owns presentation and composition; it holds no table, prompt, permission or lifecycle. The Headlines page is the canonical workspace; its Current / Under investigation / History sections are a pure projection over Headline × Case, never a Headline state. |

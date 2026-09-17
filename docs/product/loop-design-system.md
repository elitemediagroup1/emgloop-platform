# The Loop design system: one visual language for the whole product

**Status (2026-09-17): the decision, the reconciliation behind it, and the migration order.**
- **Where it is being implemented:** UI-1 (#282), which is revised by this record.
- **Visual authority:**
  - Charlie and Lexi's *Loop Product and UI Redesign — Implementation Handoff* (2026-09-16);
  - five prototype screenshots Matt shared on 2026-09-17.
- **Governing decision** (Matt, 2026-09-17): the redesign is Loop's **global** design system. Loop
  must look like one product; People and Relationships must not look like a different application
  from Home.

## 0. Locked (Matt, 2026-09-17)

**The global design-system question is resolved.**
- **Desktop:** a navy navigation rail, a light top bar and a light content canvas.
- **Mobile:** the handoff's responsive treatment:
  - a light header with Menu;
  - the full navigation as a light sheet when Menu is open;
  - the five operating areas in a fixed bottom bar.

  It is not a reproduction of the desktop sidebar.
- **Every product surface:** the same global tokens, typography, components, states and visual
  language.
- **No separate dark or light themes by product area.** Dark colour is allowed where the system uses it
  (the rail, the primary action). What is ruled out is a section of Loop running under a different
  visual system.

## 1. The decision

**One foundation.** Loop has one design foundation:
- **One set of tokens,** `--loop-*`, defined once on `:root` in `apps/web/src/app/loop-os.css`, with the
  handoff's values.
- **One shell.**
- **One vocabulary of primitives,** the React components in `apps/web/src/app/app/_loop-os/` and their
  `loop-*` classes.

Every signed-in surface renders on that foundation. Features are then migrated onto the primitives
slice by slice, without changing permissions, authority, contracts or product meaning.

**The handoff's visual language:**
- a light canvas (`#f5f6f6`) with white surfaces;
- a dark navy navigation rail (`#0e1b2c`, carrying the Loop mark);
- a navy primary action;
- teal (`#1d6e85`) for the current place, links and focus;
- semantic state colour:
  - green: established or active;
  - amber: attention or gated;
  - red: voided or failed;
  - grey: neutral;
- Inter, with large, tight, bold page titles and small uppercase letter-spaced trails;
- 1 px cool-grey borders, radius 14 px (10 px for controls), and near-flat elevation;
- initials avatars on pale teal;
- on phones, the responsive form of the same shell: a light header, a light navigation sheet and a
  fixed five-area bar.

## 2. Reconciliation: what existed before this revision

| Layer | Before | Problem |
|---|---|---|
| Shell and `/app` | `--loop-*` tokens, dark (`.loop-os`, `loop-os.css`) | the old dark language |
| `/crm` content | `--crm-*` tokens, dark (`.crm`, `design-system.css`), plus sprint CSS with hard-coded dark values | a second palette (already recorded as debt in `crm.css`) |
| Public screens (`/status`, `/login`, `/dashboard`) | `globals.css` `:root` tokens, dark | a third palette |
| UI-1 as first submitted | `.lx` wrapper with its own `--lx-*` light tokens and `lx-*` classes, drawn over the dark shell | a fourth palette, local to the redesigned pages. **This is what the revision removes** |

**Component vocabularies in use:**

| Vocabulary | Files | Users |
|---|---|---|
| `crm-*` | 47 | `/crm` pages and sprint styles |
| `loop-*` | 31 | Home, shell, admin pages |
| `cg-*` | 12 | CallGrid Intelligence |
| `adm-*` | 12 | administration |
| `tile` / `cmd` | 9 / 6 | Loop Home |
| `ent-*` | 7 | entity pages |
| `ds-*` | 6 | |
| `cw-*` | 6 | case workspace |
| `hl-*` | 5 | headlines |
| `ps-*` | 2 | product state |
| `mkt-*`, `sw2-*`, `wh-*` | smaller | |

**Duplicates and divergences found:**

| UI-1 (as first submitted) | Existing global equivalent | Resolution |
|---|---|---|
| `--lx-*` tokens | `--loop-*` tokens | `--loop-*` takes the handoff values; `--lx-*` deleted |
| `.lx` canvas (negative margins over the dark main) | `.loop-main` | the canvas is `.loop-main` itself |
| `lx-title`, `lx-subtitle` | `loop-title`, `loop-subtitle` (10 files) | one `loop-title` / `loop-subtitle`, restyled; every page using them converges |
| `lx-skel` | `loop-skel` | one `loop-skel` |
| `lx-pill` | `loop-pill` (dead: no component uses it) | the dead rule deleted; `loop-pill` is the state pill |
| `lx-count` | `loop-count` (a live count badge) | renamed `loop-resultcount`; the badge is kept |
| `lx-state` family | `ps-error`, `loop-empty`, `crm-load-error` | `loop-state` is the family; the others are repainted and migrate later |
| `lx-head` + trail | `loop-pagehead` + `loop-eyebrow` | `PageHead` (`loop-head`) is the primitive; the legacy pair is repainted to match and migrates later |
| `lx-btn` | `ent-btn`, `adm-btn`, `wh-btn`, `crm-btn-primary`, `ds-btn` | `loop-btn` is the primitive; the others are repainted |
| `lx-table` | `crm-table`, `ds-table` | `loop-table` is the primitive; the others are repainted |
| `lx-panel`, `lx-subject--card` | `loop-card`, `tile`, `ds-card`, `crm-card` | `loop-panel` is the container; the others are repainted |

## 3. Global versus domain-specific

**Global.** These live in `loop-os.css` and `_loop-os/`:
- **Tokens:** canvas, surfaces, lines, text, primary, accent, semantic states, avatar, rail, radius,
  elevation, font.
- **Shell:** navigation rail, top bar, main canvas, mobile menu, operating-area bar, skip link, focus.
- **Typography:** page title, subtitle, trail, section title, notes and counts.
- **Containers and actions:** buttons and inert actions, filters, tabs, panels, record layout
  (workspace plus rail), fact lists, summary strip, drawer (a sheet on phones), tables that become
  lists on phones, pager, loading skeleton.
- **States:** the state family (empty, unavailable, error, not permitted, attention), the state pill,
  and a screen-reader-only utility.
- **The Subject Display System:** avatar, row, card, context card and featured block, for every
  subject type.
- **Activity items:** the nine truth types.
- **Brain work states:** the words come from `@emgloop/shared`.
- **Responsive behaviour:** breakpoints at 1,100 px (rails collapse), 820 px (mobile shell) and 760 px
  (tables become lists).

**Domain-specific.** These stay with the feature:
- **Read models and subject mapping:** `crm/subject-display.ts`, `crm/crm-subject-reads.ts`,
  `crm/relationship-history.ts`.
- **Page composition** of each surface.
- **Domain visualizations:** CallGrid charts, calendars, the case workspace layout. They consume the
  tokens; their structure stays until their slice.
- **Product words:** `@emgloop/shared` product language. That is one dictionary, not styling.

## 4. What changes in the shared foundation (this revision)

1. **Tokens.** `--loop-*` is defined once on `:root` with the handoff values, plus the new semantic
   tokens (surface, sunken, ink, muted, faint, primary, the soft state tints, avatar, rail).
2. **`--crm-*` becomes compatibility aliases only.** Every `--crm-*` name resolves to a `--loop-*`
   value, so no second set of values exists.
   - **Why the names stay:** 47 CRM files and the sprint stylesheets still reference them.
   - **When they go:** when the last `/crm` surface has migrated (§6, step 9).
3. **`globals.css`** takes the same light values for the few standalone public screens.
4. **Hard-coded dark values** in the legacy stylesheets are mapped to tokens:
   - bright text tints become semantic tokens;
   - dark panels become surfaces;
   - white overlays become ink overlays;
   - heavy black shadows become light elevation.

   Every existing surface therefore renders in the new language now, without its structure being
   redesigned.
5. **Shell:** a navy rail, a light top bar, and the light canvas on `.loop-main`. On phones: a light
   header with Menu, a light navigation sheet and the area bar. The navy wordmark shows on the light
   header; the on-dark wordmark shows on the rail.
6. **Primitives.** UI-1's primitives move from the `lx-*` names to the global `loop-*` names and read
   only `--loop-*`. `LxPage` becomes `LoopPage`.
7. **Loop Home** (both the operational home and the areas home) is built from the global primitives:
   page head, panels, state, buttons. Its data, authority and wording are unchanged.

## 5. How #282 is preserved

These all stay as they were:
- the People, Person and Relationship pages, the Subject Display System and the Brain states;
- the responsive behaviour and the honest states;
- the permissions, the read models and the tests.

What changes is only which classes and tokens they use:
- they consume the global primitives, and nothing is left local to the CRM;
- the tests that pinned `lx-*` markup pin `loop-*`;
- a new test forbids any second token set.

## 6. Result of this revision (2026-09-17)

**Shared by every signed-in surface now:**
- **The palette:** `:root` `--loop-*` tokens.
- **The shell:**
  - desktop: a navy rail with the on-dark wordmark, a light top bar and a light canvas;
  - phone: a light header, a light navigation sheet and the operating-area bar.
- **The primitives:** page, head and trail, title, buttons, links, forms, filters, tabs, panels,
  summary strip, record layout, facts, drawer, table-to-list, pager, skeleton, state family, state
  pill, Subject Display System, activity item, Brain work state.
- **Loop Home:** both variants are built from those primitives.

**Legacy surfaces, repainted but not yet restructured:**
- **`--crm-*`** is aliases only.
- **Hard-coded dark colours** in the legacy stylesheets were mapped to tokens:
  - 218 values in the CRM stylesheets;
  - a handful in `loop-os.css`;
  - the setup wizard's own light palette, mapped separately.
- **Inline component colours:**
  - CallGrid sync;
  - the integration error cell;
  - the live-feed tag;
  - creator upload.

**Honesty fixes made along the way:**
- **Home search box:** it said "Search companies, contacts, work" but searches intake records,
  conversations and the workspace. It now says what it searches.
- **CRM primary and ghost buttons:** their link colour was overridden by `.crm a` (an older
  contrast bug). Fixed.

**Measured with an automated audit.** Every signed-in page was audited as the owner, plus Home,
People, Relationships, Work and the CRM as an employee, at 1,440, 900 and 390 px:
- 65 of 65 pages clean;
- no dark surface outside the rail;
- no text below WCAG AA;
- no invisible text;
- no horizontal overflow.

**Not audited, because they are a different medium:** the email templates
(`apps/web/src/lib/email/templates.ts`), which have their own light inline styles.

## 7. Surfaces still on older component structures (repainted, one palette)

| Area | Surfaces | Vocabulary still in use |
|---|---|---|
| Shared states | `ShellPage`, `UnavailablePage`, `ReadError` / `NotKnown` / `StateBadge`, `CrmLoadError`, `DataUnavailable` | `loop-empty`, `ps-*`, `crm-load-error` |
| CRM (`/crm`) | Command Center; Intake Records (+ detail, activity); Conversations (+ detail); Intake Board; Inbox; Search; Automations (+ new, detail); Identity Review and Relationships operator screens (+ detail, new) | `crm-*`, `ds-*`, sprint CSS |
| Intelligence | Headlines (+ detail); Your queue; Case workspace; Executive Brain (it has no `h1` today); Intelligence Flow; CallGrid Intelligence (+ 7 tabs); Analytics; Traffic; Revenue | `hl-*`, `cw-*`, `ps-*`, `cg-*`, `mkt-*`, legacy `loop-*`, `ds-*` |
| Work | My Work (admin and employee, + detail); Team Work; New work; Work Types / blueprints | `tile`, `cmd`, `wh-*`, `sw2-*`, `ent-*` |
| Operations | Live Operations, Live Calls, Websites; Creators (not built) | `crm-*`, `ds-*`, `ShellPage` |
| Administration | Team; Workspace; Settings (+ CallGrid); Objectives; Audit; AI Employees; Integration OS (+ provider, assistant, secrets, website property); CallGrid diagnostics; Setup wizard | `adm-*`, `crm-*`, `ios-*`, setup CSS |
| Participant and transitional | `/app/creator/upload`; the `/app/business`, `/app/client` and `/app/creator` placeholders | `ds-*`, `ShellPage` |
| Standalone | Sign-in, forgot and reset password, invitation, unauthorized; `/status`; legacy `/login` and `/dashboard` | `crm-auth-*` (sprint7), `globals.css` |

## 8. Migration order

Each step moves page structure onto the primitives, one reviewed PR at a time. No step changes
permissions, authority, contracts or product meaning.

1. **This PR.** Foundation, shell, the People / Person / Relationship slice, and the Home foundation.
2. **Shared states.**
   - Move `ShellPage`, `UnavailablePage`, `ReadError`, `NotKnown`, `StateBadge`, `CrmLoadError` and
     `DataUnavailable` onto the `StateBlock` family and `StatePill`.
   - This is a small change that affects many pages.
3. **Identity and Relationships.**
   - The Companies list and record come next.
   - The governed acts (create, establish, end, reactivate, void, participants) move onto the
     redesigned pages.
   - Then `/crm/parties` and `/crm/relationships` retire.
4. **CRM intake surfaces.** Intake Records (list, detail, activity), Conversations, Inbox, Intake
   Board, CRM Search, then the Command Center ("commercial command").
5. **Loop Home composition** (handoff UI 1).
   - Sections: Needs You, What Changed, Loop Noticed, My Work, Operating Pulse.
   - Needs: the Needs You projection and a "last operated" marker.
   - Replaces today's fixed status words.
6. **Universal Activity** (handoff UI 4), as the Party and Relationship adapters land.
7. **Intelligence.**
   - Surfaces: Headlines, Your queue, Case workspace, Executive Brain (name decision pending),
     Intelligence Flow, CallGrid Intelligence and its tabs, Analytics, Traffic, Revenue.
   - The legacy `loop-*` v3/v4/v5 sections, `hl-*`, `cw-*`, `cg-*` and `ps-*` are retired here.
8. **Work.** My Work (both), Team Work, work detail and new, Work Types. `tile`, `cmd`, `wh-*`, `sw2-*`
   and `ent-*` are retired.
9. **Operations and Administration.**
   - Surfaces: Live Operations, Calls and Websites; Creators; Team, Workspace, Settings, Objectives,
     Audit, AI Employees, Integration OS, diagnostics, the setup wizard.
   - Then **delete the `--crm-*` aliases** and the `crm.css`, `design-system.css` and sprint
     component rules.
10. **Standalone screens.**
    - Move sign-in, password reset, invitation, unauthorized and `/status` onto the primitives.
    - Remove the legacy `/login` and `/dashboard` if they are confirmed dead.
    - Then **delete the `globals.css` aliases**.

Email templates are a separate follow-up.

## 9. Temporary duplicates: what remains, why, and when it goes

**There is one palette.** What remains is **alias names**, not a second set of values:

| Alias names | Why they exist | When they go |
|---|---|---|
| `--crm-*` (design-system.css) | 47 CRM files still reference them. Every one resolves to a `--loop-*` value, and a test forbids a literal | step 9 |
| Older `--loop-bg`, `--loop-panel`, `--loop-panel-2`, `--loop-elev`, `--loop-text`, `--loop-text-2`, `--loop-text-3`, `--loop-accent-2` (on `:root`) | the legacy `loop-os.css` sections use them. Each is `var()` of a current token | steps 7–9, as those sections are deleted |
| `globals.css` `--bg`, `--panel`, `--text`, `--muted`, `--accent`, `--border`, `--ok` | the standalone public screens do not load `loop-os.css`, so these hold the same hex values. A test asserts they equal the `:root` values | step 10 |

**Retiring component vocabularies.** The legacy vocabularies (`crm-*`, `ds-*`, `tile`, `cmd`, `ent-*`,
`hl-*`, `cw-*`, `ps-*`, `cg-*`, `adm-*`, `wh-*`, `sw2-*`, the legacy `loop-*` sections) are
repainted and retire with the steps above. **New work must use the primitives.**

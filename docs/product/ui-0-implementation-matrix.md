# UI-0 — implementation matrix and repository-fit assessment

**Status: ASSESSMENT ONLY (2026-09-17). No production surface is changed by this document.**
- **What it answers.** The spec's "First Requested Deliverable"
  (`loop-product-ui-architecture-v1.0.md`, Implementation Handoff):
  1. a component inventory and plan;
  2. a route-to-area map;
  3. a data availability map for Home and Activity;
  4. the canonical read-model gaps;
  5. a proposed pull-request sequence with acceptance checks.

  It adds a screen-by-screen matrix.
- **How it was built.** Every row was read from code on `main` (`f744fca`); nothing was inferred from
  older docs.

**Source of truth, and what is missing.**
- **The controlling artifact in the repository** is *Loop Product and UI Architecture v1.0*
  (2026-09-15) with Product's annotations C-01 to C-05.
- **Charlie and Lexi's latest handoff has not reached the repository.** Matt's run brief names a
  "Subject Display System" (UI-2), which appears nowhere in the repository.
- **Consequence:** this matrix is built on v1.0. Implementation of UI-1 to UI-5 is **held** until that
  artifact is committed or pasted. Nothing here invents a competing design.

**Two numberings.**
- **The spec** numbers its slices UI 0–10: UI 0 primitives, UI 1 Home, UI 2 navigation, UI 3 CRM IA,
  UI 4 Activity, UI 5 Person, UI 6 Company and Relationship, and so on.
- **Matt's run brief** uses:
  - UI-0: this matrix;
  - UI-1: shell and primitives;
  - UI-2: Subject Display System;
  - UI-3: People → Person → Companies → Company → Relationships → Relationship;
  - UI-4: Activity and Intelligence;
  - UI-5: Brain states.
- **This document uses the brief's numbering**, and §6 maps it to the spec's.

**Route moves wait on a proposal.** The locked decision record (`loop-application-structure.md` D1,
C-01) says no route moves until Charlie and Lexi's route-transition proposal is approved. That proposal
has not been received. Target routes below are therefore the reserved or current ones, not new ones.

---

## 1. Status key

| Status | Meaning |
|---|---|
| **GREEN** | The owning authority and a read model exist and are usable from the web tier now. The slice is UI work. |
| **YELLOW** | The authority exists, but a read model, web wiring, subject support or a Product decision is missing. The slice can ship partially with honest Unknown or unavailable states. |
| **RED** | No authority exists. The only honest UI is an unavailable state or no navigation item. |

## 2. Screen-by-screen matrix

**Abbreviations:**
- `RW` = `requireWorkspace`, `RP` = `requirePermission`.
- *CI* = Commercial Intelligence.
- *B5* = the Loop-side Brain boundary, in review and not on `main`.

### S1. Loop shell (global navigation, context header, context navigation, drawer): YELLOW

- **Route:** every signed-in page (`WorkspaceShell` via the tree layouts).
- **Purpose:** stable orientation; five operating areas.
- **Authority:** `LOOP_NAV` and `navFor(session)` (`workspaces/config.ts`, `nav-access.ts`). One
  `iam.canEach` read per request.
- **Actions and authorization:**
  - navigation only;
  - items are filtered by permission and workspace;
  - every page guards itself.
- **States:**
  - `ShellPage` ("Nothing here yet") and `UnavailablePage` exist;
  - there is **no `error.tsx` or `not-found.tsx` anywhere** under `app/`.
- **Evidence, Activity, Brain:** not applicable. The shell will host the "Brain · N working" indicator
  (S16).
- **Gap:**
  - the registry is not regrouped to the five areas;
  - `one-loop-shell.test.tsx` pins today's grouping (`'' / CRM / Intelligence / Work OS / '' /
    Administration`), so a regroup changes that test as an explicit, reviewed act;
  - the Operations prefix is undecided (D1).
- **Replaces:** the temporary grouping; the unlabeled Creator Hub and Accounting group, which leads to
  "not built" pages.
- **Decisions:**
  - the route-transition proposal;
  - where Administration renders (C-01: system/workspace settings);
  - one CSS token set (§3).

### S2. Loop Home: YELLOW

- **Route:** `/app`.
- **Purpose:** Needs You → What Changed → Loop Noticed → My Work → Operating Pulse.
- **Today:** `AdminHome`, nine tiles, for ADMIN; `ModuleHome` launchers, with no data, for everyone
  else.
  - **Several tiles show fixed words, not read state:**
    - Business Status lists systems statically, and only CallGrid can read as connected;
    - CRM "Active";
    - Creator Hub "Not Configured";
    - Accounting "Not Connected".
  - These are the first things UI-1 retires.
- **Authorities per section:** §5.
- **Authorization:** each section keeps its source's guard. The CI sections are ADMIN-workspace and
  `commercialIntelligence:view` only.
- **States:** "No evidence-backed priorities require your attention."; "Unavailable" and "Unknown".
  These are good precedents.
- **Activity:** "What Changed" needs the organization Activity lane (`ActivityService`), which **no web
  page uses yet**.
- **Brain:** "Needs You" should include Brain work waiting for this person (B5 `listMine`, phase
  `WAITING_FOR_YOU`). This needs B5 merged.
- **Gaps:**
  - "since you last operated" has no per-user marker, which is a backend gap. Until one exists, the
    honest window is fixed and says so.
  - Non-ADMIN Home has no data sources beyond Work.
- **Decisions:**
  - the "What Changed" window;
  - which Pulse metrics, and for which roles;
  - what non-ADMIN people see in Needs You.

### S3. CRM Command Center: YELLOW (parts RED)

- **Route:** `/crm` (target `/app/crm` after the proposal).
- **Purpose:** where business is moving or stuck, relationships needing attention, commercial decisions
  pending.
- **Today:**
  - Needs Attention, Customer Intake, Recent Activity, Quick Actions, Recent Audit;
  - a **"Coming in Phase 2"** block, which should become nothing or an explicit unavailable state.
- **Authority:**
  - Relationships: `CrmRelationshipReadService`;
  - CI attention: `CaseWorkspaceService.attention`;
  - intake counts: `crm` repositories;
  - **Opportunities: none (RED).**
- **Guard:** `requireCrmContext` only (session). The composed sections carry their own checks
  (`canOpenHeadlines`, audit `HP`).
- **States:** `CrmLoadError`, `ReadError`, `EmptyTimeline`.
- **Decisions:** what "needs attention" means for a Relationship. It must be a CI interpretation, never
  a frontend score.

### S4. People (list): GREEN

- **Route:** `/app/crm/people`, reserved for PERSON Parties (D2/C-04). **No page exists.** Today the list
  lives inside the operator surface `/crm/parties` (#264, temporary).
- **Authority:** `PartyRecordService.listPeople` → `PartyReadModelRepository.listEstablished`
  (established, non-superseded PERSON Parties).
- **Authorization:** `identityResolution:view`.
- **States:**
  - "You do not have authority to read canonical identity.";
  - the empty list. **Production holds 0 established Parties**, so the honest first state is empty,
    and the list never falls back to Intake Records.
- **Evidence:** the governed identity posture (C-05); never a number.
- **Replaces:** the People list inside `/crm/parties`.
- **Decision:** **which permission opens People for ordinary CRM users.** Today only
  `identityResolution:view` does, an operator permission. A People view permission is an RBAC change for
  Product.

### S5. Person (record): YELLOW

- **Route:** a Person under `/app/crm/people/<id>` (not yet built). Today `/crm/parties/[id]`
  (operator).
- **Authority:**
  - `PartyRecordService.getRecord`: posture, establishment, reference, linked intake records;
  - `CrmRelationshipReadService.forParty`.
- **Grammar (spec §Canonical Record Experience):**

  | Part | Available? |
  |---|---|
  | Identity | yes |
  | State | yes (establishment, supersession) |
  | Context: relationships | yes |
  | Context: opportunities and campaigns | **no** (RED) |
  | Context: work | **no** Party reference found in Work |
  | Activity | **no** PARTY subject in `ActivityService` |
  | Intelligence | **no** CI subject for a Party |
  | Actions: communication | **no** Party-level channel. Conversations belong to Intake Records |

- **Authorization:** `identityResolution:view` today (see S4).
- **States:** a SUPERSEDED notice; `notFound()`; "This Party takes part in no Relationship yet."
- **Brain:** a Person is not a Brain subject type (B5 accepts CASE, RELATIONSHIP and
  CUSTOMER_CONVERSATION).
- **Replaces:** `/crm/parties/[id]`, and the useful parts of `/crm/customers/[id]` (spec: "Transition and
  replace").
- **Decisions:**
  - the Person permission;
  - a PARTY Activity subject (backend);
  - creator participation as a capability on a Person (C-02), not a Party type.

### S6. Companies (list): GREEN

As S4, with `PartyRecordService.listCompanies` (COMPANY Parties). **Company is not Workspace
Organization:** `/crm/organizations` is the tenant (labelled "Workspace" in the navigation) and must stay
visibly separate.

### S7. Company (record): YELLOW

As S5, for COMPANY Parties. The gaps are the same: Activity subject, opportunities, campaigns,
intelligence. The commercial network is the Relationships the Company takes part in (available).

### S8. Relationships (list): GREEN

- **Route:** `/crm/relationships` (operator surface today; target `/app/crm/relationships` after the
  proposal).
- **Authority:** `CrmRelationshipReadService.list`, with capabilities.
- **Authorization:** `relationships:view`. Creation shows only with `capabilities.create`.
- **States:** "None yet. This is the correct answer until somebody records one"; no-authority text.
  Production holds **0 Relationships**.
- **Decision:** the list filtered by kind (the creator roster; already on the project's next list).

### S9. Relationship (record): GREEN for the record, YELLOW for Activity and Intelligence

- **Authority:**
  - `CrmRelationshipReadService.getRecord`, and the participants;
  - `CrmRelationshipService` for create, end, reactivate, void and participants. Authority is checked
    inside the service.
- **States:** `notFound()` for not found **and** for not authorized. This is correct: existence is not
  leaked.
- **Activity:**
  - `CrmRelationshipEvent` rows exist, but **no RELATIONSHIP subject or adapter** exists in Activity;
  - that adapter is backend work, not a UI join.
- **Intelligence:** relationship health must be a CI interpretation. **No CI subject exists** for a
  Relationship (RED for that panel).
- **Brain:**
  - RELATIONSHIP is an accepted Brain subject, and ANALYSIS about it is owned by the Relationship
    authority (B3.1 ownership table);
  - **no task and no result store exist**, so the panel shows nothing.

### S10. Opportunities: RED

- **No model, repository or service exists.** The navigation item is `soon` and no page exists.
- "Opportunity" elsewhere in the code is a CallGrid concept; it must not be relabelled.
- **Honest UI:** keep the `soon` item hidden, or show it as unavailable.
- **Decision:** PD-F-11.

### S11. Campaigns: RED

- **No CRM Campaign authority exists.** "Campaign" today is a CallGrid call dimension
  (`/app/admin/marketplace/campaigns`) and a traffic dimension (`/crm/traffic`). Neither is the
  commercial Campaign.
- **Decision:** PD-F-12.

### S12. Intake Records (list, record, board, inbox, conversations): GREEN (preserve and demote)

- **Routes:** `/crm/customers`, `/crm/customers/[id]` (+ `/activity`), `/crm/pipeline` (Intake Board),
  `/crm/inbox`, `/crm/conversations` (+ `[id]`).
- **Authority:** the legacy Customer repositories (`crm`, `customers`, `conversationsInbox`).
- **Authorization:** `customers`, `pipeline` and `inbox` view/update, per action.
- **Findings for UI-1:**
  1. **Many CRM pages show "Database not configured" (`DbNotConfigured`) on *any* failed read,** including
     an ordinary read failure. This is an honesty defect.
     - Pages: customers, customer activity, conversations (list and record), inbox, pipeline, workflows
       (list and record), analytics, traffic, revenue, intelligence, integrations (three pages),
       CallGrid settings.
     - The `CrmLoadError` pattern (`/crm`, `/crm/customers/[id]`, `/crm/organizations/[id]`,
       `/crm/search`) is the fix.
  2. **The record's "AI Activity" tab** renders AI-attributed interactions with a purple accent
     (`var(--crm-purple)`). The spec says AI receives no ornamental treatment or default purple. Its
     content also needs an AI-honesty check against `ai-honesty-inventory.md`.
- **Intake → Party linking:**
  - `CustomerPartyLinkService` exists, but **no web surface links** an intake record to a Party;
  - the web linking decision is still open (`intake-party-linking-recommendation.md`);
  - **the Intake → Party fence is not weakened by any slice here.**

### S13. Search: YELLOW

- **Route:** `/crm/search` (`runSearch` over intake records, conversations and the workspace).
- **Target:** governed universal search that includes Parties and unresolved activity.
- **Gap:** no Party search in the web tier, and no unified search service.
- **Guard:** `customers:view`.

### S14. Universal Activity (contextual timeline): YELLOW

- **Authority:** `ActivityService.read(viewer, subject, options)`, which rechecks every item.
  - **Subjects:** ORGANIZATION, INTAKE_RECORD, CASE, WORK_ITEM.
  - **Adapters:** interactions, CallGrid calls, observations, messages, audit, Work, and Brain events
    (Brain composed in B5).
- **The contract already matches the spec:**
  - filters `ALL / COMMUNICATIONS / WORK / INTELLIGENCE / CHANGES`;
  - identity states `KNOWN_PARTY / KNOWN_COMPANY / UNRESOLVED / ANONYMOUS / NOT_APPLICABLE`
    (`packages/shared/src/activity.ts`).
- **Gaps:**
  - **no web page uses `ActivityService`.** CRM timelines use `crm/timeline.tsx` over `inboxFeed`,
    `customerActivity` and `audit.list`;
  - **no PARTY or RELATIONSHIP subject** exists.
- **Replaces:** the per-page CRM timeline adapters, once the service serves those subjects.

### S15. Intelligence area: GREEN

- **Routes:**
  - `/app/admin/headlines` (+ `[id]`), `/app/admin/queue`, `/app/admin/cases/[id]`;
  - `/app/admin/marketplace` (+ tabs), `/app/admin/brain`;
  - `/crm/intelligence`, `/crm/analytics`, `/crm/traffic`, `/crm/revenue`, `/crm/live/*`.

  The target prefix `/app/intelligence` waits on the proposal.
- **Authority:** CI (`CaseWorkspaceService`, `HeadlineInvestigationService`, `PersonalPriorityService`,
  `CaseBriefService`), the Decision Engine, and CallGrid Intelligence.
- **Authorization:** ADMIN workspace plus `commercialIntelligence:view` for the CI pages;
  `intelligence:view` and `analytics:view` for the rest.
- **Findings:**
  1. **`/app/admin/marketplace` enforces only the ADMIN workspace, while its navigation item states
     `intelligence:view`.** An ADMIN-workspace person with that permission denied can open it by URL.
     The shell test records this as a known exception. Fixing it is a small, separate authorization PR.
  2. **Two things are called "Brain":**
     - `/app/admin/brain`, a deterministic executive projection;
     - the Brain runtime (B5).

     Their naming is a Product decision, so that nobody reads the executive view as AI.
- **Spec sections vs today:**
  - Overview: no page;
  - Investigations = Cases;
  - Findings and Recommendations: inside Cases;
  - Decisions: the Decision Engine UI (`_decisions`) inside the CallGrid queue;
  - Monitoring: inside Cases.

  A dedicated Findings or Decisions list is new composition over existing authorities.

### S16. Brain product states: YELLOW (depends on B5)

- **Authority (B5, not on `main`):**
  - **reads:** `BrainWorkService` via `/api/brain/work`, `/api/brain/work/[jobId]` and
    `/api/brain/questions/[waitId]`;
  - **actions:** `submitBrainWorkAction`, `respondToBrainQuestionAction` and `cancelBrainWorkAction`.
- **States, and what backs each:**

  | State | Backed by |
  |---|---|
  | Idle | no job for the subject (`forSubject` is empty) |
  | Submitting | the action is pending |
  | Queued / working | phase `QUEUED` / `WORKING` |
  | Checkpoint / progress | the current step key and kind, and completed steps; never a percentage |
  | Waiting for you | phase `WAITING_FOR_YOU`, plus the question (choose one, confirm, short text) |
  | Completed | phase `COMPLETED`, plus result links to the owner's page |
  | Failed | the end reason, mapped to plain words |
  | Cancelled | the end reason |
  | Retryable | a new submission with a new idempotency key (resume-from-checkpoint is not exposed to the web) |
  | Not enabled | `NOT_ENABLED`, `PAUSED` or `NOT_CONFIGURED`: **every submission today** |

- **Wording:** provider-neutral. No provider, model or "thinking" theatre.
- **No live AI:** the UI must render "not enabled" honestly.
- **Gaps:**
  - **no result store** exists, so no job can complete;
  - the Case page's existing explanation panel (off) must not be duplicated.
- **Decisions (Charlie and Lexi):**
  - where the "Brain · N working" indicator and the question live;
  - the words for each end reason.

### S17. Work: GREEN

- **Routes:** `/app/admin/work` (+ `team`, `new`, `[id]`, `blueprints`), `/app/employee/work` (+ `[id]`).
  The target `/app/work` waits on the proposal.
- **Authority:** Work OS (`WorkExecutionService`, `work` repositories).
- **Guards:** the Work actor helpers.
- **Gap:** "Workflows" is `soon`.

### S18. Operations → CallGrid: GREEN (placement pending)

- **Authority:** exists (CallGrid ingestion, reconciliation and diagnostics).
- **Split (C-03):**
  - operational surfaces, such as live calls, reconciliation and diagnostics
    (`/app/admin/administration/diagnostics/callgrid`), go to Operations;
  - analytical surfaces go to Intelligence;
  - credentials and connection state (`/crm/settings/integrations/callgrid`, `/crm/integrations/*`) go
    to settings.
- **Pending:** the Operations prefix (D1).

### S19. Operations → Creators: RED

- **No creator participation or capability model** exists (C-02).
- `/app/admin/creator-hub` falls to the catch-all "not built" page.
- **The nearest real data** is the Relationship list filtered by kind (S8).

### S20. Workspace administration: GREEN (placement pending)

- **Routes:**
  - Team (`/app/admin/administration/team`), Workspace (`/crm/organizations`), Settings, Setup;
  - Audit (`/crm/audit`), AI Employees, Integration OS;
  - Objectives (CI authority).
- **Authority:** IAM, organizations, audit, Integration OS, CI.
- **Pending:** placement per C-01 (system/workspace settings), from the proposal.

### S21. Connections (Google Workspace): RED

- **Contract only:** `google-workspace-connection.md` §11, in its own PR.
- **Missing:** a table, a migration, routes and an OAuth client.
- **When built:** each capability's state is shown honestly (not connected, connected, expired,
  revoked, insufficient scope).

## 3. Component inventory and plan (spec deliverable 1; brief UI-1)

| Spec zone / primitive | Exists today | Plan |
|---|---|---|
| Global shell | `WorkspaceShell`, `ShellNav`/`ShellCrumb` (client leaf) | keep; regroup the registry after the proposal |
| Context header | partly: the `EntityPage` header (`_loop-os`), `crm-record-*` CSS | one `SubjectHeader` (identity, state, context chain, actions) |
| Context navigation | `SectionTabs` (`crm/section-tabs.tsx`, with `soon`), `CallGridNav` | one tabs primitive; `soon` renders as unavailable, never as a link |
| Primary workspace, supporting rail | `EntityPage` sections; `ContextCard`/`ContextGroup`; operator `SideSummary` | one workspace and rail layout |
| Context drawer | `EvidenceDrawer` (marketplace); `<details>` in `EntityPage` | one drawer that preserves the subject and restores state on close |
| Activity item | `Timeline`, `TimelineItem`, `ActivityTypeBadge`, `ProvenanceDisplay` (`crm/timeline.tsx`); `loop-actv`/`loop-feed` CSS | one item bound to the `activity.v1` shape (category, identity state, provenance) |
| States | `StateBadge`/`StateNote`/`NotKnown`/`ReadError` (`_loop-os/product-state.tsx`); `ShellPage`; `UnavailablePage`; `CrmLoadError`; `DbNotConfigured` (misused) | one state family: loading, empty, unknown, read error, not authorized, unavailable, superseded |
| Attention | `AttentionRow`, `AttentionBanner`, `PersonalQueue` | one attention item for Needs You |
| Status system | `StateBadge`, `StatusDot`, `ds-status-dot`, `crm-status`, `ps-badge`, `SeverityTag`, `ConfidencePill` | one semantic status scale; color carries meaning, not section |
| Formatters | `_loop-os/format.ts` (`UNKNOWN_DISPLAY`, `moneyOrUnknown`, …) | keep as the only home (CLAUDE.md) |

**Styling finding: two parallel vocabularies.**
- `app/loop-os.css` (about 3,500 lines; `loop-*`, `ps-*`, `ent-*`, `cw-*`, `hl-*`);
- `app/crm/design-system.css` (`.crm` tokens, `ds-*`), plus `crm.css` and five sprint-numbered CSS
  files.

CLAUDE.md forbids new CSS files and names the design-system tokens. **Decision for Charlie and Lexi:**
which token set is canonical. UI-1 then converges on it without adding a third.

## 4. Route → operating area map (spec deliverable 2)

| Area | Current routes | Target prefix |
|---|---|---|
| Home | `/app` | `/app` |
| CRM | `/crm`, `/crm/customers*`, `/crm/pipeline`, `/crm/inbox`, `/crm/conversations*`, `/crm/search`, `/crm/workflows*`, `/crm/parties*` (operator), `/crm/relationships*` | `/app/crm` (after the proposal) |
| Work | `/app/admin/work*`, `/app/employee/work*`, `/app/admin/administration/work-types` | `/app/work` |
| Intelligence | `/app/admin/headlines*`, `/app/admin/queue`, `/app/admin/cases/[id]`, `/app/admin/marketplace*` (analytical), `/app/admin/brain`, `/crm/intelligence`, `/crm/analytics`, `/crm/traffic`, `/crm/revenue`, `/crm/live/*`, Objectives (CI authority) | `/app/intelligence` |
| Operations | CallGrid operational: `/app/admin/administration/diagnostics/callgrid`, live calls; Creators (none) | undecided (D1) |
| Settings (not an area) | `/app/admin/administration/team`, `/crm/organizations*`, `/crm/settings*`, `/crm/setup`, `/crm/audit`, `/crm/ai-employees`, `/crm/integrations*` | from the proposal (C-01) |
| Standalone | `/crm/login`, `/crm/forgot-password`, `/crm/reset-password`, `/crm/accept-invite`, `/crm/unauthorized` | PR 3 of the structure sequence |
| Transitional | `/app/{admin,business,client,creator,employee}` redirects and catch-alls; `/app/creator/upload` (inert); `/app/admin/review` (demo harness) | retire in "Final" |

## 5. Data availability for Home and Activity (spec deliverable 3)

| Home section | Source | Exists | Web-wired | Note |
|---|---|---|---|---|
| Needs You | `PersonalPriorityService.queueFor` (CI) | yes | yes (`/app/admin/queue`) | ADMIN + CI only |
| | Work: next action, notifications, unassigned | yes | yes | |
| | Brain `WAITING_FOR_YOU` (B5 `listMine`) | in review | no | after B5 merges |
| | Pending invitations and access requests (IAM) | yes | partly (Home reads invitations) | |
| What Changed | `ActivityService` organization lane | yes | **no** | "since last operated" has no marker |
| Loop Noticed | `CaseWorkspaceService.attention`, headlines | yes | yes | |
| My Work | `work` repositories | yes | yes | |
| Operating Pulse | CallGrid `aggregateWindow`; intake `statusCounts`/`windowCounts`; the website analytics coverage | yes | yes | choose the metrics; filter by authority |

| Activity source (adapter) | Subjects | Web-wired |
|---|---|---|
| Interactions | ORGANIZATION, INTAKE_RECORD | via `crm/timeline.tsx`, not `ActivityService` |
| CallGrid calls | ORGANIZATION | no |
| Observations (Decision Engine) | CASE | Case page timeline (its own section) |
| Messages | INTAKE_RECORD | via CRM pages |
| Audit | ORGANIZATION, INTAKE_RECORD | via CRM pages |
| Work | WORK_ITEM | Work pages |
| Brain events | ORGANIZATION, CASE (ADMIN workspace) | no |
| **Party, Company, Relationship** | **none** | — |

## 6. Canonical read-model gaps (spec deliverable 4)

| Object | Exists | Missing (backend) |
|---|---|---|
| Person | `PartyRecordService` (list, record, posture, linked intake records); Relationships for a Party | a Person view permission for non-operators; a PARTY Activity subject; a Party reference on Work; opportunity and campaign context; any CI subject for a Party; a Party-level communication channel |
| Company | same as Person (COMPANY) | same as Person |
| Relationship | read service, write service, events, participants | a RELATIONSHIP Activity adapter over `CrmRelationshipEvent`; a CI subject; a list filter by kind |
| Opportunity | nothing | the whole authority (PD-F-11) |
| Campaign | nothing (CRM) | the whole authority (PD-F-12); composition with CallGrid, deliverables and accounting |

## 7. Proposed pull-request sequence (spec deliverable 5)

Each PR comes from fresh `main`, is not stacked, and is a draft that Matt merges. Every one keeps:
- server-side guards;
- no fabricated data;
- honest empty, unknown and error states;
- a production build and a client-bundle check.

| Brief | Spec | PR | Depends on | Acceptance checks |
|---|---|---|---|---|
| UI-1 | UI 0 (+ part of UI 1) | Shell and primitives: one state family, subject header, tabs, drawer, activity item, attention item; the `DbNotConfigured` fix; Home's static status words removed | the latest Charlie/Lexi artifact; the token-set decision | no new CSS file; every state rendered in a test; no client component reaches the database; `one-loop-shell` unchanged unless regrouping is approved |
| UI-1b | UI 1 | Loop Home, five sections, from §5 | UI-1 | each section names its source; the CI sections stay ADMIN-only; "What Changed" states its window; no number without a row behind it |
| UI-2 | (new) | Subject Display System | **the artifact that defines it** | held |
| UI-3a | UI 3 / UI 5 | People list and Person record (read-only), at the reserved route | UI-1; the Person-permission decision; the route proposal for `/app/crm/*` | 0 Parties renders empty and never falls back to Intake Records; posture shown as posture; the Intake → Party fence unchanged |
| UI-3b | UI 6 | Companies and Company | UI-3a | Company visibly distinct from Workspace |
| UI-3c | UI 6 | Relationships and Relationship on the record grammar (replacing the operator pages) | UI-1 | capabilities from the server; `notFound` for unauthorized; no frontend health score |
| UI-4a | UI 4 | Activity on Organization, Intake Record, Case and Work via `ActivityService` | UI-1 | the item shows its category, identity state and provenance; unresolved and anonymous stay visible |
| UI-4b | UI 4 | PARTY and RELATIONSHIP Activity subjects (**backend**) plus their timelines | UI-4a; a reviewed adapter | the adapter rechecks each item; no Person is created for an event |
| UI-4c | UI 9 | Intelligence composition (Ambient, Actionable, Governed) where CI authority exists | UI-1 | status and evidence count on every Finding; approval stays with its owner |
| UI-5 | UI 10 (part) | Brain product states on the B5 API | **B5 merged** | every state rendered; "not enabled" today; no provider or model words; no percentage |
| — | — | Authorization fix: `/app/admin/marketplace` enforces `intelligence:view` | none | the shell test's exception removed |

## 8. Unresolved decisions

1. **Charlie and Lexi's latest artifact,** including the Subject Display System. It is missing from the
   repository, and **UI-1 to UI-5 are held until it arrives.**
2. **The route-transition proposal:** Operations prefix, settings placement, CRM move (D1, C-01).
3. **The canonical CSS token set** (§3).
4. **A People and Companies view permission** for ordinary CRM users (S4).
5. **Home:** the "What Changed" window, the Pulse metrics, and non-ADMIN Needs You (S2).
6. **Naming:** the executive "Brain" page versus the Brain runtime (S15).
7. **Where Brain status and questions live in the shell** (S16).
8. **Opportunity and Campaign authorities** (PD-F-11, PD-F-12).
9. **Intake → Party web linking** (open; unchanged here).

# UI-0 — screen map and repository-fit assessment for the Loop redesign

**Status: ASSESSMENT ONLY (2026-09-17). No production surface is changed by this document.**

## Controlling source

**The design and product authority is *Loop Product and UI Redesign — Implementation Handoff*.**
- **Who and when:** Charlie and Lexi, prepared for Matt Dunn, dated September 16 2026.
- **Form:** 21 pages, with seven embedded visuals. It was supplied in this work session as
  "update from charlie and lexi.pdf".
- **What it says of itself:** it is "the current product and visual source of truth for the Loop
  redesign", to be used "with the interactive prototype and the existing domain contracts".
- **What it replaces:** visual interpretation of the temporary `/crm/parties` and `/crm/relationships`
  screens.

**The artifacts compared:**

| Artifact | Date | Role here |
|---|---|---|
| *Loop Product and UI Redesign — Implementation Handoff* | 2026-09-16 | **Controlling** design and product source |
| *Loop Product and UI Architecture v1.0* (`loop-product-ui-architecture-v1.0.md`, with Product annotations C-01 to C-05) | 2026-09-15 | Underlying architecture. The handoff repeats its model, constitution and UI 0–10 sequence. The C-01 to C-05 decisions stay locked |
| *Loop CRM Product Definition and Build Specification v1.0* | file dated 2026-09-13 | Earlier CRM specification; superseded for design purposes |

**A correction.** An earlier draft of this document said the latest Charlie and Lexi artifact had not
been delivered. That was wrong: the handoff was supplied twice in this session. This version is built
on it.

**Not recoverable from the PDF.** The handoff links "Open the Loop prototype", but the PDF carries no
URL, so the interactive prototype was not reviewed. Anything that only the prototype shows (exact
tokens, interaction timing, tablet and mobile layouts) is listed as a dependency, not guessed.

**What engineering owns** (handoff, Review Standard): "the route-to-contract mapping", and surfacing
conflicts before coding around them. This document is that mapping's first pass, in the handoff's own
Screen Implementation Contract fields.

---

## 1. What the handoff establishes

| Topic | Established by the handoff | Still undefined (specific) |
|---|---|---|
| Loop shell | Five page zones: global shell, context header, context navigation, primary workspace with a supporting rail, context drawer. Visuals show a dark left rail with the Loop mark, a top bar with **Search Loop** and a **Needs You _n_** counter, and a hierarchical trail such as "CRM / PEOPLE / DENISE K" | Exact tokens (colour, type scale, spacing); prototype only |
| Navigation | Global navigation = five operating areas (Home, CRM, Work, Intelligence, Operations), shown in that order. Contextual navigation = the subject's tabs. The context trail is navigation state only | Where workspace settings and administration appear; the visuals show no settings entry (C-01 says settings, not an area) |
| Subject Display System | **Defined** (pp. 13–14): six-part card anatomy; stable versus contextual content for Person, Company, Relationship, Workspace, Intake and Unresolved Activity; four densities; visual rules | Component names are engineering's choice. The handoff asks for it to be locked before search, participants or related-record panels |
| Route transitions | Canonical routes are **not** given. Engineering owns the route-to-contract mapping. Breadcrumbs follow areas (CRM, Intelligence) | **Who approves route moves.** The locked record (D1) says Charlie and Lexi own the route-transition proposal; the handoff assigns route mapping to engineering (§11, decision 1) |
| Home | Five sections with authorities and constraints (p. 4). Readiness: **partially ready** | The "since the user last operated" marker (no backend for it); which Pulse metrics suit which role |
| People | Canonical established PERSON Parties. Visual: columns Person, Relationship context, Opportunities, State; filters All people / Relationship / State; **+ Establish person**. Readiness: **ready** | Whether unresolved identity-review rows appear in this list (the visual shows one; the text says People holds established Parties) |
| Person detail | Header (name, state, "Person · role · affiliation"), actions Email / Call / Message / + Action, a summary strip (Relationship, Opportunities, Campaigns, Open Work), tabs, "What is happening now", an identity and active-relationship rail. States: Established, Superseded, Archived, Unresolved activity. Readiness: **ready** | How communication actions behave while no Party-level channel exists |
| Companies / Company detail | Same grammar, emphasizing the commercial network. Company is a Party; Workspace is the tenant. A Company card example shows an industry line and "Active relationship · 2 opportunities". Readiness: **ready** | No Company visual beyond the card; the industry source (no Party industry field exists) |
| Relationships / Relationship detail | Relationship detail visual: header "EMG ↔ Denise K", state, "Relationship · kind · Since year"; tabs Overview, Participants, Activity, Opportunities, Work, Intelligence; status narrative; meaningful activity with truth labels; Participants and Current Context rail. Rules on lifecycle, roles, supersession, additive history. Readiness: **ready** | No Relationships *list* visual; the display labels for kinds and roles (see §3.4) |
| Activity | Nine truth types, presentation rules, the four human filters, unidentified activity kept operable. Readiness: **partially ready** | Advanced filter layout; prototype only |
| Intelligence | Ambient, Actionable and Governed levels. The CI surfaces keep their authority, with composition redesigned (dedicated plus contextual). Readiness: **ready** | Layout of the dedicated area beyond Case Explanation |
| Brain | The product contract (produce versus never establish); Understand → Recommend → Draft → Authorize → Act. Case Explanation visual under **Intelligence / Case Explanation**: an "Activation gated" pill, a "Design specimen · no model invocation" label, evidence with authority labels, a limitation, an output-contract rail, "Human authority required". Readiness: **activation gated** | Where running or waiting Brain work is shown outside Case Explanation. Whether provider names appear in the product (§11, decision 6). The execution split (Next Action 5) |
| Responsive / mobile | Desktop, tablet and mobile rules (p. 15). Drawers become full-screen sheets; tables become prioritized lists | Breakpoints and per-screen mobile layouts; prototype only |
| Shared visual primitives | Page zones; the Subject Display System; the visual grammar (subject, state, context, attention, provenance); three densities; semantic status colour; initials fallback | Token values |
| Empty / loading / error states | Definition of Done covers default, loading, empty, error, unresolved and unauthorized. "Unknown is displayed as unknown"; "No activity found is different from no activity occurred" | Visual treatment of each state; prototype only |

## 2. Readiness: the handoff's classification and repository fit

**Repository fit** was read from the code on `main`:
- **GREEN:** the authority and read model exist; UI work only.
- **YELLOW:** the authority exists, but a projection, wiring or decision is missing.
- **RED:** no authority exists.

| Surface | Handoff readiness | Repository fit | Why |
|---|---|---|---|
| Shell, global navigation, drawers, record grammar | Ready | YELLOW | `LOOP_NAV` still has today's groups (`one-loop-shell.test.tsx` pins them); no drawer or subject-header primitive exists; no `error.tsx`/`not-found.tsx` |
| People, Person | Ready | GREEN list; YELLOW record | `PartyRecordService` serves lists, records, posture, archived and supersession. Missing for the visuals: relationship context per row, opportunity counts, contact availability, a PARTY Activity subject |
| Companies, Company | Ready | GREEN list; YELLOW record | as People; plus no industry field on a Party |
| Relationships, Relationship | Ready | GREEN list and record; YELLOW Activity | read and write services, participants and events exist; no RELATIONSHIP Activity adapter |
| Intake | Ready | GREEN | legacy Customer repositories; the Intake → Party web linking decision is still open |
| Work | Ready | GREEN | Work OS |
| Intelligence | Ready | GREEN | CI services, the Decision Engine and CallGrid Intelligence |
| Operations, CallGrid | Ready | GREEN (placement pending) | authorities exist; the Operations prefix is undecided (D1) |
| Loop Home | Partially ready | YELLOW | see §5 |
| Universal Activity | Partially ready | YELLOW | `ActivityService` exists; no web page uses it; no PARTY or RELATIONSHIP subject |
| Creator Administration | Partially ready | YELLOW | Relationships of kind `TALENT_REPRESENTATION` with the `CREATOR` capacity exist; no creator-capability model or Operations surface |
| Opportunities, Campaigns, Universal Search | Backend work required | RED | no Opportunity or CRM Campaign authority; no unified search service |
| Brain Case Explanation | Activation gated | YELLOW | the Netlify path exists and is off; the B5 boundary (PR #278) is in review; no result store; nothing activated |

## 3. Screen map (the handoff's Screen Implementation Contract)

**The first vertical slice is the one the handoff names** (Next Actions, item 2): shell, People, Person
and Relationship. Those four are mapped in full; the rest follow in shorter form.

**Fields for every row:**
- the handoff's contract fields (Charlie and Lexi screen, route, authority, read model, actions,
  permissions, states, non-default states, responsive behaviour, missing dependency, PR);
- plus the temporary UI replaced, Activity, Brain, and the repository-fit status.

### 3.1 Shell (global shell, context header, context navigation, drawer)

| Field | Answer |
|---|---|
| Charlie and Lexi screen | The frame common to pp. 6, 7, 8 and 11: dark left rail (Loop mark; Home, CRM, Work, Intelligence, Operations), top bar (Search Loop; Needs You _n_), trail, header, tabs |
| Loop route | every signed-in page (`WorkspaceShell`) |
| Backend authority | `LOOP_NAV` and `navFor(session)` (permission and workspace filtered); each page guards itself |
| Read model | one `iam.canEach` read per request. The **Needs You** count needs the Home projection (§5) |
| Available actions | navigate; global search (today `/crm/search` over intake records, conversations and the workspace) |
| Permissions | unchanged; items appear only when their destination would open |
| Data and states | active area; counter known / unknown |
| Empty loading error | an unknown counter shows as unknown, never 0; there is no route-level error or not-found page today |
| Responsive | desktop full rail; tablet collapses supporting rails; mobile action-first (p. 15) |
| Missing dependency | regrouping `LOOP_NAV` to five areas changes the pinned shell test (a reviewed act); a settings entry point (C-01); the Needs You projection; token values (prototype) |
| Implementation PR | UI 0 (primitives) and UI 2 (navigation) |
| Replaces | today's groups `'' / CRM / Intelligence / Work OS / '' / Administration`, and the unlabeled Creator Hub and Accounting group |
| Repository fit | YELLOW |

### 3.2 People (list)

| Field | Answer |
|---|---|
| Charlie and Lexi screen | p. 6 "People list using governed identity state and relationship context" |
| Loop route | `/app/crm/people` (reserved for PERSON Parties by D2/C-04; no page exists) |
| Backend authority | Party and Identity (`PartyRecordService`, `PartyService`); Relationships (`CrmRelationshipReadService`) |
| Read model | `PartyRecordService.listPeople` (established, non-superseded PERSON Parties). **Gap:** the list carries no relationship context or opportunity count. A list projection is needed (a per-row `forParty` read would be N+1) |
| Available actions | **+ Establish person** → `PartyService.create` / `establish` (the operator flow on `/crm/parties` today) |
| Permissions | today `identityResolution:view`; establishing needs `identityResolution:approve`. Ordinary CRM users hold neither (§11, decision 3) |
| Data and states | Established; Unresolved (the visual's "Identity review required · Intake evidence available"); Superseded and Archived (Party states that exist) |
| Empty loading error | production holds **0 established Parties**: empty, and never a fallback to Intake Records |
| Responsive | the table becomes a prioritized list on mobile (p. 15); display density "compact subject row" (p. 14) |
| Missing dependency | the list projection (relationship context); **Opportunities column: no authority**, so it shows unavailable or is omitted, never "0 active"; the People permission; the unresolved-row decision (§11, decision 4) |
| Implementation PR | UI 3 (CRM area) / UI 5 (Person) |
| Replaces | the People section of `/crm/parties` (kept for verification until the replacement covers its workflows) |
| Activity / Brain | none on the list |
| Repository fit | GREEN (list); YELLOW (visual columns) |

### 3.3 Person (record)

| Field | Answer |
|---|---|
| Charlie and Lexi screen | p. 7 "Canonical Person record … with identity, context, activity, intelligence and action" |
| Loop route | `/app/crm/people/<partyId>` (engineering proposal within D1) |
| Backend authority | Party and Identity; Relationships; Work; CI; Activity |
| Read model | `PartyRecordService.getRecord` (identity, reference state, `archived`, establishment, posture, linked intake records); `CrmRelationshipReadService.forParty` |
| Available actions | **Email / Call / Message: no Party-level channel exists** (conversations belong to intake records), so they are unavailable. **+ Action** must list only permitted commands |
| Permissions | `identityResolution:view` today (§11, decision 3); relationship reads `relationships:view` |
| Data and states | Established; Superseded (explain, link to current, preserve history; `reference.canonicalPartyId`); Archived (`archived`); Unresolved activity (no Person record; open the Activity or evidence context) |
| Empty loading error | not found and unauthorized both render not-found |
| Responsive | the header becomes a "featured subject block"; rails collapse on tablet; action-first on mobile |
| Missing dependency | see the list below |
| Implementation PR | UI 5 |
| Replaces | `/crm/parties/[id]`; useful parts of `/crm/customers/[id]` (the handoff: "Transition and replace") |
| Activity / Brain | Activity needs a PARTY subject. A Person is not a Brain subject type today |
| Repository fit | YELLOW |

**Missing dependencies for the Person record:**

| Element | What is missing |
|---|---|
| Summary strip: Opportunities, Campaigns | no authority (RED) |
| Summary strip: Open Work | no Party reference on Work instances found |
| Tabs: Opportunities, Campaigns | unavailable |
| Tab: Activity | no PARTY subject in `ActivityService` |
| Tab: Intelligence, and "Loop noticed" | no CI subject for a Party |
| Identity rail: Email / Phone "Available" | `PartyRecordV1` carries no contact availability (evidence tier `NOT_AVAILABLE`) |
| Identity rail: "Confidence" | shows governed posture (C-05), never a number |

### 3.4 Relationship (record) and Relationships (list)

| Field | Answer |
|---|---|
| Charlie and Lexi screen | p. 8 "Relationship detail makes the connection itself operable without collapsing either Party". **No list visual exists**; the list uses the Subject Display System (p. 13 relationship card) |
| Loop route | `/app/crm/relationships` and `/app/crm/relationships/<id>` (engineering proposal within D1) |
| Backend authority | Relationships (`CrmRelationshipService`, `CrmRelationshipReadService`); Participants; CI (interpretation only) |
| Read model | `list`, `getRecord` and participants; `CrmRelationship.label`, `description` and `state`; events (`CrmRelationshipEvent`) |
| Available actions | end, reactivate, void; add, change, end and void a participant (authority inside the service; capabilities returned to the UI) |
| Permissions | `relationships:view`; writes per capability |
| Data and states | Active, Ended, Voided (projected from events); participant history additive |
| Empty loading error | "None yet" (production holds 0); not found and unauthorized both render not-found |
| Responsive | rails collapse on tablet; participants become a context card list |
| Missing dependency | see the list below |
| Implementation PR | UI 6 (Company and Relationship) |
| Replaces | `/crm/relationships`, `/crm/relationships/[id]` and `/new` (the handoff: "Replace engineering surface"), after the workflows and states are covered |
| Activity / Brain | RELATIONSHIP is an accepted Brain subject (B5); no task and no result store exist |
| Repository fit | GREEN (record and list); YELLOW (Activity, context, labels) |

**Missing dependencies for the Relationship record:**

| Element | What is missing |
|---|---|
| Kind and role labels | The visual shows "Managed Creator", "Commercial lead" and "Talent lead". The governed vocabularies are the kind `TALENT_REPRESENTATION` ("Talent representation"), the capacities (`CREATOR`, `BUYER`, …) and the engagement roles (`PRIMARY_CONTACT`, `DECISION_MAKER`, `BILLING_CONTACT`). A display-label decision is needed (§11, decision 5) |
| Internal team members as participants | The visual shows EMG staff as participants. Today a Relationship's accountable person is a **user** (`ownerUserId`), not a Party participant (§11, decision 5) |
| "Since 2026" | derivable from the first event |
| Tab: Activity, and "Meaningful activity" | no RELATIONSHIP Activity adapter |
| Tab: Opportunities, and "Current context" counts | no authority |
| Tab: Intelligence | no CI subject for a Relationship |

### 3.5 Companies and Company

- **Screen:** p. 8 (text) and the p. 13 Company card. **No Company page visual exists.**
- **Route:** `/app/crm/companies` and `/app/crm/companies/<partyId>`, an engineering proposal within D1.
- **Read model:** `PartyRecordService.listCompanies` and `getRecord`; `forParty`.
- **Gaps:**
  - an industry line (no Party industry field; `Organization.industry` belongs to the tenant);
  - opportunity counts (RED);
  - Activity (PARTY subject).
- **Must stay distinct:** Workspace (`/crm/organizations`) remains tenant administration, and is labelled
  "Workspace".
- **Slice:** UI 6. **Fit:** GREEN list; YELLOW record.

### 3.6 Intake

- **Screen:** p. 9. Intake is preserved and demoted: source, provenance, status, identity-resolution
  progress, never a lesser Person.
- **Routes:** `/crm/customers` (+ `[id]`, `/activity`), `/crm/pipeline`, `/crm/inbox`,
  `/crm/conversations`.
- **Read model:** the legacy Customer repositories.
- **Gap:** `CustomerPartyLinkService` exists, but no web surface links Intake to a Party. The web
  linking decision is open (`intake-party-linking-recommendation.md`), and **the Intake → Party fence is
  not weakened here.**
- **Fit:** GREEN.

### 3.7 Loop Home

- **Screen:** p. 4 (text only; no visual).
- **Route:** `/app`.
- **Authorities:** Needs You from the Decision Engine, Work, Identity and domain workflows; What Changed
  from Activity; Loop Noticed from CI; My Work from Work OS; Pulse from measurement sources.
- **Data map:** §5.
- **Replaces:** the nine-tile `AdminHome`, including its fixed status words (Business Status lists
  systems statically; CRM "Active"; Creator Hub "Not Configured"; Accounting "Not Connected").
- **Slice:** UI 1, after the CRM slice (see §7). **Fit:** YELLOW.

### 3.8 Universal Activity

- **Screen:** p. 10.
- **Authority:** `ActivityService.read`. The contract (`activity.v1`) already matches the handoff:
  - the same nine categories, in the same order;
  - the four human filters;
  - identity states `KNOWN_PARTY / KNOWN_COMPANY / UNRESOLVED / ANONYMOUS / NOT_APPLICABLE`;
  - no raw values and no confidence numbers.
- **Gaps:**
  - no web page uses `ActivityService` (CRM timelines use `crm/timeline.tsx`);
  - no PARTY or RELATIONSHIP subject exists (`activity.v1` names RELATIONSHIP, OPPORTUNITY and CAMPAIGN
    as reserved and refused until their authorities exist).
- **Slice:** UI 4. **Fit:** YELLOW.

### 3.9 Intelligence

- **Routes:**
  - `/app/admin/headlines`, `/app/admin/queue`, `/app/admin/cases/[id]`;
  - `/app/admin/marketplace` (+ tabs), `/app/admin/brain`;
  - `/crm/intelligence`, `/crm/analytics`, `/crm/traffic`, `/crm/revenue`, `/crm/live/*`.

  The target prefix `/app/intelligence` follows D1.
- **Authority:** CI, the Decision Engine and CallGrid Intelligence.
- **Composition (handoff):** Ambient, Actionable and Governed.
- **Findings:**
  1. `/app/admin/marketplace` enforces only the ADMIN workspace, while its navigation item states
     `intelligence:view` (a small separate authorization PR).
  2. `/app/admin/brain` is a deterministic executive view that shares the name "Brain" with the
     governed Brain (§11, decision 7).
- **Slice:** UI 9. **Fit:** GREEN.

### 3.10 Brain: Case Explanation and Brain work states

- **Screen:** p. 11, "Brain Case Explanation separates evidence, interpretation, limitations and human
  authority".
- **Location:** Intelligence / Case Explanation.
- **Authority and read model:**
  - the Case Explanation task (Netlify path, off);
  - the B5 Brain boundary (PR #278, in review): submit, status, question, answer, cancel;
  - phases QUEUED, WORKING, WAITING_FOR_YOU, COMPLETED, FAILED, CANCELLED.
- **States the visual establishes:**
  - **Activation gated.** Every submission is refused today (`NOT_ENABLED`), and the UI says so honestly.
  - **Design specimen, no model invocation.** Any preview is labelled as a specimen.
  - **Output contract** (what Brain may and may not produce).
  - **Human authority required.**
- **Gaps:**
  - no result store, so no job can complete;
  - no controls-recording workflow;
  - B5 not yet merged.
- **Slice:** UI 10 (the handoff's sequence; Matt's brief calls the Brain states UI-5). **Fit:** YELLOW.

### 3.11 Work, Operations and CallGrid, Creator Administration, Search, Opportunities, Campaigns, Workspace administration, Connections

| Surface | Handoff | Repository fit and gap |
|---|---|---|
| Work | Preserve authority; same shell and grammar | GREEN. `/app/admin/work*`, `/app/employee/work*`. "Workflows" is `soon` |
| Operations → CallGrid | Preserve authority, under Operations | GREEN. Operational surfaces (live calls, reconciliation, diagnostics) move to Operations; credentials go to settings (C-03). The Operations prefix is undecided |
| Creator Administration | New or reconcile; partially ready | YELLOW. `TALENT_REPRESENTATION` relationships and the `CREATOR` capacity exist; no Operations → Creators surface; `/app/admin/creator-hub` is a "not built" catch-all |
| Universal Search | Backend work required | RED for universal search. `/crm/search` covers intake, conversations and the workspace only |
| Opportunities | Backend work required | RED. No authority; do not build fake permanent screens against legacy pipeline fields |
| Campaigns | Backend work required | RED. "Campaign" today is only a CallGrid or traffic dimension |
| Workspace administration | Workspace Organization: preserve and contextualize | GREEN. Team, Workspace, Settings, Audit, AI Employees, Integration OS, Objectives; placement per C-01 |
| Connections (Google) | not in the handoff | RED. Contract only (`google-workspace-connection.md` §11, PR #279) |

## 4. Subject Display System and shared primitives (UI 0)

**The Subject Display System, as the handoff defines it:**
- **Card anatomy:**
  1. canonical name;
  2. canonical type and identity or lifecycle state;
  3. contextual role or reason;
  4. affiliation or relationship;
  5. one meaningful current fact or attention state;
  6. permission-aware navigation that preserves the context chain.
- **Densities:** compact row, standard card, context card, featured block.
- **Subjects:** Person, Company, Relationship, Workspace, Intake, Unresolved Activity.

**What the data supports for each subject:**

| Subject | Stable content available | Contextual content available | Missing |
|---|---|---|---|
| Person / Company | display name, type, establishment, supersession, archived | participant roles and relationships (`forParty`) | affiliation text ("Kona, Kai & Kaleo"), industry, opportunity counts, image |
| Relationship | label, kind, state, participants | events (for "activity yesterday") | display-label vocabulary |
| Workspace | organization | membership, permissions | — |
| Intake | source, status, provenance | identity-resolution progress | a linking surface (decision open) |
| Unresolved Activity | event and source provenance (`activity.v1`) | "identifier available" as a category, never the raw value | related-event grouping is limited: grouping by raw identifier is identity matching and is forbidden by the contract |

**Visual rules to encode:**
- photos never establish identity;
- initials fallback;
- roles are not Party types;
- status colour is semantic;
- "no activity found" differs from "no activity occurred";
- a relationship card is its own subject.

**Existing primitives to converge** (UI 0 locks the shell, record header, context navigation, status,
drawers, activity items and subject display components):

| Primitive | Exists today | Plan |
|---|---|---|
| Global shell | `WorkspaceShell`, `ShellNav` (client leaf) | keep; restyle to the handoff |
| Context header | partly: the `EntityPage` header; `crm-record-*` CSS | one subject header, used by the featured subject block |
| Context navigation | `SectionTabs` (with `soon`), `CallGridNav` | one tabs primitive; unavailable tabs are never links |
| Workspace and rail | `EntityPage` sections; `ContextCard`; operator `SideSummary` | one primary workspace with a supporting rail |
| Context drawer | `EvidenceDrawer` (marketplace); `<details>` | one drawer; full-screen sheet on mobile |
| Activity item | `Timeline`/`TimelineItem`/`ActivityTypeBadge`/`ProvenanceDisplay` | one item over `activity.v1`: truth type, collapsed story, expanded evidence |
| States | `StateBadge`/`NotKnown`/`ReadError`, `ShellPage`, `UnavailablePage`, `CrmLoadError`, `DbNotConfigured` (misused) | one family: default, loading, empty, error, unresolved, unauthorized, unavailable, superseded, archived |
| Status | `StateBadge`, `StatusDot`, `ds-status-dot`, `crm-status`, `ps-badge`, `SeverityTag`, `ConfidencePill` | one semantic scale (visuals: green for established or active; amber for unresolved or activation gated) |
| Styling | two vocabularies: `loop-os.css` (`loop-*`, `ps-*`, `ent-*`, `cw-*`) and `crm/design-system.css` (`ds-*`), plus sprint CSS | converge on one token set; no new CSS file (CLAUDE.md). Token values come from the prototype |

**Findings on existing screens:**
- Many CRM pages show "Database not configured" (`DbNotConfigured`) for **any** failed read.
- The intake record's "AI Activity" tab uses the purple accent that the handoff's visual grammar and the
  constitution rule out.

## 5. Home and Activity data availability

| Home section (handoff authority) | Source in code | Exists | Web-wired |
|---|---|---|---|
| Needs You: Decision Engine | CallGrid operational queue (`loadOperationalQueue`) | yes | yes (Intelligence) |
| Needs You: CI | `PersonalPriorityService.queueFor` | yes | yes (`/app/admin/queue`, ADMIN) |
| Needs You: Work | next action, notifications, unassigned work | yes | yes |
| Needs You: Identity | `PartyRecordService.listEstablishmentQueue` | yes | operator page only |
| Needs You: domain workflows | Brain `WAITING_FOR_YOU` (B5); invitations | B5 in review; invitations yes | no; partly |
| What Changed | `ActivityService` organization lane | yes | **no**; there is no "last operated" marker |
| Loop Noticed | `CaseWorkspaceService.attention`, headlines | yes | yes |
| My Work | `work` repositories | yes | yes |
| Operating Pulse | CallGrid aggregates; intake counts; website coverage | yes | yes (role filtering to decide) |

| Activity adapter | Subjects | Web-wired |
|---|---|---|
| Interactions | ORGANIZATION, INTAKE_RECORD | through `crm/timeline.tsx`, not `ActivityService` |
| CallGrid calls | ORGANIZATION | no |
| Observations | CASE | the Case page's own section |
| Messages, Audit | INTAKE_RECORD (Audit also ORGANIZATION) | through CRM pages |
| Work | WORK_ITEM | Work pages |
| Brain events | ORGANIZATION, CASE (ADMIN workspace; B5) | no |
| **Party, Company, Relationship** | **none** | — |

## 6. Read-model gaps

| Object | Gap surfaced by the handoff's screens |
|---|---|
| Person | a list projection with relationship context; contact availability; a PARTY Activity subject; a Party reference on Work; a CI subject; a Party-level communication channel; a People permission for ordinary CRM users |
| Company | the same, plus an industry or commercial-context field |
| Relationship | a RELATIONSHIP Activity adapter over `CrmRelationshipEvent`; display labels for kinds and roles; internal team participation (§11, decision 5); a CI subject |
| Opportunity | the entire authority |
| Campaign | the entire CRM authority, and composition with execution owners |
| Search | a governed universal search service |
| Home | a per-user "last operated" marker; the Needs You projection |

## 7. Pull-request sequence

This follows the handoff's Immediate Delivery Sequence:
1. lock primitives and the Subject Display System;
2. map every screen;
3. build the ready CRM slice;
4. then Activity and Home;
5. then the capabilities that need backend work.

**Every PR:**
- comes from fresh `main`, as a draft that Matt merges;
- completes one screen-map row;
- covers default, loading, empty, error, unresolved and unauthorized states;
- is verified on desktop, tablet and mobile;
- passes a production build and a client-bundle check;
- keeps the temporary screens until its replacement covers their workflows.

| Order | Handoff slice | Matt's brief | Scope | Depends on |
|---|---|---|---|---|
| 1 | UI 0 | UI-1, UI-2 | shell restyle, subject header, tabs, drawer, activity item, state family, **Subject Display System**; the `DbNotConfigured` fix; Home's fixed status words removed | token values (prototype); the token-set choice |
| 2 | UI 2 | UI-1 | five-area global navigation | the settings entry point; the route-approval decision; updating the pinned shell test |
| 3 | UI 3 + UI 5 | UI-3 | People and Person at `/app/crm/people` (read-only first, then Establish) | the People permission; the list projection; the unresolved-row decision |
| 4 | UI 6 | UI-3 | Companies and Company; Relationships and Relationship (replacing the operator pages) | display labels; the internal-participant decision |
| 5 | UI 4 | UI-4 | Activity through `ActivityService` on the existing subjects; then PARTY and RELATIONSHIP adapters (backend) | reviewed adapters |
| 6 | UI 1 | UI-1 (Home) | Loop Home, five sections | the "last operated" marker; the Needs You projection |
| 7 | UI 9 | UI-4 | Intelligence composition | — |
| 8 | UI 10 | UI-5 | Brain states and Case Explanation (activation gated) | B5 merged; the result store; controls workflow; decisions 6 and 8 |
| — | — | — | `/app/admin/marketplace` enforces `intelligence:view` | none |
| later | UI 7, UI 8 | — | Opportunity, Campaign | their authorities (PD-F-11, PD-F-12) |

## 8. What changed from the earlier draft

The earlier draft was built on the v1.0 architecture document. Reading the handoff changed the
following.

**Source and readiness:**
1. **Source of truth.** The handoff (2026-09-16) now controls, and v1.0 remains the underlying
   architecture. The claim that the latest artifact was missing is withdrawn, and so is the hold on
   UI-1 to UI-5 "until the artifact arrives".
2. **The Subject Display System is defined** (anatomy, densities, subjects, rules). It was listed as
   undefined, and is now §4 and part of the first PR.
3. **Readiness.** The handoff's classification is adopted beside the repository-fit column:
   - Person, Company and Relationship are "ready" by the handoff, with their remaining data gaps listed
     as dependencies;
   - Creator Administration moves from RED to "partially ready" / YELLOW;
   - Search is "backend work required".

**Screens:**

4. **Row format.** Rows now use the handoff's Screen Implementation Contract fields, including the
   Charlie and Lexi screen reference and responsive behaviour.
5. **The first slice** is the handoff's shell, People, Person and Relationship, not Home.
6. **New gaps from the visuals:**
   - relationship context and opportunity counts in the People list;
   - contact availability on a Person;
   - Company industry;
   - kind and role display labels;
   - internal team members as Relationship participants;
   - the Needs You counter in the top bar;
   - Person Email / Call / Message actions without a Party channel.
7. **Brain.** Case Explanation sits under Intelligence, with explicit "activation gated" and
   "design specimen" states. The handoff's execution-split request and its provider-name display are
   now recorded as decisions.
8. **Needs You** includes Identity (the establishment queue) as a source, as the handoff specifies.

**Routes and sequence:**

9. **Routes.** The handoff gives route mapping to engineering. This conflicts with D1, which gives the
   route-transition proposal to Charlie and Lexi, and is recorded as a decision rather than as
   "waiting for a proposal".
10. **Sequence.** It now follows the handoff's delivery order (primitives, CRM slice, Activity, Home).

## 9. Findings carried from the repository

- `DbNotConfigured` is shown for any failed read, on 16 CRM pages.
- `AdminHome` shows fixed status words for systems it does not read.
- `/app/admin/marketplace` enforces less than its navigation item states.
- No web page uses `ActivityService`.
- Two CSS vocabularies exist.
- The "AI Activity" tab uses a purple accent.
- There is no route-level error or not-found page.

## 10. Temporary engineering screens

`/crm/parties` and `/crm/relationships` stay available for verification only. Each is retired only when
its redesigned replacement covers the same governed actions (create, establish, end, reactivate, void,
participants) and their non-default states (handoff, Next Actions 6).

## 11. Unresolved decisions (specific)

1. **Route approval.** The handoff says engineering owns the route-to-contract mapping; the locked D1
   says Charlie and Lexi own the route-transition proposal. Who proposes, and who approves, the
   `/app/crm/*`, `/app/work`, `/app/intelligence` and Operations moves? The Operations prefix is also
   still unset.
2. **Settings entry point.** The visuals show only the five areas. Where do Team, Workspace, Settings,
   Audit, AI Employees and Integrations appear (C-01)?
3. **People and Companies permission.** Today only `identityResolution:view` opens them, which ordinary
   CRM roles lack.
4. **Unresolved rows in People.** The People visual includes an "Identity review required" row; the text
   says People holds established Parties (C-04). Are unestablished PERSON Parties shown in the list
   under the State filter, or only in a separate review queue?
5. **Relationship vocabulary and team participants.**
   - Which display labels map to governed kinds and roles? For example, "Managed Creator" against
     `TALENT_REPRESENTATION`, and "Commercial lead" or "Talent lead", which exist in no role vocabulary.
   - Are internal team members Relationship participants (as Parties), or shown from the accountable
     user?
6. **Provider names in the Brain UI.** The handoff's output-contract rail shows "Anthropic + OpenAI
   boundaries"; the run brief asked for provider-neutral Brain wording.
7. **"Brain" naming.** The deterministic executive page `/app/admin/brain` versus the governed Brain.
8. **Brain execution split** (handoff, Next Actions 5). B3 chose AWS for both interactive and durable
   work. The handoff allows a synchronous path for requests that fit the host limit. Confirm.
9. **Person communication actions.** Email / Call / Message have no Party-level channel. Hide them,
   show them as unavailable, or route them through linked intake records (which touches the Intake
   fence)?
10. **Tokens and responsive layouts.** They exist only in the interactive prototype, whose link is not
    in the PDF. Share the prototype link.
11. **Opportunity and Campaign authorities** (PD-F-11, PD-F-12). The **Intake → Party web-linking**
    decision also remains open.

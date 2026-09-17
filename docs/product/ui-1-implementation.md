# UI-1 — the permanent shell and the first redesigned CRM slice

**Status: BUILT, IN REVIEW (draft PR). No migration, no authorization change, no AI.**

**Sources.** In order of authority:
1. Charlie and Lexi's *Loop Product and UI Redesign — Implementation Handoff* (2026-09-16), read in
   full.
2. The screen map in `ui-0-implementation-matrix.md`.
3. Five mobile screenshots of the interactive prototype, supplied by Matt on 2026-09-17: Home, People,
   Intelligence / Case Explanation, Operations and Work.

**Visual reading.** The handoff's embedded visuals could not be opened in this session: the image
viewer was unavailable. Their layout facts come from UI-0's record of them. Colours, type and the mobile
shell come from the prototype screenshots.

**Scope.** Matt's run brief, UI-1 items B1–B9. Matt's locked decisions of 2026-09-17 apply
(engineering chooses routes; settings may sit in an admin area; People are established Parties only;
Email, Call and Message are never faked; the normal Brain UI is provider-neutral).

---

## 1. What was built

| Item | Where | Notes |
|---|---|---|
| **B1 Design primitives** | `apps/web/src/app/loop-os.css` (`:root` foundation, LOOP PRIMITIVES); `_loop-os/record.tsx` | See the list below |
| **B2 Permanent shell** | `workspaces/config.ts` (`LOOP_NAV`), `ShellNav.tsx`, `WorkspaceShell.tsx` | Five operating areas; Administration at the foot; a mobile bar and menu. See §2 |
| **B3 Subject Display System** | `crm/subject-display.ts` (model), `_loop-os/subject-card.tsx` (drawing) | Six-part anatomy; four densities; six subject types; the visual rules. See §3 |
| **B4 People** | `/app/crm/people` | Established PERSON Parties only. See §4 |
| **B5 Person** | `/app/crm/people/[partyId]` | The Denise K layout, from real data only. See §5 |
| **B6 Relationship** | `/app/crm/relationships`, `/app/crm/relationships/[relationshipId]` | See §6 |
| **B7 Activity preparation** | `_loop-os/activity-item.tsx`; `crm/relationship-history.ts` | See §7 |
| **B8 Brain states** | `_loop-os/brain-state.tsx`; words in `@emgloop/shared` `BRAIN_WORK_LANGUAGE` | See §8 |
| **B9 Screenshots** | local only, synthetic data | See §10 |
| Honest failure notice | `demo/db-health.tsx` `DataUnavailable` (was `DbNotConfigured`) on 16 CRM pages | "Database is not configured" now appears only when there is no `DATABASE_URL`; a failed read says it failed |

**B1 primitives in `record.tsx`:**
- the light record canvas (`LxPage`);
- a context trail and page head;
- the state pill;
- action buttons, which are inert, with a reason, when the capability does not exist;
- context tabs, where unavailable tabs are never links;
- the summary strip, where unknown is never zero;
- the record layout (workspace plus supporting rail);
- panels and fact lists;
- the context drawer, which becomes a full-screen sheet on phones;
- the state family: empty, unavailable, error, not-permitted and attention;
- `ReadFailed`;
- a loading skeleton.

## 2. Shell and navigation

**Grouping.** `LOOP_NAV` is the one registry, grouped as the handoff's five areas:

| Area | Items |
|---|---|
| Home | Home |
| CRM | People, Relationships, Command Center, Opportunities (Soon), Campaigns (Soon), Conversations, Intake Records, Intake Board, Identity Review, Inbox, Search, Automations |
| Work | My Work, Team Work, Workflows (Soon), Work Types |
| Intelligence | Headlines, Your queue, Executive Brain, Intelligence Flow, CallGrid Intelligence, Analytics, Traffic, Revenue |
| Operations | Live Operations, Live Calls, Websites, Creators |
| Administration (foot; not an area) | Team, Workspace, Settings, Objectives, Audit Log, AI Employees, Integration OS |

**Permissions.**
- **Unchanged.** Every item still states exactly the authority its page enforces, and the per-role
  navigation is the same set of destinations as before, regrouped. The shell test proves this for
  every role.
- **No route moved.** New routes live under `/app/crm` (the D1 prefix); everything else stays where it
  was.

**Label changes:**

| Before | After | Why |
|---|---|---|
| Parties | Identity Review | Identity review is its own governed workflow (locked decision 17). The temporary operator screen still serves it, and still lists Companies |
| Brain (`/app/admin/brain`) | Executive Brain | The deterministic page must not define the governed Brain (decision 20). "Executive Brain" is already its own card title |
| Creator Hub | Creators, under Operations | C-02 |
| Accounting | removed from global navigation | C-01: surfaced contextually. It is not built; its honest not-built route still exists |
| Live Operations, Live Calls, Websites | moved from Intelligence to Operations | C-03: live execution and health |

**Desktop:** the navy navigation rail, a light top bar and the light canvas.

**Narrow screens** (820 px and below) use the handoff's responsive treatment, not a shrunken sidebar
(locked by Matt, 2026-09-17):
- **A light header with a Menu control.** Menu is a checkbox and label, so it needs no JavaScript.
- **The full navigation** opens as a light, scrollable sheet with touch-sized links.
- **A fixed operating-area bar** (Home, CRM, Work, Intel, Ops) sits at the bottom, as in the prototype:
  - each tab leads to the area's first item that person can open;
  - an area with nothing to open has no tab;
  - the current area is marked.
- **The desktop top bar is hidden,** so a phone has one header.

**Not built, and why:**
- **Search Loop:** universal search is backend work (the handoff calls it "backend work required").
- **Needs You _n_:** no Needs You projection exists, and an unknown count must never read as zero.
- **The person-name root of the top-bar breadcrumb** is kept (it is pinned by the shell tests). The
  handoff's area / section / subject trail is drawn in each redesigned page header.

## 3. Subject Display System

**Anatomy, in order.** Canonical name; canonical type and identity or lifecycle state; contextual role
or reason; affiliation or relationship; one current fact; one permission-aware action.

**Densities:**

| Density | Used for | Behaviour |
|---|---|---|
| `row` | search, tables | |
| `card` | lists | |
| `context` | rails, drawers | |
| `featured` | record headers, mobile summaries | the page heading, never a link |

**Subjects.** Person, Company, Relationship, Workspace, Intake record, Unresolved activity.

**Rules encoded and tested:**
- **The type is only the canonical type.** Roles such as Creator appear in the context line.
- **No images.** Initials or a neutral mark are used instead. A relationship shows "↔", and unresolved
  activity shows "?", never letters.
- **Placeholders are styled as placeholders:** "Unnamed person", "A person" (a name the viewer may not
  read), "Party unavailable".
- **A fact carries what Loop knows:**
  - `known`;
  - `none-found`: "No relationship recorded";
  - `unavailable`: "Relationship context unavailable".
- **A relationship is one subject** ("EMG ↔ Denise K"), never two Party cards.
- **Neither intake nor unresolved activity becomes a Person.**

**Governed words only.**
- The relationship kind uses its authority's own label (`kindLabel`, e.g. "Talent representation").
- Participant roles and lifecycle states have **no approved display labels**. They are shown as the
  governed value in sentence case ("Creator", "Primary contact", "Active") by one function,
  `governedTerm`.
- The prototype's "Managed creator", "EMG · Managed Creator" and invented affiliations are **not
  reproduced** (§11, decision 1).

## 4. People (`/app/crm/people`)

**Screen contract (UI-0 §3.2, completed):**

| Field | Answer |
|---|---|
| Authority | `PartyRecordService.listPeople`: established, non-superseded, non-archived PERSON Parties, 25 per page. Relationship context comes from `CrmRelationshipReadService.forParty`, one bounded read per row. A list projection would remove the per-row reads; it does not exist yet |
| Permission | `identityResolution:view`, enforced by the page before any read and again by the service. The nav item states the same |
| Columns | Person (row subject), Relationship context, State. **No Opportunities column:** no authority exists, and a note says so |
| Actions | **+ Establish person** leads to the governed identity workflow (the temporary operator screen) and is offered only with `createParty`. Otherwise it is inert, with a reason |
| Identity review | "Awaiting identity review · _n_" (unestablished PERSON records, a real count capped at 100+) links to that workflow. Those records are **not** listed as People |
| States | loading (skeleton); empty (first page, or past the end); error (`ReadFailed`: "a failure to read, not a finding"); not permitted (service refusal); stale page link (`INVALID_CURSOR`); partial (relationship context unreadable for some rows, flagged, with those rows saying "unavailable") |
| Filters | "All people" only. The prototype's Relationship and State drop-downs are not built: the list authority cannot filter by either, and a control that filters nothing would be fake |
| Responsive | the table becomes a prioritized list at 760 px and below |

## 5. Person (`/app/crm/people/[partyId]`)

**Data shown:**
- **Identity:** type, identity state, establishment date, basis and actor, and the same-person check.
  "Confidence" is governed posture (C-05), never a number.
- **Limitations** are stated in words.
- **How Loop knows them:** linked intake records, labelled as evidence rather than as the person, with
  links only for people who may open intake.
- **Relationships:** as cards.
- **"What is happening now":** built only from those relationships.

**States:**

| State | Shown as |
|---|---|
| Established | the default record |
| Identity review required | a notice with a link to identity review |
| Superseded | a notice naming the current record, with a link; history kept |
| Archived | a notice; history kept; new commercial action restricted |

**Not found.** A missing id, another workspace's id, a refused read and a Company id all render not
found.

**What is said instead of invented:**

| Element | Shown as | Why |
|---|---|---|
| Email / Call / Message | inert buttons with a reason | no governed Party channel exists |
| Opportunities, Campaigns | "Not tracked yet" | no authority |
| Open work | "Not linked yet" | Work carries no Party reference |
| Activity | an "unavailable" block: "This does not mean nothing happened" | no PARTY subject in `ActivityService` |
| Intelligence tab | unavailable | a Person is not a Brain or Commercial Intelligence subject |
| Email and phone | "Not part of a person record yet" | the Party read model carries no contact data by contract |

## 6. Relationships and Relationship

**List (`/app/crm/relationships`):**
- Relationship cards from `CrmRelationshipReadService.list`, 24 per page.
- **Filters:** "Current and ended" and "Including voided" are real server options.
- **Recording a relationship** leads to the governed verification form, and only with `create`.
- **Names.** Party names are shown only if the viewer may read identity; otherwise a notice explains
  the "A person" placeholders.

**Record (`/app/crm/relationships/[relationshipId]`):**
- **Header.** "EMG ↔ Denise K", its state, and "Talent representation · Since 2026".
- **Summary.** Since, participants, and Opportunities and Work shown as unavailable.
- **Tabs.** Overview, Participants and History link within the page. Activity, Opportunities and Work
  are unavailable.
- **Main area.** A status sentence, the recorded history (§7), and the Brain panel (§8).
- **Rail.** Participants as context cards (governed role, side, state, dates) and the current context
  (kind, structure, state, business dates, accountable user, recorded date).
- **Duplicates.** A duplicate-sides warning links to the other record.
- **Governed acts** (end, reactivate, void, participants) remain on the temporary verification screen.
  "Manage relationship" appears only when the viewer holds one of those capabilities.
- **Not found.** A refused or missing record renders not found.

**Not reproduced from the visual:**
- **Internal team members as participants.** Accountability is a workspace user, shown as "A workspace
  member" (§11, decision 2).
- **Invented role names.**

## 7. Activity preparation

**The primitive.** `ActivityItem` / `ActivityList` render one item over the handoff's nine truth types:
- **collapsed:** the kind of truth, the story and the time;
- **expanded:** the evidence;
- **interpretation** (signal, finding, recommendation) is drawn differently and says "Interpretation,
  not a recorded fact".

**Where it is used.** Only on the Relationship record, for the Relationship authority's **own event
log**:
- lifecycle events are changes; details, owner and participant events are audit history;
- reason text is never returned, so only "Recorded" or "None recorded" is shown.

This is not Universal Activity, and the page says so.

**Blockers for Universal Activity on People and Relationships** (backend, reviewed):
1. `ActivityService` has no PARTY or RELATIONSHIP read subject; `activity.v1` reserves RELATIONSHIP and
   refuses it.
2. No governed attribution produces KNOWN_PARTY items (identity slice 2.5).
3. A RELATIONSHIP adapter over `CrmRelationshipEvent` needs review.

No web page used `ActivityService` before this PR, and none does now. No Party feed was composed.

## 8. Brain work states

**The component.** `BrainWorkState` renders these states:

| State | Source |
|---|---|
| not switched on | |
| nothing running (idle) | |
| queued / working | with steps finished, never a percentage, and a polite live region |
| needs your answer (waiting) | |
| finished (completed) | |
| did not finish (failed) | |
| stopped (cancelled) | |

**Words.**
- **One dictionary.** They come from `@emgloop/shared` (`BRAIN_WORK_LANGUAGE`, `BRAIN_END_REASON_LANGUAGE`),
  kept out of the flat `productLabel` lookup so generic names such as FAILED cannot answer for other
  domains.
- **Provider-neutral.** An unavailable provider reads as "The reasoning service was unavailable".
- **Finished is not accepted.** A finished job's detail says the owning part of Loop decides what is
  accepted.
- **The authority boundary is always visible.**

**Where it is mounted.** Only on the Relationship record (RELATIONSHIP is an accepted Brain subject).
- While the AI floor is off, the panel shows "Not switched on", which is what production shows.
- Otherwise it shows the unfinished work `BrainWorkService.forSubject` reports, or "Nothing running".
- It starts nothing. No live AI call is made anywhere.

## 9. The design system (revised 2026-09-17)

**Matt's correction.** The redesign is Loop's **global** design system, not a CRM-local light layer.
The first version of this PR drew the redesigned pages on a local `.lx` canvas with its own tokens,
over the dark shell. That was two design systems, and it is gone.

**What replaced it:**
- **Tokens.** One palette, the `:root` `--loop-*` tokens in `loop-os.css`, with the handoff's values.
- **Shell.** A navy rail, a light top bar and a light canvas.
- **Primitives.** The UI-1 primitives moved to the global `loop-*` names.
- **Loop Home** is built from them.
- **Legacy surfaces** are repainted: `--crm-*` are aliases, and hard-coded dark colours are mapped to
  tokens.

**The record** is `docs/product/loop-design-system.md`: the reconciliation, what is shared, the
remaining older structures, the migration order, and the alias names that remain and when they go.

## 10. Screenshots (B9)

**How they were taken.**
- **Environment.** A local production build (`next start`) against a disposable local PostgreSQL 18
  (36 migrations). Captured with headless Chromium.
- **Data.** Synthetic data, created through the real `PartyService` and `CrmRelationshipService`:
  - people: Denise K, Avery Stone, Jordan Lee and Priya Raman;
  - two records awaiting review;
  - a superseded record and an archived record (set directly in the local database, since nothing in
    the product writes supersession yet);
  - two companies;
  - four relationships, one of them ended;
  - a second, empty workspace;
  - a read-only user.
- **Nothing shared.** No shared or production data was touched.

**Captured:**

| Surface | Views |
|---|---|
| Shell and People | desktop |
| Person | desktop (Denise K), superseded, archived, not found |
| Relationships | list |
| Relationship | Denise K (history opened), ended |
| Home | inside the shell |
| Tablet | Person |
| Phone | People, Person, Relationship, menu open |
| Empty workspace | People, Relationships |
| Read-only user | Relationship |
| Specimen | Subject Display System and states (desktop and phone), rendered from the real components |

**Automated audit** (320, 390, 900 and 1,440 px wide):
- no horizontal page overflow;
- one `h1` per page;
- no text below WCAG AA contrast on the redesigned pages.

**Compared with the handoff and prototype:**
- **Matches:** subject-first headers with a trail; five areas; mobile area bar; initials avatars;
  People columns (Person, Relationship context, State); a navy "+ Establish person"; underlined tabs;
  amber attention; the Person strip (Relationships, Opportunities, Campaigns, Open work); the
  Relationship rail (Participants, Current context).
- **Deliberately different:**
  - no Search Loop or Needs You counter;
  - no Relationship or State filter controls;
  - no Opportunities column or values;
  - governed words instead of the prototype's role names;
  - no photos;
  - Email, Call and Message are inert;
  - the "Design states" switcher is a prototype control, so every state is a real, reachable state
    instead.

## 11. Unresolved decisions for Charlie and Lexi (and Matt)

1. **Display labels for roles and kinds.** Which label, if any, maps to each governed value? The
   prototype shows "Managed creator" and "EMG · Managed Creator", where the authority says
   `TALENT_REPRESENTATION` ("Talent representation") and the capacity `CREATOR`. It also shows
   "Commercial lead" and "Talent lead", which exist in no vocabulary. Until decided, governed values are
   shown.
2. **Internal team members on a Relationship.** Participants (as Parties) or the accountable workspace
   user?
3. **Affiliation text on People** ("Kona, Kai & Kaleo", "Healthcare"). Only a governed Affiliation
   relationship can supply it, and no industry or vertical field exists on a Party.
4. **Relationship and State filters on People.** They need a list authority that can filter. Build it,
   or drop the controls from the design?
5. **Search Loop and Needs You in the top bar.** Both need backend work (universal search; the Needs You
   projection).
6. ~~The navy rail.~~ **Resolved (Matt, 2026-09-17).**
   - Desktop: a navy rail, a light top bar and a light canvas.
   - Mobile: the light responsive header and navigation.
   - Everywhere: one set of tokens and components (`loop-design-system.md` §0).
7. **The People permission.** People and Relationships are still gated by `identityResolution:view` and
   `relationships:view`. AI principals and unknown roles hold neither, which is intended. Confirm that
   ordinary CRM roles should keep seeing People through identity authority.
8. **Tokens and interaction timing beyond the screenshots.** The prototype link is still not in the
   PDF.
9. **Companies.** The Company record and list are the next slice. The operator screen still lists
   Companies under Identity Review.

## 12. Temporary engineering screens

`/crm/parties` (now reached as Identity Review) and `/crm/relationships` stay, for verification and for
the governed acts they hold:
- create and establish;
- end, reactivate and void;
- add, end and void participants.

The redesigned pages link to them only for people who may act. They are retired only when the redesign
covers those acts and their states (handoff, Next Actions 6).

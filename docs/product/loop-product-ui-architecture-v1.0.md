# Loop Product and UI Architecture v1.0

> **Source of record.** Verbatim transcription of *Elite Media Group — Loop Product and UI Architecture
> v1.0* (12-page PDF, dated September 15 2026, prepared by Charlie Brugnolotti and Elite Media Group),
> supplied by Matt Dunn on 2026-09-15 as the controlling Product/UI architecture. The text and tables
> below are the document's own wording; only the layout was converted to Markdown. Nothing in the
> transcription was added, removed or reinterpreted. Where this document and a locked platform decision
> disagree, the disagreement is recorded and taken to Product. It is not resolved silently here.
>
> **Product annotations.** Blocks headed *Product annotation* are not part of the source document. They
> record Product's resolution of a disagreement and say how a phrase is read in Loop. They do not change
> the document's wording or its UX intent.

> **Product annotation — conflict resolutions C-01 to C-05 (Product, 2026-09-15).** Five disagreements
> between this document and the locked application-structure decisions were resolved:
>
> - **C-01.** The five operating areas win. Administration capabilities are system/workspace settings or
>   contextual administration. Accounting stays its own domain, surfaced contextually. This is
>   information architecture only: no route migration during Identity 2.0/2.0b.
> - **C-02.** Creator Hub is not a peer area. Creator administration is Operations → Creators, and
>   `/app/creator` may stay transitional. External participant authentication, memberships, portals and
>   multi-org sign-in are not authorized.
> - **C-03.** CallGrid is split by authority. Operational surfaces go to Operations → CallGrid,
>   analytical surfaces to Intelligence, and credentials, connection state and integration governance to
>   system/workspace administration. There is no duplicate tree.
> - **C-04.** People are established, non-superseded PERSON Parties. Companies are established,
>   non-superseded COMPANY Parties. Legacy Customer records are Intake Records.
> - **C-05.** "Identity confidence" means governed identity posture, never a number.
>
> Recorded in `docs/architecture/loop-application-structure.md` (D1–D5 and its decisions log) and
> `docs/architecture/identity-evidence-resolution.md` (§2, §10, §11, §11a and the decisions log).

*Canonical product design and implementation handoff*

| Document | Detail |
|---|---|
| Status | Approved product direction |
| Prepared for | Matt Dunn and the Loop implementation team |
| Prepared by | Charlie Brugnolotti and Elite Media Group |
| Date | September 15 2026 |
| Scope | Product interaction model, information architecture, record grammar, implementation sequence, and architectural controls |

This document converts the approved Loop product direction into build instructions. It defines the interface chassis, navigation model, canonical record experience, activity and intelligence language, visual system, screen disposition, and implementation sequence. The implementation team should use it as the controlling UI specification while preserving the domain authorities and invariants already established in the platform architecture.

The central decision is that Loop will operate as one governed system. Internal operating areas, external participant experiences, and contextual record navigation may present different views, but they must compose the same underlying authorities. The interface may project and explain truth; it may not create truth for presentation convenience.

## Executive Direction

Loop is moving from a collection of application surfaces toward a subject-first operating environment. The global shell tells the user where they are operating. The current subject determines contextual navigation. Home begins the operating day by showing what needs human attention, what changed, what Loop has established, and what work is next.

### Approved Product Model

- One Loop shell with five internal operating areas: Home, CRM, Work, Intelligence, and Operations.
- Responsive participant experiences for creators, clients, publishers, sources, and partners.
- Subject-first navigation across Person, Company, Relationship, Opportunity, Campaign, Work, Investigation, and operational subjects.
- A universal activity projection that preserves source authority and permits unresolved or anonymous activity.
- Contextual intelligence presented only where it changes understanding or action.
- Visible human and machine authority boundaries throughout the product.

### Implementation Directive

Implement the redesign through vertical UX slices. Begin with reusable interface primitives, then Loop Home, navigation, CRM architecture, activity, and the canonical records as their governed read models become available. Do not perform a broad frontend rewrite, change domain ownership, or invent missing backend support to complete a screen.

### Product Cycle

The primary operating cycle is Need to Change to Understanding to Action to Outcome. Facts provide evidence. Evidence supports understanding. Understanding produces recommendations. Authorized decisions create work. Work produces outcomes, and outcomes become new facts. The product interaction model should make this cycle visible without forcing users to understand the architecture beneath it.

### Nonnegotiable Outcome

The redesigned product must feel coherent while remaining architecturally honest. Unknown must remain a valid state. Unidentified activity must remain visible. AI output must remain distinct from fact. UI composition must never transfer authority between domains.

## Product Structure

### Internal Operating Areas

| Area | Purpose | Primary Content |
|---|---|---|
| Home | Begin the user's operating day | Needs You, What Changed, Loop Noticed, My Work, Operating Pulse |
| CRM | Understand, strengthen, and monetize commercial relationships | People, Companies, Relationships, Opportunities, Campaigns, Activity |
| Work | Coordinate and execute authorized work | Assignments, status, dependencies, waiting, outcomes |
| Intelligence | Investigate governed understanding | Investigations, Findings, Recommendations, Decisions, Monitoring |
| Operations | Operate specialized business capabilities | CallGrid, Creator Management, and future operational modules |

> **Product annotation (C-01, C-03).** Administrative capabilities (Workspace, Team, Settings, Setup,
> Audit, AI Employees, Integrations, permissions and governance) are system/workspace settings or
> contextual administration, not an operating area. Accounting is its own domain, surfaced contextually.
> Under Operations, CallGrid holds only operational surfaces: live execution, routing, operational
> configuration, reconciliation, diagnostics and health. CallGrid's analytical surfaces belong to
> Intelligence. Its credentials, connection state and integration governance belong to system/workspace
> administration. No route moves during Identity 2.0/2.0b. Charlie and Lexi own the route-transition
> proposal.

### Responsive Participant Experiences

Creator Hub and customer-facing screens remain part of Loop, but they are not peer operating areas. They are responsive projections composed for a participant according to identity, membership, participation, and permissions.

| Participant | Illustrative Navigation | Internal Administrative Surface |
|---|---|---|
| Managed creator | Home, Opportunities, Campaigns, Deliverables, Messages, Earnings | Operations then Creators |
| Client | Home, Campaigns, Performance, Approvals, Messages | CRM and relevant operational records |
| Partner or source | Context-specific status, reporting, messages, and actions | Relevant CRM or Operations authority |

Global Loop navigation describes operating authority. Responsive experiences describe participation. Contextual navigation describes the subject currently being operated on.

> **Product annotation (C-02).** Internal creator administration is Operations → Creators. `/app/creator`
> may remain as a transitional route, and there is no second Creator application. External participant
> authentication, participant memberships, participant portals and multi-org sign-in are not authorized.
> The participant experiences above are direction, not an authorization to build them.

## Navigation and Context

### Global Navigation

The internal global navigation is Home, CRM, Work, Intelligence, and Operations. It remains stable, narrow, permission-aware, and shared across the internal product. Current modules move beneath the appropriate operating area instead of becoming separate shells.

### Contextual Navigation

The selected object determines the tabs and actions. A Person may expose Overview, Relationships, Opportunities, Campaigns, Activity, Work, and Intelligence. An Opportunity may expose Overview, Participants, Activity, Commercial, Work, and Intelligence. This preserves orientation while allowing each object to emphasize its own operational needs.

### Context Chain

Loop should retain the path by which the user entered a subject, such as Nordstrom to Relationship to Opportunity to Campaign. This path supports lateral navigation and preserves working context. It is navigation state only. It does not create or modify canonical relationships in the domain model.

### Subject First Rule

Users operate on subjects rather than moving through isolated pages. Opening a related object should retain the prior commercial or operational context. Closing a drawer or returning from a related record should restore the user to the context from which they entered.

## Loop Home

Loop Home is the beginning of the operating day, not a conventional metric dashboard. Every element must answer one of four questions: What changed, what matters, what did Loop notice, and what needs me.

| Section | Purpose | Authority Rule |
|---|---|---|
| Needs You | Items where the system has reached the boundary of its authority and requires a person | Projection only; the source domain retains approval or work authority |
| What Changed | Meaningful state changes since the user last operated | Project authoritative events; do not reproduce notification noise |
| Loop Noticed | Findings or recommendations relevant to the user | Show status, evidence basis, and required next authority |
| My Work | Compact orientation to today, overdue, waiting, and upcoming work | Work OS owns execution |
| Operating Pulse | A small set of authority-filtered operating metrics | Supporting context, never the primary hero |

### Priority Order

1. Needs You receives the highest visual priority.
2. What Changed establishes the current operating context.
3. Loop Noticed adds governed interpretation.
4. My Work provides execution orientation.
5. Operating Pulse provides supporting metrics.

Home starts with action and ends with metrics. It must not become a duplicate Work queue, an Intelligence dashboard, or an operational console.

## CRM Architecture

CRM exists to understand, strengthen, and monetize commercial relationships. Its primary views are Command Center, People, Companies, Relationships, Opportunities, Campaigns, and Activity. These are views into one commercial system rather than disconnected databases.

### CRM Command Center

The Command Center answers where business is moving, where it is stuck, which relationships need attention, which opportunities changed, and which commercial decisions are pending. It may compose work and intelligence but does not own either. It does not contain the creator roster or CallGrid operational controls.

### Canonical Authorities

| Object | Question Answered | Key Boundary |
|---|---|---|
| Person | Who is this person and how do we know and relate to them | Only governed Party associations appear |
| Company | What commercial organization is this and what surrounds it | Company Party is distinct from Workspace Organization |
| Relationship | What exists between parties and who participates | Relationship facts remain separate from CI interpretation |
| Opportunity | What commercial intent is being pursued | Requires canonical Opportunity authority |
| Campaign | What was sold, agreed, or commercially intended | Execution and performance remain composed from their owners |
| Intake | What entered the commercial intake process | Intake is not identity and does not automatically create a Person |

> **Product annotation (C-04).**
> - People are established, non-superseded PERSON Parties. Companies are established, non-superseded
>   COMPANY Parties. Intake is entry into a commercial process.
> - Legacy Customer records are **Intake Records**. `/app/crm/people` is reserved for PERSON Parties.
> - Customer ≠ Person ≠ Party. An Interaction, a caller ID, an anonymous visitor and an Intake record are
>   each not a Person. FACT ≠ IDENTITY ≠ INTAKE.

## Canonical Record Experience

Every serious Loop record uses a shared five-part grammar. The user learns one interaction language even when the underlying objects differ.

1. Identity answers what the user is looking at.
2. State shows what is currently true.
3. Context shows how the subject relates to other subjects and activity.
4. Activity explains what happened over time.
5. Intelligence and Action show what Loop understands and what should happen next.

### Person

A Person record shows identity confidence, contextual roles, communication actions, relationships, active opportunities and campaigns, open work, activity, and relevant intelligence. A managed creator remains a Person with creator participation and capability. Creator is not a Party type.

> **Product annotation (C-05).** "Identity confidence" means **governed identity posture**. It is made up of:
>
> - establishment state and basis;
> - CONFIRMED_SAME_PARTY, POSSIBLE_MATCH or UNRESOLVED;
> - evidence tier;
> - provenance;
> - freshness;
> - limitations;
> - conflicting evidence.
>
> It is never a 0–1 score, a percentage, an AI confidence number or a weighted frequency score.
> Definition: `docs/architecture/identity-evidence-resolution.md` §11a.

An unresolved caller is not a Person. Selecting unidentified activity opens the Activity or Event context until governed identity resolution establishes a Party.

### Company

A Company record uses the same interaction grammar as Person while emphasizing its people, relationships, opportunities, campaigns, and commercial network. Company means a commercial Party. Workspace Organization remains the tenant and administration boundary.

### Relationship

Relationship becomes a first-class commercial subject with participants, status, activity, opportunities, work, and intelligence. Findings about communication patterns or relationship health attach to the Relationship as governed interpretations; they do not become unlabelled CRM facts.

### Opportunity

Opportunity represents a live commercial pursuit. The page emphasizes current state, next action, participants, commercial structure, meaningful activity, work composition, and governed intelligence. The interface must not cosmetically rename legacy pipeline fields or invent a probability.

### Campaign

Campaign represents the agreed commercial program. CRM owns commercial intent and lifecycle. Deliverables, calls, measurement, accounting, and execution remain owned by their authoritative systems and are composed into the Campaign experience.

### Intake

Customer is demoted into an explicit Intake record. Intake shows source, status, history, identity-resolution state, evidence, and any governed link to a Person or Company. Intake answers what entered the process; it does not answer who the subject is unless identity has been established.

## Universal Activity and Timeline

The timeline becomes a core Loop primitive and a contextual projection of authoritative events. It can appear on Person, Company, Relationship, Opportunity, Campaign, Work, Investigation, and operational subjects. It tells the story without owning or rewriting it.

| Type | Meaning | Presentation Requirement |
|---|---|---|
| Fact | Something objectively occurred | Show source and verification when relevant |
| Communication | Human or machine communication occurred | Show channel, participants when known, and context |
| State Change | An authoritative object changed | Show prior state, new state, actor, time, and authority |
| Work | Execution activity occurred | Link to the owning Work record |
| Signal | A potentially meaningful pattern was detected | Do not present as a conclusion |
| Finding | CI reached a governed interpretation | Show Developing or Established and evidence count |
| Recommendation | Loop proposes an action | Show basis and required authority |
| Decision | An authorized decision was made | Show decision maker and resulting action |
| Audit | Governance or system history | Expose deeper detail progressively |

### Progressive Detail

The collapsed timeline state shows the human-readable event. Expanded detail reveals evidence, confidence, provenance, actor, timestamp, and owning authority as appropriate. Normal users read the story; investigators and auditors can reach the underlying evidence without changing interfaces.

> **Product annotation (C-05).** For identity, "confidence" here is read as governed identity posture,
> never a number. This annotation decides nothing for other authorities. Each shows only what its owning
> authority defines; for a Finding, that is the evidence state and evidence count in the table above.

### Unidentified Activity

Activity may be Known Party, Known Company, Unresolved, or Anonymous. Search and timeline presentation must support all four. Ingestion must not create a Person merely to give an event a destination.

### Filters

The primary filters are All, Communications, Work, Intelligence, and Changes. Advanced filters may expose the full event taxonomy, source, actor, date, and verification attributes.

## Intelligence Experience

Loop presents intelligence when it changes understanding or action. Intelligence remains visibly distinct from facts and always exposes its semantic state and evidence basis at the appropriate depth.

| Level | Use | Required Elements |
|---|---|---|
| Ambient | Small contextual observation on a record | Short statement, direction or condition, and basis available on demand |
| Actionable | A meaningful Finding requiring attention | Finding status, evidence count, and Investigate or Dismiss actions |
| Governed | A consequential recommendation or proposed action | Basis, authority boundary, evidence review, and explicit approval or rejection |

### Dedicated Intelligence Area

The dedicated area supports deliberate investigation through Overview, Investigations, Findings, Recommendations, Decisions, and Monitoring. Contextual intelligence remains embedded elsewhere, while the dedicated area provides the analyst environment for review and governance.

### Brain Interaction

The Brain will become a conversational interface into governed Loop context. It should understand the current subject, user authority, relevant evidence, and available actions. Its interaction sequence is Understand, Recommend, Draft, Authorize, and Act. Each step must preserve the semantic category of the output and the applicable authority boundary.

| Model Output | Permitted Meaning | Governance Rule |
|---|---|---|
| Summary | Condensed description of known material | Does not replace source facts |
| Hypothesis | Possible explanation | Must remain provisional |
| Draft | Proposed communication or content | Requires appropriate authorization before execution |
| Recommendation | Proposed course of action | Must show basis and decision authority |
| Fact or identity | Not established by model output alone | Requires the governing authority and process |
| Human decision | Not established by model output alone | Requires an authorized person or governed delegation |

## Layout and Interaction System

| Zone | Purpose | Behavior |
|---|---|---|
| Global shell | Stable orientation across Loop | Quiet, narrow, permission-aware navigation |
| Context header | Identify subject, state, context, and actions | Consistent across serious records |
| Context navigation | Expose subject-specific views | Sticky on desktop after header scroll |
| Primary workspace | Provide the main operating surface | Strong hierarchy with an optional supporting rail |
| Context drawer | Inspect related activity, evidence, people, or Findings | Opens without abandoning the current subject |

### Density

| Mode | Primary Use | Guidance |
|---|---|---|
| Scan | Home, command centers, and lists | Fast orientation with clear priority |
| Operate | Records, opportunities, campaigns, and Work | Balanced density for action and context |
| Investigate | Evidence, audit, CI, and deep operational data | Higher density with progressive detail |

### Responsive Behavior

Desktop is the primary environment for serious operation. Tablet collapses supporting rails while preserving global and contextual hierarchy. Mobile becomes action-first: key actions, attention items, active context, and recent activity appear before deep detail. Context drawers become full-screen sheets, and complex tables become prioritized lists.

### Visual Direction

The interface should be serious enough to run a company, quiet enough to support sustained thinking, and visually recognizable as Loop. Preserve the Loop mark and restrained identity. Reduce decorative cards, strengthen hierarchy, use whitespace structurally, and apply one consistent status system.

- Subject, state, context, attention, and provenance must be visually recognizable.
- Color communicates semantic meaning rather than section ownership.
- Facts, Signals, Findings, Recommendations, Decisions, and Work must not appear interchangeable.
- AI does not receive ornamental treatment or default purple styling.
- Cards indicate genuine grouping or actionable objects, not the existence of content.

## Screen Disposition

| Current Surface | Decision | Implementation Direction |
|---|---|---|
| Shared Loop shell | Preserve and refine | Permanent global shell |
| Loop Home at app root | Replace structurally | Needs You, What Changed, Loop Noticed, My Work, Operating Pulse |
| CRM Command Center | Modify heavily | Commercial command rather than a generic dashboard |
| CRM Search | Preserve capability and redesign UX | Move toward governed universal search |
| People list | Replace conceptually | Canonical People only |
| Customer Intake | Preserve and demote | Explicit intake and legacy workflow |
| Customer Detail | Transition and replace | Migrate useful components to Person and Intake |
| Person record | New canonical experience | Use shared record grammar |
| Company record | New | Commercial Company Party experience |
| Workspace Organization | Preserve and contextualize | Tenant and workspace administration only |
| Relationship | New | First-class commercial record |
| Opportunity | New | Canonical pursuit experience |
| Campaign | New and reconcile | CRM commercial authority with composed execution |
| Shared Timeline | Preserve and expand | Universal contextual activity primitive |
| Work OS | Preserve authority and reconcile UX | Adopt Loop shell and context grammar |
| CI surfaces | Preserve authority and redesign composition | Dedicated and contextual intelligence |
| CallGrid | Preserve operational authority | Operations then CallGrid |
| Creator administration | New and reconcile | Operations then Creators |
| Creator Hub | Preserve | Responsive creator experience |
| Client and partner experiences | Preserve | Responsive participant experiences |
| Role-specific shells | Retire | Replace with permission-aware Loop |
| Second CRM shell | Retire | CRM remains inside Loop |

A replace decision does not authorize immediate deletion. It means the current surface should not receive further architectural investment as the permanent solution.

## Implementation Sequence

| Slice | Deliverable | Entry Constraint |
|---|---|---|
| UI 0 | Design primitives: shell, headers, tabs, states, attention, workspace, rail, drawer, activity items, responsive and system states | No business, ontology, or backend change |
| UI 1 | Loop Home with the five approved sections | Compose only existing data; never fabricate intelligence |
| UI 2 | Five-area global navigation and module placement | Preserve permission filtering and external experiences |
| UI 3 | CRM information architecture | Expose only canonical objects backed by implemented authority |
| UI 4 | Universal Activity | Allow unidentified facts and expose provenance |
| UI 5 | Canonical Person | Requires sufficient governed Party read model |
| UI 6 | Company and Relationship | Requires canonical Company Party and Relationship |
| UI 7 | Opportunity | Requires canonical Opportunity authority |
| UI 8 | Campaign | Reconcile commercial ownership with composed execution |
| UI 9 | Intelligence composition | Apply Ambient, Actionable, and Governed patterns after record grammar stabilizes |
| UI 10 | Brain interaction | Requires stable context, permissions, records, evidence semantics, and action boundaries |

### Delivery Rule

Each slice should be reviewable as a working vertical experience. The implementation team should demonstrate repository fit, data provenance, authority boundaries, responsive behavior, empty and unknown states, and the migration impact before the slice is approved for the next stage.

## Conflict Controls

| Risk | Required Control |
|---|---|
| Needs You becomes another work queue | Treat it as a projection; source domains retain authority |
| Timeline becomes a new event store | Project authoritative events and StateChangeOutbox semantics |
| Person aggregates ungoverned Customer data | Use only governed associations; unresolved remains unresolved |
| Company is confused with Workspace Organization | Keep commercial Party and tenant authority explicitly separate |
| Relationship score is calculated in the frontend | Require CI to establish and label the interpretation |
| Opportunity probability is invented for presentation | Show entered fact, governed projection, or Unknown |
| Navigation context becomes ontology | Keep context trail as transient navigation state |
| Creator becomes a Party type | Model creator as participation and capability around a Person |
| External experiences create separate identity or auth | Compose the same Loop authorities with different UX |
| Brain response becomes Loop truth | Classify output and route it through the governing process |

## UI Constitution

1. Never create truth for presentation convenience.
2. Unknown is a valid UI state.
3. Activity does not require identity.
4. Identity does not imply commercial context.
5. Context does not transfer authority.
6. UI composition never changes domain ownership.
7. AI interpretation is visually distinct from fact.
8. Human and machine authority boundaries remain visible.
9. One Loop composes each experience through permissions and participation.
10. Optimize for the next decision rather than maximum information density.
11. Do not build SAP with nicer typography.

## Acceptance Criteria

- The internal product presents one stable Loop shell and no competing CRM shell.
- The five operating areas appear according to existing permission authority.
- Participant experiences remain responsive projections and do not add identity models.
- Home prioritizes human authority boundaries before changes, intelligence, work, and metrics.
- Canonical records follow the shared identity, state, context, activity, intelligence and action grammar.
- Unresolved and anonymous activity remains searchable and visible without creating a Person.
- Every intelligence treatment reveals its semantic status and evidence basis at the appropriate depth.
- Context drawers preserve the current subject and restore the prior state when closed.
- Commercial Company and Workspace Organization are unmistakably separate.
- No UI slice introduces a duplicate event store, work queue, identity authority, intelligence calculation, or campaign execution authority.
- Desktop, tablet, and mobile treatments follow the approved density and action priorities.

### Approval Gates

| Gate | Approval Question |
|---|---|
| Product | Does the slice match the approved subject-first operating model |
| Architecture | Does every displayed fact and action retain its authoritative owner |
| Data | Are provenance, unknown states, and identity conditions represented honestly |
| Interaction | Can a user understand subject, state, context, attention, and next action |
| Responsive | Does each viewport preserve priority rather than merely compress desktop |
| Migration | Is the current surface preserved, transitioned, or retired according to the disposition matrix |

## Implementation Handoff

Matt and the implementation team should treat this specification as the controlling UI direction for the next product phase. Begin with UI 0 and return a repository-fit assessment before changing production surfaces. That assessment should identify reusable components, routing changes, existing data sources for Loop Home and Activity, backend gaps for canonical records, migration dependencies, and any conflict with a locked platform invariant.

Where implementation discovers a conflict, stop at the authority boundary and document the conflict. Do not resolve architectural gaps with frontend-derived truth, duplicated storage, automatic identity creation, or cosmetic renaming of legacy objects. The correct result may be an unavailable navigation item, an Unknown state, or a deferred slice until the governing domain is ready.

### First Requested Deliverable

- A UI 0 component inventory and implementation plan.
- A map from current routes and components to the five operating areas.
- A source-by-source data availability map for Loop Home and Universal Activity.
- A list of canonical object read-model gaps for Person, Company, Relationship, Opportunity, and Campaign.
- A proposed vertical-slice pull request sequence with explicit acceptance checks.

Once those five items are reviewed, implementation can proceed through the approved sequence without reopening the product model unless repository evidence exposes a genuine architectural conflict.

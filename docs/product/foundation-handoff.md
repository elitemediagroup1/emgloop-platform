# Foundation Handoff — backend truth for the Loop redesign

**Status:** 2026-09-15, against `main` `543c645`. **Audience:** Charlie and Lexi (UI track), Product,
and engineering. This is the single handoff describing which backend truth exists, which contracts are
locked, what is missing, and which surfaces the redesign may build now.

**The shared rule:** the interface may project and explain truth; it may not create truth for
presentation convenience.

**Companion records**
- `docs/architecture/identity-evidence-resolution.md` — identity, Party, Intake, posture. Locked.
- `docs/architecture/relationship-participant.md` — proposed; four Product decisions.
- `docs/architecture/universal-activity.md` — proposed contract `activity.v1`.
- `docs/architecture/commercial-opportunity-campaign.md` — readiness; Product decisions.
- `docs/architecture/loop-ai-runtime.md` — proposed; architecture only.
- `docs/architecture/loop-application-structure.md` — five areas, C-01..C-04. Locked.
- `docs/product/loop-product-ui-architecture-v1.0.md` — the controlling UI specification.

**Legend**

| Status | Meaning |
|---|---|
| GREEN | Safe to design and build now |
| YELLOW | Design against the stated contract; backend implementation pending |
| RED | Authority or decision missing; do not build beyond a prototype |

---

## 1. Foundation verified (baseline)

- **`main`** is `543c645` (#243). #241, #242 and #243 were verified on `main` by content.
- **Migrations:**
  - 33 directories.
  - Production applied all 33: `Deploy Prisma Migrations` run on 2026-09-13 applied
    `20260916000000_crm_p0_2e_customer_party_link`.
  - #239–#243 added none.
- **Tests on `main`:** shared 1061, database 1066, web 397, providers 132, operations 560,
  diagnostics 47. All pass; the identity-focused subset is 81/81.
- **Known unrelated failures:**
  - `@emgloop/marketplace-intelligence` typecheck: 62 errors (zero importers).
  - ESLint was never configured.
- **What is in place:**
  - **Identity 2.0 contracts:** evidence tiers, act authority, use policy.
  - **Party Reference 2.0b:** ESTABLISHED / NOT_ESTABLISHED / SUPERSEDED / NOT_FOUND; depth 8; no
    cross-type chains; writes refuse superseded ids with the canonical id; archived Parties take no new
    references.
  - **Ingestion records facts only (Slice 1):** production had 0 People created after the merge.
  - **Loop Time Authority.**
  - **One shell and one nav registry** (`LOOP_NAV`).
  - **Membership-based authorization.**
  - **Governed Party establishment** (`PartyService`) and the governed Customer → Party link
    (`CustomerPartyLinkService`).
- **Known deferred identity items:**
  - slices 2.1a–2.6: resolver retirement, evidence schema, source policies, extraction, review read
    models, governed attribution, supersession, People and Intake projections;
  - verification, machine attribution, historical backfill, legacy People remediation;
  - cross-organization Party.
- **Critical gap:** `PartyService.create` and `establish` have **no production caller**, and production
  has **0 established Parties**. Until slice P1 ships, nothing canonical exists for People, Companies,
  Relationships or Participants to show.

## 2. Canonical record readiness matrix

### 2.1 Person

| | |
|---|---|
| Classification | **CONTRACT LOCKED / IMPLEMENTATION MISSING.** Profile attributes and contact points: **PRODUCT DECISION REQUIRED** (PD-F-05, non-blocking). |
| Canonical authority | Party contract over `CognitiveIdentity` (type PERSON); `PartyService`; `PartyRepository` |
| Identifier | `(organizationId, partyId)` |
| Tenant | Organization-local. Cross-organization Party deferred. |
| Read contract | `PartyRepository.findParty` and `PartyReferenceRepository.resolve` exist. **People list read model missing** (P1). |
| Write contract | `PartyService.create` (`identityResolution:create`, EMPLOYEE+) and `establish` (`approve`, OWNER/ADMIN, basis MANUAL/EXPLICIT_LINK) exist; **server actions missing** (P1). Profile edits: authority missing. Supersession writer: 2.5b. |
| Party Reference | Reads follow supersession forward. Writes refuse superseded ids with the canonical id. Depth 8. No cross-type chains. Archived Parties take no new references. |
| Lifecycle | Unestablished → established (approve); superseded (2.5b, not built); archived (a dormant method only) |
| Audit | `party.created`, `party.established` (ids only). Defect: the actor name records as "System". |
| Events | None. IDENTITY outbox events are planned, not published. |
| Permission inputs | `identityResolution` grants; AI_EMPLOYEE hard-denied |
| Activity | Governed attributions after identity slice 2.5. Before that, only a labeled "linked Intake Records" context lane (`universal-activity.md` §3). |
| Intelligence | Identity posture (`identity-evidence-resolution.md` §11a): establishment state and basis, CONFIRMED_SAME_PARTY / POSSIBLE_MATCH / UNRESOLVED, evidence tier (after 2.1b/2.3), limitations. **No numeric confidence.** |
| Existing UI routes | None. `/crm/customers` is Intake. |
| Legacy projections | `/crm/customers` "People"; the customer detail eyebrow "Person / Intake Record"; LiveFeed "Person" column; "People added" metrics |
| Known conflicts | Customer rows shown as People in at least 9 places. The People list will be empty until Parties are established, which is correct and must render as an honest empty state. |

**Minimum contract to design against:** `PersonRecordV1`
- `partyId`, `partyType: 'PERSON'`, `displayName | null`
- `establishment: { established, basis, establishedAt, establishedByDisplay }`
- `reference: ESTABLISHED | NOT_ESTABLISHED | SUPERSEDED (canonical id)`
- `posture` (§11a)
- `linkedIntakeRecords[]` (active and historical `CustomerPartyLink`s)
- `relationships[]` (after R3)
- `activity` (`activity.v1`), `intelligence` refs, `availableActions` (server-decided)

**UI must NOT assume:**
- contact points or profile fields beyond the display name;
- that an Intake Record is a Person;
- any identity confidence number;
- a non-zero People count;
- that unestablished Parties appear in People;
- any merge action.

### 2.2 Company

| | |
|---|---|
| Classification | **CONTRACT LOCKED / IMPLEMENTATION MISSING.** Company attributes: **PRODUCT DECISION REQUIRED** (PD-F-05, non-blocking). |
| Canonical authority | Party contract, type COMPANY |
| Identifier | `(organizationId, partyId)` |
| Tenant | Organization-local. **The Company is never the Workspace Organization** (PD-I2-07). |
| Read / write contract | As Person. Companies list read model missing (P1). |
| Party Reference / lifecycle / audit / events / permissions | As Person |
| Activity | After identity 2.5 (a business line is COMPANY evidence, never a Person) |
| Intelligence | As Person |
| Existing UI routes | None. `/crm/organizations` is the tenant. |
| Legacy projections | `Customer.attributes.company` free text; CallGrid buyer/vendor/source strings (provider dimensions, **not Companies**) |
| Known conflicts | The tenant page shows Relationships, Opportunities and Campaigns tabs (these move to Company, Person and Relationship). |

**Minimum contract to design against:** `CompanyRecordV1` = `PersonRecordV1` with
`partyType: 'COMPANY'`, plus `people` via AFFILIATION Relationships (after R3).

**UI must NOT assume:**
- that CallGrid buyers or vendors are Companies;
- that the tenant is a Company;
- company profile fields.

### 2.3 Intake (legacy Customer)

| | |
|---|---|
| Classification | **AVAILABLE NOW** (legacy authority), with the C-04 semantics. Creation authority: **AUTHORITY MISSING** (PD-I2-04 separate contract). History: missing. |
| Canonical authority | `Customer`, the current/legacy Intake authority |
| Identifier | `(organizationId, customerId)` |
| Tenant | Organization-scoped, fails closed |
| Read contract | `CrmRepository.listCustomers`, `getWorkspace`, `kanbanBoard`; search |
| Write contract | Intake status (`pipeline:update`), tags and assignment (`customers:update`), notes. **No create path** apart from seed. `/crm/merge` is live and slated to be disabled (PD-I2-05). Party link through `CustomerPartyLinkService` (`approve`; no production caller). |
| Party Reference | The link target must be ESTABLISHED. The link service does not yet refuse archived Parties or return the canonical id (P1b). |
| Lifecycle | Intake status JSON: New, Contacted, Quoted, Booked, Completed, Archived. **Overwritten in place, no history.** |
| Audit | None for status, field or note edits. `customer.merged`, `customer.party_linked`, `customer.party_link_reversed`. |
| Events | None |
| Permission inputs | `customers:*`, `pipeline:*` |
| Activity | Intake Record adapter (A2): interactions, conversations and notes by `customerId`, basis INTAKE_LINK_CONTEXT |
| Intelligence | None governed. Legacy behavioural Signals are labeled derived. |
| Existing UI routes | `/crm/customers`, `/crm/customers/[id]`, `/crm/customers/[id]/activity`, `/crm/pipeline`, `/crm/search`, `/crm/merge` |
| Legacy projections | "People" labels; "Person / Intake Record"; Intake Board copy "people arrive through calls" (false since Slice 1) |
| Known conflicts | 24,590 legacy records, 99.96% CallGrid caller-ID residue. 274 calls attached on a last-seven-digit match; 319 attached to a different number. |

**Minimum contract to design against:** `IntakeRecordV1`
- `customerId`
- `provenanceSegment` (read-time: CALLGRID_CALLER_ID_RESIDUE / WEB_VISITOR / WEB_LEAD / SEED_OR_DEMO /
  UNMARKED; approved in §10, read model pending)
- `intakeStatus`, `source`, `createdAt`
- `partyLink` (none / active link to an established Party / history)
- `activity` (`activity.v1` INTAKE_RECORD)
- `availableActions`

**UI must NOT assume:**
- an Intake Record is a Person or a Party;
- identity from contact values;
- intake status is an Opportunity stage;
- a Person can be created from an Intake Record automatically;
- merge.

### 2.4 Relationship

| | |
|---|---|
| Classification | **PRODUCT DECISION REQUIRED** (PD-F-01..04) and **AUTHORITY MISSING** |
| Canonical authority | New CRM authority (PD-I2-06); architecture in `relationship-participant.md` |
| Identifier | `(organizationId, relationshipId)` |
| Tenant | Organization-local; every Party referenced resolves in the same organization |
| Read contract | Not built (R3): list and detail with Party-resolved sides, participants, lifecycle history, duplicate diagnostic |
| Write contract | Not built (R2): create with sides, edit details and owner, end, reactivate, void; RBAC resource `relationships` (grants: PD-F-04) |
| Party Reference | Writes need ESTABLISHED, non-archived Parties; superseded ids refused with canonical id; reads forward; ids never rewritten |
| Lifecycle | ACTIVE / ENDED / VOIDED (proposed). PROSPECTIVE only if PD-F-02 requires it. |
| Audit | Append-only Relationship event log plus AuditLog |
| Events | Outbox subject RELATIONSHIP (enum migration) |
| Permission inputs | Identity, membership, role and permissions; AI_EMPLOYEE hard-denied writes; organization-wide until a team model exists |
| Activity | RELATIONSHIP is a reserved `activity.v1` subject until built |
| Intelligence | CI Findings attach by reference (health is interpretation, never a CRM field) |
| Existing UI routes | None ("Soon" nav item; tenant-page tabs) |
| Legacy projections | Dormant `IdentityRelationship` (confined, not the authority) |
| Known conflicts | The tenant is not a Party (PD-F-01); no Party can be established in production yet (P1) |

**Minimum contract to design against:** kind, sides (with labels), participants (role, side, dates,
state), lifecycle and history, owner (a User), business dates, duplicate diagnostic, `availableActions`.
Exact kinds and structure are pending PD-F-01 and PD-F-03.

**UI must NOT assume:**
- the tenant appears as a Company;
- relationship health scores;
- any automatic relationship creation;
- merge;
- who may act.

### 2.5 Participant

| | |
|---|---|
| Classification | **PRODUCT DECISION REQUIRED** (PD-F-03, PD-F-04) and **AUTHORITY MISSING** |
| Canonical authority | One CRM Participant authority (exclusive arc across Relationship, then Opportunity and Campaign) |
| Identifier | `(organizationId, participantId)` |
| Read / write contract | Not built (R2/R3). Add, change, end or void. Rows are never deleted. |
| Party Reference | As Relationship; a role may restrict Party types; one ACTIVE row per `(subject, party, role)` |
| Lifecycle | ACTIVE / ENDED / VOIDED with effective business dates |
| Audit / events | On the subject's log, AuditLog and outbox |
| Permission inputs | The subject's authority. **A Participant is never an authorization credential** in this release. |
| Activity | Activity participants come from source authorities and governed attribution, **not** Participant rows |
| Existing UI routes | None. `CaseParticipant`, Work assignment and Conversation assignee are **User** participation. |
| Legacy projections | Dormant `IdentityRole` (confined) |
| Known conflicts | `PARTY_CAPACITIES` is tied to `CognitiveEntityType` names (decoupled in R1) |

**Minimum contract to design against:** `{ participantId, subject ref, party ref (resolved), role,
roleFamily: CAPACITY | ENGAGEMENT, side | actsForSide, effectiveFrom, effectiveTo, state, history }`.

**UI must NOT assume:**
- a role changes a Party's type;
- a Participant grants access;
- an internal staff member is a Participant (staff are Users: owner or assignee).

### 2.6 Opportunity

| | |
|---|---|
| Classification | **PRODUCT DECISION REQUIRED** (PD-F-02, PD-F-06) and **AUTHORITY MISSING** |
| Canonical authority | New CRM authority (not intake status, not `ServiceRequest`) |
| Identifier | `(organizationId, opportunityId)` |
| Read / write contract | Not built |
| Party Reference | Participants through the CRM Participant authority |
| Lifecycle | Append-only transitions. Categories and stages pending PD-F-06. |
| Audit / events | Own log, AuditLog, outbox subject (migration) |
| Permission inputs | New resource `opportunities`; AI_EMPLOYEE hard-denied writes |
| Activity | Reserved `activity.v1` subject |
| Intelligence | CI Findings and Recommendations by reference. Forecast is human-only (attributed, timestamped). |
| Existing UI routes | None ("Soon"). CallGrid "opportunity" findings are **not** Opportunities. |
| Legacy projections | `pipelineStatus`, `ServiceRequest`, DRAFT orders "revenue opportunity" |
| Known conflicts | The `@emgloop/shared` `Opportunity` type name (a CallGrid finding) |

**Minimum contract to design against:** `commercial-opportunity-campaign.md` §3.4.

**UI must NOT assume:**
- stages from intake status;
- a computed or default probability;
- CallGrid findings as Opportunities;
- non-established participants;
- who may close.

### 2.7 Campaign

| | |
|---|---|
| Classification | **PRODUCT DECISION REQUIRED** (PD-F-07) and **AUTHORITY MISSING**. Participation: **DEFERRED**. |
| Canonical authority | New CRM authority for the agreed commercial program |
| Identifier | `(organizationId, campaignId)` |
| Read / write contract | Not built. Provider campaign links are human-declared and effective-dated, keyed by provider external id. |
| Party Reference | Participants when un-deferred |
| Lifecycle | Commercial lifecycle, pending PD-F-07 |
| Audit / events | As Opportunity |
| Permission inputs | New resource; AI_EMPLOYEE hard-denied writes |
| Activity | Reserved subject. Execution activity is composed from CallGrid and Creators. |
| Intelligence | Measurement composed through the existing member-keyed tables |
| Existing UI routes | None. `/app/admin/marketplace/campaigns` is the **provider campaign dimension**. |
| Legacy projections | `MarketplaceCall.campaign*`, `Interaction.metadata.campaign` (CallGrid names mixed with UTM strings) |
| Known conflicts | The noun collision with CallGrid; single-tenant ingestion constrains links for customer #2 |

**Minimum contract to design against:** `commercial-opportunity-campaign.md` §4.4.

**UI must NOT assume:**
- CallGrid campaigns are CRM Campaigns;
- traffic equals commercial status;
- copied metrics;
- Campaigns on the Workspace page.

### 2.8 Universal Activity

| | |
|---|---|
| Classification | **CONTRACT PROPOSED** (backend-owned; locks when this handoff merges) / **IMPLEMENTATION MISSING**. Known Party and Known Company activity: **DEFERRED** to identity 2.5. |
| Canonical authority | **None of its own.** A projection over source authorities (`universal-activity.md` §1). |
| Identifier | Item `key` = `recordType:recordId[:sequence]` |
| Tenant | From the source row |
| Read contract | `activity.v1` items for a subject or the organization feed. Filters All / Communications / Work / Intelligence / Changes. Keyset paging. |
| Write contract | None. Activity is never written to. |
| Party Reference | PARTY subject refs resolved forward, reporting SUPERSEDED with the canonical id |
| Lifecycle / audit / events | Belong to each source |
| Permission inputs | Per item, from the source authority, re-checked server-side |
| Activity availability now | Case/Decision, Work item, Intake Record, organization operational feed; unresolved and anonymous classification per fact |
| Intelligence | Items carry `epistemic` and `semanticStatus` labels (never numeric confidence) |
| Existing UI routes | Customer timeline tabs, activity page, `/crm/inbox`, `/crm/live/*`, Case timeline, work history |
| Legacy projections | Ten ad-hoc activity shapes (replaced progressively) |
| Known conflicts | Calls shown twice in the live feed; fabricated `occurredAt` on DomainEvent and Signal; Home and Work activity skip `audit:view` |

**Minimum contract to design against:** `ActivityItemV1` (`universal-activity.md` §4).

**UI must NOT assume:**
- Known Party activity exists before 2.5;
- raw contact values or bodies inline;
- a Person is created for unidentified activity;
- ordering by insert time where occurrence is unknown.

## 3. Opportunity and Campaign readiness (summary)

**Opportunity**
- **Locked:** a new governed CRM authority; append-only lifecycle; Party Reference participants; human
  forecast only; Intake separate; Work by reference; Activity projection; AI never closes.
- **Missing:** everything built.
- **Undecided:** whether a Relationship is required (PD-F-02); stages and categories, outcomes and loss
  reasons, forecast fields, close authority, Opportunity from Intake, grants (PD-F-06).

**Campaign**
- **Locked:** a new CRM authority for the agreed program; execution and measurement composed; provider
  campaigns linked by external id; human-declared commercial state; participation deferred.
- **Missing:** everything built; multi-tenant ingestion for customer #2.
- **Undecided:** lifecycle, commercial terms location, link cardinality and who declares links,
  participation un-deferral, Opportunity association, Objectives scoping (PD-F-07).

Full detail: `docs/architecture/commercial-opportunity-campaign.md`.

## 4. Universal Activity (summary)

- **What it is:** a shared contract (`activity.v1`) plus per-authority adapters composed at read time.
  A thin derived index comes later, only if a measured subject needs it.
- **Where authority stays:** always in the source domain. An item is a reference with an explanation;
  content is fetched from the authority under its own guard.
- **What the UI may consume:** items with category, time and time basis, actor, subjects and
  participants, identity subject state (KNOWN_PARTY / KNOWN_COMPANY / UNRESOLVED / ANONYMOUS /
  NOT_APPLICABLE), provenance and limitations, semantic status, access and sensitivity class.
- **Deliberately not in the contract:** numeric confidence, raw identifiers, bodies.

## 5. AI runtime (summary)

- **Loop owns intelligence and governance.** Anthropic and OpenAI sit behind a provider-neutral runtime:
  adapters in `packages/providers/src/ai`, runtime in `packages/database/src/services/ai-runtime`, pure
  contracts in `@emgloop/shared/ai`.
- **Routing** is versioned policy data.
- **Context** is a Loop-assembled, permission-checked, policy-gated package with a manifest.
- **Tools** are executed only by Loop's broker, with independent authorization.
- **Approvals** follow RECOMMEND → PROPOSE → APPROVE → EXECUTE on the existing Decision Engine and CI
  services. There is no second approval system.
- **Provenance** is recorded per invocation. Prompts are versioned templates. Memory maps to existing
  authorities.
- **No SDK, secret or call** until PD-F-08.

**Current state:**
- No LLM exists.
- An unused `AIProvider` interface.
- Dead mocks.
- Several **numeric confidences presented as intelligence** and UI text that fakes AI; both must be
  corrected before AI output shares those surfaces.

**First slice after approval:** read-only Case Explanation on `/app/admin/cases/[id]`. Full detail:
`docs/architecture/loop-ai-runtime.md`.

## 6. Charlie and Lexi unblock matrix

| Surface | Status | Authority relied on | Stable contract | Missing implementation | Product decision | UI may safely assume | UI must NOT imply |
|---|---|---|---|---|---|---|---|
| Loop Shell | **GREEN** | `WorkspaceShell`, `LOOP_NAV`, membership authority | One shell; nav filtered by server-resolved authority | — | — | Items the person can open; an honest unavailable state | Nav visibility is authorization; a second shell |
| Loop Home | **YELLOW** | CI attention and personal queue; Work OS; CallGrid scorecard; AuditLog (with `audit:view`) | Five sections from the specification; Needs You from authorities at their boundary; Loop Noticed from **governed CI only** | Home composition read model; last-visit instant for What Changed; removing canned "Business Status" | — | Governed sources exist for Needs You, My Work, Pulse | Numeric confidence; Executive Brain as Loop Noticed; canned system status; fake AI |
| Global Navigation | **GREEN** | C-01 five areas; `LOOP_NAV` | Home, CRM, Work, Intelligence, Operations | Route-transition proposal (Charlie/Lexi) approved by Product before routes move | Approval of their proposal | Current routes stay until the proposal is approved | Moved routes before approval; a second registry |
| Universal Search | **RED** (universal) / GREEN (CRM search redesign) | CRM search over Intake, conversations, the tenant | CRM-scoped search only | Governed universal search over Party, Activity, Work | PD-F-10 | CRM search results are Intake Records | Searching People/Parties or activity that search does not cover |
| Universal Activity | **YELLOW** | Source authorities | `activity.v1` | A1 contract code; A2 adapters; Known Party after 2.5 | PD-F-09 (non-blocking) | Unresolved and anonymous states; provenance; filters | Known Party activity before 2.5; inline raw contact values or bodies |
| People | **YELLOW** | Party contract | People = established, non-superseded PERSON Parties | P1 read model and Party write actions | — | An empty list is correct today | Intake Records as People; counts from Customer |
| Person Detail | **YELLOW** | Party contract; CPL; posture §11a | `PersonRecordV1` | P1; relationships after R3; activity after A2/2.5 | PD-F-05 (contact points, non-blocking) | Display name, establishment posture, linked Intake Records | Contact points; identity confidence numbers; merge |
| Companies | **YELLOW** | Party contract (COMPANY) | Companies = established, non-superseded COMPANY Parties | P1 | — | Empty is correct today | The tenant or CallGrid buyers as Companies |
| Company Detail | **YELLOW** | Party contract | `CompanyRecordV1` | P1; R3 for people and relationships | PD-F-05 | As Person Detail | As Companies; commercial tabs on the tenant page |
| Relationships | **RED** | — (authority missing) | Proposed only | R1–R3 | PD-F-01..04 | Prototype with unavailable states | Any real relationship data or the tenant as a side |
| Relationship Detail | **RED** | — | Proposed only | R1–R3 | PD-F-01..04 | Prototype only | Health scores; merge; automatic creation |
| Intake | **GREEN** (provenance segment YELLOW) | Customer as Intake authority | `IntakeRecordV1`; C-04 naming | Intake Records read model with provenance segment; intake history; wording fixes; merge disable | — | Existing list, detail, status board and link actions | People/Person framing; intake status as stage; merge |
| Opportunities | **RED** | — | Readiness shape only | Everything | PD-F-02, PD-F-06 | Prototype only | Intake status as pipeline; probabilities; CallGrid findings as Opportunities |
| Opportunity Detail | **RED** | — | §3.4 shape | Everything | PD-F-02, PD-F-06 | Prototype only | As Opportunities |
| Campaigns | **RED** | — | Readiness shape only | Everything | PD-F-07 | Prototype only | CallGrid campaigns as CRM Campaigns |
| Campaign Detail | **RED** | — | §4.4 shape | Everything | PD-F-07 | Prototype only | Traffic as commercial status; copied metrics |
| Work | **GREEN** | Work OS | Blueprints, instances, stages, assignments | Work Types consolidation (D4); subject links (`relatedRecord` is null); `requiresApproval` not wired | — | Execution state and assignment | Approvals or record links that don't exist |
| Intelligence | **GREEN** | Commercial Intelligence; Decision Engine | Headlines, Queue, Cases, Findings (DEVELOPING/ESTABLISHED), Recommendations (select/dismiss/revise), Monitoring | Case list route; Decision Center route; permission consistency | — | Governed semantic states and evidence counts | Numeric confidence; ungoverned Executive Brain output as governed intelligence |
| Brain | **RED** | — (AI runtime not approved) | `loop-ai-runtime.md` (proposed) | S0–S4 | PD-F-08 | Design exploration only | That an LLM exists; "AI" labels on rules; live Brain status |
| Operations | **GREEN** | C-01 area over existing authorities | Area grouping | Route-transition proposal | Approval of the proposal | Grouping of CallGrid and future modules | A new operational authority |
| CallGrid | **GREEN** | CallGrid execution, measurement and reconciliation | C-03 split | Remove the decision write on page render; convert numeric confidence | C-03 Activity/Bids classification (UI/Product call) | Operational and analytical surfaces with honest Unknowns | Numeric confidence as truth; provider campaigns as CRM Campaigns |
| Creator administration | **RED** | — (no creator authority) | C-02: Operations → Creators; creator is a Person with participation | Creator participation (Participant, PD-F-03) and capability authority | PD-F-01, PD-F-03 | Prototype with unavailable states | A second creator app; creator as a Party type; upload or AI critique |
| Context drawers | **GREEN** | — (interaction pattern) | Context chain is navigation state only | — | — | Restore prior subject and state | That the context chain creates relationships |
| Record grammar | **GREEN** | Specification | Identity, State, Context, Activity, Intelligence and Action | Per-subject readiness above | — | The grammar | Sections filled with data that does not exist |
| Responsive / mobile | **GREEN** | — | Specification density and priority rules | — | — | — | — |

## 7. Minimum backend finish line

### Must land before UI resumes

1. **This handoff and its four architecture records, reviewed and merged**, so the contracts are
   authoritative. Documentation only.
2. **For the Relationship, Opportunity, Campaign and Creator cluster only:** Product decisions
   **PD-F-01, PD-F-02, PD-F-06, PD-F-07**. Without them those surfaces stay RED. Every other surface is
   unaffected.

**Nothing else is required** for the GREEN and YELLOW surfaces to resume.

**Separately and urgently, whatever the UI track does:** merge the password-reset security fix (#244).

### Contract sufficient — UI proceeds in parallel

| Slice | Contents |
|---|---|
| P1 | Party write actions; People and Companies read models; establishment review |
| P1b | `CustomerPartyLinkService` applies the archived and canonical-id readings |
| Intake Records | Read model with provenance segment; minimal C-04 wording fixes; `/crm/merge` disable |
| A1/A2 | `activity.v1` code and adapters (Case, Work, Intake, organization feed) |
| Loop Home | Composition read model and last-visit instant |
| Authorization debt | CallGrid decision write on render; Command Center and tenant page read Customer data without `customers:view`; Home and Work activity without `audit:view`; conversation assignee repository without org scope |

### Can wait

- Identity slices 2.1a–2.6.
- Relationship R1–R3, until decisions are in.
- Opportunity and Campaign implementation.
- AI runtime S0–S4, until PD-F-08.
- Numeric-confidence conversion and fake-AI text removal. Required before any AI output shares those
  surfaces.
- Universal search.
- Activity A3–A5.
- Multi-tenant ingestion. It gates customer #2, not the UI.
- Legacy cleanup: dead Brain harnesses, `marketplace-intelligence`, `work-os`.

## 8. Product decisions required

| ID | Question | Blocks | Record |
|---|---|---|---|
| **PD-F-01** | How is the tenant represented as a side of a Relationship? | Relationship schema; Relationships UI; seller side of Opportunity/Campaign | `relationship-participant.md` §9 |
| **PD-F-02** | Must an Opportunity belong to a Relationship (PROSPECTIVE state)? | Relationship lifecycle; Opportunity | same |
| **PD-F-03** | Initial Relationship kinds, Participant roles, and Party types per role | R1; labels | same |
| **PD-F-04** | Grants for Relationship and Participant acts | R2 | same |
| **PD-F-05** (non-blocking) | Which authority holds Person/Company profile attributes and contact points before verification exists? | Contact info and communication actions on Person/Company; profile editing | §8.1 below |
| **PD-F-06** | Opportunity policy: stages and categories, outcomes, forecast fields, close authority, from-Intake act, grants | Opportunity | `commercial-opportunity-campaign.md` §3.3 |
| **PD-F-07** | Campaign policy: lifecycle, terms location, provider-campaign links, participation, Opportunity association, Objectives scope | Campaign | same, §4.3 |
| **PD-F-08** | AI runtime approval; data classes sent to providers; provider terms; body retention; first slice, invokers, budgets; routing primary | All AI runtime work | `loop-ai-runtime.md` §17 |
| **PD-F-09** (non-blocking) | Who may see raw contact identifiers and communication content? | A later security slice | `universal-activity.md` §8 |
| **PD-F-10** (non-blocking) | Authorize governed universal search (scope and sources) | Universal Search | — |

### 8.1 PD-F-05 — Party profile and contact points

**Why locked decisions do not answer it.**
- The identity record §16 marks contact points and profile editing **AUTHORITY MISSING**.
- Verification is deferred.
- `IdentityEvidence` is hash-only and exists for resolution, not communication.

**Affected authority:** the Party record's Identity section; communication actions; Company attributes.

**Recommendation.** A governed Party profile authority:
- human-entered display name and legal name, edited under `identityResolution:update` with history;
- a minimal Company profile (legal name, website domain).

Contact points are held separately (e.g. `PartyContactPoint`):
- raw value, kind, assertion mode OPERATOR_RECORDED or SUBJECT_PROVIDED, verification UNVERIFIED, source
  reference, effective dates;
- sensitivity CONTACT_IDENTIFIER, purpose-limited to communication;
- **never used to match identity** (suggestions stay limited to verified points, none of which exist).

**Alternatives:**
- (i) No Party-level contact data until verification exists; the UI shows contact values only from
  linked Intake Records, labeled as Intake data. This is honest, and is the default if undecided.
- (ii) Raw contact values on `IdentityEvidence`. Rejected: evidence is hash-only.

**Blocked:** Party contact points and profile editing only. The UI can use alternative (i) meanwhile.

## 9. Implementation plan (ordered; each slice needs authorization unless stated)

**Backend authority and contracts**
0. **#244 security fix:** merge first. It is ready for review.
1. **Foundation handoff docs:** this PR.
2. **P1:** governed Party write actions, People and Companies read models, establishment review read
   model.
3. **P1b:** `CustomerPartyLinkService` applies the Party Reference readings.
4. **Intake Records:** read model with provenance segment, C-04 wording fixes, `/crm/merge` disable
   (these two are already authorized: C-04 / PD-I2-05 / PD-I2-08).
5. **A1 then A2:** `activity.v1` contract and adapters.
6. **Authorization and security debt:**
   - CallGrid decision write on render and page `requirePermission`;
   - `customers:view` on the Command Center and tenant page;
   - `audit:view` on Home and Work activity;
   - conversation assignee organization scope;
   - timing-safe compare on `/api/v1/events`.
7. **Relationship R1 → R2 → R3**, after PD-F-01..04 (R2 needs migration approval).
8. **Identity 2.1a** (retire the dormant resolver; decide the retirement of `IdentityRelationship` and
   `IdentityRole`), then 2.1b–2.6 as authorized.
9. **Opportunity** decision record and implementation after PD-F-02 and PD-F-06; **Campaign** after
   PD-F-07.

**AI runtime**
1. PD-F-08.
2. Convert numeric confidences to semantic states; remove fake-AI text.
3. S0 contracts and adapters (recorded fixtures, no live calls in CI).
4. S1 runtime and Case Explanation behind a flag.
5. S2 `ai_invocations`.
6. S3 Decision Engine approval gaps.
7. S4 read tools and further tasks.

**Charlie and Lexi track**
1. UI 0 primitives, record grammar, context drawers, responsive system (GREEN).
2. Five-area navigation and the route-transition proposal (GREEN; Product approves the proposal).
3. Loop Home against governed sources (YELLOW).
4. Intake Records (GREEN); People, Person, Companies, Company against the P1 contract (YELLOW).
5. Universal Activity against `activity.v1` (YELLOW).
6. Intelligence, Work, Operations and CallGrid redesign (GREEN).
7. Relationships, Opportunities, Campaigns, Creator administration after decisions (RED today).
8. Brain after the AI runtime (RED today).

## 10. Deferred (not done; do not mistake for completed)

- **Identity:** cross-organization Party; external participant authentication, memberships and portals
  (C-02); machine attribution; automatic anonymous-history attribution; contact verification;
  historical evidence backfill; legacy People remediation; governed supersession writer (2.5b);
  Party-type correction as its own governed operation.
- **CRM model:** organization-configurable roles and stages; a team or reporting model (manager
  scoping); campaign participation; Objectives scoped to a Campaign.
- **Adjacent domains:** Accounting; Creator capability; multi-tenant ingestion and per-organization
  credentials (the gate on customer #2).
- **AI:** embeddings and semantic index; autonomous AI execution and AI Employees acting; user
  preference memory; multi-model critique and consensus.
- **Search and Activity:** governed universal search; Activity derived index; Person and Company activity
  from attributions.

## 11. Risks and debt

- **Security**
  - Password-reset token exposed to the requester (#244, open). Whether it was abused is unknown.
  - The CallGrid overview writes decisions on page render, behind only `requireWorkspace('ADMIN')`.
  - The Command Center and tenant page read Customer and Interaction data without `customers:view`.
  - Home and Work recent activity read AuditLog without `audit:view`.
  - The conversation assignee repository method takes no organization.
  - `/api/v1/events` compares its shared secret without a timing-safe compare.
  - `LIVE_ORG_SLUG` single-tenant ingestion is now read in 5 routes (the rule said never add a fourth).
- **Privacy**
  - Raw caller numbers and form contact values are spread into `Interaction.metadata` and `summary`,
    `DomainEvent.payload` and `Signal.metadata`, and are visible to READ_ONLY users.
  - AI context and Activity must never copy them.
- **Semantic**
  - Customer rows shown as People in at least 9 places.
  - UI text that fakes AI.
  - Numeric confidences persisted and displayed (CallGrid formula counts unknown coverage as complete;
    bid literals; signal registry; Executive Brain).
  - "Opportunity" and "Campaign" name collisions.
  - Intake status without history or audit.
  - DomainEvent and Signal fabricate occurrence times.
  - `loop-cognitive-architecture.md` still describes every event resolving an identity (superseded by
    Slice 1).
- **Identity**
  - 0 established Parties and no production write path (P1).
  - Party and link audit rows record "System" as actor.
  - `CustomerPartyLinkService` does not apply the archived and canonical-id readings.
  - IDENTITY outbox events are not published although the record plans them.
- **Migration**
  - Relationship R2, the outbox subject enum, the Intake history table and `ai_invocations` each need
    the manual `Deploy Prisma Migrations` dispatch.
  - Production is aligned today (33).
- **Performance**
  - Identifier and continuity keys live only in JSON with no index.
  - Interaction has no `(provider, externalId)` unique or `(organizationId, customerId, occurredAt)`
    index.
  - The AuditLog `(entityType, entityId)` index is not organization-prefixed.
  - Activity composition is a k-way merge over tens of thousands of call rows.
- **Legacy**
  - Dormant `IdentityRelationship` and `IdentityRole` (confined).
  - `@emgloop/marketplace-intelligence` (62 type errors) and `@emgloop/work-os` are dead.
  - Brain placeholders and demo harnesses; `AIAgent` and `VoiceProfile`.
  - Dormant `ServiceRequest`, `Booking` and `Order`.
  - The outbox drain has no subscribers.
  - Stale CLAUDE.md counts (migrations 15 → 33; tables without an organization FK 10 → 34).

## 12. Phase gate

**FOUNDATION HANDOFF BLOCKED — PRODUCT DECISIONS REQUIRED**

The GREEN and YELLOW surfaces above may resume design now, against the contracts in this handoff. The
canonical commercial core (Relationships, Opportunities, Campaigns, Creator administration) stays RED
until Product decides PD-F-01, PD-F-02, PD-F-06 and PD-F-07, and this handoff is merged.

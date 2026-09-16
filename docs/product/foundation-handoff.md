# Foundation Handoff — backend truth for the Loop redesign

**Status:** 2026-09-15, against `main` `543c645`. **Product decisions recorded:** PD-F-01, -02, -03,
-04, -06, -07 and -08 approved. PD-F-05, -09 and -10 deferred. **Audience:** Charlie and Lexi (UI track),
Product, and engineering. The UI-track summary is `docs/product/ui-track-handoff.md`. This is the single handoff describing which backend truth exists, which contracts are
locked, what is missing, and which surfaces the redesign may build now.

**The shared rule:** the interface may project and explain truth; it may not create truth for
presentation convenience.

**Companion records**
- `docs/architecture/identity-evidence-resolution.md` — identity, Party, Intake, posture. Locked.
- `docs/architecture/relationship-participant.md` — architecture locked (PD-F-01..04 approved).
- `docs/architecture/universal-activity.md` — contract `activity.v1` (backend-owned; authoritative when this merges).
- `docs/architecture/commercial-opportunity-campaign.md` — contract locked for design (PD-F-02, -06, -07 approved).
- `docs/architecture/loop-ai-runtime.md` — architecture approved (PD-F-08); activation gates §17.
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
| Classification | **CONTRACT LOCKED / IMPLEMENTATION MISSING.** Profile attributes and contact points: **DEFERRED** (PD-F-05). The UI may show linked Intake contact data labeled Intake-derived. |
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
| Classification | **CONTRACT LOCKED / IMPLEMENTATION MISSING.** Company attributes: **DEFERRED** (PD-F-05). |
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
| Classification | **CONTRACT LOCKED / IMPLEMENTATION MISSING** (PD-F-01..04 approved; slices R1–R3) |
| Canonical authority | New CRM authority (PD-I2-06); architecture in `relationship-participant.md` |
| Identifier | `(organizationId, relationshipId)` |
| Tenant | Organization-local; every Party referenced resolves in the same organization |
| Read contract | Not built (R3): list and detail with Party-resolved sides, participants, lifecycle history, duplicate diagnostic |
| Write contract | Not built (R2): create with sides, edit details and owner, end, reactivate, void; RBAC resource `relationships` (grants: PD-F-04) |
| Party Reference | Writes need ESTABLISHED, non-archived Parties; superseded ids refused with canonical id; reads forward; ids never rewritten |
| Lifecycle | ACTIVE / ENDED / VOIDED. No PROSPECTIVE state (PD-F-02). |
| Audit | Append-only Relationship event log plus AuditLog |
| Events | Outbox subject RELATIONSHIP (enum migration) |
| Permission inputs | Identity, membership, role and permissions. View: human roles. Create/update: EMPLOYEE+. End and reactivate: MANAGER+. Void: OWNER/ADMIN. AI_EMPLOYEE denied (PD-F-04). Organization-wide until a team model exists. |
| Activity | RELATIONSHIP is a reserved `activity.v1` subject until built |
| Intelligence | CI Findings attach by reference (health is interpretation, never a CRM field) |
| Existing UI routes | None ("Soon" nav item; tenant-page tabs) |
| Legacy projections | Dormant `IdentityRelationship` (confined, not the authority) |
| Known conflicts | No Party can be established in production yet (P1). The tenant is the implicit owning side of OWN kinds and never a Party (PD-F-01). |

**Minimum contract to design against:**
- kind: approved kinds with OWN / THIRD_PARTY structure and side labels (`relationship-participant.md` §9);
- sides, with the tenant implicit for OWN kinds;
- participants (role, side, dates, state);
- lifecycle ACTIVE / ENDED / VOIDED and its history;
- owner (a User) and business dates;
- duplicate diagnostic;
- `availableActions` (server-decided).

**UI must NOT assume:**
- the tenant appears as a Company;
- relationship health scores;
- any automatic relationship creation;
- merge;
- who may act.

### 2.5 Participant

| | |
|---|---|
| Classification | **CONTRACT LOCKED / IMPLEMENTATION MISSING** (PD-F-03, -04 approved; R1–R3) |
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
| Classification | **CONTRACT LOCKED FOR DESIGN / IMPLEMENTATION MISSING** (PD-F-02, -06 approved). Service grants and reading confirmations: PD-F-11, PD-F-12 (non-blocking for design). |
| Canonical authority | New CRM authority (not intake status, not `ServiceRequest`) |
| Identifier | `(organizationId, opportunityId)` |
| Read / write contract | Not built |
| Party Reference | Participants through the CRM Participant authority |
| Lifecycle | Append-only transitions. Categories OPEN / CLOSED_WON / CLOSED_LOST; organization-configured stages within OPEN; governed loss reasons. |
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
| Classification | **CONTRACT LOCKED FOR DESIGN / IMPLEMENTATION MISSING** (PD-F-07 approved). Participation: **DEFERRED** until activated. Lifecycle vocabulary and grants: PD-F-11, PD-F-12. |
| Canonical authority | New CRM authority for the agreed commercial program |
| Identifier | `(organizationId, campaignId)` |
| Read / write contract | Not built. Provider campaign links are human-declared and effective-dated, keyed by provider external id. |
| Party Reference | Participants when un-deferred |
| Lifecycle | CRM-owned, human-declared commercial lifecycle (proposed DRAFT / AGREED / ACTIVE / PAUSED / ENDED / CANCELLED); never inferred from traffic |
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

**Opportunity: locked for design** (PD-F-02, PD-F-06).
- The canonical CRM pursuit.
- Relationship optional, with no placeholder Relationship.
- Fixed categories with organization-configured stages; append-only history.
- Human-authored forecast probability with attribution and time.
- Closed-won / closed-lost with governed loss reasons; no close approval at launch.
- Explicit creation from Intake, requiring an established Party. Intake stays Intake.
- AI recommends but never authors stage, forecast, close or outcome.

**Still to confirm before its service slice:** grants (PD-F-11); the categories and loss-reason list,
and the amount and expected-close fields (PD-F-12).

**Campaign: locked for design** (PD-F-07).
- CRM owns identity, lifecycle, agreed terms, participants (when activated) and associations.
- Accounting owns transactions, invoices, payment and settlement.
- Multiple provider campaigns over time.
- No automatic Campaign on win; lifecycle never inferred from traffic.

**Still to confirm before its service slice:** lifecycle vocabulary and the one-CRM-Campaign-per-provider-
campaign-per-period rule (PD-F-12); grants (PD-F-11).

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
- **Architecture approved (PD-F-08).** No live call until activation gates G1–G6 hold (§17 of the record).

**Current state:**
- No LLM exists.
- An unused `AIProvider` interface.
- Dead mocks.
- Several **numeric confidences presented as intelligence** and UI text that fakes AI; both must be
  corrected before AI output shares those surfaces.

**First slice after approval:** read-only Case Explanation on `/app/admin/cases/[id]`. Full detail:
`docs/architecture/loop-ai-runtime.md`.

## 6. Charlie and Lexi unblock matrix (after the 2026-09-15 decisions)

> **For current status, read `ui-track-handoff.md` §2 (updated 2026-09-16).** This table records the
> 2026-09-15 decision point and is not kept up to date. Since it was written, People, Person, Companies,
> Company, Relationships and Relationship Detail have moved to GREEN, and Intake is GREEN outright.

**Changes from the previous matrix:**
- Relationships, Relationship Detail, Opportunities, Opportunity Detail, Campaigns and Campaign Detail
  move **RED → YELLOW**. Their contracts are locked strongly enough to design without inventing truth.
- Creator administration moves to **YELLOW for the roster only.** The roster is TALENT_REPRESENTATION
  Relationships with the CREATOR role. Creator execution stays RED.
- Brain stays **RED.** The approved AI slice is Case Explanation, inside Intelligence, not the Brain
  conversation.

| Surface | Status | Contract to design against | Honest empty / loading / unavailable until implementation |
|---|---|---|---|
| Loop Shell | **GREEN** | `WorkspaceShell`, `LOOP_NAV`, server-resolved authority | — |
| Loop Home | **YELLOW** | Needs You (CI attention, personal queue, Work OS unowned stages); What Changed (AuditLog with `audit:view`); Loop Noticed (governed CI Headlines only); My Work (Work OS); Operating Pulse (CallGrid scorecard) | "What Changed since you last looked" until a last-visit instant exists; no Executive Brain confidence |
| Navigation | **GREEN** | C-01 five areas; route-transition proposal approved by Product before routes move | — |
| Record grammar | **GREEN** | Specification grammar | Sections whose authority is missing render unavailable |
| Context drawers | **GREEN** | Context chain is navigation state only | — |
| Responsive / mobile | **GREEN** | Specification density and priority rules | — |
| People | **YELLOW** | `PersonRecordV1` list: established, non-superseded PERSON Parties (P1) | Empty list today (0 established Parties) with an honest explanation; no Intake rows |
| Person Detail | **YELLOW** | `PersonRecordV1`: display name, establishment posture, reference state, linked Intake Records | Contact info only from linked Intake Records, **labeled Intake-derived** (PD-F-05); Relationships after R3; Activity after A2 (Intake context) and identity 2.5 (attributed) |
| Companies | **YELLOW** | `CompanyRecordV1` list (P1) | Empty today; never the tenant; never CallGrid buyers |
| Company Detail | **YELLOW** | `CompanyRecordV1` | As Person Detail; company profile fields unavailable (PD-F-05) |
| Intake | **GREEN** (provenance segment YELLOW) | Existing Customer authority under Intake Records naming; `IntakeRecordV1` | Provenance segment until the Intake Records read model lands; no merge action |
| Universal Activity | **YELLOW** | `activity.v1` | Known Party / Known Company lanes empty until identity 2.5; adapters land progressively (Case, Work, Intake, organization feed) |
| Relationships | **YELLOW** | `relationship-participant.md` §3 and §9: kinds (OWN / THIRD_PARTY), sides, lifecycle, grants | Empty until R3 and until Parties can be established (P1); actions shown only when the server allows |
| Relationship Detail | **YELLOW** | Sides, participants (roles, sides, dates, states), history, owner, duplicate diagnostic | Unavailable until R3; no health score (CI Findings by reference only) |
| Opportunities | **YELLOW** | `commercial-opportunity-campaign.md` §3.4 | Empty until the Opportunity slices land; stage labels come from organization configuration, so design for arbitrary labels |
| Opportunity Detail | **YELLOW** | §3.4: category, stage, human forecast with author and time, outcome and loss reason, participants, optional Relationship, Intake refs | AI recommendations shown as recommendations only; amount and expected close pending (PD-F-12); actions server-decided (PD-F-11) |
| Campaigns | **YELLOW** | §4.4 | Empty until the Campaign slices land |
| Campaign Detail | **YELLOW** | §4.4: lifecycle, terms, Relationship and Opportunity refs, provider campaign links with composed execution and measurement | Participants unavailable (deferred); invoices and payments unavailable (Accounting not built) |
| Work | **GREEN** | Work OS | Record links (`relatedRecord` null) and approvals (not wired) unavailable |
| Intelligence | **GREEN** | CI Headlines, Queue, Cases, Findings, Recommendations, Monitoring; Decision Center. Case Explanation panel: **YELLOW** against `loop-ai-runtime.md` §16. | Case Explanation "not configured" until gates G1–G6 hold |
| Operations | **GREEN** | C-01 area over existing authorities | — |
| CallGrid | **GREEN** | CallGrid execution, measurement and reconciliation (C-03) | No numeric confidence as truth |
| Creator administration | **YELLOW** (roster) / **RED** (execution) | Roster: TALENT_REPRESENTATION Relationships with CREATOR participants (R3) | Deliverables, earnings, uploads and AI critique: unavailable (no creator execution authority) |
| Brain | **RED** | Design exploration only | No Brain conversation; no "AI" labels on rules |
| Universal Search | **RED** (deferred, PD-F-10) | CRM-scoped search redesign only | — |

## 7. Minimum backend finish line (updated)

**Must land before UI resumes:**
1. **This handoff (#245) merged.** The contracts above become authoritative.

**Nothing else.** No backend implementation blocks the GREEN or YELLOW surfaces. The security fix #244
is independent and merges first.

**Contract sufficient — UI proceeds in parallel.** All implementation slices in §9.

**Can wait:**
- identity 2.1a–2.6;
- Activity A3–A5;
- numeric-confidence conversion before AI output shares those surfaces;
- universal search;
- multi-tenant ingestion (gates customer #2);
- legacy cleanup.

## 8. Product decisions

**Approved (2026-09-15)**

| ID | Decision |
|---|---|
| PD-F-01 | The tenant is the implicit owning side of OWN Relationships; THIRD_PARTY is Party ↔ Party; no self-Company Party |
| PD-F-02 | Relationship optional for Opportunity; no placeholder Relationship |
| PD-F-03 | Starting kinds and roles approved under the role/type invariants. No item contradicts them. |
| PD-F-04 | View: human roles. Create/update: EMPLOYEE+. End: MANAGER+. Void: OWNER/ADMIN. AI_EMPLOYEE hard-denied. Readings: reactivate follows end; AI_EMPLOYEE view denied. |
| PD-F-06 | Opportunity policy (`commercial-opportunity-campaign.md` §3.3) |
| PD-F-07 | Campaign policy (§4.3) |
| PD-F-08 | AI runtime architecture approved; Case Explanation first; no AI domain writes; activation gates |

**Deferred, non-blocking:**
- **PD-F-05 (Party contact points).** The UI may show contact information from linked Intake Records,
  labeled Intake-derived and never implied verified.
- **PD-F-09 (raw caller and message visibility).** Its own security slice.
- **PD-F-10 (universal search).** Deferred until the Party and Activity read models exist.

**Still needed** (non-blocking for UI design; blocks only the named service slices):

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| PD-F-11 | Grants for `opportunities` and `campaigns` | Mirror PD-F-04: view for human roles; create/update (including Opportunity stage, forecast and close) EMPLOYEE+; reopen, Campaign lifecycle transitions and provider link declarations MANAGER+; void OWNER/ADMIN; AI_EMPLOYEE denied | Opportunity and Campaign services |
| PD-F-12 | Confirm readings: categories OPEN / CLOSED_WON / CLOSED_LOST with WITHDRAWN as a loss reason; starting loss reasons; forecast amount and expected close date; Campaign lifecycle states; one CRM Campaign per provider campaign per period | Confirm as written | Opportunity and Campaign contract slices |
| AI activation | Values for gates G2–G6: provider terms confirmation, model ids, budgets, organization flag | Product and operations supply them at activation | Live Case Explanation only |

## 9. Implementation sequence (authorized)

**Independent now** (each from fresh `main`, a separate PR, none dependent on another):

| Slice | Contents |
|---|---|
| **#244** | Security fix (merge first) |
| **#245** | This handoff |
| **P1** | Party write actions; People and Companies read models; unestablished-Party review read model; human actor names on Party audit rows |
| **P1b** | Customer→Party link applies the Party Reference readings |
| **Intake** | Minimal C-04 wording corrections; `/crm/merge` disabled; Intake Records read model with read-time provenance segment |
| **A1** | `activity.v1` pure contract and fences |
| **R1** | Relationship and Participant pure contracts |
| **AI S0** | Provider-neutral runtime foundation: contracts, adapters with recorded fixtures, routing, budgets and validation skeleton, fences; no live calls |

**Dependent** (each waits for a merge checkpoint):

| Slice | Waits for | Contents |
|---|---|---|
| **A2** | A1 | Activity adapters (Case/Decision, Work item, Intake Record, organization feed); retire replaced shapes |
| **R2** | R1 | Relationship and Participant persistence and migration |
| **R3** | R2 | Services, authorization, events, audit, read models |
| **Opportunity contract** | R1 | Pure contract: categories, stage sets, transitions reducer, forecast history, loss reasons, participant subset. Also PD-F-12. |
| **Opportunity persistence and services** | R2, Opportunity contract, PD-F-11 | Adds `opportunityId` to the Participant exclusive arc (migration) |
| **Campaign contract, then persistence and services** | R1 / R2, PD-F-11, PD-F-12 | Opportunity refs added once Opportunity persistence exists |
| **AI S1** | S0 | Case Explanation, built to activate when gates G1–G6 hold |

**Changes from Product's suggested order, and why:**
1. **AI S0 moves to "independent now."** It depends on no CRM slice, so waiting idles it.
2. **The Opportunity pure contract can follow R1** (in parallel with R2/R3). Its persistence needs R2,
   because Opportunity participants extend the single Participant table.
3. **R2 is persistence (schema, migration, repositories) and R3 is services (authorization, events,
   audit, read models).** Schema then reviews and deploys on its own.
4. **P1 is sequenced before R3 in practice.** It isn't a code dependency, but no Relationship write can
   succeed until a Party can be established.

**Charlie and Lexi track (in parallel):** see `docs/product/ui-track-handoff.md`.

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

**FOUNDATION HANDOFF PARTIALLY READY — SPECIFIED SURFACES MAY RESUME**

**May resume** (GREEN now; YELLOW against the named contracts once #245 merges):
- Loop Shell, Navigation, Record grammar, Context drawers, Responsive/mobile;
- Loop Home, Intake;
- People, Person Detail, Companies, Company Detail;
- Universal Activity;
- Relationships, Relationship Detail, Opportunities, Opportunity Detail, Campaigns, Campaign Detail;
- Work, Intelligence (with the Case Explanation panel), Operations, CallGrid;
- Creator administration (roster only).

**Not yet:**
- Brain;
- creator execution capabilities;
- Universal Search.

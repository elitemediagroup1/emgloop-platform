# Relationship and Participant — architecture record

**Status:** ARCHITECTURE LOCKED (2026-09-15). Product approved PD-F-01 to PD-F-04 (§9). **Nothing here
is implemented yet.** Implementation proceeds in the slice order in §10, each slice from fresh `main`
with a merge checkpoint wherever the next slice depends on it.

**Authority order:** the Engineering Constitution (`CLAUDE.md`, `docs/ENGINEERING_PRINCIPLES.md`) →
locked decisions (`identity-evidence-resolution.md`, including PD-I2-01..09, C-01..C-05 and the Party
Reference readings; `loop-application-structure.md`) → this record.
`docs/product/loop-product-ui-architecture-v1.0.md` is the controlling UI/product architecture.

**Locked inputs this record applies, not reopens:**
- PD-I2-06: commercial Relationship is a **new** governed CRM authority; `IdentityRelationship` is
  not evolved into it.
- Party types are PERSON and COMPANY only. Commercial roles (Buyer, Brand, Agency, Publisher, Source,
  Creator, Partner, Vendor) are contextual roles, never Party types.
- The Party Reference contract (§12 of the identity record) and its approved readings:
  - writes reference ESTABLISHED Parties only;
  - a superseded id is refused and the canonical id returned;
  - reads follow at most 8 supersession hops;
  - no PERSON ↔ COMPANY chains;
  - archived Parties take no new references.
- The tenant (Workspace Organization) is not a Company Party (PD-I2-07). Cross-organization Party is
  deferred.
- Machines and AI may not independently establish identity. Consequential acts need human or explicit
  governed policy authority.

---

## 1. Repository facts that constrain the design

Verified on `main` `543c645`:

| Fact | Consequence |
|---|---|
| No Relationship, Participant, Opportunity, Campaign or Creator model exists. | Greenfield: no data migration of commercial records. |
| `IdentityRelationship` and `IdentityRole` are dormant: no production writer, 0 rows in the demo organization. They carry a competing vocabulary (`CREATOR_REPRESENTED_BY`, `BUYER_OF`, `VENDOR_TO`, `PARTNER_OF`, `CONTACT_FOR`, `EMPLOYED_BY`; `LEAD`, `CLIENT`, `BUYER_CONTACT`), and `IdentityRelationship` has a `confidence` column. | Confined, not evolved (§8). The Prisma enum name `RelationshipStatus` is taken. |
| `PartyService.create` and `establish` have **no production caller**, and production holds 0 established Parties. | No Relationship or Participant write can succeed until a governed Party write surface ships (prerequisite slice P1, §10). |
| The tenant has no Party. A Party Reference resolves only PERSON/COMPANY `CognitiveIdentity` rows inside the organization. | "EMG represents Creator" has no referent for EMG's side. Resolved by PD-F-01: the tenant is the implicit owning side of OWN Relationships and never a Party. |
| No User ↔ Party association exists (allowed by Product, not built). External participant authentication is not authorized (C-02). | A Party Participant cannot be an authorization input yet (§7). |
| `CaseParticipant` (a User on a Case): re-adding overwrites the row, and its two writes are not atomic. | A precedent for a participation log, not for row semantics. |
| `CustomerPartyLink` shows the active-key unique pattern: a nullable active key, a CHECK, and P2002 → re-read. | The pattern to copy. It does not yet refuse archived Parties or return the canonical id (debt, §11). |
| `OutboxSubjectType` has no RELATIONSHIP member. `ActiveStateDomain.RELATIONSHIP` exists. Subscribers cannot filter by subject or event type. | Adding the subject type is an enum migration; `domain = RELATIONSHIP` and `stateKey = relationship.<id>` are available now. |
| No team or reporting model exists. | MANAGER cannot be scoped to "their" relationships, so grants are organization-wide (PD-F-04). |
| `PARTY_CAPACITIES` holds the nine capacities Product approved in PD-F-03, decoupled from `CognitiveEntityType` names (slice R1, #251). Before R1 it was five names borrowed from the Prisma enum. | Done: the role vocabulary is its own governed contract (§6), versioned in `@emgloop/shared`. Adding a capacity is a reviewed contract change, never a schema question. |

## 2. What a Relationship is

A **Relationship** is a tenant-owned, CRM-governed record that a durable commercial connection exists,
or existed, between parties. It has a declared commercial purpose (its **kind**), a lifecycle, and the
Parties that take part in it.

- **It is a fact about the business, asserted by an authorized person.** It is not an interpretation:
  health, strength, sentiment and "at risk" belong to Commercial Intelligence and attach to a
  Relationship as governed Findings.
- **It is not** a pursuit (Opportunity), an agreed program (Campaign), a contract or terms record
  (Accounting), a communication thread, a work item, or an identity link.
- **It is never inferred.** A machine may recommend that a Relationship exists, through the governed
  Recommendation path. Only a human creates one.

## 3. Relationship contract

### 3.1 Structure

- **Identity.** `(organizationId, relationshipId)`. The organization is the tenant in whose CRM it was
  created, taken from the signed session. Every Party it references resolves inside that organization;
  a cross-organization reference is NOT_FOUND.
- **Kind and sides.** The kind comes from a governed vocabulary (PD-F-03). It declares:
  - its **structure**: OWN or THIRD_PARTY (PD-F-01);
  - its **sides**, each with a label. For REPRESENTATION, side A *represents* and side B *is represented
    by*. A symmetric kind such as PARTNERSHIP has two sides with the same label;
  - the **Party types** each side permits.
- **Direction lives in the kind's side definitions.** The commercial **capacity** each Party holds lives
  on its Participant role (§6). So direction belongs to **both**, each carrying a different half.
  - Example: "Agency represents Brand" is kind REPRESENTATION, with Agency on side A (role AGENCY) and
    Brand on side B (role BRAND).
- **Side Participants are principal.** A Relationship is created together with its side Participants,
  in one act. Additional Participants (contacts, decision makers) are added later and name the side
  they act for.
- **Several Relationships between the same Parties are allowed** when their kinds differ. An agency can
  both represent a brand and buy media from it.
- **Uniqueness.** At most one non-VOIDED Relationship per `(organizationId, kind, side Party set)`.
  - The side set is ordered for a directed kind and normalized (unordered) for a symmetric kind.
  - It is enforced by an active-key unique column that becomes NULL once VOIDED (the `CustomerPartyLink`
    pattern).
  - An ENDED Relationship keeps its key. Renewing the connection reactivates the same record, so its
    history stays whole.

### 3.2 Lifecycle

| State | Meaning | Entered by |
|---|---|---|
| ACTIVE | The connection exists. | Creation, or reactivating an ENDED Relationship. |
| ENDED | It existed and has stopped. | End act, with a reason and an optional business end date. |
| VOIDED | It was never true (entered in error). | Void act, with a reason. It releases the active key, stays readable, and is excluded from default lists. |

- **Allowed transitions:** ACTIVE → ENDED, ENDED → ACTIVE, ACTIVE → VOIDED, ENDED → VOIDED. VOIDED is
  final.
- **State is a projection** of the append-only Relationship event log (Engineering Principles Rules 1–2).
  The reducer is pure, in `@emgloop/shared`, and each row carries a `projectionVersion`.
- **No separate archive.** VOIDED covers "should not have existed" and ENDED covers "is over". Hiding
  old records is a view filter, not a state.
- **No PROSPECTIVE state.** PD-F-02 made Relationship optional for an Opportunity, so no placeholder or
  prospective Relationship exists.

### 3.3 Mutability and history

- **Immutable after creation:** organization, kind, the side Parties, creator and creation time.
  Changing any of these means VOID and create again.
- **Editable, and every change is an event:**
  - an optional display label and description;
  - the accountable owner, who is a **User**, not a Party (accountability, as with the Decision Engine
    owner);
  - business start and end dates: calendar dates, or null for unknown. Never defaulted.
- **The event log is append-only.** Nothing is deleted.

**Events.** Strings validated in `@emgloop/shared` (the `CaseParticipant.contribution` pattern, so a new
value is not a migration):
- RELATIONSHIP_CREATED, RELATIONSHIP_DETAILS_CHANGED, RELATIONSHIP_OWNER_CHANGED
- RELATIONSHIP_ENDED, RELATIONSHIP_REACTIVATED, RELATIONSHIP_VOIDED
- PARTICIPANT_ADDED, PARTICIPANT_CHANGED, PARTICIPANT_ENDED, PARTICIPANT_VOIDED

Each event carries:
- a `sequence`, unique per Relationship;
- `occurredAt` (when it was true in the world, with its basis recorded) and `recordedAt` (server clock;
  Loop Time Authority);
- actor type (HUMAN only for these acts) and the actor's user id;
- a reason (required for END, VOID and PARTICIPANT_ENDED/VOIDED);
- safe before/after values: states, roles, sides and ids. **Never names or contact values.**

### 3.4 Party supersession

- **Reads** resolve each side and Participant Party forward through the Party Reference contract. The UI
  shows the canonical Party and may note "superseded record". Stored Party ids are **never rewritten**.
- **Writes** that name a superseded Party (creating a Relationship, adding or changing a Participant) are
  refused with the canonical id, and the caller retries explicitly. Acts that name no Party (end,
  reactivate, void, edit details) are unaffected by supersession.
- **Duplicates after supersession.** Two non-VOIDED Relationships of one kind can end up resolving to the
  same canonical side set. The database key cannot see this because the stored ids differ.
  - The read model reports it as a **governed duplicate diagnostic**.
  - A person resolves it by ending or voiding one, with a reason.
  - Relationships are never merged automatically, and consolidating them is never identity supersession.
- **Chain failure.** A side whose Party chain fails (depth, cycle, type change, cross-org) reads as
  NOT_FOUND for that Party. The Relationship stays readable with that side shown as unavailable; nothing
  is guessed.

### 3.5 Party archive and establishment lapse

- **Archived Party:** existing Relationships and Participants stay readable. No new Relationship or
  Participant may reference it (approved reading).
- **Establishment lapse:** a referenced Party that later reads as NOT_ESTABLISHED keeps its existing
  Relationships readable, with that posture shown. This can happen, for example, when the establishing
  User is deleted and the actor can no longer be shown. New writes referencing that Party are refused.
  Nothing changes automatically.

### 3.6 Ownership boundaries

| CRM Relationship owns | Composed from its owner, never copied |
|---|---|
| Existence, kind, sides, lifecycle, participants, accountable owner, business dates | Relationship health and interpretation (CI Findings); communications (Communications); tasks (Work OS); commercial terms, invoices and payments (Accounting); pursuits (Opportunity); programs (Campaign); call and creator execution (CallGrid, Creators); identity posture (Party authority) |

## 4. Audit and events

Every Relationship and Participant write:
1. resolves the organization from the session and authorizes the act (§7);
2. validates Party References with `PartyReferenceRepository.requireReferenceable`;
3. in **one transaction**, appends the Relationship event, rewrites the projection columns and enqueues
   one `StateChangeOutbox` row;
4. writes an `AuditLog` row:
   - carrying the acting user's display name;
   - with a dotted action (`relationship.created`, `relationship.participant_added`, …);
   - with `entityType = 'relationship'`;
   - holding ids and reasons only.

The outbox row has:
- `subjectType = RELATIONSHIP` (an additive enum migration);
- `domain = RELATIONSHIP` and `stateKey = relationship.<id>`;
- a PascalCase `eventType` (RelationshipCreated, …, ParticipantAdded, …);
- a payload of ids, sequence, previous and new state, role and side. No names, no contact values, no
  interpretation (the decision-events precedent).

No audit row is written for a write that did not happen.

## 5. What a Participant is

A **Participant** is a governed, time-bounded assertion that an **established Party holds a contextual
role within a CRM subject**: a Relationship now, and an Opportunity or Campaign once those authorities
exist.

**One CRM Participant authority, not a table per subject.**
- Storage is a single table with an exclusive-arc subject reference: exactly one of `relationshipId`,
  later `opportunityId`, later `campaignId`. Each is a real FK, enforced by a CHECK.
- This keeps FK integrity without three parallel participation systems.
- Opportunity and Campaign add their columns additively when those authorities are built.

**Not CRM Participants:**
- **Activity participants** (who was on a call, who sent a message) are recorded by the source authority
  and attributed to Parties only through governed identity resolution (slice 2.5). They reach the UI
  through the Activity contract's subject and participant references (`universal-activity.md`), never as
  Participant rows.
- **User participation**: `CaseParticipant`, Work OS assignment, Conversation assignee, and Decision
  Engine owner/assignee. That is accountability and execution, not Party participation.

## 6. Participant contract

- **Reference.** A Participant is `(organizationId, participantId)`. It references its subject and a
  Party `(organizationId, partyId)`, and records the Party's type at write time for invariant checks.
- **Role.** From a governed vocabulary (PD-F-03), in two families:
  - **Commercial capacities** (Product's list): BUYER, BRAND, AGENCY, PUBLISHER, SOURCE, CREATOR,
    PARTNER, VENDOR, plus EMPLOYEE from `party.ts`.
  - **Engagement roles** (approved in PD-F-03): PRIMARY_CONTACT, DECISION_MAKER, BILLING_CONTACT.
- **Role and Party type.** Each role declares the Party types it permits. Example: CREATOR → PERSON,
  following the specification's "a managed creator remains a Person".
  - A role **never decides** a Party's type, and a Party type never implies a role.
  - A write whose Party type the role does not permit is refused.
- **Vocabulary strategy.**
  - Platform-governed, versioned in `@emgloop/shared`, stored as strings validated at the boundary, with
    a per-subject-kind list of valid roles.
  - Decoupled from `CognitiveEntityType` names. `PARTY_CAPACITIES` becomes the capacity family of the new
    role contract, and the 2.0b test that ties it to `CONTEXTUAL_ROLE_ENTITY_TYPES` is updated in the
    same slice.
  - `party.ts`'s list stays a statement of which cognitive entity types are not Party types.
  - Organization-configurable roles are **deferred**.
- **Side.** On a Relationship, a Participant either **is** a side (side A or B, or the counterparty side
  under PD-F-01) or **acts for** a side (an engagement role naming that side). Opportunity and Campaign
  define their own side semantics when built.
- **Multiple roles.** One Party may hold several different roles in the same subject, one row per role.
- **Direction.** Roles are not directional by themselves; direction comes from the side (§3.1).
- **Time.** Rows carry `effectiveFrom` and `effectiveTo` business dates (null for unknown) and a state of
  ACTIVE, ENDED or VOIDED.
  - Ending sets `effectiveTo`, requires a reason, and keeps the row.
  - VOIDED means entered in error.
  - A Party that holds a role again later gets a **new** row. History is never overwritten, unlike
    `CaseParticipant`'s upsert.
- **Uniqueness.** At most one ACTIVE row per `(subject, partyId, role)`, via an active-key unique column
  that is NULL when not ACTIVE.
- **Side Participants cannot be ended on their own.** A side changes only by voiding and recreating the
  Relationship. Engagement Participants can be ended or voided independently.
- **Supersession and archive.** As §3.4 and §3.5. Two ACTIVE rows that resolve to the same canonical
  Party and role after supersession display once, with a duplicate diagnostic. They are never merged
  automatically.
- **Removal.** Removing is END (it was true) or VOID (it was not). Participant rows are never deleted.
- **Events and audit.** PARTICIPANT_* events on the subject's log, the AuditLog row and the outbox event
  (§4), all in the same transaction as the Participant write.
- **Represented-party context** (a User acting for a Company).
  - **Current release:**
    - the actor of every act is always the authenticated **User**, whose authority comes from
      membership, role and permissions;
    - no external participant can authenticate (C-02), and a Participant never grants access;
    - acting "for" a Company can only be recorded as an engagement Participant naming the side it acts
      for. That is a fact about the business, not a credential.
  - **Deferred:** once a governed User ↔ Person Party association exists, an act may additionally record
    `representedPartyId` as provenance, checked against an active Participant role (e.g. AGENCY for that
    Brand). Using it as an authorization input needs its own Product decision.

## 7. Authorization

- **Inputs used now:**
  - identity (the session User);
  - organization membership (an ACTIVE membership in the session's organization);
  - role and Permission rows, through a new RBAC resource `relationships`. Its actions are view, create,
    update (details, participants, end, reactivate) and a stricter action for void. The grant matrix is
    PD-F-04.
- **Object participation.**
  - Not used for Party Participants, because Users are not Parties.
  - The Relationship's accountable owner (a User) is recorded and may become an object-level input
    later.
  - Scoping MANAGER to their team needs a team or reporting model, which does not exist.
- **Purpose, sensitivity and policy.** Relationship records carry no contact values, so their sensitivity
  class is OPERATIONAL. Purpose and policy evaluation apply when a Relationship is used as AI context
  (`loop-ai-runtime.md`).
- **AI_EMPLOYEE is hard-denied every Relationship and Participant write.** It does not get the matrix's
  READ_ONLY fallback for writes, following `identityResolution`.
- **Every page, server action and API route enforces its own authority.** Navigation visibility is never
  authorization.

## 8. What happens to the dormant identity tables

- **`IdentityRelationship` and `IdentityRole` are confined.** No new code reads or writes them, and a
  source fence test (slice R1) fails if any Relationship or Participant code imports their repositories.
- **Their retirement is decided with slice 2.1a.** That slice retires the dormant resolver, their only
  writer; the options are to drop them or keep them as cognitive-layer history.
- **Their commercial vocabulary is not imported** into the new contract.
- **Name collisions:**
  - Existing names: Prisma `RelationshipStatus`, `OperationalObservationType.PARTICIPANT_*`, and the
    exported `ParticipationOutcome` and `RelationshipDTO`.
  - The new contract uses `CRM_RELATIONSHIP_*` / `CrmParticipant*` names rather than renaming existing
    enums.

## 9. Product decisions (approved 2026-09-15)

### PD-F-01 — The tenant's own side of a Relationship: APPROVED

**Decision.** The tenant is the implicit owning commercial side of an **OWN** Relationship. The tenant
itself does **not** become a Party to satisfy the Relationship graph, and no self-Company Party is
created for it. Tenant identity (the Workspace Organization) and commercial Party identity remain
separate authorities.

**Kinds of Relationship:**
- **OWN** — one commercial Party side, with the tenant as the implicit owning side.
- **THIRD_PARTY** — commercial Party ↔ commercial Party, inside the tenant's CRM context.

**Scoping.** Tenant ownership and organization scoping stay explicit on every row
(`organizationId`, from the session).

### PD-F-02 — Relationship requirement for an Opportunity: APPROVED

**Decision.** A Relationship is **optional** for an Opportunity. An Opportunity may exist before any
formal Relationship. **No fake, placeholder, prospective or inferred Relationship** is created to
satisfy a reference. Where a valid Relationship exists, the Opportunity may reference it. Creating a
Relationship remains an explicit governed commercial act.

**Consequence for this record.** Relationship has no PROSPECTIVE state. The lifecycle stays ACTIVE /
ENDED / VOIDED.

### PD-F-03 — Initial vocabularies: APPROVED

The starting vocabulary below is approved under these invariants, checked against every item:
- Commercial roles (Buyer, Brand, Agency, Publisher, Source, Creator, Partner, Vendor and similar)
  remain contextual roles and never become Party types. Party type is PERSON or COMPANY.
- A Party may hold multiple contextual roles where valid.
- Role validity may constrain allowed Party types, but never determines Party type.
- The vocabulary is governed and versioned in `@emgloop/shared`, never scattered string literals.

**No item contradicts the invariants.** Every Party-type rule below is a constraint on a role or side.
None assigns a type.

**Kinds**

| Kind | Structure | Sides |
|---|---|---|
| CLIENT | OWN | counterparty engages the tenant (e.g. Brand, Buyer, Agency) — PERSON or COMPANY |
| SUPPLIER | OWN | counterparty supplies the tenant (e.g. Publisher, Source, Vendor) — PERSON or COMPANY |
| TALENT_REPRESENTATION | OWN | the tenant represents the counterparty Creator — PERSON only |
| PARTNER | OWN | counterparty is a commercial partner — PERSON or COMPANY |
| REPRESENTATION | THIRD_PARTY | side A *represents* side B — PERSON or COMPANY each |
| SUPPLY | THIRD_PARTY | side A *supplies* side B — PERSON or COMPANY each |
| AFFILIATION | THIRD_PARTY | side A (PERSON) *is affiliated with* side B (COMPANY) |
| PARTNERSHIP | THIRD_PARTY, symmetric | both sides *partner with* — PERSON or COMPANY each |

**Participant roles**

| Family | Role | Permitted Party types |
|---|---|---|
| Commercial capacity | CREATOR, EMPLOYEE | PERSON |
| Commercial capacity | BRAND, AGENCY, PUBLISHER, BUYER, VENDOR, SOURCE, PARTNER | PERSON or COMPANY |
| Engagement | PRIMARY_CONTACT, DECISION_MAKER, BILLING_CONTACT | PERSON |

Kind and role names are separate vocabularies, so kind PARTNER and role PARTNER do not collide.

### PD-F-04 — Grants for Relationship and Participant acts: APPROVED (current release)

| Act | Who |
|---|---|
| View | All authorized **human** workspace roles (OWNER, ADMIN, MANAGER, EMPLOYEE, READ_ONLY), subject to tenant, object, purpose and sensitivity policy |
| Create, update (details, owner, add or change a Participant) | EMPLOYEE and above |
| End a Relationship, end a Participant role | MANAGER and above |
| Void entered-in-error records | OWNER, ADMIN |
| Any consequential Relationship or Participant write | **AI_EMPLOYEE hard-denied**, whatever a Permission row says |

**Rules that come with the grants:**
- UI visibility never replaces server authorization.
- Object participation does not grant blanket CRM access in this release.
- The external authorization evaluator architecture is preserved: identity, membership, role, object
  participation, purpose, sensitivity, policy.

**Readings recorded with the grants.** Each is fail-closed and none broadens anything:
1. **Reactivation of an ENDED Relationship** follows the end grant (MANAGER and above). It is the
   inverse act, and the decision named only end.
2. **AI_EMPLOYEE view.** AI_EMPLOYEE is not a human workspace role, so the view grant does not include
   it. It is denied view until an AI principal policy says otherwise, matching `identityResolution`.

## 10. Implementation slices

**Split change.** Relative to the proposal, the slices are re-split to match Product's execution order.
Persistence (schema, migration, repository) lands separately from services (authorization, events,
audit). The schema then reviews and deploys on its own, and services review against real Prisma types.

| Slice | Contents | Migration | Depends on |
|---|---|---|---|
| **P1** (identity track) | Governed Party write actions over `PartyService.create` / `establish` with session organization, grants and actor names on audit rows; People and Companies read models (established, non-superseded PERSON / COMPANY Parties, organization-scoped, keyset-paginated, identity posture per §11a); unestablished-Party review read model | no | — |
| **P1b** | `CustomerPartyLinkService` uses `PartyReferenceRepository.requireReferenceable` (archived refused; canonical id returned on supersession) | no | — |
| **R1** | Pure contracts in `@emgloop/shared`: kinds and structures, role families and permitted Party types, lifecycle reducer and transitions, event vocabulary, grant map, invariants; `PARTY_CAPACITIES` decoupled from `CognitiveEntityType` names; confinement fence for `IdentityRelationship` / `IdentityRole` | no | — |
| **R2** | Persistence: `crm_relationships`, `crm_relationship_events`, `crm_participants` (exclusive arc with `relationshipId` now, active-key uniques, CHECKs, organization FKs); `OutboxSubjectType.RELATIONSHIP`; repositories with the uniqueness-race and constraint tests | **yes** (manual deploy) | R1 merged |
| **R3** | Services: `relationships` RBAC resource and grants; create, update, end, reactivate, void and participant acts through the Party Reference contract; one-transaction event, projection, outbox and audit; AI_EMPLOYEE denial; UI read models (list and detail with Party-resolved sides, participants, history, duplicate diagnostic; Relationships of a Person or Company) | no | R2 merged |

## 11. Invariants

1. A commercial role never becomes a Party type, and a Party type never implies a role.
2. Every reference resolves inside the session's organization. A cross-organization reference is
   NOT_FOUND, indistinguishable from a missing one.
3. Writes reference only ESTABLISHED, non-superseded, non-archived Parties. A superseded id is refused
   with its canonical id, never silently substituted.
4. Stored Party references are never rewritten, including to shorten a supersession chain.
5. Relationship and Participant history is append-only, and state is a rebuildable projection. Nothing is
   deleted: removal is END (was true) or VOID (was not).
6. Historical facts stay attributable. Every event has an actor, a time basis, and a reason where
   required. No names or contact values appear in events, audit metadata or outbox payloads.
7. A Participant role is contextual to one subject and one time range.
8. Relationship truth is CRM-owned. Interpretation, communications, work, terms, payments and execution
   stay with their owners and are composed, never copied.
9. No machine or AI creates, ends, reactivates, voids or changes a Relationship or Participant. A machine
   may only recommend, through the governed Recommendation path.
10. A Participant is never an authorization credential in the current release.
11. Relationships are never merged automatically, and consolidating Relationships is never identity
    supersession.
12. CRM Relationship and Participant code never reads or writes `IdentityRelationship` or `IdentityRole`.
13. Known debt: `CustomerPartyLinkService` does not yet apply the archived and canonical-id readings
    (slice P1b).
14. The tenant is never a Party. OWN Relationships carry the tenant only as their implicit owning side
    (PD-F-01).
15. No placeholder or inferred Relationship is ever created to satisfy another record (PD-F-02).

## 12. Decisions log

| Date | Decision |
|---|---|
| 2026-09-15 | PD-F-01 approved: tenant is the implicit owning side of OWN Relationships; THIRD_PARTY Relationships are Party ↔ Party; no self-Company Party |
| 2026-09-15 | PD-F-02 approved: Relationship optional for Opportunity; no placeholder or prospective Relationship |
| 2026-09-15 | PD-F-03 approved: starting kinds and roles (§9) under the role/type invariants; no item contradicts them |
| 2026-09-15 | PD-F-04 approved: view for human roles; create/update EMPLOYEE+; end MANAGER+; void OWNER/ADMIN; AI_EMPLOYEE hard-denied writes. Readings: reactivate follows end; AI_EMPLOYEE view denied |

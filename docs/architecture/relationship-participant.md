# Relationship and Participant — architecture record

**Status:** PROPOSED (2026-09-15). **Nothing here is implemented.** The architecture below is complete
except for four Product decisions (§9). No schema, service or UI work starts until Product answers them
and authorizes the implementation slices (§10).

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
| The tenant has no Party. A Party Reference resolves only PERSON/COMPANY `CognitiveIdentity` rows inside the organization. | "EMG represents Creator" has no referent for EMG's side (Product decision PD-F-01). |
| No User ↔ Party association exists (allowed by Product, not built). External participant authentication is not authorized (C-02). | A Party Participant cannot be an authorization input yet (§7). |
| `CaseParticipant` (a User on a Case): re-adding overwrites the row, and its two writes are not atomic. | A precedent for a participation log, not for row semantics. |
| `CustomerPartyLink` shows the active-key unique pattern: a nullable active key, a CHECK, and P2002 → re-read. | The pattern to copy. It does not yet refuse archived Parties or return the canonical id (debt, §11). |
| `OutboxSubjectType` has no RELATIONSHIP member. `ActiveStateDomain.RELATIONSHIP` exists. Subscribers cannot filter by subject or event type. | Adding the subject type is an enum migration; `domain = RELATIONSHIP` and `stateKey = relationship.<id>` are available now. |
| No team or reporting model exists. | MANAGER cannot be scoped to "their" relationships, so grants are organization-wide (PD-F-04). |
| `PARTY_CAPACITIES` is fixed at five by a 2.0b test and reuses `CognitiveEntityType` names. | The role vocabulary becomes its own contract (§6). The identity record §12 says the full set is decided by this architecture. |

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
  - its **structure** (see PD-F-01);
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
- **No PROSPECTIVE state**, unless PD-F-02 decides a Relationship must come before an Opportunity.

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
  - **Engagement roles** (require Product approval): for example PRIMARY_CONTACT, DECISION_MAKER,
    BILLING_CONTACT.
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

## 9. Product decisions required

Implementation of §3–§7 is blocked on these four. The recommendations are engineering's; the decisions
are Product's.

### PD-F-01 — The tenant's own side of a Relationship

**Question.** How is the tenant represented when it is itself a side? Examples: "EMG represents
Creator"; EMG's relationship with Nordstrom.

**Why locked decisions do not answer it.**
- Party types are PERSON and COMPANY.
- The Workspace Organization is explicitly not a Company Party (PD-I2-07).
- A Party Reference is `(organizationId, partyId)` only.
- Cross-organization Party is deferred.
- No decision says whether the tenant can be a side.

**Affected authority:** Relationship identity, uniqueness and sides; Participant sides; the seller side
of Opportunity and Campaign; what the Relationships list means.

**Options:**
- **A (recommended) — the tenant is the implicit owning side.**
  - A kind is either **OWN** (the tenant and one counterparty side Party) or **THIRD_PARTY** (two Party
    sides the tenant is not part of).
  - The tenant is never a Party and never a Participant row; an OWN kind's definition names the tenant's
    side.
  - For: no Party that is also the tenant, which keeps PD-I2-07 and C-04 clean; nothing to establish for
    the tenant; no premature cross-org identity hook; "our relationships" is a kind filter, not a Party
    join.
- **B — a governed self-COMPANY Party per tenant**, linked one-to-one to the Workspace Organization, so
  every Relationship is Party ↔ Party.
  - For: one uniform graph.
  - Against: a Party that is also the tenant blurs Company vs Workspace; it must be established in every
    organization; and it becomes a de facto cross-org identity anchor, which Product deferred.
- **C — OWN Relationships only, for the first release.**
  - For: simplest.
  - Against: "Agency represents Brand" and "Person works at Company" cannot be represented.

**Blocked:** Relationship schema and service (R2); Relationship list and detail semantics (UI RED); the
seller side of Opportunity and Campaign.

### PD-F-02 — Does commercial pursuit require a Relationship?

**Question.** Must every Opportunity belong to a Relationship, which would give Relationship a
PROSPECTIVE state? Or may an Opportunity reference its Parties directly and a Relationship optionally?

**Why locked decisions do not answer it.** "Person/Company → Relationship → Opportunity → Campaign" is the
intended progression, but it is not stated as a mandatory reference. No decision covers prospecting a
Party with no existing Relationship.

**Affected authority:** Relationship lifecycle; Opportunity identity and associations.

**Options:**
- **Recommended — optional.**
  - An Opportunity references Parties through Participants and may reference a Relationship.
  - Relationship has no PROSPECTIVE state.
  - Winning an Opportunity creates or reactivates a Relationship only by an explicit human act, never
    automatically (Engineering Principles Rule 6).
- **Alternative — required.** Relationship gains PROSPECTIVE, and every Opportunity must reference one.
  Prospecting then always starts by creating a Relationship.

**Blocked:** Relationship lifecycle reducer (R1); Opportunity architecture.

### PD-F-03 — Initial vocabularies

**Question.** Approve the initial Relationship kinds (with side labels and permitted Party types), the
Participant role families, and each role's permitted Party types.

**Why locked decisions do not answer it.** Product locked the commercial role list. It did not lock
Relationship kinds, engagement roles such as contacts, or per-role Party-type rules.

**Affected authority:** the Relationship and Participant vocabularies. They are stored as strings, so
later additions need no migration.

**Recommended starting set** (assuming PD-F-01 option A):

| Group | Values |
|---|---|
| OWN kinds | CLIENT (the counterparty engages the tenant: Brand, Buyer, Agency); SUPPLIER (the counterparty supplies the tenant: Publisher, Source, Vendor); TALENT_REPRESENTATION (the tenant represents a Creator; PERSON only); PARTNER |
| THIRD_PARTY kinds | REPRESENTATION (A represents B); SUPPLY (A supplies B); AFFILIATION (PERSON affiliated with COMPANY); PARTNERSHIP (symmetric) |
| Engagement roles | PRIMARY_CONTACT, DECISION_MAKER, BILLING_CONTACT (PERSON only) |
| Capacities, PERSON only | CREATOR, EMPLOYEE |
| Capacities, PERSON or COMPANY | BRAND, AGENCY, PUBLISHER, BUYER, VENDOR, SOURCE, PARTNER |

**Blocked:** R1 vocabularies; UI labels (the UI must not hard-code kinds before this decision).

### PD-F-04 — Grants for Relationship and Participant acts

**Question.** Who may view, create, update (details, participants, end, reactivate) and void?

**Why locked decisions do not answer it.** This is a new RBAC resource, and adding grants is authority
Product decides ("do not silently broaden permissions").

**Affected authority:** the `iam.repository.ts` MATRIX; AI_EMPLOYEE policy.

**Recommendation:**

| Action | Roles |
|---|---|
| view | OWNER, ADMIN, MANAGER, EMPLOYEE, READ_ONLY |
| create, update | OWNER, ADMIN, MANAGER, EMPLOYEE |
| end, reactivate | OWNER, ADMIN, MANAGER |
| void | OWNER, ADMIN |

- AI_EMPLOYEE is hard-denied every write, whatever a Permission row says. Its view access is undecided
  until the AI runtime policy.
- All grants are organization-wide until a team model exists.

**Blocked:** R2 authorization; UI action availability (the UI must not assume who can act).

## 10. Implementation slices (each needs authorization; none started)

| Slice | Contents | Migration | Depends on |
|---|---|---|---|
| **P1** (identity track) | Governed Party write actions: server actions over `PartyService.create` / `establish`, using the session organization, identityResolution grants and audit actor names. People and Companies read models: established, non-superseded PERSON / COMPANY Parties, org-scoped and paginated, with identity posture per `identity-evidence-resolution.md` §11a. An unestablished-Party review read model for OWNER/ADMIN. | no | authorization only (authority settled) |
| **P1b** | `CustomerPartyLinkService` adopts `PartyReferenceRepository.requireReferenceable`: it refuses archived Parties and returns the canonical id on supersession, per the approved readings. | no | authorization only |
| **R1** | Pure contracts in `@emgloop/shared`: kind and role vocabularies, lifecycle reducer, event vocabulary, invariant checks, a confinement fence for `IdentityRelationship` / `IdentityRole`, and `PARTY_CAPACITIES` decoupling. | no | PD-F-01..03 |
| **R2** | Schema: `crm_relationships`, `crm_relationship_events`, and `crm_participants` (exclusive arc, active keys, CHECKs, real organization FKs). `OutboxSubjectType.RELATIONSHIP`. The RBAC resource. Repository and service writing audit and outbox in one transaction. Tests: cross-org, superseded, archived, unestablished, duplicates, uniqueness races, AI_EMPLOYEE denial, no-contact-value fences. | **yes** (manual deploy) | R1, PD-F-04, P1 |
| **R3** | Read models for the UI: Relationship list and detail with Party-resolved sides, participants, lifecycle history and the duplicate diagnostic; Relationships on a Person or Company. | no | R2 |

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

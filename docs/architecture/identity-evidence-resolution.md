# Identity Evidence & Resolution — decision record

**Status:** direction approved by Product on 2026-09-15. **Nothing in this record is implemented yet
except Slice 1** (#239, ingestion records facts only) **and the 2.0 pure contracts** (#242: evidence
vocabulary and tiers, identity act authority, evidence use policy; nothing produces, stores or reads
evidence) **and the 2.0b Party Reference Contract** (#243: a pure contract and a read-only resolver). Every planned item names the slice that builds
it; until that slice merges, the code is the authority and this record is the plan. When a slice
lands, this record is updated in the same PR.

**Authority order:** the Engineering Constitution (`CLAUDE.md`, `docs/ENGINEERING_PRINCIPLES.md`) →
the locked decisions below → the rest of this record. Charlie and Lexi's **Loop Product and UI
Architecture v1.0** (2026-09-15, `docs/product/loop-product-ui-architecture-v1.0.md`) is the
controlling UI/product architecture alongside it. Product's resolutions C-01 to C-05 (2026-09-15) apply
to it: C-01–C-04 in `docs/architecture/loop-application-structure.md`, and C-04 (identity semantics) and
C-05 (identity posture) here.

**Supersedes:** the "Business Identity Architecture v1" assessment in `docs/PROJECT_STATUS.md`
(KEEP_SEPARATE cognitive identity, Customer as a DomainProjection, 19 open decisions). Those were
overtaken by the Party contract (#219), governed establishment (#224), CustomerPartyLink (#225) and
the decisions below.

---

## 1. Evidence base (production audit, run 34986946619, 2026-09-15)

| Fact | Measured |
|---|---|
| Customer records | 24,590 |
| CallGrid caller-ID ingestion residue | 24,579 (99.96%) |
| Records with a name | 2 |
| Records with no human-work evidence | 24,585 |
| Established Parties / IdentityEvidence / IdentityResolutionLinks / CustomerPartyLinks | 0 / 0 / 0 / 0 |
| Calls attached on last-seven-digit match only | 274 (58 records) |
| Attached calls whose caller number differs from the record's phone | 319 |
| After Slice 1 | 0 People created, 0 provider interactions attached, 0 workflow runs; interactions still stored |

Deleting a Customer detaches (SET NULL) its interactions, signals, conversations, bookings, orders and
service requests; it does not delete them.

## 2. Locked principles

**Architecture (Product, 2026-09-15):**
- Events are facts. Identity-bearing attributes are evidence. Neither an event nor a phone number is
  a Person.
- People is a projection of governed, established identity.
- The architecture is source-agnostic. No source (CallGrid included) is an identity authority, and
  there are no source-level CRM on/off toggles.
- An unidentified caller is never required to be resolved. UNRESOLVED is a legal, permanent state.
- There is one identity-resolution authority. No third identity system.

**Loop Product and UI Architecture v1.0 (`docs/product/loop-product-ui-architecture-v1.0.md`):**
- Intake is not identity and never automatically creates a Person.
- An unresolved caller is not a Person.
- Activity supports Known Party, Known Company, Unresolved and Anonymous states.
- Customer is demoted into explicit **Intake** authority.
- Person and Company are canonical Party experiences.
- Relationship is a first-class commercial subject.
- UI may compose authority but cannot create or transfer it.

**Product resolutions (C-04, C-05, 2026-09-15):**
- People are established, non-superseded PERSON Parties. Companies are established, non-superseded
  COMPANY Parties. Intake is entry into a commercial process.
- Customer is transitional Intake infrastructure. Customer ≠ Person ≠ Party. An Interaction, a caller
  ID, an anonymous visitor and an Intake record are each not a Person. **FACT ≠ IDENTITY ≠ INTAKE.**
- There is no numeric identity confidence. The specification's "identity confidence" means governed
  identity posture (§11a).

**Already locked in code:** the Party contract (`packages/shared/src/party.ts`), PartyService
(#224, Option D), CustomerPartyLinkService (#225), the identityResolution grant table and the
ingestion fences (#239). This record evolves them; it does not replace them.

## 3. The flow

```
Source Event → Interaction / Fact → Identity Evidence → Resolution → Party / Person → governed contextual links
```

| Stage | Record | Exists |
|---|---|---|
| Source Event | `IntegrationEvent`, `LoopEvent` | yes |
| Interaction / Fact | `Interaction`, `MarketplaceCall`, `DomainEvent`, `Signal` — no subject | yes (Slice 1) |
| Identity Evidence | `IdentityEvidence`, evolved | schema 2.1b, writer 2.3 |
| Resolution | `IdentityResolutionLink`, evolved | 2.5 |
| Party / Person | `CognitiveIdentity` read through the Party contract | yes (create, establish) |
| Contextual links | `CustomerPartyLink` (Intake ↔ Party); Relationship, Participant | CPL yes; others after 2.0b |

**Resolution is four acts, never collapsed:**

| Act | Meaning | Record |
|---|---|---|
| Attribute | This evidence (and its fact) is about Party P | `IdentityResolutionLink` kind EVIDENCE_ATTRIBUTION or CONTINUITY_ATTRIBUTION (2.5) |
| Establish | P is canonical identity | `CognitiveIdentity.established*` via `PartyService.establish` (exists) |
| Same Party / supersede | P1 is P2 | `IdentityResolutionLink` kind SAME_PARTY + `CognitiveIdentity.superseded*` (2.5b) |
| Contextual link | an Intake record, Relationship or Participant refers to established P | `CustomerPartyLink` (exists); Relationship/Participant (own authority, after 2.0b) |

Attribution never establishes, supersedes or links, and an attribution confirmation is never read as
an establishment basis (§6, fence in 2.0).

## 4. Vocabulary (pure contract, 2.0)

**Evidence kinds:** PHONE, EMAIL, NAME, VISITOR, SESSION, AUTH_ACCOUNT, FORM_SUBMISSION, OPERATOR_IDENTIFICATION.

**Assertion modes** — how a value was asserted, declared by the source policy (2.2), never inferred:

| Mode | Meaning |
|---|---|
| CONTINUITY | first-party visitor or session key |
| NETWORK_ASSERTED | supplied by the phone network (caller ID); spoofable |
| SUBJECT_PROVIDED | typed by the subject into a form or lead; unverified |
| OPERATOR_RECORDED | an authorized user heard or saw it |
| VERIFIED | a verification of this value was recorded (architecture only; verification deferred) |
| AUTHENTICATED | the subject's own authenticated act (no end-customer authentication exists) |

**Evidence class** = kind + mode (e.g. PHONE/NETWORK_ASSERTED, EMAIL/SUBJECT_PROVIDED). Retention and use
policy is configured per class (§7).

**Tiers:** ANONYMOUS < WEAK < MODERATE < STRONG, plus CONFLICTING. Ordered labels, never numbers. No
confidence value is computed, stored or read (C-05, §11a).

**Identifier flags:** SHARED, BUSINESS_LINE, SUSPECT, RECYCLED; state PROPOSED / ACTIVE / DISMISSED / REVOKED.

## 5. Evidence policy

"Match" means a match against an **established, non-superseded** Party. **No machine identity
attribution at launch** (Product): every attribution is a human proposal and a human confirmation.
Machine matches exist only as read-time, non-persistent suggestions.

| Evidence | Tier | Read-time suggestion | Attribution | Can establish alone |
|---|---|---|---|---|
| Caller ID alone, any frequency | WEAK | only against exactly one verified phone of one Party, identifier not SHARED/SUSPECT (none exist until verification) | human propose + confirm | never |
| Exact phone, subject-provided | MODERATE | against exactly one Party's verified phone | human | never |
| Exact phone, verified | STRONG | yes | human at launch | VERIFIED_PHONE (deferred) |
| Email, subject-provided | MODERATE | against exactly one Party's verified email | human | never |
| Email, verified | STRONG | yes | human at launch | VERIFIED_EMAIL (deferred) |
| Name + phone / name + email | as the contact value | a name never strengthens a suggestion | human | never |
| Website form submission | per contact field | per field | human | never |
| Session / visitor continuity | ANONYMOUS | never to a Person | continuity attribution, human-confirmed (§9) | never |
| Authenticated user act | STRONG | — | human at launch | AUTHENTICATED (no end-customer auth exists) |
| Explicit human identification | STRONG once confirmed | — | EMPLOYEE records/proposes, MANAGER+ confirms | MANUAL or EXPLICIT_LINK, by OWNER/ADMIN only |
| Conflicting (two Parties, contradiction, flagged identifier) | CONFLICTING | none | human, reason required | never |

**Frequency never raises a tier.** Twenty calls from one number are twenty WEAK observations. Counts
may prioritize a review worklist and support a *proposed* flag; nothing else.

**Contract readings (2.0, #242; fail closed):**
- Only matrix rows are evidence classes.
  - PHONE/EMAIL `OPERATOR_RECORDED` is not an approved class (approved, Product 2026-09-15).
  - Nor is NAME in any mode other than `SUBJECT_PROVIDED`.
  - Neither can have a use policy or produce evidence.
- VERIFIED and AUTHENTICATED classes are unavailable. They contribute no tier and establish nothing
  (required by the 2.0 authorization).
- A name alone is WEAK (approved, Product 2026-09-15).
- An operator identification is WEAK until an authorized person confirms it (approved, Product
  2026-09-15).
- Only ACTIVE flags conflict: SHARED, SUSPECT and RECYCLED always; BUSINESS_LINE only for a Person
  (follows §8).

**SSDI / form leads vs FE caller-ID-only traffic** differ only by the evidence they carry, through the
same pipeline. An FE call yields one PHONE/NETWORK_ASSERTED observation (WEAK, stays unresolved). An
SSDI lead yields SUBJECT_PROVIDED name, email and phone (MODERATE): a suggestion against an established
Party, or an identified lead a human may turn into an unestablished Party. **Sensitive SSDI fields are
excluded from IdentityEvidence** by the source policy; raw sensitive-data access and retention is a
separate policy decision.

## 6. Authority boundaries

Grants are the existing `IDENTITY_RESOLUTION_GRANTS`; no grant change is required.

| Act | Required action | Holders | Machine | AI |
|---|---|---|---|---|
| Read identity state, evidence summaries (never raw values), suggestions | view | all but AI_EMPLOYEE | — | read-time hints only |
| Record operator identification; propose attribution; propose continuity attribution | create | EMPLOYEE, MANAGER, OWNER, ADMIN | no | no |
| Create an unestablished Party (`PartyService.create`) | create | EMPLOYEE+ | no | no |
| Confirm / reject an attribution (incl. continuity) | update | MANAGER, OWNER, ADMIN | no | no |
| Reverse a confirmed attribution — reason required; the confirmation is kept (PD-I2-02) | update | MANAGER, OWNER, ADMIN | no | no |
| Set, dismiss or revoke an identifier flag | update | MANAGER+ | propose only | no |
| Establish a Party (`PartyService.establish`) | approve | OWNER, ADMIN | no | no |
| Link / reverse Intake → Party (`CustomerPartyLinkService`) | approve | OWNER, ADMIN | no | no |
| Confirm same Party / supersede | approve | OWNER, ADMIN | no | no |
| Activate a machine policy (deferred) | approve | OWNER, ADMIN | no | no |
| Activate or change an evidence use policy (PD-I2-01) | approve | OWNER, ADMIN | no | no |
| Extract evidence from new facts | system projection, gated by active class policy | — | yes | no |

- A MANAGER may not confirm their own proposal (PD-I2-03); proposal and confirmation stay separate acts.
  In the 2.0 contract (#242), OWNER and ADMIN stay under the approved model. Any other role holding
  `update` only through a Permission row also cannot confirm its own proposal. A proposer may reject
  (withdraw) their own proposal (approved, Product 2026-09-15).
- `approve` stays the only action that establishes, links, supersedes or confirms same-Party. The
  attribution confirmations held under `update` are recorded separately and are never read as an
  establishment or same-Party basis.
- AI_EMPLOYEE writes no identity state of any kind: evidence, proposals, confirmations, flags, Parties,
  links, establishment or supersession. AI may surface read-time, non-persistent hints. There is no AI
  provider today, so any hint shipped now is a deterministic rule and is not labelled AI.

## 7. Evidence retention and use policy

Hash-only unresolved evidence is approved architecturally. **No legal basis and no retention period is
a Product assumption in code.** Retention and permitted use are configured per evidence class, by the
organization, before any evidence is produced:

- Stored in the existing `DataGovernancePolicy` (one policy authority), extended with the evidence
  class it applies to (2.1b). `retentionDays`, allowed/denied purposes, `requiresConsent` and
  `requiresHumanApproval` already exist there.
- Activating or changing a class policy requires `identityResolution:approve` (OWNER/ADMIN), is audited, and
  can never be done by a machine or AI (PD-I2-01, 2.1b).
- The extractor (2.3) writes nothing for a class without an ACTIVE policy (fail closed), stamps each
  evidence row with the policy version it was produced under, and honours `expiresAt`.
- `consentBasis` on an evidence row records only what the fact captured (e.g. consent collected with a
  lead); it is never defaulted to a legal basis.
- **Legal-basis vocabulary (Product, 2026-09-15):** the existing `ConsentBasis` values other than NONE.
  The organization records which one applies to a class, with its reference. Nothing defaults it, and a
  policy with an UNSET basis produces nothing (`evidence-use-policy.ts`, #242).

## 8. Accumulation, ambiguity and supersession

- **Persistence without a Party:** fact-derived evidence rows keep `identityId` NULL permanently.
  Attribution lives in a link, not by rewriting the evidence. No Customer, CognitiveIdentity or Party
  is created for unresolved evidence.
- **Accumulation:** a per-identifier profile (first/last seen, count, distinct sources and modes,
  distinct subject-provided names, hashed) is a derived, rebuildable read model (2.4). It never produces
  a tier or a confidence.
- **Shared and business lines:** a business line is evidence for a COMPANY Party, never a Person.
  Machines may propose SHARED/BUSINESS_LINE from patterns (many distinct subject-provided names); MANAGER+
  decides.
- **Recycled numbers:** evidence carries `observedAt`; verified contact points (deferred) carry a
  verification time and can expire; confirmed attributions do not carry forward to new facts.
- **Spoofing:** caller ID never earns more than a suggestion. No spoofing or attestation data exists in
  current payloads.
- **Contradiction:** evidence pointing at two Parties or at a flagged identifier is CONFLICTING and gets
  no suggestion; a human decides with a reason.
- **Evidence supersession:** evidence is revoked or expires; it is never deleted.
- **Party supersession:** records resolve forward; nothing pointing at the superseded Party is rewritten.
  The 2.5b supersession writer must (Product, 2026-09-15):
  - prevent cyclic or invalid supersession chains;
  - refuse superseding into an already-superseded Party where that would create an invalid chain;
  - prohibit cross-type (PERSON ↔ COMPANY) supersession;
  - provide governed diagnostics for abnormal or over-depth chains;
  - not rewrite historical pointers merely to shorten an otherwise valid chain.

  **Correcting a misclassified Party is not supersession** and is never inferred into it. If Party-type
  correction is needed, it is designed as its own governed operation.

## 9. Anonymous history

Before identification, visitor and session keys group facts into an anonymous journey with no Party.
When a fact from visitor V has been attributed to an established Party P, a human (create) may
propose that V's earlier facts are about P, and MANAGER+ confirms (update). Scope: the same first-party
visitor key and property, within the window and purposes the class policy allows. **Automatic
attribution is deferred.**

## 10. Intake (Customer)

Amended Product decision 8 and PD-I2-04 (2026-09-15). **Fact ≠ Identity ≠ Intake.**

- **Customer is Intake authority.** An Intake record is never identity evidence or identity authority,
  and nothing reads its contact values to decide identity (already locked in CustomerPartyLinkService).
- Establishing a Person or Company **does not create** an Intake record.
- Governed Person and Company experiences **compose** linked Intake records through `CustomerPartyLink`.
- Existing `customerId`-based systems (conversations, bookings, orders, service requests, workflows)
  are preserved as they are. Identity Slice 2 does not rewrite them around Party.
- Intake and Identity are separate authorities. An Interaction does not create Intake; a Person does not
  create Intake; Intake does not create or establish a Person. A Person may exist without Intake, Intake
  without a resolved Person, and several Intake records may relate to one established Party.
- Intake may be created only by an explicit authorized human intake action, or by a source event that
  satisfies a governed Intake policy showing a real commercial intake occurred. Caller ID alone, a ringing
  phone, anonymous traffic, a session or ordinary activity never qualifies. **The Intake creation authority
  is a separate contract, not built by the identity slices.**
- `/crm/merge` is to be disabled, not adapted (PD-I2-05). Customer merge is never Party resolution.
- The 24,590 legacy Intake records are classified **at read time** by the provenance marks the audit
  used (`metadata.createdFrom`, the `web-visitor:` external id, tags). No classification is written
  back. No record is deleted, hidden in storage, merged, relinked or backfilled.
- **Naming and routes (C-04).**
  - Legacy Customer records are **Intake Records**. Their exact route is set by Charlie and Lexi's
    route-transition proposal.
  - `/app/crm/people` is reserved for PERSON Parties.
  - Until the redesign, an existing screen that falsely presents Customer rows as People may receive
    only the smallest semantic wording correction (PD-I2-08). No record is deleted, purged, migrated or
    relinked, and no `customerId` system is rewritten.

## 11. People projection (2.6)

- **People** shows established, non-superseded PERSON Parties, in this organization, read through the
  Party contract. Starting at 0 is correct and is shown as an honest empty state.
- **Intake Records** remain separately accessible and separately counted to authorized users, with the
  read-time provenance segment. Achieved by reads only; no Intake record is mutated.
- A PERSON row that is not established, or an anonymous cognitive subject, never appears in People.
- **Companies** are established, non-superseded COMPANY Parties (C-04). They are not People, and they
  are not the tenant, which is the Workspace Organization (PD-I2-07).

## 11a. Identity posture (C-05)

The specification says a Person record "shows identity confidence". **In Loop that phrase means
governed identity posture, never a number.**

**Posture is composed of:**
- establishment state and basis (`MANUAL` / `EXPLICIT_LINK` today);
- resolution posture: CONFIRMED_SAME_PARTY, POSSIBLE_MATCH or UNRESOLVED;
- evidence tier (§4), including CONFLICTING;
- provenance (who or what asserted it, under which policy);
- freshness (when the supporting evidence was observed);
- limitations (for example, caller ID is spoofable and verification is not built);
- conflicting evidence.

**Never shown, computed or stored:** a 0–1 score, a percentage, an AI confidence number or a weighted
frequency score. The legacy `IdentityResolutionLink.confidence` column stays unread (§14).

**Fence.** The 2.0 contracts carry no numeric confidence field, and a test fails if one appears.

The broader UX intent is unchanged: identity posture is visible on the record and expands progressively.

## 12. Party Reference Contract (2.0b)

How every other domain (Relationship, Participant, Opportunity, Campaign, UI composition) refers to a
Party:

- Reference by `(organizationId, partyId)` only. No lookup by name, contact value, key or evidence.
- States: ESTABLISHED, NOT_ESTABLISHED, SUPERSEDED (with the canonical id), NOT_FOUND. Cross-organization
  and non-Party ids are NOT_FOUND, indistinguishably.
- Writes may reference ESTABLISHED Parties only. **Participant may not reference an unestablished Party.**
- Reads resolve SUPERSEDED forward; stored references are not rewritten.
- Referencing never creates, establishes, links or reads evidence.
- Capacities are held by a Party in a context for a time. 2.0b starts from the five `party.ts` already
  names (buyer, vendor, source, creator, employee); the full set is decided by the Relationship and
  Participant architecture. A capacity never decides Party type, and a Party type never implies one.
  That architecture is proposed in `docs/architecture/relationship-participant.md` §6: a role contract
  decoupled from `CognitiveEntityType` names (PD-F-03 approved 2026-09-15).
- The dormant `IdentityRole` table (written only by the ungoverned `IdentityRoleRepository`, reached only
  from the dormant resolver) is not the capacity authority, and 2.0b neither reads nor writes it. The
  proposed Participant architecture confines it together with `IdentityRelationship`; retirement is
  decided with 2.1a (`relationship-participant.md` §8). The specification's "contextual roles" on a
  Person are these capacities.
- `CaseParticipant` (Commercial Intelligence) is a User's participation in a Case. It is not a Party
  Participant and is not renamed by this work.
- **Contract readings (2.0b, #243; fail closed):**
  - An archived Party resolves with `archived: true` and takes no new references (approved, Product
    2026-09-15).
  - A supersession chain fails closed as NOT_FOUND on a cycle or on a link out of the organization
    (required by the 2.0b authorization).
  - **Depth guard (approved, Product 2026-09-15).** Reads follow at most 8 supersession hops. A longer
    chain fails closed as NOT_FOUND. It never guesses, silently continues or returns an uncertain
    canonical Party.
  - **No cross-type chains (approved, Product 2026-09-15).** A chain may not cross between PERSON and
    COMPANY. A read that meets PERSON → COMPANY or COMPANY → PERSON returns NOT_FOUND.
  - **Writes are refused, never substituted (approved, Product 2026-09-15).** A write that references
    a superseded Party:
    - is refused and returns the canonical Party id (in the caller's organization);
    - requires the caller or user to retry explicitly against the current Party.

    Writes keep the exact subject of the authorized act and never silently change it. Reads resolve
    forward. A UI may explain that a record was superseded and offer "Use current record". That action
    is a new, explicit attempt against the canonical Party, never a rewrite of the original action.

## 13. Audit and provenance

| Act | Recorded |
|---|---|
| Evidence extraction | fact reference, class, source policy version, use policy version, time; no raw value |
| Machine flag proposal | rule id and version, identifier kind (hashed key), time |
| Human proposal / confirmation / rejection / reversal | user, time, reason (required for reject and reverse), on the link row and in AuditLog |
| Establishment | existing `party.established` audit and `established*` provenance |
| Intake → Party link and reversal | existing `customer.party_linked` / `customer.party_link_reversed` |
| Supersession | user, time, reason, canonical id |
| Policy activation / change | user, class, version, time |

Identity writes are to publish `OutboxSubjectType.IDENTITY` state changes on the existing outbox (no
new bus). **Not built yet:** `PartyService` and `CustomerPartyLinkService` write audit rows only, and
record no actor display name (the rows read "System").
Audit rows never contain names or contact values.

## 14. Planned schema changes

All additive. Migrations reach production only through the manual `Deploy Prisma Migrations` workflow.

**2.1b (one migration):**
- `IdentityEvidence`: `identityId` nullable; add evidence class, assertion mode, fact type + fact id,
  hash scheme version (kind-level, E.164-normalized phones, so caller ID and phone for the same number
  compare), source policy version, use policy id + version; unique (organization, fact type, fact id,
  class, value hash); index (organization, class, value hash). Production holds 0 rows, so the hash
  scheme changes without rotation.
- `DataGovernancePolicy`: nullable evidence class it applies to, indexed; a nullable legal basis (a
  `ConsentBasis` value other than NONE) and the organization's reference for it. Null is UNSET, and an
  UNSET policy produces nothing (the 2.0 use-policy contract, #242).
- New satellite `identity_identifier_flags`: organization, identifier kind, value hash, flag, state,
  proposed-by (system rule or user), set/dismissed/revoked by user with reasons and times; one active
  flag per (identifier, flag) via a nullable active-key unique (the `CustomerPartyLink` pattern).

**2.5 (one migration):**
- `IdentityResolutionLink`: add link kind (SAME_PARTY, EVIDENCE_ATTRIBUTION, CONTINUITY_ATTRIBUTION);
  `sourceIdentityId` nullable plus `sourceEvidenceId`, exactly one per kind (CHECK); `proposedByUserId`,
  `proposedAt`, `decidedByUserId`, `decidedAt`, `decisionReason`, `reversedByUserId` (FKs to users);
  CHECKs tying CONFIRMED/REJECTED to a decider and REVERSED to a reverser; one active attribution per
  evidence row via an active-key unique. Legacy `confidence` and free-text `establishedBy` stay unread.

**No change:** `CognitiveIdentity` (supersession columns exist), `CustomerPartyLink`, `Customer`, every
`customerId` table.

## 15. Slices

| Slice | Contents | Migration | Production write |
|---|---|---|---|
| 2.0 | Pure contracts and fences (§4–6, §11a); this record kept current | no | no |
| 2.0b | Party Reference Contract + capacity vocabulary + read-only reference resolver | no | no |
| — | *Relationship + Participant architecture may proceed in parallel from here* | | |
| 2.1a | Retire the dormant cognitive resolver as an independent resolver | no | no |
| 2.1b | Evidence schema, identifier flags table, class policy extension + governed policy activation | yes | no (policies are set by people) |
| 2.2 | Source identity policies (CallGrid, website, lead template; sensitive exclusions) | no | no |
| 2.3 | New-fact evidence extraction projection; starts at policy activation; no historical backfill | no | evidence rows |
| 2.4 | Review read models: unresolved identifiers, read-time suggestions, activity subject state, Intake identity state | no | no |
| 2.5 | Governed resolution: propose, confirm/reject/reverse, flags, continuity attribution | yes | human acts |
| 2.5b | Governed supersession (`PartyService`), under the §8 writer rules | no | human acts |
| 2.6 | People projection and Intake Records read models; counts | no | no |

**Gated or deferred:** historical evidence backfill (separate Product checkpoint), machine
attribution, automatic anonymous-history attribution, verification (VERIFIED_EMAIL/PHONE writers),
legacy remediation, raw sensitive-data policy.

## 16. Parallel work and backend contracts

> The current, cross-domain readiness matrix and UI unblock matrix are in
> `docs/product/foundation-handoff.md` (2026-09-15). This section is kept for the identity-specific
> contract history.

**Charlie and Lexi (parallel UI track, C-01 to C-05)** may design the global navigation, Loop Home, CRM
information architecture, People, Companies, Intake Records, Relationship, Opportunity, Campaign,
Activity, Operations → Creators and Operations → CallGrid, and the route-transition proposal. Their
screens consume backend authority. Claude owns backend authority, contracts and read models. **Neither
track creates a temporary competing implementation to unblock the other.** No UI work invents backend
authority that does not exist. After 2.0b, Relationship and Participant architecture may proceed
against the Party Reference Contract.

| Area | Classification | Available now | Needed |
|---|---|---|---|
| Universal Activity | CONTRACT NEEDED | facts (Interaction, MarketplaceCall, DomainEvent, AuditLog, Signal); timeline adapters; live and inbox feeds | activity subject-state read model (Known Party / Known Company / Unresolved / Anonymous) — Unresolved/Anonymous derivable from facts; Known states need 2.5 attribution |
| Canonical Person | CONTRACT NEEDED | `PartyService.create/establish`, `PartyRepository.findParty`, grants, CPL history | Person read model and established-Person list (2.6); contact points: AUTHORITY MISSING (verification deferred); profile editing: AUTHORITY MISSING |
| Canonical Company | CONTRACT NEEDED | same Party authorities for COMPANY | Company read model; company profile attributes: AUTHORITY MISSING |
| Relationship | AUTHORITY MISSING | dormant `IdentityRelationship` (ungoverned, not authoritative) | governed Relationship authority designed on 2.0b |
| Opportunity | AUTHORITY MISSING | nothing (intake status is not Opportunity) | Opportunity + Participant authority on 2.0b |
| Campaign | AUTHORITY MISSING | campaign attribution facts on `MarketplaceCall` | Campaign authority; campaign participation DEFERRED |
| Intake Records → Party identity state | CONTRACT NEEDED | Intake records; `CustomerPartyLinkService` link/reverse/history (PERSON or COMPANY target, established only) | Intake identity-state read model with read-time provenance segment and identity posture (§11a); governed action contract for the UI |
| Operations → Creators | AUTHORITY MISSING | nothing: no creator model; `CREATOR` is only a contextual role name in `party.ts` | creator participation and capability around an established Person, designed with Participant after 2.0b; creator is never a Party type |

## 17. Known conflicts with current code (resolved in the named slice)

- `IdentityEvidence.identityId` is required; evidence type is inside the hash; phones are digits-only → 2.1b.
- `IdentityResolutionLink` links identities only and records no governed actor (`confirm()` has no
  actor; `establishedBy` is free text) → 2.5.
- The dormant resolver would mint anonymous PERSON subjects and write evidence on its own terms → 2.1a.
- Several surfaces present Intake records as People (C-04):
  - `/crm/customers` is labelled People.
  - The record page's eyebrow reads "Person / Intake Record".
  - The Command Center, Analytics, search and the `crm.new_customers` metric ("People added", Slice 1)
    count Intake records.

  Remedy: the smallest wording correction is permitted now (PD-I2-08) but not yet done; the redesign
  belongs to Charlie/Lexi; the People and Intake Record counts come in 2.6.
- `/crm/merge` repoints facts between Intake records irreversibly with counts-only audit → to be disabled
  (PD-I2-05).
- The CRM `organizations` route is the tenant organization, not a canonical Company → "Workspace" /
  "Workspace Organization" (PD-I2-07); UI application by Charlie/Lexi.

## 18. Decisions log

| Date | Decision |
|---|---|
| 2026-09-13 | Party contract; governed establishment (Option D grants); CustomerPartyLink rules (#219, #224, #225) |
| 2026-09-15 | Slice 1: ingestion records facts only (#239) |
| 2026-09-15 | Evidence tiers approved; caller ID stays WEAK at any frequency; read-time suggestion against exactly one verified phone only |
| 2026-09-15 | No machine identity attribution at launch |
| 2026-09-15 | MANAGER confirms/rejects attribution; OWNER/ADMIN establish, link, supersede and activate policy |
| 2026-09-15 | Hash-only unresolved evidence approved; retention/use configurable per class before production; no legal basis assumed |
| 2026-09-15 | EMPLOYEE identifies, proposes, creates unestablished Parties |
| 2026-09-15 | Anonymous-history attribution human-confirmed at launch; automatic deferred |
| 2026-09-15 | People = established, non-superseded PERSON Parties; Intake Records separate, read-only projection |
| 2026-09-15 | Decision 8 amended: Customer is Intake authority; customerId systems preserved; experiences compose linked Intake |
| 2026-09-15 | Verification in architecture, build deferred |
| 2026-09-15 | MANAGER+ set identifier flags; machines propose only |
| 2026-09-15 | Sensitive SSDI fields excluded from IdentityEvidence |
| 2026-09-15 | AI: read-time non-persistent hints only; no identity writes |
| 2026-09-15 | Party Reference Contract approved and moved to 2.0b; Participant references established Parties only |
| 2026-09-15 | Legacy provenance definitions approved for read-time classification only |
| 2026-09-15 | Historical evidence backfill not authorized |
| 2026-09-15 | Dormant cognitive resolver retired as an independent resolver; one resolution authority |
| 2026-09-15 | PD-I2-01: only OWNER/ADMIN (`approve`) activate an evidence use policy; machine/AI never; no evidence for a class without an authorized active policy |
| 2026-09-15 | PD-I2-02: MANAGER/OWNER/ADMIN (`update`) reverse a confirmed attribution with a mandatory reason; history kept |
| 2026-09-15 | PD-I2-03: a MANAGER may not confirm their own proposal; confirmation is never establishment |
| 2026-09-15 | PD-I2-04: Intake is a separate authority (Fact ≠ Identity ≠ Intake); creation only by an authorized human intake action or a governed Intake policy; customerId systems preserved |
| 2026-09-15 | PD-I2-05: disable `/crm/merge`; historical records are not deleted |
| 2026-09-15 | PD-I2-06: canonical commercial Relationship is a new governed CRM authority; `IdentityRelationship` is not evolved into it and is eventually retired or confined |
| 2026-09-15 | PD-I2-07: "Company" is a commercial COMPANY Party; the tenant is "Workspace" / "Workspace Organization"; no model renames for wording |
| 2026-09-15 | PD-I2-08: Claude owns backend authority, contracts and read models; Charlie/Lexi own the redesigned UI; only minimal wording fixes to materially false existing labels |
| 2026-09-15 | PD-I2-09: the Loop Product and UI Architecture v1.0 is committed at `docs/product/loop-product-ui-architecture-v1.0.md` |
| 2026-09-15 | C-01: five operating areas (Home, CRM, Work, Intelligence, Operations); Administration and Accounting are not peer areas; IA only, no route migration in 2.0/2.0b; Charlie/Lexi own the route-transition proposal (`loop-application-structure.md` D1, D3) |
| 2026-09-15 | C-02: Creator Hub is not a peer area; internal creator administration is Operations → Creators; `/app/creator` transitional; external participant auth, memberships, portals and multi-org sign-in not authorized (`loop-application-structure.md` D5) |
| 2026-09-15 | C-03: CallGrid split by authority (operations / intelligence / credentials and integration governance); no duplicate tree; no route moves in 2.0/2.0b (`loop-application-structure.md` D3, D4) |
| 2026-09-15 | C-04: D2 superseded. People = established non-superseded PERSON Parties; Companies = established non-superseded COMPANY Parties; Intake = entry into a commercial process; legacy Customers are Intake Records; `/app/crm/people` reserved; Customer ≠ Person ≠ Party; only minimal wording fixes; no delete, purge, migrate, relink or `customerId` rewrite (§10, §11) |
| 2026-09-15 | C-05: no numeric identity confidence; "identity confidence" means governed identity posture (§11a) |
| 2026-09-15 | Identity 2.0b Party Reference readings approved (§8, §12). Reads follow at most 8 supersession hops and fail closed beyond. PERSON ↔ COMPANY chains are NOT_FOUND. A write naming a superseded Party is refused, returns the canonical Party, and needs an explicit retry; it is never silently substituted. 2.5b writer: no cyclic, invalid or cross-type chains; governed diagnostics for abnormal chains; no pointer rewrites to shorten chains. Party-type correction is not supersession |
| 2026-09-15 | Identity 2.0 fail-closed readings approved (§5, §6, §7, §12). Name alone = WEAK. Operator identification = WEAK until confirmed. Operator-entered phone/email is not automatically an approved evidence class. A proposer may reject/withdraw their own proposal. The current legal-basis vocabulary is `ConsentBasis` excluding NONE. Archived Parties accept no new references |

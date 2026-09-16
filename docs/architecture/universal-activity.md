# Universal Activity — architecture record

**Status:** CONTRACT ON `main`; ADAPTERS IN REVIEW (2026-09-16). Slice A1 (the `activity.v1` item
contract) merged as #250. Slice A2 (read-time adapters, keyset composition and per-item authorization)
is open for review; **no adapter is wired to a screen, so nothing here is on a user's page yet.** Slices
A3 to A5 are not implemented. This record defines what Universal Activity is, where authority stays, and
the minimum item contract the UI can design against. It needs no Product decision to proceed. One
non-blocking visibility question is in §8.

**Governing rule:** the interface may project and explain truth; it may not create truth for
presentation convenience. Activity does not require identity (UI Constitution 3), and ingestion must not
create a Person to give an event somewhere to live.

---

## 1. Decision: Activity is a contract and a projection, not an authority

Universal Activity is **option D**:
- a shared, versioned item contract in `@emgloop/shared`;
- per-authority adapters that read each source domain under that domain's own authorization, composed
  at read time;
- later, a thin derived **index** of references, added only when a measured subject needs one.

**Rejected: a new canonical activity or event store (option A).** Loop already has eight append logs:
IntegrationEvent, LoopEvent, DomainEvent, MemoryEvent, StateChangeOutbox, AuditLog,
OperationalObservation and WorkStageEvent. A ninth would:
- compete with authorities that already hold sequence and actor;
- need dual writes from paths that are not transactional;
- copy raw PII.

DomainEvent is the cautionary precedent: it was introduced as the fact spine and became a lossy copy
whose `occurredAt` is never supplied.

**Not now: a materialized projection (option B).**
- No general change feed exists. Interaction, AuditLog, Message and Intake writes publish nothing.
- Several sources mutate in place.
- Every "Known Party" state is empty until governed attribution (identity slice 2.5).
- Building B first would index nothing useful and add a migration.

**Authority stays in the source domain, always.** An Activity item is a *reference with an explanation*,
never the fact itself. Content (message bodies, raw identifiers, evidence) is fetched from the source
authority under its own guard.

## 2. What exists today (verified on `main` `543c645`)

| Source | Authority for | Time semantics | Identity subject today | Usable now |
|---|---|---|---|---|
| Interaction | Channel facts: calls, website events, notes | One `occurredAt`: provider time when ingested, else the Loop clock (basis not recorded; website falls back to `new Date()`) | Post-Slice-1 ingestion: none. Unresolved/anonymous keys sit in raw JSON. Notes carry `customerId` | yes, with basis marked UNKNOWN where ambiguous |
| MarketplaceCall + ProviderFactRevision | CallGrid call execution and its fact history | `sourceOccurredAt` / `createdAt`; revisions `observedAt`/`appliedAt` | No subject. Buyer, vendor, source and campaign are provider external ids, **not Parties** | yes |
| IntegrationEvent | Raw provider delivery | `receivedAt`; `occurredAt?` null before about 2026-08-20 | Raw payload only | provenance only (deduplicate against Interaction) |
| AuditLog | Governance acts: admin, identity, CI | `createdAt` only | `entityType`/`entityId` | yes, behind `audit:view` |
| OperationalObservation (+ DecisionEvidence) | Decisions, Cases, Findings, Recommendations, Monitoring, Case participants | `occurredAt` + `recordedAt` + `sequence` + actor (the gold standard) | Business subject | yes |
| WorkStageEvent | Work execution transitions | `occurredAt` + `createdAt` + `sequence` | Work item | the shape is right; barely written in production |
| Conversation / Message | Human messages in existing threads | `sentAt` is insert time | `Conversation.customerId` (Intake) | yes; no production path creates conversations |
| Headline, CommercialSignal | CI attention counters | first/last detected, counters only; no per-detection log | Objective | as state, not as a timeline |
| DomainEvent, Signal (legacy) | Derived duplicates of Interaction; behavioural rules | `occurredAt`/`observedAt` = insert time | legacy `customer` aggregate | **not** an Activity source (derived duplicates, fabricated times) |
| MemoryEvent, LoopEvent | Dormant cognitive memory; raw producer events without `organizationId` | good columns / unscoped | — | no |
| StateChangeOutbox | Delivery of DECISION and WORK_ITEM changes | no `occurredAt`, no actor, mutable status | ids | **not** a timeline: a change trigger only |

**Ten ad-hoc activity shapes exist today:**
- `TimelineEntry`
- `LiveActivityItem`
- `customerActivity`
- `InboxItem`
- `CaseTimelineEntry`
- `EntityHistoryItem`
- home and work `ActivityItem`
- `WorkActivityItem`
- `RevenueTimelineEntry`
- `work-os` `WorkActivityEntry` (dead)

`activity.v1` replaces them progressively. It is not an eleventh.

## 3. Identity subject state

Each item reports one of five states, computed **at read time** and never stored:

| State | Meaning | Basis allowed |
|---|---|---|
| KNOWN_PARTY | Governed attribution to an established PERSON Party | GOVERNED_ATTRIBUTION only (identity slice 2.5) |
| KNOWN_COMPANY | Governed attribution to an established COMPANY Party | GOVERNED_ATTRIBUTION only |
| UNRESOLVED | The fact carries a contact identifier (phone, email) that no governed act has attributed | FACT_IDENTIFIER_PRESENT: key presence, never a value match |
| ANONYMOUS | The fact carries only a first-party continuity key (visitor, session) | CONTINUITY_KEY_PRESENT |
| NOT_APPLICABLE | The item is about the business, an objective, a work item or a decision, not a person | NONE |

**Fail-closed rules:**
1. **An Intake Record link is never KNOWN_*.**
   - Facts attached to a legacy Customer via `customerId` include the 77,339 ingestion-attached calls,
     274 of them matched on the last seven digits and 319 carrying a different number.
   - They carry subject `INTAKE_RECORD` with basis `INTAKE_LINK_CONTEXT`.
   - A `CustomerPartyLink` from that Intake Record to a Party does **not** make those facts the Party's
     activity. A Person or Company experience may show them only as context of a linked Intake Record,
     labeled as legacy attachment.
2. **Grouping by raw identifier values at read time is forbidden.** That would be identity matching
   outside the governed authority. Grouping by identifier waits for hashed evidence (slices 2.1b, 2.3,
   2.4).
3. **Supersession.** A superseded Party subject resolves forward through the Party Reference contract
   and reports `reference: SUPERSEDED` with the canonical id.

## 4. The `activity.v1` item contract

This is the minimum stable shape the UI can design against. Field-level rules follow the listing.

```ts
type ActivityCategory =
  | 'FACT' | 'COMMUNICATION' | 'STATE_CHANGE' | 'WORK'
  | 'SIGNAL' | 'FINDING' | 'RECOMMENDATION' | 'DECISION' | 'AUDIT';

type IdentitySubjectState = 'KNOWN_PARTY' | 'KNOWN_COMPANY' | 'UNRESOLVED' | 'ANONYMOUS' | 'NOT_APPLICABLE';

interface ActivityItemV1 {
  contractVersion: 'activity.v1';
  key: string;                    // deterministic: `${authority.recordType}:${authority.recordId}[:${sequence}]`
  organizationId: string;         // from the source row; never from the caller
  category: ActivityCategory;     // total mapping per source type, asserted by test
  type: string;                   // the source's own closed vocabulary (InteractionKind, observation type, audit action)
  authority: {
    domain: string;               // 'callgrid' | 'website' | 'crm-intake' | 'decision-engine' | 'work-os' | 'audit' | …
    recordType: string;
    recordId: string;
    sequence: number | null;
    href: string | null;          // the source's own page, which enforces its own guard
  };
  time: {
    occurredAt: string | null;    // null = unknown; never defaulted
    occurredAtBasis: 'PROVIDER_REPORTED' | 'LOOP_CLOCK' | 'OPERATOR_STATED' | 'REPORTING_WINDOW' | 'UNKNOWN';
    recordedAt: string;           // Loop clock (Loop Time Authority)
    window: { start: string; end: string } | null;
  };
  actor: {
    kind: 'HUMAN' | 'AI_EMPLOYEE' | 'SYSTEM' | 'PROVIDER' | 'MODEL' | 'UNKNOWN';
    userId: string | null;
    producer: string | null;      // rule/engine/model identity, e.g. 'callgrid-intelligence'
    producerVersion: string | null;
  };
  subjects: ActivitySubjectRef[];     // what the item is about (0..n)
  participants: ActivitySubjectRef[]; // who took part, when the source records it
  identity: {
    state: IdentitySubjectState;
    basis: 'GOVERNED_ATTRIBUTION' | 'INTAKE_LINK_CONTEXT' | 'FACT_IDENTIFIER_PRESENT' | 'CONTINUITY_KEY_PRESENT' | 'NONE';
  };
  provenance: {
    source: string;
    transport: 'WEBHOOK' | 'API_POLL' | 'API_RECOVERY' | 'LOCAL_REPROCESS' | 'HUMAN_ENTRY' | null;
    epistemic: 'RECORDED' | 'HUMAN_REPORTED' | 'DERIVED' | 'INTERPRETED';
    ruleId: string | null;
    ruleVersion: string | null;
    evidenceCount: number | null;
    limitations: string[];        // e.g. 'caller ID is network-asserted and spoofable'
  };
  display: {
    title: string;                // human-readable; never contains raw contact values
    channel: string | null;
    direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL' | null;
    stateChange: { from: string | null; to: string | null } | null;
    semanticStatus: string | null; // e.g. Finding DEVELOPING/ESTABLISHED; never a numeric confidence
  };
  access: {
    requires: Array<{ resource: string; action: 'view' }>; // every one must hold, re-checked server-side per item
    workspace: string | null;
  };
  sensitivity: {
    class: 'OPERATIONAL' | 'CONTACT_IDENTIFIER' | 'COMMUNICATION_CONTENT' | 'WORKFORCE_PII';
    rawValuesInSource: boolean;
    contentInline: false;         // content is always fetched from the authority
  };
}

type ActivitySubjectRef =
  | { kind: 'PARTY'; partyId: string; partyType: 'PERSON' | 'COMPANY';
      reference: 'ESTABLISHED' | 'SUPERSEDED'; canonicalPartyId: string }
  | { kind: 'INTAKE_RECORD'; customerId: string }
  | { kind: 'UNRESOLVED_IDENTIFIER'; identifierKind: 'PHONE' | 'EMAIL'; assertionMode: string | null;
      evidenceRef: string | null }   // never the value; evidenceRef only after slice 2.3
  | { kind: 'ANONYMOUS_CONTINUITY'; continuity: 'VISITOR' | 'SESSION'; property: string | null;
      evidenceRef: string | null }
  | { kind: 'CONVERSATION' | 'WORK_ITEM' | 'CASE' | 'HEADLINE' | 'OBJECTIVE' | 'USER'; id: string }
  | { kind: 'PROVIDER_COUNTERPARTY'; role: 'BUYER' | 'VENDOR' | 'SOURCE' | 'CAMPAIGN' | 'DESTINATION';
      provider: string; externalId: string }  // a provider dimension, not a Party
  | { kind: 'RELATIONSHIP' | 'OPPORTUNITY' | 'CAMPAIGN'; id: string };
      // RESERVED: no authority exists; a contract test fails if any adapter emits one before it does
```

**Rules the contract enforces (tests in slice A1):**
1. **Category mapping is total per source type.** A new source type does not compile until it is
   mapped.
2. **No numeric confidence anywhere.** Semantic status is a label from the owning authority. A Finding
   shows DEVELOPING or ESTABLISHED plus an evidence count (CI contract).
3. **No raw contact values or message bodies.** Neither `display.title` nor any field carries them, and
   a fence test scans adapters.
4. **Organization and access come from the source.** `organizationId` and `access` come from the source
   row and the source authority. Every item is re-authorized server-side. Hiding an item is not
   authorization.
5. **Unknown time is `null` with basis UNKNOWN.** It is never replaced by insert time (Engineering
   Principles Rule 7).
6. **Reserved subject kinds (RELATIONSHIP, OPPORTUNITY, CAMPAIGN) cannot be emitted** until their
   authorities exist.
7. **Intelligence stays separate from fact.**
   - Model or rule interpretation is `epistemic: 'INTERPRETED'` (category SIGNAL, FINDING or
     RECOMMENDATION) and is never category FACT.
   - Nothing interpretive is embedded in a factual item.

**Reading contract** (for the UI):
- **A subject timeline** takes `subject ref, filter (All | Communications | Work | Intelligence | Changes),
  cursor`.
- **An org-wide feed** takes `filter, cursor`.
- **Paging** is keyset over `(occurredAt ?? recordedAt, key)`. Items with unknown `occurredAt` sort by
  `recordedAt` and say so.
- **Progressive detail:** collapsed shows `display`. Expanded shows provenance, actor, authority, time
  basis and limitations. Content and evidence open the authority's own page or read.

## 5. What each subject can show, and when

| Subject | Sources | Available |
|---|---|---|
| Case / Decision | OperationalObservation, DecisionEvidence | **now** (adapter A2) |
| Work item | WorkStageEvent, work stage columns (marked derived) | **now**, per work item, since the Work IAM slice gave Work a real resource. Requires `work:view` and the ADMIN workspace — exactly the admin work tree. The gap noted in §6 stands: transitions are barely logged, and the lane says so |
| Intake Record | Interactions and conversations by `customerId`, AuditLog `customer`, notes; basis INTAKE_LINK_CONTEXT | **now**. Intake status changes have **no history** until slice A3 adds it |
| Organization operational feed | Interaction + MarketplaceCall (deduplicated against IntegrationEvent), classified UNRESOLVED / ANONYMOUS / NOT_APPLICABLE | **now** |
| Unresolved identifier / anonymous journey | Per fact, by key presence | per fact **now**; grouping across facts waits for identity slices 2.1b, 2.3, 2.4 |
| Person / Company | Governed attributions; linked Intake Records as labeled context | **after identity slice 2.5**; before that, only the linked-Intake context lane and Party acts (establishment, links) |
| Relationship / Opportunity / Campaign | Their event logs and composed references | after their authorities exist |
| Headline / Objective | Headline counters, detection audit, investigation authorization | as state now; per-detection history not recorded |

## 6. Required source fixes (slice A3; each its own small change)

- DomainEvent and Signal fabricate `occurredAt`/`observedAt`. Mark them derived and exclude them as
  sources. Stop presenting insert time as occurrence.
- The website adapter falls back to `new Date()` for provider time. Record the basis instead.
- Intake status and field edits are neither audited nor logged. Add an append-only Intake history.
- Work completion, handoff and assignment do not write WorkStageEvent consistently.
- Decision and work outbox payloads carry no `occurredAt` or actor. That is acceptable for triggers,
  but adapters must read time and actor from the logs, never the outbox.
- The live feed shows each call twice (IntegrationEvent + Interaction). Deduplicate in the adapter.
- Loop Home and Work "recent activity" read AuditLog without `audit:view`. Adapters must require it.
- The `AuditLog (entityType, entityId)` index is not organization-prefixed; add one before per-subject
  audit reads scale.

## 7. Slices

| Slice | Contents | Migration |
|---|---|---|
| **A1** | `activity.v1` contract, category mapping, subject refs, fences (no confidence, no raw values, reserved kinds, total mapping) — **merged, #250** | no |
| **A2** | Adapters for subjects with authority today: Case/Decision, Intake Record, organization operational feed; keyset composition; per-item authorization — **merged, #252**. The Work item adapter followed in the Work IAM slice, once Work had a resource an item could state | no |
| **A3** | The source fixes in §6 | the Intake history table needs one |
| **A4** | Person/Company activity from governed attributions | after identity 2.5 |
| **A5** | Derived reference index, only if a measured subject needs it | yes |

As each adapter lands, the ad-hoc shapes it replaces are retired in the same slice (the replacement
rule).

## 8. Non-blocking Product question

**Visibility of raw contact identifiers and communication content.** Today, raw caller numbers and
message bodies reach every role that holds `customers:view` or `intelligence:view`, READ_ONLY included
(`/crm/live/calls`, `/crm/inbox`).

`activity.v1` never carries them inline, and detail stays under each source's existing guard. So the
contract neither narrows nor broadens anything.

**Recommendation:** a separate security slice restricts raw contact identifiers and message content to
EMPLOYEE and above, applied at the source reads, once Product approves. This does not block the UI: the
UI designs detail views that request content from the authority and handle "not permitted".

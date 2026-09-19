# Intelligence & Memory Foundation — architecture record (as built)

**Status:** built on branch `feat/intelligence-foundation` (2026-09-19). D1 (persisted identity suggestions) and D2
(calendar attendee keys) were approved on 2026-09-19 and are built (§8). Nothing here is enabled in production until
the migration is applied and the commissioning steps in §9 run. This record describes what exists.

The loop this foundation serves:

**observe → remember → connect → notice → surface → human decision / outcome → use it next time.**

It adds **no new truth table**. Loop already had the authorities; what it lacked was a trigger that is not a page
view, a reader for the outcomes people record, one surfaced shape, and a real event for the first cross-authority
review. D1 and D2 add **one additive migration** (`20260924000000_identity_suggestions_and_attendee_keys`): columns on
the existing belief authority (`intelligence_hypotheses`) and on `work_events`, with no new table.

## 1. The memory contract: which authority owns each kind of truth

| Kind of truth | Authority (table) | Scope | Live? | What this milestone changed |
|---|---|---|---|---|
| **Source evidence**: what Gmail, Calendar or CallGrid said | `work_threads`, `work_messages`, `work_correspondents`, `work_events` (DL-1); `marketplace_calls`, `integration_events`, bid snapshots; CRM `interactions` | Private: org + user. CallGrid and CRM: org | yes | `work_events.attendeeHashes` (D2): one-way attendee keys. Evidence is never rewritten by an interpretation (§6) |
| **Derived interpretation**: what Loop concluded | `work_items` + `work_item_observations` (private); Cases: `operational_priorities` + `operational_observations` + `decision_evidence`; Findings: `intelligence_hypotheses` via `CaseFindingService` | Private / org | yes | Cases and work items are now also produced without a page view (§3) |
| **Entity / relationship memory** | Party (`cognitive_identities`, human-established); CRM Relationship + Participant (`crm_relationships`, `crm_participants`, human-asserted) | org | yes | read by the creator review (§5), and by a person's own intelligence once they confirm a match (§4) |
| **Identity suggestions**: "this correspondent may be that Party" (D1) | `intelligence_hypotheses` rows of type `IDENTITY_MATCH`, created PROPOSED, decided only by a person | Private to the person whose mail it came from | yes (no page renders it yet) | new: proposed after a Gmail read, confirmed or rejected by `IdentitySuggestionService`, and remembered (§4) |
| **Commitment / state memory** | Private: work-item classes (NEEDS_YOU, WAITING_ON_THEM, GONE_QUIET) and the person's corrections (`work_feedback`, e.g. "I'm waiting on them"). Org: Case lanes, owner, assignee | Private / org | yes | nothing new. Commitments extracted from message *content* ("follow-up promised Tuesday") need bodies, which are never stored, and a model, which is off. Not built. |
| **Human correction / judgment** | Private: item state and `work_feedback`. Org: Case outcomes (including the standing SUPPRESSED / ACCEPTED_RISK), Finding accept/reject, Recommendation select/dismiss/revise | Private / org | yes | standing judgments now hold against later sightings (from #301, §6) |
| **Outcome memory**: what eventually happened | Case `outcome` and every closing observation (`operational_observations.outcome`, reason, actor, time); work-item closures | org / private | **written, never read** before this milestone | **now read**: `caseIntelligence`, `personalIntelligence` and the creator review retrieve them (§6) |
| **Procedural / learned** | none (no table) | — | — | `learnFromHistory` (@emgloop/shared): a pure, stated rule that turns retrieved outcomes into the next posture. No weights and no training. |

**Dormant, and deliberately not revived:** the cognitive layer's `MemoryEvent`, `KnowledgeAssertion`, `ActiveState*`,
`IdentityRelationship`/`IdentityRole` and `LoopEventConsumer` have no production writer. They are superseded in part by
the identity and relationship records (`loop-cognitive-architecture.md`, banner). Building on them would have been a
second model of the same truths.

## 2. The surfacing contract

`IntelligenceItem` (@emgloop/shared) is the one shape every surface reads. It carries:
- what changed, and why it matters;
- evidence: references still owned by their authority (GMAIL, CALENDAR, CALLGRID, CRM, IDENTITY, CREATOR_HUB, LOOP).
  CREATOR_HUB has no producer yet (§5);
- related people, companies and objects, each marked verified or not;
- what Loop remembers;
- what happened previously, both this situation (SAME) and comparable ones (COMPARABLE);
- a suggested posture (ACT / REVIEW / WATCH / NONE) with its basis;
- confidence and uncertainty;
- source freshness;
- the human state (NEW, REVIEWED, WATCHING, ASSIGNED, WAITING, SNOOZED, HANDLED, ACCEPTED, DISMISSED, SUPPRESSED).

Builders (`services/intelligence/intelligence-items.ts`) project it from the two live authorities, and no copy is stored:

- **`personalIntelligence(prisma, principal, now)`**: one person's open work items. It is built only inside that
  person's request, and scope is `PRIVATE`.
- **`caseIntelligence(engine, organizationId, caseId)`**: one Case. Scope is `ORGANIZATION`, and a Case never holds
  private evidence.

A producer may record references to records other authorities own in its Case's opening picture
(`evidenceSnapshot.intelligence.{refs,related,remembers}`). The builder carries them through as written. This is how
a CRM Relationship is cited without being copied.

## 3. What wakes intelligence up (no longer page views)

| Source | Ingestion | Event | Detector | Memory read | Intelligence | Runs |
|---|---|---|---|---|---|---|
| Gmail | scheduled employee cycle (`cycle-employee-gmail.yml`, hourly at :17) | read completed for one person | `SourceReadDispatcher` → `mail-attention`, then `identity-suggestions` (D1) | the person's own corrections and closures; their earlier suggestion decisions | work items and PROPOSED identity suggestions (both private) | **scheduled, event-driven per read**. Page visits still refresh the queue, but only as a bounded freshness pass |
| Calendar | scheduled employee cycle (`cycle-employee-calendars.yml`) and Home visits | read completed | dispatcher (no calendar detector yet) | — | composed at read time into the person's items (§4) | scheduled; composition on read |
| CallGrid | webhooks → `marketplace_calls` | calls received recently | the page's own pipeline, run by `POST /api/internal/intelligence/callgrid` (`detect-callgrid-intelligence.yml`, hourly at :37, **off** until `INTELLIGENCE_DETECT_ENABLED=true`) | a Case's own log, comparable Cases | Cases (org) | **scheduled**. Page renders still record the viewed window |
| CRM Relationship | a person creates or changes one | the outbox (`RELATIONSHIP` domain) | publisher → `creator-onboarding-review` | CLIENT Relationships, their contacts, earlier creator reviews and outcomes | one Case per creator | **event-driven** (outbox drain every 5 min, once its secrets are set) |
| Creator Hub (future) | — | `CreatorOnboarded` (domain `CREATOR`, subject the creator's Party) | the same subscriber | same | same | event-driven |

**Bounded, idempotent, scoped, observable.**
- A dispatch covers one principal or one organization, a fixed detector list and capped reads.
- Writes are keyed: work items by recurrence key, Cases by recurrence plus detection key, deliveries once per
  (event, subscription). A repeat changes nothing twice.
- A private detector refuses an event without its person.
- Results and logs are ids and counts only.

**Think, never act.** Detectors, the CallGrid pass and subscribers write only internal intelligence: work items, Cases
and their logs, and PROPOSED identity suggestions. They send nothing, draft nothing, confirm nothing, and change no bid,
campaign, Relationship, Participant or identity. Tests check this both by behavior and by source (§7).

## 4. Connecting safely

- **Inside one person's private graph: mail and calendar (built, D2).** A conversation and an upcoming meeting are
  joined when someone on the conversation **organized the meeting or is invited to it**, on the **same one-way
  address key**. Gmail's correspondent key, Calendar's organizer key and each attendee key are one function
  (`googleAddressHash`, `calendar.ts`). The join is exact, never a name, and never a claim about who anyone is. It is
  composed at read time in that person's request and never stored mixed (daily-loop §31.4). The item says, for
  example, "You're waiting on Dana, and Dana is in tomorrow's meeting". "Tomorrow" is the person's own day (their
  stored zone). The correspondent is named by the name they gave, or not at all. **An address never appears in an
  item.**
- **Attendee keys (D2).** `work_events.attendeeHashes` holds one key per invited person other than the connected one.
  Rooms are excluded. There are at most 50, and none when Google did not send the list. A database CHECK refuses
  anything that is not a 64-character hex key, so an address cannot be stored there by mistake. The keys are the
  person's own data: they are deleted with the event, and every event is deleted when the membership ends. **An
  attendee key is never matched to a Party** (meeting-intelligence §2). Only a correspondent is.
- **A correspondent and a Party (built, D1).** After a Gmail read, `identity-suggestions` checks each correspondent
  against the EMAIL identifiers the organization recorded on its established Parties (`identity_evidence`). The check
  compares the organization-salted keyed hash evidence is stored under. It is an exact identifier match; names and
  domains are never compared.
  - Exactly one established, referenceable Party → one **PROPOSED** suggestion. It is private to that person. It
    stores references to the correspondent (by key) and to the identifier records (by id), the method, the reason, the
    source and the time. It never stores the address.
  - Two Parties → CONFLICTING: nothing is proposed.
  - A superseded, archived or unestablished record → nothing.
  - The same evidence that already produced a suggestion → nothing, **including after a rejection** (a unique
    `(organization, match key, evidence fingerprint)` enforces it). New identifier records are new evidence. They
    produce a new PROPOSED row that names the rejection it reconsiders, and the rejected row stays as it was.

  **A person decides** through `IdentitySuggestionService`. Confirm and reject require `identityResolution:update`, the
  identity record's "confirm / reject an attribution" (§6), plus `employeeIntelligence:view`. Only the owner may decide.
  A reason is required to reject. The audit trail records the act without the Party, the key or the reason.
  - AI_EMPLOYEE is hard-denied, and a system actor has no membership, so **no machine principal can confirm**.
  - The generic hypothesis reads, accept, reject and Case linking do not see private suggestions.
  - Database CHECKs refuse a decided suggestion with no person, or a rejection with no reason.

  **Unconfirmed**, a match appears in the person's item as an **unverified** Party, with "not confirmed — confirm or
  reject" in its uncertainty. Nothing is composed from it. **Confirmed**, the Party is verified in that person's
  intelligence. The authorized CRM read then composes the Relationships it takes part in, for example "You confirmed
  Dana is Dana Diaz: primary contact on the client relationship with Acme Co (active)".

  A confirmation writes no IdentityEvidence, resolution link, CustomerPartyLink, Party or Relationship, and never
  reaches organization scope. Promotion to organization scope needs an explicit governed authority, and none exists.
  - An EMPLOYEE cannot confirm an attribution, so nothing is proposed to one.
  - No page renders suggestions yet. The service is the complete backend contract a surface calls.
- **In production, nothing yet, correctly.** Suggestions need two things.
  - **EMAIL identifiers recorded on established Parties.** Production has none. The 2026-09-19 footprint showed 0
    identities and 0 identity evidence. Nothing writes identity evidence in production: `CognitiveEventProcessor` has no
    caller, and identity slices 2.1b/2.3 are not built. The detector ran after the first Gmail cycle on #305 and
    reported `checked=0` for both people, which is the right answer with no identifiers.
  - **One identifier key, the same wherever identifiers are written or compared** (§4a).
- **§4a. Which key hashes what.** Two different hashes are involved, and only one of them needs a secret.

  | Hash | Used for | Secret |
  |---|---|---|
  | `googleAddressHash`: plain SHA-256 of the normalized address | Gmail correspondent keys; Calendar organizer and attendee keys (D2); the private mail-calendar join | **none** |
  | `hashIdentifier`: HMAC-SHA-256 keyed by `COGNITIVE_HASH_SECRET`, organization-salted | `identity_evidence.normalizedValueHash` (writer: `IdentityEvidenceRepository`); the D1 detector's comparison | **required** |

  - **Runtimes that need the secret:**
    - the Gmail cycle (GitHub Actions), where the D1 detector compares; `cycle-employee-gmail.yml` passes
      `secrets.COGNITIVE_HASH_SECRET` to the Cycle step;
    - whatever runtime writes identity evidence. None does in production today. The app has no live caller, so
      Netlify does not use the secret today.
  - **When it is absent:**
    - the detector refuses to compare and logs `keyUnavailable=1` (only once identifiers exist);
    - it never falls back to the development key;
    - in a production process, `hashIdentifier` throws, so a future writer fails closed;
    - mail detection and D2 are unaffected.
  - **When it differs between two runtimes:** every identity evidence row records a one-way fingerprint of the key that
    hashed it (`metadata.keyFingerprint`). The detector counts rows it can never match as `keyMismatch`, instead of
    reporting a silent `matched=0`.
  - **When it changes after identifiers exist:**
    - every earlier `normalizedValueHash` becomes unmatchable, and the raw values are not stored, so they cannot be
      re-hashed; identifiers would have to be recorded again;
    - re-recorded identifiers get new ids, so earlier rejected suggestions would come back as RECONSIDERED.
  - **What a key change never affects:** D2, the mail-calendar join and stored work state. They use the plain hash.
  - **While production holds 0 identifiers,** choosing the value costs nothing. After that it must not change.
- **CallGrid with a Party: still not linked.** A CallGrid buyer id is not a contact identifier, and no authority records
  which Party a buyer is. That needs a human-established link (a CRM Relationship naming the buyer), which does not
  exist yet. D1 does not provide it and does not pretend to.

## 5. The creator foundation

The trigger is real. A `TALENT_REPRESENTATION` Relationship becoming ACTIVE means "EMG now represents this person",
and the CRM authority already publishes it. The subscriber also accepts Creator Hub's future `CreatorOnboarded` event.
**Creator Hub will be the authority that emits it**; nothing here decides who is a creator.

On that event, with no prompt, the review:
1. reads the organization's CLIENT Relationships (ACTIVE first, then ENDED), their active engagement-role
   participants, and earlier creator reviews with their recorded outcomes;
2. records **one** Case per creator: "*Creator*: N brand relationships worth reviewing". Each line names the brand,
   the relationship's standing, the known contact, and what happened the last time Loop suggested that brand. It
   claims no fit and compares no categories.

With no brand relationship to review, it records nothing.

**Relevance comes later, from its owner, without a redesign.** Creator context (category, audience) belongs to Creator
Hub, and nothing owns it today. The review takes an optional `CreatorRelevanceSource`. When one is wired, the review
cites its statement per brand ("Creator Hub: …") next to the relationship memory and prior outcomes. Its CREATOR_HUB
references become Case evidence, and references from any other authority are dropped. With none wired, which is
today, no fit is claimed. The full path, once Creator Hub exists:

onboarded → Creator Hub's creator context → this relationship memory → its relevance evidence → prior brand, contact
and outcome history → surfaced.

The trigger (`CreatorOnboarded`), the subscriber, the Case and `IntelligenceItem` do not change for it.

## 6. Corrections and outcomes compound

- **Mail.** A closed item reopens only on a message newer than the closure. The unchanged evidence leaves no trace, and
  the person's reason is kept (`MailAttentionService`).
- **Cases.** SUPPRESSED and ACCEPTED_RISK hold against later sightings unless severity rises. Each held sighting is
  recorded with its reason (`resightingDisposition`, from #301). Other outcomes reopen on a new occurrence, and the
  prior outcome is then **retrieved**.
- **Learning.** `learnFromHistory` applies a fixed precedence:
  - this situation was last a false alarm → REVIEW before acting;
  - it last needed action → ACT;
  - it went away on its own → WATCH;
  - no history of its own, but at least two consistent self-resolutions of the same rule elsewhere → WATCH;
  - otherwise the producer's own suggestion stands.

  Every change states its basis. Nothing is rewritten: evidence, Loop's original interpretation, the correction, later
  evidence and the new interpretation all remain in their append-only logs.

## 7. Privacy, authority and isolation

- Private work state is read only with a principal (organization and user). An OWNER is no exception. Proven in both
  directions for two OWNERs.
- Organization intelligence never reads employee-private evidence. The existing policy governs any crossing:
  - no silent organization-level aggregation (daily-loop §20.2a);
  - mixing only at read time, in one principal's request (§31.4);
  - the only bridges are the employee's explicit **promotion** of an item (D1 of the Daily Loop record) and the
    unbuilt Relationship Capture (§32, gated on identity slices 2.1b and 2.5).
- Cross-organization reads: a Case in another organization is not found, and an event in one organization triggers
  nothing in another.
- Machine principals: detectors and subscribers act as the SYSTEM producer. They hold no send authority (GM-2's
  structural denial), create no Relationship or Participant (CRM invariant 9), and establish no identity (identity
  §5–6).
- Untrusted content: detectors read stored headers and counts. No model is called, so there is no prompt to inject
  into. Draft with Loop's existing template rules are unchanged.
- Identity suggestions from private mail (D1) are private rows: only the owner reads or decides them, and an OWNER
  colleague gets NOT_FOUND. They are never listed, accepted or linked through the organization's hypothesis paths.
- Offboarding: removing or disabling a member deletes their private work state (from #301). That now includes their
  attendee keys, which go with their events, and every identity suggestion from their mail, whether proposed,
  confirmed or rejected. The audit row records counts only.

## 8. Decisions

| # | Decision | Status |
|---|---|---|
| **D1** | Identity §5: persisted machine suggestions | **Approved 2026-09-19, built** (§4). Suggestions are `intelligence_hypotheses` rows, always PROPOSED. They match exact identifiers only, and are private to the evidence's owner. Decisions go through `identityResolution:update`. A rejection is remembered per evidence fingerprint. |
| **D2** | DL-2: Calendar attendee keys | **Approved 2026-09-19, built** (§4). One-way keys only, the same function as correspondents. They are private, capped and erased with the person's events. They are never matched to a Party. |
| **D3** | Commissioning (production configuration) | Not done. §9 |

## 9. Commissioning (each is a human act)

Steps 0 and 2–4 are done (§10). Step 1 is outstanding and is not needed until identity evidence exists.

0. **Before merging:** apply the migration. Dispatch **Deploy Prisma Migrations** on this branch, then confirm
   `migrate status` shows `20260924000000_identity_suggestions_and_attendee_keys` applied.
   - The order matters. Once merged, Netlify deploys code that writes `work_events.attendeeHashes` and filters
     `intelligence_hypotheses` on the new columns. Against an unmigrated database, Calendar sync and every Finding
     read would fail.
   - The migration is additive. Rows written by the code already on `main` satisfy every new constraint (checked
     against a migrated database), so applying it first is safe.
1. Before any identity evidence is written: one `COGNITIVE_HASH_SECRET`, identical in the repository secrets (the Gmail
   cycle) and in any runtime that will write identity evidence (Netlify, if the writer lands in the app). If one
   already exists, copy it; never create a second. Never change it once identifiers exist (§4a).
2. Set `OUTBOX_DRAIN_URL` and `OUTBOX_DRAIN_SECRET`: the repository secrets, plus the Netlify variable of that name.
   `drain-outbox.yml` has failed every run since it shipped without them.
3. Dispatch **Declare Intelligence Subscriptions** for `servicesinmycity-demo`: first a dry run, then `apply: true`.
4. For scheduled CallGrid detection:
   - set the Netlify variable `INTELLIGENCE_DETECT_SECRET`;
   - set the repository secrets `INTELLIGENCE_DETECT_URL` and `INTELLIGENCE_DETECT_SECRET`;
   - set the repository variable `INTELLIGENCE_DETECT_ENABLED=true`.

Merging also changes one scheduled behavior with no switch: the already-enabled Gmail cycle now runs two detectors
after each person's read.
- The mail detector is the same computation a Home or Mail visit already runs, now without the visit.
- The identity-suggestion detector writes only PROPOSED, private rows, and stops at once while the organization has no
  EMAIL identifier on any Party.

The Calendar cycle starts storing attendee keys on its next read. Events already stored gain keys when Google next
reports them changed, or on a re-baseline.

## 10. Commissioned (2026-09-19)

What production has shown, from workflow logs and Read Intelligence State (#306). "Manual" means a human dispatched
the scheduled workflow. The code path is the one the schedule runs.

| Path | Schedule | Commissioned | Production proof | First naturally scheduled run on #305+ |
|---|---|---|---|---|
| Gmail cycle and its detectors | hourly at :17 (fires every ~2.5–5 h) | yes | manual 18:02: mail queue raised 2 and 15 new items with no page visit; identity suggestions `checked=0` | **not yet observed** |
| Calendar cycle (attendee keys) | hourly at :00 (same lag) | yes | manual re-baseline 19:11 (2 synced, 2 re-baselined); 19 events / 68 keys and 18 / 65 | **yes**, 19:12 (incremental, 2 synced) |
| CallGrid detection | hourly at :37 when `INTELLIGENCE_DETECT_ENABLED=true` | yes | manual 18:25: 5 situations, 1 new and 4 seen again, all SYSTEM, no page open, 0 duplicates of 61 | **not yet observed** |
| Outbox drain | every 5 min (fires every ~2.5–5 h) | yes | manual 18:17 and 19:07: 117 of 117 published, 0 dead-lettered | **not yet observed** (scheduled runs before the secrets existed failed, as designed) |
| Intelligence subscriptions | — | yes | both ACTIVE; the second dry run added nothing | — |

- **No qualifying data, correctly nothing:**
  - no relationship event exists, so the creator review has 0 deliveries and 0 Cases;
  - no Party or identifier exists, so D1 has 0 suggestions;
  - none of the 5 Cases has a recorded outcome, so production has not yet retrieved a real prior outcome.

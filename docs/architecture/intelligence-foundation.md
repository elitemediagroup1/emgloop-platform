# Intelligence & Memory Foundation — architecture record (as built)

**Status:** built on branch `feat/intelligence-foundation` (2026-09-19). Nothing here is enabled in production until the
commissioning steps in §9 run. This record describes what exists; §8 lists what is gated and on which decision.

The loop this foundation serves:

**observe → remember → connect → notice → surface → human decision / outcome → use it next time.**

It adds **no new truth table and no migration**. Loop already had the authorities; what it lacked was a trigger that
is not a page view, a reader for the outcomes people record, one surfaced shape, and a real event for the first
cross-authority review.

## 1. The memory contract: which authority owns each kind of truth

| Kind of truth | Authority (table) | Scope | Live? | What this milestone changed |
|---|---|---|---|---|
| **Source evidence**: what Gmail, Calendar or CallGrid said | `work_threads`, `work_messages`, `work_correspondents`, `work_events` (DL-1); `marketplace_calls`, `integration_events`, bid snapshots; CRM `interactions` | Private: org + user. CallGrid and CRM: org | yes | nothing; never rewritten by an interpretation (§6) |
| **Derived interpretation**: what Loop concluded | `work_items` + `work_item_observations` (private); Cases: `operational_priorities` + `operational_observations` + `decision_evidence`; Findings: `intelligence_hypotheses` via `CaseFindingService` | Private / org | yes | Cases and work items are now also produced without a page view (§3) |
| **Entity / relationship memory** | Party (`cognitive_identities`, human-established); CRM Relationship + Participant (`crm_relationships`, `crm_participants`, human-asserted) | org | yes | read by the creator review (§5) |
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
- evidence: references still owned by their authority (GMAIL, CALENDAR, CALLGRID, CRM, LOOP);
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
| Gmail | scheduled employee cycle (`cycle-employee-gmail.yml`, hourly at :17) | read completed for one person | `SourceReadDispatcher` → `mail-attention` | the person's own corrections and closures | work items (private) | **scheduled, event-driven per read**. Page visits still refresh, but only as a bounded freshness pass |
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
and their logs. They send nothing, draft nothing, and change no bid, campaign, Relationship, Participant or identity.
Tests check this both by behavior and by source (§7).

## 4. Connecting safely

- **Inside one person's private graph (built).** A conversation that needs the person, and an upcoming meeting
  organized by someone on it, are joined on the **same correspondent key**. Gmail's address hash and Calendar's
  organizer hash are one function by design (DL-2, `calendar.ts`). It is exact, never a name, never a claim about who
  anyone is, and it is composed at read time in that person's request and never stored mixed (daily-loop §31.4).
- **CallGrid with CRM, CallGrid with Gmail, a correspondent with a Party: gated (§8, D1).** Nothing links a CallGrid
  buyer id to a Party. Parties hold no contact values (PD-F-05). Identity §5 allows machine matches only as read-time,
  non-persistent suggestions. So "buyer X asked us to slow volume, and CallGrid shows volume down" cannot be composed
  without either a persisted, clearly-unverified suggestion (D1) or a human-established link that current authorities
  cannot yet hold.
- **Calendar attendees: gated (§8, D2).** Only the organizer is stored, hashed. Attendee participation needs attendee
  hashes, which is an amendment to DL-2's data minimisation.

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
- Offboarding: removing or disabling a member deletes their private work state (from #301).

## 8. Gated: the decisions this needs

| # | Decision | Why it is needed | Smallest amendment proposed |
|---|---|---|---|
| **D1** | **Identity §5: persisted machine suggestions** | Connecting a Gmail correspondent, a CallGrid buyer and a Party needs a match that survives the request. §5 allows only read-time, non-persistent machine matches. | Allow a machine to persist a match **only as a suggestion**: an `intelligence_hypotheses` row, always PROPOSED, recording evidence, method (exact identifier only, never name similarity), confidence or reason, source and time. Only the existing human paths (identity propose/confirm, CRM Relationship create) may verify. A suggestion built from private evidence is visible only to that person. |
| **D2** | **DL-2: attendee identity for Calendar** | Meeting-level reasoning ("who is in tomorrow's meeting") needs attendees. Today only the organizer is stored, hashed. | Store attendee address **hashes** only (the same one-way key Gmail stores for correspondents), never addresses or names, for the person's own graph. |
| **D3** | Commissioning (production configuration) | The event-driven and scheduled paths above run only when switched on. | §9 |

## 9. Commissioning (after merge, each is a human act)

1. Set `OUTBOX_DRAIN_URL` and `OUTBOX_DRAIN_SECRET`: the repository secrets, plus the Netlify variable of that name.
   `drain-outbox.yml` has failed every run since it shipped without them.
2. Dispatch **Declare Intelligence Subscriptions** for `servicesinmycity-demo`: first a dry run, then `apply: true`.
3. For scheduled CallGrid detection:
   - set the Netlify variable `INTELLIGENCE_DETECT_SECRET`;
   - set the repository secrets `INTELLIGENCE_DETECT_URL` and `INTELLIGENCE_DETECT_SECRET`;
   - set the repository variable `INTELLIGENCE_DETECT_ENABLED=true`.

Merging also changes one scheduled behavior with no switch: the already-enabled Gmail cycle now runs the mail
detector after each person's read. That is the same computation a Home or Mail visit already runs, now without the
visit.

# Loop Intelligence: as built

**Audience:** an engineer designing against Loop Intelligence, or changing it.

**Status (2026-09-26):** Phases A–G are built on `feat/loop-intelligence-fabric` and sit in one draft PR.
None of it is commissioned; the runbook is [`loop-intelligence-commissioning.md`](../runbooks/loop-intelligence-commissioning.md).
The AI runtime underneath it is [`loop-ai-runtime.md`](loop-ai-runtime.md), which merged as #340.

This document describes what exists. Where something is deliberately not built, it says so.

## 1. The shape

Intelligence flows upward only. Each layer has its own authority and stores its result in exactly one
place.

```
Loop's own records (repositories)     Gmail read-through (transient, person's own)
          |                                      |
   domain producers  -- rule reading always; model reading when its task is activated
          |
   intelligence_digests  (PRINCIPAL: one person's; ORGANIZATION: the organization's)
          |
   deterministic clustering (shared entity / explicit link, 14-day window, 2+ domains)
          |
   situation.synthesis -> situation.verify (OTHER_THAN_SUBJECT)
          |
   Cases (operational_priorities; PRIVATE ones have a case_private_scopes owner)
          |
   Loop Briefing (per person) -> work_briefs
          |
   surfaces: each domain page, Home tiles, Situations panel, Headlines, Case page, "Your briefing"
```

A model never reads a database or an API. Every model is handed a minimized context package that Loop
assembled from its own artifacts. Every answer is judged by a registered output contract before Loop
keeps any of it.

## 2. The fabric (Phase A)

**The participation contract** (`@emgloop/shared` `intelligence-contract.ts`):

- **Signals** carry a kind, knowledge (OBSERVED / MEASURED / INFERRED), canonical entity references, and
  evidence references.
- **MEASURED** requires a metric, and only a RULE or RULE_AND_MODEL producer may write it. The model output
  contracts refuse MEASURED.
- **Entity references** follow the `entity-ref.ts` grammar. The private kinds (`work_thread`, `work_event`,
  `telegram_conversation`, `correspondent`) are refused in any ORGANIZATION artifact.

**Registries** (`intelligence-registry.ts`):

- One entry per domain: its scopes, surfaces, Home decision, read authority, and **reading task**.
- One entry per source: scope, basis, cadence.
- The Chats, Mail and Calendar domains are PRINCIPAL-only, forever.

**Storage:**

- **ORGANIZATION digests.** `userId` is null, and `consentBasis` is LOOP_RECORDS; a DB CHECK refuses Chats,
  Mail and Calendar here.
- **`entity_links`.** Explicit links only; the basis is never MODEL.
- **`intelligence_refresh_queue`.** Coalescing, compare-and-set claims, lease recovery, HELD.

**The producer loop** (`producer-loop.ts`): claim → gather → fingerprint → **skip if unchanged, before any
read** → read → repository write.

`runIntelligencePass` (`intelligence-pass.ts`) puts discovery and enqueueing in front of the loop, so every
host behaves the same way.

## 3. Domains (Phases B, D, E)

Every domain is built with the **domain kit** (`domain-kit.ts`):

- `gather` produces a deterministic context and a fingerprint from repositories only.
- `rule` produces the floor reading: MEASURED and OBSERVED.
- `model` is optional and uses `domain-reading.v1`. It replaces the rule reading's statement; the rule's
  signals are kept, and the model's signals are added under an `m.` prefix.
- Every context block is minted inside its organization (`<org>::<id>`), which the gateway requires.
- Every model stage reports a bounded outcome code (`modelStages` in the loop report and the worker log).
- The loop's cost gate compares an **effective fingerprint**: the evidence bound to the producer's reading
  identity (rule; rule with the task off; rule plus the activated task at its version, schema and
  template). Activating a task is therefore one model-backed refresh, not a frozen rule reading. A stage
  that did not happen for a reason that may pass (a Loop refusal, a provider failure, no principal) stores
  its rule reading under an unsatisfied fingerprint, so it is retried.
- An answer Loop rejected satisfies the gate (no repeat on unchanged evidence) and backs off that subject
  for 24 hours under the same task and template version (`MODEL_REJECTION_BACKOFF_MS`, read from the AI
  ledger), so a persistent invalid shape costs at most one call per subject per task per day.
- **Failure backoff.** A provider call that FAILED (timeout, 429, 5xx) is not attempted again for that subject
  for 3 hours (`MODEL_FAILURE_BACKOFF_MS`, from the ledger). The stage is `MODEL_BACKOFF:FAILED`, it is
  unsatisfied, and it retries after the window even when the evidence is unchanged. Without the backoff a
  failing provider was asked on every pass, spending the BACKGROUND lane.
- **Model-read interval.** An ORGANIZATION reading the model made under the same reading identity less than
  6 hours ago stands while the evidence moves (`MODEL_READING_MIN_INTERVAL_MS`; the loop notes
  `MODEL_INTERVAL`, writes nothing, and completes the request). That caps each domain at 4 calls a day.
  Without it, CallGrid and Campaigns, which re-key hourly over a sliding window, asked the model about 24
  times a day each. A new reading identity is read at once. Personal (Calendar) readings are event-driven and
  are not held.
- **Proof on the digest.** Every reading from a producer with a model stage stores `modelStage` (the bounded
  code) and `readingIdentity` in its provenance. A model-backed one also names the `aiInvocationId` of the
  `ai_invocations` row that made it. Read Intelligence State joins the two.
- **Merge guard.** The model's signals are appended under `m.` (the key is cut before prefixing, and a repeat
  is dropped). The merged list is checked against the digest contract before it replaces the rule floor, so
  an answer that validated alone can never cost the rule reading its write.
- **The domain-reading template (v3)** says what the contract enforces:
  - `occurredAt` and `dueAt` are instants copied from a source; no clock times;
  - `owedBy` only on an OBLIGATION and null otherwise (v2 said "otherwise UNKNOWN", which the contract
    refuses);
  - every number is copied exactly (no rounding, abbreviating or arithmetic);
  - the bounds: 280 characters, 6 entities, 8 limitations, unique keys;
  - no quotation marks.

  It also sets the concision standard. The reading is one plain sentence of at most 200 characters on what
  materially changed or matters in this one domain: no advice, no preamble, and no restating the supplied
  signals. Zero added signals is a good answer, and "nothing material changed" or "not enough evidence" is
  correct and never filled.

The organization domain producers read through the scoped `DomainFactsRepository` or the domain's own
repository. They never call Prisma from a service.

| Producer | Scope | Reads | Task |
|---|---|---|---|
| `calendar.domain@1` | PRINCIPAL | work_events, the person's zone, waiting threads | calendar.domain.reading |
| `callgrid.domain@1` | ORG | marketplace_calls aggregates, 7 days against the prior 7 | callgrid.domain.reading |
| `campaigns.domain@1` | ORG | the same, per campaign | campaigns.domain.reading |
| `pipeline.domain@2` | ORG | ELIGIBLE intake only (a verified web lead, or a record a person worked: CRM note, status change, Party link): statuses, stalled by the work clock (never `lastSeenAt`), unassigned conversations; the rest counted apart, never as work (`IntakeEligibilityRepository`, shared with Home, CRM home, the Intake Board and the organization page) | pipeline.domain.reading |
| `crm.domain@1` | ORG | established parties, relationships started or ended | crm.domain.reading |
| `creators.domain@1` | ORG | Creator Hub roster: waiting on EMG or on a creator, due | creators.domain.reading |
| `work.domain@1` / `work.mine@1` | ORG / PRINCIPAL | open, overdue, past return, unowned, throughput | work.domain.reading / rule only |
| `website.domain@1` | ORG | each connected `WebsiteEvidenceReader` (today: website events only) | website.domain.reading |
| `mail.thread@1`, `mail.domain@1` | PRINCIPAL | the person's own Gmail thread, transiently, plus the mail lanes | mail.content.triage, mail.domain.reading |

Three rules apply to every organization comparison:

- Windows are **comparable** windows. A start is not a change: a prior window that Loop's record does not
  fully cover gives no comparison, and the reading says so.
- **Partial economics** are lower bounds.
- **Website** is source-ready. A new analytics, search, ads or replay source joins by adding a reader and
  its registry entry. Nothing implies such a source exists before it is connected.

**Chats v5** (Phase B) is the Telegram triage task at 4.0.0, with the portable schema v5:

- It records who owes what (`owedBy`), typed signals, and grounded party labels.
- Chats groups conversations by what needs whom.
- Items can be marked handled, snoozed or dismissed.

**Mail** (Phase D) carries the same conversation contract per thread. It is gated closed by the
counterparty-consent decision.

**Hosting:**

- The **worker** (`intelligence-host.ts`) runs everything except Mail. It runs only when a
  `LOOP_INTELLIGENCE_*` variable names a producer, a situations scope, or the briefings.
- **Mail** runs from the web route `/api/internal/intelligence/mail`, because only the web tier holds the
  Gmail read-through. The shipped-off `run-mail-intelligence.yml` workflow triggers it.

**Surfaces.** Every domain page reads the same stored digest as its Home tile, through
`OrganizationReadingSection` or `PrincipalReadingSection`. An organization reading is shown only to someone
who holds the registry's read authority for that domain.

## 4. Promote to Work (Phase C)

`PromoteToWorkService` is the one bridge from intelligence to Work OS. It:

1. re-resolves the origin within the actor's scope;
2. shows what will become shared;
3. requires a human's confirmation.

Details:

- The suggested assignee is not an authority. A person may assign the work to themselves; assigning it to
  a coworker needs `work:manage`.
- The link is recorded in `work_origins`, and a `WORK_LINKED` observation goes on the Case or Daily Loop
  item.
- A target date becomes the work's committed return date (`expectedReturnAt`).
- **An origin may become several pieces of work.** One confirmed *submission* creates exactly one: its key
  (the actor, the origin, the confirmed fingerprint and a nonce minted at preview, hashed) is unique per
  organization, so a retried submit returns the work it already created.
- **A Case origin is re-resolved by who may see it.** An organization Case needs the Cases authority (and,
  for a situation, every cited domain's). A private situation is found only through `SituationRepository`
  as its owner, is a PRINCIPAL origin that shares only what they confirm, and records `WORK_LINKED` through
  the situation door rather than an organization Case read.

## 5. Situations (Phase F)

**What may be synthesized.** Situations and the Briefing use one decision, `digestSynthesisEligibility`
(`@emgloop/shared` `intelligence-eligibility.ts`), over the shared freshness contract (`digestFreshness`).
A digest contributes only when its status is CURRENT, its content is valid, and its freshness at that
moment is SUFFICIENT or PARTIAL, **and its target has no unresolved refresh work** in the refresh queue
(any row there is queued, claimed, retrying or HELD). The inputs come from `DigestSourceStateRepository`:
whether the source is live, its newest evidence, and whether refresh work is unresolved.

For Loop-record readings (every ORGANIZATION digest) the refresh is the freshness signal. The producer loop
records each verdict on the stored reading:

- NO_EVIDENCE or a hold marks it STALE (`markTargetStale`), so it stays out even after the queue row goes.
- An unchanged successful refresh re-affirms a STALE reading without a read (`reaffirmTarget`).
- A changed refresh writes the new current reading.

This fails closed. The queue row is the freshness barrier, and it is removed only after the reading has left
CURRENT:
- If the stale write fails on NO_EVIDENCE, the request is retried rather than completed.
- A terminal failure is held whatever the stale write did.
- `purgeHeld` moves the reading out of CURRENT and deletes the HELD row in one transaction.
- A later **successful** refresh of the exact same target (written, or re-affirmed) resolves the HELD rows it
  supersedes (`resolveSupersededHeld`): those last touched before that refresh began. It runs in one
  serializable transaction that re-checks the reading is CURRENT, unexpired and carries the fingerprint just
  written. Enqueue, claim, refusals and failures never clear a barrier. Another target's rows are never touched.
- The unresolved-refresh lookup asks about exactly the supplied digests' targets, with no result cap.

- A PARTIAL digest's limitation travels with every signal into the model's context and into the stored
  situation or Briefing.
- An absence ("nothing pressing") is concluded only when every contributing reading is SUFFICIENT and none
  was left out.

**A situation is a Case.** There is no parallel situation object. The measured `headlines` table remains
evidence of measured movement.

**Candidates** come from `clusterSituationSignals`, which is pure:

- It joins only on a shared canonical entity or a governed link (below), within 14 days, across at least
  two domains.
- A plain measurement does not start a cluster.
- Time alone never connects two signals.

**Governed entity links.** Two entities are joined only by a record that proves it. Nothing else can join
them: no phone number, caller id, name, email, label, timestamp, campaign coincidence, heuristic or model.
There are two kinds:
- persisted `entity_links`, which are explicit and never MODEL;
- links that `GovernedEntityLinkProjector` projects at read time from governed records. These are not
  persisted and are scoped to the organization.

The projector recognises exactly three classes:

| Class | Record | Link | Rejected (code) |
|---|---|---|---|
| `CUSTOMER_PARTY` | an **active** `customer_party_links` row whose customer is the organization's | `customer:<id>` ↔ `party:<id>` | `CUSTOMER_NOT_IN_ORGANIZATION`; `PARTY_NOT_ESTABLISHED` (the Party is unestablished, superseded, archived, missing or in another organization). A reversed link is not a record. |
| `CREATOR_PARTY` | `creator_profiles.partyId` | `creator:<id>` ↔ `party:<id>` | `NO_PARTY`, `PARTY_NOT_ESTABLISHED` |
| `WORK_ORIGIN` | a person's `work_origins` promotion from an ORGANIZATION digest signal naming **exactly one** entity | `work_instance:<id>` ↔ that entity | `SIGNAL_NAMES_SEVERAL`, `PRIVATE_SCOPE`, `CASE_ORIGIN_NOT_CANONICAL`, `WORK_ITEM_ORIGIN`, `DIGEST_GONE`, `SIGNAL_GONE`, `SIGNAL_NAMES_NO_ENTITY`, `WORK_NOT_IN_ORGANIZATION` |

**A link is a bridge, never evidence.** A link only says two references are the same thing, or that one is
about the other. It carries no source. So a promoted Work item adds nothing to independence just by existing:
a cluster gains `LOOP_WORK` only when the Work **reading** names the instance. Work names an instance only for
its own state:
- `overdue` names instances with a step past due;
- `past-return` names instances past the return committed in Work.

A promoted item's committed return may start from its origin signal's due date. The person confirms that date
at promotion, and the fact Work adds is that the work is still not done when the date passes. Promoting a
Campaigns, Pipeline or Creators signal with no such state therefore never makes a Situation.

**One entity per origin.** A signal that names several entities is about a set, for example "3 records stalled
in Quoted". It is not a relationship among its members. Linking the work to every member would join them all
permanently, so such an origin is rejected (`SIGNAL_NAMES_SEVERAL`).

**Chains.** The pass projects from the references its signals name, then from what those links reach, for up to
`GOVERNED_LINK_HOPS` (3) hops. For example: a work item, the customer it was promoted from, that customer's
Party, and a creator on the same Party. A Party is only ever reached, never expanded ("every record on this
Party" is never read). So a broad Party joins only entities the signals already name, and the window and kind
rules still apply.

A projected link does not outlive its record. A reversed Party link stops projecting. A work origin whose origin
digest has been purged by retention reads `DIGEST_GONE` and stops bridging. Until then a stale or expired origin
digest still bridges, because the person's promotion remains true, but its signals are evidence only while that
digest is eligible. Keeping the bridge for good would mean storing the origin entity on `work_origins` at
promotion time, which is a migration. That has not been decided.

**Not projected:**
- CallGrid callers to Customers. A caller row is not intake: it is never named, so its Party link, if it has
  one, joins nothing.
- Case origins.
- Private work origins.
- CRM campaigns and opportunities.

Pipeline names only its stalled **eligible** intake records (`customer:<id>`, at most six per status, longest
stalled first with ties broken by id).

**Source lineage and the independence gate.** Provenance is recorded per digest, but a claim is made by a
signal:
- A signal inherits its digest's registered `sourceId` only when the digest read **exactly one** governed source
  (`signalSourcesOf`).
- A digest that read several sources (Website, once it has more than one reader) cannot say which source each
  signal came from. Its signals claim none: they can connect, but never count as a source.
- An unregistered id counts for nothing.
- A model's `m.*` addition to a rule reading restates the rule's facts and could pick any combination of the
  supplied references, so it does not enter clustering at all.

| Producer | Governed source of each signal |
|---|---|
| CallGrid, Campaigns | `CALLGRID` (both read `marketplace_calls`) |
| Pipeline | `LOOP_INTAKE` |
| CRM | `LOOP_CRM` |
| Creators | `LOOP_CREATORS` |
| Work (organization and personal) | `LOOP_WORK` |
| Website | `WEBSITE_EVENTS` today; none per signal once a second reader connects |
| Calendar, Mail, Chats (personal) | `GOOGLE_CALENDAR`, `GMAIL`, `TELEGRAM` |

A cluster is **source-independent** only when its kept signals span at least `SITUATION_MIN_SOURCES` (2)
distinct sources. **Only source-independent clusters reach `situation.synthesis`.** The others are counted
(`sameSourceOnly`) and cost no call. CallGrid + Campaigns is one source seen twice.

This is not *verification* independence:
- Source independence is about the evidence: two governed systems.
- Verification independence is about the checker: a different model provider re-reads the claims.

A source-independent situation with no second provider is still recorded, with verification `UNAVAILABLE`.

Three ordering rules keep the result deterministic:
- Independent clusters rank first.
- The signal cap keeps each source's strongest signal first.
- A cluster's identity is the **named** references that join it, never a union-find root, so an unrelated link
  elsewhere in the entity graph cannot make a decided cluster look new.

The eligibility, kind and 14-day rules apply unchanged.

`situation_candidates` stores each cluster's last decided fingerprint. An unchanged cluster, including one
the model said was nothing, never costs another call.

**`situation.synthesis[.private]`** answers NEW, UPDATE (naming a *supplied* open situation) or NONE. Every
claim cites supplied signal references. The contract refuses an answer that has:

- unsupplied ids or citations;
- numbers that are not in the claim's own citations;
- causal language;
- claims that join windows more than 14 days apart;
- a NEW that duplicates an open situation;
- instructions to anyone.

**`situation.verify[.private]`** is routed OTHER_THAN_SUBJECT, so a *different* provider marks each claim.
The possible states:

- No independent provider: `UNAVAILABLE`. The check is never run by the same provider and called
  independent.
- No claim supported: the situation is not recorded.

**Visibility follows the most restrictive evidence:**

- A private pass reads the person's own digests. Its Case uses sourceSystem `loop-situation:private` and has
  a `case_private_scopes` row naming its one owner.
- **Every organization Case read excludes the private source**: the repository, the Decision Engine, the
  log, evidence, participants, activity, Brain subjects and status counts. The exclusion is by value, so it
  holds before the migration too. A source-scan test fails any new read that lacks it.
- An organization situation is shown only to someone who may read **every** domain it cites. The Case page
  answers not-found to anyone else.

## 6. The Loop Briefing (Phase G)

`BriefingComposer`, one person at a time, as that person:

1. **Gathers** their own readings, the organization readings their role and permissions admit, and the
   situations visible to them.
2. **Checks its expected coverage** (`expectedBriefingCoverage`): every domain Loop is supposed to observe
   for the person. That means their connected Telegram and Google sources, plus the domains the
   deployment's active producers observe (a conservative default when it is not told), limited to the
   organization domains they may read. An expected domain with no current reading is a gap ("no current
   reading", or "not connected"), never omitted. One rule (`briefingAbsenceJustified`) then decides for both
   the deterministic and the model Briefing: "nothing pressing" only when the whole expected set is present
   and SUFFICIENT.
3. **Reuses** the stored Briefing when the artifacts' fingerprint is unchanged.
4. **Composes** with `loop.briefing.compose` when it is activated. Every line cites supplied artifacts,
   and each artifact tells the model its coverage and limitations. A composed absence claim that coverage
   cannot justify is refused, and Loop's deterministic Briefing is written instead. Otherwise it writes the
   **deterministic** Briefing, which also never claims an absence that coverage does not justify.
5. **Stores** a new version of today's `work_briefs` row in the person's own zone. Nothing is overwritten.

Home reads the stored Briefing and never composes one during a render. It says who composed it, and each
line's chip links only where the viewer's navigation goes.

## 7. Routing and budget

- **Routing `.12`:**
  - one model per call;
  - Anthropic is the primary everywhere except `situation.verify`, which prefers OpenAI and removes the
    subject's provider;
  - OpenAI is the availability fallback where fallback is permitted.
- **Budget `.6`:** it adds the classes domain-reading, mail-content-triage, situation-synthesis,
  situation-verification and loop-briefing *inside* the recorded operating budget. It does not raise the
  organization or global ceilings.

## 8. Retention and erasure

| Artifact | Retention |
|---|---|
| Principal digests | 30 days (stamped on the row) |
| ORGANIZATION digests | Their own expiry |
| Entity links | Tied to the membership |
| Refresh requests | Deleted on completion; a HELD one when a later successful refresh of the same target supersedes it, otherwise 7 days after it last changed (the `INTELLIGENCE_REFRESH_REQUESTS` policy), purged by the worker's retention sweep through `purgeHeld`, which moves its reading out of CURRENT in the same transaction |
| Private situations and a person's candidates | Tied to the membership (`PRIVATE_SITUATIONS`, work-retention `.2`) |
| Organization candidates | Purged after 90 days undecided |
| Loop Briefings (`work_briefs`) | 90 days from the local date: the approved decision (`INTELLIGENCE_BRIEFING_RETENTION_DAYS_DECIDED`), the `BRIEFS` category (work-retention `.3`, not overridable), purged by the worker |

Offboarding erases a person's digests, links, requests, private situations and candidates.

## 9. Not built

- **A private situation that also cites organization readings.** A private pass reads only the person's own
  digests, because which organization readings a person may open is decided from their session.
- **Per-domain Case-list filtering.** Situations do not appear in the CallGrid queue; only Home, Headlines
  and the Case page show them.
- **Production sources for GA4, Search Console, Ads, Bing or Clarity.**
- **Backfill of existing Work rows' origins.**
- **An organization "service account".** Organization model readings run as a named operator.

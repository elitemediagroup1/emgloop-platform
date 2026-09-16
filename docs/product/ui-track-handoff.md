# UI Track Handoff — what Charlie and Lexi can build now

**Date:** 2026-09-16, against `main` `6fdab5e` (#264–#275 merged; production at 35 migrations; the AI
runtime is built and switched off). **For:** Charlie and Lexi. **Owner of this page:** the
backend and authority track. **This table is the current status**; the matrix in
`foundation-handoff.md` §6 records the 2026-09-15 decision point.

You own the visual redesign: interaction architecture, hierarchy, layout, density, responsive behavior,
record presentation, drawers, navigation design. This page tells you which backend truth exists, which
contract to design against, and what must stay an honest empty, loading or unavailable state.

**The shared rule:** the interface may project and explain truth. It may not create truth for
presentation convenience.

**Detail lives in:**
- `docs/product/foundation-handoff.md` (§2 readiness matrix, §6 unblock matrix)
- `docs/architecture/relationship-participant.md`
- `docs/architecture/commercial-opportunity-campaign.md`
- `docs/architecture/universal-activity.md`
- `docs/architecture/loop-ai-runtime.md`
- `docs/architecture/identity-evidence-resolution.md` (identity posture §11a, Intake §10)

**Status meanings:**

| Status | Meaning |
|---|---|
| GREEN | Build now on existing authority |
| YELLOW | Design against the contract named; data arrives when the backend slice lands |
| RED | Prototype or exploration only |

The foundation handoff (#245) is merged, so the YELLOW contracts are authoritative.

### What changed since 2026-09-15

- **People, Person, Companies, Company, Relationships and Relationship Detail move YELLOW → GREEN.** The
  Party read and write authorities and the full Relationship authority are on `main`: create, end,
  reactivate and void, Participants, read models, server-decided capabilities and the duplicate
  diagnostic. Production data is still empty, which is a design state rather than a missing authority.
- **Intake moves to GREEN outright.** The provenance classification is in the Intake Records read model.
- **Universal Activity stays YELLOW, now for a precise reason.** The read model is on `main`, but it has
  no Person, Company or Relationship lane. See *Blockers* below.
- **Intelligence and CallGrid:** the fabricated "AI resolution rate" is deleted. Every numeric
  confidence render is converted to semantic strength, and a test now fails if one comes back (#262).

### The operator surface is not your redesign

PR #264 adds `/crm/parties` and `/crm/relationships`: **temporary engineering UI**. It exists so an
authorized person can establish a Person or Company and record a governed Relationship now, instead of
waiting on the redesign.

- It is deliberately plain and uses the existing CRM shell. It makes no design decisions you need to
  respect.
- **Replace it; do not restyle it.** When your People, Companies and Relationships surfaces land, those
  routes and their `_operator` components should be deleted.
- It is a working reference for the contracts. Every form renders from server capabilities, and every
  superseded, archived, refused and empty state has words on the page.

---

## 1. Start now

1. **Everywhere:** UI 0 primitives, record grammar (Identity, State, Context, Activity, Intelligence &
   Action), context drawers, the responsive and mobile system.
2. **Global navigation** in the five areas (Home, CRM, Work, Intelligence, Operations), plus your
   route-transition proposal. Routes move only after Product approves the proposal.
3. **Redesign on existing authority:** Intake Records, Work, Intelligence, Operations, CallGrid, and now
   People, Person, Companies, Company, Relationships and Relationship Detail.
4. **Loop Home**, against governed sources.
5. **Universal Activity, Opportunities and Campaigns** against the contracts below, with honest empty
   and unavailable states.

## 2. Surface by surface

| Surface | Status | Design against | Keep honest until implementation lands |
|---|---|---|---|
| Loop Shell | GREEN | One shell; navigation filtered by server-resolved authority | Nav visibility is never authorization |
| Loop Home | YELLOW | See Loop Home detail below | "What changed since you last looked" needs a last-visit instant; show a plain recent-changes list until then |
| Navigation | GREEN | Five areas (C-01) | Current routes stay until your proposal is approved |
| Record grammar | GREEN | Specification | A section whose authority is missing renders as unavailable, never with filler |
| Context drawers | GREEN | Context chain is navigation state | Closing restores the prior subject; the chain never creates relationships |
| Responsive / mobile | GREEN | Specification density and priority rules | — |
| People | GREEN | See People and Companies detail below | **Empty in production** until someone establishes a Party. Say that nobody has been established yet, which is not the same as loading. Explain that People are identified people, and link to Intake Records. |
| Person Detail | GREEN (Activity unavailable) | See People and Companies detail below; Relationships through the Party's Relationship list | Contact info only from linked Intake Records, labeled **"From Intake Record — not verified"**. No product path creates a link yet (see *Blockers*), so expect none. **Activity renders as unavailable.** |
| Companies | GREEN | Company list, same shape as People | Empty in production. Never the Workspace Organization; never CallGrid buyers or vendors. |
| Company Detail | GREEN (Activity unavailable) | Company record, same shape as Person | Company profile fields unavailable. People at the Company are AFFILIATION Relationships, which now exist. **Activity renders as unavailable.** |
| Intake | GREEN | The existing Customer records, **named Intake Records**, with a provenance segment per record (labels in `INTAKE_PROVENANCE_LABELS`) | Provenance is in the read model but no page shows it yet. Provenance says how a record was created, never who it is about. No merge action and no "link to Person" action (see *Blockers*). Intake status is not a pipeline. |
| Universal Activity | YELLOW | See Universal Activity detail below. On `main` for the organization feed, an Intake Record, a Case and a Work item; no page calls it yet | **No Person, Company or Relationship lane** (see *Blockers*). A Relationship's own history is on its record instead. Content (message bodies, raw numbers) opens from its source page under that page's permission. |
| Relationships | GREEN | See Relationships detail below | Empty in production until someone records one; creation needs established Parties. The list has no filter by kind yet. |
| Relationship Detail | GREEN | See Relationships detail below | No health or strength score (CI Findings by reference only). A superseded Party shows its stored **and** current record, and a write naming it is refused, never quietly redirected. |
| Opportunities | YELLOW | See Opportunities detail below | Empty until the Opportunity slices land |
| Opportunity Detail | YELLOW | See Opportunities detail below | Amount and expected close date are pending confirmation: design them as optional human-entered fields. Actions are server-decided. |
| Campaigns | YELLOW | See Campaigns detail below | Empty until the Campaign slices land |
| Campaign Detail | YELLOW | See Campaigns detail below | Participants unavailable (not activated); invoices and payments unavailable (Accounting not built) |
| Work | GREEN | Work OS | Links from work to records, and approvals, do not exist yet |
| Intelligence | GREEN | CI Headlines, Queue, Cases, Findings (Developing / Established + evidence count), Recommendations (select, dismiss, revise), Monitoring; Decision Center | **Case Explanation panel: YELLOW — built and switched off (#270)**; see Intelligence detail below. The "AI resolution rate" is deleted; do not reintroduce it. |
| Operations | GREEN | Area grouping of CallGrid and future operational modules | — |
| CallGrid | GREEN | CallGrid execution, measurement and reconciliation, split per C-03 | Confidence is shown as semantic strength, and a test fails if a percentage comes back. |
| Creator administration | YELLOW (roster) / RED (execution) | The roster is TALENT_REPRESENTATION Relationships with CREATOR participants. The authority exists; the list read needs a filter by kind first (a small backend slice) | Deliverables, earnings, uploads and critiques: unavailable. No separate creator app. |
| Brain / AI | RED | Exploration only | No conversational Brain; no "AI" label on rules. The only AI task is Case Explanation (below). The runtime is off, no live request has been made, and the usage ledger is deployed but empty. |
| Universal Search | RED | CRM-scoped search only | Universal search is deferred |

### Loop Home detail

- **Needs You:** CI attention items, your personal queue, unowned Work OS stages.
- **What Changed:** recent governed changes (audit, for people allowed to see audit).
- **Loop Noticed:** **governed Commercial Intelligence Headlines only.** Not the Executive Brain or its
  percentages.
- **My Work:** Work OS.
- **Operating Pulse:** CallGrid scorecard with honest Unknowns.

### People and Companies detail

**People list:** established, non-superseded PERSON Parties. Each item has:
- `partyId`, `displayName` (may be null);
- establishment (basis, established at, established by);
- archived flag.

**Person record** adds:
- the reference state (a superseded record shows its current record);
- identity posture (§11a: establishment state and basis, match posture, limitations; **never a
  confidence number**);
- linked Intake Records (active and past links).

**Companies** use the same shapes with COMPANY.

**Creating and establishing a Party** are two separate acts:
- create: EMPLOYEE and above;
- establish: OWNER or ADMIN, basis MANUAL or EXPLICIT_LINK;
- show each action only when the server says the viewer may.

### Universal Activity detail

`activity.v1` items carry:
- category: Fact / Communication / State Change / Work / Signal / Finding / Recommendation / Decision /
  Audit;
- time with its basis (unknown times are shown as unknown);
- actor, subjects and participants;
- identity state: Known person / Known company / Unresolved / Anonymous / Not applicable;
- provenance and limitations;
- semantic status (e.g. Finding Developing);
- sensitivity class.

Filters are All / Communications / Work / Intelligence / Changes.

**Available as adapters land:** Case/Decision, Work item, Intake Record, organization operational feed.

### Relationships detail

**Kinds:**

| Structure | Kinds | Tenant's place |
|---|---|---|
| OWN | CLIENT, SUPPLIER, TALENT_REPRESENTATION, PARTNER | the tenant is the implied other side; **it never appears as a Company** |
| THIRD_PARTY | REPRESENTATION, SUPPLY, AFFILIATION, PARTNERSHIP | two Party sides |

**A Relationship shows:**
- sides with labels ("represents" / "is represented by");
- participants with roles:
  - capacities: CREATOR, EMPLOYEE, BRAND, AGENCY, PUBLISHER, BUYER, VENDOR, SOURCE, PARTNER;
  - engagement roles: PRIMARY_CONTACT, DECISION_MAKER, BILLING_CONTACT;
- lifecycle ACTIVE / ENDED / VOIDED with history;
- owner (a Loop user);
- business dates;
- a "possible duplicate" notice when two records resolve to the same Parties.

**Who can act** (every role is tested by submitting each act directly, bypassing the UI):

| Act | Who |
|---|---|
| View | every human role, including READ_ONLY |
| Create, edit, add or change a Participant | EMPLOYEE+ |
| End, reactivate, end a Participant | MANAGER+ |
| Void, void a Participant | OWNER/ADMIN |
| Anything | never AI_EMPLOYEE |

A side Participant (the Party that *is* a side) cannot be ended on its own. End the Relationship instead.

### Opportunities detail

**Status:**
- category: OPEN / CLOSED_WON / CLOSED_LOST;
- stage: **organization-configured labels**, so design for arbitrary names and counts;
- outcome and loss reason when closed.

**Forecast:** a human-authored probability with **who set it and when**, plus its history.

**Context:**
- participants (established Parties with roles);
- an **optional** Relationship;
- the Intake Record it was created from, if any;
- Campaign references.

**AI** may appear only as a *recommendation* (stage, forecast, next action) with its evidence. It never
changes the Opportunity.

### Campaigns detail

**The record:**
- name;
- commercial lifecycle (proposed: Draft / Agreed / Active / Paused / Ended / Cancelled), declared by
  people and never from traffic;
- agreed terms;
- Relationship and Opportunity references;
- provider campaign links (provider, external id, effective period), with CallGrid execution and
  measurement shown **as CallGrid's facts**.

### Intelligence detail: the Case Explanation panel

**Built and switched off (#266–#270).** The panel on `/app/admin/cases/[id]` uses the Case page's existing
styles. Its **states and wording are the contract**; its look is yours to redesign.

- **What it is.** On-demand and read-only. An OWNER or ADMIN presses "Explain this investigation". MANAGER
  is pending a Product decision.
- **What comes back.** A summary, then claims in three groups, then limitations:
  - "What the evidence shows"
  - "Why it may matter"
  - "Worth looking into"
- **Citations.** Every claim carries citation chips: Evidence `<id>`, Headline, Finding, This
  investigation, Monitoring, Outcome.
- **No numbers of its own.** No confidence number, and no number, figure or date that the cited evidence
  does not contain. An answer that breaks a rule is **not shown at all**; the panel says why instead.
- **Self-labelling.** It says it was written by an AI model from the evidence, is not a finding, decision
  or recommendation, and changes nothing.
- **What it reports about itself:**
  - what was *not* sent (for example "2 evidence people reported");
  - the label key for names (`buyer #1 = …`);
  - the model and versions;
  - that the answer is not stored.
- **States to design:**
  - not enabled;
  - paused;
  - not configured;
  - owners and admins only;
  - explaining (pending);
  - answered;
  - not shown, with a reason: rules broken, model declined, allowance used up, provider unavailable, or
    not found.
- **No real-data sample exists yet.** Nothing is recorded, and answers are never stored.

### Brain: what the approved architecture means for your design (B3, 2026-09-16, not built)

Brain work will run on AWS; this page and your screens stay on Netlify. The details are in
`docs/architecture/brain-execution-infrastructure.md`. This section covers behaviour, not visuals:
the look is yours. **None of it is built**, and today's Explanation panel is unchanged and OFF.

- **Quick (interactive) Brain.** Work the person watches, such as today's Case explanation.
  - Pressing the button **starts a job and returns at once**. The screen then asks for the job's state
    every second or so.
  - The result appears **whole** when it is ready. There is no word-by-word typing, because an answer
    that breaks a rule is never shown at all.
  - Each task has a **presentation budget**: Case Explanation's provisional target is 20 s. After it,
    show the work as continuing in the background; the job itself does not change.
  - Each task also has a **deadline**: 75 s provisionally. After it, a task that allows it becomes
    durable; otherwise it ends with a named reason.
  - Neither number is a technical limit, and both are yours to confirm.
- **Durable Brain.** Longer work that keeps going when the person leaves.
  - It may **stop to ask the person something**, and continue when they answer.
  - Nothing about it depends on the page staying open.
- **"Brain • N working."** A count of the person's own Brain jobs that are not finished, read from
  Loop's records.
  - It survives navigation, reloads and a closed browser.
  - It counts jobs, not percentages. There is no progress bar with an invented percentage; show the
    **named step** instead (for example "Reading the evidence", "Checking citations").
- **Working state on the object.** The record a job is about (a Case, later a Relationship or
  Campaign) can show "Brain is working on this", and who started it.
- **Waiting for you (WAITING_FOR_USER).**
  - **V1: only the person who started the job may answer.** Nobody else sees an answer control.
  - The question has an **expiry**. After it, the job ends as "expired", and a late answer is refused
    with that wording.
  - An answer to an older version of the question, from a stale tab, is refused.
  - Answering twice returns the first answer.
  - Cancelling while waiting stops the job at once.
- **When it finishes.**
  - **In V1, notification is in-app only**: the count changes, and the object shows the result.
  - **Email or other delivery comes later**, because it depends on repairing Loop's outbox, which is
    currently broken in production.
- **Failure and retry wording.** Jobs end with a named reason: the model declined, the answer broke a
  rule, the provider was unavailable, the allowance was used up, access was withdrawn, the deadline
  passed, it was paused by an administrator, or the question expired. Show the reason honestly.
  - **"Try again"** starts a new job that reuses what the old one already finished, so already-paid
    work is not paid for twice.
  - **Cancelling** means stopping at the next safe point. A result that arrives after the person asked
    to stop is never applied.
- **Leaving the page.** Quick work continues too, and its result is waiting when the person comes
  back. Nothing is lost by navigating away.
- **Where results live.** A result belongs to the object it is about:
  - a Case explanation to that Case;
  - a finding or recommendation to that Case's intelligence;
  - **a draft to the customer conversation it would be sent in;**
  - a proposed action to the approval queue.

  **There is no "Brain inbox" that owns results.** Activity shows that something happened and links
  to the object.
- **A draft is not a send (decided 2026-09-16).** Brain can write an email, a follow-up or a rewrite
  as a **draft** for a person to review, edit and use.
  - **Creating a draft never sends anything,** schedules anything or grants permission to send,
    whichever provider wrote it.
  - **Sending is a separate act:**
    - the person sends it themselves, under their own Conversations permission;
    - or, later, Brain proposes "send this", and that proposal goes to the approval queue on its own
      and is approved on its own.
  - **So the "Send" control belongs to the conversation, not to the Brain result.** Never design a
    one-click "Brain sent this".
  - **Label a draft as a draft,** with what it was based on (the message it replies to, the booking
    it mentions).
- **Provenance and details.** Every result can show how it was produced:
  - model and provider;
  - whether a fallback answered, and why;
  - task, template and policy versions;
  - what was withheld;
  - the citations.

  It never shows prompts or raw model text beyond the validated answer.

**Decisions that are yours:**
1. The background presentation, and where people find running, waiting and finished work.
2. The confirmed presentation budget and deadline for Case Explanation (currently 20 s / 75 s,
   provisional).
3. How a waiting question looks, its default expiry, and the expired wording.
4. The in-app notification pattern for V1.
5. Whether Case explanations keep a history or stay one-off.
6. How each result type is presented.
7. **Communication drafts (the type is decided; the experience is yours).** DRAFT is now its own
   result type, separate from a proposed "send" (`brain-execution-architecture.md` §5). Still open
   with you and Product:
   - where drafts appear on a conversation, and how a person edits, discards or sends one;
   - whether drafts may be started from other places (a Relationship, a Campaign, a Brain
     conversation); each is added when its first task is defined;
   - whether a draft's text may appear while it is being written (today: no, it appears whole).

## 3. Blockers you will hit

**Person and Company activity, and linking an Intake Record to a Person, are the same blocker.**

- Universal Activity has no Person, Company or Relationship lane. The only honest Person reading would
  show each *linked Intake Record's* activity, labeled as that record's. It would never be relabeled as
  the Person's own.
- But no product path creates a link. The web app is fenced off from linking entirely: a test forbids
  any web file from even naming it.
- Whether people may link Intake Records to Parties from the product, and how that fence narrows while
  still keeping ingestion out, is a **Product and architecture decision that has not been taken.**

Until it is: no "link to Person" action on Intake Records, and Activity on Person and Company renders as
unavailable.

A concrete proposal for that workflow, and the narrowest fence change it would need, is in
`docs/product/intake-party-linking-recommendation.md`.

## 4. What is still missing before your redesign can be implemented

The backend truth above is ready. **The visual redesign itself cannot yet be built from anything in the
repository.** As of 2026-09-16 the repository holds:
- no design files;
- no exported mockups or screen designs;
- no Storybook;
- no written visual specification.

`docs/product/loop-product-ui-architecture-v1.0.md` (Charlie Brugnolotti and EMG, 2026-09-15) is the one
document from your track. It is an information-architecture and interaction specification, and its visual
direction is qualitative. It has:
- no colour or status palette;
- no type scale;
- no spacing, grid or breakpoints;
- no component specifications;
- no screen layouts.

To implement the redesign, engineering needs:

1. **The visual design deliverable.** Either screen designs (Figma or equivalent, or exported frames) or a
   written visual specification covering:
   - a semantic colour and status system;
   - a type scale;
   - spacing, grid and breakpoints;
   - component specs for the UI 0 primitives: shell, context header, tabs, states, attention, rail,
     drawer, activity item.
2. **Your route-transition proposal.** Per `loop-application-structure.md`, no route moves until Product
   approves it.
3. **The "Product Definition" the code already cites.** `design-system.css` and `app/crm/page.tsx`
   reference "Charlie/Lexi §10.1 / §10.2", and PR #226 cites "§18 screen families". No document with
   those sections is in the repository.

**The two temporary engineering screens should be replaced by your designs, not restyled:**
- `/crm/parties` and `/crm/relationships` (operator surface, #264);
- the Case Explanation panel's current look (#270).

## 5. Rules that apply to every surface

1. **Names:**
   - "People" means identified Parties only;
   - legacy Customer rows are **Intake Records**;
   - the tenant is the **Workspace**;
   - CallGrid's campaigns are **provider campaigns**.
2. **Never show a generic confidence percentage** for identity or machine output. Human Opportunity
   forecast probability is the only numeric probability, and it always shows who set it and when.
3. **Actions are server-decided.** Render an action only when the read model says the viewer may perform
   it. Hiding a button is not the security boundary, and showing one is not a promise.
4. **Unknown is a valid state.** Never zero-fill, default or estimate a missing value.
5. **AI output is always labeled by kind** (summary, recommendation, draft), with its evidence. It is
   never styled as fact and never given ornamental "AI" treatment.
6. **Contact information:**
   - from linked Intake Records only, and labeled as such;
   - raw caller numbers and message bodies open from their source under that source's permission;
   - who may see them is a separate security decision (PD-F-09).
7. **No placeholder records.** Do not create a Person for unidentified activity, a Relationship to hold
   an Opportunity, or a Campaign on win.

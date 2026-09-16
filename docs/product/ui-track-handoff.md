# UI Track Handoff — what Charlie and Lexi can build now

**Date:** 2026-09-16, against `main` `b8bc560`, with two open PRs noted where they change a status
(#264 operator surface, #265 AI usage ledger). **For:** Charlie and Lexi. **Owner of this page:** the
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
| Intelligence | GREEN | CI Headlines, Queue, Cases, Findings (Developing / Established + evidence count), Recommendations (select, dismiss, revise), Monitoring; Decision Center | **Case Explanation panel is YELLOW**; see Intelligence detail below. The "AI resolution rate" is deleted; do not reintroduce it. |
| Operations | GREEN | Area grouping of CallGrid and future operational modules | — |
| CallGrid | GREEN | CallGrid execution, measurement and reconciliation, split per C-03 | Confidence is shown as semantic strength, and a test fails if a percentage comes back. |
| Creator administration | YELLOW (roster) / RED (execution) | The roster is TALENT_REPRESENTATION Relationships with CREATOR participants. The authority exists; the list read needs a filter by kind first (a small backend slice) | Deliverables, earnings, uploads and critiques: unavailable. No separate creator app. |
| Brain / AI | RED | Exploration only | No conversational Brain; no "AI" label on rules. Provider adapters exist but run only against test fixtures. No credential is read, no live request exists, and the runtime is not switched on. The usage ledger (#265) is not deployed. |
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

- On-demand, read-only explanation of a Case.
- Every statement cites its source.
- No confidence number.
- Shows "not configured" until the runtime's activation gates hold.

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

## 4. Rules that apply to every surface

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

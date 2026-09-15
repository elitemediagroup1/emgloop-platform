# Opportunity and Campaign — readiness record

**Status:** READINESS ASSESSMENT (2026-09-15). **Neither authority exists and none is authorized to be
built.** This record separates what is locked, what is only missing, and what needs Product. It gives
the UI the minimum stable contract to design against, and lists what the UI must not assume.

---

## 1. Directions recorded here for the first time

Product stated both directions in the foundation brief (2026-09-15). Neither appeared in any repository
document before this record.

1. **Human forecast probability.** An Opportunity may carry a numeric probability **only as a human
   commercial forecast**: entered by a person, attributed to that user and timestamped, and kept as an
   append-only history. It is never defaulted from a stage, never computed by a machine, and never shown
   as machine confidence. Machine epistemic state is never a generic confidence percentage.
2. **Execution ownership.** CRM owns commercial truth. Execution domains keep execution truth:

| Domain | Owns |
|---|---|
| CallGrid | call execution and call-level reconciliation |
| Creator capability | creator execution and deliverables |
| Intake / Property | submission, qualification and routing |
| Work OS | human tasks, assignments and production work |
| Accounting | transactions and payments |
| Communications | provider, transmission and delivery |
| Measurement | governed performance and outcome facts |
| Decision Engine | governed decisions and approvals |
| Commercial Intelligence | interpretation, Findings and Recommendations |

CRM composes these through governed references and projections. It never copies their authority.

## 2. What exists today (verified on `main` `543c645`)

| Item | What it really is | Class |
|---|---|---|
| `Customer.attributes.pipelineStatus`, the `pipeline` resource, `/crm/pipeline` | **Intake status.** A JSON key (New, Contacted, Quoted, Booked, Completed, Archived), overwritten in place, with **no history and no audit** on manual writes. The workflow step accepts unvalidated strings. | Legacy Intake. Preserved as Intake. **Never the Opportunity.** |
| `ServiceRequest` (NEW/QUALIFYING/QUOTED/WON/LOST, `estimatedValueCents`) | A lead/quote-shaped Intake table **with no writer, ever** | Dormant Intake-domain record. **Not evolved into Opportunity:** that would key pursuit by Customer, not Party, and set status without a log. |
| Booking, Order | No current writer. DRAFT orders shown as "revenue opportunity" | Dormant; Accounting and execution territory |
| `@emgloop/shared` `interface Opportunity`, CallGrid `findingType: 'OPPORTUNITY'`, "Today's biggest opportunity", Executive Brain "Top Opportunities", `revenue_opportunity`, `UPSELL_OPPORTUNITY` | Intelligence **improvement findings**, not commercial pursuits | Naming collision (§5) |
| `CognitiveEntityType.OPPORTUNITY` / `CAMPAIGN`; cognitive `CAMPAIGN_STATUS_CHANGED` | Dormant cognitive enum values | Not the authority. Confined. |
| `MarketplaceCall.campaignExternalId/Label`, `/app/admin/marketplace/campaigns` | The **provider (CallGrid) campaign**: an execution attribution dimension | Execution authority (Operations → CallGrid; C-03) |
| `ObjectiveMeasureBinding.campaignExternalIds`, `ProviderMemberExpectation` (member dimension CAMPAIGN), reconciliation members, `MeasureSourceAuthority` | Measurement keyed by provider campaign id | Measurement authority, composed by reference |
| `Interaction.metadata.campaign` | CallGrid campaign names **and** website UTM campaign strings under one key | Attribution facts with a key collision (§5) |
| Creator Hub, creator upload, Accounting | Placeholder shells | Absent |
| Work OS `metadata.relatedRecord` | Always `null` ("no first-class record source exists") | No subject reference |
| Decision Engine outcomes, `CognitiveDecision` approval, `BlueprintStage.requiresApproval` | Intelligence decisions, dormant approval columns, unwired execution approval | **Not** commercial stage or close machinery |

## 3. Opportunity

### 3.1 Locked (usable now)

- **A new governed CRM authority,** tenant-local. Cross-organization access is not-found. Organization
  foreign keys are real.
- **Not a Party, not a `CognitiveIdentity`, not Intake status, not `ServiceRequest`, not a CRM
  Automation or Work OS Blueprint.**
- **Stage changes are an append-only transition log with a rebuildable projection** (Engineering
  Principles Rules 1–2). Each transition records prior state, new state, actor, time and authority.
- **Participants use the Party Reference contract** through the CRM Participant authority
  (`relationship-participant.md` §5–6):
  - writes reference established, non-archived Parties;
  - a superseded id is refused with its canonical id.
- **Forecast:** never invented. Show the human-entered fact, a governed projection, or Unknown. Numeric
  probability only as an attributed human forecast (§1).
- **Intake:** a separate authority. Intake status never drives Opportunity stage. An Intake → Party link
  creates no Opportunity.
- **Work:** Work OS owns execution. An Opportunity stores a `(destinationSystem, destinationType,
  destinationId)` reference and reads work state at read time (the `case-work-coordination` precedent).
- **Activity:** composed through `activity.v1`. `OPPORTUNITY` is a reserved subject kind until the
  authority exists.
- **Events:** one bus, `StateChangeOutbox`, with a new subject type (a migration). AuditLog for
  consequential acts. The history is its own log, never AuditLog alone.
- **No model output closes an Opportunity or makes a human decision.** AI_EMPLOYEE is hard-denied
  writes.

### 3.2 Missing, but not a decision

- The schema, service, RBAC resource, outbox subject and read models.
- Relationship and Participant implementation (slices R1–R3).
- A governed Party write surface (slice P1).
- A non-colliding shared type name (§5).

### 3.3 Product decisions

**PD-F-02** (in `relationship-participant.md` §9): must an Opportunity belong to a Relationship?

**PD-F-06 — Opportunity policy.** Locked decisions fix the form (append-only, attributed, never
invented) but not the content:

| Sub-question | Recommendation | Main alternative |
|---|---|---|
| (a) Stage vocabulary | Platform-fixed **lifecycle categories** OPEN, WON, LOST, WITHDRAWN. **Organization-configured ordered stages** within OPEN, owned by OWNER/ADMIN and versioned, because no vertical stage names may live in a shared layer. | One platform-fixed stage list |
| (b) Outcomes | Outcome equals the closed category, with a required closed loss reason list (PRICE, TIMING, NO_DECISION, COMPETITOR, NOT_QUALIFIED, OTHER with note). Reopen allowed with a reason. | Free-text reasons (rejected: Rule 4 needs comparable outcomes) |
| (c) Forecast fields | Human-entered amount (integer minor units plus ISO currency); human probability 0–100 with author and time, append-only; expected close date as a calendar date. **No stage-implied default probability, no machine forecast.** CI interpretation, if any, is a separate Finding. | Stage-weighted probability |
| (d) Close authority | Any holder of `opportunities:update` may close. No approval at launch: no team model exists and no commercial `approve` action exists. Decision Engine not used. | MANAGER approval (needs a team model first) |
| (e) Opportunity from Intake | An explicit human act. It references the Intake Record, **does not change intake status**, and requires at least one established Party participant. Intake-only leads stay in Intake until identity is established. | Allow zero-participant Opportunities keyed only to Intake (rejected: pursuit keyed by Customer again) |
| (f) Grants | New resource `opportunities`, mirroring PD-F-04, AI_EMPLOYEE hard-denied | — |

**Blocked by PD-F-02 and PD-F-06:** the Opportunity schema, service and UI beyond a prototype.

### 3.4 Minimum contract the UI may design against (shape only; not built)

| Part | Content |
|---|---|
| Identity | `(organizationId, opportunityId)`, title |
| Context | Participants (Party refs + roles + sides); optional Relationship ref (per PD-F-02); Intake Record refs; Campaign refs |
| State | Lifecycle category + stage label (vocabulary pending); human forecast (amount, probability, expected close) with author and time, or Unknown |
| Activity | `activity.v1` (reserved until built) |
| Intelligence and Action | CI Findings and Recommendations linked by reference; Work references; close and reopen actions shown only when the server says the viewer may act |

**The UI must not:**
- present intake status or `ServiceRequest` as Opportunity stage;
- compute or default a probability;
- label CallGrid "opportunity" findings as Opportunities;
- show participants that are not established Parties;
- assume who can close.

## 4. Campaign

### 4.1 Locked (usable now)

- **A new CRM authority for the agreed commercial program:** what was sold, agreed or commercially
  intended.
- **CRM owns** commercial intent and lifecycle. Execution, measurement, deliverables, accounting and
  calls stay with their owners and are composed.
- **Not the provider campaign.** A CRM Campaign links to provider campaigns **by provider external
  id**, through a human-declared, effective-dated link. There is no foreign key to `marketplace_calls`,
  no row rewrite and no copied metrics. Only provider campaigns with observed traffic are knowable.
- **Commercial state is declared by people,** never inferred from traffic.
- **Campaign participation is DEFERRED** (identity record §16) until un-deferred.
- **Events and audit** follow Opportunity.

### 4.2 Missing, but not a decision

- The schema, service and link table.
- **Multi-tenant ingestion.** A Campaign-to-provider-campaign link is only as tenant-safe as ingestion.
  Today ingestion resolves `LIVE_ORG_SLUG` and `marketplace_calls` is globally unique on
  `(provider, externalId)`. This does not block single-tenant use; it blocks customer #2.

### 4.3 Product decisions

**PD-F-07 — Campaign policy:**

| Sub-question | Recommendation | Alternative |
|---|---|---|
| (a) Lifecycle | DRAFT, AGREED, ACTIVE, PAUSED, ENDED, CANCELLED; human-declared, effective-dated transitions | Mirror provider campaign status (rejected: execution state is not commercial state) |
| (b) Commercial terms | **CRM Campaign holds agreed terms** as human-declared, effective-dated agreement facts: rate basis, caps, payout basis, dates. The specification defines Campaign as "what was sold, agreed". **Accounting owns** invoices, transactions and payments. **CallGrid owns** its execution configuration. | Terms owned by Accounting, referenced from CRM |
| (c) Provider campaign links | One CRM Campaign links to many provider campaigns over effective-dated periods. A provider campaign links to at most one CRM Campaign per period. Buyer, source and vendor links follow the same pattern when needed. Declared by MANAGER+. | One-to-one |
| (d) Participation | Un-defer when Campaign is built, using the CRM Participant authority (exclusive arc) | Keep deferred; Campaign shows only Relationship- and Opportunity-derived Parties |
| (e) Opportunity → Campaign | A Campaign may reference won Opportunities. Created only by an explicit human act, never automatically on win (Rule 6). | Automatic creation on win |
| (f) Objectives scoped to a Campaign | Defer until Campaign exists; objectives stay organization- or user-scoped | Allow now (impossible: no entity) |

**Blocked by PD-F-07:** the Campaign schema, service and UI beyond a prototype.

### 4.4 Minimum contract the UI may design against (shape only; not built)

| Part | Content |
|---|---|
| Identity | `(organizationId, campaignId)`, name |
| State | Commercial lifecycle (vocabulary pending); effective dates |
| Context | Relationship and Opportunity refs; participants (deferred); agreed terms (pending PD-F-07b) |
| Execution | Composed provider campaign links with their CallGrid execution and measurement facts, each labeled with its owning authority |
| Activity | `activity.v1` (reserved until built) |

**The UI must not:**
- present the CallGrid Campaigns dimension as CRM Campaigns;
- show provider traffic as commercial status;
- copy measurement into Campaign fields;
- host Campaigns on the Workspace Organization page (PD-I2-07).

## 5. Conflicts and non-destructive reconciliation

1. **Intake status presented as "pipeline."**
   - Keep the key, route and resource as Intake infrastructure: no data rewrite, no renames for wording.
   - Add a fence: Opportunity code never reads `pipelineStatus`.
   - Minimal wording fixes (PD-I2-08) for "Set pipeline status", "CRM & Pipeline defaults", "Pipeline
     Summary", "Sales pipeline", and the Workspace page copy "replaces the current intake statuses".
   - Separate small branches: validate the workflow step's status against `PIPELINE_STATUSES`, and stop
     writing the dead `settings.pipeline`.
2. **ServiceRequest.**
   - Classify it as dormant Intake. The Intake creation contract decides whether to keep it as
     qualification or retire it.
   - Fix Loop Home's "Qualify" call to action, which has no action behind it.
3. **"Opportunity" collisions.**
   - Reserve "Opportunity" for the CRM pursuit.
   - Rename the type-only `@emgloop/shared` `Opportunity` to e.g. `CallGridOpportunityFinding`.
   - Do **not** rename stored or enum values: `findingType` may be persisted inside decision evidence.
   - Relabel intelligence UI copy through the UI track.
4. **CallGrid campaign vs CRM Campaign.**
   - Vocabulary: "Campaign" is the CRM program; "provider campaign" is the execution member.
   - Link by external id.
   - If `docs/CALLGRID_MISSING_CAPABILITY_BLUEPRINT.md`'s `MarketplaceCampaign` is ever built, it holds
     CallGrid execution configuration only.
   - A future ingestion change writes UTM campaign to a distinct key instead of rewriting history.
     Revenue-by-campaign is labeled as mixed until then.
5. **The Workspace Organization page hosts commercial tabs** (Relationships, Opportunities, Campaigns).
   The UI track moves them to Person, Company and Relationship. The test pinning those disabled tabs is
   updated in that change.
6. **Stage and approval borrowing.** Copy the Decision Engine *pattern* (append-only log plus reducer),
   never its tables or outcomes, for commercial state.
7. **AI authority.** New commercial resources hard-deny AI_EMPLOYEE writes instead of inheriting the
   READ_ONLY fallback.

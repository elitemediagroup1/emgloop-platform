# Opportunity and Campaign — readiness record

**Status:** CONTRACT LOCKED FOR DESIGN (2026-09-15). Product approved PD-F-02, PD-F-06 and PD-F-07.
**Neither authority is implemented.** Implementation follows the Relationship and Participant slices
(`relationship-participant.md` §10). Two small confirmations (PD-F-11, PD-F-12, §6) are needed before
the Opportunity and Campaign *service* slices, not before UI design.

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

### 3.3 Product decisions (approved 2026-09-15)

**PD-F-02 — Relationship optional.** An Opportunity may exist before any formal Relationship. No fake,
placeholder, prospective or inferred Relationship is created. Where a valid Relationship exists, the
Opportunity may reference it.

**PD-F-06 — Opportunity policy.** Opportunity is the canonical CRM commercial pursuit.

| Element | Decision |
|---|---|
| Categories | Governed, fixed Opportunity categories |
| Stages | Organization-configurable stages within the governed lifecycle |
| History | Append-only stage and state transition history |
| Forecast | Explicitly human-authored forecast probability, with attribution and timestamp on every change |
| Outcomes | Governed closed-won / closed-lost outcomes, with governed loss reasons |
| Close approval | None at launch, unless another existing authority already requires one (none does today) |
| Creation from Intake | An explicit act. It requires a governed, established Party. Intake remains Intake and is never transformed into an Opportunity. |
| What AI may do | Summarize; identify evidence; recommend stage, forecast or next action |
| What AI may not do | Silently author or modify stage, human forecast, close state or commercial outcome |
| Prohibited | Using `Customer.status` / `pipelineStatus` as the canonical pipeline; reusing the CallGrid/shared `Opportunity` finding type as the CRM authority |

**Readings recorded with the decision** (fail-closed; confirm or change in PD-F-12):
1. **Lifecycle categories are OPEN, CLOSED_WON and CLOSED_LOST.** The decision names only closed-won and
   closed-lost outcomes, so the proposed WITHDRAWN category is not adopted. A withdrawn pursuit closes
   as CLOSED_LOST with loss reason WITHDRAWN.
2. **Starting governed loss reasons:** PRICE, TIMING, NO_DECISION, COMPETITOR, NOT_QUALIFIED, WITHDRAWN,
   OTHER (a note is required).
3. **Stage configuration** is organizational settings authority (`settings:update`, OWNER/ADMIN today).
   Stage sets are versioned, and a transition records the stage-set version it used.
4. **Reopening a closed Opportunity** requires a reason and is an appended transition. Grants are in
   PD-F-11.
5. **The forecast** is human-authored probability plus attribution and time. The decision names only
   probability. Amount (integer minor units and ISO currency) and expected close date stay proposed
   human-entered fields until confirmed (PD-F-12).

### 3.4 Minimum contract the UI may design against (shape only; not built)

| Part | Content |
|---|---|
| Identity | `(organizationId, opportunityId)`, title |
| State | `category`: OPEN / CLOSED_WON / CLOSED_LOST; `stage`: an organization-configured label within OPEN, from a versioned stage set; `outcome` and `lossReason` when closed; human forecast probability with `authoredBy` and `authoredAt` (or Unknown); forecast history. Amount and expected close date shown as pending fields. |
| Context | Participants (established Party refs + roles + sides) through the CRM Participant authority; an **optional** Relationship ref; Intake Record refs (the Intake it was created from, if any); Campaign refs |
| Activity | `activity.v1` (OPPORTUNITY reserved until built) |
| Intelligence and Action | CI Findings and Recommendations by reference. AI *recommendations* for stage, forecast or next action are shown as recommendations with evidence, never applied. Work references. Actions (advance stage, update forecast, close, reopen) appear only when the server says the viewer may act. |

**The UI must not:**
- present intake status or `ServiceRequest` as stages;
- compute or default a probability, or present an AI recommendation as the forecast;
- label CallGrid "opportunity" findings as Opportunities;
- show participants that are not established Parties;
- require or fabricate a Relationship;
- assume who may close or reopen.

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

### 4.3 Product decisions (approved 2026-09-15)

**PD-F-07 — Campaign policy.** CRM owns canonical commercial Campaign truth.

| Owner | Owns |
|---|---|
| **CRM** | Campaign identity; commercial lifecycle; agreed commercial terms or their reference; commercial participants *when that capability is activated*; association to Relationships and Opportunities |
| **Accounting** | Transactions, invoices, payment and settlement |
| **Execution domains** | Their execution truth (CallGrid calls, creator deliverables, …) |
| **Measurement** | Governed outcome and performance facts |

**Rules:**
- A CRM Campaign may reference **multiple provider or execution campaigns over time**.
- Execution truth is never duplicated into CRM.
- Winning an Opportunity **does not** create a Campaign. Campaign creation is an explicit governed act.
- Campaign lifecycle is **never inferred** from traffic or provider activity.

**Readings recorded with the decision** (fail-closed; confirm or change in PD-F-12):
1. **Lifecycle states (proposed):** DRAFT, AGREED, ACTIVE, PAUSED, ENDED, CANCELLED. Human-declared,
   effective-dated transitions.
2. **One provider campaign links to at most one CRM Campaign in any effective period.** This prevents
   one provider campaign's measurement being composed into two commercial programs at once.
3. **Participation stays deferred** until activated. The UI shows an honest unavailable state.
4. **Objectives scoped to a Campaign stay deferred.**

### 4.4 Minimum contract the UI may design against (shape only; not built)

| Part | Content |
|---|---|
| Identity | `(organizationId, campaignId)`, name |
| State | Commercial lifecycle state (proposed vocabulary, §4.3), with effective dates and transition history |
| Context | Relationship refs; Opportunity refs; agreed commercial terms (human-declared, effective-dated) or a reference to them; participants: **unavailable** until activated |
| Execution | Provider campaign links (provider, external id, effective period, declared by, declared at), with composed CallGrid execution and measurement facts each labeled with its owning authority; invoices and payments shown only from Accounting when it exists (unavailable today) |
| Activity | `activity.v1` (CAMPAIGN reserved until built) |

**The UI must not:**
- present the CallGrid Campaigns dimension as CRM Campaigns;
- show provider traffic as commercial state;
- copy measurement into Campaign fields;
- create a Campaign on Opportunity win;
- host Campaigns on the Workspace Organization page.

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

## 6. Confirmations still needed (non-blocking for UI design)

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| **PD-F-11** | Grants for the new `opportunities` and `campaigns` resources | View: all human workspace roles. Create/update (Opportunity stage, forecast, close; Campaign details and terms): EMPLOYEE+. Reopen an Opportunity, transition Campaign lifecycle, declare provider campaign links: MANAGER+. Void: OWNER/ADMIN. AI_EMPLOYEE hard-denied writes and view (as PD-F-04). | Opportunity and Campaign service slices |
| **PD-F-12** | Confirm the readings in §3.3 and §4.3: categories OPEN / CLOSED_WON / CLOSED_LOST with WITHDRAWN as a loss reason; starting loss reasons; forecast amount and expected close date; Campaign lifecycle states; one CRM Campaign per provider campaign per period | Confirm as written | Opportunity and Campaign contract slices |

## 7. Decisions log

| Date | Decision |
|---|---|
| 2026-09-15 | PD-F-02 approved: Relationship optional for Opportunity; no placeholder Relationship |
| 2026-09-15 | PD-F-06 approved: fixed categories, organization-configurable stages, append-only history, human-authored attributed forecast probability, closed-won/closed-lost with governed loss reasons, no close approval at launch, explicit creation from Intake requiring an established Party, AI recommends but never authors stage, forecast, close or outcome |
| 2026-09-15 | PD-F-07 approved: CRM owns Campaign identity, lifecycle, terms, participants (when activated) and associations; Accounting owns transactions, invoices, payment and settlement; multiple provider campaigns over time; no automatic Campaign on win; lifecycle never inferred from traffic |


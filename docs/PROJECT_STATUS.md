# EMG Loop — Project Status (where we left off)

The living "current state" per workstream, so any session (or Matt) can resume without
losing the thread. **One current-state block per workstream — overwrite it, don't append.**
Read this at the start of a session; update it at the end of a work batch. History lives
in git, not here.

_Last updated: 2026-07-31._

---

## How to read this
Each workstream is either **DONE (merged)**, **IN REVIEW (open PR)**, or **NOT BUILT**.
"NOT BUILT" surfaces show honest "Not Configured / unavailable" states — never fake data.

## ⚠️ Cannot be validated in the dev environment
There is **no database, no runtime, and no email** in the dev sandbox, so anything below
marked _(needs deploy validation)_ is verified only by typecheck + build + unit tests —
NOT by seeing it render or run. Those must be checked on the deploy.

---

## Dashboard — DONE (merged: #128/#129)
`/app/admin` is the one-screen 9-tile command center. Honest tiles only
(Verified / Derived / Unknown / Unavailable). CallGrid **scorecard**: Yesterday (Completed)
vs Today (Live) × Revenue / Profit / Billable / Total, with per-metric % trend. Business
Status = system connectivity, never invented health. Eastern-time day boundaries.
_(needs deploy validation: one-screen fit + real values.)_

## CallGrid Intelligence & Brain — DONE (merged: #136)
**Ownership split — every component has exactly one owner.** `/app/admin/brain` is now the
real **Brain** page and owns the entire Executive Brain (Executive Summary, System Health,
Cross-Sensor Insights, What Changed, Top Risks/Opportunities, Recommended Actions, Evidence
Coverage/Sources, Confidence) + the Evidence/Platform-Health rail + Live Calls — moved
verbatim. **CallGrid Intelligence** (`/app/admin/marketplace`) was rebuilt to EXACTLY five
tile sections: Today, Yesterday (Revenue/Profit/Billable/Total via `marketplaceCalls.aggregateWindow`
+ shared `toScore` truth-states), Top Performers (`loadDimensionWindows`), Watch List
(`report.risks` only — never a false all-clear), Quick Access (6 navigate-only tiles). Six
drill-downs unchanged (Buyers/Vendors/Sources/Campaigns/Activity/**Bids**). Brain is now a
sidebar item (icon `brain`); CallGrid uses `chart`.
**Follow-up:** the Bids page (`/marketplace/auction`) is still a raw-table surface — needs a
real drill-down pass. _(needs deploy validation: real values + reconciliation.)_

## CallGrid Intelligence — MERGED through #150; operational review IN PROGRESS (branch `feat/callgrid-operational-review`, off main `5e1c51e`)

**Merged (#149, #150).** The pass that turned `/app/admin/marketplace` from a reporting
copy of CallGrid into an explainable workspace, then into an operations centre.

- **The root cause of the distrust, fixed.** `today` and every trailing-N-day preset compared a
  PARTIAL window against N COMPLETE prior days — at 9am "Today" reported a ~-85% revenue collapse,
  every morning, forever. Every in-progress window is now cut against the same **wall-clock** point
  of its own period. Same class: `this_month`/`year_to_date` clamping, custom ranges ending at a
  future midnight, future-only ranges.
- **Second root-cause fix (data layer).** `aggregateWindow` did `revenueCents += rev ?? 0` with no
  coverage counter, so an unpriced buyer was indistinguishable from one that earned $0. Per-row
  coverage counters added; unknown revenue renders "Unknown" and **sorts last in both directions**.
- **Built:** canonical metric contract · deterministic intelligence engine (findings with evidence,
  limitations, unknowns, ruleId/version) · historical series + Intelligence Score + Marketplace Risk
  + anomalies + per-entity intelligence, every statistic declaring a minimum and **withholding**
  (never zeroing) a component it cannot measure · decision support · operational reasoning
  (root cause = arithmetic attribution, never mechanism) · Business Health (UNKNOWN, never HEALTHY,
  when unmeasurable) · reconciliation harness under Administration → Diagnostics.
- **Deleted (replacement rule):** `callgrid-dimensions.ts`, `callgrid-watch.ts`.

### THE DECISION CENTER — DONE (merged #151; migration replay fix merged #152)
Turns the Overview from an analytics surface into a queue that is **cleared**, with decisions
that survive a refresh. Built outside-in: queue → lifecycle → persistence → history, coupled
deliberately because a button that forgets is worse than no button.

- **Situations before ranking.** The engine ranked *findings* (one rule × one metric × one window),
  so one business event arrived as four competing rows. Clustering now runs BEFORE scoring. Merges
  only over relations already measured; co-occurrence in a period is not a ground (proven by test);
  a Situation inherits the WORST severity so merging can never soften urgency.
- **Platform primitives, not CallGrid tables.** `operational_priorities` + `operational_observations`
  (+4 enums). `sourceSystem` names the producer; CallGrid is the FIRST one, not the owner. CRM,
  Accounting, Marketing, Website, Support, Compliance and Creator intelligence write through the
  same surface with no migration.
- **Named the Decision Center** (Matt, 2026-07-30). Architecture-level name only — the identifiers
  stay plain because they describe a row's shape; the Decision Center is what the collection IS.
  This is the one place in Loop where a decision is made, owned and closed, whatever noticed it.
- **Event-sourced.** The observation log is the truth; the state columns are a documented,
  rebuildable cache written in the same transaction. `projectLifecycle` (pure, in `@emgloop/shared`)
  is the single definition of "current state". Ordering is by **sequence** (the order Loop learned
  things), not occurrence, so a backdated note cannot reorder decisions made before it.
- **Idempotent detection.** `(priorityId, detectionKey)` unique binds only detection rows, so the
  server-rendered Overview records ONE sighting per analysis period no matter how often it renders.
  A sighting from a period that ended before an existing resolution does **not** reopen it —
  browsing history is reading, not relapsing.
- **Real lanes and real controls.** Assign / watch / resolve / dismiss / note / contact / outcome,
  each a guarded server action writing an immutable observation. Lanes count every open priority,
  not just this period's; Open Work survives a date-filter change.
- **Decisions section** — the only surface that measures the product: false-positive rate, reopen
  rate, median time to close, measured effect. Every rate is withheld with a reason rather than
  rendered as 0%, and below 4 closed items it says "not enough history yet".
- **Retired:** `laneAvailability` / `SituationQueue.lanes` / `.counts` and the "Loop cannot remember
  operator decisions" copy everywhere it appeared, including the lifecycle unknown.

**Validated:** 423 shared tests · 210 database tests · typecheck clean (shared/database/web) ·
`turbo build --filter=@emgloop/web` passes · `prisma validate` clean. Migration is additive only
(0 DROP / 0 rename / 0 column-type change), ASCII header.

**⚠️ GATE — merged, but still not live in production.** The code half is done and merged (#152). The `sprint_11`
em-dash is fixed on its own branch and the full 11-migration chain is **verified to replay from an
empty Postgres 16 with no drift** (71 tables). What remains is human-run against production: back
up + restore-test, `migrate resolve --applied` every existing migration (resolve, never run), then
`migrate deploy`, then upgrade the Netlify build from `prisma generate` to
`migrate deploy && generate` as a separate reviewed change. See
`docs/architecture/migration-remediation-plan.md`.

**⚠️ Still open, unchanged by this branch:**
1. **Phase 1 production reconciliation has never been run.** Every health band, opportunity amount
   and evidence-strength badge inherits whatever the metric layer gets wrong. The instrument exists
   and is empty: `docs/validation/callgrid-production-reconciliation.md`. It needs a human with both
   Loop and CallGrid credentials — CallGrid has **no working aggregate stats endpoint**
   (`POST /api/reports/stats` has never returned 200), so this cannot be automated.
2. **Bids page redesign** — still a raw-table surface; its "closed targets overnight" example is
   unreachable because the snapshot carries no hour-of-day dimension.
3. ~~Permissions question~~ **ANSWERED (Matt, 2026-07-30): leave `intelligence:update` at
   OWNER/ADMIN.** Managers have no defined operational role yet. When CRM lands and roles like
   Operations/Sales/CSR/Accounting Manager exist, those permissions come from the MATRIX — not from
   CallGrid, and not invented ahead of the roles they serve.

**Honest limits held:** bid data is snapshot-only so **no bid trend is shown anywhere**; campaign/
vendor profit is not attributable at that grain and says so; entity counts mean "observed this
period" (CallGrid exposes no roster). **No LLM anywhere** — every string is deterministic template
language.

## The Decision Engine — DONE (merged #154)
The final platform layer between intelligence producers and every consumer. **CallGrid now
consumes it and touches persistence nowhere** — `repositories.operationalPriorities` appears
zero times in the producer.

- **One event bus.** `StateChangeOutbox` generalized additively: `subjectType` (ACTIVE_STATE /
  DECISION / WORK_ITEM / MEMORY / KNOWLEDGE / IDENTITY), `subjectId`, `eventType`, and
  `identityId` now NULLABLE — most decisions describe the business, not a person. No second
  outbox, no DomainEventOutbox, no fabricated identities. Existing active-state publishing,
  deliveries, retries and subscriptions untouched.
- **`packages/database/src/services/decision/`** — `DecisionEngine` is the only producer-facing
  surface. 17 methods. Every state change is one transaction: resolve in-org → validate
  transition → append immutable observation → rewrite projection from the whole log → publish
  exactly one domain event → commit.
- **Owner ≠ assignee ≠ state**, three independent dimensions. Ownership is accountability and
  changes rarely; assignment is execution and changes often; neither derives the other or the lane.
- **`ignore()` is an action; the outcome says why.** Outcomes extended additively with DUPLICATE,
  MERGED, SUPPRESSED, EXPIRED, CONVERTED_TO_WORK. The work destination lives on the observation,
  so the engine never names Work OS or CRM.
- **Evidence is a table now** (`decision_evidence`), append-only, carrying rule/formula/
  calculation/producer versions, raw/normalized/derived values, completeness, limitations and
  unknowns. The #153 JSON snapshot remains as the opening picture.
- **Docs:** `docs/architecture/decision-engine.md` — purpose, boundaries, both contracts, the four
  models, outbox integration, replay/idempotency guarantees, how to add the next producer, and a
  **Not built** section.

**Validated:** 429 shared · 250 database tests · typecheck clean (shared/database/web) · web build
passes · **from-zero replay against PostgreSQL 16: all 12 migrations apply to an empty database,
`migrate diff` reports no drift, 72 tables.** Both new migrations additive — 0 DROP, 0 rename.

**⚠️ NO SUBSCRIBER CONSUMES DECISION EVENTS YET.** The engine publishes, and as of PR #157 a drain
actually delivers to matching subscriptions — but none are registered for `DECISION` subjects.
Registering the first one (Work OS) is what closes ENGINEERING_PRINCIPLES **Rule 6**.

**NEXT after that: CRM as the second producer.** Per Matt, not until the Decision Center is
genuinely reusable. The engine test suite is written from an ACCOUNTING and WEBSITE producer's
position precisely to keep that answer honest.

## Decision Event Contract + the outbox drain — IN REVIEW (draft PR #157) · branch `feat/decision-event-contract` (off main `5352aef`)
The prerequisite Matt asked for before the first subscriber: define what leaves the engine, then
make it actually leave.

- **The contract is CODE, not prose** — `packages/shared/src/decision-events.ts`. Prisma-free, so
  subscribers depend on the contract and never on persistence. `packages/database` re-exports the
  map under `Record<OperationalObservationType, DecisionEventName>`, so the schema and the contract
  fail to compile the moment they disagree. There is no second table.
- **Two phantom events caught before a line of subscriber was written.** `DecisionDismissed` and
  `DecisionMerged` do not exist and never did — dismissal announces `DecisionClosed`, and a merge is
  an OUTCOME arriving as `DecisionResolved`/`DecisionClosed` with `outcome: 'MERGED'`. A handler on
  either name compiles, registers and never fires. Tests assert their absence.
- **The payload was an untyped object literal.** A renamed field would have broken every subscriber
  at runtime with no compile error anywhere. Now built as `DecisionEventPayloadV1`. It deliberately
  carries no title/severity/impact: a payload duplicating the row goes stale, and copying business
  content into an outbox row widens what a delivery bug can leak.
- **Nothing drained the outbox.** Rule 6 held in form (the engine names no subscriber) while no
  subscriber could receive anything. `OutboxDrainRunner` + `POST /api/internal/outbox/drain` +
  `.github/workflows/drain-outbox.yml` close it. **The trigger is replaceable by construction** —
  the runner owns what a pass IS, the route owns only auth, the workflow only the schedule.
- **A dead worker used to strand a delivery forever.** `claim()` covered PENDING/FAILED only, so a
  timeout or a mid-dispatch deploy left a row that was never retried, never dead-lettered and never
  surfaced. `reclaimStale()` recovers it, or dead-letters it once attempts are spent so a poison
  handler surfaces instead of looping. `at-least-once` moved PARTIAL → GUARANTEED on that basis.
- **The contract polices itself.** Tests fail if the drain trigger disappears, if `reclaimStale` is
  deleted, if the route ever starts reading an organization, or if a PARTIAL guarantee stops naming
  what is missing. It cannot describe a system that does not exist, and cannot keep describing one
  that has since been built.
- **A test-double bug fixed underneath it all:** the in-memory Prisma fake returned on the FIRST
  operator in a condition, so `{ not: null, lt: cutoff }` matched every non-null row — a filter
  narrowing by age would have passed its test while doing nothing. `distinct` and column defaults
  were also missing. No production code changed; 259 existing tests passed unmoved.

**Validated:** 471 shared · 269 database (10 new drain tests, 9 contract-binding) · typecheck clean
(shared/database/web) · web build registers the route. **No migration.**

**⚠️ NOT LIVE UNTIL CONFIGURED.** `OUTBOX_DRAIN_SECRET` in the deployment, plus `OUTBOX_DRAIN_URL`
and `OUTBOX_DRAIN_SECRET` as repository secrets. Unconfigured, the endpoint fails closed with 401
and nothing is delivered — which is why `delivery-execution` is PARTIAL, not GUARANTEED. Verify
with a manual `workflow_dispatch` run.

**NEXT: the Work OS subscriber**, now that it would land on a spine that provably delivers. Note
the existing cognitive `work-os` handler is NOT a Work OS integration — it is identity-scoped
(`identityId` is null for most decisions by design, so it no-ops on nearly all of them) and records
a `CognitiveDecision`, creating no `WorkInstance`.

## Decision Center experience — #155 and #156 merged

The surface pass that turned the Decision Center from a report into an inbox (#155), then
made it a *platform* surface rather than CallGrid's page (#156).

- **Split by coupling, not convenience (#156).** The engine, contract, persistence and events
  were already producer-neutral; the EXPERIENCE was not — all of it lived in `marketplace/`,
  so producer #2 would have had to import from a CallGrid folder or fork the surface.
  `app/app/admin/_decisions/decision-ui.tsx` now holds the producer-neutral half (MissionBrief,
  LaneRail, ConfidencePill, OwnershipTag, DecisionActions, DecisionTimeline,
  DecisionActivityPanel, OpenWorkPanel, UnknownGroups, TierHead) and takes platform types only.
  Server actions arrive as a `DecisionActionSet` prop, so it imports no producer's action module.
- **What is honestly still coupled:** the queue and the card body read `Situation`, a CallGrid
  type, and stay in `marketplace/queue-ui.tsx`. Lifting them would mean dragging CallGrid types
  into the platform folder or inventing a shape the canonical contract cannot fill (those fields
  are still RESERVED). The file header names this rather than implying the split is finished.
- **The route deliberately does NOT move.** `/app/admin/decisions` is not earned until a second
  producer publishes decisions — extracting it today would rename a CallGrid page and call it a
  platform (Matt, 2026-07-31). The split is done now so that later move is a file move.
- **Resolve is a primary action** with a one-question confirmation, not a one-click close: a
  blind resolve would make UNKNOWN the default recorded outcome, and the false-positive rate the
  activity panel publishes is only worth something if that field is real. Recovery is folded into
  the outcome rather than asked separately — two fields that can disagree would corrupt the only
  dataset Loop has for judging its own recommendations. Prior closures render ABOVE the outcome
  field, so history is visible before it is added to.
- **Presentation became a tested contract.** `ownershipOf` / `outcomeChoices` / `priorClosure` /
  `groupUnknowns` / `storyDigest` are pure functions in `@emgloop/shared`, asserted by invariant
  (grouping conserves every choice; tiering conserves every item; recovery outcomes only when
  something measurable exists to recover) rather than by output.
- **Retired:** `_MarketplaceDecisionQueue.tsx`, the loop-os `AttentionRow` queue this supersedes.

**Validated:** 457 shared tests (28 new) · typecheck clean (web/shared/database) · web build
passes · server components only, no new client JavaScript. **No migration** — no schema change.

**NEXT (Matt, 2026-07-31): "Operator Velocity" — Decision Center v2, zero backend.** Reduce
reading, increase scanning: hierarchy instead of paragraphs, decision cards closer to
Linear/GitHub Issues, a visual timeline instead of text, a fully actionable Mission Brief,
confidence as a visual scale, and history surfaced as a first-class product surface
(seen N times · resolved · returned · average recovery · typical owner).

## Canonical Decision contract + Engineering Principles — DONE (merged #153)
The platform-layer pass Matt asked for before CRM: define the canonical Decision, write the
laws down, and answer "could Accounting use this tomorrow" honestly.

- **`decision-contract.ts`** — one model for every producer: producer registry, one shared
  severity vocabulary (a cross-producer queue cannot rank CRITICAL against P1), impact-unit
  vocabulary, evidence-snapshot shape, and `DECISION_FIELDS` marking every field
  **PERSISTED** or **RESERVED**.
- **The anti-`EVENT_BUS.md` device.** A test walks `DECISION_FIELDS` against the real Prisma
  columns in BOTH directions: a PERSISTED field with no column fails, and a RESERVED field
  that quietly gained one fails too. Every RESERVED field must state what has to happen
  before it exists. The contract therefore cannot describe a system that does not exist.
- **Reserved, honestly:** `impactUnit` (today's column is `impactCents`, which assumes every
  producer measures money — false for Website/Support/Compliance), `costCents`, `category`
  (deliberately NOT invented from CallGrid alone), `tags`, sortable `confidence`,
  `relatedDecisionIds`, `dueAt`.
- **Two gaps found and closed, both introduced in #151.** (1) Evidence was never persisted —
  the engine recomputes on every render so an OPEN decision always looked right, but a
  decision closed weeks ago under a since-changed rule version kept its conclusion and lost
  its reason. Now snapshotted into the immutable opening observation, limitations and
  unknowns included, truncation disclosed. No migration — the `evidence` column already
  existed and was never written. (2) `hypothesisId` was a dead FK; now populated on first
  sighting **in the same transaction** (proposing first would orphan a belief on a race),
  always PROPOSED / DETERMINISTIC_RULE.
- **`docs/ENGINEERING_PRINCIPLES.md`** — Matt's 8 platform invariants. Each carries the rule,
  the scar, what a violation looks like, and **what enforces it — including "nothing yet"**.
  `CLAUDE.md` links to it and keeps process; the invariants doc owns system laws. No
  restatement in both, so they cannot drift like the four architecture docs did.
- **⚠️ Rule 6 (publish, don't couple) is the largest open gap and says so.** The cognitive
  outbox + `StateChangeSubscription` + a `WORK_OS` subscriber type all exist (#148) and the
  Decision Center **does not publish into them**. The rule holds today by discipline, not
  enforcement.

**Validated:** 423 shared · 225 database tests · typecheck clean (shared/database/web) ·
web build passes. No schema change, no migration.

**Superseded by #154**, which built that facade. Rule 6 remains open until a subscriber
actually consumes `DECISION` events — see the Decision Engine block above.

## Work OS — DONE (merged #130, CSS #132); Start Work + Work Types (#135)
Dashboard-matched one-screen tile grid, business terminology, **Team Work** page, centralized
route→product resolver. **Start Work rebuilt (#135)** as a centered sectioned form; **Work
Types = Blueprint** (adapted, no new table — deploy runs only `prisma generate`), config in
`Blueprint.metadata`; starter catalog + admin at `/app/admin/administration/work-types`.
_(needs deploy validation: real work data.)_

## Configurable sequential workflows — ENGINE DONE (merged #137); Start Work UI IN REVIEW (#138)
Backend engine built on existing tables (Work Type = Blueprint `kind='work_type'`, Workflow
Template = Blueprint `kind='workflow_template'` + stages, Work Item = WorkInstance, Work Step
= WorkStage — all per-step config in `metadata`). **Engine merged (#137):** 5 assignment modes
(specific / responsibility / creator / previous-completer / unassigned) with fail-closed
resolution; sequential handoff (only step 1 active → complete → resolve+activate exactly the
next → final completes item + notifies all participants); workflow-template save /
list-by-work-type / reuse / duplicate / activate; custom-field defs; member **de-dup + email
normalization** source fix.
**Start Work UI (#138, draft):** the six-section builder — Select Work Type (+ inline Add-New-Type
modal) · Work Info + type-specific custom fields · Select/Build workflow (saved template / build /
single-person; save-as-template) · vertical step-assignment review · Priority + optional Eastern
target · Review & Start. Drives `createWorkItem`. Removed the redundant globals (Related-To
selector, free-text Reference, Responsibility dropdown, Assign-To radio + Team Member, flat
Requirements). Engine gained `WorkTypeView.fields` + a workflow-aware `buildWorkItemSubmission`
(replaces the single-owner `buildWorkSubmission`). Typecheck+build clean, DB suite 150/150.
- ⚠️ **`ResponsibilityAssignment` model does NOT exist** (spec assumed it) — responsibility
  resolves via a configurable org owner-map; absent ⇒ Needs an Owner (never fabricated).
- ⚠️ **Duplicate "Matt Dunn" is DATA, not a query bug**: the demo-seed OWNER `admin@emgloop.com`
  got renamed to "Matt Dunn" during setup and coexists with Matt's real account. Dedup collapses
  same-id/same-email; the two distinct-email rows need the seed `admin@`/`manager@`/`viewer@`
  rows **removed once via the Team page** (persists since #134).
- **NOT built yet:** the Work Detail timeline + Complete-My-Step (increment 2), the Workflow
  Template admin page (increment 3), and the custom-field **config** UI (defs render when present;
  no Type defines any until the config UI ships).

## Onboarding / invitations / team lifecycle — DONE (merged: #129, #133, #134)
Absolute invite/reset URLs; team management at `/app/admin/administration/team`. **Lifecycle
hardened (#133):** invite/re-invite go through `prepareInvitation` (no more P2002 Team-page
crash; reinstates the one `(org,email)` row); login gates on ACTIVE. **Fake-member seed fixed
(#134):** demo identities (Morgan/Riley/etc.) only seed when `isDemoSeedEnabled` (explicit flag
+ non-production); a seed can never reactivate a removed member. Pre-existing seed rows still
need one-time removal via the Team page. _(needs deploy validation: fresh-invitation journey.)_

## Business timezone — DONE (merged)
`BUSINESS_TIME_ZONE = 'America/New_York'` in `@emgloop/shared` (DST-aware via Intl). Every
calendar-day boundary (today/yesterday/completed-today) is Eastern. Rolling N-day windows
stay duration-based (timezone-independent).

## Global sidebar — DONE (merged)
Flat: Dashboard · **Brain** · CallGrid Intelligence · CRM · Creator Hub · Work OS · Accounting ·
Administration (footer: Team · Work Types, permission-aware). One shared shell; longest-prefix
active-state.

## Loop Cognitive Architecture — INCREMENTS 1–3 IN REVIEW (draft PR #148) · branch `feat/loop-cognitive-architecture-foundation` (off main `553ec08`)
A 4-increment controlled build of the canonical cognitive foundation (identity / durable
memory / governed knowledge / explainable active state / governance / outbox / subscriptions /
hypotheses / decisions); see `docs/architecture/loop-cognitive-architecture.md`. **Increment 1
(base):** 16 additive Prisma models + 30 enums (`schema.prisma` §cognitive), 16 org-scoped
repositories under `packages/database/src/repositories/cognitive/` (barrel `repositories.cognitive`),
org-salted HMAC hashing, migrations `20260723000000`/`20260723000001` (additive, 0 ALTER/DROP).
Canonical: `CognitiveIdentity` (not CRM Customer), `MemoryEvent` (immutable), `KnowledgeAssertion`
(class-preserving), `ActiveStateRecord` (evidence-required projection). `marketplace-intelligence`
marked DEPRECATE. **Increment 2 (processing pipeline) shipped on top of Increment 1.** The
`CognitiveEventProcessor` (9 stages: idempotency → normalize → resolve identity →
durable memory → governance → knowledge → active-state → transactional revision →
status) runs entirely through the Increment 1 repositories — no parallel persistence,
no direct Prisma from evaluators, no governance bypass. Pure evaluators:
`GovernanceEvaluator` (deny-by-default), `KnowledgeEvaluatorRegistry` (7 event types),
`ActiveStateEvaluatorRegistry` (Commerce/Communication/Work/Campaign). New model
`CognitiveProcessingAttempt` (retry/dead-letter; migration `20260723000001`). **Seam
reuse:** `LoopEventConsumer` drains the existing `LoopEvent` store via its previously
zero-caller `processed`/`markLoopEventProcessed` methods — **no second public receiver**;
org resolved from `platform` via an injected server-side resolver, never the event body.
**Increment 3 (governed read surface + publisher) shipped on top of Increment 2.**
`CognitiveContextService` is the deny-by-default READ surface — `getIdentityContext`
+ `explainActiveState` map stored rows to the Prisma-free `cognitive-context.v1` DTOs
in `@emgloop/shared` (readers depend on the contract, never persistence). Omits
expired/revoked/suppressed/unpermitted data (disclosed in `unknowns`), LABELS
stale-but-live state, never leaks raw memory payloads; explains state "supported by,
never caused by" from rows only. `StateChangePublisher` drains the transactional
outbox → one `StateChangeDelivery` per matching ACTIVE subscription: exactly-once per
(change, subscriber) via `(outboxId, subscriptionId)` unique + atomic single-claim,
independent per-subscriber retry/dead-letter, REQUIRED-subscriber dead-letter fails the
parent while OPTIONAL never blocks. Four internal subscribers (audit / decision-eval /
work-os / dashboard-invalidation) — none execute an external action; audit records a
safe summary only. `DecisionPolicyRegistry` (pure): 3 declarative policies over governed
context, deterministic order-independent precedence (SUPPRESS>QUEUE>RECOMMEND>NO_ACTION);
decisions RECORDED (idempotent by revision+policy+version), never sent; CREATE_WORK is
approval-required. New model `StateChangeDelivery` + `DeliveryStatus`, `+required` on
subscriptions, `+idempotencyKey` on decisions (migration `20260723000002`, additive-only).
**Validated (current HEAD):** **197 tests pass / 0 fail**; typecheck (`@emgloop/database`/`shared`/`web`)
+ `turbo build --filter=@emgloop/web` clean; `prisma validate` clean. *(Fixture-determinism
fix: the Increment-3 publisher tests pinned events to a hardcoded 2026-07-23 `occurredAt`;
once the calendar passed the 1-day active-state TTL the governed read surface correctly
omitted the now-expired state and two tests failed. Fixtures now anchor `occurredAt` near
real now — no injected clock reconciles fixture-time TTLs with wall-clock outbox/policy rows.
Production behavior unchanged.)* **RELEASE BLOCKER
(tracked, not fixed here):** `docs/architecture/migration-remediation-plan.md` — the
`sprint_11` migration's leading em-dash blocks `migrate deploy` replay; prod has no
`_prisma_migrations` table. Cognitive architecture is **NOT production-ready** until
that plan's exit criteria are met. The remediation plan now lists **all three** cognitive
migrations in order (`…000000`/`…000001`/`…000002`) and their role in the future baseline.
PR #148 is Draft, titled *Increments 1–3*, body reflects 197 tests + three migrations. **Next:**
Increment 4 (real-time product-click vertical slice + admin-only validation page
`/app/admin/administration/cognitive-architecture`, simulator disabled in production unless an
explicit safe flag is set) — not yet started; all Increment-3 gates pass.

## CRM · Creator Hub · Accounting — NOT BUILT
Approved operating areas, shown in the sidebar, but not built/connected. They render honest
"Not Configured / unavailable" states and **never** show fabricated data. (CRM specifically
must never surface CallGrid caller records as contacts — the `Customer` table is shared.)

---

## Open threads / next steps
1. **Configurable workflows — engine merged (#137); Start Work builder in review (#138).** Next
   UI increments on a fresh branch off main: (2) Work Detail timeline + Complete-My-Step
   (handoff/complete), then (3) Workflow Template admin page + custom-field config UI.
2. **Data repair (Team page, one-time):** remove the demo-seed rows `admin@emgloop.com`
   (renamed "Matt Dunn"), `manager@emgloop.com` (Morgan), `viewer@emgloop.com` (Riley) so
   assignee/member lists show real people only. Recreation is already gated (#134).
3. **Deploy validation** (only on the deploy): Dashboard/Work OS fit; fresh-invitation journey;
   CallGrid scorecard reconciliation; Brain page renders the moved Executive Brain.
4. **Platform floor** (CLAUDE.md Long-Term Goals): commit the lockfile; a CI gate on `main`; a
   **web test harness** (route/render/permission tests can't run without one today).
5. **CallGrid deploy validation** — still unrun, and still the gate on trusting any figure the
   intelligence layer reports. See the CallGrid block above for the exact per-period checklist.
6. **Migration remediation — code half DONE (draft PR #152), production half OUTSTANDING.**
   The em-dash fix is verified by from-zero replay against real Postgres. The remaining steps are
   human-run against production data: back up + restore-test, baseline with
   `migrate resolve --applied`, `migrate deploy`, then upgrade the Netlify build step separately.
   Until those run, any branch that adds a table is code-complete but not live — currently #148
   and #151.
7. **The Decision Center sequence (Matt, 2026-07-31).** Architecture follows actual reuse, never
   speculation — each step earns the next:
   1. Merge #156.
   2. **Operator Velocity** — Decision Center v2 UI/workflow polish, zero backend.
   3. **Work OS as the FIRST subscriber** to `DECISION` events. This is what closes
      ENGINEERING_PRINCIPLES Rule 6, which currently holds by discipline rather than enforcement.
   4. Prove the event bus end to end.
   5. CRM onto the Decision Engine (producer #2).
   6. Accounting onto the Decision Engine (producer #3).
   7. **Only then** extract `/app/admin/decisions` as its own route — by which point #156 has
      made it close to a file move.

## Working agreement
**One branch per work batch.** After a PR merges, cut a fresh branch off freshly-merged
`main` for the next objective — never keep committing to a merged branch (it strands work
with no open PR). Always open a draft PR and report its URL; Matt merges.

# EMG Loop — Project Status (where we left off)

The living "current state" per workstream, so any session (or Matt) can resume without
losing the thread. **One current-state block per workstream — overwrite it, don't append.**
Read this at the start of a session; update it at the end of a work batch. History lives
in git, not here.

_Last updated: 2026-08-14._

---

## How to read this
Each workstream is either **DONE (merged)**, **IN REVIEW (open PR)**, or **NOT BUILT**.
"NOT BUILT" surfaces show honest "Not Configured / unavailable" states — never fake data.

**MERGED is not DEPLOYED.** Anything adding a database table is code-complete until somebody
dispatches the migration workflow by hand, so this file distinguishes **DEPLOYED** (the migration is
applied in production) and **PRODUCTION VERIFIED** (somebody loaded the surface and confirmed it
behaves). See *Production migration state* directly below.

## ⚠️ Cannot be validated in the dev environment
There is **no database, no runtime, and no email** in the dev sandbox, so anything below
marked _(needs deploy validation)_ is verified only by typecheck + build + unit tests —
NOT by seeing it render or run. Those must be checked on the deploy.

---

## Production migration state — ALIGNED THROUGH CI STAGE 2 (verified 2026-08-16)

**Production is, and has been since 2026-07-09, under Prisma Migrate management.** The long-standing
claim that it has no `_prisma_migrations` ledger and that no migration has ever been applied through
Prisma was **false**. It originated in `CLAUDE.md`, was repeated in PR #152's commit message, and
propagated into two later assessments before anyone checked the workflow run history. Both files are
now corrected.

| | |
|---|---|
| Engine | PostgreSQL 18.4 (Neon) |
| Ledger | `_prisma_migrations` exists · **15 rows** · 0 rolled back · 0 unfinished |
| Public tables | **74** |
| Aligned through | `20260816000000_ci_commercial_signals` — Commercial Intelligence Stage 2 |
| Last deployment | `Deploy Prisma Migrations` **run #6**, 2026-08-16 — applied migrations 8–15 |
| Restore point | Neon branch `pre-ci-migration-2026-08-15`, taken before the run |

**How it got here.** A one-off baseline recovery on 2026-07-09 marked the two pre-existing migrations
as applied via `migrate resolve --applied` — recorded, never executed, which is why both still show
`applied_steps_count = 0` — and created the ledger. Four `Deploy Prisma Migrations` runs then applied
migrations 3–7, the last on 2026-07-19. **Eight migrations then sat unapplied until 2026-08-16**, not
because the tooling was broken but because nobody dispatched the workflow.

**Deployment remains manual, deliberately.** Netlify runs `prisma generate` only. Migrations reach
production solely through the human-dispatched `Deploy Prisma Migrations` workflow. Wiring
`migrate deploy` into the Netlify build would let any branch — including preview deploys — mutate
production schema, run migrations concurrently across parallel builds, and couple a schema change to
a front-end deploy that can roll back independently. **Do not automate it without a separate
decision.**

**Open follow-up (not implemented, not authorized):** the repository should eventually gain a
read-only check that signals when `main` carries migrations production has not applied. Comparing the
migration count on `main` against `migrate status` would have surfaced this gap in a day rather than
three weeks. Tracked in `CLAUDE.md` §Long-Term Goals item 2.

**Consequence for any branch adding a table:** still code-complete, not live, until the workflow is
dispatched. The gate is clear, not removed.

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

**✅ GATE CLEARED 2026-08-16 — now live in production.** The code half merged as #152; the production
half ran as `Deploy Prisma Migrations` #6. Production holds all 15 migrations, 0 rolled back, 74
tables. See the *Production migration state* block near the top of this file. The Netlify build step
was deliberately **not** changed — migration deployment stays manual.

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

## Decision Event Contract + the outbox drain — DONE (merged #157; `main` = `1b71715`)
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
`sprint_11` migration's leading em-dash blocked `migrate deploy` replay. **RESOLVED:** the em-dash
fix merged as #152 and all three cognitive migrations were applied to production by
`Deploy Prisma Migrations` run #6 on 2026-08-16. The schema is live; whether the cognitive
*runtime* is production-ready is a separate question this line never answered. The remediation plan now lists **all three** cognitive
migrations in order (`…000000`/`…000001`/`…000002`) and their role in the future baseline.
PR #148 is Draft, titled *Increments 1–3*, body reflects 197 tests + three migrations. **Next:**
Increment 4 (real-time product-click vertical slice + admin-only validation page
`/app/admin/administration/cognitive-architecture`, simulator disabled in production unless an
explicit safe flag is set) — not yet started; all Increment-3 gates pass.

## Commercial Intelligence — STAGES 1 + 2 PRODUCTION VERIFIED · STAGE 3 NOT AUTHORIZED
**Stage 1 — Performance Objectives:** BUILT · MERGED (#158) · DEPLOYED · **PRODUCTION VERIFIED** 2026-08-16
**Stage 2 — Commercial Signals:** BUILT · MERGED (#159, main `ae3fc4e`) · DEPLOYED · **PRODUCTION VERIFIED** 2026-08-16
**Stage 3 — Headlines:** ARCHITECTURE ASSESSMENT COMPLETE · PRODUCT DEFINITION IN PROGRESS (Charlie + Lexi) · **IMPLEMENTATION NOT AUTHORIZED**
The first Commercial Intelligence concept to reach the schema, and deliberately the only one.
CI defines a **CI Signal as a data point tied to a performance objective**, and Loop had no such
concept anywhere — not a model, not a type, not a field — so "commercially relevant" had nothing
to be relevant TO. This batch builds that referent (human-authored intent) and stops there.

- **The contract is CODE** — `packages/shared/src/performance-objective.ts`, Prisma-free
  (`performance-objective.v1`), the rule `decision-contract.ts` and `cognitive-context.ts` already
  follow. Closed rejection vocabulary + `validatePerformanceObjectiveShape` as a pure function, so
  the form, the action and the repository cannot drift on what counts as invalid.
- **No metric, target, unit, baseline, attainment, progress or achievement state, and their absence
  is the design.** Loop cannot measure attainment today; a `targetValue` column would commit the
  platform to a measurement semantics nobody has approved and put a number on screen that traces to
  nothing. Status is `ACTIVE | ARCHIVED` only — there is no ON_TRACK/AT_RISK/ACHIEVED, because each
  is a claim about measured performance. Knowing WHAT MATTERS precedes calculating whether a number
  was hit, and the two are separate approvals.
- **Scope is `ORGANIZATION | USER`, and that is a constraint rather than a starting point.** Loop
  has no Team model, no Division, no Department and no reporting relationship, so a `TEAM` member
  would point at an entity that does not exist and a free-text team name would be a fabricated
  identifier some later query would have to pretend to resolve. A third member arrives when Loop has
  a canonical entity for it to reference.
- **Tenancy enforced at the data layer from line one, not retrofitted.** `organizationId` is the
  first required argument of every repository method; the row is resolved WITHIN the organization and
  fails closed to `null`; a cross-org id is NOT-FOUND, never forbidden. Every action checks the
  return value before writing audit — no audit row for a write that did not happen.
- **Real foreign keys with defined delete behaviour**, unlike the scalar-`organizationId`-no-FK
  precedent of Work OS / `vk_*` / cognitive / `operational_*`. Those carry known orphan-on-delete
  debt; a new table has no migration cost to being correct. Org CASCADE, `scopeUser` CASCADE (a
  USER-scoped objective whose user is gone violates the scope invariant), `createdBy` SET NULL
  (authorship is attribution and outlives the author leaving — `audit_logs.userId`'s reasoning).
- **A new RBAC resource, `commercialIntelligence`, deliberately NOT folded into `intelligence`.**
  That resource governs READING what Loop concluded and is granted down to READ_ONLY; authoring what
  the organization is trying to accomplish is a different act by different people, and reusing one
  resource would have silently handed every READ_ONLY user a write capability the day the form shipped.
- **⚠️ MANAGER is view-only, and that is a deliberate narrowing that reports a platform gap.** The
  intended policy — a manager manages objectives for the people they manage — is a sentence Loop
  cannot express: `MANAGER` is an authorization level in a static matrix, NOT an organizational fact,
  and "the people they manage" resolves to nothing. The only grant the matrix could actually issue is
  org-wide create/update, which is authority over arbitrary users arriving by implication. Widening
  needs a real platform relationship or an explicit product decision, never an inference from a role
  name.
- **Surface:** `/app/admin/administration/objectives` — a form and a list, server components only,
  existing `adm-*` classes, no new CSS, no new client JavaScript. No headline feed, no signal
  explorer, no score, no chart, no recommendation: none of those exist, and hinting at them would
  promise what the platform cannot do.

**Validated:** 482 shared (11 new) · 290 database (21 new) · typecheck clean (shared/database/web) ·
`turbo build --filter=@emgloop/web` passes and registers the route · `prisma validate` clean ·
**from-zero replay against PostgreSQL 16: all 14 migrations apply to an empty database,
`migrate diff` reports no drift, 73 tables.** Migration is additive only — 2 enums, 1 table, 3
indexes, 3 FKs, 0 DROP / 0 rename / 0 column-type change, no existing table altered, ASCII header.

**✅ LIVE — deployed and production verified 2026-08-16.** `performance_objectives` exists in
production. Smoke test: `/app/admin/administration/objectives` loads without error, and a real
objective — *"Grow roofing lead revenue in Texas"*, ORGANIZATION scope, Elite Media Group, effective
2026-08-15, open-ended — was created and shows as ACTIVE. The pre-deployment 500 risk on this page
(no try/catch, no error boundary, nav entry visible to all five roles) is **closed**.

### Stage 2 — Commercial Signals (IN REVIEW)
An observed fact evaluated **relative to** a Performance Objective, plus the reason it may matter.
The primitive, one deterministic evaluator to prove it, and nothing else.

- **`CommercialSignal` / `commercial_signals`, and the incumbent behavioural `Signal` is UNTOUCHED.**
  That model is customer/conversation enrichment written by `services/signal-registry.ts` and read by
  four repositories; the two share an English word and nothing else. Nothing was renamed, wrapped,
  aliased, migrated or read. The migration emits no DDL naming `signals`.
- **Selectively persisted — positive determinations only.** A row exists because an evaluator
  concluded an observation may matter. Evaluations concluding nothing write nothing, so the ABSENCE
  of a row means only that no positive determination was recorded — **never** that Loop examined
  something and dismissed it. Stage 2 keeps no negative-evaluation history. A projection was rejected
  outright: objective text is editable, so re-deriving after an edit would rewrite what CI believed in
  the past.
- **Fact and inference are structurally separate.** `CommercialSignalView` nests the source's
  statement under `observation` and Loop's conclusion under `relevance`; the table separates them by
  column group. A shape that cannot tell them apart eventually presents the second as the first.
- **⚠️ `TERM_MATCH` is a Stage 2 validation mechanism, NOT the approved relevance model.** Objectives
  are free text with no metric, so the evaluator compares normalized significant terms and records
  which ones matched. It is deliberately dumb: "Nike hires a new CMO" may matter enormously to "grow
  brand partnerships" while sharing no word with it, and a test asserts the limit (Texas ≠ TX) so
  nobody "fixes" it with synonyms, stemming or an ontology. No score, no confidence, no weights, no
  embeddings, no LLM. The extension point is `relevanceBasis` / `evaluatorId` / `evaluatorVersion`.
- **Provenance by reference, and NO FK to the source domain.** `sourceSystem` + `sourceKey` are opaque
  handles, never parsed — `OperationalPriority.sourceReference`'s shape. A real FK to
  `marketplace_calls` was rejected: that table has a scalar `organizationId` with no FK and a
  **globally** unique `(provider, externalId)`, and a reference would inherit both defects.
- **Idempotency is tenant-scoped:** `@@unique(organizationId, performanceObjectiveId, sourceSystem,
  sourceKey, evaluatorId)`. Re-running moves `lastEvaluatedAt` / `evaluationCount` and rewrites
  nothing else — not the rationale, not the basis, not the observation. History is not revisable.
- **Source:** CallGrid calls via `marketplace_calls`, read through `MarketplaceCallRepository`
  (one additive read method, `listWindowSummaries`; no existing method or caller changed, no write
  path touched). `ServiceRequest` was evaluated and rejected — it has **zero active producers**.
- **RBAC reuses `commercialIntelligence`.** `view` to read, `update` to run an evaluation. No new
  resource, action or role. MANAGER holds `view` only, a consequence of the Stage 1 matrix and not a
  statement about who manages whom; nothing in Stage 2 reads a role as an organizational relationship.
- **No Stage 2 events.** No consumer exists and Stage 3 is not authorized; an outbox type with no
  reader is `EVENT_BUS.md` again.
- **Surface:** one guarded action and one read-only table on the existing objectives page. Ordered by
  when the observation happened and by nothing else — no ranking, no badge, no CTA on a row, nothing
  to click through to. It is an inspection surface, not an attention surface.

**Stage 2 validated:** 498 shared (16 new) · 314 database (24 new) · typecheck clean
(shared/database/web) · `turbo run build` passes · `prisma validate` clean ·
**from-zero replay against PostgreSQL 16: all 15 migrations apply to an empty database and
`migrate diff --exit-code` reports no drift** · hand-written migration DDL verified byte-identical to
`prisma migrate diff --from-empty` output · **end-to-end against real Postgres**: two active
objectives, one real call row → exactly one signal (roofing matched, SSDI did not), re-run reaffirmed
without duplicating, cross-tenant objective id returned `null`, and 0 rows written to
`operational_priorities` / `state_change_outbox` / `signals` / `audit_logs`. Migration is additive
only — 1 table, 2 indexes, 1 unique, 2 FKs, 0 enums, 0 DROP / 0 rename / 0 column-type change, no
existing table altered, ASCII header.

**✅ LIVE — deployed and production verified 2026-08-16.** `commercial_signals` exists in production.
Smoke test: *Evaluate recent activity* was run **once**; signals persisted and rendered with observed
date, source system (CALLGRID), source reference, objective, rationale, evaluator provenance and
established date. The rationale read *"Objective and the source's own descriptors share the terms: …"*
attributed to `term-match v1`, **confirming the Stage 2 defect fix is live**: CI-authored
`observationSummary` text is not establishing relevance; source-owned descriptors are.

**⚠️ WHAT THE PRODUCTION SMOKE TEST ACTUALLY DEMONSTRATED — read this before Stage 3.**
The architecture works: an observation was evaluated *relative to* a human-authored objective and
produced a signal with inspectable provenance. **Objective-relative relevance is operational.**

The evaluator is also visibly primitive, exactly as designed. Real determinations from the run:

| Objective | Observation | Matched on |
|---|---|---|
| Grow roofing lead revenue in Texas | an **SSDI** call in Texas | `texas` |
| Grow roofing lead revenue in Texas | a **Final Expense** Lead Plateau call in New York | `lead` |
| Grow roofing lead revenue in Texas | a **Pest Control** Revenue Click call | `revenue` |

Every one is a correct `TERM_MATCH` determination under the frozen Stage 2 implementation. None is
necessarily commercially meaningful.

**This is not a defect and must not be "fixed."** `TERM_MATCH` was chosen as the smallest deterministic
mechanism that could prove the architecture without inventing a relevance model nobody has approved,
and it did its job. The lesson to carry forward is the distinction, not a bug report:

> **Objective-relative relevance is operational. Literal token overlap is not sufficient to define
> commercial intelligence.**

Stage 3 consumes the Signal layer as it exists. Do not add synonyms, geography normalization,
stemming, embeddings, LLM relevance, ontology, scoring, confidence, weighting or ranking — in Stage 3
or as a prerequisite to it. Replacing the evaluator is a separate, separately-approved piece of work,
and the contract is already shaped for it: a new evaluator supplies a different `relevanceBasis` /
`evaluatorId` and changes nothing about what a Commercial Signal means.

**Consequence Product should plan around:** the surface will be both sparse and occasionally
irrelevant until a real relevance model exists. Charlie and Lexi should design the Headlines
experience against what Loop can honestly say today, marking the richer version as future vision.

### Stage 3 — Headlines (NOT AUTHORIZED)
**ARCHITECTURE ASSESSMENT COMPLETE · PRODUCT DEFINITION IN PROGRESS · IMPLEMENTATION NOT AUTHORIZED.**

No Headline schema, generation, routing, feed, seven-business-day logic, Investigate, Subject or Case
exists, and no Stage 3 abstraction was prepared in advance. The architecture assessment identified
6 product decisions (H-P1…H-P6) and 10 architecture decisions (H-ADR1…H-ADR10) that must close first;
Charlie and Lexi own the Headlines experience definition in parallel. **Implementation begins only on
a separate, explicit authorization.**

## Business Identity Architecture v1 — ASSESSMENT COMPLETE, AWAITING APPROVAL (no branch, no code)
The prerequisite before CRM v1 can be designed against a real identity layer. This batch produced a
repository-impact assessment **only**: ten artifacts audited at `main` = `1b71715` (post-#157).
**No branch, no schema, no migration, no implementation, no PR.**

⚠️ **THE TEN ARTIFACTS ARE NOT IN THIS REPOSITORY.** They exist only in the authoring workspace as
untracked files under `docs/architecture/business-identity-assessment/`, and nothing in this
document links to a file a reader can open. Committing them is a separate documentation change,
deliberately not folded into the Commercial Intelligence branch. Every filename cited in this block
refers to one of those uncommitted artifacts — treat the summary below as the record until they land.

**What the audit changes about the plan:**
- **The cognitive identity layer is real, tested, and has ZERO production callers.** `apps/web/src`
  contains no reference to any cognitive symbol; `CognitiveIdentity`/`IdentityRole`/`IdentityEvidence`/
  `IdentityResolutionLink`/`IdentityRelationship` are touched only by their own repositories and by
  `cognitive-core.test.ts` / `cognitive-pipeline.test.ts`. (The outbox/drain half of
  `services/cognitive/` **is** production-reachable — same folder, different half.)
- **It cannot be reused, for semantic reasons not naming ones.** `IdentityEvidence` stores
  `normalizedValueHash` only, so no contact value can ever be displayed; `entityType` is inside
  `CognitiveIdentity`'s unique key, so a record can never change type; `IdentityRelationship` collapses
  Affiliation + StructuralLink + CommercialRelationship + Event + OpportunityParticipant into one edge
  table. Disposition: **KEEP_SEPARATE**, with an optional one-directional link later.
- **`Customer` is ingestion-owned and semantically mixed** — anonymous website visitors (no name/email/
  phone, tagged `anonymous-visitor`), caller-ID leads and hand-edited CRM records in one table, all
  listed together at `/crm/customers`. It becomes a **DomainProjection**, never a Party, and must not
  be auto-backfilled.
- **There is no Opportunity model.** The CRM "pipeline" is a string in `Customer.attributes`. Every
  multi-party opportunity concept is a clean slate.
- **The best prior art is orphaned.** `KnowledgeAssertion`'s supersession, `IdentityResolutionStatus`'s
  lifecycle and `IdentityResolutionLink`'s reversal fields are close to the approved design and none of
  them run. Copy the shapes; do not reuse the tables.
- **Events need no new infrastructure.** `OutboxSubjectType.IDENTITY` already exists; the contract is a
  separate file on the existing outbox. Net cost is one additive enum member on `ActiveStateDomain`.
- **Recommended foundation is smaller than proposed:** 8 before-code capabilities, 5 proposed items
  demoted, **4 additive migrations rather than 12** (fewer manual production operations is safer
  regardless — each one is a human-dispatched workflow run).

**⚠️ GATE — 19 open approval decisions, none accepted.** Bucketed A (10, before Stage 1 contracts) /
B (4, before schema) / C (2, before CRM production) / D (3, deferrable). Roots are **Q1** (production
migration deployment — scheduled, not merely agreed) and **Q2** (may `packages/business-identity` be
created). Four need Charlie and Lexi: Q4, concern 11, Q6, Q8. Gates G1, G2, G3, G7, G9, G11, G12 are
groupable without further debate; G5 and G8 carry named carve-outs; G4 and G6 cannot be grouped.

**Live defect found, deliberately NOT folded in (Q10).** `/crm/merge` writes `metadata.mergedInto` and
**nothing reads it** — merged customers stay in every list, search and count, and `findDuplicates()`
re-proposes the same pair indefinitely. The merge is also irreversible (`updateMany` destroys the
original `customerId`; the audit records counts only) and its header comment claiming "soft-archived
(kept for audit)" is false. Needs its own ticket, outside this project.

**NEXT: Matt's decisions on the approval packet.** Then Stage 1 (contracts + terminology, **no
schema**) as its own branch. Business Identity implementation has not begun.

## CRM · Creator Hub · Accounting — NOT BUILT
Approved operating areas, shown in the sidebar, but not built/connected. They render honest
"Not Configured / unavailable" states and **never** show fabricated data. (CRM specifically
must never surface CallGrid caller records as contacts — the `Customer` table is shared.)
**CRM design may proceed now** — per the assessment's CRM design guidance (uncommitted; see the
Business Identity block): 13 areas SAFE_TO_FINALIZE, 11 PROVISIONAL, 15 binding
FORBIDDEN_ASSUMPTIONs. **CRM code may not begin until Business Identity Stage 2 lands.**

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
6. **Migration gate — CLEARED 2026-08-16.** Production is aligned with `main` through Commercial
   Intelligence Stage 2: 15 ledger rows, 0 rolled back, 74 tables, PostgreSQL 18.4. See the
   *Production migration state* block below. **The gate is not gone, only clear:** deployment stays
   manual by design, so any branch adding a table is still code-complete until somebody dispatches
   `Deploy Prisma Migrations`. The open follow-up is a read-only signal when `main` carries
   migrations production has not applied — eight sat unapplied for three weeks and nothing warned.
7. **Business Identity approval packet — 19 decisions, none accepted.** Blocks CRM v1 code (not CRM
   design). Answer **Q2** first to unblock the most downstream work; **Q1** is the only one where
   "yes in principle, no date" leaves the project worse off than a clear "not yet". See the
   Business Identity block above; the decision log itself (§5-6) is one of the uncommitted artifacts.
8. **`/crm/merge` defects** — unread `mergedInto` filter, irreversible re-pointing, false
   "soft-archived" comment. Own ticket, outside the Business Identity project (Q10).
9. **The Decision Center sequence (Matt, 2026-07-31).** Architecture follows actual reuse, never
   speculation — each step earns the next:
   1. ~~Merge #156.~~ **Done**; #157 (event contract + drain) also merged.
   2. **Operator Velocity** — Decision Center v2 UI/workflow polish, zero backend.
   3. **Work OS as the FIRST subscriber** to `DECISION` events. This is what closes
      ENGINEERING_PRINCIPLES Rule 6, which currently holds by discipline rather than enforcement.
      The drain now provably delivers — no subscription is registered for `DECISION` subjects.
   4. Prove the event bus end to end.
   5. CRM onto the Decision Engine (producer #2) — now downstream of Business Identity too.
   6. Accounting onto the Decision Engine (producer #3).
   7. **Only then** extract `/app/admin/decisions` as its own route — by which point #156 has
      made it close to a file move.
10. **Commercial Intelligence Stage 2 in review** (branch `feat/ci-commercial-signals`). Stage 1
    merged as #158. Stage 3 (Headlines) is not started and is a separate approval.
    Performance Objectives only — the referent a CI Signal is defined against. Stage 2 does not
    start until Stage 1 merges and real objectives exist; a signal layer built against an empty
    referent is a fabricated concept. Adds a table, so open thread 6 gates it going live.

## Working agreement
**One branch per work batch.** After a PR merges, cut a fresh branch off freshly-merged
`main` for the next objective — never keep committing to a merged branch (it strands work
with no open PR). Always open a draft PR and report its URL; Matt merges.

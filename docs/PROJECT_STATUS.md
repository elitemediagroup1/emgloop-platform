# EMG Loop — Project Status (where we left off)

The living "current state" per workstream, so any session (or Matt) can resume without
losing the thread. **One current-state block per workstream — overwrite it, don't append.**
Read this at the start of a session; update it at the end of a work batch. History lives
in git, not here.

_Last updated: 2026-09-23 (Creator Hub built and locally acceptance-tested, draft PR in review, staging deployment pending Matt — see the Creator Hub block; earlier: Intelligence & Memory Foundation commissioned — #305/#306 on main, migration 42 applied, completion PR in review; Google onboarding: #302/#303 merged, Gmail cycle not yet on, one-derivation PR in review; production at migration 41; Gmail GM-1..GM-3 in review as #295/#296/#297; AI runtime #266–#271 merged, switched off; B0–B6 merged incl. #284, B7 pre-deployment #285 merged; AWS staging not bootstrapped, nothing deployed; Google Workspace connection (Private V1) merged as #286 and migration 37 applied in production; Daily Loop / Employee Intelligence architecture merged as #287, DL-0..DL-3 merged with migrations 38 and 39 applied and production verified, DL-4 (Your Day) merged as #293, DL-5 (the automated Calendar cycle) in review; see the Foundation handoff and Google Workspace blocks)._

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

## Creator Hub — BUILT, LOCALLY ACCEPTANCE-TESTED, IN REVIEW (draft PR on `feat/creator-hub-demo`, off main `88d1a9c`) · NOT ON STAGING YET

**What it is.** The approved design (Mockup #1 locked, Mockup #2 reviewed) built as one system with two
experiences: a managed creator's own login (`SystemRole.CREATOR`, same organization, one `LOOP_NAV`
filtered to `/app/creator/*`) and the EMG side at Operations → Creators (`/app/admin/creator-hub`).
No `CreatorHub*` tables: CRM owns `CrmOpportunity`/`CrmCampaign`/`CampaignDeliverable` (append-only
transitions), Work OS owns every Production (a `WorkInstance` of work type `creator-production`, with
`WorkInstruction` sets and `WorkComment.visibility`), the creator domain owns `CreatorProfile` /
`CreatorContent` / immutable `ContentVersion` lineage / approvals / publications, evidence rows carry
`source` (SEEDED_DEMO is labelled everywhere it shows), and the Brain composes "What Loop noticed"
(`creatorContentNotice`, pure; Fact / Observation / Interpretation / Proposed / Not yet). Media bytes
live in a private S3 bucket behind a presigning Lambda in the connections stack (browser → presigned
PUT/GET; the web tier holds no AWS credential); `LOOP_MEDIA_STORAGE=local` is dev-only and refused on a
production runtime.

**Migration:** `20260930000000_creator_hub_foundation` (additive: `CREATOR` enum value, 2 Work OS
columns + `work_comments.visibility`, 14 tables). Applied to the local Postgres only.

**Validated (2026-09-23, local):** typecheck clean for shared/providers/brain/database/web/infra/ops;
web build passes; tests: web 707, database 1651 (Postgres opt-in included), shared 1380, providers 248,
brain 8, infra 41, operations 630 — all passing. The full 52-step acceptance path was driven in a real
browser (Playwright) against `next dev` + local Postgres + local disk media: creator video upload →
request edit → EMG finds it in Requests → real Work OS work assigned, expected return set → editor
uploads Edit v1 and returns it → creator reviews (same-playhead compare, Change + Keep notes, drafts
survive reload) → request changes continues the SAME Production (round 2) → Edit v2 addresses the notes
→ creator approves v2 → Production completes, EMG sees the approval on v2 and the immutable lineage →
photo uploaded and manually marked published, persisting across reload → a creator cannot open EMG
pages, another creator gets 404 on the record and the media, anonymous gets 401.

**Next (Matt, in order — `docs/runbooks/creator-hub-staging.md`):** merge → `connections-infra-deploy`
(diff, then deploy) → Netlify staging env `LOOP_MEDIA_STORAGE=aws` → `connections-migrate-staging` →
`creator-demo-seed-staging` → fast-forward `staging`. Then the staging acceptance run and the handoff
(one URL, how each person enters). Production is untouched by all of it.

**Known limits:** payouts are not a rail (the transfer control is inert and says so); notification
preferences are saved but nothing sends; the Work OS reassign dropdown lists every ACTIVE member
including creators; brand approval is EMG-relayed (no brand login); analytics/earnings are seeded
evidence until a platform connection exists.

## Production migration state — AT 41 · `main` IS AT 41 (verified 2026-09-19)

**Production matches `main`.** Migrations **40** (`20260922000000_gmail_read_and_send_scopes`) and
**41** (`20260923000000_gmail_reply_drafts`) were applied by `Deploy Prisma Migrations` run
`35374762981` on 2026-09-18 17:30 UTC (its log: "Applying migration" for both, then "All migrations
have been successfully applied"). This block previously said they were not applied; that was true
only until that run.

**Latest:** migrations **38** (`20260920000000_daily_loop_work_state`) and **39**
(`20260921000000_work_event_calendar_facts`) were dispatched together and applied successfully on
2026-09-18, after **37** (`20260920000000_google_workspace_connections`). DL-3 was then verified against
production: a real Calendar sync ran for one employee and stored its cursor. Run IDs are in the
`Deploy Prisma Migrations` history — read that, not this file, for the authoritative state.

Migration 36 and earlier, for history: run `35160530756` applied migration 36, `20260919000000_brain_durable_persistence`, from
`main` at `f744fca` (B4, #277).
- **What it added:** eight Brain tables, plus three nullable columns on `ai_invocations`.
- **Evidence:** a fresh PostgreSQL 18 replay of all 36 showed no drift beforehand. The dossier is
  `docs/architecture/brain-persistence.md` §12.
- **Node:** the run used Node 20.20.2, and `npm install` warned that `openai@7.15.0` needs Node ≥ 22.
  The migration does not load the SDK. A maintenance PR moving the workflows to `.nvmrc` is
  recommended (`brain-boundary.md` §11.3).

The previous run, `35103219698`, applied migration 35 (`20260918000000_ai_usage_ledger`). B5 adds **no**
migration.

`migrate status` does not detect schema drift. Seven pre-existing, cosmetic differences between the
migration history and `schema.prisma` are recorded in `docs/architecture/schema-drift-2026-09-16.md`.
**B1 (#273, merged) aligned `schema.prisma` to the database.** It changed no migration and no database,
and no migration was needed. `prisma migrate diff` from a clean replay of all 35 migrations reports
"No difference detected" (re-checked on `c3ac3f2`).

The 2026-08-16 narrative below is kept as history.

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

## Intelligence & Memory Foundation — COMMISSIONED (2026-09-19): #305 + #306 on main, migration 42 applied; completion PR in review

- **Commissioned and proven in production** (details in `docs/architecture/intelligence-foundation.md` §10):
  - the Gmail cycle's detectors raised real work items with no page visit;
  - CallGrid detection recorded 5 situations (1 new, 4 seen again, all SYSTEM), 0 duplicates;
  - the drain published all 117 outbox rows;
  - both creator subscriptions are ACTIVE;
  - D2 attendee keys are populated (19 events / 68 keys and 18 / 65).
- **Naturally scheduled runs:** only the Calendar cycle has been seen on #305+ (19:12). The Gmail cycle, CallGrid
  detection and the drain have so far run only when dispatched by hand. GitHub fires these "hourly" and "5-minute"
  crons every ~2.5–5 h.
- **By loop stage:**

  | Stage | State |
  |---|---|
  | Observe | **Production proven**: Gmail, Calendar, and CallGrid ingestion |
  | Remember | **Production proven**: work state, attendee keys, the Case log. **Awaiting data**: Case outcomes (none recorded on these Cases) |
  | Connect | **Awaiting data**: D1 (0 Parties or identifiers) and the creator review (0 relationship events). **Not surfaced**: the mail-calendar join (`personalIntelligence` has no page) |
  | Notice | **Production proven**: mail attention and CallGrid detection. **Running, no data**: the identity-suggestion detector |
  | Surface | **Live, not independently viewed in the audit**: existing pages render work items (Home/Mail) and Cases (CallGrid; `/app/admin/cases/<id>`). **Not surfaced**: `IntelligenceItem` (`personalIntelligence`, `caseIntelligence`) and suggestion confirm/reject |
  | Human decision / outcome | **Implemented, awaiting a real outcome**: the Case outcome and mail close paths exist. **Not surfaced**: D1 confirm/reject |
  | Learn | **Implemented, awaiting data**: standing judgments, mail corrections and the creator review's memory act in production code paths. `learnFromHistory` for CallGrid Cases is computed but not surfaced |

- **Completion PR** (branch `fix/intelligence-foundation-completion`):
  - `caseIntelligence` compares against the registry producer `CALLGRID_DECISION_PRODUCER`. The old lowercase check
    labelled real CallGrid evidence LOOP.
  - Identity evidence records a one-way key fingerprint, and the D1 detector reports `keyMismatch`.
  - Docs.
- **External, not urgent:** one `COGNITIVE_HASH_SECRET` in the GitHub repository secrets, identical to any future
  identity-evidence writer's runtime. It is needed only once identifiers exist, and must never change after that.
- **Next:** surface `IntelligenceItem` (a UI slice), and let the first real Case outcome and the first natural
  scheduled runs arrive. Creator Hub itself is a separate product layer; nothing here builds it.

## Google onboarding (Matt, Charlie, every employee after) — DONE: #302, #303, #304 MERGED; Gmail cycle ON (run 2026-09-19 15:09 UTC: eligible=2, both SYNCED INCREMENTAL)

- **Merged:**
  - #302: Gmail's first read belongs to the scheduled cycle; readiness replaces "Connected"; Drive
    shows as unused; `read-employee-sources` added.
  - #303: the diagnostic trims its slug.
- **Production truth (Read Employee Sources run `35449047490`, 2026-09-19 14:32 UTC, on `main` `2eb1beb`):**

  | | Ref | Gmail scopes | Eligible | Position | Threads / messages / items | Last Gmail read | Calendar |
  |---|---|---|---|---|---|---|---|
  | **Matt** | `d1c3c4956b11` | both, plus the leftover legacy `gmail.metadata` | yes | none | 270 / 341 / 102 | 01:50:55 UTC, TRUNCATED (250) ×3 | 22 events; current |
  | **Charlie** | `f5aec1d1d7ec` | both | yes | none | 0 / 0 / 0 | 3 runs 08:56–08:57, all RATE_LIMITED | 18 events; current |

  Matt's Connections page ("Gmail · Ready · Last read 12h ago") reads the same record through the same
  derivation and agrees with this run.
- **In review:** one derivation. `deriveSourceState` (@emgloop/shared) is used by Connections, Mail,
  Home's mail panel and the diagnostic, which now prints `readiness` and `position`. Adds regression
  tests on Matt's exact facts, and on employee #3 becoming eligible with no configuration change.
- **Commissioned:** the Gmail cycle is enabled for `servicesinmycity-demo`; both employees read incrementally.
- **Employees after Matt and Charlie are automatic.** The cycle's own query includes anyone with a
  complete grant and an active membership. The external limit is Google Testing mode: only listed test
  users can consent, and grants lapse 7 days after issue.

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

## CallGrid webhook convergence — MERGED (#298, main `1f735ba`)

CallGrid fires Ended, Billable and Payable for one call at essentially the same moment; every
delivery order now converges on one call with its revenue, payout and flags, late values are never
overwritten by stale zeros, the backfill and reconcile route read the right fields, and Home and
CallGrid label Net Profit (revenue − payout − telco cost). No migration. Routine polling stays OFF
(`ROUTINE_POLL_ORGANIZATIONS` unset) and is to become reconciliation only. **Next:** Matt verifies
the three CallGrid webhook templates.

## CallGrid command center — IN REVIEW (draft PR #300 on `feat/callgrid-command-center`, off main `91cadee`)

`/app/admin/marketplace` restructured from one long diagnostic page into layers: Overview (five
KPIs, Today's Brief, at most three priorities, a compact workspace) → Money / Buyers / Vendors /
Sources / Campaigns / Bids / Intelligence → entity pages (`/buyers/[key]` etc.) → a Situation page
(`/intelligence/[id]`) → evidence and limits behind disclosures. Daily / Weekly / Monthly periods
(`callgrid-period`) resolve through the one window contract; old `?range=` links still work.
"Live" now comes from when CallGrid last delivered data, not the render clock. Pages now enforce
`intelligence:view` (the permission their nav item always stated). Nothing was deleted from the
old Overview: the queue, story, risk model, Loop's record and every limit are in Intelligence. No
migration.

Pre-merge review fixes (same PR):
- A Situation speaks with one finding's voice (`voiceFindingId`), so a priority's headline,
  explanation and action cannot come from different findings.
- The brief is a health band with a short reason plus at most two sentences (45-word cap).
- Comparisons are withheld when Loop's call record (its first stored call, by Eastern day) does
  not cover the comparison period, so there is no +305% on a half-covered month.
- The phone layout keeps the health line and the first priority on the first screen.

**Next:** Matt reviews. After merge, confirm the freshness badge against a real day of CallGrid
deliveries (production has had no routine poll, so "Live" rests on webhooks alone).

A Situation's "What happened", Measured values and evidence now read in words and units
(`callgrid-metric-presentation`). Each rule states what its comparison value is, so an average of
earlier periods is never called "yesterday". Stored decision summaries keep their old wording until
the situation is detected again; no data was rewritten.

**Found, not fixed here (pre-existing on `main`):**
- The situation page's confidence pill reads "High confidence confidence".
- The impact line can read "Not quantifiable not quantifiable".
- The Buyers, Vendors, Sources and Campaigns list pages' decision cards still list evidence by
  metric key.

**NEXT CALLGRID MILESTONE: margin-setting intelligence. NOT STARTED, and deliberately not in #300.**
Matt's requirements:
- the historical margin-setting periods per campaign;
- net profit per business day at each setting;
- break-even volume;
- realized-versus-set margin drift;
- confidence;
- a Hold / Adjust / Test / Watch recommendation.

**Prerequisite, and a separate task:** audit whether CallGrid exposes, through an API Loop can
ingest:
- historical campaign margin / payout settings;
- when each setting took effect;
- schedules;
- vendor-level overrides.

Loop stores none of this today. `MarketplaceCall` carries revenue, payout, cost and rate per call;
it holds no configured margin and no settings history. Do not assume the data exists. Do not
substitute realized margin for configured margin: the milestone exists to compare the two.
Hold/Adjust/Test also needs a written policy (thresholds, minimum sample, who may act), and it
must stay inside the recommendation-safety vocabulary. Unverified lead for the audit: the CallGrid
API surface has campaign, version-history and commission reads. Nobody has checked whether they
carry settings history.

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

**⚠️ Confirmed 2026-09-16: STILL NOT CONFIGURED.** Every scheduled run since at least 2026-09-14 fails
with "OUTBOX_DRAIN_URL and OUTBOX_DRAIN_SECRET must both be set", so nothing drains the outbox in
production. This is an open item, not a resolved one.

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

## Commercial Intelligence — STAGES 1 + 2 PRODUCTION VERIFIED · STAGE 3 IN IMPLEMENTATION
**Stage 1 — Performance Objectives:** BUILT · MERGED (#158) · DEPLOYED · **PRODUCTION VERIFIED** 2026-08-16
**Stage 2 — Commercial Signals:** BUILT · MERGED (#159, main `ae3fc4e`) · DEPLOYED · **PRODUCTION VERIFIED** 2026-08-16
**Stage 3 — Headlines:** IN IMPLEMENTATION · MERGED #161–#174 · **PR 5 (readiness gate) MERGED AND DEPLOYED** · window certified · first production reconciliation done, **2026-08-06 is NOT ready** · **evidence-sweep mode IN REVIEW** · PR 6 onward NOT AUTHORIZED
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

### Stage 3 — Headlines (IN IMPLEMENTATION · PR 2 OF 7 IN REVIEW)
**IMPLEMENTATION IN PROGRESS.** Authorization now extends through **PR 2 of a 7-PR stack**.
**PR 3 onward is NOT authorized.**

Stage 3 makes an objective measurable, measures it only across days Loop can prove it observed, and
states a material change as a Headline. Five PRs have merged; the current stack builds the
completeness layer those PRs proved was missing.

| PR | Merged | What it established |
|---|---|---|
| **#161** | 2026-08-16 | **Stage 3 v1.** `ObjectiveMeasureBinding` (immutable, versioned, supersede-only), deterministic measurement over two complete Eastern weeks, `Headline`, and human dismissal as attention feedback rather than an outcome. No Headline→Decision promotion, no scoring, no ranking, no LLM. Migration `20260817000000_ci_stage3_headlines`. |
| **#162** | 2026-08-17 | **A measurement may not be computed over days nobody looked at.** `provider_observation_days` + `ProviderObservationService.certifyDay()` + a fourteen-day gate; `measureChange` now *requires* a `WindowObservation` and returns before any arithmetic when the window was not fully observed. Also: a page-budget exhaustion in `fetchAllCallGridCalls` no longer reports as a clean read. Migration `20260818000000_ci_stage3_observation_completeness`. |
| **#163** | 2026-08-17 | **Certification runner** — `scripts/operations/certify-observation-days.ts` + a `workflow_dispatch` workflow, the only caller `certifyDay()` has. Source-constraint tests fail if the runner ever names certification internals, recovery, measurement or direct Prisma. |
| **#164** | 2026-08-18 | **Read-only August 5 identity reconciliation diagnostic** + `workflow_dispatch` workflow. `provider_observation_days` persists a count, never an identity set, so it can say 107 records are absent but not *which*. Three refusal verdicts; PII excluded by allowlist, not by filtering. |
| **#165** | 2026-08-19 | **PR 1 of 7 — the pure completeness contracts.** `member-expectation.ts`, `provider-reconciliation.ts`, `measurement-source.ts` and `measurement-readiness.ts` (`assessReadiness`), plus `EffectiveDateRange` in `business-time.ts` and 11 readiness reasons extending `MATERIALITY_WITHHOLDINGS` — among them `CAMPAIGN_EXPECTATION_CONTRADICTED`. **Nothing wired, nothing persisted; Stage 3 behaves exactly as it did before.** No migration. |
| **#166** | 2026-08-19 | **PR 2 of 7 — member expectation persistence.** `provider_member_expectations`: effective-dated half-open declarations (`declare` / `resolveOn` / `declarationsFor`), at most one in force per member per date enforced by a Postgres `EXCLUDE USING gist` over `btree_gist`. `UNKNOWN` stays unstorable. Nothing reads traffic. Migration `20260819000000_ci_stage3_member_expectation`, **applied to production 2026-08-19** (`btree_gist` 1.8, schema `public`). |

**Deployed.** `Deploy Prisma Migrations` applied `20260817000000_ci_stage3_headlines` on 2026-08-16,
`20260818000000_ci_stage3_observation_completeness` on 2026-08-17 and
`20260819000000_ci_stage3_member_expectation` on 2026-08-19; the last run reported *"Database schema
is up to date"* against all 18 migrations then on `main`. #163, #164 and #165 carry no migration.
**Not yet production-verified** — no Headline has been observed rendering against real production
data, the certification runner has not been dispatched, and no expectation has been declared.

**IN REVIEW — PR 3 of 7: provider reconciliation persistence. NOT MERGED.** The third fact, beside
the other two rather than folded into either:

| | |
|---|---|
| `provider_observation_days` | did Loop **look** at this business date? |
| `provider_reconciliation_days` | did what it saw **arrive**? ← PR 3 |
| `provider_member_expectations` | was it **supposed** to arrive? |

- **`ProviderReconciliationDay` + `ProviderReconciliationMember`.** The verdict lives at the day
  because measurement gates on a day; the difference lives in campaigns, because 106 of August 5's
  107 absences belonged to three of them and a day-level gate alone would let one broken campaign
  block every objective in the organization.
- **The comparison boundary is `integration_events`,** where receipt is proven and before
  normalization or projection semantics apply. Reconciling at `MarketplaceCall` would conflate a
  delivery failure with a projection rule permanently.
- **Selected by delivery time, judged by occurrence.** The local scan reaches two days either side
  of the Eastern window and filters by the canonical `resolveCallOccurrence`, so a webhook retried
  the next morning still counts toward the day it occurred on.
- **Evidence is weighed before the verdict.** A truncated provider read, a record carrying no member
  attribution, a local row whose occurrence will not resolve, a local row with no identity, and two
  identity sets that barely overlap each produce INCONCLUSIVE without the counts ever being read for
  a finding. `localOnly > 0` is INCONCLUSIVE, not UNRECONCILED — it impeaches the comparison rather
  than reporting a gap in it.
- **The three set equations are enforced by Postgres,** not only by the service. A comparison whose
  own arithmetic disagrees with itself is REFUSED and nothing is written, because an INCONCLUSIVE
  row would still assert that a comparison happened.
- **Expectation is resolved through PR 2 and recorded by id.** The member row names the declaration
  it used, so a declaration recorded tomorrow cannot silently rewrite what a historical
  reconciliation concluded. Re-running is the deliberate act that applies a new answer.
- **One current answer per day, rewritten in place** — the same upsert-on-identity shape
  `certifyDay` uses. Member rows are replaced inside the same transaction, so a campaign that
  stopped appearing cannot linger looking current.
- **`Reconcile Provider Days`** — `workflow_dispatch` only, no schedule, one date per dispatch
  intended. It runs the source-constraint suite **before** the production credential is used, so
  "it cannot ingest, recover, certify or declare" is a checked property of the run.

⚠️ **Migration `20260820000000_ci_stage3_provider_reconciliation` is NOT APPLIED.** Additive: two
tables, three indexes, four foreign keys, seven CHECK constraints. Zero DROP, zero rename, zero
column-type change, no existing table altered, nothing seeded, no `CREATE EXTENSION`.

**Nothing is wired to measurement.** `headline-detection.service.ts` is untouched and the readiness
gate remains unwired; PR 3's persistence is inert until PR 5. **No production reconciliation has been
run** — the capability exists and has never been pointed at production.

### Operations bridge — declaring expectations (MERGED #168 · PROVEN IN PRODUCTION)
**Not PR 4.** `ProviderMemberExpectationRepository.declare()` shipped in #166 with **zero callers** —
no route, no server action, no page, no script, no workflow — so the expectation table could not be
written to at all. The same shape `certifyDay()` shipped in, and #163 had to unblock it the same way.

`Declare Member Expectations` (`workflow_dispatch` only) plus
`scripts/operations/declare-member-expectations.ts` are the bridge, and both are deletable the day a
real operator surface ships.

- **One campaign per dispatch, no batch mode.** A declaration is a human statement; four campaigns is
  four runs, each with its own dispatcher, reason and line in the audit trail.
- **`dry_run` defaults to true** and is the pre-write check: it resolves the organization, the
  declarer and the declaration currently in force for that campaign on that date, and writes nothing.
  **It does not call `declare()` at all.**
- **The preview and the write ask the same question.** `previewDeclaration` and `declare` share one
  shape check and one decision function inside the repository, so a dry run cannot say CREATED and be
  followed by a write that refuses. A test drives every shape through both.
- **Provider, stream and dimension are constants, not inputs** — this bridge exists for the Stage 3
  CallGrid campaign operation, and `EXPECTATION_DIMENSIONS` is CAMPAIGN only in v1.
- **No user id is ever accepted from outside.** An optional declarer email resolves through the
  existing organization-scoped `iam.listUsers` roster and fails closed on no match or an ambiguous
  one; blank records no actor, which the repository documents as the honest value.
- **No provider credential.** A declaration never reads traffic — a campaign that broke must not
  un-expect itself the moment it stops delivering — so the runner holds only `DIRECT_DATABASE_URL`.
- **The safety suite runs before the credential is used**, so "it cannot reconcile, certify, ingest,
  recover or measure" is a checked property of each run.

**No migration.** **The bridge is merged and deployed, and is the proven path to the expectation
table** — it is the only caller `declare()` has. Whether a given campaign has been declared is a
question for the workflow's run history, not for this file. The remaining campaign declarations are a
configuration act, not an engineering one, and the bootstrap bridge below is how the first batch of
them is dispatched.

### Measurement source authority — PR 4 of 7 (MERGED #169 · DEPLOYED)
**WHOSE NUMBER is this measure?** The fourth Stage 3 fact, and the one that stops a false zero. On
2026-08-05 every one of the 974 records the provider held carried `converted=false` — present, not
absent — so a conversion rate computed from them would have returned 0% at full coverage, cleared
every guard Stage 3 had, and stated a business falsehood as a measured fact. **A source containing a
field does not make it authoritative for that field.**

Three tables persist what PR 1's pure contract already defined: `measurement_sources` (what this
organization is willing to believe), `measurement_source_metrics` (which measures each may be
believed about, and the definition id it uses for each), and `measure_source_authorities` (which one
is authoritative for a member and measure over a period).

- **Authority is DECLARED, never inferred.** The repository has exactly two write methods —
  `registerSource` and `declareAuthority` — and a test asserts the list by name. Neither accepts a
  call, a revenue figure, a webhook, an import result or a reconciliation verdict, so authority
  cannot be derived from any of them. Recording a reconciliation or an expectation provably does not
  change a resolution.
- **The grain is (member, metric, date)**, taken from the PR 1 contract rather than chosen here. It
  buys the case this exists for at no extra cost: **the provider for call volume and a counterparty
  for revenue, on the same campaign on the same day**, without either being a contradiction.
- **Fails closed in both directions, with no fallback.** Zero declarations is MISSING — never "assume
  the provider", which is precisely the assumption that made the false zero computable. Two is
  CONFLICT, never a precedence puzzle: any tie-break would settle a disagreement the organization has
  not actually settled. A row whose stored vocabulary cannot be read is counted, not dropped —
  dropping one could turn a two-way conflict into a confident answer.
- **Effective-dated, and history is never rewritten.** A successor moves ONE column (`effectiveTo`)
  on its predecessor and keeps its source, reason and author. Re-running last month's comparison
  resolves the authority that was in force LAST MONTH.
- **Postgres holds the invariants.** An EXCLUDE USING gist over `daterange(..., '[)')` makes two
  authorities for one member+measure+date impossible; a **composite** foreign key over
  `(id, organizationId)` makes a declaration naming another tenant's source impossible. Both were
  exercised against real PostgreSQL 18.6, not only asserted in a fake.
- **One readiness truth.** `readinessFacts()` returns `MeasurementSourceDefinition[]` and
  `MeasureSourceAuthorityDeclaration[]` — the exact arrays `ReadinessInput` already declares — so
  persisted authority reaches `assessReadiness` as DATA. **No second readiness engine, and
  `measurement-readiness.ts` is untouched.**
- **The overlap reasoning was promoted, not copied.** `decideEffectiveDatedWrite` now lives in
  `@emgloop/shared` and PR 2's expectation repository was refactored onto it, so the platform has one
  definition of what an overlap is. Two copies would eventually disagree about the boundary date —
  the one case that matters, because closing a declaration and opening its successor produces
  exactly that adjacency.

⚠️ **Migration `20260821000000_ci_stage3_source_authority` is NOT APPLIED.** Additive: three tables,
four indexes, six foreign keys, five CHECK constraints and one EXCLUDE. Zero DROP, zero rename, zero
column-type change, no existing table altered, **nothing seeded**, no `CREATE EXTENSION` (btree_gist
was installed by `20260819000000` and applied on 2026-08-19).

**Zero callers, deliberately.** Nothing outside `packages/database` imports the repository — no
route, no action, no page, no script, no workflow. **No source has been registered and no authority
has been declared in production.** Following the #163/#168 precedent, the operations bridge is its
own PR rather than being folded into the persistence one.

**The SSDI buyer-report importer is DEFERRED, on repository evidence** — this plan already listed it
as an item separate from source-authority persistence. PR 4 builds the layer that makes it safe: an
importer will write a `BUYER_REPORT` source's facts, and that source is only believed for a measure
where a person has declared it authoritative. **The join identity from the buyer sheet to a Loop call
is UNRESOLVED** and must be settled before an importer is designed — it is an input contract, not an
implementation detail.

**PR 4 IS MERGED (#169) AND DEPLOYED.** Migration `20260821000000_ci_stage3_source_authority` is
applied in production and verified: all three tables exist, along with the effective-range CHECK, the
no-overlap GiST exclusion constraint, the tenant-safe composite source foreign keys, the
PROVIDER_STREAM pairing CHECK, the required identifier/reason/definition CHECKs, and the
`ON DELETE RESTRICT` protecting sources named by authorities. The persistence layer is live.

### Source authority operations bridge — MERGED #170 · PROVEN IN PRODUCTION
**Not PR 5.** PR 4 shipped with **zero production callers**, so the three tables could not be written
to at all. This is the bridge, and it is deletable the day a real operator surface ships. It follows
the #163/#168 precedent exactly.

**TWO workflows, because they are two different human acts.** `Register Measurement Source` says
"this organization is willing to believe this thing, about this measure". `Declare Measure Source
Authority` says "for this member and this measure, believe it INSTEAD of anything else". A single
dispatch that silently created a source while declaring authority over it would collapse two
statements into one act, and the run record would no longer show who decided what. An authority
declaration must name a source somebody already registered; the authority runner **cannot create
one**, and a test asserts it names no registration method at all.

- **`workflow_dispatch` only** on both — no schedule, push, pull_request or workflow_call. Authority
  is a human decision, and a job that changed it automatically would be the inference this whole
  layer exists to prevent.
- **`dry_run` defaults to true** and is the pre-write check. It resolves the organization, the
  declarer, the source and what is already in force, and **does not call the mutating method at
  all**. The preview and the write ask the SAME repository decision function, and a test drives every
  case through both to prove a dry run cannot say one thing and the write then do another.
- **One metric per registration dispatch; one member + metric + source per authority dispatch.** No
  batch mode in either.
- **No user id is ever accepted from outside.** An optional declarer email resolves through the
  organization-scoped `iam.listUsers` roster and fails closed on no match or an ambiguous one; blank
  records no actor, which the repository documents as the honest value. The email is never echoed
  into the run log.
- **No provider credential.** Neither runner reads traffic — a provider having a field is exactly
  what must NOT make it believable — so both hold only `DIRECT_DATABASE_URL`.
- **The safety suite runs before the credential is used**, so "it cannot register what it must not,
  declare what it must not, reconcile, certify, ingest, recover or measure" is a checked property of
  each run rather than a comment.

⚠️ **ONE SHIPPED CONTRACT CHANGED, deliberately: `registerSource` is now ADDITIVE.** As merged it
REPLACED a source's metric set on every call, which was sound for a whole-set declaration and became
a hazard the moment a caller existed — a one-metric dispatch would have silently deleted every other
metric the source declared, and a metric row is **not** protected by the `ON DELETE RESTRICT` that
guards the source, so authorities naming it would have started failing the gate with no write anybody
performed on them. Now: metrics not named are left alone, an identical metric is a no-op, and a
**conflicting definition id or a changed kind/provider/stream is REFUSED rather than overwritten**.
Withdrawing a metric became a separate deliberate act. **No schema change** — TypeScript contract
only. Two PR 4 tests asserting the replace behaviour were updated and six were added.

**No migration.** **Both mechanisms are proven in production.** `callgrid-calls` is registered
against the live tenant, and one real `CAMPAIGN` / `CALL_VOLUME` authority over it has been created
and read back. Registering the remaining sources and declaring the remaining authorities is a
configuration act, not an engineering one.

### Metric definition correction — MERGED #171 · PROVEN IN PRODUCTION
**Not PR 5.** The first production source registration recorded the METRIC NAME in the definition
field. Registration deliberately refuses to overwrite a definition id, which is right and left that
value unfixable through the registration path forever. This is the narrow, guarded exception — one
column on one metric row.

**THE SAFETY CONDITION IS APPLICATION-ONLY, AND THAT IS THE POINT.** Nothing in the database
references a metric ROW: an authority names the SOURCE through a composite foreign key and carries
`metric` as a plain string column, and `measureDefinitionId` is stored in exactly one place and
copied nowhere. Postgres would accept this update at any moment and report nothing wrong. The danger
is entirely semantic, so the repository refuses it itself:

**Correction is safe ONLY while no authority names that source for that measure.** Before an
authority exists nothing can have been measured from the source — the gate resolves MISSING and
withholds — so no published number depends on the old string. Once one exists, changing the
definition would retroactively redefine a published number and silently start or stop two sources
agreeing, with nothing in either to show it happened. It **fails closed**, and the operator registers
a NEW source instead — which the run summary says explicitly, so the pressure is never to find a way
around the guard.

- The guard is **per source AND measure**, not per source: an authority on a different metric of the
  same source does not block.
- The guard is **re-asked inside the write's transaction**, not carried over from the preview. There
  is no database constraint behind it, so the narrowest window between deciding and writing is the
  only protection; a residual race with a concurrent declaration remains and is documented rather
  than hidden.
- **Identity cannot be changed through it.** No input for kind, provider, stream, a source id or a
  row id, and no code path that writes one — asserted structurally.
- **Provenance is the run record.** The metric row has no reason column and adding one would be a
  migration this fix deliberately does not carry. The required plain-language reason, the
  dispatcher, and BOTH the old and new definition ids are printed and preserved in the Actions log.

**No migration.** **Proven in production:** the first registration recorded the metric NAME in the
definition field, and this bridge corrected it. `callgrid-calls` now stores
`objective-measure-binding.v1:CALL_VOLUME` for `CALL_VOLUME`.

### Stage 3 production bootstrap — MERGED #172 · APPLIED IN PRODUCTION
**Not PR 5.** Every individual mechanism above is now proven against production, and what remains is
the FIRST FULL CONFIGURATION of a tenant — which through the one-declaration workflows is dozens of
hand-filled forms, each an opportunity to mistype a campaign id, and none of them reviewable as a
whole before any of it is live. `Stage 3 Production Bootstrap` (`workflow_dispatch` only) plus
`scripts/operations/bootstrap-stage3-production.ts` apply one explicitly written plan — several
member expectations and several source authorities — in one human-dispatched run.

- **It does NOT replace the one-at-a-time workflows.** `Declare Member Expectations` and `Declare
  Measure Source Authority` remain the long-term correction and maintenance tools. This is bootstrap
  tooling, deletable the day a real operator surface ships.
- **Why multi-member is allowed here.** The single-declaration workflows refuse batch mode because a
  declaration is a human statement. That objection is about INFERENCE, not arity: here every
  statement is separately and explicitly present in the plan the human wrote, nothing is derived from
  traffic or from a sibling entry, every entry gets its own preview line, result line and stable
  index (`EXPECTATION[1]`, `AUTHORITY[2]`), and processing is sequential.
- **The runner classifies nothing.** It never decides whether a campaign is expected, excluded or
  unconfigured, which source is authoritative, which measure a source owns, or which date anything
  takes effect from. It reads no calls, no revenue, no webhook configuration, no reconciliation
  verdict and no import, and holds no provider credential.
- **It decides nothing the repositories already decide.** Per-entry validation IS the two shipped
  runners' own `validateRequest` functions and their `resolveDeclarer`, imported rather than
  re-typed. The only reasoning that is new is about the plan AS A WHOLE.
- **Full-plan preflight, then sequential guarded writes.** Every entry is previewed through the
  repository that owns it before any entry is written; one blocked preview ends the run with **zero
  writes**. It is deliberately **not** a transaction across two repositories — inventing one would be
  a redesign — so a concurrent change landing between the preflight and a write stops the run at that
  entry and the summary reports `OVERALL_RESULT=PARTIALLY_APPLIED` with `FAILED_INDEX`, never
  success. Re-running converges: applied entries report ALREADY_EQUIVALENT and write nothing.
- **Two entries about the same subject are refused, whatever their dates.** A preview is asked
  against the record as it stands and cannot see a sibling entry that has not been written yet, so a
  plan carrying a declaration and its successor would preview as though neither superseded the other.
  The successor goes through the single-declaration workflow afterwards.
- **The plan is an input, never a file in this repository.** No campaign id, organization slug,
  source key or date is committed in the runner or the workflow, and a test asserts it.

**No migration.** **APPLIED IN PRODUCTION 2026-08-20**, dry-run first, on a plan carrying only what
repository evidence could support: `WRITTEN_COUNT=2 EQUIVALENT_COUNT=1 SUPERSEDED_COUNT=0
FAILED_INDEX= OVERALL_RESULT=APPLIED`, every entry read back through its repository.

| Entry | Result |
|---|---|
| SSDI 1696 `EXPECTED` from 2026-08-05 | CREATED · `cmt0sj3o8000291lo6gxyfrfj` |
| Spanish FE `CALL_VOLUME` → `callgrid-calls` from 2026-08-05 | ALREADY_EQUIVALENT · `cmt0pq33z00021044ld34tish` — **idempotency verified against real production state** |
| SSDI 1696 `CALL_VOLUME` → `callgrid-calls` from 2026-08-05 | CREATED · `cmt0sj3qn000691lou3d0exvf` |

⚠️ **THREE CAMPAIGNS ARE DELIBERATELY UNDECLARED, AND MUST STAY THAT WAY UNTIL A DATE CAN BE
SUPPORTED.** Spanish FE `cmo93ju7606k306k1of3tttac`, Home Security Internal
`cmphdtnu504eh07ii5aul38mz` and SSDI Retainer `cmo1siqoq033t07jngw973suv` are each settled as
`NOT_CONFIGURED` / `PROVIDER_CONFIG_VERIFIED` — **the STATE is decided; the `effectiveFrom` is not.**
"No webhook" is a statement about today. The 2026-08-05 reconciliation names three campaigns with
zero Loop representation but never their identities, and zero representation proves records did not
arrive, never that no webhook was the reason. Declaring `NOT_CONFIGURED` from 2026-08-05 would file a
possible delivery failure as a correct absence, permanently.

**And do not date them today as a workaround.** An effective-dated write refuses a predecessor
starting on or after an existing row's start date, so a row dated now makes the 2026-08-05
declaration unwritable through the normal path — the same trap as the mistyped definition id in #171.
Undeclared resolves `UNKNOWN`, which withholds and stays cheap to correct. What would settle it is
CallGrid's own webhook-attachment history for those three campaigns covering 2026-08-05; #165's
commit message records that **two** of the three zero-representation campaigns were once verified in
the provider's interface as never attached, without naming which two.

### PR 5 of 7 — the readiness gate, wired (MERGED #173 · DEPLOYED)
`assessReadiness` has been pure, tested and **unwired** since #165, and PR 3's reconciliation
persistence was inert without it. This connects it: a measure may now be computed only when, for
EVERY date in both windows, the day was observed **and** reconciled, every bound member's expectation
is known and uncontradicted, and exactly one authoritative source is resolved for that member and
that measure.

- **One gate, not two.** `MeasurementInput.observation` became `MeasurementInput.readiness`, still
  REQUIRED, so the type system still refuses to compile a caller that never asked.
  `assessReadiness` evaluates observation first and returns on it, so a second `observation` field
  would be one question asked twice with nothing forcing the answers to agree.
- **Refused before any aggregate is read.** The service returns without querying a single aggregate
  when the gate objects, so no value is computed and then hidden — the difference between a guard and
  a curtain, and the shape of a defect Stage 2 already shipped once.
- **Two additive repository reads.** `ProviderReconciliationRepository.factsForDates` (the read
  `memberFactsForDates` was documented as anticipating) and
  `MarketplaceCallRepository.partitionPopulationWindows`. The second returns EVERY bound member
  including ones that contributed nothing — a `groupBy` alone would let a campaign that went silent
  vanish from the population, which is exactly the August 2026 shape.
- **Day facts are resolved once per run**, not once per objective: a day's reconciliation is a fact
  about the stream and the date, so two objectives can never disagree about the 11th.
- **`unattributedCalls` is computed, not assumed zero.** It is structurally zero under today's
  selection; asserting that instead of asking would be true only until selection widens.
- **`outcomeDays` is empty, and that fails closed.** `SourceOutcomeDay` is not persisted, so a
  BUYER_REPORT authority resolves `AUTHORITATIVE_DATA_PENDING` rather than being computed from
  whatever sits in the call rows. No BUYER_REPORT source is registered, so the branch is unreached —
  and a test pins the refusal anyway.
- **The measurement path cannot write the facts it gates on.** A source-inspection test fails if the
  service ever names `declare`, `declareAuthority`, `registerSource`, `recordDay`, `certifyDay` or a
  Prisma delegate: a gate that could unblock itself is decoration.

**No migration.** Merged as #173 on top of #174, which removed two raw NUL bytes that made
`provider-reconciliation.repository.ts` classify as binary and vanish from `grep`.

### What production actually says now
**Observation is complete** for the fourteen-day window. **The first reconciliation has been run**,
and it is the reason the gate exists.

**2026-08-06 — `state=UNKNOWN_EXPECTATION`, written, `reconciled=false`.** 1220 provider identities,
1129 local, `intersection=1129`, `providerOnly=91`, **`localOnly=0`**. All three set equations hold,
so the comparison is sound and the finding is real:

| Member | Expectation | provider | local | providerOnly |
|---|---|---|---|---|
| SSDI 1696 `cmng68vp2001d06inikyf6zqh` | **EXPECTED** | 884 | 880 | **4** |
| SSDI Retainer `cmo1siqoq033t07jngw973suv` | UNKNOWN | 83 | 0 | 83 |
| Spanish FE `cmo93ju7606k306k1of3tttac` | UNKNOWN | 2 | 0 | 2 |
| `cmjpxdd2o05mg07l5hieyhrge` | UNKNOWN | 2 | 0 | 2 |

- **A fourth undeclared campaign exists** (`cmjpxdd2o05mg07l5hieyhrge`). The configuration set is
  larger than the four campaigns discussed so far.
- **249 of the 1129 local calls come from campaigns that deliver perfectly and are still undeclared**
  (`providerOnly = 0`, so they do not trigger the day-level state). They will still withhold
  `CAMPAIGN_EXPECTATION_UNKNOWN` for any binding that contains them — the day state understates how
  much configuration is missing.
- ⚠️ **`UNKNOWN_EXPECTATION` MASKS the expected gap at the day level.**
  `deriveReconciliationState` tests unknown expectation BEFORE `providerOnlyExpected > 0`, so
  resolving the three declarations would move 2026-08-06 to `UNRECONCILED`, **not** to `RECONCILED`.
  The four SSDI 1696 calls are a genuine delivery defect, and Aug 5 was 621/622 — two of two
  reconciled days show the same small persistent leak. **The masking is only in the day summary;**
  `assessReadiness` reasons per member and reports `POPULATION_INCOMPLETE` regardless.
- **Nothing was recovered, no expectation was altered, no historical date was manufactured.**

**There is therefore no honest READY population today.** SSDI 1696 is the only campaign that is both
declared and authoritative, and it is short 4 calls on a date inside the window.

### Reconciliation evidence sweep — IN REVIEW, NOT MERGED
The gate stopped at 2026-08-06, correctly, which left thirteen dates needing thirteen hand-filled
dispatches. `Reconcile Provider Days` gains an explicit **`mode`** input: `gate` (default, unchanged)
and `evidence`.

- **Evidence mode changes exactly one branch** — what happens after a day whose row was WRITTEN. It
  alters no verdict: the same day yields the same state either way, because the state is decided by
  the service and the pure contract, neither of which knows the input exists.
- **Every stop that protects correctness is unchanged in both modes.** A comparison that contradicts
  itself writes nothing and ends the run; a provider or persistence error aborts it (no `try/catch`
  was added); and a stored state this build cannot read stops the run rather than being filed under a
  guess. `reconciliationCertifies` is untouched and `RECONCILED` is still the only certifying state.
- **SUCCESS is reserved for a window where every requested date reconciled.** Anything else is
  `COMPLETE_WITH_FINDINGS`, which exits 0 — collecting evidence is the job and it succeeded — with a
  GitHub warning naming the finding dates so nobody has to open the log to learn there were any.
- **The summary buckets every requested date**: `RECONCILED_DATES`, `UNRECONCILED_DATES`,
  `UNKNOWN_EXPECTATION_DATES`, `INCONCLUSIVE_DATES`, `FAILED_DATE`, `OVERALL_RESULT`. Disjoint,
  ordered as supplied, and the 2026-08-06 shape is pinned as a regression fixture.
- **No second runner and no second reconciliation engine** — one operations surface, one
  `reconcileDay()`.

**No migration. No production run — the workflow has not been dispatched in either mode.**

### Production ingestion gap — 2026-08-06 to 2026-08-19 (INVESTIGATION, no fix)
The full fourteen-day evidence pass is complete: all fourteen days certified, all fourteen
reconciled. **10,561 of 31,744 provider identities never reached Loop — 33% of the window. 9,052 of
the missing are on a campaign declared EXPECTED.**

| | |
|---|---|
| 08-06 | 7.5% lost · 4 EXPECTED |
| 08-07 | 4.6% lost · 0 EXPECTED |
| 08-08, 08-09, 08-15, 08-16 | RECONCILED (weekend/low volume) |
| **08-10** | 4.6% lost · **167 EXPECTED** · 2.5× the volume of any other weekday |
| **08-11, 08-12, 08-13** | **100% lost.** 9,984 identities, **zero** local rows |
| 08-14 | 0.9% lost · 0 EXPECTED — immediate, near-complete recovery |
| 08-17, 08-18, 08-19 | 0.5–0.9% lost · 1, 13, 2 EXPECTED |

**What the code proves.** `IngestionService` writes the `IntegrationEvent` **first, in RECEIVED
state, before any processing**, and reconciliation's local population is that table unfiltered by
status. So `localUnique = 0` cannot be a normalization, projection, enrichment or workflow failure —
every one leaves a row that would still be counted. **The loss is at or before the webhook route's
verification gate, or the deliveries never arrived.** The route has exactly four pre-ingest exits and
none writes a row: 404 org-not-found, 400 invalid-json, 401 verification-failed, or an uncaught throw.

**Ruled out:** a code change (`main` had **no commit, and so no deploy, between 2026-07-30 23:34 and
2026-08-14 15:24** — the outage sits entirely inside that gap); a schema or identity change (no
migration applied 08-05 → 08-16); occurrence, window or timezone logic (the ±2-day local scan margin
dwarfs any DST error, and adjacent days reconciled cleanly on the same code).

⚠️ **`IntegrationEvent.receivedAt` is `@default(now())` and `ingest()` never sets it, while
reconciliation selects local rows by `receivedAt` ±2 days.** Importing the missing calls through the
existing sync would recover the DATA and leave 08-11 → 08-13 reconciling as 100% missing **forever**.
The import path exists; a recovery that reconciles does not. **That is a contract decision to settle
before anyone imports anything**, not an implementation detail.

**Nothing has been recovered, no expectation altered, no webhook configuration touched.**

### Reconciliation evidence reader — MERGED #176
`reconcileDay` stores a `localRowsScanned` / `localInWindow` / `localUnresolvedOccurrence` /
`localMissingIdentity` / `truncated` block on every row. Nothing printed it, so it has been in
production since the first run and has never been read. `Read Reconciliation Evidence`
(`workflow_dispatch` only) prints it.

It separates the two faults that produce the same zero: `localRowsScanned = 0` means nothing was ever
received; `localRowsScanned > 0` with `localInWindow = 0` means rows arrived and something kept them
out of the day. One is an ingestion outage, the other a data defect, and they need opposite responses.

- **READ-ONLY by construction.** Two seams — one organization lookup, one scoped `findDay` — and
  neither has a write method. No provider credential, no `fetch`, no adapter, no raw SQL, no Prisma
  delegate; asserted by source inspection, run **before** the database credential is used.
- **A missing row is a result, printed as MISSING, never skipped.** A finding never makes the run red;
  only a precondition failure does. An inspection tool that went red on findings is a gate wearing an
  inspector's name.
- **No PII and no call identity.** Member ids and declarations are printed; the stored display label
  deliberately is not.

**No migration. No production run — the workflow has not been dispatched.**

### The Aug 11-13 evidence, read (2026-08-20)
`Read Reconciliation Evidence` was dispatched for 2026-08-10 to 2026-08-14. All five rows found.

| Date | providerUnique | localUnique | localInWindow | localRowsScanned |
|---|---|---|---|---|
| 08-10 | 7,298 | 6,963 | 6,963 | — |
| **08-11** | 4,239 | **0** | **0** | **6,970** |
| **08-12** | 2,943 | **0** | **0** | **9,389** |
| **08-13** | 2,802 | **0** | **0** | **2,498** |
| 08-14 | 2,449 | 2,426 | 2,426 | — |

`localUnresolvedOccurrence=0`, `localMissingIdentity=0`, `truncated=false` on all three.

**`localRowsScanned` counts every callgrid `IntegrationEvent` received within ±2 days of the business
date, regardless of status and regardless of which day it occurred on.** For date *D* the band covers
Eastern days *D−2 … D+2*, and the observed totals are exactly the neighbours' known populations:
7+6,963 = **6,970**; 6,963+2,426 = **9,389**; 2,426+72 = **2,498**. Three independent windows, exact
to the unit, **no residue** — not one row that could be a misfiled Aug 11-13 call.

⚠️ **`localMissingIdentity` is computed AFTER the in-window filter, so its zero here is vacuous.** It
says nothing about identities. Do not read it as "identities were fine."

**Ruled out:** timestamps outside the window (would appear as scanned rows beyond the neighbour
totals); occurrence misfiling (`localUnresolvedOccurrence=0`, and occurrence comes from the payload,
never `receivedAt`); a status or stage filter (**there is none** — `RECEIVED`, `PROCESSING`,
`PROCESSED` and `FAILED` all count, so a pipeline failure leaves a counted row).

**Not ruled out, because the ±2-day band cannot see it:** rows arriving more than two days late; rows
under a different `provider` string; rows under a different `organizationId`.

⚠️ **RECOVERY THROUGH THE EXISTING SYNC WOULD MAKE THIS WORSE, NOT BETTER.** `ingest` never sets
`receivedAt`, so a `create` stamps today and reconciliation — which selects by `receivedAt` ±2 days —
would never scan those rows. The calls would appear in `MarketplaceCall`, the CRM and analytics while
the completeness ledger kept asserting they never arrived. And the outcome is not even uniform:
`ingest`'s idempotency lookup is `{provider, externalId}` with **no organization scope**, so a call
that already has a row anywhere takes the `update` branch and keeps its ORIGINAL `receivedAt`. Which
calls fall in which bucket is exactly what the coverage read answers.

### Integration event coverage reader — IN REVIEW, NOT MERGED
`Read Integration Event Coverage` (`workflow_dispatch` only) reads callgrid `IntegrationEvent` rows
over an explicit **inclusive** range of delivery dates and prints aggregates only: per receivedAt day
with the status split, per occurrence day, and the **cross-timing** pair that names both at once.

It exists for one line: `occurrenceDate=2026-08-11 receivedDate=2026-08-20` would mean the calls
arrived late and reconciliation could never have counted them. Its absence, with the occurrence
buckets empty over a wide range, would mean Loop never persisted them at all.

- **Reuses `listEventsReceivedBetween` and the canonical `resolveCallOccurrence`.** No second query
  path, and explicitly **no second occurrence resolver** — two would eventually disagree about
  exactly the rows under investigation.
- **Counts only, enforced by shape.** Every row is reduced to a delivery date, an occurrence date and
  a status the instant it is read; no payload, id or label survives the loop.
- **`missingIdentity` is counted over EVERY scanned row here**, unlike reconciliation's counter, so a
  zero is a fact rather than an artefact of an empty window.
- Three read-only seams, `DATABASE_URL` only, safety suite before the credential.

**No migration. No production run — the workflow has not been dispatched.**

**PR 6 onward is NOT AUTHORIZED.** `SourceOutcomeDay` persistence, the buyer-report importer and any
Stage 3 UI remain out of scope until separately authorized. The buyer-report join identity is still
**UNRESOLVED**.

## Business Identity Architecture v1 — SUPERSEDED. Do not use as authority.

_Last updated: 2026-09-15._

This block used to record an unmerged assessment (ten artifacts never committed, 19 open decisions). Its
conclusions were overtaken and **must not be treated as current architecture**:

| Superseded claim | What is authoritative instead |
|---|---|
| The cognitive identity layer "cannot be reused"; KEEP_SEPARATE | A Party is a governed reading of `CognitiveIdentity`; there is no Party table (`packages/shared/src/party.ts`, #219) |
| No governed establishment existed | `PartyService.create/establish` with provenance, OWNER/ADMIN approve (#224) |
| Customer becomes a DomainProjection | Customer is **Intake** authority; `CustomerPartyLink` composes it with an established Party (#225; Product decision 8 amended 2026-09-15) |
| 19 open approval decisions | Replaced by the #219–#225 decisions and the 2026-09-15 decisions in `docs/architecture/identity-evidence-resolution.md` |

**Still open from that assessment:** there is no Opportunity model (the CRM "pipeline" is an Intake
status string). `/crm/merge` still repoints facts between Intake records irreversibly with a counts-only
audit; merged-away records stay in lists, search and counts. `CustomerPartyLinkService` now refuses a
merged-away record, but the merge itself needs its own decision.

## Loop Time Authority — MERGED (#238, verified on `main` by content)

_Last updated: 2026-09-15._

Product decision T-01–T-12 locked in `docs/architecture/loop-time-authority.md`: UTC instants, the
server clock for anything consequential, and every human-facing date in the signed-in person's current
device IANA zone. There is no EMG business timezone, and the fallback is UTC, labelled. One authority:
`@emgloop/shared` `loop-time.ts` plus `apps/web/src/time/`. Fixes the verified 2026-09-14 defect where
dates showed Sep 15 at 8:37 PM Eastern.

**Product decisions recorded (PD-1, PD-2; ADR amended):**
- **Work OS targets:** use the entering user's effective timezone. Calendar-only targets stay calendar
  dates; instant targets persist as UTC plus their originating IANA zone; never an Eastern default.
  Implementation is a follow-up, not part of #238. Today, entry is Eastern, a date-only target becomes
  5 PM ET, and no originating zone is persisted.
- **Setup wizard timezone:** it is the explicit user preference (outranks the device). Its legacy values
  are not read until audited. Until then: validated device zone, then labelled UTC.

**Next:** PD-1 implementation (Work OS targets) and PD-2 preference governance, each its own branch.

## Identity — SLICE 1 MERGED (#239) · AUDIT RUN (#240) · RECORD MERGED (#241) · 2.0 MERGED (#242) · 2.0b PARTY REFERENCE (#243)

_Last updated: 2026-09-15._

**Authority:** `docs/architecture/identity-evidence-resolution.md` (decision record, 2026-09-15, including
PD-I2-01–09). Charlie and Lexi's Loop Product and UI Architecture v1.0 controls UI/product architecture
alongside the Constitution: `docs/product/loop-product-ui-architecture-v1.0.md`.

**Specification conflicts resolved (Product C-01–C-05, 2026-09-15):**
- C-01: five operating areas. Administration and Accounting are not peer areas.
- C-02: Creator Hub is not a peer area; Operations → Creators.
- C-03: CallGrid is split by authority.
- C-04: People are established PERSON Parties, Companies are established COMPANY Parties, and legacy
  Customers are Intake Records.
- C-05: identity posture, never a confidence number.

These are recorded in `loop-application-structure.md` (D1–D5 amended) and the decision record. They are
information architecture only, with no route move in Identity 2.0/2.0b.

**Slice 1 (#239, verified in production):** ingestion records facts and never creates, selects, attaches
to or modifies a Customer. Production audit after deploy: 0 People created, 0 provider interactions
attached, 0 workflow runs, interactions still stored.

**People population audit (#240, run 34986946619):** 24,590 Customers; 24,579 (99.96%) CallGrid caller-ID
residue; 2 with names; 24,585 with no human-work evidence; 0 Parties, IdentityEvidence, resolution links
or CustomerPartyLinks; 274 calls attached on last-seven-digit match only; 319 attached calls with a
different caller number. Dispatched with the default `slice1_at` (merge instant), not the approved
13:52:00Z; the zero counts still hold. Nothing was remediated.

**Slice 2 direction approved (2026-09-15), not implemented:** evidence tiers (caller ID stays WEAK at any
frequency); no machine attribution at launch; EMPLOYEE proposes and creates unestablished Parties,
MANAGER confirms attribution and sets flags, OWNER/ADMIN establish, link and supersede; hash-only
unresolved evidence with per-class retention/use policy configured before any evidence is produced;
People = established, non-superseded PERSON Parties (starts at 0); Customer is Intake authority and
`customerId` systems are preserved; dormant cognitive resolver retired as an independent resolver.

**Sequence:** 2.0 pure contracts → 2.0b Party Reference Contract (then Relationship/Participant may
proceed in parallel) → 2.1a retire resolver → 2.1b evidence schema → 2.2 source policies → 2.3 new-fact
extraction → 2.4 review read models → 2.5 governed resolution → 2.5b supersession → 2.6 People / Intake
projection. **Not authorized:** historical evidence backfill, machine attribution, automatic
anonymous-history attribution, verification build, legacy remediation.

**Separate operational cleanup (awaiting explicit approval):** deactivate the two inert seeded call
workflows; resolve the workflow run stuck RUNNING since July.

**Product/UI reconciliation passed (2026-09-15).**
- **#241 (merged, `8afac50`):** decision record, specification and C-01–C-05.
- **#242 (merged, `c0a17fa`):** Identity 2.0, pure evidence, authority and use-policy contracts.
- **#243:** Identity 2.0b, Party Reference Contract and read-only resolver. It updates the record's
  status line.

None needs a migration. Product approved the six fail-closed contract readings on 2026-09-15 (see the
record's decisions log). Product approved the three 2.0b readings as implemented on 2026-09-15: the 8-hop
depth guard, NOT_FOUND on a PERSON ↔ COMPANY chain, and refusing (never substituting) a superseded id on
write. The rules for the 2.5b supersession writer are recorded in §8.

#243 merged as `543c645` and was verified on `main` by content.

**Next:** see *Foundation handoff* below. No 2.1a or later slice without new authorization.

## Foundation handoff — AI RUNTIME ON MAIN, OFF · BRAIN B0–B6 MERGED, MIGRATION 36 DEPLOYED · STAGING ACCOUNT EXISTS, NOT BOOTSTRAPPED, NOTHING DEPLOYED · B7 PRE-DEPLOYMENT PR IN REVIEW

_Last updated: 2026-09-17._ `main` is `b9ae393`. #244–#284 are merged and were verified by content.
- Each squash commit matches its PR's reviewed head: #266 `8b8fac3`, #267 `d069c7d`, #268 `ce3f606`,
  #269 `d6b5742`, #270 `5c4dec0`, #271 `7f33d3f`, #272 (B0, docs) `71006dd`, #273 (B1, schema) `c3ac3f2`,
  #274 (B2, contracts) `c85911a`, #275 (B3, AWS design) `6fdab5e`, #276 (B3.1, DRAFT and fallback) `5d73d46`,
  #277 (B4, persistence) `f744fca`, #278 (B5, Loop-side boundary) `65276cf`, #279 (Google Private V1
  contract) `97bf187`, #280 (UI-0 matrix) `12b9951`, #282 (UI-1) `1de058e`, #281 (B6) `a824564`, #283
  (brand wordmark) `50c07b8`, #284 (B6 definition pass, head `c64bfa9`) `b9ae393`.
- Validation on `main` is green. The only failures are the known baselines: `marketplace-intelligence`
  typecheck, and lint, which was never configured.
- Production has 36 migrations (run `35160530756`).
- The operator surface (#264) is on `main` as temporary engineering UI.
- Production holds 0 established Parties and 0 Relationships. Nothing has been converted, linked or
  cleaned up.

**AI runtime: built, switched off.** Zero Anthropic and zero OpenAI requests have been made.
- **#266 AI-1:** every provider call is reserved in `ai_invocations` inside a serializable transaction
  before dispatch, and reconciled after. Activation allowlists, a versioned routing policy, a budget
  policy and an invoker authorizer.
- **#267 AI-2:** Node 22 for provider code.
  - `apps/web/src/ai/ai-environment.ts` is the one server-only reader of the credentials and `LOOP_AI_*`.
  - `sdk-clients.ts` is the one SDK importer.
- **#268 AI-3:** adapters speak current APIs.
  - Anthropic uses `output_config.format`; OpenAI sends `store: false`.
  - Evidence is escaped.
  - Failures carry no provider text.
- **#269 AI-4:** the verified model catalog.
  - For Case Explanation, `claude-opus-5` is primary and `gpt-6-astra` its permitted fallback (a
    per-task choice; there is no platform-wide fallback order).
  - Re-verified against the providers' own documentation on 2026-09-16, and still matching.
  - Routing `routing.2026-09-16.2`; budget `budget.2026-09-16.1-proposed`.
- **#270 AI-5:** Case Explanation.
  - Context minimization and validation v2.
  - A 20-scenario evaluation (scenarios 1–18, plus 7b and 7c).
  - A switched-off panel.
- **#271:** the schema-drift record, the Intake → Party linking recommendation, and the Charlie/Lexi
  handoff.

**Brain execution: direction approved 2026-09-16. B2–B6 merged, migration 36 deployed; the staging
account exists, but nothing executes and no Brain resource is provisioned.** See `docs/architecture/brain-execution-architecture.md`,
`brain-execution-infrastructure.md`, `brain-persistence.md`, `brain-boundary.md`, the B6 plan
`brain-aws-implementation-dossier.md` and the B6 record `brain-aws-foundation.md`.
- **The split:** Netlify stays the product, auth boundary and Brain API. Neon stays authoritative. AWS
  runs every Brain step and every provider call, for INTERACTIVE and DURABLE alike, behind a Loop-owned
  orchestrator port.
- **Orchestration:** Inngest is dropped. Step Functions, then Temporal, are escalation options only.
- **Trust:** no long-lived AWS credentials in Netlify. Neon commands plus a JWT doorbell, approved
  subject to implementation review.
- **Keys:** provider keys end up in AWS Secrets Manager.
- **Scope of the approval:** architecture only. No AWS resource exists, and nothing in Netlify has
  changed.
- **Sequence (Matt, 2026-09-16), one reviewed PR each:**
  - B0: docs, merged (#272);
  - B1: schema-only drift alignment, merged (#273), no migration;
  - B2: pure contracts, merged (#274);
  - B3: AWS trust, security and infrastructure **design**, merged (#275);
  - B3.1: DRAFT and provider-specialization reconciliation, merged (#276);
  - B4: durable persistence, merged (#277); migration 36 **deployed**;
  - B5: the Loop side, merged (#278), no migration;
  - B6: AWS foundation for staging, **merged (#281, #284), not deployed**;
  - B7: Case Explanation on AWS, with the first live request in staging on a synthetic Case. The
    pre-deployment PR is in review (details below); nothing is deployed;
  - B8: the first DURABLE task, the outbox repair and notifications.

**B7 pre-deployment (in review, branch `feat/b7-predeploy-access`). Nothing created: no AWS, GitHub
settings, Neon, Netlify or provider change; no bootstrap; no deployment.**
- **Adds** (record §14–15):
  - the GitHub deploy identity as a committed template, `infra/brain/access/github-deploy-access.yaml`,
    with tests: trust only for `brain-staging`, exactly three CDK role ARNs, no wildcards;
  - `RetainExceptOnCreate` on the 13 kept resources, so a failed first deployment can be retried;
  - the credentials action pinned to the v6.3.0 commit, with `allowed-account-ids`;
  - the corrected bootstrap procedure (CloudShell, outside the repository);
  - runbook steps for the organization trail, the central $100 budget, the exact `brain-staging`
    environment and the applied-quota check.
- **GO / NO-GO (2026-09-17):**
  - **Bootstrap:** GO once the organization trail is logging and Matt says so. The quota does not
    block it.
  - **Deployment:** NO-GO until all of these exist:
    - the applied Lambda limit is at least 118;
    - the deploy identity (runbook step 9);
    - the `brain-staging` environment (step 11);
    - the bootstrap (step 14);
    - the trail and the budget (steps 4–5);
    - staging Neon (Part 5).

**B6 (merged #281 and #284): the AWS foundation. BUILT AND TESTED, NOT DEPLOYED, NOT BOOTSTRAPPED. No
migration; no Brain resource on AWS; no provider call; AI OFF.**
- **The accounts (Matt, 2026-09-17):**
  - the organization's management account is **EMG Loop Production, `670682108352`**;
  - the member account is **Loop Brain Staging, `065148797865`**, `us-east-1`;
  - IAM Identity Center is enabled, and Matt has `AdministratorAccess` through the portal (verified);
  - there are no long-lived IAM credentials, and nothing was created by hand;
  - Cost Explorer is initialized, and the $100 budget is planned but not created;
  - the Lambda concurrency limit is **10**, with an increase to 1,000 pending;
  - Loop Brain Staging has **no CloudTrail trail**, and **no CDK bootstrap**.
- **The definition pass** (#284, record §15):
  - the stack is pinned to that account, and the app refuses any other;
  - the recommended CDK feature flags are pinned;
  - the tests synthesize with the CLI's context and add target, bootstrap, async-handler and
    secret-hygiene checks;
  - the deploy workflow checks the account twice;
  - the runbook carries the real account and the exact bootstrap command, which has **not been run**.
- **Record:** `docs/architecture/brain-aws-foundation.md`; §14 is the pre-deployment report.
  **Matt's steps:** `docs/runbooks/brain-aws-staging.md`.
- **The runtime,** `apps/brain-executor`, revision `loop-step-runner.r1`, DARK only. It provides the
  doorbell authorizer, the dispatcher, the worker (a step runner) and the sweeper.
  - **The worker covers:** lease, re-read, context, checkpoints, questions and resume, cancellation,
    kills and the worker switch, deadline promotion, and bounded retry.
  - **It ends every job at the governed commit boundary:** FAILED `COMMIT_REFUSED`, because no owner
    gate exists. It never calls a provider and never commits.
- **The second deployable,** `infra/brain` (AWS CDK, its own lockfile, us-east-1, `nodejs24.x`). It
  contains:
  - an HTTP API doorbell with a Lambda authorizer and a DynamoDB replay ledger;
  - two SQS queues with DLQs;
  - five functions with per-role IAM, using no wildcards and no managed policies;
  - two KMS keys (data, and worker signing);
  - six secrets: the provider placeholders, which no role can read, the three Neon URLs and the
    checkpoint secret;
  - seven closed-by-default parameters;
  - a 5-minute sweeper schedule;
  - ten alarms.
- **CI:** `brain-infra-ci` on PRs. **Deploy:** `brain-infra-deploy`, manual, through GitHub OIDC and
  the `brain-staging` environment. **Not run.**
- **Loop-side changes:**
  - Loop's CONTEXT answer now says whether a result could be committed (`commitGate`) and returns
    the principal record;
  - the step kind `SYNTHETIC`;
  - the command lookup carries the execution class.
- **Two recovery gaps found and fixed:**
  - a job stranded RUNNING after a failed delivery;
  - stale-lease recovery skipping ACCEPTED jobs.
- **Evidence:**
  - the executor's 27 tests;
  - a dark run on real PostgreSQL 18 under the restricted roles;
  - the web-to-executor token compatibility test;
  - 29 infrastructure tests after the definition pass (template, IAM, target, secret hygiene,
    adapters, bundles free of provider code), and 37 after the pre-deployment PR (deploy identity,
    retention);
  - 55 of 55 planted defects caught (9 initial survivors were real test gaps and are closed; 1 anchor
    was fixed).
- **Stopped at:** Matt's setup, in the runbook's order:
  1. the organization trail and the central budget (steps 4–5), plus the guardrails (step 3) and
     `LoopBrainOperator` (step 7);
  2. the deploy identity from the committed template (step 9), and the `brain-staging` environment
     (step 11);
  3. the applied Lambda limit of at least 118 (step 13);
  4. the bootstrap (step 14), **only on Matt's go-ahead**;
  5. staging Neon (Part 5);
  6. then explicit deployment authorization.

  The staging Loop wiring (Part 7) is a separate Netlify decision.
- **Follow-ups before B7:**
  - a cap on recovery attempts;
  - a sweeper pass for killed waiting jobs;
  - activation re-decided at paid boundaries;
  - a way to record stored controls;
  - the Case Explanation result store (a migration).

**B5 (merged #278): the Loop-side Brain boundary. No migration; no AWS; no provider call; AI OFF.**
- **Record:** `docs/architecture/brain-boundary.md`. **B6 plan:** `docs/architecture/brain-aws-implementation-dossier.md`.
- **The Brain API** (server actions and routes): submit, status, list, question, answer, cancel.
  - **Order:** the session's organization and person; authorization first; stored controls AND the
    environment floor; the route gate; the subject in the organization; accept; ring.
  - **Visibility:** status, question and answer are the principal's only. Stopping is the principal's
    or an OWNER's or ADMIN's.
- **The internal Brain API** (`/api/internal/brain/{access,context,commit}`) for workers only.
  - **Tokens:** ES256, pinned keys, bound to job, generation, purpose and body.
  - **Authority:** the loaded job, never the request. Access and context are re-decided per call.
  - **Commits:** checked against re-assembled evidence and handed to an owner's gate. **No gate
    exists yet.**
- **Doorbell signing:** 60 s tokens with `{commandId}` only; never throws; never blocks. The environment
  reader is `brain-environment.ts`, and nothing is configured.
- **The executor's surface** (`BrainExecutorStore`), an AES-256-GCM checkpoint sealer, and a test-only
  reference executor (end to end, a question round trip, cancellation mid-step).
- **Brain Activity composed,** in the ADMIN workspace. A B5 finding fixed: the lane had no workspace.
- **Retired:** `/api/brain/call-handling-briefing`, its record, and its only repository read.
- **Tests:** 16 web, 24 database and 4 shared.
- **Mutation testing:** 63 of 63 planted defects caught in the final full run, against a green
  baseline. The first runs left eight survivors, all real test gaps and now closed:
  - a ring before its command was committed;
  - a demoted principal;
  - membership checked apart from the authorizer;
  - another job's call;
  - a resume without a recorded reply;
  - an organization's switch-off read as a platform pause;
  - an unset doorbell variable;
  - an unchecked sealed-payload header.
- **Blockers before the first live request** (not before AWS provisioning):
  - a Case Explanation result store (migration plus a retention decision);
  - an operations workflow to record platform controls;
  - the Anthropic effort decision.

**B4 (merged #277; migration 36 deployed): Brain durable persistence.**
- **Record and dossier:** `docs/architecture/brain-persistence.md`.
- **Tables:** `brain_jobs`, `brain_job_transitions`, `brain_job_steps`, `brain_job_waits`,
  `brain_commands`, `brain_events`, `ai_controls` and `ai_control_current`.
- **`ai_invocations` gains** nullable `brainJobId`, `brainStepKey` and `specializationPolicyVersion`.
- **Four declarations, four sets of columns:**
  - capability route;
  - result type, owner and subject;
  - execution class (only promotion changes it).

  There is no provider or model on any Brain table, and vocabularies are text, not enums.
- **Tenancy in the database:**
  - composite `(organizationId, jobId)` keys on every child row;
  - the principal is bound to a membership in the job's organization;
  - resumed jobs and ledger rows are tied to the same organization.

  Every repository method takes the organization first. The executor's reference lookups are the one
  unscoped path, and they return identities only.
- **Repositories:**
  - jobs: accept (idempotent), transitions, cancel, leases;
  - waits: open, one reply, expire, resume;
  - steps: checkpoint-first resume, sealed checkpoints, lost paid calls counted;
  - commands and events;
  - stored controls (append-only, versioned, never stale);
  - references.
- **Activity:** the Brain-events adapter, composed in B5.
- **Restricted roles:** `scripts/operations/brain-database-roles.sql` and
  `docs/runbooks/brain-database-roles.md`. They are verified on local PostgreSQL 18 only; the worker
  cannot change what a job is.
- **Pure contracts added:** `brain-wait.ts`, `ai-controls.ts` and `brainCommandDedupeKey`.
- **Tests:**
  - 29 fake-backed tests;
  - 4 opt-in real-Postgres tests (constraints, 12-writer concurrency, rollback, deletion);
  - 1 opt-in roles test;
  - 6 shared contract tests.
- **Mutation testing:** 57 of 57 planted defects caught, against a green baseline.
  - An earlier 57-of-57 run is void: a broken test file failed every mutant.
  - The first valid run caught 53. Its four survivors were real test gaps, now closed: the retry
    write, resume before a reply, another step's in-flight calls, and another organization's events.

**B3.1 (merged #276): DRAFT and "no universal fallback", reconciled. Pure contracts, tests and docs; no migration.**
- **DRAFT is a sixth result type:** ANSWER, ANALYSIS, FINDING, RECOMMENDATION, DRAFT, PROPOSED_ACTION.
  - **Standing is fixed by type.** DRAFT is NON_AUTHORITATIVE (`BRAIN_RESULT_TYPE_STANDING`), so a
    DRAFT task is READ_ONLY.
  - **Owner.** Communications (new owner authority) holds drafts about a `CUSTOMER_CONVERSATION`
    (new subject type: the CRM's `conversations`).
  - **The action path is closed both ways.** `brainOwnershipTableViolations` proves only the Decision
    Engine holds a PROPOSED_ACTION, and that it holds nothing else.
- **A draft job cannot commit a send proposal.** The job record now carries `resultOwner`, and
  `brainCommitExpectation(job)` derives the commit expectation from the record alone.
  - A later send proposal is its own job and approval.
  - It cites the draft only as untrusted input.
- **No universal fallback order.** A task is served by another provider only when its own entry permits
  it **and** names the target. The new conformance finding is `FALLBACK_PERMITTED_WITHOUT_TARGET`.
  - The routing and specialization **data are unchanged** (`routing.2026-09-16.2`,
    `specialization.2026-09-16.1`). Only comments were clarified.
- **Independence.** Capability route, result type (with owner and subject) and execution class stay
  separate declarations. The job holds no provider or model.
- **B4 scope revised** (`brain-execution-infrastructure.md` §25):
  - the four declarations become separate columns;
  - vocabularies are text validated by contracts, not enums;
  - `ai_invocations` gains `specializationPolicyVersion` beside the job and step references.

**B3 (merged #275): the AWS design. Nothing provisioned; the only code is pure contracts.**
- **Region.** us-east-1, because production Neon is in `aws-us-east-1`, verified from the migration
  run log. The Netlify function region is not verified.
- **Executor revised.** A Loop step runner on Lambda, driven by SQS (interactive and durable queues,
  each with a DLQ), plus a one-minute EventBridge Scheduler sweeper.
  - Neon is the only workflow state; each job holds a lease.
  - This replaces B0's Lambda durable functions proposal. Durable functions and Step Functions remain
    adapters behind the executor port.
- **Trust, Netlify to AWS.** A doorbell `POST {commandId}` carrying an ES256 token, verified by a
  Lambda authorizer (pinned keys, a DynamoDB `jti` replay ledger). The dispatcher reads the command
  and its job from Neon.
- **Trust, AWS to Loop.** KMS-signed worker tokens, bound to a job, purpose and body, calling Loop's
  internal Brain API for access decisions, context and result commits.
- **Neon access.** Restricted roles for Brain tables and the ledger only; no product-table access
  from AWS.
- **Keys and interactive work.**
  - Provider keys: Secrets Manager, readable only by the worker. Netlify keeps no provider key after
    cut-over.
  - Interactive work also runs on AWS, and promotion is a state change on the same job.
- **Outbox.** Brain does **not** depend on the broken drain. Email and subscribers do (B8
  prerequisite).
- **Controls.** Stored controls in Neon, read at every boundary (≤5 s cache), with an AWS break-glass.
- **Contracts added (pure, 7 new test groups):** `brain-dispatch.ts` (identities, advance messages, leases,
  step-start deadline, run-time routing gate, worker-request check) and a new failure reason,
  `ROUTING_NOT_CONFORMANT`.

**B2 (merged #274): provider-independent Brain contracts. Pure code; no migration; nothing activated.**
- **Execution class** (INTERACTIVE, DURABLE). Presentation budget and interactive deadline are separate:
  - the presentation budget only moves the job to a background presentation;
  - the deadline promotes the job if the task supports DURABLE, and otherwise fails it by name;
  - no hosting limit is part of the contract.
- **Semantic result type** (ANSWER, ANALYSIS, FINDING, RECOMMENDATION, PROPOSED_ACTION; DRAFT added in B3.1).
  - Each type has an ownership table.
  - Standing is only NON_AUTHORITATIVE or PROPOSED.
  - A commit check covers organization, job, subject, owner, citations, evidence refs, model output
    cited as fact, and provenance.
  - Activity events are pointers only.
- **Capability route replaces `profile`.** The ledger column keeps its name and now records the route;
  pre-B2 rows stay readable.
  - The provider-specialization policy is versioned data, with a conformance check enforced by tests.
  - Case Explanation is TECHNICAL_ANALYSIS and conforms, so `routing.2026-09-16.2` is unchanged.
- **Job state machine:** ACCEPTED, QUEUED, RUNNING, WAITING_FOR_USER, SUCCEEDED, FAILED, CANCELLED.
  - There are no connection events, and a compile-time guard enforces it.
  - Idempotent submission.
  - Resume only by the principal, whose access is re-checked, for the matching wait.
  - Attributed cancellation.
  - A result that arrives after a cancel is never applied.
  - Progress is named steps, with a fraction only for a fixed plan.
- **Steps:** checkpoint-first resume; paid model calls at most once per attempt (2 paid attempts);
  bounded retries by failure class; fallback provenance that refuses shopping for an answer.
- **Trust:** the doorbell claim and body check, stored-command disposition, and an access re-check
  against the job at every boundary. There is no signing, verification or endpoint yet.
- **Executor port** with twelve named obligations. No infrastructure product is named in the contract.
- **Tests:** 41 new shared contract tests and 6 provider-specialization tests. **76 of 76 planted
  defects were caught**; the two initial survivors were real test gaps and were closed.

**Open items — NOT resolved:**
1. **Outbox drain is broken in production.** Every scheduled "Drain outbox" run since at least
   2026-09-14 fails because the repository secrets `OUTBOX_DRAIN_URL` and `OUTBOX_DRAIN_SECRET` are
   unset. Nothing delivers `state_change_outbox` events. It needs Matt, and it blocks B8's
   notifications.
2. **Schema drift: RESOLVED by B1 (#273, merged).** The migration history and the database are unchanged,
   the Prisma schema is aligned, and replay drift is zero (re-checked on `c3ac3f2`). The CI replay check
   that would stop a recurrence is **not built**. See `docs/architecture/schema-drift-2026-09-16.md`.
3. **Anthropic effort.** Anthropic says to start Claude Opus 5 at `high`; the reviewed routing uses
   `medium`, never evaluated live. Decide before the first live request, ideally after a staging effort
   sweep.
4. **First live request venue.** Recommended: AWS staging with a synthetic Case (B6). The earlier plan was
   Netlify production for one organization. Matt to confirm.
5. **Region.** Production Neon is `aws-us-east-1` (verified), so AWS us-east-1 is recommended. The
   Netlify function region is unverified and should be aligned to `iad` if the plan allows (Matt).
6. **DRAFT: decided (Matt and Charlie), reconciled in B3.1.** Still open for Charlie, Lexi and Product:
   - where drafts appear and how a person edits or sends one;
   - draft subjects beyond a customer conversation;
   - whether draft text may show while written.
7. **Settled for B3 (Matt):**
   - replies come from the originating principal only (V1);
   - routing conformance is enforced at run time too, at acceptance and before every model step;
   - Case Explanation's 20 s / 75 s are provisional product targets, not infrastructure limits.

**Blocked on a decision:** web-side Intake → Party linking. The recommendation and the narrowest fence
change are in `docs/product/intake-party-linking-recommendation.md`.
`legacy-intake-retirement-plan.md` and the handoff disagree on whether this is already authorized.

**Handoff:** `docs/product/ui-track-handoff.md` is current, including the Brain behaviours B5 serves.

**Redesign (Track 2).**
- **Controlling source:** Charlie and Lexi's *Loop Product and UI Redesign — Implementation Handoff*
  (2026-09-16), plus five prototype screenshots Matt supplied on 2026-09-17.
- **UI-0 screen map:** merged (#280, `docs/product/ui-0-implementation-matrix.md`).
- **UI-1: merged (#282; the official wordmark followed in #283)** (`docs/product/ui-1-implementation.md`).
  - **Design system (revised on Matt's correction, then LOCKED, 2026-09-17):** the redesign is Loop's
    global design system (`docs/product/loop-design-system.md` §0).
    - Desktop: a navy rail, a light top bar and a light canvas.
    - Mobile: a light responsive header, a navigation sheet and the area bar.
    - No per-area themes.
    - One `:root` palette, a navy rail and a light canvas; Loop Home is on the shared primitives.
    - Every legacy surface is repainted from the same palette (`--crm-*` are aliases).
    - The audit of 65 pages at three widths is clean.
    - The ordered migration of the remaining page structures is in that record.
  - **Shell:** the five-area shell, with the mobile area bar and menu.
  - **Subject Display System:** six subjects, four densities.
  - **CRM slice:** `/app/crm/people`, `/app/crm/people/[partyId]` and `/app/crm/relationships[/id]`,
    all from real authority.
  - **Brain work states:** provider-neutral.
  - **Honesty fix:** "Database not configured" is shown only when no database is configured.
  - **No migration and no authorization change.** The temporary operator screens remain for the
    governed acts.
  - **Ready for merge.** The next UI migration slice has not started (Matt).
  - **Open decisions** are in its §11: display labels for roles and kinds, team participants,
    filters, Search and Needs You, the People permission, and the prototype link.
- **Open decisions** are listed in that document's §11. They include who approves route moves, the
  People permission, and the prototype link, which the PDF does not carry.

**Product decisions:**
- **Approved:**
  - PD-F-01, -02, -03, -04, -06, -07, -08;
  - the AI ledger (reproducible cost, the organization's business date, no per-user cap);
  - the Brain execution direction (2026-09-16), including stored AI controls in Neon.
  - provider specialization by capability route (2026-09-16). COMMUNICATION defaults to OpenAI
    primary, TECHNICAL_ANALYSIS to Anthropic primary, and GENERAL_REASONING is named per task.
    Fallback stays governed and recorded. There is **no universal fallback order**: each task's
    entry permits and names its own (reaffirmed after B3). **Contracts and policy data merged in B2;
    the run-time gate is designed in B3; not activated**; the routing policy is unchanged. See
    `brain-execution-architecture.md` §5a.
  - DRAFT as a sixth result type, distinct from PROPOSED_ACTION; a draft never authorizes or
    performs a send (2026-09-16, after B3).
- **Deferred:** PD-F-05, -09, -10.
- **Still needed:**
  - PD-F-11 and PD-F-12;
  - AI budget values, per-job budgets and the paid-attempt limit;
  - MANAGER as a Case Explanation invoker;
  - Fable 5.1 versus Opus 5 (retention trade-off);
  - GPT-6 Astra versus GPT-5.6 Sol as fallback (cost);
  - retention for checkpoints, execution data and logs;
  - the AWS account structure and access;
  - a staging database (Neon branch);
  - the Neon plan;
  - the infrastructure-as-code tool (Charlie; CDK in TypeScript recommended);
  - the B3 executor revision, the Neon restricted roles, and who may flip platform controls;
  - the Brain experience decisions (Charlie and Lexi);
  - the web linking decision.

**Next:**
1. Review and merge the B7 pre-deployment PR (`feat/b7-predeploy-access`).
2. Matt: organization trail and budget, then the deploy identity and `brain-staging` environment
   (runbook steps 3–11, with the template taken from the merged `main` commit).
3. Wait for an applied Lambda limit of at least 118.
4. Only on Matt's go-ahead:
   1. bootstrap `aws://065148797865/us-east-1` from CloudShell (runbook step 14);
   2. staging Neon (Part 5);
   3. `brain-infra-deploy` `diff`, then `deploy`, then the Neon secrets at once (step 18).

   The deployment stays switched off.
4. Before the first request:
   - the result store;
   - the controls workflow;
   - the effort decision;
   - staging provider workspaces.
5. Fix the outbox drain secrets (Matt). This is a prerequisite for B8's notifications.
6. The Node maintenance PR: workflows on `.nvmrc`, `engines >= 22`.
7. Unrelated to AI:
   - the Relationship list filtered by kind (creator roster);
   - Opportunity and Campaign, after PD-F-11 and PD-F-12.

## Google Workspace connection — PRIVATE V1 MERGED (#286, `e16a07c`) · MIGRATION 37 APPLIED · OAUTH CLIENT CREATED

_Last updated: 2026-09-17._ Merged into `main`; the migration was dispatched the same day (run
succeeded 18:39Z) and the production OAuth client and the three Netlify variables now exist.
- **Record:** `docs/architecture/google-workspace-connection.md` §11 (the contract) and §12 (what was
  built).
- **Matt's steps:** `docs/runbooks/google-workspace-oauth.md`.

**Google Cloud (Matt, 2026-09-17):**
- the project "EMG Loop": External, Testing, with test users Matt and Charlie;
- the Gmail, Calendar and Drive APIs enabled;
- the scopes `gmail.metadata`, `calendar.events.readonly` and `drive.metadata.readonly`;
- **no OAuth client yet.**

**Built:**
- **One connection per Loop user per organization.** Gmail, Calendar and Drive are granted one
  capability at a time (incremental authorization).
- **The flow.**
  - `GET /api/integrations/google/connect` records a single-use state and nonce, stored hashed,
    bound to organization, user and session, for ten minutes.
  - `GET /api/integrations/google/callback` exchanges the code server-side, verifies the ID token
    (RS256 signature against Google's published signing keys, then the claims), reads the GRANTED
    scopes against an allowlist, and stores the refresh token sealed (AES-256-GCM,
    `LOOP_GOOGLE_TOKEN_KEY`).
- **Other lifecycle.** Disconnect, and removal of one capability (Google cannot revoke one scope,
  so the whole grant is revoked and the rest re-approved), are server actions. Expiry (a refused
  refresh, or a rotated key) turns the connection Expired and deletes the credential.
- **Onboarding and Connections.**
  - Accepting an invitation lands on `/app/onboarding/google`, which is optional: Continue or Skip.
  - Home → Connections (`/app/connections`) is available any time.
- **IAM:** a new `googleWorkspace` resource with its own grant table.
  - Every human role has view and update on **its own** connection, and nothing else.
  - **No role holds authority over another member's connection** — the unused `manage` action was
    removed on 2026-09-17; ending someone's access stays `users:update` / `users:delete`.
  - AI Employees are always denied.
- **Offboarding:** disabling or removing a member revokes their connection in the same transaction,
  and Google is asked to revoke after commit.
- **ID-token verification** (`packages/providers/src/google-workspace/id-token.ts`): the signature is
  checked against Google's published keys (`jwks_uri`, RS256 only) before any claim is read; the key
  set is cached per Google's `Cache-Control`/`Age`, refetched once for an unknown `kid` (rotation,
  rate-limited), never used stale, and every failure refuses the connection.
- **Migration** `20260917172545_google_workspace_connections`: additive, two tables. CHECKs pin the
  three scopes, the credential lifecycle, hashed state and valid return targets. It is **not
  dispatched**.

**Evidence (2026-09-17):**
- **New tests:**
  - shared contract: 7;
  - OAuth protocol: 5;
  - ID-token verification (signature, algorithms, rotation, caching, unavailability): 13;
  - database lifecycle and isolation: 26;
  - real PostgreSQL 18: 2, opt-in, run locally;
  - web: 17.
- **Full suites:** web 535, database 1375 (8 opt-in included), shared 1209, providers 195, executor
  28, infra 37. All pass.
- **Local replay:** all 37 migrations replayed on PostgreSQL 18.6, with no drift from the schema.
  The Google migration's id is dated for the day it was written (2026-09-17), which sorts before two
  migrations production already has; applying it onto a 36-migration ledger and replaying it into a
  fresh database were both checked, and both produce an identical schema.
- **Build:** `next build` passes.
- **A local run of the built app** against that database, with a test-only client, checked:
  - the connect redirect;
  - every refusal path;
  - the hashed state;
  - both pages;
  - no horizontal overflow at 390 px.

  No call reached Google.
- **Defect planting:** 14 planted defects were caught. The one survivor was a redundant duplicate
  check, since removed.

**Not done:** no Gmail, Calendar or Drive data is read yet —
`GoogleWorkspaceService.accessToken()` still has no production caller — and the app is still in
Google's Testing mode (test users only; refresh tokens expire every 7 days).

**Next:**
1. Connect as Matt and Charlie, and confirm a real grant end to end.
2. Daily Loop (draft #287) — the read path is its first phase.
3. Google verification and publishing (runbook §6).

## Daily Loop / Employee Intelligence — ARCHITECTURE MERGED (#287) · DL-0..DL-5 MERGED · GMAIL (GM-1..GM-3) MERGED

**Record:** `docs/architecture/daily-loop-employee-intelligence.md` (2026-09-17, direction approved,
product decisions recorded). **No code, no schema, no scope change, no infrastructure.** It designs the
employee surface on top of the Google connection #286 shipped: Google as a sensor, per-employee work
state, Home as Daily Loop, in four stages (metadata -> content -> Brain -> actions).

**What the research settled:**
- `gmail.metadata` forbids Gmail's `q` parameter, so there is no date-filtered search; reading bodies
  needs `gmail.readonly`, and both scopes are already restricted (CASA is required either way).
- `calendar.events.readonly` is sufficient for the Day view and meeting cards; listing calendars is
  the only thing that would need more.
- **Brain cannot run this today:** only a HUMAN may submit a job, a system-issued START is refused at
  dispatch, no result owner gate is registered, no `MODEL_CALL` step exists, nothing is deployed.
- So **V1 is deterministic and calls no model**: who is waiting on you, what you have not answered,
  what went quiet, your day, a stored daily brief, and a structured Ask Loop.

**Reuse, not new systems:** `projectBrainBriefing` (wired to nothing today), `attention-state`,
`personal-priority`, the decision vocabulary, the AI task/context/template governance, the meeting
record's M0-M4 slices, and `GoogleWorkspaceService.accessToken()` — which still has no caller.

**The new boundary:** user-first isolation. This is the first data an OWNER must not be able to read;
§20 makes it structural (no repository method without `userId`, no `manage` action).

**Decisions (Matt, 2026-09-17, recorded in §29.1):** V1 does not request `gmail.readonly`, but Stage 2
is a planned stage, not an option; employee mail intelligence is private from OWNER/ADMIN structurally
(`employeeIntelligence` has no `manage` action); Stage 2 derives and discards, with only a sealed
<=24h processing cache and <=240-char evidence quotes; **no organization-level aggregation**, and no
shortcut to one; retention is a window per category, not one number; no second AI runtime — scheduled
model work waits for the seven Brain prerequisites; Home is NEEDS YOU / YESTERDAY / YOUR DAY /
TOMORROW / WAITING ON / GONE QUIET / ASK LOOP, not a counter dashboard.

**Closed 2026-09-17:** retention approved as **initial product policy** (a window per category, §29.1
D13), and **`googleWorkspace:manage` is to be removed, not fenced** (D14) — OWNER/ADMIN get no generic
permission that could grow into another employee's Google connection; termination already revokes
under `users:update` / `users:delete`. **Nothing open now blocks DL-1.**

**New requirement (D15):** Ask Loop is not a Gmail-only retrieval system. **§31** adds the
multi-domain retrieval seam — employee-private intelligence, organization/institutional knowledge
(Lexi's 14-document EMG corpus, which nothing in Loop ingests today) and operational company data,
each separately governed, mixed only at read time, with an answer inheriting the strictest visibility
of its inputs. The Company Knowledge track (CK-1..CK-4) is a separate programme and is **not** part of
Daily Loop V1.

**Automatic Relationship Capture (D16, §32):** Loop discovers meaningful business relationships from
connected communication and maintains the CRM, without a contact per address. Its **private half**
(who you actually correspond with, when you last spoke, who has gone quiet) works on today's metadata
and needs no governed act; **every CRM write is a governed human act**, because
`identity-evidence-resolution.md` §5 locks "no machine identity attribution — every attribution is a
human proposal and a human confirmation", and C-05 forbids numeric identity confidence. Loop therefore
proposes with evidence and a human accepts in one click. Gmail metadata identifies **who and when**;
**title, company and context need Stage 2**.

**Capture decisions (D17, 2026-09-17, closing O7-O11):** Path 1 — the identity constitution is not
amended; the machine discovers and proposes, a human establishes shared identity. Shared fields are
business conclusions only (name, business email, company, title where evidenced, owner, status, coarse
recency, plus the provenance claim) — never subjects, bodies, message counts, private Calendar/Drive
evidence or quotations. A **new narrow `relationshipCapture` (`view`, `accept`)** capability lets the
relationship owner accept a conflict-free contact; everything ambiguous, competing, merging or
splitting still routes to `identityResolution:approve`, which is not broadened. Internal colleagues are
excluded from external capture. Dormancy defaults to 30 days as a cadence-aware, configurable
heuristic, never a verdict.

**Still open (§29.2, none blocking DL-0 or DL-1):** evidence quotes on by default (S2-2); the morning email
digest (DL-10); delegated mailboxes (DL-7); when to start Google verification (Testing mode expires
refresh tokens weekly). The five relationship-capture decisions are closed (D17).

**Shipped since:** #288 removed `googleWorkspace:manage` (DL-0), and #287 merged the record.

**DL-1 merged as #289** — the per-employee work-state foundation. Thirteen additive tables in migration
`20260920000000_daily_loop_work_state` (38); the `employeeIntelligence` IAM resource with exactly
`view`/`update` and no `manage` or `approve`; repositories under
`packages/database/src/repositories/work-state/` whose every employee-private method takes a
`WorkPrincipal` (organization **and** user), so an org-only read of another employee's work state is not
expressible; retention as versioned data with per-organization overrides.

**DL-2 merged as #290** — the Calendar sensor, provider layer only. A Loop-owned, provider-neutral
contract (`packages/shared/src/calendar-sensor.ts`) and the Google adapter
(`packages/providers/src/google-workspace/calendar.ts`): bounded `events.list` reads of the **primary
calendar** with `singleEvents=true`, a 10-page bound, incremental reads by `syncToken`
(410 -> `CURSOR_EXPIRED`), and normalization into event facts — attendees **counted**, organizer
**hashed**, no description, location, attendee list or joining link.

**DL-3 merged as #291** — the first complete private data path: the employee's own Google connection,
through `GoogleWorkspaceService.accessToken()` (its first production caller), through the DL-2 sensor,
into their own DL-1 work state. A bounded first window (7 days back, 30 ahead), then incremental reads;
an expired cursor causes ONE bounded re-baseline, never a crawl. Idempotent upserts on the provider key;
a cancelled event is kept as cancelled rather than deleted. Migration 39
`20260921000000_work_event_calendar_facts` adds the ten calendar-fact columns and one CHECK. The manual
trigger is `POST /api/integrations/google/calendar/sync`, which takes the principal from the session and
reads no body, query or header that could name anybody else.

**Migrations 38 and 39 are APPLIED, and DL-3 is PRODUCTION VERIFIED (2026-09-18).** A real Calendar sync
ran for one employee: a bounded WINDOW read first, then INCREMENTAL reads against the stored sync token.

**#292 merged** — the reason the second production run repeated the window. Google does not return
`nextSyncToken` when `orderBy` is set; it is documented, and it fails silently. The initial window read
no longer sorts, so every run after the first is incremental. A **periodic re-baseline is a DL-5
follow-up**, deliberately not in that fix.

**DL-4 merged as #293: YOUR DAY — the first employee-facing Daily Loop surface.** Loop Home opens
with the employee's own day, for every role, above whatever else that person can open: how current
Loop is, what is happening now or next, today, tomorrow. The projection is pure
(`packages/shared/src/your-day.ts`); the read model (`apps/web/src/daily-loop/your-day.ts`) resolves
the day in the employee's own zone and reads only through the DL-1 principal repositories.

Two facts decide the words, and they are different facts: whether Loop has **ever completed a read**,
and whether that read is **current enough to describe in the present tense**. A state with no read
shows no schedule at all rather than a day that looks empty, and a read Loop cannot refresh shows what
it last saw and never calls it current. Every sentence traces to a stored row: no meeting purpose, no
preparation advice, no participant identity, no location, link or attachment, no model call. No schema
change and no migration.

**DL-5 (in review, draft #294): THE AUTOMATED CALENDAR CYCLE.** Google Calendar maintains itself for
every employee who connected it; "Read my calendar again" stays as recovery, and normal use no longer
depends on it.

- **The established mechanism, not a second runtime:** a GitHub Actions workflow
  (`cycle-employee-calendars.yml`) running an operations script
  (`scripts/operations/cycle-employee-calendars.ts`) against `DIRECT_DATABASE_URL` — the same shape as
  `poll-callgrid-routine`. **No HTTP route**, so there is no endpoint that could be pointed at an
  employee, and no Netlify function, scheduler or queue is introduced.
- **Shipped OFF.** It exits immediately unless the repository variable
  `DAILY_LOOP_CALENDAR_ORGANIZATIONS` is set. Enabling it is one configuration action with no code
  change.
- **Cadence, in three parts:** an employee **using** Loop still refreshes their own calendar on their
  own visit (DL-4, unchanged); the **background cycle is hourly**; the **rolling-window re-baseline is
  weekly** (Sunday 04:25 UTC). The background pass is priced for the people who are *not* looking --
  hourly is ~1,100-1,450 runner minutes a month against ~4,300-5,800 at quarter-hourly, to shorten a
  gap on a calendar nobody is currently reading. The arithmetic is in the workflow header.
- **The #292 follow-up is closed.** A sync token inherits the window that minted it; the weekly
  baseline re-reads the rolling window and replaces the token, keeping the forward horizon at today +
  23 days or better. A failed or truncated baseline replaces nothing and leaves the employee on the
  cursor they had.
- **Isolation:** each pass names one `{organizationId, userId}` and goes through the same token path,
  which re-derives that employee's own membership and IAM. One expired, revoked or rate-limited
  connection ends that employee's pass and nothing else. Three *consecutive* credential failures abort
  the cycle deliberately — that pattern is far more likely to be the job's own key than three lapsed
  grants, and marching on would mark a whole organization's connections expired.
- **Observability:** structured `event=` lines and a `CYCLE_SUMMARY` with
  eligible/attempted/synced/truncated/failed/skipped/notAttempted/rebaselined. No identity, no title,
  no attendee, no count of anybody's meetings — an employee appears as a salted digest.
- **One assembly, two runtimes.** The Google OAuth port, the Calendar sync wiring and the deployment
  configuration reader moved into `@emgloop/database` / `@emgloop/shared`, so the web server and the
  cycle read a calendar the same way rather than drifting apart. No schema change and **no migration**.

**DL-5 merged as #294** — the automated Calendar cycle. A GitHub Actions workflow running
`scripts/operations/cycle-employee-sources.ts` against `DIRECT_DATABASE_URL`: hourly incremental,
weekly rolling-window baseline, shipped OFF behind `DAILY_LOOP_CALENDAR_ORGANIZATIONS`.

## GMAIL — the employee's mail as a work surface (GM-1..GM-3 MERGED #295–#297 · NOT COMMISSIONED · Mail intelligence + executive Home IN REVIEW)

**GM-1 (draft #295): the Gmail sensor, ingestion and the three freshness paths.**

- **Scopes decided and verified against Google's current documentation (2026-09-18):**
  `gmail.readonly` (restricted — the narrowest scope that returns a body, and the one that permits
  `q` so the first read can be bounded) and `gmail.send` (sensitive — sends as the connected person
  and can do nothing else). `gmail.metadata` is replaced. **Not requested:** `gmail.modify`,
  `gmail.labels`, `gmail.insert`, `gmail.settings.*`, `mail.google.com/`. Migration 40 widens the
  `google_connections` scope CHECK additively and keeps the legacy metadata scope legal, so an
  existing connection asks to reconnect rather than becoming an illegal row.
- **Metadata only is persisted.** The sync read asks Gmail for `format=metadata`, so the only Gmail
  read that is ever stored cannot carry correspondence. Bodies are read through on demand when an
  employee opens a thread and are never stored (§21.3 `GOOGLE_RAW_RESPONSES -> NEVER_STORED`).
- **Synchronization follows Google's own guide:** `messages.list` bounded by `q=newer_than:14d` with
  the boundary `historyId` captured first, then `history.list` for every later pass; a 404 is
  `CURSOR_EXPIRED` and causes ONE bounded re-baseline; weekly baseline before the position can
  expire (Gmail keeps history "at least one week").
- **No new tables.** DL-1's `work_threads`, `work_messages` and `work_correspondents` were designed
  for this and are used as designed.
- **Background cycle:** the DL-5 runner, generalized to `--source calendar|gmail` (one runner, one
  source per pass) plus `cycle-employee-gmail.yml` — hourly, weekly baseline, OFF behind
  `DAILY_LOOP_GMAIL_ORGANIZATIONS`.
- **Freshness:** one policy shape for every source. Gmail's numbers are faster than Calendar's —
  stale after 30 min, visit refresh at most every 5 min, manual floor 30 s.

**GM-2 (draft #296): the Inbox, the conversation, the composer and sending.**

- **`/app/mail`** — the employee's own conversations, from stored metadata, with the freshness line
  and a manual "Read my mail again" (30-second floor). A visit refreshes at most every 5 minutes.
- **`/app/mail/[threadId]`** — the conversation, read through from Gmail for that request and kept
  nowhere, rendered **as text only** (no markup, no iframe, no remote image, no tracking pixel).
- **The composer** — Reply / Reply all, editable recipients, save draft, discard, send. One box,
  whoever wrote the first draft.
- **`employeeMail:send`** — a new IAM resource with exactly one action, denied to AI_EMPLOYEE by the
  matrix and by a hard rule an explicit ALLOW row cannot override.
- **Threading** — all three parts of Google's documented contract, built from stored headers.
- **Migration 41** — `work_drafts` (the one body Loop stores, cleared on send) and
  `work_messages.references`.
- **Sent once, never twice (review fix, 2026-09-18)** — `DRAFT → SENDING → SENT | DRAFT |
  SEND_UNKNOWN`. The attempt's identity and body fingerprint are stored before Gmail is called.
  Only a definitive failure returns a draft to sendable. An ambiguous one is reconciled against
  the employee's own Sent mail and never retried. No clock releases a claim, and a crashed attempt
  becomes `SEND_UNKNOWN`. Architecture §6.11a.

**GM-3 (draft #297): Draft with Loop, and what the mailbox is waiting on.**

- **`mail.reply.draft`** — a governed AI task through the existing runtime (activation, budget,
  routing, provenance, output contract, no tools). `READ_ONLY`, because a `DRAFT`'s standing is
  `NON_AUTHORITATIVE`: it is text, not an approval item. One reviewed ownership addition —
  `DRAFT` / `EMPLOYEE_INTELLIGENCE` / `EMPLOYEE_MAIL_THREAD` — which the ownership table
  anticipated. Routing policy `routing.2026-09-18.3` adds the route (COMMUNICATION → OpenAI
  primary, Anthropic fallback); budget adds a `mail-reply-draft` class, worst case still under
  $50/day.
- **Prompt injection** — every message enters as `UNTRUSTED_INPUT`, the template says so in prose,
  and the task publishes no tool. Three independent reasons an injected instruction reaches nothing.
- **Attention** — deterministic `NEEDS_YOU` / `WAITING_ON_THEM` / `GONE_QUIET` over stored headers,
  each row carrying why it is there. Handled / Dismiss / Snooze / "I'm waiting on them" record
  corrections beside the evidence; a closed item reopens only on new evidence.
- **Home** — Your Mail sits beside Your Day: what needs you, what you are waiting on, what changed
  since yesterday (counts, never narrative).
- **An organization-feed leak was closed on the way**: employee-private tasks are now excluded from
  the Brain activity feed's requirements and items.
- **Final refresh onto main after #296 (2026-09-18)**: rebased onto `8f2d78c` without conflicts.
  Three fixes from the re-review: Draft with Loop is refused while a reply is `SENDING` /
  `SEND_UNKNOWN`, before any read or model call; Reply no longer silently becomes Reply all when
  Loop drafts; and Home's Your Mail carries the Inbox's currency line and concludes nothing from an
  unreadable mailbox.

**Mail intelligence + executive Home (draft PR on `feat/home-executive-review`, off `main` `fee2798`).**
No migration, no new Google call, no autonomous sending.

- **`/app/mail` is a dashboard, not an inbox**: four lanes (needs my reply, follow-ups due, waiting
  on them, new opportunities) plus Talent / Performance / Operations views, each a stated rule over
  stored metadata (`classifyMailThread`, @emgloop/shared `mail-intelligence`). Notification mail is
  an automated sender or a Gmail bulk tab and never "needs reply"; an opportunity is an outreach
  reply or a new inbound conversation whose subject names one — never a promotion. Search and the
  filters are a GET form. GM-3 corrections moved from Home onto the conversation itself.
- **Home (Owner/Admin/Manager) is Today's Review + the day**: a headline of ranked, source-built
  sentences, four cards (a card with no source says "not tracked yet"), Key updates, Needs
  attention, and a timeline of the viewer's own calendar. Composed by one pure contract
  (`executive-review`); each source loads on its own. Employees keep Your Day, and get the concise
  Your Mail (three counts, three rows, Open Mail).
- **Relevant email has one definition** (`notificationMessageReason`), shared by Home and Mail.

**Next:** Matt reviews the PR. Before either surface works in production, migrations 40 and 41
must be dispatched (above); then commission Gmail (scopes, reconnect, secrets, the gate variable)
as recorded in the GM-3 PR.

## Loop Application Structure — IN PROGRESS (PR 1 + 2 merged as #237)

_Last updated: 2026-09-15._

Decisions D1–D8 and the authorization invariant are locked in
`docs/architecture/loop-application-structure.md` (approved by Matt 2026-09-14; D1–D5 amended by Product
C-01–C-04 on 2026-09-15). One application under `/app`: one shell, one nav registry, five operating areas
(Home, CRM, Work, Intelligence, Operations), deliberate redirects.

| PR | Scope | Status |
|----|-------|--------|
| 1 + 2 | Sign-in lands on Loop; one shell, one `LOOP_NAV`; CRM inside the shell; explicit guard on every role-guarded page | **MERGED** #237 (verified on `main` by content) |
| 3 | Route authority, redirect table (incl. `/app/admin/crm`, role homes, catch-alls), public auth routes | Not started |
| 4–7 | Canonical routes per area | Awaiting Charlie/Lexi's route-transition proposal (C-01); PR 4's Administration prefix superseded |
| Final | Retire role trees, phantom Business/Creator authority, placeholders; docs | Not started |

#235 and #236 remain open as superseded candidates; close them when directed.

## CRM Phase 1 — Shared Experience Layer — CODE MERGED; completion blockers open

_Last updated: 2026-09-14 (all Phase 1 PRs merged; see blockers below)._

| PR | Scope | Status |
|----|-------|--------|
| A–D | Search, timeline primitives, detail experience, UX/a11y/responsive | **MERGED** #227 #228 #229 #230 |
| E — Security closeout | Tenant-local orgs, `audit:view` gating, server-derived note provenance, Workspace nav | **MERGED** #231 |
| — /demo removal | Public PII read + fabricated-record write surface deleted | **MERGED** #232 — production verified 404 (GET and server-action POST) 2026-09-14 16:39Z |
| — Demo footprint runner | Read-only `workflow_dispatch` runner for records the /demo generators left | **MERGED** #233 — run 2026-09-14 17:15Z: 3 suspects (1 /demo journey), 0 orphans |
| F — Final reconciliation | Derived signals, AI Activity, Inbox nav, permission-aware record, intake framing, activity link, deterministic ordering, search/timeline tests, governed Headlines | **MERGED** #234 |

**Open completion blockers (final audit, 2026-09-14):** (1) fabricated /demo journey
`cmqsza1v40002awufuvq9zkrt` and fixture `demo-cust-0001` in production lists — needs a quarantine-or-delete
decision and write authorization; (2) People list bulk bar and Intake Board move form shown without
update permission; (3) customer activity page uses the legacy failure notice and renders an empty page
for an unknown id.

**/demo exposure — what is and is not known.** Closed on production (verified). Whether it was
accessed is **unknown**: no Netlify credentials or request logs are reachable from the dev
environment, and missing logs are not evidence of no access. The exposure window ran from Sprint 4
(2026-06-24) to the #232 deploy (2026-09-14).

**Headlines in the CRM (Product decision 2026-09-14):** link to CI's governed `/app/admin/headlines`
and compose its `AttentionBanner` on the Command Center — only for sessions that can open it (ADMIN
workspace + `commercialIntelligence:view`). EMPLOYEE/READ_ONLY hold the read grant but are not shown
it; a broader Headlines route/access policy is a separate future decision.

**Test baseline:** web `tsx --tsconfig tsconfig.test.json --test test/*.test.tsx` → 299/299 on #234
(main after #232: 263/263). Database 1006, shared 996, providers 132, operations 535, diagnostics 47.
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
7. **Business Identity approval packet — superseded.** See the Identity block and
   `docs/architecture/identity-evidence-resolution.md`.
8. **`/crm/merge`** — Product decided to disable it, not adapt it (PD-I2-05). It needs its own small PR,
   and historical records are not deleted.
9. **The Decision Center sequence (Matt, 2026-07-31).** Architecture follows actual reuse, never
   speculation — each step earns the next:
   1. ~~Merge #156.~~ **Done**; #157 (event contract + drain) also merged.
   2. **Operator Velocity** — Decision Center v2 UI/workflow polish, zero backend.
   3. **Work OS as the FIRST subscriber** to `DECISION` events. This is what closes
      ENGINEERING_PRINCIPLES Rule 6, which currently holds by discipline rather than enforcement.
      The drain delivers in code and tests, but **it is not configured in production** (repository
      secrets unset; see the drain block). No subscription is registered for `DECISION` subjects.
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

## Microsoft Teams + Telegram Connections — STAGING PHASE BUILT (draft #308); DEPLOY + LOGIN PENDING

**Draft PR #308** on `feat/connections-teams-telegram` (off `main` @ `1cfce8b`). Surface + durable
Telegram worker + staging infra, on the Google-connection discipline. Matt merges/deploys.

**LOCKED PRINCIPLE (in code):** Teams/Telegram are INTELLIGENCE SOURCES, not clients Loop
reimplements. OBSERVE → NORMALIZE → cross-source intelligence (no silo). No composer/reply/inbox.
Observation ≠ retention (governed, content-minimized store; never a mirror). Provenance returns to
source. Privacy unchanged. **Security:** web tier holds NO session key (only the worker seals/opens);
phone/code/password never stored/logged; message text read only as `hadText`; signed web↔worker
channel; no send/reply/react/history-import; teleproto in the worker pkg only (never the web bundle).

**Built & tested (643 web + 64 connection + 6 infra synth; typecheck clean except the marketplace
baseline; web build passes):** state/sealing; content-free `ConversationEvent`; `SourceConnection` +
repo + `sourceConnections` IAM + `SourceConnectionService`; `/app/connections` tiles + interactive
Telegram sign-in widget; worker (`apps/connections-worker`): content-free mapping, `TelegramAdapter`,
`runObservationSweep` (sink-before-cursor), login coordinator, teleproto seam, signed control server,
entrypoint; `SourceObservation` governed store; `infra/connections` (Fargate + internal ALB + HTTPS
HTTP API/VPC Link + Secrets Manager wiring).

**Migrations (NOT dispatched):** `20260925000000_source_connections`, `20260926000000_source_observations`.
Apply to the STAGING Neon DB before the worker/web use the tables.

**Secrets (Secrets Manager, staging 065148797865 us-east-1):** `loop/connections/staging/telegram`
(api_id/api_hash) — created by Matt ✅. Created by the CDK deploy: `.../connection-key` (UNSET →
`openssl rand -base64 32`), `.../database-url` (UNSET → Neon staging URL), `.../conversation-secret`
(generated), `.../worker-control` (generated; read once for the web env).

**Web env (Netlify) to set after deploy:** `LOOP_CONNECTION_PROVIDERS=TELEGRAM`,
`LOOP_CONNECTIONS_WORKER_URL=<HttpApi WorkerUrl output>`, `LOOP_CONNECTIONS_WORKER_SECRET=<worker-control
value>`. (The web no longer uses `LOOP_CONNECTION_SECRET_KEY`.)

**Deployment model: GitHub Actions + OIDC + workflow_dispatch (no local AWS creds/CDK)**, mirroring
Brain. Workflows: `connections-infra-ci` (PR) and `connections-infra-deploy` (manual, environment
`connections-staging`, account/region guards, synth-before-deploy, confirm text). Deploy identity:
`infra/connections/access/github-deploy-access.yaml` (own role, trusts connections-staging, assumes
the CDK bootstrap roles incl. image-publishing). Runbook: docs/runbooks/connections-aws-staging.md.

**Next human actions (ordered):** (1) ONE-TIME bootstrap (admin): deploy the access CFN in staging
+ create the `connections-staging` GitHub environment (required reviewer, main only) with var
`CONNECTIONS_STAGING_DEPLOY_ROLE_ARN`; (2) run `connections-infra-deploy` (action `diff`, then
`deploy` + confirm `deploy loop-connections-staging`) — approve the environment gate; (3) populate the
two UNSET secrets (connection-key, database-url) + read worker-control; (4) apply the two migrations
to staging Neon; (5) set the three Netlify vars + redeploy web; (6) force a new Fargate deployment;
(7) Connections → Telegram → Connect → phone/code/2FA → Ready. No production changes.

## Working agreement
**One branch per work batch.** After a PR merges, cut a fresh branch off freshly-merged
`main` for the next objective — never keep committing to a merged branch (it strands work
with no open PR). Always open a draft PR and report its URL; Matt merges.

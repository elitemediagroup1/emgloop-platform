# EMG Loop — Project Status (where we left off)

The living "current state" per workstream, so any session (or Matt) can resume without
losing the thread. **One current-state block per workstream — overwrite it, don't append.**
Read this at the start of a session; update it at the end of a work batch. History lives
in git, not here.

_Last updated: 2026-07-29._

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

## CallGrid Intelligence — factuality, reconciliation & intelligence — IN REVIEW (draft PR #149) · branch `feat/callgrid-intelligence-factuality` (off main `9551cdc`)
The pass that turns `/app/admin/marketplace` from a reporting copy of CallGrid into an
explainable, checkable workspace. Nine commits; **423 tests pass (shared 226 · database 197)**,
typecheck clean on web/shared/database, `turbo build --filter=@emgloop/web` passes.

**The root cause of the distrust, found and fixed.** `today` and every trailing-N-day preset
compared a PARTIAL window against N COMPLETE prior days. At 9am "Today" reported a ~-85% revenue
collapse — every morning, forever. Every in-progress window is now cut against the same
**wall-clock** point of its own period (wall clock, not elapsed ms, so a DST day doesn't compare
14 hours against 13). Also fixed in the same class: `this_month`/`year_to_date` day clamping,
custom ranges ending at a future midnight, and future-only ranges. Windows now carry
`comparisonBasis`/`includesLiveData`/`isCompleted`/`isValid`, and the UI names the cut time
("Yesterday · through 2:30 PM").

**Second root-cause fix (data layer).** `aggregateWindow`'s dimension accumulator did
`revenueCents += rev ?? 0` with no coverage counter — so an unpriced buyer was indistinguishable
from one that earned $0, and every ranking, share, concentration and contribution built on those
rows was wrong. Per-row coverage counters added; the report service now carries nullable
economics, and unknown revenue renders "Unknown" and **sorts last in both directions**.

**Built:** canonical metric contract (every metric's provenance, grain, versioned formula, and
what zero/unknown/unavailable mean, plus the one implementation of each formula) · deterministic
intelligence engine (findings with evidence + limitations + unknowns + ruleId/version; a versioned
significance registry holding every threshold; contribution-not-causation enforced by test) · bid
rejection classification registry + a review-priority score that orders work **without pricing it**
· evidence drawers (native `<details>`, no client JS) · "What Loop Cannot Determine" as a
first-class section on every page · Bids rebuilt as an operational workspace · Activity rebuilt on
engine findings instead of its own thresholds · reconciliation harness under Administration →
Diagnostics.

**Deleted (replacement rule):** `callgrid-dimensions.ts` (a parallel hardcoded-7-day path, zero
importers) and `callgrid-watch.ts` (superseded by the engine).

**⚠️ NOT production-validated, and this is the gate.** The sandbox has no database, no runtime and
no browser, so **no figure here has been seen against real data**. What remains:
1. **Deploy validation** — for Today / Yesterday / This Week / one historical day / Last 7 Days /
   Last Week / one custom range, compare Loop vs CallGrid revenue, profit, billable and total, then
   the top five rows per dimension. Use the diagnostics panel
   (`/app/admin/administration/diagnostics/callgrid?range=…&dim=…&cgCalls=…`) and classify every
   discrepancy MATCH / EXPECTED_ROUNDING / KNOWN_PROVIDER_LIMITATION / BUG.
2. **Intelligence validation** — for ≥5 real periods, confirm each finding's evidence is correct,
   its wording does not overstate causation, and an operator finds it useful.
3. **Responsive check** on real content (desktop/tablet/mobile).

**⚠️ Hard provider limitation (new, important).** CallGrid has **no working aggregate
call-statistics endpoint** — `POST /api/reports/stats` returned HTTP 400 on the live discovery run
and has never returned 200. Loop's call economics come from ingested call records, not a CallGrid
report, so "do the numbers match CallGrid" **cannot be automated**. The harness therefore accepts
figures typed in from the CallGrid interface, and `fullyReconciled` requires no defects AND nothing
unverified — a window with unentered figures reports "This is NOT a pass."

**Honest limits held:** bid data is snapshot-only (one window stored) so **no bid trend is shown
anywhere**; historical bid snapshots remain a separate ingestion project. Campaign/vendor profit is
not attributable at that grain and says so. Entity counts mean "observed this period" — CallGrid
exposes no roster. **No LLM narrative** — every string is deterministic template language.

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
5. **CallGrid deploy validation** — the only thing standing between this branch and "done".
   See the CallGrid block above for the exact per-period checklist.

## Working agreement
**One branch per work batch.** After a PR merges, cut a fresh branch off freshly-merged
`main` for the next objective — never keep committing to a merged branch (it strands work
with no open PR). Always open a draft PR and report its URL; Matt merges.

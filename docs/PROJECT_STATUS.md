# EMG Loop — Project Status (where we left off)

The living "current state" per workstream, so any session (or Matt) can resume without
losing the thread. **One current-state block per workstream — overwrite it, don't append.**
Read this at the start of a session; update it at the end of a work batch. History lives
in git, not here.

_Last updated: 2026-07-23._

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

## CallGrid Intelligence finalization — ALL PAGES BUILT (verified) · branch stack `feat/callgrid-intelligence-finalization` (#143) → `feat/callgrid-date-window` (#144) → `feat/callgrid-dimension-pages` (tip, contains all)
An 18-phase controlled reorg/correction of `/app/admin/marketplace` (not a redesign). **Canonical
source proven:** `crmRepos.marketplaceCalls.aggregateWindow(org, since, until)` →
`{calls, monetized(=billable), revenueCents, payoutCents, costCents, callsWithRevenue, buyers[],
vendors[], sources[], campaigns[]}` is THE CallGrid economics source; it takes arbitrary Eastern
windows. Bid/ping data is a **separate snapshot grain** (latest synced window only, UTC-requested).
**Locked decisions:** canonical Bids route = `/marketplace/bids` (`/auction` = redirect only);
native date inputs replaced by the two-month visual calendar.

**Foundation (in review):**
- **#143 (draft):** fixed the **Buyers contradiction** — Buyers read `revenueIntelligence`
  (CRM/revenue; UNKNOWN → false 0) while Overview read the call projection. Buyers now reads the
  **same canonical source**; cross-product content stripped. Retired its paid-off zero-coercion ledger entry.
- **#144 (draft, stacked):** shared **date-window contract** (`resolveCallGridWindow` — all presets +
  comparisons, Eastern, 13 tests); canonical **`callgrid-report`** service (Truth-honest); **date-range
  picker** (URL-driven, persists across tabs). Overview + Buyers wired.

**On `feat/callgrid-dimension-pages` (tip — the single clean base):**
- **Committed:** two-month **calendar** picker (`CallGridDateRange`); **shared dimension design
  language** (`dimension-ui.tsx` shell/tiles/table/detail/activity/SnapshotNotice, `dimension-metrics.ts`,
  `call-dimension-page.tsx`); **Buyers/Vendors/Campaigns unified** (thin config wrappers — one product,
  different data); **Sources** verified hybrid (range-honoring Total/Active Sources from calls +
  snapshot-only bid metrics under `SnapshotNotice`; `bid-report.ts` = one canonical bid-snapshot reader).
  Also committed: **Activity** (derived operational stream + filters); **Bids workspace**
  (`/bids` — snapshot summary, source vs destination tables kept strictly separate, two-group
  rejection reasons, operational watch list, honest recent-activity); **`/auction` → `/bids`
  redirect** + nav/Quick-Access repointed; **diagnostics moved** → `/app/admin/administration/diagnostics/callgrid`
  (admin-guarded, out of the CallGrid tab bar; `auction-data.ts` → `diagnostics-data.ts`); retired the
  vendors/campaigns zero-coercion ledger entries; CSS. **All eight pages (steps 1–8) committed.**
- **Verified now:** `@emgloop/shared` **106/106**, `apps/web` **typecheck clean**, `turbo build` **passes**.

## CallGrid date control + data-consistency correction — IN REVIEW (draft PR #146) · branch `fix/callgrid-date-control` (off merged #145 content)
Correction pass making the shared date control visibly govern every route. Foundation was already
single-sourced (`resolveCallGridWindow` + `loadCallGridReport` + `loadBidReport`); this wires the
missing behavior. **Committed & validated (typecheck clean · `turbo build` passes · `@emgloop/shared` 116/116):**
- **Shared contract:** `describeCallGridWindow` (one source of Live/Completed/Includes-Live language +
  header line + period/comparison titles); `callGridDayNav` (prev/next Eastern day, Next disabled on
  Today, forward-off-history returns to Today); `callGridRangeQuery` normalizes **Today explicitly**
  (`range=today`). +13 tests.
- **Every route:** live/completed header line + period-titled summary heading; prev/next-day arrows
  (single-day only) + Live indicator/`Updated <time> ET`/**Refresh** (`router.refresh()`, no polling)
  when live; selected range persists on all tab/Quick-Access/sort/selection links (Today included).
- **Overview:** per-metric **comparison indicator** ("No valid comparison" when prior 0/unknown/unavail);
  new **Bids Overview** (6 snapshot metrics → `/bids`, snapshot-match honesty); **Watch List now
  CallGrid-derived only** (`callgrid-watch.ts`) — Brain dependency removed from this surface. Section
  order: Header·Date·Selected·Comparison·Top Performers·**Bids Overview**·Watch·Quick Access.
- **Bids/Sources:** `bidSnapshotMatches` (conservative same-day-only); "Bid Reporting Window" reconciled
  against the selected period. Compact metric-tile density (typography unchanged).
- **Reconciliation is structural** (unchanged & re-verified): Overview Top {dimension} = `dimensions[dim][0]`
  and each subpage table is the same collection/sort — one aggregation path.

**Remaining before this is done:** (a) **deploy validation** against real production CallGrid data —
numeric top-5 reconciliation per dimension, on-screen Live/Completed verification, and **screenshots**
(no DB/runtime/browser in the sandbox — deploy-only, Matt merges/deploys); (b) remainder of the spec's
full test suite (no web render/route test harness per CLAUDE.md); (c) responsive polish pass.
- ℹ️ Honest limits held: **Campaigns** uses Avg Rev/Billable, not Profit (not reliably attributable at
  dimension grain); **Sources** shows aggregate rejection reasons (per-source `?source=` detail not built);
  bid data is snapshot-only — **historical bid snapshots are a separate future ingestion project**.
- ✅ Resolved this pass: Overview Watch List no longer sources Brain risks (now CallGrid-operational only).

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

## Loop Cognitive Architecture — INCREMENT 1 IN REVIEW (draft PR) · branch `feat/loop-cognitive-architecture-foundation` (off main `553ec08`)
The canonical cognitive foundation: identity / durable memory / governed knowledge /
explainable active state / governance / transactional outbox / subscriptions / hypotheses /
decisions. A 4-increment controlled build; **Increment 1 (domain model + repositories) is
done and validated**, Increments 2–4 (processing pipeline; explainability + publishing;
real-time product-click vertical slice + admin validation page) are **designed but not built**
(see `docs/architecture/loop-cognitive-architecture.md`).
**Increment 1 shipped:** 15 additive Prisma models + 29 enums (`schema.prisma` §cognitive);
15 org-scoped repositories under `packages/database/src/repositories/cognitive/` (wired into the
barrel as `repositories.cognitive`); org-salted HMAC hashing for sensitive identifiers; additive
migration `20260723000000_loop_cognitive_architecture_foundation` (15 tables, 0 ALTER/DROP on
existing tables). **Not a parallel system** — reuses LoopEvent (ingress seam), DomainEvent,
Customer/resolveCustomer, `packages/intelligence`; **`packages/marketplace-intelligence` is now
marked DEPRECATE** (dead + broken, superseded). **Canonical:** `CognitiveIdentity` (not CRM
Customer), `MemoryEvent` (immutable), `KnowledgeAssertion` (class-preserving), `ActiveStateRecord`
(derived projection, evidence-required).
**Validated:** 16 new deterministic tests (166 total pass); `@emgloop/web` + `@emgloop/database`
typecheck clean; production build passes; migration applies on clean Postgres **from-zero** (66
tables) and **from-current** (51→66, additive). **Not built / not claimed:** processor, publisher,
context/explain service, vertical slice, admin page, Brain, aggregate intelligence, any LLM.
**Caveat (pre-existing):** `sprint_11` migration has an em-dash syntax error blocking `migrate
deploy` replay; prod applies schema via `prisma generate` + a deliberate step, so this migration
is a deliberate human apply, not a build side effect. _(needs deploy validation: apply migration;
nothing renders yet — no UI in Increment 1.)_

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
5. **CallGrid polish:** Bids raw-table page → real drill-down; per-drill-down copy.

## Working agreement
**One branch per work batch.** After a PR merges, cut a fresh branch off freshly-merged
`main` for the next objective — never keep committing to a merged branch (it strands work
with no open PR). Always open a draft PR and report its URL; Matt merges.

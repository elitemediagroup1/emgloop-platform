# EMG Loop — Project Status (where we left off)

The living "current state" per workstream, so any session (or Matt) can resume without
losing the thread. **One current-state block per workstream — overwrite it, don't append.**
Read this at the start of a session; update it at the end of a work batch. History lives
in git, not here.

_Last updated: 2026-07-22._

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

## CallGrid Intelligence — DONE (merged)
Single command center at `/app/admin/marketplace` (Overview) + drill-downs
(Buyers / Vendors / Sources / Campaigns / Activity / **Bids**). Canonical **EntityPage**
drill-down pattern; Sources vertical = lightweight listing + per-source detail.
**Follow-up:** the Bids page (route `/marketplace/auction`) is still a raw-table surface —
needs a real drill-down pass; per-drill-down business-language polish remains.

## Work OS — IN REVIEW (**PR #130 open**, `feat/internal-alpha-ux`)
Redesigned to match the Dashboard: one-screen 3·3·2 tile grid, business terminology
(no Work Instance / Blueprint / Stage), conversational **Start Work** form, new **Team Work**
page, and a centralized route→product resolver driving both breadcrumb and active-state.
_(needs deploy validation: 1920×1080 no-scroll fit + real work data.)_

## Onboarding / invitations — DONE (merged: #129)
Absolute invite/reset URLs (`@emgloop/shared/app-origin`); team management at
`/app/admin/administration/team` (invite / role / disable / remove / resend / revoke);
`/crm/users` redirects at the edge; role fix (metadata is the source of truth, no auto
downgrade); first login → `/app`; personalized breadcrumb; permission-aware nav.
_(needs deploy validation: the end-to-end fresh-invitation journey — see below.)_

## Business timezone — DONE (merged)
`BUSINESS_TIME_ZONE = 'America/New_York'` in `@emgloop/shared` (DST-aware via Intl). Every
calendar-day boundary (today/yesterday/completed-today) is Eastern. Rolling N-day windows
stay duration-based (timezone-independent).

## Global sidebar — DONE (merged)
Flat: Dashboard · CallGrid Intelligence · CRM · Creator Hub · Work OS · Accounting ·
Administration (footer, permission-aware). One shared shell; longest-prefix active-state.

## CRM · Creator Hub · Accounting — NOT BUILT
Approved operating areas, shown in the sidebar, but not built/connected. They render honest
"Not Configured / unavailable" states and **never** show fabricated data. (CRM specifically
must never surface CallGrid caller records as contacts — the `Customer` table is shared.)

---

## Open threads / next steps
1. **Merge PR #130** (Work OS) — then start the next batch on a FRESH branch off `main`.
2. **Deploy validation** (only possible on the deploy): Dashboard + Work OS one-screen fit;
   the fresh-invitation onboarding journey; CallGrid scorecard value reconciliation.
3. **Platform floor** (from CLAUDE.md Long-Term Goals): commit the lockfile; a CI gate on
   `main`; a **web test harness** (route/render/permission tests can't run without one today).
4. **CallGrid polish:** Bids raw-table page → real drill-down; per-drill-down copy.

## Working agreement
**One branch per work batch.** After a PR merges, cut a fresh branch off freshly-merged
`main` for the next objective — never keep committing to a merged branch (it strands work
with no open PR). Always open a draft PR and report its URL; Matt merges.

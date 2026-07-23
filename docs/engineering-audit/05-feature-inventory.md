# 05 — Feature / Route Inventory

**Frontend:** Next.js 14 App Router, **server-component-first** (only **6** `'use client'` files, all leaves — no client pages/layouts). **76** `page.tsx` total; **37** under `/crm`, ~32 under `/app`, 7 marketing/misc. Two URL surfaces (`/crm/*`, `/app/*`) render through **one** `WorkspaceShell` (data-driven, zero role branching).

**Classification key:** Production-ready · Functional-incomplete · Prototype · Placeholder · Disconnected · Redirect. "Complete" requires connected + real data + authorized + error-handled.

---

## 1. Workspaces — reality

| Workspace | Reachable by | State |
|---|---|---|
| **ADMIN** | OWNER/ADMIN/MANAGER | **Fully built** — the real product surface |
| **EMPLOYEE** | EMPLOYEE/AI_EMPLOYEE | **Partly built** — Work Queue real; dashboard is a placeholder |
| CLIENT | READ_ONLY | **Placeholder shells only** |
| BUSINESS_OWNER | *nobody* (phantom) | Placeholder + **unreachable** (no `workspaceRole` writer) |
| CREATOR | *nobody* (phantom) | Placeholder + **unreachable** |

---

## 2. Feature inventory (major routes)

| Feature | Route | Backend/data | Provider dep | Classification | Major issue / next action |
|---|---|---|---|---|---|
| CRM overview | `/crm` | crmRepos | — | Production-ready | — |
| Customers | `/crm/customers`(+`/[id]`,`/activity`) | crmRepos (org-scoped) | CallGrid ingest | Production-ready | Page guard is `requireCrmContext` only (no matrix) — see AUTHZ-002 |
| Conversations / Inbox | `/crm/conversations`,`/crm/inbox` | crmRepos | — | Production-ready | Inbox labelled "Calendar" in nav (misleading) |
| Pipeline | `/crm/pipeline` | `crm.kanbanBoard` | — | Production-ready | honest empty-state |
| Revenue Intelligence | `/crm/revenue` | `revenueIntelligence` | — | Production-ready | exemplary honest empty-state |
| Analytics / Traffic | `/crm/analytics`,`/crm/traffic` | crmRepos | — | Production-ready | — |
| Workflows (automation) | `/crm/workflows`(+`/new`,`/[id]`) | `workflows.repository` | — | **Functional-incomplete** | EVENT+MANUAL real; **SCHEDULE inert** (no cron) |
| AI Employees | `/crm/ai-employees` | `ai-employee.repository` | — | Functional-incomplete | **config-only, honestly labelled** "no live providers" |
| Integrations | `/crm/integrations`(+`/[provider]`,`/secrets`,`/website/...`) | `integration-os.ts` | CallGrid/Website | Production-ready | single-tenant (`LIVE_ORG_SLUG`) |
| Live feeds | `/crm/live/{activity,calls,websites}` | crmRepos + `LiveFeed`(client) | CallGrid/Website | Production-ready | polling, not push |
| Setup wizard | `/crm/setup` | crmRepos | — | Production-ready | client leaf |
| Audit / Search / Merge / Settings | `/crm/{audit,search,merge,settings}` | crmRepos | — | Production-ready | — |
| **Admin home (command center)** | `/app/admin` | `dashboard-data.ts` | CallGrid | **Production-ready** | honest Unknown/Unavailable tiles |
| **Executive Brain** | `/app/admin/brain` | `loadExecutiveBrain` + crmRepos | — | Functional-incomplete | deterministic rules, honest "cannot reason" state; mixes `.crm`+`.loop-os` tokens |
| **CallGrid Intelligence** | `/app/admin/marketplace`(+ activity/auction/buyers/campaigns/sources/vendors) | `marketplaceCalls`, dimension loaders | CallGrid | Production-ready* | *PR #146 finalization pending; **no `requirePermission`** (AUTHZ-001) |
| Marketplace-intelligence (legacy) | `/app/admin/marketplace-intelligence` | — | — | Redirect | → `/app/admin/marketplace` |
| **Work OS** | `/app/admin/work`(+`/[id]`,`/new`,`/team`,`/blueprints`) | `WorkRepository` | — | Production-ready | **isolated from CRM record graph** (no links to customers/calls) |
| Administration | `/app/admin/administration/{team,work-types}` | repos | — | Production-ready | — |
| Employee Work Queue | `/app/employee/work`(+`/[id]`) | `loadEmployeeWork` | — | Production-ready | the PR #76 surface |
| Employee dashboard | `/app/employee` | none | — | **Placeholder** | "summaries plug in here" |
| Business/Creator/Client | `/app/{business,creator,client}/*` | none | — | **Placeholder / unreachable** | phantom workspaces |
| Unbuilt nav (CRM/Creator Hub/Accounting) | `/app/admin/[...slug]` | config only | — | **Placeholder shell** | honest "Nothing here yet" |
| Legacy | `/login`, `/dashboard`, `/status` | hardcoded | — | Placeholder/Redirect | `/login` dead; `/status` static; `/dashboard`→`/app/admin` |
| Demo | `/demo`(+`/intake`,`/timeline`) | demo repos + **mock providers** | mocks | Prototype | self-contained, labelled |

---

## 3. Findings

### Finding FE-001 — Medium — Frontend / Maintainability
**Title:** Formatter duplication — `relTime` reimplemented ~10–12×, money/currency ~6×, despite a canonical `_loop-os/format.ts`.
**Evidence:** `relTime` local copies in `crm/pipeline`, `crm/conversations`, `crm/workflows`, `crm/customers`, `crm/inbox`, `app/admin/page.tsx`, `app/admin/work/page.tsx`, `work/[id]`, `workspace-home-data.ts` (+ `relativeTime` variants in `LiveFeed`, `integration-os`). `money` in `crm/traffic`, `crm/revenue`, `crm/customers/[id]`, `app/admin/marketplace`, plus inline `toLocaleString` currency in 3 places — each subtly different (rounding/decimals).
**Why it matters:** Inconsistent money/time rendering across pages is a *correctness* smell in a product whose whole thesis is "numbers must reconcile." Divergent rounding is exactly how Overview vs subpage mismatches arise.
**Recommendation:** Delete the local copies; import from `_loop-os/format.ts`. Add a lint rule / test forbidding local `money`/`relTime`.
**Effort:** Small. **Priority:** Next sprint.

### Finding FE-002 — Medium — Frontend / Architecture
**Title:** The two-shell surface carries duplicated stylesheet imports, two layered token sets, and cross-shell hard links.
**Evidence:** `app/app/layout.tsx` and `app/crm/layout.tsx` each import the same 7 stylesheets (the `/app` tree reaches up into `../crm/*.css`); CRM content wraps in `.crm crm--embedded` (light `--crm-*`) *inside* the dark `.loop-os` shell (fragile per the layout's own warning comments); `WorkspaceShell`'s notification bell hard-links to `/app/admin/work` regardless of shell; `CRM_SHELL` nav points `Team` into `/app/admin/administration/team`.
**Why it matters:** This is the "two shells / two token sets" debt CLAUDE.md names; it makes styling fragile and blocks the Phase-4 shell unification.
**Recommendation:** Collapse to one token set + one stylesheet import path as part of the shell-unification plan (do not start without the written plan CLAUDE.md requires).
**Effort:** Large. **Priority:** Long-term (Roadmap Phase 4/shell unification).

### Finding FE-003 — Low — Frontend
5 legacy `crm/sprintN.css` files remain (sprint-named anti-pattern). Fold into `design-system.css`; delete. **Effort:** Small.

### Positive — UX honesty holds
Sampled pages show **honest, specific empty/error states** ("No realized revenue yet…", "The Brain cannot reason right now… showing you nothing rather than a briefing it could not confirm"). `loadOrFallback` renders "Unavailable" not zeros; `format.ts` enforces em-dash for Unknown. **No fabricated "Brain Status: Online" pill exists** — the CLAUDE.md example is no longer present; the Brain health band derives from real `ExecutiveBrainReport.systemHealth.band`. The only static status surface is `/status` (honestly labelled) and the dead `/login` placeholder. This is the codebase's best property — protect it.

---

## 4. Server/client discipline (a strength)

Exactly 6 `'use client'` files, all leaves: `StartWorkForm`, `bulk-bar`, `CallGridSync`, `LiveFeed`, `RequestAccessModal`, `SetupWizard`. **No client pages or layouts.** Post-login routing happens in one place (`app/app/page.tsx` → `resolveHomeRoute`). Preserve this — it is the strongest frontend property.

Cross-refs: authorization gaps → `08`; workflow/Work-OS reality → `10`; token/CSS consolidation → `15`.

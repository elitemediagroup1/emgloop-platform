# 15 — Technical-Debt Register

Prioritized. **Effort:** Small/Medium/Large/Multi-phase. **Priority:** Immediate / Before-features / Next-sprint / Near-term / Long-term. IDs cross-reference other deliverables.

| ID | Debt | Evidence | Why it matters | Fix | Effort | Priority |
|---|---|---|---|---|---|---|
| TD-01 | Single-tenant ingestion (`LIVE_ORG_SLUG`) | `crm/live-org.ts:18` + 3 routes | Blocks customer #2; cross-tenant contamination | Per-org routing + creds | Multi-phase | Before-features |
| TD-02 | Global unique keys (`integration_events`, `marketplace_calls`) | schema `:766`,`:1598` | 2nd tenant's events dropped as dupes | Org-scoped `@@unique` migration | Medium | Before-features |
| TD-03 | Knowledge/event shared-secret master key | `v1/events`, `lib/knowledge/gateway.ts` | Cross-tenant read/write | Per-producer creds, scope from credential | Medium | Before-features |
| TD-04 | No repo-wide CI gate on `main` | only `verified-knowledge-ci.yml` | Bad merge reaches prod unverified | PR gate: `npm ci`→typecheck→build→test | Small-Med | Immediate |
| TD-05 | Lockfile committed but CI uses `npm install` | `package-lock.json` tracked; workflows say "no lockfile" | Non-reproducible installs; stale CI assumption | Switch CI to `npm ci` | Small | Immediate |
| TD-06 | Preview/prod DB isolation undefined | `netlify.toml` no context blocks | Preview may hit prod DB | Per-context env + isolated DB | Small (verify first) | Immediate |
| TD-07 | Em-dash breaks Sprint-11 migration | `…sprint_11…/migration.sql:1` (`e2 80 94`) | Apply-from-empty fails | Fix byte to `--`; add apply-from-empty CI | Small | Next-sprint |
| TD-08 | Authz coarse on `/app/admin/*` | `admin/layout.tsx:18` only | MANAGER sees restricted surfaces; unsafe for future mutations | `requirePermission` per page/action | Medium | Before-features |
| TD-09 | Synchronous ingestion, no queue/DLQ | `IngestionService.ingest` in request | No scale headroom; blocks response; silent loss | Persist-fast + queue + workers | Multi-phase | Near-term |
| TD-10 | 200-on-failure webhook contract | callgrid/website/auction-sync | Providers don't redeliver → data loss | 5xx on persist failure | Medium | Next-sprint |
| TD-11 | No event bus; `LoopEvent` no consumer | grep: no bus; 0 callers | Spine-B events inert; inline one-offs | Async event spine or delete gateway | Large | Near-term |
| TD-12 | Work OS siloed from CRM record graph | `work/actions.ts:229` `relatedRecord:null` | No org memory; can't start work from a call | Polymorphic org-scoped link | Medium | Near-term |
| TD-13 | `$executeRawUnsafe` DDL in request path | `live-org.ts:66-67` | Violates 2 constitution rules | Remove shim; enum via migration | Small | Next-sprint |
| TD-14 | 14 models: `organizationId` without FK | Work OS(3)+`vk_*`(7)+Marketplace(4) | Org deletion orphans rows; no integrity | Add FKs `onDelete:Cascade` (migration) | Medium | Before-features |
| TD-15 | SCHEDULE workflows + due dates inert | `workflows.repository.ts:56`; no cron | Reminders/escalation impossible; misleading UI | Build scheduler or hide SCHEDULE | Medium | Near-term |
| TD-16 | Orphan packages `work-os`, `marketplace-intelligence` | 0 importers; MI 62 typeerrors | Dead "canonical" contracts; parallel systems | Retire after zero-ref confirm | Small-Med | Next-sprint |
| TD-17 | Dead `apps/api` (35-line stub) | 0 importers, not deployed | Confusion; README mis-describes it | Delete | Small | Next-sprint |
| TD-18 | Formatter duplication (`relTime` ~10-12×, `money` ~6×) | across CRM/admin pages | Inconsistent money/time rendering (reconciliation risk) | Import `_loop-os/format.ts`; add guard test | Small | Next-sprint |
| TD-19 | Two shells / 2 token sets / duplicated CSS imports | `app`+`crm` layouts import same 7 css; `.crm` inside `.loop-os` | Fragile styling; blocks shell unification | Collapse to one token set (plan first) | Large | Long-term |
| TD-20 | 5 sprint-named CSS files + `/login` dead placeholder | `crm/sprintN.css`; `app/login/page.tsx` | Sprint-named anti-pattern; "two logins" honesty drift | Fold CSS into design-system; delete `/login` | Small | Next-sprint |
| TD-21 | Stale/aspirational docs | README, AUTHENTICATION.md, EVENT_BUS.md (cited by 10), DATA_MODEL.md, 4 arch docs | New engineer actively misled | Correct/collapse; delete EVENT_BUS.md unless built | Medium | Near-term |
| TD-22 | No onboarding docs; `.env.example` drift | no LOCAL_DEVELOPMENT/ENV_VARS; missing CallGrid vars | New engineer can't start | Write onboarding + accurate env reference | Small-Med | Near-term |
| TD-23 | `err.message` leaked to clients | `brain/...:253`, `sync:110`, `backfill:78` | Info disclosure | Non-disclosing `mapThrownError` everywhere | Small | Next-sprint |
| TD-24 | Reset token in redirect URL | `auth/actions.ts:96` | History/referrer/log exposure | Email-only delivery | Small | Next-sprint |
| TD-25 | Stale `health` endpoint | `api/health/route.ts` | Always "not_configured"; useless signal | Real probe or delete | Small | Next-sprint |
| TD-26 | `admin-actions.ts:374` `statusRaw as any` | whitelist-checked then cast | Typed-escape debt (small) | Narrow the type | Small | Next-sprint |
| TD-27 | `NormalizationEngine` in `*.repository.ts`; some `WorkRepository` methods take no org arg | `normalization.repository.ts`; `getWorkInstance(id)` etc. | Naming/boundary leak; org-scope by convention | Rename; add org first-arg | Small-Med | Near-term |
| TD-28 | No membership model (1 org/user) | `User.organizationId` scalar | Blocks super-admin, cross-org roles, dept modules | `OrganizationMembership` table | Large | Long-term (Phase B/H) |

**Debt character (from the code-quality scan):** the codebase is **not** debt-ridden at the micro level — 0 `@ts-ignore`, 0 `TODO/FIXME/HACK`, 0 real empty catches, only 4 production `as any`, and the `mock/fake/placeholder` markers are overwhelmingly an **honesty culture** (test doubles + honestly-labelled stubs), not deception. The debt is **architectural and organizational** (tenancy, async, tests/CI, docs, parallel systems), which is exactly where the roadmap focuses.

Machine-readable: `technical-debt.csv`.

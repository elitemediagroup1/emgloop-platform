# CLAUDE.md — EMG Loop Engineering Constitution

**Read this before making any change.** It is the operating manual for this repository, not a README.
It encodes what we learned building this platform, including the mistakes. Where it contradicts a
comment in the code, this file wins — several file headers in this repo are stale, and some are
actively misleading. Where it contradicts the code's *behavior*, trust the code and fix this file.

Written and maintained by the lead engineer. Keep it short enough to read every session.

---

## Mission

EMG Loop is an **AI-first operating system for customer-facing businesses**. It is not a CRM. The CRM
is one surface inside it.

It sits on top of businesses that book appointments, take orders, and answer phones — home services,
salons, clinics, restaurants, law firms — and handles lead management, AI phone/SMS agents, customer
timelines, workflows, analytics, and behavioral intelligence.

**Long-term vision:** the business's operating brain. Signals flow in from every channel, the Brain
reasons over them, AI Employees act on them, and humans supervise rather than operate.

**Principles behind the platform:**

1. **AI-first, not CRM-first.** The CRM is a view over the intelligence, not the product.
2. **Industry-agnostic from day one.** ServicesInMyCity is the first data source, not the product.
   Nothing vertical-specific belongs in a shared layer.
3. **Multi-tenant SaaS.** Every row belongs to an organization. No exceptions (see §Multi-Tenant Rules).
4. **Provider-agnostic.** We own the intelligence, not the infrastructure. No vendor names in domain code.
5. **Own the intelligence, rent the plumbing.** Twilio, Stripe, ElevenLabs, Anthropic are replaceable.
   The Brain is not.

---

## Product Philosophy — responsibility boundaries

These boundaries are the most violated thing in the repo. Learn them before adding code.

| Layer | Owns | Never does |
|---|---|---|
| **Loop OS** (`apps/web/src/app/app/`, `src/workspaces/`) | The shell: role routing, workspace config, navigation, layout chrome. | Business logic, data access, intelligence. It *describes* the shell; it is never the security boundary. |
| **CRM** (`apps/web/src/app/crm/`) | The operator's working surface: customers, conversations, pipeline, inbox, workflows, users, settings. Human-driven records. | Owning intelligence. It renders what the Brain concluded; it does not conclude. |
| **Work OS** (`work.repository.ts` + `Blueprint`/`WorkInstance` tables) | Human work execution: blueprint → instance → stage → assignment → completion → handoff. | Automation triggers. That is a CRM Workflow. Two different concepts that unfortunately share a word. |
| **Brain** (`packages/brain`) | Reasoning: signals, diagnostics, recommendations, next-best-action, briefings. **Pure functions only.** | I/O. No `fetch`, no Prisma, no `process.env`, no clock, no RNG. Timestamps and ids are passed in. This discipline is real — hold it. |
| **Marketplace** (`app/app/admin/marketplace/`, `packages/marketplace-intelligence`) | Buyer/vendor/source/campaign economics over call and lead data. | Defining new intelligence shapes. It projects into Brain types; it must not fork them. |
| **AI Employees** (`AIEmployee` model, `ai-employee.repository.ts`) | Identity and configuration of an autonomous worker: name, role, channels, hours, escalation, DNA. | **Pretending to think.** There is no LLM in this codebase today. AI Employees are assignable identities. Do not imply otherwise in UI or comments. |

**The rule behind the table:** intelligence flows *up* — providers → database → brain → UI. If a lower
layer imports a higher one, stop and reconsider. `database → brain` already exists and is an inversion
we tolerate, not a pattern to copy.

---

## Core Engineering Principles

These are not aspirations. They are enforced in review.

1. **Never fabricate functionality.** If it isn't built, it doesn't get a button.
2. **Never fake AI.** No canned strings presented as reasoning. If an LLM isn't called, don't call it
   intelligence. (`crm/layout.tsx` once rendered a hardcoded "Brain Status: Online" — that is the
   anti-pattern, by name.)
3. **Never fake metrics.** A number on screen must trace to a row in the database.
4. **Prefer honest empty states.** "No realized revenue yet" beats a zero dressed as data. This repo
   already does this well (`revenue/page.tsx`); match that standard.
5. **Delete dead code instead of hiding it.** We carry ~9,000 lines with zero importers. Every one of
   them was "kept just in case." Deleting is cheaper than the confusion. Git remembers.
6. **One source of truth.** We have three workflow systems, two shells, three nav configs, and two
   token sets. Each one started as "just for now."
7. **Simplicity over cleverness.** The `_loop-os` primitives are good because they are boring.
8. **Production-first.** Code that only works because one tenant exists is not production code.
9. **Comments describe *now*, not intent-at-writing.** This repo's comments drift badly and people make
   decisions from them. If you change behavior, change the header. If you find a lying comment, fix it
   even if it's not your ticket.
10. **Honesty is a feature.** The best thing about this codebase is that it admits its limits
    (`property-ingest.ts` refuses to claim authenticity it can't have). Never regress that.

---

## Repository Architecture — the canonical mental model

Turborepo + npm workspaces. **One deployable: `apps/web`.** Netlify builds `--filter=@emgloop/web`.

```
apps/
  web/     Next.js 14 App Router. THE product. ~24k LOC.
           src/app/crm/      36 mature feature routes
           src/app/app/      Loop OS shell (5 workspaces; only ADMIN + EMPLOYEE/work are real)
           src/app/api/      19 route handlers — THE REAL API TIER
           src/auth/         session, scrypt, guards
           src/workspaces/   role router, workspace config, WorkspaceShell
           src/crm/          server actions + CRM context
  api/     DEAD. 35-line stub. Nothing imports or deploys it. Do not add to it.
packages/
  shared/                    kernel types + kg.v1 contract. Incoherent; don't add to it casually.
  providers/                 interfaces + adapters. CallGrid, Resend, Website are REAL. Rest are mocks.
  brain/                     intelligence contracts. Pure. ~80% type declarations today.
  database/                  Prisma + 24 repositories + 5 services. Largest real asset.
  work-os/                   types only, ZERO importers. Contracts the runtime ignored.
  marketplace-intelligence/  ZERO importers. Does not typecheck.
```

**Do not believe `docs/`.** 87 files, mostly frozen at day one. `AUTHENTICATION.md` claims no auth
exists (it does). `EVENT_BUS.md` describes a bus that was never built, and three other docs cite it.
`DATA_MODEL.md` says 28 models; there are 47. Read code, not docs.

### Database layer
PostgreSQL (Neon) + Prisma. 47 models, 27 enums, 5 migrations. **Zero raw SQL** — keep it that way.
Migration history is a reconstruction, not a chronology; production has no `_prisma_migrations` table
and the build runs only `prisma generate`. Treat migrations as fragile until that's fixed.

### Repository pattern
`packages/database/src/repositories/*` own persistence. `services/*` orchestrate across repositories.
The boundary leaks today (services call Prisma directly; `NormalizationEngine` is a service wearing a
repository's filename). Don't widen the leak. **Repositories take an explicit org scope** — see below.

### Authentication
Cookie `emgloop_session`, httpOnly. scrypt + per-user salt. Session token returned to the browser;
only its SHA-256 hash is persisted. `timingSafeEqual` everywhere. This is correct — don't "improve" it.

`middleware.ts` gates `/crm/*` on **cookie presence only** (Edge has no DB). Real enforcement is in
server guards. `PUBLIC_PATHS` in `middleware.ts` must stay in sync with `STANDALONE_PREFIXES` in
`crm/layout.tsx` — they drifted once and made the entire invite flow unreachable.

**One organization per user.** `User.organizationId` is scalar. No membership table, no org switcher.
This is a real ceiling; changing it is a schema decision, not a refactor.

### RBAC
Deny-by-default. Static `MATRIX` in `iam.repository.ts` maps `SystemRole` → `resource:action`.
`Permission` rows can ADD or DENY on top; **DENY always wins**. 12 resources, 5 actions.

⚠️ `systemRole` and `passwordHash` both live in the `user.metadata` JSON bag. **Always merge, never
replace** that bag (see §Multi-Tenant Rules). `Invitation.systemRole` is a real column that nothing
reads — the role is in metadata. Don't be fooled.

### WorkspaceShell & routing
`/` → `/crm/login` → `/crm` → setup gate → `/app` → role home. `/app/page.tsx` is the *only* place
post-login routing happens.

`workspaces/config.ts` is data, not code branches. Adding a role is a row. `WorkspaceShell` takes
`{workspace, session}` and has zero role branching — keep it that way.

⚠️ `BUSINESS_OWNER` and `CREATOR` resolve only via a `session.workspaceRole` hint that **nothing sets**.
Those two workspaces are unreachable. Don't build into them without fixing the hint first.

---

## Coding Standards

- **Server Components first.** Only 5 `'use client'` files exist, all leaves. Zero client layouts,
  zero client pages. This is the strongest property of the frontend — do not erode it. If you need
  `'use client'`, push it to the smallest possible leaf.
- **Repository pattern.** Feature code never touches `prisma.*` directly. Go through a repository.
- **Strong typing.** `strict` + `noUncheckedIndexedAccess` are on. Don't add `any` to silence them;
  `status: statusRaw as any` in `admin-actions.ts` is debt, not precedent.
- **Avoid duplication.** `relTime` exists 8 times, `money` 4 times. Before writing a helper, grep.
  `_loop-os/format.ts` is the home for formatters.
- **Consistent naming.** `xBelongsToOrg` for ownership guards. `*.repository.ts` for persistence.
  `*.service.ts` for orchestration. A file named for a sprint is a mistake we already made ×5.
- **Defensive programming.** Fail closed. Unknown role → least privilege. Missing scope → deny.
  Return `null` for not-found rather than throwing into a server action.
- **No new CSS files.** Especially not sprint-numbered ones. Use the tokens in `design-system.css`.

---

## Multi-Tenant Rules

**This section is non-negotiable. It is written in scar tissue.**

### What happened
Sprint 28 correctly moved every CRM *read* onto the session organization and deleted the demo-slug
resolver. Sprint 29A then found **three cross-tenant writes** — including one that let any
`organizations:update` holder rename *any organization on the platform* while the audit row was
attributed to the attacker's own org. Those bugs were introduced *during* four consecutive
org-scoping hardening PRs, by people actively thinking about tenancy.

**The lesson is not "be careful."** It is that caller-enforced isolation cannot be sustained by
review, because the safe call and the unsafe call look identical at the call site.

### The rules

1. **The organization ALWAYS comes from the signed session.** Never from FormData, a query param, a
   header, a path segment, or a body. If you type `formData.get('orgId')`, you are writing a
   vulnerability.
2. **Repository APIs take an explicit `organizationId` as their first argument** for anything that
   reads or mutates a tenant-owned row. A method signature of `update(id, fields)` on a tenant model
   is a bug waiting for a caller. This is why `AIEmployeeRepository` now reads
   `updateEmployee(organizationId, id, fields)`.
3. **Scope at the data layer, not the call site.** Resolve the row *within* the organization first
   (`findFirst({ where: { id, organizationId } })`), and fail closed to `null`. Make the unsafe call
   unwriteable rather than trusting the next author to remember a guard.
4. **No audit entry for a write that didn't happen.** If the scoped resolve returns null, return —
   don't record.
5. **Cross-org access is not-found, not forbidden.** Don't leak the existence of other tenants' rows.
6. **`AuthRepository` is the one legitimate exception** (`findAnyUserByEmail`, `resolveSession`).
   Nothing else gets to be cross-org.

### Known open tenancy debt — do not make it worse

- **Ingestion is single-tenant.** `/api/webhooks/callgrid`, `/api/webhooks/website`, and
  `/api/integrations/callgrid/sync` resolve their org from a hardcoded
  `LIVE_ORG_SLUG = 'servicesinmycity-demo'`, behind one global webhook URL and one global signing
  secret. **We cannot onboard a second customer until this is fixed.** Never add a fourth route that
  reads `LIVE_ORG_SLUG`.
- **The knowledge API's isolation is self-declared.** One shared `LOOP_EVENT_SECRET` proves "you are
  some EMG service," then the caller names its own `platform`/`organizationId` in the query string.
  Treat the knowledge graph as a **single trust domain** until scope derives from the credential.
- **`integration_events` is uniquely keyed `(provider, externalId)` globally, not per-org.** Fixing
  this needs a migration; it cannot be fixed in callers.
- **10 tables carry `organizationId` with no FK** (Work OS + `vk_*`). Deleting an org orphans them.
- **The metadata bag must be merged.** `softRemoveUser` once replaced it wholesale and destroyed both
  `passwordHash` and `systemRole`, silently returning re-enabled users as passwordless EMPLOYEEs.
  Always `{ ...meta(user), ...changes }`.

---

## Security Rules

- **Authentication** is solved. Don't rebuild it. Don't add a second session mechanism. Don't
  introduce a social-login dependency without a decision from Matt.
- **Authorization is server-side, always.** `requirePermission(resource, action)` at the top of the
  page or action. The UI hiding a button is not access control. (PR #76 shipped exactly that bug:
  a UI-only ownership check that let any employee complete a colleague's work stage.)
- **Every page and action guards itself.** `/crm/layout.tsx` does *not* guard — it renders even
  unauthenticated. Never assume a layout protected you.
- **Secrets** are server-only, never in `NEXT_PUBLIC_*`, never logged, never echoed in a response.
  A secret shared across many callers authenticates *a class*, not *a tenant* — never use one to
  authorize tenant-scoped data.
- **Webhooks:** verify before parsing. HMAC over `<timestamp>.<body>`, timing-safe compare, timestamp
  tolerance, fail closed when the secret is missing. Production **never** accepts unsigned traffic.
  Know that replay protection is an in-memory per-instance map — on serverless it is close to
  decorative. Idempotency on `(provider, externalId)` is the real defense.
- **Never trust the SDK.** Browser ingest keys are `pk_emg_<property>` over a public list. That tier
  is *unauthenticated by design*. It may never grant anything beyond low-trust event ingestion.
- **Production safety:** no destructive DDL from a request path. No `migrate deploy` from a webhook.
  Anything touching production data is a `workflow_dispatch` with a human typing a confirmation.

---

## Git Workflow

1. **One objective per branch.** Name it `fix/…`, `feat/…`, `chore/…`. If you discover a second
   problem, note it — don't fold it in.
2. **Never commit to `main`.** Branch first, always.
3. **Validate before committing:** build, typecheck, lint (see §Validation).
4. **Logical commits.** One defect or concern per commit. The message explains *why it was wrong*,
   not what the diff shows. A reader six months from now needs the reasoning, not the patch.
5. **Draft PR.** Always `--draft`. The body states: what changed, why, what was validated, what was
   deliberately excluded, and whether a migration is needed.
6. **Never merge.** Not ever, not "it's obviously fine." Matt merges.
7. **Never commit `package-lock.json` casually.** It is currently untracked by convention. Committing
   it is a deliberate decision, not a side effect. (It *should* be committed — but as its own change,
   with CI adjusted from `npm install` to `npm ci` in the same PR.)
8. **Revert generated churn.** `next-env.d.ts` regenerates on every build/lint and will pollute your
   diff. `git checkout -- apps/web/next-env.d.ts` before committing.
9. Verify a merge actually landed before deleting a branch. GitHub squash-merges here, so your commit
   SHA won't be an ancestor of `main` — check the *content*, not the graph.

---

## Validation Requirements

Every sprint validates with **build**, **typecheck**, **lint**. Run all three. Report all three.

### Current baseline — know this before you panic

- ✅ `turbo run build` — passes.
- ⚠️ `turbo run typecheck` — **fails on `@emgloop/marketplace-intelligence` (62 errors).**
  Pre-existing. That package has zero importers and doesn't gate the build (Netlify filters to
  `@emgloop/web`). `apps/web` and `packages/database` are clean — keep them clean.
- ⚠️ `turbo run lint` — **fails because ESLint was never configured.** No config, no dependency;
  `next lint` drops into an interactive wizard and exits 1. `npm run lint` has never passed here.

### When validation fails

1. **Determine root cause.** Read the actual error. Don't infer.
2. **Isolate.** Prove whether it's yours: `git diff origin/main -- <path>`. If the failing package is
   byte-identical to `main` and doesn't depend on what you touched, it's pre-existing.
   Beware false baselines — a fresh worktree without `node_modules` will silently run the wrong `tsc`
   and report zero errors.
3. **Fix only what your sprint requires.** Pre-existing breakage is a tracked follow-up, not scope creep.
4. **Never hide a failure.** Don't `|| true`, don't narrow the CI filter, don't delete the assertion.
   Report it in the PR body with evidence.

**There are 2 test files for ~48,000 lines, and no CI gate on PRs to `main`.** Every guarantee in this
document is currently enforced by human attention. Act accordingly: if you touch tenancy, auth, or
ingestion, be more careful than you think you need to be.

---

## Documentation Rules

| File | Update when | Never |
|---|---|---|
| `README.md` | The product pitch, stack, or setup steps change. Audience: a new human. | Sprint detail. (It currently claims "Sprint 1 — no customer-facing features." It's wrong. Fix it when you touch it.) |
| `docs/ARCHITECTURE.md` | A structural decision changes: a new package, a boundary move, a deploy change. Audience: an engineer designing against it. | Aspirations. If it isn't built, it doesn't go here. There are already four competing architecture docs — add to none of them; collapse them. |
| `CLAUDE.md` (this file) | A **rule** changes, a scar is earned, or the baseline shifts. Audience: the next Claude session. | Narrative or sprint logs. This is a constitution, not a changelog. |

**Never write an aspirational doc.** `EVENT_BUS.md` describes a system that does not exist, and three
other docs now depend on it. A doc for unbuilt work is worse than no doc — it gets cited.

If you write a doc for a feature, the doc dies with the feature. Delete both.

---

## Decision Framework

When multiple valid implementations exist, in strict order:

1. **Does it introduce a parallel system?** If yes, stop. This is the repo's defining failure mode —
   three workflow systems, two shells, three navs, two token sets, two logins. Every one was locally
   reasonable. **Extend or replace; never add alongside.**
2. **Architectural consistency.** Match the pattern that already exists, even if you'd have chosen
   differently. A consistent mediocre pattern beats two good ones.
3. **Clarity.** The next reader has no context. Optimize for them.
4. **Maintainability.** Prefer the version that's easier to delete.
5. **Then** performance, elegance, everything else.

**Corollary — the replacement rule:** if you build a replacement, you own retiring the original *in
the same sprint*. "We'll delete it later" is how we got 9,000 lines of orphaned code and a package
named `work-os` that points at the dead implementation.

**Corollary — fix at the root:** when the same class of bug recurs, the fix is structural, not another
guard. Sprint 29A scoped the repository API instead of adding a fourth `xBelongsToOrg` helper, because
three prior guards hadn't stopped the bug.

---

## Working With Matt

- **Think like a CTO, not a ticket processor.** You are accountable for the platform's trajectory,
  not just the diff. If the ticket is right but the plan is wrong, say so.
- **No surprise architectural pivots.** Never introduce a new package, shell, framework, dependency,
  or data model as a side effect of another task. Propose it, explain the tradeoff, wait.
- **Explain tradeoffs before changing architecture**, not after. Give a recommendation, not a menu.
- **Surface risks early**, especially when they're inconvenient. "We can ship the shell, but ingestion
  is still single-tenant so customer #2 will write into ServicesInMyCity" is the kind of thing that
  must be said *before* the sprint, not in the retro.
- **Challenge assumptions respectfully.** If a request encodes a wrong premise, name the premise.
  "Shell Unification" was a reasonable instinct with no written plan and unresolved prerequisites —
  the useful answer said so rather than starting.
- **Report honestly.** If tests fail, say so with the output. If you skipped something, say that. If
  it's done and verified, say it plainly without hedging.
- **Stop and ask** only when: production data could be affected, security needs a judgment call,
  multiple approaches are genuinely equal, or tooling blocks you. Otherwise decide and move.
- **Distinguish what you verified from what you inferred.** Always.

---

## Long-Term Goals

The order matters. Each unlocks the next.

1. **True multi-tenancy.** Per-org webhook routing and per-org credentials; delete `LIVE_ORG_SLUG`.
   Derive knowledge scope from the credential. Fix the `integration_events` unique key. Add the
   missing FKs. **This is the gate on customer #2 — it outranks everything below.**
2. **A floor.** Commit the lockfile. CI gate on `main`: repo-wide typecheck + tests. A real test
   suite starting with cross-tenant access attempts.
3. **Asynchronous processing.** A queue and worker. Webhooks persist raw and return fast; processing
   moves off the request path with retries, a DLQ, and a shared replay store. Fix the
   200-on-failure contract so providers redeliver. Give `LoopEvent` a consumer or delete the gateway.
4. **Unified shell.** Move `/crm`'s 36 real routes into `/app`'s better shell — it is config-driven,
   permission-aware, and fail-closed. This is a migration *into* `/app`, not a meeting in the middle.
   Prerequisites: one nav config, one guard family, one token set, and the phantom workspaces resolved.
   **Write the plan down first** — no plan exists today.
5. **Production Brain.** Replace `demonstrateBrainActivityFlow` — the current live briefing path — with
   a real envelope author over real signals. Implement the `BrainService` sub-services that are
   currently names.
6. **Production AI Employees.** A real AI provider behind the existing `ai.provider.ts` interface,
   then wire `channels`, `operatingHours`, `escalationRules` and `dnaOverrides` to something that
   reads them. **Last, deliberately.** Agents on top of caller-enforced tenancy, no async spine, and
   two tests would compound every risk above. The abstraction is ready; the foundation isn't.

**The through-line:** this platform's read path is good and its write path is not. Everything above is
about making the write path as trustworthy as the read path, and only then making it smart.

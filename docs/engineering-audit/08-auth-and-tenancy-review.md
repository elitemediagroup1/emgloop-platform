# 08 — Authentication, Authorization & Multi-Tenancy Review

**Baseline:** `ab830f8` (production `main`). All claims verified from source unless marked *(inferred)*.

**Verdict:** Authentication is genuinely well-built and should be **preserved, not rebuilt**. The gaps are in **authorization granularity** (workspace-level guards standing in for matrix-level checks on the newer `/app/admin/*` surfaces) and in **tenancy ceilings** (single-tenant ingestion; a self-declared knowledge-gateway scope). This matches — and updates — `CLAUDE.md`'s scar-tissue section.

---

## 1. Authentication — Production-ready ✅

| Property | Implementation | Evidence |
|---|---|---|
| Session cookie | `emgloop_session`, `httpOnly` + `secure` + `sameSite:lax`, 1-day / 30-day (remember) | `apps/web/src/auth/auth.ts:26,138-144` |
| Password hash | `scryptSync(pw, salt, 64)`, per-user 16-byte random salt, stored `scrypt$salt$hash` | `auth.ts:32-54` |
| Verify | recompute scrypt + `timingSafeEqual`; malformed → `false` (fail-closed) | `auth.ts:44-54` |
| Token at rest | client gets `randomBytes(32)` hex; DB stores only `sha256(token)` | `auth.ts:58-64` |
| Login | active-only, anti-enumeration on INVITED/DISABLED, creates hashed session, records login | `auth.ts:97-146` |
| Validate | `resolveSession(sha256(token))`; rejects revoked/expired/missing/DISABLED | `auth.repository.ts:105-120` |
| Logout | `revokeSession` + cookie `expires:0` | `auth.ts:148-155` |
| Password reset | single-use hashed token, expiry-checked, `revokeAllForUser` after reset | `actions.ts:101`, `auth.repository.ts:155-167` |
| Invite accept | derives identity from hashed token, never trusts client email | `actions.ts:127` |

**Finding AUTH-001 — Low — Security.** `requestResetAction` appends the **plaintext reset token** to the redirect URL (`&token=<plaintext>`) for in-app display. *Evidence:* `apps/web/src/auth/actions.ts:96`. *Why it matters:* reset tokens in query strings land in browser history, referrer headers, and any proxy logs. *Recommendation:* deliver the token only via email; render the in-app confirmation without the secret. *Effort:* Small. *Priority:* Next sprint.

**Finding AUTH-002 — Informational.** No independent email-verification on onboarding; the invite token is the sole trust root. Acceptable given invite-only signup, but note it before opening self-serve signup.

---

## 2. Middleware & edge gating

- Matcher: `['/crm/:path*', '/app/:path*']` (`middleware.ts:73`).
- **`/crm/*`** gated on **cookie presence only** (Edge has no DB) — a forged/expired cookie passes the edge but fails server-side `resolveSession`. Correct by design.
- **`/app/*` is NOT gated at the edge** — `middleware.ts:52` returns early for non-`/crm` paths. `/app/*` relies entirely on `requireWorkspace()` in layouts. *(Verified; this is intentional but means every `/app` page's safety is the layout guard — see §3.)*
- **`PUBLIC_PATHS` (`middleware.ts:25-31`) ↔ `STANDALONE_PREFIXES` (`workspaces/config.ts:355-361`) are identical** (5 entries, same order). The `CLAUDE.md` sync hazard currently holds. ✅

---

## 3. Authorization / RBAC

**Model:** deny-by-default static `MATRIX` (`iam.repository.ts:69-95`); `Permission` rows ADD (user-level ALLOW) or subtract (user/role DENY); **DENY always wins** (`can()`, `:191-221`). 12 resources × 5 actions.

### Effective permissions matrix (from code)

`V`iew `C`reate `U`pdate `D`elete `M`anage · ALL=VCUDM · RW=VCU · RO=V

| Resource | OWNER | ADMIN | MANAGER | EMPLOYEE | READ_ONLY |
|---|---|---|---|---|---|
| customers | ALL | ALL | RW | RW | RO |
| pipeline | ALL | ALL | RW | RW | RO |
| inbox | ALL | ALL | RW | RW | RO |
| workflows | ALL | ALL | RW | RO | RO |
| users | ALL | ALL | RO | — | — |
| organizations | ALL | V,U | RO | — | — |
| aiEmployees | ALL | ALL | RW | RO | RO |
| settings | ALL | ALL | RO | — | — |
| audit | ALL | RO | RO | — | — |
| analytics | ALL | ALL | RO | RO | RO |
| integrations | ALL | ALL | RO | — | — |
| intelligence | ALL | ALL | RO | RO | RO |

> `AI_EMPLOYEE` is in the `SystemRole` enum with a label but has **no MATRIX row** → silently inherits `READ_ONLY` grants (`matrixAllows`, `:105`). There is **no role-level ALLOW branch** — role customization can only DENY; only user-level `Permission` rows add access.

### Finding AUTHZ-001 — High — Authorization

**Title:** The entire `/app/admin/marketplace/*` subtree (plus `admin/brain`, `admin/marketplace-intelligence`, `admin/work/*`) has **no `requirePermission`** — only `requireWorkspace('ADMIN')`.
**Evidence:** `apps/web/src/app/app/admin/layout.tsx:18` guards the subtree with `requireWorkspace('ADMIN')`; the marketplace/brain/work page files contain no `requirePermission` call (verified by grep). `requireWorkspace('ADMIN')` (`workspaces/guard.ts:34-41`) only checks the session resolves to the ADMIN workspace — i.e. `SystemRole ∈ {OWNER, ADMIN, MANAGER}` — and never maps to a `resource:action`.
**Why it matters:** A **MANAGER** reaches every marketplace/brain admin page, even though the matrix grants MANAGER only `view`/`RO` on `intelligence`/`analytics` and nothing on `settings`/`users` mutations. Authorization on the newest, most sensitive surfaces is **coarse (workspace-level)**, not matrix-level. This is the same class as PR #76's "UI-only check" scar. It is currently read-mostly, so impact is bounded to **information disclosure** today — but any mutation added under `/app/admin/*` inherits the gap.
**Recommendation:** Add `requirePermission('intelligence','view')` (and the appropriate action for any mutation) at the top of each `/app/admin/*` page/action, or wrap the subtree's data loaders in a matrix check. Fix at the root: give the admin layout a required `resource:action`, not just a workspace.
**Effort:** Medium. **Priority:** Before new features. **Dependency:** none.

### Finding AUTHZ-002 — Medium — Authorization

**Title:** Several CRM data pages enforce only authentication + org scope, not the RBAC matrix.
**Evidence:** `crm/customers`, `customers/[id]`, `inbox`, `pipeline`, `search`, and `crm/page.tsx` use `requireCrmContext()` (`crm/crm-data.ts:42` → `requireWorkspaceSession`) — auth + org only, **no `resource:action`**. 25 of 37 CRM pages *do* call `requirePermission`; these are the exceptions.
**Why it matters:** A `READ_ONLY` user has `view` on these resources anyway, so exposure is limited; but the page layer no longer enforces the matrix, so a future DENY on `customers:view` for some role would not be honored at these pages. Mutations still route through `requirePermission` in `conversation-actions.ts` etc., so writes are safe.
**Recommendation:** Add the matching `requirePermission(resource,'view')` to these list/detail pages for defense-in-depth and matrix honesty.
**Effort:** Small. **Priority:** Next sprint.

**Positive:** All mutating server actions (`admin-actions.ts`, `workflow-actions.ts`, `conversation-actions.ts`, `integration-actions.ts`, `setup-actions.ts`, `work-types/actions.ts` — ~40 call-sites) **do** call `requirePermission`. Write-path authorization is consistent.

---

## 4. Role storage (verified quirks)

- `systemRole` and `passwordHash` live in **`user.metadata` JSON**, not columns (`iam.repository.ts:119-122,290`; `auth.repository.ts:49-70`). ✅ matches `CLAUDE.md`.
- **`Invitation.systemRole` column is effectively unread** — role is written to `metadata.systemRole`; the column keeps its `@default(EMPLOYEE)` (`iam.repository.ts:134-139,430,450`). Dead column; do not "fix" a reader onto it without also writing it.
- **Metadata-merge clobber bug is NOT live** — every existing-user metadata write does a read-modify-`{...m, ...}` merge (`updateUserRole:375`, `softRemoveUser:401-410`, `prepareInvitation:353`, `setPasswordHash:60`). `createUser`/`prepareInvitation`-create set a fresh bag (correct, new row). The historical `softRemoveUser` REPLACE bug is fixed and documented in-place.

---

## 5. Multi-tenancy

### Finding TENANCY-001 — High *(inferred — needs route confirmation, see `06-api-inventory`)* — Multi-tenancy

**Title:** The knowledge gateway derives `organizationId` from the **request query string / body**, not the session.
**Evidence:** `apps/web/src/lib/knowledge/gateway.ts:95` (`resolveScopeFromQuery`) and `:124` (`validateScopeObject`) read `organizationId`/`platform` from client-supplied input. `CLAUDE.md` already flags the knowledge API as a single trust domain authenticated by one shared `LOOP_EVENT_SECRET`.
**Why it matters:** If any route handler under `src/app/api/**/knowledge*` calls these without binding scope to the caller's session org, a holder of the shared secret can name **any** `organizationId` and read/write across tenants — the exact "safe call and unsafe call look identical" failure `CLAUDE.md` §Multi-Tenant Rules describes.
**Recommendation:** Derive scope from the authenticated credential/session, never from the query. Until then, treat the knowledge graph as one trust domain and do not put per-tenant-sensitive data in it. **Confirm the calling routes in the API inventory before downgrading severity.**
**Effort:** Medium. **Priority:** Before new features. **Dependency:** API route confirmation.

### Finding TENANCY-002 — High (known, documented) — Multi-tenancy

**Title:** All inbound ingestion is hard-bound to a single tenant via `LIVE_ORG_SLUG = 'servicesinmycity-demo'`.
**Evidence:** `crm/live-org.ts:18`; consumed by `api/webhooks/website/route.ts`, `api/webhooks/callgrid/route.ts`, `api/integrations/callgrid/sync/route.ts` (each `where: { slug: LIVE_ORG_SLUG }`). Server-side constant, **not** client input — so not an injection, but a scaling ceiling.
**Why it matters:** **This is the gate on customer #2** — every webhook writes into `servicesinmycity-demo` regardless of payload. One global webhook URL, one global signing secret.
**Recommendation:** Per-org webhook routing + per-org credentials; derive org from the credential. (Long-Term Goal #1 in `CLAUDE.md`.) Never add a 4th route reading `LIVE_ORG_SLUG`.
**Effort:** Large / Multi-phase. **Priority:** Before onboarding a second customer.

**Positive — core CRM tenancy is sound:** `grep formData.get('organizationId'|'orgId')` → **0 hits**; every CRM action derives org from `session.organizationId`. Sampled IAM/AI-employee repository lookups all scope `{ id, organizationId }` (`iam.repository.ts:194,271,372,401`; `ai-employee.repository.ts:99`). Lookups by primary key alone are only on session-derived / single-use-token ids (correct).

---

## 6. Phantom workspaces — confirmed dead

`BUSINESS_OWNER` and `CREATOR` workspaces resolve **only** via `session.workspaceRole` (`role-router.ts:57-63`), but **nothing in production ever sets that field** — `AuthSession` has no `workspaceRole` (`auth.ts:68-75`); the only writers are self-test fixtures (`workspaces/verification.ts:93-115`). Therefore `requireWorkspace('BUSINESS_OWNER'|'CREATOR')` redirects **every** real session away, and `/app/business/*` + `/app/creator/*` are unreachable. Do not build into them until the hint is actually set. *Effort to fix: Small (populate the hint from a real signal); Priority: Long-term.*

---

## 7. Can the model support the target role set?

The 5-role `SystemRole` + additive `Permission` layer + 12×5 matrix is a **reasonable foundation** but has two structural ceilings for the roles named in the brief (super-admin, org owner/admin, exec, dept leader, manager, employee, contractor, accounting/sales/talent, creator, client, vendor, read-only, AI employee, service account):

1. **One organization per user** (`User.organizationId` scalar; no membership table) — blocks platform super-admin across orgs, vendors/creators/clients who span orgs, and any org switcher. *This is a schema decision (see `07-database-review`), not a refactor.*
2. **Resources are product-area coarse** (12 fixed). Department-scoped or record-scoped authorization (e.g. "accounting user sees only accounting", "talent manager sees only their creators") needs either scoped resources or row-level scoping — not expressible in the current matrix.
3. **No role-level ALLOW** — new roles can only be built by DENY-carving from a base role, which is awkward for additive personas.

**Recommendation:** Keep the deny-by-default matrix and DENY-wins semantics (they are correct). Before the department modules (Roadmap Phase H), introduce a **membership table** (org ↔ user ↔ role) and **scoped/record-level permissions**. Treat `AI_EMPLOYEE` explicitly in the matrix rather than letting it inherit `READ_ONLY` by accident.

---

### Cross-references
- Ingestion single-tenancy detail → `10-ai-and-workflow-review`, `09-provider-and-integration-review`.
- Knowledge-gateway route confirmation → `06-api-inventory`.
- Membership-table schema change → `07-database-review`, `17-engineering-roadmap` Phase B/C.
- Security severities consolidated → `11-security-report`.

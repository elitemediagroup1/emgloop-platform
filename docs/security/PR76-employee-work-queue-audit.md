# PR #76 Employee Work Queue — Post-Merge Security Audit

Scope: the five files shipped by PR #76 (now on main), plus the PR #75
WorkRepository methods they call. Audit only; the sole code change is the
stage-ownership fix described below.

## Threat model

Employees (EMPLOYEE workspace) can reach /app/employee/work. They must only
ever see and act on real work in their own organization, and only complete
stages they personally own. The client is never trusted for identity or scope.

## Checklist

| Control | Result |
| --- | --- |
| Every employee route guarded by EMPLOYEE workspace | PASS — employee/layout.tsx calls requireWorkspace('EMPLOYEE') (fail-closed), and the data/action layer re-guards via requireEmployeeActor(). |
| No admin-only blueprint creation exposed to employees | PASS — no blueprint-creation entry points in the employee surface. |
| Every read scoped to actor.organizationId | PASS — all reads pass actor.organizationId. |
| Every mutation re-derives actor from server session | PASS — all four actions call requireEmployeeActor(). |
| Employees cannot update work outside their org | PASS — repository org guards; detail page returns notFound cross-org. |
| Employees cannot complete stages they do not own | FIXED — was UI-only; now enforced server-side (see below). |
| Employees cannot mark another user's notifications read | PASS — markNotificationRead scopes by { id, userId }. |
| Detail page returns notFound for cross-org ids | PASS — loadEmployeeInstance returns null on org mismatch. |
| No unauthenticated access | PASS — requireWorkspace redirects unauthenticated users to login. |
| Admin Work OS routes still build | PASS — untouched by this PR. |
| No unrelated files changed | PASS. |

## The one finding and its fix

Before this PR, the "Complete stage" control was gated only in the UI
(isMine = current.ownerUserId === actor.userId). The server action
completeCurrentStageAction did not re-verify ownership; it forwarded the
client-supplied work instance id and actor.userId to the WorkRepository, which
enforces organization isolation but not stage ownership. An authenticated
employee could therefore complete the current stage of any active instance in
their own organization, including a stage owned by a colleague.

Fix: completeCurrentStageAction now re-loads the organization-scoped instance
via loadEmployeeInstance and rejects completion unless the current stage's
ownerUserId equals the acting user. The change is contained to the employee
action file; the shared PR #75 repository is not modified.

## Verification

Code review plus a green Netlify/GitHub build (TypeScript compile + Next build).
This is not a live database or runtime test.

# Brain boundary — the Loop side (B5)

**Status: BUILT, SWITCHED OFF.**
- **What B5 adds.** The Loop side of the approved Brain-on-AWS design (`brain-execution-infrastructure.md`):
  - the Brain API a signed-in person reaches;
  - the narrow surface an executor may use;
  - the internal Brain API an executor calls;
  - doorbell signing and worker-token verification;
  - stored-control enforcement;
  - Brain Activity;
  - checkpoint sealing;
  - a test-only reference executor.
- **What B5 does not do:**
  - no migration, and no applied migration is touched;
  - no AWS resource and no AWS credential;
  - no provider call and no activation;
  - no change to Netlify;
  - no production read or write.
- **With the environment every deployment has today, nothing runs:**
  - the AI floor is off, so every submission is refused `NOT_ENABLED` before anything is recorded;
  - the doorbell is not configured, so nothing is rung;
  - worker trust is not configured, so every internal request gets `401`.

**How it relates to the other records.**
- `brain-execution-architecture.md` holds the direction and contracts.
- `brain-execution-infrastructure.md` (B3) holds the AWS design.
- `brain-persistence.md` (B4) holds the tables.
- This record says what Loop now answers, to whom, and on what authority.
- The AWS build plan for B6 is `brain-aws-implementation-dossier.md`.

---

## 1. Verified starting facts (2026-09-17)

| Fact | Evidence |
|---|---|
| `main` is `f744fca`, the squash of #277 (B4) | content matches the reviewed head |
| 36 migrations; the last is `20260919000000_brain_durable_persistence`; nothing later | `packages/database/prisma/migrations` |
| Production is at 36 | "Deploy Prisma Migrations" run `35160530756` applied migration 36 and reported the schema up to date |
| That run used **Node 20.20.2** and warned that `openai@7.15.0` requires Node ≥ 22 | the run log (the warning is from `npm install`; the migration does not load the SDK) |
| The schema matches `brain-persistence.md` | B5 changes neither `schema.prisma` nor any migration; `prisma validate` passes |
| AI is off; zero Anthropic and zero OpenAI requests | no provider path was exercised; B5 adds no provider import |

## 2. Submission

**Entry point:** `submitBrainWorkAction(submission)` (server action, `apps/web/src/brain/actions.ts`). It
resolves the signed session first; the organization and the person come from it and from nothing else.
The service is `BrainWorkService.submit` (`packages/database/src/services/brain/brain-work.service.ts`).

**Order of decisions.** Each step runs only if the one before allowed the work; a refusal writes nothing.

| # | Decision | Refusal |
|---|---|---|
| 1 | `parseBrainSubmission`: exactly `taskId`, `subject`, `executionClass`, `idempotencyKey`, `input` (scalars); any organization, principal, role, provider or other field is refused | `INVALID_SUBMISSION` |
| 2 | **Authorization, before anything else is read:** membership authority for (session organization, session user), then `iamAiAuthorizer` (role in the task's `invokerRoles`, every `requires` permission through the enforcing `can()`), then `brainSubmissionRefusals` (known task, allowed execution class, subject type matches the task's owner) | `NOT_PERMITTED`, `UNKNOWN_TASK`, `EXECUTION_CLASS_NOT_SUPPORTED`, `SUBJECT_TYPE_MISMATCH` |
| 3 | **Controls:** this deployment's floor AND the recorded controls (§8), then `aiTaskAvailability` | `NOT_ENABLED`, `PAUSED`, `NOT_CONFIGURED` |
| 4 | **Route gate:** `brainRouteGate` (the reviewed routing still honours provider specialization) | `ROUTING_NOT_CONFORMANT` |
| 5 | **Subject:** it must be a live record **of the session's organization**, of a type whose authority is built | `SUBJECT_NOT_FOUND` |
| 6 | **Accept:** one Neon transaction writes the job, transition #1, event `brain.job.accepted` and the START command (`BrainJobRepository.accept`) | `IDEMPOTENCY_KEY_REUSED`, `PRINCIPAL_NOT_ACTIVE_MEMBER`, … |
| 7 | **Ring** the doorbell for the stored START command (§7). The outcome is reported and never undoes the job | — |

- **A person who may not run the task learns only `NOT_PERMITTED`.** That includes a disabled member,
  whom the authorizer refuses before the membership check could name them.
- **INTERACTIVE and DURABLE stay distinct.** The caller asks for a class; the task decides whether it is
  allowed. Case Explanation is INTERACTIVE only.
- **The result type is its own declaration.** It is stored separately from the capability route and the
  execution class, and how a job runs never changes what it produces.
- **Idempotent.** The same submission (organization, principal, task, key, same content) returns
  `EXISTING` with the same job and rings nothing. The same key with different content is refused.
- **No provider, no AWS.** Nothing in this path imports a provider SDK, reads a provider credential or
  an AWS credential, or calls anything but Neon and the doorbell.

**Subjects Brain may work on** (`brain-subjects.ts`). Anything else is refused.

| Subject type | Record | Owner's page |
|---|---|---|
| `CASE` | `operational_priorities` in the organization | `/app/admin/cases/<id>` |
| `RELATIONSHIP` | `crm_relationships` in the organization, not `VOIDED` | `/crm/relationships/<id>` |
| `CUSTOMER_CONVERSATION` | `conversations` in the organization | `/crm/conversations/<id>` |

Brain `CONVERSATION`, `CAMPAIGN` and `DECISION` subjects are not accepted: their authorities are not
built.

## 3. Status and reads

| Route / method | Who | Returns |
|---|---|---|
| `GET /api/brain/work` | the session's person | their work (unfinished first, then newest, at most 50) and `working`, a measured count |
| `GET /api/brain/work/<jobId>` | the job's principal only | one job's view; anyone else gets `404` |
| `BrainWorkService.forSubject` | anyone who may run the job's task | "Brain is working on this": job id, task, result type, phase and who started it. **States only** |

**The view (`BrainWorkView`)** carries:
- job id, task and result type;
- the subject and a link to its owner's page;
- execution class and whether it was promoted;
- state, and the product **phase**:

  | Job state | Phase |
  |---|---|
  | ACCEPTED, QUEUED | `QUEUED` |
  | RUNNING | `WORKING` |
  | WAITING_FOR_USER | `WAITING_FOR_YOU` |
  | SUCCEEDED | `COMPLETED` |
  | FAILED | `FAILED` |
  | CANCELLED | `CANCELLED` |

- whether it is finished, its open question (wait id and expiry), whether a stop was requested, and
  its end reason;
- where each result lives: owner authority, subject, artifact id and the owner's page;
- progress as the running step (key and kind) and the number of completed steps, **never a percentage**;
- accepted, started and ended times.

It carries **no** input, question text, result content, provider or model.

- **Navigating away loses nothing.** Every read comes from Neon; nothing depends on the browser that
  submitted the work.
- **Truth States.** `working` and `forSubject` are measured (`Truth`), so "no work" is a measured zero,
  not a missing number.
- **No UI yet.** The Brain product states are Track 2 (UI-5), built on these reads.

## 4. WAITING_FOR_USER

**The question contract** is `brain.question/1` (`packages/shared/src/ai/brain-question.ts`).

| Kind | Asks | A valid answer |
|---|---|---|
| `CHOOSE_ONE` | a prompt and 2–10 options, each with an id, a label and an optional governed ref (`type:id`) | exactly one offered option id |
| `CONFIRM` | a prompt | `confirmed: true` or `false` |
| `SHORT_TEXT` | a prompt and a maximum length (1–1,000) | non-blank text within that length |

- **Limits:** prompts are at most 500 characters and labels at most 120.
- **Refused:** extra fields and control characters anywhere.
- **Nothing rides on an answer.** A reply naming an organization, a user or a record the question did
  not offer is refused.

**The round trip:**
1. **The executor asks.** `BrainExecutorStore.waitForUser` parses the question **before** it is stored;
   a malformed question never waits. The wait rules are B4's: DURABLE only, the task must allow waits,
   no pending stop, expiry in the future.
2. **The principal reads it.** `GET /api/brain/questions/<waitId>` answers the principal only; anyone
   else gets `404`.
3. **The principal answers.** `respondToBrainQuestionAction(waitId, reply)` runs these checks in order:
   1. the wait is this person's; otherwise `WAIT_NOT_FOUND`, exactly as for a missing wait;
   2. the person may still run the job's task (`NOT_PERMITTED`);
   3. the stored question parses (`QUESTION_UNREADABLE`);
   4. the reply is valid for that question (`INVALID_REPLY`).

   It then applies B4's `waits.answer`. That call records one reply and one RESUME command in one
   transaction. An identical repeat is `ALREADY`, a different second answer is
   `WAIT_ALREADY_ANSWERED`, and a write race is retried once. Finally it rings.
4. **The executor wakes.**
   - `BrainExecutorStore.command(commandId)` reads the command, its job and its wait.
     `brainCommandDisposition` executes a RESUME only when Loop holds the answer it names.
   - The executor asks Loop for a fresh access decision, then calls `resumeAfterReply`, which reads the
     reply from Neon; the message never carries it.
5. **Expiry.** `expiredWaits` finds the due waits and `expireWait` cancels each job with
   `WAIT_EXPIRED`. A late reply is refused.

## 5. Cancellation

**Entry point:** `cancelBrainWorkAction(jobId)` → `BrainWorkService.cancel`.

- **Who may stop work:**
  - the job's principal (`REQUESTED_BY_PRINCIPAL`);
  - an OWNER or ADMIN of the organization (`REQUESTED_BY_ADMINISTRATOR`, attributed to that person).
  - **Anyone else is told the job does not exist.**
- **Durable.** The request is a transition, a recorded cancel request (actor, reason, time) and a CANCEL
  command, in one transaction.
- **Idempotent.** Asking twice stores one CANCEL command. A finished job is `ALREADY_FINISHED`, and
  version races are retried (at most three attempts).
- **Immediate where nothing runs.** ACCEPTED, QUEUED and WAITING_FOR_USER jobs become CANCELLED at once
  (`stoppedNow: true`).
- **At a boundary where something runs.** A RUNNING job shows `cancelRequested: true` and stays
  `WORKING` until the executor settles it (`CANCEL_SETTLED`) at its next step boundary.
- **Visible to the executor** in two ways: the CANCEL command's disposition is `EXECUTE`, and the job
  record carries the cancel request.
- **Controls stop work too.** `BrainExecutorStore.stopByPolicy` records the stop as a named POLICY act
  (reason `KILL_SWITCH`), never as an anonymous system.

## 6. The executor's surface

### 6.1 `BrainExecutorStore`: everything an executor may do to Loop's records

| Group | Methods |
|---|---|
| Waking up | `resolve` (an advance message's job, current generation only), `command` (a rung command and its disposition), `markDispatched` |
| Holding a job | `claim` (lease, then read the job and its input), `release`, `addActiveTime`, `transition` (DISPATCHED, STARTED, PROMOTED, CANCEL_SETTLED, RESULT_COMMITTED, FAILED only), `controlsFor`, `stopByPolicy` |
| Steps | `stepState`, `beginStep`, `checkpoint`, `readCheckpoint`, `failStep` |
| Waiting | `waitForUser` (parsed questions only), `resumeAfterReply`, `expireWait` |
| Usage | `reserveCall`, which reserves under `brainCallKey` and records job, step and specialization policy version; `reconcileCall`, which refuses any call that is not this job's |
| Sweeper | `undispatchedCommands`, `expiredWaits`, `staleLeases` |

- **What it lacks:** no method creates a job, records a reply, requests a person's cancellation, reads
  a product table or writes a result. A test pins the method list.
- **The one unscoped step.** It resolves a reference to its organization once (identities only), then
  acts through organization-first repositories.
- **In AWS** it runs as `loop_brain_worker`, whose grants match this surface
  (`scripts/operations/brain-database-roles.sql`).

### 6.2 The internal Brain API: three questions, no more

| Route | Purpose | Answer |
|---|---|---|
| `POST /api/internal/brain/access` | `ACCESS_DECISION` | the principal's membership and a fresh `{allowed, organizationId, principalUserId, taskId, decidedAtMs}` |
| `POST /api/internal/brain/context` | `CONTEXT` | the minimized context package, the citable refs with their trust, task support data and withheld counts, the access decision and principal record it was assembled under, and `commitGate` (`AVAILABLE` only when an owner gate is registered for the job's result; added in B6); `403 NOT_PERMITTED`, `409` otherwise |
| `POST /api/internal/brain/commit` | `COMMIT_RESULT` | body `{stepKey, envelope}` → the owner's artifact ref and commit key; `403 NOT_PERMITTED`, `409` for every other refusal |

**Authentication** (`authenticateBrainWorkerRequest`, run first in each route):
1. worker trust must be configured, otherwise `401`;
2. the Bearer token must verify against a pinned key (§7), otherwise `401` with no detail;
3. the claims must be well formed, otherwise `401`;
4. the body must be 256 KiB or less, otherwise `413`;
5. the SHA-256 of the exact bytes received is computed;
6. **the job the token names is loaded from Loop's records**;
7. `brainWorkerRequestCheck` checks issuer, worker, audience `loop-brain-internal`, lifetime, the
   route's purpose, the body hash, the job, its generation, and whether the job's state allows the
   purpose. A failure returns `403` with the rule broken;
8. the body must be JSON, otherwise `400`.

No route reads a session or a cookie, and nothing in the request names an organization or a principal:
**the job does**. The middleware matches only `/crm` and `/app`, so these routes are reachable without a
cookie, and each one guards itself.

**Every answer is re-decided** (`BrainInternalService`):
- **access** reads membership and runs the IAM authorizer now. An inactive membership is refused even
  if an authorizer would allow it, and a task version Loop no longer serves allows nothing.
- **context** re-decides access, then runs the task's registered assembler for the job's own
  organization, principal and stored input. The package must name that organization and person and
  pass `validateAiContextPackage`.
- **commit** re-assembles the context, applies `brainCommitRefusals` against the job's expectation
  (`brainCommitExpectation`) and the evidence Loop supplied **now**, and then hands the result to the
  owning authority's gate under `brainResultCommitKey`. Brain never stores a result.

### 6.3 Context assemblers

- **`case.explanation`** reuses the interactive path's minimized context (`buildCaseExplanationContext`):
  structured measurements and system findings, with free text, names and user identifiers withheld.
  Its figures and dates travel as `support` for the executor's validator.
- **No other task is registered**, so any other task is `NO_CONTEXT_FOR_TASK`.

### 6.4 Owner gates: none yet (a blocker for the first request)

- **No owning authority has a result store**, so every commit is refused `OWNER_GATE_UNAVAILABLE`.
- **Case Explanation on AWS (B7) needs a Commercial Intelligence store for Case analyses.** That means
  a migration, plus Matt's decision on whether explanations are kept as history or replaced. See
  `brain-execution-infrastructure.md` §24.
- **This blocks the first live request, not AWS provisioning.**

### 6.5 Checkpoint sealing

- **`AesGcmBrainPayloadSealer`** (`brain-payload-sealer.ts`) implements B4's `BrainPayloadSealer`:
  - AES-256-GCM, format `aes-gcm.1`;
  - a binary header, then a random 12-byte IV;
  - associated data binding the key reference, organization, job, step, input fingerprint and purpose.
- **It refuses to open** a checkpoint copied to another job, step, input or organization, one relabelled
  to another key, one with a tampered byte, or one with another header.
- **The caller supplies the key.**
  - Tests use a random key.
  - In B6 the executor supplies a data key its key service unwrapped, and names the wrapped key in
    `keyRef` (envelope encryption).

### 6.6 The reference executor (tests only)

`packages/database/test/brain-boundary.test.ts` drives accepted work the way an execution-environment
worker will, in process and with no provider:
- ring → command → dispatch → lease → start → controls → context;
- a stub "model" step with a real sealed checkpoint → an owner's commit → `RESULT_COMMITTED`;
- a question and its answer;
- a cancellation that arrives mid-step, honoured at the boundary.

It proves the shapes B6 will call.

## 7. The doorbell trust boundary

**A ring is a wakeup, not authority.** It asks the executor to look at one stored command. The executor
re-reads that command and its job from Neon and decides for itself (`brainCommandDisposition`), so a
forged, replayed or duplicated ring can only make it look again at work already recorded.

| Property | Loop side (built, `doorbell.ts`) | Receiving side (B6, contract already pure and tested) |
|---|---|---|
| Algorithm | ES256 (P-256) only; the header is exactly `alg`, `typ`, `kid` | verify with pinned public keys by `kid`; refuse any other `alg`, `none`, or `crit` |
| Issuer / subject | `LOOP_BRAIN_DOORBELL_ISSUER` / `LOOP_BRAIN_DOORBELL_SUBJECT` | must be in the trusted issuers and callers |
| Audience / scope | `loop-brain-doorbell` / `brain.dispatch` | `brainDoorbellCheck` refuses anything else |
| Lifetime | 60 s (`iat`, `exp`) | ≤ 120 s including skew |
| Replay | a random `jti` for every ring | `jti` written once to a replay ledger; a second use is refused |
| Claims | exactly `iss`, `sub`, `aud`, `scope`, `jti`, `iat`, `exp` | no organization, principal, job or role, in the token or the body |
| Body | exactly `{"commandId": "…"}` | exactly that; anything else is refused |
| Signing material | a private key from the deployment environment; never from a request. The verifier honours no `jku`, `x5u` or embedded key | public keys from configuration only |
| Transport | HTTPS only; no credentials in the URL; `redirect: error`; no cache; 2 s timeout | throttled route |
| Failure | never throws; returns `RUNG`, `NOT_CONFIGURED` or `FAILED`; the job stands either way | `401` or `403` with no detail |
| Missed ring | the command stays `dispatchedAt = null`; the sweeper finds it (`undispatchedCommands`) | the sweeper dispatches it (reason RECOVERY) |
| Duplicate ring | harmless: one command per purpose | `ALREADY_DONE` |
| AWS keys | none; Loop holds no AWS credential | — |

**Environment variables** (`brain-environment.ts` is the only reader; none is `NEXT_PUBLIC_`):

| Name | Secret | Meaning |
|---|---|---|
| `LOOP_BRAIN_DOORBELL_URL` | no | the doorbell endpoint (https) |
| `LOOP_BRAIN_DOORBELL_ISSUER` | no | this deployment's issuer name |
| `LOOP_BRAIN_DOORBELL_SUBJECT` | no | this deployment's caller name |
| `LOOP_BRAIN_DOORBELL_KEY_ID` | no | the `kid` the receiver pins |
| `LOOP_BRAIN_DOORBELL_SIGNING_KEY` | **yes** | PKCS#8 P-256 private key (PEM; `\n` escapes accepted) |
| `LOOP_BRAIN_WORKER_ISSUERS` | no | comma-separated trusted worker issuers |
| `LOOP_BRAIN_WORKER_SUBJECTS` | no | comma-separated trusted worker names |
| `LOOP_BRAIN_WORKER_PUBLIC_KEYS` | no | JSON `{kid: SPKI PEM}` |

- **Nothing set** reads as `NOT_CONFIGURED`.
- **Anything partial or malformed** reads as `INVALID`, which is treated as off. That covers an
  unset or empty value, an `http` URL, a URL with credentials, a non-P-256 key, and **a private key
  placed in the public-keys variable** (refused, not silently converted).
- **A key's value is never echoed**, not even in an error.
- **B5 sets none of these.** Setting them is a B6/B7 step for Matt.

**Tests** (`apps/web/test/brain-boundary.test.tsx`) prove:
- **Signing and verification:** tampering, `none`, `HS256`, `crit`, unknown or missing `kid`, a wrong
  key, malformed and oversized tokens, and signature length are all refused.
- **Loop's ring token** passes the receiver's `brainDoorbellCheck`, carries exactly its seven claims,
  and gets a fresh `jti` each time. The body is only `{commandId}`.
- **Ring failures:** not configured, a bad command id, a refused ring, an unreachable doorbell and a
  hanging doorbell all return without throwing, and without waiting past the timeout.
- **Worker requests:** every refusal path, including a token for another purpose, body, audience,
  issuer, worker, time, job, generation or state. The organization and principal come from the loaded
  job even when the token claims others.
- **Fences:**
  - only `brain-environment.ts` reads `LOOP_BRAIN_*`, and none is public;
  - every Brain module is server-only, names no provider and needs no cloud credential;
  - each person-facing entry point resolves the session first;
  - each internal route authenticates the worker first and never reads a session.

## 8. Stored controls

**Effective controls = this deployment's floor AND the recorded controls** (`aiEffectiveControls`,
`packages/shared/src/ai/ai-controls.ts`). No migration was needed.
- **Absent means off where a control grants.** GLOBAL, the ORGANIZATION itself, a platform TASK and a
  PROVIDER must each be recorded ACTIVE.
- **Any applicable KILLED control stops work.** GLOBAL, the organization, a platform task, a provider
  or a model.
- **Stop-only scopes** (flagged for Matt):
  - an **organization's own TASK** control can switch a task off for that organization, never on;
  - a **MODEL** control only stops, because models are allowlisted by the reviewed routing policy.
- **Scoped to the organization.** Another organization's controls never apply.

**Where controls apply:**
- **At submission** (§2, step 3), with the web floor from `readAiControlFloor`. That floor reads
  `LOOP_AI_*` and **no provider credential**: Brain executes elsewhere. A provider counts when it is
  listed. (Provider data-terms approval -- G2 -- is a recorded `PROVIDER_POLICY` control enforced by
  the AI gateway's admission since 2026-09-24; `LOOP_AI_PROVIDER_TERMS_CONFIRMED` is no longer read.)
- **In the executor** (`BrainExecutorStore.controlsFor(job, floor)`), with the executor's own floor, at
  every boundary.

**Consequence for activation.** Production has **no control rows**, so even with `LOOP_AI_ENABLED=true`
every Brain submission is `NOT_ENABLED`.
- Recording platform controls needs a reviewed operations workflow (typed confirmation, like
  migrations). **It is not built.**
- An organization-level control surface for OWNER/ADMIN is not built either.
- Both are prerequisites for the first request, not for AWS provisioning.
- The existing Netlify Case Explanation path is unchanged and stays off. It reads the environment
  floor only, and is retired when Case Explanation moves to AWS (B7).

## 9. Brain Activity

- **Composed.** The Brain-events adapter (`brain-event.adapter.ts`) is now part of Activity, because
  migration 36 is deployed.
- **What an item says.** Its title is a sentence with no content:
  - "Brain analysis started", "… continues in the background", "… completed", "… failed",
    "… cancelled", with the noun taken from the result type;
  - "Brain is waiting for clarification".

  It never carries a prompt, a response, a question, a reply, input, a provider, a model or a secret.
- **Two lanes, both in the ADMIN workspace:**
  - the organization feed, which requires every permission any Brain task requires;
  - a Case's feed, which additionally requires `commercialIntelligence:view` and covers at most 200
    jobs per Case.
- **Each item is rechecked.** It requires its own task's permissions, so a viewer never sees work on
  a task they could not run.
- **A finding fixed during B5.** The lane first opened without a workspace, so an OWNER in the
  EMPLOYEE workspace, and a narrowed EMPLOYEE, could read the Brain feed. It now carries the ADMIN
  workspace, like the Case log and the Brain module, and tests pin this.

## 10. Retired: `/api/brain/call-handling-briefing`

As B3 §25 and B4 §13 planned, Brain now has one front door.
- **Deleted:**
  - the unlinked, read-only diagnostic route;
  - its record (`docs/brain/call-handling-briefing-endpoint.md`);
  - its only data read, `LiveOperationsRepository.listBrainCallWindow`, with its two types.
- **Also gone:** the audit's finding that the route echoed `err.message` (SEC-L2), for this route.
- **Kept:** the pure `packages/brain` functions it composed (`assembleAndRunCallHandlingFlow`,
  `projectBrainBriefing`), which have their own verification importers.

## 11. Carried forward

### 11.1 The outbox drain: disposition

- **Brain does not depend on it.** Dispatch uses Brain's own command table, the doorbell and the
  sweeper; completion is recorded as Brain events and read by Activity at query time.
- **Still broken in production.** Scheduled "Drain outbox" runs fail because the repository secrets
  `OUTBOX_DRAIN_URL` and `OUTBOX_DRAIN_SECRET` are unset. The route also needs `OUTBOX_DRAIN_SECRET` in
  the Netlify environment.
- **Disposition:** Matt sets the secrets, or B6 replaces the GitHub schedule with an EventBridge
  Scheduler call. **B8 prerequisite** (notifications and subscribers); **not** an AWS or first-request
  prerequisite.

### 11.2 Schema drift: disposition

- **Resolved by B1** (#273); B5 changes no schema and no applied migration.
- **Follow-ups, not built:**
  - a CI replay check (fresh replay, then `prisma migrate diff` must be empty);
  - a read-only check that production index names match the replay.

### 11.3 Node runtime: audit

| Where | Node | Status |
|---|---|---|
| `.nvmrc` | 22 | matches the SDK floor |
| `netlify.toml` `NODE_VERSION` | 22 | matches |
| root `package.json` `engines` | `>=20.0.0` | **below** the SDK floor (`openai@7.15.0` requires ≥ 22) |
| GitHub workflows | 20 in twenty workflows, including `deploy-prisma-migrations`; `.nvmrc` in two | Node 20 is past end of life upstream, and Lambda deprecated `nodejs20.x` on 2026-04-30 |
| Code guard | `AI_MINIMUM_NODE_MAJOR = 22` (`sdk-clients.ts`): provider SDKs are never constructed below 22 | holds for any executor that uses the adapters |
| AWS Lambda (read 2026-09-17) | `nodejs24.x` (deprecation 2028-04-30), `nodejs22.x` (2027-04-30) | see the dossier §D |

- **Executor runtime contract:** Node ≥ 22 is enforced by the adapter guard. **Recommended:**
  `nodejs24.x`, tested on Node 24 in the executor's CI; `nodejs22.x` is acceptable but deprecates
  within about seven months.
- **Recommendation: a separate maintenance PR**, not part of B5:
  - move every workflow to `node-version-file: .nvmrc`;
  - raise `engines` to `>=22`.

  Moving `.nvmrc` and Netlify to 24 is a further, separate decision.

## 12. Findings and decisions for Matt

1. **No result store exists for any owner** (§6.4). Case Explanation on AWS needs one: a migration,
   plus a history-or-replace decision. It blocks the first live request, not provisioning.
2. **No way to record platform or organization controls** (§8). An operations workflow is needed
   before any request; an OWNER/ADMIN surface can come later.
3. **Administrators may stop anyone's Brain work** in their organization (§5). This follows B3's
   "the principal or an administrator the API checked"; confirm.
4. **Organization TASK and MODEL controls are stop-only** (§8). Confirm.
5. **DRAFT.** The latest run brief lists five result types without DRAFT. DRAFT was approved in B3.1 and
   is persisted by B4, and B5 keeps it. Confirm this was an omission.
6. **The Netlify Case Explanation path** stays off and is retired in B7.
7. **Status polling cost** on Netlify is still to be measured before B7 (B3 §21).
8. **Node:** the maintenance PR in §11.3.

## 13. Validation

Recorded in the B5 pull request.

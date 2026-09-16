# Brain on AWS — trust, security and infrastructure record (B3)

**Status: DESIGN. Nothing in this record is provisioned or built.**
- **What exists:** the pure contracts it relies on, in `packages/shared/src/ai/` (B2, plus the small B3
  addition `brain-dispatch.ts`).
- **What does not exist:**
  - no AWS account, role, function, queue, API, secret or key;
  - no change to Netlify;
  - no provider credential moved;
  - AI is not activated;
  - no migration.
- **Scope of the design:** it settles how Loop hands Brain work to AWS **before** that environment
  exists. Each build step (§25) is its own reviewed pull request.

**Amended after merge (B3.1, 2026-09-16).** Matt and Charlie then decided DRAFT and reaffirmed
provider specialization with no universal fallback order. Decision 2 below, §15's fallback row, §24
and §25 are updated to match; nothing else in the design changes.

**How it relates to the other records.**
- `brain-execution-architecture.md` holds the approved direction and the contracts.
- `loop-ai-runtime.md` holds governance, the taxonomy and the activation gates.
- This record says how the direction becomes infrastructure, and **revises one proposal from B0**: the
  executor (§7).

---

## 1. Verified starting facts (2026-09-16)

| Fact | Evidence |
|---|---|
| `main` is `c85911a`; B2 (#274) landed exactly as reviewed | content diff against the reviewed head is empty |
| 35 migrations; replay drift zero | fresh PostgreSQL 18 replay: 35/35 applied, `prisma migrate diff` "No difference detected", exit 0 |
| AI switched off; zero Anthropic and zero OpenAI requests | `LOOP_AI_ENABLED` must be exactly `true`; no code path was exercised against a provider |
| No AWS Brain infrastructure in the repository | no IaC, no AWS SDK, no infra directory |
| **Production Neon is in `aws-us-east-1`** | the database host Prisma reported in the production migration run log (35103219698). Only the region is recorded here. |
| Netlify function region | **not verified.** Netlify's default for sites created after 2023-10-04 is `cmh` (us-east-2); this site's setting must be read in the Netlify UI |
| Activity is a read-time projection with no table and no outbox | `activity-read-model.repository.ts` |
| The production outbox drain is failing | every scheduled run since at least 2026-09-14: repository secrets unset |

## 2. Decisions from Matt for B3 (approved direction)

1. **B3 is design.** AWS trust, security and infrastructure design comes first. Brain persistence
   follows only after this is approved.
2. **No sixth result type yet** (superseded after B3). Communication drafts were **not** forced into
   ANSWER, and the question was left open. **Matt and Charlie have since added DRAFT** as a sixth
   type, distinct from PROPOSED_ACTION (§24).
3. **Replies come from the principal only.** WAITING_FOR_USER is answered only by the originating
   principal in V1. There is no delegation.
4. **Conformance at run time too.** Provider-specialization conformance must be enforced at run time
   as well as by tests. The boundary is set in §23; production routing is not changed.
5. **Budgets are product targets.** Case Explanation's 20 s presentation budget and 75 s interactive
   deadline are **provisional product targets**. No infrastructure value is derived from them, and
   no infrastructure limit may become them.

## 3. The architecture (recommended V1)

```
 Browser ──session──▶ NETLIFY (Loop web tier)
   │  Brain API: submit · status · respond · cancel       (server actions; session → org + person)
   │   1. authorize (IAM) · controls · route gate · parse submission
   │   2. ONE Neon transaction: job + first command (+ reply / cancel as applicable)
   │   3. ring the doorbell: POST {commandId} + ES256 token (≤60 s)      ── no content, no org
   │  Internal Brain API (for workers only): /api/internal/brain/{access|context|commit}
   │   · verifies the worker's KMS-signed token · loads the JOB · re-authorizes its principal
   ▼
 AWS (one account per environment, us-east-1)
   API Gateway HTTP API  POST /v1/doorbell   (route throttling)
     └─ Lambda authorizer   (pinned public keys · iss/aud/scope/exp/lifetime · jti → DynamoDB)
          └─ dispatcher λ   (body check · reads command + job from Neon · disposition)
               └─ SQS  brain-interactive / brain-durable  (standard; DLQ each)
                    └─ worker λ   (lease → next step → checkpoint-first → do → commit → next)
                          │  • context / access / result commit  ──▶ Loop internal API (KMS-signed)
                          │  • provider keys ◀── Secrets Manager (CMK)
                          │  • model calls ──▶ Anthropic / OpenAI (via the existing adapters)
                          └  • Brain tables, ledger, Brain events ──▶ Neon (restricted role)
   EventBridge Scheduler rate(1 minute) ─▶ sweeper λ
       (undispatched commands · expired waits · due retries · stale leases · passed deadlines)
   KMS (CMK + one asymmetric signing key) · CloudWatch · X-Ray (sampled) · CloudTrail · Budgets
 ▼
 NEON (authority): brain jobs · transitions · steps/checkpoints · waits/replies · commands ·
       brain events · ai_controls · ai_invocations · governed artifacts (written only by Loop)
```

- **What stays on Netlify:**
  - the whole product and sessions;
  - the Brain API;
  - the internal Brain API that workers call;
  - the doorbell signer;
  - the status read model;
  - after the cut-over, **no provider credential**.
- **What runs on AWS:**
  - every Brain step and every provider call;
  - dispatch and scheduling;
  - provider credentials;
  - runtime metrics and alarms.
- **What Neon holds:** everything authoritative. AWS keeps no workflow state that Loop needs.

## 4. Components and their privileges

| Component | Can | Cannot |
|---|---|---|
| Netlify Brain API | Read the session; authorize; write jobs, commands, replies and cancels; sign rings; POST to the public doorbell | Call a provider; hold AWS credentials or call AWS APIs |
| Netlify internal Brain API | Verify worker tokens; read context and write governed artifacts **for the job it loaded**, as that job's principal | Accept an organization or principal from a worker; serve a job in the wrong state |
| Lambda authorizer | Read the pinned doorbell public keys; record a token id | Read Neon; send to a queue; read secrets |
| Dispatcher | Read commands and jobs; mark a command dispatched; send to the queues | Read provider keys; call providers; call Loop's internal API |
| Worker | Lease and advance jobs; read and write Brain tables and the ledger (plus `organizations(id, timezone)` for the ledger's business day); read provider keys; sign worker tokens; call providers and Loop's internal API | Read any other product table; write governed artifacts directly; read other secrets |
| Sweeper | Find due work in Brain tables; send to the queues | Read provider keys; call providers |

## 5. Trust boundary

### 5.1 Netlify side (who may submit, and what is trusted)
- **Who submits.** Only the Brain API's server actions and route handlers submit work. There is no
  client-side submission.
- **Organization and principal** come from the signed session (`requireWorkspace`/session →
  membership authority), never from the request.
- **Checks before anything is stored:**
  1. the IAM decision (`iamAiAuthorizer` plus the task's `requires`);
  2. stored controls plus the environment floor;
  3. the route gate;
  4. `parseBrainSubmission`, which **refuses** any organization, principal or role in the body.
- **Stored before dispatch, in one Neon transaction:**
  - the job (ACCEPTED);
  - the transition row;
  - the first command (START), with `dispatchedAt = null`.
- **Sent to AWS:** only `{ commandId }` and the ring token.
- **Never trusted from the browser:** organization, principal, role, job state, plan, model, provider,
  budget, deadline, wait id ownership, or any "result".

### 5.2 AWS side (the doorbell)
1. **API Gateway receives `POST /v1/doorbell`.** It is throttled per route, and the request never
   reaches the dispatcher unauthenticated.
2. **The Lambda authorizer verifies the ring's ES256 token** against the pinned public keys, taken by
   `kid` from SSM Parameter Store:
   - issuer, audience `loop-brain-doorbell`, scope `brain.dispatch`;
   - `iat` and `exp`, with a lifetime of 120 s or less including skew;
   - it then writes `jti` to a DynamoDB replay table with `attribute_not_exists`, expiring at
     `exp + skew`. **A second use of the same token is refused.**
3. **The dispatcher applies `brainDoorbellCheck`'s body rules:** exactly `{commandId}`, with no
   organization, principal, job or role.
4. **The dispatcher reads the command and its job from Neon by id** and applies
   `brainCommandDisposition`: same organization and generation, the permitted issuer, the state
   accepts it. It then sends a **reference-only** advance message (`parseBrainAdvanceMessage` shape)
   and sets `dispatchedAt`.
5. **Organization substitution is impossible.** The organization is read from the job, the command
   must agree with it, and nothing in the ring or the message can name one.
6. **Execution identity is recorded:**
   - the ring's `jti` and `sub`, the dispatcher request id and the message id, in logs;
   - `dispatchedAt` and the dispatch count, on the command.

### 5.3 AWS → Loop (the worker's requests)
- **When the worker calls Loop:** before a model call or result commit (access), to assemble
  context, or to commit a result. Each call goes to Netlify's internal Brain API with an **ES256 token
  signed by a KMS asymmetric key**, whose private key never leaves KMS.
- **Token claims:**
  - `iss` (environment), `sub` (worker), `aud = loop-brain-internal`;
  - `jti`, `iat`, `exp` (60 s or less);
  - `jobId`, `generation`, `purpose`;
  - `bodySha256`.
- **Netlify verifies with the public key.** The public key is configuration, not a secret. It applies
  `brainWorkerRequestCheck`: the purpose must match the route, the body hash must match the bytes
  received, and the **job it loads** must be in a state that allows the purpose.
- **Loop's answer is based on the job:** its organization and principal, re-authorized through IAM
  right then. A worker can never ask about a job that is not RUNNING (or QUEUED/WAITING for an
  access decision).
- **Replays are harmless.** Access and context calls are reads; commits are idempotent by
  `brainResultCommitKey`.

### 5.4 Authentication options compared

| Option | Secret exposure | Rotation | Replay | Blast radius if leaked | Audit | Burden | Netlify support | Latency | Cost |
|---|---|---|---|---|---|---|---|---|---|
| **A. Netlify-held asymmetric key; ES256 ring token verified by a Lambda authorizer with pinned keys (recommended)** | One private key in Netlify (secret, production context) | Publish new `kid` in SSM, switch Netlify, retire old | `jti` ledger + ≤120 s tokens + idempotent commands | "Look again at commands already recorded"; throttled | Authorizer logs, DynamoDB rows | Low | Native (Node `crypto`) | +1 small Lambda | Negligible |
| B. Same token, API Gateway's native JWT authorizer | Same | Needs a public OIDC discovery document and key set (a public bucket or CDN) | Replay still needs a `jti` check downstream | Same | Less (no custom log) | Medium (public hosting) | Native | None extra | Lowest |
| C. HMAC shared secret | The secret exists in **both** Netlify and AWS | Both sides | Needs the same `jti` ledger | A leak on either side lets anyone forge | Weak | Low | Native | None | Negligible |
| D. AWS IAM SigV4 from Netlify (static keys) | Long-lived AWS keys in Netlify | IAM rotation | SigV4 date only | Real AWS credentials | CloudTrail | Low | Needs keys | None | None |
| E. IAM Roles Anywhere | Certificate private key in Netlify | Certificate authority lifecycle | SigV4 | Temporary AWS credentials | CloudTrail | **High** (hand-written X.509 signing; `CreateSession` is in no SDK) | Poor | +STS | Private CA from $50/month |
| F. Self-issued OIDC → STS `AssumeRoleWithWebIdentity` | Signing key in Netlify | Key set | Session lifetime | **Real AWS credentials** for the role | CloudTrail | Medium | Needs hosting | +STS | Free |
| G. No doorbell (the sweeper only) | None | — | — | — | — | Lowest | — | **Up to a minute or more before work starts** | Free |

- **Why A:**
  - **Least privilege.** A leaked key grants nothing but a "look". AWS holds only public keys, so an
    AWS-side compromise cannot forge rings.
  - **Separation.** The authorizer runs with **no** access to Neon, queues or secrets, so
    unauthenticated input never touches a privileged role.
  - **Standard parts.** It needs no public key hosting and no custom cryptography.
  - **Fallback.** G remains the recovery path underneath it.
- **Netlify issues no workload identity token** (verified 2026-09-16). Keyless federation from Netlify
  is therefore not available, and some secret in Netlify is unavoidable for push dispatch.
- **For AWS → Loop,** a KMS-signed token is preferred over two alternatives:
  - **HMAC:** it would need a shared secret.
  - **Presigned STS `GetCallerIdentity`, the Vault pattern.** It has no key cost, and STS actions are
    logged. But every verification calls STS, and its server-id header binds a request to a server,
    not to one use, so replay within the signature window needs a separate nonce.

  KMS signing costs $0.15 per 10,000 ECC signatures (§21).
- **The worker's token calls are not replay-free on their own.** Loop needs no `jti` ledger for them:
  reads are harmless, and commits are unique by commit key.

## 6. Exact doorbell flow

1. **The person acts, in Netlify.** The session gives the organization and principal. Loop checks
   access, controls and the route gate, and parses the submission. It then applies
   `brainSubmissionDecision`: **RETURN_EXISTING** ends here with the existing job, and **REFUSE**
   ends here with `IDEMPOTENCY_KEY_REUSED`.
2. **One Neon transaction:**
   - insert the job (ACCEPTED, generation 1);
   - insert transition #1 (event `brain.job.accepted`);
   - insert the START command (`dispatchedAt = null`).
3. **After the commit, Netlify signs a ring token** (`jti` random, ≤60 s) and sends
   `POST /v1/doorbell {commandId}` with a 2 s client timeout. **The result is not awaited for
   correctness.** Netlify returns `{ jobId }` to the browser.
4. **API Gateway → authorizer:** token verification and the `jti` conditional put. A failure returns
   401 or 403 with no detail.
5. **Dispatcher:**
   - body check;
   - `SELECT` the command and its job (restricted role);
   - `brainCommandDisposition`: EXECUTE sends `{jobId, generation, reason, commandId}` to the
     interactive or durable queue and sets `dispatchedAt`; ALREADY_DONE is acknowledged; REFUSE is
     logged and alarmed;
   - returns 202.
6. **Worker:** lease → the job's next step (§8).
7. **If step 3 or 5 failed,** the sweeper finds `dispatchedAt IS NULL AND createdAt < now − 15 s`
   within about a minute and performs step 5 itself (reason RECOVERY).

## 7. Orchestration: the executor

**Options compared against B2's obligations** (Neon holds job state and checkpoints; checkpoint first;
references only; days-long waits; cancellation at step boundaries):

| | A. Lambda durable functions (B0 proposal) | B. Step Functions Standard + Lambda steps | **C. Loop step runner on Lambda + SQS + Scheduler (recommended)** | D. Temporal on ECS |
|---|---|---|---|---|
| Where workflow state lives | AWS checkpoint store **and** Neon (two sources of truth) | Step Functions history **and** Neon | **Neon only** | Temporal history **and** Neon |
| Late failure without re-paying | Yes (plus Loop checkpoints) | Yes (plus Loop checkpoints) | Yes (Loop checkpoints) | Yes |
| Waiting days for a person | Callback, no compute | Task token, no compute | **No message = no compute**; reply → RESUME command | Signal |
| Timers, retries | Built in | Built in | Sweeper (1 min) + SQS delay (≤15 min) + Loop retry policy | Built in |
| Deploying while jobs wait | **Executions pinned to the old version.** A new SDK major version can break in-flight executions, and a security fix cannot reach a waiting job | Definition versioned; waiting runs keep the old definition | **The newest code runs the next step.** Plan versions are data the code must support | Workflow versioning discipline |
| Limits | 3,000 operations and 100 MB per execution; 256 KB per result | 25,000 events; 256 KB | None beyond Neon; messages ≤1 MiB (references only) | History 51,200 events |
| Divergence risk | Needs a reconciler | Needs a reconciler | None: nothing else remembers | Needs a reconciler |
| Maturity | Generally available Dec 2025 (≈9 months); the OpenTelemetry plugin is experimental | Mature | SQS and Lambda are mature; **the runner is Loop code** (small, pure decisions already in B2/B3) | Mature, but heavy to operate |
| Local testing | Local runner | Local emulator | **The same runner with an in-memory queue** | Test server |
| Cost per job | ~$8 per million operations | $25 per million transitions | SQS about $0.40 per million requests | Actions from $50 per million, plus always-on workers |

- **Decision: C.** B2 made Neon the single authority for jobs, steps and checkpoints, so an engine that
  also stores workflow state only adds a second truth to reconcile. It also brings version-pinning,
  which clashes with days-long waits, plus hard limits and new-service risk, all for scheduling that
  a one-minute sweeper and queue delays provide.
- **This revises B0's "proposed shape".** Matt's approval covered the direction, "confirmed at
  implementation review".
- **A and B stay valid adapters behind the executor port** if a future workload needs an engine.
  Temporal stays the heavy escalation. ECS Fargate is added only for a step longer than about
  14 minutes.

**Mapping each need to a service:**
- **Ingress:** API Gateway HTTP API plus the Lambda authorizer.
- **Orchestration:** the worker's step runner, with Neon as its state.
- **Queueing and backpressure:** SQS, with `MaximumConcurrency` on each event source mapping and
  separate interactive and durable queues.
- **Provider invocation:** the worker, through the existing gateway and adapters.
- **Retries:**
  - SQS redelivery covers a crash;
  - `brainStepRetryDecision` plus a delayed send or the sweeper covers planned backoff;
  - DLQ after 5 receives.
- **Checkpointing:** Neon (`brainStepResumeDecision`, checkpoint first).
- **WAITING_FOR_USER:** no message; the reply's RESUME command wakes the job.
- **Cancellation:** a CANCEL command, the cancel flag checked at boundaries, and the in-flight poll.
- **Deadlines and scheduled wake-ups:** `brainStepStartDecision` plus the sweeper.
- **Dead letters:** a DLQ per queue, with an alarm. **Recovery comes from Neon through the sweeper,
  not from DLQ replay.**
- **Concurrency:** event source mapping `MaximumConcurrency`, per-organization admission in Neon,
  and the per-job lease.
- **Observability:** §18.

## 8. How a job advances

For each advance message:

1. **Parse** (`parseBrainAdvanceMessage`). A malformed message goes to the DLQ.
2. **Lease** (`brainLeaseDecision`) with a conditional update on `brain_jobs` (lease holder, lease
   expiry, version).
   - **BUSY:** delete the message and stop; the holder carries on.
   - **TAKE_OVER:** the previous worker died; continue from checkpoints.
   - The lease lasts the longest step's timeout plus a margin (`brainLeaseDurationMs`).
3. **Controls.** Read the stored controls (cached for 5 s or less) plus the environment floor. A kill
   applies → `CANCEL_REQUESTED` (actor POLICY, reason KILL_SWITCH).
4. **Command** (when the message names one): `brainCommandDisposition`.
5. **Next step.** Pick the next step from the job's persisted, versioned plan, then decide with
   `brainStepResumeDecision` (checkpoint first) and `brainStepStartDecision` (deadline and
   promotion).
6. **Boundary checks** before a model call or result commit:
   - an ACCESS_DECISION request to Loop, then `brainBoundaryRefusals` (at most 30 s old);
   - `brainRouteGate`;
   - the ledger reservation (serializable, as today).
7. **Do the step:** context via Loop, the model via the adapters, validation, or a commit via Loop.
8. **One Neon transaction** records the checkpoint, the transition, the ledger reconciliation and the
   Brain event (`brainEventId`), renews or releases the lease, and increments the version.
9. **Send the next message** (CONTINUE, possibly delayed) unless the job is waiting or terminal.
   Delete the current message.

- **A crash at any point** leaves the message invisible until its visibility timeout, or the lease
  expires. Redelivery or the sweeper resumes the job, and step 5 prevents re-running finished work.
- **A cancel during a model call:** while a provider call is in flight, the worker checks the job's
  cancel flag about every 5 s and aborts the call. The ledger row is reconciled with whatever usage
  is known, and otherwise the estimate stays counted.

## 9. Interactive execution

**Options compared:**

| | A. Keep interactive on Netlify | **B. Interactive through AWS (recommended)** | C. Hybrid |
|---|---|---|---|
| Latency | Lowest: no hop | +~0.3 s warm; 1–4 s cold (to measure) | Mixed |
| Streaming | Capped at 60 s | Not needed: results are shown whole; progress comes from Neon | Mixed |
| The 60 s Netlify limit | **Governs the call** | Irrelevant | Governs half |
| Usage accounting, credentials, routing, authorization | Duplicated in two places | **One path** | Two paths |
| Promotion to DURABLE | A cross-system handoff | **A state change on the same job** | A handoff |
| Observability | Split | One | Split |
| Operational complexity | Keys and runtime in two places | One | Highest |

- **Decision: B.** Both classes run on the same AWS runner. The difference is the queue, the
  concurrency reservation and the execution envelope.
- **The browser polls.** It calls Netlify's status route, backing off from about 1 s, and Netlify
  reads Neon.
- **If measured cold-start latency breaks the presentation budget,** the fix is provisioned
  concurrency on the interactive worker, not a second path.
- **The existing Netlify path stays OFF** and is retired when Case Explanation moves to AWS (§25).
- **Presentation budget ≠ interactive deadline ≠ infrastructure timeout:**
  - the presentation budget is only a UI decision (`brainPresentation`);
  - the deadline is the job contract (`brainDeadlineDecision`, `brainStepStartDecision`);
  - the worker's own function timeout is sized from the **longest step**, never from a task's
    budget.

## 10. Interactive → durable promotion

- **Where it happens:** in the worker, at a step boundary.
  - Before a step, `brainStepStartDecision` returns PROMOTE when the step could outlast the
    interactive deadline.
  - After a step, `brainDeadlineDecision` returns PROMOTE once the deadline has passed.
- **What it records.** The `PROMOTED` transition (`brainJobTransition`) is written in the same Neon
  transaction as that boundary's checkpoint. The job's execution class becomes DURABLE, and
  `brain.job.promoted` is emitted.
- **What changes:**
  - the **queue** for the next advance (durable);
  - the **envelope** (the durable deadline, and waits become possible).
- **What does not change:** job id and generation, transitions, checkpoints, ledger rows, evidence
  and provenance, principal and organization (access is still re-checked at every boundary), and the
  result owner.
- **Who decides:** the worker, using Loop's clock values from the job record. Netlify never decides
  promotion; it shows the promoted state when it polls. The presentation budget has no effect on the
  job.
- **Non-promotable tasks** (Case Explanation today) fail by name instead: `DEADLINE_EXCEEDED`,
  before any step that could not finish.

## 11. WAITING_FOR_USER (V1: originating principal only)

1. **Entering the wait.** In the REQUEST_USER_INPUT step, one Neon transaction:
   - inserts the wait (id, question schema and version, minimal structured question, `expiresAt`,
     principal, status OPEN);
   - records `USER_INPUT_REQUESTED` (the job must be DURABLE, the task must allow waits, and no
     cancel may be pending);
   - inserts a Brain event.

   The worker then sends **no** message. Nothing runs, and nothing is billed.
2. **Notification.**
   - **In-app:** the "Brain • N working" and waiting state read from Neon.
   - **Email:** a later step, which depends on the outbox (§16).
3. **The reply (Netlify).** The session identifies the person; the job is loaded within that
   organization.
   - **Refused:** a different principal (`RESPONDER_IS_NOT_PRINCIPAL`), a wait that is not OPEN
     (`WAIT_ALREADY_ANSWERED`), a passed expiry (`WAIT_EXPIRED`), or a different wait
     (`WAIT_MISMATCH`).
   - **Checked:** access is re-checked through IAM, and the reply is validated against its schema.
   - **One transaction:** store the reply under a unique key per wait (an identical repeat returns
     the stored reply), mark the wait ANSWERED, and insert a RESUME command. Then ring.
4. **Waking the job.** The dispatcher applies `brainCommandDisposition` (the RESUME needs the matching
   wait and the recorded reply) and sends RESUME. The worker re-decides access at the boundary,
   applies `USER_INPUT_RECEIVED` (`responderPermitted` true), and continues. The reply is read from
   Neon; the message never carries it.
5. **Expiry.** The sweeper finds OPEN waits whose `expiresAt` has passed and sends TIMER. The worker
   applies `WAIT_EXPIRED`, so the job becomes CANCELLED with reason `WAIT_EXPIRED`. A late reply is
   refused.
6. **Cancellation while waiting.** Nothing is in flight, so Netlify applies `CANCEL_REQUESTED`, making
   the job CANCELLED, in the same transaction as the CANCEL command. It rings anyway, so AWS clears
   any timers.
7. **Duplicate or stale replies:** unique per wait, and repeated rings are harmless (§14).

## 12. Neon access from AWS

**Options compared:**

| | Unrestricted DB client in the worker | Restricted role + views for context | **Restricted role for Brain state + Loop internal API for product data (recommended)** | Everything through an API |
|---|---|---|---|---|
| Blast radius of a compromised worker | The whole database | Brain tables plus every view | **Brain tables, the ledger, one organizations column** | API scope only |
| Authorization logic | Duplicated outside Loop | Duplicated in views | **Stays in Loop (IAM, repositories)** | Stays in Loop |
| Transactions (reservation, checkpoint and reconcile together) | Yes | Yes | **Yes, for Brain state** | Every write is a round trip; serializable reservation over HTTP |
| Latency | Lowest | Low | Low for state; +1 hop for context and commits | Highest |
| Dependency on Netlify | None | None | For context, access and commits only | For everything |

**The V1 boundary:**

| Kind of access | Path | Grant |
|---|---|---|
| Brain job, command, step, checkpoint, wait and event writes | Worker, sweeper, dispatcher → Neon (pooled, TLS) | Read/write on `brain_*` tables only |
| Usage ledger writes | Worker → Neon, serializable | Insert/update on `ai_invocations`; select on `organizations(id, timezone)` |
| Context reads (product data) | Worker → **Loop internal API** (CONTEXT) | none in Neon |
| Access decisions (IAM) | Worker → **Loop internal API** (ACCESS_DECISION) | none in Neon |
| Authoritative product writes (governed artifacts) | Worker → **Loop internal API** (COMMIT_RESULT) → the owner's service | none in Neon |
| Activity and outbox | Worker writes **Brain events** (Brain-owned). Activity reads them at query time as a source adapter | Read/write on the Brain events table |

**Database users.** Three roles, none with DDL; migrations still run as the owner through the manual
workflow:
- `loop_brain_worker`;
- `loop_brain_dispatcher` (read commands and jobs, update `dispatchedAt`);
- `loop_brain_sweeper` (read Brain tables).

**B4 prepared them** in `scripts/operations/brain-database-roles.sql`, with the runbook
`docs/runbooks/brain-database-roles.md`; they are verified locally and applied nowhere shared.

**Create them with SQL, not in Neon's console.** Neon gives console- or API-created roles
`neon_superuser`, while SQL-created roles get only default privileges plus explicit GRANTs. The roles
and grants are applied per environment by a reviewed operations script, **not** by a Prisma
migration, because a migration must not depend on a role that differs between environments.

**Connection handling:**
- **Endpoint and TLS:** Neon's pooled endpoint, in transaction mode, over TLS with certificate
  verification.
- **Pool:** one connection per Lambda instance.
- **Scale:** the queues' `MaximumConcurrency` caps connections well under the pooler's limits.
- **Prisma:** the serializable reservation still works, because each transaction holds one server
  connection.
- **Pooler limits:** Neon's pooler (PgBouncer, transaction mode) supports protocol-level prepared
  statements since 1.22.0. Neon says Prisma ≥ 5.10 no longer needs `pgbouncer=true`. It does **not**
  support `SET`, `LISTEN`, SQL `PREPARE` or session advisory locks, which is why the lease is a
  conditional `UPDATE`, not an advisory lock.

**Network:**
- **V1:** the public internet, with TLS, a strong generated password and a least-privilege role. It
  needs neither a NAT gateway nor a VPC.
- **Later hardening:** Neon IP allowlisting (Scale plan, and static egress through NAT) or Neon
  private networking (Scale plan, same region).

## 13. Provider credentials

| | Netlify environment (today) | **Secrets Manager (recommended)** | SSM Parameter Store SecureString |
|---|---|---|---|
| Who can read | Every Netlify function | **Only the worker role** (resource policy plus identity policy) | Identity policy only; no resource policy |
| Encryption | Netlify-managed | **KMS customer-managed key** | KMS |
| Rotation | Manual, redeploy | **Versioned** (AWSCURRENT/AWSPENDING); manual dual-key runbook, no redeploy | Versioned, manual |
| Audit | Netlify audit log | **CloudTrail** records every read | CloudTrail |
| Cost | Included | About $0.40 per secret per month plus API calls | Standard tier is cheaper (§21) |

**Design:**
- **Secrets.** Three per environment account: `loop/brain/<env>/anthropic`,
  `loop/brain/<env>/openai`, `loop/brain/<env>/neon-worker`. The dispatcher and sweeper get their
  own database secrets.
- **Encryption and access.** Encrypted with the environment's KMS key. The resource policy allows
  `GetSecretValue` only for the worker role and a break-glass role.
- **Reading and caching.** Read with an in-process cache of 5 minutes or less (or the Parameters and
  Secrets extension).
- **Scope.** Keys are **new, per environment**, in separate provider workspaces with spend limits.
- **Rotation.** Create a new provider key, write it as a new secret version, let workers pick it up
  within the cache time, then revoke the old key.
- **Non-secret configuration** goes in SSM Parameter Store (standard): the doorbell public keys, the
  trusted issuers and callers, the Loop internal API base URL, and the worker key id.
- **After cut-over, Netlify holds no provider credential.** Matt removes `ANTHROPIC_API_KEY` and
  `OPENAI_API_KEY` once Case Explanation runs on AWS. Netlify keeps:
  - `DATABASE_URL`, as today;
  - the doorbell signing key (secret, production context only);
  - the worker public key (not secret);
  - the environment master switch.
- **Which components can read a provider key: exactly one**, the worker.

## 14. Idempotency: durable identities, idempotent effects

| Identity | Form | What makes a repeat harmless |
|---|---|---|
| Job | `jobId`, plus `generation` for re-dispatch | Unique per (organization, principal, task, idempotency key) → `brainSubmissionDecision` |
| Command | `commandId` | Immutable row; `brainCommandDisposition` returns ALREADY_DONE |
| Ring | token `jti` | DynamoDB conditional put |
| Advance message | `{jobId, generation, reason, commandId}` | The lease (BUSY) plus checkpoint first |
| Step | `stepKey` (from the plan) plus attempt | `brainStepResumeDecision` |
| Checkpoint | `(jobId, stepKey, inputFingerprint)` | Unique; returned instead of re-running |
| Provider invocation | `brainCallKey` = `jobId:stepKey:attempt[.n]` = `ai_invocations.invocationId` | Unique per organization; a real retry is a new row; a lost paid call counts as spent |
| Result commit | `brainResultCommitKey` = `jobId:stepKey:commit` | The owner's store is unique on it |
| Brain event | `brainEventId` = `jobId#transitionSequence` | Unique; the transition row and the event are written together |
| Wait reply | the `waitId` | Unique; an identical repeat returns the stored reply |
| Job advancement | job `version` plus lease | A conditional update, so two workers cannot both advance a job |

**This is not distributed exactly-once.**
- **Delivery is at least once.** Effects are made idempotent by these identities and by writing the
  checkpoint, transition, ledger reconciliation and event **in one Neon transaction**.
- **The one unavoidable double payment:** a provider answered and the worker died before that
  transaction. The call is recorded as spent, and one more paid attempt is allowed
  (`PROVIDER_RESULT_LOST` if none remains).

## 15. Failure and recovery model

| Failure | What happens | State / reason |
|---|---|---|
| Netlify stored the job but the ring failed | Sweeper dispatches within about 1 min (RECOVERY) | ACCEPTED → QUEUED later; the UI shows it in the background after its presentation budget |
| AWS accepted but the worker crashed | Message redelivered after the visibility timeout; lease taken over; checkpoints reused | RUNNING continues |
| Provider answered; worker died before commit | The `IN_FLIGHT` row is marked abandoned (spend kept); one more paid attempt if allowed | RUNNING, or FAILED `PROVIDER_RESULT_LOST` |
| Provider timeout | The gateway's failure policy; fallback if permitted | RUNNING, or FAILED `PROVIDER_UNAVAILABLE` |
| Provider rate-limited | Fallback if permitted; otherwise a delayed retry within policy | RUNNING, or FAILED `RETRIES_EXHAUSTED` |
| The primary provider fails, and the task's own entry permits and names a fallback (for Case Explanation: Anthropic, then OpenAI) | The fallback serves; `fellBackFrom` and the reason recorded. A task that permits none fails by name | RUNNING → SUCCEEDED, or FAILED `PROVIDER_UNAVAILABLE` |
| Both providers fail | Both calls recorded | FAILED `PROVIDER_UNAVAILABLE` |
| Neon temporarily unavailable | Lease fails → message retried → DLQ after 5; the sweeper re-drives from Neon when it returns; the dispatcher returns 503 and the sweeper dispatches later | The last state stands; nothing advances without Neon |
| User cancels during a model call | Cancel flag set; the worker aborts the call within about 5 s or settles at the boundary; any late result is kept but not applied | RUNNING → CANCELLED `REQUESTED_BY_PRINCIPAL` |
| Access revoked mid-job | The next boundary check refuses | FAILED `ACCESS_WITHDRAWN` |
| Routing policy stops conforming | The route gate refuses before the model step | FAILED `ROUTING_NOT_CONFORMANT` |
| Deployment while jobs are active | In-flight invocations finish on the old version; the next step runs new code; plan versions still in use must stay supported (a deploy check counts live jobs by plan version) | Unchanged |
| Kill switch | The next boundary cancels; new work is refused at submit and at dispatch | CANCELLED `KILL_SWITCH` |
| us-east-1 outage | Neon (same region) and Brain are both affected; jobs stay in Neon; when the region returns, the sweeper resumes them. A cross-region redeploy is possible through IaC but useless while Neon is down | Unchanged until recovery. RPO: Neon point-in-time recovery; RTO: hours (V1) |
| Poison message or bug | DLQ + alarm; the job's lease expires; the sweeper retries, and after a bounded number of recovery attempts the job fails | FAILED `INTERNAL` |

## 16. The outbox

- **Brain does not depend on the existing outbox drain.**
  - Dispatch uses Brain's own command table, the doorbell and the sweeper.
  - Completion is recorded as Brain events in Neon, and in-app Activity reads them at query time.
- **What does depend on the drain:** anything **delivered** to other modules or people, such as email
  notifications, cross-module subscribers and a Work OS subscriber. **The outbox repair is a
  prerequisite** for those (B8) and must not be assumed working. B3 does not repair it.

## 17. Stored control plane

- **Where controls live.** `ai_controls` in Neon (built with persistence):
  - an append-only log of scope (GLOBAL, ORGANIZATION, TASK, PROVIDER, MODEL), value and state
    (ACTIVE or KILLED);
  - each entry records reason, actor, time and version;
  - a current projection sits on top.
- **Who may change them:**
  - **GLOBAL, PROVIDER and MODEL** are platform-operator controls. In V1 they change through a
    reviewed operations script run by `workflow_dispatch` with typed confirmation, the same pattern
    as migrations, because Loop has no platform-operator role.
  - **ORGANIZATION**, and TASK within an organization, can be changed by that organization's OWNER
    or ADMIN through an IAM permission (decision needed).
- **How AWS sees changes quickly:**
  - the worker and dispatcher read the current projection at every boundary with a cache of 5 s or
    less, so changes apply within seconds and need no deploy;
  - the sweeper turns a GLOBAL or PROVIDER kill into cancels at the next boundary.
- **Floors that remain:**
  - `LOOP_AI_ENABLED` on Netlify;
  - `BRAIN_WORKER_ENABLED` in the Lambda environment (a configuration update, not a deploy);
  - an **AWS break-glass**: set the worker's reserved concurrency to 0 and disable the queue event
    source mappings. It is instant, needs no deploy, and uses a console role.
- **Until the stored controls exist,** the environment switches remain the OFF mechanism.

## 18. Observability (no prompts, responses, secrets or unnecessary personal data)

- **Operator view (Loop read model).** Per job:
  - state and current semantic step (key, kind, label);
  - attempts per step;
  - provider and model per call (requested and served);
  - routing, specialization and template versions;
  - latency per step and per call;
  - reported and estimated tokens, and estimated and actual cost with its price-list version;
  - the fallback path (`fellBackFrom` and reason);
  - failure class and end reason;
  - checkpoint age and lease holder or expiry;
  - the waiting state and expiry;
  - cancel request (actor and reason);
  - time from acceptance to dispatch;
  - queue age.
  - **No percentage**, except a fraction from a fixed plan.
- **Metrics** (CloudWatch embedded metric format), with job and step counts by state, reason, task
  and provider. **No organization or job dimension**, to avoid cardinality and cost blow-up. They
  include:
  - step duration;
  - provider latency;
  - tokens and estimated cost;
  - fallbacks and abandoned paid calls;
  - lease takeovers;
  - ring outcomes;
  - authorizer rejections;
  - route-gate refusals.
- **Logs.** Structured, with ids only (job, step, call key, command, `jti`, organization id), and
  30-day retention. Prompts, responses, context and replies are never logged.
- **Traces.** X-Ray, sampled, with id annotations only.
- **Alarms:**
  - any DLQ depth above 0;
  - oldest queue message older than 2 min (interactive) or 10 min (durable);
  - abandoned paid calls above 0;
  - worker error rate;
  - authorizer 4xx spike;
  - sweeper failures;
  - budget refusals spike;
  - AWS Budgets and Cost Anomaly Detection.

## 19. Region, accounts, environments, naming, tagging, IAM

- **Region: `us-east-1`.**
  - It is where production Neon runs (verified).
  - The providers' APIs are US-hosted, and Loop's users are US businesses.
  - Every service chosen here exists in us-east-1.
- **Netlify function region.** Confirm in the Netlify UI, and align functions to `iad` (us-east-1)
  if the plan allows. That is a Matt decision; B3 changes nothing.
- **Accounts** (AWS Organizations, IAM Identity Center, no IAM users):
  - **management** (billing, identity);
  - `loop-brain-staging`;
  - `loop-brain-prod`;
  - optionally `loop-brain-dev` later. Development runs the in-process runner locally.
- **Environments.** Staging uses a separate Neon branch or project and separate provider keys and
  workspaces.
- **Naming:** `loop-brain-<env>-<component>` (e.g. `loop-brain-prod-worker`,
  `loop-brain-prod-interactive-queue`).
- **Tags:** `app=loop`, `component=brain`, `env=<env>`, `owner=<team>`,
  `data-class=operational`, `managed-by=iac`.
- **IAM:**
  - **one role per function**, with the permissions in §4 only;
  - the deploy role comes from GitHub OIDC (repository and environment pinned), with a permissions
    boundary;
  - service control policies restrict regions, and deny leaving the organization, root actions,
    IAM user and access-key creation, CloudTrail tampering, and KMS key deletion outside
    break-glass.

## 20. Infrastructure as code

| | **AWS CDK, TypeScript (recommended)** | Terraform / OpenTofu | SST | SAM |
|---|---|---|---|---|
| Language | TypeScript, like the repo | HCL (new to the team) | TypeScript | YAML |
| State | CloudFormation (managed, rollback) | A state backend to run | Its own state store | CloudFormation |
| Fit for Lambda + SQS + API Gateway + Scheduler + KMS + DynamoDB | Good, higher-level constructs | Good | Good, opinionated | Lambda-centric |
| Third-party platform dependency | None | None (OpenTofu) | Yes | None |
| Drift and rollback | CloudFormation | Plan/apply | Varies | CloudFormation |

**Recommendation: CDK in TypeScript,** in an `infra/brain` workspace (B6), deployed from GitHub
Actions through OIDC, with a manual approval for production. This is Charlie's decision; nothing is
installed.

## 21. Cost model (us-east-1 list prices, read 2026-09-16)

**Prices used.**

| Service | Price | Source |
|---|---|---|
| Lambda | $0.20 per 1M requests; Arm $0.0000133334 per GB-s. **Always free:** 1M requests and 400,000 GB-s per month | aws.amazon.com/lambda/pricing, aws.amazon.com/free/serverless |
| SQS standard | $0.40 per 1M requests, where every action counts and each 64 KB chunk is one request. **Always free:** 1M per month | aws.amazon.com/sqs/pricing (free tier); the $0.40 rate appears in an AWS Solutions cost table and the 2016 launch post, because the pricing table did not render |
| API Gateway HTTP API | $1.00 per 1M requests (first 300M) | aws.amazon.com/api-gateway/pricing |
| EventBridge Scheduler | 14M invocations per month free, then $1.00 per 1M | aws.amazon.com/eventbridge/pricing |
| DynamoDB on-demand | $0.625 per 1M writes; $0.125 per 1M reads; $0.25 per GB-month. TTL deletes consume no write throughput | aws.amazon.com/dynamodb/pricing/on-demand; the TTL developer guide |
| KMS | $1 per key per month; symmetric requests $0.03 per 10k (20k per month free); **ECC P-256 Sign $0.15 per 10k (not in the free tier)** | aws.amazon.com/kms/pricing |
| Secrets Manager | $0.40 per secret per month; $0.05 per 10k API calls | aws.amazon.com/secrets-manager/pricing |
| Parameter Store | Standard parameters and standard-throughput API calls: no charge | aws.amazon.com/systems-manager/pricing |
| CloudWatch | Custom metrics $0.30 each (first 10k); logs $0.50 per GB ingested and $0.03 per GB-month; standard alarm $0.10. **Free:** 10 metrics, 10 alarms, 5 GB of logs. Metrics written in the embedded format are billed as custom metrics | aws.amazon.com/cloudwatch/pricing |
| X-Ray | $5 per 1M traces recorded | aws.amazon.com/xray/pricing (as read by the B0 research) |
| Data transfer out | 100 GB per month free across services; then $0.09 per GB | aws.amazon.com/ec2/pricing/on-demand |

**Job shape assumed** (a V1 mix of Case-Explanation-like and small durable jobs):
- **Steps and provider calls:** 6 steps; 1.5 provider calls averaging 18 s each.
- **Worker time:** about 30 GB-s at 1,024 MB Arm. **The worker is billed while it waits on the
  provider.**
- **Invocations:** 8.4 per job (worker 6, authorizer 1.2, dispatcher 1.2).
- **Queue:** 18 SQS requests.
- **Doorbell:** 1.2 rings and 1.2 DynamoDB writes.
- **Worker → Loop:** 3 signed calls.
- **Logs:** 5 KB.
- **Transfer:** about 45 KB out to providers.

**Baselines and fixed costs:**
- **Queue polling:** the event source mappings long-poll even at zero traffic, estimated at up to
  about 1M SQS requests a month for two queues (inferred: AWS documents the poller count, not the
  call rate).
- **Sweeper:** 43,800 invocations a month.
- **Fixed per environment:** 2 KMS keys ($2), 5 secrets ($2), about 25 metric series (about $4.50),
  about 12 alarms (about $0.20). That is **about $8–10 per month per environment account**.

| Usage (production) | AWS infrastructure / month | Largest AWS item | Model tokens / month (≈$0.05–0.30 per job) |
|---|---|---|---|
| Near zero (~10 jobs) | **≈ $8–10** (almost all fixed) | KMS keys, secrets, custom metrics | < $5 |
| 100 jobs/day (3k) | **≈ $9–11**: Lambda and SQS inside the free tier | Fixed costs | $150–900 |
| 1,000 jobs/day (30k) | **≈ $17–20**: Lambda duration ≈ $6.70, KMS signing ≈ $1.35, SQS ≈ $0.22 | Lambda time spent waiting on providers | $1.5k–9k |
| 10,000 jobs/day (300k) | **≈ $140–150**: Lambda duration ≈ $115, KMS signing ≈ $13.50, SQS ≈ $2.20, X-Ray (5% sampled) ≈ $0.60, API Gateway + DynamoDB + Lambda requests ≈ $0.90 | Lambda time spent waiting on providers (~80%) | $15k–90k |

- **Staging:** add about $8–10 per month.
- **Model tokens dominate** at every real scale; AWS infrastructure stays around 1% or less of model
  spend from 1,000 jobs a day.
- **Model price basis:** Claude Opus 5 at $5 / $25 per MTok (and GPT-6 Astra at $10 / $50 when a
  fallback serves), from each provider's pricing page on 2026-09-16. About 4k input and 1.5k output
  tokens per call is assumed.

**Costs outside AWS, to watch:**
- **Netlify.** Status polling and the internal Brain API are Netlify function requests: 2 credits per
  10k web requests plus 10 credits per GB-hour of compute (Netlify credit-based plans).
  - At 10,000 jobs a day with about 20 polls, 1 submit and 3 internal calls per job, that is about
    7.2M requests a month, **on the order of thousands of credits**.
  - This makes polling with backoff (and later push) a real cost lever. **To measure before B7.**
- **Neon.** The one-minute sweeper queries Neon continuously, which can keep a staging compute awake.
  Run staging's sweeper less often.
- **Levers if Lambda duration grows:** lower worker memory for model steps, or move very long calls
  to ECS Fargate or a provider batch API (a privacy decision).

## 22. Threat model

| Threat | Trust boundary | Prevention | Detection | Containment / recovery |
|---|---|---|---|---|
| Forged doorbell | Internet → API Gateway | ES256 token with pinned keys; the authorizer's role has no data access | Authorizer 4xx metric | Throttling; rotate `kid` |
| Replay | Internet → API Gateway | ≤120 s tokens; `jti` ledger; idempotent commands | Replay counter | Harmless by design |
| Cross-organization substitution | Browser → Netlify; ring → AWS; worker → Loop | The organization comes only from the session or the job; `parseBrainSubmission` and the ring and worker checks refuse authority fields | Refusal logs | Nothing to contain: a request cannot name another organization |
| Stale authorization | Job lifetime | `brainBoundaryRefusals` (≤30 s decision) at every model call and commit; reply re-check | `ACCESS_WITHDRAWN` count | The job fails at the next boundary |
| Credential theft (provider) | AWS account | Only the worker role may read; KMS; CloudTrail | CloudTrail anomalies; provider spend alerts | Rotate the key; provider spend limits; kill switch |
| Credential theft (doorbell key) | Netlify | Secret environment variable in production context | Unusual ring rate or `sub` | Rotate `kid`; blast radius is "look again" only |
| Credential theft (worker signing) | AWS account | Non-exportable KMS key | CloudTrail `Sign` calls | Disable the key; Loop trusts a `kid` list |
| Prompt injection | Source content → model | Escaped source rendering; no tools; the instructions treat sources as data; whole-answer validation | Rejection metrics | The answer is refused whole |
| Malicious source content | Product data → context | Context minimization; trust levels; `MODEL_OUTPUT_CITED_AS_FACT` | Commit refusals | The result is refused |
| Duplicate delivery | Queue → worker | Lease; checkpoint first; unique keys | Lease-takeover and duplicate metrics | Harmless |
| Result tampering | Worker → Loop commit | Body-hash-bound worker token; `brainCommitRefusals` on the Loop side before the owner's gate | Commit refusals | Refused |
| Log leakage | Everywhere | Ids-only logging; no content fields; 30-day retention; KMS-encrypted log groups | Log-scan test in CI (B6) | Purge the log group |
| Compromised worker | AWS | The role cannot read product tables or write artifacts directly; every product action goes through Loop, which re-authorizes | CloudTrail and API refusal spikes | Reserved concurrency 0; revoke the database role; rotate secrets |
| Runaway cost | Provider spend | Serializable budget reservation; per-job paid-attempt limit; queue concurrency caps; provider spend limits; AWS Budgets | Budget refusals; cost anomaly alerts | Kill switch; break-glass |
| Provider outage | Loop → provider | Governed fallback; circuit via failure classes | Provider error metrics | A PROVIDER kill; jobs fail by name, never silently |

## 23. Run-time routing conformance

- **Where it is enforced:** at two points, both using the same pure `brainRouteGate`.
  1. **Acceptance (Netlify).** A task whose current routing does not conform is refused before any
     job exists.
  2. **Every model step (worker), before the ledger reservation.** The executor may run a later
     deployment than the one that accepted the job. A refusal ends the job as FAILED
     `ROUTING_NOT_CONFORMANT`.
- **Why not in the existing Netlify gateway:** it is OFF and will be retired.
- **Why not per request in the provider adapters:** adapters must not know policy.
- **Production routing is unchanged.**

## 24. Unresolved decisions

**The DRAFT result type: DECIDED after B3** (Matt and Charlie, 2026-09-16; contracts in B3.1).
- **The decision** is option 3 below: DRAFT is a sixth result type for content a person reviews and
  uses, and PROPOSED_ACTION remains the only way to ask Loop to act (sending included).
- **How the contracts hold it** (`brain-execution-architecture.md` §5):
  - a DRAFT is NON_AUTHORITATIVE by type;
  - it is held by Communications on a customer conversation;
  - it can never reach the approval path;
  - a draft job cannot commit a send proposal;
  - a later send proposal cites the draft only as untrusted input, with its own job and approval.
- **What this changes in the AWS design:** nothing structural.
  - A draft is committed through the same internal COMMIT_RESULT call as any result.
  - No AWS component gains a send capability.
  - The worker's role still cannot write product tables.
- **Still open for Charlie, Lexi and Product:**
  - drafts about other subjects;
  - whether draft text may show while it is written;
  - the draft store itself, which is built with the first communication task.

| Option (as offered in B3) | What it meant | Outcome |
|---|---|---|
| 1. Add a DRAFT result type | Owned by a Communications authority; NON_AUTHORITATIVE; sending is a separate act | Taken, as part of 3 |
| 2. Drafts are the payload of a PROPOSED_ACTION | Every draft an approval item | Not taken |
| 3. Both: DRAFT for working text, PROPOSED_ACTION when someone asks to send | Two paths with a clear hand-off | **Chosen** |
| 4. Defer communication tasks | No COMMUNICATION task ships | Not needed |

**For Matt:**
- the Netlify function region (align to `iad`?);
- the executor revision in §7 (C instead of A);
- the Neon worker roles and the grants process;
- the account structure;
- who may flip platform controls (§17);
- whether the Case Explanation result is persisted (history) or stays ephemeral;
- provisioned concurrency for interactive work if cold starts miss the budget;
- whether email notifications wait for the outbox repair;
- the effort choice and the first live request venue (still open).

**For Charlie:** the IaC tool (§20) and the operations runbook.

**For Charlie and Lexi:** the experience items in `docs/product/ui-track-handoff.md`, and the
remaining draft questions above.

## 25. Sequence after B3

| Step | Scope | Migration |
|---|---|---|
| **B4** | Brain persistence (detail below). **Built; see `brain-persistence.md`.** | one additive migration (`20260919000000_brain_durable_persistence`), **not dispatched** |
| B5 | Loop side: the Brain API (submit, status, respond, cancel), the internal Brain API (access, context, commit), ring signing, worker-token verification, stored-control reads, the in-process step runner for tests and development, and retirement of `/api/brain/call-handling-briefing` | none |
| B6 | AWS foundation in staging, **off**: CDK; the authorizer, dispatcher, worker, sweeper, queues and DLQs; DynamoDB; KMS; Secrets Manager; SSM parameters; alarms; budgets; GitHub OIDC deploys. **Second deployable: needs approval.** | none |
| B7 | Case Explanation on AWS in staging: the two-phase panel; the first live request on a synthetic Case with staging keys (only after the effort decision). Then production, and removal of Netlify's provider keys. | none |
| B8 | The first DURABLE task, its owned artifact and interface; the outbox repair (prerequisite) and notifications; ECS long steps only if needed | artifact migration |

**B4 in detail (revised in B3.1; built in B4 as `brain-persistence.md` records, which is now the
authority on the exact tables, columns, keys and checks).**
- **`brain_jobs`.** Each of the four declarations is its own column, fixed at acceptance unless
  marked:
  - what the work needs: `capabilityRoute`;
  - what it produces and who holds it: `resultType`, `resultOwnerAuthority`, `resultSubjectType`,
    `resultSubjectId`;
  - how it runs: `executionClass` (changed only by promotion), plus `promotedAt`.
  - **No provider, model, fallback or routing column.** Those are chosen per call and recorded on
    `ai_invocations`.
  - The rest of the row:
    - organization and principal (both foreign keys), task id and version;
    - state, generation, `version` (optimistic), lease holder and expiry;
    - cancel request (actor, reason, time), end reason;
    - idempotency key and submission fingerprint (unique per organization, principal, task and
      key);
    - `resumesJobId`;
    - accepted, started and ended times, and active elapsed time (excluding waits).
- **`brain_job_transitions`:** sequence, event, from and to state, actor and reason. Unique per job
  and sequence.
- **`brain_job_steps`:** step key, kind, attempt, paid attempts, state, and the checkpoint (input
  fingerprint and encrypted payload). Unique per job and step key, and per checkpoint key.
- **`brain_job_waits`:** question schema and version, minimal question, expiry, status, responder,
  validated reply, answered time. One reply per wait.
- **`brain_commands`:** kind (START, RESUME or CANCEL), generation, issuer, wait id, `dispatchedAt`,
  dispatch count.
- **`brain_events`:** the `BrainJobEvent` allowlist, including `resultType`, with `brainEventId` as
  the unique key.
- **`ai_controls`:** the append-only log and its current projection.
- **`ai_invocations` gains three nullable columns:**
  - `brainJobId` and `brainStepKey`;
  - `specializationPolicyVersion`, beside the existing `routingPolicyVersion`, because conformance is
    decided per call.
  - `profile` keeps holding the capability route.
- **Vocabularies are text columns validated by the shared contracts, not database enums.** Adding
  DRAFT would have needed a migration if they were enums; as text, a new result type, route or owner
  stays a reviewed code change.
- **Also in B4:**
  - organization-first repositories that map rows to `BrainJobSnapshot` and back (round-trip tests,
    including a DRAFT job);
  - the Activity source adapter for Brain events;
  - opt-in Postgres tests;
  - the runbook for the three restricted database roles, applied by an ops script and not by the
    migration.
- **Not in B4:**
  - any result store: no draft store, Communications table or approval-item table;
  - any API, executor, AWS resource, provider call or activation;
  - any change to the routing or specialization policy data.

## 26. Still to verify during build

- Prisma 5.22 through Neon's pooled endpoint in a real staging run. Neon documents PgBouncer 1.22
  prepared-statement support and Prisma ≥ 5.10 compatibility; migrations keep using the direct URL.
- Measured cold-start latency of the worker (Prisma engine plus SDKs) against the presentation
  budget.
- The Netlify function region, and whether `iad` is available on the plan.
- The HTTP API Lambda authorizer's response and caching settings (caching **off**; tokens are
  single-use).
- KMS `Sign` at peak worker concurrency: ECC operations share 1,000 requests per second (adjustable).
  KMS returns DER-encoded ECDSA signatures, which must be converted to the JOSE `R||S` form for ES256.
- The ReceiveMessage rate of idle event source mappings (the cost baseline above is an estimate).

## 27. Sources (all read 2026-09-16)

- **Pricing:** §21.
- **AWS:**
  - Lambda: SQS event source mapping scaling (`services-sqs-scaling`), `with-sqs`, timeout
    configuration, VPC internet access, async error handling, concurrency, and the Parameters and
    Secrets extension (`with-secrets-manager`).
  - SQS: short and long polling; FAQs.
  - DynamoDB: TTL, condition expressions; Powertools for AWS Lambda idempotency (a conditional put
    plus TTL).
  - Parameter Store: throughput, advanced parameters, SecureString KMS encryption, shared parameters.
  - Secrets Manager: rotation (a custom Lambda is needed for third-party keys), CloudTrail entries.
  - CloudTrail: data events.
  - KMS: asymmetric key specs, the Sign API, requests-per-second quotas.
  - STS: `GetCallerIdentity`; the IAM SigV4 reference.
  - API Gateway: HTTP API JWT authorizers (RSA only) and throttling.
  - EventBridge Scheduler: schedule types.
  - CloudWatch: embedded metric format.
- **HashiCorp Vault:** the AWS IAM auth method (the presigned `GetCallerIdentity` pattern).
- **Neon:** connection pooling, roles, the Prisma guide, the Prisma/PgBouncer 1.22 post, Data API
  (open beta), regions.
- **Netlify:** function optional configuration (region: Pro/Enterprise; `iad` available), credit-based
  pricing and how credits work.
- **Earlier on 2026-09-16** (`brain-execution-architecture.md` §15, B0 research): Netlify issues no
  OIDC token; Lambda durable functions limits and behaviour; Step Functions quotas; Fargate; IAM
  Roles Anywhere; Identity Center and Organizations guidance.

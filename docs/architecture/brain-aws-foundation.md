# Brain on AWS — the dark foundation (B6)

**Status: BUILT AND TESTED. NOT DEPLOYED.**
- **What B6 adds:**
  - the Brain execution runtime (`apps/brain-executor`, executor revision `loop-step-runner.r1`);
  - the second deployable (`infra/brain`, AWS CDK), which creates the dark AWS environment;
  - CI for both;
  - a manual, approved deploy workflow;
  - Matt's runbook (`docs/runbooks/brain-aws-staging.md`).
- **What B6 does not do:**
  - no AWS resource exists, and this environment has no AWS credentials;
  - no provider call, no provider secret value, no activation;
  - no migration;
  - no Netlify or Google Cloud change;
  - no production read or write.

**Related records.**
- `brain-execution-infrastructure.md` (B3) is the design.
- `brain-aws-implementation-dossier.md` is the plan; §4 below names where the build differs from it.
- `brain-boundary.md` (B5) is the Loop side these components call.

---

## 1. Starting facts (verified 2026-09-17)

| Fact | Evidence |
|---|---|
| `main` is `12b9951`; #278 (B5), #279 (Google contract) and #280 (UI-0) are on it | every file each PR changed is byte-identical on `main` |
| 36 migrations, the last `20260919000000_brain_durable_persistence`; production is at 36 | migrations directory; run `35160530756` |
| AI is off; no provider request has been made by repository code | no `LOOP_AI_ENABLED` in repository configuration; no provider path is enabled |
| No AWS Brain infrastructure existed | no infrastructure directory, CDK or AWS SDK before this branch |
| This environment has **no** AWS credentials | no AWS CLI, no `AWS_*` variables, no `~/.aws` |
| AWS Lambda supports `nodejs24.x` (deprecation 2028-04-30) | AWS "Lambda runtimes" page, read 2026-09-17; `aws-cdk-lib` 2.269.0 has `Runtime.NODEJS_24_X` |

## 2. The executor revision: `loop-step-runner.r1`

**What it is.** The revision B3 §7 chose instead of the B0 proposal (hosted durable functions):
- a Loop-owned step runner on stateless Lambda workers;
- driven by two SQS queues and a scheduled sweeper;
- with **Neon as the only workflow state**.

`BRAIN_EXECUTOR_REVISION` names it in code, and it changes only by a reviewed PR.

**Dark only.** Revision 1 has one mode, `DARK`.
- It has no model step and no provider client.
- It never commits a result.
- `LIVE` arrives with provider activation (B7) as a new revision.

**The dark plan** (`dark-plan.r1`, `plans.ts`). Every job runs these steps:

| Step | Kind | What it does |
|---|---|---|
| `context.load` | LOAD_CONTEXT | CONTEXT from Loop; keeps only the shape: counts, a manifest hash, and whether a result could be committed |
| `dark.probe` | SYNTHETIC (new kind) | stands where a model call will stand; calls no provider |
| `dark.clarify` | REQUEST_USER_INPUT | only when the task may wait **and** the job's input says `darkAskQuestion: true`; a structured CONFIRM question |
| `commit.result` | COMMIT_RESULT | access re-decided; the job ends FAILED `COMMIT_REFUSED` |

**What Matt asked the executor to support, and where it stands:**

| Required | In revision 1 | Evidence |
|---|---|---|
| Durable job claim | lease via `BrainExecutorStore.claim`; a live lease makes a duplicate delivery `BUSY` | worker tests: held lease, then takeover |
| Authoritative state reread | every delivery resolves the job; every step renews the lease and re-reads the job | `worker.ts drive` |
| Minimized context retrieval | CONTEXT from Loop's internal API (B5 assembler); only the shape is kept | worker tests; `loop-client.ts` |
| Checkpoints | every step output is sealed (AES-256-GCM, key derived from the generated secret) into Loop | crash test: `context.load` not re-run |
| Idempotent steps | `brainStepResumeDecision` before every step; a checkpoint is returned, never recomputed | as above |
| Cancellation | cancel request honoured at the next step boundary; a waiting job stops at once | cancellation tests |
| WAITING_FOR_USER | question opened, lease released, nothing scheduled | waiting tests |
| Resume | a RESUME command with a recorded reply, after access is re-decided; the reply is read from Loop | waiting tests |
| Usage / provenance reconciliation | `reserveCall`/`reconcileCall` exist (B5). **Not exercised: revision 1 makes no call** | B7 (LIVE) must reserve before every model call |
| Candidate result submission | `LoopClient.commit` exists and is tested; **revision 1 never calls it** | §3 |
| Governed commit boundary | access re-decided; then FAILED `COMMIT_REFUSED`, with the reason in the step's failure class | first worker test |
| Failure | failure by name: `ACCESS_WITHDRAWN`, `CONTEXT_UNAVAILABLE`, `RETRIES_EXHAUSTED`, `DEADLINE_EXCEEDED`, `COMMIT_REFUSED`, `INTERNAL` | worker tests |
| Completion | **no job SUCCEEDS in revision 1**: that needs `RESULT_COMMITTED` (§3) | state machine: `NO_RESULT` |
| Duplicate doorbells | replay ledger refuses a reused token; a duplicate command is `ALREADY_DONE`; a duplicate message finds the job terminal or leased | authorizer and duplicate tests |
| Missed doorbells | the sweeper hands commands left undispatched past 15 s to the dispatcher | missed-ring tests (fake and real Postgres) |
| Stored controls | the worker applies the worker switch and every applicable kill (GLOBAL, ORGANIZATION, TASK) at the start and before every step | kill tests |
| Kill behavior | recorded as a POLICY cancel (`worker-switch`, `ai-control:<scope>`), settled at once | kill tests |

**The twelve B2 executor obligations** each have an entry in `BRAIN_EXECUTOR_OBLIGATION_EVIDENCE`, and a
test fails if one is missing.
- `PAID_AT_MOST_ONCE_PER_ATTEMPT` holds trivially: nothing is paid.
- `RESULTS_THROUGH_OWNERS` holds by construction: nothing is committed.

## 3. The governed commit boundary, precisely

**"No owner gate exists" means:**
- `BrainInternalService` hands a result to its owning authority only through a registered
  `BrainResultOwnerGate` for the job's result type, owner and subject type;
- **none is registered.**
- So every commit is refused `OWNER_GATE_UNAVAILABLE`, and no job can reach SUCCEEDED, because the state
  machine requires at least one result reference (`NO_RESULT`).

**B6 does not invent a gate. It separates:**
- **Execution completion.** The execution steps have sealed checkpoints. This is what a dark run
  proves.
- **Governed domain commit.** An owner accepts a result, and the job becomes SUCCEEDED. This is
  impossible today, and revision 1 never attempts it.

**The executor learns it before paying.** B6 adds `commitGate: AVAILABLE | UNAVAILABLE` to Loop's
CONTEXT answer (`BrainInternalService.context`). The dark run records it and names the reason:
- `OWNER_GATE_UNAVAILABLE` when no owner is registered;
- `DARK_MODE_NO_RESULT` when an owner exists but a dark run has nothing to give it.

A LIVE revision must refuse to spend on a job whose commit gate is unavailable.

**What a first gate needs** (for Case Explanation, the first planned live task):
- a Commercial Intelligence store for Case analyses. That is **a migration** plus Matt's decision:
  keep explanations as history, or replace them;
- a gate implementation registered in the web tier's `brainInternal()`.

Neither is in B6.

## 4. What is built

```
Loop (Netlify, unchanged; B5 code, not configured)
  │ POST /v1/doorbell  {commandId} + ES256 ring token (≤60 s)
  ▼
API Gateway HTTP API ── Lambda authorizer (pinned keys · claims · jti → DynamoDB, uncached)
  │
  ▼
dispatcher λ ── Neon as loop_brain_dispatcher (command + job + wait; records the hand-over)
  │  reference {jobId, generation, reason, commandId} → the queue the JOB's class selects
  ▼
SQS interactive ─► worker-interactive λ ┐   (DLQ after 5 receives, each)
SQS durable ─────► worker-durable λ ────┤── Neon as loop_brain_worker
                                        └── Loop internal API (ES256 token signed by KMS)
EventBridge Scheduler (5 min, staging) ─► sweeper λ ── Neon as loop_brain_sweeper (read only)
      lost commands → dispatcher (invoke) · expired waits → TIMER · stale leases → RECOVERY
KMS: data key (secrets, logs) · worker signing key (ECC P-256, sign only)
Secrets Manager: provider placeholders (granted to nobody) · three Neon URLs · checkpoint secret
Parameter Store: doorbell trust · worker switch · AI floor · Loop base URL · worker key label
CloudWatch: 5 log groups (30 days, KMS) · 10 alarms → SNS · embedded metrics
```

| Resource (staging names) | Why it exists |
|---|---|
| API `loop-brain-staging-doorbell`, route `POST /v1/doorbell`, stage throttle 10 rps / burst 20 | the only public entry |
| Lambda `authorizer` (256 MB, 5 s, reserved 5) | verifies a ring before anything with data access runs |
| Lambda `dispatcher` (256 MB, 15 s, reserved 5) | stored command → queued reference; the only writer of a dispatch |
| Lambda `worker-interactive` (1,024 MB, 120 s, reserved 5) and `worker-durable` (1,024 MB, 120 s, reserved 2) | advance jobs; two functions from one bundle so each has its own concurrency and stop switch |
| Lambda `sweeper` (256 MB, 60 s, reserved 1) | recovers lost wakeups |
| SQS `interactive-queue`, `durable-queue` (visibility 720 s) and their DLQs (14 days) | at-least-once delivery, backpressure, dead letters for an operator |
| DynamoDB `ring-replay` (on demand, TTL) | a ring token is accepted once |
| KMS `alias/loop-brain-staging-data` (rotation on) | encrypts secrets and logs |
| KMS `alias/loop-brain-staging-worker-signing` (ECC_NIST_P256, SIGN_VERIFY) | worker request signatures; the private key never leaves KMS |
| 6 secrets (§6) | provider placeholders, three database URLs, the checkpoint secret |
| 7 parameters (§6) | non-secret configuration, all closed by default |
| Scheduler `sweep` (every 5 minutes) | recovery |
| 5 log groups, 10 alarms, SNS `alarms` | observability (§11) |
| Budget (only if a notification address is given) | a monthly cost ceiling |

**Not built:** VPC, NAT, any AWS database, Step Functions, Temporal, ECS, IAM users or access keys,
Lambda function URLs, X-Ray, API access logs.

**Where the build differs from the dossier:**
- **x86_64, not arm64.** `schema.prisma` already targets `rhel-openssl-3.0.x`, so the schema is
  unchanged. The cost difference is about 20% of Lambda compute.
- **Queue encryption is SQS-managed, not the customer key.** Messages carry references only, and this
  avoids a key-policy dependency.
- **The sweeper hands lost commands to the dispatcher by invocation.** The B4 roles let only the
  dispatcher record a dispatch, and the sweeper stays read-only.
- **Staging sweeps every 5 minutes, not every minute** (Neon compute).
- **No X-Ray.** Correlation ids are in logs.
- **No function may read a provider secret in B6.**

## 5. IAM (every role, every action)

| Role | Actions | Resources |
|---|---|---|
| `authorizer-role` | `dynamodb:PutItem`; `ssm:GetParameter(s)`, `ssm:GetParameterHistory`, `ssm:DescribeParameters`; `logs:CreateLogStream`, `logs:PutLogEvents` | the replay table; the three doorbell parameters; its log group |
| `dispatcher-role` | `secretsmanager:GetSecretValue`, `DescribeSecret`; `ssm` read; `sqs:SendMessage`, `GetQueueAttributes`, `GetQueueUrl`; logs | `neon-dispatcher`; trusted issuers and callers; the two work queues; its log group |
| `worker-interactive-role`, `worker-durable-role` | `kms:Sign`; `secretsmanager` read; `ssm` read; `sqs` send; `sqs:ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility` (own queue); logs | the signing key; `neon-worker` and `checkpoint-key`; the four worker parameters; both queues; its log group |
| `sweeper-role` | `secretsmanager` read; `sqs` send; `lambda:InvokeFunction`; logs | `neon-sweeper`; the durable queue; the dispatcher function; its log group |
| Scheduler target role (CDK) | `lambda:InvokeFunction` | the sweeper |

**Encryption and wildcards:**
- **Decryption.** Each role that reads a secret gets `kms:Decrypt` on the data key only through
  Secrets Manager (`kms:ViaService` in the key policy).
- **The account-root statements are CDK's defaults.** They let IAM govern the key: `kms:*` for the
  account on both keys, and use through Secrets Manager for the data key. No other account or
  principal is named.
- **No wildcard action or resource** appears in any IAM policy (a test asserts it).
- **The two key-policy `"*"` resources** mean "this key", as KMS key policies do. The CloudWatch Logs
  statement is conditioned on the Brain log-group ARNs.
- **No managed policies.** Logs are granted per log group instead of through
  `AWSLambdaBasicExecutionRole`.
- **No role can read `anthropic` or `openai`** (a test asserts it).

## 6. Secrets and parameters

| Secret | Initial value | Read by |
|---|---|---|
| `loop/brain/staging/anthropic`, `/openai` | `{"state":"UNSET","placeholder":…}` (generated; not a key) | **nobody** in B6 |
| `loop/brain/staging/neon-worker`, `/neon-dispatcher`, `/neon-sweeper` | same placeholder; Matt writes `{"url":"postgresql://…"}` | the matching role only; an UNSET secret connects nothing |
| `loop/brain/staging/checkpoint-key` | 64 random characters, generated by Secrets Manager | the workers. The 32-byte key is derived with HKDF-SHA256; `keyRef` names the secret version, so rotation keeps old checkpoints readable |

All secrets are encrypted with the data key and **retained** if the stack is deleted. No secret value
appears in the template (tested).

| Parameter (`/loop/brain/staging/…`) | Default | Meaning |
|---|---|---|
| `doorbell/public-keys` | `{}` | pinned ring keys: none, so every ring is refused |
| `doorbell/trusted-issuers`, `doorbell/trusted-callers` | `UNSET` | none trusted |
| `loop/internal-base-url` | `UNSET` | the worker cannot reach Loop |
| `worker/enabled` | `false` | every job is stopped by policy |
| `worker/key-id` | `worker-2026-1` | the label Loop pins for the worker's public key |
| `ai/floor` | off, no kill switches | the worker's own floor; malformed reads as a GLOBAL stop |

**Operational values are changed with `put-parameter --overwrite`.** CloudFormation leaves them alone
unless a default in `BRAIN_PARAMETER_DEFAULTS` changes, which is a reviewed act that resets the value
on deploy.

## 7. Loop → AWS trust (the doorbell)

**Built on the AWS side** (`doorbell-authorizer.ts`, `dispatcher.ts`; the specification is
`brain-boundary.md` §7). An HTTP API authorizer (payload 2.0, simple responses, **no caching**):
1. verifies ES256 against the pinned keys;
2. applies `brainDoorbellCheck`'s claim rules;
3. refuses any claim outside the seven;
4. only then records the `jti` once.

The dispatcher re-checks the claims **with the body** (exactly `{commandId}`, 1 KiB or less), reads the
command and its job, and acts only on EXECUTE.

**Tested:**
- duplicate rings (replay refused);
- expired, not-yet-valid and over-long tokens;
- invalid and unpinned signatures;
- malformed and authority-bearing bodies;
- wrong audience, scope, issuer or caller;
- unconfigured trust;
- refused tokens never occupying the ledger;
- already-completed work (`ALREADY_DONE`);
- missed rings (the sweeper and dispatcher path);
- Loop's real ring token accepted by the runtime's authorizer (web suite).

No AWS credential is in Netlify: the ring is signed with a key only the Loop deployment holds.

## 8. AWS → Loop trust (worker requests)

**The token.** Each call to Loop's internal API carries an ES256 token signed by the KMS key, which
returns DER that the runtime converts to R‖S. The token:
- names the worker;
- uses audience `loop-brain-internal`;
- lives 60 s;
- binds the job, its generation, the purpose and the SHA-256 of the exact body.

**How Loop verifies it.** Loop checks the token against the pinned public key, loads **that** job, and
answers for its organization and principal only.

| Case | Result | Where tested |
|---|---|---|
| wrong audience, issuer or worker | 403 | web boundary suite; compatibility test (`CALLER_NOT_TRUSTED`) |
| expired, or lifetime too long | 403 | web boundary suite |
| wrong job / generation | 403 `JOB_NOT_FOUND` / `GENERATION_MISMATCH` | compatibility test |
| wrong organization | not expressible: the token carries no organization; Loop takes it from the job | web boundary suite (claims naming another organization are ignored) |
| invalid or unpinned signature | 401; the worker fails the step as a trust fault (`LOOP_REFUSED_401`), never a blind retry | executor worker test |
| body swapped | 403 `BODY_MISMATCH` | compatibility test |
| unauthorized operation | 403 `PURPOSE_MISMATCH` / `JOB_STATE_REFUSES_PURPOSE` | web boundary suite |
| replay | reads are harmless; commits are keyed by `brainResultCommitKey`; tokens live 60 s. No worker-token ledger (as B3 §5.3 decided) | — |

## 9. Staging Neon

**Not a branch of production.** A Neon branch is a copy of production data, so dark tests on it would
read production content.

**The procedure** (Matt; runbook part 4):
1. a **new Neon project** in AWS us-east-1;
2. `prisma migrate deploy` with its direct URL (36 migrations);
3. the roles script;
4. three pooled role URLs written into the three secrets.

**Current status:** not created. Claude has no Neon access.

**Staging Loop.** Staging also needs a Loop deployment wired to that database, so the worker's internal
API calls reach staging data. For example, a Netlify branch deploy with the staging `DATABASE_URL` and
the worker-trust variables. **That is a Netlify change and needs its own authorization.**

## 10. Dark executor: status

- **Proven locally, end to end, without a model**, against the in-memory store and against **real
  Postgres 18 with the restricted roles**. The path covered:
  1. submission → command → dispatch → worker → re-read → lease;
  2. steps and checkpoints;
  3. a question → an answer → resume;
  4. cancellation (mid-step and while waiting);
  5. worker-switch and recorded kills;
  6. a lost ring recovered;
  7. an expired question;
  8. a dead worker's lease taken over;
  9. Loop unreachable (bounded retry);
  10. deadlines (promotion or failure);
  11. the commit boundary.
- **No `ai_invocations` row is written.**
- **Not yet proven on AWS.** That needs the deployment (not authorized) plus the staging Neon project
  and staging Loop (§9). The dark tests are in the runbook, part 6.

## 11. Observability

**Logs.** One JSON object per line, built only from an allowlist of fields:
- correlation id, revision, mode, component;
- job, generation, command, message, step (key and kind), attempt;
- state, outcome, refusal and failure codes, end reason;
- queue, delay, duration, token id, caller, organization, wait, count, status, plan version, commit
  gate, call key.

There is **no free-text field**, and unknown fields are dropped and counted. Prompts, replies, context,
model output, tokens and secrets have no key to travel under (tested).

**Metrics.** CloudWatch embedded format (`Loop/Brain`), dimensioned only by component and outcome:
- `DoorbellRefused`;
- `DispatchOutcome`;
- `WorkerOutcome`;
- `SweeperRecovered`, `SweeperTimers`, `SweeperTakeovers`, `SweeperErrors`.

**Alarms** (to SNS; email optional):
- either DLQ above 0;
- oldest message older than 2 minutes (interactive) or 10 minutes (durable);
- errors in any of the five functions;
- more than 20 refused rings in 5 minutes.

**Future provenance and cost** stay where B4 put them: `ai_invocations`, with job, step, call key and
specialization version. The runtime logs the call key.

## 12. Stop, kill and roll back

| Action | Effect | Running work |
|---|---|---|
| `aws ssm put-parameter --name /loop/brain/staging/worker/enabled --value false --overwrite` | within 5 s every job is stopped by policy (`worker-switch`) at its next boundary | a step in flight finishes; the job then ends CANCELLED `KILL_SWITCH` |
| a GLOBAL, ORGANIZATION or platform TASK `KILLED` control in Neon | the same, named `ai-control:<scope>`; Loop refuses new submissions too | same. **A job waiting for a person stops when it is next touched** (an answer or its expiry), not at once |
| `aws lambda put-function-concurrency --function-name loop-brain-staging-worker-interactive --reserved-concurrent-executions 0` (and `-durable`) | no worker runs; messages wait, then reach the DLQ | leases expire; the sweeper re-drives after re-enabling |
| `aws lambda update-event-source-mapping --uuid <id> --no-enabled` | queues stop feeding workers; messages are kept | nothing is lost |
| `aws scheduler update-schedule … --state DISABLED` | no sweeps | lost rings wait |
| empty `doorbell/public-keys` (`{}`) | every ring refused | the sweeper still recovers |
| `aws kms disable-key` on the signing key | Loop refuses every worker request | steps fail by name |
| provider disablement (B7+) | a PROVIDER kill control, and revoking the key at the provider | — |
| `npx cdk destroy LoopBrain-staging` | stateless resources removed; keys, secrets and log groups **retained** (termination protection must be turned off first) | messages are lost; jobs stay in Neon and the sweeper recovers them after a redeploy |
| Neon roles | `REVOKE` / `DROP ROLE` per the roles runbook | the runtime loses all database access |

Nothing in Loop needs reversing: B5 is off without configuration, and B6 adds no migration.

**How revision 1 reads controls, compared with B3 §17:**
- **Kill switches.** Read at every delivery and every step boundary: the worker switch (a parameter
  cached for 5 s, in place of B3's Lambda environment variable, so no configuration update is needed),
  the worker's AI floor (5 s) and the stored controls (read fresh).
- **Activation** (whether AI is enabled for an organization or task) is decided by Loop at
  submission.
  - Revision 1 does not re-decide it: it makes no model call and commits nothing.
  - `RECHECK_AT_BOUNDARIES` requires the LIVE revision to re-decide it before every model call and
    every commit.
  - So **an organization's own task switch-off does not stop a dark job that is already running.**
- **B3 also says the dispatcher refuses killed work and the sweeper turns a GLOBAL kill into
  cancels.** Revision 1 does neither.
  - A killed job is cancelled (`KILL_SWITCH`) by the worker before its first step. The dispatcher's
    role cannot record a cancel, and refusing at dispatch would leave the job ACCEPTED.
  - A waiting job holds no lease and spends nothing, but it stays WAITING until touched.
  - Follow-up (§16): a sweeper pass that sends a RECOVERY message to every non-terminal job while a
    GLOBAL kill applies.

## 13. The outbox

**Brain still does not depend on it.** Neither `apps/brain-executor` nor `infra/brain` references the
outbox or its drain.

**Disposition unchanged:**
- the drain fails because the GitHub secrets `OUTBOX_DRAIN_URL` / `OUTBOX_DRAIN_SECRET` are unset
  (Matt; not repaired here);
- it remains a **B8 prerequisite** (notifications and subscribers).

## 14. Pre-deployment report

| Item | Value |
|---|---|
| Account | `loop-brain-staging`, a new member account under the organization's `Workloads` OU. **It does not exist yet; its account id is unknown.** Never the management account |
| Region | `us-east-1` |
| Stack | `LoopBrain-staging` (termination protection on) |
| Resources | as §4: 5 functions, 4 queues, 1 table, 2 KMS keys (+2 aliases), 6 secrets, 7 parameters, 1 HTTP API (1 route, 1 authorizer, 1 stage, 1 integration), 1 schedule, 5 log groups, 10 alarms, 1 SNS topic, 6 IAM roles with inline policies, 2 Lambda permissions, 4 queue policies, 2 event source mappings, and the CDK bootstrap stack |
| IAM | §5 |
| Secrets | §6: placeholders and a generated checkpoint secret. **No real value is written by the deployment** |
| Estimated baseline cost | about **$5–10 per month idle**: KMS $2, secrets $2.40, alarms free up to 10, the rest within free tiers (sweeper invocations, idle queue polling, logs). Signing costs $0.15 per 10k once workers call Loop. Neon staging compute is separate |
| Network | no VPC. Functions reach AWS APIs, the Neon pooled endpoint (TLS) and Loop (HTTPS) over AWS-managed egress. The only inbound path is the HTTPS doorbell route, behind the authorizer and a throttle |
| Staging Neon | a separate project, not a production branch (§9); not created |
| Rollback | §12 |
| **Proof that no provider call can occur** | (1) no bundle contains a provider client, host or package (bundle test); (2) no role can read a provider secret (stack test); (3) the provider secrets hold placeholders; (4) revision 1 has no model step, and its source imports no provider module (fence test); (5) the worker switch and AI floor default to off |
| Deploy mechanism | `.github/workflows/brain-infra-deploy.yml`: manual, `diff` or `deploy`, typed confirmation, `brain-staging` environment with reviewer, OIDC role. **Not run** |

**Deployment is stopped here** for Matt's account setup (runbook parts 1–3) and his explicit
authorization.

## 15. Changes and findings in B6

**Two recovery gaps, found by the dark tests and fixed:**
1. **A job left RUNNING could be stranded.** A delivery that failed after starting a job released its
   lease, and the redelivered START was dropped as "already done". The job sat RUNNING with no worker.
   The worker now drops only REFUSE dispositions; the lease, state and checkpoints decide the rest.
2. **Stale-lease recovery skipped ACCEPTED jobs.** A worker that died after leasing, but before moving
   the job, left an ACCEPTED job the sweeper never found. `staleLeases` now includes ACCEPTED.

**Contract and API changes:**
- **`SYNTHETIC` step kind** (shared). A dark-verification step with an unpaid, 3-attempt policy. It
  needs no migration, because kinds are text.
- **`commitGate`** in the CONTEXT answer (§3).
- **`executionClass`** in the executor's command lookup, so the dispatcher picks the queue from the
  job.
- **The internal context route** also returns the principal record, for the worker's boundary check.

**Checks added:**
- the web suite has a compatibility test using the real code from both sides;
- CI `brain-infra-ci` runs on PRs; the manual deploy workflow is `brain-infra-deploy`.

**Tooling and dependencies:**
- `infra/brain` is **not an npm workspace**: it has its own lockfile, so the web build never installs
  CDK or the AWS SDK.
- `apps/brain-executor` is a workspace with no external dependencies; the root lockfile gains only its
  link.

## 16. Decisions for Matt

1. **Authorize deployment** after the account setup, and choose the alarm and budget addresses.
2. **Staging Loop.** Wire a Loop deployment to the staging database (a Netlify change).
3. **The first owner gate.** Case Explanation's result store (a migration) and its retention rule.
4. **Recovery attempts are not capped.** A poison message stops at its DLQ, but the sweeper keeps
   re-driving an expired lease. B3 §15 calls for a bounded number of recovery attempts before the job
   fails; it is not yet built. Recommended before B7.
5. **Killed waiting jobs** stop only when next touched (§12). The follow-up is a sweeper pass for
   a GLOBAL kill. Recommended before B7, alongside activation being re-decided at paid boundaries.
6. **The staging sweep interval** (5 minutes), against Neon compute cost.
7. **arm64 later?** It needs a Prisma binary-target change, which is a reviewed schema generator edit.

## 17. Validation

Recorded in the B6 pull request.

# Brain on AWS — implementation dossier (for B6)

> **Implemented as code in B6, not deployed.** What was built, and where it differs from this plan,
> is in `brain-aws-foundation.md` (§4 lists the differences). Matt's steps are in
> `docs/runbooks/brain-aws-staging.md`. This dossier is kept as the plan of record.

**Status: A PLAN. Nothing in it has been created on AWS.**
- No AWS account, organization, identity, role, key, secret, queue, function or API exists.
- No Netlify variable has changed. No provider key has been created or moved.

**What it is for.** It turns the approved design (`brain-execution-infrastructure.md`, B3) and the built
Loop side (`brain-boundary.md`, B5) into the exact build Matt authorizes next. Where B3 and this dossier
differ, the difference is named and the reason given.

**Facts re-read on 2026-09-17:** the Lambda runtime table; the SQS event source mapping guidance;
Lambda maximum-concurrency limits; HTTP API Lambda authorizers; and the AWS Organizations
management-account guidance. Sources are listed in the last section.

---

## A. Account topology

- **Recommendation:** the existing AWS account becomes the **management account only**.
  - **What it does:** billing, AWS Organizations, IAM Identity Center, the organization CloudTrail and
    budgets.
  - **What it never runs:** Brain.
  - **Why:** AWS recommends keeping workloads out of the management account, because service control
    policies do not restrict anyone in it.
- **Workload accounts** are created under a `Workloads` organizational unit:

  | Account | Purpose | When |
  |---|---|---|
  | `loop-brain-staging` | B6 foundation (switched off), dark tests, then B7's first request on a synthetic Case | B6 |
  | `loop-brain-prod` | production Brain | B7, after staging is proven |
  | `loop-brain-dev` | optional; development uses the in-process runner locally | not planned |

- **People sign in through IAM Identity Center.** No IAM users and no access keys, anywhere.
- **Deployments use GitHub OIDC roles** in each workload account.
- **Decision for Matt:** approve this topology. The alternative, one workload account with staging and
  production side by side, is **not** recommended: a staging mistake would share production's blast
  radius and quotas.

## B. Region

- **`us-east-1`** for every Brain resource.
  - Production Neon is `aws-us-east-1` (verified from the migration run log).
  - Netlify functions run in IAD (us-east-1), per Matt's brief. This dossier did not read that setting.
- **IAM Identity Center's home region:** `us-east-1`.
- **A service control policy denies other regions,** except for global services (IAM, Organizations,
  STS, Budgets, CloudFront, Support).

## C. Services (exact list)

| Service | Resource(s) per environment | Why |
|---|---|---|
| API Gateway (HTTP API) | `loop-brain-<env>-doorbell`, route `POST /v1/doorbell`, stage `$default`, throttling | the only public entry |
| Lambda | `-authorizer`, `-dispatcher`, `-worker-interactive`, `-worker-durable`, `-sweeper` | see §D |
| SQS (standard) | `-interactive-queue`, `-durable-queue`, each with a DLQ (`-interactive-dlq`, `-durable-dlq`) | at-least-once delivery, backpressure |
| EventBridge Scheduler | `-sweeper-schedule`, `rate(1 minute)` (staging: `rate(5 minutes)`) | recovery and timers |
| DynamoDB (on-demand) | `-ring-replay` (partition key `jti`, TTL attribute `expiresAt`) | doorbell replay ledger |
| KMS | `alias/loop-brain-<env>-data` (symmetric, rotation on); `alias/loop-brain-<env>-worker-signing` (asymmetric `ECC_NIST_P256`, `SIGN_VERIFY`) | encryption at rest; worker tokens |
| Secrets Manager | `loop/brain/<env>/anthropic`, `/openai`, `/neon-worker`, `/neon-dispatcher`, `/neon-sweeper`, `/checkpoint-key` | §F |
| SSM Parameter Store (standard) | `/loop/brain/<env>/doorbell/public-keys`, `/doorbell/trusted-issuers`, `/doorbell/trusted-callers`, `/loop/internal-base-url`, `/worker/key-id`, `/worker/issuer`, `/worker/enabled` | non-secret configuration |
| CloudWatch | log groups (30 days, KMS), metrics, alarms, one dashboard | §K |
| X-Ray | sampled tracing on the Lambda functions | §K |
| CloudTrail | organization trail (management events), S3 data events off | audit |
| IAM | one execution role per function; the GitHub OIDC provider and deploy role; Identity Center permission sets | §G |
| AWS Budgets, Cost Anomaly Detection | per account | §L |
| AWS CDK bootstrap | the `CDKToolkit` stack (asset bucket, deploy roles) | IaC (B3 §20) |

**Not used:** VPC, NAT gateway, RDS or any AWS database, Step Functions, Lambda durable functions, ECS,
ECR, IAM users, access keys.

**A refinement of B3.** B3 drew one worker function with two queues. This dossier uses **two functions
built from the same artifact**, for three reasons:
- provisioned concurrency can apply to interactive work alone (B3 §9);
- each gets its own alarms;
- a break-glass can stop durable work without stopping interactive work.

## D. The executor

| Setting | Value | Reason |
|---|---|---|
| Runtime | **`nodejs24.x`**, arm64 | supported until 2028-04-30. `nodejs22.x` deprecates on 2027-04-30; `nodejs20.x` is already deprecated. The provider adapters refuse to construct below Node 22 (`AI_MINIMUM_NODE_MAJOR`) |
| CI | the executor package's tests run on Node 24 | the runtime that ships is the one tested |
| Packaging | CDK `NodejsFunction` (esbuild), one bundle per handler, source maps on, provider SDKs bundled | no layers to drift |
| Prisma | the query engine for Lambda arm64 must be in the bundle. `schema.prisma`'s generator `binaryTargets` gains the Lambda target (**to verify in B6**: `linux-arm64-openssl-3.0.x`) | a generator change, **not** a migration |
| Timeout | authorizer 5 s; dispatcher 15 s; workers **120 s**; sweeper 60 s | the worker's timeout covers the longest step (Case Explanation: a 25 s primary plus a 20 s fallback, plus context and commit calls), never a task's budget |
| Memory | workers 1,024 MB; others 256 MB | B3 §21 cost model |
| Queue visibility timeout | **720 s** (6 × 120 s) | AWS: at least six times the function timeout |
| Batch size | 1, with `ReportBatchItemFailures` | one job advance per invocation |
| Concurrency | event source mapping `MaximumConcurrency`: interactive 5, durable 2 (allowed range 2–1,000). Reserved concurrency: workers 5 and 2, dispatcher 5, authorizer 5, sweeper 1 | reserved concurrency must be at least the mappings' total; caps Neon connections |
| Retry | SQS `maxReceiveCount` 5, then DLQ; planned backoff via `brainStepRetryDecision` and a delayed send | AWS: redrive at least 5 |
| Idempotency | Neon identities (B3 §14): the lease, checkpoint first, `brainCallKey`, `brainResultCommitKey` | at-least-once delivery |
| Checkpoints | `AesGcmBrainPayloadSealer` with the key from `loop/brain/<env>/checkpoint-key`. `keyRef` is `secretsmanager:loop/brain/<env>/checkpoint-key:<version-stage>` | envelope encryption, and fits B4's `keyRef` format |
| Cancel | CANCEL command, then the job's cancel flag checked at every boundary and polled every 5 s during a provider call | B3 §8 |
| WAITING_FOR_USER | `waitForUser`, then no message; the RESUME command wakes the job | no compute while waiting |
| Networking | no VPC; TLS to Neon (pooled endpoint), to the providers and to Loop | B3 §12 |
| Logging | JSON, ids only; KMS-encrypted log groups; 30 days | B3 §18 |
| Switch | `/loop/brain/<env>/worker/enabled` = `false` until B7. The worker stops every job by policy while false | an extra floor under stored controls |

**The worker's loop** is B3 §8, using `BrainExecutorStore` (§6.1 of `brain-boundary.md`) and the
internal Brain API (§6.2).

## E. Orchestration: what exists today

| Piece | State |
|---|---|
| Commands, jobs, steps, waits, events, controls in Neon | **built** (B4), migration 36 deployed |
| Submission, status, answers, cancellation, doorbell signing, worker-token verification, internal API | **built** (B5), switched off |
| The executor's persistence surface and a reference executor | **built** (B5); the reference executor runs in tests only |
| The step runner as a deployable (handlers, KMS token signer, sweeper) | **not built**: B6, in `infra/brain` plus an executor package |
| Any AWS resource | **none** |

## F. Secrets

| Secret | Holds | Readable by | Created by | Value entered by |
|---|---|---|---|---|
| `loop/brain/<env>/anthropic` | a **new** Anthropic key from a separate, spend-limited workspace for that environment | worker roles and break-glass only (resource policy) | CDK (empty) | Matt, in the console |
| `loop/brain/<env>/openai` | a **new** OpenAI key from a separate, spend-limited project for that environment | same | CDK (empty) | Matt |
| `loop/brain/<env>/neon-worker` | connection string for `loop_brain_worker` (pooled endpoint, TLS) | worker roles | CDK (empty) | Matt, after running the roles runbook |
| `loop/brain/<env>/neon-dispatcher`, `/neon-sweeper` | the same for their roles | dispatcher and sweeper roles | CDK (empty) | Matt |
| `loop/brain/<env>/checkpoint-key` | 32 random bytes (base64) | worker roles | CDK (generated) | nobody; generated inside AWS |

- **All secrets are encrypted with `alias/loop-brain-<env>-data`.**
- **Reading:** the workers cache secret values in process for 5 minutes or less.
- **Rotation:**
  1. create a new provider key;
  2. write it as a new version;
  3. wait for the cache time;
  4. revoke the old key.
- **The executor's signing key** is the KMS asymmetric key, whose private half never leaves KMS. There
  is no secret to hold.
- **Netlify's existing `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are not moved or copied.** They are
  removed after Case Explanation runs on AWS (B7).
- **Netlify gains** (in B7, not B6):
  - the doorbell signing key (secret, production context only);
  - the non-secret doorbell and worker-trust values (`brain-boundary.md` §7).
- **The doorbell key pair** is generated by Matt on his own machine:

  ```sh
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out doorbell-private.pem
  openssl pkey -in doorbell-private.pem -pubout -out doorbell-public.pem
  ```

  - The private PEM goes only into Netlify, as `LOOP_BRAIN_DOORBELL_SIGNING_KEY`.
  - The public PEM goes into SSM as `/loop/brain/<env>/doorbell/public-keys` (JSON `{kid: PEM}`).
  - The private file is then deleted.
  - **No key is ever pasted into chat, a PR, a log or a file in the repository.**
- **The worker's public key,** for Netlify's `LOOP_BRAIN_WORKER_PUBLIC_KEYS`:

  ```sh
  aws kms get-public-key --key-id alias/loop-brain-<env>-worker-signing --query PublicKey --output text \
    | base64 -d | openssl pkey -pubin -inform DER -outform PEM
  ```

  **KMS returns DER-encoded ECDSA signatures.** The executor's signer converts them to the 64-byte
  R||S form that `verifyEs256` requires.

## G. IAM: least privilege

| Principal | Allowed | Explicitly not |
|---|---|---|
| `-authorizer` role | read the SSM doorbell parameters; `dynamodb:PutItem` on `-ring-replay` (with `attribute_not_exists` in code); write its own logs | Neon, queues, secrets, KMS signing |
| `-dispatcher` role | `secretsmanager:GetSecretValue` on `neon-dispatcher`; `sqs:SendMessage` on the two work queues; `kms:Decrypt` (data key, via Secrets Manager or SQS); logs | provider secrets, the signing key, Loop's internal API |
| `-worker-*` roles | `GetSecretValue` on `anthropic`, `openai`, `neon-worker`, `checkpoint-key`; `kms:Sign` on the signing key (`ECDSA_SHA_256`); `kms:Decrypt` and `kms:GenerateDataKey` on the data key; receive and delete on their own queue; `SendMessage` on both work queues (promotion, continuation); read the SSM worker parameters; logs; X-Ray | other secrets, DynamoDB, IAM, any product table (enforced in Neon too) |
| `-sweeper` role | `GetSecretValue` on `neon-sweeper`; `SendMessage` on the two work queues; logs | provider secrets, signing |
| API Gateway | `lambda:InvokeFunction` on the authorizer and the dispatcher (resource policies scoped to the API) | — |
| GitHub deploy role | assume only from `repo:elitemediagroup1/emgloop-platform:environment:brain-<env>` (audience `sts.amazonaws.com`), CDK deploy roles only, under a permissions boundary | IAM users, access keys, secret values, KMS key deletion |
| Identity Center: `BrainOperator` | read-only on the Brain stack, CloudWatch, queue attributes, DLQ redrive; set a function's reserved concurrency to 0; disable a mapping | secret values, KMS signing, IAM changes |
| Identity Center: `BrainBreakGlass` | as operator, plus `PutSecretValue`, provider-secret reads, and KMS key disable | used only with a recorded reason; alarms on use |
| Identity Center: `Administrator` | management and account setup | not used for day-to-day Brain operation |

**Service control policies** (organization root and `Workloads` OU). They deny:
- regions other than `us-east-1` (global services excepted);
- `organizations:LeaveOrganization` and `account:CloseAccount`;
- creating IAM users and access keys;
- stopping or deleting CloudTrail;
- scheduling KMS key deletion, except for `BrainBreakGlass`;
- root user actions.

## H. Loop → AWS trust (the doorbell)

The specification is `brain-boundary.md` §7; the Loop side is built.

**B6 builds the receiving side:**
1. **The authorizer** (payload format 2.0, simple responses, **caching off**, identity source
   `$request.header.Authorization`):
   - verifies ES256 against the SSM public keys;
   - applies `brainDoorbellCheck`'s claim rules (issuer, caller, audience, scope, lifetime ≤ 120 s);
   - puts the `jti` into `-ring-replay`, conditionally, with a TTL of `exp` plus skew.

   **An HTTP API authorizer never sees the body.**
2. **The dispatcher** does four things:
   - applies `brainDoorbellCheck`'s body rules (exactly `{commandId}`);
   - calls `BrainExecutorStore.command`;
   - on `EXECUTE`, sends the reference-only advance message and calls `markDispatched`;
   - returns `202`.

**Values Matt will set in Netlify (B7), in the production context only:**
- `LOOP_BRAIN_DOORBELL_URL`: the API's invoke URL plus `/v1/doorbell`;
- `LOOP_BRAIN_DOORBELL_ISSUER`: `loop-web-production`;
- `LOOP_BRAIN_DOORBELL_SUBJECT`: `netlify-emgloop2`;
- `LOOP_BRAIN_DOORBELL_KEY_ID`: `doorbell-2026-1`;
- `LOOP_BRAIN_DOORBELL_SIGNING_KEY`: the private PEM.

**SSM mirrors the non-secret values:**
- `/doorbell/trusted-issuers` = `loop-web-production`;
- `/doorbell/trusted-callers` = `netlify-emgloop2`;
- `/doorbell/public-keys` = `{"doorbell-2026-1": "<public PEM>"}`.

These names are proposals; they only have to match on both sides.

## I. AWS → Loop trust (the worker's requests)

- **Token claims:** `iss` = `loop-brain-<env>`, `sub` = `worker-interactive` or `worker-durable`,
  `aud` = `loop-brain-internal`, a random `jti`, a lifetime of 60 s, `jobId`, `generation`, `purpose`,
  and `bodySha256` of the exact bytes sent.
- **Signing:** KMS `Sign` with `ECDSA_SHA_256`; the DER signature is converted to R||S; the header is
  `{alg: ES256, typ: JWT, kid: <worker key id>}`.
- **Netlify values (B7):**
  - `LOOP_BRAIN_WORKER_ISSUERS` = `loop-brain-prod`;
  - `LOOP_BRAIN_WORKER_SUBJECTS` = `worker-interactive,worker-durable`;
  - `LOOP_BRAIN_WORKER_PUBLIC_KEYS` = `{"worker-2026-1": "<PEM from §F>"}`.
- **Staging's workers call the Loop deployment that fronts staging data.** A Netlify deploy preview or
  branch deploy, wired to the staging Neon branch, needs Matt's decision (§O).
- **Loop's answers** are `brain-boundary.md` §6.2. Worker tokens need no replay ledger: reads are
  harmless, and commits are unique by commit key.

## J. Neon

- **Staging.** A **Neon branch** (or separate project) for staging. Production data is never copied
  into it; the synthetic Case for B7 is created there.
- **Roles.** `loop_brain_worker`, `loop_brain_dispatcher` and `loop_brain_sweeper` are created **by
  SQL**, per environment, following `docs/runbooks/brain-database-roles.md`
  (`scripts/operations/brain-database-roles.sql`), never in the Neon console.
- **Connections:**
  - the pooled endpoint, `sslmode=require`, `connection_limit=1` per Lambda instance;
  - migrations keep using the direct URL through the manual workflow.
- **Grants match `BrainExecutorStore`.** A dark test (§N) proves product tables are unreadable.
- **Later hardening:** IP allowlisting or private networking (Scale plan), with static egress.
- **Still to verify in a real staging run** (B3 §26): Prisma 5.22 through the pooled endpoint.

## K. Observability

- **Metrics** (embedded metric format; no organization or job dimension):
  - ring outcomes and authorizer refusals;
  - dispatch dispositions;
  - lease takeovers;
  - step duration and provider latency;
  - tokens and estimated cost;
  - fallbacks and abandoned paid calls;
  - route-gate refusals;
  - policy stops.
- **Alarms:**
  - any DLQ depth above 0;
  - oldest message older than 2 minutes (interactive) or 10 minutes (durable);
  - worker errors;
  - an authorizer 4xx spike;
  - sweeper failures;
  - abandoned paid calls above 0;
  - budget refusals;
  - any `BrainBreakGlass` sign-in.
- **Logs:** ids only (job, step, call key, command, `jti`, organization id), never content; a CI log-scan
  test in B6.
- **Loop's operator view** stays in Loop, read from Neon (B3 §18).

## L. Cost controls

- **AWS Budgets per workload account.** Staging $25 per month and production $100 per month for
  infrastructure, with alerts at 50%, 80% and 100%.
  - These are proposals; B3 §21 models about $8–20 per month at V1 volumes.
- **Cost Anomaly Detection** is on.
- **Provider spend limits** are set in each provider workspace or project, and are the hard ceiling on
  model spend.
- **Loop's budget policy:** a serializable reservation per call, per-task and per-organization daily
  caps (`budget.2026-09-16.1-proposed`, **values still need Matt's approval**), and a two-paid-attempt
  limit per step.
- **Concurrency caps** (§D) bound both spend rate and Neon connections.
- **Kill paths:** stored controls (seconds); the worker switch; reserved concurrency 0; disabling the
  mappings.

## M. Setup sequence (for the next run, only when authorized)

Console labels change; the setting named is what matters. Every step is recorded in the B6 pull
request.

**In the management account (Matt):**
1. Confirm the root user has MFA and no access keys. Sign in as root only for tasks that require it.
2. **AWS Organizations → Create an organization** (all features). Create OU `Workloads`.
3. **IAM Identity Center → Enable,** home region `us-east-1`, identity source "Identity Center
   directory". Create Matt's user with MFA required.
4. **Create permission sets:** `Administrator`, `BrainOperator`, `BrainBreakGlass` (§G). Session
   duration 1–4 hours.
5. **AWS Organizations → Add an AWS account → Create:** `loop-brain-staging` under `Workloads`, with a
   distinct email address Matt controls. Assign Matt `Administrator` in it.
6. **Policies → Service control policies → Enable,** then create and attach the SCPs in §G. Check that
   the leave and close protection is present, since organizations created in the console after
   2026-07-10 receive it automatically.
7. **CloudTrail → Create trail:** an organization trail, all regions, management events, log file
   validation, KMS encryption.
8. **Billing → Budgets:** an organization budget, plus Cost Anomaly Detection.

**In `loop-brain-staging` (Matt, through Identity Center):**
9. **IAM → Identity providers → Add:** OpenID Connect, URL
   `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
10. **IAM → Roles → Create** `loop-brain-staging-deploy`:
    - trust: that provider, with conditions `aud = sts.amazonaws.com` and
      `sub = repo:elitemediagroup1/emgloop-platform:environment:brain-staging`;
    - a permissions boundary;
    - permission to assume the CDK bootstrap roles only.
11. **GitHub → Settings → Environments → New:** `brain-staging`, with required reviewer Matt.
12. **CDK bootstrap** (`cdk bootstrap aws://<staging-account-id>/us-east-1`), run once from the B6
    workflow or by Matt with Identity Center credentials.

**Deploy and fill (B6 pull request, then Matt):**
13. **Deploy the B6 stack** through the `brain-staging` workflow, with manual approval. Everything is
    created **switched off**: `/worker/enabled` = `false`, and the provider secrets are empty.
14. **Create the staging Neon branch;** run the roles runbook against it.
15. Put the three Neon connection strings into their secrets (console → Secrets Manager →
    Retrieve / Edit value). **Leave the provider secrets empty.**
16. Generate the doorbell key pair (§F), put the public key into SSM, and keep the private key for the
    staging Loop deployment.
17. Run the dark tests (§N).

**Not in B6:** provider keys; Netlify production changes; `loop-brain-prod`; the first request.

## N. Dark verification tests (no provider, no production)

| # | Test | Expected |
|---|---|---|
| 1 | `POST /v1/doorbell` with no token, a malformed token, `alg: none`, an HS256 token, an unknown `kid`, an expired token | `401`/`403`; the dispatcher is never invoked |
| 2 | The same valid token twice | first accepted, second refused (replay) |
| 3 | A valid token with a body other than `{commandId}` | refused by the dispatcher |
| 4 | A valid ring for an unknown command | `REFUSE COMMAND_NOT_FOUND`, logged; nothing sent |
| 5 | A synthetic staging job, then a ring | dispatched once; the worker leases it; with the worker switch off, the job is stopped by policy (`KILL_SWITCH`) and **no provider secret is read** |
| 6 | The same ring again | `ALREADY_DONE` |
| 7 | A START command with `dispatchedAt = null` and no ring | the sweeper dispatches it within a minute or so (staging: 5) |
| 8 | Connect as `loop_brain_worker` and `SELECT` from `users`, `customers`, `operational_priorities` | permission denied |
| 9 | IAM policy simulator: the authorizer and dispatcher on `GetSecretValue` for the provider secrets | denied |
| 10 | A worker token signed by KMS for the synthetic job, sent to the staging Loop `access` route | `200` with a decision. The same token with the body changed gets `403 BODY_MISMATCH`; one signed by a different key gets `401` |
| 11 | A poison message on the durable queue | five receives, then the DLQ; the alarm fires |
| 12 | Set a worker's reserved concurrency to 0 | processing stops; restoring it resumes from Neon |
| 13 | Scan the log groups for prompt, response, question or reply fields | none |
| 14 | Budgets test notification | received |

## O. The first request (a procedure, NOT executed)

**Prerequisites, each a separate authorization:**
1. B5 merged; B6 merged, deployed and dark-tested.
2. **A Case Explanation result store** (Commercial Intelligence), with its migration and Matt's
   history-or-replace decision. Its owner gate is registered in `BrainInternalService`.
3. **A reviewed operations workflow for recording platform controls** (GLOBAL, TASK
   `case.explanation`, PROVIDER), plus the organization control for the staging organization.
4. **The Anthropic effort decision** (`medium` as reviewed, or `high` as Anthropic suggests for Opus 5),
   and the routing policy version that records it.
5. **New staging provider keys** in spend-limited workspaces, entered by Matt into the staging secrets.
6. **A staging Loop deployment** wired to the staging Neon branch, with the doorbell and worker-trust
   values set in that deployment only.
7. **A synthetic Case** in staging. No production data.

**Procedure:**
1. Record the controls; set the staging Loop floor to that organization and task only; set the worker
   switch on.
2. Submit Case Explanation as an OWNER of the staging organization.
3. Watch the status route, the job's transitions and the ledger row.
4. Confirm:
   - one provider call, reserved then reconciled;
   - a result committed through the owner gate;
   - a Brain Activity item;
   - no content in any log.
5. Switch the worker off again and record the outcome.

**Stop if** anything is refused unexpectedly, any content appears in a log, or any cost differs from
the estimate by more than the budget policy allows.

## P. Rollback

| Layer | Action | Effect |
|---|---|---|
| Stored controls | record GLOBAL `KILLED` | every boundary stops work within seconds |
| Worker switch | `/worker/enabled` = `false` | workers stop jobs by policy |
| Doorbell | unset the Netlify doorbell variables | no rings; the sweeper still recovers |
| Compute | worker reserved concurrency 0; disable the mappings | nothing runs; messages wait or reach the DLQ |
| Provider keys | revoke them in the provider consoles | no call can succeed |
| Signing | disable the KMS signing key | Loop refuses every worker request |
| Stack | `cdk destroy` in staging | resources removed. KMS keys enter a 30-day pending deletion (cancellable); secrets keep their recovery window |
| Neon roles | `REVOKE` and `DROP ROLE`, per the runbook | the executor loses all database access |
| Loop | B5 is off without configuration; no migration to reverse (36 is additive and stays) | — |

## READY FOR AWS: checklist

| # | Item | State |
|---|---|---|
| 1 | Loop-side Brain API: submit, status, answer, cancel | done (B5) |
| 2 | Internal Brain API: access, context, commit, with worker-token verification | done (B5) |
| 3 | Doorbell signing, specified and tested against the receiver's contract | done (B5) |
| 4 | Stored controls enforced at submission and available to the executor | done (B5) |
| 5 | Executor persistence surface and reference executor | done (B5) |
| 6 | Checkpoint sealer usable with an AWS-held key | done (B5) |
| 7 | Migration 36 deployed; no migration needed for B6 | done |
| 8 | Restricted Neon roles script and runbook | done (B4); applied nowhere |
| 9 | B5 pull request merged | **pending: Matt** |
| 10 | Account topology approved (management only, plus `loop-brain-staging`) | **pending: Matt** |
| 11 | Second deployable and IaC tool approved (CDK in TypeScript, `infra/brain`) | **pending: Matt and Charlie** |
| 12 | Executor revision (B3 §7 C) and the two-function refinement approved | **pending: Matt** |
| 13 | Staging Neon branch or project, and the Neon plan | **pending: Matt** |
| 14 | Who may flip platform controls (operations workflow) | **pending: Matt**; needed before the first request, not B6 |
| 15 | Case Explanation result store (migration and retention) | **pending: Matt**; needed before the first request, not B6 |
| 16 | Anthropic effort decision | **pending: Matt**; before the first request |
| 17 | Staging provider workspaces with spend limits | **pending: Matt**; before the first request |
| 18 | Budget values approved | **pending: Matt** |
| 19 | Workflow Node maintenance (`.nvmrc` everywhere, `engines >= 22`) | recommended separate PR; not blocking B6 |
| 20 | Outbox drain secrets | **pending: Matt**; B8 prerequisite, not B6 |

## Sources (read 2026-09-17)

**AWS Lambda:**
- "Lambda runtimes" (supported and deprecated Node.js runtimes and dates);
- "Creating and configuring an Amazon SQS event source mapping" (visibility timeout at least six
  times the function timeout; `maxReceiveCount` at least 5; batch size; partial batch responses);
- "Configuring scaling behavior for SQS event source mappings" (maximum concurrency 2–1,000;
  reserved concurrency at least the mappings' total).

**API Gateway:** "Control access to HTTP APIs with AWS Lambda authorizers" (payload format 2.0, simple
responses, caching and identity sources).

**AWS Organizations:** "Best practices for the management account" (no workloads; SCPs do not apply to
the management account; the leave and close SCP, applied automatically to console-created
organizations after 2026-07-10).

**Earlier (B3 §27):** pricing, KMS, Secrets Manager, Parameter Store, DynamoDB TTL, Neon pooling and
roles, and Netlify function configuration.

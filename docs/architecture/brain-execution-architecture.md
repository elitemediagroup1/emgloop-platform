# Brain execution architecture — decision record

**Status:** the direction was approved by Matt on 2026-09-16. **None of it is built.** Only §2
describes what exists in code today. No AWS resource exists and no Netlify setting has changed.

This record approves architecture only. It does not approve implementation, provisioning or
production use:
- each build step in §12 is its own reviewed pull request;
- nothing here authorizes provisioning AWS, changing Netlify, activating AI, sending production
  data to a provider, or creating or dispatching a migration;
- the trust design in §6 is an approved direction, **subject to implementation review**.

**How it relates to the other records.**
- `loop-ai-runtime.md` (PD-F-08) remains the authority for governance, the intelligence taxonomy,
  context packaging, tools and approval, provenance, and the built activation gates. This record
  changes **where** that runtime executes and how work outlives a request.
- `ai-model-selection.md` remains the authority for which models answer.

---

## 1. The decision, as approved

1. **Netlify** remains Loop's product, its authentication boundary, and the Brain API front door.
2. **Neon** remains authoritative for jobs, commands, checkpoints, controls, provenance and
   governed domain artifacts.
3. **AWS** becomes the execution environment for Brain.
4. **Anthropic and OpenAI calls move to AWS.**
5. **INTERACTIVE and DURABLE** use the same Brain execution architecture.
6. **Inngest is removed** from the plan.
7. **The orchestrator stays behind a Loop-owned port.**
8. **Step Functions, and ultimately Temporal,** remain escalation options, not parallel systems
   today.
9. **No long-lived AWS IAM credentials are stored in Netlify.**
10. **The trust direction** is the Neon command plus a restricted JWT "doorbell" (§6), subject to
    implementation review.
11. **Provider credentials** ultimately live in AWS Secrets Manager, not Netlify.

These product and governance contracts carry over unchanged:
- execution classes;
- semantic result types;
- durable jobs that survive the loss of a browser or session;
- checkpoints and resumability;
- idempotency;
- WAITING_FOR_USER;
- cancellation;
- per-step and per-provider budgets;
- `ai_invocations` provenance;
- authorization re-checked at consequential boundaries;
- kill switches;
- provider-neutral adapters.

AI never establishes truth by itself. Domain authorities own the artifacts. Activity records what
happened; it does not own the artifact.

## 2. What exists today (`main` `7f33d3f`)

- **The built runtime.** AI-1 to AI-5 (#266–#270) built the governed runtime and Case Explanation:
  - gateway, reservation ledger, adapters, model catalog, routing and budget policy;
  - context minimization and validation;
  - a 20-scenario evaluation.
- **Where it runs.** Inside the Netlify-hosted Next.js app, through the server action
  `explainCaseAction`.
- **Credentials and activation.**
  - Provider credentials are read only by `apps/web/src/ai/ai-environment.ts`.
  - Activation is the `LOOP_AI_*` environment gates in `loop-ai-runtime.md` §17.
- **State.** It is switched off. **Zero Anthropic and zero OpenAI requests have been made.**
- **Not built:**
  - Brain job, step, command or control tables;
  - any orchestrator;
  - any AWS account resource;
  - any Brain API beyond that one action.
- **An older route.** `apps/web/src/app/api/brain/call-handling-briefing` is an unlinked,
  deterministic diagnostic from `packages/brain`, and is not this runtime. B4 retires or absorbs
  it, so Brain has one front door.

## 3. Boundary (target)

| Layer | Owns | Never does |
|---|---|---|
| **Netlify** (`apps/web`) | UI, sessions, the first authorization check, the Brain API (start, status, respond, cancel), writing jobs and commands to Neon, the doorbell call, status reads | Call a model provider (once B6 lands); hold AWS credentials; hold provider keys (once B6 lands) |
| **Neon** | Jobs, transitions, step checkpoints, waits, commands (outbox), stored AI controls, `ai_invocations`, governed domain artifacts, domain events | — |
| **AWS** (one workload account per environment) | Executing Brain steps, all provider calls, orchestration state (disposable), command dispatch, sweeping, reconciliation, provider credentials, runtime metrics and alarms | Decide tenancy or authority from its own inputs; become a source of truth |
| **Providers** | Answering one request | Hold Loop state (`store: false`; provider conversation state is never relied on) |

```
Browser ─session─▶ Netlify: Brain API (start · status · respond · cancel)
                      │ authorize → ONE Neon txn: brain_job + brain_command → doorbell (JWT, no content)
                      ▼
AWS: HTTP API (JWT authorizer) → dispatcher ◀── scheduled sweeper
       │ start (async, execution name = job) · resume (callback) · cancel (callback fail / stop)
       ▼
     brain-worker (Lambda durable functions): steps → AI Runtime gateway → adapters → Anthropic / OpenAI
       │ provider keys ◀ Secrets Manager (KMS)          status events → reconciler
       ▼
Neon: jobs · steps/checkpoints · waits · commands · controls · ai_invocations · artifacts · outbox
       ▲ Netlify reads status and results; the browser polls Netlify
```

## 4. Execution classes

- **INTERACTIVE:** the user is present and the work fits within seconds.
- **DURABLE:** background work, with human waits of hours or days.

**Both run on the same AWS worker code.** They differ only in:
- the task's latency budget;
- the worker configuration (a short or long execution timeout);
- what the interface shows;
- DURABLE alone may enter WAITING_FOR_USER.

**Starting a job.** Netlify never holds a request open for a model. It starts the job, returns
`jobId`, and the browser polls status.

**Over budget.** When an interactive job exceeds its latency budget, the work is **not** handed
over or run again, because it is already a durable execution. The interface switches to a
background presentation, and a `PROMOTED` transition is recorded. A task that declares
itself DURABLE-capable may continue as a durable job that reuses its checkpoints.

**Output is shown whole.** A validated result is shown in full, as today. Raw token streaming is
not planned: an answer that breaks its contract is refused whole, so provisional text would show
content Loop may reject. Progress is shown at the step level.

## 5. Semantic result types

Every result carries one envelope:
- `resultType` and `schemaId@version`;
- the subject;
- claims with citations to supplied source refs;
- limitations;
- `authority`: `NON_AUTHORITATIVE` or `PROPOSED`, never established;
- provenance: job, invocations, template, and routing and budget versions, plus the context
  manifest hash.

No numeric confidence is attached.

| Type | What it is | Where it lives | What it can never do |
|---|---|---|---|
| ANSWER | A reply in a Brain conversation | A conversation turn, under a retention policy still to be decided | Assert without citation |
| ANALYSIS | A sectioned explanation of one subject (Case Explanation) | The subject's domain | Replace the facts it explains |
| FINDING | A claim under evaluation | `CaseFindingService`, author MODEL, PROPOSED | Set its own evidence state |
| RECOMMENDATION | Options with rationale | `CaseRecommendationService`, author `MODEL` | Be selected or dismissed by a model |
| PROPOSED_ACTION | A tool, typed input, justification, impact bound and idempotency key | A Decision Engine approval item, once the gaps in `loop-ai-runtime.md` §8 close | Execute |

**The job is not the artifact.**
- Job state belongs to Brain execution.
- A completed result belongs to its domain.
- Activity projects that something happened.

## 6. Trust: how Netlify starts AWS work

**Verified 2026-09-16:** Netlify issues no OIDC or workload identity token, and AWS does not list
it as a shared OIDC provider. Keyless role federation from Netlify is therefore not available.
Some secret must live in Netlify, so the design makes that secret nearly worthless.

1. **Neon is the command authority.** After authorizing the person, Netlify writes the job and a
   `START`, `RESUME` or `CANCEL` command in one transaction. The organization always comes from
   the session.
2. **The doorbell.** `POST /v1/doorbell {commandId}` carries a JWT that lives about 60 seconds.
   - Claims: issuer, audience `loop-brain-doorbell`, subject `netlify-production`, scope
     `brain.dispatch`, and `jti` / `iat` / `exp`.
   - It is signed RS256 with a private key held only in Netlify, in the production context,
     marked secret.
   - An API Gateway HTTP API JWT authorizer rejects bad tokens before any code runs. It accepts
     RSA only, requires `kid`, and caches keys for up to 2 hours.
   - The public keys and discovery document are served from a public HTTPS location managed with
     the infrastructure code.
3. **The dispatcher trusts nothing but "look".** It claims the command from Neon, re-reads the
   job, organization and state, and only then acts:
   - it starts the worker asynchronously, with an execution name derived from the job id;
   - or it completes a callback;
   - or it stops an execution.
4. **A scheduled sweeper** delivers any command whose doorbell was lost. That closes the gap
   between writing to Neon and calling AWS.

**If the key leaks.** An attacker can only make AWS look again at commands already authorized and
written to Neon. They cannot create work, read data, or call any AWS API. Throttling and the
dispatcher's concurrency bound the cost. Rotation is: publish the new public key, switch Netlify,
retire the old key.

**Considered and not chosen:**
- **Long-lived IAM keys** in Netlify (ruled out).
- **Loop as its own OIDC issuer for STS.** A leaked key would yield real AWS credentials.
- **IAM Roles Anywhere.** The private key would still sit in Netlify, and the SDKs do not include
  its `CreateSession` call.
- **A public function URL checked by a shared HMAC.** Every abusive request would still run
  code.

## 7. Credentials and controls

**Provider keys.**
- They live in AWS Secrets Manager in each workload account, encrypted with a customer-managed KMS
  key and readable only by the worker role.
- There is one fenced reader on the AWS side, the counterpart of `ai-environment.ts`.
- They are **new keys created per environment**, in provider workspaces with spend limits. They
  are never copied from Netlify, never pasted in chat, and never stored in GitHub.
- Netlify's existing `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` stay unused and are removed after B6.

**Netlify holds:**
- `DATABASE_URL` (as today);
- the doorbell signing key;
- a deploy-level master switch.

**The worker's database credential** lives in Secrets Manager.

**Controls become stored in Neon.** Two deployables cannot safely share environment variables, so
activation allowlists and kill switches become versioned, audited controls that both sides read.
- Each deployable keeps a master switch as a floor, and both must be on.
- A kill switch then takes effect in seconds, not on the next deploy.
- **Until that is built,** the environment gates in `loop-ai-runtime.md` §17 are the mechanism,
  and they remain OFF.

## 8. Job lifecycle

The states are **QUEUED, RUNNING, WAITING_FOR_USER, COMPLETED, FAILED and CANCELLED.**
- A cancellation request is a field (`cancelRequestedAt`) while a step is in flight, not a state.
- An expired wait is CANCELLED with reason `EXPIRED`.
- Promotion is a transition, not a state.
- Status is a projection of an append-only transitions table (Engineering Principles Rules 1–2).
- Terminal states never change. "Resume" creates a new job linked by `resumesJobId`, which reuses
  valid checkpoints.

| From → To | Trigger | Guard or effect |
|---|---|---|
| QUEUED → RUNNING | The first step starts | Not cancelled; controls on; principal still authorized |
| RUNNING → WAITING_FOR_USER | A question is committed | The question and the state change are one transaction; notification comes after it |
| WAITING_FOR_USER → RUNNING | An authorized, schema-valid reply is stored | Controls on |
| RUNNING → COMPLETED | The governed result is committed | Every COMPLETED job references at least one result |
| RUNNING → FAILED | A non-retryable failure, or retries are exhausted | Typed reason, for example `MODEL_REFUSED`, `OUTPUT_REJECTED`, `PROVIDER_UNAVAILABLE`, `BUDGET_REFUSED`, `AUTHORIZATION_REVOKED`, `PROVIDER_RESULT_LOST`, `INTERNAL` |
| QUEUED, RUNNING or WAITING → CANCELLED | A person, an admin, a kill switch, or expiry | A step already running settles and is reconciled; its result is kept but not applied |

**Every step:**
1. Return the Loop checkpoint `(jobId, stepKey, inputHash)` if one exists.
2. Check for cancellation, the controls, authorization and the job budget.
3. Do the work.
4. Commit the result to Neon.

The organization and the principal always come from Neon, never from the orchestrator's input.

**Model calls:**
- Each provider attempt, primary or fallback, is its own step.
- The ledger call key is `jobId:stepKey:attempt`.
- The reservation happens before dispatch, as today. Reconciliation and the checkpoint commit are
  **one** Neon transaction.
- A long call streams internally. The installed Anthropic SDK refuses non-streaming calls that may
  exceed 10 minutes.

**If a worker dies after a paid call:**
- **It died after the commit.** The replay returns the Loop checkpoint and makes no new call.
- **It died before the commit.** The row stays `IN_FLIGHT`.
  - On retry it is marked abandoned, and its estimate stays counted as spend.
  - A new paid attempt runs only if the step's paid-attempt limit allows. Otherwise the job fails
    with `PROVIDER_RESULT_LOST`.
  - An alarm fires. No loss is silent, and no provider-side de-duplication is relied on.

**WAITING_FOR_USER:**
1. The worker creates a durable callback. The same transaction stores the wait row, with its
   callback id and expiry, and the state change. The callback id never reaches the browser.
2. The person replies in Loop. Netlify authorizes the person, validates the reply, stores it, and
   writes a `RESUME` command.
3. The dispatcher completes the callback with the wait id only, and the worker re-reads the reply
   from Neon.
4. If the callback expires, the job is CANCELLED with reason `EXPIRED`, and a late reply is refused.

**Cancellation:**
- The request is recorded in Neon.
- A waiting job's callback is failed.
- A running job stops at the next step boundary, and an in-flight provider call can be aborted.
- After a grace period, the execution is stopped and any open reservation is reconciled.

## 9. AWS runtime (proposed shape, confirmed at B5 review)

| Service | Role |
|---|---|
| Lambda durable functions (Node 22) | The worker, in two configurations (interactive, durable) from one artifact |
| API Gateway HTTP API + JWT authorizer | The doorbell |
| EventBridge Scheduler | The sweeper |
| EventBridge "Durable Execution Status Change" events | The reconciler, which keeps Neon consistent |
| Secrets Manager + a KMS customer-managed key | Credentials; execution data and checkpoint encryption |
| CloudWatch, X-Ray, CloudTrail, Budgets, Cost Anomaly Detection | Operations and cost safety |
| ECS Fargate | **Only if needed:** steps longer than a Lambda invocation allows |

**Lambda durable functions: facts from AWS documentation read 2026-09-16:**
- **Availability:** generally available since 2025-12-02, starting in US East (Ohio); Node.js 22
  and 24.
- **Timeouts:** each invocation is bounded by the function timeout (at most 15 minutes). An
  execution lasts up to one year, and waiting incurs no duration charge.
- **Steps:** at-least-once per retry by default. `AtMostOncePerRetry` exists; nothing is
  exactly-once.
- **Callbacks** support timeouts and heartbeats.
- **Naming:** an execution name with the same payload returns the existing execution.
- **Versions:** executions stay pinned to the version they started on, and a new SDK major
  version can break executions already in flight. Pin the major version and deploy through
  versions.
- **Hard limits:** 3,000 operations and 100 MB written per execution; 256 KB per checkpointed
  result.
- **KMS:** deleting the key destroys executions and their history, so key deletion is locked down.
- **Testing:** a local test runner, `@aws/durable-execution-sdk-js-testing`, needs no
  credentials.
- **Observability:** the OpenTelemetry plugin is marked experimental.
- **Documentation conflicts:** AWS pages disagree on the maximum execution timeout and the default
  retention period.

**Network and region.**
- The worker runs outside a VPC and reaches Neon's pooler and the providers over the public
  internet with TLS. No NAT gateway is needed.
- IP allowlisting or private networking to Neon would need NAT and Neon's Scale plan; that is later
  hardening.
- **Region:** must equal Neon's region. That region is not recorded in the repository and must be
  confirmed. Netlify's default function region is `cmh` (us-east-2).

## 10. Escalation and non-goals

- **Inngest is removed.** Two orchestrators would be a parallel system.
- **Escalation order:**
  1. chained or child jobs, when an execution nears its operation or storage limit;
  2. Step Functions Standard, if durable functions' maturity or limits fail us;
  3. Temporal Cloud with workers on ECS in the same AWS accounts.

  Neon's job model and the orchestrator port make each of these an adapter change.
- **Calls longer than about 14 minutes** go to a Fargate step completed through a callback. The
  Anthropic Message Batches API is also an option, but it stores jobs and so is outside zero data
  retention (a privacy decision).
- **Not planned:**
  - token streaming for validated result types;
  - provider-side conversation state;
  - any second queue beside the Neon command outbox.

## 11. Security and privacy

- **AWS becomes a subprocessor inside Loop's own account.**
  - One region, enforced by a service control policy.
  - Execution data carries ids, not content, is KMS-encrypted, and has short retention.
  - No prompt or response bodies appear in logs or traces, and log retention is set explicitly.
- **Least privilege.** Each function has its own role. Only the worker reads provider keys, and
  only the dispatcher starts, resumes or stops executions.
- **Tenant isolation is enforced by Loop code.**
  - Organization-first repositories.
  - Jobs re-resolved from Neon.
  - The principal re-authorized at each consequential step.
  - Per-organization admission and budgets in Neon.
  - A concurrency cap on the worker, which also protects Neon's connection pool.
- **New persisted content.** Checkpoint payloads are the first persisted model outputs. They are
  encrypted, organization-scoped, and purged on a schedule still to be decided. This amends the
  "bodies are not persisted" default for checkpoints only; the default still holds everywhere else.

## 12. Implementation sequence (not started)

Each step is a separate draft PR with its own review. No step activates AI.

| Step | Scope | Migration |
|---|---|---|
| B0 | Documentation corrections and this record | none |
| B1 | Schema-only alignment of the seven recorded drift items (`schema-drift-2026-09-16.md`), so the next migration contains only intended changes | none |
| B2 | Pure contracts: execution classes, result envelope, job state machine, step plans and paid-attempt policy, command types, orchestrator port, doorbell token claims, stored-control types | none |
| B3 | Persistence: jobs, transitions, steps and checkpoints, waits, command outbox, stored AI controls, plus job and step references on `ai_invocations` | one additive migration, not dispatched |
| B4 | Brain core; an in-process orchestrator for tests and local development only; the Netlify Brain API; doorbell token issuing; stored-control reads; retirement of the old `/api/brain` route | none |
| B5 | AWS foundation in staging, switched off: the worker, dispatcher, doorbell API, sweeper, reconciler, secret-reader fence, KMS, alarms and budgets; GitHub OIDC deploys. **This adds a second deployable and infrastructure-as-code, which needs explicit approval of layout and tool.** | none |
| B6 | Case Explanation on AWS: a two-phase panel, waits, cancellation, resume, paid-attempt handling. The first live request happens in staging with a synthetic Case and staging keys; production follows, and then Netlify's provider keys are removed. | none |
| B7 | The first DURABLE task, with its domain artifact and interface; outbox events to Activity and notifications (needs the outbox drain working); a Fargate long-step worker only if needed | artifact migration |

## 13. Open decisions

**Matt:**
- the AWS region (it must match Neon's; please confirm Neon's region);
- the account structure and access;
- approval of the second deployable and its layout at B5;
- where the first live request happens (staging with a synthetic Case is recommended);
- new per-environment provider keys, and removal of Netlify's keys after B6;
- retention for checkpoints, execution data and logs;
- budget values, per-job budgets, and the paid-attempt limit;
- a staging database (a Neon branch);
- the Neon plan (public pooler now, or private networking later);
- an AWS support plan;
- still open from PD-F-08: MANAGER as an invoker; Opus 5 vs Fable 5.1; GPT-6 Astra vs GPT-5.6
  Sol.

**Charlie:** the infrastructure-as-code tool (TypeScript CDK is recommended) and ownership of the
AWS runbook.

**Charlie and Lexi:**
- the move-to-background experience and notification channel;
- how a waiting question looks, and its default expiry;
- whether Case explanations keep a history;
- whether any live token streaming is ever wanted;
- how each result type is presented, and conversation retention.

## 14. Open items carried forward — NOT resolved

1. **The outbox drain does not run in production.** Every scheduled "Drain outbox" run since at
   least 2026-09-14 fails because the repository secrets `OUTBOX_DRAIN_URL` and
   `OUTBOX_DRAIN_SECRET` are unset. Nothing delivers `state_change_outbox` events. Brain's
   event and notification step (B7) depends on fixing this.
2. **Schema drift must be aligned before the next migration.** Seven pre-existing differences
   (six index names, one column default) are recorded in `schema-drift-2026-09-16.md`. B1 aligns
   them without a migration; until then, `prisma migrate dev` would try to fold "fixes" into the
   next migration.
3. **Anthropic effort is undecided.** Anthropic's documentation says to start Claude Opus 5 at
   effort `high` and lower it once evaluations show quality holds. The reviewed routing policy
   (`routing.2026-09-16.2`) uses `medium`, which has never been evaluated against the live model.
   This must be settled, ideally with an effort sweep in staging, before the first live request.

## 15. Sources

All were read on 2026-09-16.
- **AWS:**
  - Lambda durable functions: docs.aws.amazon.com/lambda/latest/dg/durable-*.html and
    docs.aws.amazon.com/durable-execution/.
  - Lambda limits, pricing and response streaming.
  - API Gateway HTTP API JWT authorizers and quotas.
  - Step Functions quotas and pricing; Fargate pricing.
  - IAM OIDC providers and AssumeRoleWithWebIdentity; IAM Roles Anywhere.
  - Secrets Manager and KMS pricing; CloudWatch pricing.
  - Organizations, Identity Center and multi-account guidance.
- **Netlify:** functions configuration and API, environment variables, the changelog feed (no
  OIDC), private connectivity.
- **Neon:** regions, connection pooling, the AWS Lambda and Prisma guides, private networking,
  pricing.
- **Anthropic and OpenAI:** as listed in `ai-model-selection.md`.

Where a page did not state a fact (for example, several us-east-2 prices), the design does not rely
on it.

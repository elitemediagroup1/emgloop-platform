# Brain execution architecture — decision record

**Status:** the direction was approved by Matt on 2026-09-16.
- **B2 implemented the provider-independent contracts** as pure code in `packages/shared/src/ai/` (§2).
- **B3 designed the AWS trust, security and infrastructure** in `brain-execution-infrastructure.md`,
  which revises §9's executor. None of it is provisioned.
- **Nothing executes them yet.** No AWS resource exists, no Netlify setting has changed, and AI is not
  activated.
- **Where to look:** §2 separates what exists from what does not; §12 shows each step's status.

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

A separate product decision made the same day, **provider specialization by capability route**, is
recorded in §5a. It is approved, but it is not implemented and does not change today's routing policy.

## 2. What exists today (as of B2)

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
- **Contracts (B2), implemented, pure, and not yet called by anything:**

  | File | Contract |
  |---|---|
  | `capability.ts` | Capability routes, the provider-specialization policy type, routing conformance, and the ledger reader for the capability column |
  | `brain-execution.ts` | Execution classes, the interactive and durable envelopes, and the deadline/promotion decision |
  | `brain-result.ts` | Result types, the ownership table, the result envelope and its commit check, and the Activity event and its check |
  | `brain-job.ts` | Job states and transitions, submission parsing, access and idempotency, and progress |
  | `brain-step.ts` | Step policies, checkpoint and call keys, retry and resume decisions, and fallback provenance |
  | `brain-trust.ts` | The doorbell claim and body check, stored commands and their disposition, and the access re-check at each boundary |
  | `brain-executor.ts` | The executor port and its obligations |
  | `brain-dispatch.ts` (B3) | Commit and event identities, reference-only advance messages, job leases, the step-start deadline and promotion decision, the run-time routing gate, and the check on a worker's requests to Loop |

  The provider-specialization policy data is
  `packages/providers/src/ai/policy/provider-specialization.ts`.
- **Not built:**
  - Brain job, step, command or control tables;
  - any executor or orchestrator adapter;
  - the doorbell endpoint and its token signing or verification;
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
AWS: HTTP API (Lambda authorizer, jti ledger) → dispatcher ─▶ SQS (interactive | durable) ◀── sweeper (1 min)
       ▼                                                                   (B3 design, not built)
     brain-worker (Lambda step runner, lease per job): steps → AI Runtime gateway → adapters → Anthropic / OpenAI
       │ provider keys ◀ Secrets Manager (KMS)     context · access · commit ─▶ Loop internal API (KMS-signed)
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

**Two separate budgets (implemented in B2 as `BrainExecutionContract`).** Neither is a hosting
limit, and the contract names none.
- **Presentation budget.** When it passes, a surface shows the job as working in the background
  (`brainPresentation`). The job itself does not change.
- **Interactive execution deadline.** When it passes (`brainDeadlineDecision`):
  - if the task also supports DURABLE, the same job is **promoted**: a `PROMOTED` transition, its
    completed steps kept, nothing re-run;
  - otherwise the job **fails** with `DEADLINE_EXCEEDED`.
- **Durable envelope.** It carries a whole-job deadline (time spent waiting for a person is not
  counted) and the longest single wait. `null` means the task never asks.

**Case Explanation declares:**
- interactive only;
- a 20 s presentation budget and a 75 s interactive deadline, both proposals for Charlie and Lexi
  to confirm;
- streaming `NONE`.

It is not promotable until a reviewed change adds DURABLE.

**Output is shown whole.** A validated result is shown in full, as today.
- **Streaming options:** `NONE` or `PROGRESS` (named steps).
- **`PROVISIONAL_TEXT`:** allowed only for result types listed in `BRAIN_PROVISIONAL_TEXT_RESULT_TYPES`.
  That list is empty until Product approves one, because an answer that breaks its contract is
  refused whole and provisional text would show content Loop may reject.
- **Progress:** a named step plus a completed count. A fraction is reported only when the plan is
  fixed; there is never an estimated percentage.

## 5. Semantic result types

Every result carries one envelope (`BrainResultEnvelope`, B2):
- `resultType` and `schemaId`;
- organization, subject and **owner**;
- claims with citations to supplied source refs, the sorted union of those refs (`evidenceRefs`), and
  limitations;
- `standing`: `NON_AUTHORITATIVE` or `PROPOSED`, and nothing stronger;
- provenance:
  - the job;
  - every ledger call key;
  - the served models and the model a fallback stood in for;
  - task and template versions;
  - capability route, specialization and routing policy versions;
  - the context manifest hash.

No numeric confidence is attached.

| Type | What it is | Where it lives | What it can never do |
|---|---|---|---|
| ANSWER | A reply in a Brain conversation | A conversation turn, under a retention policy still to be decided | Assert without citation |
| ANALYSIS | A sectioned explanation of one subject (Case Explanation) | The subject's domain | Replace the facts it explains |
| FINDING | A claim under evaluation | `CaseFindingService`, author MODEL, PROPOSED | Set its own evidence state |
| RECOMMENDATION | Options with rationale | `CaseRecommendationService`, author `MODEL` | Be selected or dismissed by a model |
| PROPOSED_ACTION | A tool, typed input, justification, impact bound and idempotency key | A Decision Engine approval item, once the gaps in `loop-ai-runtime.md` §8 close | Execute |

**Ownership rules (`BRAIN_OWNERSHIP_RULES`).**

| Result type | Owner, about | Standing |
|---|---|---|
| ANSWER | Brain conversations, a conversation | NON_AUTHORITATIVE |
| ANALYSIS | Commercial Intelligence (a Case), Relationships (a Relationship), or Campaigns (a Campaign) | NON_AUTHORITATIVE |
| FINDING | Commercial Intelligence, a Case | PROPOSED |
| RECOMMENDATION | Commercial Intelligence, a Case | PROPOSED |
| PROPOSED_ACTION | Decision Engine, a Decision | PROPOSED |

- **Anything else is refused.** Any other pairing is refused, and Activity, Brain execution and a
  model provider can never own a result.
- **The stores behind these paths are not built.**

**The commit check (`brainCommitRefusals`) refuses a result that:**
- crosses organization, job, subject, type or owner;
- claims a standing its rule does not give;
- has an uncited claim or cites evidence Loop did not supply;
- declares evidence refs that differ from what its claims cite;
- is not an ANSWER and has no evidence;
- cites a model's earlier output (a `brain-result:` ref) as a governed fact;
- lacks full provenance.

**Activity events (`BrainJobEvent`).** An event says that a job changed state, who caused it and where
its results now live. Its fields are an allowlist, so an event that carries content, or names a
non-owner, is refused.

**Not yet decided:** where a communication **draft** belongs. The runtime taxonomy has a Draft
artifact, but the five approved result types have no DRAFT.
**The job is not the artifact.**
- Job state belongs to Brain execution.
- A completed result belongs to its domain.
- Activity projects that something happened.

## 5a. Capability routes: provider specialization

**Status:** an approved product decision (Matt and Charlie, 2026-09-16). **Implemented in B2 as contract
and versioned policy data; not activated.** The reviewed routing policy `routing.2026-09-16.2` is
unchanged.

Brain uses **provider specialization**, not one universal primary/fallback order. This is a routing
policy decision. It is **not** a claim that either provider is better in general.

**Three independent dimensions.** Choosing one never implies another.

| Dimension | Values | What it decides |
|---|---|---|
| Execution class | INTERACTIVE, DURABLE (§4) | How the work runs |
| Semantic result class | ANSWER, ANALYSIS, FINDING, RECOMMENDATION, PROPOSED_ACTION (§5) | What it produces and which authority owns it |
| Capability route | COMMUNICATION, TECHNICAL_ANALYSIS, GENERAL_REASONING (extensible later) | Which capability the work needs, and so which provider policy applies |

For example, a DURABLE communication job may use OpenAI, and an INTERACTIVE technical analysis may use
Anthropic.

| Capability route | Covers | Default primary |
|---|---|---|
| **COMMUNICATION** | Work whose main output is language meant for a person: email drafting and rewriting, outreach, follow-ups, client-facing communication, conversational responses, tone and style adaptation, meeting follow-up communication | **OpenAI** |
| **TECHNICAL_ANALYSIS** | Technical reasoning, engineering and code analysis, architecture reasoning, complex investigations, evidence synthesis, diagnostics, and other deeply structured analysis | **Anthropic** |
| **GENERAL_REASONING** | Anything else | **No global default.** Each task's reviewed policy names its provider explicitly. |

**Rules to carry into the implementation:**
- **One route per task.** Each task declares exactly one capability route. The reviewed, versioned
  routing policy (`loop-ai-runtime.md` §5) states each task's primary and fallback. A policy that departs
  from its route's default must say why.
- **Governed fallback.** A fallback happens only on the failure classes the policy allows. It never
  happens because another provider's output is preferred. Every fallback is observable and recorded in
  provenance: which provider was tried first, and the requested and served models.
- **A route names a provider preference, not a model.** Model ids stay in the catalog and the policy,
  and each one is verified against the provider's current official documentation when it is chosen.

**How B2 reconciled the existing `profile`: it is REPLACED.**
- **What `profile` was.** Before B2 a task carried `profile` (EXPLANATION, EXTRACTION, CLASSIFICATION,
  DRAFTING), and the gateway copied it into `ai_invocations.profile`.
  - It was **read by nothing**: not routing, not a template, not the evaluation.
  - It was a declared label answering "what kind of capability does this task need?", the route's
    question, so the two could not coexist.
- **Now:**
  - The task field is `capabilityRoute`.
  - The retired type is deleted.
  - The gateway records the route in the same `ai_invocations.profile` column. The name is kept
    because renaming a column needs a migration, and the column is free text, so no migration was
    needed.
- **Old rows stay readable.** `aiLedgerCapabilityOf` reads a pre-B2 row as `RETIRED_PROFILE` and
  never maps it onto a route it did not record.

**The policy (B2):**
- **Data.** `AI_PROVIDER_SPECIALIZATION_POLICY` (`specialization.2026-09-16.1`) holds the table above
  as data.
- **Departures.** `AiTaskRoutePolicy.providerChoiceReason` is where a routing entry says why it
  departs from its route's preference.
- **Conformance.** `aiRoutingConformance` finds, per task:
  - an unknown route;
  - a missing entry;
  - a task version the entry was not reviewed against;
  - a departure without a reason;
  - a no-default route without a reason;
  - a fallback that duplicates the primary.
- **Enforcement.** The providers test suite requires the shipped routing policy to conform for
  every task. A non-conforming policy cannot land; the runtime does not re-check it on each call yet.

**Case Explanation:**
- Its route is **TECHNICAL_ANALYSIS**: evidence synthesis about an investigation.
- The preferred provider is Anthropic, and the reviewed primary is Claude Opus 5, so it **conforms
  with no change**.
- Its OpenAI fallback is availability behaviour, not a departure.
- No routing change is recommended for it.

**Still open:**
- **The COMMUNICATION models.** Which OpenAI model serves COMMUNICATION, and its governed fallback,
  are chosen and verified against current official documentation when the first communication task
  is defined.
- **Recording the specialization version.** It enters job provenance when persistence exists.

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
   - *(B3 revises this bullet and the two before it: ES256 tokens verified by a Lambda authorizer with
    pinned keys, plus a `jti` replay ledger. See `brain-execution-infrastructure.md` §5.)*
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

**Implemented as contract (B2), not as infrastructure (`brain-trust.ts`):**
- **`brainDoorbellCheck`** checks a verified token's claims and the ring's body:
  - issuer, caller, audience and scope;
  - token id, validity window, and a lifetime of at most 120 s including skew;
  - a body with exactly one `commandId`. Any organization, principal, job or role in the body is
    refused.
- **`brainCommandDisposition`** acts on a stored command only when it and the job agree:
  - same organization and generation;
  - START and RESUME issued by the principal;
  - CANCEL issued by a person or a named policy, never an anonymous system.

  A repeat is acknowledged, not re-run.
- **`brainBoundaryRefusals`** re-decides access against the job at each consequential boundary. The
  decision must be at most 30 s old and cover the same organization, principal and task; the
  principal must be human and active.
- **`BrainRequestIdentities`** keeps caller, principal, organization, access decision, job and
  invocation apart.
- **Not built:** signing, signature verification, key custody, key publication, replay tracking and
  the HTTP endpoint (B3 onward).

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

**Implemented in B2** (`brain-job.ts`, `brain-step.ts`). The states are:

| State | Meaning |
|---|---|
| **ACCEPTED** | Authorized and recorded; not yet handed to an executor |
| **QUEUED** | An executor acknowledged it |
| **RUNNING** | A step has begun |
| **WAITING_FOR_USER** | Paused on a question |
| **SUCCEEDED** | Its result is committed |
| **FAILED** | It ended without its result |
| **CANCELLED** | It was stopped |

- **Changes from B0.** ACCEPTED is new: a job stuck there is a dispatch problem, one stuck in QUEUED a
  capacity problem. SUCCEEDED was COMPLETED. No further state was needed.
- **Cancellation while running.** The request is a field (`cancelRequest`) while a step is in flight,
  not a state. The first request stands.
- **Expiry.** An expired wait is CANCELLED with reason `WAIT_EXPIRED`.
- **No connection events.** No state or event describes a client, a session or a connection, and a
  compile-time guard fails the build if one is added.
- Promotion is a transition, not a state.
- Status is a projection of an append-only transitions table (Engineering Principles Rules 1–2).
- Terminal states never change. "Resume" creates a new job linked by `resumesJobId`, which reuses
  valid checkpoints.

| From → To | Event | Guard or effect |
|---|---|---|
| ACCEPTED → QUEUED | `DISPATCHED` | An executor acknowledged the start |
| QUEUED → RUNNING | `STARTED` | Controls on; principal still permitted (boundary check) |
| ACCEPTED, QUEUED or RUNNING, as INTERACTIVE | `PROMOTED` | Only if the task supports DURABLE, and only once; the job becomes DURABLE, keeps its id and state, and emits `brain.job.promoted` |
| RUNNING → WAITING_FOR_USER | `USER_INPUT_REQUESTED` | DURABLE only; the task must allow waits; refused while a cancel is pending |
| WAITING_FOR_USER → RUNNING | `USER_INPUT_RECEIVED` | The same wait id; the responder is the principal, with access re-checked just now |
| WAITING_FOR_USER → CANCELLED | `WAIT_EXPIRED` | The same wait id; reason `WAIT_EXPIRED` |
| ACCEPTED, QUEUED or WAITING → CANCELLED | `CANCEL_REQUESTED` | Immediate: nothing is in flight |
| RUNNING (stays RUNNING) | `CANCEL_REQUESTED` | Records the request; the first one stands |
| RUNNING → CANCELLED | `CANCEL_SETTLED` | Only after a request; in-flight work was reconciled |
| RUNNING → SUCCEEDED | `RESULT_COMMITTED` | At least one owner's result ref; refused while a cancel is pending (the result is kept, never applied) |
| any live state → FAILED | `FAILED` | Typed reason: `MODEL_REFUSED`, `OUTPUT_REJECTED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RESULT_LOST`, `BUDGET_REFUSED`, `ACCESS_WITHDRAWN`, `CONTEXT_UNAVAILABLE`, `RETRIES_EXHAUSTED`, `DEADLINE_EXCEEDED`, `COMMIT_REFUSED`, `ROUTING_NOT_CONFORMANT` (B3) or `INTERNAL` |

**Submission (implemented).**
- **Parsing.** `parseBrainSubmission` accepts only task, subject, execution class, idempotency key and
  scalar input. An organization, principal or role anywhere in the body, including inside `input`,
  is refused (`CLIENT_SUPPLIED_AUTHORITY`).
- **Who may submit.** `brainSubmissionRefusals` admits only an active, permitted **person**. An AI
  Employee or a service is refused, and anyone not permitted learns only `NOT_PERMITTED`.
- **Idempotency.** An idempotency key is unique per (organization, principal, task). The same request
  returns the existing job; a different request under a used key is refused.
- **Accepted jobs.** `brainAcceptedJob` takes organization and principal only from the submitter.

**Every step:**
1. Return the Loop checkpoint `(jobId, stepKey, inputHash)` if one exists.
2. Check for cancellation, the controls, authorization and the job budget.
3. Do the work.
4. Commit the result to Neon.

The organization and the principal always come from Neon, never from the orchestrator's input.

**Model calls:**
- Each provider attempt, primary or fallback, is its own step.
- The ledger call key is `jobId:stepKey:attempt`, plus `.n` for a fallback target (`brainCallKey`), so
  a real retry is always a new row.
- **Step policies** (`BRAIN_DEFAULT_STEP_POLICIES`) bound retries by failure class and attempts.
  - A model call is **paid**, at most 2 paid attempts; the second exists only to recover a result lost
    after payment.
  - Validation is never retried.
- **Resuming a step** (`brainStepResumeDecision`) looks for its checkpoint **first**.
- **Fallback provenance** (`brainModelStepProvenance`, `brainFallbackRefusals`) always records the
  model a fallback stood in for and why. Nothing may follow a refusal, a rejected answer, an
  authentication failure or an unclassified error.
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

## 9. AWS runtime: designed in B3, not built

**The authoritative design is `brain-execution-infrastructure.md` (B3).** It **revises** the shape
first proposed here in B0.

| B0 proposal | B3 design | Why |
|---|---|---|
| Lambda **durable functions** as the executor | A **Loop step runner on Lambda**, driven by **SQS** (interactive and durable queues, each with a DLQ), with a **one-minute EventBridge Scheduler sweeper** for timers and recovery | Neon already holds job state and checkpoints (B2). A durable engine would be a second state store to reconcile, and it pins in-flight executions to old code during days-long waits. It also adds hard per-execution limits and new-service risk. Durable functions and Step Functions stay valid adapters behind the executor port. |
| API Gateway **native JWT authorizer** (RS256, public discovery document) | API Gateway HTTP API + a **Lambda authorizer with pinned ES256 keys** (from SSM) and a DynamoDB `jti` replay ledger | No public key hosting. The authorizer runs with no data access, and a token can be used only once. |
| The worker runs Loop's repositories against product tables | The worker's **restricted Neon role** covers Brain tables and the ledger only. Context, access decisions and artifact commits go through **Loop's internal Brain API** on Netlify, with **KMS-signed** worker tokens bound to one job, purpose and body. | Authorization and product data stay behind Loop's own code. A compromised worker cannot read product tables. |
| "A reconciler keeps Neon consistent with the engine" | Not needed | Nothing else holds workflow state |
| Region "to confirm" | **us-east-1**, where production Neon runs (verified 2026-09-16) | Co-location with the authority |

**Unchanged:**
- Netlify initiates work, and Neon is the authority.
- Provider keys live only in Secrets Manager, readable only by the worker.
- No long-lived AWS credentials sit in Netlify.
- Durable work never depends on the requester's connection.

## 10. Escalation and non-goals

- **Inngest is removed.** Two orchestrators would be a parallel system.
- **Escalation order (revised in B3):**
  1. more steps or chained jobs in the Loop step runner, which has no per-execution operation limit;
  2. an engine adapter behind the executor port, if a workload needs engine-managed workflows:
     Lambda durable functions or Step Functions Standard;
  3. Temporal Cloud with workers on ECS in the same AWS accounts.

  Neon's job model and the orchestrator port make each of these an adapter change.
- **Calls longer than about 14 minutes** go to a Fargate step completed through a callback. The
  Anthropic Message Batches API is also an option, but it stores jobs and so is outside zero data
  retention (a privacy decision).
- **Not planned:**
  - token streaming for validated result types;
  - provider-side conversation state;
  - any queue that holds job state. The SQS queues carry only references; Neon's command table is
    the source of truth for what should run.

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

## 12. Implementation sequence

Each step is a separate draft PR with its own review. No step activates AI.

| Step | Scope | Migration |
|---|---|---|
| B0 | Documentation corrections and this record. **Merged (#272).** | none |
| B1 | Schema-only alignment of the seven recorded drift items (`schema-drift-2026-09-16.md`), so the next migration contains only intended changes. **Merged (#273).** | none |
| B2 | **Merged (#274).** Pure contracts: execution classes, result envelope, capability routes (reconciled with the existing `profile`, §5a), job state machine, step plans and paid-attempt policy, command types, orchestrator port, doorbell token claims, stored-control types | none |
| B3 | **In review.** AWS trust, security and infrastructure **design** (`brain-execution-infrastructure.md`), plus the pure dispatch contracts (`brain-dispatch.ts`). Nothing is provisioned. | none |
| B4 | Persistence: jobs (with lease and version), transitions, steps and checkpoints, waits and replies, commands, Brain events, stored AI controls, and job and step references on `ai_invocations`; the Brain-events Activity adapter; the restricted-roles runbook | one additive migration, not dispatched |
| B5 | Loop side: the Brain API, the internal Brain API (access, context, commit), ring signing, worker-token verification, stored-control reads, the in-process step runner; retirement of the old `/api/brain` route | none |
| B6 | AWS foundation in staging, switched off (CDK; authorizer, dispatcher, worker, sweeper, queues, DynamoDB, KMS, secrets, alarms, budgets; GitHub OIDC). **Adds a second deployable: needs approval of layout and tool.** | none |
| B7 | Case Explanation on AWS in staging, then production; the first live request on a synthetic Case after the effort decision; removal of Netlify's provider keys | none |
| B8 | The first DURABLE task, with its owned artifact and interface; the outbox repair (prerequisite) and notifications; ECS long steps only if needed | artifact migration |

The order above is Matt's (2026-09-16): design first (B3), then persistence (B4).

## 13. Open decisions

**Matt:**
- the AWS region: **us-east-1** is recommended, where production Neon runs (verified). Also the
  Netlify function region;
- the account structure and access;
- approval of the second deployable and its layout at B6;
- the B3 executor revision (§9);
- where the first live request happens (staging with a synthetic Case is recommended);
- new per-environment provider keys, and removal of Netlify's keys after B7;
- retention for checkpoints, execution data and logs;
- budget values, per-job budgets, and the paid-attempt limit;
- a staging database (a Neon branch);
- the Neon plan (public pooler now, or private networking later);
- an AWS support plan;
- still open from PD-F-08: MANAGER as an invoker; Opus 5 vs Fable 5.1; GPT-6 Astra vs GPT-5.6
  Sol.

**Resolved in B2:**
- capability route replaces `profile`;
- Case Explanation is TECHNICAL_ANALYSIS and conforms, with no routing change.

**Settled by Matt for B3 (2026-09-16):**
- WAITING_FOR_USER replies come from the originating principal only in V1.
- Routing conformance is enforced at run time as well. B3 sets the boundary: acceptance, and before
  every model step (`brainRouteGate`).
- Case Explanation's 20 s / 75 s are provisional product targets, never infrastructure limits.
- The sequence is B3 design, then B4 persistence.

**Still open:**
- the COMMUNICATION primary and fallback models, verified when chosen;
- **where a communication draft belongs.** There is no DRAFT result type; the options are in
  `brain-execution-infrastructure.md` §24, and it is deliberately unresolved.

**Charlie:** the infrastructure-as-code tool (TypeScript CDK is recommended) and ownership of the
AWS runbook.

**Charlie and Lexi:**
- the move-to-background experience and notification channel;
- how a waiting question looks, and its default expiry;
- whether Case explanations keep a history;
- whether any live token streaming is ever wanted;
- how each result type is presented, and conversation retention.

## 14. Open items carried forward

1. **The outbox drain does not run in production.** Every scheduled "Drain outbox" run since at
   least 2026-09-14 fails because the repository secrets `OUTBOX_DRAIN_URL` and
   `OUTBOX_DRAIN_SECRET` are unset. Nothing delivers `state_change_outbox` events. Brain's
   event and notification step (B7) depends on fixing this.
2. **Schema drift: RESOLVED by B1 (#273, merged).** The Prisma schema now describes the database the
   35 migrations build, and a clean replay diffs empty. The migrations and the database were not
   changed. A CI replay check that would prevent a recurrence is **not built**.
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

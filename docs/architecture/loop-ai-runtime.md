# Loop AI Runtime — architecture record

**Status:** ARCHITECTURE APPROVED (PD-F-08, 2026-09-15). Slices S0–S2 are **built and switched off**
(see the slice table in §16, which also describes what exists). **No live provider request has been made.** Case
Explanation is the first governed use case. **No AI-generated domain write is authorized.** Provider SDKs
and HTTP stay behind provider adapters. No production data is sent to any provider until the activation
gates in §17 hold.

**Where it executes (amended 2026-09-16, approved direction).** Brain execution, including every provider
call, moves to AWS. Netlify stays the product and the Brain API front door, and Neon stays authoritative.
See `brain-execution-architecture.md`.
- **Built so far (B2, B3, B3.1, B4):** the provider-independent execution and dispatch contracts
  (§6a), including the DRAFT result type, and the durable persistence they need
  (`brain-persistence.md`; migration not dispatched). Nothing executes them.
- **Designed (B3, not provisioned):** how work reaches AWS and runs there. See
  `brain-execution-infrastructure.md`:
  - an authenticated doorbell;
  - SQS-driven Lambda step runners with Neon as the only workflow state;
  - provider keys in Secrets Manager;
  - product reads and writes through Loop's internal Brain API;
  - region us-east-1, where production Neon runs.
- **Until the rest is built:** the runtime described here runs inside the Netlify app, as §16 and §17
  say.

**Position.** Loop owns intelligence and governance. Anthropic and OpenAI are interchangeable reasoning
engines underneath it. Neither is Loop's authority, memory or brain.

```
Loop authoritative facts
  → governed context and evidence assembly      (Loop; per-principal authorization; policy gate)
  → Loop AI Runtime                             (routing, budgets, invocation, provenance)
  → provider adapter → model                    (replaceable)
  → structured output → validation              (schema, citations, policy)
  → typed artifact: Summary | Draft | Hypothesis | Recommendation option | Action proposal
  → the owning Loop authority's gate           (CI Finding/Recommendation services, Decision Engine)
  → human or explicitly approved policy authority
  → consequential action by the domain service, under that authority
```

---

## 1. Repository baseline (verified on `main` `543c645`)

**Models, SDKs and runtime pieces**

| Finding | Class |
|---|---|
| No model SDK, model host call, prompt sent to a model, embedding, vector store or MCP server exists anywhere. CLAUDE.md's "there is no LLM" is true. | — |
| `packages/providers/src/interfaces/ai.provider.ts` defines `AIProvider` (messages, tools, usage, finish reason, optional stream). It is **not exported** from the providers barrel; its only implementation is `MockAIProvider`. | REAL/UNUSED, safe to evolve |
| `MockAIProvider`, mock voice/SMS/calendar providers | MOCK, dead |
| `KNOWN_PROVIDERS.ai = ['anthropic','openai']`; catalog secret names `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (read only by the configured/not-configured check); `.env.example` `AI_PROVIDER`, `AI_API_KEY` (read by nothing). Two naming schemes. | PLACEHOLDER |
| `AIAgent.systemPrompt/model/modelProvider`, `VoiceProfile` | PLACEHOLDER; must not become the prompt store |
| No model usage, token, cost, prompt or template table | — |

**Governance and intelligence pieces**

| Finding | Class |
|---|---|
| `DataGovernancePolicy.aiReasoningAllowed`, `externalDisclosureAllowed`, `DataPurpose.AI_REASONING`, deny-by-default `GovernanceEvaluator` | REAL/UNUSED; the evaluator ignores `aiReasoningAllowed` |
| `RECOMMENDATION_AUTHORS = MACHINE \| MODEL \| HUMAN`; `CaseRecommendationService.record` (writes `requiresApproval: true`, no numeric confidence, posture ceiling from evidence strength); `CaseFindingService.record` (Finding evidence state derived from governed evidence only; human accept/reject) | REAL; the **record** paths have no production caller. Safe to evolve. |
| Decision Engine (append-only log, projection, outbox, idempotency, org scoping) | REAL/ACTIVE; the approval substrate, with gaps (§8) |
| Existing fence: `packages/database/test/case-finding.test.ts` forbids `anthropic`, `openai`, `fetch(`, `llm`, `prompt`, `completion` in the CI Finding service | Keep: the runtime sits beside CI services, not inside them |
| `packages/brain` | Mostly type declarations and dead demo harnesses. Next-best-action rules run on ingestion and write "Assign default AI Employee… acknowledge and qualify", which no AI Employee can do. |
| `@emgloop/intelligence` Executive Brain | Deterministic; renders numeric "N% confidence" |
| CallGrid intelligence | Persists a formula confidence (unknown coverage counts as full) into Case, evidence and hypothesis rows; bid literals 0.9/0.8 |
| Signal registry | Writes constants 0.4–0.9 |

The last three are CONFLICTING with Engineering Principles Rule 7 and the locked machine-authority
decision.

**UI text that presents canned output as AI** (to correct through the UI track and minimal wording
fixes): "AI resolution rate", "Meet your AI Assistant", "AI Setup Assistant", the "Brain Pipeline"
diagram with a live dot, "Brain insight" threshold strings, "Connecting to the Brain…", the "AI
Activity" tab, catalog "Turn on the AI features…".

## 2. Principles

1. **Loop is the authority.** A model output is never a fact, identity, permission, time or human
   decision. It becomes a canonical object only through the owning authority's governed path.
2. **One intelligence system.** The runtime is a capability used by existing authorities (Commercial
   Intelligence, Decision Engine, Work OS, CRM read models). It is not a second Brain, queue, approval
   system or memory.
3. **Deny by default.** A task runs only when the principal is authorized, the data is permitted for
   the purpose, the provider is approved for that data class, and the budget allows it.
4. **Provider-neutral.** No provider name or SDK type appears in domain code, repositories, CI services
   or UI (CLAUDE.md principle 4). Adapters are the only place they live.
5. **Honest uncertainty.** Model uncertainty is expressed as semantic status, stated limitations and
   withheld or unknown inputs, never as a generic confidence percentage.
6. **Auditable, not reproducible.** Every invocation records what was asked, with what, under which
   versions and policies, and what came back. Nondeterministic models are not promised to reproduce.

## 3. Components and placement

| Component | Location | Responsibility |
|---|---|---|
| **AI contracts** | `packages/shared/src/ai/` (pure) | Task definitions and versions; output schemas; the intelligence taxonomy; `ContextPackage` manifest types; provenance record type; routing policy types; error taxonomy; tool definition types. **Since B2, also:** capability routes and routing conformance; Brain execution classes; result types and ownership; the job state machine; step, retry and checkpoint policy; the doorbell and command trust contract; the executor port |
| **Provider adapters** | `packages/providers/src/ai/` | `ModelProvider` implementations (Anthropic, OpenAI) evolved from `AIProvider`. **The only code that imports an SDK or calls a model host.** |
| **Runtime (gateway)** | `packages/database/src/services/ai-runtime/` | Task execution: context assembly through repositories; governance gate; routing; budgets; invocation with retry, timeout, cancellation and fallback; output validation; tool broker; provenance and usage recording |
| **Prompt templates** | `packages/database/src/services/ai-runtime/templates/` | Versioned template modules reviewed by PR (§10) |
| **Callers** | apps/web server actions and route handlers; CI services | Invoke *tasks* by name. Never adapters, never raw prompts. |

- **Fences (tests):**
  - SDK imports only under `packages/providers/src/ai/adapters/`.
  - No provider names in `packages/shared` domain files, CI services or `apps/web`.
  - No `NEXT_PUBLIC_*` model keys.
  - No model calls from client components.
- **Execution environment (amended 2026-09-16, not built).** These packages keep the runtime's code. It
  will execute in an AWS worker behind a Loop-owned orchestrator port, with Netlify as the front door
  (`brain-execution-architecture.md` §3, §9).
- **Placement choice.** A dedicated `packages/ai-runtime` package is the alternative. It is not
  recommended now because it adds a package without a second consumer. Decide it before slice S1 if
  Product prefers the separation.

## 4. F1 — Provider abstraction

```ts
interface ModelProvider {
  readonly providerId: string;                         // 'anthropic' | 'openai' | future
  capabilities(model: string): ModelCapabilities;      // declared by the adapter, overridable by config
  invoke(req: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
  stream?(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

interface ModelRequest {
  invocationId: string;              // Loop idempotency and correlation id
  model: { providerId: string; modelId: string };
  instructions: string;              // rendered governed template (system)
  input: ModelContentBlock[];        // text / structured data blocks, each tagged with its source refs and trust level
  tools?: ToolSpec[];                // JSON-schema tool specs from the broker (no WRITE tools at launch)
  output: { kind: 'TEXT' } | { kind: 'JSON_SCHEMA'; schemaId: string; schema: object; strict: true };
  limits: { maxOutputTokens: number; timeoutMs: number };
  sampling?: { temperature?: number };
}

interface ModelResult {
  output: { text?: string; json?: unknown };
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  stopReason: 'END' | 'MAX_TOKENS' | 'TOOL_USE' | 'REFUSAL' | 'CONTENT_FILTERED';
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number };
  providerRequestId: string | null;
  reportedModel: string | null;      // what the provider says actually served the request
  latencyMs: number;
}
```

- **Capabilities** are declared per model:
  - structured output mode (native JSON schema, tool-forced or none);
  - tool use and parallel tool calls;
  - streaming;
  - context window and maximum output;
  - prompt caching;
  - batch;
  - region and data-retention eligibility, as *configuration confirmed by contract*, never assumed.
- **Error taxonomy.** Adapters map provider errors to these classes; the runtime owns every retry
  decision.

| Class | Retry | Fallback |
|---|---|---|
| AUTH | no | no; alert |
| RATE_LIMITED | yes, honoring retry-after, bounded | yes, after attempts |
| UNAVAILABLE / OVERLOADED | yes, bounded, with jitter | yes |
| TIMEOUT | once | yes |
| INVALID_REQUEST | no (a Loop bug) | no |
| CONTEXT_TOO_LARGE | no | re-assemble smaller, or route to a larger-context model if policy allows |
| REFUSED / CONTENT_FILTERED | no | no; recorded as an outcome |
| OUTPUT_INVALID (post-validation) | at most one repair attempt, if the task allows | no |
| POLICY_DENIED, BUDGET_EXCEEDED | runtime-level, before any call | no |
| CANCELLED | no | no |

- **Timeouts and cancellation.**
  - Every invocation has an overall deadline.
  - An `AbortSignal` propagates from the caller (request abort) to the adapter.
  - Retries never exceed the deadline.
- **Idempotency.** `invocationId` is stable across retries. A step that executed a tool is not retried
  unless the tool is idempotent under its key.
- **Rate limiting.**
  - Per provider and model: global token-bucket limits. Per organization: quotas.
  - Serverless instances do not share memory, so limits and quotas use a durable counter (the usage
    record, §12), not an in-memory map (the webhook replay-map lesson in CLAUDE.md).
- **Health.**
  - A per-provider and per-model circuit breaker, derived from recent invocation outcomes.
  - An operator kill switch by configuration: global, per provider, per task, per organization.
- **Streaming.**
  - Only for human-facing drafting.
  - Partial output is shown as "draft in progress" and never stored or treated as an artifact.
  - For Brain jobs this needs Product's approval first: `BRAIN_PROVISIONAL_TEXT_RESULT_TYPES` is empty,
    DRAFT included.
  - Validation runs on the complete output.
  - Structured-output tasks do not stream.

## 5. F2 — Model routing

Routing is **versioned policy data**, not code branches:

```ts
interface RoutingPolicyV1 {
  policyVersion: string;
  tasks: Record<TaskId, {
    requires: { structuredOutput?: boolean; toolUse?: boolean; minContextTokens?: number };
    dataClassCeiling: SensitivityClass;         // highest class the task may send (PD-F-08)
    latencyTargetMs: number;
    costTier: 'LOW' | 'STANDARD' | 'HIGH';
    candidates: Array<{ providerId: string; modelId: string }>;  // ordered
    fallbackOn: ErrorClass[];                    // e.g. UNAVAILABLE, TIMEOUT, RATE_LIMITED
    maxAttemptsPerCandidate: number;
  }>;
}
```

The router filters candidates in this order:
1. the provider is approved for the organization and for the task's data class;
2. capabilities match;
3. circuit health;
4. budget.

It then takes the first remaining candidate and records the route decision: policy version, candidates
considered, reasons for skipping, and the one chosen.

- **Change.** Policy content lives in the repository and changes by reviewed PR with an evaluation run
  (§13). Per-organization overrides are deferred.
- **Adding a provider or model** is an adapter plus policy rows. Domain semantics never change.
- **No hard-coded "provider X does task Y"** outside this policy.
- **Provider specialization (approved product decision 2026-09-16; implemented in B2 as contract and
  policy data; not activated).**
  - **One declaration per task.** Each task declares one capability route: COMMUNICATION,
    TECHNICAL_ANALYSIS or GENERAL_REASONING. The route **replaced** the old, unread `profile` field.
  - **Where the preferences live.** `AI_PROVIDER_SPECIALIZATION_POLICY` (`specialization.2026-09-16.1`):
    OpenAI for COMMUNICATION, Anthropic for TECHNICAL_ANALYSIS, and no default for GENERAL_REASONING.
  - **Departures.** A routing entry that departs from its route's preference says why in
    `providerChoiceReason`.
  - **Enforcement.** `aiRoutingConformance` checks every shipped task, and the providers test suite
    fails on any finding.
  - **Fallback** stays governed and recorded.
  - **No universal fallback order** (reaffirmed after B3).
    - Neither provider is the other's standing fallback.
    - A task is served by another approved provider only when its own routing entry permits it and
      names the target. `aiRoutingConformance` reports `FALLBACK_PERMITTED_WITHOUT_TARGET` otherwise.
  - **Independence.** The route does not imply the result type (a COMMUNICATION task usually produces a
    DRAFT) or the execution class.
  - **Unchanged.** `routing.2026-09-16.2` is unchanged, because Case Explanation (TECHNICAL_ANALYSIS)
    already conforms.
  - **Run-time enforcement (B3, designed).** `brainRouteGate` runs where Brain work is accepted and
    before every model step; a refusal ends the job as `ROUTING_NOT_CONFORMANT`. The existing,
    switched-off Netlify gateway is not changed, because it is retired when Case Explanation moves
    to AWS.

  See `brain-execution-architecture.md` §5a.

## 6. F3 — Intelligence taxonomy

| Object | Canonical authority today | May a model produce it directly? | Governed path |
|---|---|---|---|
| Raw model response | none | — | Never authority. Retained only per §11 retention. |
| Validated output | none | yes | A typed artifact *candidate*. Still no authority. |
| **Summary** | none (derived) | yes | Shown labeled as a model summary with citations. May be stored as a non-authoritative artifact with provenance. Never replaces facts. |
| **Draft** (communication, content) | none until sent | yes | The Brain result type DRAFT (B3.1), held by Communications. Stored only as a draft. Sending is a Communications act by a human, or a separate PROPOSED_ACTION approved on its own. |
| **Hypothesis** | CI `IntelligenceHypothesis` (PROPOSED → human accept/reject) | proposes only | `CaseFindingService` with author MODEL. Evidence state stays derived from governed evidence, so a model cannot make a claim ESTABLISHED. |
| **Signal** | CI Commercial Signal (deterministic evaluator) | no | Only as a versioned *evaluator* behind the evaluator contract, with every referenced fact validated. Never written from raw output. |
| **Finding** | CI Finding gate | no | Human acceptance plus the evidence gate. A model proposal never becomes a Finding by being emitted. |
| **Recommendation** | CI Case recommendation options (`requiresApproval: true`) | proposes options | `CaseRecommendationService.record` with author MODEL, under the evidence-strength posture ceiling. Humans select, dismiss or revise. |
| **Decision** | Decision Engine (human or producer lifecycle) | **never** | Decisions are recorded by authorized humans, or by an explicitly approved policy. Model output never resolves, dismisses or selects. |
| **Work** | Work OS | proposes only | A proposal becomes work only through approval (§8). |
| **Proposed action** | none until approved | yes (as a proposal) | A typed `ActionProposal` naming the tool, input and justification. Authorization and approval are separate acts. |
| Fact / identity / human decision | their authorities | **never** | Model output alone never establishes them (specification Brain table). |

### 6a. Brain result types (B2)

The Brain execution contracts (`brain-execution-architecture.md` §5) give every result one of six
**semantic result types**, independent of how the work executes and which capability it needs.

| Result type | Taxonomy object(s) above | Owner and standing |
|---|---|---|
| ANSWER | Summary, in a conversation | Brain conversations; NON_AUTHORITATIVE |
| ANALYSIS | Summary of one subject | Commercial Intelligence (Case), Relationships or Campaigns; NON_AUTHORITATIVE |
| FINDING | Hypothesis | Commercial Intelligence, through `CaseFindingService`; PROPOSED |
| RECOMMENDATION | Recommendation | Commercial Intelligence, through `CaseRecommendationService`; PROPOSED |
| DRAFT | Draft | Communications, on a customer conversation; NON_AUTHORITATIVE |
| PROPOSED_ACTION | Proposed action | Decision Engine approval item; PROPOSED |

- **A draft is not a send** (decided 2026-09-16, after B3).
  - Committing a DRAFT authorizes, schedules and performs nothing.
  - Only a PROPOSED_ACTION asks Loop to act, and only the Decision Engine holds one.
  - A draft job can never commit one.
- **Signal, Decision, Work, facts and identity** stay outside what a model may produce.
- **Standing and ownership.** No result is ever more than PROPOSED, and Activity, Brain execution and a
  provider never own one.

## 7. F4 — Context and evidence packaging

The model receives a `ContextPackage` built by Loop. It never queries the database itself.

- **Assembly.**
  - Assembled per task by a task-specific assembler.
  - It calls domain repositories and services **as the invoking principal**: the user session with the
    existing `requirePermission` / `can()` checks, or an approved service policy (§8).
  - Organization-scoped.
- **Item manifest.** Each item carries:
  - source refs: `authority`, `recordType`, `recordId`, `sequence`;
  - subject refs (Party, Case, Work…);
  - `observedAt` and freshness;
  - sensitivity class, purpose tag, semantic status (e.g. Finding DEVELOPING), limitations;
  - minimized content.
- **Policy gate per item.**
  - `GovernanceEvaluator`, evolved to read `aiReasoningAllowed` and `externalDisclosureAllowed`, with
    purpose `AI_REASONING`, deny-by-default.
  - Withheld items are recorded in the manifest and told to the model as "withheld: <reason>", so the
    model and the reader know what was not seen.
- **What may be sent**, by sensitivity class:

| Class | Default |
|---|---|
| OPERATIONAL | permitted only if the policy allows |
| CONTACT_IDENTIFIER | not sent; replaced by stable placeholders when the task needs to distinguish subjects |
| COMMUNICATION_CONTENT | only when the task's purpose requires it and policy allows |
| WORKFORCE_PII | not sent |
| SSDI and other sensitive fields, secrets | never |

  Adopted default (§17): only OPERATIONAL data leaves Loop. Anything more needs a separate Product and
  security review.
- **Tenancy.** A package is bound to one organization. The runtime asserts every item's
  `organizationId` equals the invocation's, and aborts on mismatch (fence test). Nothing is cached
  across organizations.
- **Budget.** Items are ranked by the task's deterministic relevance rules. Truncation is disclosed in
  the manifest and to the model.
- **Untrusted content.** Evidence statements, notes, message bodies and provider payloads are wrapped as
  delimited, labeled data. Instructions come only from governed templates.
- **Nothing broader.** The whole database or unscoped search is never sent.

## 8. F5 and F6 — Tools and the approval boundary

**Tools are executed by Loop's broker, never by the model.** A model's tool call is a *request*.

```ts
interface ToolDefinition {
  name: string; version: string;
  kind: 'READ' | 'DRAFT' | 'PROPOSE' | 'WRITE';
  inputSchema: object; outputSchema: object;
  authority: { resource: string; action: string; service: string };   // enforced by the broker
  purpose: DataPurpose; outputSensitivity: SensitivityClass;
  idempotency: 'NATURAL' | 'KEY_REQUIRED' | 'NOT_APPLICABLE';
  approval: 'NONE' | 'HUMAN' | 'POLICY';
  principals: Array<'HUMAN_SESSION' | 'SERVICE_POLICY' | 'AI_EMPLOYEE'>;
  audit: 'ALWAYS' | 'WRITE_ONLY';
}
```

**Broker sequence for every call:**
1. validate input against the schema;
2. re-authorize independently for the principal and organization (`can()` plus policy);
3. check the task's tool allowlist and limits (maximum calls, depth, time);
4. execute through the domain service, never raw Prisma;
5. filter output by sensitivity;
6. return the result as **untrusted data**;
7. record the call, authorization result and outcome in provenance, and in AuditLog for anything not
   read-only.

**Tool catalogue (proposed; none built):**

| Tool | Kind | Authority | Approval | AI_EMPLOYEE |
|---|---|---|---|---|
| `crm.read` (Party, Intake, Relationship read models) | READ | `customers:view` / `relationships:view` | none | no (until an AI principal policy exists) |
| `activity.read` (`activity.v1` for a subject) | READ | per-item source authority | none | no |
| `intelligence.read` (Case workspace, Headlines) | READ | `commercialIntelligence:view` | none | no |
| `work.read` | READ | workspace or work authority | none | no |
| `search` (governed search, when built) | READ | per result | none | no |
| `analytics.read` | READ | `analytics:view` | none | no |
| `draft.communication` | DRAFT | `inbox:view` | none; **sending is not a tool** | no |
| `recommendation.propose` (CI option) | PROPOSE | CI service gate | human selection | no |
| `decision.request` (open an approval item) | PROPOSE | Decision Engine producer contract | human | no |
| `work.propose` | PROPOSE | Work OS | human | no |
| `work.create`, any CRM or identity write, external integrations | WRITE | domain authority | human or approved policy | **not available at launch** |

**The four steps, and what crosses each boundary:**

| Step | What it is | State change |
|---|---|---|
| **RECOMMEND** | The model produces a labeled recommendation or summary. | none |
| **PROPOSE** | Loop persists a typed proposal as a CI recommendation option or a Decision Engine approval item, with author MODEL and full provenance. | a proposal only |
| **APPROVE** | An authorized human, or an explicitly approved governed policy, records approval in the owning authority's log (actor HUMAN or POLICY with the policy version). | an approval record |
| **EXECUTE** | The domain service performs the act under the approver's authority, with an idempotency key, records execution, and observes the outcome. | the consequential change |

**Consequential operations never happen because a model emitted a tool call.**

**The Decision Engine is the approval substrate. There is no second approval system.** Before any
AI-proposed action flows through it, these gaps must close (slice S3):
- an actor type for model- and policy-originated observations;
- a `decision:approve` permission with an approver check;
- approval that changes the lane;
- proposal expiry;
- an executor that records `executedAt` and the outcome;
- atomic approve-plus-log;
- transition guards on assign and watch;
- removal of the decision write that happens on CallGrid page render.

**Policy authority** ("explicitly approved low-risk actions"):
- a versioned automation policy, approved by OWNER/ADMIN under `approve`;
- scoped to a task, tool and impact bound;
- audited and revocable.
- **Deferred:** no autonomous execution at launch.

## 9. F7 — Provenance

Every invocation writes an **AI invocation record**, organization-scoped, append-only:

| Group | Fields |
|---|---|
| Call identity | `invocationId`, `organizationId`, principal (user id, service policy id and version, or AI Employee id), task id and version |
| Instructions and route | template id, version and content hash; routing policy version and route decision |
| Provider | provider, requested model, reported model, adapter version, sampling parameters |
| Inputs | context manifest (source refs and sequences, withheld items and reasons, sensitivity classes; **not content**); tool set version and every tool call with its authorization result |
| Output | output schema id and version; validation result; output artifact refs; stated limitations |
| Cost and outcome | usage (input, output, cached and reasoning tokens); estimated cost and pricing table version; latency, attempts and fallbacks; error class |
| Time | `startedAt` / `completedAt` (server clock) |

- Artifacts (summary, draft, proposal) reference their `invocationId`.
- Evidence snapshots follow Engineering Principles Rule 3: a stored AI-proposed recommendation keeps its
  context manifest and limitations.
- Full prompt and response *bodies* are not persisted in production (adopted default, §17).

## 10. F8 — Prompt management

- **Identity.** Templates are versioned modules in the repository (`<task>.<template>@<semver>`) with a
  content hash recorded on every invocation. Tenant-editable free-text system prompts are not supported:
  `AIAgent.systemPrompt` stays unused.
- **Ownership and review.** Engineering owns template code. Product reviews task intent and output
  schemas. Every change goes through a PR with rendered-prompt snapshots from fixtures and an evaluation
  run (§13).
- **Environments.** The same templates run everywhere; routing and model configuration may differ per
  environment.
- **Rollback.** Pin or revert the version. Old versions stay addressable for audit.
- **Testability.** Pure render functions with fixture contexts; injection-delimiter tests; schema tests.
- **Prompt content is never domain authority.** Outputs are validated against schemas and source refs.
  A template cannot make an output canonical.

## 11. F9 — Memory

No vague global AI memory. Each kind maps to an existing or proposed authority:

| Memory | Authority | Provenance / tenancy / purpose / retention / correction |
|---|---|---|
| Conversation context (turns in one interaction) | Task-local, held by Loop for the session | Ephemeral; the transcript is retained only under the conversation retention policy. **Provider-side conversation state (stored threads, previous-response ids) is never canonical and not relied on.** |
| Task-local context | `ContextPackage` | Ephemeral content; the manifest persists in provenance |
| User preference memory | *Proposed:* explicit, user-set preferences only, never inferred | User-owned, editable and deletable. Deferred. |
| Organizational memory | Existing `KnowledgeAssertion` (class ORGANIZATIONAL), human-accepted | A model may propose (INFERRED/PROPOSED), never accept. Revocable. |
| Subject history | Source authorities through `activity.v1` | No copy; retention per source |
| Learned operating patterns | CI case learning (outcome counts from human decisions) | A model may summarize patterns; it does not store beliefs |
| Embeddings / semantic index | **Deferred** | If ever built: tenant-scoped, derived and rebuildable, deletion propagates, governed like any projection |

## 12. F10 and F11 — Security, privacy, cost

**Credentials**
- Provider keys are server-only environment variables using the catalog names (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`). Retire `.env.example`'s `AI_PROVIDER` / `AI_API_KEY`.
- Never `NEXT_PUBLIC`, never logged, never echoed.
- Rotation supports a primary and a secondary key read.
- Customer-supplied keys are deferred. A credential authenticates Loop to the provider, never a tenant
  to Loop.

**Tenant isolation**
- Per-invocation organization assertion (§7).
- No cross-tenant caching of outputs.
- Provider-side prompt caching applies only to template prefixes that contain no tenant data.

**Data minimization and injection defenses**
- Sensitivity classes (§7), placeholders for identifiers, and SSDI sensitive fields never sent.
- Application logs carry ids and error classes, never prompt or response content.
- Defenses:
  - instruction/data separation;
  - per-task tool allowlists;
  - no WRITE tools;
  - output validation;
  - **citation validation**: every claim must cite refs present in the manifest, and output citing
    anything else is rejected;
  - tool results treated as untrusted data.
- **Output validation:**
  - strict JSON schema;
  - enum membership;
  - no fields the schema forbids (numeric confidence, raw contact values the input did not contain);
  - numbers must appear in the cited sources;
  - length bounds.

**Provider terms, residency and incidents**
- Before any production data is sent, Product and legal confirm per provider: no training on
  submissions, retention and zero-retention eligibility, and processing region (activation gate G2, §17). The
  runtime records the provider and region on each invocation.
- Incident handling:
  - kill switches (§4);
  - invocation records for forensics;
  - a key revocation and rotation runbook;
  - suspension of affected tasks per organization.

**Cost and usage governance**
- **Usage record** per invocation: provider, model, tokens, estimated cost from a versioned pricing
  table, task, organization, principal, latency, success or failure, fallback.
- **Budgets:**
  - per request (token and tool-call ceilings);
  - per task run;
  - per organization (daily and monthly);
  - global;
  - per model tier.
- **Enforcement:** projected before the call and actual after. On exhaustion the task is refused with an
  honest "budget reached" state, or degraded to a cheaper tier when policy allows.
- **Cost data never enters domain tables.**

## 13. F12 — Evaluation

- **Offline suites per task** use synthetic or sanitized fixtures, never production PII. They measure:
  - structured-output validity rate;
  - citation validity;
  - groundedness (claims supported by cited sources; automated checks plus human rating);
  - policy compliance (no forbidden fields, no raw PII, no unsupported certainty);
  - tool selection;
  - latency and cost.
- **Online:** shadow mode first, then limited exposure by routing policy.
- **Outcome signals from existing authorities:**
  - recommendation selected, dismissed or revised;
  - Decision outcomes, including FALSE_POSITIVE and NOT_ACTIONABLE (Engineering Principles Rule 4);
  - downstream measured outcomes where they exist.
- **Gate.** A template, model or routing change ships only with an evaluation run. Subjective preference
  ("sounds smart") is not a metric.

## 14. F13 — Multi-model behavior

| Pattern | Position |
|---|---|
| Primary + fallback | **Yes**, for availability, under the same task contract and validation |
| Task routing | **Yes**, through routing policy |
| Parallel independent analysis, critique or review | **Deferred.** Only for evaluation, or high-stakes proposals under explicit policy. |
| Consensus | **Never establishes anything.** Agreement between models is not evidence. Disagreement is surfaced as uncertainty and escalated to a human. |

## 15. F14 — Brain and Commercial Intelligence integration

| Existing system | Reality | Role for the runtime |
|---|---|---|
| Commercial Intelligence (Objectives, Signals, Headlines, Cases, Evidence, Finding gate, Recommendations, Monitoring, Learning) | **The real intelligence authority** | The runtime is an *author* under CI services' gates (author MODEL). It never bypasses them. |
| Decision Engine | Real lifecycle and approval substrate | Approval items for AI proposals, after the §8 gaps close |
| Work OS | Real human execution | Proposals become work only through approval |
| CRM read models (Party, Intake, Relationship when built) | Real or planned authorities | Read tools only; no model writes |
| Cognitive layer (`GovernanceEvaluator`, `KnowledgeAssertion`, `IntelligenceHypothesis`) | Dormant | Evolve `GovernanceEvaluator` as the purpose gate; use `KnowledgeAssertion` for organizational memory proposals |
| `packages/brain` | Mostly placeholder. Next-best-action rules active with a false AI claim. Call-handling briefing route unlinked, with hardcoded confidences. | Retire or confine. It is **not** the runtime. Remove the "assign AI Employee" rule until an AI Employee can act. |
| `@emgloop/intelligence` Executive Brain | Deterministic, ungoverned, numeric confidence | Confine; not a source for "Loop Noticed" (governed CI only) |
| Numeric confidences (signal registry, CallGrid persisted confidence, bid literals, intelligence package, diagnoser) | CONFLICTING | Convert to semantic states **before** model output shares a surface with them. Otherwise model uncertainty is compared to fabricated numbers. |
| "Brain" as a product name | UI 10 conversational interface | The governed runtime behind CI context, later. Not a second intelligence system. |

## 16. F15 — First integration slice: Case Explanation (as built, AI-1 to AI-5)

**Case Explanation:** a read-only, on-demand, citation-bound explanation of one Commercial Intelligence
Case for the person viewing it. **Prepared and switched off.** No live provider request has been made.

- **Surface.** `/app/admin/cases/[id]`, an "Explanation" panel. The page only asks whether to offer it,
  which is a permission and configuration check with no model call. The request goes through the guarded
  action `explainCaseAction`.
- **Authority.**
  - `requireWorkspace('ADMIN')` and `commercialIntelligence:view` in the action.
  - `iamAiAuthorizer` in the service:
    - an active OWNER or ADMIN membership;
    - every required permission through `can()`;
    - never AI_EMPLOYEE.
  - The runtime allowlists for the organization, the task and the provider (§17).
  - A person who may not invoke is refused **before the Case is read**.
- **Context.** Built by `buildCaseExplanationContext` from `CaseWorkspaceView`, as the invoking person.
  - **Sent:** structured facts only, all OPERATIONAL:
    - the Case's state and detection history;
    - the headline's measured lineage;
    - measured evidence rows (capped at 30, entity names replaced by labels such as `buyer #1`);
    - a current rule-produced finding;
    - monitoring criteria and verdict;
    - the outcome.
  - **Withheld and counted:** everything a person typed, the Case title and subject, recommendations,
    participation and work, user ids, and entity names.
  - **Units:** taken only from Loop's metric definitions, never from a name.
  - **Per-block manifest:** each block carries its authority, why it was included, the permission it was
    read under, its sensitivity, its trust and its time basis.
  - **Wrapping:** blocks go inside escaped `<loop_sources>` elements that source text cannot break out of.
- **Output** `case-explanation.v2`:
  - `summary`;
  - `claims`, each an OBSERVATION, SIGNIFICANCE or CONSIDERATION, with `citations` and `figures`;
  - `limitations`.
- **Validation** (`validateAiTaskOutput`). The answer is refused whole on any of:
  - wrong schema;
  - empty answer;
  - too long;
  - an unknown claim kind;
  - an uncited claim;
  - a citation that wasn't supplied;
  - a figure not in the claim's own cited sources;
  - any number in prose that the evidence doesn't contain;
  - any date the evidence doesn't name;
  - a self-scored confidence;
  - an instruction to act.

  A refused answer is shown as a reason, never partially.
- **Writes.**
  - **No domain writes.**
  - One `ai_invocations` row per provider call (reserved before, reconciled after).
  - One AuditLog row `ai.case_explanation` per attempt that reached a provider (ids, versions, outcome, no
    content).
  - Answers are not stored.
- **Declarations (B2).**
  - Capability route **TECHNICAL_ANALYSIS**; `ai_invocations.profile` now records this route instead of
    the retired `EXPLANATION`.
  - Result type **ANALYSIS**, owned by Commercial Intelligence (Case).
  - Execution **INTERACTIVE** only: a 20 s presentation budget and a 75 s interactive deadline (both
    proposals), with streaming `NONE`.
- **Routing.** `routing.2026-09-16.2`, which conforms to the specialization policy with no change:
  - Case Explanation's own entry: Claude Opus 5 primary, with GPT-6 Astra as its permitted fallback.
    This is one task's choice, not a platform-wide order.
  - Fallback only on UNAVAILABLE, TIMEOUT or RATE_LIMITED; never after a refusal or a rejected answer.
  - One attempt per target, within Netlify's 60 s request.
- **Limits.**
  - the per-call, per-task, per-organization and global caps (`budget.2026-09-16.1-proposed`);
  - kill switches at five scopes;
  - no streaming, no tools.
- **Evaluation.** 20 synthetic scenarios, numbered 1–18 plus 7b and 7c
  (`packages/database/test/ai-case-explanation.eval.test.ts`),
  drive the real adapters with scripted clients and gate the slice.

**Why this surface.** The Case workspace is already authorized, org-scoped, deterministic, read-only, and
carries provenance and explicit unknowns, which maps directly onto "Summary: does not replace source
facts". Its follow-on (`CaseRecommendationService.record` with author MODEL) already models approval.

**Rejected as the first surface:**
- **Headlines:** too thin to be worth summarizing.
- **CallGrid situation:** writes on render, fabricated confidence, no `requirePermission`.
- **Call-handling briefing:** unlinked, hardcoded confidence.

**Slices**

| Slice | Contents | Migration |
|---|---|---|
| S0 | Contracts in `@emgloop/shared/ai`; `ModelProvider`; adapters with recorded-fixture tests and no live calls in CI; fences | no |
| S1 | Runtime: governance gate, routing, budgets, validation, AuditLog provenance; Case Explanation behind the activation allowlists — **built (AI-1 to AI-5), not activated** | no |
| S2 | `ai_invocations` usage and provenance table; budgets from durable counters — **built and deployed (#265, AI-1)** | yes (applied) |
| S3 | Decision Engine approval gaps (§8); `recommendation.propose` with author MODEL | possibly (actor type) |
| S4 | Read tools and the broker; further tasks | no |

## 17. Approval (PD-F-08) and activation gates

**Approved 2026-09-15:** this architecture, including provider adapters, governed routing, authorized
context assembly, structured output, provenance, independent tool authorization, the Decision Engine
approval boundary, cost and usage governance, prompt versioning, evaluation, privacy and security gates,
and primary/fallback capability. Case Explanation is the first use case.

**Not authorized:**
- any AI-generated domain write;
- direct provider calls outside adapters;
- a global AI memory;
- provider conversation state as Loop memory.

**Defaults adopted with the architecture** (the privacy and security gates):
- **Data classes:** only OPERATIONAL data is sent to providers. Contact identifiers, communication
  content, workforce PII and sensitive fields are not sent (§7).
- **Bodies:** prompt and response bodies are not persisted in production. Manifests and validated
  artifacts are (§9).
- **Case Explanation access:** OWNER/ADMIN with `commercialIntelligence:view`, for organizations on the
  deployment's allowlist (§16; G6, G7 below).

**Activation gates.** A live call to a provider happens only when **every** gate holds. Until then the
task reports an honest "not configured" or "not enabled" state and makes no call. As built (AI-1, AI-2),
the gates are read by exactly one server-only module, `apps/web/src/ai/ai-environment.ts`, and enforced by
the pure `admitAiInvocation` and the durable reservation.

| Gate | What must be true | Where it lives |
|---|---|---|
| G0 Runtime enabled | `LOOP_AI_ENABLED` is exactly `true`. Anything else is OFF, and no provider client is even constructed. | Deployment environment (Netlify) |
| G1 Credentials | `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` present. **Presence means CONFIGURED, never ON.** Read only by the environment module, handed only to the SDK factory, never `NEXT_PUBLIC`, never logged, never echoed. | Deployment environment |
| G2 Provider terms | The provider is listed in **both** `LOOP_AI_PROVIDERS` and `LOOP_AI_PROVIDER_TERMS_CONFIRMED` — the second is the operator's record that its data terms (training, retention, region) were confirmed. | Deployment environment |
| G3 Models and routing | The task version has an entry in the reviewed, versioned routing policy: exact primary and fallback model ids, effort, deadline, output ceiling, price list. A task version the policy was not reviewed against is refused. | Routing policy file (code review) |
| G4 Budgets | A budget policy with per-call limits, a per-task daily cap, a per-organization daily cap and a global cap. Absent, unknown or zero means refused. Enforced in a serializable reservation. | Budget policy file (code review) + `ai_invocations` |
| G5 Kill switches | None of `LOOP_AI_KILL_SWITCHES` names this task, organization, provider or model, and none is `GLOBAL`. An unreadable entry is `GLOBAL`. | Deployment environment |
| G6 Organization and task | The organization is in `LOOP_AI_ORGANIZATIONS` and the task in `LOOP_AI_TASKS`. | Deployment environment |
| G7 Invoker | The person is an active OWNER or ADMIN member holding every required permission through `can()`; never AI_EMPLOYEE. | `iamAiAuthorizer` |

Environment changes reach a Netlify deployment on its **next deploy**, so these switches act in minutes,
not instantly. The approved Brain execution direction makes activation and kill switches **stored controls in
Neon**, read by Netlify and the AWS worker alike, with a master switch per deployable as a floor
(`brain-execution-architecture.md` §7; the control-plane design is in
`brain-execution-infrastructure.md` §17).
- **B4 stored them** (`ai_controls`, migration 36).
- **B5 enforces them for Brain work** (`brain-boundary.md` §8): the environment floor AND the recorded
  controls, where a missing grant means off.
- **No control has been recorded, and no workflow to record one exists yet.** Brain work is therefore
  refused even where the environment allows it.
- **This Netlify Case Explanation path still reads only these environment gates.** It stays OFF and is
  retired when Case Explanation moves to AWS (B7).

**If credentials are missing,** everything is built up to the adapter boundary and tested with recorded
fixtures, so the task can activate once G1–G6 are supplied.

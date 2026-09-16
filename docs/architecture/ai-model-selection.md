# AI model selection — verified record

**Verified 2026-09-16 against each provider's current official documentation. Nothing here is from memory.**
The machine-readable version is `packages/providers/src/ai/policy/model-catalog.ts`, and the routing
decision is `packages/providers/src/ai/policy/routing-policy.ts` (version `routing.2026-09-16.1`). Changing
either is a reviewed pull request.

## Primary — Anthropic Claude Opus 5

| | |
|---|---|
| Display name | Claude Opus 5 |
| API model id | `claude-opus-5` |
| Pinned? | Yes. Anthropic: "Every Claude model ID is a pinned snapshot, including the dateless IDs used from the 4.6 generation on." |
| Status | Active (latest), released 2026-07-24; retirement not sooner than 2027-07-24 |
| Context / max output | 1M tokens / 128K tokens (synchronous) |
| Knowledge cutoff | May 2026 |
| Pricing (list `anthropic-api-pricing-2026-09-16`) | $5 / MTok input, $25 / MTok output (cache read $0.50, unused) |
| Structured output | Native JSON schema via `output_config.format` (GA) |
| Thinking | Adaptive, on by default; depth via `output_config.effort` (`low`…`max`); sampling parameters rejected |
| Data retention (published) | API inputs/outputs deleted within 30 days by default; not used for training without express permission; ZDR by arrangement; **not** a 30-day-retention "Covered Model" |
| Sources | platform.claude.com/docs/en/about-claude/models/overview · …/models/opus-5/overview · …/about-claude/pricing · …/build-with-claude/structured-outputs · …/manage-claude/api-and-data-retention · privacy.claude.com commercial retention article |

**Why it fits Case Explanation.** The models overview says to start with Claude Opus 5 for most
workloads. Its strength is deep reasoning, at moderate latency, which an on-demand explanation inside
a 60-second web request needs. **Why not Claude Fable 5.1** (the most capable tier): it is slower,
costs twice as much ($10/$50), rejects a forced `tool_choice`, and **requires 30-day retention, so it
cannot run under Zero Data Retention.** Choosing it would be a Product decision with a retention
consequence.

**Known limits.** Output tokens include thinking, so the route ceiling (6,000) covers both. Latency on
real Case contexts is unmeasured until the first controlled request. Safety classifiers can return
`stop_reason: "refusal"`; Loop records that as an outcome. Anthropic's server-side refusal
`fallbacks` parameter is deliberately **not** used, because re-running a declined request on another
model conflicts with Loop's rule that a refusal is an outcome.

## Fallback — OpenAI GPT-6 Astra

| | |
|---|---|
| Display name | GPT-6 Astra |
| API model id | `gpt-6-astra` |
| Pinned? | The model page lists `gpt-6-astra` as its only snapshot. Aliases such as `gpt-5.6` are not used. Every call records the model OpenAI reports serving. |
| Status | Current flagship ("our flagship model for complex reasoning and coding") |
| Context / max output | 1.05M tokens (922K max input) / 128K tokens |
| Knowledge cutoff | 2026-04-30 |
| Pricing (list `openai-api-pricing-2026-09-16`) | $10 / MTok input, $50 / MTok output (cached input $1; prompts above 272K input cost more — Loop's per-call ceiling is 40K) |
| Structured output | Supported; Responses API `text.format` JSON schema, `strict: true` |
| Reasoning | `reasoning.effort` `low`…`max` |
| Data retention (published) | API data not used for training unless opted in; abuse-monitoring logs up to 30 days; Responses API stores for ≥30 days **unless `store: false`** (Loop always sends it); ZDR / Modified Abuse Monitoring need OpenAI approval |
| Sources | developers.openai.com/api/docs/models · …/models/gpt-6-astra · …/guides/structured-outputs · …/guides/your-data |

**Why it is the fallback.** It is OpenAI's documented flagship for complex reasoning, so an answer
served during a primary outage is held to a comparable standard. It serves only when the primary is
unavailable, rate limited or timed out. **The cheaper alternative** is `gpt-5.6-sol` ($4/$20), which
is a Product call.

## Runtime constraints that shaped the policy

- **Netlify synchronous functions have a fixed 60-second limit.** It is not configurable
  (docs.netlify.com/build/functions/configuration). The limits are therefore:
  - one attempt per target;
  - a 25 s primary deadline and a 20 s fallback deadline;
  - at least 10 s left for reads, reservations and reconciliation.
- **Node 22** is required by `openai` 7.15 and is the only non-EOL LTS both SDKs support. See PR #267.

## Assumptions that still need legal or Product confirmation

- **Whether EMG's Anthropic and OpenAI organizations have ZDR or other contractual terms in place.**
  The runtime records data handling as `UNCONFIRMED` until then (gate G2).
- The published retention periods above are documentation, not EMG's contract.
- **The budget figures are a proposal** (`budget.2026-09-16.1-proposed`):
  - worst case is about $0.70 per call;
  - worst case is about $35 per day across all enabled organizations.

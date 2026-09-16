// The reviewed routing and budget policy for AI tasks. Slice AI-4.
//
// CHANGING THE MODEL THAT ANSWERS IS A PULL REQUEST. The routing policy names exact,
// pinned model ids from the verified catalog, with a version that is recorded on
// every call. A new model, a different effort, a longer deadline or a looser budget
// is a new version of this file, reviewed like any other change.
//
// EVERY ENTRY IS ONE TASK'S DECISION. There is no platform-wide primary and no
// universal fallback order: each task version names its own primary, and may be served
// by another approved provider only when its own entry says `fallbackPermitted` and
// names that target. The choices below are Case Explanation's.
//
// CASE EXPLANATION'S PRIMARY: Claude Opus 5 (Anthropic). The models overview recommends it as the
// starting point for most workloads, and it is strong on the reasoning this task
// needs. It is also eligible for Zero Data Retention, which Claude Fable 5.1 -- the
// more capable, slower and twice as expensive tier -- is not, because Fable 5.1
// requires 30-day retention. For an on-demand explanation that must return inside a
// web request, Opus 5 is the appropriate choice; moving to Fable 5.1 would be a
// Product decision with a retention consequence.
//
// CASE EXPLANATION'S FALLBACK: GPT-6 Astra (OpenAI), which OpenAI documents as its most
// capable model, so a fallback answer is held to a comparable standard. It is this
// task's permitted fallback, not OpenAI's standing role behind Anthropic. Fallback is AVAILABILITY
// behaviour only: it serves when the primary is unavailable, rate limited or timed
// out -- never after a refusal, a rejected answer, an authentication failure or a bad
// request, and never to get a second opinion.
//
// PROVIDER SPECIALIZATION (B2). Case Explanation declares the TECHNICAL_ANALYSIS
// capability route, whose preferred provider is Anthropic
// (provider-specialization.ts). The primary above follows that preference, so this
// entry needs no `providerChoiceReason`. This version's models, efforts, deadlines and
// limits are exactly as reviewed; B2 changed only this comment.
//
// THE DEADLINES FIT THE PLATFORM. Netlify runs a server action inside a synchronous
// function with a fixed 60-second limit. The primary's 25 seconds plus the fallback's
// 20, with one attempt each, leaves room for the reads, the reservations and the
// reconciliation around them.
//
// THE BUDGET IS A PROPOSAL UNTIL MATT APPROVES IT. The figures below bound the worst
// case -- every call falling back to the dearer model at its per-call ceiling -- to
// roughly $0.70 a call and $35 a day across every enabled organization.

import type { AiBudgetPolicy, AiRouteTargetPolicy, AiRoutingPolicy } from '@emgloop/shared';

import { aiCatalogModel } from './model-catalog';

/** The synchronous function limit on Netlify, which a web-request AI call must fit inside. */
export const AI_PLATFORM_REQUEST_LIMIT_MS = 60_000;
/** Calls per route target. One: a retry would not fit the platform limit alongside a fallback. */
export const AI_MAX_ATTEMPTS_PER_TARGET = 1;

function target(
  providerId: 'anthropic' | 'openai',
  modelId: string,
  limits: Pick<AiRouteTargetPolicy, 'reasoningEffort' | 'timeoutMs' | 'maxOutputTokens'>,
): AiRouteTargetPolicy {
  const model = aiCatalogModel(providerId, modelId);
  if (!model) throw new Error(`routing policy names a model the catalog does not: ${providerId}/${modelId}`);
  return Object.freeze({ providerId, modelId, ...limits, pricing: model.pricing });
}

// .2: reviewed against Case Explanation task 2.0.0 (sectioned answer, per-source figures).
export const AI_ROUTING_POLICY_VERSION = 'routing.2026-09-16.2';

export const AI_ROUTING_POLICY: AiRoutingPolicy = Object.freeze({
  version: AI_ROUTING_POLICY_VERSION,
  tasks: Object.freeze({
    'case.explanation': Object.freeze({
      taskId: 'case.explanation',
      taskVersion: '2.0.0',
      // Thinking tokens count against the output ceiling on both providers, so it is
      // sized for reasoning plus a structured answer, not for the answer alone.
      primary: target('anthropic', 'claude-opus-5', { reasoningEffort: 'medium', timeoutMs: 25_000, maxOutputTokens: 6_000 }),
      fallback: target('openai', 'gpt-6-astra', { reasoningEffort: 'medium', timeoutMs: 20_000, maxOutputTokens: 6_000 }),
      fallbackPermitted: true,
      budgetClass: 'case-explanation',
    }),
  }),
});

export const AI_BUDGET_POLICY_VERSION = 'budget.2026-09-16.1-proposed';

export const AI_BUDGET_POLICY: AiBudgetPolicy = Object.freeze({
  version: AI_BUDGET_POLICY_VERSION,
  classes: Object.freeze({
    'case-explanation': Object.freeze({
      maxInputTokensPerCall: 40_000,
      maxOutputTokensPerCall: 6_000,
      taskDaily: Object.freeze({ maxInvocations: 20, maxInputTokens: 800_000, maxOutputTokens: 120_000 }),
    }),
  }),
  organizationDaily: Object.freeze({ maxInvocations: 30, maxInputTokens: 1_200_000, maxOutputTokens: 180_000 }),
  globalDaily: Object.freeze({ maxInvocations: 50, maxInputTokens: 2_000_000, maxOutputTokens: 300_000 }),
});

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
// .3 (2026-09-18, GM-3): adds Mail Reply Draft 1.0.0. Its route is COMMUNICATION, whose reviewed
// preference is OpenAI -- "work whose main output is language meant for a person" is exactly a
// reply somebody will send -- so the primary follows the preference and needs no written
// departure. The fallback is Anthropic, because a draft that cannot be produced is a person
// typing it themselves, not an outage worth failing over twice for.
// .4 (2026-09-21, content-triage): adds Telegram Content Triage 1.0.0. Its route is
// GENERAL_REASONING, which has NO default provider, so this entry names one and says why
// (`providerChoiceReason`): a conservative single-message actionability judgment is general
// reasoning, and Claude Opus 5 is the reviewed primary for it, with GPT-6 Astra as the availability
// fallback. Both run at LOW effort with a SMALL output ceiling -- the verdict is a few fields, not
// prose -- and the deadlines are short because this is a background sweep, not a person waiting.
// .5 (2026-09-21, schema fix): Telegram Content Triage moves to task 1.1.0. Its output schema drops
// the structured-output keywords Anthropic rejects (a 400), and the length bounds it dropped are now
// enforced in `validateAiTaskOutput`; this route's `taskVersion` moves in lockstep with the task.
// .6 (2026-09-21, conversation-triage v2): Telegram Content Triage moves to task 2.0.0. It now reads a
// bounded recent CONVERSATION and returns the still-unresolved obligations (historical backfill and the
// forward path share one contract). The provider, effort, deadlines and budget class are UNCHANGED --
// the reviewed 8000-token input cap and the shared daily ceilings still bind, and the adaptive window
// keeps every chunk inside that cap. This route's `taskVersion` moves in lockstep with the task.
// .7 (2026-09-22, conversation-triage v2.1): Telegram Content Triage moves to task 2.1.0. Each obligation
// now carries minimized business context (what happened, the topic, the next step, a GROUNDED deadline)
// and the conversation is named by Telegram's own label. Provider, effort, deadlines, output ceiling and
// budget class are UNCHANGED: the same 1000-token output ceiling holds the richer (still small) answer.
// .8 (2026-09-25, Chats Intelligence): Telegram Content Triage moves to task 3.0.0 (output schema v4). The
// SAME one call now also returns a minimized reading of the whole conversation, stored as the person's
// private CHATS digest -- no second call, no new task. Provider, effort and deadlines are UNCHANGED. The
// OUTPUT CEILING rises 1000 -> 2000 on both targets: the v4 answer's worst case (eight obligations plus a
// full conversation reading) no longer fits 1000 tokens, and an answer cut off at the ceiling is not a
// smaller answer, it is invalid JSON -- a FAILED call that holds the frontier and is re-run, i.e. spends
// again. The budget class moves with it (budget .4-proposed below).
export const AI_ROUTING_POLICY_VERSION = 'routing.2026-09-25.8';

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
    // GM-3. Smaller ceilings than an explanation: a reply is a few hundred words, and the
    // deadlines leave room inside the platform's 60-second synchronous limit for the thread read
    // that precedes the call.
    'mail.reply.draft': Object.freeze({
      taskId: 'mail.reply.draft',
      taskVersion: '1.0.0',
      primary: target('openai', 'gpt-6-astra', { reasoningEffort: 'low', timeoutMs: 20_000, maxOutputTokens: 2_000 }),
      fallback: target('anthropic', 'claude-opus-5', { reasoningEffort: 'low', timeoutMs: 15_000, maxOutputTokens: 2_000 }),
      fallbackPermitted: true,
      budgetClass: 'mail-reply-draft',
    }),
    // content-triage. A background conversation review: LOW effort, a SMALL output ceiling (each
    // obligation is a category, a few short paraphrase fields and an anchor; at most eight, plus a
    // bounded conversation reading and a few limitations), and short deadlines because nothing is
    // waiting on it interactively.
    // GENERAL_REASONING has no default provider, so `providerChoiceReason` records why Anthropic
    // Claude Opus 5 is the reviewed primary; GPT-6 Astra is the availability fallback, never a second opinion.
    'telegram.content.triage': Object.freeze({
      taskId: 'telegram.content.triage',
      taskVersion: '3.0.0',
      primary: target('anthropic', 'claude-opus-5', { reasoningEffort: 'low', timeoutMs: 20_000, maxOutputTokens: 2_000 }),
      fallback: target('openai', 'gpt-6-astra', { reasoningEffort: 'low', timeoutMs: 15_000, maxOutputTokens: 2_000 }),
      fallbackPermitted: true,
      budgetClass: 'telegram-content-triage',
      providerChoiceReason:
        'GENERAL_REASONING has no default provider. Claude Opus 5 is the reviewed primary for a ' +
        'conservative conversation-review actionability judgment; GPT-6 Astra is the availability fallback.',
    }),
  }),
});

// .2 (GM-3): adds the mail-reply-draft class and raises the organization and global ceilings to
// cover it. Still a proposal until Matt approves the figures.
// .3 (content-triage): adds the telegram-content-triage class WITHOUT raising the organization or
// global ceilings -- the shared caps (and the worst-case guardrail that keeps them under $50/day
// across every organization) stay exactly as reviewed, and triage sweeps run INSIDE that envelope.
// Its per-message call is cheaper than a draft; the shared caps bind first, by design. Still a
// proposal until Matt approves the figures -- and the runtime is OFF, so nothing spends against it.
// .4 (2026-09-25, Chats Intelligence): the telegram-content-triage class's per-call OUTPUT cap follows the
// route's ceiling, 1000 -> 2000, and its daily OUTPUT tokens 50k -> 100k so the same 50 daily invocations
// still fit (the ledger reserves each call at its ceiling). Its invocation cap, its input caps, and the
// organization and global ceilings are UNCHANGED -- they still bind first. Still a proposal.
export const AI_BUDGET_POLICY_VERSION = 'budget.2026-09-25.4-proposed';

export const AI_BUDGET_POLICY: AiBudgetPolicy = Object.freeze({
  version: AI_BUDGET_POLICY_VERSION,
  classes: Object.freeze({
    'case-explanation': Object.freeze({
      maxInputTokensPerCall: 40_000,
      maxOutputTokensPerCall: 6_000,
      taskDaily: Object.freeze({ maxInvocations: 20, maxInputTokens: 800_000, maxOutputTokens: 120_000 }),
    }),
    // A drafting task is used far more often than an investigation and costs far less per call:
    // one conversation in, a few hundred words out. The daily ceiling is what one person can
    // plausibly send in a day, not what a mailbox could ask for.
    'mail-reply-draft': Object.freeze({
      maxInputTokensPerCall: 20_000,
      maxOutputTokensPerCall: 2_000,
      taskDaily: Object.freeze({ maxInvocations: 50, maxInputTokens: 800_000, maxOutputTokens: 120_000 }),
    }),
    // A per-conversation triage: one bounded window in, a few fields and a short reading out. Cheaper per call than a draft,
    // but run far more often, so the daily invocation ceiling -- not the token ceiling -- is what
    // bounds one person's sweep. There is no all-message option: past a day's cap, the sweep simply
    // does not triage more, which fails safe (no verdict, no WorkItem).
    'telegram-content-triage': Object.freeze({
      maxInputTokensPerCall: 8_000,
      maxOutputTokensPerCall: 2_000,
      // Bounded to sit INSIDE the existing organization/global envelope (which the worst-case
      // guardrail keeps under $50/day across every organization): the shared caps bind first, and
      // that is the point -- adding a per-message task must not raise the platform's daily ceiling.
      taskDaily: Object.freeze({ maxInvocations: 50, maxInputTokens: 400_000, maxOutputTokens: 100_000 }),
    }),
  }),
  // The ceilings still bound the WORST case, which is every call being the dearest class at its
  // per-call limit: 70 x ~$0.70 is under the $50 a day this policy promises. Drafting is far
  // cheaper than that per call, so in practice the drafting class buys many more than 70 replies
  // -- the global number is a blast radius, not a forecast.
  organizationDaily: Object.freeze({ maxInvocations: 60, maxInputTokens: 2_000_000, maxOutputTokens: 300_000 }),
  globalDaily: Object.freeze({ maxInvocations: 70, maxInputTokens: 3_000_000, maxOutputTokens: 450_000 }),
});

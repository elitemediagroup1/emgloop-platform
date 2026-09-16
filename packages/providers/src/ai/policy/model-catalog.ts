// The models Loop may route to, as verified against each provider's CURRENT official
// documentation. Slice AI-4.
//
// NOTHING HERE IS FROM MEMORY. Every entry names the page it was read from and the
// day it was read. An entry is a record of what the provider published, not a
// judgement about the model. When a provider retires or replaces a model, this file
// changes in a reviewed pull request -- the routing policy never follows an alias
// quietly.
//
// PINNED IDS ONLY. Anthropic states that every Claude model ID, including the
// dateless ones from the 4.6 generation on, is a pinned snapshot. OpenAI lists each
// model's snapshots and aliases on the model's own page; the ids below are the ones
// it lists as snapshots, and the `gpt-5.6` style aliases are deliberately not used.
// Every call still records the model the provider REPORTS serving, so a change on
// their side is visible on ours.
//
// DATA HANDLING IS NOT A DOCUMENTATION CLAIM. `dataHandling` stays UNCONFIRMED until
// the organization's contractual terms are confirmed (activation gate G2). What the
// public documentation says is recorded in `dataHandlingPublished` for the dossier,
// and is not treated as a commitment.

import type { AiModelCapabilities, AiModelPricing } from '@emgloop/shared';

export interface AiCatalogModel {
  readonly providerId: 'anthropic' | 'openai';
  /** The exact API model id. */
  readonly modelId: string;
  readonly displayName: string;
  /** True when the provider documents this id as a fixed snapshot, not a moving alias. */
  readonly pinned: true;
  readonly status: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly knowledgeCutoff: string;
  readonly retirement: string | null;
  readonly pricing: AiModelPricing;
  readonly reasoningEfforts: readonly string[];
  readonly structuredOutputs: 'NATIVE_JSON_SCHEMA';
  readonly dataHandlingPublished: string;
  readonly sources: readonly string[];
  /** The day the sources were read. */
  readonly verifiedOn: string;
}

export const ANTHROPIC_PRICE_LIST = 'anthropic-api-pricing-2026-09-16';
export const OPENAI_PRICE_LIST = 'openai-api-pricing-2026-09-16';

export const AI_MODEL_CATALOG: readonly AiCatalogModel[] = Object.freeze([
  Object.freeze({
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    pinned: true,
    // "Active (latest)", released 2026-07-24; the models overview recommends starting
    // with it "for most workloads".
    status: 'Active (latest); released 2026-07-24',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    knowledgeCutoff: 'May 2026 (reliable and training data)',
    retirement: 'Not sooner than 2027-07-24',
    // $5 / MTok input, $25 / MTok output; cache reads $0.50 / MTok (unused by Loop).
    pricing: Object.freeze({ listVersion: ANTHROPIC_PRICE_LIST, inputMicrosPerToken: 5, outputMicrosPerToken: 25 }),
    reasoningEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    structuredOutputs: 'NATIVE_JSON_SCHEMA',
    dataHandlingPublished:
      'API inputs and outputs deleted within 30 days by default; not used for training without express permission; ' +
      'Zero Data Retention available by arrangement, and Claude Opus 5 is not a 30-day-retention "Covered Model".',
    sources: Object.freeze([
      'https://platform.claude.com/docs/en/about-claude/models/overview',
      'https://platform.claude.com/docs/en/models/opus-5/overview',
      'https://platform.claude.com/docs/en/about-claude/pricing',
      'https://platform.claude.com/docs/en/build-with-claude/structured-outputs',
      'https://platform.claude.com/docs/en/manage-claude/api-and-data-retention',
      'https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data',
    ]),
    verifiedOn: '2026-09-16',
  }),
  Object.freeze({
    providerId: 'openai',
    modelId: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    pinned: true,
    // "our flagship model for complex reasoning and coding"; the page lists
    // `gpt-6-astra` as its only snapshot.
    status: 'Current flagship',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    knowledgeCutoff: '2026-04-30',
    retirement: null,
    // $10 / MTok input, $50 / MTok output (prompts above 272K input tokens cost more;
    // Loop's per-call input ceiling is far below that).
    pricing: Object.freeze({ listVersion: OPENAI_PRICE_LIST, inputMicrosPerToken: 10, outputMicrosPerToken: 50 }),
    reasoningEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    structuredOutputs: 'NATIVE_JSON_SCHEMA',
    dataHandlingPublished:
      'API data not used for training unless the customer opts in; abuse-monitoring logs retained up to 30 days; ' +
      'Responses API stores responses for at least 30 days unless store=false (Loop always sends store=false); ' +
      'Zero Data Retention and Modified Abuse Monitoring require OpenAI approval.',
    sources: Object.freeze([
      'https://developers.openai.com/api/docs/models',
      'https://developers.openai.com/api/docs/models/gpt-6-astra',
      'https://developers.openai.com/api/docs/guides/structured-outputs',
      'https://developers.openai.com/api/docs/guides/your-data',
    ]),
    verifiedOn: '2026-09-16',
  }),
]);

export function aiCatalogModel(providerId: string, modelId: string): AiCatalogModel | null {
  return AI_MODEL_CATALOG.find((m) => m.providerId === providerId && m.modelId === modelId) ?? null;
}

/**
 * What the runtime is told about a model. Documented limits are declared; data
 * handling stays UNCONFIRMED until a contract says otherwise (gate G2), which keeps
 * such a model ineligible for anything above OPERATIONAL data.
 */
export function aiCatalogCapabilities(providerId: string, modelId: string): AiModelCapabilities {
  const model = aiCatalogModel(providerId, modelId);
  return {
    providerId,
    modelId,
    structuredOutput: model ? model.structuredOutputs : 'NONE',
    tools: false,
    streaming: false,
    contextWindowTokens: model?.contextWindowTokens ?? 0,
    maxOutputTokens: model?.maxOutputTokens ?? 0,
    promptCaching: false,
    dataHandling: 'UNCONFIRMED',
    region: null,
  };
}

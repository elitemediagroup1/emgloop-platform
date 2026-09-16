// The OpenAI adapter. Slices B5 and AI-3 -- NOT ACTIVATED by anything in this file.
//
// The sibling of the Anthropic adapter, and deliberately its equal: same interface,
// same failure taxonomy, same injected client, same silence about credentials, same
// rendering of the evidence. A test keeps the two symmetric.
//
// NOTHING IS STORED AT THE PROVIDER. The Responses API stores responses for at least
// 30 days unless told not to (SDK documentation, verified 2026-09-16). Every request
// sends `store: false`, so Loop's evidence and the model's answer are not retained
// for retrieval. (Abuse-monitoring retention is a separate, contractual matter.)
//
// STRUCTURED OUTPUT NATIVELY, with `strict: true`. Depth is `reasoning.effort` from
// the routing policy; no sampling parameter is sent. NO TOOL IS EVER SENT.
//
// ONLY `completed` IS AN ANSWER. A refusal item is a refusal; `incomplete` is
// truncated, filtered or otherwise unfinished; `failed` is a failure, classified by
// its code and never by its message.
//
// USAGE IS TOTAL INPUT. OpenAI's input count already includes cached tokens, and its
// output count already includes reasoning tokens; both details are noted. Absent
// usage is null, never zero.

import type { AiContentBlock, AiModelCapabilities, AiModelRequest, AiModelResult, AiUsage } from '@emgloop/shared';

import { ModelProviderError, type ModelProvider } from '../model-provider';
import { renderAiSources } from '../source-rendering';
import { classifyProviderError, providerFailureMessage, retryAfterMs } from './failure-mapping';

export const OPENAI_PROVIDER_ID = 'openai';

interface OpenAiResponse {
  id?: string;
  model?: string;
  status?: string | null;
  error?: { code?: string | null } | null;
  incomplete_details?: { reason?: string | null } | null;
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number } | null;
    output_tokens_details?: { reasoning_tokens?: number } | null;
  } | null;
}

/** The part of the SDK this adapter uses. Structural, so the SDK's types stay inside. */
export interface OpenAiResponsesClient {
  responses: {
    create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<OpenAiResponse>;
  };
}

export interface OpenAiAdapterDeps {
  readonly client: OpenAiResponsesClient;
  readonly capabilities: (modelId: string) => AiModelCapabilities;
  readonly now?: () => number;
}

export class OpenAiAdapter implements ModelProvider {
  readonly providerId = OPENAI_PROVIDER_ID;

  constructor(private readonly deps: OpenAiAdapterDeps) {}

  capabilities(modelId: string): AiModelCapabilities {
    return this.deps.capabilities(modelId);
  }

  async invoke(request: AiModelRequest, signal: AbortSignal): Promise<AiModelResult> {
    if (request.tools.length > 0) {
      throw new ModelProviderError('POLICY_DENIED', this.providerId, 'provider failure: POLICY_DENIED');
    }
    const now = this.deps.now ?? (() => Date.now());
    const startedAt = now();
    const structured = request.output.kind === 'JSON_SCHEMA';

    const body: Record<string, unknown> = {
      model: request.model.modelId,
      instructions: request.instructions,
      input: renderAiSources(request.input as readonly AiContentBlock[]),
      max_output_tokens: request.limits.maxOutputTokens,
      store: false,
      reasoning: { effort: request.reasoningEffort },
      ...(request.output.kind === 'JSON_SCHEMA'
        ? {
            text: {
              format: {
                type: 'json_schema',
                name: request.output.schemaId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64),
                schema: request.output.schema,
                strict: true,
              },
            },
          }
        : {}),
    };

    let response: OpenAiResponse;
    try {
      response = await this.deps.client.responses.create(body, { signal });
    } catch (err) {
      const failure = signal.aborted ? 'CANCELLED' : classifyProviderError(err);
      throw new ModelProviderError(failure, this.providerId, providerFailureMessage(failure, err), retryAfterMs(err));
    }

    if (response.status === 'failed') {
      const failure = classifyProviderError({ error: { code: response.error?.code ?? undefined } });
      const cls = failure === 'UNCLASSIFIED' ? 'UNAVAILABLE' : failure;
      throw new ModelProviderError(cls, this.providerId, providerFailureMessage(cls, null));
    }

    const refused = (response.output ?? [])
      .flatMap((item) => item.content ?? [])
      .some((c) => c.type === 'refusal' || (typeof c.refusal === 'string' && c.refusal.length > 0));
    const stopReason = stopReasonOf(response, refused);
    const text = response.output_text ?? textOf(response.output);

    return {
      output: structured ? (stopReason === 'END' ? { json: safeJson(text) } : {}) : { text },
      toolCalls: [],
      stopReason,
      usage: usageOf(response.usage),
      providerRequestId: response.id ?? null,
      reportedModel: response.model ?? null,
      latencyMs: now() - startedAt,
    };
  }
}

function textOf(output: OpenAiResponse['output']): string {
  return (output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((c) => c.type === 'output_text' || c.type === undefined)
    .map((c) => c.text ?? '')
    .join('');
}

function stopReasonOf(response: OpenAiResponse, refused: boolean): AiModelResult['stopReason'] {
  if (refused) return 'REFUSAL';
  if (response.status === 'completed') return 'END';
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason;
    if (reason === 'max_output_tokens') return 'MAX_TOKENS';
    if (reason === 'content_filter') return 'CONTENT_FILTERED';
  }
  // incomplete for another reason, queued, in_progress, cancelled, or anything newer.
  return 'INCOMPLETE';
}

function usageOf(usage: OpenAiResponse['usage']): AiUsage | null {
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;
  const cached = usage.input_tokens_details?.cached_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(typeof cached === 'number' && cached > 0 ? { cachedInputTokens: cached } : {}),
    ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not the shape asked for. The runtime rejects the answer whole rather than
    // showing half of it; this only decides that there is nothing to show.
    return undefined;
  }
}

// The Anthropic adapter. Slices B5 and AI-3 -- NOT ACTIVATED by anything in this file.
//
// It maps Loop's provider-neutral request onto the Messages API and the response
// back. It does not create its own client, read an environment variable, choose a
// model, retry, or decide anything; the client is injected (built by sdk-clients.ts
// from a credential the server-only environment boundary handed it), the model and
// effort come from the reviewed routing policy, and the gateway owns retries.
//
// STRUCTURED OUTPUT THROUGH `output_config.format`. The Messages API accepts a JSON
// schema natively (GA; verified against platform.claude.com/docs structured outputs,
// 2026-09-16), and the answer arrives as the text block. The earlier forced-tool
// approach is gone: current models run adaptive thinking by default, and some reject
// a forced `tool_choice` outright. NO TOOL IS EVER SENT.
//
// EFFORT, NOT SAMPLING. Current models reject temperature and budget_tokens; depth is
// `output_config.effort`, taken from the routing policy. Thinking is left at the
// model's default (adaptive), and its tokens count against `max_tokens` -- which is
// why the routing policy's output ceiling is sized for it.
//
// ONLY `end_turn` IS AN ANSWER. `max_tokens` is truncated; a paused turn or an
// exhausted context window is incomplete; `refusal` is a refusal. None of them is
// parsed as an answer.
//
// USAGE IS TOTAL INPUT. Anthropic reports uncached input separately from cache reads
// and writes; Loop records the sum as input, with cache reads also noted, so a budget
// counts every token processed. Absent usage is null, never zero.

import type { AiContentBlock, AiModelCapabilities, AiModelRequest, AiModelResult, AiUsage } from '@emgloop/shared';

import { ModelProviderError, type ModelProvider } from '../model-provider';
import { renderAiSources } from '../source-rendering';
import { classifyProviderError, providerFailureMessage, retryAfterMs } from './failure-mapping';

export const ANTHROPIC_PROVIDER_ID = 'anthropic';

/** The part of the SDK this adapter uses. Structural, so the SDK's types stay inside. */
export interface AnthropicMessagesClient {
  messages: {
    create(
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<{
      id?: string;
      model?: string;
      stop_reason?: string | null;
      content?: Array<{ type: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        output_tokens_details?: { thinking_tokens?: number } | null;
      } | null;
    }>;
  };
}

export interface AnthropicAdapterDeps {
  readonly client: AnthropicMessagesClient;
  /** Declared per model and confirmed against a contract; never assumed here. */
  readonly capabilities: (modelId: string) => AiModelCapabilities;
  readonly now?: () => number;
}

export class AnthropicAdapter implements ModelProvider {
  readonly providerId = ANTHROPIC_PROVIDER_ID;

  constructor(private readonly deps: AnthropicAdapterDeps) {}

  capabilities(modelId: string): AiModelCapabilities {
    return this.deps.capabilities(modelId);
  }

  async invoke(request: AiModelRequest, signal: AbortSignal): Promise<AiModelResult> {
    // No task publishes a tool at launch, and none may write. A request carrying one
    // is refused here too, before anything is sent.
    if (request.tools.length > 0) {
      throw new ModelProviderError('POLICY_DENIED', this.providerId, 'provider failure: POLICY_DENIED');
    }
    const now = this.deps.now ?? (() => Date.now());
    const startedAt = now();
    const structured = request.output.kind === 'JSON_SCHEMA';

    const body: Record<string, unknown> = {
      model: request.model.modelId,
      max_tokens: request.limits.maxOutputTokens,
      system: request.instructions,
      messages: [{ role: 'user', content: renderAiSources(request.input as readonly AiContentBlock[]) }],
      output_config: {
        effort: request.reasoningEffort,
        ...(request.output.kind === 'JSON_SCHEMA' ? { format: { type: 'json_schema', schema: request.output.schema } } : {}),
      },
    };

    let response: Awaited<ReturnType<AnthropicMessagesClient['messages']['create']>>;
    try {
      response = await this.deps.client.messages.create(body, { signal });
    } catch (err) {
      const failure = signal.aborted ? 'CANCELLED' : classifyProviderError(err);
      throw new ModelProviderError(failure, this.providerId, providerFailureMessage(failure, err), retryAfterMs(err));
    }

    const stopReason = stopReasonOf(response.stop_reason ?? null);
    const text = (response.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    return {
      output: structured ? (stopReason === 'END' ? { json: safeJson(text) } : {}) : { text },
      toolCalls: [],
      stopReason,
      usage: usageOf(response.usage),
      providerRequestId: response.id ?? null,
      // What actually served it, which is not always what was asked for.
      reportedModel: response.model ?? null,
      latencyMs: now() - startedAt,
    };
  }
}

function stopReasonOf(raw: string | null): AiModelResult['stopReason'] {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'END';
    case 'max_tokens':
      return 'MAX_TOKENS';
    case 'refusal':
      return 'REFUSAL';
    case 'tool_use':
      return 'TOOL_USE';
    default:
      // pause_turn, model_context_window_exceeded, null, or anything newer.
      return 'INCOMPLETE';
  }
}

function usageOf(usage: NonNullable<Awaited<ReturnType<AnthropicMessagesClient['messages']['create']>>['usage']> | null | undefined): AiUsage | null {
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;
  const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
  const cacheWrite = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
  const thinking = usage.output_tokens_details?.thinking_tokens;
  return {
    inputTokens: usage.input_tokens + cacheRead + cacheWrite,
    outputTokens: usage.output_tokens,
    ...(cacheRead > 0 ? { cachedInputTokens: cacheRead } : {}),
    ...(typeof thinking === 'number' ? { reasoningTokens: thinking } : {}),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not the shape asked for. The runtime rejects the answer whole.
    return undefined;
  }
}

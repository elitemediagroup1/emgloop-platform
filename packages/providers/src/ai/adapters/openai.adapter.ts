// The OpenAI adapter. Slice B5 (S1 preparation) -- NOT ACTIVATED.
//
// The sibling of the Anthropic adapter, and deliberately its equal: same interface,
// same failure taxonomy, same injected client, same silence about credentials. If
// one of these two files ever gains a capability the other lacks, the runtime above
// them stops being provider-neutral, and a test asserts the two stay symmetric.
//
// STRUCTURED OUTPUT NATIVELY. OpenAI accepts a JSON schema directly, so a
// schema-bound task says so and the response is parsed. Anthropic reaches the same
// contract through a forced tool. THAT DIFFERENCE LIVES HERE AND NOWHERE ELSE --
// which is the whole reason adapters exist.
//
// NO TOOLS ARE PUBLISHED. The runtime refuses a tool that writes, and no task has
// one; this adapter sends none at all.

import type { AiContentBlock, AiModelCapabilities, AiModelRequest, AiModelResult } from '@emgloop/shared';

import { ModelProviderError, type ModelProvider } from '../model-provider';
import { classifyProviderError, retryAfterMs } from './failure-mapping';

export const OPENAI_PROVIDER_ID = 'openai';

/** The part of the SDK this adapter uses. Structural, so the SDK's types stay inside. */
export interface OpenAiResponsesClient {
  responses: {
    create(
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<{
      id?: string;
      model?: string;
      status?: string | null;
      incomplete_details?: { reason?: string } | null;
      output_text?: string;
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
      usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
    }>;
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
    const now = this.deps.now ?? (() => Date.now());
    const startedAt = now();
    const structured = request.output.kind === 'JSON_SCHEMA';

    const body: Record<string, unknown> = {
      model: request.model.modelId,
      instructions: request.instructions,
      input: request.input.map(asBlock).join('\n\n'),
      max_output_tokens: request.limits.maxOutputTokens,
      ...(structured && request.output.kind === 'JSON_SCHEMA'
        ? {
            text: {
              format: { type: 'json_schema', name: request.output.schemaId.replace(/[^A-Za-z0-9_]/g, '_'), schema: request.output.schema, strict: true },
            },
          }
        : {}),
    };

    try {
      const response = await this.deps.client.responses.create(body, { signal });
      const refusal = (response.output ?? [])
        .flatMap((item) => item.content ?? [])
        .find((c) => typeof c.refusal === 'string' && c.refusal.length > 0);
      const text = response.output_text ?? textOf(response.output);

      return {
        output: structured && !refusal ? { json: safeJson(text) } : { text },
        toolCalls: [],
        stopReason: stopReasonOf(response, Boolean(refusal)),
        usage: {
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          ...(response.usage?.input_tokens_details?.cached_tokens !== undefined
            ? { cachedInputTokens: response.usage.input_tokens_details.cached_tokens }
            : {}),
        },
        providerRequestId: response.id ?? null,
        reportedModel: response.model ?? null,
        latencyMs: now() - startedAt,
      };
    } catch (err) {
      if (signal.aborted) throw new ModelProviderError('CANCELLED', this.providerId, 'cancelled');
      throw new ModelProviderError(classifyProviderError(err), this.providerId, messageOf(err), retryAfterMs(err));
    }
  }
}

function asBlock(block: AiContentBlock): string {
  return `[${block.trust} | source: ${block.sourceRef}]\n${block.content}`;
}

function textOf(output: OpenAiResponsesClient extends never ? never : { content?: Array<{ text?: string }> }[] | undefined): string {
  return (output ?? []).flatMap((item) => item.content ?? []).map((c) => c.text ?? '').join('');
}

function stopReasonOf(
  response: { status?: string | null; incomplete_details?: { reason?: string } | null },
  refused: boolean,
): AiModelResult['stopReason'] {
  if (refused) return 'REFUSAL';
  if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') return 'MAX_TOKENS';
  if (response.status === 'incomplete' && response.incomplete_details?.reason === 'content_filter') return 'CONTENT_FILTERED';
  return 'END';
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

function messageOf(err: unknown): string {
  const message = (err as { message?: unknown })?.message;
  return typeof message === 'string' ? message : 'provider error';
}

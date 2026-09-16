// The Anthropic adapter. Slice B5 (S1 preparation) -- NOT ACTIVATED.
//
// This file and its OpenAI sibling are the only places in Loop that may import a
// model SDK. Everything above them speaks `AiModelRequest` / `AiModelResult`, so the
// runtime has no idea which vendor answered and no behaviour anywhere branches on
// one.
//
// IT DOES NOT CREATE ITS OWN CLIENT. The client is injected. That is what lets every
// test drive this adapter with no credential and no network, and it is why nothing
// here reads an environment variable: a runtime that can build its own client can
// make a call nobody authorized.
//
// STRUCTURED OUTPUT VIA A FORCED TOOL. Anthropic has no native JSON-schema response
// mode, so a schema-bound task is expressed as a single tool the model must call,
// and the tool's input IS the answer. The tool WRITES NOTHING -- it is a shape, not a
// capability, and the runtime refuses any tool that claims otherwise.
//
// TRUST TRAVELS WITH THE CONTENT. Each block says what it is and where it came from,
// so the instruction can tell the model that a human-reported line is not a Loop fact.

import type { AiContentBlock, AiModelCapabilities, AiModelRequest, AiModelResult } from '@emgloop/shared';

import { ModelProviderError, type ModelProvider } from '../model-provider';
import { classifyProviderError, retryAfterMs } from './failure-mapping';

export const ANTHROPIC_PROVIDER_ID = 'anthropic';
const STRUCTURED_TOOL = 'loop_structured_answer';

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
      content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
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
    const now = this.deps.now ?? (() => Date.now());
    const startedAt = now();
    const structured = request.output.kind === 'JSON_SCHEMA';

    const body: Record<string, unknown> = {
      model: request.model.modelId,
      max_tokens: request.limits.maxOutputTokens,
      system: request.instructions,
      messages: [{ role: 'user', content: request.input.map(asBlock).join('\n\n') }],
      ...(request.sampling?.temperature !== undefined ? { temperature: request.sampling.temperature } : {}),
      ...(structured && request.output.kind === 'JSON_SCHEMA'
        ? {
            tools: [{ name: STRUCTURED_TOOL, description: 'Return the answer in the required shape.', input_schema: request.output.schema }],
            tool_choice: { type: 'tool', name: STRUCTURED_TOOL },
          }
        : {}),
    };

    try {
      const response = await this.deps.client.messages.create(body, { signal });
      const toolUse = (response.content ?? []).find((b) => b.type === 'tool_use' && b.name === STRUCTURED_TOOL);
      const text = (response.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      return {
        output: structured ? { json: toolUse?.input } : { text },
        toolCalls: [],
        stopReason: stopReasonOf(response.stop_reason ?? null, Boolean(toolUse)),
        usage: {
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          ...(response.usage?.cache_read_input_tokens !== undefined
            ? { cachedInputTokens: response.usage.cache_read_input_tokens }
            : {}),
        },
        providerRequestId: response.id ?? null,
        // What actually served it, which is not always what was asked for.
        reportedModel: response.model ?? null,
        latencyMs: now() - startedAt,
      };
    } catch (err) {
      if (signal.aborted) throw new ModelProviderError('CANCELLED', this.providerId, 'cancelled');
      throw new ModelProviderError(classifyProviderError(err), this.providerId, messageOf(err), retryAfterMs(err));
    }
  }
}

/** Each block carries where it came from and how much it is worth, as text the model reads. */
function asBlock(block: AiContentBlock): string {
  return `[${block.trust} | source: ${block.sourceRef}]\n${block.content}`;
}

function stopReasonOf(raw: string | null, usedTool: boolean): AiModelResult['stopReason'] {
  if (raw === 'max_tokens') return 'MAX_TOKENS';
  if (raw === 'refusal') return 'REFUSAL';
  if (raw === 'tool_use') return usedTool ? 'END' : 'TOOL_USE';
  return 'END';
}

function messageOf(err: unknown): string {
  const message = (err as { message?: unknown })?.message;
  return typeof message === 'string' ? message : 'provider error';
}

// AI provider interface.
//
// Abstracts large language model providers (Claude/Anthropic first, others later).
// No vendor SDK types leak through this boundary.

import type { BaseProvider, ProviderContext } from '../types';

export type AIRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AIMessage {
  role: AIRole;
  content: string;
  name?: string;
}

export interface AIToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>;
}

export interface AICompletionRequest {
  model?: string;
  messages: AIMessage[];
  system?: string;
  tools?: AIToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Free-form provider-specific options (escape hatch, used sparingly). */
  options?: Record<string, unknown>;
}

export interface AIToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AICompletionResult {
  text: string;
  toolCalls?: AIToolCall[];
  finishReason: 'stop' | 'length' | 'tool_use' | 'content_filter' | 'other';
  usage?: { inputTokens?: number; outputTokens?: number };
  raw?: unknown;
}

export interface AIStreamChunk {
  delta: string;
  done: boolean;
}

export interface AIProvider extends BaseProvider {
  complete(ctx: ProviderContext, req: AICompletionRequest): Promise<AICompletionResult>;
  /** Optional streaming. Implementations may omit if unsupported. */
  stream?(
    ctx: ProviderContext,
    req: AICompletionRequest,
  ): AsyncIterable<AIStreamChunk>;
}

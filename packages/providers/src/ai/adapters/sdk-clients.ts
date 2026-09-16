// The ONLY file in Loop that imports a model SDK. Slice AI-2.
//
// It turns a credential it is HANDED into a ModelProvider. It never looks for one:
// no environment variable is read here, and nothing here decides whether AI is on.
// The server-only environment boundary in apps/web reads the credential, and the
// runtime's activation gates decide whether the provider is ever called.
//
// CONSTRUCTING A CLIENT MAKES NO REQUEST. Both SDKs build lazily; a test proves it by
// constructing each client with a fetch that fails the test if it is ever called.
//
// NOTHING IN THE ENVIRONMENT MAY STEER THESE CLIENTS. Both SDKs will otherwise pick up
// settings from process.env on their own: a base URL (which would send traffic, and
// the key, somewhere else), an auth token, an organization or project, a log level
// (whose debug output includes request bodies). Every one of those is pinned here,
// explicitly, so the only thing that reaches the provider is what this file sets.
//
// LOOP OWNS RETRIES AND DEADLINES. The SDKs retry twice by default and wait up to ten
// minutes; the gateway retries per `providerFailurePolicy`, reserves each call, and
// aborts at the route's deadline. So SDK retries are off, and the SDK timeout is only
// a backstop above any route's deadline.
//
// A RUNTIME THE SDKS DO NOT SUPPORT IS NOT A RUNTIME TO CALL FROM. `openai` requires
// Node 22 or newer, and Anthropic supports only Node versions that are not end of
// life (Node 20 ended 2026-04-30). An older runtime yields RUNTIME_UNSUPPORTED rather
// than a client that fails in ways nobody tested.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AiModelCapabilities } from '@emgloop/shared';

import type { ModelProvider } from '../model-provider';
import { unconfirmedCapabilities } from '../model-provider';
import { AnthropicAdapter, ANTHROPIC_PROVIDER_ID, type AnthropicMessagesClient } from './anthropic.adapter';
import { OpenAiAdapter, OPENAI_PROVIDER_ID, type OpenAiResponsesClient } from './openai.adapter';

/** The lowest Node major both SDKs support. Kept in step with `.nvmrc` by a test. */
export const AI_MINIMUM_NODE_MAJOR = 22;

/** Hosts are pinned. A provider base URL is not something an environment gets to choose. */
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

/** Above every route's deadline. The gateway aborts first; this only stops a hang. */
export const AI_SDK_BACKSTOP_TIMEOUT_MS = 120_000;

export const AI_PROVIDER_CLIENT_STATES = ['CONFIGURED', 'PROVIDER_NOT_CONFIGURED', 'RUNTIME_UNSUPPORTED'] as const;
export type AiProviderClientState = (typeof AI_PROVIDER_CLIENT_STATES)[number];

export type AiProviderClient =
  | { readonly providerId: string; readonly state: 'CONFIGURED'; readonly provider: ModelProvider }
  | { readonly providerId: string; readonly state: 'PROVIDER_NOT_CONFIGURED' | 'RUNTIME_UNSUPPORTED' };

export interface AiProviderClientOptions {
  /** The credential, handed in. Absent or blank means not configured. */
  readonly apiKey: string | null | undefined;
  /** Declared per model, from the reviewed routing policy. Defaults to "nothing confirmed". */
  readonly capabilities?: (modelId: string) => AiModelCapabilities;
  /** Tests only: a fetch that proves no request is made. */
  readonly fetch?: typeof fetch;
  /** Tests only: the Node version to judge. */
  readonly nodeVersion?: string;
  /** Tests only: sees the constructed SDK client, so its pinned settings can be checked. */
  readonly onClientBuilt?: (client: Record<string, unknown>) => void;
}

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * The provider, with the SDK client (and so the credential) held only in a closure.
 * Serializing it for a log, a prop or an error report shows which provider it is and
 * nothing else; `util.inspect` shows the same.
 */
function sealed(providerId: string, inner: ModelProvider): ModelProvider {
  const label = `ModelProvider(${providerId})`;
  return Object.freeze({
    providerId,
    capabilities: (modelId: string) => inner.capabilities(modelId),
    invoke: (request: Parameters<ModelProvider['invoke']>[0], signal: AbortSignal) => inner.invoke(request, signal),
    toJSON: () => ({ providerId }),
    toString: () => label,
    [INSPECT]: () => label,
  });
}

export function nodeMajor(version: string = process.versions.node): number {
  const major = Number.parseInt(String(version).split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : 0;
}

function usable(options: AiProviderClientOptions): 'CONFIGURED' | 'PROVIDER_NOT_CONFIGURED' | 'RUNTIME_UNSUPPORTED' {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') return 'PROVIDER_NOT_CONFIGURED';
  if (nodeMajor(options.nodeVersion) < AI_MINIMUM_NODE_MAJOR) return 'RUNTIME_UNSUPPORTED';
  return 'CONFIGURED';
}

export function createAnthropicProvider(options: AiProviderClientOptions): AiProviderClient {
  const state = usable(options);
  if (state !== 'CONFIGURED') return { providerId: ANTHROPIC_PROVIDER_ID, state };
  const client = new Anthropic({
    apiKey: options.apiKey!.trim(),
    authToken: null,
    webhookKey: null,
    baseURL: ANTHROPIC_API_BASE_URL,
    maxRetries: 0,
    timeout: AI_SDK_BACKSTOP_TIMEOUT_MS,
    logLevel: 'off',
    dangerouslyAllowBrowser: false,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  options.onClientBuilt?.(client as unknown as Record<string, unknown>);
  const adapter = new AnthropicAdapter({
    client: client as unknown as AnthropicMessagesClient,
    capabilities: options.capabilities ?? ((modelId) => unconfirmedCapabilities(ANTHROPIC_PROVIDER_ID, modelId)),
  });
  return { providerId: ANTHROPIC_PROVIDER_ID, state, provider: sealed(ANTHROPIC_PROVIDER_ID, adapter) };
}

export function createOpenAiProvider(options: AiProviderClientOptions): AiProviderClient {
  const state = usable(options);
  if (state !== 'CONFIGURED') return { providerId: OPENAI_PROVIDER_ID, state };
  const client = new OpenAI({
    apiKey: options.apiKey!.trim(),
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL: OPENAI_API_BASE_URL,
    maxRetries: 0,
    timeout: AI_SDK_BACKSTOP_TIMEOUT_MS,
    logLevel: 'off',
    dangerouslyAllowBrowser: false,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  options.onClientBuilt?.(client as unknown as Record<string, unknown>);
  const adapter = new OpenAiAdapter({
    client: client as unknown as OpenAiResponsesClient,
    capabilities: options.capabilities ?? ((modelId) => unconfirmedCapabilities(OPENAI_PROVIDER_ID, modelId)),
  });
  return { providerId: OPENAI_PROVIDER_ID, state, provider: sealed(OPENAI_PROVIDER_ID, adapter) };
}

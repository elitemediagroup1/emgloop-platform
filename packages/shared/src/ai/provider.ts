// What Loop asks a model for, and what it accepts back. Slice AI S0.
//
// The architecture is docs/architecture/loop-ai-runtime.md §4 (F1), approved as
// PD-F-08. THESE ARE TYPES AND PURE DECISIONS ONLY: no SDK, no network, no key, no
// call. Nothing in this file can reach a provider, and the fences prove it.
//
// PROVIDER-NEUTRAL BY CONSTRUCTION. `providerId` is data. No behaviour anywhere in
// Loop branches on whether it says 'anthropic' or 'openai' -- routing is policy
// (see ./runtime.ts), and a hard-coded "Claude does X, OpenAI does Y" is the thing
// this shape exists to prevent. Loop owns the intelligence; it rents the plumbing.
//
// THE ADAPTER MAPS, THE RUNTIME DECIDES. An adapter's only judgement is turning a
// provider's error into one of the classes below. Every retry, fallback, repair and
// give-up decision is Loop's, made by `providerFailurePolicy`, so two providers
// cannot disagree about what "try again" means.
//
// CAPABILITIES ARE DECLARED, NEVER ASSUMED -- including data handling. A model's
// retention and training posture is CONFIGURATION CONFIRMED AGAINST A CONTRACT, and
// until somebody confirms it the answer is `UNCONFIRMED`, which the governance gate
// treats as "not eligible for anything but OPERATIONAL data".

export const AI_CONTRACT_VERSION = 'loop-ai.v1' as const;

/** Every provider Loop may be configured with. Data, never a branch. */
export const AI_PROVIDER_IDS = ['anthropic', 'openai'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export const AI_STRUCTURED_OUTPUT_MODES = ['NATIVE_JSON_SCHEMA', 'TOOL_FORCED', 'NONE'] as const;
export type AiStructuredOutputMode = (typeof AI_STRUCTURED_OUTPUT_MODES)[number];

/**
 * What a provider says about a model's handling of data sent to it. UNCONFIRMED is
 * the default and is not a synonym for "probably fine": it is the reason a task
 * carrying anything above OPERATIONAL cannot run.
 */
export const AI_DATA_HANDLING_POSTURES = ['UNCONFIRMED', 'NO_TRAINING_CONFIRMED', 'ZERO_RETENTION_CONFIRMED'] as const;
export type AiDataHandlingPosture = (typeof AI_DATA_HANDLING_POSTURES)[number];

export interface AiModelCapabilities {
  readonly providerId: string;
  readonly modelId: string;
  readonly structuredOutput: AiStructuredOutputMode;
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly promptCaching: boolean;
  /** Confirmed against a contract, never inferred from documentation. */
  readonly dataHandling: AiDataHandlingPosture;
  /** Where the request is served, when the provider commits to one. */
  readonly region: string | null;
}

export const AI_CONTENT_TRUST_LEVELS = ['GOVERNED_FACT', 'HUMAN_REPORTED', 'PROVIDER_REPORTED', 'UNTRUSTED_INPUT'] as const;
export type AiContentTrustLevel = (typeof AI_CONTENT_TRUST_LEVELS)[number];

/**
 * One block of what Loop sends. Every block names the record it came from, so a
 * claim can be traced back to an authority -- and so content a person typed is
 * never mistaken for something Loop established.
 */
export interface AiContentBlock {
  readonly blockId: string;
  readonly kind: 'TEXT' | 'STRUCTURED';
  readonly trust: AiContentTrustLevel;
  /** The authority this came from, as `${recordType}:${recordId}`. */
  readonly sourceRef: string;
  readonly content: string;
}

export interface AiToolSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: Record<string, unknown>;
  /**
   * A tool that changes anything. ALWAYS FALSE AT LAUNCH: the broker refuses to
   * publish a writing tool, and `aiToolsAdmissible` refuses a request carrying one.
   */
  readonly writes: false;
}

export interface AiModelRequest {
  /** Stable across retries: Loop's idempotency and correlation id. */
  readonly invocationId: string;
  readonly model: { readonly providerId: string; readonly modelId: string };
  /** A rendered governed template. Never assembled at the call site. */
  readonly instructions: string;
  readonly input: readonly AiContentBlock[];
  readonly tools: readonly AiToolSpec[];
  readonly output:
    | { readonly kind: 'TEXT' }
    | { readonly kind: 'JSON_SCHEMA'; readonly schemaId: string; readonly schema: Record<string, unknown>; readonly strict: true };
  readonly limits: { readonly maxOutputTokens: number; readonly timeoutMs: number };
  readonly sampling?: { readonly temperature?: number };
}

export const AI_STOP_REASONS = ['END', 'MAX_TOKENS', 'TOOL_USE', 'REFUSAL', 'CONTENT_FILTERED'] as const;
export type AiStopReason = (typeof AI_STOP_REASONS)[number];

export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
}

export interface AiModelResult {
  readonly output: { readonly text?: string; readonly json?: unknown };
  readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly input: unknown }[];
  readonly stopReason: AiStopReason;
  readonly usage: AiUsage;
  readonly providerRequestId: string | null;
  /** What the provider says actually served the request, which is not always what was asked for. */
  readonly reportedModel: string | null;
  readonly latencyMs: number;
}

// --- The failure taxonomy, and who decides what to do about it -----------------------

export const AI_FAILURE_CLASSES = [
  'AUTH',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'TIMEOUT',
  'INVALID_REQUEST',
  'CONTEXT_TOO_LARGE',
  'REFUSED',
  'CONTENT_FILTERED',
  'OUTPUT_INVALID',
  'POLICY_DENIED',
  'BUDGET_EXCEEDED',
  'CANCELLED',
] as const;
export type AiFailureClass = (typeof AI_FAILURE_CLASSES)[number];

export interface AiFailurePolicy {
  readonly retry: boolean;
  readonly fallback: boolean;
  /** One repair attempt, for an output that parsed but did not satisfy its contract. */
  readonly repair: boolean;
  /** Somebody needs to know now: a key is wrong, not a model is busy. */
  readonly alert: boolean;
}

const FAILURE_POLICY: Readonly<Record<AiFailureClass, AiFailurePolicy>> = Object.freeze({
  // A bad credential is not a transient condition, and retrying it just locks things out.
  AUTH: { retry: false, fallback: false, repair: false, alert: true },
  RATE_LIMITED: { retry: true, fallback: true, repair: false, alert: false },
  UNAVAILABLE: { retry: true, fallback: true, repair: false, alert: false },
  TIMEOUT: { retry: true, fallback: true, repair: false, alert: false },
  // Loop built a request the provider cannot accept. That is a bug, not weather.
  INVALID_REQUEST: { retry: false, fallback: false, repair: false, alert: true },
  // Re-assemble smaller, or route wider if policy allows. Never silently truncate.
  CONTEXT_TOO_LARGE: { retry: false, fallback: false, repair: false, alert: false },
  // A refusal is an OUTCOME, recorded as one. Asking a second provider until one
  // agrees is shopping for an answer, and Loop does not do it.
  REFUSED: { retry: false, fallback: false, repair: false, alert: false },
  CONTENT_FILTERED: { retry: false, fallback: false, repair: false, alert: false },
  OUTPUT_INVALID: { retry: false, fallback: false, repair: true, alert: false },
  POLICY_DENIED: { retry: false, fallback: false, repair: false, alert: false },
  BUDGET_EXCEEDED: { retry: false, fallback: false, repair: false, alert: true },
  CANCELLED: { retry: false, fallback: false, repair: false, alert: false },
});

/** Fails closed: an unrecognised failure is not retried, not fallen back from, and is raised. */
export function providerFailurePolicy(failure: string): AiFailurePolicy {
  return FAILURE_POLICY[failure as AiFailureClass] ?? { retry: false, fallback: false, repair: false, alert: true };
}

/**
 * A request may carry no tool that writes. The type says `writes: false`, and this
 * says it again at runtime, because the type is erased by the time a provider sees it.
 */
export function aiToolsAdmissible(tools: readonly { readonly writes?: unknown }[]): boolean {
  return tools.every((tool) => tool.writes === false);
}

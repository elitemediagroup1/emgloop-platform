// The provider boundary. Slice AI S0.
//
// Architecture: docs/architecture/loop-ai-runtime.md §3 and §4. THIS DIRECTORY IS
// THE ONLY PLACE IN LOOP THAT MAY EVER IMPORT A MODEL SDK. A fence test asserts it,
// scanning the whole repository, because the value of a provider-neutral runtime is
// lost the first time an SDK type appears in a service signature -- not loudly, but
// by making the next person's shortcut reasonable.
//
// NOTHING HERE CALLS ANYTHING YET. Slice S0 defines the boundary and a fixture
// implementation that replays recorded results. No SDK is installed, no credential
// is read, and no request leaves the process. S1 adds the Anthropic and OpenAI
// adapters behind this same interface, and the activation gates G1-G6 decide when
// they may run.
//
// AN ADAPTER MAPS; IT DOES NOT DECIDE. It turns one provider's shape into Loop's,
// and one provider's error into a failure class. Retry, fallback, repair and
// give-up are the runtime's, from `providerFailurePolicy`, so two providers cannot
// mean different things by "try again".

import type {
  AiFailureClass,
  AiModelCapabilities,
  AiModelRequest,
  AiModelResult,
} from '@emgloop/shared';

/** What every model provider is, whoever it is. */
export interface ModelProvider {
  readonly providerId: string;
  capabilities(modelId: string): AiModelCapabilities;
  invoke(request: AiModelRequest, signal: AbortSignal): Promise<AiModelResult>;
}

/** An adapter reports failure as one of Loop's classes, and nothing else. */
export class ModelProviderError extends Error {
  constructor(
    readonly failure: AiFailureClass,
    readonly providerId: string,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

export interface RecordedInvocation {
  readonly modelId: string;
  readonly result?: AiModelResult;
  readonly failure?: { readonly failure: AiFailureClass; readonly message: string; readonly retryAfterMs?: number };
}

/**
 * A provider that replays recorded results. It is how the runtime is exercised end
 * to end -- routing, fallback, validation, provenance -- WITHOUT a credential, a
 * network call or a bill, and it stays useful after S1 as the evaluation harness.
 *
 * It is not a mock pretending to be intelligent: it returns what somebody recorded,
 * and it refuses to answer a model it has nothing for rather than improvising.
 */
export class RecordedModelProvider implements ModelProvider {
  private readonly byModel = new Map<string, RecordedInvocation>();

  constructor(
    readonly providerId: string,
    recordings: readonly RecordedInvocation[],
    private readonly declared: (modelId: string) => AiModelCapabilities,
  ) {
    for (const recording of recordings) this.byModel.set(recording.modelId, recording);
  }

  capabilities(modelId: string): AiModelCapabilities {
    return this.declared(modelId);
  }

  async invoke(request: AiModelRequest, signal: AbortSignal): Promise<AiModelResult> {
    if (signal.aborted) throw new ModelProviderError('CANCELLED', this.providerId, 'cancelled before dispatch');
    const recording = this.byModel.get(request.model.modelId);
    if (!recording) {
      throw new ModelProviderError('INVALID_REQUEST', this.providerId, `nothing recorded for ${request.model.modelId}`);
    }
    if (recording.failure) {
      throw new ModelProviderError(
        recording.failure.failure,
        this.providerId,
        recording.failure.message,
        recording.failure.retryAfterMs ?? null,
      );
    }
    return recording.result!;
  }
}

/**
 * The capabilities of a model nobody has confirmed anything about. Every field is
 * the cautious answer, and `dataHandling: 'UNCONFIRMED'` is what keeps such a model
 * ineligible for anything above OPERATIONAL data until a contract says otherwise.
 */
export function unconfirmedCapabilities(providerId: string, modelId: string): AiModelCapabilities {
  return {
    providerId,
    modelId,
    structuredOutput: 'NONE',
    tools: false,
    streaming: false,
    contextWindowTokens: 0,
    maxOutputTokens: 0,
    promptCaching: false,
    dataHandling: 'UNCONFIRMED',
    region: null,
  };
}

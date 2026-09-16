// The Loop AI runtime gateway. Slice B5 (AI S1 preparation).
//
// One place where a task becomes a model call, and the only place. Callers invoke a
// TASK BY NAME; they never choose a provider, never write a prompt, never see an
// SDK, and never receive an answer Loop has not checked.
//
// NOTHING HERE CALLS ANYTHING YET. The gateway invokes whatever `ModelProvider`
// implementations were registered with it, and the only implementation that exists
// today is the recorded-fixture provider. No SDK is installed, no credential is
// read, and `activated` defaults to false. Registering a real adapter is slice S1,
// and it is gated on G1-G6 and on Matt's explicit authorization.
//
// THE ORDER MATTERS, AND IT IS THE CHEAPEST-REFUSAL-FIRST ORDER.
//   1. admit  -- activation, kill switches, budgets, context, tools, routing. Pure,
//                free, and decided before a byte leaves the process.
//   2. invoke -- with a deadline, bounded retries, and fallback ONLY where the
//                failure class allows one.
//   3. parse and validate -- an answer that breaks its contract is REFUSED WHOLE,
//                never partially shown.
//   4. record -- provenance and usage, for an answer, a refusal and a failure alike.
//
// A REFUSAL IS AN OUTCOME, NOT A RETRY. When a model declines or its content filter
// fires, Loop records that and stops. Asking the next provider until one agrees is
// shopping for an answer, and it would make the fallback list a way to launder a
// refusal.
//
// USAGE IS COUNTED THROUGH AN INTERFACE, NOT A MAP. Serverless instances share no
// memory (the webhook replay-map lesson in CLAUDE.md), so budgets read a durable
// ledger. The durable implementation needs a table, and a table needs a migration,
// which this run is not authorized to add -- so S1 supplies it and the interface is
// here, with an in-memory implementation for tests.

import {
  admitAiInvocation,
  aiProvenanceOf,
  providerFailurePolicy,
  validateAiContextPackage,
  validateAiTaskOutput,
  type AiAdmissionRefusal,
  type AiBudget,
  type AiContextPackage,
  type AiInvocationProvenance,
  type AiKillSwitch,
  type AiModelRequest,
  type AiModelResult,
  type AiRouteTarget,
  type AiRoutingPolicy,
  type AiSpendToday,
  type AiTaskDefinition,
  type AiTaskOutputV1,
  type AiOutputRejection,
} from '@emgloop/shared';

/** What the gateway needs of a provider. Structurally the providers package's `ModelProvider`. */
export interface AiProviderPort {
  readonly providerId: string;
  invoke(request: AiModelRequest, signal: AbortSignal): Promise<AiModelResult>;
}

/** The durable counter budgets are read from. S1 backs this with a table. */
export interface AiUsageLedger {
  spentToday(organizationId: string): Promise<AiSpendToday>;
  record(provenance: AiInvocationProvenance): Promise<void>;
}

/** Enough of a ledger to exercise the gateway. Not for production: instances share no memory. */
export class InMemoryAiUsageLedger implements AiUsageLedger {
  readonly provenance: AiInvocationProvenance[] = [];
  private readonly byOrg = new Map<string, AiSpendToday>();

  async spentToday(organizationId: string): Promise<AiSpendToday> {
    return this.byOrg.get(organizationId) ?? { invocations: 0, inputTokens: 0, outputTokens: 0 };
  }

  async record(provenance: AiInvocationProvenance): Promise<void> {
    this.provenance.push(provenance);
    const current = await this.spentToday(provenance.organizationId);
    this.byOrg.set(provenance.organizationId, {
      invocations: current.invocations + 1,
      inputTokens: current.inputTokens + provenance.usage.inputTokens,
      outputTokens: current.outputTokens + provenance.usage.outputTokens,
    });
  }
}

export interface AiRuntimeConfig {
  readonly policy: AiRoutingPolicy;
  readonly budget: AiBudget;
  readonly killSwitches: readonly AiKillSwitch[];
  /** G6. False until an operator turns the runtime on. */
  readonly activated: boolean;
  /** Bounded, and never beyond the task's deadline. */
  readonly maxAttemptsPerTarget: number;
}

export interface AiRuntimeDeps {
  readonly providers: readonly AiProviderPort[];
  readonly ledger: AiUsageLedger;
  /** Injected, because a runtime that reads the clock cannot be tested against one. */
  readonly now: () => Date;
  /** Injected for the same reason; the gateway mints no ids of its own. */
  readonly newInvocationId: () => string;
}

export type AiRunResult =
  | { readonly outcome: 'ANSWERED'; readonly output: AiTaskOutputV1; readonly provenance: AiInvocationProvenance }
  | { readonly outcome: 'REFUSED_BY_LOOP'; readonly refusals: readonly AiAdmissionRefusal[] }
  | { readonly outcome: 'REJECTED_OUTPUT'; readonly rejections: readonly AiOutputRejection[]; readonly provenance: AiInvocationProvenance }
  | { readonly outcome: 'REFUSED_BY_MODEL'; readonly provenance: AiInvocationProvenance }
  | { readonly outcome: 'FAILED'; readonly failure: string; readonly provenance: AiInvocationProvenance };

export interface AiRunRequest {
  readonly task: AiTaskDefinition;
  readonly context: AiContextPackage;
  readonly instructions: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly schema: Record<string, unknown>;
  /** The numbers the supplied evidence actually contains. An answer may state no other. */
  readonly supportedFigures: ReadonlySet<number>;
  readonly signal?: AbortSignal;
}

export class AiRuntimeGateway {
  constructor(
    private readonly config: AiRuntimeConfig,
    private readonly deps: AiRuntimeDeps,
  ) {}

  async run(request: AiRunRequest): Promise<AiRunResult> {
    const { task, context } = request;

    // 1. Admission. Every refusal is decided before anything is sent, and all of
    //    them are reported at once so an operator fixes one thing, not five in turn.
    const contextRefusals = validateAiContextPackage(context);
    const admission = admitAiInvocation({
      taskId: task.taskId,
      profile: task.profile,
      organizationId: context.organizationId,
      policy: this.config.policy,
      killSwitches: this.config.killSwitches,
      budget: this.config.budget,
      spentToday: await this.deps.ledger.spentToday(context.organizationId),
      registeredProviders: this.deps.providers.map((p) => p.providerId),
      requestedMaxOutputTokens: task.maxOutputTokens,
      contextRefusals,
      tools: [],
      activated: this.config.activated,
    });
    if (!admission.ok) return { outcome: 'REFUSED_BY_LOOP', refusals: admission.refusals };

    // 2. Invocation, primary then fallbacks, each within the task's deadline.
    const invocationId = this.deps.newInvocationId();
    const targets = [admission.route, ...admission.fallbacks];
    let lastFailure = 'UNAVAILABLE';
    let lastTarget = admission.route;

    for (const target of targets) {
      lastTarget = target;
      const provider = this.deps.providers.find((p) => p.providerId === target.providerId);
      if (!provider) continue;
      const attempt = await this.attempt(provider, target, invocationId, request);

      if (attempt.kind === 'RESULT') {
        const result = attempt.result;
        // A refusal is an outcome. It is recorded and it stops here.
        if (result.stopReason === 'REFUSAL' || result.stopReason === 'CONTENT_FILTERED') {
          const provenance = this.provenanceOf(request, invocationId, target, result, 'REFUSED_BY_MODEL');
          await this.deps.ledger.record(provenance);
          return { outcome: 'REFUSED_BY_MODEL', provenance };
        }

        // 3. The answer is checked before anybody sees it.
        const parsed = this.parse(result);
        const rejections = parsed
          ? validateAiTaskOutput(parsed, task, new Set(context.items.map((i) => i.sourceRef)), request.supportedFigures)
          : (['WRONG_SCHEMA'] as AiOutputRejection[]);
        const provenance = this.provenanceOf(request, invocationId, target, result, rejections.length === 0 ? 'ANSWERED' : 'REJECTED_BY_LOOP');
        await this.deps.ledger.record(provenance);
        if (!parsed || rejections.length > 0) return { outcome: 'REJECTED_OUTPUT', rejections, provenance };
        return { outcome: 'ANSWERED', output: parsed, provenance };
      }

      lastFailure = attempt.failure;
      // Only the failure classes Loop says may fall back, do.
      if (!providerFailurePolicy(attempt.failure).fallback) break;
    }

    const provenance = this.provenanceOf(request, invocationId, lastTarget, null, 'FAILED');
    await this.deps.ledger.record(provenance);
    return { outcome: 'FAILED', failure: lastFailure, provenance };
  }

  /** One target, with bounded retries inside the task's deadline. */
  private async attempt(
    provider: AiProviderPort,
    target: AiRouteTarget,
    invocationId: string,
    request: AiRunRequest,
  ): Promise<{ kind: 'RESULT'; result: AiModelResult } | { kind: 'FAILURE'; failure: string }> {
    const modelRequest: AiModelRequest = {
      // Stable across retries: the same attempt, not a new one.
      invocationId,
      model: target,
      instructions: request.instructions,
      input: request.context.items,
      tools: [],
      output: { kind: 'JSON_SCHEMA', schemaId: request.task.outputSchemaId, schema: request.schema, strict: true },
      limits: { maxOutputTokens: request.task.maxOutputTokens, timeoutMs: request.task.timeoutMs },
    };

    let failure = 'UNAVAILABLE';
    for (let attempt = 0; attempt < Math.max(1, this.config.maxAttemptsPerTarget); attempt += 1) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.signal?.addEventListener('abort', abort, { once: true });
      try {
        return { kind: 'RESULT', result: await provider.invoke(modelRequest, controller.signal) };
      } catch (err) {
        failure = classify(err);
        if (!providerFailurePolicy(failure).retry) break;
      } finally {
        request.signal?.removeEventListener('abort', abort);
      }
    }
    return { kind: 'FAILURE', failure };
  }

  /** A body that is not the shape asked for is not half an answer. */
  private parse(result: AiModelResult): AiTaskOutputV1 | null {
    const value = result.output.json ?? safeJson(result.output.text);
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<AiTaskOutputV1>;
    if (typeof candidate.schemaId !== 'string' || !Array.isArray(candidate.claims)) return null;
    return {
      schemaId: candidate.schemaId,
      summary: typeof candidate.summary === 'string' ? candidate.summary : '',
      claims: candidate.claims,
      limitations: Array.isArray(candidate.limitations) ? candidate.limitations : [],
    };
  }

  private provenanceOf(
    request: AiRunRequest,
    invocationId: string,
    target: AiRouteTarget,
    result: AiModelResult | null,
    outcome: AiInvocationProvenance['outcome'],
  ): AiInvocationProvenance {
    return aiProvenanceOf(request.context, {
      invocationId,
      taskVersion: request.task.version,
      templateId: request.templateId,
      templateVersion: request.templateVersion,
      requestedModel: target,
      servedModel: result?.reportedModel ?? null,
      providerRequestId: result?.providerRequestId ?? null,
      usage: result?.usage ?? { inputTokens: 0, outputTokens: 0 },
      latencyMs: result?.latencyMs ?? 0,
      outcome,
      recordedAt: this.deps.now().toISOString(),
    });
  }
}

/** An adapter reports a failure class; anything else is treated as unknown and not retried. */
function classify(err: unknown): string {
  const failure = (err as { failure?: unknown })?.failure;
  return typeof failure === 'string' ? failure : 'UNAVAILABLE';
}

function safeJson(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

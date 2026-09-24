// The Loop AI runtime gateway. Slices B5 and AI-1.
//
// One place where a task becomes a model call, and the only place. Callers invoke a
// TASK BY NAME, as a signed-in person; they never choose a provider, never write a
// prompt, never see an SDK, and never receive an answer Loop has not checked.
//
// THE SEQUENCE, AND WHY IT IS THIS ORDER
//
//    1-3  the principal is the session's person, in the session's organization, and
//         the context was assembled as that person in that organization;
//    4    the principal may invoke this task (their grants, their role, and never an
//         AI_EMPLOYEE -- an invocation always traces to a person);
//    5    the context package is valid and within the task's sensitivity ceiling;
//    6-9  activation, kill switches, routing, the provider POLICY (G2: a recorded ACTIVE
//         policy whose sensitivity ceiling reaches the task's, per target, read from
//         `ai_controls` -- missing, KILLED, lower or unreadable is POLICY_DENIED) and a
//         cheap budget check -- all decided before a byte leaves the process;
//    10   the call is estimated, pessimistically;
//    11   the estimate is RESERVED in the durable ledger, which re-checks the budget
//         inside a serializable transaction. Two serverless instances cannot both
//         see room and both spend it;
//    12   only a successful reservation makes a provider call eligible;
//    13   the provider is called, under the route's deadline;
//    14   the answer is parsed and validated, and refused whole if it breaks its
//         contract;
//    15   the reservation is reconciled with what the provider reported;
//    16   provenance is returned for an answer, a refusal and a failure alike;
//    17   only then does anybody see the answer.
//
// EVERY PROVIDER CALL HAS ITS OWN RESERVATION. A retry is a second call and a
// fallback is a second call; each spends money, so each is reserved before it is
// made and reconciled after. A fallback whose reservation is refused is not made.
//
// A REFUSAL IS AN OUTCOME, NOT A RETRY. When a model declines or its content filter
// fires, Loop records that and stops. Asking the next provider until one agrees is
// shopping for an answer.
//
// AN UNRECOGNISED ERROR IS NOT WEATHER. It is not retried and not fallen back from.
//
// IF THE LEDGER CANNOT RECORD, NOTHING IS SHOWN. An answer whose spend and provenance
// could not be written is an answer nobody can account for; the reservation that did
// land still counts against the budget, which is the safe direction.
//
// NO BODY IS PERSISTED. The ledger receives ids, versions, counts and a hash of the
// source refs -- never the prompt, never the answer, never a provider's error text.

import {
  admitAiInvocation,
  aiBudgetRefusals,
  aiCostMicros,
  aiProvenanceOf,
  estimateAiInputTokens,
  parseAiTaskOutput,
  providerFailurePolicy,
  validateAiContextPackage,
  validateAiTaskOutput,
  AI_FAILURE_CLASSES,
  type AiActivation,
  type AiAdmissionRefusal,
  type AiBudgetPolicy,
  type AiCallEstimate,
  type AiContextPackage,
  type AiInvocationProvenance,
  type AiKillSwitch,
  type AiModelRequest,
  type AiModelResult,
  type AiOutputRejection,
  type AiProviderPolicy,
  type AiRouteTargetPolicy,
  type AiRoutingPolicy,
  type AiSpendSnapshot,
  type AiTaskDefinition,
  type AiSupportedEvidence,
  type AiTaskOutput,
  type AiUsage,
} from '@emgloop/shared';

/** What the gateway needs of a provider. Structurally the providers package's `ModelProvider`. */
export interface AiProviderPort {
  readonly providerId: string;
  invoke(request: AiModelRequest, signal: AbortSignal): Promise<AiModelResult>;
}

/** The signed-in person the invocation is for. Established by the caller from the session. */
export interface AiPrincipal {
  readonly organizationId: string;
  readonly userId: string;
}

/** Whether this person may invoke this task. Production: `iamAiAuthorizer`. */
export type AiAuthorizer = (principal: AiPrincipal, task: AiTaskDefinition) => Promise<boolean>;

/** One provider call, as the ledger records it before the call is made. */
export interface AiCallReservation {
  readonly organizationId: string;
  /** Unique per organization. The first call is the invocation id; later calls add `.n`. */
  readonly callKey: string;
  readonly principalUserId: string;
  readonly taskId: string;
  readonly taskVersion: string;
  /** The task's declared capability route. Stored in `ai_invocations.profile`. */
  readonly capabilityRoute: string;
  readonly target: AiRouteTargetPolicy;
  readonly routingPolicyVersion: string;
  readonly budgetClass: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly contextSourceRefs: readonly string[];
  readonly estimate: AiCallEstimate;
  /** The model this call stands in for, when it is not the primary. */
  readonly fellBackFrom: string | null;
  /** 1 for the first call of an invocation, 2 for the next, and so on. */
  readonly callOrdinal: number;
  readonly requestedAt: Date;
  /**
   * B5. The Brain job and step this call serves, when a Brain executor makes it. The
   * call key is then `brainCallKey(job, step, attempt, ordinal)`. This gateway never sets it.
   */
  readonly brain?: { readonly jobId: string; readonly stepKey: string } | null;
  /** B5. The provider-specialization policy version the call's routing conformed to. */
  readonly specializationPolicyVersion?: string | null;
}

export type AiReserveResult = { readonly ok: true } | { readonly ok: false; readonly refusals: readonly AiAdmissionRefusal[] };

export const AI_CALL_OUTCOMES = ['ANSWERED', 'REFUSED_BY_MODEL', 'REJECTED_BY_LOOP', 'FAILED', 'CANCELLED'] as const;
export type AiCallOutcome = (typeof AI_CALL_OUTCOMES)[number];

export interface AiCallReconciliation {
  readonly callKey: string;
  readonly outcome: AiCallOutcome;
  readonly servedModel: string | null;
  readonly providerRequestId: string | null;
  /** Null when the provider reported nothing. The reserve then keeps counting. */
  readonly usage: AiUsage | null;
  readonly unitCostBasis: string | null;
  readonly failureClass: string | null;
  readonly rejectionCodes: readonly string[];
  readonly completedAt: Date;
  readonly latencyMs: number | null;
}

/**
 * The durable counter budgets are read from and reserved against.
 * Production: `DurableAiUsageLedger` over the `ai_invocations` table.
 */
export interface AiUsageLedger {
  /** Spend so far, for the cheap pre-check. The reservation re-reads it authoritatively. */
  spend(organizationId: string, taskId: string, at: Date, activeOrganizations: readonly string[]): Promise<AiSpendSnapshot>;
  /** Claim the estimate, or refuse. Must be atomic with its own budget check. */
  reserve(reservation: AiCallReservation, budget: AiBudgetPolicy, activeOrganizations: readonly string[]): Promise<AiReserveResult>;
  /** Replace the estimate with what happened. False when no such reservation exists. */
  reconcile(organizationId: string, reconciliation: AiCallReconciliation): Promise<boolean>;
}

export interface AiRuntimeConfig {
  readonly activation: AiActivation;
  readonly policy: AiRoutingPolicy;
  /** Null means no budget is configured, and nothing runs (gate G4). */
  readonly budget: AiBudgetPolicy | null;
  readonly killSwitches: readonly AiKillSwitch[];
  /** Calls per target, first attempt included. Bounded. */
  readonly maxAttemptsPerTarget: number;
}

export interface AiRuntimeDeps {
  readonly providers: readonly AiProviderPort[];
  readonly ledger: AiUsageLedger;
  readonly authorize: AiAuthorizer;
  /** Injected, because a runtime that reads the clock cannot be tested against one. */
  readonly now: () => Date;
  /** Injected for the same reason; the gateway mints no ids of its own. */
  readonly newInvocationId: () => string;
  /** Injected so a deadline can be tested without waiting for one. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /**
   * G2. Every provider's CURRENT recorded policy. Production: `aiProviderPolicyReader(prisma)`
   * (a short in-process cache over `ai_controls`). REQUIRED, and a read that throws refuses every
   * provider as PROVIDER_POLICY_UNREADABLE: there is no default that approves.
   */
  readonly providerPolicies: () => Promise<readonly AiProviderPolicy[]>;
}

export type AiRunResult =
  | { readonly outcome: 'ANSWERED'; readonly output: AiTaskOutput; readonly provenance: AiInvocationProvenance }
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
  /** The numbers (per source) and dates the supplied evidence actually contains. An answer may state no other. */
  readonly evidence: AiSupportedEvidence;
  readonly signal?: AbortSignal;
}

/**
 * Enough of a ledger to exercise the gateway in one process. Not for production:
 * serverless instances share no memory. Its check-and-insert is SYNCHRONOUS, so
 * concurrent reservations inside one process cannot interleave between them -- the
 * same guarantee the durable ledger gets from a serializable transaction.
 */
export class InMemoryAiUsageLedger implements AiUsageLedger {
  readonly calls: Array<AiCallReservation & { reconciliation: AiCallReconciliation | null }> = [];

  async spend(organizationId: string, taskId: string): Promise<AiSpendSnapshot> {
    return this.snapshot(organizationId, taskId);
  }

  private snapshot(organizationId: string, taskId: string): AiSpendSnapshot {
    // Same rule as the durable ledger's sumSpend: a reconciled call counts what the provider actually
    // reported (null usage means it processed nothing -- ZERO, not its reserve); only a call still
    // outstanding (reconciliation === null) holds its estimate. Falling back to the estimate for a
    // reconciled-but-unreported call is phantom spend.
    const sum = (rows: InMemoryAiUsageLedger['calls']) =>
      rows.reduce(
        (acc, r) => ({
          invocations: acc.invocations + 1,
          inputTokens: acc.inputTokens + (r.reconciliation ? (r.reconciliation.usage?.inputTokens ?? 0) : r.estimate.inputTokens),
          outputTokens: acc.outputTokens + (r.reconciliation ? (r.reconciliation.usage?.outputTokens ?? 0) : r.estimate.outputTokens),
        }),
        { invocations: 0, inputTokens: 0, outputTokens: 0 },
      );
    const org = this.calls.filter((c) => c.organizationId === organizationId);
    return { organization: sum(org), task: sum(org.filter((c) => c.taskId === taskId)), global: sum(this.calls) };
  }

  async reserve(reservation: AiCallReservation, budget: AiBudgetPolicy): Promise<AiReserveResult> {
    if (this.calls.some((c) => c.organizationId === reservation.organizationId && c.callKey === reservation.callKey)) {
      return { ok: false, refusals: ['DUPLICATE_INVOCATION'] };
    }
    const spend = this.snapshot(reservation.organizationId, reservation.taskId);
    const refusals = aiBudgetRefusals(budget, reservation.budgetClass, reservation.estimate, spend);
    if (refusals.length > 0) return { ok: false, refusals };
    this.calls.push({ ...reservation, reconciliation: null });
    return { ok: true };
  }

  async reconcile(organizationId: string, reconciliation: AiCallReconciliation): Promise<boolean> {
    const row = this.calls.find((c) => c.organizationId === organizationId && c.callKey === reconciliation.callKey);
    if (!row) return false;
    row.reconciliation = reconciliation;
    return true;
  }
}

type CallOutcome =
  | { readonly kind: 'RESULT'; readonly result: AiModelResult; readonly callKey: string; readonly target: AiRouteTargetPolicy }
  | { readonly kind: 'FAILURE'; readonly failure: string; readonly callKey: string | null; readonly target: AiRouteTargetPolicy }
  | { readonly kind: 'NOT_RESERVED'; readonly refusals: readonly AiAdmissionRefusal[] };

class LedgerUnavailable extends Error {}

export class AiRuntimeGateway {
  constructor(
    private readonly config: AiRuntimeConfig,
    private readonly deps: AiRuntimeDeps,
  ) {}

  async run(principal: AiPrincipal, request: AiRunRequest): Promise<AiRunResult> {
    const { task, context } = request;

    // 1-3. The context is this person's, in this organization, or nothing happens.
    if (
      !principal.organizationId ||
      !principal.userId ||
      context.organizationId !== principal.organizationId ||
      context.viewerUserId !== principal.userId ||
      context.taskId !== task.taskId
    ) {
      return { outcome: 'REFUSED_BY_LOOP', refusals: ['NOT_AUTHORIZED'] };
    }

    // 4. Their grants, their role. An unauthorized caller learns nothing more.
    let authorized = false;
    try {
      authorized = await this.deps.authorize(principal, task);
    } catch {
      authorized = false;
    }
    if (!authorized) return { outcome: 'REFUSED_BY_LOOP', refusals: ['NOT_AUTHORIZED'] };

    // 5-10. Context, activation, kill switches, routing, a cheap budget check.
    const now = this.deps.now();
    const estimatedInputTokens = estimateAiInputTokens([
      request.instructions,
      JSON.stringify(request.schema),
      ...context.items.flatMap((item) => [item.sourceRef, item.trust, item.content]),
    ]);
    let spend: AiSpendSnapshot;
    try {
      spend = await this.deps.ledger.spend(context.organizationId, task.taskId, now, this.config.activation.organizations);
    } catch {
      return { outcome: 'REFUSED_BY_LOOP', refusals: ['LEDGER_UNAVAILABLE'] };
    }
    // G2. Read, never assumed: a failed read is null, and null refuses every provider.
    let providerPolicies: readonly AiProviderPolicy[] | null;
    try {
      providerPolicies = await this.deps.providerPolicies();
    } catch {
      providerPolicies = null;
    }
    const admission = admitAiInvocation({
      taskId: task.taskId,
      taskVersion: task.version,
      organizationId: context.organizationId,
      authorized,
      activation: this.config.activation,
      policy: this.config.policy,
      killSwitches: this.config.killSwitches,
      budget: this.config.budget,
      spend,
      estimatedInputTokens,
      registeredProviders: this.deps.providers.map((p) => p.providerId),
      contextRefusals: validateAiContextPackage(context),
      tools: [],
      providerPolicies,
      sensitivityCeiling: task.sensitivityCeiling,
    });
    if (!admission.ok) return { outcome: 'REFUSED_BY_LOOP', refusals: admission.refusals };
    const budget = this.config.budget;
    if (!budget) return { outcome: 'REFUSED_BY_LOOP', refusals: ['BUDGET_NOT_CONFIGURED'] };

    const invocationId = this.deps.newInvocationId();
    const refs = [...new Set(context.items.map((i) => i.sourceRef))].sort();
    const primaryName = `${admission.route.providerId}/${admission.route.modelId}`;
    // When the policy's own primary could not serve (killed, not enabled, not
    // registered), the first call already stands in for it -- and says so. A skipped
    // FALLBACK changes nothing about the first call.
    const policyPrimary = this.config.policy.tasks[task.taskId]?.primary;
    const primarySkipped =
      policyPrimary &&
      (policyPrimary.providerId !== admission.route.providerId || policyPrimary.modelId !== admission.route.modelId);
    const skippedPrimary = primarySkipped ? `${policyPrimary.providerId}/${policyPrimary.modelId}` : null;
    const targets = [admission.route, ...admission.fallbacks];

    let callOrdinal = 0;
    let lastFailure = 'UNAVAILABLE';
    let lastTarget = admission.route;
    let lastUsage: AiUsage | null = null;
    let latencyMs = 0;
    const startedAt = now.getTime();

    const provenance = (
      target: AiRouteTargetPolicy,
      result: AiModelResult | null,
      outcome: AiInvocationProvenance['outcome'],
    ): AiInvocationProvenance =>
      aiProvenanceOf(context, {
        invocationId,
        taskVersion: task.version,
        templateId: request.templateId,
        templateVersion: request.templateVersion,
        routingPolicyVersion: admission.routingPolicyVersion,
        requestedModel: { providerId: target.providerId, modelId: target.modelId },
        servedModel: result?.reportedModel ?? null,
        providerRequestId: result?.providerRequestId ?? null,
        usage: result?.usage ?? lastUsage,
        calls: callOrdinal,
        latencyMs: result?.latencyMs ?? latencyMs,
        outcome,
        recordedAt: this.deps.now().toISOString(),
      });

    try {
      for (const [targetIndex, target] of targets.entries()) {
        const provider = this.deps.providers.find((p) => p.providerId === target.providerId);
        if (!provider) continue;
        const fellBackFrom = targetIndex === 0 ? skippedPrimary : primaryName;

        for (let attempt = 0; attempt < Math.max(1, this.config.maxAttemptsPerTarget); attempt += 1) {
          if (request.signal?.aborted) {
            lastFailure = 'CANCELLED';
            break;
          }
          callOrdinal += 1;
          const outcome = await this.call(principal, request, provider, target, {
            invocationId,
            callOrdinal,
            fellBackFrom,
            refs,
            estimatedInputTokens,
            budget,
            routingPolicyVersion: admission.routingPolicyVersion,
            budgetClass: admission.budgetClass,
          });
          lastTarget = target;

          if (outcome.kind === 'NOT_RESERVED') {
            // No reservation, no call. On the first call this is a refusal; on a
            // retry or fallback, it ends the attempt with the failure that led here.
            if (callOrdinal === 1) return { outcome: 'REFUSED_BY_LOOP', refusals: outcome.refusals };
            callOrdinal -= 1;
            return { outcome: 'FAILED', failure: lastFailure, provenance: provenance(target, null, 'FAILED') };
          }

          if (outcome.kind === 'RESULT') {
            return await this.conclude(request, outcome, provenance);
          }

          lastFailure = outcome.failure;
          latencyMs = this.deps.now().getTime() - startedAt;
          if (outcome.failure === 'CANCELLED') break;
          if (!providerFailurePolicy(outcome.failure).retry) break;
        }

        if (lastFailure === 'CANCELLED') break;
        // Only the failure classes Loop says may fall back, do.
        if (!providerFailurePolicy(lastFailure).fallback) break;
      }
    } catch (err) {
      if (err instanceof LedgerUnavailable) {
        return { outcome: 'FAILED', failure: 'LEDGER_UNAVAILABLE', provenance: provenance(lastTarget, null, 'FAILED') };
      }
      throw err;
    }

    return { outcome: 'FAILED', failure: lastFailure, provenance: provenance(lastTarget, null, 'FAILED') };
  }

  /** Steps 11-13 for one call: reserve, then (and only then) invoke under a deadline. */
  private async call(
    principal: AiPrincipal,
    request: AiRunRequest,
    provider: AiProviderPort,
    target: AiRouteTargetPolicy,
    meta: {
      invocationId: string;
      callOrdinal: number;
      fellBackFrom: string | null;
      refs: readonly string[];
      estimatedInputTokens: number;
      budget: AiBudgetPolicy;
      routingPolicyVersion: string;
      budgetClass: string;
    },
  ): Promise<CallOutcome> {
    const callKey = meta.callOrdinal === 1 ? meta.invocationId : `${meta.invocationId}.${meta.callOrdinal}`;
    const estimate: AiCallEstimate = { inputTokens: meta.estimatedInputTokens, outputTokens: target.maxOutputTokens };

    let reserved: AiReserveResult;
    try {
      reserved = await this.deps.ledger.reserve(
        {
          organizationId: principal.organizationId,
          callKey,
          principalUserId: principal.userId,
          taskId: request.task.taskId,
          taskVersion: request.task.version,
          capabilityRoute: request.task.capabilityRoute,
          target,
          routingPolicyVersion: meta.routingPolicyVersion,
          budgetClass: meta.budgetClass,
          templateId: request.templateId,
          templateVersion: request.templateVersion,
          contextSourceRefs: meta.refs,
          estimate,
          fellBackFrom: meta.fellBackFrom,
          callOrdinal: meta.callOrdinal,
          requestedAt: this.deps.now(),
        },
        meta.budget,
        this.config.activation.organizations,
      );
    } catch {
      return { kind: 'NOT_RESERVED', refusals: ['LEDGER_UNAVAILABLE'] };
    }
    if (!reserved.ok) return { kind: 'NOT_RESERVED', refusals: reserved.refusals };

    // 12-13. Reserved; the call is now eligible, and bounded by the route's deadline.
    const modelRequest: AiModelRequest = {
      invocationId: callKey,
      model: { providerId: target.providerId, modelId: target.modelId },
      instructions: request.instructions,
      input: request.context.items,
      tools: [],
      output: { kind: 'JSON_SCHEMA', schemaId: request.task.outputSchemaId, schema: request.schema, strict: true },
      limits: { maxOutputTokens: target.maxOutputTokens, timeoutMs: target.timeoutMs },
      reasoningEffort: target.reasoningEffort,
    };

    const controller = new AbortController();
    let timedOut = false;
    const schedule = this.deps.schedule ?? ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });
    const cancelTimer = schedule(() => {
      timedOut = true;
      controller.abort();
    }, target.timeoutMs);
    const onCallerAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const started = this.deps.now().getTime();

    let failure: string;
    try {
      const result = await provider.invoke(modelRequest, controller.signal);
      if (timedOut) throw Object.assign(new Error('deadline'), { failure: 'TIMEOUT' });
      return { kind: 'RESULT', result, callKey, target };
    } catch (err) {
      failure = timedOut ? 'TIMEOUT' : request.signal?.aborted ? 'CANCELLED' : classify(err);
    } finally {
      cancelTimer();
      request.signal?.removeEventListener('abort', onCallerAbort);
    }

    // The call happened and failed. Its reservation keeps counting unless the
    // provider told us what it actually cost, and it did not.
    await this.reconcile(principal.organizationId, {
      callKey,
      outcome: failure === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
      servedModel: null,
      providerRequestId: null,
      usage: null,
      unitCostBasis: target.pricing?.listVersion ?? null,
      failureClass: failure,
      rejectionCodes: [],
      completedAt: this.deps.now(),
      latencyMs: this.deps.now().getTime() - started,
    });
    return { kind: 'FAILURE', failure, callKey, target };
  }

  /** Steps 14-17 for a call that returned. */
  private async conclude(
    request: AiRunRequest,
    outcome: Extract<CallOutcome, { kind: 'RESULT' }>,
    provenance: (target: AiRouteTargetPolicy, result: AiModelResult | null, outcome: AiInvocationProvenance['outcome']) => AiInvocationProvenance,
  ): Promise<AiRunResult> {
    const { result, callKey, target } = outcome;
    const organizationId = request.context.organizationId;
    const base = {
      callKey,
      servedModel: result.reportedModel,
      providerRequestId: result.providerRequestId,
      usage: result.usage,
      unitCostBasis: target.pricing?.listVersion ?? null,
      completedAt: this.deps.now(),
      latencyMs: result.latencyMs,
    };

    // A refusal is an outcome. It is recorded and it stops here.
    if (result.stopReason === 'REFUSAL' || result.stopReason === 'CONTENT_FILTERED') {
      await this.reconcile(organizationId, { ...base, outcome: 'REFUSED_BY_MODEL', failureClass: null, rejectionCodes: [] });
      return { outcome: 'REFUSED_BY_MODEL', provenance: provenance(target, result, 'REFUSED_BY_MODEL') };
    }

    // 14. Checked before anybody sees it. A truncated answer is not half an answer.
    const parsed = result.stopReason === 'END' ? parseAiTaskOutput(result.output.json ?? safeJson(result.output.text)) : null;
    const rejections: AiOutputRejection[] = parsed
      ? validateAiTaskOutput(parsed, request.task, new Set(request.context.items.map((i) => i.sourceRef)), request.evidence)
      : ['WRONG_SCHEMA'];
    const accepted = parsed !== null && rejections.length === 0;

    // 15. Reconcile before returning; a failure to record withholds the answer.
    await this.reconcile(organizationId, {
      ...base,
      outcome: accepted ? 'ANSWERED' : 'REJECTED_BY_LOOP',
      failureClass: accepted
        ? null
        : result.stopReason === 'MAX_TOKENS'
          ? 'OUTPUT_TRUNCATED'
          : result.stopReason === 'END'
            ? 'OUTPUT_INVALID'
            : 'OUTPUT_INCOMPLETE',
      rejectionCodes: rejections,
    });

    if (!accepted) return { outcome: 'REJECTED_OUTPUT', rejections, provenance: provenance(target, result, 'REJECTED_BY_LOOP') };
    return { outcome: 'ANSWERED', output: parsed, provenance: provenance(target, result, 'ANSWERED') };
  }

  private async reconcile(organizationId: string, reconciliation: AiCallReconciliation): Promise<void> {
    let recorded = false;
    try {
      recorded = await this.deps.ledger.reconcile(organizationId, reconciliation);
    } catch {
      recorded = false;
    }
    if (!recorded) throw new LedgerUnavailable();
  }
}

/** Integer micro-dollars a call is estimated to cost, for the reservation row. */
export function aiReservationCostMicros(target: AiRouteTargetPolicy, estimate: AiCallEstimate): number | null {
  return aiCostMicros(target.pricing, estimate);
}

/** An adapter reports a failure class; anything else is UNCLASSIFIED and fails closed. */
function classify(err: unknown): string {
  const failure = (err as { failure?: unknown })?.failure;
  return typeof failure === 'string' && (AI_FAILURE_CLASSES as readonly string[]).includes(failure) ? failure : 'UNCLASSIFIED';
}

function safeJson(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

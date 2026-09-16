// The decisions Loop makes about a model, none of which a model makes. Slices AI S0, AI-1.
//
// Architecture: docs/architecture/loop-ai-runtime.md §5, §8, §9, §12 (F2, F5/F6, F7,
// F10-F11), approved as PD-F-08. Activation, routing, budgets, kill switches and
// output admission are POLICY, and policy is a pure function of configuration and
// recorded state. That is deliberate: it makes every one of them testable without a
// network, and it keeps "which model answered, and why" a question with a written
// answer.
//
// OFF IS THE DEFAULT, AND CREDENTIALS ARE NOT A SWITCH. A deployment holding valid
// provider keys still makes no call until an operator enables the runtime globally,
// for the organization, for the task and for the provider. Four separate answers,
// because "the key is present" means CONFIGURED and nothing more.
//
// ROUTING IS VERSIONED POLICY, PER TASK. A task names what it needs; a reviewed,
// versioned routing policy names the exact primary and fallback models for that
// task version. The model ids live in that policy and nowhere in domain code, so
// changing the model that answers is a reviewed configuration change -- never a
// provider alias quietly moving underneath a pinned request.
//
// A KILL SWITCH IS NOT A FEATURE FLAG. It is checked before routing, it fails
// closed, and it exists at five scopes because the thing going wrong is rarely the
// whole system: one model, one provider, one task, or one organization.
//
// BUDGETS ARE CHECKED TWICE. Once here, cheaply, before anything is assembled; and
// again, authoritatively, inside the durable reservation -- because two serverless
// instances reading the same spend-to-date would otherwise both decide there was
// room. This file only says what "room" means.
//
// PURE. No clock, no I/O. Instants and counters are supplied by the caller.

import { aiToolsAdmissible, type AiModelRequest, type AiUsage } from './provider';
import { aiContextSourceRefs, type AiContextPackage } from './context';

/** What a task needs of a model, not which model. Recorded on the task; routing is per task. */
export const AI_CAPABILITY_PROFILES = ['EXPLANATION', 'EXTRACTION', 'CLASSIFICATION', 'DRAFTING'] as const;
export type AiCapabilityProfile = (typeof AI_CAPABILITY_PROFILES)[number];

/** How hard a model should think. Provider-neutral; each adapter maps it to its own knob. */
export const AI_REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];

export interface AiRouteTarget {
  readonly providerId: string;
  readonly modelId: string;
}

/**
 * What a model costs, copied from the provider's published price list and VERSIONED.
 * The ledger records raw usage plus `listVersion`, so a corrected price re-values
 * history rather than rewriting it (Product, 2026-09-16).
 */
export interface AiModelPricing {
  /** Which published list these figures came from, and when it was read. */
  readonly listVersion: string;
  /** Integer micro-dollars per token. $5 per million tokens is exactly 5. */
  readonly inputMicrosPerToken: number;
  readonly outputMicrosPerToken: number;
}

/** One model a task may be served by, and the limits it is served under. */
export interface AiRouteTargetPolicy extends AiRouteTarget {
  readonly reasoningEffort: AiReasoningEffort;
  /** The deadline for one provider call. The gateway enforces it; the provider is told it. */
  readonly timeoutMs: number;
  /** Output ceiling for one call. Reasoning tokens count against it on every current provider. */
  readonly maxOutputTokens: number;
  /** Null when nobody has priced it; the reservation then records no cost estimate. */
  readonly pricing: AiModelPricing | null;
}

/** The reviewed answer to "which model serves this task version, and what if it cannot". */
export interface AiTaskRoutePolicy {
  readonly taskId: string;
  /** A task version the policy was not reviewed against is refused, not guessed at. */
  readonly taskVersion: string;
  readonly primary: AiRouteTargetPolicy;
  readonly fallback: AiRouteTargetPolicy | null;
  /**
   * Fallback is AVAILABILITY behaviour. It serves when the primary is unavailable --
   * never to get a second opinion, and never after a refusal.
   */
  readonly fallbackPermitted: boolean;
  /** Which budget class limits this task. */
  readonly budgetClass: string;
}

export interface AiRoutingPolicy {
  /** Recorded on every call, so "which table chose this model" has an answer. */
  readonly version: string;
  readonly tasks: Readonly<Record<string, AiTaskRoutePolicy>>;
}

// --- Activation ----------------------------------------------------------------------------

/**
 * Whether the runtime may run at all, for whom, for what, through which provider.
 * Every list is an ALLOWLIST; an empty list admits nobody.
 */
export interface AiActivation {
  readonly enabled: boolean;
  readonly organizations: readonly string[];
  readonly tasks: readonly string[];
  readonly providers: readonly string[];
}

export const AI_ACTIVATION_OFF: AiActivation = Object.freeze({
  enabled: false,
  organizations: Object.freeze([]) as readonly string[],
  tasks: Object.freeze([]) as readonly string[],
  providers: Object.freeze([]) as readonly string[],
});

// --- Kill switches -------------------------------------------------------------------------

export const AI_KILL_SWITCH_SCOPES = ['GLOBAL', 'PROVIDER', 'MODEL', 'TASK', 'ORGANIZATION'] as const;
export type AiKillSwitchScope = (typeof AI_KILL_SWITCH_SCOPES)[number];

export interface AiKillSwitch {
  readonly scope: AiKillSwitchScope;
  /** The provider, model, task or organization this stops. Ignored for GLOBAL. */
  readonly value?: string;
}

// --- Budgets -------------------------------------------------------------------------------

/** A ceiling on one window of spend. Zero, negative or non-finite means nothing is allowed. */
export interface AiSpendCaps {
  readonly maxInvocations: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

export interface AiBudgetClass {
  /** Per call: one runaway request cannot spend the day. */
  readonly maxInputTokensPerCall: number;
  readonly maxOutputTokensPerCall: number;
  /** Per task, per organization, per the organization's business day. */
  readonly taskDaily: AiSpendCaps;
}

/**
 * Budgets are CONFIGURATION: absent means disabled (activation gate G4). There is no
 * per-user cap at launch (Product, 2026-09-16) -- the principal is attribution, not a
 * budget grain.
 */
export interface AiBudgetPolicy {
  readonly version: string;
  readonly classes: Readonly<Record<string, AiBudgetClass>>;
  /** Per organization, per its own business day (`Organization.timezone`). */
  readonly organizationDaily: AiSpendCaps;
  /** Across every organization the runtime is enabled for, over the trailing 24 hours. */
  readonly globalDaily: AiSpendCaps;
}

/** What has already been spent in one window, read from the durable usage ledger. */
export interface AiSpendToday {
  readonly invocations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const AI_NO_SPEND: AiSpendToday = Object.freeze({ invocations: 0, inputTokens: 0, outputTokens: 0 });

export interface AiSpendSnapshot {
  readonly organization: AiSpendToday;
  readonly task: AiSpendToday;
  readonly global: AiSpendToday;
}

/** What one provider call is expected to cost before it is made. Deliberately pessimistic. */
export interface AiCallEstimate {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A context-size estimate that errs high. The ledger replaces it with what was reported. */
export const AI_ESTIMATE_OVERHEAD_TOKENS = 1024;

/**
 * Two characters per token is well under what any current tokenizer achieves on
 * English or JSON, so this OVER-estimates on purpose: a reservation that is too big
 * refuses early, while one that is too small lets a burst through.
 */
export function estimateAiInputTokens(parts: readonly string[]): number {
  const chars = parts.reduce((total, part) => total + (typeof part === 'string' ? part.length : 0), 0);
  return Math.ceil(chars / 2) + AI_ESTIMATE_OVERHEAD_TOKENS;
}

/** Integer micro-dollars for an estimate or a report. Null when unpriced or unreported. */
export function aiCostMicros(
  pricing: AiModelPricing | null,
  tokens: { readonly inputTokens: number | null; readonly outputTokens: number | null },
): number | null {
  if (!pricing || tokens.inputTokens === null || tokens.outputTokens === null) return null;
  return Math.ceil(tokens.inputTokens * pricing.inputMicrosPerToken + tokens.outputTokens * pricing.outputMicrosPerToken);
}

function capOk(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function exceeds(caps: AiSpendCaps, spent: AiSpendToday, estimate: AiCallEstimate): boolean {
  if (!capOk(caps.maxInvocations) || !capOk(caps.maxInputTokens) || !capOk(caps.maxOutputTokens)) return true;
  return (
    spent.invocations + 1 > caps.maxInvocations ||
    spent.inputTokens + estimate.inputTokens > caps.maxInputTokens ||
    spent.outputTokens + estimate.outputTokens > caps.maxOutputTokens
  );
}

/**
 * Whether ONE more call of this size fits. "Fits" includes the call itself: a
 * reservation that only checked what was already spent would admit the call that
 * crosses the line.
 */
export function aiBudgetRefusals(
  budget: AiBudgetPolicy | null | undefined,
  budgetClass: string,
  estimate: AiCallEstimate,
  spend: AiSpendSnapshot,
): AiAdmissionRefusal[] {
  if (!budget) return ['BUDGET_NOT_CONFIGURED'];
  const cls = budget.classes[budgetClass];
  if (!cls) return ['BUDGET_CLASS_UNKNOWN'];
  const out: AiAdmissionRefusal[] = [];
  if (!capOk(cls.maxInputTokensPerCall) || estimate.inputTokens > cls.maxInputTokensPerCall) out.push('INPUT_LIMIT_ABOVE_POLICY');
  if (!capOk(cls.maxOutputTokensPerCall) || estimate.outputTokens > cls.maxOutputTokensPerCall) out.push('OUTPUT_LIMIT_ABOVE_POLICY');
  if (exceeds(cls.taskDaily, spend.task, estimate)) out.push('BUDGET_TASK_EXHAUSTED');
  if (exceeds(budget.organizationDaily, spend.organization, estimate)) out.push('BUDGET_ORGANIZATION_EXHAUSTED');
  if (exceeds(budget.globalDaily, spend.global, estimate)) out.push('BUDGET_GLOBAL_EXHAUSTED');
  return out;
}

// --- Admission -----------------------------------------------------------------------------

export const AI_ADMISSION_REFUSALS = [
  'NOT_AUTHORIZED',
  'NOT_ACTIVATED',
  'ORGANIZATION_NOT_ENABLED',
  'TASK_NOT_ENABLED',
  'KILL_SWITCH',
  'CONTEXT_REFUSED',
  'WRITING_TOOL_REQUESTED',
  'NO_ROUTE_FOR_TASK',
  'ROUTE_TASK_VERSION_MISMATCH',
  'PROVIDER_NOT_ENABLED',
  'PROVIDER_NOT_REGISTERED',
  'BUDGET_NOT_CONFIGURED',
  'BUDGET_CLASS_UNKNOWN',
  'INPUT_LIMIT_ABOVE_POLICY',
  'OUTPUT_LIMIT_ABOVE_POLICY',
  'BUDGET_TASK_EXHAUSTED',
  'BUDGET_ORGANIZATION_EXHAUSTED',
  'BUDGET_GLOBAL_EXHAUSTED',
  'RESERVATION_CONTENDED',
  'DUPLICATE_INVOCATION',
  'LEDGER_UNAVAILABLE',
] as const;
export type AiAdmissionRefusal = (typeof AI_ADMISSION_REFUSALS)[number];

export interface AiAdmissionRequest {
  readonly taskId: string;
  readonly taskVersion: string;
  readonly organizationId: string;
  /** Decided by the caller from the principal's own grants, before this is asked. */
  readonly authorized: boolean;
  readonly activation: AiActivation;
  readonly policy: AiRoutingPolicy;
  readonly killSwitches: readonly AiKillSwitch[];
  readonly budget: AiBudgetPolicy | null;
  readonly spend: AiSpendSnapshot;
  /** Input tokens the call is estimated to send. Output is the route's own ceiling. */
  readonly estimatedInputTokens: number;
  readonly registeredProviders: readonly string[];
  readonly contextRefusals: readonly string[];
  readonly tools: readonly { readonly writes?: unknown }[];
}

/** Why an admissible primary did not serve. Recorded, so a provider never changes silently. */
export interface AiSkippedTarget {
  readonly target: AiRouteTarget;
  readonly reason: 'KILL_SWITCH' | 'PROVIDER_NOT_ENABLED' | 'PROVIDER_NOT_REGISTERED';
}

export type AiAdmission =
  | {
      readonly ok: true;
      readonly route: AiRouteTargetPolicy;
      readonly fallbacks: readonly AiRouteTargetPolicy[];
      readonly skipped: readonly AiSkippedTarget[];
      readonly routingPolicyVersion: string;
      readonly budgetClass: string;
    }
  | { readonly ok: false; readonly refusals: readonly AiAdmissionRefusal[] };

/**
 * Whether this invocation may happen at all, and if so which model serves it.
 *
 * AN UNAUTHORIZED CALLER LEARNS ONE THING: that they are not authorized. Whether the
 * runtime is on, which provider would have served, and how much budget is left are
 * facts about the organization, and a person who may not invoke the task does not
 * get them as a side effect of asking.
 *
 * Everyone else sees every reason at once, so an operator fixes one thing rather
 * than five in turn. The free checks come first, so a killed switch or a disabled
 * organization never assembles a route.
 */
export function admitAiInvocation(request: AiAdmissionRequest): AiAdmission {
  if (!request.authorized) return { ok: false, refusals: ['NOT_AUTHORIZED'] };

  const refusals: AiAdmissionRefusal[] = [];
  const { activation } = request;
  if (activation.enabled !== true) refusals.push('NOT_ACTIVATED');
  if (!activation.organizations.includes(request.organizationId)) refusals.push('ORGANIZATION_NOT_ENABLED');
  if (!activation.tasks.includes(request.taskId)) refusals.push('TASK_NOT_ENABLED');
  if (isStopped(request)) refusals.push('KILL_SWITCH');
  if (request.contextRefusals.length > 0) refusals.push('CONTEXT_REFUSED');
  if (!aiToolsAdmissible(request.tools)) refusals.push('WRITING_TOOL_REQUESTED');

  const route = request.policy.tasks[request.taskId];
  if (!route) return { ok: false, refusals: unique([...refusals, 'NO_ROUTE_FOR_TASK']) };
  if (route.taskVersion !== request.taskVersion) refusals.push('ROUTE_TASK_VERSION_MISMATCH');

  const candidates = [route.primary, ...(route.fallbackPermitted && route.fallback ? [route.fallback] : [])];
  const skipped: AiSkippedTarget[] = [];
  const serving: AiRouteTargetPolicy[] = [];
  for (const target of candidates) {
    const reason = unavailableReason(request, target);
    if (reason) skipped.push({ target: { providerId: target.providerId, modelId: target.modelId }, reason });
    else serving.push(target);
  }
  if (serving.length === 0) {
    if (skipped.some((s) => s.reason === 'PROVIDER_NOT_ENABLED')) refusals.push('PROVIDER_NOT_ENABLED');
    if (skipped.some((s) => s.reason === 'PROVIDER_NOT_REGISTERED')) refusals.push('PROVIDER_NOT_REGISTERED');
    if (skipped.some((s) => s.reason === 'KILL_SWITCH')) refusals.push('KILL_SWITCH');
  }

  const [primary, ...fallbacks] = serving;
  if (primary) {
    const estimate = { inputTokens: request.estimatedInputTokens, outputTokens: primary.maxOutputTokens };
    refusals.push(...aiBudgetRefusals(request.budget, route.budgetClass, estimate, request.spend));
  }

  if (refusals.length > 0 || !primary) {
    return { ok: false, refusals: unique(refusals.length > 0 ? refusals : ['NO_ROUTE_FOR_TASK']) };
  }
  return {
    ok: true,
    route: primary,
    fallbacks,
    skipped,
    routingPolicyVersion: request.policy.version,
    budgetClass: route.budgetClass,
  };
}

function unavailableReason(request: AiAdmissionRequest, target: AiRouteTarget): AiSkippedTarget['reason'] | null {
  if (stoppedTarget(request.killSwitches, target)) return 'KILL_SWITCH';
  if (!request.activation.providers.includes(target.providerId)) return 'PROVIDER_NOT_ENABLED';
  if (!request.registeredProviders.includes(target.providerId)) return 'PROVIDER_NOT_REGISTERED';
  return null;
}

function isStopped(request: AiAdmissionRequest): boolean {
  return request.killSwitches.some(
    (k) =>
      k.scope === 'GLOBAL' ||
      (k.scope === 'TASK' && k.value === request.taskId) ||
      (k.scope === 'ORGANIZATION' && k.value === request.organizationId),
  );
}

function stoppedTarget(switches: readonly AiKillSwitch[], target: AiRouteTarget): boolean {
  return switches.some(
    (k) => (k.scope === 'PROVIDER' && k.value === target.providerId) || (k.scope === 'MODEL' && k.value === target.modelId),
  );
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

// --- Availability, for a screen ------------------------------------------------------

export const AI_TASK_AVAILABILITY = ['AVAILABLE', 'NOT_AUTHORIZED', 'NOT_ENABLED', 'PAUSED', 'NOT_CONFIGURED'] as const;
export type AiTaskAvailability = (typeof AI_TASK_AVAILABILITY)[number];

/**
 * What a surface may OFFER, decided without calling anything. It is a courtesy, not a
 * gate: the gateway re-decides every one of these when the task is actually invoked.
 *
 *   NOT_AUTHORIZED  this person may not invoke the task (and learns nothing more);
 *   NOT_ENABLED     the runtime, the organization or the task is not switched on;
 *   PAUSED          a kill switch stops it;
 *   NOT_CONFIGURED  no enabled provider on the task's route has a working client.
 */
export function aiTaskAvailability(input: {
  readonly authorized: boolean;
  readonly activation: AiActivation;
  readonly killSwitches: readonly AiKillSwitch[];
  readonly policy: AiRoutingPolicy;
  readonly organizationId: string;
  readonly taskId: string;
}): AiTaskAvailability {
  if (!input.authorized) return 'NOT_AUTHORIZED';
  const a = input.activation;
  if (a.enabled !== true || !a.organizations.includes(input.organizationId) || !a.tasks.includes(input.taskId)) return 'NOT_ENABLED';
  const route = input.policy.tasks[input.taskId];
  if (!route) return 'NOT_ENABLED';
  const stopped = input.killSwitches.some(
    (k) =>
      k.scope === 'GLOBAL' ||
      (k.scope === 'TASK' && k.value === input.taskId) ||
      (k.scope === 'ORGANIZATION' && k.value === input.organizationId),
  );
  if (stopped) return 'PAUSED';
  const targets = [route.primary, ...(route.fallbackPermitted && route.fallback ? [route.fallback] : [])];
  const usable = targets.filter((t) => !stoppedTarget(input.killSwitches, t) && a.providers.includes(t.providerId));
  if (usable.length === 0) {
    return targets.some((t) => stoppedTarget(input.killSwitches, t)) ? 'PAUSED' : 'NOT_CONFIGURED';
  }
  return 'AVAILABLE';
}

// --- Provenance -----------------------------------------------------------------------

export interface AiInvocationProvenance {
  readonly invocationId: string;
  readonly organizationId: string;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly routingPolicyVersion: string;
  readonly requestedModel: AiRouteTarget;
  /** What the provider says served it, which is the one worth keeping. */
  readonly servedModel: string | null;
  readonly providerRequestId: string | null;
  /** Whose authority assembled the context and triggered the task. */
  readonly viewerUserId: string;
  readonly contextSourceRefs: readonly string[];
  /** Null when no provider reported usage -- never zeroes, which would read as "free". */
  readonly usage: AiUsage | null;
  /** Every provider call this invocation made, in order. A fallback is never invisible. */
  readonly calls: number;
  readonly latencyMs: number;
  readonly outcome: 'ANSWERED' | 'REFUSED_BY_MODEL' | 'REJECTED_BY_LOOP' | 'FAILED';
  readonly recordedAt: string;
}

/**
 * The record every invocation leaves, whatever happened. An answer nobody can trace
 * is not intelligence, it is a rumour with a timestamp -- and a refusal or a failure
 * is as much a fact about the system as an answer is.
 */
export function aiProvenanceOf(
  pkg: AiContextPackage,
  fields: Omit<AiInvocationProvenance, 'organizationId' | 'taskId' | 'viewerUserId' | 'contextSourceRefs'>,
): AiInvocationProvenance {
  return {
    ...fields,
    organizationId: pkg.organizationId,
    taskId: pkg.taskId,
    viewerUserId: pkg.viewerUserId,
    contextSourceRefs: [...aiContextSourceRefs(pkg)].sort(),
  };
}

/** A request is only ever built for an admitted route, so the two cannot disagree. */
export function aiRequestMatchesRoute(request: Pick<AiModelRequest, 'model'>, route: AiRouteTarget): boolean {
  return request.model.providerId === route.providerId && request.model.modelId === route.modelId;
}

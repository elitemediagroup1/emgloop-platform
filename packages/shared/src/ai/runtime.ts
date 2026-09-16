// The decisions Loop makes about a model, none of which a model makes. Slice AI S0.
//
// Architecture: docs/architecture/loop-ai-runtime.md §5, §8, §9, §12 (F2, F5/F6, F7,
// F10-F11), approved as PD-F-08. Routing, budgets, kill switches and output
// admission are POLICY, and policy is a pure function of configuration and recorded
// state. That is deliberate: it makes every one of them testable without a network,
// and it keeps "which model answered, and why" a question with a written answer.
//
// LOOP OWNS ROUTING. A task names a CAPABILITY PROFILE, never a provider. The
// policy maps a profile to a primary and a fallback, and an operator changes that
// mapping by configuration. Nothing in the domain says "use Claude for this" --
// the day that sentence appears in a service, the abstraction is already gone.
//
// A KILL SWITCH IS NOT A FEATURE FLAG. It is checked before routing, it fails
// closed, and it exists at four scopes because the thing going wrong is rarely the
// whole system: one model, one provider, one task, or one organization.
//
// PURE. No clock, no I/O. Instants and counters are supplied by the caller.

import { aiToolsAdmissible, type AiModelRequest, type AiUsage } from './provider';
import { aiContextSourceRefs, type AiContextPackage } from './context';

/** What a task needs of a model, not which model. */
export const AI_CAPABILITY_PROFILES = ['EXPLANATION', 'EXTRACTION', 'CLASSIFICATION', 'DRAFTING'] as const;
export type AiCapabilityProfile = (typeof AI_CAPABILITY_PROFILES)[number];

export interface AiRouteTarget {
  readonly providerId: string;
  readonly modelId: string;
}

export interface AiRoutingPolicy {
  /** Profile -> ordered candidates. The first admissible one serves; the rest are fallbacks. */
  readonly routes: Readonly<Record<string, readonly AiRouteTarget[]>>;
}

export const AI_KILL_SWITCH_SCOPES = ['GLOBAL', 'PROVIDER', 'MODEL', 'TASK', 'ORGANIZATION'] as const;
export type AiKillSwitchScope = (typeof AI_KILL_SWITCH_SCOPES)[number];

export interface AiKillSwitch {
  readonly scope: AiKillSwitchScope;
  /** The provider, model, task or organization this stops. Ignored for GLOBAL. */
  readonly value?: string;
}

export interface AiBudget {
  readonly maxInvocationsPerDay: number;
  readonly maxInputTokensPerDay: number;
  readonly maxOutputTokensPerDay: number;
  /** One invocation's ceiling, so a single runaway request cannot spend the day. */
  readonly maxOutputTokensPerInvocation: number;
}

/** What has already been spent today, read from the durable usage record. */
export interface AiSpendToday {
  readonly invocations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const AI_ADMISSION_REFUSALS = [
  'KILL_SWITCH',
  'NO_ROUTE_FOR_PROFILE',
  'PROVIDER_NOT_REGISTERED',
  'BUDGET_INVOCATIONS_EXHAUSTED',
  'BUDGET_TOKENS_EXHAUSTED',
  'OUTPUT_LIMIT_ABOVE_POLICY',
  'CONTEXT_REFUSED',
  'WRITING_TOOL_REQUESTED',
  'NOT_ACTIVATED',
] as const;
export type AiAdmissionRefusal = (typeof AI_ADMISSION_REFUSALS)[number];

export interface AiAdmissionRequest {
  readonly taskId: string;
  readonly profile: AiCapabilityProfile;
  readonly organizationId: string;
  readonly policy: AiRoutingPolicy;
  readonly killSwitches: readonly AiKillSwitch[];
  readonly budget: AiBudget;
  readonly spentToday: AiSpendToday;
  readonly registeredProviders: readonly string[];
  readonly requestedMaxOutputTokens: number;
  readonly contextRefusals: readonly string[];
  readonly tools: readonly { readonly writes?: unknown }[];
  /** The runtime is not live until an operator says so, per activation gate G6. */
  readonly activated: boolean;
}

export type AiAdmission =
  | { readonly ok: true; readonly route: AiRouteTarget; readonly fallbacks: readonly AiRouteTarget[] }
  | { readonly ok: false; readonly refusals: readonly AiAdmissionRefusal[] };

/**
 * Whether this invocation may happen at all, and if so which model serves it. Every
 * reason to say no is collected, so an operator sees all of them at once rather than
 * fixing one and discovering the next.
 *
 * Order matters for cost, not for correctness: the free checks come first, so a
 * killed switch or an exhausted budget never assembles a route.
 */
export function admitAiInvocation(request: AiAdmissionRequest): AiAdmission {
  const refusals: AiAdmissionRefusal[] = [];
  if (!request.activated) refusals.push('NOT_ACTIVATED');
  if (isStopped(request)) refusals.push('KILL_SWITCH');
  if (request.contextRefusals.length > 0) refusals.push('CONTEXT_REFUSED');
  if (!aiToolsAdmissible(request.tools)) refusals.push('WRITING_TOOL_REQUESTED');

  if (request.spentToday.invocations >= request.budget.maxInvocationsPerDay) refusals.push('BUDGET_INVOCATIONS_EXHAUSTED');
  if (
    request.spentToday.inputTokens >= request.budget.maxInputTokensPerDay ||
    request.spentToday.outputTokens >= request.budget.maxOutputTokensPerDay
  ) {
    refusals.push('BUDGET_TOKENS_EXHAUSTED');
  }
  if (request.requestedMaxOutputTokens > request.budget.maxOutputTokensPerInvocation) refusals.push('OUTPUT_LIMIT_ABOVE_POLICY');

  const candidates = (request.policy.routes[request.profile] ?? []).filter(
    (target) => !stoppedTarget(request.killSwitches, target),
  );
  if (candidates.length === 0) refusals.push('NO_ROUTE_FOR_PROFILE');
  const registered = candidates.filter((target) => request.registeredProviders.includes(target.providerId));
  if (candidates.length > 0 && registered.length === 0) refusals.push('PROVIDER_NOT_REGISTERED');

  const [primary, ...fallbacks] = registered;
  if (refusals.length > 0 || !primary) {
    return { ok: false, refusals: [...new Set(refusals.length > 0 ? refusals : ['NO_ROUTE_FOR_PROFILE' as const])] };
  }
  return { ok: true, route: primary, fallbacks };
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

// --- Provenance -----------------------------------------------------------------------

export interface AiInvocationProvenance {
  readonly invocationId: string;
  readonly organizationId: string;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly requestedModel: AiRouteTarget;
  /** What the provider says served it, which is the one worth keeping. */
  readonly servedModel: string | null;
  readonly providerRequestId: string | null;
  /** Whose authority assembled the context and triggered the task. */
  readonly viewerUserId: string;
  readonly contextSourceRefs: readonly string[];
  readonly usage: AiUsage;
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

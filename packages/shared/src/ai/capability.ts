// What capability a task needs, and which provider a reviewed policy prefers for it. Slice B2.
//
// Architecture: docs/architecture/brain-execution-architecture.md §5a (provider
// specialization, approved 2026-09-16) and loop-ai-runtime.md §5.
//
// ONE VOCABULARY, NOT TWO. Until B2 a task carried a capability `profile` (EXPLANATION,
// EXTRACTION, CLASSIFICATION, DRAFTING). The gateway copied it into every
// `ai_invocations` row, and nothing else read it: not routing, not a template, not the
// evaluation. It was a label for the question the capability route now answers --
// "what kind of model capability does this task need?" -- so the route REPLACES it.
// The ledger column keeps its name (`ai_invocations.profile`; renaming it needs a
// migration) and carries the route from B2 on. `aiLedgerCapabilityOf` keeps a row
// written with the retired words readable, without pretending to know its route.
//
// A TASK NEVER NAMES A PROVIDER. It declares the capability it needs. The
// specialization policy says which provider that capability prefers by default; the
// routing policy names exact models per task version; and a routing entry that departs
// from the preference must say why. All three are versioned data changed by reviewed
// pull request. None of it is a conditional in code.
//
// PREFERENCE DECIDES THE PRIMARY, NOT THE FALLBACK. A fallback stays availability
// behaviour under the failure policy, and is recorded. It never happens because
// another provider's output is preferred.
//
// PURE. No clock, no I/O.

import type { AiRoutingPolicy } from './runtime';

export const AI_CAPABILITY_ROUTES = ['COMMUNICATION', 'TECHNICAL_ANALYSIS', 'GENERAL_REASONING'] as const;
export type AiCapabilityRoute = (typeof AI_CAPABILITY_ROUTES)[number];

export function isAiCapabilityRoute(value: unknown): value is AiCapabilityRoute {
  return typeof value === 'string' && (AI_CAPABILITY_ROUTES as readonly string[]).includes(value);
}

/** What each route covers, in the words of the approved decision. New routes are a reviewed change. */
export const AI_CAPABILITY_ROUTE_SCOPE: Readonly<Record<AiCapabilityRoute, string>> = Object.freeze({
  COMMUNICATION:
    'Work whose main output is language meant for a person: drafting and rewriting email, outreach, follow-ups, ' +
    'client-facing communication, conversational responses, tone and style adaptation, meeting follow-up.',
  TECHNICAL_ANALYSIS:
    'Technical reasoning, engineering and code analysis, architecture reasoning, complex investigations, ' +
    'evidence synthesis, diagnostics, and other deeply structured analysis.',
  GENERAL_REASONING: 'Anything else. There is no global default provider: each task names its own, with a reason.',
});

/** One route's default. `null` means no default: every task on the route must choose, and justify, its provider. */
export interface AiCapabilityRoutePreference {
  readonly preferredProviderId: string | null;
  readonly rationale: string;
}

/**
 * Provider specialization as data. Versioned, because "which provider does this kind of
 * work prefer" is a decision somebody made on a date, and it can change.
 */
export interface AiProviderSpecializationPolicy {
  readonly version: string;
  readonly routes: Readonly<Record<AiCapabilityRoute, AiCapabilityRoutePreference>>;
}

export const AI_ROUTE_CONFORMANCE_FINDINGS = [
  'UNKNOWN_CAPABILITY_ROUTE',
  'NO_ROUTE_FOR_TASK',
  'ROUTE_TASK_VERSION_MISMATCH',
  'PREFERENCE_DEPARTED_WITHOUT_REASON',
  'NO_DEFAULT_AND_NO_REASON',
  'FALLBACK_DUPLICATES_PRIMARY',
] as const;
export type AiRouteConformanceFinding = (typeof AI_ROUTE_CONFORMANCE_FINDINGS)[number];

export interface AiRouteConformance {
  readonly taskId: string;
  readonly capabilityRoute: string;
  readonly preferredProviderId: string | null;
  readonly primaryProviderId: string | null;
  /** NONE: the primary is the route's preference. JUSTIFIED: it departs, and the policy says why. */
  readonly departure: 'NONE' | 'JUSTIFIED' | null;
  readonly findings: readonly AiRouteConformanceFinding[];
}

/** Just what conformance needs of a task, so this file does not depend on the task module. */
export interface AiRoutedTask {
  readonly taskId: string;
  readonly version: string;
  readonly capabilityRoute: string;
}

/**
 * Whether a routing policy honours the specialization policy for every task. A routing
 * policy with any finding is not shippable; the providers package proves the shipped
 * pair conforms, so a departure cannot land without its reason being reviewed.
 */
export function aiRoutingConformance(
  tasks: readonly AiRoutedTask[],
  routing: AiRoutingPolicy,
  specialization: AiProviderSpecializationPolicy,
): AiRouteConformance[] {
  return tasks.map((task) => {
    const findings: AiRouteConformanceFinding[] = [];
    const known = isAiCapabilityRoute(task.capabilityRoute);
    const preference = known ? specialization.routes[task.capabilityRoute as AiCapabilityRoute] : undefined;
    if (!known || !preference) findings.push('UNKNOWN_CAPABILITY_ROUTE');

    const entry = routing.tasks[task.taskId];
    if (!entry) {
      findings.push('NO_ROUTE_FOR_TASK');
      return result(task, preference, null, null, findings);
    }
    if (entry.taskVersion !== task.version) findings.push('ROUTE_TASK_VERSION_MISMATCH');

    const reason = typeof entry.providerChoiceReason === 'string' ? entry.providerChoiceReason.trim() : '';
    const primaryProvider = entry.primary.providerId;
    let departure: AiRouteConformance['departure'] = null;
    if (preference) {
      if (preference.preferredProviderId === null) {
        if (reason) departure = 'JUSTIFIED';
        else findings.push('NO_DEFAULT_AND_NO_REASON');
      } else if (primaryProvider === preference.preferredProviderId) {
        departure = 'NONE';
      } else if (reason) {
        departure = 'JUSTIFIED';
      } else {
        findings.push('PREFERENCE_DEPARTED_WITHOUT_REASON');
      }
    }
    if (
      entry.fallback &&
      entry.fallback.providerId === entry.primary.providerId &&
      entry.fallback.modelId === entry.primary.modelId
    ) {
      findings.push('FALLBACK_DUPLICATES_PRIMARY');
    }
    return result(task, preference, primaryProvider, departure, findings);
  });
}

function result(
  task: AiRoutedTask,
  preference: AiCapabilityRoutePreference | undefined,
  primaryProviderId: string | null,
  departure: AiRouteConformance['departure'],
  findings: AiRouteConformanceFinding[],
): AiRouteConformance {
  return {
    taskId: task.taskId,
    capabilityRoute: task.capabilityRoute,
    preferredProviderId: preference?.preferredProviderId ?? null,
    primaryProviderId,
    departure,
    findings: [...new Set(findings)],
  };
}

// --- Reading the ledger's capability column ---------------------------------------------

/**
 * The words `ai_invocations.profile` held before B2. Kept only so a row written then
 * reads as what it is. No task may declare one, and none is mapped to a route: the old
 * vocabulary described the shape of the work, not which capability served it, and
 * guessing would be a fabricated certainty (Engineering Principles Rule 7).
 */
export const AI_RETIRED_CAPABILITY_PROFILES = ['EXPLANATION', 'EXTRACTION', 'CLASSIFICATION', 'DRAFTING'] as const;
export type AiRetiredCapabilityProfile = (typeof AI_RETIRED_CAPABILITY_PROFILES)[number];

export type AiLedgerCapability =
  | { readonly kind: 'CAPABILITY_ROUTE'; readonly route: AiCapabilityRoute }
  | { readonly kind: 'RETIRED_PROFILE'; readonly profile: AiRetiredCapabilityProfile }
  | { readonly kind: 'UNRECOGNIZED'; readonly stored: string };

/** How to read the capability a ledger row recorded, whenever it was written. */
export function aiLedgerCapabilityOf(stored: string): AiLedgerCapability {
  if (isAiCapabilityRoute(stored)) return { kind: 'CAPABILITY_ROUTE', route: stored };
  if ((AI_RETIRED_CAPABILITY_PROFILES as readonly string[]).includes(stored)) {
    return { kind: 'RETIRED_PROFILE', profile: stored as AiRetiredCapabilityProfile };
  }
  return { kind: 'UNRECOGNIZED', stored };
}

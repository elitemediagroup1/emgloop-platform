// Stored AI controls: the recorded authority to run, or stop, AI work. Slice B4.
//
// Architecture: docs/architecture/brain-execution-infrastructure.md §17, and the
// persistence record docs/architecture/brain-persistence.md §7.
//
// TWO THINGS, NEVER MERGED. Each deployment's environment (LOOP_AI_* for the web tier,
// and the worker's own switch) is the FLOOR: bootstrap configuration that says whether
// that deployment may run AI at all. A stored control is RECORDED AUTHORITY: who decided,
// when, why, about what. Neither is copied into the other. Work runs only where the
// floor allows it AND the recorded controls allow it, and a KILLED control stops it
// whatever either says. Combining the two is the reader's job (B5), never the store's.
//
// APPEND-ONLY. A change is a new version of one control's history; nothing is edited or
// deleted. The current view is a projection of the latest version, written in the
// same transaction, so it is never ahead of or behind its log.
//
// ABSENT MEANS OFF where a control grants. GLOBAL, ORGANIZATION, a platform TASK and a
// PROVIDER must each be ACTIVE for work to run; there is no default-on control, and no
// control is inferred from a missing one. Two scopes only ever STOP: MODEL (models are
// allowlisted by the reviewed routing policy, not by controls) and a TASK within one
// organization (an organization may switch off a task the platform enabled, never
// switch on one it did not). `aiEffectiveControls` is the one place this is decided.
//
// ONE MORE KIND, KEPT APART (G2, 2026-09-24). A PROVIDER_POLICY control is not an
// activation switch: it records the highest sensitivity class Loop may send to one provider
// (`ceiling`), with a reason. It lives in the same log -- versioned, append-only, KILLED the
// same way -- under its own key namespace (`PROVIDER_POLICY|-|<provider>`), so it can never be
// read as, or collide with, a PROVIDER activation control. `aiEffectiveControls` ignores it;
// the gateway's admission reads it (provider-policy.ts).
//
// AND ONE MORE (PR 1, 2026-09-26). A BUDGET control records the OPERATING BUDGET (capacity.ts): the
// daily cost caps, lanes and invocation caps an operator raises from observed usage. Platform-wide, one
// history (`BUDGET|-|operating`), ACTIVE only, carrying its figures in `settings`. Like a provider
// policy it is not a switch: `aiEffectiveControls` ignores it and the gateway reads it.
//
// WHAT THE AI GATEWAY READS OF THE SWITCHES (PR 1). Only the KILLED ones (`aiStoredKillSwitches`). The
// gateway's floor is its deployment's environment, and it does not require ACTIVE grant rows the way a
// Brain job does -- reading grants there would switch off every deployment that never recorded one. A
// KILLED control, though, stops the gateway's work within the reader's cache (under a minute), with no
// deploy: GLOBAL, one provider, one model, one task, or one organization.
//
// PURE.

import { AI_KILL_SWITCH_SCOPES, type AiActivation, type AiKillSwitch, type AiKillSwitchScope } from './runtime';
import { AI_SENSITIVITY_CLASSES, type AiSensitivityClass } from './context';
import { AI_PROVIDER_POLICY_SCOPE, type AiProviderPolicy } from './provider-policy';

/** PR 1. The scope the operating budget is recorded under, and its one value. */
export const AI_BUDGET_SCOPE = 'BUDGET' as const;
export const AI_BUDGET_CONTROL_VALUE = 'operating' as const;

/** The scopes that switch AI work on or off: the same five the kill switches use. */
export const AI_CONTROL_SCOPES = AI_KILL_SWITCH_SCOPES;
export type AiControlScope = AiKillSwitchScope;

/** Every scope the control log stores: the five switches, and the provider policy (G2). */
export const AI_STORED_CONTROL_SCOPES = [...AI_CONTROL_SCOPES, AI_PROVIDER_POLICY_SCOPE, AI_BUDGET_SCOPE] as const;
export type AiStoredControlScope = (typeof AI_STORED_CONTROL_SCOPES)[number];

/** ACTIVE: recorded authority enables the target. KILLED: it is stopped. */
export const AI_CONTROL_STATES = ['ACTIVE', 'KILLED'] as const;
export type AiControlState = (typeof AI_CONTROL_STATES)[number];

/**
 * What one control is about.
 *   GLOBAL        the platform. No organization, no value.
 *   PROVIDER      one provider, platform-wide. No organization.
 *   MODEL         one model, platform-wide. No organization.
 *   TASK          one task, platform-wide (no organization) or within one organization.
 *   ORGANIZATION  one organization. Its value IS that organization.
 *   PROVIDER_POLICY  one provider's data-class approval, platform-wide. No organization.
 *   BUDGET        the operating budget, platform-wide. No organization; value `operating`.
 */
export interface AiControlTarget {
  readonly scope: AiStoredControlScope;
  readonly organizationId: string | null;
  readonly value: string | null;
}

/** Who recorded a control: a person acting in an organization, or a reviewed operations run. */
export type AiControlActor =
  | { readonly kind: 'HUMAN'; readonly userId: string }
  | { readonly kind: 'OPERATIONS'; readonly reference: string };

export interface AiControlEntry {
  readonly target: AiControlTarget;
  readonly state: AiControlState;
  /** 1 for a control's first record, and one more for each change after it. */
  readonly version: number;
  readonly reason: string;
  readonly actor: AiControlActor;
  readonly recordedAtMs: number;
  /**
   * PROVIDER_POLICY only: the highest sensitivity class the provider may receive. Required
   * when ACTIVE; optional when KILLED; never present on any other scope.
   */
  readonly ceiling?: AiSensitivityClass | null;
  /**
   * BUDGET only (PR 1): the operating budget's figures, validated by `aiOperatingBudgetRefusals` before
   * they are recorded and again when they are read. Never present on any other scope.
   */
  readonly settings?: unknown;
}

export const AI_CONTROL_REFUSALS = [
  'UNKNOWN_SCOPE',
  'UNKNOWN_STATE',
  'ORGANIZATION_NOT_ALLOWED_FOR_SCOPE',
  'ORGANIZATION_REQUIRED',
  'VALUE_NOT_ALLOWED_FOR_SCOPE',
  'VALUE_REQUIRED',
  'ORGANIZATION_VALUE_MISMATCH',
  'REASON_REQUIRED',
  'ACTOR_INCOMPLETE',
  'CEILING_REQUIRED',
  'CEILING_NOT_ALLOWED_FOR_SCOPE',
  'UNKNOWN_CEILING',
  // PR 1: the operating budget's own rules.
  'SETTINGS_REQUIRED',
  'SETTINGS_NOT_ALLOWED_FOR_SCOPE',
  'BUDGET_MUST_BE_ACTIVE',
] as const;
export type AiControlRefusal = (typeof AI_CONTROL_REFUSALS)[number];

const VALUE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,199}$/;

/** Everything wrong with a control about to be recorded. Empty means it may be appended. */
export function aiControlRefusals(entry: Pick<AiControlEntry, 'target' | 'state' | 'reason' | 'actor' | 'ceiling' | 'settings'>): AiControlRefusal[] {
  const out: AiControlRefusal[] = [];
  const { scope, organizationId, value } = entry.target;
  if (!(AI_STORED_CONTROL_SCOPES as readonly string[]).includes(scope)) out.push('UNKNOWN_SCOPE');
  if (!(AI_CONTROL_STATES as readonly string[]).includes(entry.state)) out.push('UNKNOWN_STATE');
  const platformOnly = scope === 'GLOBAL' || scope === 'PROVIDER' || scope === 'MODEL' || scope === AI_PROVIDER_POLICY_SCOPE || scope === AI_BUDGET_SCOPE;
  if (platformOnly && organizationId !== null) out.push('ORGANIZATION_NOT_ALLOWED_FOR_SCOPE');
  if (scope === 'ORGANIZATION' && organizationId === null) out.push('ORGANIZATION_REQUIRED');
  if (scope === 'GLOBAL' && value !== null) out.push('VALUE_NOT_ALLOWED_FOR_SCOPE');
  if (scope !== 'GLOBAL' && (typeof value !== 'string' || !VALUE.test(value))) out.push('VALUE_REQUIRED');
  if (scope === 'ORGANIZATION' && organizationId !== null && value !== organizationId) out.push('ORGANIZATION_VALUE_MISMATCH');
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') out.push('REASON_REQUIRED');
  const a = entry.actor;
  if (a.kind === 'HUMAN' ? !nonBlank(a.userId) : a.kind === 'OPERATIONS' ? !nonBlank(a.reference) : true) out.push('ACTOR_INCOMPLETE');
  // The ceiling belongs to a provider policy and nothing else. An ACTIVE policy must name one; a
  // KILLED one may keep the ceiling it had, or name none.
  const ceiling = entry.ceiling ?? null;
  if (ceiling !== null && !(AI_SENSITIVITY_CLASSES as readonly string[]).includes(ceiling)) out.push('UNKNOWN_CEILING');
  if (scope === AI_PROVIDER_POLICY_SCOPE) {
    if (entry.state === 'ACTIVE' && ceiling === null) out.push('CEILING_REQUIRED');
  } else if (ceiling !== null) {
    out.push('CEILING_NOT_ALLOWED_FOR_SCOPE');
  }
  // The operating budget carries its figures and is only ever ACTIVE: to change it, record new figures.
  const settings = entry.settings ?? null;
  if (scope === AI_BUDGET_SCOPE) {
    if (entry.state !== 'ACTIVE') out.push('BUDGET_MUST_BE_ACTIVE');
    if (settings === null) out.push('SETTINGS_REQUIRED');
    if (value !== AI_BUDGET_CONTROL_VALUE) out.push('VALUE_REQUIRED');
  } else if (settings !== null) {
    out.push('SETTINGS_NOT_ALLOWED_FOR_SCOPE');
  }
  return [...new Set(out)];
}

function nonBlank(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * The one identity a control's history is kept under. Deterministic, and the database
 * checks the same derivation, so two spellings of one target cannot hold two histories.
 */
export function aiControlKey(target: AiControlTarget): string {
  return `${target.scope}|${target.organizationId ?? '-'}|${target.value ?? '-'}`;
}

export type AiControlAppendDecision =
  | { readonly action: 'APPEND'; readonly version: number }
  | { readonly action: 'UNCHANGED' }
  | { readonly action: 'STALE'; readonly currentVersion: number };

/**
 * Whether a change may be appended. The writer states which version it read; if the
 * control moved since, the change is refused rather than silently overriding somebody
 * else's decision. Recording the state a control already has appends nothing.
 */
export function aiControlAppendDecision(
  current: { readonly version: number; readonly state: AiControlState; readonly ceiling?: string | null; readonly settings?: unknown } | null,
  request: { readonly expectedVersion: number; readonly state: AiControlState; readonly ceiling?: string | null; readonly settings?: unknown },
): AiControlAppendDecision {
  const version = current?.version ?? 0;
  if (request.expectedVersion !== version) return { action: 'STALE', currentVersion: version };
  // A provider policy that moves its ceiling -- or an operating budget that moves any figure -- is a
  // change even when its state does not.
  if (
    current &&
    current.state === request.state &&
    (current.ceiling ?? null) === (request.ceiling ?? null) &&
    canonicalJson(current.settings ?? null) === canonicalJson(request.settings ?? null)
  ) {
    return { action: 'UNCHANGED' };
  }
  return { action: 'APPEND', version: version + 1 };
}

/** JSON with object keys sorted, so two recordings of the same figures compare equal. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/**
 * Which current controls an organization's work is subject to: every platform control,
 * and its own -- never another organization's.
 */
export function aiControlsApplyingTo<T extends { readonly target: AiControlTarget }>(organizationId: string, entries: readonly T[]): T[] {
  return entries.filter((e) => e.target.organizationId === null || e.target.organizationId === organizationId);
}

/** What one deployment's environment allows: its floor. Never written to the control log. */
export interface AiControlFloor {
  readonly activation: AiActivation;
  readonly killSwitches: readonly AiKillSwitch[];
}

/** What an organization's AI work may do right now. */
export interface AiEffectiveControls {
  readonly activation: AiActivation;
  readonly killSwitches: readonly AiKillSwitch[];
}

/**
 * The deployment's floor AND the recorded controls, for one organization. Nothing the
 * floor refuses is allowed, nothing a control does not grant is allowed, and every KILLED
 * control that applies stops what it names. The result has the shape the runtime already
 * admits work against (`admitAiInvocation`, `aiTaskAvailability`).
 */
export function aiEffectiveControls(
  floor: AiControlFloor,
  stored: readonly AiControlEntry[],
  organizationId: string,
): AiEffectiveControls {
  // Provider policies and the operating budget are not switches: both are read at admission, never here.
  const applying = aiControlsApplyingTo(organizationId, stored).filter(
    (e) => e.target.scope !== AI_PROVIDER_POLICY_SCOPE && e.target.scope !== AI_BUDGET_SCOPE,
  );
  const has = (state: AiControlState, scope: AiControlScope, value: string | null, org: string | null) =>
    applying.some((e) => e.state === state && e.target.scope === scope && e.target.value === value && e.target.organizationId === org);

  const enabled = floor.activation.enabled === true && has('ACTIVE', 'GLOBAL', null, null);
  const organizations =
    floor.activation.organizations.includes(organizationId) && has('ACTIVE', 'ORGANIZATION', organizationId, organizationId)
      ? [organizationId]
      : [];
  const tasks = floor.activation.tasks.filter(
    (task) => has('ACTIVE', 'TASK', task, null) && !has('KILLED', 'TASK', task, organizationId),
  );
  const providers = floor.activation.providers.filter((provider) => has('ACTIVE', 'PROVIDER', provider, null));

  const killSwitches: AiKillSwitch[] = [...floor.killSwitches];
  for (const e of applying) {
    if (e.state !== 'KILLED') continue;
    const { scope, value, organizationId: org } = e.target;
    if (scope === 'GLOBAL') killSwitches.push({ scope: 'GLOBAL' });
    else if (scope === 'ORGANIZATION' && value) killSwitches.push({ scope: 'ORGANIZATION', value });
    else if (scope === 'TASK' && org === null && value) killSwitches.push({ scope: 'TASK', value });
    else if ((scope === 'PROVIDER' || scope === 'MODEL') && value) killSwitches.push({ scope, value });
    // An organization's own TASK kill is applied above, by removing the task for that
    // organization: it reads as switched off by the organization (NOT_ENABLED), never as
    // a platform stop (PAUSED).
  }
  return {
    activation: { enabled, organizations, tasks, providers },
    killSwitches,
  };
}

/**
 * The current provider policies among a set of current controls, in the shape admission reads.
 * A policy row that cannot be understood is dropped here and so reads as MISSING, never as a
 * wider approval; the repository refuses to return such a row at all.
 */
export function aiProviderPoliciesOf(entries: readonly AiControlEntry[]): AiProviderPolicy[] {
  const out: AiProviderPolicy[] = [];
  for (const e of entries) {
    if (e.target.scope !== AI_PROVIDER_POLICY_SCOPE || e.target.organizationId !== null || !e.target.value) continue;
    out.push({ providerId: e.target.value, state: e.state, ceiling: e.ceiling ?? null, version: e.version, recordedAtMs: e.recordedAtMs });
  }
  return out;
}

/**
 * PR 1. The stored KILLED controls that stop an AI gateway's work for one organization, as kill switches
 * `admitAiInvocation` already understands. ACTIVE controls are ignored here on purpose (see the header):
 * the gateway's floor is its environment. A KILLED TASK recorded by this organization stops that task for
 * this organization only; every platform KILLED control stops what it names everywhere.
 */
export function aiStoredKillSwitches(stored: readonly AiControlEntry[], organizationId: string): AiKillSwitch[] {
  const out: AiKillSwitch[] = [];
  for (const e of aiControlsApplyingTo(organizationId, stored)) {
    if (e.state !== 'KILLED') continue;
    const { scope, value } = e.target;
    if (scope === 'GLOBAL') out.push({ scope: 'GLOBAL' });
    else if ((scope === 'ORGANIZATION' || scope === 'TASK' || scope === 'PROVIDER' || scope === 'MODEL') && value) out.push({ scope, value });
  }
  return out;
}

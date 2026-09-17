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
// PURE.

import { AI_KILL_SWITCH_SCOPES, type AiActivation, type AiKillSwitch, type AiKillSwitchScope } from './runtime';

export const AI_CONTROL_SCOPES = AI_KILL_SWITCH_SCOPES;
export type AiControlScope = AiKillSwitchScope;

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
 */
export interface AiControlTarget {
  readonly scope: AiControlScope;
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
] as const;
export type AiControlRefusal = (typeof AI_CONTROL_REFUSALS)[number];

const VALUE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,199}$/;

/** Everything wrong with a control about to be recorded. Empty means it may be appended. */
export function aiControlRefusals(entry: Pick<AiControlEntry, 'target' | 'state' | 'reason' | 'actor'>): AiControlRefusal[] {
  const out: AiControlRefusal[] = [];
  const { scope, organizationId, value } = entry.target;
  if (!(AI_CONTROL_SCOPES as readonly string[]).includes(scope)) out.push('UNKNOWN_SCOPE');
  if (!(AI_CONTROL_STATES as readonly string[]).includes(entry.state)) out.push('UNKNOWN_STATE');
  const platformOnly = scope === 'GLOBAL' || scope === 'PROVIDER' || scope === 'MODEL';
  if (platformOnly && organizationId !== null) out.push('ORGANIZATION_NOT_ALLOWED_FOR_SCOPE');
  if (scope === 'ORGANIZATION' && organizationId === null) out.push('ORGANIZATION_REQUIRED');
  if (scope === 'GLOBAL' && value !== null) out.push('VALUE_NOT_ALLOWED_FOR_SCOPE');
  if (scope !== 'GLOBAL' && (typeof value !== 'string' || !VALUE.test(value))) out.push('VALUE_REQUIRED');
  if (scope === 'ORGANIZATION' && organizationId !== null && value !== organizationId) out.push('ORGANIZATION_VALUE_MISMATCH');
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') out.push('REASON_REQUIRED');
  const a = entry.actor;
  if (a.kind === 'HUMAN' ? !nonBlank(a.userId) : a.kind === 'OPERATIONS' ? !nonBlank(a.reference) : true) out.push('ACTOR_INCOMPLETE');
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
  current: { readonly version: number; readonly state: AiControlState } | null,
  request: { readonly expectedVersion: number; readonly state: AiControlState },
): AiControlAppendDecision {
  const version = current?.version ?? 0;
  if (request.expectedVersion !== version) return { action: 'STALE', currentVersion: version };
  if (current && current.state === request.state) return { action: 'UNCHANGED' };
  return { action: 'APPEND', version: version + 1 };
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
  const applying = aiControlsApplyingTo(organizationId, stored);
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

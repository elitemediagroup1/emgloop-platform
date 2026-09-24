// The recorded approval to send a class of data to one AI provider. Activation gate G2.
//
// Architecture: docs/architecture/loop-ai-runtime.md §15 (G2), approved 2026-09-24.
//
// WHAT IT IS. A provider policy is a STORED CONTROL (`ai_controls`, scope PROVIDER_POLICY,
// value = the provider id): an operator or a person recorded, with a reason, the HIGHEST
// sensitivity class Loop may send to that provider -- after reading its data terms (training,
// retention, region). It is versioned and append-only like every other control, and it is KILLED
// the same way.
//
// WHAT IT REPLACED. G2 used to be an environment variable, LOOP_AI_PROVIDER_TERMS_CONFIRMED, and
// the connections stack set it automatically whenever it listed a provider -- so "the provider
// is listed" silently implied "its terms were confirmed". Nothing reads that variable any more.
// A deployment's environment still decides which providers it may CONSTRUCT (LOOP_AI_PROVIDERS,
// the credential floor); only a recorded policy decides what may be SENT.
//
// THE RULE, AND IT FAILS CLOSED. A call may go to a provider only when that provider's CURRENT
// policy is ACTIVE and its ceiling is at or above the task's own sensitivity ceiling
// (`aiSensitivityRank`). Missing, KILLED, lower, or unreadable -- the provider is refused with a
// named reason. There is no staging bypass and no environment override that implies approval.
//
// PURE. The caller reads the policies; this decides.

import { AI_SENSITIVITY_CLASSES, aiSensitivityRank, type AiSensitivityClass } from './context';

/** The control scope a provider policy is recorded under. Its own key namespace. */
export const AI_PROVIDER_POLICY_SCOPE = 'PROVIDER_POLICY' as const;

/** One provider's current policy, as the reader hands it to admission. */
export interface AiProviderPolicy {
  readonly providerId: string;
  readonly state: 'ACTIVE' | 'KILLED';
  /** The highest class this provider may receive. Null only for a KILLED policy that named none. */
  readonly ceiling: AiSensitivityClass | null;
  readonly version: number;
  readonly recordedAtMs: number;
}

/**
 * Why a provider may not serve a task under the recorded policy.
 *
 *   PROVIDER_POLICY_MISSING     nobody recorded a policy for this provider.
 *   PROVIDER_POLICY_KILLED      the current policy is KILLED.
 *   PROVIDER_POLICY_BELOW_TASK  the approved ceiling is below the class this task sends.
 *   PROVIDER_POLICY_UNREADABLE  the policies could not be read, or a row could not be understood.
 */
export const AI_PROVIDER_POLICY_REFUSALS = [
  'PROVIDER_POLICY_MISSING',
  'PROVIDER_POLICY_KILLED',
  'PROVIDER_POLICY_BELOW_TASK',
  'PROVIDER_POLICY_UNREADABLE',
] as const;
export type AiProviderPolicyRefusal = (typeof AI_PROVIDER_POLICY_REFUSALS)[number];

export function isAiSensitivityClass(value: unknown): value is AiSensitivityClass {
  return typeof value === 'string' && (AI_SENSITIVITY_CLASSES as readonly string[]).includes(value);
}

/**
 * Whether `providerId` may receive a task whose ceiling is `taskCeiling`. Null means it may.
 *
 * `policies` null or undefined means the read failed: UNREADABLE, never "no policy needed". Two
 * current policies for one provider cannot happen (one key per provider); if it ever did, which
 * one governs would be a guess, so it is UNREADABLE too.
 */
export function aiProviderPolicyRefusal(
  policies: readonly AiProviderPolicy[] | null | undefined,
  providerId: string,
  taskCeiling: AiSensitivityClass | string,
): AiProviderPolicyRefusal | null {
  if (!Array.isArray(policies)) return 'PROVIDER_POLICY_UNREADABLE';
  const mine = policies.filter((p) => p.providerId === providerId);
  if (mine.length === 0) return 'PROVIDER_POLICY_MISSING';
  if (mine.length > 1) return 'PROVIDER_POLICY_UNREADABLE';
  const policy = mine[0]!;
  if (policy.state === 'KILLED') return 'PROVIDER_POLICY_KILLED';
  if (policy.state !== 'ACTIVE' || !isAiSensitivityClass(policy.ceiling)) return 'PROVIDER_POLICY_UNREADABLE';
  // An unclassified task ceiling ranks above every class (aiSensitivityRank fails closed), so no
  // recorded ceiling can admit it.
  if (aiSensitivityRank(policy.ceiling) < aiSensitivityRank(taskCeiling)) return 'PROVIDER_POLICY_BELOW_TASK';
  return null;
}

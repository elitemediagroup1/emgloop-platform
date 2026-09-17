// Reading the executor's deployment configuration, closed by default. Slice B6.
//
// Every value here comes from the deployment (parameters and secrets the infrastructure
// created), never from a request. Anything missing or malformed reads as OFF.

import { hkdfSync } from 'node:crypto';
import { AI_ACTIVATION_OFF, AI_KILL_SWITCH_SCOPES, type AiControlFloor, type AiKillSwitch } from '@emgloop/shared';
import { AesGcmBrainPayloadSealer } from '@emgloop/database/src/services/brain/brain-payload-sealer';

/** A floor that stops everything. Used whenever the configured floor cannot be read. */
export const BRAIN_FLOOR_STOPPED: AiControlFloor = Object.freeze({
  activation: AI_ACTIVATION_OFF,
  killSwitches: Object.freeze([{ scope: 'GLOBAL' } as AiKillSwitch]),
});

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

function names(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === 'string' && NAME.test(v))) return null;
  return [...new Set(value as string[])];
}

/**
 * The executor's AI floor, from a JSON parameter:
 * `{"enabled":false,"organizations":[],"tasks":[],"providers":[],"killSwitches":[]}`.
 */
export function parseAiFloor(raw: string | undefined): AiControlFloor {
  if (typeof raw !== 'string') return BRAIN_FLOOR_STOPPED;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return BRAIN_FLOOR_STOPPED;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return BRAIN_FLOOR_STOPPED;
  const v = value as Record<string, unknown>;
  const allowed = ['enabled', 'organizations', 'tasks', 'providers', 'killSwitches'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return BRAIN_FLOOR_STOPPED;
  const organizations = names(v.organizations);
  const tasks = names(v.tasks);
  const providers = names(v.providers);
  if (typeof v.enabled !== 'boolean' || !organizations || !tasks || !providers || !Array.isArray(v.killSwitches)) return BRAIN_FLOOR_STOPPED;
  const killSwitches: AiKillSwitch[] = [];
  for (const k of v.killSwitches) {
    const entry = k as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object' || !(AI_KILL_SWITCH_SCOPES as readonly unknown[]).includes(entry.scope)) return BRAIN_FLOOR_STOPPED;
    if (entry.scope === 'GLOBAL') killSwitches.push({ scope: 'GLOBAL' });
    else if (typeof entry.value === 'string' && NAME.test(entry.value)) killSwitches.push({ scope: entry.scope as AiKillSwitch['scope'], value: entry.value });
    else return BRAIN_FLOOR_STOPPED;
  }
  return { activation: { enabled: v.enabled, organizations, tasks, providers }, killSwitches };
}

/** A switch is on only when it says exactly `true`. */
export function parseSwitch(raw: string | undefined): boolean {
  return raw === 'true';
}

/** A comma-separated list of trusted names. Malformed entries are dropped. */
export function parseNameList(raw: string | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => NAME.test(s)))];
}

/**
 * The checkpoint sealer for one version of the checkpoint secret. The secret is random
 * text generated inside the key store; the 32-byte key is derived from it with HKDF, so
 * the secret's format never has to be a key's.
 */
export function checkpointSealerFromSecret(secret: string, keyRef: string): AesGcmBrainPayloadSealer {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('checkpoint secret too short');
  const key = new Uint8Array(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('loop-brain', 'utf8'), Buffer.from('checkpoint.v1', 'utf8'), 32));
  return new AesGcmBrainPayloadSealer(keyRef, key);
}

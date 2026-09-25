// How a deployable's gateway reads the recorded AI controls. PR 1 (AI runtime), 2026-09-26.
//
// ONE READER FOR EVERY DEPLOYABLE, THREE ANSWERS. The web tier (Netlify functions) and the connections
// worker both build their gateway with this, over their own Prisma client:
//   providerPolicies     G2: which provider may be sent which class of data (provider-policy-reader.ts);
//   storedKillSwitches   the KILLED switches that apply to one organization (`aiStoredKillSwitches`);
//   operatingBudget      the recorded operating budget (capacity.ts), or NONE.
//
// SHORT, IN-PROCESS CACHES, AND ONLY FOR A SUCCESSFUL READ. 30 seconds by default, never more than 60,
// so a KILLED control or a new budget takes effect on every running instance within a minute, without a
// deploy. A failed read is never cached and never read as "no control": it throws, and the gateway
// refuses the call as CONTROLS_UNREADABLE (or PROVIDER_POLICY_UNREADABLE for G2).
//
// THE KNOWN BUDGET CLASSES ARE THE REVIEWED POLICY'S. A recorded budget naming a class the reviewed
// policy does not have is UNREADABLE, so a typo cannot quietly leave a task without a cap.

import type { PrismaClient } from '@prisma/client';
import { AI_BUDGET_POLICY } from '@emgloop/providers';
import { aiStoredKillSwitches, type AiKillSwitch, type AiProviderPolicy } from '@emgloop/shared';

import { AiControlRepository, type AiOperatingBudgetRead } from '../../repositories/brain/ai-control.repository';
import { AI_PROVIDER_POLICY_CACHE_MAX_MS, AI_PROVIDER_POLICY_CACHE_MS, cachedAiProviderPolicies } from './provider-policy-reader';

export interface AiRuntimeControls {
  readonly providerPolicies: () => Promise<readonly AiProviderPolicy[]>;
  readonly storedKillSwitches: (organizationId: string) => Promise<readonly AiKillSwitch[]>;
  readonly operatingBudget: () => Promise<AiOperatingBudgetRead>;
}

/** What the reader needs of the control store. Production: `AiControlRepository`. */
export interface AiRuntimeControlSource {
  providerPolicies(): Promise<readonly AiProviderPolicy[]>;
  currentFor(organizationId: string): ReturnType<AiControlRepository['currentFor']>;
  operatingBudget(knownClasses: readonly string[]): Promise<AiOperatingBudgetRead>;
}

/** The three readers over `source`, each caching a successful read for `ttlMs`, clamped to [0, 60 s]. */
export function cachedAiRuntimeControls(
  source: AiRuntimeControlSource,
  options: { readonly ttlMs?: number; readonly nowMs?: () => number; readonly knownClasses?: readonly string[] } = {},
): AiRuntimeControls {
  const ttl = Math.max(0, Math.min(options.ttlMs ?? AI_PROVIDER_POLICY_CACHE_MS, AI_PROVIDER_POLICY_CACHE_MAX_MS));
  const nowMs = options.nowMs ?? (() => Date.now());
  const knownClasses = options.knownClasses ?? Object.keys(AI_BUDGET_POLICY.classes);

  const kills = new Map<string, { readonly at: number; readonly switches: readonly AiKillSwitch[] }>();
  let budget: { readonly at: number; readonly reading: AiOperatingBudgetRead } | null = null;

  return {
    providerPolicies: cachedAiProviderPolicies(source, { ttlMs: ttl, nowMs }),
    storedKillSwitches: async (organizationId) => {
      const now = nowMs();
      const hit = kills.get(organizationId);
      if (hit && now - hit.at < ttl) return hit.switches;
      const switches = Object.freeze(aiStoredKillSwitches(await source.currentFor(organizationId), organizationId));
      kills.set(organizationId, { at: now, switches });
      return switches;
    },
    operatingBudget: async () => {
      const now = nowMs();
      if (budget && now - budget.at < ttl) return budget.reading;
      const reading = await source.operatingBudget(knownClasses);
      // An unreadable budget is an answer about the record, not a failed read -- but it is never kept:
      // the next call reads again, so a corrected record takes effect at once.
      if (reading.state !== 'UNREADABLE') budget = { at: now, reading };
      return reading;
    },
  };
}

/** The production reader: this deployable's own database, cached briefly. */
export function aiRuntimeControlsReader(prisma: PrismaClient, options: { readonly ttlMs?: number } = {}): AiRuntimeControls {
  return cachedAiRuntimeControls(new AiControlRepository(prisma), options);
}
